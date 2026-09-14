'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const originalDataDir = process.env.DATA_DIR;
const originalPublicKeyFile = process.env.LICENSE_PUBLIC_KEY_FILE;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-balance-license-'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyFile = path.join(dataDir, 'public.pem');
fs.writeFileSync(publicKeyFile, keys.publicKey.export({ type: 'spki', format: 'pem' }));
process.env.DATA_DIR = dataDir;
process.env.LICENSE_PUBLIC_KEY_FILE = publicKeyFile;
delete require.cache[require.resolve('./license')];
const license = require('./license');

function signedCode(payload, privateKey) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.sign('sha256', Buffer.from(encoded), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return encoded + '.' + signature.toString('base64url');
}

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalPublicKeyFile === undefined) delete process.env.LICENSE_PUBLIC_KEY_FILE;
  else process.env.LICENSE_PUBLIC_KEY_FILE = originalPublicKeyFile;
});

test('free installs are limited and signed licenses unlock the install', () => {
  const installId = license.installId();
  assert.throws(() => license.assertStationCount(3), /免费版最多/);
  assert.throws(() => license.assertPaidFeature('推送功能'), /10 元/);
  const code = signedCode({ version: 1, plan: 'pro', licenseId: 'ORDER-1', installId, issuedAt: Date.now() }, keys.privateKey);
  assert.equal(license.verify(code, installId, keys.publicKey).licenseId, 'ORDER-1');
  assert.throws(() => license.verify(code, crypto.randomUUID(), keys.publicKey), /不属于当前安装/);
  const parts = code.split('.');
  const tampered = (parts[0][0] === 'A' ? 'B' : 'A') + parts[0].slice(1) + '.' + parts[1];
  assert.throws(() => license.verify(tampered, installId, keys.publicKey));
  assert.equal(license.activate(code).active, true);
  assert.doesNotThrow(() => license.assertStationCount(100));
  assert.doesNotThrow(() => license.assertPaidFeature('推送功能'));
});
