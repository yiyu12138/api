'use strict';

function securityHeaders(mode) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors " + (mode === 'fnos' ? 'http: https:' : "'none'") + "; base-uri 'self'; form-action 'self'",
  };
  if (mode !== 'fnos') headers['X-Frame-Options'] = 'DENY';
  return headers;
}

module.exports = { securityHeaders };
