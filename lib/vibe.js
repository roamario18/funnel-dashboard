'use strict';

const BASE = process.env.VIBE_API_BASE || 'https://vibecode.bitrix24.tech';

function apiKey() {
  return process.env.VIBECODE_API_KEY || process.env.VIBE_API_KEY || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authFromReq(req) {
  const vibe = req.headers['x-vibe-authorization'];
  if (typeof vibe === 'string' && vibe.trim()) return vibe.trim();
  const bearer = req.headers.authorization;
  if (typeof bearer === 'string' && /^Bearer\s+vibe_session_/i.test(bearer)) {
    return bearer;
  }
  return undefined;
}

async function vibeFetch(path, { method = 'GET', body, authorization, timeoutMs = 30000 } = {}) {
  const key = apiKey();
  if (!key) {
    const err = new Error('Не задан VIBECODE_API_KEY');
    err.code = 'MISSING_API_KEY';
    err.status = 500;
    throw err;
  }

  const headers = {
    'X-Api-Key': key,
    Accept: 'application/json',
  };
  if (authorization) headers.Authorization = authorization;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let attempt = 0;
  const maxAttempts = 4;
  while (true) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      if (attempt < maxAttempts) {
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      const err = new Error('VibeCode API недоступен');
      err.code = 'BITRIX_UNAVAILABLE';
      err.status = 502;
      err.cause = cause;
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }

    if (res.status === 429 && attempt < maxAttempts) {
      const retryAfter = res.headers.get('Retry-After') || json.error?.retryAfter;
      const waitSec = retryAfter ? Number(retryAfter) : 2 ** (attempt - 1);
      await sleep((Number.isFinite(waitSec) ? Math.min(waitSec, 60) : 1) * 1000);
      continue;
    }

    if (!res.ok || json.success === false) {
      const code = json.error?.code || `HTTP_${res.status}`;
      const message = json.error?.userMessage || json.error?.message || res.statusText || 'Ошибка API';
      const err = new Error(message);
      err.code = code;
      err.status = res.status || 500;
      throw err;
    }

    return json;
  }
}

function summarizeMe(payload) {
  const data = payload.data || {};
  const caps = data.capabilities || {};
  const pick = (group, name) => {
    const slot = caps[group]?.[name];
    if (!slot || typeof slot !== 'object') return undefined;
    return { available: Boolean(slot.available), reason: slot.reason || null };
  };
  const scopes = Array.isArray(data.scopes) ? data.scopes : [];
  return {
    type: data.type || null,
    portal: data.portal || null,
    accessMode: data.accessMode || null,
    scopes,
    warnings: [
      !scopes.includes('crm') && 'Нет скоупа crm — сделки недоступны',
      !scopes.includes('user') && 'Нет скоупа user — имена ответственных недоступны',
      !scopes.includes('placement') && 'Нет скоупа placement — встройка в меню не заработает',
    ].filter(Boolean),
    capabilities: {
      apps: {
        create: pick('apps', 'create'),
        publish: pick('apps', 'publish'),
        bindPlacements: pick('apps', 'bindPlacements'),
      },
      servers: {
        create: pick('servers', 'create'),
        deploy: pick('servers', 'deploy'),
      },
    },
  };
}

module.exports = { vibeFetch, authFromReq, apiKey, summarizeMe };
