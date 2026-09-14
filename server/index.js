'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const store = require('./store');
const probe = require('./probe');
const fx = require('./fx');
const notify = require('./notify');
const updatePackage = require('./update-package');
const license = require('./license');
const { securityHeaders } = require('./security');
const { PRESETS } = require('./providers');
const { version: APP_VERSION } = require('../package.json');

const PORT = Number(process.env.PORT || 8080);
const DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE === 'fnos' ? 'fnos' : 'docker';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPDATE_STATUS_FILE = path.join(store.DATA_DIR, 'update-status.json');
const APP_DIR = process.env.APP_DIR || path.join(__dirname, '..');
const MAX_UPDATE_BYTES = 100 * 1024 * 1024;
// A shared short-lived snapshot prevents clients/ranges from independently re-fetching moving pages.
const usageSnapshots = new Map();
const SECURITY_HEADERS = securityHeaders(DEPLOYMENT_MODE);
async function getUsageSnapshot(st, force) {
  const fxRate = Number(store.get().fx?.rate || 7.2);
  const key = JSON.stringify([st.id,st.baseUrl,st.tokenEnc,st.usageEndpoint,st.usageRequestMethod,st.usageRequestBody,st.usageAuthMode,st.usageAuthQueryParam,st.usageMap,fxRate]);
  if (force) usageSnapshots.delete(key);
  const current = usageSnapshots.get(key);
  if(current && current.expires > Date.now()) return current.promise;
  const entry = {expires:Date.now()+120000};
  entry.promise = probe.queryUsage(st,store.decrypt(st.tokenEnc),fxRate).then(data=>{
    entry.expires=Date.now()+60000; return data;
  }).catch(e=>{usageSnapshots.delete(key);throw e;});
  usageSnapshots.set(key,entry);
  if(usageSnapshots.size>200) for(const [k,v] of usageSnapshots) if(v.expires<Date.now()) usageSnapshots.delete(k);
  return entry.promise;
}

/* ---------------- 小工具 ---------------- */
function sendJson(res, code, data, headers) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, SECURITY_HEADERS, headers || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 512 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function readUpdateStatus() {
  try {
    const value = JSON.parse(fs.readFileSync(UPDATE_STATUS_FILE, 'utf8'));
    return value && typeof value === 'object' ? value : { state: 'idle' };
  } catch (e) {
    return { state: 'idle' };
  }
}

function writeUpdateStatus(state, message, commit, extra) {
  fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify(Object.assign({ state, message, commit: commit || '', at: Date.now() }, extra || {})));
}

function normalizeProxy(value) {
  const proxy = String(value || '').trim();
  if (!proxy) return '';
  let url;
  try { url = new URL(proxy); } catch (e) { throw new Error('代理地址格式不正确'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('代理仅支持 HTTP 或 HTTPS');
  return proxy;
}

function normalizeUpdateSource(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  let url;
  try { url = new URL(source); } catch (e) { throw new Error('备用仓库地址格式不正确'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('备用仓库仅支持 HTTP 或 HTTPS');
  if (url.username || url.password) throw new Error('备用仓库地址不能包含账号或密码');
  return source;
}

function setNotifySettings(cfg, input) {
  if (!input || typeof input !== 'object') return;
  if (input.pushTime !== undefined) {
    const value = String(input.pushTime);
    cfg.notify.pushTime = /^([01]\d|2[0-3]):([0-5]\d)$/.test(value) ? value : '09:00';
  }
  const patches = Object.assign({}, input.channels || {});
  if (input.barkEnabled !== undefined || input.barkUrl !== undefined) {
    patches.bark = Object.assign({}, patches.bark || {}, { enabled: input.barkEnabled, url: input.barkUrl });
  }
  Object.entries(store.NOTIFY_FIELDS).forEach(([type, fields]) => {
    const patch = patches[type];
    if (!patch || typeof patch !== 'object') return;
    const channel = cfg.notify.channels[type];
    if (patch.enabled !== undefined) channel.enabled = patch.enabled === true;
    fields.forEach((field) => {
      if (patch[field] === undefined) return;
      const value = String(patch[field] || '').trim().slice(0, 1000);
      if (!value) return;
      if (field === 'url') {
        let url;
        try { url = new URL(value); } catch (error) { throw new Error((notify.LABELS[type] || type) + ' 地址格式不正确'); }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error((notify.LABELS[type] || type) + ' 地址仅支持 HTTP 或 HTTPS');
      }
      channel[field + 'Enc'] = store.encrypt(value);
    });
  });
}

function gitEnv(proxy) {
  const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' });
  if (proxy) Object.assign(env, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy });
  return env;
}

const { compareVersions } = updatePackage;

function execGit(args, proxy, timeout) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'safe.directory=' + APP_DIR, '-C', APP_DIR, ...args], {
      env: gitEnv(proxy), timeout: timeout || 30000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.detail = String(stderr || stdout || error.message).trim().split(/\r?\n/).slice(-1)[0];
        reject(error);
      } else resolve(String(stdout || '').trim());
    });
  });
}

