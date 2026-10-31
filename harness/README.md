# LineCheck Vision harness

Local mock contracts that let you exercise the **real** Meta `fetch()` paths - Bearer auth,
JSON parsing, error handling, throttling over an actual network hop - without spending a
single SAM 3.1 or Muse credit.

No dependencies. Node's built-in `http` only.

---

## Fallback route (open-weight Meta vision, Modal)

`harness/proxy-server.mjs` can fail over from the primary Meta route to an open-weight tier when the
primary errors. The served endpoint lives in `fallback/` (Modal + vLLM, Llama 3.2 Vision, OpenAI
wire format). Switch it on with `FALLBACK_MODE=auto`; see `fallback/README.md` for the deploy, the
exact trigger rules, and how to rehearse the whole thing offline with `fallback/dev-fixtures.mjs`.

---

## Run the mock server

```bash
node harness/mock-server.mjs                 # http://127.0.0.1:8787
MOCK_PORT=9000 node harness/mock-server.mjs  # different port
```

```
  LineCheck mock contract server
  http://127.0.0.1:8787
  token: local-test-token
  routes: /sam-3.1/segment  /muse-audio/transcribe  /health  /__simulate
  simulate: latency | slow | 401 | 500
```

---

## Point the app at it (zero-credit live path)

Create `harness/webmcp/.env.local` (gitignored):

```
VITE_USE_MOCK_META=false
VITE_META_API_KEY=local-test-token
VITE_SAM_MODEL_ENDPOINT=http://127.0.0.1:8787/sam-3.1/segment
VITE_MUSE_AUDIO_ENDPOINT=http://127.0.0.1:8787/muse-audio/transcribe
VITE_SNAPSHOT_MIN_INTERVAL_MS=1500
VITE_SOURCE_FRAME_WIDTH=1280
VITE_SOURCE_FRAME_HEIGHT=720
```

Then `npm run build` (or `npm run dev`) inside `harness/webmcp`.

Delete `.env.local` to fall back to the mock-first default. The app shows
`SAM 3.1: LIVE` or `SAM 3.1: MOCK (<reason>)` on the canvas so the mode is never ambiguous.

> **Security:** Vite inlines every `VITE_*` value into the built bundle, so anything you put
> here is readable by anyone with the JS file. `local-test-token` is a fake. **Never put a real
> Meta API key in `VITE_META_API_KEY`** - proxy it server-side for anything that ships.

---

## SAM 3.1 contract - `sam-3.1/detections.mjs`

`POST /sam-3.1/segment`

Request: `{ "frame": <base64|null>, "width": 1280, "height": 720 }`
Reply:

```json
{
  "detections": [
    { "id": "sam-pan-1", "label": "1/3 Hotel Pan - Sliced Tomato",
      "x": 120, "y": 180, "width": 320, "height": 210,
      "confidence": 0.96, "fill_percentage": 68 },
    { "id": "sam-salmon-trim", "label": "Salmon Trim Zone",
      "x": 560, "y": 140, "width": 280, "height": 190,
      "confidence": 0.91, "fill_percentage": 12 },
    { "id": "sam-scale-zone", "label": "Scale Tare Zone",
      "x": 900, "y": 430, "width": 260, "height": 170,
      "confidence": 0.88, "fill_percentage": 55 },
    { "id": "sam-overflow", "label": "Overflow Probe (Right Edge)",
      "x": 1180, "y": 300, "width": 300, "height": 200, "confidence": 0.74 }
  ],
  "meta": { "model": "sam-3.1-mock", "sourceFrame": {"width":1280,"height":720},
            "overflowBoxRight": 1480, "simulated": true }
}
```

Deliberately **unnormalised 1280x720 pixel coordinates** so `src/mcp/normalize.ts` has to do the
real work. The last box has a right edge of **1480** on a 1280-wide frame - it exists purely to
prove clamping puts it back inside the 600x600 canvas (`x=459 w=141 right=600`).

`fill_percentage: 12` on the salmon trim exercises the `<20 => warning` status rule.

---

