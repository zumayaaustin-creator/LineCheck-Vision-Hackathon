# LineCheck Vision — 90-Second Judge Quick-Start

> **No API keys required.** Runs entirely on local mocks by default.

## One-Command Start

```bash
git clone https://github.com/zumayaaustin-creator/LineCheck-Vision-Hackathon.git
cd LineCheck-Vision-Hackathon/harness/webmcp
npm install && npm run dev
```

Open **http://localhost:5173** — you see a 600×600 cyber-dark HUD on a kitchen photo. The footer
reads `SAM 3.1: MOCK (VITE_USE_MOCK_META)`: this is a recorded-response demo, labelled as such.

---

## Drive the Demo

| Key | What it does |
|-----|--------------|
| `1` `2` `3` `4` | Load demo photo 1–4 (clears the previous photo's reticles) |
| `S` | Snapshot: the HUD draws reticles on the loaded photo |
| `V` | One voice command: plays the next line of a 7-line script |
| `T` | Pin / unpin the **ledger card** (it also pops up for 8 s on every new entry) |
| `0` | Clear the HUD |

A good first run: press **`S`** on photo 1 (six prep containers → `1/6 PAN` reticles, one
warning, one breach), then press **`V`** a few times and watch the ledger card fill.

| Photo | Scene | Reticles |
|-------|-------|----------|
| `1` | Six prep containers | 1/6 pans of jalapenos, black olives, salsa, plus diced onion |
| `2` | Seasoned tri-tip on a sheet pan | TRI-TIP A / B / C |
| `3` | Pork roast on a cutting board | PORK ROAST |
| `4` | Pulled pork in a half pan | 1/2 PAN — PULLED PORK |

The photos live in `harness/webmcp/public/demo-frames/` (`scene-1.jpg` … `scene-4.jpg`); their
reticles are in `harness/webmcp/mock-device-kit/mockScenes.json`. Full details, the voice script
and how to add a photo are in the **Demo scenes** section of [`README.md`](README.md).

---

## Turn On the Kitchen Ledger (two terminals)

The reticles and voice need no server. The **ledger** does: each voice command is saved through
the proxy. Run both from the **repository root**.

```bash
# Terminal 2: local mock upstream (http://127.0.0.1:8787)
node harness/mock-server.mjs

# Terminal 3: the proxy (http://127.0.0.1:8790)
UPSTREAM_BASE=http://127.0.0.1:8787 META_API_KEY=local-test-token node harness/proxy-server.mjs
```

PowerShell: set `$env:UPSTREAM_BASE = "http://127.0.0.1:8787"` and
`$env:META_API_KEY = "local-test-token"` first. `local-test-token` is a throwaway string the mock
server checks, not a real credential.

Now press **`V`**. A row appears in the ledger card, for example `PAN 1/6 Pan 95%` or
`WASTE Pork Roast -450g Fat cap trim`.

```bash
curl http://127.0.0.1:8790/__kitchen/state     # full kitchen ledger (waste, yield, pan checks)
curl http://127.0.0.1:8790/__usage             # spend ledger
curl -X POST http://127.0.0.1:8790/__kitchen/reset   # empty the kitchen ledger
```

---

## The Four Kitchen Tools, Directly (Shift + 1–4)

These run a tool on the HUD without the voice chain, and do not write to the ledger.

| Key | Tool | What happens |
|-----|------|--------------|
| `Shift+1` | `tare_scale` | Sets the tare |
| `Shift+2` | `calculate_yield` | 75% yield (2200 g → 1650 g) |
| `Shift+3` | `verify_pan_depth` | 15% fill → **warning** reticle |
| `Shift+4` | `record_waste` | 450 g Pork Collar → **ALERT** reticle |

---

## Exercise the Real Fetch Path (optional)

This leaves mock mode and sends real HTTP requests to the mock server. With
`node harness/mock-server.mjs` running, create `harness/webmcp/.env.local`:

```env
VITE_USE_MOCK_META=false
VITE_META_API_KEY=local-test-token
VITE_SAM_MODEL_ENDPOINT=http://127.0.0.1:8787/sam-3.1/segment
VITE_MUSE_AUDIO_ENDPOINT=http://127.0.0.1:8787/muse-audio/transcribe
```

Restart `npm run dev` and press **`S`**: the HUD draws the mock server's generic boxes (hotel pan,
salmon trim, scale zone, an overflow box clamped to the canvas edge) rather than the photo's.