async function checkLatestVersion(proxy, mirrorUrl) {
  const sources = [{ label: 'GitHub', value: 'origin' }];
  if (mirrorUrl) sources.push({ label: '备用仓库', value: mirrorUrl });
  const checked = await Promise.all(sources.map(async (source) => {
    try {
      const output = await execGit(['ls-remote', '--tags', '--refs', source.value], proxy, 20000);
      const versions = output.split(/\r?\n/).map((line) => {
        const match = line.match(/refs\/tags\/(v?(\d+\.\d+\.\d+))$/);
        return match ? { version: match[2], ref: 'refs/tags/' + match[1] } : null;
      }).filter(Boolean).sort((a, b) => compareVersions(a.version, b.version));
      return { ...source, latest: versions.at(-1) || null };
    } catch (error) {
      return { ...source, error: error.detail || error.message || '连接失败' };
    }
  }));
  const available = checked.filter((item) => item.latest).sort((a, b) => compareVersions(b.latest.version, a.latest.version));
  if (!available.length) {
    return { current: APP_VERSION, latest: '', updateAvailable: false, error: checked.map((item) => item.label + '：' + item.error).join('；') || '版本检查失败', checkedAt: Date.now() };
  }
  const selected = available[0];
  const latest = selected.latest.version;
  let details = [], detailError = '';
  if (compareVersions(latest, APP_VERSION) > 0) {
    try {
      await execGit(['fetch', '--quiet', '--force', selected.value, selected.latest.ref + ':refs/api-balance/update-check'], proxy, 30000);
      const log = await execGit(['log', '--format=%h%x09%s', '--max-count=20', 'HEAD..refs/api-balance/update-check'], proxy, 10000);
      details = log.split(/\r?\n/).filter(Boolean).map((line) => {
        const [commit, ...message] = line.split('\t');
        return { commit, message: message.join('\t') || '代码更新' };
      });
    } catch (error) { detailError = error.detail || error.message || '更新明细读取失败'; }
  }
  return { current: APP_VERSION, latest, updateAvailable: compareVersions(latest, APP_VERSION) > 0, source: selected.label, details, detailError, checkedAt: Date.now() };
}

async function checkLatestFpk() {
  try {
    const response = await fetch('https://api.github.com/repos/yiyu12138/api/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'api-balance/' + APP_VERSION },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('GitHub 返回 HTTP ' + response.status);
    return { ...updatePackage.parseFpkRelease(await response.json(), APP_VERSION), checkedAt: Date.now() };
  } catch (error) {
    return { current: APP_VERSION, latest: '', updateAvailable: false, error: error.message || '版本检查失败', checkedAt: Date.now() };
  }
}

async function runFpkUpdate(info) {
  const file = process.env.FNOS_UPDATE_FILE || path.join(store.DATA_DIR, 'api-balance-update.fpk');
  let previousProgress = -1;
  writeUpdateStatus('running', '正在下载 v' + info.latest + ' FPK', '', { targetVersion: info.latest, progress: 0 });
  try {
    await updatePackage.downloadReleaseAsset(info.fpkUrl, file, {
      expectedSize: info.fpkSize,
      maxBytes: MAX_UPDATE_BYTES,
      userAgent: 'api-balance/' + APP_VERSION,
      onProgress(downloaded, total) {
        const progress = total > 0 ? Math.min(99, Math.floor(downloaded * 100 / total)) : 0;
        if (progress >= previousProgress + 5) {
          previousProgress = progress;
          writeUpdateStatus('running', '正在下载 v' + info.latest + ' FPK', '', { targetVersion: info.latest, progress });
        }
      },
    });
    const installer = '/usr/local/bin/appcenter-cli';
    if (!fs.existsSync(installer)) throw new Error('未找到飞牛应用中心安装命令');
    writeUpdateStatus('installing', '下载完成，正在调用飞牛应用中心安装 v' + info.latest, '', { targetVersion: info.latest, progress: 100 });
    const child = execFile('sudo', ['-n', installer, 'install-fpk', file], { timeout: 10 * 60 * 1000 }, (error, stdout, stderr) => {
      if (error) writeUpdateStatus('failed', String(stderr || stdout || error.message).trim().split(/\r?\n/).slice(-1)[0] || 'FPK 安装失败');
    });
    child.unref();
  } catch (error) {
    fs.rmSync(file, { force: true });
    writeUpdateStatus('failed', error.message || 'FPK 更新失败');
  }
}

async function runUpdate(proxy, source, label) {
  writeUpdateStatus('running', '正在从' + label + '拉取最新代码');
  try {
    await execGit(['pull', '--ff-only', source, 'main'], proxy, 90000);
    const commit = await execGit(['rev-parse', '--short', 'HEAD'], proxy, 10000).catch(() => '');
    writeUpdateStatus('success', '更新完成，服务重启后页面将自动刷新', commit);
    setTimeout(() => process.exit(0), 1200);
  } catch (error) {
    writeUpdateStatus('failed', error.detail || error.message || '更新失败');
  }
}

function receiveUpdateBundle(req) {
  const filename = updatePackage.validateBundleFilename(req.headers['x-update-filename']);
  const declaredSize = Number(req.headers['content-length'] || 0);
  if (declaredSize > MAX_UPDATE_BYTES) throw new Error('更新包不能超过 100 MB');
  const dir = fs.mkdtempSync(path.join(store.DATA_DIR, 'update-upload-'));
  const file = path.join(dir, 'update.bundle');
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(file, { mode: 0o600 });
    let size = 0;
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      output.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPDATE_BYTES) return fail(new Error('更新包不能超过 100 MB'));
      if (!failed && !output.write(chunk)) {
        req.pause();
        output.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      if (failed) return;
      if (!size) return fail(new Error('更新包为空'));
      output.end(() => resolve({ file, dir, filename }));
    });
    req.on('aborted', () => fail(new Error('更新包上传已中断')));
    req.on('error', fail);
    output.on('error', fail);
  });
}

