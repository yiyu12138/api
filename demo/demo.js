'use strict';

(() => {
  document.documentElement.classList.add('demo');
  document.title = 'API Balance 在线演示';

  const now = Date.now();
  const rate = 6.73;
  const station = (id, name, balance, currency, used, total, ms, tag) => ({
    id, name, baseUrl: 'https://example.invalid', preset: 'relay-auto', hasToken: true,
    tokenMask: 'sk-••••demo', queryPath: '', quotaPath: '', subtractPath: '', usedPath: '', totalPath: '', planPath: '',
    requestMethod: 'GET', requestBody: '', authMode: 'bearer', authQueryParam: 'key', rawPerUnit: 1,
    unitCurrency: currency, tag, thresholdUsd: 10, effectiveThresholdUsd: 10, extraHeaders: {}, extraHeaderKeys: [],
    enabled: true, failCount: 0, queryMode: 'auto', usageEndpoint: '/v1/usage', usageRequestMethod: 'GET',
    usageRequestBody: '', usageAuthMode: 'bearer', usageAuthQueryParam: 'key', usageMap: '{}',
    history: [5, 4, 3, 2, 1, 0].map((offset) => ({ t: now - offset * 3600000, v: (currency === 'CNY' ? balance / rate : balance) + offset * 0.08 })),
    last: {
      ok: true, at: now, ms, mode: 'demo', kind: 'balance', currency, balance, used, total,
      requests: id === 'demo-alpha' ? 128 : 96, group: '虚拟演示', extra: {}, note: '', balanceAvailable: true,
      balanceUsd: currency === 'CNY' ? balance / rate : balance, stale: false, error: null,
    },
  });

  const stations = [
    station('demo-alpha', '示例中转 A', 23.45, 'USD', 6.55, 30, 238, '虚拟'),
    station('demo-beta', '示例中转 B', 66.60, 'CNY', 33.40, 100, 356, '虚拟'),
  ];
  const emptyChannels = {
    bark: { enabled: false, urlConfigured: false, urlMask: '' },
    serverChan: { enabled: false, sendKeyConfigured: false, sendKeyMask: '' },
    pushPlus: { enabled: false, tokenConfigured: false, tokenMask: '' },
    telegram: { enabled: false, botTokenConfigured: false, botTokenMask: '', chatIdConfigured: false, chatIdMask: '' },
    webhook: { enabled: false, urlConfigured: false, urlMask: '' },
  };
  const state = {
    version: '1.16.6', stations,
    summary: { totalUsd: stations.reduce((sum, item) => sum + item.last.balanceUsd, 0), normal: 1, low: 1, failed: 0, unknown: 0, count: 2 },
    settings: {
      refreshMinutes: 30, timeoutMs: 12000, thresholdDefaultUsd: 10,
      fx: { auto: true, rate, updatedAt: now, source: 'demo' },
      notify: { pushTime: '09:00', channels: emptyChannels }, proxy: { url: '', mirrorUrl: '' }, alerts: [],
      license: { active: true, status: 'active', installId: 'demo-install', stationLimit: null, contactEmail: 'avhlune@gmail.com', licenseId: 'DEMO' },
      update: { state: 'idle', message: '演示站不会执行程序更新', commit: '', at: now },
    },
    lastRefreshAt: now,
  };

  const usage = (id, range) => {
    const factor = { today: 1, yesterday: 0.82, '7d': 5.6, '30d': 19.4 }[range] || 1;
    const sole = id === 'demo-beta';
    const cost = (sole ? 0.1836 : 0.4268) * factor;
    const requests = Math.round((sole ? 51 : 74) * factor);
    const inputTokens = Math.round((sole ? 432100 : 825400) * factor);
    const outputTokens = Math.round((sole ? 20900 : 42600) * factor);
    const day = (offset) => new Date(now - offset * 86400000).toISOString().slice(0, 10);
    return {
      detail: true, complete: true, requestDetail: true, fetchedAt: now, fetchedRecords: requests,
      today: { cost, requests, inputTokens, outputTokens, cacheReadTokens: Math.round(inputTokens * 1.8), cacheWriteTokens: 0 },
      trend: [6, 5, 4, 3, 2, 1, 0].map((offset, index) => ({ date: day(offset), cost: Number((cost * (0.08 + index * 0.02)).toFixed(4)) })),
      models: [
        { model: 'gpt-5.6-luna', requests: Math.round(requests * 0.72), inputTokens: Math.round(inputTokens * 0.7), outputTokens: Math.round(outputTokens * 0.7), cost: cost * 0.7 },
        { model: 'gpt-5.6-terra', requests: Math.round(requests * 0.28), inputTokens: Math.round(inputTokens * 0.3), outputTokens: Math.round(outputTokens * 0.3), cost: cost * 0.3 },
      ],
      logs: [0, 1, 2].map((offset) => ({ created_at: new Date(now - offset * 1800000).toISOString(), model: offset ? 'gpt-5.6-terra' : 'gpt-5.6-luna', input_tokens: 8200 + offset * 900, output_tokens: 430 + offset * 70, cost_usd: 0.013 + offset * 0.004 })),
    };
  };

  const presets = window.APIBalanceProviders.PRESETS;

  const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  }));
  const nativeFetch = window.fetch.bind(window);
  const nativeOpen = window.open.bind(window);
  window.fetch = (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return nativeFetch(input, options);
    if (url.pathname === '/api/bootstrap') return json({ ok: true, presets, version: state.version });
    if (url.pathname === '/api/state') return json({ ok: true, data: state });
    if (url.pathname === '/api/version') return json({ ok: true, data: { current: state.version, latest: state.version, updateAvailable: false, source: '演示数据', details: [], checkedAt: now } });
    if (url.pathname === '/api/usage') return json({ ok: true, data: usage(url.searchParams.get('id'), url.searchParams.get('range') || 'today') });
    if (url.pathname === '/api/update' && (!options.method || options.method === 'GET')) return json({ ok: true, data: state.settings.update });
    if (url.pathname.startsWith('/api/update')) return json({ ok: false, error: '在线演示不会执行程序更新' }, 400);
    if (url.pathname === '/api/probe') return json({ ok: false, error: '在线演示不会请求真实站点' });
    return json({ ok: true, data: { ...state, elapsedMs: 180 } });
  };
  window.open = (url, ...args) => {
    if (String(url).startsWith('/api/export')) {
      const href = URL.createObjectURL(new Blob([JSON.stringify({ demo: true, stations }, null, 2)], { type: 'application/json' }));
      const link = Object.assign(document.createElement('a'), { href, download: 'api-balance-demo.json' });
      link.click();
      setTimeout(() => URL.revokeObjectURL(href));
      return null;
    }
    return nativeOpen(url, ...args);
  };
})();
