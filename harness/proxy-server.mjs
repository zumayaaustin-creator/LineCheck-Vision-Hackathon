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

// ---------------------------------------------------------------- model tiers (Spark only)
/**
 * Muse Spark can be served from two places, chosen per request by the `x-model-tier` header (or
 * a `tier` field in the JSON body):
 *
 *   primary       Meta-hosted Spark. The default. Flat cost = COST.spark per call.
 *   open-weights  the open-weight build on Baseten or Modal (the hackathon partner credits).
 *
 * Deliberate choices, each one guarding a specific way this could go wrong:
 *  - The tier is part of the replay-cache key. Without that, a primary response would be
 *    replayed for an open-weights request and the HUD would name the wrong model at $0.00.
 *  - An unknown tier is a 400, never a silent fall back to primary: a typo must not quietly
 *    spend on the expensive route while reporting the cheap one.
 *  - A tier whose URL is unset is a 400 too. Falling back to the Meta endpoint while labelling
 *    the response "open-weights" would be a lie in the ledger and a split cache for nothing.
 *  - Cost stays a flat per-call floor like every other route in this file. Per-1k-token prices
 *    are NOT applied here because this proxy never sees an invoice line; it reconciles against
 *    whatever the upstream reports (actualCostFrom below) and otherwise keeps the floor.
 */
const MODEL_TIERS = {
  primary: {
    id: process.env.META_PRIMARY_MODEL || 'muse-spark-1.3',
    url: () => SPARK_URL,
    key: () => process.env.META_API_KEY || '',
    cost: () => COST.spark,
  },
  'open-weights': {
    id: process.env.META_OPEN_WEIGHTS_MODEL || 'muse-spark-open-1026',
    url: () => process.env.META_OPEN_WEIGHTS_SPARK_URL || process.env.BASETEN_MODAL_OPEN_URL || '',
    // falls back to the Meta key when the partner key is unset; warned about at boot
    key: () => process.env.BASETEN_API_KEY || process.env.MODAL_API_KEY || process.env.META_API_KEY || '',
    cost: () => COST.openWeights,
  },
};
const DEFAULT_TIER = 'primary';

// ---------------------------------------------------------------- Spark wire protocol
/**
 * The linecheck contract (what the HUD speaks) is `{transcript, tools}` in,
 * `{tool:{name,arguments}}` out. Meta Model API speaks OpenAI: chat messages + `tools` in,
 * `choices[0].message.tool_calls[]` out. Rather than teach the browser two dialects, the proxy
 * translates when `PROXY_SPARK_PROTOCOL=openai`:
 *
 *   PROXY_SPARK_PROTOCOL   linecheck (default) | openai
 *   META_SPARK_MODEL       model id sent upstream          (default muse-spark-1.3)
 *   PROXY_SPARK_MAX_TOKENS max_tokens for the live call    (default 256)
 *   PROXY_SPARK_SYSTEM     system prompt; a tool-calling bias, because prose is unusable here
 *
 * Translation happens BEFORE the cache key is computed, so the key covers the translated payload:
 * switching protocol invalidates the cache instead of replaying a body shaped for the other one.
 */
const SPARK_PROTOCOL = (process.env.PROXY_SPARK_PROTOCOL || 'linecheck').toLowerCase();

// ---------------------------------------------------------------- failover: primary -> open-weights
/**
 * "Seamless switch when the primary Meta API fails" is a routing decision, so it lives here and not
 * in the browser: the HUD cannot know that Spark timed out, and teaching it a second retry loop
 * would put the second endpoint's URL in the bundle.
 *
 *   FALLBACK_MODE        off (default) | auto
 *   FALLBACK_TIER        which tier serves as the fallback        (default open-weights)
 *   FALLBACK_TRIGGERS    status,timeout,network                   (default all three)
 *   FALLBACK_COOLDOWN_MS how long to bypass a failing primary     (default 60000)
 *   PROXY_FALLBACK_TOOL_JSON  true (default) | false  - parse a JSON tool reply out of a model that
 *                             has no OpenAI tool_calls support (vLLM + Llama 3.2 Vision)
 *
 * Deliberate choices:
 *  - `off` by default. A silent switch that the ledger cannot explain is worse than a visible error,
 *    and the demo needs to be able to show the primary path failing honestly.
 *  - An explicit `x-model-tier: open-weights` request never touches the primary, and never gets
 *    relabelled; only a request that ASKED for primary can be served by the fallback.
 *  - Our own budget refusals (429 from this proxy) never trigger failover. Failing over past our own
 *    ceiling would be spending money the operator just refused to spend.
 *  - A 4xx from the primary is not a fallback trigger: a malformed request will be malformed
 *    everywhere, and retrying it doubles the bill for the same error.
 *  - The fallback attempt re-runs the budget gates and re-reserves, so the ledger records two
 *    reservations and one refund - the refunded primary attempt is visible instead of vanishing.
 */
