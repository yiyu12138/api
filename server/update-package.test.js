'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updatePackage = require('./update-package');

test('selects main or newest version tag from a bundle', () => {
  const main = updatePackage.selectBundleTarget('a'.repeat(40) + ' refs/heads/main\n' + 'b'.repeat(40) + ' refs/tags/v2.0.0');
  assert.equal(main.ref, 'refs/heads/main');
  const tag = updatePackage.selectBundleTarget('a'.repeat(40) + ' refs/tags/v1.9.0\n' + 'b'.repeat(40) + ' refs/tags/v1.10.0');
  assert.equal(tag.version, '1.10.0');
});

test('validates local update filename and package version', () => {
  assert.equal(updatePackage.validateBundleFilename('api-balance-v1.11.0.bundle'), 'api-balance-v1.11.0.bundle');
  assert.throws(() => updatePackage.validateBundleFilename('../bad.bundle'), /请选择/);
  assert.equal(updatePackage.validatePackageJson('{"name":"api-balance","version":"1.11.0"}', '1.10.0'), '1.11.0');
  assert.throws(() => updatePackage.validatePackageJson('{"name":"other","version":"1.11.0"}', '1.10.0'), /不是有效/);
  assert.throws(() => updatePackage.validatePackageJson('{"name":"api-balance","version":"1.9.0"}', '1.10.0'), /不高于/);
});

test('reads the matching FPK from a GitHub release', () => {
  const result = updatePackage.parseFpkRelease({
    tag_name: 'v1.15.0', body: '## 更新内容\n- 保留配置升级\n- 显示版本说明',
    html_url: 'https://github.com/yiyu12138/api/releases/tag/v1.15.0',
    assets: [{ name: 'api-balance-v1.15.0.fpk', size: 1234, browser_download_url: 'https://github.com/yiyu12138/api/releases/download/v1.15.0/api-balance-v1.15.0.fpk' }],
  }, '1.14.3');
  assert.equal(result.latest, '1.15.0');
  assert.equal(result.updateAvailable, true);
  assert.deepEqual(result.releaseNotes, ['保留配置升级', '显示版本说明']);
  assert.equal(result.fpkSize, 1234);
  assert.throws(() => updatePackage.parseFpkRelease({ tag_name: 'v1.15.0', assets: [{ name: 'api-balance-v1.15.0.fpk', browser_download_url: 'https://example.com/file.fpk' }] }, '1.14.0'), /可信/);
});

test('downloads a release asset with size validation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-balance-fpk-'));
  const file = path.join(dir, 'update.fpk');
  try {
    const fakeFetch = async () => new Response(Buffer.from('fpk'), { status: 200, headers: { 'content-length': '3' } });
    assert.equal(await updatePackage.downloadReleaseAsset('https://github.com/file.fpk', file, { fetch: fakeFetch, expectedSize: 3 }), 3);
    assert.equal(fs.readFileSync(file, 'utf8'), 'fpk');
    await assert.rejects(() => updatePackage.downloadReleaseAsset('https://github.com/file.fpk', file, { fetch: fakeFetch, expectedSize: 4 }), /大小/);
    assert.equal(fs.existsSync(file), false);
    await assert.rejects(() => updatePackage.downloadReleaseAsset('https://github.com/file.fpk', path.join(dir, 'missing', 'update.fpk'), { fetch: fakeFetch }), /ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
