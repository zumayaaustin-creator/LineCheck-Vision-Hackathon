# Sprint & Quota Checklist

## Meta API Allocation

- Starting Budget: $150 Credit Limit
- Hard Cap Enforcement: Stop remote calls at $120 threshold
- Cache Strategy: Save local JSON responses for identical vision/audio passes

**Implemented so far:** `harness/proxy-server.mjs` enforces a hard `MAX_PAID_CALLS` ceiling
(default 60) and returns `429 paid_call_cap_reached` past it, with `GET /__usage` reporting
`{paidCalls, maxPaidCalls, remaining}`. That is a **call ceiling, not a dollar ceiling** - a
USD-accurate cap needs real per-request pricing from Meta, which is not yet known. Do not treat
the current guard as a $120 equivalent.

## Immediate Deliverables

- [x] Mount and verify project structure on D:\
      Structure verified and now under local git (7 commits). `harness/webmcp` holds the code,
      `specs/` and `sprints/` hold intent.
- [x] Implement local JSON replay cache for audio transcription
      Delivered as `harness/muse-audio/transcripts.mjs` + `harness/mock-server.mjs`: four canned
      transcripts that resolve to the four WebMCP tools, served over the real HTTP contract with
      Bearer auth. It is a mock contract, not a true cache - identical requests cycle rather than
      being memoised, and no real responses have been captured to replay yet.
- [x] Stand up 600x600 WebMCP canvas mock
      `harness/webmcp` renders a fixed 600x600 canvas with colour-coded reticles and four working
      tools (`record_waste`, `calculate_yield`, `tare_scale`, `verify_pan_depth`), driven by keys
      `S` (snapshot), `M`/`V` (voice), `1-4` (tools), `0` (clear).
- [x] Connect SAM 3.1 overlay to test frame feeds
      Connected to the **mock** SAM 3.1 contract over HTTP, not to Meta. Boxes arrive in
      unnormalised 1280x720 and are proven to normalise into 600x600 with the right-edge overflow
      clamped to exactly `right=600`. No real frame feed is wired; captures are synthetic.

## Next

- [ ] Wire the real Meta endpoints behind the proxy (`META_SAM_URL`, `META_MUSE_URL`)
- [ ] Replace the call ceiling with a USD-accurate budget stop at $120
- [ ] Wake-word detection to replace push-to-talk
- [ ] Real camera frame capture for the snapshot path