const FALLBACK_MODE = (process.env.FALLBACK_MODE || 'off').toLowerCase();
const FALLBACK_TIER = process.env.FALLBACK_TIER || 'open-weights';
const FALLBACK_COOLDOWN_MS = Number(process.env.FALLBACK_COOLDOWN_MS ?? 60000);
const FALLBACK_TRIGGERS = new Set(
  (process.env.FALLBACK_TRIGGERS || 'status,timeout,network')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);
const FALLBACK_TOOL_JSON = String(process.env.PROXY_FALLBACK_TOOL_JSON ?? 'true') !== 'false';

/**
 * The fallback model needs to be told the JSON contract explicitly. Measured on the Cloudflare
 * Workers AI build of Llama 3.2 11B Vision: with the primary system prompt plus a `tools` array it
 * answered with a bare tool NAME and no arguments (safe to ignore), and with no tools at all it
 * invented names like "Inventory". Given this instruction (names + one example) it produced the
 * exact object both times, at temperature 0 and 0.2.
 *
 *   PROXY_FALLBACK_SYSTEM   override the whole instruction; {tools} and {example} are substituted
 */
const FALLBACK_SYSTEM_TEMPLATE =
  process.env.PROXY_FALLBACK_SYSTEM ||
  'You are LineCheck, a kitchen HUD assistant. Available tools: {tools}. '
  + 'Choose exactly one tool and answer with ONLY a JSON object, no prose, no markdown fences, '
  + 'using this exact shape:\n{example}\n'
  + 'Use the numeric weight in grams and a short lowercase reason.';

/** Build the fallback instruction from the tools the caller actually offered. */
function buildFallbackSystem(toolNames) {
  const names = toolNames.length ? toolNames.join(', ') : 'record_waste, calculate_yield, tare_scale, verify_pan_depth';
  const first = toolNames[0] || 'record_waste';
  const example = JSON.stringify({ tool: { name: first, arguments: { ingredient: 'salmon trim', weight_g: 900, reason: 'trim waste' } } });
  return FALLBACK_SYSTEM_TEMPLATE.replaceAll('{tools}', names).replaceAll('{example}', example);
}

/** The tool names an OpenAI body offers (both `tools[].function.name` and the linecheck shape). */
function offeredToolNames(body) {
  if (!Array.isArray(body?.tools)) return [];
  return body.tools
    .map((t) => t?.function?.name ?? t?.name)
    .filter((n) => typeof n === 'string' && n.length > 0);
}

