'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { channelRequest, send } = require('./notify');

test('推送渠道生成各自要求的请求', () => {
  const bark = channelRequest('bark', { url: 'https://api.day.app/key' }, '标题', '内容');
  assert.match(bark.url, /api\.day\.app\/key\//);

  const serverChan = channelRequest('serverChan', { sendKey: 'SCT-key' }, '标题', '内容');
  assert.equal(serverChan.options.method, 'POST');
  assert.match(serverChan.url, /SCT-key\.send$/);

  const pushPlus = channelRequest('pushPlus', { token: 'token' }, '标题', '内容');
  assert.deepEqual(JSON.parse(pushPlus.options.body), { token: 'token', title: '标题', content: '内容', template: 'txt' });

  const telegram = channelRequest('telegram', { botToken: 'bot', chatId: '123' }, '标题', '内容');
  assert.deepEqual(JSON.parse(telegram.options.body), { chat_id: '123', text: '标题\n内容' });

  const webhook = channelRequest('webhook', { url: 'https://example.com/hook' }, '标题', '内容');
  assert.equal(JSON.parse(webhook.options.body).source, 'API Balance');
});

test('推送服务拒绝非 HTTP 地址', async () => {
  await assert.rejects(() => send('webhook', { url: 'file:///tmp/hook' }, '标题', '内容'), /仅支持 HTTP/);
});
