'use strict';

(() => {
  const root = document.getElementById('root');
  const toastRoot = document.getElementById('toast');

  let PRESETS = [];
  let DATA = null;
  let draft = {};
  let probeRes = {};
  let settingsOpen = false;
  let settingsView = 'general';
  let editingStationId = null;
  let stationFilter = 'all';
  let stationSort = 'default';
  let usageData = null;
  let usageStationId = null;
  let usageRange = 'today';
  let usageBusy = false;
  let overviewUsage = null;
  let overviewUsageBusy = false;
  let overviewUsageLoadedRange = null;
  let overviewUsageStation = 'all';
  let overviewUsageRange = 'today';
  const OVERVIEW_USAGE_CACHE_KEY = 'api-balance-overview-usage-v2';
  let newStep = 1;
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let themeMode = window.localStorage.getItem('api-balance-theme') || 'system';
  if (!['system', 'light', 'dark'].includes(themeMode)) themeMode = 'system';
  let darkMode = themeMode === 'dark' || (themeMode === 'system' && systemTheme.matches);
  function applyTheme() {
    document.body.classList.toggle('dark', darkMode);
    document.getElementById('theme-color')?.setAttribute('content', darkMode ? '#111315' : '#eef1f7');
  }
  applyTheme();
  let busy = false;
  let elapsedMs = null;
  let updatePollTimer = null;
  let updateConfirmOpen = false;
  let updateMethod = 'github';
  let localUpdateFile = null;
  let feedbackOpen = false;
  let purchaseModal = '';
  let modalReturnAction = '';
  let versionInfo = null;
  let versionChecking = false;
  let androidDownload = null;

  function androidValue(method) {
    try { return window.AndroidApp && typeof window.AndroidApp[method] === 'function' ? window.AndroidApp[method]() : ''; }
    catch (error) { return ''; }
  }

  const standaloneValue = androidValue('isStandalone');
  const androidStandalone = standaloneValue === true || standaloneValue === 'true';

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function icon(name) {
    return '<svg class="ui-icon" aria-hidden="true"><use href="icons.svg#' + name + '"></use></svg>';
  }

  function renderThemeOptions(className) {
    return '<div class="theme-options ' + className + '" role="group" aria-label="外观">'
      + '<button type="button" class="' + (themeMode === 'system' ? 'on' : '') + '" data-act="theme-mode" data-mode="system" aria-label="跟随系统" aria-pressed="' + (themeMode === 'system') + '" data-tooltip="跟随系统">' + icon('monitor') + '<span>系统</span></button>'
      + '<button type="button" class="' + (themeMode === 'light' ? 'on' : '') + '" data-act="theme-mode" data-mode="light" aria-label="亮色模式" aria-pressed="' + (themeMode === 'light') + '" data-tooltip="亮色模式">' + icon('sun') + '<span>亮色</span></button>'
      + '<button type="button" class="' + (themeMode === 'dark' ? 'on' : '') + '" data-act="theme-mode" data-mode="dark" aria-label="暗色模式" aria-pressed="' + (themeMode === 'dark') + '" data-tooltip="暗色模式">' + icon('moon') + '<span>暗色</span></button></div>';
  }

  function finite(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  }

  function number(value, digits) {
    if (!finite(value)) return '--';
    return Number(value).toLocaleString('zh-CN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function money(value, currency) {
    if (!finite(value)) return '--';
    return (currency === 'CNY' ? '¥' : '$') + number(value, 2);
  }

  function usdAsCny(value) {
    const rate = Number(DATA?.settings?.fx?.rate) > 0 ? Number(DATA.settings.fx.rate) : 7.2;
    return finite(value) ? Number(value) * rate : null;
  }

  function tokenMillions(value) {
    return finite(value) ? number(Number(value) / 1000000, 2) + 'M' : '--';
  }

  function fileSize(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function clock(ts) {
    if (!finite(ts) || Number(ts) <= 0) return '尚未更新';
    return new Date(Number(ts)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  function ago(ts) {
    if (!finite(ts) || Number(ts) <= 0) return '尚未查询';
    const seconds = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
    if (seconds < 45) return '刚刚';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
    return Math.floor(seconds / 86400) + ' 天前';
  }

  function presetOf(id) {
    return PRESETS.find((item) => item.id === id) || PRESETS[0] || {
      id: 'relay-auto', name: '中转站（自动识别）', kind: 'relay', baseUrl: '',
      currency: 'USD', rawPerUnit: 500000, icon: '🔀', note: '',
    };
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
  }

  function valueOf(sid, field, serverValue, fallback) {
    if (draft[sid] && hasOwn(draft[sid], field)) return draft[sid][field];
    if (serverValue !== undefined && serverValue !== null) return serverValue;
    return fallback ?? '';
  }

  function toast(message, type) {
    const item = document.createElement('div');
    item.textContent = String(message || '操作完成');
    if (type) item.className = type;
    toastRoot.appendChild(item);
    window.setTimeout(() => item.remove(), 2800);
  }

  async function request(path, options) {
    const init = Object.assign({ credentials: 'same-origin' }, options || {});
    init.headers = Object.assign({}, init.headers || {});
    if (init.body && typeof init.body !== 'string') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }

    if (androidStandalone && window.AndroidStandalone) {
      return window.AndroidStandalone.request(path, init);
    }

    let response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      throw new Error('网络连接失败，请检查服务是否正常运行');
    }

    let body = {};
    try { body = await response.json(); } catch (error) { body = {}; }

    if (!response.ok) throw new Error(body.error || '请求失败（HTTP ' + response.status + '）');
    return body;
  }

  async function copyText(value) {
    if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(String(value));
    const input = document.createElement('textarea');
    input.value = String(value);
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('复制失败');
  }

  function post(path, body) {
    return request(path, { method: 'POST', body });
  }

  async function uploadUpdate(file) {
    let response;
    try {
      response = await fetch('/api/update/file', {
        method: 'POST', credentials: 'same-origin', body: file,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Update-Filename': encodeURIComponent(file.name) },
      });
    } catch (error) { throw new Error('更新包上传失败，请检查服务是否正常运行'); }
    let body = {};
    try { body = await response.json(); } catch (error) { body = {}; }
    if (!response.ok) throw new Error(body.error || '更新包上传失败（HTTP ' + response.status + '）');
    return body;
  }

  function restoreOverviewUsage(stations, range) {
    try {
      const cache = JSON.parse(window.localStorage.getItem(OVERVIEW_USAGE_CACHE_KEY) || '{}');
      const saved = cache.ranges?.[range];
      const byId = new Map(stations.map((station) => [station.id, station]));
      const rows = Array.isArray(saved?.rows) ? saved.rows
        .map((row) => ({ station: byId.get(row.stationId), data: row.data }))
        .filter((row) => row.station && row.station.enabled !== false && row.station.queryMode !== 'paused' && row.data) : [];
      overviewUsage = rows.length ? rows : null;
      overviewUsageLoadedRange = range;
      return rows;
    } catch (error) {
      overviewUsage = null;
      overviewUsageLoadedRange = range;
      return [];
    }

  }

  function cacheOverviewUsage(range, rows) {
    try {
      const cache = JSON.parse(window.localStorage.getItem(OVERVIEW_USAGE_CACHE_KEY) || '{}');
      cache.ranges = cache.ranges || {};
      cache.ranges[range] = {
        savedAt: Date.now(),
        rows: rows.filter((row) => row.data).map((row) => ({ stationId: row.station.id, data: row.data })),
      };
      window.localStorage.setItem(OVERVIEW_USAGE_CACHE_KEY, JSON.stringify(cache));
    } catch (error) { /* 缓存不可用时仍正常查询 */ }
  }

  function snapshotDrafts() {
    root.querySelectorAll('[data-field]').forEach((element) => {
      const sid = element.dataset.sid || '__new__';
      if (!draft[sid]) draft[sid] = {};
      draft[sid][element.dataset.field] = element.type === 'checkbox' ? element.checked : element.value;
    });
  }

  function statusOf(station) {
    const last = station.last;
    if (!station.enabled) return 'idle';
    if (!last || !last.at) return 'idle';
    if (last.ok === false) return 'dead';
    if (last.balanceAvailable === false || !finite(last.balanceUsd)) return 'unknown';
    if (finite(station.effectiveThresholdUsd)
        && Number(last.balanceUsd) < Number(station.effectiveThresholdUsd)) return 'low';
    return 'ok';
  }

  function spark(history, color) {
    const points = (Array.isArray(history) ? history : [])
      .map((item) => Number(item && item.v))
      .filter(Number.isFinite);
    if (points.length < 2) return '';
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min || 1;
    const coords = points.map((value, index) => {
      const x = 2 + (92 * index / (points.length - 1));
      const y = 23 - ((value - min) / range) * 20;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return '<svg class="spark" width="96" height="26" viewBox="0 0 96 26" role="img" aria-label="余额趋势">'
      + '<polyline class="l" stroke="' + esc(color) + '" points="' + esc(coords) + '"/></svg>';
  }

  const FIELD_HELP = {
    name: '用于在面板中区分站点；填写容易识别的名称，如生产站点。',
    baseUrl: '站点根地址或完整计费接口；必须以 http:// 或 https:// 开头。',
    token: '用于请求余额和用量；填写平台生成的 API Key 或系统访问令牌。',
    queryMode: '同时控制余额和用量查询；一般选自动，接口限流时选择仅手动。',
    preset: '决定请求路径和字段解析；选择对应平台，未知类型可先用自动识别。',
    userId: '部分 New API 或其他站点要求；填写后台的数字用户 ID，不要求则留空。',
    rawPerUnit: '把接口内部额度换算成金额；直接返回金额填 1，New API 常见为 500000。',
    unitCurrency: '接口原始额度使用的币种；应与平台后台显示的币种一致。',
    thresholdUsd: '余额低于此值时告警；留空使用通用设置中的默认阈值。',
    tag: '用于筛选和分类；可填写主力、备用、官方等简短标签。',
    requestMethod: '按平台文档选择 GET 或 POST；余额查询通常使用 GET。',
    authMode: '密钥的发送方式；必须与平台计费接口文档一致。',
    authQueryParam: '密钥放在 URL 中时的参数名；例如 key、token 或 api_key。',
    requestBody: 'POST 请求发送的 JSON；可用 {{apiKey}} 代表当前站点密钥。',
    queryPath: '计费接口路径或完整 URL；例如 /api/v1/key/quota。',
    quotaPath: '返回 JSON 中的剩余额度字段；例如 data.available_usd。',
    usedPath: '返回 JSON 中的已用额度字段；平台未提供时可以留空。',
    totalPath: '返回 JSON 中的总额度字段；平台未提供时可以留空。',
    planPath: '返回 JSON 中的套餐名称字段；仅用于展示，可以留空。',
    usageEndpoint: '可选。填写完整用量接口或以 / 开头的路径；配置后优先于内置识别。',
    usageRequestMethod: '按用量接口文档选择 GET 或 POST。',
    usageAuthMode: '密钥在用量请求中的发送方式，必须与运营商文档一致。',
    usageAuthQueryParam: '仅 URL 参数认证使用，例如 key、token 或 api_key。',
    usageRequestBody: '仅 POST 使用；必须是 JSON，可用 {{apiKey}} 代入站点密钥。',
    usageMap: '把平台周期、消费、请求、Token 和模型字段映射到面板；costCurrency 指明消费币种，costDivisor 用于内部额度换算。',
    thresholdDefaultUsd: '新站点默认低余额告警线；按美元填写，例如 10。',
    refreshMinutes: '自动查询全部站点的间隔分钟数；填写 0 表示关闭定时刷新。',
    timeoutSeconds: '单次接口请求最长等待时间；填写 1 至 60 秒。',
    fxRate: '1 美元可兑换的人民币数值；自动模式下无需填写。',
    pushTime: '每日检查并发送低余额提醒的北京时间。',
    barkUrl: 'Bark 完整推送地址；例如 https://api.day.app/你的Key。',
    serverChanSendKey: '在 Server酱后台复制 SendKey，只填写 Key 本身。',
    pushPlusToken: '在 PushPlus 的“发送消息”页面复制用户 Token。',
    telegramBotToken: '通过 BotFather 创建机器人后获得的 Bot Token。',
    telegramChatId: '接收消息的个人、群组或频道 Chat ID。',
    webhookUrl: '接收 POST JSON 的完整 HTTP/HTTPS 地址。',
    proxyUrl: '仅用于从 GitHub 更新；填写容器可访问的 HTTP 代理，直连时留空。',
    mirrorUrl: 'GitHub 无法连接时使用；填写可信 Git 镜像或备用仓库的完整 HTTPS 地址。',
  };

  function fieldHelp(field, id) {
    return '<span class="field-help" id="' + esc(id) + '-help">' + esc(FIELD_HELP[field] || '填写后保存配置生效。') + '</span>';
  }

  function inputRow(label, field, value, sid, options) {
    const opts = options || {};
    const id = 'f-' + String(sid).replace(/[^a-zA-Z0-9_-]/g, '-') + '-' + field;
    const attrs = [
      'id="' + esc(id) + '"',
      'class="field' + (opts.mono ? ' mono' : '') + '"',
      'type="' + esc(opts.type || 'text') + '"',
      'data-sid="' + esc(sid) + '"',
      'data-field="' + esc(field) + '"',
      'value="' + esc(value) + '"',
      'aria-describedby="' + esc(id) + '-help"',
    ];
    if (opts.placeholder) attrs.push('placeholder="' + esc(opts.placeholder) + '"');
    if (opts.autocomplete) attrs.push('autocomplete="' + esc(opts.autocomplete) + '"');
    if (opts.inputmode) attrs.push('inputmode="' + esc(opts.inputmode) + '"');
    if (opts.min !== undefined) attrs.push('min="' + esc(opts.min) + '"');
    if (opts.max !== undefined) attrs.push('max="' + esc(opts.max) + '"');
    if (opts.step !== undefined) attrs.push('step="' + esc(opts.step) + '"');
    if (opts.disabled) attrs.push('disabled');
    return '<div class="row"><label class="lbl" for="' + esc(id) + '">' + esc(label) + '</label>'
      + '<input ' + attrs.join(' ') + '>' + fieldHelp(field, id) + '</div>';
  }

  function textareaRow(label, field, value, sid, options) {
    const opts = options || {};
    const id = 'f-' + String(sid).replace(/[^a-zA-Z0-9_-]/g, '-') + '-' + field;
    return '<div class="row row-textarea"><label class="lbl" for="' + esc(id) + '">' + esc(label) + '</label>'
      + '<textarea id="' + esc(id) + '" class="field mono" data-sid="' + esc(sid) + '" data-field="' + esc(field)
      + '" rows="8" aria-describedby="' + esc(id) + '-help" placeholder="' + esc(opts.placeholder || '') + '">' + esc(value) + '</textarea>'
      + fieldHelp(field, id) + '</div>';
  }

  function selectRow(label, field, value, sid, choices) {
    const id = 'f-' + String(sid).replace(/[^a-zA-Z0-9_-]/g, '-') + '-' + field;
    return '<div class="row"><label class="lbl" for="' + esc(id) + '">' + esc(label) + '</label>'
      + '<select id="' + esc(id) + '" class="field" data-sid="' + esc(sid) + '" data-field="' + esc(field) + '" aria-describedby="' + esc(id) + '-help">'
      + choices.map((choice) => '<option value="' + esc(choice.value) + '"'
        + (String(choice.value) === String(value) ? ' selected' : '') + '>' + esc(choice.label) + '</option>').join('')
      + '</select>' + fieldHelp(field, id) + '</div>';
  }

  function stationFields(station, sid, selectedPreset) {
    const p = selectedPreset;
    const isNew = !station;
    const current = station || {};
    const val = (field, fallback) => valueOf(sid, field, current[field], fallback);
    const token = valueOf(sid, 'token', '', '');
    const tokenPlaceholder = !isNew && current.hasToken
      ? '已保存 ' + (current.tokenMask || '密钥，留空不改')
      : '请输入 API Key 或系统访问令牌';
    let html = '';

    html += inputRow('名称', 'name', val('name', isNew ? p.name.replace(/（.*?）/g, '') : ''), sid, {
      placeholder: '给这个站点起个名字', autocomplete: 'off',
    });
    html += inputRow('地址', 'baseUrl', val('baseUrl', p.baseUrl || ''), sid, {
      type: 'url', mono: true, placeholder: 'https://api.example.com', autocomplete: 'url',
    });
    html += inputRow('密钥', 'token', token, sid, {
      type: 'password', mono: true, placeholder: tokenPlaceholder, autocomplete: 'new-password',
    });
    if (isNew && newStep === 1) return html;

    const queryMode = val('queryMode', current.queryMode || 'auto');
    html += '<div class="query-config-head"><span class="query-config-icon">▥</span><span><strong>余额与用量查询</strong><small>选择模板，测试成功后保存配置</small></span></div>';
    html += selectRow('运行方式', 'queryMode', queryMode, sid, [
      { value: 'auto', label: '自动查询' }, { value: 'manual', label: '仅手动查询' }, { value: 'paused', label: '暂停全部查询' },
    ]);
    html += selectRow('预设模板', 'preset', p.id, sid, PRESETS.map((item) => ({ value: item.id, label: item.name })));

    if (p.kind === 'relay') {
      html += inputRow('用户 ID', 'userId', val('userId', current.extraHeaders?.['New-Api-User'] || ''), sid, {
        inputmode: 'numeric', placeholder: '', autocomplete: 'off',
      });
      html += inputRow('换算除数', 'rawPerUnit', val('rawPerUnit', p.rawPerUnit || 500000), sid, {
        type: 'number', inputmode: 'decimal', min: 0.000001, step: 'any',
      });
      html += selectRow('额度币种', 'unitCurrency', val('unitCurrency', p.currency || 'USD'), sid, [
        { value: 'USD', label: 'USD 美元' }, { value: 'CNY', label: 'CNY 人民币' },
      ]);
      html += inputRow('低余额阈值', 'thresholdUsd', val('thresholdUsd', ''), sid, {
        type: 'number', inputmode: 'decimal', min: 0, step: '0.01', placeholder: '留空跟随全局余额',
      });
      html += inputRow('标签', 'tag', val('tag', ''), sid, { placeholder: '如：主力、备用', autocomplete: 'off' });
    } else if (p.kind === 'balance') {
      html += inputRow('低余额阈值', 'thresholdUsd', val('thresholdUsd', ''), sid, {
        type: 'number', inputmode: 'decimal', min: 0, step: '0.01', placeholder: '留空跟随全局余额',
      });
      html += inputRow('标签', 'tag', val('tag', ''), sid, { placeholder: '如：主力、备用', autocomplete: 'off' });
    } else if (p.kind === 'billing' || p.kind === 'connectivity') {
      html += inputRow('标签', 'tag', val('tag', ''), sid, { placeholder: '如：官方、仅检测', autocomplete: 'off' });
    } else if (p.kind === 'custom') {
      const method = val('requestMethod', current.requestMethod || 'GET');
      const authMode = val('authMode', current.authMode || 'bearer');
      html += selectRow('请求方法', 'requestMethod', method, sid, [
        { value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' },
      ]);
      html += selectRow('认证方式', 'authMode', authMode, sid, [
        { value: 'bearer', label: 'Bearer Token' }, { value: 'x-api-key', label: 'X-API-Key' },
        { value: 'query', label: 'URL 参数' }, { value: 'none', label: '无需认证' },
      ]);
      if (authMode === 'query') html += inputRow('参数名称', 'authQueryParam', val('authQueryParam', 'key'), sid, { mono: true, placeholder: 'key' });
      if (method === 'POST') html += inputRow('请求 JSON', 'requestBody', val('requestBody', ''), sid, {
        mono: true, placeholder: '{"token":"{{apiKey}}"}', autocomplete: 'off',
      });
      html += inputRow('请求 URL', 'queryPath', val('queryPath', ''), sid, {
        mono: true, placeholder: '/api/v1/key/quota 或完整 URL', autocomplete: 'url',
      });
      html += inputRow('剩余额度', 'quotaPath', val('quotaPath', ''), sid, {
        mono: true, placeholder: '例如 data.available_usd', autocomplete: 'off',
      });
      html += inputRow('已用额度', 'usedPath', val('usedPath', ''), sid, {
        mono: true, placeholder: '可选，例如 data.key.used_usd', autocomplete: 'off',
      });
      html += inputRow('总额度', 'totalPath', val('totalPath', ''), sid, {
        mono: true, placeholder: '可选，例如 data.key.total_usd', autocomplete: 'off',
      });
      html += inputRow('套餐名称', 'planPath', val('planPath', ''), sid, {
        mono: true, placeholder: '可选，例如 data.plan.name', autocomplete: 'off',
      });
      html += inputRow('换算除数', 'rawPerUnit', val('rawPerUnit', p.rawPerUnit || 1), sid, {
        type: 'number', inputmode: 'decimal', min: 0.000001, step: 'any',
      });
      html += selectRow('额度币种', 'unitCurrency', val('unitCurrency', p.currency || 'USD'), sid, [
        { value: 'USD', label: 'USD 美元' }, { value: 'CNY', label: 'CNY 人民币' },
      ]);
      html += inputRow('标签', 'tag', val('tag', ''), sid, { placeholder: '如：主力、备用', autocomplete: 'off' });
    }
    const usageEndpoint = val('usageEndpoint', current.usageEndpoint || '');
    const usageMethod = val('usageRequestMethod', current.usageRequestMethod || 'GET');
    const usageAuth = val('usageAuthMode', current.usageAuthMode || 'bearer');
    const usageMapExample = '{"summary":{"remaining":"remaining","used":"used","total":"total","unit":"unit"},"timezone":"timezone","costCurrency":"USD","costDivisor":1,"periods":{"today":"periods.today","yesterday":"periods.yesterday","last7d":"periods.last7d","last30d":"periods.last30d"},"metrics":{"requests":"requests","successCount":"successCount","failedCount":"failedCount","successRate":"successRate","inputTokens":"promptTokens","outputTokens":"completionTokens","totalTokens":"totalTokens","cost":"cost","models":"topModels"},"model":{"id":"modelId","name":"modelName","requests":"requests","tokens":"totalTokens","cost":"cost","successRate":"successRate"}}';
    html += '<details class="usage-custom"' + (usageEndpoint ? ' open' : '') + '><summary><span>自定义用量统计接口</span><small>可选 · 按运营商文档配置</small></summary>';
    html += inputRow('用量接口 URL', 'usageEndpoint', usageEndpoint, sid, { mono: true, placeholder: 'https://api.example.com/v1/usage', autocomplete: 'url' });
    html += selectRow('请求方法', 'usageRequestMethod', usageMethod, sid, [{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }]);
    html += selectRow('认证方式', 'usageAuthMode', usageAuth, sid, [
      { value: 'bearer', label: 'Bearer Token' }, { value: 'x-api-key', label: 'X-API-Key' },
      { value: 'query', label: 'URL 参数' }, { value: 'none', label: '无需认证' },
    ]);
    if (usageAuth === 'query') html += inputRow('参数名称', 'usageAuthQueryParam', val('usageAuthQueryParam', current.usageAuthQueryParam || 'key'), sid, { mono: true, placeholder: 'key' });
    if (usageMethod === 'POST') html += inputRow('请求 JSON', 'usageRequestBody', val('usageRequestBody', current.usageRequestBody || ''), sid, { mono: true, placeholder: '{"token":"{{apiKey}}"}' });
    html += textareaRow('字段映射 JSON', 'usageMap', val('usageMap', current.usageMap || ''), sid, { placeholder: usageMapExample });
    html += '<div class="query-config-note">运营商只返回周期汇总时，面板可显示消费、请求、Token 和模型排行，但无法显示逐条请求日志。</div></details>';
    html += '<div class="query-config-note">显示额度 = 接口原始额度 ÷ 换算除数。请求超时 ' + esc(number((DATA.settings.timeoutMs || 12000) / 1000, 0))
      + ' 秒 · 自动查询间隔 ' + esc(DATA.settings.refreshMinutes ?? 30) + ' 分钟，可在通用设置调整。</div>';
    return html;
  }

  function probeBadge(sid, station) {
    const probe = probeRes[sid];
    if (probe) {
      if (probe.ok) return '<span class="badge ok">探测成功 · ' + esc(probe.preset || probe.result?.mode || '可用') + '</span>';
      return '<span class="badge warn">探测失败</span>';
    }
    const last = station && station.last;
    if (!last || !last.at) return '<span class="badge">待探测</span>';
    if (last.ok) return '<span class="badge ok">最近成功 · ' + esc(last.mode || '可用') + '</span>';
    return '<span class="badge warn">最近查询失败</span>';
  }

  function probeNote(sid) {
    const probe = probeRes[sid];
    if (!probe) return '';
    if (!probe.ok) return '<div class="badnote">' + esc(probe.error || '探测失败') + '</div>';
    const result = probe.result || {};
    const balance = result.balanceAvailable === false ? 'Key 可用，但该厂商未开放余额接口' : '余额 ' + money(result.balance, result.currency);
    return '<div class="oknote">已识别为 ' + esc(probe.preset || result.mode || '可用接口')
      + ' · ' + esc(balance) + ' · ' + esc(probe.ms || 0) + 'ms</div>';
  }

  function renderPresetGrid(sid, selectedId) {
    return '<div class="presetgrid">' + PRESETS.map((p) => (
      '<button type="button" class="' + (p.id === selectedId ? 'on' : '') + '" data-act="pick-preset"'
      + ' data-sid="' + esc(sid) + '" data-preset="' + esc(p.id) + '" aria-pressed="' + (p.id === selectedId) + '">'
      + '<span aria-hidden="true">' + esc(p.icon || '•') + '</span>' + esc(p.name) + '</button>'
    )).join('') + '</div>';
  }

  function renderStationPanel(station) {
    const isNew = !station;
    const sid = isNew ? '__new__' : station.id;
    const selectedId = valueOf(sid, 'preset', station?.preset, PRESETS[0]?.id || 'relay-auto');
    const p = presetOf(selectedId);
    const status = station ? statusOf(station) : 'idle';
    const dotClass = status === 'low' ? ' warn' : status === 'dead' ? ' bad' : status === 'ok' ? '' : ' idle';
    const displayName = valueOf(sid, 'name', station?.name, isNew ? '新增站点' : '未命名');

    let html = '<section class="panel station-editor" data-panel-sid="' + esc(sid) + '">';
    html += '<div class="phead"><span class="dot' + dotClass + '"></span><span class="n">' + esc(displayName || '新增站点') + '</span>';
    html += probeBadge(sid, station);
    if (!isNew) {
      html += '<span class="sp"><button type="button" class="sw' + (station.enabled ? '' : ' off') + '"'
        + ' data-act="toggle-station" data-sid="' + esc(sid) + '" aria-label="' + esc(station.enabled ? '停用站点' : '启用站点')
        + '" aria-pressed="' + station.enabled + '"></button></span>';
    }
    html += '</div>';

    if (isNew) {
      html += '<div class="stepbar"><span class="' + (newStep === 1 ? 'on' : '') + '">1 基础信息</span><i></i><span class="' + (newStep === 2 ? 'on' : '') + '">2 查询与保存</span></div>';
      html += '<div class="autodetect"><span class="autodetect-icon">✦</span><div><strong>自动识别站点类型</strong><small>保存或探测时会自动匹配接口</small></div></div>';
    }
    html += stationFields(station, sid, p);
    if (isNew && newStep === 1) {
      html += '<div class="step-hint">填写名称、地址和密钥后，进入下一步探测并保存。</div>';
    } else if (p.note) html += '<div class="hint">' + esc(p.note) + '</div>';
    html += probeNote(sid);
    html += '<div class="ops">';
    if (isNew && newStep === 1) {
      html += '<button type="button" class="btn primary" data-act="new-next">下一步</button>';
    } else {
      if (!isNew) html += '<button type="button" class="btn" data-act="refresh-station" data-sid="' + esc(sid) + '">立即刷新</button>';
      html += '<button type="button" class="btn" data-act="probe" data-sid="' + esc(sid) + '">' + (probeRes[sid] ? '重新测试' : '测试查询') + '</button>'
        + '<button type="button" class="btn primary" data-act="save-station" data-sid="' + esc(sid) + '">保存配置</button>';
      if (isNew) html += '<button type="button" class="btn ghost" data-act="new-prev">上一步</button>';
      else html += '<button type="button" class="btn danger" data-act="del-station" data-sid="' + esc(sid) + '">删除站点</button>';
    }
    if (isNew) html += '<button type="button" class="btn ghost" data-act="settings-back">取消</button>';
    html += '</div>';
    if (!isNew) html += renderStationDetail(station);
    html += '</section>';
    return html;
  }

  function stationSummary(station) {
    const status = statusOf(station);
    const last = station.last || {};
    const dotClass = status === 'low' ? ' warn' : status === 'dead' ? ' bad' : status === 'ok' ? '' : ' idle';
    const state = status === 'ok' ? '正常' : status === 'low' ? '余额偏低' : status === 'dead' ? '查询失败' : status === 'unknown' ? 'Key 正常' : '尚未查询';
    return '<button type="button" class="station-item" data-act="edit-station" data-sid="' + esc(station.id) + '">'
      + '<span class="dot' + dotClass + '"></span><span class="station-main"><strong>' + esc(station.name || '未命名') + '</strong><small>' + esc(station.tag || station.baseUrl || '未设置标签') + '</small></span>'
      + '<span class="station-state ' + status + '">' + esc(state) + '</span><span class="station-usage" data-act="usage" data-sid="' + esc(station.id) + '">统计</span><span class="station-chevron">›</span></button>';
  }

  function renderStationList(stations) {
    const tags = [...new Set(stations.map((s) => s.tag).filter(Boolean))];
    let filtered = stationFilter === 'all' ? stations.slice() : stations.filter((s) => s.tag === stationFilter);
    if (stationSort === 'name') filtered.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
    if (stationSort === 'status') filtered.sort((a, b) => statusOf(a).localeCompare(statusOf(b)));
    if (stationSort === 'balance') filtered.sort((a, b) => Number(b.last?.balanceUsd ?? -Infinity) - Number(a.last?.balanceUsd ?? -Infinity));
    let html = '<div class="station-tools"><div class="filter-label">站点 ' + stations.length + ' 个</div><span class="station-filters"><select class="tag-filter" data-act="filter-tag" aria-label="按标签筛选"><option value="all">全部标签</option>'
      + tags.map((tag) => '<option value="' + esc(tag) + '"' + (stationFilter === tag ? ' selected' : '') + '>' + esc(tag) + '</option>').join('') + '</select>'
      + '<select class="tag-filter" data-act="sort-stations" aria-label="站点排序"><option value="default">默认排序</option><option value="name"' + (stationSort === 'name' ? ' selected' : '') + '>按名称</option><option value="status"' + (stationSort === 'status' ? ' selected' : '') + '>按状态</option><option value="balance"' + (stationSort === 'balance' ? ' selected' : '') + '>按余额</option></select></span></div>';
    html += '<div class="station-list">' + filtered.map(stationSummary).join('') + '</div>';
    if (!filtered.length) html += '<div class="empty compact"><strong>没有匹配的站点</strong><div>换一个标签筛选试试。</div></div>';
    if (editingStationId) {
      const station = stations.find((s) => s.id === editingStationId);
      if (station) html += renderStationPanel(station);
    }
    return html;
  }

  function formatErrorCategory(last) {
    const map = { timeout: '请求超时', auth: '密钥无效', network: '网络错误', provider: '服务商错误' };
    return map[last?.errorCategory] || '查询失败';
  }

  function renderAlerts() {
    const alerts = Array.isArray(DATA.settings?.alerts) ? DATA.settings.alerts : [];
    let html = '<section class="panel alerts-panel"><div class="phead"><span class="n">告警记录</span><span class="badge">最近 ' + alerts.length + ' 条</span></div>';
    if (!alerts.length) html += '<div class="empty compact">暂无告警记录</div>';
    else html += '<div class="alert-list">' + alerts.slice(0, 12).map((a) => '<div class="alert-row"><span class="dot warn"></span><span><strong>' + esc(a.stationName || '站点') + '</strong><small>' + esc(a.message || '余额偏低') + ' · ' + esc(clock(a.at)) + '</small></span></div>').join('') + '</div>';
    if (alerts.length) html += '<div class="ops"><button type="button" class="btn ghost" data-act="clear-alerts">清空告警</button></div>';
    return html + '</section>';
  }

  function renderHistoryPanel(station) {
    if (!station || !Array.isArray(station.history) || !station.history.length) return '<div class="hint">暂无历史数据，刷新几次后会显示趋势。</div>';
    const values = station.history.map((p) => Number(p.v)).filter(Number.isFinite);
    const min = Math.min(...values); const max = Math.max(...values); const range = max - min || 1;
    const fxRate = Number(DATA.settings.fx.rate) > 0 ? Number(DATA.settings.fx.rate) : 7.2;
    const points = values.map((v, i) => (2 + i * 96 / Math.max(1, values.length - 1)).toFixed(1) + ',' + (34 - (v - min) / range * 28).toFixed(1)).join(' ');
    return '<div class="history-box"><div class="history-title">余额趋势 · 最近 ' + values.length + ' 次</div><svg class="history-chart" viewBox="0 0 100 38" preserveAspectRatio="none"><polyline points="' + esc(points) + '"/></svg><div class="history-range"><span>' + esc(money(min * fxRate, 'CNY')) + '</span><span>最低</span><span>最高 ' + esc(money(max * fxRate, 'CNY')) + '</span></div></div>';
  }

  function renderStationDetail(station) {
    if (!station || !station.last) return '';
    const last = station.last;
    return '<div class="detail-box"><div class="detail-grid"><span>最近查询 <b>' + esc(clock(last.at)) + '</b></span><span>响应耗时 <b>' + esc(number(last.ms, 0)) + 'ms</b></span><span>失败次数 <b>' + esc(station.failCount || 0) + '</b></span><span>查询状态 <b>' + esc(last.ok ? '正常' : formatErrorCategory(last)) + '</b></span></div>' + (last.error ? '<div class="badnote">' + esc(formatErrorCategory(last) + '：' + last.error) + '</div>' : '') + renderHistoryPanel(station) + '</div>';
  }
  function dailyPill(station, status) {
    const last = station.last || {};
    const fxRate = Number(DATA.settings.fx.rate) > 0 ? Number(DATA.settings.fx.rate) : 7.2;
    if (!station.enabled) return '<span class="pill">已停用</span>';
    if (status === 'dead') return '<span class="pill bad">' + esc(last.error || '查询失败') + '</span>';
    if (status === 'low') return '<span class="pill warn">余额低于 ' + esc(money(Number(station.effectiveThresholdUsd) * fxRate, 'CNY')) + '</span>';
    if (status === 'unknown') return '<span class="pill info">未开放余额接口 · Key 正常</span>';
    if (status === 'idle') return '<span class="pill">尚未查询</span>';

    const history = Array.isArray(station.history) ? station.history : [];
    if (history.length >= 2 && finite(history[0].v) && finite(history[history.length - 1].v)) {
      const diff = Number(history[history.length - 1].v) - Number(history[0].v);
      if (Math.abs(diff) >= 0.005) {
        return '<span class="pill num">今日 ' + (diff > 0 ? '+' : '-') + money(Math.abs(diff) * fxRate, 'CNY') + '</span>';
      }
    }
    if (last.group) return '<span class="pill">分组 ' + esc(last.group) + '</span>';
    return '<span class="pill">更新于 ' + esc(ago(last.at)) + '</span>';
  }

  function renderCard(station) {
    const last = station.last || {};
    const status = statusOf(station);
    const cardClasses = ['card'];
    if (status === 'low') cardClasses.push('low');
    if (status === 'dead') cardClasses.push('dead');
    if (last.stale || !station.enabled) cardClasses.push('muted');
    const dotClass = status === 'low' ? ' warn' : status === 'dead' ? ' bad' : (status === 'unknown' || status === 'idle') ? ' idle' : '';
    const available = last.balanceAvailable !== false && finite(last.balance);
    const rate = Number(DATA.settings.fx.rate) > 0 ? Number(DATA.settings.fx.rate) : 7.2;
    const actualCurrency = last.currency === 'CNY' ? 'CNY' : 'USD';
    const actual = available ? Number(last.balance) : null;
    const balanceCny = available ? (actualCurrency === 'CNY' ? actual : actual * rate) : null;
    const hasBar = finite(last.used) && finite(last.total) && Number(last.total) > 0;
    const usedPercent = hasBar ? Math.max(0, Math.min(100, Number(last.used) / Number(last.total) * 100)) : 0;
    const color = status === 'low' ? '#f79009' : status === 'dead' ? '#f04438' : '#0a84ff';

    let html = '<article class="' + cardClasses.join(' ') + '">';
    html += '<div class="chead"><span class="dot' + dotClass + '"></span><span class="name">' + esc(station.name || '未命名') + '</span>';
    if (station.tag) html += '<span class="tag">' + esc(station.tag) + '</span>';
    html += '</div>';
    html += '<div class="bal"><span class="usd num">' + esc(money(balanceCny, 'CNY')) + '</span>'
      + '<span class="cny num">实际 ' + actualCurrency + ' ' + esc(number(actual, 2)) + '</span></div>';
    if (hasBar) html += '<div class="bar" title="已用占比 ' + esc(number(usedPercent, 0)) + '%"><i style="width:' + esc(usedPercent.toFixed(1)) + '%"></i></div>';

    const meta = [];
    if (finite(last.used)) {
      meta.push('已用 <b>' + esc(money(last.used, actualCurrency)) + '</b>' + (hasBar ? ' / ' + esc(number(usedPercent, 0)) + '%' : ''));
    }
    if (finite(last.requests)) meta.push('请求 <b>' + esc(Number(last.requests).toLocaleString('zh-CN')) + '</b>');
    if (finite(last.ms)) meta.push('<b>' + esc(number(last.ms, 0)) + 'ms</b>');
    if (!meta.length) meta.push(last.at ? esc(ago(last.at)) : '等待首次查询');
    html += '<div class="meta num">' + meta.map((item) => '<span>' + item + '</span>').join('') + '</div>';
    html += '<div class="foot">' + spark(station.history, color) + dailyPill(station, status) + '</div>';
    const extra = last.extra && typeof last.extra === 'object' ? Object.entries(last.extra) : [];
    if (extra.length) {
      html += '<div class="exrow">' + extra.map(([key, value]) => '<span>' + esc(key) + ' <b>' + esc(value) + '</b></span>').join('') + '</div>';
    }

    html += '</article>';
    return html;
  }

  function renderSettings() {
    const settings = DATA.settings;
    const sid = '__settings__';
    const fxAuto = draft[sid] && hasOwn(draft[sid], 'fxAuto') ? draft[sid].fxAuto : settings.fx.auto !== false;
    const get = (field, serverValue, fallback) => valueOf(sid, field, serverValue, fallback);

    let html = '<section class="panel">';
    html += inputRow('默认余额阈值', 'thresholdDefaultUsd', get('thresholdDefaultUsd', settings.thresholdDefaultUsd, ''), sid, {
      type: 'number', inputmode: 'decimal', min: 0, step: '0.01', placeholder: '美元',
    });
    html += inputRow('自动刷新', 'refreshMinutes', get('refreshMinutes', settings.refreshMinutes, 30), sid, {
      type: 'number', inputmode: 'numeric', min: 0, step: 1,
    });
    html += inputRow('请求超时', 'timeoutSeconds', get('timeoutSeconds', (settings.timeoutMs || 12000) / 1000, 12), sid, {
      type: 'number', inputmode: 'numeric', min: 1, max: 60, step: 1,
    });
    html += '<div class="hint">自动刷新设为 0 时关闭后台定时查询；打开网页仍会刷新一次。请求超时范围为 1-60 秒。Android 系统后台任务最短间隔为 15 分钟，前台不受此限制。</div>';
    html += '<div class="row"><span class="lbl">汇率模式</span><div class="seg">'
      + '<button type="button" class="' + (fxAuto ? 'on' : '') + '" data-act="fx-mode" data-mode="auto" aria-pressed="' + fxAuto + '">自动</button>'
      + '<button type="button" class="' + (!fxAuto ? 'on' : '') + '" data-act="fx-mode" data-mode="manual" aria-pressed="' + (!fxAuto) + '">手动</button>'
      + '</div><span class="field-help">自动获取 USD/CNY；获取失败或需要固定汇率时选择手动。</span></div>';
    html += inputRow('美元汇率', 'fxRate', get('fxRate', settings.fx.rate, 7.2), sid, {
      type: 'number', inputmode: 'decimal', min: 0.0001, step: '0.0001', disabled: fxAuto,
    });
    html += '<div class="hint">自动模式会定期更新 USD→CNY 汇率；获取失败时沿用上一次结果。</div>';
    html += '<div class="ops"><button type="button" class="btn" data-act="export">导出配置</button>'
      + '<button type="button" class="btn" data-act="import">导入配置</button>'
      + '<button type="button" class="btn primary" data-act="save-settings">保存并应用</button></div>'
      + '<input id="import-file" type="file" accept="application/json" hidden></section>';
    return html;
  }

  function renderLicense() {
    const license = DATA.settings?.license;
    if (!license) return '';
    const price = Number(license.priceCny) || 10;
    let html = '<section class="panel license-panel' + (license.active ? ' active' : '') + '" id="license-panel">'
      + '<div class="license-head"><span class="license-icon">' + icon('key') + '</span><span><strong>' + (license.active ? '完整功能已激活' : '解锁完整功能') + '</strong>'
      + '<small>' + (license.active ? '不限站点，并已解锁推送通知' : '免费版最多 ' + esc(license.stationLimit || 2) + ' 个站点；' + esc(price) + ' 元解锁不限站点和推送') + '</small></span>'
      + '<b>' + (license.active ? '已激活' : '免费版') + '</b></div>';
    if (license.active) {
      html += '<div class="license-meta"><span>许可证编号</span><code>' + esc(license.licenseId || '已验证') + '</code></div>';
    } else {
      html += '<div class="license-meta"><span>安装编号</span><code>' + esc(license.installId) + '</code><button type="button" data-act="copy-install-id" title="复制安装编号">' + icon('copy') + '<span>复制</span></button></div>'
        + '<div class="license-price"><strong>一次性 ' + esc(price) + ' 元</strong><span>付款后通过邮箱领取与当前安装绑定的激活码。</span></div>'
        + renderPaymentButtons()
        + '<small class="license-payment-note">发送付款截图及转账单号，24 小时内会通过邮箱回复激活码。</small>'
        + '<div class="license-activate"><input class="field mono" type="text" data-sid="__license__" data-field="code" autocomplete="off" placeholder="粘贴激活码"><button type="button" class="btn" data-act="activate-license">激活</button></div>';
      if (license.status === 'invalid' && license.error) html += '<div class="badnote">当前许可证无效：' + esc(license.error) + '</div>';
    }
    return html + '</section>';
  }

  function notifyChannelCard(type, title, description, fields) {
    const sid = '__notify__';
    const channel = DATA.settings.notify?.channels?.[type] || {};
    const enabledField = type + 'Enabled';
    const enabled = draft[sid] && hasOwn(draft[sid], enabledField) ? draft[sid][enabledField] : channel.enabled === true;
    let html = '<section class="panel notify-card"><div class="phead"><span><span class="n">' + esc(title) + '</span><small>' + esc(description) + '</small></span>'
      + '<button type="button" class="sw' + (enabled ? '' : ' off') + '" data-act="toggle-notify" data-channel="' + esc(type) + '" aria-label="切换 ' + esc(title) + '" aria-pressed="' + enabled + '"></button></div>';
    fields.forEach((field) => {
      const configured = channel[field.secret + 'Configured'] === true;
      const placeholder = configured ? '已保存 ' + (channel[field.secret + 'Mask'] || '••••') + '，留空则保留' : field.placeholder;
      html += inputRow(field.label, field.name, valueOf(sid, field.name, '', ''), sid, {
        type: field.type || 'password', mono: true, placeholder, autocomplete: 'off',
      });
    });
    html += '<div class="notify-actions"><span>' + (fields.every((field) => channel[field.secret + 'Configured']) ? '凭据已配置' : '尚未完整配置') + '</span>'
      + '<button type="button" class="btn" data-act="test-notify" data-channel="' + esc(type) + '">保存并测试</button></div></section>';
    return html;
  }

  function renderNotifySettings() {
    if (!DATA.settings?.license?.active) {
      return '<section class="panel notify-paywall"><span class="license-icon">' + icon('key') + '</span><div><h2>推送通知需付费解锁</h2><p>支付 10 元激活完整功能后，可使用全部推送渠道，同时解除 2 个站点的数量限制。</p></div>'
        + renderPaymentButtons() + '<small>发送付款截图及转账单号，24 小时内会通过邮箱回复激活码。</small></section>';
    }
    const sid = '__notify__';
    const savedTime = DATA.settings.notify?.pushTime || '09:00';
    let html = '<section class="panel notify-rule"><div class="phead"><span class="n">低余额通知规则</span></div>';
    html += inputRow('每日推送时间', 'pushTime', valueOf(sid, 'pushTime', savedTime, '09:00'), sid, { type: 'time' });
    html += '<div class="warnnote">启用的渠道会在北京时间的设定时刻发送低余额提醒。同一站点每天只提醒一次；至少一个渠道发送成功后记为已提醒。</div></section>';
    html += '<div class="notify-grid">'
      + notifyChannelCard('bark', 'Bark', '适合 iPhone 与 Bark App', [{ label: '推送地址', name: 'barkUrl', secret: 'url', type: 'url', placeholder: 'https://api.day.app/你的Key' }])
      + notifyChannelCard('serverChan', 'Server酱', '通过微信接收通知', [{ label: 'SendKey', name: 'serverChanSendKey', secret: 'sendKey', placeholder: 'SCT...' }])
      + notifyChannelCard('pushPlus', 'PushPlus', '支持微信等多种接收方式', [{ label: 'Token', name: 'pushPlusToken', secret: 'token', placeholder: '用户 Token' }])
      + notifyChannelCard('telegram', 'Telegram', '通过 Telegram Bot 发送消息', [
        { label: 'Bot Token', name: 'telegramBotToken', secret: 'botToken', placeholder: '123456:ABC...' },
        { label: 'Chat ID', name: 'telegramChatId', secret: 'chatId', placeholder: '-1001234567890' },
      ])
      + notifyChannelCard('webhook', '通用 Webhook', '向自建服务发送标准 JSON', [{ label: 'Webhook URL', name: 'webhookUrl', secret: 'url', type: 'url', placeholder: 'https://example.com/webhook' }])
      + '</div><div class="ops notify-save"><button type="button" class="btn primary" data-act="save-notify">保存推送设置</button></div>';
    return html;
  }

  function renderDocs() {
    const chapters = [
      ['docs-start', '项目说明'], ['docs-overview', '余额总览'], ['docs-add', '添加站点'],
      ['docs-query', '余额查询配置'], ['docs-manage', '站点管理'], ['docs-usage', '用量统计'],
      ['docs-general', '通用设置'], ['docs-notify', '推送设置'], ['docs-http', 'HTTP API'], ['docs-update', '程序更新'], ['docs-fnos', '飞牛 fnOS'], ['docs-android', 'Android 应用'], ['docs-security', '数据与安全'], ['docs-faq', '常见问题'],
    ];
    const faqs = [
      ['程序更新一直停在“正在拉取代码”怎么办？', '先等待最多 90 秒，再查看更新状态。若失败，请确认 NAS 能访问 GitHub，并检查代理地址是否能从 API 容器访问。'],
      ['NAS 无法连接 GitHub，怎样本地更新？', '在能联网的设备打开 GitHub Releases，下载与目标版本同名的 .bundle 文件且不要解压；在程序更新页选择该文件。普通 Source code ZIP 不是本地更新包。'],
      ['飞牛版应该下载哪个文件？', '首次安装下载扩展名为 .fpk 的文件；后续可在程序更新页直接下载安装。.apk 只用于 Android，.bundle 只用于普通 Docker/Git 部署。'],
      ['为什么不能填写电脑的 127.0.0.1 代理？', '容器中的 127.0.0.1 指向容器自身。请在代理程序中允许局域网连接，并填写 NAS 或局域网内实际可访问的 IP 与端口。'],
      ['余额显示特别大的数字怎么办？', '通常是接口返回内部额度或无限额度占位值。请选择正确模板，或在自定义接口中填写正确的余额字段与换算除数。'],
      ['换算除数应该填多少？', '计算方式是“显示额度 = 接口原始额度 ÷ 换算除数”。接口直接返回金额时填 1；New API 常见值为 500000。'],
      ['查询成功但没有按日期或模型的用量明细？', '部分平台只提供余额和累计用量。只有平台开放日志或账单明细接口时，面板才能显示日期、模型和 Token 统计。'],
      ['New API 查询返回 401 或 403 怎么办？', '确认填写的是系统访问令牌；部分站点还必须填写用户 ID，并确保令牌拥有读取用户信息和用量的权限。'],
      ['更新后站点密钥无法读取怎么办？', '请确认 APP_SECRET 没有变化，并保留原 data 数据卷。APP_SECRET、data 目录任一丢失都可能导致旧密钥无法解密。'],
      ['测试推送失败怎么办？', '先确认凭据已保存且渠道服务可访问。Telegram 需要 Bot Token 与 Chat ID 两项；Docker 无法访问公网时还需检查 NAS 网络、DNS 和防火墙。'],
      ['部署到公网后如何限制访问？', '面板不提供内置登录，请使用 NAS 权限、反向代理认证或防火墙，仅允许可信网络访问。'],
    ];
    const links = chapters.map(([id, title]) => '<a href="#' + id + '">' + esc(title) + '</a>').join('');
    return '<label class="docs-mobile-jump"><span>跳转章节</span><select data-act="docs-jump">' + chapters.map(([id, title]) => '<option value="' + id + '">' + esc(title) + '</option>').join('') + '</select></label><div class="docs-layout"><aside class="docs-nav"><strong>文档导航</strong>' + links + '</aside>'
      + '<article class="docs-article">'
      + '<section id="docs-start"><p class="docs-kicker">使用指南</p><h2>这是什么</h2><p>API Balance 是多站点 API 余额与用量监控面板，可作为 Android 独立应用直接运行，也可通过 FPK 安装到飞牛 fnOS，或部署在 NAS、家庭服务器和其他 Docker 主机上。它保存用户配置的中转站地址和密钥，定时调用各站点公开的余额、额度或用量接口，再把不同币种和数据格式整理到一个页面中。</p>'
      + '<p>它不是 API 中转服务，不转发模型请求，也不会替代中转站自身的计费系统。余额和用量是否可显示、显示到什么粒度，完全取决于中转站实际提供的接口与返回字段。</p>'
      + '<h3>数据流程</h3><ol><li>Docker 版由本机后端保存状态并请求站点；Android 版由应用直接请求站点。</li><li>程序使用加密保存的站点凭据调用中转站接口。</li><li>程序解析余额、币种和用量并保存本地历史。</li><li>余额低于阈值时，通过用户启用的推送渠道发送通知。</li></ol><h3>快速开始</h3>'
      + '<ol><li>进入“添加站点”，填写名称、站点地址和密钥。</li><li>选择内置模板；没有匹配模板时使用“自定义余额路径”。</li><li>点击“测试查询”，确认余额、币种和状态正确后保存。</li><li>回到“余额总览”查看汇总，或在“站点管理”继续调整配置。</li></ol>'
      + '<div class="docs-callout"><strong>接口以平台文档为准</strong><span>具体接口请参考中转站的官方文档。不知道如何填写时，把中转站接口文档和本页文档一起发给 AI，让 AI 按本页字段规则生成配置。请用 sk-xxxxx 代替真实密钥，不要把真实密钥发给 AI。</span></div></section>'
      + '<section id="docs-overview"><p class="docs-kicker">01</p><h2>余额总览</h2><p>打开网页时会自动刷新一次全部已启用站点。页面顶部同时显示人民币总额、美元总额、站点数量和最后更新时间。</p>'
      + '<h3>状态与卡片</h3><ul><li><strong>正常：</strong>查询成功且余额高于站点阈值。</li><li><strong>余额偏低：</strong>查询成功，但余额低于站点阈值。</li><li><strong>异常：</strong>接口超时、认证失败或返回内容无法解析。</li><li><strong>站点卡片：</strong>显示原币余额、折算金额、已用比例、响应时间和最近余额趋势。</li></ul>'
      + '<p>“刷新”会重新查询全部已启用站点；失败站点不会按 0 元计入总额，避免误导汇总结果。</p></section>'
      + '<section id="docs-add"><p class="docs-kicker">02</p><h2>添加站点</h2><p>基础信息只需要名称、地址和密钥。地址可以填写站点根地址，也可以直接填写计费接口地址；系统会根据所选模板组合最终请求。</p>'
      + '<div class="docs-table-wrap"><table><thead><tr><th>字段</th><th>作用</th><th>填写建议</th></tr></thead><tbody><tr><td>名称</td><td>面板中的站点标识</td><td>使用容易辨认的平台名称</td></tr><tr><td>地址</td><td>请求目标</td><td>包含 http:// 或 https://</td></tr><tr><td>密钥</td><td>调用计费接口</td><td>支持 API Key 或系统访问令牌</td></tr><tr><td>标签</td><td>筛选与分类</td><td>例如“主力”“备用”</td></tr></tbody></table></div>'
      + '<p>每个字段右侧都提供用途和填写方法。填写基础信息后进入第二步，选择查询模板并测试；测试成功会展示识别到的余额、已用额度和币种，确认无误后保存。</p></section>'
      + '<section id="docs-query"><p class="docs-kicker">03</p><h2>余额查询与计费接口</h2><p>各平台的计费接口不同，因此每个站点都可以独立配置查询方式。系统只发送结构化 HTTP 请求，不执行用户脚本。</p>'
      + '<h3>运行方式</h3><div class="docs-table-wrap"><table><thead><tr><th>方式</th><th>余额与用量行为</th><th>适用情况</th></tr></thead><tbody><tr><td>自动查询</td><td>打开页面、定时刷新和手动刷新时查询</td><td>接口稳定且允许轮询</td></tr><tr><td>仅手动查询</td><td>只在测试、立即刷新或“更新用量”时查询</td><td>接口有限流或调用成本</td></tr><tr><td>暂停全部查询</td><td>保留配置但不查询，也不参与汇总</td><td>临时停用</td></tr></tbody></table></div>'
      + '<h3>先从中转站文档确认什么</h3><ul><li>余额或额度接口的完整 URL、请求方法以及请求示例。</li><li>密钥放在 Authorization、X-API-Key、URL 参数还是请求 JSON 中。</li><li>成功响应的完整 JSON 示例，以及哪个字段代表剩余、已用、总额度和套餐。</li><li>额度单位是美元、人民币还是平台内部积分；内部积分与金额的换算比例是多少。</li><li>接口是否额外要求用户 ID，以及用户 ID 的请求头或参数名称。</li></ul>'
      + '<h3>自定义接口字段映射</h3><div class="docs-table-wrap"><table><thead><tr><th>面板字段</th><th>填写规则</th><th>示例</th></tr></thead><tbody>'
      + '<tr><td>地址</td><td>站点根地址。请求 URL 为完整地址时，此项仍填写站点首页或 API 根地址。</td><td>https://api.example.com</td></tr>'
      + '<tr><td>请求方法</td><td>必须与接口文档一致，只支持 GET 或 POST。</td><td>GET</td></tr>'
      + '<tr><td>认证方式</td><td>Bearer 自动发送 Authorization: Bearer 密钥；X-API-Key 自动发送 x-api-key；URL 参数会把密钥加入指定参数。</td><td>Bearer Token</td></tr>'
      + '<tr><td>参数名称</td><td>仅认证方式为 URL 参数时填写。</td><td>key</td></tr>'
      + '<tr><td>请求 JSON</td><td>仅 POST 使用，必须是合法 JSON。支持 {{apiKey}}、{{accessToken}}、{{baseUrl}}、{{userId}} 占位符。</td><td>{"token":"{{apiKey}}"}</td></tr>'
      + '<tr><td>请求 URL</td><td>以 / 开头时拼接到站点地址；以 http:// 或 https:// 开头时直接请求完整地址。</td><td>/api/v1/key/quota</td></tr>'
      + '<tr><td>剩余额度</td><td>必填。成功响应 JSON 中代表当前可用余额的字段路径。</td><td>data.key.remaining_usd</td></tr>'
      + '<tr><td>已用额度</td><td>可选。累计已用金额或额度的字段路径。</td><td>data.key.used_usd</td></tr>'
      + '<tr><td>总额度</td><td>可选。额度上限字段；留空且有已用额度时，系统使用剩余 + 已用。</td><td>data.key.total_usd</td></tr>'
      + '<tr><td>套餐名称</td><td>可选。仅用于站点卡片展示。</td><td>data.plan.name</td></tr>'
      + '<tr><td>换算除数</td><td>显示金额 = 接口原始数值 ÷ 换算除数。接口直接返回金额时填 1。</td><td>1 或 500000</td></tr>'
      + '<tr><td>额度币种</td><td>选择接口原始额度对应的币种，不是面板汇总后的币种。</td><td>USD 美元</td></tr></tbody></table></div>'
      + '<h3>JSON 字段路径规则</h3><p>字段路径从响应根对象开始，使用英文句点逐层定位；数组下标也使用数字片段。不要填写 <code>$.</code>、方括号或 JavaScript 表达式。数值和只包含数字、逗号、货币符号的字符串都可以解析。</p>'
      + '<div class="docs-code"><code>{<br>&nbsp;&nbsp;"data": {<br>&nbsp;&nbsp;&nbsp;&nbsp;"key": { "remaining_usd": 50, "used_usd": 3.2 },<br>&nbsp;&nbsp;&nbsp;&nbsp;"plan": { "name": "Pro" }<br>&nbsp;&nbsp;}<br>}<br><br>剩余额度：data.key.remaining_usd<br>已用额度：data.key.used_usd<br>套餐名称：data.plan.name<br>换算除数：1<br>额度币种：USD</code></div>'
      + '<h3>用户 ID 与 New API</h3><p>用户 ID 只在接口明确要求时填写。中转站自动识别模板会把它作为 <code>New-Api-User</code> 请求头发送；New API 或部分其他站点通常需要“系统访问令牌 + 用户 ID”。普通 API Key 查询一般留空。</p>'
      + '<h3>交给 AI 时使用的模板</h3><p>把下面任务、本页文档和中转站接口文档一起发给 AI。若平台文档没有提供某个字段，要求 AI 写“留空”，不要猜测。</p>'
      + '<div class="docs-code docs-prompt"><code>请根据中转站接口文档，为 API Balance 生成配置。<br>只使用文档明确给出的接口和字段，不要猜测，不要使用真实密钥。<br>请依次输出：<br>1. 地址<br>2. 余额请求方法、认证方式和参数名称<br>3. 余额请求 JSON（不需要则留空）<br>4. 余额请求 URL<br>5. 剩余、已用、总额度和套餐名称 JSON 路径<br>6. 余额换算除数、币种及计算依据<br>7. 是否需要用户 ID<br>8. 用量接口 URL（没有则留空）<br>9. 用量请求方法、认证方式、参数名称和请求 JSON<br>10. 完整用量字段映射 JSON<br>11. 用量 costCurrency 与 costDivisor 及依据<br>12. 接口返回周期汇总还是逐条日志<br>最后用响应示例逐项验证路径，列出缺失字段，并说明测试后应显示什么。</code></div></section>'
      + '<section id="docs-manage"><p class="docs-kicker">04</p><h2>站点管理</h2><p>这里集中维护已有站点。可按标签筛选、按余额或名称排序，也可直接启用、停用、编辑、测试、刷新和删除站点。</p>'
      + '<ul><li><strong>启用/停用：</strong>停用后保留配置，但不参与自动刷新和总额统计。</li><li><strong>测试查询：</strong>验证当前编辑内容，不必先覆盖已保存配置。</li><li><strong>立即刷新：</strong>重新获取单个站点数据。</li><li><strong>删除站点：</strong>确认后移除站点配置及其本地历史记录，此操作不可撤销。</li></ul></section>'
      + '<section id="docs-usage"><p class="docs-kicker">05</p><h2>用量统计</h2><p>总览下方可切换今日、昨日、近 7 天和近 30 天，查看消费、请求次数、输入与输出 Token、缓存读写、模型排行和最近请求。</p>'
      + '<h3>余额汇总与请求明细的区别</h3><p>自定义计费接口可提供剩余、已用、总额度和套餐汇总，但不能仅凭累计用量还原每天、每个模型和每次请求。详细统计必须由平台提供日志或分时账单接口。</p>'
      + '<h3>当前支持范围</h3><p>derouter 会自动读取 <code>/usage-logs</code> 或 <code>/sub-key/usage-logs</code>。其他平台可在站点管理中展开“自定义用量统计接口”，填写接口 URL、认证方式和字段映射 JSON，不需要修改程序代码。</p>'
      + '<div class="docs-callout warning"><strong>汇总不是日志</strong><span>周期汇总接口能显示消费、请求、Token 和模型排行，但不包含每次请求的时间与模型，因此“最近请求”会明确显示接口未提供逐条日志。</span></div>'
      + '<h3>字段映射 JSON</h3><p><code>summary</code> 映射根级余额；<code>periods</code> 映射今天、昨天、近 7 天和近 30 天对象；<code>metrics</code> 映射周期统计；<code>model</code> 映射模型排行。<code>costCurrency</code> 填 USD 或 CNY，<code>costDivisor</code> 填接口消费数值换算为金额时的除数。未提供的字段保持未知，不会按 0 汇总。</p>'
      + '<div class="docs-code docs-prompt"><code>{"summary":{"remaining":"remaining","used":"used","total":"total","unit":"unit"},"timezone":"timezone","costCurrency":"USD","costDivisor":1,"periods":{"today":"periods.today","yesterday":"periods.yesterday","last7d":"periods.last7d","last30d":"periods.last30d"},"metrics":{"requests":"requests","successCount":"successCount","failedCount":"failedCount","successRate":"successRate","inputTokens":"promptTokens","outputTokens":"completionTokens","totalTokens":"totalTokens","cost":"cost","models":"topModels"},"model":{"id":"modelId","name":"modelName","requests":"requests","tokens":"totalTokens","cost":"cost","successRate":"successRate"}}</code></div>'
      + '<h3>Sole 类周期汇总接口示例</h3><p>SoleAPI 可留空用量接口和映射，使用内置识别。若手动配置 <code>https://soleapi.com/v1/usage</code>，请求方法选 GET，认证方式选 Bearer Token，使用上面的 JSON 并将 <code>costCurrency</code> 改为 <code>CNY</code>，<code>costDivisor</code> 保持 1。Sole Credits 按人民币计价，不应再乘美元汇率。该接口返回 <code>periods</code> 汇总而非逐条日志，所以可以显示今日、近 7 天、近 30 天和模型排行，不能显示最近单次请求。</p>'
      + '<h3>判断中转站文档能否提供明细</h3><p>把平台文档交给 AI 时，让它确认日志接口是否返回以下信息：请求时间、模型名称、消费金额、输入 Token、输出 Token、缓存读取和缓存写入。时间字段必须能转换为日期；日志还需要分页方式，才能覆盖所选时间范围。</p>'
      + '<div class="docs-table-wrap"><table><thead><tr><th>统计项</th><th>程序可识别的常见字段</th><th>缺失时的结果</th></tr></thead><tbody><tr><td>请求时间</td><td>created_at 或 createdAt</td><td>无法归入日期范围</td></tr><tr><td>模型</td><td>model</td><td>归为“未知模型”</td></tr><tr><td>消费</td><td>cost_usdc、cost_usd、cost、amount</td><td>显示未知</td></tr><tr><td>输入 Token</td><td>input_tokens 或 inputTokens</td><td>显示未知</td></tr><tr><td>输出 Token</td><td>output_tokens 或 outputTokens</td><td>显示未知</td></tr><tr><td>缓存</td><td>cache_read_tokens、cache_write_tokens 或驼峰写法</td><td>显示未知</td></tr></tbody></table></div>'
      + '<p>把平台文档和本页一起发给 AI，要求它输出“用量接口 URL、请求方法、认证方式、请求 JSON、字段映射 JSON”，并逐项用响应示例验证路径。若平台返回分页日志而不是周期汇总，还要让 AI 明确分页参数和下一页规则；当前自定义表单只解析周期汇总，不能伪造单次请求。</p></section>'
      + '<section id="docs-general"><p class="docs-kicker">06</p><h2>通用设置</h2><div class="docs-table-wrap"><table><thead><tr><th>设置</th><th>说明</th></tr></thead><tbody><tr><td>刷新间隔</td><td>定时刷新全部站点；设为 0 表示关闭自动刷新。</td></tr><tr><td>请求超时</td><td>单个站点等待时间，范围 1 至 60 秒。</td></tr><tr><td>美元汇率</td><td>自动获取 USD/CNY，失败时沿用上次结果；也可切换手动填写。</td></tr><tr><td>低余额阈值</td><td>新站点默认告警值，单个站点仍可独立修改。</td></tr><tr><td>外观</td><td>侧边栏底部可选跟随系统、亮色或暗色；跟随系统会在设备主题改变时立即切换。</td></tr><tr><td>导入/导出</td><td>迁移设置与站点配置；导出文件应按密钥文件妥善保管。</td></tr></tbody></table></div></section>'
      + '<section id="docs-notify"><p class="docs-kicker">07</p><h2>推送设置</h2><p>推送属于一次性 10 元完整功能，激活后可使用。所有启用渠道共享每日推送时间；站点余额低于自身阈值或默认阈值时，系统向每个启用渠道发送一次，同一站点当天不重复提醒。</p>'
      + '<div class="docs-table-wrap"><table><thead><tr><th>渠道</th><th>需要填写</th><th>获取位置或请求格式</th></tr></thead><tbody><tr><td>Bark</td><td>完整推送地址</td><td>Bark App 提供的 https://api.day.app/你的Key</td></tr><tr><td>Server酱</td><td>SendKey</td><td>Server酱后台的 SendKey，只填 Key</td></tr><tr><td>PushPlus</td><td>Token</td><td>PushPlus“发送消息”页面中的用户 Token</td></tr><tr><td>Telegram</td><td>Bot Token、Chat ID</td><td>BotFather 创建机器人取得 Token；Chat ID 填接收者、群组或频道 ID</td></tr><tr><td>通用 Webhook</td><td>完整 URL</td><td>POST JSON：title、body、source、at</td></tr></tbody></table></div>'
      + '<ol><li>填写渠道凭据并打开对应开关。</li><li>先保存设置，再点击该渠道的测试按钮确认可达。</li><li>到达设定时间后，系统检查最近保存的余额；同一低余额站点当天只提醒一次。自动刷新设为 0 时仍会检查，但余额可能是上次结果。</li></ol><div class="docs-callout"><strong>凭据安全</strong><span>推送地址、Token、SendKey 和 Chat ID 会使用 APP_SECRET 加密保存在 data/config.json 中；网页只显示掩码，不返回明文。</span></div></section>'
      + '<section id="docs-http"><p class="docs-kicker">08</p><h2>HTTP API</h2><p>本章描述 API Balance 自身提供给网页和自动化工具调用的接口，不是中转站计费接口。所有响应均为 JSON，成功结构为 <code>{"ok":true,"data":...}</code>，失败结构为 <code>{"ok":false,"error":"原因"}</code>。</p>'
      + '<div class="docs-table-wrap"><table><thead><tr><th>方法与路径</th><th>用途</th></tr></thead><tbody><tr><td>GET /api/health</td><td>服务健康检查</td></tr><tr><td>GET /api/state</td><td>读取公开面板状态和掩码配置</td></tr><tr><td>POST /api/refresh</td><td>刷新全部自动站点；body 传 id 时刷新单站点</td></tr><tr><td>GET /api/usage?id=&amp;range=&amp;force=1</td><td>读取站点用量；range 为 today、yesterday、7d 或 30d，force=1 跳过短缓存</td></tr><tr><td>POST /api/probe</td><td>测试站点查询配置</td></tr><tr><td>POST /api/station</td><td>新增或更新站点；免费版最多 2 个</td></tr><tr><td>DELETE /api/station?id=</td><td>删除站点与本地历史</td></tr><tr><td>POST /api/license/activate</td><td>激活与当前安装绑定的完整功能许可证</td></tr><tr><td>POST /api/settings</td><td>保存通用、推送或更新设置</td></tr><tr><td>GET /api/version</td><td>检查远程版本与更新明细</td></tr><tr><td>GET / POST /api/update</td><td>读取更新状态或开始仓库更新</td></tr><tr><td>POST /api/update/file</td><td>上传 Git Bundle 本地更新包</td></tr><tr><td>GET /api/export / POST /api/import</td><td>导出或导入配置</td></tr></tbody></table></div><p>完整请求字段和状态码见 GitHub 仓库的 <code>docs/接口契约.md</code>。本接口没有内置鉴权，不应直接暴露到公网。</p></section>'
      + '<section id="docs-update"><p class="docs-kicker">09</p><h2>程序更新</h2><p>页面打开时会检查版本，进入“程序更新”或点击“检查更新”也会立即重新检测。检测结果会同时显示在首页、侧边栏和更新页；发现新版时，更新页列出当前版本到最新版之间的提交明细。</p>'
      + '<ol><li>代理留空表示 NAS 直连；需要代理时填写容器能够访问的 HTTP 或 HTTPS 代理。</li><li>正常连接 GitHub 时点击“从 GitHub 更新”，服务执行 <code>git pull --ff-only origin main</code>。</li><li>GitHub 无法连接时，可填写同步了本项目 <code>main</code> 分支和版本标签的可信 Git 镜像地址，保存后点击“从备用仓库更新”。</li><li>NAS 无法访问任何仓库时，在能联网的手机或电脑打开 GitHub Releases，下载名为 <code>api-balance-vX.Y.Z.bundle</code> 的文件，不要解压；回到更新页点击“选择更新包”。服务会校验项目、版本和 Git 历史，只允许快进到更高版本。</li><li>更新成功后服务退出并由 Docker 重启，页面等待服务恢复后自动刷新。若更新包含 Dockerfile 或依赖变化，请执行 <code>docker compose up -d --build</code>。</li></ol>'
      + '<div class="docs-callout warning"><strong>容器网络</strong><span>容器内的 127.0.0.1 指向容器自身，不是你的电脑。局域网代理应允许 LAN 访问，并填写 NAS 或代理主机的实际 IP 与端口。</span></div></section>'
      + '<section id="docs-fnos"><p class="docs-kicker">10</p><h2>飞牛 fnOS 应用</h2><p>首次安装使用 GitHub Release 中的 <code>api-balance-vX.Y.Z.fpk</code>；后续可在程序更新页查看说明并直接下载安装。FPK 使用飞牛的 <code>nodejs_v22</code> 运行时直接启动服务，不会创建 Docker 容器。</p><ol><li>安装向导中选择访问端口，默认 19999；已有 Docker 版占用该端口时请选择其他空闲端口。</li><li>安装完成后从飞牛桌面入口打开，或访问 <code>http://飞牛地址:所选端口</code>。端口也可在系统应用设置中修改，保存后服务会自动重启。</li><li>使用同一应用包名覆盖升级时，配置、加密密钥、日志和历史继续保存在飞牛分配的应用数据目录。</li><li>不要先卸载旧版；卸载时选择删除应用数据会清空这些文件。升级或卸载前建议先在通用设置导出配置。</li><li>应用内更新只接受官方 Release 中匹配版本的 FPK，并调用飞牛应用中心覆盖安装。</li></ol><div class="docs-callout warning"><strong>不要混用安装包</strong><span>FPK 用于飞牛，APK 用于 Android，Bundle 用于普通 Docker/Git 部署。原生版与 Docker 版数据相互独立；面板没有内置登录，不要把访问端口直接暴露到公网。</span></div></section>'
      + '<section id="docs-android"><p class="docs-kicker">11</p><h2>Android 独立应用</h2><p>Android 应用内置完整手机页面和查询逻辑，不需要 NAS、Docker 或单独部署服务。站点配置、密钥、余额历史与推送凭据只保存在当前手机。</p><ol><li>首次启动直接进入面板，在“添加站点”中填写地址和密钥即可查询。</li><li>密钥与配置由 Android Keystore 生成的设备密钥加密保存，卸载应用会删除本地数据。</li><li>系统后台任务会继续执行自动余额查询和低余额推送；Android 规定后台周期最短为 15 分钟，省电策略可能延迟执行，打开应用时仍按页面设置刷新。</li><li>导出配置时由系统选择保存位置；导出文件含站点密钥和推送凭据，应按密码文件保管。</li><li>更新页会显示 GitHub Release 的更新内容、安装包大小和实时下载进度。点击“下载 APK 并安装”后，下载完成会自动打开 Android 系统安装器。</li><li>首次更新时按系统提示允许本应用安装未知应用；Android 不允许应用绕过系统确认静默安装。</li></ol><div class="docs-callout warning"><strong>签名校验</strong><span>Android 只允许使用相同签名的新版 APK 覆盖安装。请只从本项目 GitHub Release 下载；覆盖安装会保留本机配置。</span></div></section>'
      + '<section id="docs-security"><p class="docs-kicker">12</p><h2>数据与安全</h2><p>Docker 版使用 <code>APP_SECRET</code> 加密数据卷；飞牛版使用应用数据目录中的随机设备密钥；Android 独立版使用 Android Keystore。所有模式的页面都不会显示完整密钥。</p>'
      + '<p>Docker 面板不提供内置账号登录，只应在可信局域网使用，或通过 NAS 权限、反向代理认证、VPN 和防火墙限制访问。站点、用量和 Webhook URL 会由程序主动请求，只应填写你信任的地址。</p><p>迁移 Docker 数据卷时必须保留原 <code>APP_SECRET</code>。Android 导出文件包含明文站点密钥和推送凭据，用于用户主动迁移，必须按密码文件保管；Android 应用私有数据本身仍保持加密。</p></section>'
      + '<section id="docs-faq" class="faq-section"><p class="docs-kicker">SUPPORT</p><h2>常见问题</h2><div class="faq-list">'
      + faqs.map(([question, answer]) => '<details><summary>' + esc(question) + '</summary><p>' + esc(answer) + '</p></details>').join('')
      + '</div></section></article></div>';
  }

  function renderUpdate() {
    const sid = '__update__';
    const update = DATA.settings.update || {};
    const labels = { idle: '尚未更新', queued: '等待执行', running: '正在下载', installing: '正在安装', success: '更新完成', failed: '更新失败' };
    const proxy = valueOf(sid, 'proxyUrl', DATA.settings.proxy?.url || '', '');
    const mirror = valueOf(sid, 'mirrorUrl', DATA.settings.proxy?.mirrorUrl || '', '');
    const busy = ['queued', 'running', 'installing'].includes(update.state);
    const androidVersion = androidValue('getVersionName');
    const androidServer = androidStandalone ? '配置与查询数据保存在本机' : androidValue('getServerUrl');
    const downloadBusy = ['queued', 'running', 'paused'].includes(androidDownload?.state);
    const downloadProgress = Number.isFinite(Number(androidDownload?.progress)) ? Math.max(-1, Math.min(100, Number(androidDownload.progress))) : -1;
    const installLabel = downloadBusy ? (downloadProgress >= 0 ? '正在下载 ' + downloadProgress + '%' : '准备下载…') : '立即更新';
    const versionState = versionChecking ? '正在检查新版本…' : versionInfo?.error ? '版本检查失败' : versionInfo?.updateAvailable ? '发现 v' + versionInfo.latest : versionInfo ? '已是最新 v' + versionInfo.current : '尚未检查版本';
    let html = '<section class="panel update-panel"><div class="phead"><span class="n">程序更新</span><span class="update-status ' + esc(update.state || 'idle') + '">' + esc(labels[update.state] || '尚未更新') + '</span><button type="button" class="btn update-check" data-act="check-update"' + (versionChecking ? ' disabled' : '') + '>' + icon('refresh') + ' 检查更新</button></div>';
    if (androidVersion) html += '<div class="android-update-card' + (androidStandalone ? ' standalone' : '') + '"><div><strong>' + (androidStandalone ? 'Android 独立版' : 'Android 应用') + '</strong><span class="android-version">v' + esc(androidVersion) + '</span><small>' + esc(androidServer) + '</small></div><div>' + (androidStandalone ? '' : '<button type="button" class="btn" data-act="android-server">修改服务器</button>') + '<button type="button" class="btn primary android-install" data-act="android-update"' + (downloadBusy ? ' disabled' : '') + '>' + icon(downloadBusy ? 'refresh' : 'download') + '<span>' + esc(installLabel) + '</span></button></div><p>安装包来自本项目 GitHub Release；下载完成后会打开 Android 系统安装器，首次使用需允许本应用安装更新。</p></div>';
    if (androidStandalone) {
      html += '<div class="update-version-summary"><strong>' + esc(versionState) + '</strong>' + (versionInfo?.error ? '<span>' + esc(versionInfo.error) + '</span>' : '') + '</div>';
      if (versionInfo?.releaseNotes?.length) html += '<div class="android-release-notes"><div><strong>更新内容</strong><span>v' + esc(versionInfo.latest) + (versionInfo.apkSize ? ' · ' + esc(fileSize(versionInfo.apkSize)) : '') + '</span></div><ul>' + versionInfo.releaseNotes.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul></div>';
      if (androidDownload) {
        const progressText = downloadProgress >= 0 ? downloadProgress + '%' : '等待中';
        const sizeText = androidDownload.total > 0 ? fileSize(androidDownload.downloaded) + ' / ' + fileSize(androidDownload.total) : fileSize(androidDownload.downloaded);
        html += '<div class="android-download-state ' + esc(androidDownload.state || '') + '" role="status" aria-live="polite"><div><span>' + esc(androidDownload.message || '正在准备下载') + '</span><strong>' + esc(progressText) + '</strong></div><div class="android-progress' + (downloadProgress < 0 && downloadBusy ? ' indeterminate' : '') + '" role="progressbar" aria-label="APK 下载进度"' + (downloadProgress >= 0 ? ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + downloadProgress + '"' : '') + '><i style="width:' + (downloadProgress >= 0 ? downloadProgress : 35) + '%"></i></div>' + (sizeText ? '<small>' + esc(sizeText) + '</small>' : '') + '</div>';
      }
      html += '</section>';
      return html;
    }
    if (DATA.deploymentMode === 'fnos') {
      const latest = versionInfo?.latest || '—';
      html += '<div class="fnos-version-grid"><div><span>当前版本</span><strong>v' + esc(DATA.version) + '</strong></div><b aria-hidden="true">→</b><div><span>最新版本</span><strong>' + (latest === '—' ? latest : 'v' + esc(latest)) + '</strong></div></div>';
      html += '<div class="update-version-summary"><strong>' + esc(versionState) + '</strong>' + (versionInfo?.source ? '<span>检测来源：' + esc(versionInfo.source) + '</span>' : '') + (versionInfo?.error ? '<span>' + esc(versionInfo.error) + '</span>' : '') + '</div>';
      if (versionInfo?.releaseNotes?.length) html += '<div class="android-release-notes"><div><strong>更新内容</strong><span>v' + esc(versionInfo.latest) + (versionInfo.fpkSize ? ' · ' + esc(fileSize(versionInfo.fpkSize)) : '') + '</span></div><ul>' + versionInfo.releaseNotes.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul></div>';
      html += '<div class="update-message">应用会在内部下载官方 FPK 并交给飞牛应用中心覆盖升级，站点配置、密钥和历史数据会保留；不要先卸载旧版。</div>';
      if (busy || update.message) html += '<div class="android-download-state ' + esc(update.state || '') + '" role="status" aria-live="polite"><div><span>' + esc(update.message || '正在准备更新') + '</span><strong>' + (Number.isFinite(Number(update.progress)) ? esc(update.progress) + '%' : '') + '</strong></div><div class="android-progress' + (Number(update.progress) <= 0 && busy ? ' indeterminate' : '') + '" role="progressbar" aria-label="FPK 更新进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + esc(Number(update.progress) || 0) + '"><i style="width:' + esc(Number(update.progress) || 0) + '%"></i></div></div>';
      html += '<div class="ops update-actions"><button type="button" class="btn primary" data-act="fnos-update"' + (!versionInfo?.updateAvailable || busy ? ' disabled' : '') + '>' + icon(busy ? 'refresh' : 'download') + ' ' + (busy ? '正在更新…' : versionInfo?.updateAvailable ? '立即更新到 v' + esc(versionInfo.latest) : '当前已是最新版') + '</button></div></section>';
      return html;
    }
    if (androidVersion) html += '<div class="update-section-title"><strong>服务端程序</strong><span>更新 NAS 或 Docker 中运行的 API Balance</span></div>';
    html += '<div class="update-version-summary"><strong>' + esc(versionState) + '</strong>' + (versionInfo?.source ? '<span>检测来源：' + esc(versionInfo.source) + '</span>' : '') + (versionInfo?.error ? '<span>' + esc(versionInfo.error) + '</span>' : '') + '</div>';
    html += '<div class="row"><label class="lbl" for="f-__update__-proxyUrl">代理地址</label><div class="update-proxy-control">'
      + '<input id="f-__update__-proxyUrl" class="field mono" type="url" data-sid="' + sid + '" data-field="proxyUrl" value="' + esc(proxy) + '" placeholder="http://NAS 可访问的代理地址:端口" autocomplete="url" aria-describedby="f-__update__-proxyUrl-help">'
      + '</div>' + fieldHelp('proxyUrl', 'f-__update__-proxyUrl') + '</div>';
    html += '<div class="row"><label class="lbl" for="f-__update__-mirrorUrl">备用仓库</label><div class="update-proxy-control">'
      + '<input id="f-__update__-mirrorUrl" class="field mono" type="url" data-sid="' + sid + '" data-field="mirrorUrl" value="' + esc(mirror) + '" placeholder="https://镜像站/用户/api.git" autocomplete="url" aria-describedby="f-__update__-mirrorUrl-help">'
      + '</div>' + fieldHelp('mirrorUrl', 'f-__update__-mirrorUrl') + '</div>';
    html += '<div class="hint">代理留空表示直连。备用仓库需同步本项目 main 分支和版本标签，并且只能填写可信地址。</div>';
    html += '<div class="row local-update-row"><label class="lbl" for="local-update-file">本地文件</label><div class="local-update-control">'
      + '<button type="button" class="btn" data-act="choose-local-update"' + (busy ? ' disabled' : '') + '>' + icon('upload') + ' 选择更新包</button>'
      + '<input id="local-update-file" type="file" accept=".bundle,application/octet-stream" hidden></div>'
      + '<div class="field-help">从 <a href="https://github.com/yiyu12138/api/releases" target="_blank" rel="noopener noreferrer">GitHub Releases</a> 下载 <code>api-balance-vX.Y.Z.bundle</code>，不要解压，最大 100 MB。</div></div>';
    if (versionInfo?.updateAvailable) {
      html += '<div class="update-details"><div><strong>更新明细</strong><span>v' + esc(versionInfo.current) + ' → v' + esc(versionInfo.latest) + '</span></div>';
      html += versionInfo.details?.length ? '<ul>' + versionInfo.details.map((item) => '<li><code>' + esc(item.commit) + '</code><span>' + esc(item.message) + '</span></li>').join('') + '</ul>' : '<p>' + esc(versionInfo.detailError || '远程仓库未提供可读取的提交明细。') + '</p>';
      html += '</div>';
    }
    if (update.message) html += '<div class="update-message">' + esc(update.message) + (update.commit ? ' · ' + esc(update.commit) : '') + '</div>';
    html += '<div class="ops update-actions"><button type="button" class="btn" data-act="save-update-settings">保存连接设置</button><button type="button" class="btn primary" data-act="update" data-source="github"' + (busy ? ' disabled' : '') + '>从 GitHub 更新</button><button type="button" class="btn" data-act="update" data-source="mirror"' + (busy || !mirror ? ' disabled' : '') + '>从备用仓库更新</button></div></section>';
    return html;
  }

  function renderUpdateConfirm() {
    const mirror = updateMethod === 'mirror';
    const local = updateMethod === 'local';
    const source = local ? '本地文件' : mirror ? '备用仓库' : ' GitHub';
    return '<div class="app-modal-backdrop"><section class="app-modal" role="dialog" aria-modal="true" aria-labelledby="update-confirm-title">'
      + '<h2 id="update-confirm-title">确认从' + source + '更新</h2>'
      + '<p>' + (local ? '将上传并验证“' + esc(localUpdateFile?.name || '更新包') + '”，仅在版本更高且 Git 历史可快进时安装。' : '将拉取 main 分支并重启当前服务。') + ' 配置和历史数据不会删除；Dockerfile 或依赖变化仍需手动重新构建镜像。</p>'
      + '<div class="app-modal-actions"><button type="button" class="btn" data-act="update-cancel">取消</button>'
      + '<button type="button" class="btn primary" data-act="update-confirm">确认更新</button></div></section></div>';
  }

  function renderVersionBanner() {
    if (!versionChecking && !versionInfo) return '';
    const text = versionChecking ? '正在检查程序更新…' : versionInfo.error ? '更新检测失败，点击查看' : versionInfo.updateAvailable ? '发现新版本 v' + versionInfo.latest + '，查看更新明细' : '当前已是最新版本 v' + versionInfo.current;
    const state = versionInfo?.updateAvailable ? ' available' : versionInfo?.error ? ' failed' : '';
    return '<button type="button" class="overview-update-state' + state + '" data-act="sidebar-view" data-view="update">' + icon('refresh') + '<span>' + esc(text) + '</span><b>›</b></button>';
  }

  function renderFeedback() {
    return '<div class="app-modal-backdrop"><section class="app-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-title">'
      + '<h2 id="feedback-title">反馈与联系</h2>'
      + '<p>使用过程中遇到问题或有功能建议，可通过下面的邮箱联系。</p>'
      + '<div class="feedback-address-row"><a class="feedback-address" href="mailto:avhlune@gmail.com?subject=API%20Balance%20反馈">avhlune@gmail.com</a>'
      + '<button type="button" class="feedback-copy" data-act="copy-email" title="复制邮箱">' + icon('copy') + '<span>复制</span></button></div>'
      + '<div class="app-modal-actions"><button type="button" class="btn" data-act="feedback-close">关闭</button>'
      + '<a class="btn primary" href="mailto:avhlune@gmail.com?subject=API%20Balance%20反馈">发送邮件</a></div></section></div>';
  }

  function renderPaymentButtons() {
    return '<div class="license-payment-actions"><button type="button" class="btn payment-alipay" data-act="payment-open" data-method="alipay">支付宝</button>'
      + '<button type="button" class="btn payment-wechat" data-act="payment-open" data-method="wechat">微信</button>'
      + '<button type="button" class="btn" data-act="payment-open" data-method="email">' + icon('mail') + ' 联系邮箱</button></div>';
  }

  function renderPurchaseModal() {
    const license = DATA.settings?.license || {};
    const email = license.contactEmail || 'avhlune@gmail.com';
    const installId = license.installId || '';
    const subject = encodeURIComponent('API Balance 激活码申请');
    const body = encodeURIComponent('你好，我已支付 10 元购买 API Balance 完整功能。\n\n安装编号：' + installId + '\n转账单号：\n\n我会在邮件中附上付款截图。');
    if (purchaseModal === 'email') {
      return '<div class="app-modal-backdrop"><section class="app-modal payment-modal" role="dialog" aria-modal="true" aria-labelledby="payment-title">'
        + '<h2 id="payment-title">联系邮箱领取激活码</h2><p>请把付款截图、转账单号和安装编号发送到下面的邮箱。</p>'
        + '<div class="feedback-address-row"><a class="feedback-address" href="mailto:' + esc(email) + '?subject=' + subject + '&body=' + body + '">' + esc(email) + '</a><button type="button" class="feedback-copy" data-act="copy-email" title="复制邮箱">' + icon('copy') + '<span>复制</span></button></div>'
        + '<div class="payment-install-id"><span>安装编号</span><code>' + esc(installId) + '</code></div><small class="payment-help">发送付款截图及转账单号，24 小时内会通过邮箱回复激活码。</small>'
        + '<div class="app-modal-actions"><button type="button" class="btn" data-act="payment-close">关闭</button><a class="btn primary" href="mailto:' + esc(email) + '?subject=' + subject + '&body=' + body + '">发送邮件</a></div></section></div>';
    }
    const alipay = purchaseModal === 'alipay';
    const name = alipay ? '支付宝' : '微信';
    const image = alipay ? 'payments/alipay.png' : 'payments/wechat.png';
    return '<div class="app-modal-backdrop"><section class="app-modal payment-modal" role="dialog" aria-modal="true" aria-labelledby="payment-title">'
      + '<h2 id="payment-title">' + name + '付款</h2><p>使用' + name + '扫码支付 10 元。</p><figure class="payment-qr"><img src="' + image + '" alt="' + name + '收款二维码"><figcaption>' + name + ' · 10 元</figcaption></figure>'
      + '<small class="payment-help">付款后请发送截图及转账单号，24 小时内会通过邮箱回复激活码。</small><div class="app-modal-actions"><button type="button" class="btn" data-act="payment-close">关闭</button><button type="button" class="btn primary" data-act="payment-open" data-method="email">联系邮箱</button></div></section></div>';
  }

  function renderSidebar() {
    const current = !settingsOpen ? 'overview' : settingsView;
    const version = DATA.version || '1.13.3';
    const hasUpdate = versionInfo?.updateAvailable === true;
    return '<aside class="app-sidebar" aria-label="主导航">'
      + '<div class="brand"><img class="brand-mark" src="favicon.svg" alt=""><span class="brand-text">API <b>Balance</b></span></div>'
      + '<nav class="main-nav">'
      + '<button type="button" class="nav-item' + (current === 'overview' ? ' active' : '') + '" data-act="sidebar-view" data-view="overview"><span class="nav-icon">' + icon('dashboard') + '</span><span class="nav-text">余额总览</span></button>'
      + '<button type="button" class="nav-item' + (current === 'add' ? ' active' : '') + '" data-act="sidebar-view" data-view="add"><span class="nav-icon">' + icon('plus') + '</span><span class="nav-text">添加站点</span></button>'
      + '<button type="button" class="nav-item' + (current === 'stations' ? ' active' : '') + '" data-act="sidebar-view" data-view="stations"><span class="nav-icon">' + icon('server') + '</span><span class="nav-text">站点管理</span></button>'
      + '<button type="button" class="nav-item' + (current === 'notify' ? ' active' : '') + '" data-act="sidebar-view" data-view="notify"><span class="nav-icon">' + icon('bell') + '</span><span class="nav-text">推送设置</span></button>'
      + '<button type="button" class="nav-item' + (current === 'general' ? ' active' : '') + '" data-act="sidebar-view" data-view="general"><span class="nav-icon">' + icon('settings') + '</span><span class="nav-text">通用设置</span></button>'
      + '</nav>'
      + '<div class="sidebar-bottom">'
      + '<button type="button" class="sidebar-tool" data-act="feedback-open" title="反馈"><span aria-hidden="true">' + icon('mail') + '</span><span class="sidebar-tool-text">反馈</span></button>'
      + '<a class="sidebar-repo" href="https://soleapi.com/r/ht4yz3xu" target="_blank" rel="noopener noreferrer" title="打开 SoleAPI 推荐链接"><span aria-hidden="true">' + icon('star') + '</span><span>推荐站点</span><small>推荐链接</small></a>'
      + '<button type="button" class="sidebar-tool' + (current === 'docs' ? ' active' : '') + '" data-act="sidebar-view" data-view="docs" title="API 文档"><span aria-hidden="true">' + icon('book') + '</span><span class="sidebar-tool-text">API 文档</span></button>'
      + '<button type="button" class="sidebar-tool' + (current === 'update' ? ' active' : '') + '" data-act="sidebar-view" data-view="update" title="程序更新"><span aria-hidden="true">' + icon('refresh') + '</span><span class="sidebar-tool-text">程序更新</span>' + (hasUpdate ? '<b>有更新</b>' : '') + '</button>'
      + '<a class="sidebar-repo" href="https://github.com/yiyu12138/api" target="_blank" rel="noopener noreferrer" title="打开 GitHub"><span aria-hidden="true">' + icon('github') + '</span><span>GitHub</span><small>v' + esc(version) + '</small></a>'
      + '<div class="sidebar-appearance"><span>外观</span>' + renderThemeOptions('sidebar-theme-options') + '</div>'
      + '</div>'
      + '</aside>';
  }

  function renderMobileUtilities() {
    const version = DATA.version || '1.13.3';
    const hasUpdate = versionInfo?.updateAvailable === true;
    const androidVersion = androidValue('getVersionName');
    return '<div class="mobile-utilities"><button type="button" class="side-item" data-act="feedback-open"><span class="side-icon">' + icon('mail') + '</span><span><strong>反馈</strong><small>联系开发者</small></span><b>›</b></button>'
      + '<a class="side-item" href="https://soleapi.com/r/ht4yz3xu" target="_blank" rel="noopener noreferrer"><span class="side-icon blue">' + icon('star') + '</span><span><strong>推荐站点</strong><small>SoleAPI · 推荐链接</small></span><b>↗</b></a>'
      + '<button type="button" class="side-item" data-act="sidebar-view" data-view="docs"><span class="side-icon">' + icon('book') + '</span><span><strong>API 文档</strong><small>查看全部功能说明</small></span><b>›</b></button>'
      + '<button type="button" class="side-item" data-act="sidebar-view" data-view="update"><span class="side-icon blue">' + icon('refresh') + '</span><span><strong>程序更新</strong><small>' + (androidVersion ? 'Android v' + esc(androidVersion) + ' · 服务 v' + esc(version) : hasUpdate ? '发现 v' + esc(versionInfo.latest) + ' 新版本' : '当前 v' + esc(version)) + '</small></span><b>›</b></button>'
      + '<a class="side-item" href="https://github.com/yiyu12138/api" target="_blank" rel="noopener noreferrer"><span class="side-icon">' + icon('github') + '</span><span><strong>GitHub</strong><small>v' + esc(version) + '</small></span><b>›</b></a>'
      + '<div class="mobile-theme"><strong>外观</strong>' + renderThemeOptions('mobile-theme-options') + '</div>'
      + '</div>';
  }

  function watchUpdate() {
    if (updatePollTimer) window.clearInterval(updatePollTimer);
    let tries = 0;
    updatePollTimer = window.setInterval(async () => {
      tries += 1;
      try {
        const body = await request('/api/update');
        if (body.ok && DATA) {
          DATA.settings.update = body.data;
          renderMainRaw();
          if (['success', 'failed'].includes(body.data.state) || tries > 40) {
            window.clearInterval(updatePollTimer);
            updatePollTimer = null;
            if (body.data.state === 'success') {
              let attempts = 0;
              window.setTimeout(async function waitForService() {
                attempts += 1;
                try {
                  const response = await fetch('/api/health', { cache: 'no-store' });
                  if (response.ok) return window.location.reload();
                } catch (error) { /* 服务重启期间继续等待 */ }
                if (attempts < 60) window.setTimeout(waitForService, 2000);
              }, 2500);
            }
          }
        }
      } catch (error) {
        if (tries > 40) { window.clearInterval(updatePollTimer); updatePollTimer = null; }
      }
    }, 3000);
  }

  function renderMobileNav() {
    const current = !settingsOpen ? 'overview' : settingsView;
    return '<nav class="mobile-bottom-nav" aria-label="底部导航"' + (updateConfirmOpen || feedbackOpen || purchaseModal ? ' inert' : '') + '>'
      + '<button type="button" class="' + (current === 'overview' ? 'active' : '') + '" data-act="sidebar-view" data-view="overview"><span class="mobile-nav-icon">' + icon('home') + '</span><span>总览</span></button>'
      + '<button type="button" class="' + (current === 'add' ? 'active' : '') + '" data-act="sidebar-view" data-view="add"><span class="mobile-nav-icon">' + icon('plus') + '</span><span>添加</span></button>'
      + '<button type="button" class="' + (current === 'stations' ? 'active' : '') + '" data-act="sidebar-view" data-view="stations"><span class="mobile-nav-icon">' + icon('server') + '</span><span>管理</span></button>'
      + '<button type="button" class="' + (current === 'notify' ? 'active' : '') + '" data-act="sidebar-view" data-view="notify"><span class="mobile-nav-icon">' + icon('bell') + '</span><span>推送</span></button>'
      + '<button type="button" class="' + (current === 'general' ? 'active' : '') + '" data-act="sidebar-view" data-view="general"><span class="mobile-nav-icon">' + icon('settings') + '</span><span>设置</span></button></nav>';
  }

  let overviewRequestId = 0;
  async function loadOverviewUsage(stations, options) {
    const explicit = options?.explicit === true;
    const force = options?.force === true;
    const candidates = stations.filter((station) => station.enabled !== false && station.queryMode !== 'paused' && (explicit || station.queryMode === 'auto'));
    const ticket=++overviewRequestId, range=overviewUsageRange;
    if (overviewUsageLoadedRange !== range) restoreOverviewUsage(stations, range);
    const previous = overviewUsageLoadedRange === range && Array.isArray(overviewUsage) ? overviewUsage : [];
    overviewUsageBusy=true; renderMainRaw();
    const rows=await Promise.all(candidates.map(async station=>{
      try { const r=await request('/api/usage?id='+encodeURIComponent(station.id)+'&range='+range+(force?'&force=1':''),{cache:'no-store'}); if(!r.ok) throw new Error(r.error || '查询失败'); return {station,data:r.data}; }
      catch(e){ return {station,error:e.message}; }
    }));
    if(ticket!==overviewRequestId || !DATA) return;
    const merged = new Map(previous
      .filter((row) => stations.some((station) => station.id === row.station.id && station.enabled !== false && station.queryMode !== 'paused'))
      .map((row) => [row.station.id, row]));
    rows.forEach((row) => {
      const old = merged.get(row.station.id);
      merged.set(row.station.id, row.error && old?.data ? { ...old, station: row.station, refreshError: row.error } : row);
    });
    overviewUsage=Array.from(merged.values()); overviewUsageLoadedRange=range; overviewUsageBusy=false;
    cacheOverviewUsage(range, overviewUsage);
    renderMainRaw();
  }
  function renderOverviewUsage(stations) {
    const rows=Array.isArray(overviewUsage)?overviewUsage:[];
    const details=rows.filter(x=>x.data?.detail);
    const keys=['cost','requests','inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'];
    const summarize=(items,key)=>{const values=items.map(x=>x.data?.today?.[key]).filter(finite).map(Number);return {value:values.reduce((sum,value)=>sum+value,0),known:values.length};};
    const total=Object.fromEntries(keys.map(k=>[k,summarize(details,k)]));
    const label={today:'今日',yesterday:'昨日','7d':'近七天','30d':'近30天'}[overviewUsageRange];
    const selected=overviewUsageStation==='all'?rows:rows.filter(x=>x.station.id===overviewUsageStation);
    const valid=selected.filter(x=>x.data?.detail);
    const stats=Object.fromEntries(keys.map(k=>[k,summarize(valid,k)]));
    const complete=rows.length>0 && details.length===rows.length && details.every(x=>x.data.complete);
    const metric=(title,value)=>'<div><small>'+esc(title)+'</small><b>'+value+'</b></div>';
    const mnum=(item,d=0)=>!item?.known?'—':number(item.value,d);
    const mtokens=(item)=>!item?.known?'—':tokenMillions(item.value);
    const partial=(title,...items)=>title+(items.some(item=>item.known<rows.length)?' · 已知部分':'');
    let h='<section id="usage-dashboard" class="overview-usage"><div class="overview-usage-head"><h2>全部中转站 · 用量总览</h2><div class="usage-selects"><div class="usage-range">'+[['today','今日'],['yesterday','昨日'],['7d','近七天'],['30d','近30天']].map(([v,t])=>'<button type="button" class="'+(v===overviewUsageRange?'on':'')+'" data-act="overview-usage-range" data-range="'+v+'">'+t+'</button>').join('')+'</div><button type="button" class="usage-update" data-act="overview-usage-refresh" aria-busy="'+overviewUsageBusy+'"'+(overviewUsageBusy?' disabled':'')+'>'+icon('refresh')+'<span>'+(overviewUsageBusy?'后台更新中':'更新用量')+'</span></button></div></div>';
    h+='<div class="overview-usage-metrics">'+metric(partial(label+'消费',total.cost),total.cost.known?money(usdAsCny(total.cost.value),'CNY'):'—')+metric(partial('请求次数',total.requests),mnum(total.requests))+metric(partial('输入 / 输出 Token',total.inputTokens,total.outputTokens),mtokens(total.inputTokens)+' / '+mtokens(total.outputTokens))+metric(partial('缓存读取 / 写入',total.cacheReadTokens,total.cacheWriteTokens),mtokens(total.cacheReadTokens)+' / '+mtokens(total.cacheWriteTokens))+'</div>';
    const sourceStatus=(x)=>x.refreshError?'刷新失败，显示上次数据 · '+clock(x.data?.fetchedAt):(x.error || x.data?.unavailableReason || (!x.data?.detail?'仅余额 · 无日期用量':finite(x.data.fetchedRecords)?(x.data.complete?'':'部分数据 · ')+number(x.data.fetchedRecords,0)+' 条日志 · '+clock(x.data.fetchedAt):'周期汇总 · '+clock(x.data.fetchedAt)));
    h+='<div class="coverage">'+(overviewUsageBusy?(rows.length?'正在后台更新，当前显示上次数据':'正在读取站点…'):details.length+'/'+rows.length+' 个已查询站点提供用量'+(complete?' · 已读取接口报告的数据':' · 缺失字段和失败站点不计为 0')+(stations.some(s=>s.enabled!==false&&s.queryMode==='manual')?' · 仅手动站点请点“更新用量”':'') )+'</div>';
    h+='<div class="overview-usage-list">'+rows.map(x=>'<div class="overview-usage-row"><strong>'+esc(x.station.name)+'</strong><span>'+esc(sourceStatus(x))+'</span></div>').join('')+'</div>';
    const daily={}; details.forEach(x=>(x.data.trend || []).forEach(d=>{daily[d.date]=(daily[d.date] || 0)+d.cost;}));
    const entries=Object.entries(daily).sort(), peak=Math.max(...entries.map(x=>x[1]),0.000001);
    h+='<div class="trend-box"><div class="detail-heading"><h3>'+label+'消费趋势</h3><small>RMB · 用量接口</small></div>';
    h+=entries.length?'<div class="trend-bars">'+entries.map(([d,v])=>'<div title="'+d+' · '+money(usdAsCny(v),'CNY')+'"><span>'+money(usdAsCny(v),'CNY')+'</span><i style="height:'+Math.max(v/peak*110,2)+'px"></i><small>'+d.slice(5)+'</small></div>').join('')+'</div>':'<div class="overview-usage-loading">'+(overviewUsageBusy?'正在读取趋势…':'暂无可统计的明细数据')+'</div>';
    h+='</div><div class="detail-heading usage-station-picker"><div><h3>详细用量</h3><small>切换站点仅影响下方明细，上方始终汇总所有已查询站点</small></div><label><span>查看站点明细</span><select data-act="overview-usage-station"><option value="all">所有已查询站点</option>'+rows.map(x=>x.station).map(s=>'<option value="'+esc(s.id)+'"'+(s.id===overviewUsageStation?' selected':'')+'>'+esc(s.name)+'</option>').join('')+'</select></label></div>';
    h+=selected.filter(x=>x.error || x.data?.unavailable || !x.data?.detail || !x.data.complete).map(x=>'<div class="usage-note">'+esc(x.station.name)+'：'+esc(x.error || x.data?.unavailableReason || (x.data.detail?x.data.warning:'当前接入的 API 仅返回余额与累计汇总，无法按日期或模型拆分。'))+(x.data?.summary?'<br>剩余 '+esc(number(x.data.summary.remaining,4))+' / 累计使用 '+esc(number(x.data.summary.used,4))+' / 总额 '+esc(number(x.data.summary.total,4))+' '+esc(x.data.summary.unit || 'Credits'):'')+'</div>').join('');
    h+='<div class="usage-metrics">'+keys.map((k,i)=>metric(['消费 RMB','请求次数','输入 Token','输出 Token','缓存读取','缓存写入'][i]+(stats[k].known<valid.length?' · 已知部分':''),i===0?(stats[k].known?money(usdAsCny(stats[k].value),'CNY'):'—'):i===1?mnum(stats[k]):mtokens(stats[k]))).join('')+'</div>';
    const models={}, logs=[];
    valid.forEach(x=>{(x.data.models || []).forEach(m=>{const key=x.station.id+'|'+m.model; models[key]={...m,station:x.station.name};});(x.data.logs || []).forEach(l=>logs.push({...l,station:x.station.name}));});
    const pickCost=x=>{for(const k of ['cost_usdc','cost_usd','cost','amount']) if(finite(x[k])) return Number(x[k]);return 0;};
    h+='<div class="usage-columns"><section class="usage-section"><div class="usage-section-title">'+label+' · 模型消费排行</div>'+Object.values(models).sort((a,b)=>b.cost-a.cost).map(m=>'<div class="model-row"><span><strong>'+esc(m.model)+'</strong><small>'+esc(m.station)+' · '+number(m.requests,0)+' 次 · '+tokenMillions(m.inputTokens+m.outputTokens)+' tokens</small></span><b>'+money(usdAsCny(m.cost),'CNY')+'</b></div>').join('')+(!Object.keys(models).length?'<div class="overview-usage-loading">接口未返回模型排行</div>':'')+'</section><section class="usage-section"><div class="usage-section-title">最近请求 · 最多 30 条</div>'+logs.sort((a,b)=>new Date(b.created_at || b.createdAt)-new Date(a.created_at || a.createdAt)).slice(0,30).map(x=>'<div class="log-row"><span><strong>'+esc(x.model || '未知模型')+'</strong><small>'+esc(x.station)+' · '+esc(new Date(x.created_at || x.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}))+'</small><small>'+number(x.input_tokens ?? x.inputTokens ?? 0,0)+' in / '+number(x.output_tokens ?? x.outputTokens ?? 0,0)+' out</small></span><b>'+money(usdAsCny(pickCost(x)),'CNY')+'</b></div>').join('')+(!logs.length?'<div class="overview-usage-loading">当前接口只提供汇总，不包含逐条请求日志</div>':'')+'</section></div></section>';
    return h;
  }

  function renderUsagePage(stations) {
    const st = stations.find((x) => x.id === usageStationId);
    const name = st?.name || '站点用量';
    if (usageBusy) return '<div class="usage-view"><div class="drawer-head"><button type="button" class="back" data-act="usage-back">‹</button><div><p class="hello">统计</p><h1>' + esc(name) + '</h1></div></div><div class="empty"><div class="big">◌</div><strong>正在读取用量数据…</strong></div></div>';
    const data = usageData;
    let html = '<div class="usage-view"><div class="drawer-head"><button type="button" class="back" data-act="usage-back">‹</button><div><p class="hello">用量统计</p><h1>' + esc(name) + '</h1></div></div><div class="usage-range" role="tablist">' + [['today','今日'],['yesterday','昨日'],['7d','近七天'],['30d','近30天']].map((r) => '<button type="button" class="' + (usageRange === r[0] ? 'on' : '') + '" data-act="usage-range" data-range="' + r[0] + '">' + r[1] + '</button>').join('') + '</div>';
    if (!data) return html + '<div class="empty"><div class="big">▥</div><strong>暂无用量数据</strong><div>点击下方按钮重新读取。</div><button type="button" data-act="usage" data-sid="' + esc(usageStationId) + '">读取用量</button></div></div>';
    if (!data.detail) {
      const s = data.summary || {};
      html += '<div class="usage-note">该站点官方只开放汇总接口，未开放按模型和请求明细。</div><div class="usage-metrics"><div><small>剩余</small><b>$' + esc(number(s.remaining, 4)) + '</b></div><div><small>累计使用</small><b>$' + esc(number(s.used, 4)) + '</b></div><div><small>总额度</small><b>$' + esc(number(s.total, 4)) + '</b></div></div><button type="button" class="btn primary usage-refresh" data-act="usage" data-sid="' + esc(usageStationId) + '">刷新统计</button></div>';
      return html;
    }
    const t = data.today || {};
    html += '<div class="usage-metrics"><div><small>今日消费</small><b>' + esc(money(usdAsCny(t.cost), 'CNY')) + '</b></div><div><small>今日请求</small><b>' + esc(number(t.requests, 0)) + '</b></div><div><small>输入 Token</small><b>' + esc(tokenMillions(t.inputTokens)) + '</b></div><div><small>输出 Token</small><b>' + esc(tokenMillions(t.outputTokens)) + '</b></div><div><small>缓存读取</small><b>' + esc(tokenMillions(t.cacheReadTokens)) + '</b></div><div><small>缓存写入</small><b>' + esc(tokenMillions(t.cacheWriteTokens)) + '</b></div></div>';
    html += '<div class="usage-section"><div class="usage-section-title">今日模型消费</div><div class="model-list">' + (data.models.length ? data.models.map((m) => '<div class="model-row"><span><strong>' + esc(m.model) + '</strong><small>' + esc(number(m.requests, 0)) + ' 次 · ' + esc(tokenMillions(m.inputTokens + m.outputTokens)) + ' tokens</small></span><b>' + esc(money(usdAsCny(m.cost), 'CNY')) + '</b></div>').join('') : '<div class="empty compact">今天暂无模型用量</div>') + '</div></div>';
    html += '<div class="usage-section"><div class="usage-section-title">最近请求明细</div><div class="log-list">' + data.logs.slice(0, 20).map((x) => '<div class="log-row"><span><strong>' + esc(x.model || '未知模型') + '</strong><small>' + esc(x.created_at || '') + ' · ' + esc(number(x.input_tokens || 0, 0)) + ' in / ' + esc(number(x.output_tokens || 0, 0)) + ' out</small></span><b>' + esc(money(usdAsCny(x.cost_usdc || 0), 'CNY')) + '</b></div>').join('') + '</div></div><button type="button" class="btn primary usage-refresh" data-act="usage" data-sid="' + esc(usageStationId) + '">刷新统计</button></div>';
    return html;
  }

  function renderSettingsPage(stations) {
    const pages = {
      general: ['通用设置', '刷新、汇率与配置管理'],
      notify: ['推送设置', '配置低余额通知渠道与每日发送时间'],
      add: ['添加站点', '保存或探测时自动识别站点类型'],
      update: ['程序更新', '检查版本并选择更新来源'],
      stations: ['站点管理', '编辑、检测和管理已有站点'],
      docs: ['API 文档', '面板全部功能与配置说明'],
    };
    const page = pages[settingsView] || pages.general;
    let html = '<section class="workspace-page"><header class="workspace-head"><p class="hello">API BALANCE</p><h1>'
      + esc(page[0]) + '</h1><span>' + esc(page[1]) + '</span></header><div class="workspace-body">';
    if (settingsView === 'general') {
      html += renderLicense() + renderSettings() + renderAlerts() + renderMobileUtilities();
    } else if (settingsView === 'notify') {
      html += renderNotifySettings();
    } else if (settingsView === 'add') {
      html += renderStationPanel(null);
    } else if (settingsView === 'update') {
      html += renderUpdate();
    } else if (settingsView === 'docs') {
      html += renderDocs();
    } else {
      html += renderStationList(stations);
    }
    html += '</div></section>';
    return html;
  }

  function renderMainRaw() {
    if (!DATA) return;
    const summary = DATA.summary || {};
    const rate = Number(DATA.settings?.fx?.rate) > 0 ? Number(DATA.settings.fx.rate) : 7.2;
    const totalUsd = finite(summary.totalUsd) ? Number(summary.totalUsd) : 0;
    const totalCny = totalUsd * rate;
    const stations = Array.isArray(DATA.stations) ? DATA.stations : [];

    const pageTitle = settingsOpen ? ({ general: '通用设置', notify: '推送设置', add: '添加站点', update: '程序更新', stations: '站点管理', docs: 'API 文档' }[settingsView] || '控制台') : '控制台';
    let html = '<div class="app-shell"' + (updateConfirmOpen || feedbackOpen || purchaseModal ? ' inert' : '') + '>' + renderSidebar() + '<main class="wrap"><div class="topbar"><div class="topbar-title"><span class="topbar-icon">' + icon('dashboard') + '</span><span>' + esc(pageTitle) + '</span></div><span class="topbar-state">API 余额与用量</span></div>';
    if (settingsOpen) {
      html += renderSettingsPage(stations) + '</main></div>';
      if (updateConfirmOpen) html += renderUpdateConfirm();
      if (feedbackOpen) html += renderFeedback();
      if (purchaseModal) html += renderPurchaseModal();
      root.innerHTML = html + renderMobileNav();
      return;
    }
    html += '<div class="top"><div><p class="hello">余额总览</p>'
      + '<div class="total num"><small>¥</small>' + esc(number(totalCny, 2)) + '</div>'
      + '<div class="sub num"><b>' + esc(money(totalUsd, 'USD')) + '</b> · ' + esc(summary.count || 0) + ' 家站点 · ' + esc(clock(DATA.lastRefreshAt)) + ' 更新</div>'
      + '</div><div class="top-actions"><button type="button" class="refresh" data-act="refresh"' + (busy ? ' disabled' : '') + '>'
      + (busy ? '<span class="spin"></span>刷新中' : '↻ 刷新') + '</button></div></div>';

    html += renderVersionBanner();

    html += '<div class="chips"><div class="chip"><i></i>' + esc(summary.normal || 0) + ' 家正常</div>'
      + '<div class="chip warn"><i></i>' + esc(summary.low || 0) + ' 家余额偏低</div>';
    if (Number(summary.failed) > 0) html += '<div class="chip bad"><i></i>' + esc(summary.failed) + ' 家异常</div>';
    html += '<div class="chip num">汇率 ' + esc(number(rate, 2)) + ' · ' + (DATA.settings.fx.auto === false ? '手动' : '自动') + '</div>'
      + '<div class="chip num">总耗时 ' + (finite(elapsedMs) ? esc((Number(elapsedMs) / 1000).toFixed(2)) + 's' : '--') + '</div></div>';

    if (stations.length) {
      html += '<div class="grid station-grid">' + stations.map(renderCard).join('') + '</div>';
    } else {
      html += '<div class="empty"><div class="big" aria-hidden="true">💳</div><strong>还没有添加 API 站点</strong>'
        + '<div>点击下方按钮或左侧“添加站点”开始配置。</div>'
        + '<button type="button" data-act="settings-open-add">＋ 添加站点</button></div>';
    }

    html += renderOverviewUsage(stations);

    html += '<div class="footnote">密钥会加密保存在容器数据卷中，网页接口不会返回明文。</div>';
    html += '</main></div>';

    if (updateConfirmOpen) html += renderUpdateConfirm();
    if (feedbackOpen) html += renderFeedback();
    if (purchaseModal) html += renderPurchaseModal();
    root.innerHTML = html + renderMobileNav();
  }

  function rerender() {
    snapshotDrafts();
    renderMainRaw();
  }

  function renderLoadError(message) {
    root.innerHTML = '<main class="wrap"><div class="empty"><div class="big" aria-hidden="true">⚠️</div><strong>暂时无法打开面板</strong>'
      + '<div>' + esc(message || '请稍后重试') + '</div><button type="button" data-act="bootstrap">重试</button></div></main>';
  }

  function stationPayload(sid) {
    snapshotDrafts();
    const current = sid === '__new__' ? null : DATA.stations.find((item) => item.id === sid);
    const values = draft[sid] || {};
    const selectedPreset = values.preset || current?.preset || PRESETS[0]?.id || 'relay-auto';
    const p = presetOf(selectedPreset);
    const read = (field, fallback) => hasOwn(values, field) ? values[field] : (current && current[field] !== undefined ? current[field] : fallback);
    const threshold = read('thresholdUsd', '');
    const raw = read('rawPerUnit', p.rawPerUnit || 1);
    const extraHeaders = Object.assign({}, current?.extraHeaders || {});
    const userId = String(read('userId', extraHeaders['New-Api-User'] || '')).trim();
    if (userId) extraHeaders['New-Api-User'] = userId;
    else delete extraHeaders['New-Api-User'];
    return {
      id: current?.id,
      name: String(read('name', p.name || '未命名')).trim(),
      baseUrl: String(read('baseUrl', p.baseUrl || '')).trim(),
      preset: selectedPreset,
      queryMode: read('queryMode', current?.queryMode || 'auto'),
      usageEndpoint: String(read('usageEndpoint', '')).trim(),
      usageRequestMethod: read('usageRequestMethod', 'GET') === 'POST' ? 'POST' : 'GET',
      usageRequestBody: String(read('usageRequestBody', '')),
      usageAuthMode: ['bearer', 'x-api-key', 'query', 'none'].includes(read('usageAuthMode', 'bearer')) ? read('usageAuthMode', 'bearer') : 'bearer',
      usageAuthQueryParam: String(read('usageAuthQueryParam', 'key')).trim() || 'key',
      usageMap: String(read('usageMap', '')).trim(),
      queryPath: String(read('queryPath', '')).trim(),
      quotaPath: String(read('quotaPath', '')).trim(),
      subtractPath: String(read('subtractPath', '')).trim(),
      usedPath: String(read('usedPath', '')).trim(),
      totalPath: String(read('totalPath', '')).trim(),
      planPath: String(read('planPath', '')).trim(),
      requestMethod: read('requestMethod', 'GET') === 'POST' ? 'POST' : 'GET',
      requestBody: String(read('requestBody', '')),
      authMode: ['bearer', 'x-api-key', 'query', 'none'].includes(read('authMode', 'bearer')) ? read('authMode', 'bearer') : 'bearer',
      authQueryParam: String(read('authQueryParam', 'key')).trim() || 'key',
      rawPerUnit: finite(raw) && Number(raw) > 0 ? Number(raw) : (p.rawPerUnit || 1),
      unitCurrency: read('unitCurrency', p.currency || 'USD') === 'CNY' ? 'CNY' : 'USD',
      tag: String(read('tag', '')).trim(),
      enabled: current ? current.enabled !== false : true,
      thresholdUsd: threshold === '' || threshold === null || threshold === undefined ? null : Number(threshold),
      extraHeaders,
      token: String(read('token', '')).trim(),
    };
  }

  function notificationPayload() {
    const values = draft.__notify__ || {};
    const saved = DATA.settings.notify || { pushTime: '09:00', channels: {} };
    const enabled = (type) => hasOwn(values, type + 'Enabled')
      ? values[type + 'Enabled'] : saved.channels?.[type]?.enabled === true;
    const text = (field) => String(values[field] || '').trim();
    return {
      pushTime: text('pushTime') || saved.pushTime || '09:00',
      channels: {
        bark: { enabled: enabled('bark'), url: text('barkUrl') },
        serverChan: { enabled: enabled('serverChan'), sendKey: text('serverChanSendKey') },
        pushPlus: { enabled: enabled('pushPlus'), token: text('pushPlusToken') },
        telegram: { enabled: enabled('telegram'), botToken: text('telegramBotToken'), chatId: text('telegramChatId') },
        webhook: { enabled: enabled('webhook'), url: text('webhookUrl') },
      },
    };
  }

  function validateStation(station, isNew) {
    if (!station.name) throw new Error('请填写站点名称');
    if (!station.baseUrl) throw new Error('请填写站点地址');
    try { new URL(station.baseUrl); } catch (error) { throw new Error('站点地址格式不正确'); }
    if (isNew && !station.token && !(station.preset === 'custom' && station.authMode === 'none')) throw new Error('请填写密钥或系统访问令牌');
    if (station.thresholdUsd !== null && !Number.isFinite(station.thresholdUsd)) throw new Error('余额格式不正确');
    if (station.preset === 'custom' && !station.queryPath) throw new Error('请填写请求 URL');
    if (station.preset === 'custom' && !station.quotaPath) throw new Error('请填写剩余额度字段');
    if (station.usageEndpoint && !station.usageMap) throw new Error('请填写用量字段映射 JSON');
    if (station.usageMap) {
      try { JSON.parse(station.usageMap); } catch (error) { throw new Error('用量字段映射不是有效 JSON'); }
    }
  }

  async function refreshOnOpen() {
    if (!DATA) return;
    busy = true;
    renderMainRaw();
    try {
      const body = await post('/api/refresh', {});
      if (!body.ok) throw new Error(body.error || '自动刷新失败');
      DATA = body.data;
      elapsedMs = body.data.elapsedMs;
    } catch (error) {
      toast('自动刷新失败：' + error.message, 'bad');
    } finally {
      busy = false;
      if (DATA) renderMainRaw();
    }
  }

  async function loadState(body) {
    body = body || await request('/api/state');
    if (!body.ok) throw new Error(body.error || '读取状态失败');
    DATA = body.data;
    restoreOverviewUsage(DATA.stations || [], overviewUsageRange);
    renderMainRaw();
    checkVersionOnOpen();
    loadOverviewUsage(DATA.stations || []);
    await refreshOnOpen();
  }

  async function checkVersionOnOpen() {
    if (versionChecking) return;
    versionChecking = true;
    if (DATA) renderMainRaw();
    try {
      const body = await request('/api/version');
      if (body.ok) versionInfo = body.data;
    } catch (error) {
      versionInfo = { current: DATA?.version || '', latest: '', updateAvailable: false, error: error.message };
    } finally {
      versionChecking = false;
    }
    if (DATA) renderMainRaw();
  }

  async function bootstrap() {
    try {
      const [body, state] = await Promise.all([request('/api/bootstrap'), request('/api/state')]);
      PRESETS = Array.isArray(body.presets) ? body.presets : [];
      await loadState(state);
    } catch (error) {
      renderLoadError(error.message);
    }
  }

  function navigateView(view) {
    snapshotDrafts();
    const license = DATA?.settings?.license;
    if (view === 'add' && license && !license.active && DATA.stations.length >= Number(license.stationLimit || 2)) {
      settingsOpen = true; settingsView = 'general'; editingStationId = null;
      renderMainRaw();
      toast('免费版最多添加 ' + (license.stationLimit || 2) + ' 个站点，支付 10 元可解锁完整功能', 'bad');
      window.setTimeout(() => root.querySelector('#license-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
      return;
    }
    if (view === 'overview') {
      settingsOpen = false; settingsView = 'general'; editingStationId = null; usageStationId = null; usageData = null;
    } else {
      settingsOpen = true; settingsView = view; editingStationId = null; usageStationId = null; usageData = null;
      stationFilter = 'all'; stationSort = 'default'; newStep = 1;
    }
    renderMainRaw();
    window.scrollTo(0, 0);
  }
  function restoreModalFocus() {
    const action = modalReturnAction;
    modalReturnAction = '';
    [...root.querySelectorAll('[data-act="' + action + '"]')].find((node) => node.getClientRects().length)?.focus();
  }

  async function handleAction(button) {
    const action = button.dataset.act;
    const sid = button.dataset.sid;

    if (action === 'bootstrap') return bootstrap();
    if (action === 'feedback-open') {
      modalReturnAction = action;
      feedbackOpen = true;
      renderMainRaw();
      window.setTimeout(() => root.querySelector('[data-act="feedback-close"]')?.focus(), 0);
      return;
    }
    if (action === 'feedback-close') {
      feedbackOpen = false;
      renderMainRaw();
      window.setTimeout(restoreModalFocus, 0);
      return;
    }
    if (action === 'payment-open') {
      modalReturnAction = action;
      purchaseModal = button.dataset.method || 'email';
      renderMainRaw();
      window.setTimeout(() => root.querySelector('[data-act="payment-close"]')?.focus(), 0);
      return;
    }
    if (action === 'payment-close') {
      purchaseModal = '';
      renderMainRaw();
      window.setTimeout(restoreModalFocus, 0);
      return;
    }
    if (action === 'copy-email') {
      const email = 'avhlune@gmail.com';
      try {
        await copyText(email);
        toast('邮箱已复制', 'ok');
      } catch (error) { toast('复制失败，请手动复制', 'bad'); }
      return;
    }
    if (action === 'copy-install-id') {
      try {
        await copyText(DATA.settings.license.installId);
        toast('安装编号已复制', 'ok');
      } catch (error) { toast('复制失败，请手动复制', 'bad'); }
      return;
    }
    if (action === 'android-update') {
      try {
        if (!window.AndroidApp || typeof window.AndroidApp.downloadUpdate !== 'function') throw new Error('当前不是 Android 应用');
        androidDownload = { state: 'queued', progress: -1, downloaded: 0, total: 0, message: '正在准备下载' };
        renderMainRaw();
        window.AndroidApp.downloadUpdate();
      } catch (error) {
        androidDownload = { state: 'failed', progress: -1, downloaded: 0, total: 0, message: error.message || '无法启动下载' };
        renderMainRaw();
        toast(error.message || '无法启动下载', 'bad');
      }
      return;
    }
    if (action === 'fnos-update') {
      if (!versionInfo?.updateAvailable) return toast('当前没有可安装的新版本', 'bad');
      const body = await post('/api/update', {});
      if (!body.ok) return toast(body.error || '无法开始更新', 'bad');
      DATA.settings.update = body.data;
      renderMainRaw();
      toast('已开始在应用内下载并安装', 'ok');
      watchUpdate();
      return;
    }
    if (action === 'android-server') {
      if (window.AndroidApp && typeof window.AndroidApp.changeServer === 'function') window.AndroidApp.changeServer();
      return;
    }
    if (action === 'update') {
      modalReturnAction = action;
      snapshotDrafts();
      updateMethod = button.dataset.source === 'mirror' ? 'mirror' : 'github';
      updateConfirmOpen = true;
      renderMainRaw();
      window.setTimeout(() => root.querySelector('[data-act="update-confirm"]')?.focus(), 0);
      return;
    }
    if (action === 'choose-local-update') {
      root.querySelector('#local-update-file')?.click();
      return;
    }
    if (action === 'update-cancel') {
      updateConfirmOpen = false;
      if (updateMethod === 'local') localUpdateFile = null;
      renderMainRaw();
      window.setTimeout(restoreModalFocus, 0);
      return;
    }
    if (action === 'check-update') {
      checkVersionOnOpen();
      return;
    }
    if (action === 'sidebar-view') {
      const view = button.dataset.view || 'overview';
      navigateView(view);
      if (view === 'update') checkVersionOnOpen();
      return;
    }
    if (action === 'settings-open') {
      snapshotDrafts();
      settingsOpen = true;
      settingsView = 'general';
      editingStationId = null;
      renderMainRaw();
      return;
    }
    if (action === 'settings-open-add') {
      snapshotDrafts();
      settingsOpen = true;
      settingsView = 'add';
      newStep = 1;
      renderMainRaw();
      return;
    }
    if (action === 'edit-station') {
      snapshotDrafts();
      editingStationId = sid;
      settingsView = 'stations';
      settingsOpen = true;
      renderMainRaw();
      window.setTimeout(() => root.querySelector('[data-panel-sid="' + sid + '"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
      return;
    }
    if (action === 'filter-tag') {
      stationFilter = button.value || 'all';
      renderMainRaw();
      return;
    }
    if (action === 'sort-stations') {
      stationSort = button.value || 'default';
      renderMainRaw();
      return;
    }
    if (action === 'new-next') {
      snapshotDrafts();
      const station = stationPayload('__new__');
      if (!station.name) return toast('请填写站点名称', 'bad');
      if (!station.baseUrl) return toast('请填写站点地址', 'bad');
      try { new URL(station.baseUrl); } catch (error) { return toast('站点地址格式不正确', 'bad'); }
      newStep = 2;
      renderMainRaw();
      return;
    }
    if (action === 'new-prev') {
      snapshotDrafts();
      newStep = 1;
      renderMainRaw();
      return;
    }
    if (action === 'theme-mode') {
      themeMode = button.dataset.mode || 'system';
      darkMode = themeMode === 'dark' || (themeMode === 'system' && systemTheme.matches);
      window.localStorage.setItem('api-balance-theme', themeMode);
      applyTheme();
      renderMainRaw();
      return;
    }
    if (action === 'overview-usage-station') {
      overviewUsageStation = button.value || 'all';
      renderMainRaw();
      return;
    }
    if (action === 'overview-usage-range') {
      overviewUsageRange = button.dataset.range || 'today';
      restoreOverviewUsage(DATA.stations || [], overviewUsageRange);
      loadOverviewUsage(DATA.stations || [], { explicit: true });
      return;
    }
    if (action === 'usage') {
      overviewUsageStation=sid; settingsOpen=false; usageStationId=null;
      renderMainRaw();
      root.querySelector('#usage-dashboard')?.scrollIntoView({behavior:'smooth'});
      if (!overviewUsage) loadOverviewUsage(DATA.stations || [], { explicit: true });
      return;
    }
    if (action === 'overview-usage-refresh') return loadOverviewUsage(DATA.stations || [], { explicit: true, force: true });
    if (action === 'usage-back') {
      snapshotDrafts();
      usageStationId = null;
      usageData = null;
      usageBusy = false;
      renderMainRaw();
      return;
    }
    if (action === 'settings-back') {
      snapshotDrafts();
      usageStationId = null;
      usageData = null;
      settingsOpen = false;
      settingsView = 'general';
      editingStationId = null;
      renderMainRaw();
      return;
    }
    if (action === 'pick-preset') {
      snapshotDrafts();
      const p = presetOf(button.dataset.preset);
      draft.__new__ = Object.assign({}, draft.__new__, {
        preset: p.id,
        baseUrl: p.baseUrl || '',
        rawPerUnit: p.rawPerUnit || 1,
        unitCurrency: p.currency || 'USD',
      });
      delete probeRes.__new__;
      renderMainRaw();
      return;
    }
    if (action === 'fx-mode') {
      snapshotDrafts();
      if (!draft.__settings__) draft.__settings__ = {};
      draft.__settings__.fxAuto = button.dataset.mode === 'auto';
      renderMainRaw();
      return;
    }
    if (action === 'toggle-notify') {
      snapshotDrafts();
      if (!draft.__notify__) draft.__notify__ = {};
      const field = button.dataset.channel + 'Enabled';
      const current = hasOwn(draft.__notify__, field)
        ? draft.__notify__[field] : DATA.settings.notify?.channels?.[button.dataset.channel]?.enabled === true;
      draft.__notify__[field] = !current;
      renderMainRaw();
      return;
    }
    if (action === 'export') {
      if (androidStandalone && window.AndroidStandalone && window.AndroidApp?.saveExport) {
        window.AndroidApp.saveExport(window.AndroidStandalone.exportConfig());
        toast('请选择配置文件保存位置', 'ok');
        return;
      }
      if (window.AndroidApp && typeof window.AndroidApp.downloadExport === 'function') {
        window.AndroidApp.downloadExport();
        toast('配置文件开始下载', 'ok');
        return;
      }
      window.open('/api/export', '_blank', 'noopener');
      return;
    }
    if (action === 'import') {
      root.querySelector('#import-file')?.click();
      return;
    }
    if (action === 'clear-alerts') {
      button.disabled = true;
      try {
        const body = await post('/api/alerts/clear', {});
        if (!body.ok) throw new Error(body.error || '清理失败');
        DATA = body.data;
        toast('告警已清空', 'ok');
        renderMainRaw();
      } catch (error) { toast(error.message || '清理失败', 'bad'); }
      return;
    }
    button.disabled = true;
    try {
      if (action === 'refresh') {
        snapshotDrafts();
        busy = true;
        renderMainRaw();
        const body = await post('/api/refresh', {});
        if (!body.ok) throw new Error(body.error || '刷新失败');
        DATA = body.data;
        elapsedMs = body.data.elapsedMs;
        toast('余额已刷新', 'ok');
      } else if (action === 'refresh-station') {
        snapshotDrafts();
        const body = await post('/api/refresh', { id: sid });
        if (!body.ok) throw new Error(body.error || '刷新失败');
        DATA = body.data;
        toast('站点已刷新', 'ok');
      } else if (action === 'probe') {
        const station = stationPayload(sid);
        validateStation(station, sid === '__new__');
        const payload = sid === '__new__'
          ? { station, token: station.token, preset: station.preset === 'relay-auto' ? 'auto' : station.preset }
          : { id: sid, token: station.token || '' };
        const body = await post('/api/probe', payload);
        probeRes[sid] = body;
        toast(body.ok ? '探测成功' : '探测失败', body.ok ? 'ok' : 'bad');
      } else if (action === 'clear-alerts') {
        const body = await post('/api/alerts/clear', {});
        if (!body.ok) throw new Error(body.error || '清理失败');
        DATA = body.data;
        toast('告警已清空', 'ok');
      } else if (action === 'save-station') {
        const station = stationPayload(sid);
        validateStation(station, sid === '__new__');
        const body = await post('/api/station', { station });
        if (!body.ok) throw new Error(body.error || '保存失败');
        DATA = body.data;
        delete draft[sid];
        delete probeRes[sid];
        if (sid === '__new__') {
          settingsView = 'stations';
          newStep = 1;
        } else if (sid === editingStationId) {
          editingStationId = null;
        }
        toast(sid === '__new__' ? '站点已添加' : '站点已保存', 'ok');
      } else if (action === 'activate-license') {
        snapshotDrafts();
        const code = String(draft.__license__?.code || '').trim();
        if (!code) throw new Error('请粘贴激活码');
        const body = await post('/api/license/activate', { code });
        if (!body.ok) throw new Error(body.error || '激活失败');
        DATA = body.data;
        delete draft.__license__;
        toast('完整功能已激活', 'ok');
      } else if (action === 'del-station') {
        const station = DATA.stations.find((item) => item.id === sid);
        if (!window.confirm('确定删除“' + (station?.name || '这个站点') + '”吗？此操作不可撤销。')) return;
        const body = await request('/api/station?id=' + encodeURIComponent(sid), { method: 'DELETE' });
        if (!body.ok) throw new Error(body.error || '删除失败');
        DATA = body.data;
        delete draft[sid];
        delete probeRes[sid];
        if (sid === editingStationId) editingStationId = null;
        toast('站点已删除', 'ok');
      } else if (action === 'toggle-station') {
        snapshotDrafts();
        const station = DATA.stations.find((item) => item.id === sid);
        const body = await post('/api/station', { station: { id: sid, enabled: !station.enabled } });
        if (!body.ok) throw new Error(body.error || '切换失败');
        DATA = body.data;
        toast(station.enabled ? '站点已停用' : '站点已启用', 'ok');
      } else if (action === 'save-settings') {
        snapshotDrafts();
        const values = draft.__settings__ || {};
        const fxAuto = hasOwn(values, 'fxAuto') ? values.fxAuto : DATA.settings.fx.auto !== false;
        const payload = {
          refreshMinutes: values.refreshMinutes,
          timeoutMs: Number(values.timeoutSeconds || 12) * 1000,
          thresholdDefaultUsd: values.thresholdDefaultUsd,
          fx: fxAuto ? { auto: true } : { auto: false, rate: values.fxRate },
          refreshFx: fxAuto,
        };
        const body = await post('/api/settings', payload);
        if (!body.ok) throw new Error(body.error || '设置保存失败');
        DATA = body.data;
        delete draft.__settings__;
        toast('设置已保存', 'ok');
      } else if (action === 'save-notify' || action === 'test-notify') {
        snapshotDrafts();
        const body = await post('/api/settings', { notify: notificationPayload() });
        if (!body.ok) throw new Error(body.error || '推送设置保存失败');
        DATA = body.data;
        delete draft.__notify__;
        if (action === 'test-notify') {
          const tested = await post('/api/notify/test', { type: button.dataset.channel });
          if (!tested.ok) throw new Error(tested.error || '测试推送失败');
          toast('测试推送已发送', 'ok');
        } else {
          toast('推送设置已保存', 'ok');
        }
      } else if (action === 'save-update-settings') {
        snapshotDrafts();
        const body = await post('/api/settings', { proxy: { url: draft.__update__?.proxyUrl || '', mirrorUrl: draft.__update__?.mirrorUrl || '' } });
        if (!body.ok) throw new Error(body.error || '代理设置保存失败');
        DATA = body.data;
        draft.__update__ = { proxyUrl: DATA.settings.proxy?.url || '', mirrorUrl: DATA.settings.proxy?.mirrorUrl || '' };
        toast('更新连接设置已保存', 'ok');
        checkVersionOnOpen();
      } else if (action === 'update-confirm') {
        updateConfirmOpen = false;
        snapshotDrafts();
        const body = updateMethod === 'local'
          ? await uploadUpdate(localUpdateFile)
          : await post('/api/update', { proxyUrl: draft.__update__?.proxyUrl || '', mirrorUrl: draft.__update__?.mirrorUrl || '', source: updateMethod });
        if (!body.ok) throw new Error(body.error || '更新请求失败');
        localUpdateFile = null;
        if (DATA) DATA.settings.update = body.data;
        toast('更新任务已提交，服务会自动重启', 'ok');
        watchUpdate();
      }
    } catch (error) {
      toast(error.message || '操作失败', 'bad');
    } finally {
      if (action === 'refresh') { busy = false; if(DATA) loadOverviewUsage(DATA.stations || []); }
      if (DATA) renderMainRaw();
      if (action === 'update-confirm') window.setTimeout(restoreModalFocus, 0);
      if (button.isConnected) button.disabled = false;
    }
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act]');
    if (!button || !root.contains(button) || button.tagName === 'SELECT') return;
    handleAction(button);
  });

  root.addEventListener('keydown', (event) => {
    const modal = root.querySelector('.app-modal');
    if (event.key === 'Tab' && modal) {
      const focusable = [...modal.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])')];
      if (focusable.length) {
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    if (event.key === 'Escape' && (updateConfirmOpen || feedbackOpen || purchaseModal)) {
      updateConfirmOpen = false;
      feedbackOpen = false;
      purchaseModal = '';
      renderMainRaw();
      window.setTimeout(restoreModalFocus, 0);
      return;
    }
  });

  root.addEventListener('change', async (event) => {
    const updateFile = event.target.closest('#local-update-file');
    if (updateFile && updateFile.files && updateFile.files[0]) {
      const selected = updateFile.files[0];
      if (!/\.bundle$/i.test(selected.name)) { toast('请选择 .bundle 更新包', 'bad'); updateFile.value = ''; return; }
      if (selected.size > 100 * 1024 * 1024) { toast('更新包不能超过 100 MB', 'bad'); updateFile.value = ''; return; }
      localUpdateFile = selected;
      updateMethod = 'local';
      updateConfirmOpen = true;
      modalReturnAction = 'choose-local-update';
      renderMainRaw();
      window.setTimeout(() => root.querySelector('[data-act="update-confirm"]')?.focus(), 0);
      return;
    }
    const file = event.target.closest('#import-file');
    if (file && file.files && file.files[0]) {
      try {
        const data = JSON.parse(await file.files[0].text());
        if (!window.confirm('导入配置将合并站点，是否继续？')) return;
        const body = await post('/api/import', { data, replace: false });
        if (!body.ok) throw new Error(body.error || '导入失败');
        DATA = body.data;
        toast('配置已导入', 'ok');
        renderMainRaw();
      } catch (error) { toast(error.message || '配置文件格式不正确', 'bad'); }
      file.value = '';
      return;
    }
    const usageStation = event.target.closest('[data-act="overview-usage-station"]');
    if (usageStation) {
      overviewUsageStation = usageStation.value || 'all';
      renderMainRaw();
      return;
    }
    const overviewRange = event.target.closest('[data-act="overview-usage-range"]');
    if (overviewRange) {
      overviewUsageRange = overviewRange.dataset.range || 'today';
      restoreOverviewUsage(DATA.stations || [], overviewUsageRange);
      loadOverviewUsage(DATA.stations || [], { explicit: true });
      return;
    }
    const docsJump = event.target.closest('[data-act="docs-jump"]');
    if (docsJump) {
      const target = root.querySelector('#' + CSS.escape(docsJump.value));
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const filter = event.target.closest('[data-act="filter-tag"]');
    if (filter) {
      stationFilter = filter.value || 'all';
      renderMainRaw();
      return;
    }
    const sort = event.target.closest('[data-act="sort-stations"]');
    if (sort) {
      stationSort = sort.value || 'default';
      renderMainRaw();
      return;
    }
    const field = event.target.closest('[data-field="preset"],[data-field="requestMethod"],[data-field="authMode"],[data-field="usageRequestMethod"],[data-field="usageAuthMode"]');
    if (!field) return;
    snapshotDrafts();
    if (field.dataset.field === 'preset') {
      const preset = presetOf(field.value);
      draft[field.dataset.sid].rawPerUnit = preset.rawPerUnit || 1;
      draft[field.dataset.sid].unitCurrency = preset.currency || 'USD';
    }
    delete probeRes[field.dataset.sid];
    renderMainRaw();
  });

  systemTheme.addEventListener('change', (event) => {
    if (themeMode !== 'system') return;
    darkMode = event.matches;
    applyTheme();
    if (DATA) renderMainRaw();
  });

  window.addEventListener('api-balance-state-changed', async () => {
    if (!androidStandalone || !DATA) return;
    try {
      const body = await request('/api/state');
      if (body.ok) {
        DATA = body.data;
        renderMainRaw();
        loadOverviewUsage(DATA.stations || []);
      }
    } catch (error) { /* 下一次刷新继续尝试 */ }
  });

  window.addEventListener('api-balance-download', (event) => {
    const detail = event.detail || {};
    const previous = androidDownload?.state;
    androidDownload = {
      state: String(detail.state || 'queued'),
      progress: Number(detail.progress),
      downloaded: Number(detail.downloaded) || 0,
      total: Number(detail.total) || 0,
      message: String(detail.message || '正在下载安装包'),
    };
    if (DATA) renderMainRaw();
    if (androidDownload.state === 'failed' && previous !== 'failed') toast(androidDownload.message, 'bad');
    if (androidDownload.state === 'completed' && previous !== 'completed') toast('下载完成，正在打开系统安装器', 'ok');
  });

  bootstrap();
})();

/* 首页全部中转站统计可视化 */
