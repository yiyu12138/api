'use strict';
/**
 * 汇率：从免费公开接口取 USD → CNY，取不到就沿用上一次的值。
 */
const FX_URL = process.env.FX_URL || 'https://open.er-api.com/v6/latest/USD';
const FALLBACK_URL = 'https://api.exchangerate-api.com/v4/latest/USD';

async function getJson(url, timeout) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout || 8000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRate() {
  const sources = [FX_URL, FALLBACK_URL];
  let lastErr = null;
  for (const url of sources) {
    try {
      const json = await getJson(url, 8000);
      const rate = json && json.rates && json.rates.CNY;
      const n = Number(rate);
      if (Number.isFinite(n) && n > 0.5 && n < 50) {
        return { rate: Number(n.toFixed(4)), source: url.includes('er-api') ? 'exchangerate' : 'fallback' };
      }
      lastErr = new Error('返回的汇率不可用');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('获取汇率失败');
}

module.exports = { fetchRate };