## Muse audio contract - `muse-audio/transcripts.mjs`

`POST /muse-audio/transcribe` (multipart, field `audio`, optional field `hint`)

Returns a transcript that resolves to exactly one WebMCP tool, with arguments already in the
units `src/mcp/tools.ts` expects:

| transcript | tool | arguments |
|---|---|---|
| "log 2 pounds of salmon trim waste" | `record_waste` | `salmon trim, 907 g, Trim waste` |
| "calculate yield on 15 pounds whole chicken down to 10.5 pounds" | `calculate_yield` | `ap 6804 g, ep 4762 g` -> 70% |
| "tare scale for deep half pan" | `tare_scale` | `unit: g` |
| "verify pan depth 4-inch hotel pan" | `verify_pan_depth` | `4-inch Hotel Pan, 15%` -> warning |

Calls cycle through the four in order, or force one with `?scenario=record_waste` (also accepts
`hint` in the multipart body). Unit conversion deliberately happens **here**, mirroring a real
Muse Spark 1.3 parser, so the tool layer only ever receives grams.

Reply:

```json
{ "transcription": "log 2 pounds of salmon trim waste",
  "reply": "Logged 907 g of salmon trim. That is a 12% loss on the case.",
  "action": "NOTIFY_PREP",
  "tool": { "name": "record_waste",
            "arguments": { "ingredient": "Salmon Trim", "weight_g": 907, "reason": "Trim waste" } },
  "meta": { "model": "muse-mock", "scenario": "record_waste", "audioBytes": 2048 } }
```

---

## Voice chain - three hops, each metered

`Muse Audio -> Muse Spark 1.3 -> WebMCP` runs as three observable steps rather than one opaque
call:

```
POST /muse-audio/transcribe   $0.02   "log 2 pounds of salmon trim waste"
POST /muse-spark/dispatch     $0.03   -> record_waste { Salmon Trim, 907 g }
executeTool()                 $0.00   -> hudStore + HUD
```

`harness/muse-audio/spark-dispatch.mjs` is the Spark 1.3 stand-in: it takes a transcript plus the
offered tools and returns exactly one tool call with arguments already in grams. Keyword-based on
purpose - it is a stand-in, not a parser.

## Latency & error injection

Per request:

```
POST /sam-3.1/segment?simulate=latency   # +600 ms
POST /sam-3.1/segment?simulate=slow      # +2500 ms - long enough to catch an in-flight guard
POST /sam-3.1/segment?simulate=401       # 401, even with a valid token
POST /sam-3.1/segment?simulate=500       # 500
```

Or set a sticky default so no rebuild is needed between failure modes:

```bash
curl -X POST 'http://127.0.0.1:8787/__simulate?mode=401'
curl -X POST 'http://127.0.0.1:8787/__simulate?mode=none'   # clear
```

Auth runs **before** the 500 injection deliberately, so `?simulate=500` proves HTTP-error
handling and `?simulate=401` proves auth-failure handling - two different paths in the client.

---

---

## Proxy server - keeping the key out of the browser

`harness/proxy-server.mjs` holds the Meta credential server-side and forwards the two routes
the HUD needs. **This is the recommended path for anything real**, because Vite inlines every
`VITE_*` value into the browser bundle - a key in `VITE_META_API_KEY` is public.

```bash
META_API_KEY=sk-... \
META_SAM_URL=https://api.example.com/sam-3.1/segment \
META_MUSE_URL=https://api.example.com/muse-audio/transcribe \
node harness/proxy-server.mjs                     # http://127.0.0.1:8790
```

Rehearse the whole chain with no internet and no key of value:

```bash
UPSTREAM_BASE=http://127.0.0.1:8787 META_API_KEY=local-test-token \
MAX_PAID_CALLS=60 node harness/proxy-server.mjs
```

Then the browser config needs **no credential at all**:

```
VITE_USE_MOCK_META=false
VITE_USE_PROXY=true
VITE_SAM_MODEL_ENDPOINT=http://127.0.0.1:8791/sam-3.1/segment
VITE_MUSE_AUDIO_ENDPOINT=http://127.0.0.1:8791/muse-audio/transcribe
```

