#!/usr/bin/env node
/**
 * Server-side proxy for the Meta API, with a persistent USD spend ledger and a
 * content-addressed replay cache.
 *
 * WHY THE PROXY EXISTS
 * Vite inlines every VITE_* value into the browser bundle, so a real Meta API key placed in
 * VITE_META_API_KEY would be readable by anyone who loads the page. This proxy keeps the key
 * on the server and exposes only the routes the HUD needs.
 *
 *   META_API_KEY=... \
 *   META_SAM_URL=... META_MUSE_URL=... META_MUSE_SPARK_URL=... \
 *   node harness/proxy-server.mjs
 *
 * Rehearse the whole chain offline against the mock contracts:
 *
 *   UPSTREAM_BASE=http://127.0.0.1:8787 META_API_KEY=local-test-token \
 *   MAX_SPEND_USD=5 node harness/proxy-server.mjs
 *
 * ---------------------------------------------------------------------------
 * ROUTES
 *   POST /sam-3.1/segment         -> $COST_PER_SAM_CALL_USD     (default 0.05)
 *   POST /muse-audio/transcribe   -> $COST_PER_MUSE_AUDIO_USD    (default 0.02)
 *   POST /muse-spark/dispatch     -> $COST_PER_MUSE_SPARK_USD    (default 0.03)
 *   GET  /health
 *   GET  /__usage        {paidCalls, totalSpendUsd, remainingUsd, cacheHits, ...}
 *
 * ---------------------------------------------------------------------------
 * BUDGET ENFORCEMENT (all three must pass, checked BEFORE the upstream call)
 *   MAX_PAID_CALLS        default 60        hard call count
 *   MAX_SPEND_USD         default 120.00    persistent lifetime ceiling
 *   MAX_SESSION_SPEND_USD default 5.00      ceiling for this process run only
 *
 * The ledger is written to .cache/spend-ledger.json (gitignored) so a restart does not reset
 * what has already been spent. Rejections are HTTP 429 with a reason, before any network call.
 *
 * CHARGE SEMANTICS (deliberately conservative and explicit)
 *   The next call's cost is RESERVED in the ledger before the upstream request, so a crash
 *   mid-flight still counts it. If the upstream returns a non-2xx or is unreachable, the
 *   reservation is REFUNDED and the event is logged as `refundedUsd` - otherwise a single
 *   misconfigured URL would silently burn the whole budget on 401s. Both the charge and any
 *   refund are recorded, so the ledger never quietly under-reports.
 *
 * ---------------------------------------------------------------------------
 * REPLAY CACHE (content-addressed)
 *   PROXY_CACHE_MODE = record-or-replay (default) | record-only | off
 *   Requests are hashed (SHA-256 over route + request body) into .cache/replay/<hash>.json.
 *   On a hit in record-or-replay mode the stored response is served at $0.00, no upstream call
 *   is made, and cacheHits is incremented. A successful live response is written back, so a
 *   unique frame or voice command is only ever paid for once.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- configuration
const PORT = Number(process.env.PROXY_PORT || 8790);
const HOST = process.env.PROXY_HOST || '127.0.0.1';

const UPSTREAM_BASE = process.env.UPSTREAM_BASE || null;
const SAM_URL  = process.env.META_SAM_URL  || (UPSTREAM_BASE ? `${UPSTREAM_BASE}/sam-3.1/segment`       : '');
const MUSE_URL = process.env.META_MUSE_URL || (UPSTREAM_BASE ? `${UPSTREAM_BASE}/muse-audio/transcribe` : '');
const SPARK_URL = process.env.META_MUSE_SPARK_URL || (UPSTREAM_BASE ? `${UPSTREAM_BASE}/muse-spark/dispatch` : '');

const API_KEY = process.env.META_API_KEY || '';

const COST = {
  sam:   Number(process.env.COST_PER_SAM_CALL_USD   ?? 0.05),
  muse:  Number(process.env.COST_PER_MUSE_AUDIO_USD ?? 0.02),
  spark: Number(process.env.COST_PER_MUSE_SPARK_USD ?? 0.03),
};

const MAX_PAID_CALLS        = Number(process.env.MAX_PAID_CALLS ?? 60);
const MAX_SPEND_USD         = Number(process.env.MAX_SPEND_USD ?? 120.0);
const MAX_SESSION_SPEND_USD = Number(process.env.MAX_SESSION_SPEND_USD ?? 5.0);

const CACHE_MODE = process.env.PROXY_CACHE_MODE || 'record-or-replay';
const CACHE_DIR  = process.env.PROXY_CACHE_DIR || '.cache/replay';
const LEDGER_PATH = process.env.PROXY_LEDGER_PATH || '.cache/spend-ledger.json';

const ALLOWED_ORIGINS = (process.env.PROXY_ALLOWED_ORIGINS ||
  'http://127.0.0.1:8099,http://localhost:8099,http://127.0.0.1:5173,http://localhost:5173').split(',');

const ROUTES = {
  '/sam-3.1/segment':       { upstream: SAM_URL,   cost: COST.sam,   key: 'sam'   },
  '/muse-audio/transcribe': { upstream: MUSE_URL,  cost: COST.muse,  key: 'muse'  },
  '/muse-spark/dispatch':   { upstream: SPARK_URL, cost: COST.spark, key: 'spark' },
};

// ---------------------------------------------------------------- ledger (persistent)
const emptyLedger = () => ({
  version: 1,
  totalSpendUsd: 0,
  paidCalls: 0,
  cacheHits: 0,
  failedCalls: 0,
  refundedUsd: 0,
  byRoute: {
    sam:   { calls: 0, spendUsd: 0 },
    muse:  { calls: 0, spendUsd: 0 },
    spark: { calls: 0, spendUsd: 0 },
  },
  createdAtUtc: new Date().toISOString(),
  updatedAtUtc: new Date().toISOString(),
});

function loadLedger() {
  try {
    if (!existsSync(LEDGER_PATH)) return emptyLedger();
    const parsed = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
    const base = emptyLedger();
    return {
      ...base,
      ...parsed,
      byRoute: { ...base.byRoute, ...(parsed.byRoute || {}) },
    };
  } catch (err) {
    console.error(`[proxy] WARN: ledger unreadable (${err.message}); starting a fresh one at ${LEDGER_PATH}`);
    return emptyLedger();
  }
}

let ledger = loadLedger();

/** in-process ceiling: resets on restart, by design (a "test run" budget) */
let sessionSpendUsd = 0;

