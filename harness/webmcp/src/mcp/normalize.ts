import type { ContainerTarget, ReticleStatus } from '../types/hud';
import { HUD_SIZE } from '../config/env';

/**
 * A detection as it comes off the wire. SAM 3.1 returns pixel boxes in the *source frame*
 * (e.g. 1280x720), which is not the HUD's 600x600 space. Accepted shapes:
 *   { x, y, width, height }        corner + size in source pixels
 *   { x1, y1, x2, y2 }             two corners in source pixels
 *   the above with values in 0..1   normalised, detected automatically
 */
export interface RawDetection {
  id?: string;
  label?: string;
  name?: string;
  x?: number; y?: number; width?: number; height?: number;
  x1?: number; y1?: number; x2?: number; y2?: number;
  confidence?: number;
  score?: number;
  fillPercentage?: number;
  fill_percentage?: number;
  status?: string;
}

export interface SourceFrame {
  width: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** all four numbers <= 1 means the model already normalised; scale by HUD size instead */
function looksNormalised(vals: number[]): boolean {
  return vals.every((v) => Number.isFinite(v) && Math.abs(v) <= 1);
}

function statusOf(raw: string | undefined, fill: number | undefined): ReticleStatus {
  if (raw === 'nominal' || raw === 'warning' || raw === 'breach') return raw;
  if (fill !== undefined) {
    if (fill < 20 || fill > 90) return 'warning';
  }
  return 'nominal';
}

/**
 * Convert model-space detections into HUD-space reticles (0..600), clamped to the canvas.
 * Every coordinate leaving this function is safe to draw in a 600x600 context.
 */
export function normalizeToHud(
  detections: RawDetection[],
  frame: SourceFrame,
  hud: number = HUD_SIZE,
): ContainerTarget[] {
  if (!Array.isArray(detections)) return [];

  return detections
    .map((d, i): ContainerTarget | null => {
      // 1. resolve to x/y/width/height, accepting either box convention
      let x = d.x;
      let y = d.y;
      let width = d.width;
      let height = d.height;

      if (width === undefined && d.x1 !== undefined && d.x2 !== undefined) {
        x = Math.min(d.x1, d.x2);
        width = Math.abs(d.x2 - d.x1);
      }
      if (height === undefined && d.y1 !== undefined && d.y2 !== undefined) {
        y = Math.min(d.y1, d.y2);
        height = Math.abs(d.y2 - d.y1);
      }

      if ([x, y, width, height].some((v) => v === undefined || !Number.isFinite(v))) return null;

      // 2. decide the input space and scale into HUD space
      const alreadyNormalised = looksNormalised([x!, y!, width!, height!]);
      const sx = alreadyNormalised ? hud : hud / (frame.width || hud);
      const sy = alreadyNormalised ? hud : hud / (frame.height || hud);

      let nx = x! * sx;
      let ny = y! * sy;
      let nw = width! * sx;
      let nh = height! * sy;

      // 3. round FIRST, then clamp against the rounded size.
      //    Clamping the float and rounding afterwards is a classic 1px overflow: a box at
      //    x=412.5,w=187.5 clamps to 412.5 then both round up to x=413,w=188 -> x+w=601
      //    on a 600px canvas. Rounding first makes x + width <= hud exact.
      nw = clamp(Math.round(nw), 1, hud);
      nh = clamp(Math.round(nh), 1, hud);
      nx = clamp(Math.round(nx), 0, hud - nw);
      ny = clamp(Math.round(ny), 0, hud - nh);

      const fill = d.fillPercentage ?? d.fill_percentage;
      const confidence = d.confidence ?? d.score ?? 0;

      return {
        id: d.id ?? `det-${i}`,
        label: (d.label ?? d.name ?? 'UNLABELLED').toUpperCase(),
        x: nx,
        y: ny,
        width: nw,
        height: nh,
        confidence: clamp(confidence, 0, 1),
        fillPercentage: fill === undefined ? undefined : clamp(fill, 0, 100),
        status: statusOf(d.status, fill),
      };
    })
    .filter((d): d is ContainerTarget => d !== null);
}
