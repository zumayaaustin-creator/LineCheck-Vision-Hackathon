# LineCheck Vision

A kitchen prep and waste-tracking HUD for Ray-Ban-class display hardware. You talk to it, it
looks at the pan in front of you, and it tells you what is wrong before service does.

Built for the **Meta Global AI Developer Hackathon**.

---

## The problem

Commercial kitchens lose money to three things nobody measures in real time: over-portioning,
prep that runs short mid-service, and waste that never gets logged because logging it means
stopping work to write something down. The waste logs that do get written are reconstructed
from memory at close, which is why they are fiction.

LineCheck Vision puts the measurement where the work already happens - in front of the person
holding the pan - so recording it costs a glance and a sentence instead of a clipboard.

---

## What it does

A 600x600 HUD canvas renders detection reticles over whatever the camera sees, with each box
coloured by urgency. Voice drives the same four actions the touch UI would.

| You say | It does |
|---|---|
| "log 2 pounds of salmon trim waste" | `record_waste` - flags the trim zone, logs 907 g as loss |
| "calculate yield on 15 pounds whole chicken down to 10.5 pounds" | `calculate_yield` - 70%, drawn on the HUD |
| "tare scale for deep half pan" | `tare_scale` - zeroes the readout, draws a calibration box |
| "check the jalapeno pan" (a 1/6 pan at 55%) | `verify_pan_depth` - warns when fill is out of the 20-90% band |

---

## Architecture Diagram

```mermaid
flowchart TD
    subgraph HUD["600×600 HUD (harness/webmcp)"]
        direction TB
        PHOTO["Demo photos 1-4<br/>public/demo-frames"] --> CANVAS
        CAM[Camera 1280×720] --> SNAP[Snapshot Trigger S/M]
        PHOTO --> SNAP
        MIC[Microphone 2.2s] --> VOICE[Voice Trigger V/W]
        SNAP --> META[MetaModelClient]
        VOICE --> META
        META -->|mock mode, default| MOCK["Mock replay<br/>mockScenes.json boxes per photo<br/>7-line voice script"]
        META -->|live mode| SAM[SAM 3.1 Segment]
        META -->|live mode| MUSE[Muse Audio Transcribe]
        SAM --> NORM[normalizeToHud 1280×720 → 600×600]
        MUSE --> SPARK[Muse Spark Dispatch]
        MOCK --> STORE[HUDStore]
        MOCK --> TOOLS
        SPARK --> TOOLS[executeTool 4 tools]
        NORM --> STORE
        TOOLS --> STORE
        STORE --> CANVAS[Canvas Render Loop]
        CANVAS --> RET["Photo background + Reticles<br/>+ Status Bar + Ledger card"]
    end

    subgraph PROXY["Proxy Server (harness/proxy-server.mjs)"]
        direction TB
        PROXY_API[HTTP :8790] --> BUDGET[Budget Gates]
        BUDGET --> CACHE[Replay Cache SHA-256]
        CACHE --> TIER{Model Tier}
        TIER -->|primary| META_API[Meta API]
        TIER -->|open-weights| FALLBACK[Cloudflare Worker]
        FALLBACK --> KV[Rate Limit KV]
        META_API --> LEDGER[Spend Ledger]
        FALLBACK --> LEDGER
        LEDGER --> FILE[(.cache/spend-ledger.json)]
        CACHE --> CACHE_FILE[(.cache/replay/)]
    end

    subgraph KITCHEN["Kitchen Operations Ledger"]
        direction TB
        TOOLS -->|"POST /__kitchen/log (voice chain)"| KPROXY[Proxy]
        KPROXY --> KFILE[(.cache/kitchen-ops-ledger.json)]
        KPROXY -->|saved state in the response| CARD["Ledger card inside the HUD<br/>T pins it, flashes 8s on a new entry"]
    end

    subgraph FALLBACK_SVC["Fallback Vision (fallback/)"]
        direction TB
        CF_WORKER[Cloudflare Worker] --> AI[Workers AI @cf/meta/llama-3.2-11b-vision-instruct]
        AI --> KV2[Rate Limit 60/min]
    end

    CAM -.->|frames| META
    MIC -.->|audio| META
    SNAP -.->|"base64 (live mode only)"| PROXY_API
    VOICE -.->|"multipart (live mode only)"| PROXY_API
    PROXY_API -.->|OpenAI wire| META_API
    PROXY_API -.->|OpenAI wire| FALLBACK
```