async function runLocalUpdate(upload) {
  const temporaryRef = 'refs/api-balance/local-update';
  writeUpdateStatus('running', '正在验证本地更新包 ' + upload.filename);
  try {
    await execGit(['bundle', 'verify', upload.file], '', 30000);
    const target = updatePackage.selectBundleTarget(await execGit(['bundle', 'list-heads', upload.file], '', 10000));
    await execGit(['fetch', '--quiet', '--force', upload.file, target.ref + ':' + temporaryRef], '', 90000);
    const version = updatePackage.validatePackageJson(await execGit(['show', temporaryRef + ':package.json'], '', 10000), APP_VERSION);
    const dirty = await execGit(['status', '--porcelain', '--untracked-files=no'], '', 10000);
    if (dirty) throw new Error('程序目录存在未提交修改，请先处理后再更新');
    try { await execGit(['merge-base', '--is-ancestor', 'HEAD', temporaryRef], '', 10000); }
    catch (error) { throw new Error('更新包与当前版本不是同一条 Git 历史，已拒绝安装'); }
    await execGit(['merge', '--ff-only', temporaryRef], '', 90000);
    const commit = await execGit(['rev-parse', '--short', 'HEAD'], '', 10000).catch(() => '');
    writeUpdateStatus('success', '已从本地更新包升级到 v' + version + '，服务重启后页面将自动刷新', commit);
    setTimeout(() => process.exit(0), 1200);
  } catch (error) {
    writeUpdateStatus('failed', error.detail || error.message || '本地更新失败');
  } finally {
    await execGit(['update-ref', '-d', temporaryRef], '', 10000).catch(() => {});
    fs.rmSync(upload.dir, { recursive: true, force: true });
  }
}

/* ---------------- 业务 ---------------- */
async function queryWithRetry(st, token, attempts) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try { return await probe.query(st, token); } catch (e) {
      last = e;
      if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 800 * (i + 1)));
    }
  }
  throw last || new Error('查询失败');
}

async function refreshStation(st, cfg) {
  const t0 = Date.now();
  const token = store.decrypt(st.tokenEnc);
  try {
    const r = await queryWithRetry(st, token, 2);
    const balanceUsd = store.toUsd(r.balance, r.currency, cfg.fx.rate);
    st.failCount = 0;
    st.last = {
      ok: true,
      at: Date.now(),
      ms: Date.now() - t0,
      mode: r.mode,
      kind: r.kind,
      currency: r.currency,
      balance: r.balance,
      used: r.used,
      total: r.total,
      requests: r.requests,
      group: r.group,
      extra: r.extra || {},
      note: r.note || '',
      balanceAvailable: r.balanceAvailable !== false,
      balanceUsd,
      // 查不到余额的来源（如未开放接口的官方站），保留上一次的数字并标记为过期
      stale: r.balanceAvailable === false,
      error: null,
    };
    if (r.balanceAvailable === false) st.last.errorCategory = null;
    if (balanceUsd !== null) store.pushHistory(st.id, balanceUsd, Date.now());
  } catch (e) {
    st.failCount = Number(st.failCount || 0) + 1;
    const message = e.message || String(e);
    const category = /timeout|超时/i.test(message) ? 'timeout'
      : /401|403|key|token|密钥|令牌|unauthor/i.test(message) ? 'auth'
      : /fetch|network|网络|ENOTFOUND|ECONN|证书|TLS/i.test(message) ? 'network' : 'provider';
    st.last = Object.assign({}, st.last || {}, {
      ok: false,
      error: message,
      errorCategory: category,
      failCount: st.failCount,
      ms: Date.now() - t0,
      at: Date.now(),
      stale: true,
    });
  }
  return st.last;
}

