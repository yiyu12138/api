'use strict';

const LABELS = {
  bark: 'Bark',
  serverChan: 'Server酱',
  pushPlus: 'PushPlus',
  telegram: 'Telegram',
  webhook: 'Webhook',
};

function buildBarkUrl(base, title, body) {
  const url = new URL(String(base).trim());
  url.pathname = url.pathname.replace(/\/+$/, '') + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(body);
  url.searchParams.set('group', 'API余额');
  url.searchParams.set('level', 'timeSensitive');
  return url.toString();
}

function channelRequest(type, config, title, body) {
  const value = config || {};
  if (type === 'bark') {
    if (!value.url) throw new Error('未配置 Bark 地址');
    return { url: buildBarkUrl(value.url, title, body), options: {} };
  }
  if (type === 'serverChan') {
    if (!value.sendKey) throw new Error('未配置 Server酱 SendKey');
    return {
      url: 'https://sctapi.ftqq.com/' + encodeURIComponent(value.sendKey) + '.send',
      options: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ title, desp: body }).toString() },
    };
  }
  if (type === 'pushPlus') {
    if (!value.token) throw new Error('未配置 PushPlus Token');
    return {
      url: 'https://www.pushplus.plus/send',
      options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: value.token, title, content: body, template: 'txt' }) },
    };
  }
  if (type === 'telegram') {
    if (!value.botToken || !value.chatId) throw new Error('未完整配置 Telegram Bot Token 和 Chat ID');
    return {
      url: 'https://api.telegram.org/bot' + encodeURIComponent(value.botToken) + '/sendMessage',
      options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: value.chatId, text: title + '\n' + body }) },
    };
  }
  if (type === 'webhook') {
    if (!value.url) throw new Error('未配置 Webhook 地址');
    return {
      url: String(value.url).trim(),
      options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body, source: 'API Balance', at: new Date().toISOString() }) },
    };
  }
  throw new Error('不支持的推送渠道');
}

async function send(type, config, title, body, timeout) {
  const request = channelRequest(type, config, title, body);
  const url = new URL(request.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('推送地址仅支持 HTTP 或 HTTPS');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout || 8000);
  try {
    const response = await fetch(url, Object.assign({}, request.options, { signal: controller.signal }));
    const text = await response.text();
    if (!response.ok) throw new Error((LABELS[type] || type) + ' HTTP ' + response.status + ' ' + text.slice(0, 120));
    let json = null;
    try { json = JSON.parse(text); } catch (error) { /* Webhook 可以返回非 JSON */ }
    if (type === 'bark' && json && json.code !== undefined && Number(json.code) !== 200) throw new Error('Bark 返回 ' + text.slice(0, 120));
    if (type === 'serverChan' && json && json.code !== undefined && Number(json.code) !== 0) throw new Error('Server酱返回 ' + text.slice(0, 120));
    if (type === 'pushPlus' && json && json.code !== undefined && Number(json.code) !== 200) throw new Error('PushPlus 返回 ' + text.slice(0, 120));
    if (type === 'telegram' && json && json.ok === false) throw new Error('Telegram 返回 ' + text.slice(0, 120));
    return true;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { LABELS, buildBarkUrl, channelRequest, send };