In **mock mode** (the default) nothing leaves the browser except the kitchen-ledger POST: the
reticles come from `mock-device-kit/mockScenes.json` and the voice lines from a scripted list in
`src/mcp/client.ts`. The proxy and fallback boxes only matter in live mode.

---

## Data Flow Diagram

```mermaid
sequenceDiagram
    participant U as User
    participant H as HUD (600×600)
    participant P as Proxy :8790
    participant M as Meta API / Cloudflare Worker
    participant K as Kitchen Ledger

    Note over U,H: Press 1-4 (load a demo photo)
    H->>H: Draw photo letterboxed, clear old reticles

    Note over U,H: Press S (Snapshot)
    alt Mock mode (default)
        H->>H: Look up the photo's boxes in mockScenes.json (no network)
    else Live mode
        H->>H: Capture camera frame 1280×720
        H->>P: POST /sam-3.1/segment {frame, w, h}
        P->>P: Budget check (3 ceilings)
        P->>P: Cache lookup (SHA-256)
        alt Cache hit
            P-->>H: Cached detections $0.00
        else Cache miss
            P->>M: Forward to Meta/Worker
            M-->>P: Detections 1280×720
            P->>P: Reserve cost, reconcile
            P-->>H: Fresh detections
        end
        H->>H: normalizeToHud() → 600×600
    end
    H->>H: Render reticles + status

    Note over U,H: Press V (Voice)
    alt Mock mode (default)
        H->>H: Next line of the 7-line script (transcript + tool call)
    else Live mode
        H->>H: Capture 2.2s audio
        H->>P: POST /muse-audio/transcribe (multipart)
        P->>M: Transcribe
        M-->>P: Transcript
        H->>P: POST /muse-spark/dispatch {transcript, tools}
        P->>M: Spark tool selection
        M-->>P: Tool call {name, args}
    end
    H->>H: executeTool()
    H->>K: POST /__kitchen/log {type, ...}
    K-->>H: Saved ledger state
    H->>H: Flash the ledger card for 8s
```

---

## Kitchen Operations Ledger Flow

```mermaid
flowchart LR
    subgraph TOOLS[WebMCP Tools]
        T1[record_waste]
        T2[calculate_yield]
        T3[tare_scale]
        T4[verify_pan_depth]
    end

    subgraph PROXY[Proxy /__kitchen/*]
        LOG[POST /log]
        STATE[GET /state]
        RESET[POST /reset]
    end

    subgraph STORE["Kitchen Ledger Store"]
        PAR[("parStock: per-ingredient parG and currG")]
        WASTE[("wasteLog[]")]
        YIELD[("yieldLog[]")]
        TARE[("activeContainer, activeTareG")]
        AUDIT[("panDepthAudit[]")]
    end

    CARD["Ledger card in the HUD<br/>newest 4 entries, T to pin"]

    T1 --> LOG
    T2 --> LOG
    T3 --> LOG
    T4 --> LOG
    LOG -->|mutate| PAR
    LOG -->|"append (record_waste)"| WASTE
    LOG -->|"append (calculate_yield)"| YIELD
    LOG -->|"update (tare_scale)"| TARE
    LOG -->|"append (verify_pan_depth)"| AUDIT
    LOG -->|"saved state in the response"| CARD
    STATE -->|"poll every 5s"| CARD
    RESET -->|clear| STORE
```

Only the **voice chain** (V, M, wake word) writes to the ledger. The proxy accepts both the short names (`waste`, `yield`)
and the WebMCP tool names the HUD actually sends (`record_waste`, `calculate_yield`).

---

## Demo scenes (mock mode)

In mock mode the HUD can sit on one of four real kitchen photos instead of a camera feed. The
photo is drawn **letterboxed** (the whole picture, aspect ratio kept, dark bars on the short
side) inside the 600×600 canvas, and pressing **S** draws that photo's reticles from
`harness/webmcp/mock-device-kit/mockScenes.json`.

