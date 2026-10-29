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

// Fallback pricing used ONLY when upstream reports tokens/duration but no explicit cost.
// Leave at 0 to disable token-based reconciliation and keep the conservative floor.
const TOKEN_PRICE = {
  promptPer1k: Number(process.env.PRICE_PROMPT_USD_PER_1K ?? 0),
  completionPer1k: Number(process.env.PRICE_COMPLETION_USD_PER_1K ?? 0),
  audioPerSecond: Number(process.env.PRICE_AUDIO_USD_PER_SECOND ?? 0),
};

const USAGE_SAMPLE_PATH = process.env.PROXY_USAGE_SAMPLE_PATH || '.cache/live-usage-sample.json';

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
  reconciledUsd: 0,
  reconciledCalls: 0,
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

// ---------------------------------------------------------------- usage reconciliation
const BILLING_HEADER_RE = /^(x-)?(ratelimit|rate-limit|cost|billing|usage|request-id|x-request-id|retry-after)/i;

/** pull billing-ish headers, never the credential */
function billingHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    if (/^(authorization|set-cookie|cookie)$/i.test(k)) continue;
    if (BILLING_HEADER_RE.test(k) || /^x-.*(cost|usage|billing)/i.test(k)) out[k] = v;
  }
  return out;
}

/** find a usage object anywhere sane in the upstream JSON */
function extractUsage(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  const candidates = [parsed?.usage, parsed?.meta?.usage, parsed?.billing, parsed?.data?.usage];
  const usage = candidates.find((u) => u && typeof u === 'object');
  if (!usage) return null;
  return {
    total_cost_usd: num(usage.total_cost_usd ?? usage.cost_usd ?? usage.cost),
    prompt_tokens: num(usage.prompt_tokens ?? usage.input_tokens),
    completion_tokens: num(usage.completion_tokens ?? usage.output_tokens),
    duration_seconds: num(usage.duration_seconds ?? usage.billed_seconds ?? usage.audio_seconds),
    raw: usage,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Turn whatever the upstream reported into an actual USD figure.
 * Explicit cost wins. Tokens/seconds only reconcile when a price constant is configured -
 * otherwise we would be inventing a number, which is worse than keeping the floor.
 */
function actualCostFrom(usage) {
  if (!usage) return { usd: null, basis: 'no usage block' };
  if (usage.total_cost_usd !== undefined) {
    return { usd: usage.total_cost_usd, basis: 'upstream total_cost_usd' };
  }
  const parts = [];
  let usd = 0;
  if (usage.prompt_tokens !== undefined && TOKEN_PRICE.promptPer1k > 0) {
    usd += (usage.prompt_tokens / 1000) * TOKEN_PRICE.promptPer1k;
    parts.push('prompt tokens');
  }
  if (usage.completion_tokens !== undefined && TOKEN_PRICE.completionPer1k > 0) {
    usd += (usage.completion_tokens / 1000) * TOKEN_PRICE.completionPer1k;
    parts.push('completion tokens');
  }
  if (usage.duration_seconds !== undefined && TOKEN_PRICE.audioPerSecond > 0) {
    usd += usage.duration_seconds * TOKEN_PRICE.audioPerSecond;
    parts.push('audio seconds');
  }
  if (parts.length === 0) {
    return { usd: null, basis: 'tokens/seconds present but no price constant configured' };
  }
  return { usd: round6(usd), basis: `computed from ${parts.join(' + ')}` };
}

/** record the first raw usage sample per route, verbatim, for calibrating the constants */
async function recordUsageSample(routePath, status, body, headers, reconciliation) {
  let store = { version: 1, note: 'First raw upstream usage block + billing headers per route. Use these to replace the COST_PER_* estimates with real pricing.', samples: {} };
  try {
    store = JSON.parse(await fs.readFile(USAGE_SAMPLE_PATH, 'utf8'));
  } catch { /* first run */ }

  store.samples = store.samples || {};
  if (store.samples[routePath]) return false; // first sample per route only

  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* keep raw text */ }

  store.samples[routePath] = {
    capturedAtUtc: new Date().toISOString(),
    status,
    headers: headers,
    usage: parsed?.usage ?? parsed?.meta?.usage ?? null,
    reconciliation,
    bodyPreview: parsed ? undefined : body.slice(0, 600),
  };

  try {
    mkdirSync(path.dirname(USAGE_SAMPLE_PATH), { recursive: true });
    const tmp = `${USAGE_SAMPLE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, USAGE_SAMPLE_PATH);
    return true;
  } catch (err) {
    console.error(`[proxy] WARN: usage sample write failed (${err.message})`);
    return false;
  }
}

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
      reconciliation: {
        reconciledCalls: ledger.reconciledCalls,
        reconciledDeltaUsd: round6(ledger.reconciledUsd),
        usageSamplePath: USAGE_SAMPLE_PATH,
        tokenPricing: TOKEN_PRICE,
      },
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
      reconciledUsd: round6(ledger.reconciledUsd),
      reconciledCalls: ledger.reconciledCalls,
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

    // ---- reconcile the reserved floor against what the upstream actually reported ----
    const usage = extractUsage(text);
    const actual = actualCostFrom(usage);
    let reconciliation = {
      reservedUsd: nextCost,
      actualUsd: null,
      deltaUsd: 0,
      basis: actual.basis,
    };

    if (actual.usd !== null) {
      const delta = round6(actual.usd - nextCost);
      ledger.totalSpendUsd = round6(Math.max(0, ledger.totalSpendUsd + delta));
      sessionSpendUsd = round6(Math.max(0, sessionSpendUsd + delta));
      ledger.byRoute[route.key].spendUsd = round6(Math.max(0, ledger.byRoute[route.key].spendUsd + delta));
      ledger.reconciledUsd = round6(ledger.reconciledUsd + delta);
      ledger.reconciledCalls += 1;
      reconciliation = { reservedUsd: nextCost, actualUsd: actual.usd, deltaUsd: delta, basis: actual.basis };
      saveLedger();

      const sign = delta >= 0 ? '+' : '-';
      log(`RECONCILE ${url.pathname} reserved $${nextCost.toFixed(4)} -> actual $${actual.usd.toFixed(6)} (${sign}$${Math.abs(delta).toFixed(6)}) [${actual.basis}] lifetime $${ledger.totalSpendUsd.toFixed(4)}`);
      if (ledger.totalSpendUsd > MAX_SPEND_USD) {
        log(`WARN: reconciliation pushed lifetime spend to $${ledger.totalSpendUsd.toFixed(4)}, above the $${MAX_SPEND_USD} ceiling - it was already spent`);
      }
    } else {
      log(`NO-RECONCILE ${url.pathname}: ${actual.basis} - keeping the $${nextCost.toFixed(2)} floor`);
    }

    const sampleWritten = await recordUsageSample(
      url.pathname, upstream.status, text, billingHeaders(upstream.headers), reconciliation,
    );
    if (sampleWritten) log(`SAMPLE ${url.pathname} -> ${USAGE_SAMPLE_PATH}`);

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
      'X-Proxy-Cost-Actual': reconciliation.actualUsd === null ? 'unknown' : String(reconciliation.actualUsd),
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
