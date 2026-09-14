'use strict';
/**
 * 统一余额查询：把「中转站」和「官方厂商」两类来源归一成同一份结构。
 *
 * 返回结构：
 *   { mode, kind, currency, balance, used, total, requests, group, extra, note, balanceAvailable }
 * balance 为 null 表示该来源查不到余额（只做了 Key 可用性检测）。
 */
const providerModule = typeof module !== 'undefined' && module.exports
  ? require('./providers')
  : globalThis.APIBalanceProviders;
const { PRESETS, getPreset } = providerModule;

const DEFAULT_TIMEOUT = 12000;

/* ---------------- 基础工具 ---------------- */
async function request(url, opts) {
  const o = opts || {};
  const timeout = o.timeout || DEFAULT_TIMEOUT;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const headers = Object.assign({ Accept: 'application/json' }, o.headers || {});
  if (o.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  if (typeof globalThis.APIBalanceNativeRequest === 'function') {
    return globalThis.APIBalanceNativeRequest(url, {
      method: o.method || 'GET', headers, body: o.body || '', timeout,
    });
  }
  try {
    const res = await fetch(url, {
      method: o.method || 'GET',
      headers,
      body: o.body,
      signal: ac.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应，保留原文用于报错 */ }
    return { status: res.status, ok: res.ok, json, text: String(text).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,\s$¥￥]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function getPath(obj, p) {
  if (!p) return undefined;
  return String(p).split('.').reduce((o, k) => {
    if (o === null || o === undefined) return undefined;
    const key = /^\d+$/.test(k) ? Number(k) : k;
    return o[key];
  }, obj);
}

function joinUrl(base, p) {
  if (/^https?:\/\//i.test(String(p || ''))) return String(p);
  return String(base || '').replace(/\/+$/, '') + p;
}

function cleanExtra(extra) {
  const out = {};
  Object.keys(extra || {}).forEach((k) => {
    const v = extra[k];
    if (v !== null && v !== undefined && v !== '') out[k] = String(v);
  });
  return out;
}

function fillTemplate(value, st, token) {
  const vars = {
    apiKey: token,
    accessToken: token,
    baseUrl: String(st.baseUrl || '').replace(/\/+$/, ''),
    userId: String(st.extraHeaders?.['New-Api-User'] || ''),
  };
  return String(value || '').replace(/\{\{(apiKey|accessToken|baseUrl|userId)\}\}/g, (_, key) => vars[key]);
}

function fillJsonTemplate(value, st, token) {
  let parsed;
  try { parsed = JSON.parse(String(value)); } catch (e) { throw new Error('请求 JSON 格式不正确'); }
  const walk = (item) => {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, walk(val)]));
    return typeof item === 'string' ? fillTemplate(item, st, token) : item;
  };
  return JSON.stringify(walk(parsed));
}

/* ---------------- 统一构造查询参数 ---------------- */
function buildCall(preset, base, token, path, timeout, extraHeaders, requestOptions) {
  const options = requestOptions || {};
  const headers = Object.assign({}, preset.extraHeaders || {}, extraHeaders || {});
  let url = joinUrl(base, path);
  let bearer = null;

  if (preset.auth === 'query') {
    const u = new URL(url);
    u.searchParams.set(preset.queryParam || 'key', token);
    url = u.toString();
  } else if (preset.auth === 'x-api-key') {
    headers['x-api-key'] = token;
  } else if (preset.auth !== 'none') {
    bearer = token;
  }
  return request(url, { token: bearer, headers, timeout, method: options.method, body: options.body });
}

/* ---------------- 各策略 ---------------- */

// 1) new-api / one-api 中转站
function fromNewApi(json, st) {
  const d = json && json.data;
  if (!d || typeof d !== 'object') return null;
  const quota = num(d.quota);
  if (quota === null) return null;
  const ratio = Number(st.rawPerUnit) > 0 ? Number(st.rawPerUnit) : 500000;
  const currency = st.unitCurrency === 'CNY' ? 'CNY' : 'USD';
  const usedRaw = num(d.used_quota);
  const balance = quota / ratio;
  const used = usedRaw === null ? null : usedRaw / ratio;
  return {
    mode: 'new-api',
    kind: 'relay',
    currency,
    balance,
    used,
    total: used === null ? null : balance + used,
    requests: num(d.request_count),
    group: d.group || null,
    extra: cleanExtra({
      用户名: d.username || d.display_name || null,
      分组倍率: d.group || null,
      邀请码: d.aff_code || null,
    }),
    balanceAvailable: true,
  };
}

// 2) OpenAI 计费接口
function fromOpenAI(sub, usage) {
  if (!sub || typeof sub !== 'object') return null;
  const limit = num(sub.hard_limit_usd !== undefined ? sub.hard_limit_usd : sub.system_hard_limit_usd);
  if (limit === null) return null;
  const usedRaw = num(usage && usage.total_usage);
  const used = usedRaw === null ? null : usedRaw / 100;
  if (limit >= 100000000) {
    return {
      mode: 'openai-billing', kind: 'billing', currency: 'USD',
      balance: null, used, total: null, requests: null, group: null,
      extra: cleanExtra({ 额度上限: '无限制' }),
      note: '接口返回无限额度占位值，无法作为真实余额', balanceAvailable: false,
    };
  }
  return {
    mode: 'openai-billing',
    kind: 'billing',
    currency: 'USD',
    balance: used === null ? limit : Math.max(0, limit - used),
    used,
    total: limit,
    requests: null,
    group: null,
    extra: cleanExtra({ 额度上限: '$' + limit.toFixed(2) }),
    balanceAvailable: true,
  };
}

// 3) 官方余额接口 / 自定义 JSON 路径
function fromPath(json, spec) {
  const raw = num(getPath(json, spec.balancePath));
  if (raw === null) return null;
  const sub = spec.subtractPath ? num(getPath(json, spec.subtractPath)) : null;
  const ratio = Number(spec.rawPerUnit) > 0 ? Number(spec.rawPerUnit) : 1;
  const currency = spec.currency === 'CNY' ? 'CNY' : 'USD';
  const directUsed = spec.usedPath ? num(getPath(json, spec.usedPath)) : null;
  const directTotal = spec.totalPath ? num(getPath(json, spec.totalPath)) : null;
  const used = directUsed === null ? (sub === null ? null : sub / ratio) : directUsed / ratio;
  const balance = (sub === null ? raw : raw - sub) / ratio;
  const extra = {};
  Object.keys(spec.extraPaths || {}).forEach((label) => {
    const v = num(getPath(json, spec.extraPaths[label]));
    if (v !== null) extra[label] = String(v / ratio);
  });
  return {
    mode: spec.mode || 'vendor',
    kind: 'vendor',
    currency,
    balance,
    used,
    total: directTotal === null ? (used === null ? null : balance + used) : directTotal / ratio,
    requests: null,
    group: spec.planPath ? getPath(json, spec.planPath) || null : null,
    extra: cleanExtra(extra),
    balanceAvailable: true,
  };
}

// 4) Key 可用性检测
async function checkConnectivity(preset, base, token, timeout, extraHeaders) {
  const paths = preset.testPaths || preset.testPath ? (preset.testPaths || [preset.testPath]) : ['/v1/models'];
  const tried = [];
  for (const p of paths) {
    try {
      const r = await buildCall(preset, base, token, p, timeout, extraHeaders);
      if (r.ok) return { ok: true, path: p };
      if (r.status === 401 || r.status === 403) {
        return { ok: false, error: 'Key 无效或无权限（HTTP ' + r.status + '）', path: p };
      }
      tried.push(p + ' → HTTP ' + r.status);
    } catch (e) {
      tried.push(p + ' → ' + e.message);
    }
  }
  return { ok: false, error: tried.join('；') };
}

function fromBalance(json, mode, station) {
  if (!json || typeof json !== 'object') return null;
  const balance = num(json.available !== undefined ? json.available : json.remaining);
  if (balance === null) return null;
  const used = num(json.used !== undefined ? json.used : json.spent);
  const total = num(json.total !== undefined ? json.total : json.budget);
  const stationCurrency = station && station.unitCurrency === 'CNY' ? 'CNY' : 'USD';
  const currency = mode === 'soleapi' ? stationCurrency : (station && station.unitCurrency === 'CNY' ? 'CNY' : 'USD');
  return {
    mode: mode || 'balance', kind: 'balance', currency, balance,
    used, total: total === null ? (used === null ? null : balance + used) : total,
    requests: null, group: null, extra: cleanExtra({ 单位: json.unit }), balanceAvailable: true,
  };
}

function knownBalanceEndpoint(base) {
  let u;
  try { u = new URL(base); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  if (host === 'cf-api.derouter.ai' || host.endsWith('.derouter.ai')) {
    const path = u.pathname.replace(/\/+$/, '');
    return { url: path === '/sub-key/balance' ? u.toString() : path === '/balance' ? u.toString() : u.origin + '/balance', mode: path === '/sub-key/balance' ? 'derouter-sub-key' : 'derouter' };
  }
  if (host === 'soleapi.com' || host === 'www.soleapi.com') {
    const path = u.pathname.replace(/\/+$/, '');
    return { url: path === '/v1/usage' ? u.toString() : u.origin + '/v1/usage', mode: 'soleapi' };
  }
  return null;
}

function shanghaiDayKey(value) {
  const t = new Date(value || 0);
  if (!Number.isFinite(t.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(t);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return get('year') + '-' + get('month') + '-' + get('day');
}

function addDaysKey(key, delta) {
  const d = new Date(key + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function parseUsageMap(value) {
  let map;
  try { map = typeof value === 'string' ? JSON.parse(value) : value; } catch (e) { throw new Error('用量字段映射不是有效 JSON'); }
  if (!map || typeof map !== 'object' || !map.periods || !map.metrics) throw new Error('用量字段映射缺少 periods 或 metrics');
  return map;
}

async function queryMappedUsage(st, token, fxRate) {
  const map = parseUsageMap(st.usageMap);
  const endpoint = fillTemplate(st.usageEndpoint, st, token);
  const method = st.usageRequestMethod === 'POST' ? 'POST' : 'GET';
  const body = method === 'POST' && st.usageRequestBody ? fillJsonTemplate(st.usageRequestBody, st, token) : undefined;
  const auth = ['bearer', 'x-api-key', 'query', 'none'].includes(st.usageAuthMode) ? st.usageAuthMode : 'bearer';
  const r = await buildCall({ auth, queryParam: st.usageAuthQueryParam || 'key' }, new URL(st.baseUrl).origin, token, endpoint,
    Number(st.timeoutMs) > 0 ? Number(st.timeoutMs) : DEFAULT_TIMEOUT, st.extraHeaders, { method, body });
  if (!r.ok || !r.json) throw new Error('自定义用量接口不可用（HTTP ' + r.status + '）');
  const metric = map.metrics;
  const modelMap = map.model || {};
  const costDivisor = Number(map.costDivisor) > 0 ? Number(map.costDivisor) : 1;
  const costCurrency = map.costCurrency === 'CNY' ? 'CNY' : 'USD';
  const costUsd = (value) => {
    const amount = num(value);
    if (amount === null) return null;
    const normalized = amount / costDivisor;
    return costCurrency === 'CNY' ? normalized / (Number(fxRate) > 0 ? Number(fxRate) : 7.2) : normalized;
  };
  const periods = {};
  Object.entries(map.periods).forEach(([key, path]) => {
    const source = getPath(r.json, path);
    if (!source || typeof source !== 'object') return;
    const models = getPath(source, metric.models);
    periods[key] = {
      requests: num(getPath(source, metric.requests)),
      successCount: num(getPath(source, metric.successCount)),
      failedCount: num(getPath(source, metric.failedCount)),
      successRate: num(getPath(source, metric.successRate)),
      promptTokens: num(getPath(source, metric.inputTokens)),
      completionTokens: num(getPath(source, metric.outputTokens)),
      totalTokens: num(getPath(source, metric.totalTokens)),
      cost: costUsd(getPath(source, metric.cost)),
      topModels: Array.isArray(models) ? models.map((item) => ({
        modelId: getPath(item, modelMap.id),
        modelName: getPath(item, modelMap.name),
        requests: num(getPath(item, modelMap.requests)),
        totalTokens: num(getPath(item, modelMap.tokens)),
        cost: costUsd(getPath(item, modelMap.cost)),
        successRate: num(getPath(item, modelMap.successRate)),
      })) : [],
    };
  });
  const summaryMap = map.summary || {};
  return {
    source: 'configured-summary', detail: true, requestDetail: false,
    summary: {
      remaining: num(getPath(r.json, summaryMap.remaining)),
      used: num(getPath(r.json, summaryMap.used)),
      total: num(getPath(r.json, summaryMap.total)),
      unit: getPath(r.json, summaryMap.unit) || '',
    },
    periods,
    timezone: getPath(r.json, map.timezone) || 'Asia/Shanghai',
    logs: [], fetchedAt: Date.now(), complete: true,
  };
}

function aggregateUsage(usage, range) {
  range = ['today','yesterday','7d','30d'].includes(range) ? range : 'today';
  if (usage.periods) {
    const key = { today: 'today', yesterday: 'yesterday', '7d': 'last7d', '30d': 'last30d' }[range];
    const p = usage.periods[key];
    if (!p) return { source:usage.source, detail:true, requestDetail:false, summary:usage.summary||null, range, timezone:usage.timezone, unavailable:true, unavailableReason:'用量接口暂未返回该时间窗口', today:{cost:null,requests:null,successCount:null,failedCount:null,successRate:null,inputTokens:null,outputTokens:null,totalTokens:null,cacheReadTokens:null,cacheWriteTokens:null}, models:[], trend:[], logs:[], complete:true, fetchedAt:usage.fetchedAt };
    const value = (input) => input === null || input === undefined ? null : Number(input);
    return { source:usage.source, detail:true, requestDetail:false, summary:usage.summary||null, range, timezone:usage.timezone, today:{cost:value(p.cost),requests:value(p.requests),successCount:value(p.successCount),failedCount:value(p.failedCount),successRate:value(p.successRate),inputTokens:value(p.promptTokens),outputTokens:value(p.completionTokens),totalTokens:value(p.totalTokens),cacheReadTokens:null,cacheWriteTokens:null}, models:(p.topModels||[]).map(m=>({model:m.modelName||m.modelId||'未知模型',requests:value(m.requests),cost:value(m.cost),inputTokens:null,outputTokens:value(m.totalTokens),successRate:value(m.successRate)})), trend:[], logs:[], complete:true, fetchedAt:usage.fetchedAt };
  }
  const todayKey = shanghaiDayKey(Date.now());
  const startKey = addDaysKey(todayKey, range === 'yesterday' ? -1 : range === '7d' ? -6 : range === '30d' ? -29 : 0);
  const endKey = range === 'yesterday' ? startKey : todayKey;
  const pick = (x, keys) => { for (const k of keys) if(x[k] !== null && x[k] !== undefined && x[k] !== '' && Number.isFinite(Number(x[k]))) return Number(x[k]); return 0; };
  const selected = (usage.logs || []).filter(x => { const key=shanghaiDayKey(x.created_at || x.createdAt); return key >= startKey && key <= endKey; }).sort((a,b)=>new Date(b.created_at || b.createdAt)-new Date(a.created_at || a.createdAt));
  const blank = () => ({cost:0,requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0});
  const totals=blank(), models={}, days={};
  for(let key=startKey;key<=endKey;key=addDaysKey(key,1)) days[key]={date:key,...blank()};
  for(const x of selected){
    const value={cost:pick(x,['cost_usdc','cost_usd','cost','amount']),requests:1,inputTokens:pick(x,['input_tokens','inputTokens']),outputTokens:pick(x,['output_tokens','outputTokens']),cacheReadTokens:pick(x,['cache_read_tokens','cacheReadTokens']),cacheWriteTokens:pick(x,['cache_write_tokens','cacheWriteTokens'])};
    const model=x.model || '未知模型', day=shanghaiDayKey(x.created_at || x.createdAt);
    models[model] ||= {model,...blank()};
    for(const target of [totals,models[model],days[day]]) for(const k of Object.keys(value)) target[k]+=value[k];
  }
  return {source:usage.source,detail:usage.detail,summary:usage.summary || null,range,timeZone:'Asia/Shanghai',startDate:startKey,endDate:endKey,fetchedAt:usage.fetchedAt || Date.now(),complete:usage.complete !== false,warning:usage.warning || '',fetchedRecords:(usage.logs || []).length,expectedRecords:usage.expectedRecords ?? null,today:totals,models:Object.values(models).sort((a,b)=>b.cost-a.cost),trend:Object.values(days),logs:selected.slice(0,100)};
}

async function queryUsage(st, token, fxRate) {
  if (!token && !(st.usageEndpoint && st.usageAuthMode === 'none')) throw new Error('未填写密钥');
  if (st.usageEndpoint) return queryMappedUsage(st, token, fxRate);
  let u;
  try { u = new URL(String(st.baseUrl || '').trim()); } catch (e) { throw new Error('站点地址格式不正确'); }
  const host = u.hostname.toLowerCase();
  const origin = u.origin;
  if (host === 'cf-api.derouter.ai' || host.endsWith('.derouter.ai')) {
    const paths = ['/usage-logs?page=1&limit=100', '/sub-key/usage-logs?page=1&limit=100'];
    let first = null;
    for (const path of paths) {
      const r = await request(origin + path, { token, timeout: Number(st.timeoutMs) > 0 ? Number(st.timeoutMs) : DEFAULT_TIMEOUT });
      if (r.ok && r.json && Array.isArray(r.json.data)) { first = { r, path }; break; }
      if (r.status !== 401 && r.status !== 403 && !first) first = { r, path };
    }
    if (!first || !first.r.ok || !first.r.json || !Array.isArray(first.r.json.data)) {
      throw new Error('用量日志接口不可用（请确认使用账户密钥或客户密钥）');
    }
    const logs = first.r.json.data.slice();
    const pagination = first.r.json.pagination || {};
    let cursor = pagination.nextCursor;
    let hasMore = pagination.hasMore === true;
    let complete = true, warning = '';
    const fingerprint = (x) => JSON.stringify([x.request_id,x.id,x.created_at,x.model,x.cost_usdc,x.input_tokens,x.output_tokens,x.duration_ms]);
    const seen = new Set(logs.map(fingerprint));
    let calls = 1;
    while (hasMore && cursor !== null && cursor !== undefined && calls < 2000) {
      const separator = first.path.includes('?') ? '&' : '?';
      const r = await request(origin + first.path + separator + 'cursor=' + encodeURIComponent(cursor), { token, timeout: Number(st.timeoutMs) > 0 ? Number(st.timeoutMs) : DEFAULT_TIMEOUT });
      calls += 1;
      if (!r.ok || !r.json || !Array.isArray(r.json.data)) { complete=false; warning='游标 '+cursor+' 后的日志读取失败'; break; }
      let added=0;
      r.json.data.forEach(x=>{const key=fingerprint(x);if(!seen.has(key)){seen.add(key);logs.push(x);added++;}});
      const meta=r.json.pagination || {};
      if (!r.json.data.length) { hasMore=false; break; }
      if (added===0 || meta.nextCursor===cursor) { complete=false;warning='用量接口游标没有前进，当前仅为部分数据';break; }
      cursor=meta.nextCursor; hasMore=meta.hasMore===true;
    }
    if(hasMore){complete=false;warning=warning || '日志超过安全读取上限，当前仅为部分数据';}
    return { source: first.path.startsWith('/sub-key/') ? 'derouter-sub-key' : 'derouter', detail: true, logs, complete, warning, expectedRecords:null, fetchedAt:Date.now() };
  }
  if (host === 'soleapi.com' || host === 'www.soleapi.com') {
    const r = await request(origin + '/v1/usage', { token, timeout: Number(st.timeoutMs) > 0 ? Number(st.timeoutMs) : DEFAULT_TIMEOUT });
    if (!r.ok || !r.json) {
      if (r.status === 401 || r.status === 403) throw new Error('Key 无效或无权限（HTTP ' + r.status + '）');
      throw new Error('SoleAPI 用量接口不可用（HTTP ' + r.status + '）');
    }
    return { source: 'soleapi', detail: true, requestDetail: false, summary: r.json, periods: r.json.periods || {}, timezone: r.json.timezone || 'Asia/Tokyo', logs: [], fetchedAt: Date.now(), complete: true };
  }
  throw new Error('该站点暂未配置用量统计接口');
}

/* ---------------- 主入口 ---------------- */

/**
 * @param {object} st      站点配置（含 baseUrl / preset / tokenEnc 解出的 token 等）
 * @param {string} token   明文密钥
 * @param {string} [presetId] 覆盖预设（探测时用）
 */
async function query(st, token, presetId) {
  const preset = getPreset(presetId || st.preset || 'relay-auto');
  const base = String(st.baseUrl || preset.baseUrl || '').trim();
  if (!base) throw new Error('未填写查询地址');
  if (!token && !(preset.kind === 'custom' && st.authMode === 'none')) throw new Error('未填写密钥');

  const timeout = Number(st.timeoutMs) > 0 ? Number(st.timeoutMs) : DEFAULT_TIMEOUT;
  const extraHeaders = st.extraHeaders && typeof st.extraHeaders === 'object' ? st.extraHeaders : {};

  const known = knownBalanceEndpoint(base);
  if (known) {
    const r = await request(known.url, { token, headers: extraHeaders, timeout });
    const d = fromBalance(r.json, known.mode, st);
    if (d) return d;
    if (r.status === 401 || r.status === 403) throw new Error('Key 无效或无权限（HTTP ' + r.status + '）');
    throw new Error('余额接口返回格式无法识别（HTTP ' + r.status + '）');
  }

  /* --- 中转站：依次尝试 new-api → OpenAI 计费 → 自定义 --- */
  if (preset.kind === 'relay') {
    const attempts = [];
    try {
      const r = await request(joinUrl(base, '/api/user/self'), { token, headers: extraHeaders, timeout });
      const d = fromNewApi(r.json, st);
      if (d) return d;
      attempts.push('new-api → HTTP ' + r.status + (r.json && r.json.message ? ' ' + r.json.message : ''));
    } catch (e) { attempts.push('new-api → ' + e.message); }

    try {
      const r1 = await request(joinUrl(base, '/dashboard/billing/subscription'), { token, headers: extraHeaders, timeout });
      if (r1.json) {
        const r2 = await request(joinUrl(base, '/dashboard/billing/usage'), { token, headers: extraHeaders, timeout });
        const d = fromOpenAI(r1.json, r2.json);
        if (d) return d;
      }
      attempts.push('计费接口 → HTTP ' + r1.status);
    } catch (e) { attempts.push('计费接口 → ' + e.message); }

    if (st.quotaPath) {
      try {
        const r = await request(joinUrl(base, st.queryPath || '/api/user/self'), { token, headers: extraHeaders, timeout });
        const d = fromPath(r.json, {
          balancePath: st.quotaPath,
          subtractPath: st.subtractPath,
          rawPerUnit: st.rawPerUnit,
          currency: st.unitCurrency,
          mode: 'custom',
        });
        if (d) return d;
        attempts.push('自定义路径 → 取不到 ' + st.quotaPath);
      } catch (e) { attempts.push('自定义路径 → ' + e.message); }
    }

    const err = new Error(attempts.join('；') || '未知错误');
    err.attempts = attempts;
    throw err;
  }

  /* --- 官方余额接口：一次请求拿余额 --- */
  if (preset.kind === 'balance') {
    const path = st.queryPath || preset.path;
    const r = await buildCall(preset, base, token, path, timeout, extraHeaders);
    const d = fromPath(r.json, {
      balancePath: st.quotaPath || preset.balancePath,
      subtractPath: preset.subtractPath,
      rawPerUnit: preset.rawPerUnit,
      currency: preset.currency,
      extraPaths: preset.extraPaths,
      mode: preset.id,
    });
    if (d) return d;
    if (r.status === 401 || r.status === 403) throw new Error('Key 无效或无权限（HTTP ' + r.status + '）');
    throw new Error('取不到余额字段 ' + (preset.balancePath || '') + '（HTTP ' + r.status + '）');
  }

  /* --- OpenAI：先试计费，失败降级为可用性检测 --- */
  if (preset.kind === 'billing') {
    try {
      const r1 = await request(joinUrl(base, '/v1/dashboard/billing/subscription'), { token, headers: extraHeaders, timeout });
      if (r1.json) {
        const r2 = await request(joinUrl(base, '/v1/dashboard/billing/usage'), { token, headers: extraHeaders, timeout });
        const d = fromOpenAI(r1.json, r2.json);
        if (d) return d;
      }
    } catch (e) { /* 忽略，走降级 */ }
    const conn = await checkConnectivity(preset, base, token, timeout, extraHeaders);
    if (conn.ok) {
      return {
        mode: 'connectivity', kind: 'connectivity', currency: preset.currency || 'USD',
        balance: null, used: null, total: null, requests: null, group: null, extra: cleanExtra({ 检测方式: conn.path }),
        note: 'Key 可用，但 OpenAI 未开放余额查询接口', balanceAvailable: false,
      };
    }
    throw new Error('Key 校验失败：' + conn.error);
  }

  /* --- 自定义 --- */
  if (preset.kind === 'custom') {
    if (!st.queryPath) throw new Error('未填写请求 URL');
    const auth = ['bearer', 'x-api-key', 'query', 'none'].includes(st.authMode) ? st.authMode : 'bearer';
    const method = st.requestMethod === 'POST' ? 'POST' : 'GET';
    const callPreset = Object.assign({}, preset, { auth, queryParam: st.authQueryParam || 'key' });
    const body = method === 'POST' && st.requestBody ? fillJsonTemplate(st.requestBody, st, token) : undefined;
    const r = await buildCall(callPreset, base, token, st.queryPath || '/api/user/self', timeout, extraHeaders, { method, body });
    if (!r.ok) throw new Error('计费接口请求失败（HTTP ' + r.status + '）');
    const d = fromPath(r.json, {
      balancePath: st.quotaPath,
      subtractPath: st.subtractPath,
      usedPath: st.usedPath,
      totalPath: st.totalPath,
      planPath: st.planPath,
      rawPerUnit: st.rawPerUnit,
      currency: st.unitCurrency,
      mode: 'custom',
    });
    if (d) return d;
    throw new Error('取不到字段 ' + (st.quotaPath || '(未填)') + '（HTTP ' + r.status + '）');
  }

  /* --- 仅检测 --- */
  const conn = await checkConnectivity(preset, base, token, timeout, extraHeaders);
  if (!conn.ok) throw new Error('Key 校验失败：' + conn.error);
  return {
    mode: 'connectivity', kind: 'connectivity', currency: preset.currency || 'USD',
    balance: null, used: null, total: null, requests: null, group: null,
    extra: cleanExtra({ 检测方式: conn.path }),
    note: preset.name + ' 未开放余额接口，Key 可用', balanceAvailable: false,
  };
}

/**
 * 一键探测：不知道是哪家时，按地址/响应自动识别。
 * @returns { preset, result }
 */
async function detect(st, token) {
  const base = String(st.baseUrl || '').trim();
  const timeout = Number(st.timeoutMs) > 0 ? Number(st.timeoutMs) : DEFAULT_TIMEOUT;
  const lower = base.toLowerCase();
  const host = (() => { try { return new URL(base).host; } catch (e) { return lower; } })();

  const candidates = [];
  const push = (id) => { if (!candidates.includes(id)) candidates.push(id); };

  if (/deepseek/.test(host)) push('deepseek');
  if (/moonshot|kimi/.test(host)) push(host.includes('.ai') ? 'moonshot-intl' : 'moonshot');
  if (/siliconflow/.test(host)) push('siliconflow');
  if (/openrouter/.test(host)) { push('openrouter-key'); push('openrouter-credits'); }
  if (/openai\.com/.test(host)) push('openai');
  if (/anthropic/.test(host)) push('anthropic');
  if (/generativelanguage|googleapis/.test(host)) push('gemini');

  // 没看出域名就按官方预设逐个试，最后兜底中转站
  PRESETS.forEach((p) => {
    if (p.kind === 'balance' && p.baseUrl) push(p.id);
  });
  push('relay-auto');

  const errors = [];
  for (const id of candidates) {
    try {
      const result = await query(st, token, id);
      return { preset: id, result };
    } catch (e) {
      errors.push(getPreset(id).name + '：' + e.message);
    }
  }
  const err = new Error(errors.slice(0, 6).join('；'));
  err.attempts = errors;
  throw err;
}

const exported = { query, queryUsage, aggregateUsage, detect, request, getPath, num, fromOpenAI, parseUsageMap };
if (typeof module !== 'undefined' && module.exports) module.exports = exported;
if (typeof globalThis !== 'undefined') globalThis.APIBalanceProbe = exported;
