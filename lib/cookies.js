'use strict';

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    try {
      out[name] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[name] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function cookieHeader(name, value, { maxAge, httpOnly = true, sameSite = 'Lax', secure = false, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (httpOnly) parts.push('HttpOnly');
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

module.exports = { parseCookies, cookieHeader };
