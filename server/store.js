'use strict';
/**
 * 配置与持久化：config.json / history.json / secret
 * 站点密钥使用 AES-256-GCM 加密后落盘，页面永远拿不到明文。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '/data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret');

const HISTORY_MAX = 240; // 每个站点保留的采样点
const NOTIFY_FIELDS = {
  bark: ['url'],
  serverChan: ['sendKey'],
  pushPlus: ['token'],
  telegram: ['botToken', 'chatId'],
  webhook: ['url'],
};
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------- 密钥 ---------------- */
function loadKey() {
  const env = (process.env.APP_SECRET || '').trim();
  if (env) return crypto.createHash('sha256').update('api-balance|' + env).digest();
  if (fs.existsSync(SECRET_FILE)) {
    const hex = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  }
  const buf = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, buf.toString('hex'), { mode: 0o600 });
  return buf;
}
const KEY = loadKey();

/* ---------------- 加解密 ---------------- */
function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(enc) {
  if (!enc) return '';
  const p = String(enc).split(':');
  if (p[0] !== 'v1' || p.length !== 4) return String(enc); // 兼容历史明文
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(p[1], 'base64'));
    d.setAuthTag(Buffer.from(p[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(p[3], 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

function maskToken(token) {
  if (!token) return '';
  const t = String(token);
  if (t.length <= 8) return '••••';
  return t.slice(0, 3) + '••••••' + t.slice(-4);
}

/* ---------------- 配置 ---------------- */
function defaultConfig() {
  return {
    version: 1,
    stations: [],
    fx: { auto: true, rate: 7.2, updatedAt: 0, source: 'default' },
    refreshMinutes: 30,
    timeoutMs: 12000,
    threshold: { defaultUsd: 10 },
    notify: {
      pushTime: '09:00',
      channels: {
        bark: { enabled: false, urlEnc: '' },
        serverChan: { enabled: false, sendKeyEnc: '' },
        pushPlus: { enabled: false, tokenEnc: '' },
        telegram: { enabled: false, botTokenEnc: '', chatIdEnc: '' },
        webhook: { enabled: false, urlEnc: '' },
      },
    },
    proxy: { url: '', mirrorUrl: '' },
    alerts: [],
  };
}

function normalizeNotify(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const defaults = defaultConfig().notify;
  const channels = {};
  Object.entries(NOTIFY_FIELDS).forEach(([type, fields]) => {
    const input = source.channels && source.channels[type] && typeof source.channels[type] === 'object'
      ? source.channels[type] : {};
    channels[type] = { enabled: input.enabled === true };
    fields.forEach((field) => {
      const encrypted = input[field + 'Enc'];
      const plain = input[field];
      channels[type][field + 'Enc'] = encrypted || (plain ? encrypt(String(plain)) : '');
    });
  });
  if (source.barkUrl && !channels.bark.urlEnc) channels.bark.urlEnc = encrypt(String(source.barkUrl));
  if (source.barkEnabled === true) channels.bark.enabled = true;
  return {
    pushTime: /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(source.pushTime || ''))
      ? String(source.pushTime) : defaults.pushTime,
    channels,
  };
}

function mergeConfig(raw) {
  const def = defaultConfig();
  const cfg = Object.assign({}, def, raw || {});
  delete cfg.passwordHash;
  cfg.fx = Object.assign({}, def.fx, (raw && raw.fx) || {});
  cfg.threshold = Object.assign({}, def.threshold, (raw && raw.threshold) || {});
  cfg.notify = normalizeNotify((raw && raw.notify) || {});
  cfg.proxy = Object.assign({}, def.proxy, (raw && raw.proxy) || {});
  if (!Array.isArray(cfg.stations)) cfg.stations = [];
  cfg.stations = cfg.stations.map((s) => normalizeStation(s));
  return cfg;
}

function publicNotify() {
  const n = config.notify;
  const channels = {};
  Object.entries(NOTIFY_FIELDS).forEach(([type, fields]) => {
    const channel = n.channels[type];
    channels[type] = { enabled: channel.enabled === true };
    fields.forEach((field) => {
      const value = decrypt(channel[field + 'Enc']);
      channels[type][field + 'Configured'] = !!value;
      channels[type][field + 'Mask'] = maskToken(value);
    });
  });
  return { pushTime: n.pushTime, channels };
}

function privateNotify() {
  const n = config.notify;
  const channels = {};
  Object.entries(NOTIFY_FIELDS).forEach(([type, fields]) => {
    const channel = n.channels[type];
    channels[type] = { enabled: channel.enabled === true };
    fields.forEach((field) => { channels[type][field] = decrypt(channel[field + 'Enc']); });
  });
  return { pushTime: n.pushTime, channels };
}

function normalizeStation(s) {
  const st = Object.assign({
    id: '',
    name: '',
    baseUrl: '',
    tokenEnc: '',
    preset: 'relay-auto',
    queryPath: '',
    quotaPath: '',
    subtractPath: '',
    usedPath: '',
    totalPath: '',
    planPath: '',
    requestMethod: 'GET',
    requestBody: '',
    authMode: 'bearer',
    authQueryParam: 'key',
    rawPerUnit: 500000,
    unitCurrency: 'USD',
    tag: '',
    thresholdUsd: null,
    extraHeaders: {},
    enabled: true,
    queryMode: 'auto',
    usageEndpoint: '',
    usageRequestMethod: 'GET',
    usageRequestBody: '',
    usageAuthMode: 'bearer',
    usageAuthQueryParam: 'key',
    usageMap: '',
    failCount: 0,
    createdAt: 0,
    lastNotifyAt: 0,
    last: null,
  }, s || {});
  if (!st.id) st.id = newId();
  if (!st.createdAt) st.createdAt = Date.now();
  if (!st.rawPerUnit || !(Number(st.rawPerUnit) > 0)) st.rawPerUnit = 1;
  st.rawPerUnit = Number(st.rawPerUnit);
  st.unitCurrency = st.unitCurrency === 'CNY' ? 'CNY' : 'USD';
  st.requestMethod = st.requestMethod === 'POST' ? 'POST' : 'GET';
  st.authMode = ['bearer', 'x-api-key', 'query', 'none'].includes(st.authMode) ? st.authMode : 'bearer';
  st.usageRequestMethod = st.usageRequestMethod === 'POST' ? 'POST' : 'GET';
  st.usageAuthMode = ['bearer', 'x-api-key', 'query', 'none'].includes(st.usageAuthMode) ? st.usageAuthMode : 'bearer';
  st.enabled = st.enabled !== false;
  return st;
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('[store] 读取失败', file, e.message);
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

let config = mergeConfig(loadJson(CONFIG_FILE, {}));
let history = loadJson(HISTORY_FILE, {});
if (!history || typeof history !== 'object') history = {};

function get() { return config; }

function save() {
  writeJsonAtomic(CONFIG_FILE, config);
}

function saveHistory() {
  writeJsonAtomic(HISTORY_FILE, history);
}

function pushHistory(id, value, t) {
  if (!id || !Number.isFinite(value)) return;
  const arr = history[id] || (history[id] = []);
  const last = arr[arr.length - 1];
  const now = t || Date.now();
  // 5 分钟内且数值没变就不重复记点，避免刷新手抖把曲线刷平
  if (last && now - last.t < 5 * 60 * 1000 && Math.abs(last.v - value) < 1e-9) { last.t = now; return; }
  arr.push({ t: now, v: Number(value.toFixed(6)) });
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
  saveHistory();
}

function getHistory(id) {
  return (history[id] || []).slice();
}

function removeHistory(id) {
  if (history[id]) { delete history[id]; saveHistory(); }
}

/* ---------------- 工具 ---------------- */
function toUsd(value, currency, rate) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  if (currency === 'CNY') {
    const r = Number(rate) > 0 ? Number(rate) : 7.2;
    return v / r;
  }
  return v;
}

function publicStation(st, cfg) {
  const token = decrypt(st.tokenEnc);
  return {
    id: st.id,
    name: st.name,
    baseUrl: st.baseUrl,
    preset: st.preset || 'relay-auto',
    hasToken: !!st.tokenEnc,
    tokenMask: maskToken(token),
    queryPath: st.queryPath,
    quotaPath: st.quotaPath,
    subtractPath: st.subtractPath,
    usedPath: st.usedPath,
    totalPath: st.totalPath,
    planPath: st.planPath,
    requestMethod: st.requestMethod,
    requestBody: st.requestBody,
    authMode: st.authMode,
    authQueryParam: st.authQueryParam,
    rawPerUnit: st.rawPerUnit,
    unitCurrency: st.unitCurrency,
    tag: st.tag,
    thresholdUsd: st.thresholdUsd,
    extraHeaders: st.extraHeaders || {},
    extraHeaderKeys: Object.keys(st.extraHeaders || {}),
    enabled: st.enabled !== false,
    failCount: Number(st.failCount || 0),
    queryMode: st.queryMode || 'auto',
    usageEndpoint: st.usageEndpoint || '',
    usageRequestMethod: st.usageRequestMethod || 'GET',
    usageRequestBody: st.usageRequestBody || '',
    usageAuthMode: st.usageAuthMode || 'bearer',
    usageAuthQueryParam: st.usageAuthQueryParam || 'key',
    usageMap: st.usageMap || '',
    last: st.last,
    history: getHistory(st.id).slice(-240),
    effectiveThresholdUsd: st.thresholdUsd === null || st.thresholdUsd === undefined
      ? cfg.threshold.defaultUsd
      : st.thresholdUsd,
  };
}

module.exports = {
  DATA_DIR,
  CONFIG_FILE,
  encrypt,
  decrypt,
  maskToken,
  newId,
  normalizeStation,
  get,
  save,
  getHistory,
  pushHistory,
  removeHistory,
  toUsd,
  publicStation,
  publicNotify,
  privateNotify,
  normalizeNotify,
  NOTIFY_FIELDS,
  defaultConfig,
  mergeConfig,
};
