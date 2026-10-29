# LineCheck Vision harness

Local mock contracts that let you exercise the **real** Meta `fetch()` paths - Bearer auth,
JSON parsing, error handling, throttling over an actual network hop - without spending a
single SAM 3.1 or Muse credit.

No dependencies. Node's built-in `http` only.

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

**Cost guard:** `MAX_PAID_CALLS` (default 60) is a hard ceiling. Past it the proxy returns
`429 paid_call_cap_reached` and refuses to forward. `GET /__usage` shows
`{paidCalls, maxPaidCalls, remaining}`.

Other knobs: `PROXY_PORT`, `PROXY_TIMEOUT_MS` (30 s), `PROXY_ALLOWED_ORIGINS` (CORS allowlist).

---

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
| `0` | clear |

Both `S` and `V` are guarded by an in-flight flag plus a debounce, and the client adds its own
`VITE_SNAPSHOT_MIN_INTERVAL_MS` floor - so neither can be driven from an animation frame even
if the UI is changed to try.
