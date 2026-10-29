# System Architecture Spec - LineCheck Vision

## Hardware / Target Specs

- HUD Resolution: **600x600 px, fixed canvas** (`HUD_SIZE`, `src/config/constants.ts`)
- Streaming: local WebMCP IPC socket (planned); browser canvas loop today
- Colour language: cyan `#00F0FF` nominal, yellow `#FCEE0A` warning, magenta `#BD00FF` breach

## Pipeline Flow

1. **Audio capture & intent** - one bounded 2.2 s `getUserMedia` window per wake event
   (`src/mic.ts`) -> Muse Voice Transcribe -> Muse Spark 1.3 parser -> `{transcription, tool, arguments}`
2. **Visual segmentation** - snapshot event -> SAM 3.1 -> bounding boxes in **1280x720 source
   coordinates**
3. **Normalisation** - `normalizeToHud()` (`src/mcp/normalize.ts`) scales 1280x720 -> 600x600,
   clamps every box inside the canvas, drops non-finite detections, resolves reticle status
4. **Execution boundary** - the public demo UI is decoupled from core private repositories
   (`AGENTS.md`); no LineTare logic is present here

## Invariants

1. **No paid endpoint is ever called on a timer.** SAM runs on an explicit snapshot event, Muse
   on an explicit wake event. The `requestAnimationFrame` loop is pure drawing and touches no
   network. Verified: 0 fetch calls across 4 s of animation frames.
2. **Nothing reaches the UI unless it is in HUD space.** The canvas is fixed at 600x600 and must
   never draw outside itself, whatever frame size or coordinate convention the model returns.
   Asserted by 13 CI tests and 11 in-browser self-tests, including 500 randomised boxes.
3. **A mock is never mistakable for a live call.** The canvas draws
   `SAM 3.1: LIVE` or `SAM 3.1: MOCK (<reason>)`.

## Trust boundaries

| boundary | rule |
|---|---|
| browser -> model | no credential in the bundle; talk to `harness/proxy-server.mjs`, which injects the key and enforces `MAX_PAID_CALLS` |
| client -> mock | `harness/mock-server.mjs` requires `Bearer <MOCK_META_TOKEN>` so the 401 path is exercised too |
| public repo -> private IP | `AGENTS.md` boundary: harness only |

## Coordinate contract

`normalizeToHud(detections, frame, hud = 600)` accepts:

- `{x, y, width, height}` or `{x1, y1, x2, y2}`
- source pixels **or** already-normalised `0..1` (auto-detected)
- optional `fill_percentage` / `fillPercentage`; explicit `status` wins over the fill heuristic
- fill `< 20` or `> 90` => `warning`, otherwise `nominal`

Rounding happens **before** clamping. Clamping the float and rounding afterwards produced a
1 px overflow (`x=412.5,w=187.5` -> `x=413,w=188` -> `x+w=601` on a 600 px canvas).
