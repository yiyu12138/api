'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fromOpenAI, query, queryUsage, aggregateUsage } = require('./probe');
const { getPreset } = require('./providers');

test('停用的硅基流动余额接口不会再被请求', () => {
  const preset = getPreset('siliconflow');
  assert.equal(preset.kind, 'connectivity');
  assert.equal(preset.balanceAvailable, false);
  assert.equal(preset.path, undefined);
  assert.deepEqual(preset.testPaths, ['/v1/models']);
});

test('Sole Credits stay in CNY after all period and model costs are displayed', async (t) => {
  const period = { requests: 12, promptTokens: 545500, completionTokens: 4201, totalTokens: 549701, cost: 0.238003, topModels: [{ modelName: 'gpt-test', cost: 0.191 }] };
  const response = { periods: { today: period, yesterday: period, last7d: period, last30d: period, missing: { cost: null } } };
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://soleapi.com/v1/usage');
    return { status: 200, ok: true, text: async () => JSON.stringify(response) };
  });
  for (const rate of [6.7156, 7.2]) {
    const usage = await queryUsage({ baseUrl: 'https://soleapi.com/v1/usage' }, 'test-key', rate);
    for (const range of ['today', 'yesterday', '7d', '30d']) {
      const result = aggregateUsage(usage, range);
      assert.ok(Math.abs(result.today.cost * rate - 0.238003) < 1e-10);
      assert.ok(Math.abs(result.models[0].cost * rate - 0.191) < 1e-10);
      assert.equal(result.today.outputTokens, 4201);
      assert.equal(result.today.requests, 12);
    }
    assert.equal(usage.periods.missing.cost, null);
    assert.equal(usage.summary.periods.today.cost, 0.238003);
    assert.equal(usage.timezone, 'Asia/Shanghai');
  }
});

test('OpenAI 无限额度占位值不作为真实余额', () => {
  const result = fromOpenAI({ hard_limit_usd: 100000000 }, { total_usage: 0 });
  assert.equal(result.balance, null);
  assert.equal(result.balanceAvailable, false);
});

test('普通 OpenAI 额度仍按余额解析', () => {
  const result = fromOpenAI({ hard_limit_usd: 10 }, { total_usage: 125 });
  assert.equal(result.balance, 8.75);
  assert.equal(result.balanceAvailable, true);
});

test('NewAPI 查询发送用户 ID 并读取真实余额', async (t) => {
  let userId = '';
  const server = http.createServer((req, res) => {
    userId = req.headers['new-api-user'];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { quota: 500000, used_quota: 0 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const result = await query({
    preset: 'relay-auto',
    baseUrl: 'http://127.0.0.1:' + server.address().port,
    rawPerUnit: 500000,
    extraHeaders: { 'New-Api-User': '277789' },
  }, 'system-token');

  assert.equal(userId, '277789');
  assert.equal(result.balance, 1);
});

test('自定义计费接口支持完整 URL 和 JSON 字段路径', async (t) => {
  let request = {};
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      request = { method: req.method, apiKey: req.headers['x-api-key'], body: Buffer.concat(chunks).toString() };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { available_usd: 12.5, used_usd: 3.2, total_usd: 15.7, plan: '生产环境' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/v1/key/quota';

  const result = await query({
    preset: 'custom', baseUrl: 'https://unused.example', queryPath: endpoint,
    requestMethod: 'POST', requestBody: '{"token":"{{apiKey}}"}', authMode: 'x-api-key',
    quotaPath: 'data.available_usd', usedPath: 'data.used_usd',
    totalPath: 'data.total_usd', planPath: 'data.plan', rawPerUnit: 1, unitCurrency: 'USD',
  }, 'api-key');

  assert.deepEqual(request, { method: 'POST', apiKey: 'api-key', body: '{"token":"api-key"}' });
  assert.equal(result.balance, 12.5);
  assert.equal(result.used, 3.2);
  assert.equal(result.total, 15.7);
  assert.equal(result.group, '生产环境');
  assert.equal(result.currency, 'USD');
});

test('自定义周期汇总接口按字段映射生成用量', async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer api-key');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      remaining: 408.6, used: 85.4, total: 494, unit: 'Credits', timezone: 'Asia/Tokyo',
      periods: { today: { requests: 12, promptTokens: 100, completionTokens: 20, totalTokens: 120, cost: 1.25, topModels: [{ modelName: 'gpt-test', requests: 12, totalTokens: 120, cost: 1.25 }] } },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const mapping = {
    summary: { remaining: 'remaining', used: 'used', total: 'total', unit: 'unit' }, timezone: 'timezone',
    costCurrency: 'CNY', costDivisor: 10,
    periods: { today: 'periods.today' },
    metrics: { requests: 'requests', inputTokens: 'promptTokens', outputTokens: 'completionTokens', totalTokens: 'totalTokens', cost: 'cost', models: 'topModels' },
    model: { name: 'modelName', requests: 'requests', tokens: 'totalTokens', cost: 'cost' },
  };
  const usage = await queryUsage({
    baseUrl: 'http://127.0.0.1:' + server.address().port,
    usageEndpoint: '/v1/usage', usageAuthMode: 'bearer', usageMap: JSON.stringify(mapping),
  }, 'api-key', 5);
  const today = aggregateUsage(usage, 'today');
  assert.equal(today.summary.remaining, 408.6);
  assert.equal(today.today.requests, 12);
  assert.equal(today.today.inputTokens, 100);
  assert.equal(today.today.cost, 0.025);
  assert.deepEqual(today.models[0], { model: 'gpt-test', requests: 12, cost: 0.025, inputTokens: null, outputTokens: 120, successRate: null });
  assert.equal(today.requestDetail, false);
});