| Key | Photo | What `S` draws |
|---|---|---|
| `1` | Six prep containers on a steel table (3:2) | Six `1/6 PAN` reticles: jalapenos ×2, black olives ×2, diced onion, salsa. One jalapeno pan warns, the onion pan breaches |
| `2` | Seasoned tri-tip on a sheet pan (1:1) | `TRI-TIP A / B / C`, B warns |
| `3` | Pork roast on a cutting board (4:3) | `PORK ROAST`, warns |
| `4` | Pulled pork in a half pan (16:9) | `1/2 PAN — PULLED PORK`, 90% fill |

How it behaves:

- The HUD opens on scene 1 with **no reticles**. Press `S` to have it "find" things.
- Switching scenes (`1`-`4`) clears the previous photo's reticles.
- Only the bundled demo photos use these boxes. An image you drag onto the HUD gets the generic
  `mockDetections.json` boxes instead, which will not line up with it.
- A loaded photo is drawn behind the reticles in preference to the live camera.

**Photos.** They live in `harness/webmcp/public/demo-frames/` as `scene-1.jpg` … `scene-4.jpg`.
If a file is missing, that slot falls back to the camera (or a synthetic frame) and the generic
boxes.

**Adding or changing a photo.** Boxes are in 600×600 HUD space *after* letterboxing. For an image
of `w × h` pixels with a box at `(x, y, bw, bh)` in image pixels:

```
s        = 600 / max(w, h)
canvasX  = x * s + (600 - w * s) / 2
canvasY  = y * s + (600 - h * s) / 2
canvasW  = bw * s        canvasH = bh * s
```

### Voice script (mock mode)

Each press of `V` plays the next line, so the transcript, the tool the HUD runs and the ledger
row all agree. It loops after the seventh line and restarts on a page refresh.

| # | Transcript | Tool | Ledger row |
|---|---|---|---|
| 1 | "Check prep level on the diced onion" | `verify_pan_depth` 1/6 Pan, 95% | `PAN 1/6 Pan 95%` |
| 2 | "Log pork roast trim, four hundred fifty grams, fat cap" | `record_waste` Pork Roast, 450 g | `WASTE Pork Roast -450g Fat cap trim` |
| 3 | "Check the jalapeno pan" | `verify_pan_depth` 1/6 Pan, 55% | `PAN 1/6 Pan 55%` |
| 4 | "Yield on the tri-tip, twenty-two hundred purchased, sixteen fifty edible" | `calculate_yield` 2200 / 1650 | `YIELD 75.0% EP 1650g / AP 2200g` |
| 5 | "Check the black olives" | `verify_pan_depth` 1/6 Pan, 80% | `PAN 1/6 Pan 80%` |
| 6 | "Log salsa waste, three hundred grams, expired" | `record_waste` Salsa, 300 g | `WASTE Salsa -300g Expired` |
| 7 | "Check the pulled pork half pan" | `verify_pan_depth` 1/2 Pan, 90% | `PAN 1/2 Pan 90%` |

### Ledger card

Press `T` to pin the **ledger card** open or closed. It sits inside the HUD, above the footer
strip, and lists the newest four entries (`WASTE`, `YIELD`, `PAN`) with the entry count and the
scale tare in its header. It also appears on its own for about 8 seconds whenever a new entry is
saved. The full ledger is at `http://127.0.0.1:8790/__kitchen/state` and on disk in
`.cache/kitchen-ops-ledger.json`.

---

## Quick-Start (90 seconds)

### Prerequisites
- Node 18+ (tested on 20)
- No Meta API key needed - runs on local mocks by default

### 1. Clone & Install
```bash
git clone https://github.com/zumayaaustin-creator/LineCheck-Vision-Hackathon.git
cd LineCheck-Vision-Hackathon/harness/webmcp
npm install
```

### 2. Run Mock-First (zero credits, zero keys)
```bash
npm run dev
# Opens http://localhost:5173
# The HUD footer reads: SAM 3.1: MOCK (VITE_USE_MOCK_META)
```

### 3. Drive the demo

| Key | Action |
|-----|--------|
| `1` `2` `3` `4` | load demo photo 1-4 (clears the old reticles) |
| `S` | snapshot: draw the loaded photo's reticles |
| `V` | one voice command: plays the next line of the voice script |
| `M` | capture the real microphone (synthetic if no device), then run the voice chain |
| `W` | toggle the hands-free wake word ("line check") |
| `T` | pin / unpin the ledger card |
| `C` | restart the camera capture |
| `F` | cycle the model tier |
| `0` | clear the HUD |