async function refreshAll(onlyId) {
  const cfg = store.get();
  const list = cfg.stations.filter((s) => (onlyId ? s.id === onlyId : true) && s.enabled !== false && (onlyId || s.queryMode === 'auto'));
  await Promise.all(list.map((st) => refreshStation(st, cfg)));
  store.save();
  return cfg;
}

async function refreshFxIfNeeded(force) {
  const cfg = store.get();
  if (!force && cfg.fx.auto === false) return cfg.fx;
  if (!force) {
    const age = Date.now() - Number(cfg.fx.updatedAt || 0);
    if (cfg.fx.source === 'auto' && cfg.fx.rate && age < 12 * 3600 * 1000) return cfg.fx;
  }
  try {
    const r = await fx.fetchRate();
    cfg.fx.rate = r.rate;
    cfg.fx.source = 'auto';
    cfg.fx.updatedAt = Date.now();
    store.save();
    console.log('[fx] 汇率更新为', r.rate);
  } catch (e) {
    console.error('[fx] 更新失败，沿用', cfg.fx.rate, e.message);
  }
  return cfg.fx;
}

function isPushDue(now, configured) {
  const value = /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(configured || '09:00')) ? String(configured) : '09:00';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const hh = (parts.find((x) => x.type === 'hour') || {}).value;
  const mm = (parts.find((x) => x.type === 'minute') || {}).value;
  return hh + ':' + mm >= value;
}

async function checkThresholds() {
  if (!license.state().active) return;
  const cfg = store.get();
  const n = store.privateNotify();
  const channels = Object.entries(n.channels || {}).filter(([, channel]) => channel.enabled === true);
  if (!channels.length) return;
  const now = Date.now();
  const pushTime = String(n.pushTime || '09:00');
  const shanghaiMinute = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const dayKey = shanghaiMinute.slice(0, 10);
  if (!isPushDue(now, pushTime)) return;
  for (const st of cfg.stations) {
    if (st.enabled === false) continue;
    const last = st.last;
    if (!last || !last.ok || last.balanceUsd === null || last.balanceUsd === undefined) continue;
    const th = st.thresholdUsd === null || st.thresholdUsd === undefined ? cfg.threshold.defaultUsd : st.thresholdUsd;
    if (th === null || th === undefined) continue;
    if (last.balanceUsd < Number(th) && String(st.lastNotifyDay || '') !== dayKey) {
      const cny = last.currency === 'CNY' && last.balance !== null
        ? last.balance
        : store.toUsd(last.balanceUsd, 'USD', cfg.fx.rate) !== null
          ? (last.balanceUsd * cfg.fx.rate) : null;
      const body = '当前 $' + last.balanceUsd.toFixed(2)
        + (cny !== null ? '（约 ¥' + cny.toFixed(2) + '）' : '')
        + '，低于阈值 $' + Number(th).toFixed(2);
      try {
        const results = await Promise.allSettled(channels.map(([type, channel]) => (
          notify.send(type, channel, '⚠️ ' + (st.name || '中转站') + ' 余额偏低', body)
        )));
        const sent = results.filter((result) => result.status === 'fulfilled').length;
        if (!sent) throw new Error(results.map((result) => result.reason && result.reason.message).filter(Boolean).join('；') || '没有可用推送渠道');
        st.lastNotifyAt = now;
        st.lastNotifyDay = dayKey;
        cfg.alerts = Array.isArray(cfg.alerts) ? cfg.alerts : [];
        cfg.alerts.push({ at: now, stationId: st.id, stationName: st.name, type: 'low', message: body });
        if (cfg.alerts.length > 100) cfg.alerts.splice(0, cfg.alerts.length - 100);
        store.save();
        console.log('[notify] 已通过 ' + sent + ' 个渠道推送', st.name);
      } catch (e) {
        console.error('[notify] 推送失败', st.name, e.message);
      }
    }
  }
}

