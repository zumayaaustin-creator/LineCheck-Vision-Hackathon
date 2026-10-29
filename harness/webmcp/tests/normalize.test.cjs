/**
 * Node-side tests for the coordinate contract.
 *
 * Runs with the built-in test runner, no extra dependencies:
 *   npm test
 *
 * normalize.ts is deliberately importable outside the bundler (it takes HUD_SIZE from
 * config/constants, which has no import.meta access), so these are the same assertions as
 * the in-browser self-test but runnable in CI.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeToHud } = require('../.testdist/mcp/normalize.js');
const { HUD_SIZE } = require('../.testdist/config/constants.js');

const FRAME = { width: 1280, height: 720 };

test('HUD_SIZE is the documented 600', () => {
  assert.equal(HUD_SIZE, 600);
});

test('frame centre maps to HUD centre', () => {
  const [b] = normalizeToHud([{ id: 'c', label: 'centre', x: 640, y: 360, width: 320, height: 180 }], FRAME);
  assert.deepEqual({ x: b.x, y: b.y, w: b.width, h: b.height }, { x: 300, y: 300, w: 150, h: 150 });
});

test('origin stays at the origin', () => {
  const [b] = normalizeToHud([{ id: 'o', label: 'corner', x: 0, y: 0, width: 64, height: 36 }], FRAME);
  assert.equal(b.x, 0);
  assert.equal(b.y, 0);
});

test('right/bottom overflow clamps exactly to the canvas edge', () => {
  const [b] = normalizeToHud([{ id: 'x', label: 'overflow', x: 1200, y: 700, width: 400, height: 200 }], FRAME);
  assert.equal(b.x + b.width, HUD_SIZE);
  assert.equal(b.y + b.height, HUD_SIZE);
});

test('negative origin clamps to zero', () => {
  const [b] = normalizeToHud([{ id: 'n', label: 'off', x: -100, y: -50, width: 200, height: 100 }], FRAME);
  assert.equal(b.x, 0);
  assert.equal(b.y, 0);
});

test('already-normalised 0..1 input is detected and scaled', () => {
  const [b] = normalizeToHud([{ id: 'h', label: 'norm', x: 0.5, y: 0.5, width: 0.25, height: 0.25 }], FRAME);
  assert.equal(b.x, 300);
  assert.equal(b.width, 150);
});

test('x1/y1/x2/y2 corner form is accepted', () => {
  const [b] = normalizeToHud([{ id: 'q', label: 'corners', x1: 0, y1: 0, x2: 640, y2: 360 }], FRAME);
  assert.equal(b.width, 300);
  assert.equal(b.height, 300);
});

test('non-finite detections are dropped', () => {
  const out = normalizeToHud([{ id: 'f', label: 'bad', x: NaN, y: 0, width: 10, height: 10 }], FRAME);
  assert.equal(out.length, 0);
});

test('fill percentage drives status', () => {
  const out = normalizeToHud([
    { id: 'lo', label: 'low', x: 0, y: 0, width: 10, height: 10, fill_percentage: 12 },
    { id: 'ok', label: 'ok', x: 0, y: 0, width: 10, height: 10, fill_percentage: 55 },
    { id: 'hi', label: 'high', x: 0, y: 0, width: 10, height: 10, fill_percentage: 95 },
  ], FRAME);
  assert.equal(out[0].status, 'warning');
  assert.equal(out[1].status, 'nominal');
  assert.equal(out[2].status, 'warning');
});

test('explicit status overrides the fill heuristic', () => {
  const [b] = normalizeToHud([{ id: 'e', label: 'e', x: 0, y: 0, width: 10, height: 10, fill_percentage: 55, status: 'breach' }], FRAME);
  assert.equal(b.status, 'breach');
});

test('500 random boxes never leave the canvas', () => {
  let worstRight = 0, worstBottom = 0;
  for (let i = 0; i < 500; i++) {
    const x = Math.random() * 2400 - 400;
    const y = Math.random() * 1600 - 300;
    const w = Math.random() * 1200 + 1;
    const h = Math.random() * 900 + 1;
    for (const b of normalizeToHud([{ id: String(i), label: 'r', x, y, width: w, height: h }], FRAME)) {
      assert.ok(b.x >= 0 && b.y >= 0, `negative origin at iteration ${i}`);
      assert.ok(b.x + b.width <= HUD_SIZE, `right overflow ${b.x + b.width} at iteration ${i}`);
      assert.ok(b.y + b.height <= HUD_SIZE, `bottom overflow ${b.y + b.height} at iteration ${i}`);
      worstRight = Math.max(worstRight, b.x + b.width);
      worstBottom = Math.max(worstBottom, b.y + b.height);
    }
  }
  assert.ok(worstRight <= HUD_SIZE && worstBottom <= HUD_SIZE);
});

test('empty and malformed input does not throw', () => {
  assert.doesNotThrow(() => normalizeToHud([], FRAME));
  assert.doesNotThrow(() => normalizeToHud(null, FRAME));
});

test('unknown frame size falls back to HUD size instead of dividing by zero', () => {
  const [b] = normalizeToHud([{ id: 'z', label: 'z', x: 10, y: 10, width: 10, height: 10 }], { width: 0, height: 0 });
  assert.ok(Number.isFinite(b.x) && Number.isFinite(b.width));
  assert.ok(b.x + b.width <= HUD_SIZE);
});
