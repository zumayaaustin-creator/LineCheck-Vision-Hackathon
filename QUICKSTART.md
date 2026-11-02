# LineCheck Vision — 90-Second Judge Quick-Start

> **No API keys required.** Runs entirely on local mocks by default.

## One-Command Start

```bash
git clone https://github.com/zumayaaustin-creator/LineCheck-Vision-Hackathon.git
cd LineCheck-Vision-Hackathon/harness/webmcp
npm install && npm run dev
```

Open **http://localhost:5173** — you see a 600×600 cyber-dark HUD.

---

## Test the Four Kitchen Actions (keys 1–4)

| Key | Tool | What Happens |
|-----|------|--------------|
| `1` | `tare_scale` | Sets tare to 0g, updates telemetry panel |
| `2` | `calculate_yield` | Logs 75% yield (2200g → 1650g) |
| `3` | `verify_pan_depth` | 15% fill → **warning** reticle |
| `4` | `record_waste` | 450g Pork Collar → **ALERT** reticle |

Press **`T`** → Telemetry panel slides out (right side) showing:
- Live inventory balances
- Waste & Yield logs
- Active tare / container
- Ledger save status

Press **`0`** to clear all reticles.

---

## Test SAM 3.1 Snapshot (Press `S`)

Requires the mock server running:

```bash
# Terminal 2
cd LineCheck-Vision-Hackathon/harness
node mock-server.mjs
# Listening on http://127.0.0.1:8787
```

Create `harness/webmcp/.env.local`:
```env
VITE_USE_MOCK_META=false
VITE_META_API_KEY=local-test-token
VITE_SAM_MODEL_ENDPOINT=http://127.0.0.1:8787/sam-3.1/segment
VITE_MUSE_AUDIO_ENDPOINT=http://127.0.0.1:8787/muse-audio/transcribe
```

Restart `npm run dev`. Press **`S`** — HUD renders 4 detection boxes:
- ✅ Hotel Pan 68% nominal
- ⚠️ Salmon Trim 12% **warning**
- ✅ Scale Tare 55%
- 📏 Overflow (clamped to canvas edge)

---

## Test Voice Chain (Press `V` or `M`)

- `V` — synthetic audio, instant
- `M` — real 2.2s mic capture (falls back to synthetic)

Flow: Audio → Muse Transcribe → Spark Tool Pick → WebMCP Execute → Kitchen Ledger.

---

## Run Full Stack (Proxy + Budget + Fallback)

```bash
# Terminal 3: Proxy with budget enforcement
cd harness
META_API_KEY=local-test-token UPSTREAM_BASE=http://127.0.0.1:8787 node proxy-server.mjs
# http://127.0.0.1:8790

# Check spend ledger
curl http://127.0.0.1:8790/__usage
```

---

## Run Tests (CI Gate)

```bash
cd harness
node --test tests/proxy-fallback.test.mjs
# ✅ 11/11 pass: failover, budget, circuit breaker, tier routing, cache
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
├── README.md                    ← This guide + architecture diagrams
├── AGENTS.md                    ← Contribution boundaries
├── harness/
│   ├── mock-server.mjs          ← Local contract server (no deps)
│   ├── proxy-server.mjs         ← Key proxy + budget + cache + tiers
│   ├── tests/proxy-fallback.test.mjs
│   ├── webmcp/                  ← 600×600 HUD (TypeScript + Vite)
│   │   ├── src/main.ts          ← Canvas loop, hotkeys, snapshots
│   │   ├── src/hud/state.ts     ← Reactive HUDStore
│   │   ├── src/mcp/normalize.ts ← 1280×720 → 600×600 clamp
│   │   ├── src/mcp/tools.ts     ← 4 WebMCP tools + dispatch
│   │   ├── src/mcp/client.ts    ← MetaModelClient (mock/live)
│   │   └── src/mic.ts           ← Bounded 2.2s capture
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
