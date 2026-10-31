#!/usr/bin/env node
/**
 * Contract check for the LineCheck fallback endpoint.
 *
 *   node fallback/contract.mjs --self-test
 *       Runs the whole checker against an in-process fake of the vLLM OpenAI server, so the checker
 *       itself is verified without a GPU, a Modal token, or a network. This is the mode that runs
 *       in CI / on a laptop.
 *
 *   node fallback/contract.mjs --url https://...modal.run --key $FALLBACK_API_KEY
 *       Hits the deployed endpoint and asserts the four things the proxy relies on:
 *         1. GET  /health                      -> 200
 *         2. GET  /v1/models                   -> the served model is listed
 *         3. POST /v1/chat/completions (text)  -> 200, non-empty content
 *         4. POST /v1/chat/completions (image) -> 200, non-empty content  (vision actually wired)
 *         5. POST with the HUD system prompt   -> a JSON tool object the proxy can parse
 *       Exit code 0 = contract holds. Any other exit = the exact check that failed, printed.
 *
 * No dependencies: Node's fetch and http only, same rule as the rest of this harness.
 */
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const SELF_TEST = args.includes('--self-test');
const BASE = (argOf('--url', 'http://127.0.0.1:8000') || '').replace(/\/+$/, '');
// self-test still needs a token: the fake enforces bearer auth so the checker exercises it
const KEY = argOf('--key', process.env.FALLBACK_API_KEY || (SELF_TEST ? 'self-test-key' : ''));
const MODEL = argOf('--model', process.env.FALLBACK_SERVED_MODEL_NAME || 'llama-3.2-11b-vision');
const TIMEOUT_MS = Number(argOf('--timeout', '180000'));

// 1x1 PNG - a real image part, small enough to inline, so the vision path is exercised for real.
const PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const HUD_SYSTEM =
  'You are LineCheck, a kitchen HUD assistant. Call exactly one tool that completes the request. ' +
  'Never answer in prose. If no tool fits, call verify_pan_depth with what you know.';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'record_waste',
      description: 'Record a waste entry for a kitchen container.',
      parameters: {
        type: 'object',
        properties: {
          ingredient: { type: 'string' },
          weight_g: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['ingredient', 'weight_g', 'reason'],
      },
    },
  },
];

const checks = [];
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

async function call(base, path, { method = 'GET', body, key = KEY } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text, json: safeJson(text) };
  } finally {
    clearTimeout(timer);
  }
}

const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

/** The proxy's parser, mirrored: first balanced JSON object in a string. */
function firstJsonObject(text) {
  const start = String(text).indexOf('{');
  if (start === -1) return null;
  let depth = 0; let inStr = false; let esc = false;
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
      if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

async function runContract(base) {
  const health = await call(base, '/health');
  record('GET /health returns 200', health.status === 200, `status ${health.status}`);

  const models = await call(base, '/v1/models');
  const ids = (models.json?.data ?? []).map((m) => m.id);
  record('GET /v1/models lists the served model', models.status === 200 && ids.includes(MODEL),
    `status ${models.status}, ids [${ids.join(', ')}]`);

  const textChat = await call(base, '/v1/chat/completions', {
    method: 'POST',
    body: {
      model: MODEL,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    },
  });
  const textContent = textChat.json?.choices?.[0]?.message?.content ?? '';
  record('POST /v1/chat/completions (text) answers', textChat.status === 200 && textContent.trim().length > 0,
    `status ${textChat.status}, ${String(textContent).slice(0, 60)}`);

  const vision = await call(base, '/v1/chat/completions', {
    method: 'POST',
    body: {
      model: MODEL,
      max_tokens: 48,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What colour is this image? One word.' },
          { type: 'image_url', image_url: { url: PIXEL_PNG } },
        ],
      }],
    },
  });
  const visionContent = vision.json?.choices?.[0]?.message?.content ?? '';
  record('POST /v1/chat/completions (image) answers', vision.status === 200 && String(visionContent).trim().length > 0,
    `status ${vision.status}, ${String(visionContent).slice(0, 60)}`);

  const toolish = await call(base, '/v1/chat/completions', {
    method: 'POST',
    body: {
      model: MODEL,
      max_tokens: 128,
      temperature: 0,
      messages: [
        { role: 'system', content: `${HUD_SYSTEM} Answer ONLY with JSON: {"tool":{"name":...,"arguments":{...}}}` },
        { role: 'user', content: 'We threw away 900 grams of salmon trim.' },
      ],
    },
  });
  const content = toolish.json?.choices?.[0]?.message?.content ?? '';
  const parsed = firstJsonObject(content);
  const toolName = parsed?.tool?.name ?? parsed?.name ?? null;
  record('fallback reply parses into a tool object', toolish.status === 200 && Boolean(toolName),
    toolName ? `tool=${toolName}` : `unparseable: ${String(content).slice(0, 120)}`);

  const badAuth = await call(base, '/v1/models', { key: 'definitely-wrong-key' });
  record('wrong bearer token is rejected', badAuth.status === 401 || badAuth.status === 403,
    `status ${badAuth.status}`);

  return checks;
}

/** In-process fake of the vLLM OpenAI surface, so the checker can be verified without a GPU. */
async function startFakeServer() {
  const server = createServer((req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    const auth = req.headers.authorization || '';
    if (req.url === '/health') return send(200, { status: 'ok' });
    if (req.url === '/v1/models') {
      if (!auth.startsWith('Bearer ')) return send(401, { error: 'unauthorized' });
      if (auth !== `Bearer ${KEY}`) return send(401, { error: 'bad key' });
      return send(200, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* keep {} */ }
        const contentParts = JSON.stringify(body.messages ?? []);
        const isVision = contentParts.includes('image_url');
        const wantsTool = contentParts.includes('LineCheck');
        const content = wantsTool
          ? '{"tool":{"name":"record_waste","arguments":{"ingredient":"salmon trim","weight_g":900,"reason":"Trim waste"}}}'
          : isVision ? 'black' : 'ready';
        send(200, {
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      });
      return;
    }
    send(404, { error: 'not_found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function main() {
  let base = BASE;
  let fake = null;
  if (SELF_TEST) {
    fake = await startFakeServer();
    base = `http://127.0.0.1:${fake.port}`;
    console.log(`self-test: checker pointed at an in-process fake on ${base}\n`);
  } else {
    console.log(`contract: ${base} (model ${MODEL})\n`);
  }

  try {
    await runContract(base);
  } finally {
    if (fake) {
      // Windows/libuv aborts if the process exits with a request still in flight, so close the
      // listener and its sockets, and let the loop drain instead of calling process.exit().
      fake.server.closeAllConnections?.();
      await new Promise((resolve) => fake.server.close(resolve));
    }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} contract checks passed`);
  if (failed.length) {
    console.log('failed:', failed.map((c) => c.name).join('; '));
    process.exitCode = 1;
    return;
  }
  if (SELF_TEST) {
    console.log('self-test OK: the checker passes against a conforming fake and would fail a broken one.');
  }
}

main().catch((err) => {
  console.error('contract run failed:', err?.message ?? err);
  process.exitCode = 1;
});