---

## Run Tests (CI Gate)

```bash
cd harness/webmcp
npm test                                    # 50 assertions: coordinates, wake word, tiers, tools

cd ../..
node --test harness/tests/proxy-fallback.test.mjs
# 11/11 pass: failover, budget, circuit breaker, tier routing, cache
```

---

## Live Vision Endpoint (Cloudflare Worker)

Already deployed for hackathon:
```
https://linecheck-fallback.zumayaaustin.workers.dev/v1/chat/completions
```
Model: `@cf/meta/llama-3.2-11b-vision-instruct` (Llama 3.2 11B Vision)
Rate limit: 60 req/min (KV token bucket)

---

## File Layout for Judges

```
LineCheck-Vision-Hackathon/
├── README.md                    ← Architecture diagrams, demo scenes, env contracts
├── AGENTS.md                    ← Contribution boundaries
├── harness/
│   ├── mock-server.mjs          ← Local contract server (no deps)
│   ├── proxy-server.mjs         ← Key proxy + budget + cache + tiers + kitchen ledger
│   ├── tests/proxy-fallback.test.mjs
│   ├── webmcp/                  ← 600×600 HUD (TypeScript + Vite)
│   │   ├── src/main.ts          ← Canvas loop, hotkeys, photo scenes, ledger card
│   │   ├── src/hud/state.ts     ← Reactive HUDStore
│   │   ├── src/mcp/normalize.ts ← 1280×720 → 600×600 clamp
│   │   ├── src/mcp/tools.ts     ← 4 WebMCP tools + dispatch
│   │   ├── src/mcp/client.ts    ← MetaModelClient (mock/live) + voice script
│   │   ├── src/mic.ts           ← Bounded 2.2s capture
│   │   ├── mock-device-kit/     ← mockScenes.json (per-photo boxes), mockDetections.json
│   │   └── public/demo-frames/  ← scene-1.jpg … scene-4.jpg
│   └── README.md                ← Contracts, injection, security
├── fallback/
│   ├── worker/                  ← Cloudflare Worker + Workers AI
│   ├── dev-fixtures.mjs         ← Offline rehearsal fixtures
│   └── contract.mjs             ← OpenAI wire format contract
└── specs/architecture/System-Spec.md
```

---

## What's Real vs Mock

| Component | Status |
|-----------|--------|
| HUD canvas, store, 4 tools | ✅ Working |
| Demo photo scenes + per-photo reticles | ✅ Working (mock mode) |
| Scripted voice demo + kitchen ledger card | ✅ Working (mock mode) |
| Kitchen ledger (proxy-side, persisted to `.cache/`) | ✅ Working |
| Coordinate normalization + clamping | ✅ Tested |
| Snapshot/voice throttling + in-flight guards | ✅ Working |
| Mic capture + graceful fallback | ✅ Working |
| Proxy: budget ledger, replay cache, reconciliation | ✅ Working |
| Proxy: model tiers + tier-keyed cache | ✅ Working |
| Spark wire adapter (OpenAI format) | ✅ Built, verified |
| SAM 3.1 adapter (Responses API) | ✅ Built, verified |
| **Live Meta endpoints** | ❌ Mock contracts only |
| Muse Voice Transcribe (real) | ❌ Not wired |

**Every dollar shown is the proxy's simulation. Actual spend = $0.00.**
