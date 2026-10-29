# Sprint & Quota Checklist

## Meta API Allocation

- Starting Budget: $150 Credit Limit
- Hard Cap Enforcement: Stop remote calls at $120 threshold
- Cache Strategy: Save local JSON responses for identical vision/audio passes

**Implemented:** `harness/proxy-server.mjs` now enforces **both** a call ceiling and a USD
ceiling, with the spend ledger persisted to `.cache/spend-ledger.json` so a restart does not
reset what has been spent.

| guard | default | scope |
|---|---|---|
| `MAX_PAID_CALLS` | 60 | hard call count |
| `MAX_SPEND_USD` | 120.00 | **lifetime**, survives restarts |
| `MAX_SESSION_SPEND_USD` | 5.00 | this process run only |

Per-route pricing is configurable and conservative:
`COST_PER_SAM_CALL_USD=0.05`, `COST_PER_MUSE_AUDIO_USD=0.02`, `COST_PER_MUSE_SPARK_USD=0.03`.

The next call's cost is checked against all three ceilings **before** the upstream request and
rejected with `429` + a reason if it would breach. Verified: with `MAX_SPEND_USD=0.20`, a call
taking spend from $0.18 to $0.23 returned `429 budget_exceeded` and the proxy log shows no
upstream line after the refusal.

**Remaining caveat:** those per-call costs are **estimates**, not Meta's published pricing.
Replace them with real figures before trusting the $120 figure; the mechanism is right, the
constants are guesses.

## Immediate Deliverables

- [x] Mount and verify project structure on D:\
      Structure verified and now under local git (7 commits). `harness/webmcp` holds the code,
      `specs/` and `sprints/` hold intent.
- [x] Implement local JSON replay cache for audio transcription
      Now a **true content-addressed cache** at the proxy: SHA-256 over the canonicalised
      request body -> `.cache/replay/<hash>.json`. `PROXY_CACHE_MODE=record-or-replay` (default)
      serves a hit at **$0.00** with no upstream call and increments `cacheHits`; a successful
      live response is written back automatically. Mock fixtures still exist in
      `harness/muse-audio/` for offline runs.

      One real bug found and fixed here: multipart boundaries are randomly generated per
      request, so hashing raw upload bytes made every audio POST look unique and the cache never
      hit. Bodies are now canonicalised into sorted `field -> content-hash` pairs, which is
      stable across boundaries. Verified over HTTP: identical clip -> hit at $0.00; different
      clip -> charged.
- [x] Stand up 600x600 WebMCP canvas mock
      `harness/webmcp` renders a fixed 600x600 canvas with colour-coded reticles and four working
      tools (`record_waste`, `calculate_yield`, `tare_scale`, `verify_pan_depth`), driven by keys
      `S` (snapshot), `M`/`V` (voice), `1-4` (tools), `0` (clear).
- [x] Connect SAM 3.1 overlay to test frame feeds
      Connected to the **mock** SAM 3.1 contract over HTTP, not to Meta. Boxes arrive in
      unnormalised 1280x720 and are proven to normalise into 600x600 with the right-edge overflow
      clamped to exactly `right=600`. No real frame feed is wired; captures are synthetic.

## Voice chain

`Muse Audio transcript -> Muse Spark 1.3 tool selection -> WebMCP execution` runs as three
observable hops, each through the same ledger and replay cache:

```
POST /muse-audio/transcribe   $0.02   transcript
POST /muse-spark/dispatch     $0.03   tool + arguments
executeTool()                 $0.00   in src/mcp/tools.ts
```

Verified in the browser against the mock contracts:
`1/3 transcribe -> 2/3 spark (conf 0.94) -> 3/3 execute record_waste {Salmon Trim, 907g}`.
A repeated identical command costs $0.00 on both hops.

## Next

- [ ] Wire the real Meta endpoints behind the proxy (`META_SAM_URL`, `META_MUSE_URL`, `META_MUSE_SPARK_URL`)
- [ ] Replace the call ceiling with a USD-accurate budget stop at $120
- [ ] Wake-word detection to replace push-to-talk
- [ ] Real camera frame capture for the snapshot path