function buildState() {
  const cfg = store.get();
  const stations = cfg.stations.map((s) => store.publicStation(s, cfg));
  let totalUsd = 0;
  let normal = 0;
  let low = 0;
  let failed = 0;
  let unknown = 0;
  stations.forEach((s) => {
    const last = s.last || {};
    if (!s.enabled) return;
    if (last.balanceUsd !== null && last.balanceUsd !== undefined) totalUsd += last.balanceUsd;
    if (!last.ok && last.at) { failed += 1; return; }
    if (last.balanceAvailable === false || last.balanceUsd === null || last.balanceUsd === undefined) { unknown += 1; return; }
    if (last.balanceUsd < Number(s.effectiveThresholdUsd ?? -Infinity)) low += 1;
    else normal += 1;
  });
  return {
    version: APP_VERSION,
    deploymentMode: DEPLOYMENT_MODE,
    stations,
    summary: { totalUsd, normal, low, failed, unknown, count: stations.length },
    settings: {
      refreshMinutes: cfg.refreshMinutes,
      timeoutMs: cfg.timeoutMs,
      thresholdDefaultUsd: cfg.threshold.defaultUsd,
      fx: cfg.fx,
      notify: store.publicNotify(),
      proxy: { url: cfg.proxy?.url || '', mirrorUrl: cfg.proxy?.mirrorUrl || '' },
      license: license.state(),
      alerts: Array.isArray(cfg.alerts) ? cfg.alerts.slice(-100).reverse() : [],
      update: readUpdateStatus(),
    },
    lastRefreshAt: Math.max(0, ...stations.map((s) => (s.last && s.last.at) || 0)),
  };
}