### 4. Turn on the kitchen ledger (optional, two terminals)

In mock mode the reticles and voice need no server. The ledger does: `V` posts each entry to
the proxy. Run both from the **repository root**, because the proxy reads
`harness/webmcp/tools.json` and writes `.cache/` relative to where it starts.

```bash
# terminal 1: local mock upstream (http://127.0.0.1:8787)
node harness/mock-server.mjs

# terminal 2: the proxy (http://127.0.0.1:8790)
UPSTREAM_BASE=http://127.0.0.1:8787 META_API_KEY=local-test-token node harness/proxy-server.mjs
```

On PowerShell, set `$env:UPSTREAM_BASE = "http://127.0.0.1:8787"` and
`$env:META_API_KEY = "local-test-token"` before `node harness/proxy-server.mjs`.
`local-test-token` is a throwaway string the mock server checks, not a real credential.

- `GET /__usage` shows the spend ledger, `GET /__kitchen/state` the kitchen ledger.
- `POST /__kitchen/reset` empties the kitchen ledger (do this before recording a clean take).

### 5. Exercise the real fetch path against the mock server

This leaves mock mode and sends real HTTP requests to the mock server, which returns generic
(non-photo) boxes. With `node harness/mock-server.mjs` running, create `harness/webmcp/.env.local`:

```
VITE_USE_MOCK_META=false
VITE_META_API_KEY=local-test-token
VITE_SAM_MODEL_ENDPOINT=http://127.0.0.1:8787/sam-3.1/segment
VITE_MUSE_AUDIO_ENDPOINT=http://127.0.0.1:8787/muse-audio/transcribe
```

Restart `npm run dev`. Press `S` → the HUD shows the mock server's detections:
- 1/3 Hotel Pan (68% fill, nominal)
- Salmon Trim Zone (12% fill, **warning**)
- Scale Tare Zone (55% fill)
- Overflow Probe (clamped to canvas edge)

Press `V` → synthetic audio → mock Muse transcript → Spark tool pick → tool executes → ledger.

### 6. Run Tests
```bash
cd harness/webmcp
npm test
# 50 assertions: coordinates, wake word, tiers, tool dispatch

cd ../..
node --test harness/tests/proxy-fallback.test.mjs
# 11/11 pass: failover, budget, circuit breaker, tier routing
```

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `VITE_USE_MOCK_META` | `true` | `false` = hit real/mock upstream |
| `VITE_USE_PROXY` | `false` | `true` = browser calls proxy, no key needed |
| `VITE_META_API_KEY` | `""` | **Never put real key here** — Vite inlines it |
| `VITE_SAM_MODEL_ENDPOINT` | - | Override SAM endpoint |
| `VITE_MUSE_AUDIO_ENDPOINT` | - | Override Muse endpoint |
| `VITE_WAKE_MODE` | `auto` | `speech` \| `vad` \| `auto` |
| `VITE_SNAPSHOT_MIN_INTERVAL_MS` | `1500` | Client-side throttle floor |
| `PROXY_PORT` | `8790` | Proxy HTTP port |
| `META_API_KEY` | `""` | **Server-side only** — real key lives here |
| `UPSTREAM_BASE` | - | Base URL for all Meta endpoints |
| `MAX_PAID_CALLS` | `60` | Hard call ceiling |
| `MAX_SPEND_USD` | `120.00` | Lifetime USD ceiling (persists) |
| `MAX_SESSION_SPEND_USD` | `5.00` | Per-process ceiling |
| `PROXY_CACHE_MODE` | `record-or-replay` | `off` \| `record-only` |
| `FALLBACK_MODE` | `off` | `auto` = primary→open-weights failover |
| `FALLBACK_TIER` | `open-weights` | Fallback tier name |

---

## Fallback Mock Responses

The mock server (`harness/mock-server.mjs`) returns these exact shapes:

