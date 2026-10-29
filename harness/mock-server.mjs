#!/usr/bin/env node
/**
 * Local mock contract server for the live Meta paths.
 *
 * Purpose: exercise the REAL fetch() branch in src/mcp/client.ts - Bearer auth, JSON
 * parsing, error handling, throttling over an actual network hop - without spending a
 * single SAM 3.1 / Muse credit.
 *
 *   node harness/mock-server.mjs                 # default port 8787
 *   MOCK_PORT=9000 node harness/mock-server.mjs
 *
 * Then point the app at it:
 *   VITE_USE_MOCK_META=false
 *   VITE_META_API_KEY=local-test-token
 *   VITE_SAM_MODEL_ENDPOINT=http://127.0.0.1:8787/sam-3.1/segment
 *   VITE_MUSE_AUDIO_ENDPOINT=http://127.0.0.1:8787/muse-audio/transcribe
 *
 * Routes
 *   POST /sam-3.1/segment       -> 1280x720 unnormalised detections
 *   POST /muse-audio/transcribe -> kitchen transcript + WebMCP tool call
 *   POST /muse-spark/dispatch   -> transcript -> tool selection (Spark 1.3 stand-in)
 *   GET  /health                -> readiness
 *   POST /__simulate?mode=...   -> set a default failure/latency mode for later requests
 *
 * Failure + latency injection (query param on either POST route, or via /__simulate)
 *   ?simulate=latency   -> +600 ms
 *   ?simulate=slow      -> +2500 ms (long enough to catch an in-flight guard)
 *   ?simulate=500       -> 500 response
 *   ?simulate=401       -> 401 response
 *
 * Auth: every POST route requires `Authorization: Bearer <MOCK_META_TOKEN>`
 * (default `local-test-token`). A wrong or missing token yields 401, which is what lets
 * us prove the HUD survives an auth failure.
 */

import { createServer } from 'node:http';
import { buildDetections, SOURCE_FRAME } from './sam-3.1/detections.mjs';
import { nextTranscript, allScenarios } from './muse-audio/transcripts.mjs';
import { dispatch } from './muse-audio/spark-dispatch.mjs';

const PORT = Number(process.env.MOCK_PORT || 8787);
const HOST = process.env.MOCK_HOST || '127.0.0.1';
const TOKEN = process.env.MOCK_META_TOKEN || 'local-test-token';

/** default simulation for requests that do not specify one */
let defaultSimulate = null;
let requestCount = 0;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '600',
};

function json(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...CORS,
    ...extra,
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

function log(msg) {
  console.log(`[mock] ${new Date().toISOString().slice(11, 23)}  ${msg}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const simulate = url.searchParams.get('simulate') || defaultSimulate;

  // ---- CORS preflight ----
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (path === '/health') {
    json(res, 200, {
      status: 'ok',
      service: 'linecheck-mock-contracts',
      routes: ['/sam-3.1/segment', '/muse-audio/transcribe', '/muse-spark/dispatch'],
      defaultSimulate,
      scenarios: allScenarios(),
      sourceFrame: SOURCE_FRAME,
    });
    return;
  }

  // ---- runtime simulation control, so failure modes need no rebuild ----
  if (path === '/__simulate') {
    const mode = url.searchParams.get('mode');
    defaultSimulate = mode === 'none' || !mode ? null : mode;
    log(`default simulate set to ${defaultSimulate ?? 'none'}`);
    json(res, 200, { defaultSimulate });
    return;
  }

  if (req.method !== 'POST' || !['/sam-3.1/segment', '/muse-audio/transcribe', '/muse-spark/dispatch'].includes(path)) {
    json(res, 404, { error: 'not_found', path });
    return;
  }

  requestCount += 1;
  const n = requestCount;

  // ---- latency injection ----
  if (simulate === 'latency') {
    log(`#${n} ${path} simulating +600ms`);
    await new Promise((r) => setTimeout(r, 600));
  } else if (simulate === 'slow') {
    log(`#${n} ${path} simulating +2500ms`);
    await new Promise((r) => setTimeout(r, 2500));
  }

  // ---- auth check: this is the point of the exercise ----
  const auth = req.headers.authorization || '';
  if (simulate === '401') {
    log(`#${n} ${path} forced 401`);
    json(res, 401, { error: 'unauthorized', message: 'forced by ?simulate=401' });
    return;
  }
  if (auth !== `Bearer ${TOKEN}`) {
    log(`#${n} ${path} 401 bad token: got "${auth ? auth.slice(0, 24) : '(none)'}"`);
    json(res, 401, {
      error: 'unauthorized',
      message: 'Authorization: Bearer <MOCK_META_TOKEN> required',
      expected: `Bearer ${TOKEN}`,
    });
    return;
  }

  if (simulate === '500') {
    log(`#${n} ${path} forced 500`);
    json(res, 500, { error: 'internal_error', message: 'forced by ?simulate=500' });
    return;
  }

  // ---- body ----
  const raw = await readBody(req);
  let body = {};
  const ctype = String(req.headers['content-type'] || '');
  if (ctype.includes('application/json') && raw.length) {
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      json(res, 400, { error: 'bad_json' });
      return;
    }
  }

  try {
    if (path === '/sam-3.1/segment') {
      const frame = {
        width: Number(body.width) || SOURCE_FRAME.width,
        height: Number(body.height) || SOURCE_FRAME.height,
      };
      const payload = buildDetections(frame);
      log(`#${n} sam-3.1 -> ${payload.detections.length} detections, frame ${frame.width}x${frame.height}, auth ok, body ${raw.length}B`);
      json(res, 200, payload);
      return;
    }

    if (path === '/muse-spark/dispatch') {
      const transcript = String(body.transcript ?? '');
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const out = dispatch(transcript, tools);
      log(`#${n} muse-spark -> "${transcript.slice(0, 48)}" => ${out.tool.name} (conf ${out.confidence}) auth ok`);
      json(res, 200, {
        ...out,
        meta: { model: 'muse-spark-1.3-mock', toolsOffered: tools.length },
      });
      return;
    }

    // /muse-audio/transcribe
    const scenario = url.searchParams.get('scenario') || body.hint || null;
    const t = nextTranscript(scenario);
    log(`#${n} muse-audio -> "${t.transcription}" tool=${t.tool.name} auth ok, audio ${raw.length}B`);
    json(res, 200, {
      transcription: t.transcription,
      reply: t.reply,
      action: t.action,
      tool: t.tool,
      meta: { model: 'muse-mock', scenario: t.scenario, audioBytes: raw.length },
    });
  } catch (err) {
    log(`#${n} ${path} 500 ${err?.message}`);
    json(res, 500, { error: 'mock_server_error', message: String(err?.message) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  LineCheck mock contract server');
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  token: ${TOKEN}`);
  console.log('  routes: /sam-3.1/segment  /muse-audio/transcribe  /muse-spark/dispatch  /health  /__simulate');
  console.log('  simulate: latency | slow | 401 | 500');
  console.log('');
});
