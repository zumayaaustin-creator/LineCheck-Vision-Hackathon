/**
 * Proxy failover contract: primary Meta route -> open-weight fallback.
 *
 * Every case here runs the REAL proxy (`harness/proxy-server.mjs`) as a child process against two
 * fake upstreams, so the assertions cover the actual fetch path, the actual ledger file, and the
 * actual response headers - not a mock of them. The point of this suite is the money: a fallback
 * that double-charges, or that fails over past the operator's ceiling, is worse than no fallback.
 *
 *   node --test harness/tests/proxy-fallback.test.mjs
 *
 * Nothing here touches a paid API: both upstreams are local http servers and META_API_KEY is a
 * literal test string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

/** A fake upstream that records what the proxy actually sent it. */
function fakeUpstream(handler) {
  const state = { hits: 0, auth: [], bodies: [] };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.hits += 1;
      state.auth.push(req.headers.authorization ?? null);
      const parsed = safeJson(raw);
      state.bodies.push(parsed ?? raw);
      handler(req, res, state, parsed ?? raw);
    });
  });
  return {
    state,
    listen: async () => {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    close: async () => { await new Promise((resolve) => server.close(resolve)); },
  };
}

const jsonReply = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

/** OpenAI-shaped success from the primary route, with a real tool_call. */
const openaiToolCall = (res, { model = 'muse-spark-1.3', tool = 'record_waste', args } = {}) => jsonReply(res, 200, {
  id: 'chatcmpl-primary',
  object: 'chat.completion',
  model,
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: tool,
          arguments: JSON.stringify(args ?? { ingredient: 'salmon trim', weight_g: 907, reason: 'Trim waste' }),
        },
      }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
});

/** OpenAI-shaped success from the fallback route: JSON in content, because mllama has no tool_calls. */
const fallbackJsonTool = (res, { model = 'llama-3.2-11b-vision', tool = 'record_waste' } = {}) => jsonReply(res, 200, {
  id: 'chatcmpl-fallback',
  object: 'chat.completion',
  model,
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: `{"tool":{"name":"${tool}","arguments":{"ingredient":"salmon trim","weight_g":900,"reason":"Trim waste"}}}`,
    },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 90, completion_tokens: 30, total_tokens: 120 },
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`proxy never came up at ${url}: ${lastErr?.message ?? 'timeout'}`);
}

/**
 * Boot one proxy wired to the two fakes. `tuning` overrides env for the case under test.
 */
async function withProxy({ primary, fallback, tuning = {} }, fn) {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), 'lc-fallback-'));
  const ledgerPath = path.join(dir, 'ledger.json');

  const env = {
    ...process.env,
    META_API_KEY: 'test-meta-key',
    META_SAM_URL: 'http://127.0.0.1:1/sam-3.1/segment',
    META_MUSE_URL: 'http://127.0.0.1:1/muse-audio/transcribe',
    META_MUSE_SPARK_URL: `http://127.0.0.1:${primary}/muse-spark/dispatch`,
    META_OPEN_WEIGHTS_SPARK_URL: `http://127.0.0.1:${fallback}/v1/chat/completions`,
    META_OPEN_WEIGHTS_MODEL: 'llama-3.2-11b-vision',
    MODAL_API_KEY: 'test-partner-key',
    PROXY_SPARK_PROTOCOL: 'openai',
    PROXY_PORT: String(port),
    PROXY_HOST: '127.0.0.1',
    PROXY_CACHE_MODE: 'off',
    PROXY_LEDGER_PATH: ledgerPath,
    PROXY_USAGE_SAMPLE_PATH: path.join(dir, 'usage.json'),
    COST_PER_OPEN_WEIGHTS_CALL_USD: '0.01',
    PROXY_TIMEOUT_MS: '4000',
    ...tuning,
  };

  const proc = spawn(process.execPath, ['harness/proxy-server.mjs'], {
    cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d.toString(); });
  proc.stderr.on('data', (d) => { log += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${base}/health`);
    const ledger = () => (existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : null);
    const call = async (body, headers = {}) => {
      const res = await fetch(`${base}/muse-spark/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, text, json: safeJson(text) };
    };
    return await fn({ base, ledger, call, log: () => log, dir });
  } finally {
    proc.kill('SIGKILL');
    await once(proc, 'exit').catch(() => {});
  }
}