`VITE_USE_PROXY=true` tells the client that the missing key is correct rather than a
misconfiguration - without it `shouldUseMock()` would refuse to leave the mock path.

### Spend ledger - persistent USD budget

Three ceilings, all checked **before** the upstream request:

| guard | default | scope |
|---|---|---|
| `MAX_PAID_CALLS` | 60 | hard call count |
| `MAX_SPEND_USD` | 120.00 | lifetime, **survives restarts** |
| `MAX_SESSION_SPEND_USD` | 5.00 | this process run only |

Per-route estimates (override these with real pricing):

| route | env var | default |
|---|---|---|
| `/sam-3.1/segment` | `COST_PER_SAM_CALL_USD` | $0.05 / frame |
| `/muse-audio/transcribe` | `COST_PER_MUSE_AUDIO_USD` | $0.02 / clip |
| `/muse-spark/dispatch` | `COST_PER_MUSE_SPARK_USD` | $0.03 / dispatch |

The ledger persists to `.cache/spend-ledger.json` (gitignored) so a restart does not reset spend:

```json
{ "totalSpendUsd": 0.18, "paidCalls": 4, "cacheHits": 1,
  "byRoute": { "sam": {"calls": 3, "spendUsd": 0.15}, ... } }
```

Refusals are `429` with a reason - `call_cap_reached`, `budget_exceeded`, or
`session_budget_exceeded` - and never reach the network.

**Charge semantics:** the next call's cost is reserved *before* the upstream request so a crash
still counts it. A non-2xx or unreachable upstream is refunded and logged as `refundedUsd`,
otherwise one misconfigured URL would burn the whole budget on 401s. Both are recorded, so the
ledger never quietly under-reports.

`GET /__usage` returns `{paidCalls, totalSpendUsd, remainingUsd, cacheHits, failedCalls,
refundedUsd, sessionSpendUsd, byRoute, ...}`. The HUD shows `remainingUsd` on its status bar when
`VITE_PROXY_USAGE_URL` is set.

> These per-call costs are **estimates**, not Meta's published prices. Replace them before
> trusting the $120 figure - the mechanism is right, the constants are guesses.

### Usage reconciliation - self-calibrating costs

The `COST_PER_*` values above are **estimates**. After every 2xx response the proxy reads the
upstream body and reconciles the reservation against reality:

1. **Pre-call reservation** still uses the conservative floor, so ceilings block before firing.
2. **Post-response** it looks for `usage` (`total_cost_usd`, `prompt_tokens`,
   `completion_tokens`, `duration_seconds`, `billed_seconds`) in the JSON, and captures
   billing-ish headers (`x-ratelimit-*`, `x-request-id`, cost/usage headers).
3. The **first** raw usage block + headers per route is written verbatim to
   `.cache/live-usage-sample.json` (gitignored) - exact telemetry from call #1, so the constants
   can be replaced with real numbers rather than guesses.
4. If an explicit cost exists, the ledger is adjusted by the delta. If only tokens/seconds are
   reported, they are converted **only when a price constant is configured**:

```
PRICE_PROMPT_USD_PER_1K=0
PRICE_COMPLETION_USD_PER_1K=0
PRICE_AUDIO_USD_PER_SECOND=0
```

All zero by default - inventing a price is worse than keeping the conservative floor. When
nothing usable is reported the proxy logs `NO-RECONCILE ... keeping the floor`.

Response headers: `X-Proxy-Cost` (reserved) and `X-Proxy-Cost-Actual` (reconciled, or `unknown`).
`/__usage` adds `reconciledCalls` and `reconciledUsd`.

### Replay cache - pay once per unique request

`PROXY_CACHE_MODE=record-or-replay` (default; also `record-only`, `off`).

Requests are hashed (`SHA-256` over route + canonicalised body) into `.cache/replay/<hash>.json`.
A hit is served at **$0.00**, no upstream call is made, `cacheHits` increments, and the response
carries `X-Proxy-Cache: hit`. A successful live response is written back automatically, so a
unique frame or voice command is only ever paid for once.

