'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const stage = path.join(dist, 'fpk-source');

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(root, 'fnos'), stage, { recursive: true });
fs.rmSync(path.join(stage, 'app', 'docker'), { recursive: true, force: true });
const serviceDir = path.join(stage, 'app', 'service');
fs.mkdirSync(serviceDir, { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(serviceDir, 'package.json'));
fs.cpSync(path.join(root, 'server'), path.join(serviceDir, 'server'), { recursive: true });
fs.cpSync(path.join(root, 'public'), path.join(serviceDir, 'public'), { recursive: true });

const manifestPath = path.join(stage, 'manifest');
const manifest = fs.readFileSync(manifestPath, 'utf8').replace(/^version\s*=.*$/m, 'version               = ' + pkg.version);
fs.writeFileSync(manifestPath, manifest);
for (const name of ['install_init', 'install_callback', 'upgrade_init', 'upgrade_callback', 'uninstall_init', 'uninstall_callback', 'config_init', 'config_callback']) {
  const script = path.join(stage, 'cmd', name);
  if (!fs.existsSync(script)) fs.writeFileSync(script, '#!/bin/bash\nexit 0\n');
}
for (const name of fs.readdirSync(path.join(stage, 'cmd'))) {
  const script = path.join(stage, 'cmd', name);
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace(/\r\n/g, '\n'));
  fs.chmodSync(script, 0o755);
}

if (process.argv.includes('--prepare-only')) {
  console.log(stage);
  process.exit(0);
}

const fnpack = process.env.FNPACK_BIN || (process.platform === 'win32' ? 'fnpack.exe' : 'fnpack');
const result = spawnSync(fnpack, ['build', '--directory', stage], { cwd: dist, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

const generated = [path.join(dist, 'api-balance.fpk'), path.join(stage, 'api-balance.fpk')].find(fs.existsSync);
if (!generated) throw new Error('fnpack did not create api-balance.fpk');
const target = path.join(dist, 'api-balance-v' + pkg.version + '.fpk');
fs.renameSync(generated, target);
console.log(target);
