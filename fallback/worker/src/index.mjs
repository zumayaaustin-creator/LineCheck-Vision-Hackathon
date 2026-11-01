/**
 * LineCheck fallback endpoint - OpenAI-compatible face over Cloudflare Workers AI.
 *
 * Serves the open-weight Meta vision model `@cf/meta/llama-3.2-11b-vision-instruct` behind the same
 * wire contract the primary Meta API speaks, so `harness/proxy-server.mjs` can fail over to it with
 * nothing but a URL change.
 *
 * Routes
 *   GET  /health                -> 200 when the binding is wired
 *   GET  /v1/models             -> OpenAI model list (contract checkers and clients expect it)
 *   POST /v1/chat/completions   -> OpenAI chat completions, including image_url content parts
 *
 * Design notes worth keeping:
 *  - The translation is explicit because Workers AI's own OpenAI shim is documented for text
 *    models; vision arrives here as `image_url` data URLs and leaves as byte arrays.
 *  - Auth is a bearer token WE set (`FALLBACK_API_KEY`), optional but enforced when present. The AI
 *    binding needs no secret at all, so there is no provider token to leak.
 *  - `tool_calls` are NOT synthesised. This model answers in prose/JSON; the proxy decides whether
 *    the JSON is usable (`PROXY_FALLBACK_TOOL_JSON`) and otherwise declines, rather than inventing
 *    a tool call for a bookkeeping app.
 */

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-model-tier',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/**
 * Normalise an OpenAI messages array for Workers AI.
 *
 * Workers AI's own input schema says the top-level `image` parameter is DEPRECATED: "use image as a
 * part of messages now". So the OpenAI content parts are kept as parts and forwarded - the platform
 * decodes `image_url` itself. Passing bytes out-of-band (top-level `image`) is accepted, silently
 * ignored, and the model then answers "There is no image" while prompt_tokens stay text-sized; that
 * exact symptom is what this function exists to avoid.
 */
function toWorkerAiInput(openaiMessages) {
  const messages = (openaiMessages ?? [])
    .filter((m) => m && m.role)
    .map((m) => ({ role: m.role, content: m.content }));
  const imageCount = messages.reduce((n, m) => n + (Array.isArray(m.content)
    ? m.content.filter((p) => p?.type === 'image_url' || p?.type === 'input_image').length
    : 0), 0);
  return { messages, imageCount };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // Root: this is an API, not a page. A bare click used to return a 404, which reads as "broken"
    // to anyone who isn't the proxy. Say what this is and what it serves.
    if (url.pathname === '/' || url.pathname === '/index.json') {
      return json({
        service: 'linecheck-fallback-worker',
        what: 'OpenAI-compatible endpoint serving an open-weight Meta vision model. '
          + 'It is a fallback upstream for the LineCheck proxy, not a user interface.',
        model: env.MODEL,
        served_model_name: env.SERVED_MODEL_NAME,
        endpoints: {
          'GET /health': 'liveness, no auth',
          'GET /v1/models': 'OpenAI model list, bearer required',
          'POST /v1/chat/completions': 'OpenAI chat completions (text + image_url parts), bearer required',
          'POST /__agree': 'one-time licence acceptance for a new account, bearer required',
        },
        used_by: 'harness/proxy-server.mjs with FALLBACK_MODE=auto',
        docs: 'fallback/README.md in the LineCheck-Vision-Hackathon repo',
      }, 200, cors);
    }

    if (url.pathname === '/health') {
      return json({ status: 'ok', service: 'linecheck-fallback-worker', model: env.MODEL }, 200, cors);
    }

    // Bearer auth covers every route that can spend neurons, not just completions: a models list
    // that answers without credentials made the contract checker's wrong-key probe look like a hole.
    const needsAuth = url.pathname.startsWith('/v1/') || url.pathname === '/__agree';
    if (needsAuth && env.FALLBACK_API_KEY) {
      const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (got !== env.FALLBACK_API_KEY) {
        return json({ error: { message: 'invalid api key', type: 'unauthorized' } }, 401, cors);
      }
    }

    // Some Meta models are licence-gated at the Workers AI layer: until the account accepts, every
    // inference returns 5016 "must submit the prompt 'agree'". The acceptance call needs the model's
    // native `prompt` shape, which an OpenAI request never carries - hence this route. Idempotent,
    // safe to call once per account, and it is the reason the first contract run failed.
    if (url.pathname === '/__agree' && request.method === 'POST') {
      try {
        const out = await env.AI.run(env.MODEL, { prompt: 'agree' });
        return json({ status: 'accepted', model: env.MODEL, upstream: out }, 200, cors);
      } catch (err) {
        const msg = String(err?.message ?? err);
        // Workers AI signals a *successful* acceptance with the same 5016 code: the text is
        // "Thank you for agreeing to this model's terms. You may now use the model."
        if (/thank you for agreeing/i.test(msg)) {
          return json({ status: 'accepted', model: env.MODEL }, 200, cors);
        }
        return json({ error: { message: msg, type: 'agree_failed' } }, 502, cors);
      }
    }

    if (url.pathname === '/v1/models') {
      return json({
        object: 'list',
        data: [{ id: env.SERVED_MODEL_NAME, object: 'model', owned_by: 'meta', served_in: env.MODEL }],
      }, 200, cors);
    }

    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return json({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }, 400, cors);
      }

      const { messages, imageCount } = toWorkerAiInput(body.messages);
      if (!messages.length) {
        return json({ error: { message: 'messages is required', type: 'invalid_request_error' } }, 400, cors);
      }

      const params = {
        messages,
        max_tokens: Math.min(Number(body.max_tokens ?? 512), 2048),
        temperature: Number(body.temperature ?? 0.2),
        stream: false,
      };
      // Forward the caller's tools. Without them the model invents tool names ("Inventory",
      // "calculate_waste") which a bookkeeping app must never accept as real calls.
      if (Array.isArray(body.tools) && body.tools.length) params.tools = body.tools;
      let out;
      try {
        out = await env.AI.run(env.MODEL, params);
      } catch (err) {
        return json({
          error: { message: String(err?.message ?? err), type: 'upstream_error' },
        }, 502, cors);
      }

      // Workers AI parses a JSON-looking reply into an OBJECT and hands it back in `response`.
      // OpenAI clients (and our proxy's parser) expect `content` to be a string, so coerce - an
      // object here is what produced the literal "[object Object]" in the contract checker.
      const raw = typeof out === 'string' ? out : out?.response;
      const content = typeof raw === 'string' ? raw : (raw === undefined || raw === null ? '' : JSON.stringify(raw));
      return json({
        id: `chatcmpl-cf-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: env.SERVED_MODEL_NAME,
        _meta: { images: imageCount },
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content,
            // native tool_calls when Workers AI produced them, so the proxy's existing
            // OpenAI->linecheck translation path works unchanged
            ...(Array.isArray(out?.tool_calls) && out.tool_calls.length
              ? { tool_calls: out.tool_calls }
              : {}),
          },
          finish_reason: Array.isArray(out?.tool_calls) && out.tool_calls.length ? 'tool_calls' : 'stop',
        }],
        usage: out?.usage
          ? {
            prompt_tokens: out.usage.prompt_tokens ?? null,
            completion_tokens: out.usage.completion_tokens ?? null,
            total_tokens: out.usage.total_tokens ?? null,
          }
          : undefined,
      }, 200, cors);
    }

    return json({ error: { message: `no route for ${url.pathname}`, type: 'not_found' } }, 404, cors);
  },
};