**multipart is canonicalised**: the boundary is randomly generated per request, so hashing raw
upload bytes makes every audio POST look unique and the cache never hits. Bodies are reduced to
sorted `field -> content-hash` pairs instead, which is stable across boundaries.

Other knobs: `PROXY_PORT`, `PROXY_TIMEOUT_MS` (30 s), `PROXY_ALLOWED_ORIGINS` (CORS allowlist),
`PROXY_CACHE_DIR`, `PROXY_LEDGER_PATH`.

---

### Model tiers - primary vs open-weights

`/muse-spark/dispatch` can be served from two places, chosen per request:

| header | tier | upstream | key |
|---|---|---|---|
| *(absent)* | `primary` | `META_MUSE_SPARK_URL` (or `UPSTREAM_BASE`) | `META_API_KEY` |
| `x-model-tier: open-weights` | `open-weights` | `META_OPEN_WEIGHTS_SPARK_URL` (or `BASETEN_MODAL_OPEN_URL`) | `BASETEN_API_KEY` / `MODAL_API_KEY`, else `META_API_KEY` |

The same tier can be requested in the JSON body as `"tier": "open-weights"` - the header wins.
SAM and Muse audio are not tiered; the header is ignored on those routes.

Every JSON response is stamped so the HUD footer can name the route that actually served it
without a second call to `/__usage`:

```json
"_meta": {
  "activeRoute": "spark", "modelTier": "open-weights", "modelId": "muse-spark-open-1026",
  "cached": false, "costUsd": 0.03, "actualCostUsd": null,
  "ledgerSpentUsd": 0.0371, "sessionSpendUsd": 0.0371, "cacheHits": 0
}
```

The same values ride on `X-Model-Tier`, `X-Model-Id` and `X-Proxy-Ledger-Usd`, which are listed
in `Access-Control-Expose-Headers` so browser code can read them. Stamping happens **when the
response is served, never before it is cached** - a cached body must not carry another run's
ledger total.

Three refusals, all `400` and all before any charge:

| error | when |
|---|---|
| `unknown_model_tier` | the header names something other than `primary` / `open-weights` |
| `tier_not_configured` | the tier exists but its URL env var is unset |

Neither falls back silently: a typo must not spend on the expensive route while reporting the
cheap one, and a misrouted open-weights call must not be labelled open-weights while hitting
Meta.

**The tier is part of the replay-cache key** (`route:spark:<tier>`). Without it, an identical
transcript would replay the primary answer for an open-weights request at $0.00 and the HUD would
name the wrong model - see commit history for the test that pins this.

Cost stays a flat per-call floor (`COST_PER_OPEN_WEIGHTS_CALL_USD`, default = the Spark cost)
because the proxy never sees an invoice line; it reconciles against whatever the upstream
reports and otherwise keeps the floor.

### Live path - the real Meta Model API

The browser only ever speaks one dialect: `{transcript, tools}` in, `{tool:{name,arguments}}` out.
Meta Model API speaks OpenAI (`messages` + `tools` in, `choices[0].message.tool_calls[]` out), so the
proxy translates. Nothing in the HUD changes when it goes live.

| env | default | meaning |
|---|---|---|
| `PROXY_SPARK_PROTOCOL` | `linecheck` | `openai` switches the Spark route to the real wire format |
| `META_MUSE_SPARK_URL` | - | `https://api.meta.ai/v1/chat/completions` |
| `META_API_KEY` | - | your `MODEL_API_KEY` - server-side only, never `VITE_*` |
| `META_SPARK_MODEL` | `muse-spark-1.3` | model id sent upstream |
| `PROXY_SPARK_MAX_TOKENS` | `256` | `max_tokens` for the live call |
| `PROXY_SPARK_SYSTEM` | tool-calling bias | system prompt; prose is unusable downstream |

What it does, exactly:

- **Request:** wraps the transcript in `[system, user]`, wraps each tool as
  `{type:'function', function:…}`, sets `tool_choice:'auto'`, and substitutes the model id.
