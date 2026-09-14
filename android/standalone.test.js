'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function createApp(initial, nativeResponse, verifyLicense) {
  let stored = initial || '';
  const window = {
    AndroidApp: {
      isStandalone: () => true,
      getVersionName: () => '1.13.3',
      loadState: () => stored,
      saveState: (value) => { stored = value; },
      scheduleRefresh: () => {},
      verifyLicense: verifyLicense || (() => false),
      httpRequest: (id) => window.APIBalanceNative.resolve(id, JSON.stringify(nativeResponse || {})),
    },
    APIBalanceProviders: { PRESETS: [{ id: 'relay-auto', name: '中转站（自动识别）' }] },
    APIBalanceProbe: {
      parseUsageMap: JSON.parse,
      query: async () => ({ mode: 'test', kind: 'relay', currency: 'USD', balance: 5, used: 1, total: 6, balanceAvailable: true }),
      detect: async () => ({ preset: 'relay-auto', result: { balance: 5 } }),
      queryUsage: async () => ({ logs: [] }),
      aggregateUsage: () => ({ today: { cost: 0 }, logs: [] }),
    },
    setInterval: () => 1,
    dispatchEvent: () => {},
  };
  const context = { window, globalThis: null, crypto: webcrypto, URL, URLSearchParams, CustomEvent: class {}, console };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'standalone.js'), 'utf8'), context);
  return { window, stored: () => stored };
}

test('Android 独立版在本机保存并恢复站点', async () => {
  const first = createApp();
  const bootstrap = await first.window.AndroidStandalone.request('/api/bootstrap');
  assert.equal(bootstrap.ok, true);

  const saved = await first.window.AndroidStandalone.request('/api/station', {
    method: 'POST',
    body: JSON.stringify({ station: { name: '本地站点', baseUrl: 'https://example.com', token: 'secret', preset: 'relay-auto' } }),
  });
  assert.equal(saved.data.stations[0].name, '本地站点');
  assert.equal(saved.data.stations[0].token, undefined);
  assert.equal(saved.data.stations[0].hasToken, true);

  const restarted = createApp(first.stored());
  const state = await restarted.window.AndroidStandalone.request('/api/state');
  assert.equal(state.data.stations[0].name, '本地站点');
  assert.equal(state.data.stations[0].last.balanceUsd, 5);
});

test('Android 更新检查返回可读的 Release 更新说明', async () => {
  const app = createApp('', {
    ok: true,
    status: 200,
    json: {
      tag_name: 'v1.13.4',
      html_url: 'https://github.com/yiyu12138/api/releases/tag/v1.13.4',
      published_at: '2026-09-14T00:00:00Z',
      body: '## 更新内容\n- 显示下载进度\n- [修复更新说明](https://example.com)\n\n**Full Changelog**: ignored',
      assets: [{ name: 'api-balance.apk', size: 2048 }],
    },
  });
  const result = await app.window.AndroidStandalone.request('/api/version');
  assert.equal(result.data.updateAvailable, true);
  assert.deepEqual([...result.data.releaseNotes], ['显示下载进度', '修复更新说明']);
  assert.equal(result.data.apkSize, 2048);
});

test('Android 免费版限制两个站点，激活后解除限制', async () => {
  const app = createApp('', {}, () => true);
  for (const name of ['A', 'B']) {
    await app.window.AndroidStandalone.request('/api/station', {
      method: 'POST', body: JSON.stringify({ station: { name, baseUrl: 'https://example.com', token: 'secret' } }),
    });
  }
  await assert.rejects(() => app.window.AndroidStandalone.request('/api/station', {
    method: 'POST', body: JSON.stringify({ station: { name: 'C', baseUrl: 'https://example.com', token: 'secret' } }),
  }), /免费版最多/);
  const state = await app.window.AndroidStandalone.request('/api/state');
  const payload = Buffer.from(JSON.stringify({ installId: state.data.settings.license.installId })).toString('base64url');
  const activated = await app.window.AndroidStandalone.request('/api/license/activate', {
    method: 'POST', body: JSON.stringify({ code: payload + '.signature' }),
  });
  assert.equal(activated.data.settings.license.active, true);
  const added = await app.window.AndroidStandalone.request('/api/station', {
    method: 'POST', body: JSON.stringify({ station: { name: 'C', baseUrl: 'https://example.com', token: 'secret' } }),
  });
  assert.equal(added.data.stations.length, 3);
});
