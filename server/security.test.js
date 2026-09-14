'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { securityHeaders } = require('./security');

test('飞牛桌面可嵌入页面，普通部署继续禁止嵌入', () => {
  const fnos = securityHeaders('fnos');
  const docker = securityHeaders('docker');
  assert.equal(fnos['X-Frame-Options'], undefined);
  assert.match(fnos['Content-Security-Policy'], /frame-ancestors http: https:/);
  assert.equal(docker['X-Frame-Options'], 'DENY');
  assert.match(docker['Content-Security-Policy'], /frame-ancestors 'none'/);
});