const round6 = (n) => Math.round(n * 1e6) / 1e6;

function saveLedger() {
  ledger.updatedAtUtc = new Date().toISOString();
  try {
    mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    const tmp = `${LEDGER_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    renameSync(tmp, LEDGER_PATH); // atomic on the same volume
  } catch (err) {
    // never let a ledger write failure silently hide spend
    console.error(`[proxy] ERROR: could not persist ledger (${err.message})`);
  }
}

// ---------------------------------------------------------------- cache
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function cachePath(hash) {
  return path.join(CACHE_DIR, `${hash}.json`);
}

async function readCache(hash) {
  if (CACHE_MODE === 'off') return null;
  try {
    const raw = await fs.readFile(cachePath(hash), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(hash, entry) {
  if (CACHE_MODE === 'off') return;
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const tmp = `${cachePath(hash)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry, null, 2));
    await fs.rename(tmp, cachePath(hash));
  } catch (err) {
    console.error(`[proxy] WARN: cache write failed (${err.message})`);
  }
}

/**
 * Canonicalise a request body for hashing.
 *
 * JSON bodies hash directly. multipart/form-data does NOT: the boundary is randomly generated
 * per request, so hashing the raw bytes makes every audio upload look unique and the replay
 * cache never hits. Instead, hash each part's field name plus its content hash, sorted - that
 * is stable across boundaries while still distinguishing different audio.
 */
function canonicalBody(ctype, raw) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype || '');
  if (!ctype || !ctype.includes('multipart/form-data') || !boundaryMatch) return raw;

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const parts = raw.toString('latin1').split(`--${boundary}`);
  const entries = [];

  for (const part of parts) {
    if (!part.includes('Content-Disposition')) continue;
    const nameMatch = /name="([^"]+)"/i.exec(part);
    const name = nameMatch ? nameMatch[1] : 'part';
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const content = part.slice(split + 4).replace(/\r\n$/, '');
    entries.push([name, sha256(Buffer.from(content, 'latin1'))]);
  }

  if (entries.length === 0) return raw;
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return Buffer.from(JSON.stringify(entries));
}

/** canonical key: route identity + canonicalised request body */
function cacheKeyFor(routeKey, ctype, raw) {
  return sha256(Buffer.concat([
    Buffer.from(`route:${routeKey}\n`),
    canonicalBody(ctype, raw),
  ]));
}

// ---------------------------------------------------------------- http helpers
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

