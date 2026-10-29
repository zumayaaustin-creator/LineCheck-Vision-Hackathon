/**
 * SAM 3.1 mock contract payload.
 *
 * Deliberately UNNORMALISED: these are pixel coordinates in a 1280x720 source frame,
 * exactly as a real segmentation response would arrive. The whole point is to force
 * src/mcp/normalize.ts to do the real work over HTTP rather than receiving tidy
 * pre-scaled boxes.
 */

export const SOURCE_FRAME = { width: 1280, height: 720 };

/**
 * @param {{ width?: number, height?: number }} frame  the frame the caller claims to have sent
 * @returns {{ detections: Array<object>, meta: object }}
 */
export function buildDetections(frame = SOURCE_FRAME) {
  const w = Number(frame?.width) || SOURCE_FRAME.width;
  const h = Number(frame?.height) || SOURCE_FRAME.height;

  const detections = [
    {
      // 1/3 hotel pan, well stocked
      id: 'sam-pan-1',
      label: '1/3 Hotel Pan - Sliced Tomato',
      x: 120, y: 180, width: 320, height: 210,
      confidence: 0.96,
      fill_percentage: 68,
    },
    {
      // salmon trim, nearly empty -> should come out as a warning/breach
      id: 'sam-salmon-trim',
      label: 'Salmon Trim Zone',
      x: 560, y: 140, width: 280, height: 190,
      confidence: 0.91,
      fill_percentage: 12,
    },
    {
      // scale tare zone, nominal
      id: 'sam-scale-zone',
      label: 'Scale Tare Zone',
      x: 900, y: 430, width: 260, height: 170,
      confidence: 0.88,
      fill_percentage: 55,
    },
    {
      // INTENTIONAL right-edge overflow: right edge is 1480 on a 1280 frame.
      // normalizeToHud must clamp this inside the 600x600 canvas, not draw off-screen.
      id: 'sam-overflow',
      label: 'Overflow Probe (Right Edge)',
      x: 1180, y: 300, width: 300, height: 200,
      confidence: 0.74,
    },
  ];

  return {
    detections,
    meta: {
      model: 'sam-3.1-mock',
      sourceFrame: { width: w, height: h },
      // proves the overflow box really is outside the declared frame before normalisation
      overflowBoxRight: 1180 + 300,
      simulated: true,
    },
  };
}
