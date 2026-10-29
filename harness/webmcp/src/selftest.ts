/**
 * Self-test for the coordinate contract.
 *
 * Runs in the browser (window.runHudSelfTest) so it needs no test runner and works offline.
 * Every case here encodes a rule the HUD depends on: a box must never leave the 600x600
 * canvas, whatever frame size or input convention the model uses.
 */

import { normalizeToHud, type RawDetection } from './mcp/normalize';
import { HUD_SIZE } from './config/env';

export interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

function check(name: string, pass: boolean, detail: string): TestResult {
  return { name, pass, detail };
}

const FRAME_1280x720 = { width: 1280, height: 720 };

export function runHudSelfTest(): { passed: number; failed: number; results: TestResult[] } {
  const results: TestResult[] = [];

  // 1. centre of the frame maps to the centre of the HUD
  {
    const out = normalizeToHud(
      [{ id: 'c', label: 'centre', x: 640, y: 360, width: 320, height: 180 }],
      FRAME_1280x720,
    );
    const b = out[0];
    results.push(check('centre maps to centre', !!b && b.x === 300 && b.y === 300 && b.width === 150,
      b ? `x=${b.x} y=${b.y} w=${b.width}` : 'dropped'));
  }

  // 2. corner stays at the corner
  {
    const out = normalizeToHud([{ id: 'b', label: 'corner', x: 0, y: 0, width: 64, height: 36 }], FRAME_1280x720);
    const b = out[0];
    results.push(check('corner stays at 0,0', !!b && b.x === 0 && b.y === 0,
      b ? `x=${b.x} y=${b.y} w=${b.width} h=${b.height}` : 'dropped'));
  }

  // 3. right-edge overflow is clamped inside the canvas (the 1px bug that existed once)
  {
    const out = normalizeToHud([{ id: 'o', label: 'overflow', x: 1200, y: 700, width: 400, height: 200 }], FRAME_1280x720);
    const b = out[0];
    results.push(check('overflow clamps to the canvas edge', !!b && b.x + b.width === HUD_SIZE && b.y + b.height === HUD_SIZE,
      b ? `right=${b.x + b.width} bottom=${b.y + b.height} (limit ${HUD_SIZE})` : 'dropped'));
  }

  // 4. negative origin clamps to 0
  {
    const out = normalizeToHud([{ id: 'n', label: 'offscreen', x: -100, y: -50, width: 200, height: 100 }], FRAME_1280x720);
    const b = out[0];
    results.push(check('negative origin clamps to 0,0', !!b && b.x === 0 && b.y === 0,
      b ? `x=${b.x} y=${b.y}` : 'dropped'));
  }

  // 5. already-normalised 0..1 input is detected and scaled
  {
    const out = normalizeToHud([{ id: 'h', label: 'norm', x: 0.5, y: 0.5, width: 0.25, height: 0.25 }], FRAME_1280x720);
    const b = out[0];
    results.push(check('0..1 input detected and scaled', !!b && b.x === 300 && b.width === 150,
      b ? `x=${b.x} w=${b.width}` : 'dropped'));
  }

  // 6. x1/y1/x2/y2 corner form is accepted
  {
    const out = normalizeToHud([{ id: 'q', label: 'corners', x1: 0, y1: 0, x2: 640, y2: 360 }], FRAME_1280x720);
    const b = out[0];
    results.push(check('corner-pair input accepted', !!b && b.width === 300 && b.height === 300,
      b ? `w=${b.width} h=${b.height}` : 'dropped'));
  }

  // 7. non-finite detections are dropped, not drawn
  {
    const out = normalizeToHud([{ id: 'f', label: 'bad', x: NaN, y: 0, width: 10, height: 10 }], FRAME_1280x720);
    results.push(check('NaN detection dropped', out.length === 0, `kept ${out.length}`));
  }

  // 8. fill percentage drives status
  {
    const out = normalizeToHud([
      { id: 'lo', label: 'low', x: 0, y: 0, width: 10, height: 10, fill_percentage: 12 },
      { id: 'ok', label: 'ok', x: 0, y: 0, width: 10, height: 10, fill_percentage: 55 },
    ], FRAME_1280x720);
    results.push(check('fill 12% -> warning, 55% -> nominal',
      out[0]?.status === 'warning' && out[1]?.status === 'nominal',
      `${out[0]?.status} / ${out[1]?.status}`));
  }

  // 9. explicit status wins over the fill heuristic
  {
    const out = normalizeToHud([{ id: 'x', label: 'x', x: 0, y: 0, width: 10, height: 10, fill_percentage: 55, status: 'breach' as any }], FRAME_1280x720);
    results.push(check('explicit status overrides fill rule', out[0]?.status === 'breach', `${out[0]?.status}`));
  }

  // 10. nothing may ever be drawn outside the canvas, across many random boxes
  {
    let worstRight = 0, worstBottom = 0, allInside = true;
    for (let i = 0; i < 500; i++) {
      const x = Math.random() * 2400 - 400;
      const y = Math.random() * 1600 - 300;
      const w = Math.random() * 1200 + 1;
      const h = Math.random() * 900 + 1;
      const out = normalizeToHud([{ id: `${i}`, label: 'r', x, y, width: w, height: h }], FRAME_1280x720);
      for (const b of out) {
        worstRight = Math.max(worstRight, b.x + b.width);
        worstBottom = Math.max(worstBottom, b.y + b.height);
        if (b.x < 0 || b.y < 0 || b.x + b.width > HUD_SIZE || b.y + b.height > HUD_SIZE) allInside = false;
      }
    }
    results.push(check('500 random boxes all stay inside the canvas', allInside,
      `worst right=${worstRight} bottom=${worstBottom} (limit ${HUD_SIZE})`));
  }

  // 11. empty / malformed input does not throw
  {
    let ok = true;
    try {
      normalizeToHud([], FRAME_1280x720);
      normalizeToHud(null as unknown as RawDetection[], FRAME_1280x720);
    } catch {
      ok = false;
    }
    results.push(check('empty/garbage input does not throw', ok, ok ? 'safe' : 'threw'));
  }

  const failed = results.filter((r) => !r.pass).length;
  return { passed: results.length - failed, failed, results };
}