// ---------------------------------------------------------------- boot guards
if (!API_KEY) {
  console.error('[proxy] FATAL: META_API_KEY is not set. The key belongs here, never in VITE_*.');
  process.exit(1);
}
for (const [route, cfg] of Object.entries(ROUTES)) {
  if (!cfg.upstream) {
    console.error(`[proxy] FATAL: no upstream for ${route}. Set its META_*_URL, or UPSTREAM_BASE.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- server
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
      routes: Object.keys(ROUTES),
      spend: {
        totalSpendUsd: round6(ledger.totalSpendUsd),
        remainingUsd: round6(Math.max(0, MAX_SPEND_USD - ledger.totalSpendUsd)),
        sessionSpendUsd: round6(sessionSpendUsd),
        sessionRemainingUsd: round6(Math.max(0, MAX_SESSION_SPEND_USD - sessionSpendUsd)),
      },
      limits: {
        maxPaidCalls: MAX_PAID_CALLS,
        maxSpendUsd: MAX_SPEND_USD,
        maxSessionSpendUsd: MAX_SESSION_SPEND_USD,
        costPerRoute: COST,
      },
      cache: { mode: CACHE_MODE, dir: CACHE_DIR, hits: ledger.cacheHits },
      keyConfigured: true,
    });
    return;
  }

  if (url.pathname === '/__usage') {
    json(req, res, 200, {
      paidCalls: ledger.paidCalls,
      totalSpendUsd: round6(ledger.totalSpendUsd),
      remainingUsd: round6(Math.max(0, MAX_SPEND_USD - ledger.totalSpendUsd)),
      cacheHits: ledger.cacheHits,
      failedCalls: ledger.failedCalls,
      refundedUsd: round6(ledger.refundedUsd),
      sessionSpendUsd: round6(sessionSpendUsd),
      sessionRemainingUsd: round6(Math.max(0, MAX_SESSION_SPEND_USD - sessionSpendUsd)),
      maxPaidCalls: MAX_PAID_CALLS,
      maxSpendUsd: MAX_SPEND_USD,
      maxSessionSpendUsd: MAX_SESSION_SPEND_USD,
      byRoute: ledger.byRoute,
      cacheMode: CACHE_MODE,
      updatedAtUtc: ledger.updatedAtUtc,
    });
    return;
  }

  const route = ROUTES[url.pathname];
  if (req.method !== 'POST' || !route) {
    json(req, res, 404, { error: 'not_found', path: url.pathname });
    return;
  }

  const raw = await readBody(req);
  const ctype = String(req.headers['content-type'] || 'application/json');
  const hash = cacheKeyFor(route.key, ctype, raw);
  const nextCost = route.cost;

  // ---- 1. replay cache: a hit costs nothing and never touches upstream ----
  const cached = await readCache(hash);
  if (cached && CACHE_MODE === 'record-or-replay') {
    ledger.cacheHits += 1;
    saveLedger();
    log(`CACHE HIT ${url.pathname} ${hash.slice(0, 12)} -> $0.00 (${ledger.cacheHits} hits)`);
    res.writeHead(cached.status ?? 200, {
      'Content-Type': cached.contentType || 'application/json',
      'Content-Length': Buffer.byteLength(cached.body),
      'X-Proxy-Cache': 'hit',
      ...corsFor(req),
    });
    res.end(cached.body);
    return;
  }

  // ---- 2. budget gates, all checked before any upstream call ----
  const wouldTotal = ledger.totalSpendUsd + nextCost;
  const wouldSession = sessionSpendUsd + nextCost;

  if (ledger.paidCalls >= MAX_PAID_CALLS) {
    log(`REFUSED ${url.pathname}: call cap ${MAX_PAID_CALLS}`);
    json(req, res, 429, {
      error: 'call_cap_reached',
      message: `Refusing: ${MAX_PAID_CALLS} paid calls already made.`,
      paidCalls: ledger.paidCalls, maxPaidCalls: MAX_PAID_CALLS,
    });
    return;
  }
  if (wouldTotal > MAX_SPEND_USD) {
    log(`REFUSED ${url.pathname}: lifetime budget would exceed $${MAX_SPEND_USD} ($${ledger.totalSpendUsd.toFixed(4)} + $${nextCost})`);
    json(req, res, 429, {
      error: 'budget_exceeded',
      message: `Refusing: next call costs $${nextCost}, which would put lifetime spend at $${round6(wouldTotal)} against a $${MAX_SPEND_USD} ceiling.`,
      totalSpendUsd: round6(ledger.totalSpendUsd),
      remainingUsd: round6(Math.max(0, MAX_SPEND_USD - ledger.totalSpendUsd)),
      nextCallCostUsd: nextCost,
    });
    return;
  }
  if (wouldSession > MAX_SESSION_SPEND_USD) {
    log(`REFUSED ${url.pathname}: session budget would exceed $${MAX_SESSION_SPEND_USD}`);
    json(req, res, 429, {
      error: 'session_budget_exceeded',
      message: `Refusing: next call costs $${nextCost}, which would put this session at $${round6(wouldSession)} against a $${MAX_SESSION_SPEND_USD} ceiling.`,
      sessionSpendUsd: round6(sessionSpendUsd),
      sessionRemainingUsd: round6(Math.max(0, MAX_SESSION_SPEND_USD - sessionSpendUsd)),
      nextCallCostUsd: nextCost,
    });
    return;
  }

  // ---- 3. reserve the cost BEFORE the call so a crash still counts ----
  ledger.paidCalls += 1;
  ledger.totalSpendUsd = round6(ledger.totalSpendUsd + nextCost);
  sessionSpendUsd = round6(sessionSpendUsd + nextCost);
  ledger.byRoute[route.key].calls += 1;
  ledger.byRoute[route.key].spendUsd = round6(ledger.byRoute[route.key].spendUsd + nextCost);
  saveLedger();

  log(`#${ledger.paidCalls} ${url.pathname} $${nextCost.toFixed(2)} (lifetime $${ledger.totalSpendUsd.toFixed(2)}/${MAX_SPEND_USD}, session $${sessionSpendUsd.toFixed(2)}/${MAX_SESSION_SPEND_USD})`);

  const upstreamUrl = route.upstream + (url.search || '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.PROXY_TIMEOUT_MS || 30000));

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`, // credential never leaves the server
        ...(ctype.includes('multipart') ? {} : { 'Content-Type': ctype || 'application/json' }),
      },
      body: raw.length ? raw : undefined,
      signal: controller.signal,
    });

    const text = await upstream.text();
    log(`#${ledger.paidCalls} <- ${upstream.status} (${text.length}B)`);

    if (upstream.status < 200 || upstream.status >= 300) {
      // refund: an outright rejection was almost certainly not billed
      ledger.totalSpendUsd = round6(Math.max(0, ledger.totalSpendUsd - nextCost));
      sessionSpendUsd = round6(Math.max(0, sessionSpendUsd - nextCost));
      ledger.byRoute[route.key].spendUsd = round6(Math.max(0, ledger.byRoute[route.key].spendUsd - nextCost));
      ledger.refundedUsd = round6(ledger.refundedUsd + nextCost);
      ledger.failedCalls += 1;
      saveLedger();
      log(`REFUND ${url.pathname} $${nextCost.toFixed(2)} (upstream ${upstream.status}) -> lifetime $${ledger.totalSpendUsd.toFixed(2)}`);

      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Content-Length': Buffer.byteLength(text),
        'X-Proxy-Cost': 'refunded',
        ...corsFor(req),
      });
      res.end(text);
      return;
    }

    // only successful responses are worth replaying
    await writeCache(hash, {
      hash,
      route: url.pathname,
      status: upstream.status,
      contentType: upstream.headers.get('content-type') || 'application/json',
      body: text,
      costUsd: nextCost,
      recordedAtUtc: new Date().toISOString(),
      upstream: upstreamUrl.replace(/\/\/.*@/, '//'),
    });

    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Content-Length': Buffer.byteLength(text),
      'X-Proxy-Cost': nextCost.toFixed(3),
      'X-Proxy-Cache': cached ? 'miss-recorded' : 'miss',
      ...corsFor(req),
    });
    res.end(text);
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    ledger.totalSpendUsd = round6(Math.max(0, ledger.totalSpendUsd - nextCost));
    sessionSpendUsd = round6(Math.max(0, sessionSpendUsd - nextCost));
    ledger.byRoute[route.key].spendUsd = round6(Math.max(0, ledger.byRoute[route.key].spendUsd - nextCost));
    ledger.refundedUsd = round6(ledger.refundedUsd + nextCost);
    ledger.failedCalls += 1;
    saveLedger();
    log(`REFUND ${url.pathname} (${aborted ? 'timeout' : err?.message}) -> lifetime $${ledger.totalSpendUsd.toFixed(2)}`);
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
  console.log('  LineCheck Meta proxy  (USD ledger + replay cache)');
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  sam   -> ${SAM_URL}   $${COST.sam}`);
  console.log(`  muse  -> ${MUSE_URL}   $${COST.muse}`);
  console.log(`  spark -> ${SPARK_URL}   $${COST.spark}`);
  console.log(`  lifetime: $${ledger.totalSpendUsd.toFixed(2)} / $${MAX_SPEND_USD}   (${ledger.paidCalls} calls, ${ledger.cacheHits} cache hits)`);
  console.log(`  session : $${sessionSpendUsd.toFixed(2)} / $${MAX_SESSION_SPEND_USD}   (resets on restart)`);
  console.log(`  calls   : ${ledger.paidCalls} / ${MAX_PAID_CALLS}`);
  console.log(`  cache   : ${CACHE_MODE} -> ${CACHE_DIR}`);
  console.log(`  ledger  : ${LEDGER_PATH}`);
  console.log('');
});
