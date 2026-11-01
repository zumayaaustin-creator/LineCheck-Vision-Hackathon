/**
 * Unit tests for the Worker's OpenAI -> Workers AI translation.
 *
 * The AI binding is stubbed, so this runs in plain Node with no Cloudflare account, no network and
 * no GPU: it checks the parts that are ours (parsing, image decoding, auth, response shaping), not
 * the model's answers.
 *
 *   node --test fallback/worker/test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './src/index.mjs';

const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const SERVED = 'llama-3.2-11b-vision';

/** Stub binding: records the params it was called with, returns a fixed Workers AI reply. */
function stubEnv({ apiKey = null, response = 'ok', throws = null } = {}) {
  const calls = [];
  return {
    calls,
    env: {
      MODEL,
      SERVED_MODEL_NAME: SERVED,
      FALLBACK_API_KEY: apiKey ?? undefined,
      AI: {
        run: async (model, params) => {
          calls.push({ model, params });
          if (throws) throw new Error(throws);
          return { response, usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } };
        },
      },
    },
  };
}

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const post = (path, body, headers = {}) => new Request(`https://worker.test${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('GET /health answers and names the model', async () => {
  const { env } = stubEnv();
  const res = await worker.fetch(new Request('https://worker.test/health'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, 'linecheck-fallback-worker');
  assert.equal(body.model, MODEL);
});

test('GET /v1/models lists the served id in OpenAI shape', async () => {
  const { env } = stubEnv();
  const res = await worker.fetch(new Request('https://worker.test/v1/models'), env);
  const body = await res.json();
  assert.equal(body.object, 'list');
  assert.equal(body.data[0].id, SERVED);
});

test('text-only completion reaches the binding and comes back OpenAI-shaped', async () => {
  const { env, calls } = stubEnv({ response: 'ready' });
  const res = await worker.fetch(post('/v1/chat/completions', {
    model: SERVED,
    messages: [{ role: 'user', content: 'say ready' }],
  }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, 'ready');
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.equal(body.model, SERVED);
  assert.equal(body.usage.total_tokens, 15);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, MODEL, 'the binding gets the Cloudflare model id, not the served name');
  assert.equal(calls[0].params.messages[0].content, 'say ready');
  assert.equal(calls[0].params.image, undefined, 'no image on a text call');
});

test('image parts are forwarded inside messages (top-level image is deprecated)', async () => {
  const { env, calls } = stubEnv({ response: 'red' });
  const res = await worker.fetch(post('/v1/chat/completions', {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what colour is this?' },
        { type: 'image_url', image_url: { url: PIXEL } },
      ],
    }],
  }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, 'red');
  assert.equal(body._meta.images, 1, 'the response reports how many image parts were sent');

  const sent = calls[0].params;
  assert.equal(sent.image, undefined, 'no out-of-band image param: Workers AI silently ignores it');
  assert.ok(Array.isArray(sent.messages[0].content), 'content stays a parts array');
  const imgPart = sent.messages[0].content.find((p) => p.type === 'image_url');
  assert.ok(imgPart, 'the image part survives the translation unchanged');
  assert.equal(imgPart.image_url.url, PIXEL);
});

test('text is preserved alongside image parts', async () => {
  const { env, calls } = stubEnv();
  await worker.fetch(post('/v1/chat/completions', {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'two frames' },
        { type: 'image_url', image_url: { url: PIXEL } },
        { type: 'image_url', image_url: { url: PIXEL } },
      ],
    }],
  }), env);
  const parts = calls[0].params.messages[0].content;
  assert.equal(parts.filter((p) => p.type === 'text').length, 1);
  assert.equal(parts.filter((p) => p.type === 'image_url').length, 2);
});

test('a configured bearer is enforced, and a wrong one is a 401', async () => {
  const { env, calls } = stubEnv({ apiKey: 'right' });
  const bad = await worker.fetch(post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] },
    { Authorization: 'Bearer wrong' }), env);
  assert.equal(bad.status, 401);
  assert.equal(calls.length, 0, 'no model call on a rejected request');

  const good = await worker.fetch(post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] },
    { Authorization: 'Bearer right' }), env);
  assert.equal(good.status, 200);
});

test('no configured bearer means open (documented, not accidental)', async () => {
  const { env } = stubEnv({ apiKey: null });
  const res = await worker.fetch(post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }), env);
  assert.equal(res.status, 200);
});

test('a binding failure surfaces as a 502 in OpenAI error shape', async () => {
  const { env } = stubEnv({ throws: 'out of neurons' });
  const res = await worker.fetch(post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }), env);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error.message, /out of neurons/);
});

test('missing messages is a 400, not a model call', async () => {
  const { env, calls } = stubEnv();
  const res = await worker.fetch(post('/v1/chat/completions', { messages: [] }), env);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});