### SAM 3.1 Segment
```json
POST /sam-3.1/segment
{
  "frame": "<base64>", "width": 1280, "height": 720
}
→
{
  "detections": [
    {"id":"sam-pan-1","label":"1/3 Hotel Pan - Sliced Tomato","x":120,"y":180,"width":320,"height":210,"confidence":0.96,"fill_percentage":68},
    {"id":"sam-salmon-trim","label":"Salmon Trim Zone","x":560,"y":140,"width":280,"height":190,"confidence":0.91,"fill_percentage":12},
    {"id":"sam-scale-zone","label":"Scale Tare Zone","x":900,"y":430,"width":260,"height":170,"confidence":0.88,"fill_percentage":55},
    {"id":"sam-overflow","label":"Overflow Probe (Right Edge)","x":1180,"y":300,"width":300,"height":200,"confidence":0.74}
  ],
  "meta": {"model":"sam-3.1-mock","sourceFrame":{"width":1280,"height":720},"overflowBoxRight":1480,"simulated":true}
}
```

### Muse Audio Transcribe
```json
POST /muse-audio/transcribe (multipart: audio, hint?)
→
{
  "transcription": "log 2 pounds of salmon trim waste",
  "reply": "Logged 907 g of salmon trim. That is a 12% loss on the case.",
  "action": "NOTIFY_PREP",
  "tool": {"name":"record_waste","arguments":{"ingredient":"Salmon Trim","weight_g":907,"reason":"Trim waste"}},
  "meta": {"model":"muse-mock","scenario":"record_waste","audioBytes":2048}
}
```

### Muse Spark Dispatch
```json
POST /muse-spark/dispatch
{"transcript": "...", "tools": [...]}
→
{
  "tool": {"name": "record_waste", "arguments": {"ingredient": "Salmon Trim", "weight_g": 907, "reason": "Trim waste"}},
  "confidence": 0.95,
  "source": "mock",
  "telemetry": {"modelTier": "primary"}
}
```

### Kitchen Ledger State
```json
GET /__kitchen/state
→
{
  "version": 1,
  "parStock": {"Default Ingredient": {"parGrams": 5000, "currentGrams": 5000, "unit": "g"}},
  "wasteLog": [],
  "yieldLog": [],
  "activeContainer": null,
  "activeTareGrams": 0,
  "panDepthAudit": [],
  "createdAtUtc": "...", "updatedAtUtc": "..."
}
```

---

## Verify Your Build

```bash
# 1. Lint + TypeCheck + Build
cd harness/webmcp && npm run build

# 2. Proxy tests (11/11)
cd ../.. && node --test harness/tests/proxy-fallback.test.mjs

# 3. Open HUD
npm run dev  # or serve dist/ with http-server
# Open http://localhost:5173 (or https://localhost:8081 with mkcert)
```

---

## Security Checklist

- [ ] No `VITE_META_API_KEY` with real value in repo
- [ ] Proxy runs server-side with `META_API_KEY`
- [ ] `MAX_PAID_CALLS` and `MAX_SPEND_USD` set for production
- [ ] `PROXY_ALLOWED_ORIGINS` restricted to your domains
- [ ] `.cache/` gitignored (contains spend ledger + replay cache)


```
  camera frame ──snapshot (S key / snapshot event)──┐
                                                    ▼
                                          ┌──────────────────┐
  microphone ──2.2s capture (M key)──►    │   MetaModelClient │
                                          │  mock │ live      │
                                          └────────┬─────────┘
                     SAM 3.1 ◄─────────────────────┤
                     (boxes in 1280x720)           │
                                                   ▼
                                    normalizeToHud()  1280x720 -> 600x600
                                    clamp · status · drop bad
                                                   │
                                                   ▼
                                          ┌──────────────────┐
                                          │    HUDStore      │  typed, subscribable
                                          │ IDLE LISTENING   │
                                          │ PROCESSING ALERT │
                                          └────────┬─────────┘
                                                   ▼
                                      600x600 canvas render loop
                                                   ▲
                     Muse Voice ◄──────────────────┤
                     (transcript + tool call)      │
                                                   ▼
                                    executeTool() -> tools.ts (4 tools)
```

Two rules hold the whole thing together:

1. **Nothing calls a paid endpoint on a timer.** SAM runs on an explicit snapshot event, Muse on
   an explicit wake event. The render loop is pure drawing and never touches the network -
   verified at 0 fetch calls across 4 seconds of animation frames.
2. **Everything the model returns is normalised into HUD space before the UI sees it.** The HUD
   is a fixed 600x600 and must never draw a box outside itself, whatever the model sends.

---

## Running it

```bash
cd harness/webmcp
npm install
npm run dev          # http://localhost:5173
npm run build        # -> dist/
```

