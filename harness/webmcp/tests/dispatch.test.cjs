/**
 * Node-side tests for the WebMCP dispatch chain.
 *
 * The chain under test is the one the HUD actually runs:
 *   Spark (muse-audio/spark-dispatch.mjs) -> tool call -> executeTool() -> hudStore
 *
 * The point is that the arguments Spark returns are in the shape tools.ts declares. An earlier
 * draft of this integration used `item` / `quantity` / `unit`, which this suite now pins shut.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { executeTool, validateArgs, toolDefinitions } = require('../.testdist/mcp/tools.js');
const { hudStore } = require('../.testdist/hud/state.js');

const SPARK = pathToFileURL(path.join(__dirname, '..', '..', 'muse-audio', 'spark-dispatch.mjs')).href;

test('the registry is the four documented tools', () => {
  assert.deepEqual(
    toolDefinitions.map((t) => t.name),
    ['record_waste', 'calculate_yield', 'tare_scale', 'verify_pan_depth'],
  );
});

test('every tool accepts an argument bag built from its own schema', () => {
  for (const def of toolDefinitions) {
    const args = {};
    for (const key of def.parameters.required) {
      args[key] = def.parameters.properties[key].type === 'number' ? 1 : 'x';
    }
    assert.equal(validateArgs(def.name, args), null, `${def.name} rejected its own required args`);
  }
});

test('record_waste mutates state: ALERT + a labelled reticle', async () => {
  hudStore.setReticles([]);
  const result = await executeTool('record_waste', {
    ingredient: 'Salmon Trim',
    weight_g: 907,
    reason: 'Trim waste',
  });
  assert.equal(result.success, true);
  assert.equal(result.code, 'WASTE_LOGGED');
  assert.equal(result.logged_g, 907);
  assert.equal(hudStore.getState().status, 'ALERT');
  const [reticle] = hudStore.getState().reticles;
  assert.match(reticle.label, /WASTE: SALMON TRIM/);
  assert.equal(reticle.status, 'breach');
});

test('calculate_yield computes the EP/AP percentage', async () => {
  const result = await executeTool('calculate_yield', {
    ap_weight_g: 6804,
    ep_weight_g: 4762,
    trim_weight_g: 2042,
  });
  assert.equal(result.success, true);
  assert.equal(result.yield_percentage, 70);
  assert.equal(hudStore.getState().status, 'IDLE', 'a yield result must settle out of PROCESSING');
});

test('verify_pan_depth flags an under-filled pan', async () => {
  const result = await executeTool('verify_pan_depth', { pan_type: '1/6 Pan', fill_percentage: 15 });
  assert.equal(result.success, true);
  assert.equal(result.nominal, false);
  assert.equal(hudStore.getState().status, 'ALERT');
});

test('tare_scale zeroes and returns to IDLE', async () => {
  const result = await executeTool('tare_scale', { unit: 'g' });
  assert.equal(result.success, true);
  assert.equal(result.zero_offset, 0);
  assert.equal(result.unit, 'g');
  assert.equal(hudStore.getState().status, 'IDLE');
});

test('the stale paste schema is rejected, not crashed on', async () => {
  // this is the exact shape the earlier draft used: item/quantity/unit with qt-lb-oz-pan
  hudStore.setReticles([
    { id: 'kept', x: 10, y: 10, width: 50, height: 50, label: 'KEEP ME', confidence: 1, status: 'nominal' },
  ]);
  const before = hudStore.getState().status;

  const result = await executeTool('record_waste', { item: 'Salmon', quantity: 2, unit: 'lb' });
  assert.equal(result.success, false);
  assert.equal(result.code, 'INVALID_ARGS');
  assert.match(result.error, /missing ingredient/);

  // the HUD keeps what it was drawing - a bad tool call is not a reason to blank the screen
  assert.equal(hudStore.getState().status, before);
  assert.equal(hudStore.getState().reticles[0].id, 'kept');
});

test('a non-numeric weight is rejected with a message naming the field', async () => {
  const result = await executeTool('record_waste', {
    ingredient: 'Onions',
    weight_g: '450',
    reason: 'Spoilage',
  });
  assert.equal(result.success, false);
  assert.match(result.error, /weight_g must be a number/);
});

test('an unknown tool still throws - that is the registry contract', async () => {
  await assert.rejects(() => executeTool('fetch_supplier_benchmarks', {}), /not recognized/);
});

test('end to end: Spark transcript -> tool call -> real handler -> state', async () => {
  const { dispatch } = await import(SPARK);

  const cases = [
    ['log 2 pounds of salmon trim waste', 'record_waste'],
    ['what is the yield on the chicken', 'calculate_yield'],
    ['zero the scale', 'tare_scale'],
    ['check the 4-inch hotel pan at 15 percent', 'verify_pan_depth'],
  ];

  for (const [transcript, expected] of cases) {
    const picked = dispatch(transcript, toolDefinitions);
    assert.equal(picked.tool.name, expected, `"${transcript}" resolved to ${picked.tool.name}`);

    const result = await executeTool(picked.tool.name, picked.tool.arguments);
    assert.equal(result.success, true, `${expected} rejected Spark's own arguments: ${JSON.stringify(result)}`);
  }
});

// ---- targeted annotation: a voice command marks the item on the photo, it does not add a box ----
const scene = () => [
  { id: 'a', x: 0, y: 0, width: 10, height: 10, label: '1/6 PAN — JALAPENOS', confidence: 1, status: 'warning' },
  { id: 'b', x: 0, y: 0, width: 10, height: 10, label: '1/6 PAN — DICED ONION', confidence: 1, status: 'breach' },
];

test('verify_pan_depth with a target edits that reticle in place, keeps the others, adds none', async () => {
  hudStore.setReticles(scene());
  const result = await executeTool('verify_pan_depth', { pan_type: '1/6 Pan', fill_percentage: 55, target: 'JALAPENOS' });
  assert.equal(result.success, true);
  const rs = hudStore.getState().reticles;
  assert.equal(rs.length, 2);
  assert.equal(rs[0].label, '1/6 PAN — JALAPENOS | 55%');
  assert.equal(rs[0].status, 'nominal');
  assert.equal(rs[1].label, '1/6 PAN — DICED ONION');
});

test('repeating a targeted command rewrites the result instead of stacking text', async () => {
  hudStore.setReticles(scene());
  await executeTool('verify_pan_depth', { pan_type: '1/6 Pan', fill_percentage: 95, target: 'DICED ONION' });
  await executeTool('verify_pan_depth', { pan_type: '1/6 Pan', fill_percentage: 40, target: 'DICED ONION' });
  const onion = hudStore.getState().reticles[1];
  assert.equal(onion.label, '1/6 PAN — DICED ONION | 40%');
});

test('a target that is not on screen changes nothing and draws no stray box', async () => {
  hudStore.setReticles(scene());
  await executeTool('record_waste', { ingredient: 'Salsa', weight_g: 300, reason: 'Expired', target: 'SALSA' });
  assert.equal(hudStore.getState().reticles.length, 2);
  assert.equal(hudStore.getState().reticles[0].label, '1/6 PAN — JALAPENOS');
});

test('record_waste with a target marks the matching reticle as a breach', async () => {
  hudStore.setReticles(scene());
  await executeTool('record_waste', { ingredient: 'Jalapenos', weight_g: 120, reason: 'Wilted', target: 'JALAPENOS' });
  const r = hudStore.getState().reticles[0];
  assert.equal(r.status, 'breach');
  assert.match(r.label, /\| WASTE 120g \(Wilted\)$/);
});

test('calculate_yield with a target marks every matching reticle nominal', async () => {
  hudStore.setReticles([
    { id: 'x', x: 0, y: 0, width: 5, height: 5, label: 'TRI-TIP A', confidence: 1, status: 'nominal' },
    { id: 'y', x: 0, y: 0, width: 5, height: 5, label: 'TRI-TIP B', confidence: 1, status: 'warning' },
  ]);
  await executeTool('calculate_yield', { ap_weight_g: 2200, ep_weight_g: 1650, target: 'TRI-TIP' });
  const rs = hudStore.getState().reticles;
  assert.equal(rs.length, 2);
  assert.ok(rs.every((r) => r.status === 'nominal' && r.label.endsWith('| YIELD 75.0%')));
});