/** Rewrite the system message of an OpenAI body for the fallback attempt. Returns the new body or null. */
function withFallbackSystem(rawBody, names) {
  let parsed;
  try { parsed = JSON.parse(rawBody.toString('utf8')); } catch { return null; }
  if (!Array.isArray(parsed.messages) || !parsed.messages.length) return null;
  const instruction = buildFallbackSystem(names);
  const idx = parsed.messages.findIndex((m) => m?.role === 'system');
  if (idx >= 0) parsed.messages[idx] = { ...parsed.messages[idx], content: instruction };
  else parsed.messages.unshift({ role: 'system', content: instruction });
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

/** When the primary is known-bad, skip straight to the fallback tier until this timestamp. */
let primaryDownUntil = 0;

const FALLBACK_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * The ordered list of upstreams a request may touch.
 * A single entry unless: Spark route, caller asked for primary, mode is auto, the fallback tier is
 * configured, and it is not the same tier as the primary.
 */
function buildAttemptPlan(requestedTier, routeKey = 'spark') {
  const solo = [{ tier: requestedTier, via: null }];
  if (routeKey !== 'spark' || requestedTier !== DEFAULT_TIER) return solo;
  if (FALLBACK_MODE !== 'auto') return solo;
  const fb = MODEL_TIERS[FALLBACK_TIER];
  if (!fb || FALLBACK_TIER === requestedTier || !fb.url()) return solo;
  if (Date.now() < primaryDownUntil) {
    return [{ tier: FALLBACK_TIER, via: 'circuit_open' }];
  }
  return [{ tier: requestedTier, via: null }, { tier: FALLBACK_TIER, via: 'failover' }];
}

/** Does this failure justify spending on a second attempt? */
function isFailoverWorthy(failure) {
  if (!failure) return false;
  if (failure.kind === 'timeout') return FALLBACK_TRIGGERS.has('timeout');
  if (failure.kind === 'network') return FALLBACK_TRIGGERS.has('network');
  if (failure.kind === 'status') return FALLBACK_TRIGGERS.has('status') && FALLBACK_STATUSES.has(failure.status);
  return false;
}

/**
 * Pull the first balanced JSON object out of prose. vLLM + Llama 3.2 Vision has no OpenAI tool_call
 * support, so the fallback is asked to answer with the contract object; this reads it back.
 * Declines (returns null) rather than guessing - the client's own keyword fallback still runs.
 */
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** OpenAI chat body -> linecheck `{tool:{name,arguments}}` when the model replied with JSON text. */
function shapeFallbackToolJson(routeKey, payload, contentType, allowedNames = null, enabled = FALLBACK_TOOL_JSON) {
  if (!enabled || routeKey !== 'spark') return payload;
  if (!String(contentType).includes('json')) return payload;
  let parsed;
  try { parsed = JSON.parse(payload); } catch { return payload; }
  const msg = parsed?.choices?.[0]?.message;
  if (!msg || (Array.isArray(msg.tool_calls) && msg.tool_calls.length)) return payload;
  const content = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (!content) return payload;

  const candidate = firstJsonObject(content);
  if (!candidate || typeof candidate !== 'object') return payload;
  const tool = candidate.tool && typeof candidate.tool === 'object' && candidate.tool.name
    ? candidate.tool
    : (typeof candidate.name === 'string'
      ? { name: candidate.name, arguments: candidate.arguments ?? {} }
      : null);
  if (!tool?.name) return payload;
  // An offered-tools list is authoritative: a name the caller never sent is an invention, and
  // passing it through would let the model create state the app has no handler for.
  if (allowedNames && allowedNames.length && !allowedNames.includes(tool.name)) return payload;

  return JSON.stringify({
    tool: { name: tool.name, arguments: tool.arguments ?? {} },
    confidence: typeof candidate.confidence === 'number' ? candidate.confidence : null,
    rationale: "translated from the fallback model's JSON reply by the proxy",
    upstream_model: parsed.model,
    upstream_usage: parsed.usage,
  });
}

// ---------------------------------------------------------------- SAM wire protocol
/**
 * SAM 3.1 on Meta Model API is a different call, not a different shape: POST /v1/responses with
 * model `sam-3.1`, ONE noun-phrase concept per request, plus one media part. The answer streams a
 * special-token grammar in `output_text` - one line per frame, each record an object id, a box and a
 * mask:
 *
 *   text<0f>1<|box;x1=444;y1=625;x2=679;y2=850;w=1800;h=1200|><|mask;x=0;y=0;data=226,236,!...|>
 *
 * The HUD only needs boxes, so this adapter reads the box tokens and ignores the mask payloads
 * entirely - no base85 decoding, no raster. Boxes are rescaled into the frame size the caller
 * declared, because the response reports the media's own pixel size and the client normalises
 * against what it sent.
 *
 *   PROXY_SAM_PROTOCOL              linecheck (default) | meta
 *   META_SAM_MODEL                  default sam-3.1
 *   PROXY_SAM_CONCEPT               the noun phrase to segment; default "hotel pan"
 *   PROXY_SAM_INCLUDE_CONFIDENCE    asks the API for per-box confidence (adds `c=`)
 *
 * Zero matches is a valid answer and comes back as `{detections: []}` - the client renders nothing.
 */
const SAM_PROTOCOL = (process.env.PROXY_SAM_PROTOCOL || 'linecheck').toLowerCase();
const SAM_MODEL = process.env.META_SAM_MODEL || 'sam-3.1';
const SAM_CONCEPT = process.env.PROXY_SAM_CONCEPT || 'hotel pan';
const SAM_INCLUDE_CONFIDENCE = process.env.PROXY_SAM_INCLUDE_CONFIDENCE === 'true';
const SPARK_MODEL = process.env.META_SPARK_MODEL || 'muse-spark-1.3';
const SPARK_MAX_TOKENS = Number(process.env.PROXY_SPARK_MAX_TOKENS ?? 256);
const SPARK_SYSTEM =
  process.env.PROXY_SPARK_SYSTEM ||
  'You are LineCheck, a kitchen HUD assistant. Call exactly one tool that completes the request. ' +
  'Never answer in prose. If no tool fits, call verify_pan_depth with what you know.';

const COST = {
  sam:   Number(process.env.COST_PER_SAM_CALL_USD   ?? 0.05),
  muse:  Number(process.env.COST_PER_MUSE_AUDIO_USD ?? 0.02),
  spark: Number(process.env.COST_PER_MUSE_SPARK_USD ?? 0.03),
  // the open-weight route is cheaper, but the floor stays conservative until a real invoice
  // says otherwise: set COST_PER_OPEN_WEIGHTS_CALL_USD once Baseten/Modal usage is known.
  openWeights: Number(
    process.env.COST_PER_OPEN_WEIGHTS_CALL_USD ?? process.env.COST_PER_MUSE_SPARK_USD ?? 0.03,
  ),
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
    'Access-Control-Allow-Headers': 'Content-Type, x-model-tier',
    'Access-Control-Expose-Headers':
      'X-Proxy-Cache, X-Proxy-Cost, X-Proxy-Cost-Actual, X-Model-Tier, X-Model-Id, X-Proxy-Ledger-Usd',
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

// ---------------------------------------------------------------- tier + payload helpers
/** the tool schemas Spark is given when a caller forgets to send them */
let FALLBACK_TOOLS = null;
function loadFallbackTools() {
  if (FALLBACK_TOOLS !== null) return FALLBACK_TOOLS;
  const toolsPath = process.env.PROXY_TOOLS_PATH || 'harness/webmcp/tools.json';
  try {
    const parsed = JSON.parse(readFileSync(toolsPath, 'utf8'));
    FALLBACK_TOOLS = Array.isArray(parsed) ? parsed : [];
    if (FALLBACK_TOOLS.length) log(`TOOLS loaded ${FALLBACK_TOOLS.length} schemas from ${toolsPath}`);
  } catch {
    FALLBACK_TOOLS = []; // no fallback file: forward the body exactly as received
  }
  return FALLBACK_TOOLS;
}

/**
 * Resolve the model tier for a request. Only the Spark route is tiered; SAM and Muse audio have
 * exactly one home each.
 */
function resolveTier(routeKey, headers, body) {
  if (routeKey !== 'spark') return { tier: null, error: null };
  const headerTier = String(headers['x-model-tier'] || '').trim().toLowerCase();
  const bodyTier = typeof body?.tier === 'string' ? body.tier.trim().toLowerCase() : '';
  const requested = headerTier || bodyTier || DEFAULT_TIER;
  const cfg = MODEL_TIERS[requested];
  if (!cfg) return { tier: requested, error: 'unknown_model_tier' };
  if (!cfg.url()) return { tier: requested, error: 'tier_not_configured' };
  return { tier: requested, error: null };
}

/**
 * OpenAI tool_calls -> the linecheck `{tool:{name,arguments}}` shape.
 *
 * Deliberately conservative: if there is no tool call, or the body is not the shape we expect, the
 * response is returned untouched so the client's own fallback (keyword match) still runs. A
 * translation layer that guesses is worse than one that declines.
 */
function shapeSparkResponse(routeKey, payload, contentType) {
  if (routeKey !== 'spark' || SPARK_PROTOCOL !== 'openai') return payload;
  if (!String(contentType).includes('json')) return payload;
  let parsed;
  try { parsed = JSON.parse(payload); } catch { return payload; }

  const call = parsed?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call?.function?.name) return payload;

  let args = call.function.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  return JSON.stringify({
    tool: { name: call.function.name, arguments: args ?? {} },
    confidence: null,
    rationale: 'translated from openai tool_calls by the proxy',
    upstream_model: parsed.model,
    upstream_usage: parsed.usage,
  });
}

/**
 * SAM grammar text -> `{detections:[...]}` in the frame space the caller declared.
 *
 * Reads box tokens only. A missing box token set is zero matches, which the API defines as a
 * successful empty result, so it returns an empty list rather than an error.
 */
function shapeSamResponse(routeKey, payload, frame, concept) {
  if (routeKey !== 'sam' || SAM_PROTOCOL !== 'meta') return payload;
  const BOX = /<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)(?:;c=([0-9.]+))?\|>/g;
  const detections = [];
  let m;
  let index = 0;
  while ((m = BOX.exec(payload)) !== null) {
    const [, x1, y1, x2, y2, w, h, c] = m;
    const mediaW = Number(w) || 0;
    const mediaH = Number(h) || 0;
    const sx = frame?.width && mediaW ? frame.width / mediaW : 1;
    const sy = frame?.height && mediaH ? frame.height / mediaH : 1;
    index += 1;
    detections.push({
      id: `sam-${index}`,
      label: String(concept || 'object').toUpperCase(),
      x: Math.round(Number(x1) * sx),
      y: Math.round(Number(y1) * sy),
      // x2/y2 are inclusive per the API grammar
      width: Math.round((Number(x2) - Number(x1) + 1) * sx),
      height: Math.round((Number(y2) - Number(y1) + 1) * sy),
      confidence: c ? Number(c) : 0.8,
      status: 'nominal',
    });
  }
  return JSON.stringify({
    detections,
    model: SAM_MODEL,
    concept: String(concept || ''),
    matches: detections.length,
    note: 'boxes parsed from the SAM grammar; masks not decoded by this proxy',
  });
}