/* ---------------- 路由 ---------------- */
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') return sendJson(res, 200, { ok: true, ts: Date.now() });

  if (p === '/api/bootstrap') {
    return sendJson(res, 200, {
      ok: true,
      presets: PRESETS,
      version: APP_VERSION,
    });
  }

  if (p === '/api/state' && req.method === 'GET') return sendJson(res, 200, { ok: true, data: buildState() });

  if (p === '/api/version' && req.method === 'GET') {
    if (DEPLOYMENT_MODE === 'fnos') {
      return sendJson(res, 200, { ok: true, data: await checkLatestFpk() });
    }
    const cfg = store.get();
    return sendJson(res, 200, { ok: true, data: await checkLatestVersion(cfg.proxy?.url || '', cfg.proxy?.mirrorUrl || '') });
  }

  if (p === '/api/usage' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    const cfg = store.get();
    const st = cfg.stations.find((x) => x.id === id);
    if (!st) return sendJson(res, 404, { ok: false, error: '站点不存在' });
    try {
      const range = url.searchParams.get('range') || 'today';
      const usage = await getUsageSnapshot(st, url.searchParams.get('force') === '1');
      return sendJson(res, 200, { ok: true, data: probe.aggregateUsage ? probe.aggregateUsage(usage, range) : usage });
    } catch (e) { return sendJson(res, 200, { ok: false, error: e.message || String(e) }); }
  }
  if (p === '/api/refresh' && req.method === 'POST') {
    const body = await readBody(req);
    await refreshFxIfNeeded(false);
    const t0 = Date.now();
    await refreshAll(body.id || null);
    const state = buildState();
    state.elapsedMs = Date.now() - t0;
    return sendJson(res, 200, { ok: true, data: state });
  }

  if (p === '/api/update' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, data: readUpdateStatus() });
  }

  if (p === '/api/update' && req.method === 'POST') {
    const current = readUpdateStatus();
    if (['queued', 'running', 'installing'].includes(current.state)) {
      return sendJson(res, 409, { ok: false, error: '更新正在进行中', data: current });
    }
    if (DEPLOYMENT_MODE === 'fnos') {
      const latest = await checkLatestFpk();
      if (latest.error) return sendJson(res, 502, { ok: false, error: latest.error });
      if (!latest.updateAvailable) return sendJson(res, 409, { ok: false, error: '当前已是最新版本' });
      if (['queued', 'running', 'installing'].includes(readUpdateStatus().state)) {
        return sendJson(res, 409, { ok: false, error: '更新正在进行中' });
      }
      writeUpdateStatus('queued', '等待下载 FPK', '', { targetVersion: latest.latest, progress: 0 });
      sendJson(res, 202, { ok: true, data: readUpdateStatus() });
      setImmediate(() => runFpkUpdate(latest));
      return;
    }
    try {
      const body = await readBody(req);
      const cfg = store.get();
      const proxy = normalizeProxy(body.proxyUrl ?? cfg.proxy?.url);
      const mirrorUrl = normalizeUpdateSource(body.mirrorUrl ?? cfg.proxy?.mirrorUrl);
      const useMirror = body.source === 'mirror';
      if (useMirror && !mirrorUrl) throw new Error('请先填写并保存备用仓库地址');
      cfg.proxy = { url: proxy, mirrorUrl };
      store.save();
      writeUpdateStatus('queued', '等待更新任务');
      sendJson(res, 202, { ok: true, data: readUpdateStatus() });
      setImmediate(() => runUpdate(proxy, useMirror ? mirrorUrl : 'origin', useMirror ? '备用仓库' : ' GitHub'));
      return;
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/update/file' && req.method === 'POST') {
    if (DEPLOYMENT_MODE === 'fnos') {
      req.resume();
      return sendJson(res, 409, { ok: false, error: '飞牛版请通过应用中心或新版 FPK 升级' });
    }
    const current = readUpdateStatus();
    if (current.state === 'queued' || current.state === 'running') {
      req.resume();
      return sendJson(res, 409, { ok: false, error: '更新正在进行中', data: current });
    }
    let upload;
    try {
      upload = await receiveUpdateBundle(req);
      writeUpdateStatus('queued', '本地更新包上传完成，等待验证');
      sendJson(res, 202, { ok: true, data: readUpdateStatus() });
      setImmediate(() => runLocalUpdate(upload));
      return;
    } catch (error) {
      if (upload?.dir) fs.rmSync(upload.dir, { recursive: true, force: true });
      return sendJson(res, 400, { ok: false, error: error.message || '更新包上传失败' });
    }
  }

  if (p === '/api/license/activate' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      license.activate(body.code);
      return sendJson(res, 200, { ok: true, data: buildState() });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error.message || '激活失败' });
    }
  }

  if (p === '/api/station' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = store.get();
    const s = body.station || {};
    let st;
    if (s.id) {
      st = cfg.stations.find((x) => x.id === s.id);
      if (!st) return sendJson(res, 404, { ok: false, error: '站点不存在' });
    } else {
      try { license.assertStationCount(cfg.stations.length + 1); }
      catch (error) { return sendJson(res, 403, { ok: false, code: error.code, error: error.message }); }
      st = store.normalizeStation({});
    }
    const nextUsageEndpoint = s.usageEndpoint === undefined ? st.usageEndpoint : String(s.usageEndpoint).trim().slice(0, 500);
    const nextUsageMap = s.usageMap === undefined ? st.usageMap : String(s.usageMap).slice(0, 20000);
    if (nextUsageEndpoint && !nextUsageMap) return sendJson(res, 400, { ok: false, error: '请填写用量字段映射 JSON' });
    try { if (nextUsageMap) probe.parseUsageMap(nextUsageMap); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    if (!s.id) cfg.stations.push(st);
    if (s.name !== undefined) st.name = String(s.name).slice(0, 60) || '未命名';
    if (s.baseUrl !== undefined) st.baseUrl = String(s.baseUrl).trim().slice(0, 300);
    if (s.preset !== undefined) st.preset = String(s.preset);
    if (s.queryPath !== undefined) st.queryPath = String(s.queryPath).trim();
    if (s.quotaPath !== undefined) st.quotaPath = String(s.quotaPath).trim();
    if (s.subtractPath !== undefined) st.subtractPath = String(s.subtractPath).trim();
    if (s.usedPath !== undefined) st.usedPath = String(s.usedPath).trim();
    if (s.totalPath !== undefined) st.totalPath = String(s.totalPath).trim();
    if (s.planPath !== undefined) st.planPath = String(s.planPath).trim();
    if (s.requestMethod !== undefined) st.requestMethod = s.requestMethod === 'POST' ? 'POST' : 'GET';
    if (s.requestBody !== undefined) st.requestBody = String(s.requestBody).slice(0, 10000);
    if (s.authMode !== undefined) st.authMode = ['bearer', 'x-api-key', 'query', 'none'].includes(s.authMode) ? s.authMode : 'bearer';
    if (s.authQueryParam !== undefined) st.authQueryParam = String(s.authQueryParam).trim().slice(0, 80) || 'key';
    if (s.tag !== undefined) st.tag = String(s.tag).slice(0, 20);
    if (s.enabled !== undefined) st.enabled = s.enabled !== false;
    if (s.queryMode !== undefined) st.queryMode = ['auto', 'manual', 'paused'].includes(String(s.queryMode)) ? String(s.queryMode) : 'auto';
    if (s.usageEndpoint !== undefined) st.usageEndpoint = nextUsageEndpoint;
    if (s.usageRequestMethod !== undefined) st.usageRequestMethod = s.usageRequestMethod === 'POST' ? 'POST' : 'GET';
    if (s.usageRequestBody !== undefined) st.usageRequestBody = String(s.usageRequestBody).slice(0, 10000);
    if (s.usageAuthMode !== undefined) st.usageAuthMode = ['bearer', 'x-api-key', 'query', 'none'].includes(s.usageAuthMode) ? s.usageAuthMode : 'bearer';
    if (s.usageAuthQueryParam !== undefined) st.usageAuthQueryParam = String(s.usageAuthQueryParam).trim().slice(0, 80) || 'key';
    if (s.usageMap !== undefined) st.usageMap = nextUsageMap;
    if (s.extraHeaders !== undefined && typeof s.extraHeaders === 'object') st.extraHeaders = s.extraHeaders;
    if (s.rawPerUnit !== undefined && Number(s.rawPerUnit) > 0) st.rawPerUnit = Number(s.rawPerUnit);
    if (s.unitCurrency !== undefined) st.unitCurrency = s.unitCurrency === 'CNY' ? 'CNY' : 'USD';
    if (s.thresholdUsd !== undefined) {
      st.thresholdUsd = s.thresholdUsd === null || s.thresholdUsd === '' ? null : Number(s.thresholdUsd);
      if (Number.isNaN(st.thresholdUsd)) st.thresholdUsd = null;
    }
    if (typeof s.token === 'string' && s.token.trim() !== '') st.tokenEnc = store.encrypt(s.token.trim());
    store.save();
    if (st.enabled !== false && st.queryMode !== 'paused' && (st.tokenEnc || (st.preset === 'custom' && st.authMode === 'none'))) await refreshStation(st, cfg);
    store.save();
    return sendJson(res, 200, { ok: true, data: buildState() });
  }

  if (p === '/api/station' && req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    const cfg = store.get();
    const i = cfg.stations.findIndex((x) => x.id === id);
    if (i < 0) return sendJson(res, 404, { ok: false, error: '站点不存在' });
    cfg.stations.splice(i, 1);
    store.removeHistory(id);
    store.save();
    return sendJson(res, 200, { ok: true, data: buildState() });
  }

  // 探测：不落库，只返回识别结果
  if (p === '/api/probe' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = store.get();
    let token = '';
    let st;
    if (body.id) {
      st = cfg.stations.find((x) => x.id === body.id);
      if (!st) return sendJson(res, 404, { ok: false, error: '站点不存在' });
      token = body.token && String(body.token).trim() ? String(body.token).trim() : store.decrypt(st.tokenEnc);
    } else {
      st = store.normalizeStation(body.station || {});
      token = String(body.token || '').trim();
    }
    const t0 = Date.now();
    try {
      let out;
      if (body.preset && body.preset !== 'auto') {
        const r = await probe.query(st, token, body.preset);
        out = { preset: body.preset, result: r };
      } else {
        out = await probe.detect(st, token);
      }
      return sendJson(res, 200, {
        ok: true,
        preset: out.preset,
        ms: Date.now() - t0,
        result: out.result,
      });
    } catch (e) {
      return sendJson(res, 200, { ok: false, ms: Date.now() - t0, error: e.message || String(e), attempts: e.attempts || [] });
    }
  }

  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = store.get();
    if (body.refreshMinutes !== undefined) {
      const v = Number(body.refreshMinutes);
      cfg.refreshMinutes = Number.isFinite(v) && v >= 0 ? Math.min(24 * 60, Math.floor(v)) : 30;
    }
    if (body.thresholdDefaultUsd !== undefined) {
      const v = body.thresholdDefaultUsd;
      cfg.threshold.defaultUsd = v === null || v === '' ? null : Number(v);
    }
    if (body.timeoutMs !== undefined) {
      const v = Number(body.timeoutMs);
      cfg.timeoutMs = Number.isFinite(v) && v >= 1000 ? Math.min(60000, v) : 12000;
    }
    if (body.fx !== undefined) {
      if (body.fx.auto !== undefined) cfg.fx.auto = body.fx.auto !== false;
      if (body.fx.rate !== undefined && Number(body.fx.rate) > 0) {
        cfg.fx.rate = Number(body.fx.rate);
        cfg.fx.source = 'manual';
        cfg.fx.updatedAt = Date.now();
      }
    }
    if (body.notify !== undefined) {
      try { license.assertPaidFeature('推送功能'); }
      catch (error) { return sendJson(res, 403, { ok: false, code: error.code, error: error.message }); }
      try { setNotifySettings(cfg, body.notify); }
      catch (error) { return sendJson(res, 400, { ok: false, error: error.message }); }
    }
    if (body.proxy !== undefined) {
      try {
        cfg.proxy = {
          url: normalizeProxy(body.proxy.url),
          mirrorUrl: normalizeUpdateSource(body.proxy.mirrorUrl ?? cfg.proxy?.mirrorUrl),
        };
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }
    store.save();
    if (body.refreshFx) await refreshFxIfNeeded(true);
    return sendJson(res, 200, { ok: true, data: buildState() });
  }

  if (p === '/api/notify/test' && req.method === 'POST') {
    try { license.assertPaidFeature('推送功能'); }
    catch (error) { return sendJson(res, 403, { ok: false, code: error.code, error: error.message }); }
    const body = await readBody(req);
    const type = String(body.type || 'bark');
    if (!store.NOTIFY_FIELDS[type]) return sendJson(res, 400, { ok: false, error: '不支持的推送渠道' });
    const channel = store.privateNotify().channels[type];
    try {
      await notify.send(type, channel, '✅ 测试推送', 'API 余额面板已接通，来自 Docker 容器');
      return sendJson(res, 200, { ok: true, channel: type });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message || String(e) });
    }
  }

  if (p === '/api/export' && req.method === 'GET') {
    const cfg = store.get();
    return sendJson(res, 200, {
      ok: true,
      data: {
        version: 1,
        exportedAt: Date.now(),
        stations: cfg.stations.map((s) => ({
          name: s.name, baseUrl: s.baseUrl, preset: s.preset, queryPath: s.queryPath,
          quotaPath: s.quotaPath, subtractPath: s.subtractPath, usedPath: s.usedPath,
          totalPath: s.totalPath, planPath: s.planPath, rawPerUnit: s.rawPerUnit,
          requestMethod: s.requestMethod, requestBody: s.requestBody,
          authMode: s.authMode, authQueryParam: s.authQueryParam,
          unitCurrency: s.unitCurrency, tag: s.tag, thresholdUsd: s.thresholdUsd,
          extraHeaders: s.extraHeaders, enabled: s.enabled, queryMode: s.queryMode,
          usageEndpoint: s.usageEndpoint, usageRequestMethod: s.usageRequestMethod,
          usageRequestBody: s.usageRequestBody, usageAuthMode: s.usageAuthMode,
          usageAuthQueryParam: s.usageAuthQueryParam, usageMap: s.usageMap,
          tokenEnc: s.tokenEnc,
        })),
        fx: cfg.fx,
        refreshMinutes: cfg.refreshMinutes,
        threshold: cfg.threshold,
        notify: cfg.notify,
      },
    });
  }

  if (p === '/api/import' && req.method === 'POST') {
    const body = await readBody(req);
    const incoming = body.data || body;
    if (!incoming || !Array.isArray(incoming.stations)) return sendJson(res, 400, { ok: false, error: '配置格式不正确' });
    const cfg = store.get();
    const replace = body.replace === true;
    const list = incoming.stations.map((s) => store.normalizeStation(s));
    try { license.assertStationCount(replace ? list.length : cfg.stations.length + list.length); }
    catch (error) { return sendJson(res, 403, { ok: false, code: error.code, error: error.message }); }
    cfg.stations = replace ? list : cfg.stations.concat(list);
    if (incoming.fx) cfg.fx = Object.assign({}, cfg.fx, incoming.fx);
    if (incoming.threshold) cfg.threshold = Object.assign({}, cfg.threshold, incoming.threshold);
    if (incoming.notify) {
      cfg.notify = store.normalizeNotify(incoming.notify);
      if (!license.state().active) Object.values(cfg.notify.channels).forEach((channel) => { channel.enabled = false; });
    }
    if (incoming.refreshMinutes !== undefined && Number.isFinite(Number(incoming.refreshMinutes))) cfg.refreshMinutes = Math.max(0, Number(incoming.refreshMinutes));
    store.save();
    return sendJson(res, 200, { ok: true, data: buildState() });
  }

  if (p === '/api/alerts/clear' && req.method === 'POST') {
    const cfg = store.get();
    cfg.alerts = [];
    store.save();
    return sendJson(res, 200, { ok: true, data: buildState() });
  }


}

