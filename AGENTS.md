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
5. **Never commit secrets or local state.** `.env*`, `.remember/`, `node_modules/`, `dist/`,
   `.testdist/` and `.cache/` are ignored. Session transcripts and the spend ledger stay out of
   the repo.
6. **Budget ceilings are enforced before the network call.** The proxy reserves cost, checks
   `MAX_PAID_CALLS` / `MAX_SPEND_USD` / `MAX_SESSION_SPEND_USD`, and only then calls upstream.
   Never move a budget check after the fetch.
7. **Sensory input degrades, it does not fail.** Camera and microphone both fall back (synthetic
   frame, synthetic audio) so `S`, `V` and the wake word work with no hardware and in headless
   runs.

## Verification expectations

Before claiming a change works, run:

```bash
cd harness/webmcp
npx tsc --noEmit      # types
npm test              # 50 assertions: coordinates, wake word, tiers, tool dispatch
npm run build         # production bundle

# from the repo root - the fallback route and its switch
node fallback/contract.mjs --self-test        # OpenAI-compatible contract checker
node --test harness/tests/proxy-fallback.test.mjs   # 11 failover cases, real proxy + real ledger
node --test fallback/worker/test.mjs          # 9 Worker translation cases, no account needed
```

Then exercise it in a browser. A green build is not evidence the HUD renders correctly: several
runtime defects in this repo compiled cleanly and were only found by running it - a banner drawn
under the header, a label plate narrower than its text, tools stranded in `PROCESSING`, a wake
word reporting itself active while erroring, and a replay cache that never hit because it hashed
a random multipart boundary.

## Layout

| path | role |
|---|---|
| `harness/webmcp/` | the app: canvas loop, HUDStore, Meta client, normaliser, tools, mic |
| `harness/mock-server.mjs` | local SAM 3.1 + Muse contracts, zero dependencies |
| `harness/proxy-server.mjs` | server-side key proxy with a hard call ceiling and primary->open-weights failover |
| `fallback/` | Modal app serving Llama 3.2 Vision as an OpenAI-compatible endpoint, plus its contract checker and rehearsal fixtures |
| `harness/tests/proxy-fallback.test.mjs` | the 9-case failover suite (refunds, triggers, breaker, budget gates) |
| `harness/sam-3.1/`, `harness/muse-audio/` | contract fixtures |
| `specs/architecture/System-Spec.md` | pipeline, invariants, coordinate contract |
| `sprints/Sprint-01.md` | budget allocation and deliverable status |

## Current honest status

Working: HUD + store + 4 tools, coordinate normalisation, mock/live switch, snapshot and voice
throttling, local mock contracts, key proxy with ceiling, microphone capture with fallback.

Not working yet: live Meta calls (the live branch has only ever spoken to the local mock), wake
word, real camera frames.

Fallback route (`fallback/`): **live** as a Cloudflare Worker over Workers AI
(`@cf/meta/llama-3.2-11b-vision-instruct`) at
`https://linecheck-fallback.zumayaaustin.workers.dev`, OpenAI-compatible, free tier, no card.
6/6 contract checks against the deployed endpoint, 11/11 proxy failover cases, 9/9 Worker unit tests.
`fallback/modal_app.py` (self-hosted vLLM on Modal) is built and image-validated but cannot deploy
without a payment method on the Modal account; it stays as the self-hosted option.
