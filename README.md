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
| "verify pan depth 4-inch hotel pan" | `verify_pan_depth` - warns when fill is out of the 20-90% band |

---

## Architecture

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
| `S` | one SAM 3.1 snapshot |
| `M` | hold a 2.2s microphone capture, then send to Muse |
| `W` | toggle the hands-free wake word |
| `C` | restart the camera capture |
| `V` | one Muse utterance using synthetic audio |
| `1` `2` `3` `4` | tare_scale · calculate_yield · verify_pan_depth · record_waste |
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
