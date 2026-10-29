#!/usr/bin/env node
/**
 * Server-side proxy for the Meta API.
 *
 * WHY THIS EXISTS
 * Vite inlines every VITE_* variable into the browser bundle, so a real Meta API key placed
 * in VITE_META_API_KEY would be readable by anyone who loads the page. This proxy keeps the
 * key on the server and exposes only the two routes the HUD needs. The browser talks to
 * localhost (or a deployed proxy) with no credential at all.
 *
 *   META_API_KEY=... node harness/proxy-server.mjs
 *
 * Routes (same shapes the mock server implements, so nothing in the client changes):
 *   POST /sam-3.1/segment
 *   POST /muse-audio/transcribe
 *   GET  /health
 *   GET  /__usage        spent-vs-cap counter
 *
 * Cost guard: MAX_PAID_CALLS (default 60) is a hard ceiling. Once reached the proxy returns
 * 429 and refuses to forward, so a runaway loop cannot drain the credit budget.
 *
 * Point it at the mock server instead of Meta for a full end-to-end rehearsal:
 *   UPSTREAM_BASE=http://127.0.0.1:8787 META_API_KEY=local-test-token node harness/proxy-server.mjs
 */

import { createServer } from 'node:http';

const PORT  = Number(process.env.PROXY_PORT || 8790);
const HOST  = process.env.PROXY_HOST || '127.0.0.1';

// Either real Meta URLs, or a single upstream base for rehearsal against the mock server.
const UPSTREAM_BASE = process.env.UPSTREAM_BASE || null;
const SAM_URL  = process.env.META_SAM_URL  || (UPSTREAM_BASE ? `${UPSTREAM_BASE}/sam-3.1/segment`       : '');
const MUSE_URL = process.env.META_MUSE_URL || (UPSTREAM_BASE ? `${UPSTREAM_BASE}/muse-audio/transcribe` : '');

const API_KEY = process.env.META_API_KEY || '';
const MAX_PAID_CALLS = Number(process.env.MAX_PAID_CALLS || 60);

// Only these origins may call the proxy. The page is served from 8099 in dev.
const ALLOWED_ORIGINS = (process.env.PROXY_ALLOWED_ORIGINS ||
  'http://127.0.0.1:8099,http://localhost:8099,http://127.0.0.1:5173,http://localhost:5173').split(',');

let paidCalls = 0;

function corsFor(req) {
  const origin = req.headers.origin || '';
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(req, res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...corsFor(req),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const log = (m) => console.log(`[proxy] ${new Date().toISOString().slice(11, 23)}  ${m}`);

if (!API_KEY) {
  console.error('[proxy] FATAL: META_API_KEY is not set. The key belongs here, never in VITE_*.');
  process.exit(1);
}
if (!SAM_URL || !MUSE_URL) {
  console.error('[proxy] FATAL: set META_SAM_URL/META_MUSE_URL, or UPSTREAM_BASE for rehearsal.');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsFor(req));
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    json(req, res, 200, {
      status: 'ok',
      service: 'linecheck-meta-proxy',
      upstream: { sam: SAM_URL.replace(/\/\/.*@/, '//'), muse: MUSE_URL.replace(/\/\/.*@/, '//') },
      paidCalls,
      maxPaidCalls: MAX_PAID_CALLS,
      keyConfigured: true,
    });
    return;
  }

  if (url.pathname === '/__usage') {
    json(req, res, 200, { paidCalls, maxPaidCalls: MAX_PAID_CALLS, remaining: Math.max(0, MAX_PAID_CALLS - paidCalls) });
    return;
  }

  const target = url.pathname === '/sam-3.1/segment' ? SAM_URL
               : url.pathname === '/muse-audio/transcribe' ? MUSE_URL
               : null;

  if (req.method !== 'POST' || !target) {
    json(req, res, 404, { error: 'not_found', path: url.pathname });
    return;
  }

  // ---- hard cost ceiling ----
  if (paidCalls >= MAX_PAID_CALLS) {
    log(`REFUSED ${url.pathname}: paid-call cap ${MAX_PAID_CALLS} reached`);
    json(req, res, 429, {
      error: 'paid_call_cap_reached',
      message: `Refusing to forward: ${MAX_PAID_CALLS} calls already made. Raise MAX_PAID_CALLS deliberately.`,
      paidCalls,
    });
    return;
  }

  const raw = await readBody(req);
  const ctype = String(req.headers['content-type'] || 'application/json');

  // preserve the query string (so ?simulate=... still works against an upstream mock)
  const upstreamUrl = target + (url.search || '');

  paidCalls += 1;
  log(`#${paidCalls} -> ${url.pathname} (${raw.length}B ${ctype})`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.PROXY_TIMEOUT_MS || 30000));

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        // credential lives here, server-side only
        Authorization: `Bearer ${API_KEY}`,
        ...(ctype.includes('multipart') ? {} : { 'Content-Type': ctype || 'application/json' }),
      },
      body: raw.length ? raw : undefined,
      signal: controller.signal,
    });

    const text = await upstream.text();
    log(`#${paidCalls} <- ${upstream.status} (${text.length}B)`);

    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Content-Length': Buffer.byteLength(text),
      ...corsFor(req),
    });
    res.end(text);
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    log(`#${paidCalls} !! ${aborted ? 'timeout' : err?.message}`);
    json(req, res, aborted ? 504 : 502, {
      error: aborted ? 'upstream_timeout' : 'upstream_unreachable',
      message: String(err?.message ?? err),
    });
  } finally {
    clearTimeout(timer);
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  LineCheck Meta proxy');
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  sam  -> ${SAM_URL}`);
  console.log(`  muse -> ${MUSE_URL}`);
  console.log(`  paid-call cap: ${MAX_PAID_CALLS}`);
  console.log('  key: configured server-side (never in the bundle)');
  console.log('');
});