- **Response:** reads `choices[0].message.tool_calls[0]`, JSON-parses `function.arguments`, and emits
  the linecheck shape with `rationale` and `upstream_model` kept for the log. **If there is no tool
  call, or the body is not that shape, it is returned untouched** - a translator that guesses is
  worse than one that declines, and the client's own keyword fallback still runs.
- Translation happens **before** the cache key is computed, so switching protocol invalidates the
  replay cache instead of replaying a body shaped for the other dialect.

Verified against a fake upstream that speaks the OpenAI wire format: the proxy sent `model=muse-spark-1.3`, `tool_choice=auto`, `messages=[system,user]`,
`tools=[{type:function,…}]`; it returned
`{"tool":{"name":"record_waste","arguments":{"ingredient":"Salmon Trim","weight_g":907,"reason":"Trim waste"}}}`,
`_meta.actualCostUsd` reconciled to the upstream's `usage.total_cost_usd` ($0.00864 against a $0.03
reserve), and the second identical call was a cache hit with the same shape.

#### SAM 3.1 - the same trick, for a different call

SAM is not a different *shape*, it is a different *call*: `POST /v1/responses`, model `sam-3.1`, one
`input_text` **noun phrase per concept** plus one `input_image`, `stream: true`. The answer streams a
special-token grammar in `output_text`:

```
text<0f>1<|box;x1=444;y1=600;x2=675;y2=849;w=1800;h=1200;c=0.93|><|mask;x=0;y=0;data=226,236,!...|>,2<|box;...|>
```

`PROXY_SAM_PROTOCOL=meta` makes the proxy build that request and read it back:

| env | default | meaning |
|---|---|---|
| `PROXY_SAM_PROTOCOL` | `linecheck` | `meta` switches the SAM route to the Responses API |
| `META_SAM_URL` | - | `https://api.meta.ai/v1/responses` |
| `META_SAM_MODEL` | `sam-3.1` | model id |
| `PROXY_SAM_CONCEPT` | `hotel pan` | the noun phrase to segment (one concept per call) |
| `PROXY_SAM_INCLUDE_CONFIDENCE` | unset | ask for per-box `c=` confidence |

**Only the box tokens are read.** The HUD needs boxes, not rasters, so the mask payloads are ignored
entirely - no base85 decoding, no `@meta-sam/parser` dependency. Boxes carry the media's own `w`/`h`,
so the adapter rescales them into the frame size the caller declared (a 1800x1200 answer to a
1280x720 request comes back in 1280x720 space, and `x2`/`y2` are inclusive per the grammar). Zero
matches is a successful empty result and returns `{detections: []}`.

Verified against a fake streaming upstream: request carried `model=sam-3.1`, `stream=true`,
`input=[{type:message, role:user, content:[input_text, input_image]}]`; 1800x1200 boxes arrived
rescaled to 1280x720 (`x1=444 -> 316`, width `232 -> 165`), confidence 0.93 where present and 0.8
where absent, a zero-match prompt returned an empty list, and `_meta` was stamped with
`activeRoute: sam` and the `$0.05` reserve - which required relabelling the shaped body as
`application/json` instead of passing the upstream's `text/event-stream` through.

**Still not wired: Muse Voice Transcribe.** It is multipart with a `request` settings part plus the
audio, close enough to our current body to be an adapter rather than a rewrite, but it has not been
built.

#### Tool schemas in the payload

Spark needs the tool definitions to pick one. The HUD sends them, but a bare `curl` does not, so
the proxy injects `harness/webmcp/tools.json` when the body has no `tools` array - **before** the
cache key is computed, so replay stays deterministic. That file is generated from
`webmcp/src/mcp/tools.ts`, which stays the single source of truth:

```
cd harness/webmcp && npm run gen:tools
```

## Microphone capture

`harness/webmcp/src/mic.ts` records one bounded window (2.2 s) via `getUserMedia` +
`MediaRecorder`, then releases the device. Same rule as SAM: one wake event, one call - never an
always-on stream.