const hudBody = (extra = {}) => ({
  transcript: 'we threw away nine hundred grams of salmon trim',
  tools: [{ name: 'record_waste', parameters: { ingredient: 'string', weight_g: 'number', reason: 'string' } }],
  ...extra,
});

// ---------------------------------------------------------------------------------------------

test('primary healthy: no failover, primary tier stamped, fallback untouched', async () => {
  const primary = fakeUpstream((req, res) => openaiToolCall(res));
  const fallback = fakeUpstream((req, res) => fallbackJsonTool(res));
  const [pPort, fPort] = [await primary.listen(), await fallback.listen()];
  try {
    await withProxy({ primary: pPort, fallback: fPort, tuning: { FALLBACK_MODE: 'auto' } }, async ({ call, ledger }) => {
      const r = await call(hudBody());
      assert.equal(r.status, 200);
      assert.equal(r.json?.tool?.name, 'record_waste', 'primary tool_call translated to the HUD contract');
      assert.equal(r.headers.get('x-fallback'), null, 'no failover header on a healthy primary');
      assert.equal(r.json?._meta?.modelTier, 'primary');
      assert.equal(primary.state.hits, 1);
      assert.equal(fallback.state.hits, 0, 'the fallback must not be paid for when primary answered');

      const l = ledger();
      assert.equal(l.failedCalls, 0);
      assert.equal(l.refundedUsd, 0);
      assert.ok(l.totalSpendUsd > 0, 'a paid call is recorded');
      assert.equal(l.byRoute.spark.calls, 1);
    });
  } finally { await primary.close(); await fallback.close(); }
});

test('primary 503: fails over, fallback cost only, primary refunded and visible', async () => {
  const primary = fakeUpstream((req, res) => jsonReply(res, 503, { error: 'model_overloaded' }));
  const fallback = fakeUpstream((req, res) => fallbackJsonTool(res));
  const [pPort, fPort] = [await primary.listen(), await fallback.listen()];
  try {
    await withProxy({ primary: pPort, fallback: fPort, tuning: { FALLBACK_MODE: 'auto' } }, async ({ call, ledger }) => {
      const r = await call(hudBody());
      assert.equal(r.status, 200, 'the caller sees a served answer, not the primary error');
      assert.equal(r.headers.get('x-fallback'), 'primary->open-weights');
      assert.equal(r.headers.get('x-fallback-reason'), 'failover');
      assert.equal(r.headers.get('x-model-tier'), 'open-weights');
      assert.equal(r.json?.tool?.name, 'record_waste', 'JSON content parsed into the tool contract');
      assert.equal(r.json?._meta?.modelTier, 'open-weights');
      assert.equal(r.json?._meta?.fallback?.from, 'primary');
      assert.equal(r.json?._meta?.fallback?.to, 'open-weights');
      assert.equal(r.json?._meta?.fallback?.reason, 'failover');
      assert.equal(r.json?._meta?.fallback?.primaryFailure?.status, 503);

      assert.equal(primary.state.hits, 1);
      assert.equal(fallback.state.hits, 1);
      assert.equal(fallback.state.auth[0], 'Bearer test-partner-key', 'fallback gets the partner key, not the Meta key');

      const l = ledger();
      assert.equal(l.paidCalls, 2, 'both attempts were reserved');
      assert.equal(l.failedCalls, 1, 'the 503 is recorded as a failed call');
      assert.equal(l.refundedUsd, 0.03, 'primary reservation refunded');
      assert.ok(Math.abs(l.totalSpendUsd - 0.01) < 1e-9, `lifetime spend is the fallback cost only (got ${l.totalSpendUsd})`);
      assert.equal(l.byRoute.spark.calls, 2);
    });
  } finally { await primary.close(); await fallback.close(); }
});

test('FALLBACK_MODE=off: the primary error is returned and the fallback is never called', async () => {
  const primary = fakeUpstream((req, res) => jsonReply(res, 503, { error: 'model_overloaded' }));
  const fallback = fakeUpstream((req, res) => fallbackJsonTool(res));
  const [pPort, fPort] = [await primary.listen(), await fallback.listen()];
  try {
    await withProxy({ primary: pPort, fallback: fPort, tuning: { FALLBACK_MODE: 'off' } }, async ({ call, ledger }) => {
      const r = await call(hudBody());
      assert.equal(r.status, 503);
      assert.equal(r.headers.get('x-proxy-cost'), 'refunded');
      assert.equal(r.headers.get('x-fallback'), null);
      assert.equal(fallback.state.hits, 0, 'off means off');
      assert.equal(ledger().refundedUsd, 0.03);
      assert.equal(ledger().totalSpendUsd, 0);
    });
  } finally { await primary.close(); await fallback.close(); }
});

