'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('fnOS migrates private legacy data without changing keys or following links', {
  skip: process.platform !== 'linux' || process.getuid() !== 0,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-balance-permissions-'));
  const data = path.join(root, 'data');
  const helper = path.resolve(__dirname, '../fnos/cmd/prepare-data');
  const uid = Number(execFileSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).trim());
  const group = execFileSync('id', ['-gn', 'nobody'], { encoding: 'utf8' }).trim();
  const run = (code, user) => execFileSync(user ? 'runuser' : process.execPath,
    user ? ['-u', 'nobody', '--', process.execPath, '-e', code] : ['-e', code],
    { env: { ...process.env, DATA_DIR: data }, encoding: 'utf8' });
  try {
    fs.chmodSync(root, 0o755);
    fs.mkdirSync(data, { mode: 0o700 });
    const storeFile = path.join(root, 'store.js');
    fs.copyFileSync(path.resolve(__dirname, '../server/store.js'), storeFile);
    const load = 'const s = require(' + JSON.stringify(storeFile) + ');';
    run(load + 's.get().stations = [{id:"test",tokenEnc:s.encrypt("preserved-key")}];s.save();');
    for (const name of ['history.json', 'install-id', 'license', 'update-status.json', 'config.json.tmp']) {
      fs.writeFileSync(path.join(data, name), name === 'history.json' ? '{}' : 'unchanged', { mode: 0o600 });
    }
    const before = Object.fromEntries(fs.readdirSync(data).map(name => [name, fs.readFileSync(path.join(data, name))]));
    assert.throws(() => run(load, true), /EACCES/);
    for (let attempt = 0; attempt < 2; attempt++) {
      execFileSync('bash', [helper, data, 'nobody', group]);
      for (const [name, bytes] of Object.entries(before)) {
        const file = path.join(data, name);
        assert.deepEqual(fs.readFileSync(file), bytes);
        assert.equal(fs.statSync(file).uid, uid);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      }
      assert.equal(run(load + 'process.stdout.write(s.decrypt(s.get().stations[0].tokenEnc));', true), 'preserved-key');
    }
    run(load + 's.save();', true);
    const outside = path.join(root, 'outside');
    fs.writeFileSync(outside, 'untouched', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(data, 'license.tmp'));
    assert.throws(() => execFileSync('bash', [helper, data, 'nobody', group]), /Unsafe/);
    assert.equal(fs.statSync(outside).uid, 0);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