Every failure resolves to a readable message and the HUD falls back to a synthetic audio Blob, so
the voice path stays testable on machines with no mic:

| failure | message |
|---|---|
| `NotAllowedError` | `microphone permission denied` |
| `NotFoundError` | `no microphone device found` |
| `NotReadableError` | `microphone is in use by another application` |

Verified in a headless browser with no device permission: it logged
`mic unavailable (microphone permission denied) - using synthetic audio` and still completed the
Muse -> WebMCP tool call.

---

## Camera and wake word

`src/camera.ts` captures a real webcam frame at 1280x720 and passes its **true** dimensions into
the SAM snapshot, so `normalizeToHud()` scales from what the camera produced rather than an
assumed constant. No camera, no permission, or no API all fall back to a deterministic synthetic
frame - a snapshot is always possible, only the source changes. The HUD shows
`FRAME: camera live` or `FRAME: synthetic 1280x720 (reason)`.

`src/wakeword.ts` adds a hands-free trigger, $0.00 against the Meta budget, in two backends:

| mode | what | honesty note |
|---|---|---|
| `speech` | `SpeechRecognition` phrase match on "line check" / "hey line check" | most Chromium builds back this with a remote service; it costs no Meta credit but is not guaranteed on-device. On-device processing is requested where the build supports it. |
| `vad` | RMS energy gate over an `AnalyserNode` | genuinely on-device, but it detects that someone spoke, not which words |

`VITE_WAKE_MODE=auto` prefers on-device speech, then VAD. If both fail the HUD reports
`WAKE: unavailable` with a reason and everything else keeps working. The wake trigger shares the
in-flight guards with `S` and `V`, and is paused during its own capture so the tail of the
recording cannot retrigger it.

## Keyboard harness (in the HUD)

| key | action |
|---|---|
| `S` | one SAM 3.1 snapshot (mock or live, depending on `VITE_USE_MOCK_META`) |
| `V` | one Muse voice utterance -> resolves to a WebMCP tool -> executes it |
| `M` | same as `V` but captures from the real microphone first |
| `1` | `tare_scale` |
| `2` | `calculate_yield` |
| `3` | `verify_pan_depth` (15% -> warning) |
| `4` | `record_waste` (-> ALERT) |
| `C` | restart the camera capture |
| `W` | toggle the wake word listener |
| `0` | clear |

Both `S` and `V` are guarded by an in-flight flag plus a debounce, and the client adds its own
`VITE_SNAPSHOT_MIN_INTERVAL_MS` floor - so neither can be driven from an animation frame even
if the UI is changed to try.

## Hackathon contributions (Oct 26 - Nov 4, 2026)

Built during the Meta Global AI Developer Hackathon. LineCheck's proprietary kitchen-costing logic is
**not** in this repository (`AGENTS.md` boundary); this harness is the demo surface around it.

| what | state |
|---|---|
| 600x600 HUD, snapshot-only SAM path, coordinate contract with CI + in-browser self-tests | working |
| Four WebMCP tools with real schemas, dispatch into HUD state, argument validation | working |
| Voice chain: transcribe -> Spark -> tool call -> execution, one bounded capture per wake | working |
| Server-side proxy: key isolation, spend ledger, replay cache, per-call reconciliation | working |
| Model tiers (`primary` / `open-weights`) with tier-keyed cache and serve-time `_meta` | working |
| Spark wire-protocol adapter for the real Meta Model API | built, verified against a fake upstream |
| SAM 3.1 adapter (Responses API, grammar -> boxes, concept prompt) | built, verified against a fake streaming upstream |
| Muse Voice Transcribe against the real API | **not wired** - mock contract only |
| Offline queue | **not built** |

**Honesty note for judges:** the HUD, the tool chain and the budget machinery are real and run end
to end; the three model endpoints behind the proxy are mock contracts that mirror the shapes we
designed against. Every dollar figure shown is the proxy's simulation - actual spend on this build
is $0.00. The Spark adapter is the one path that is ready for a live key.
