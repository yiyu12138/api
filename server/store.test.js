'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'api-balance-store-'));
process.env.APP_SECRET = 'store-test-secret';
const store = require('./store');

test('旧 Bark 配置迁移为加密的多渠道结构', () => {
  const config = store.mergeConfig({ notify: { barkEnabled: true, barkUrl: 'https://api.day.app/test-key', pushTime: '10:30' } });
  assert.equal(config.notify.pushTime, '10:30');
  assert.equal(config.notify.channels.bark.enabled, true);
  assert.match(config.notify.channels.bark.urlEnc, /^v1:/);
  assert.equal(store.decrypt(config.notify.channels.bark.urlEnc), 'https://api.day.app/test-key');
});

test('更新连接配置兼容旧代理并保存备用仓库', () => {
  const oldConfig = store.mergeConfig({ proxy: { url: 'http://192.168.1.2:20171' } });
  assert.equal(oldConfig.proxy.url, 'http://192.168.1.2:20171');
  assert.equal(oldConfig.proxy.mirrorUrl, '');

  const newConfig = store.mergeConfig({ proxy: { mirrorUrl: 'https://mirror.example.com/user/api.git' } });
  assert.equal(newConfig.proxy.mirrorUrl, 'https://mirror.example.com/user/api.git');
});

test('配置落盘失败时向调用方抛错', () => {
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk full'); };
  try { assert.throws(() => store.save(), /disk full/); }
  finally { fs.renameSync = rename; }
});
