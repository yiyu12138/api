'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const INSTALL_ID_FILE = path.join(DATA_DIR, 'install-id');
const LICENSE_FILE = path.join(DATA_DIR, 'license');
const PUBLIC_KEY_FILE = process.env.LICENSE_PUBLIC_KEY_FILE || path.join(__dirname, 'license-public.pem');
const FREE_STATION_LIMIT = 2;
const CONTACT_EMAIL = 'avhlune@gmail.com';

fs.mkdirSync(DATA_DIR, { recursive: true });

function writeAtomic(file, value) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function installId() {
  try {
    const existing = fs.readFileSync(INSTALL_ID_FILE, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/i.test(existing)) return existing;
  } catch (error) { /* create below */ }
  const value = crypto.randomUUID();
  writeAtomic(INSTALL_ID_FILE, value + '\n');
  return value;
}

function decodePayload(value) {
  const buffer = Buffer.from(value, 'base64url');
  if (!buffer.length || buffer.length > 4096) throw new Error('激活码内容无效');
  let payload;
  try { payload = JSON.parse(buffer.toString('utf8')); }
  catch (error) { throw new Error('激活码内容无效'); }
  return payload;
}

function verify(code, expectedInstallId, publicKey) {
  const value = String(code || '').trim();
  if (!value || value.length > 8192) throw new Error('激活码格式不正确');
  const parts = value.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('激活码格式不正确');
  let signature;
  try { signature = Buffer.from(parts[1], 'base64url'); }
  catch (error) { throw new Error('激活码格式不正确'); }
  const key = publicKey || fs.readFileSync(PUBLIC_KEY_FILE, 'utf8');
  const valid = crypto.verify('sha256', Buffer.from(parts[0]), {
    key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }, signature);
  if (!valid) throw new Error('激活码签名无效');
  const payload = decodePayload(parts[0]);
  if (payload.version !== 1 || payload.plan !== 'pro') throw new Error('激活码版本或套餐无效');
  if (payload.installId !== expectedInstallId) throw new Error('激活码不属于当前安装');
  if (!payload.licenseId || String(payload.licenseId).length > 100) throw new Error('激活码缺少许可证编号');
  if (payload.expiresAt && Date.now() >= Number(payload.expiresAt)) throw new Error('激活码已过期');
  return payload;
}

function readCode() {
  try { return fs.readFileSync(LICENSE_FILE, 'utf8').trim(); }
  catch (error) { return ''; }
}

function state() {
  const id = installId();
  const code = readCode();
  if (!code) return { active: false, status: 'free', installId: id, stationLimit: FREE_STATION_LIMIT, contactEmail: CONTACT_EMAIL };
  try {
    const payload = verify(code, id);
    return {
      active: true,
      status: 'active',
      installId: id,
      stationLimit: null,
      contactEmail: CONTACT_EMAIL,
      licenseId: String(payload.licenseId),
      issuedAt: Number(payload.issuedAt || 0),
      expiresAt: Number(payload.expiresAt || 0),
    };
  } catch (error) {
    return { active: false, status: 'invalid', installId: id, stationLimit: FREE_STATION_LIMIT, contactEmail: CONTACT_EMAIL, error: error.message };
  }
}

function activate(code) {
  const id = installId();
  verify(code, id);
  writeAtomic(LICENSE_FILE, String(code).trim() + '\n');
  return state();
}

function assertStationCount(count) {
  const current = state();
  if (!current.active && Number(count) > FREE_STATION_LIMIT) {
    const error = new Error('免费版最多添加 ' + FREE_STATION_LIMIT + ' 个站点，请在通用设置中激活完整功能');
    error.code = 'LICENSE_REQUIRED';
    throw error;
  }
}

module.exports = { FREE_STATION_LIMIT, activate, assertStationCount, installId, state, verify };
