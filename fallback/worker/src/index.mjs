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



/**
 * Token-bucket rate limiter using Cloudflare KV.
 * Keyed by API key (or IP if no auth). Configurable via env vars.
 */
async function rateLimit(request, env, key) {
  const limit = Number(env.RATE_LIMIT_MAX ?? 60);      // requests
  const windowMs = Number(env.RATE_LIMIT_WINDOW_MS ?? 60000); // 60s default
  const now = Date.now();
  const windowStart = now - windowMs;

  const bucket = await env.RATE_LIMIT.get(key, { type: 'json' });
  let tokens = bucket?.tokens ?? limit;
  let lastRefill = bucket?.lastRefill ?? now;

  // Refill tokens based on time passed
  const elapsed = now - lastRefill;
  if (elapsed > 0) {
    const refillRate = limit / windowMs; // tokens per ms
    tokens = Math.min(limit, tokens + elapsed * refillRate);
    lastRefill = now;
  }

  if (tokens < 1) {
    const retryAfter = Math.ceil((1 - tokens) / refillRate);
    return { allowed: false, retryAfter, limit, remaining: 0, reset: new Date(now + retryAfter).toISOString() };
  }

  tokens -= 1;
  await env.RATE_LIMIT.put(key, JSON.stringify({ tokens, lastRefill }), { expirationTtl: Math.ceil(windowMs / 1000) + 60 });

  return { allowed: true, retryAfter: 0, limit, remaining: Math.floor(tokens), reset: new Date(now + windowMs).toISOString() };
}

function rateLimitHeaders(rl) {
  return {
    'X-RateLimit-Limit': String(rl.limit),
    'X-RateLimit-Remaining': String(rl.remaining),
    'X-RateLimit-Reset': rl.reset,
  };
}

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

    // Root: this is an API, not a page.
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

    // Auth + rate limit: determine the rate limit key (or null for public routes)
    const needsAuth = url.pathname.startsWith('/v1/') || url.pathname === '/__agree';
    let rateLimitKey = null;
    if (needsAuth && env.FALLBACK_API_KEY) {
      const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (got !== env.FALLBACK_API_KEY) {
        return json({ error: { message: 'invalid api key', type: 'unauthorized' } }, 401, cors);
      }
      rateLimitKey = `key:${got}`;
    } else if (needsAuth && !env.FALLBACK_API_KEY) {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      rateLimitKey = `ip:${ip}`;
    }

    // Apply rate limit if needed
    let rateLimitInfo = null;
    if (rateLimitKey) {
      rateLimitInfo = await rateLimit(request, env, rateLimitKey);
      if (!rateLimitInfo.allowed) {
        return json({ error: { message: 'rate limit exceeded', type: 'rate_limit' } }, 429, { ...cors, ...rateLimitHeaders(rateLimitInfo) });
      }
    }

    // Helper to add rate limit headers to a response
    const withRateLimitHeaders = (response) => {
      if (!rateLimitKey || !rateLimitInfo) return response;
      const limit = Number(env.RATE_LIMIT_MAX ?? 60);
      const headers = new Headers(response.headers);
      headers.set('X-RateLimit-Limit', String(limit));
      headers.set('X-RateLimit-Remaining', String(rateLimitInfo.remaining));
      headers.set('X-RateLimit-Reset', rateLimitInfo.reset);
      return new Response(response.body, { status: response.status, headers });
    };

    // Licence acceptance
    if (url.pathname === '/__agree' && request.method === 'POST') {
      try {
        const out = await env.AI.run(env.MODEL, { prompt: 'agree' });
        return await withRateLimitHeaders(json({ status: 'accepted', model: env.MODEL, upstream: out }, 200, cors));
      } catch (err) {
        const msg = String(err?.message ?? err);
        if (/thank you for agreeing/i.test(msg)) {
          return await withRateLimitHeaders(json({ status: 'accepted', model: env.MODEL }, 200, cors));
        }
        return await withRateLimitHeaders(json({ error: { message: msg, type: 'agree_failed' } }, 502, cors));
      }
    }

    if (url.pathname === '/v1/models') {
      const response = json({
        object: 'list',
        data: [{ id: env.SERVED_MODEL_NAME, object: 'model', owned_by: 'meta', served_in: env.MODEL }],
      }, 200, cors);
      return await withRateLimitHeaders(response);
    }

    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch {
        return await withRateLimitHeaders(json({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }, 400, cors));
      }

      const { messages, imageCount } = toWorkerAiInput(body.messages);
      if (!messages.length) {
        return await withRateLimitHeaders(json({ error: { message: 'messages is required', type: 'invalid_request_error' } }, 400, cors));
      }

      const params = {
        messages,
        max_tokens: Math.min(Number(body.max_tokens ?? 512), 2048),
        temperature: Number(body.temperature ?? 0.2),
        stream: false,
      };
      if (Array.isArray(body.tools) && body.tools.length) params.tools = body.tools;
      let out;
      try {
        out = await env.AI.run(env.MODEL, params);
      } catch (err) {
        return await withRateLimitHeaders(json({
          error: { message: String(err?.message ?? err), type: 'upstream_error' },
        }, 502, cors));
      }

      const raw = typeof out === 'string' ? out : out?.response;
      const content = typeof raw === 'string' ? raw : (raw === undefined || raw === null ? '' : JSON.stringify(raw));
      const response = json({
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
      return await withRateLimitHeaders(response);
    }

    return json({ error: { message: `no route for ${url.pathname}`, type: 'not_found' } }, 404, cors);
  },
};