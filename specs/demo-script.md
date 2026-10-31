# LineCheck Vision - three minute demo (shot list)

Deadline: submissions due **Wed 2026-11-04 21:00 ET / 18:00 PT**. Record on Nov 2, edit Nov 3,
submit Nov 3 evening. This script exists so the recording is mechanical, not improvised.

Run the app in proxy mode with the mocks (`harness/proxy-server.mjs` + `harness/mock-server.mjs`),
open `http://127.0.0.1:8099`, and say plainly what is live and what is simulated - the judging
criteria for the indie track are creativity, technical ambition and whether it works, and an honest
simulated pipeline scores better than an overclaim that a judge can spot.

## Before you hit record

- Cold state: ledger 0 calls / $0.00, replay cache empty, mock transcript cursor at `record_waste`.
  (The proxy and mock both start that way after a fresh start with `.cache/demo-*` removed.)
- Window 1280x720 or larger, browser zoom 100%, HUD frame fully visible, no other tabs.
- Console visible in a second window for the honest-technical shots; close anything with a key in it.
- One dry run, then record. Do not record while debugging.

## 0:00 - 0:20  The problem

Voice over, no UI yet: "Line kitchens lose money in grams, not dollars. Trim on a case of salmon, a
pan that is under par at service, a yield guess that is 5% off. Nobody writes it down because writing
it down means stopping work."

## 0:20 - 0:50  The HUD and a snapshot

- Show the 600x600 HUD, cyan on black, `SAM 3.1: LIVE`. Say what the badge means in this build:
  "LIVE means the app is not using its local mock cache - it is calling the endpoint it is
  configured with, which in this recording is a contract mock of the Meta API. I will say when
  anything is live against Meta's real models."
- Press `S`. Four reticles appear. Point at `OVERFLOW PROBE (RIGHT EDGE)` and say: "the box is flush
  with the canvas edge at 600 - every detection is normalised into HUD space and clamped there, and
  that is asserted in CI, not eyeballed."
- Say what SAM is: segmentation that returns boxes and masks, one concept per call.

## 0:50 - 1:40  The agentic chain (the core of the entry)

- Press `M` and speak the canned line: **"log two pounds of salmon trim waste."**
- As it runs, narrate the three hops visible in the console:
  1. Muse Voice Transcribe turns the audio into text.
  2. Muse Spark picks a tool *from the schema we published*, not from a prompt: `record_waste`.
  3. The HUD executes it - `WASTE: SALMON TRIM (907g - Trim waste)`, status ALERT.
- Point at the footer: `MUSE:muse-spark-1.3  TIER:primary  CACHE:MISS  LEDGER:$0.02692`.
- Press `V` again with the same audio: `CACHE:HIT`, the ledger does not move. "A repeat costs nothing
  because the request is content-addressed, and that is why a demo cannot burn the credit."

## 1:40 - 2:10  The other two verbs, deterministically

- Press `2`: `YIELD: 75.0% (EP: 1650g / AP: 2200g)`.
- Press `3`: `1/6 PAN DEPTH: 15%`, warning.
- Say: "same registry the model calls, exercised directly - the tools are not a prompt trick."

## 2:10 - 2:40  Open weights

- Press `F`. Footer turns magenta: `MUSE:muse-spark-open-1026  TIER:open-weights`.
- Press `V`. Same chain, served by the open-weight route.
- Say: "same tools, same contract, different model behind it - one header changes the route, and the
  replay cache is keyed per tier so a hosted answer can never be served as an open-weight one."

## 2:40 - 3:00  Architecture and honesty

- Cut to a simple diagram or the README table: browser holds no key -> proxy holds it, enforces a
  $5 session / $120 lifetime ceiling with refunds on failure, and stamps `_meta` on every response.
- Close with the honest line: "the HUD, the tool chain and the budget machinery are real. The model
  endpoints in this recording are mock contracts that mirror the API shapes; actual spend is $0.00.
  The Spark adapter is ready for a live key, and that is the next commit."

## What must be on screen at least once

- [ ] `SAM 3.1: LIVE` (never a mock badge while claiming live)
- [ ] `CACHE:MISS` then `CACHE:HIT` with an unchanged ledger
- [ ] footer with tier + model id + ledger in both colours
- [ ] a tool call that mutates HUD state

## Do not claim

- production readiness, real kitchen deployment, or measured weights from a physical scale
- glasses hardware - this is a simulator
- live model calls if the recording ran on mocks
