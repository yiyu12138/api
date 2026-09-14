'use strict';

(() => {
  if (!window.AndroidApp || window.AndroidApp.isStandalone?.() !== true) return;

  const providers = window.APIBalanceProviders;
  const probe = window.APIBalanceProbe;
  const pending = new Map();
  let requestId = 0;
  const FREE_STATION_LIMIT = 2;
  const CONTACT_EMAIL = 'avhlune@gmail.com';

  function installationId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function nativeRequest(url, options) {
    const id = String(++requestId);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        window.AndroidApp.httpRequest(id, JSON.stringify({
          url,
          method: options?.method || 'GET',
          headers: options?.headers || {},
          body: options?.body || '',
          timeout: options?.timeout || 12000,
        }));
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  window.APIBalanceNative = {
    resolve(id, value) {
      const task = pending.get(String(id));
      if (!task) return;
      pending.delete(String(id));
      try {
        const result = JSON.parse(value);
        if (result.error) task.reject(new Error(result.error));
        else task.resolve(result);
      } catch (error) { task.reject(error); }
    },
  };
  window.APIBalanceNativeRequest = nativeRequest;

  function defaultConfig() {
    return {
      version: 1,
      installId: installationId(),
      licenseCode: '',
      stations: [],
      fx: { auto: true, rate: 7.2, updatedAt: 0, source: 'default' },
      refreshMinutes: 30,
      timeoutMs: 12000,
      threshold: { defaultUsd: 10 },
      notify: {
        pushTime: '09:00',
        channels: {
          bark: { enabled: false, url: '' },
          serverChan: { enabled: false, sendKey: '' },
          pushPlus: { enabled: false, token: '' },
          telegram: { enabled: false, botToken: '', chatId: '' },
          webhook: { enabled: false, url: '' },
        },
      },
      alerts: [],
      history: {},
    };
  }

  function id() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  }

  function normalizeStation(input) {
    const source = input || {};
    return Object.assign({
      id: id(), name: '', baseUrl: '', token: '', preset: 'relay-auto', queryPath: '',
      quotaPath: '', subtractPath: '', usedPath: '', totalPath: '', planPath: '',
      requestMethod: 'GET', requestBody: '', authMode: 'bearer', authQueryParam: 'key',
      rawPerUnit: 500000, unitCurrency: 'USD', tag: '', thresholdUsd: null,
      extraHeaders: {}, enabled: true, queryMode: 'auto', usageEndpoint: '',
      usageRequestMethod: 'GET', usageRequestBody: '', usageAuthMode: 'bearer',
      usageAuthQueryParam: 'key', usageMap: '', failCount: 0, createdAt: Date.now(),
      lastNotifyDay: '', last: null,
    }, source, {
      id: source.id || id(),
      token: source.token || source._token || '',
      enabled: source.enabled !== false,
      rawPerUnit: Number(source.rawPerUnit) > 0 ? Number(source.rawPerUnit) : 1,
      unitCurrency: source.unitCurrency === 'CNY' ? 'CNY' : 'USD',
      extraHeaders: source.extraHeaders && typeof source.extraHeaders === 'object' ? source.extraHeaders : {},
    });
  }

  function mergeConfig(input) {
    const defaults = defaultConfig();
    const source = input && typeof input === 'object' ? input : {};
    const config = Object.assign({}, defaults, source);
    config.fx = Object.assign({}, defaults.fx, source.fx || {});
    config.threshold = Object.assign({}, defaults.threshold, source.threshold || {});
    config.notify = Object.assign({}, defaults.notify, source.notify || {});
    config.notify.channels = {};
    Object.keys(defaults.notify.channels).forEach((type) => {
      config.notify.channels[type] = Object.assign({}, defaults.notify.channels[type], source.notify?.channels?.[type] || {});
    });
    config.stations = Array.isArray(source.stations) ? source.stations.map(normalizeStation) : [];
    config.alerts = Array.isArray(source.alerts) ? source.alerts.slice(-100) : [];
    config.history = source.history && typeof source.history === 'object' ? source.history : {};
    if (!/^[0-9a-f-]{36}$/i.test(String(config.installId || ''))) config.installId = installationId();
    config.licenseCode = String(config.licenseCode || '');
    return config;
  }

  function loadConfig() {
    try { return mergeConfig(JSON.parse(window.AndroidApp.loadState() || '{}')); }
    catch (error) { return defaultConfig(); }
  }

  let config = loadConfig();

  function saveConfig() {
    window.AndroidApp.saveState(JSON.stringify(config));
    window.AndroidApp.scheduleRefresh?.(Number(config.refreshMinutes || 0));
  }

  function mask(value) {
    const text = String(value || '');
    if (!text) return '';
    if (text.length <= 8) return '••••';
    return text.slice(0, 3) + '••••••' + text.slice(-4);
  }

  function publicNotify() {
    const channels = {};
    const fields = { bark: ['url'], serverChan: ['sendKey'], pushPlus: ['token'], telegram: ['botToken', 'chatId'], webhook: ['url'] };
    Object.entries(fields).forEach(([type, names]) => {
      const source = config.notify.channels[type];
      channels[type] = { enabled: source.enabled === true };
      names.forEach((name) => {
        channels[type][name + 'Configured'] = Boolean(source[name]);
        channels[type][name + 'Mask'] = mask(source[name]);
      });
    });
    return { pushTime: config.notify.pushTime || '09:00', channels };
  }

  function publicStation(station) {
    const copy = Object.assign({}, station);
    delete copy.token;
    copy.hasToken = Boolean(station.token);
    copy.tokenMask = mask(station.token);
    copy.history = (config.history[station.id] || []).slice(-240);
    copy.effectiveThresholdUsd = station.thresholdUsd === null || station.thresholdUsd === undefined
      ? config.threshold.defaultUsd : station.thresholdUsd;
    return copy;
  }

  function licenseState() {
    let active = false;
    try { active = Boolean(config.licenseCode && window.AndroidApp.verifyLicense?.(config.licenseCode, config.installId)); }
    catch (error) { active = false; }
    const state = {
      active,
      status: active ? 'active' : (config.licenseCode ? 'invalid' : 'free'),
      installId: config.installId,
      stationLimit: active ? null : FREE_STATION_LIMIT,
      contactEmail: CONTACT_EMAIL,
    };
    return state;
  }

  function assertStationCount(count) {
    if (!licenseState().active && count > FREE_STATION_LIMIT) {
      const error = new Error('免费版最多添加 ' + FREE_STATION_LIMIT + ' 个站点，请在通用设置中激活完整功能');
      error.code = 'LICENSE_REQUIRED';
      throw error;
    }
  }

  function toUsd(value, currency) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
    return currency === 'CNY' ? Number(value) / Number(config.fx.rate || 7.2) : Number(value);
  }

  function pushHistory(stationId, value) {
    if (!Number.isFinite(value)) return;
    const list = config.history[stationId] || (config.history[stationId] = []);
    const now = Date.now();
    const last = list.at(-1);
    if (last && now - last.t < 300000 && Math.abs(last.v - value) < 1e-9) last.t = now;
    else list.push({ t: now, v: Number(value.toFixed(6)) });
    if (list.length > 240) list.splice(0, list.length - 240);
  }

  function buildState() {
    const stations = config.stations.map(publicStation);
    const summary = { totalUsd: 0, normal: 0, low: 0, failed: 0, unknown: 0, count: stations.length };
    stations.forEach((station) => {
      if (!station.enabled) return;
      const last = station.last || {};
      if (Number.isFinite(Number(last.balanceUsd))) summary.totalUsd += Number(last.balanceUsd);
      if (last.ok === false && last.at) summary.failed += 1;
      else if (last.balanceAvailable === false || last.balanceUsd === null || last.balanceUsd === undefined) summary.unknown += 1;
      else if (Number(last.balanceUsd) < Number(station.effectiveThresholdUsd ?? -Infinity)) summary.low += 1;
      else summary.normal += 1;
    });
    return {
      version: window.AndroidApp.getVersionName(), stations, summary,
      settings: {
        refreshMinutes: config.refreshMinutes,
        timeoutMs: config.timeoutMs,
        thresholdDefaultUsd: config.threshold.defaultUsd,
        fx: config.fx,
        notify: publicNotify(),
        proxy: { url: '', mirrorUrl: '' },
        license: licenseState(),
        alerts: config.alerts.slice().reverse(),
        update: { state: 'idle' },
      },
      lastRefreshAt: Math.max(0, ...stations.map((station) => Number(station.last?.at || 0))),
    };
  }

  async function refreshFx(force) {
    if (config.fx.auto === false) return;
    if (!force && config.fx.source === 'auto' && Date.now() - Number(config.fx.updatedAt || 0) < 43200000) return;
    for (const url of ['https://open.er-api.com/v6/latest/USD', 'https://api.exchangerate-api.com/v4/latest/USD']) {
      try {
        const response = await nativeRequest(url, { timeout: 8000, headers: { Accept: 'application/json' } });
        const value = Number(response.json?.rates?.CNY);
        if (response.ok && value > 0.5 && value < 50) {
          config.fx = { auto: true, rate: Number(value.toFixed(4)), updatedAt: Date.now(), source: 'auto' };
          return;
        }
      } catch (error) { /* try fallback */ }
    }
  }

  async function refreshStation(station) {
    const started = Date.now();
    try {
      let result;
      try { result = await probe.query(Object.assign({ timeoutMs: config.timeoutMs }, station), station.token); }
      catch (firstError) { result = await probe.query(Object.assign({ timeoutMs: config.timeoutMs }, station), station.token); }
      const balanceUsd = toUsd(result.balance, result.currency);
      station.failCount = 0;
      station.last = {
        ok: true, at: Date.now(), ms: Date.now() - started, mode: result.mode, kind: result.kind,
        currency: result.currency, balance: result.balance, used: result.used, total: result.total,
        requests: result.requests, group: result.group, extra: result.extra || {}, note: result.note || '',
        balanceAvailable: result.balanceAvailable !== false, balanceUsd,
        stale: result.balanceAvailable === false, error: null,
      };
      if (balanceUsd !== null) pushHistory(station.id, balanceUsd);
    } catch (error) {
      station.failCount = Number(station.failCount || 0) + 1;
      const message = error.message || String(error);
      station.last = Object.assign({}, station.last || {}, {
        ok: false, error: message,
        errorCategory: /timeout|超时/i.test(message) ? 'timeout' : /401|403|key|token|密钥|令牌|unauthor/i.test(message) ? 'auth' : /network|网络|证书|TLS/i.test(message) ? 'network' : 'provider',
        failCount: station.failCount, ms: Date.now() - started, at: Date.now(), stale: true,
      });
    }
  }

  async function refreshAll(onlyId) {
    await refreshFx(false);
    const list = config.stations.filter((station) => station.enabled !== false
      && (onlyId ? station.id === onlyId : station.queryMode === 'auto'));
    await Promise.all(list.map(refreshStation));
    await checkThresholds();
    saveConfig();
  }

  function notificationRequest(type, channel, title, body) {
    if (type === 'bark') {
      if (!channel.url) throw new Error('未配置 Bark 地址');
      const url = new URL(channel.url);
      url.pathname = url.pathname.replace(/\/+$/, '') + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(body);
      url.searchParams.set('group', 'API余额');
      return { url: url.toString() };
    }
    if (type === 'serverChan') return { url: 'https://sctapi.ftqq.com/' + encodeURIComponent(channel.sendKey) + '.send', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ title, desp: body }).toString() };
    if (type === 'pushPlus') return { url: 'https://www.pushplus.plus/send', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: channel.token, title, content: body, template: 'txt' }) };
    if (type === 'telegram') return { url: 'https://api.telegram.org/bot' + encodeURIComponent(channel.botToken) + '/sendMessage', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: channel.chatId, text: title + '\n' + body }) };
    if (type === 'webhook') return { url: channel.url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body, source: 'API Balance Android', at: new Date().toISOString() }) };
    throw new Error('不支持的推送渠道');
  }

  async function sendNotification(type, title, body) {
    const request = notificationRequest(type, config.notify.channels[type] || {}, title, body);
    const response = await nativeRequest(request.url, Object.assign({ timeout: 8000 }, request));
    if (!response.ok) throw new Error(type + ' HTTP ' + response.status);
  }

  async function checkThresholds() {
    const enabled = Object.entries(config.notify.channels).filter(([, channel]) => channel.enabled === true);
    if (!enabled.length) return;
    const now = new Date();
    const day = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const time = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (time < String(config.notify.pushTime || '09:00')) return;
    for (const station of config.stations) {
      const last = station.last;
      const threshold = station.thresholdUsd ?? config.threshold.defaultUsd;
      if (!station.enabled || !last?.ok || !Number.isFinite(Number(last.balanceUsd)) || threshold === null || Number(last.balanceUsd) >= Number(threshold) || station.lastNotifyDay === day) continue;
      const message = '当前 $' + Number(last.balanceUsd).toFixed(2) + '，低于阈值 $' + Number(threshold).toFixed(2);
      const results = await Promise.allSettled(enabled.map(([type]) => sendNotification(type, '⚠️ ' + (station.name || '中转站') + ' 余额偏低', message)));
      if (results.some((result) => result.status === 'fulfilled')) {
        station.lastNotifyDay = day;
        config.alerts.push({ at: Date.now(), stationId: station.id, stationName: station.name, type: 'low', message });
        if (config.alerts.length > 100) config.alerts.splice(0, config.alerts.length - 100);
      }
    }
  }

  function updateNotify(input) {
    if (!input || typeof input !== 'object') return;
    if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(input.pushTime || ''))) config.notify.pushTime = input.pushTime;
    const fields = { bark: ['url'], serverChan: ['sendKey'], pushPlus: ['token'], telegram: ['botToken', 'chatId'], webhook: ['url'] };
    Object.entries(fields).forEach(([type, names]) => {
      const source = input.channels?.[type];
      if (!source) return;
      config.notify.channels[type].enabled = source.enabled === true;
      names.forEach((name) => { if (String(source[name] || '').trim()) config.notify.channels[type][name] = String(source[name]).trim(); });
    });
  }

  function compareVersions(a, b) {
    const left = String(a || '').replace(/^v/, '').split('.').map(Number);
    const right = String(b || '').replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
    }
    return 0;
  }

  function parseReleaseNotes(value) {
    return String(value || '').replace(/\r/g, '').split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^#{1,6}\s/.test(line) && !/^(?:\*\*)?(?:Full Changelog|完整更新日志)/i.test(line))
      .map((line) => line.replace(/^[-*+]\s*/, '').replace(/\[([^\]]+)]\([^)]+\)/g, '$1').replace(/[*_`]/g, '').trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  async function versionInfo() {
    const current = window.AndroidApp.getVersionName();
    try {
      const response = await nativeRequest('https://api.github.com/repos/yiyu12138/api/releases/latest', { timeout: 12000, headers: { Accept: 'application/vnd.github+json' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const release = response.json || {};
      const latest = String(release.tag_name || '').replace(/^v/, '');
      const apk = Array.isArray(release.assets) ? release.assets.find((asset) => asset?.name === 'api-balance.apk') : null;
      return {
        current, latest, updateAvailable: compareVersions(latest, current) > 0,
        source: 'GitHub Release', releaseUrl: release.html_url || '', releasedAt: release.published_at || '',
        releaseNotes: parseReleaseNotes(release.body), apkSize: Number(apk?.size) || 0, checkedAt: Date.now(),
      };
    } catch (error) {
      return { current, latest: '', updateAvailable: false, error: '无法连接 GitHub：' + error.message, checkedAt: Date.now() };
    }
  }

  async function apiRequest(path, init) {
    const url = new URL(path, 'https://app.local');
    const method = String(init?.method || 'GET').toUpperCase();
    let body = {};
    if (init?.body) body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;

    if (url.pathname === '/api/bootstrap') return { ok: true, presets: providers.PRESETS, version: window.AndroidApp.getVersionName() };
    if (url.pathname === '/api/health') return { ok: true, ts: Date.now() };
    if (url.pathname === '/api/state') return { ok: true, data: buildState() };
    if (url.pathname === '/api/version') return { ok: true, data: await versionInfo() };
    if (url.pathname === '/api/update') return { ok: true, data: { state: 'idle' } };
    if (url.pathname === '/api/license/activate' && method === 'POST') {
      const code = String(body.code || '').trim();
      if (!code || !window.AndroidApp.verifyLicense?.(code, config.installId)) return { ok: false, error: '激活码无效或不属于当前设备' };
      config.licenseCode = code;
      saveConfig();
      return { ok: true, data: buildState() };
    }
    if (url.pathname === '/api/refresh' && method === 'POST') {
      const started = Date.now();
      await refreshAll(body.id || null);
      const state = buildState();
      state.elapsedMs = Date.now() - started;
      return { ok: true, data: state };
    }
    if (url.pathname === '/api/usage') {
      const station = config.stations.find((item) => item.id === url.searchParams.get('id'));
      if (!station) throw new Error('站点不存在');
      try {
        const usage = await probe.queryUsage(Object.assign({ timeoutMs: config.timeoutMs }, station), station.token, config.fx.rate);
        return { ok: true, data: probe.aggregateUsage(usage, url.searchParams.get('range') || 'today') };
      } catch (error) { return { ok: false, error: error.message || String(error) }; }
    }
    if (url.pathname === '/api/probe' && method === 'POST') {
      const station = body.id ? config.stations.find((item) => item.id === body.id) : normalizeStation(body.station || {});
      if (!station) throw new Error('站点不存在');
      const token = String(body.token || '').trim() || station.token;
      const started = Date.now();
      try {
        const result = body.preset && body.preset !== 'auto'
          ? { preset: body.preset, result: await probe.query(Object.assign({ timeoutMs: config.timeoutMs }, station), token, body.preset) }
          : await probe.detect(Object.assign({ timeoutMs: config.timeoutMs }, station), token);
        return { ok: true, preset: result.preset, result: result.result, ms: Date.now() - started };
      } catch (error) { return { ok: false, error: error.message || String(error), attempts: error.attempts || [], ms: Date.now() - started }; }
    }
    if (url.pathname === '/api/station' && method === 'POST') {
      const source = body.station || {};
      let station = source.id ? config.stations.find((item) => item.id === source.id) : null;
      if (source.id && !station) throw new Error('站点不存在');
      if (!station) {
        assertStationCount(config.stations.length + 1);
        station = normalizeStation(source);
        config.stations.push(station);
      }
      const preservedToken = station.token;
      Object.assign(station, source);
      station.token = String(source.token || '').trim() || preservedToken;
      station.rawPerUnit = Number(station.rawPerUnit) > 0 ? Number(station.rawPerUnit) : 1;
      station.enabled = station.enabled !== false;
      if (station.usageMap) probe.parseUsageMap(station.usageMap);
      if (station.enabled && station.queryMode !== 'paused' && (station.token || (station.preset === 'custom' && station.authMode === 'none'))) await refreshStation(station);
      saveConfig();
      return { ok: true, data: buildState() };
    }
    if (url.pathname === '/api/station' && method === 'DELETE') {
      const stationId = url.searchParams.get('id');
      const index = config.stations.findIndex((item) => item.id === stationId);
      if (index < 0) throw new Error('站点不存在');
      config.stations.splice(index, 1);
      delete config.history[stationId];
      saveConfig();
      return { ok: true, data: buildState() };
    }
    if (url.pathname === '/api/settings' && method === 'POST') {
      if (body.refreshMinutes !== undefined) config.refreshMinutes = Math.max(0, Math.min(1440, Math.floor(Number(body.refreshMinutes) || 0)));
      if (body.timeoutMs !== undefined) config.timeoutMs = Math.max(1000, Math.min(60000, Number(body.timeoutMs) || 12000));
      if (body.thresholdDefaultUsd !== undefined) config.threshold.defaultUsd = body.thresholdDefaultUsd === '' || body.thresholdDefaultUsd === null ? null : Number(body.thresholdDefaultUsd);
      if (body.fx) {
        config.fx.auto = body.fx.auto !== false;
        if (Number(body.fx.rate) > 0) Object.assign(config.fx, { rate: Number(body.fx.rate), source: 'manual', updatedAt: Date.now() });
      }
      if (body.notify) updateNotify(body.notify);
      if (body.refreshFx) await refreshFx(true);
      saveConfig();
      return { ok: true, data: buildState() };
    }
    if (url.pathname === '/api/notify/test' && method === 'POST') {
      try {
        await sendNotification(String(body.type || 'bark'), '✅ 测试推送', 'API Balance 安卓独立版已接通');
        return { ok: true, channel: body.type };
      } catch (error) { return { ok: false, error: error.message || String(error) }; }
    }
    if (url.pathname === '/api/alerts/clear' && method === 'POST') {
      config.alerts = [];
      saveConfig();
      return { ok: true, data: buildState() };
    }
    if (url.pathname === '/api/import' && method === 'POST') {
      const incoming = body.data || body;
      if (!Array.isArray(incoming.stations)) throw new Error('配置格式不正确');
      const imported = incoming.stations.map(normalizeStation);
      assertStationCount(body.replace === true ? imported.length : config.stations.length + imported.length);
      config.stations = body.replace === true ? imported : config.stations.concat(imported);
      if (incoming.fx) config.fx = Object.assign(config.fx, incoming.fx);
      if (incoming.threshold) config.threshold = Object.assign(config.threshold, incoming.threshold);
      if (incoming.notify) config.notify = mergeConfig({ notify: incoming.notify }).notify;
      if (Number.isFinite(Number(incoming.refreshMinutes))) config.refreshMinutes = Math.max(0, Number(incoming.refreshMinutes));
      saveConfig();
      return { ok: true, data: buildState() };
    }
    throw new Error('本地应用不支持此操作');
  }

  function exportConfig() {
    return JSON.stringify({
      version: 1, exportedAt: Date.now(), source: 'API Balance Android',
      stations: config.stations.map((station) => Object.assign({}, station, { last: null })),
      fx: config.fx, refreshMinutes: config.refreshMinutes, threshold: config.threshold, notify: config.notify,
    }, null, 2);
  }

  window.AndroidStandalone = { request: apiRequest, exportConfig };

  window.addEventListener?.('api-balance-resume', () => {
    config = loadConfig();
    window.dispatchEvent(new Event('api-balance-state-changed'));
  });
  saveConfig();

  let timerBusy = false;
  window.setInterval(async () => {
    const minutes = Number(config.refreshMinutes || 0);
    const last = Math.max(0, ...config.stations.map((station) => Number(station.last?.at || 0)));
    if (timerBusy || minutes <= 0 || !config.stations.length || Date.now() - last < minutes * 60000) return;
    timerBusy = true;
    try {
      await refreshAll();
      window.dispatchEvent(new CustomEvent('api-balance-state-changed'));
    } finally { timerBusy = false; }
  }, 60000);
})();