Out of the box it runs **entirely on local mocks** - no key, no credits, no network.

### Keyboard map

| key | action |
|---|---|
| `S` | one snapshot (SAM 3.1 in live mode, the photo's mock boxes in mock mode) |
| `M` | hold a 2.2s microphone capture, then run the voice chain |
| `W` | toggle the hands-free wake word |
| `C` | restart the camera capture |
| `V` | one voice command (the next scripted line in mock mode, synthetic audio in live mode) |
| `1` `2` `3` `4` | load demo photo 1-4 |
| `T` | pin / unpin the ledger card |
| `F` | cycle the model tier |
| `0` | clear the HUD |

### Going live without spending anything

`harness/mock-server.mjs` implements both contracts locally, so the real `fetch()` path can be
exercised for free. `harness/proxy-server.mjs` keeps the credential server-side. See
[`harness/README.md`](harness/README.md) for both, plus failure injection
(`?simulate=latency|slow|401|500`).

---

## Status, stated plainly

| part | state |
|---|---|
| HUD canvas, store, 4 kitchen tools | **working** |
| Coordinate normalisation 1280x720 -> 600x600 | **working, tested against edge cases** |
| Mock-first / live switch | **working** |
| Snapshot + voice throttling | **working** |
| Local mock contracts (SAM 3.1 + Muse) | **working** |
| Server-side key proxy with cost ceiling | **working** |
| Microphone capture | **working, with graceful fallback** |
| USD spend ledger + reconciliation | **working** - persistent, self-calibrating from upstream usage |
| Content-addressed replay cache | **working** - pay once per unique frame/command |
| Real camera capture | **working** - 1280x720 with synthetic fallback |
| Wake word ("line check") | **working** - speech recognition, VAD fallback, $0.00 |
| Demo photo scenes (1-4) with per-photo reticles | **working** - mock mode, boxes in `mockScenes.json` |
| Scripted 7-line voice demo | **working** - mock mode, transcript, tool and ledger row agree |
| Kitchen ledger card inside the HUD | **working** - `T` pins it, flashes on each new entry |
| Live Meta SAM 3.1 / Muse calls | **not yet** - contract shapes settled, real endpoints not wired |

The live branch has only ever spoken to the local mock. It has never contacted Meta, and no real
API key exists in this repository.

---

## Layout

```
specs/architecture/System-Spec.md   hardware and pipeline intent
sprints/Sprint-01.md                budget allocation and deliverable checklist
AGENTS.md                           isolation boundary for contributors and agents

harness/mock-server.mjs             local contract server (no dependencies)
harness/proxy-server.mjs            server-side key proxy + cost ceiling
harness/sam-3.1/detections.mjs      SAM contract fixture (unnormalised 1280x720)
harness/muse-audio/transcripts.mjs  Muse contract fixtures -> the four tools
harness/README.md                   contracts, injection modes, security notes

harness/webmcp/src/main.ts          canvas loop, hotkeys, snapshot + voice triggers
harness/webmcp/src/config/env.ts    mock-first env resolution
harness/webmcp/src/hud/state.ts     typed reactive HUDStore
harness/webmcp/src/mcp/normalize.ts 1280x720 -> 600x600 with clamping
harness/webmcp/src/mcp/tools.ts     the four WebMCP tools + dispatch
harness/webmcp/src/mcp/client.ts    MetaModelClient, mock and live branches
harness/webmcp/src/mic.ts           bounded microphone capture
harness/webmcp/mock-device-kit/mockScenes.json     per-photo reticles (600x600, letterboxed)
harness/webmcp/mock-device-kit/mockDetections.json generic fallback reticles
harness/webmcp/public/demo-frames/  scene-1.jpg ... scene-4.jpg demo photos
```

---

## Security note

Vite inlines every `VITE_*` value into the browser bundle. A Meta API key placed in
`VITE_META_API_KEY` would be readable by anyone who loads the page. Use `harness/proxy-server.mjs`
and `VITE_USE_PROXY=true`: the browser then holds no credential at all, and the proxy enforces a
hard `MAX_PAID_CALLS` ceiling.

---

## The boundary

`AGENTS.md` defines this repo as the **public demo harness**. LineTare and LineCheck Live
proprietary logic deliberately lives elsewhere and is not present here, in any branch or commit.
