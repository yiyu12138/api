'use strict';

function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function validateBundleFilename(value) {
  let name;
  try { name = decodeURIComponent(String(value || '')); } catch (error) { throw new Error('更新包文件名无效'); }
  if (!name || name !== name.replace(/[\\/]/g, '') || !/\.bundle$/i.test(name)) {
    throw new Error('请选择 GitHub Releases 提供的 .bundle 更新包');
  }
  return name.slice(0, 180);
}

function selectBundleTarget(output) {
  const refs = String(output || '').split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^([0-9a-f]{40,64})\s+(\S+)$/i);
    return match ? { commit: match[1], ref: match[2] } : null;
  }).filter(Boolean);
  const main = refs.find((item) => item.ref === 'refs/heads/main');
  if (main) return main;
  const tags = refs.map((item) => {
    const match = item.ref.match(/^refs\/tags\/v?(\d+\.\d+\.\d+)$/);
    return match ? { ...item, version: match[1] } : null;
  }).filter(Boolean).sort((a, b) => compareVersions(b.version, a.version));
  if (tags[0]) return tags[0];
  throw new Error('更新包中没有 main 分支或版本标签');
}

function validatePackageJson(raw, currentVersion) {
  let pkg;
  try { pkg = JSON.parse(String(raw || '')); } catch (error) { throw new Error('更新包中的 package.json 无效'); }
  if (pkg.name !== 'api-balance' || !/^\d+\.\d+\.\d+$/.test(String(pkg.version || ''))) {
    throw new Error('这不是有效的 API Balance 更新包');
  }
  if (compareVersions(pkg.version, currentVersion) <= 0) {
    throw new Error('更新包版本 v' + pkg.version + ' 不高于当前版本 v' + currentVersion);
  }
  return pkg.version;
}

function parseRelease(release, currentVersion) {
  const latest = String(release?.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('GitHub Release 版本号无效');
  const releaseNotes = String(release.body || '').split(/\r?\n/)
    .map((line) => line.trim().match(/^[-*]\s+(.+)$/)?.[1]).filter(Boolean).slice(0, 20);
  return {
    current: currentVersion,
    latest,
    updateAvailable: compareVersions(latest, currentVersion) > 0,
    source: 'GitHub Release',
    releaseNotes,
    releaseUrl: /^https:\/\/github\.com\//.test(String(release.html_url || '')) ? release.html_url : '',
  };
}
module.exports = { compareVersions, validateBundleFilename, selectBundleTarget, validatePackageJson, parseRelease };