/* ---------------- 静态资源 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // 前端是单页，找不到的路径统一回 index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, Object.assign({ 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }, SECURITY_HEADERS));
        res.end(html);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, Object.assign({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-store' : 'public, max-age=3600',
    }, SECURITY_HEADERS));
    res.end(buf);
  });
}

/* ---------------- 启动 ---------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      console.error('[api]', url.pathname, e);
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    });
    return;
  }
  serveStatic(req, res, url);
});

const startupUpdate = readUpdateStatus();
if (startupUpdate.state === 'installing' && startupUpdate.targetVersion === APP_VERSION) {
  writeUpdateStatus('success', '已升级到 v' + APP_VERSION, '', { targetVersion: APP_VERSION, progress: 100 });
} else if (['queued', 'running', 'installing'].includes(startupUpdate.state)) {
  writeUpdateStatus('failed', '上次更新未完成，请重新尝试');
}

server.listen(PORT, () => {
  const cfg = store.get();
  console.log('API 余额面板已启动: http://0.0.0.0:' + PORT);
  console.log('数据目录: ' + store.DATA_DIR + '，站点数: ' + cfg.stations.length);
  refreshFxIfNeeded(false).then(() => {
    if (store.get().stations.length) return refreshAll();
  }).then(() => checkThresholds()).catch((e) => console.error('[startup]', e.message));
});

// 定时任务：自动刷新 + 阈值提醒
setInterval(async () => {
  try {
    const cfg = store.get();
    const minutes = Number(cfg.refreshMinutes);
    const every = Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 0;
    const autoStations = cfg.stations.filter((s) => s.enabled !== false && s.queryMode === 'auto');
    const lastAt = Math.max(0, ...autoStations.map((s) => (s.last && s.last.at) || 0));
    if (every && autoStations.length && Date.now() - lastAt >= every) {
      await refreshFxIfNeeded(false);
      await refreshAll();
    }
    await checkThresholds();
  } catch (e) {
    console.error('[tick]', e.message);
  }
}, 60 * 1000);

setInterval(() => { refreshFxIfNeeded(false).catch(() => {}); }, 6 * 3600 * 1000);
