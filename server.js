'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { loadEnv } = require('./lib/env');

loadEnv();

const { vibeFetch, authFromReq, summarizeMe, apiKey } = require('./lib/vibe');
const { sendApiError } = require('./lib/errors');
const { loadDashboard } = require('./lib/dashboard');
const { parseCookies, cookieHeader } = require('./lib/cookies');

const PORT = Number(process.env.PORT || 3000);
const VIBE_URL = process.env.VIBE_API_BASE || 'https://vibecode.bitrix24.tech';
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function publicOrigin(req) {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = (forwarded ? String(forwarded).split(',')[0] : req.protocol) || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

function callbackUri(req) {
  return `${publicOrigin(req)}/auth/callback`;
}

function sessionAuth(req) {
  const header = authFromReq(req);
  if (header) return header;
  const token = parseCookies(req).vibe_session;
  if (!token) return undefined;
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/', (req, res) => {
  if (req.query.code && !req.query.state) {
    const next = new URL('/auth/callback', publicOrigin(req));
    next.searchParams.set('code', String(req.query.code));
    if (req.query.state) next.searchParams.set('state', String(req.query.state));
    return res.redirect(next.toString());
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/auth/login', (req, res) => {
  const key = apiKey();
  if (!key) {
    return res.status(500).send('Не задан VIBECODE_API_KEY');
  }
  const state = crypto.randomBytes(24).toString('hex');
  res.setHeader(
    'Set-Cookie',
    cookieHeader('oauth_state', state, { maxAge: 600, httpOnly: true, sameSite: 'Lax' }),
  );
  const url = new URL(`${VIBE_URL}/v1/oauth/authorize`);
  url.searchParams.set('app_key', key);
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', callbackUri(req));
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (req.query.error) {
      return res.redirect(`/?auth_error=${encodeURIComponent(String(req.query.error))}`);
    }
    const code = req.query.code ? String(req.query.code) : '';
    const state = req.query.state ? String(req.query.state) : '';
    const expected = parseCookies(req).oauth_state;
    if (!code || !state || !expected || state !== expected) {
      return res.redirect('/?auth_error=invalid_state');
    }
    const json = await vibeFetch('/v1/oauth/token', {
      method: 'POST',
      body: {
        app_key: apiKey(),
        code,
        redirect_uri: callbackUri(req),
      },
    });
    const token = json.access_token || json.data?.access_token;
    if (!token) {
      return res.redirect('/?auth_error=no_token');
    }
    const secure = publicOrigin(req).startsWith('https://');
    res.setHeader('Set-Cookie', [
      cookieHeader('vibe_session', token, {
        maxAge: 60 * 60 * 24,
        httpOnly: true,
        sameSite: secure ? 'None' : 'Lax',
        secure,
      }),
      cookieHeader('oauth_state', '', { maxAge: 0, httpOnly: true }),
    ]);
    res.redirect('/');
  } catch (err) {
    const code = err.code || 'auth_failed';
    res.redirect(`/?auth_error=${encodeURIComponent(code)}`);
  }
});

app.post('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', cookieHeader('vibe_session', '', { maxAge: 0, httpOnly: true }));
  res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
  try {
    const json = await vibeFetch('/v1/me', { authorization: sessionAuth(req) });
    res.json({ success: true, data: summarizeMe(json) });
  } catch (err) {
    sendApiError(res, err);
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const data = await loadDashboard(req.query, sessionAuth(req));
    res.json({ success: true, data });
  } catch (err) {
    sendApiError(res, err);
  }
});

app.use((err, _req, res, _next) => {
  sendApiError(res, err);
});

app.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`funnel-dashboard listening on ${PORT}\n`);
});
