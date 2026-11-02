# `/fallback` - open-weight Meta vision route (Modal)

Serverless fallback for the LineCheck demo. When the primary Meta Model API (Muse Spark 1.3) is
down, rate-limited, or out of credits, the proxy switches this route in and the HUD keeps answering.

| | |
|---|---|
| model | `meta-llama/Llama-3.2-11B-Vision-Instruct` (open weights, Meta) |
| serving | vLLM's OpenAI-compatible server, one Modal GPU container |
| wire format | OpenAI `/v1/chat/completions` + `/v1/models` + `/health`, bearer auth |
| provider | Modal (`fallback/modal_app.py`) |
| switch | `FALLBACK_MODE` in `harness/proxy-server.mjs` - `off` (default) or `auto` |

## Architecture

```
HUD (browser)                proxy (server-side key)                 upstreams
    │  POST /muse-spark/dispatch   │
    ├─────────────────────────────►│  plan: [primary, open-weights]
    │                              ├───────────► Meta Model API   (META_MUSE_SPARK_URL)
    │                              │   503/429/timeout ──► refund, retry ↓
    │                              ├───────────► Modal vLLM       (META_OPEN_WEIGHTS_SPARK_URL)
    │◄─────────────────────────────┤  {tool:{...}} + _meta.fallback
```

The browser never learns the fallback exists: it calls one proxy path, and the proxy reports the
serving facts in `_meta` / `X-Model-Tier` / `X-Model-Id`, which the HUD footer already renders
(`TIER:open-weights`, `MUSE:llama-3.2-11b-vision`).

## Deploy

Weights: `meta-llama/Llama-3.2-11B-Vision-Instruct` is **gated** (`gated=manual`), so it needs licence
acceptance on the HF account plus `HF_TOKEN` in the secret. `unsloth/Llama-3.2-11B-Vision-Instruct` is a
**public mirror of the same weights** and needs no token at all - the first deploy used it, which is why
no HF account was required. Point `FALLBACK_MODEL` at whichever you have access to.

```bash
pip install modal
modal setup                                   # browser login, once

# keep the bearer token in a local dotenv outside the repo so it never reaches a command line
#   ~/.linecheck/fallback.env  ->  FALLBACK_API_KEY=<random-long-string>
#                                  HF_TOKEN=hf_...   (only for the gated meta-llama repo)
modal secret create --from-dotenv ~/.linecheck/fallback.env linecheck-fallback --force

# FALLBACK_MODEL is read at DEPLOY time, not request time: changing the model is a redeploy.
FALLBACK_MODEL=unsloth/Llama-3.2-11B-Vision-Instruct modal deploy fallback/modal_app.py
```

The app raises at startup if a gated model has no `HF_TOKEN`, rather than silently waiting out a
download that can never succeed (`FALLBACK_REQUIRE_HF_TOKEN=true|false` overrides the heuristic).

`modal deploy` prints the URL, e.g.

```
https://<workspace>--linecheck-fallback-serve.modal.run
```

## Wire it into the proxy

```bash
# the only three settings that matter
export META_OPEN_WEIGHTS_SPARK_URL=https://<workspace>--linecheck-fallback-serve.modal.run/v1/chat/completions
export META_OPEN_WEIGHTS_MODEL=llama-3.2-11b-vision
export MODAL_API_KEY=<the FALLBACK_API_KEY above>
export FALLBACK_MODE=auto          # off = never fail over
export PROXY_SPARK_PROTOCOL=openai # vLLM speaks OpenAI, so the Spark adapter must too
```