test('explicit x-model-tier: open-weights routes straight to the fallback and never touches primary', async () => {
  const primary = fakeUpstream((req, res) => openaiToolCall(res));
  const fallback = fakeUpstream((req, res) => fallbackJsonTool(res));
  const [pPort, fPort] = [await primary.listen(), await fallback.listen()];
  try {
    await withProxy({ primary: pPort, fallback: fPort, tuning: { FALLBACK_MODE: 'auto' } }, async ({ call }) => {
      const r = await call(hudBody(), { 'x-model-tier': 'open-weights' });
      assert.equal(r.status, 200);
      assert.equal(r.json?.tool?.name, 'record_waste');
      assert.equal(primary.state.hits, 0, 'an explicit tier request is not a primary attempt');
      assert.equal(fallback.state.hits, 1);
      assert.equal(r.json?._meta?.fallback, undefined, 'not a failover: the caller asked for this tier');
    });
  } finally { await primary.close(); await fallback.close(); }
});

test('primary timeout: aborts and fails over instead of surfacing a 504', async () => {
  const primary = fakeUpstream((req, res) => { /* never answer */ });
  const fallback = fakeUpstream((req, res) => fallbackJsonTool(res));
  const [pPort, fPort] = [await primary.listen(), await fallback.listen()];
  try {
    await withProxy({ primary: pPort, fallback: fPort, tuning: { FALLBACK_MODE: 'auto', PROXY_TIMEOUT_MS: '400' } }, async ({ call, ledger }) => {
      const r = await call(hudBody());
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('x-fallback'), 'primary->open-weights');
      assert.equal(r.json?._meta?.fallback?.primaryFailure?.kind, 'timeout');
      assert.equal(fallback.state.hits, 1);
      const l = ledger();
      assert.equal(l.refundedUsd, 0.03);
      assert.ok(Math.abs(l.totalSpendUsd - 0.01) < 1e-9);
    });
  } finally { await primary.close(); await fallback.close(); }
});

test('both upstreams down: one error, both reservations refunded, failover reported', async () => {
  const primary = fakeUpstream((req, res) => jsonReply(res, 503, { error: 'down' }));
  const fallback = fakeUpstream((req, res) => jsonReply(res, 502, { error: 'gpu_unavailable' }));
  const [pPort, fPort] = [await primary.listen(), await fallback.listen()];
  try {
    await withProxy({ primary: pPort, fallback: fPort, tuning: { FALLBACK_MODE: 'auto' } }, async ({ call, ledger }) => {
      const r = await call(hudBody());
      assert.equal(r.status, 502, 'the last failure status is what the caller sees');
      assert.equal(r.headers.get('x-fallback'), 'attempted-and-failed');
      assert.equal(primary.state.hits, 1);
      assert.equal(fallback.state.hits, 1);

      const l = ledger();
      assert.equal(l.paidCalls, 2);
      assert.equal(l.failedCalls, 2);
      assert.ok(Math.abs(l.refundedUsd - 0.04) < 1e-9, `both refunded (got ${l.refundedUsd})`);
      assert.equal(l.totalSpendUsd, 0, 'a total failure costs nothing');
    });
  } finally { await primary.close(); await fallback.close(); }
});

test('circuit breaker: after a failover the next call skips the primary entirely', async () => {
  let primaryMode = 'fail';
  const primary = fakeUpstream((req, res) => (primaryMode === 'fail'
    ? jsonReply(res, 503, { error: 'down' })
    : openaiToolCall(res)));
  const fallback = fakeUpstream((req, res) => fallbackJsonTool(res));
  const [pPort, fPort] = [await primary.listen(), await fallback.listen()];
  try {
    await withProxy({ primary: pPort, fallback: fPort, tuning: { FALLBACK_MODE: 'auto', FALLBACK_COOLDOWN_MS: '60000' } }, async ({ call }) => {
      const first = await call(hudBody());
      assert.equal(first.status, 200);
      assert.equal(primary.state.hits, 1);

      primaryMode = 'ok'; // the primary recovers, but the breaker is still open
      const second = await call(hudBody({ transcript: 'second request after the breaker opened' }));
      assert.equal(second.status, 200);
      assert.equal(primary.state.hits, 1, 'primary is bypassed inside the cooldown');
      assert.equal(second.headers.get('x-fallback-reason'), 'circuit_open');
      assert.equal(second.json?._meta?.fallback?.reason, 'circuit_open');
    });
  } finally { await primary.close(); await fallback.close(); }
});

