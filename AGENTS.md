# AGENTS.md — LineCheck Vision Isolation Boundary

## Workspace Scope

- Target Drive: D:\ (external SSD, KingSpec Z5)
- Active Hackathon Scope: Meta Global AI Developer Hackathon
- Primary UI: WebMCP Ray-Ban 600x600 HUD Display Canvas
- Model Chain: Muse Voice Transcribe -> Muse Spark 1.3 -> SAM 3.1 Overlay

## Hard Boundaries

1. Core LineTare / zero-trace proprietary logic MUST NOT be committed to public demo harnesses.
2. Maintain local mock layers for testing without exhausting Meta API credits.

## Non-negotiables for anyone (or any agent) changing this repo

1. **No paid model call on a timer.** SAM 3.1 fires on an explicit snapshot event, Muse on an
   explicit wake event. `render()` must never call the network - it only draws `HUDStore` state.
2. **No credential in the browser bundle.** Vite inlines every `VITE_*` value into the shipped
   JS. Use `harness/proxy-server.mjs` with `VITE_USE_PROXY=true`; the proxy holds the key and
   enforces `MAX_PAID_CALLS`.
3. **Mock-first is the default.** `VITE_USE_MOCK_META` unset means mock. The HUD draws
   `SAM 3.1: MOCK (<reason>)` so a mock run cannot be mistaken for a live one.
4. **Everything is normalised into 600x600 before the UI sees it.** `normalizeToHud()` owns that
   conversion; do not feed raw model coordinates to `hudStore`.
5. **Never commit secrets or local state.** `.env*`, `.remember/`, `node_modules/`, `dist/` and
   `.testdist/` are ignored. Session transcripts stay out of the repo.

## Verification expectations

Before claiming a change works, run:

```bash
cd harness/webmcp
npx tsc --noEmit      # types
npm test              # 13 coordinate-contract assertions
npm run build         # production bundle
```

Then exercise it in a browser. A green build is not evidence the HUD renders correctly: three
runtime defects in this repo (banner drawn under the header, label plate narrower than its text,
tools stranded in `PROCESSING`) all compiled cleanly.

## Layout

| path | role |
|---|---|
| `harness/webmcp/` | the app: canvas loop, HUDStore, Meta client, normaliser, tools, mic |
| `harness/mock-server.mjs` | local SAM 3.1 + Muse contracts, zero dependencies |
| `harness/proxy-server.mjs` | server-side key proxy with a hard call ceiling |
| `harness/sam-3.1/`, `harness/muse-audio/` | contract fixtures |
| `specs/architecture/System-Spec.md` | pipeline, invariants, coordinate contract |
| `sprints/Sprint-01.md` | budget allocation and deliverable status |

## Current honest status

Working: HUD + store + 4 tools, coordinate normalisation, mock/live switch, snapshot and voice
throttling, local mock contracts, key proxy with ceiling, microphone capture with fallback.

Not working yet: live Meta calls (the live branch has only ever spoken to the local mock), wake
word, real camera frames.