/**
 * Stamp a JSON response with _meta so the HUD footer can show which route served it and what the
 * ledger has spent, without a second round trip to /__usage. Non-JSON bodies pass through
 * untouched - the same values ride on the response headers for those.
 */
function stampMeta(body, contentType, meta) {
  if (!String(contentType).includes('json')) return body;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
    parsed._meta = { ...(parsed._meta || {}), ...meta };
    return JSON.stringify(parsed, null, 2);
  } catch {
    return body; // an upstream that lied about its content-type is not our problem
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

if (MODEL_TIERS['open-weights'].url() && !process.env.BASETEN_API_KEY && !process.env.MODAL_API_KEY) {
  log('WARN: open-weights tier has a URL but no BASETEN_API_KEY/MODAL_API_KEY - it will send the Meta key');
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
      modelTiers: {
        default: DEFAULT_TIER,
        routes: Object.fromEntries(Object.entries(MODEL_TIERS).map(([name, cfg]) => [name, {
          id: cfg.id,
          configured: Boolean(cfg.url()),
          costPerCallUsd: cfg.cost(),
        }])),
      },
      updatedAtUtc: ledger.updatedAtUtc,
    });
    return;
  }

  const route = ROUTES[url.pathname];
  if (req.method !== 'POST' || !route) {
    json(req, res, 404, { error: 'not_found', path: url.pathname });
    return;
  }

  let raw = await readBody(req);
  const ctype = String(req.headers['content-type'] || 'application/json');

  // ---- 0a. the Spark payload always carries the tool schemas ----
  // The HUD sends them, but a direct curl used to reach Spark with no tools at all, and a model
  // with no tools answers in prose the HUD cannot execute. Injection happens BEFORE the cache
  // key is computed, so the replay cache stays deterministic across both callers.
  if (route.key === 'spark' && ctype.includes('json') && raw.length) {
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
        const fallback = loadFallbackTools();
        if (fallback.length) {
          raw = Buffer.from(JSON.stringify({ ...parsed, tools: fallback }), 'utf8');
          log(`INJECT ${fallback.length} tool schemas -> ${url.pathname}`);
        }
      }
    } catch { /* not JSON: forward untouched */ }
  }

  // ---- 0a2. translate the Spark request into the upstream's wire format ----
  if (route.key === 'spark' && SPARK_PROTOCOL === 'openai' && ctype.includes('json') && raw.length) {
    try {
      const asked = JSON.parse(raw.toString('utf8'));
      const tools = Array.isArray(asked.tools) ? asked.tools : [];
      raw = Buffer.from(JSON.stringify({
        model: SPARK_MODEL,
        messages: [
          { role: 'system', content: SPARK_SYSTEM },
          { role: 'user', content: String(asked.transcript ?? '') },
        ],
        tools: tools.map((t) => ({ type: 'function', function: t })),
        tool_choice: 'auto',
        max_tokens: SPARK_MAX_TOKENS,
      }), 'utf8');
      log(`SPARK -> openai wire format (${tools.length} tools, model ${SPARK_MODEL})`);
    } catch { /* not JSON: forward untouched */ }
  }

  // ---- 0a3. translate the SAM request into the Responses API ----
  let samFrame = null;
  if (route.key === 'sam' && SAM_PROTOCOL === 'meta' && ctype.includes('json') && raw.length) {
    try {
      const asked = JSON.parse(raw.toString('utf8'));
      samFrame = { width: Number(asked.width) || 0, height: Number(asked.height) || 0 };
      raw = Buffer.from(JSON.stringify({
        model: SAM_MODEL,
        input: [{
          type: 'message', role: 'user',
          content: [
            { type: 'input_text', text: String(asked.concept || SAM_CONCEPT) },
            { type: 'input_image', image_url: String(asked.frame || '') },
          ],
        }],
        stream: true,
        ...(SAM_INCLUDE_CONFIDENCE ? { include_confidence: true } : {}),
      }), 'utf8');
      log(`SAM -> responses wire format (concept "${asked.concept || SAM_CONCEPT}", model ${SAM_MODEL})`);
    } catch { /* not JSON: forward untouched */ }
  }

  // ---- 0b. model tier (Spark only) ----
  let tier = null;
  let tierCfg = null;
  if (route.key === 'spark') {
    let parsedBody = null;
    if (ctype.includes('json') && raw.length) {
      try { parsedBody = JSON.parse(raw.toString('utf8')); } catch { parsedBody = null; }
    }
    const resolved = resolveTier(route.key, req.headers, parsedBody);
    if (resolved.error) {
      log(`REFUSED ${url.pathname}: ${resolved.error} (${resolved.tier})`);
      json(req, res, 400, {
        error: resolved.error,
        tier: resolved.tier,
        message: resolved.error === 'unknown_model_tier'
          ? `Unknown model tier "${resolved.tier}". Known tiers: ${Object.keys(MODEL_TIERS).join(', ')}.`
          : `Tier "${resolved.tier}" has no upstream URL configured. Set META_OPEN_WEIGHTS_SPARK_URL.`,
        knownTiers: Object.keys(MODEL_TIERS),
      });
      return;
    }
    tier = resolved.tier;
    tierCfg = MODEL_TIERS[tier];
  }

  // ---- 0c. which upstreams this request may touch, in order ----
  const plan = buildAttemptPlan(tier, route.key);
  if (plan.length > 1) log(`PLAN ${url.pathname} -> ${plan.map((a) => a.tier || 'route').join(' then ')}`);
  let lastFailure = null;

  for (let attemptIndex = 0; attemptIndex < plan.length; attemptIndex += 1) {
    const attempt = plan[attemptIndex];
    const isLastAttempt = attemptIndex === plan.length - 1;
    const cfg = attempt.tier ? MODEL_TIERS[attempt.tier] : null;
    const activeUpstream = cfg ? cfg.url() : route.upstream;
    const activeKey = cfg ? cfg.key() : API_KEY;
    const activeModelId = cfg ? cfg.id : 'n/a';
    const nextCost = cfg ? cfg.cost() : route.cost;
    const attemptTier = attempt.tier;

    // the tier is part of the key: a primary answer must never be replayed for an open-weight ask
    const hash = cacheKeyFor(attemptTier ? `${route.key}:${attemptTier}` : route.key, ctype, raw);

    // ---- 1. replay cache: a hit costs nothing and never touches upstream ----
    const cached = await readCache(hash);
    if (cached && CACHE_MODE === 'record-or-replay') {
      ledger.cacheHits += 1;
      saveLedger();
      log(`CACHE HIT ${url.pathname} ${hash.slice(0, 12)} -> $0.00 (${ledger.cacheHits} hits)`);
      const hitBody = stampMeta(cached.body, cached.contentType || 'application/json', {
        activeRoute: route.key,
        modelTier: attemptTier,
        modelId: activeModelId,
        cached: true,
        costUsd: 0,
        ledgerSpentUsd: round6(ledger.totalSpendUsd),
        sessionSpendUsd: round6(sessionSpendUsd),
        cacheHits: ledger.cacheHits,
        ...(attempt.via ? { fallback: { to: attemptTier, reason: attempt.via, servedFromCache: true } } : {}),
      });
      res.writeHead(cached.status ?? 200, {
        'Content-Type': cached.contentType || 'application/json',
        'Content-Length': Buffer.byteLength(hitBody),
        'X-Proxy-Cache': 'hit',
        'X-Model-Tier': attemptTier || 'n/a',
        'X-Model-Id': activeModelId,
        'X-Proxy-Ledger-Usd': round6(ledger.totalSpendUsd).toFixed(6),
        ...(attempt.via ? { 'X-Fallback': `${DEFAULT_TIER}->${attemptTier}`, 'X-Fallback-Reason': attempt.via } : {}),
        ...corsFor(req),
      });
      res.end(hitBody);
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

    log(`#${ledger.paidCalls} ${url.pathname}${attemptTier ? ` [${attemptTier}]` : ''} $${nextCost.toFixed(2)} (lifetime $${ledger.totalSpendUsd.toFixed(2)}/${MAX_SPEND_USD}, session $${sessionSpendUsd.toFixed(2)}/${MAX_SESSION_SPEND_USD})`);

    const upstreamUrl = activeUpstream + (url.search || '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.PROXY_TIMEOUT_MS || 30000));

    /** refund the reservation for a failed attempt; returns nothing, mutates the ledger */
    const refundAttempt = (why) => {
      ledger.totalSpendUsd = round6(Math.max(0, ledger.totalSpendUsd - nextCost));
      sessionSpendUsd = round6(Math.max(0, sessionSpendUsd - nextCost));
      ledger.byRoute[route.key].spendUsd = round6(Math.max(0, ledger.byRoute[route.key].spendUsd - nextCost));
      ledger.refundedUsd = round6(ledger.refundedUsd + nextCost);
      ledger.failedCalls += 1;
      saveLedger();
      log(`REFUND ${url.pathname}${attemptTier ? ` [${attemptTier}]` : ''} $${nextCost.toFixed(2)} (${why}) -> lifetime $${ledger.totalSpendUsd.toFixed(2)}`);
    };

    /** decide once per failed attempt: fall over, or answer with the failure */
    const handleFailure = (failure) => {
      lastFailure = failure;
      const canFailOver = !isLastAttempt && isFailoverWorthy(failure);
      if (canFailOver) {
        primaryDownUntil = Date.now() + FALLBACK_COOLDOWN_MS;
        log(`FAILOVER ${url.pathname}: ${failure.kind}${failure.status ? ` ${failure.status}` : ''} -> ${plan[attemptIndex + 1].tier} (primary bypassed for ${FALLBACK_COOLDOWN_MS}ms)`);
        return 'continue';
      }
      const status = failure.kind === 'timeout' ? 504 : failure.kind === 'network' ? 502 : failure.status;
      const headers = {
        'Content-Type': failure.contentType || 'application/json',
        'Content-Length': Buffer.byteLength(failure.body ?? ''),
        'X-Proxy-Cost': 'refunded',
        ...(plan.length > 1 ? { 'X-Fallback': 'attempted-and-failed' } : {}),
        ...corsFor(req),
      };
      if (failure.kind === 'status') {
        res.writeHead(status, headers);
        res.end(failure.body ?? '');
        return 'responded';
      }
      const payload = JSON.stringify({
        error: failure.kind === 'timeout' ? 'upstream_timeout' : 'upstream_unreachable',
        message: String(failure.message ?? failure.kind),
        ...(plan.length > 1 ? { fallback: { attempted: true, failed: true, reasons: [failure.kind] } } : {}),
      }, null, 2);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Proxy-Cost': 'refunded',
        ...(plan.length > 1 ? { 'X-Fallback': 'attempted-and-failed' } : {}),
        ...corsFor(req),
      });
      res.end(payload);
      return 'responded';
    };

    try {
      // The fallback tier gets a deterministic JSON instruction built from the tools actually sent.
      // Only for the failover attempt: the primary route must receive the caller's own prompt.
      let attemptRaw = raw;
      let fallbackNames = null;
      if (attempt.via && route.key === 'spark' && SPARK_PROTOCOL === 'openai' && ctype.includes('json') && raw.length) {
        let parsedForTools = null;
        try { parsedForTools = JSON.parse(raw.toString('utf8')); } catch { parsedForTools = null; }
        fallbackNames = offeredToolNames(parsedForTools);
        const rewritten = withFallbackSystem(raw, fallbackNames);
        if (rewritten) {
          attemptRaw = rewritten;
          log(`FALLBACK SYSTEM rewritten for ${attempt.tier} (${fallbackNames.length} tools offered)`);
        }
      }

      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${activeKey}`, // credential never leaves the server
          ...(ctype.includes('multipart') ? {} : { 'Content-Type': ctype || 'application/json' }),
        },
        body: attemptRaw.length ? attemptRaw : undefined,
        signal: controller.signal,
      });

      let text = await upstream.text();
      let upstreamCtype = upstream.headers.get('content-type') || 'application/json';
      log(`#${ledger.paidCalls} <- ${upstream.status} (${text.length}B)`);

      if (upstream.status < 200 || upstream.status >= 300) {
        // refund: an outright rejection was almost certainly not billed
        refundAttempt(`upstream ${upstream.status}`);
        const outcome = handleFailure({
          kind: 'status', status: upstream.status, body: text, contentType: upstream.headers.get('content-type') || 'application/json',
        });
        if (outcome === 'continue') { clearTimeout(timer); continue; }
        clearTimeout(timer);
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

      // translate the upstream's answer back into the contract the browser speaks, before it is
      // cached, so a replay serves the same shape the live call did
      text = shapeSparkResponse(route.key, text, upstreamCtype);
      text = shapeFallbackToolJson(route.key, text, upstreamCtype, fallbackNames);
      text = shapeSamResponse(route.key, text, samFrame, SAM_CONCEPT);
      // both adapters emit JSON; an SSE content-type would be a lie downstream and would skip _meta
      if (!upstreamCtype.includes('json') && text.trimStart().startsWith('{')) upstreamCtype = 'application/json';

      const sampleWritten = await recordUsageSample(
        url.pathname, upstream.status, text, billingHeaders(upstream.headers), reconciliation,
      );
      if (sampleWritten) log(`SAMPLE ${url.pathname} -> ${USAGE_SAMPLE_PATH}`);

      // only successful responses are worth replaying
      await writeCache(hash, {
        hash,
        route: url.pathname,
        status: upstream.status,
        contentType: upstreamCtype,
        body: text,
        costUsd: nextCost,
        recordedAtUtc: new Date().toISOString(),
        upstream: upstreamUrl.replace(/\/\/.*@/, '//'),
      });

      const servedBody = stampMeta(text, upstreamCtype, {
        activeRoute: route.key,
        modelTier: attemptTier,
        modelId: activeModelId,
        cached: false,
        costUsd: nextCost,
        actualCostUsd: reconciliation.actualUsd,
        ledgerSpentUsd: round6(ledger.totalSpendUsd),
        sessionSpendUsd: round6(sessionSpendUsd),
        cacheHits: ledger.cacheHits,
        ...(attempt.via
          ? {
            fallback: {
              from: DEFAULT_TIER,
              to: attemptTier,
              reason: attempt.via,
              primaryFailure: lastFailure
                ? { kind: lastFailure.kind, status: lastFailure.status ?? null }
                : null,
            },
          }
          : {}),
      });

      res.writeHead(upstream.status, {
        'Content-Type': upstreamCtype,
        'Content-Length': Buffer.byteLength(servedBody),
        'X-Proxy-Cost': nextCost.toFixed(3),
        'X-Proxy-Cost-Actual': reconciliation.actualUsd === null ? 'unknown' : String(reconciliation.actualUsd),
        'X-Proxy-Cache': 'miss',
        'X-Model-Tier': attemptTier || 'n/a',
        'X-Model-Id': activeModelId,
        'X-Proxy-Ledger-Usd': round6(ledger.totalSpendUsd).toFixed(6),
        ...(attempt.via ? { 'X-Fallback': `${DEFAULT_TIER}->${attemptTier}`, 'X-Fallback-Reason': attempt.via } : {}),
        ...corsFor(req),
      });
      res.end(servedBody);
      clearTimeout(timer);
      return;
    } catch (err) {
      const aborted = err?.name === 'AbortError';
      refundAttempt(aborted ? 'timeout' : err?.message);
      const outcome = handleFailure({
        kind: aborted ? 'timeout' : 'network',
        message: String(err?.message ?? err),
      });
      clearTimeout(timer);
      if (outcome === 'continue') continue;
      return;
    }
  }

  // every planned attempt failed and each one answered already
  json(req, res, 502, {
    error: 'all_attempts_failed',
    message: 'Every upstream in the failover plan failed.',
    lastFailure: lastFailure ? { kind: lastFailure.kind, status: lastFailure.status ?? null } : null,
  });
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
  for (const [name, cfg] of Object.entries(MODEL_TIERS)) {
    const url = cfg.url() || '(not configured)';
    console.log(`  tier    : ${name.padEnd(13)} ${cfg.id}  $${cfg.cost()}  -> ${url}`);
  }
  console.log(`  failover: ${FALLBACK_MODE}` +
    (FALLBACK_MODE === 'auto'
      ? `  primary -> ${FALLBACK_TIER} on [${[...FALLBACK_TRIGGERS].join(',')}] cooldown ${FALLBACK_COOLDOWN_MS}ms`
      : '  (set FALLBACK_MODE=auto to fail over)'));
  console.log(`  cache   : ${CACHE_MODE} -> ${CACHE_DIR}`);
  console.log(`  ledger  : ${LEDGER_PATH}`);
  console.log('');
});