test('our own call cap refuses before any upstream call, even with failover armed', async () => {
  const primary = fakeUpstream((req, res) => openaiToolCall(res));
  const fallback = fakeUpstream((req, res) => fallbackJsonTool(res));
  const [pPort, fPort] = [await primary.listen(), await fallback.listen()];
  try {
    await withProxy({ primary: pPort, fallback: fPort, tuning: { FALLBACK_MODE: 'auto', MAX_PAID_CALLS: '0' } }, async ({ call }) => {
      const r = await call(hudBody());
      assert.equal(r.status, 429);
      assert.equal(r.json?.error, 'call_cap_reached');
      assert.equal(primary.state.hits, 0, 'budget gates stay in front of the network');
      assert.equal(fallback.state.hits, 0, 'a refusal must not be routed around by failover');
    });
  } finally { await primary.close(); await fallback.close(); }
});

test('a 400 from the primary is NOT a failover trigger (same malformed request everywhere)', async () => {
  const primary = fakeUpstream((req, res) => jsonReply(res, 400, { error: 'invalid_tool_schema' }));
  const fallback = fakeUpstream((req, res) => fallbackJsonTool(res));
  const [pPort, fPort] = [await primary.listen(), await fallback.listen()];
  try {
    await withProxy({ primary: pPort, fallback: fPort, tuning: { FALLBACK_MODE: 'auto' } }, async ({ call }) => {
      const r = await call(hudBody());
      assert.equal(r.status, 400);
      assert.equal(fallback.state.hits, 0, 'retrying a malformed request doubles the bill for the same error');
    });
  } finally { await primary.close(); await fallback.close(); }
});

test('the failover attempt receives a JSON instruction built from the tools actually offered', async () => {
  const primary = fakeUpstream((req, res) => jsonReply(res, 503, { error: 'down' }));
  const fallback = fakeUpstream((req, res) => fallbackJsonTool(res, { tool: 'record_waste' }));
  const [pPort, fPort] = [await primary.listen(), await fallback.listen()];
  try {
    await withProxy({ primary: pPort, fallback: fPort, tuning: { FALLBACK_MODE: 'auto' } }, async ({ call }) => {
      const r = await call(hudBody());
      assert.equal(r.status, 200);

      // what the fallback upstream actually received
      const sent = fallback.state.bodies[0];
      const sys = (sent.messages ?? []).find((m) => m.role === 'system');
      assert.ok(sys, 'a system message was sent to the fallback');
      const text = typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content);
      assert.match(text, /record_waste/, 'the offered tool names are in the instruction');
      assert.match(text, /ONLY a JSON object/i, 'the JSON contract is stated explicitly');
      assert.match(text, /"tool"/, 'an example object is included');

      // the primary must NOT get that rewrite: it gets the caller's own prompt
      const primarySent = primary.state.bodies[0];
      const primarySys = (primarySent.messages ?? []).find((m) => m.role === 'system');
      assert.ok(!primarySys || !/ONLY a JSON object/i.test(JSON.stringify(primarySys.content)),
        'the primary route keeps the caller prompt');
    });
  } finally { await primary.close(); await fallback.close(); }
});

test('a fallback reply naming a tool the caller never offered is refused, not passed through', async () => {
  const primary = fakeUpstream((req, res) => jsonReply(res, 503, { error: 'down' }));
  // the model invents "Inventory" - observed on the real endpoint when tools were absent
  const fallback = fakeUpstream((req, res) => fallbackJsonTool(res, { tool: 'Inventory' }));
  const [pPort, fPort] = [await primary.listen(), await fallback.listen()];
  try {
    await withProxy({ primary: pPort, fallback: fPort, tuning: { FALLBACK_MODE: 'auto' } }, async ({ call }) => {
      const r = await call(hudBody());
      assert.equal(r.status, 200, 'the HTTP call still succeeds');
      assert.equal(r.json?.tool, undefined, 'no invented tool is handed to the HUD');
      assert.ok(r.json?.choices, 'the raw OpenAI body is passed through instead, so the client can decide');
    });
  } finally { await primary.close(); await fallback.close(); }
});