Copy `fallback/.env.example` for the full list. Never put `MODAL_API_KEY` or `HF_TOKEN` in any
`VITE_*` variable - Vite inlines those into the browser bundle (repo rule, AGENTS.md #2).

## The toggle, precisely

| situation | behaviour |
|---|---|
| `FALLBACK_MODE=off` (default) | primary failure is returned as-is; fallback never called |
| `FALLBACK_MODE=auto`, primary 2xx | primary serves; fallback untouched |
| `FALLBACK_MODE=auto`, primary 5xx/429/408/409/timeout/network error | refund primary, retry on the fallback tier, stamp `_meta.fallback` |
| primary 4xx | **no** failover - the same malformed request would fail everywhere |
| caller sends `x-model-tier: open-weights` | straight to the fallback, never a primary attempt, never labelled as a failover |
| this proxy's own budget refusal (429) | returned immediately; failover cannot spend past the operator's ceiling |
| after a failover | primary bypassed for `FALLBACK_COOLDOWN_MS` (default 60 s), reason `circuit_open` |

## Verification (all runnable without a Modal account)

```bash
# 1. the contract checker, against its own in-process fake (no GPU, no network)
node fallback/contract.mjs --self-test

# 2. the 9-case proxy failover suite: real proxy process, real ledger, local fake upstreams
node --test harness/tests/proxy-fallback.test.mjs

# 3. after deploying: does the real endpoint hold the contract?
node fallback/contract.mjs --url https://<workspace>--linecheck-fallback-serve.modal.run --key $FALLBACK_API_KEY

# 4. browser proof, no credits: rehearse the failover in the HUD
node fallback/dev-fixtures.mjs &                       # primary DOWN on 8901, fallback on 8902
FALLBACK_MODE=auto PROXY_SPARK_PROTOCOL=openai PROXY_PORT=8795 \
META_API_KEY=test-meta \
META_SAM_URL=http://127.0.0.1:8901/sam-3.1/segment \
META_MUSE_URL=http://127.0.0.1:8901/muse-audio/transcribe \
META_MUSE_SPARK_URL=http://127.0.0.1:8901/muse-spark/dispatch \
META_OPEN_WEIGHTS_SPARK_URL=http://127.0.0.1:8902/v1/chat/completions \
MODAL_API_KEY=test-partner-key \
node harness/proxy-server.mjs &
# build the HUD against the proxy (an .env.[mode].local file overrides .env.local, so the phone
# build in .env.local is left alone) and open it on http://127.0.0.1:8099, then press V
```

Measured on 2026-10-31 with fixtures 4 (not the real endpoint - no Modal credentials here):
`X-Fallback: primary->open-weights`, `X-Model-Tier: open-weights`, HUD footer
`MUSE:llama-3.2-11b-vision TIER:open-weights  LEDGER:$0.04000`, reticle
`WASTE: SALMON TRIM (900g - trim waste)`, ledger 6 paid calls / $0.04 net / $0.07 refunded.

## Honest status and limits

* **Deployed on Modal** (`zumayaaustin` workspace) against the public mirror
  `unsloth/Llama-3.2-11B-Vision-Instruct`; the live contract check is the acceptance test. Until that
  passes, the honest status is "built and verified against fakes".
* **No OpenAI `tool_calls` from this model.** Llama 3.2 Vision on vLLM does not emit tool calls, so
  the proxy sets a JSON-only instruction and parses the object out of the reply
  (`PROXY_FALLBACK_TOOL_JSON`, default on). If the model answers in prose the proxy declines to
  translate and the client's keyword fallback runs - a wrong guess here would invent a waste entry.
* **One image per prompt** (`--limit-mm-per-prompt {"image": 1}`): mllama in vLLM does not batch
  images. Multi-frame snapshot reasoning is out of scope.
* **`--enforce-eager` is required** for the mllama architecture, so this route is slower than the
  primary even warm.
* **vLLM is pinned to 0.8.5** because mllama support was deprecated in later releases; raising the
  pin can break the model load, not just a flag. Override with `FALLBACK_VLLM_VERSION` only after
  reading that release's notes.
* **Cold start** is 2-5 min on the first call (image build + 22 GB weights), ~40-90 s with the HF
  volume warm. `min_containers=0` keeps idle cost at zero; warm the route before walking on stage.
* **Scope: the Spark role only.** SAM 3.1 has no open-weight drop-in here; a segmentation fallback
  would be a different model and a different contract.

---

## Deployed route: Cloudflare Worker in front of Workers AI (live, free tier)

Modal's GPU functions require a payment method on the account regardless of credit balance, and
Llama 3.2 Vision cannot run on this laptop (Ollama and every LM Studio llama.cpp backend have dropped
the `mllama` architecture). So the fallback that actually runs is a **Cloudflare Worker** calling
Workers AI's `@cf/meta/llama-3.2-11b-vision-instruct` - same Meta weights, OpenAI-compatible face,
free daily neuron allowance, no card.

```
HUD -> proxy :8795 -> [primary dead] -> https://linecheck-fallback.zumayaaustin.workers.dev
                                         -> env.AI.run(@cf/meta/llama-3.2-11b-vision-instruct)
```

| piece | path |
|---|---|
| Worker source | `fallback/worker/src/index.mjs` |
| Worker config | `fallback/worker/wrangler.toml` (AI binding, model id) |
| Unit tests (no account needed) | `fallback/worker/test.mjs` - `node --test fallback/worker/test.mjs` |
| Deployed URL | `https://linecheck-fallback.zumayaaustin.workers.dev` |

Wiring:

```bash
export META_OPEN_WEIGHTS_SPARK_URL=https://linecheck-fallback.zumayaaustin.workers.dev/v1/chat/completions
export META_OPEN_WEIGHTS_MODEL=llama-3.2-11b-vision
export MODAL_API_KEY=<FALLBACK_API_KEY from ~/.linecheck/fallback.env>
export FALLBACK_MODE=auto
export PROXY_SPARK_PROTOCOL=openai
```

Redeploy:

```bash
cd fallback/worker
npx wrangler deploy                       # prints the URL
npx wrangler secret put FALLBACK_API_KEY  # from stdin, never as an argument
```

### Four things that only showed up against the real endpoint

1. **The model is licence-gated at Workers AI.** Every inference returns `5016 ... you must submit
   the prompt 'agree'` until the account accepts. The acceptance call needs the model's native
   `prompt` shape, which an OpenAI request never carries, so the Worker exposes
   `POST /__agree` (bearer-protected, idempotent). A successful acceptance is *reported as the same
   5016 error* with the text "Thank you for agreeing..." - the route treats that as success.
2. **A top-level `image` parameter is deprecated and silently ignored.** Bytes travel fine and the
   model answers "There is no image" with text-only prompt tokens (~21 instead of ~1600). Images must
   travel **inside `messages`** as OpenAI content parts. Measured: 64x64 red PNG -> "Red." and 1,623
   prompt tokens.
3. **Workers AI parses a JSON-looking reply into an object**, so `content` arrived as
   `{tool:{...}}` and any string consumer saw `"[object Object]"`. The Worker now stringifies
   non-string replies, keeping OpenAI's contract (`content` is a string).
4. **The model invents tool names when it is not given any.** With `tools` forwarded it returns
   native `tool_calls`; without them it answered bare names like `Inventory` / `calculate_waste`.
   Two guards: the Worker forwards `tools`, and the proxy refuses a tool name the caller never
   offered (`shapeFallbackToolJson`) rather than creating state the app cannot handle.

The proxy also rewrites the system prompt **only on the fallback attempt** (`buildFallbackSystem`),
stating the allowed tool names and the JSON shape with an example - measured necessary when the model
would otherwise answer with a bare name and no arguments.

### Measured, 2026-10-31 (live Cloudflare route)

```
contract: 6/6  (health, models, text, image, tool-JSON, wrong-bearer 401)
proxy:    HTTP 200  X-Fallback: primary->open-weights  X-Model-Tier: open-weights
          body {tool:{name:"record_waste",arguments:{ingredient:"salmon trim",weight_g:900,reason:"trim"}}}
worker unit tests: 9/9      proxy failover suite: 11/11
```

Not yet done on this route: the in-browser HUD pass (the footer/telemetry proof was run against the
local fixture, which exercises the same code path).


---

# Fallback Vision — Open-Weight Vision on Cloudflare Workers

## Architecture

```mermaid
flowchart TD
    subgraph PROXY["Proxy :8790"]
        F_TIER{Fallback Router}
        F_COOL[Cooldown 60s]
        F_BUILD[Build Fallback Prompt
{tools} + {example}]
    end

    subgraph CF["Cloudflare Worker"]
        W_API[/v1/chat/completions/]
        W_AI[Workers AI
@cf/meta/llama-3.2-11b-vision-instruct]
        W_KV[KV Rate Limit
60 req/min]
    end

    PROXY -->|FALLBACK_MODE=auto| F_TIER
    F_TIER -->|open-weights| F_BUILD
    F_BUILD -->|OpenAI wire format| W_API
    W_API --> W_AI
    W_API --> W_KV
    W_AI -->|tool JSON| W_API
    W_API -->|tool JSON| PROXY
    PROXY -->|Re-reserve + Refund| LEDGER[Spend Ledger]
```

## Deploy

```bash
cd fallback/worker
# 1. Auth
npx wrangler login

# 2. Set secret (stdin)
echo "sk-..." | npx wrangler secret put FALLBACK_API_KEY

# 3. Deploy
npx wrangler deploy
# Creates https://linecheck-fallback.<subdomain>.workers.dev
```

## Test

```bash
# Health
curl https://linecheck-fallback.zumayaaustin.workers.dev/health

# Vision completion
curl -X POST https://linecheck-fallback.zumayaaustin.workers.dev/v1/chat/completions   -H "Authorization: Bearer $FALLBACK_API_KEY"   -H "Content-Type: application/json"   -d '{
    "model": "llama-3.2-11b-vision",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "What kitchen containers do you see?"},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
      ]
    }],
    "tools": [{"type": "function", "function": {"name": "record_waste", "parameters": {...}}}]
  }'
```

## Rate Limit Headers

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 59
X-RateLimit-Reset: 1700000000
```

## Free Tier Limits

- Workers: 100,000 requests/day
- Workers AI: ~10,000 neurons/day (vision ≈ 0.6 neurons/call)
- No credit card required for this tier
