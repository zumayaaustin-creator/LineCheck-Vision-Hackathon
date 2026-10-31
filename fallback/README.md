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

## Deploy (needs credentials - not yet done on this machine)

```bash
pip install modal
modal setup                                              # browser login, once
modal secret create linecheck-fallback \
    FALLBACK_API_KEY=<random-long-string> HF_TOKEN=hf_... # Llama 3.2 Vision is a gated repo
modal deploy fallback/modal_app.py
```

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

* **Not deployed.** No Modal token and no HF token exist on this machine, so `modal deploy` has not
  run. Everything above is verified against local fakes of the same wire contract.
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
