/**
 * Node-side tests for the tier + telemetry contract.
 *
 * These cover the three things that can silently go wrong at the browser/proxy seam:
 *   1. the request does not carry `x-model-tier` (the proxy then serves `primary` and the HUD
 *      reports a tier that never answered),
 *   2. `_meta` is not ingested (the footer shows a model that did not serve the frame),
 *   3. a tier refusal is thrown instead of drawn (one bad config key blanks the HUD).
 *
 * tier.ts is dependency-free on purpose (no `import.meta`, no DOM), so this is the same code the
 * bundle runs.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MODEL_TIERS,
  TIER_MODEL_ID,
  tierHeader,
  toggleTier,
  asTier,
  headerValue,
  readTelemetry,
  classifyTierRefusal,
  sparkRequestInit,
  cacheLabel,
  formatLedgerUsd,
  footerText,
} = require('../.testdist/mcp/tier.js');

test('the tier list matches what the proxy accepts', () => {
  assert.deepEqual([...MODEL_TIERS], ['primary', 'open-weights']);
  assert.equal(TIER_MODEL_ID.primary, 'muse-spark-1.3');
  assert.equal(TIER_MODEL_ID['open-weights'], 'muse-spark-open-1026');
});

test('tierHeader emits the exact header the proxy routes on', () => {
  assert.deepEqual(tierHeader('primary'), { 'x-model-tier': 'primary' });
  assert.deepEqual(tierHeader('open-weights'), { 'x-model-tier': 'open-weights' });
});

test('toggleTier round-trips and never invents a third tier', () => {
  assert.equal(toggleTier('primary'), 'open-weights');
  assert.equal(toggleTier('open-weights'), 'primary');
  assert.equal(toggleTier(toggleTier('primary')), 'primary');
});

test('asTier rejects anything the proxy would 400', () => {
  assert.equal(asTier('primary'), 'primary');
  assert.equal(asTier('open-weights'), 'open-weights');
  assert.equal(asTier('gpt-5'), null);
  assert.equal(asTier(undefined), null);
  assert.equal(asTier(null), null);
});

test('sparkRequestInit propagates the tier as a header', () => {
  const init = sparkRequestInit('zero the scale', [{ name: 'tare_scale' }], 'open-weights');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-model-tier'], 'open-weights');
  assert.equal(init.headers['Content-Type'], 'application/json');
});

test('sparkRequestInit keeps the tier OUT of the body so cache keys stay stable', () => {
  const body = JSON.parse(sparkRequestInit('zero the scale', [{ name: 'tare_scale' }], 'primary').body);
  assert.deepEqual(Object.keys(body).sort(), ['tools', 'transcript']);
  assert.equal(body.tier, undefined);
});

test('sparkRequestInit only adds a credential when one is configured', () => {
  const proxyMode = sparkRequestInit('t', [], 'primary', '');
  assert.equal(proxyMode.headers.Authorization, undefined);
  const keyMode = sparkRequestInit('t', [], 'primary', 'test-key');
  assert.equal(keyMode.headers.Authorization, 'Bearer test-key');
});

test('readTelemetry ingests the proxy _meta block', () => {
  const body = {
    tool: { name: 'record_waste', arguments: {} },
    _meta: {
      activeRoute: 'spark',
      modelTier: 'open-weights',
      modelId: 'muse-spark-open-1026',
      cached: false,
      costUsd: 0.03,
      ledgerSpentUsd: 0.0371,
      sessionSpendUsd: 0.0371,
      cacheHits: 2,
    },
  };
  const t = readTelemetry(body, null);
  assert.equal(t.modelTier, 'open-weights');
  assert.equal(t.modelId, 'muse-spark-open-1026');
  assert.equal(t.cached, false);
  assert.equal(t.ledgerSpentUsd, 0.0371);
  assert.equal(t.lastError, null);
});

test('readTelemetry falls back to the response headers', () => {
  const headers = {
    get(name) {
      const map = {
        'X-Model-Tier': 'open-weights',
        'X-Model-Id': 'muse-spark-open-1026',
        'X-Proxy-Cache': 'hit',
        'X-Proxy-Ledger-Usd': '0.007100',
      };
      return map[name] ?? null;
    },
  };
  const t = readTelemetry({}, headers);
  assert.equal(t.modelTier, 'open-weights');
  assert.equal(t.modelId, 'muse-spark-open-1026');
  assert.equal(t.cached, true);
  assert.equal(t.ledgerSpentUsd, 0.0071);
});

test('readTelemetry prefers _meta over headers when they disagree', () => {
  const headers = { get: (n) => (n === 'X-Model-Tier' ? 'open-weights' : null) };
  const t = readTelemetry({ _meta: { modelTier: 'primary', modelId: 'muse-spark-1.3' } }, headers);
  assert.equal(t.modelTier, 'primary');
  assert.equal(t.modelId, 'muse-spark-1.3');
});

test('readTelemetry survives a missing, empty or garbage response', () => {
  for (const body of [null, undefined, {}, { _meta: null }, { _meta: 'nope' }, 42]) {
    const t = readTelemetry(body, null);
    assert.equal(t.modelTier, null);
    assert.equal(t.modelId, '');
    assert.equal(t.cached, null);
    assert.equal(t.ledgerSpentUsd, null);
  }
  const garbage = readTelemetry({ _meta: { modelTier: 'gpt-5', ledgerSpentUsd: 'abc' } }, null);
  assert.equal(garbage.modelTier, null, 'an unrecognised tier must not be adopted');
  assert.equal(garbage.ledgerSpentUsd, null, 'NaN must not reach the footer');
});

test('a 400 tier_not_configured becomes a readable pill, not an exception', () => {
  const refusal = classifyTierRefusal(400, {
    error: 'tier_not_configured',
    tier: 'open-weights',
    message: 'Tier has no upstream URL configured.',
  });
  assert.ok(refusal);
  assert.equal(refusal.code, 'tier_not_configured');
  assert.match(refusal.message, /TIER UNAVAILABLE/);
  assert.match(refusal.message, /open-weights/);
  assert.match(refusal.message, /META_OPEN_WEIGHTS_SPARK_URL/, 'the pill has to name the fix');
});

test('a 400 unknown_model_tier names the tier and the valid set', () => {
  const refusal = classifyTierRefusal(400, { error: 'unknown_model_tier', tier: 'gpt-5' });
  assert.ok(refusal);
  assert.equal(refusal.code, 'unknown_model_tier');
  assert.match(refusal.message, /gpt-5/);
  assert.match(refusal.message, /primary, open-weights/);
});

test('ordinary HTTP failures are NOT dressed up as tier problems', () => {
  assert.equal(classifyTierRefusal(400, { error: 'something_else' }), null);
  assert.equal(classifyTierRefusal(400, null), null);
  assert.equal(classifyTierRefusal(429, { error: 'session_budget_exceeded' }), null);
  assert.equal(classifyTierRefusal(500, { error: 'tier_not_configured' }), null);
});

test('footer labels are the documented strings', () => {
  assert.equal(cacheLabel(true), 'CACHE:HIT');
  assert.equal(cacheLabel(false), 'CACHE:MISS');
  assert.equal(cacheLabel(null), 'CACHE:--');
  assert.equal(formatLedgerUsd(0.0071), '$0.00710');
  assert.equal(formatLedgerUsd(0), '$0.00000');
  assert.equal(formatLedgerUsd(null), '$--.-----');
});

test('footerText falls back to the tier default before any response arrives', () => {
  const cold = footerText({
    modelTier: 'open-weights',
    modelId: '',
    cached: null,
    ledgerSpentUsd: null,
  });
  assert.deepEqual(cold, {
    tier: 'TIER:open-weights',
    model: 'MUSE:muse-spark-open-1026',
    cache: 'CACHE:--',
    ledger: 'LEDGER:$--.-----',
  });

  const warm = footerText({
    modelTier: 'primary',
    modelId: 'muse-spark-1.3',
    cached: true,
    ledgerSpentUsd: 0.0371,
  });
  assert.equal(warm.model, 'MUSE:muse-spark-1.3');
  assert.equal(warm.cache, 'CACHE:HIT');
  assert.equal(warm.ledger, 'LEDGER:$0.03710');
});

test('headerValue reads both a Headers instance and a plain record', () => {
  assert.equal(headerValue({ get: (n) => (n === 'X-A' ? 'v' : null) }, 'X-A'), 'v');
  assert.equal(headerValue({ 'x-a': 'lower' }, 'X-A'), 'lower');
  assert.equal(headerValue(null, 'X-A'), null);
  assert.equal(headerValue({}, 'X-A'), null);
});
