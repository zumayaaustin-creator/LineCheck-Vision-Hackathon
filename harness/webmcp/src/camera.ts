/**
 * Camera frame grabber for the SAM 3.1 snapshot path.
 *
 * `S` used to send a synthetic stub. This captures a real webcam frame at 1280x720 and hands
 * the true source dimensions to the model, so `normalizeToHud()` scales from what the camera
 * actually produced rather than from an assumed constant.
 *
 * Mirrors src/mic.ts in its failure behaviour: no camera, no permission, or no browser support
 * all fall back to a deterministic synthetic frame instead of breaking the snapshot. A snapshot
 * must always be possible; only the frame source changes.
 */

export interface FrameCapture {
  /** JPEG data URL, ready to POST */
  dataUrl: string;
  /** true dimensions of what was captured - these drive normalisation */
  width: number;
  height: number;
  source: 'camera' | 'synthetic';
  /** set when the camera was requested and failed, for the HUD to show */
  reason?: string;
}

export const TARGET_WIDTH = 1280;
export const TARGET_HEIGHT = 720;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Deterministic stand-in frame: kitchen-bench-ish grid with fiducials. Same every run. */
function drawSynthetic(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#0A0A0A';
  ctx.fillRect(0, 0, w, h);

  // bench grid
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.10)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x += 80) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y <= h; y += 80) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // three "containers" so the frame has structure a detector could plausibly find
  const boxes = [
    { x: 120, y: 180, w: 320, h: 210, c: '#00F0FF', label: 'SYNTH PAN A' },
    { x: 560, y: 140, w: 280, h: 190, c: '#FCEE0A', label: 'SYNTH PAN B' },
    { x: 900, y: 430, w: 260, h: 170, c: '#BD00FF', label: 'SYNTH SCALE' },
  ];
  ctx.lineWidth = 3;
  for (const b of boxes) {
    ctx.strokeStyle = b.c;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = b.c;
    ctx.font = 'bold 20px monospace';
    ctx.fillText(b.label, b.x + 10, b.y + 30);
  }

  // corner fiducials + frame stamp
  ctx.strokeStyle = '#00F0FF';
  ctx.lineWidth = 4;
  const m = 24, s = 60;
  ctx.beginPath(); ctx.moveTo(m, m + s); ctx.lineTo(m, m); ctx.lineTo(m + s, m); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(w - m - s, m); ctx.lineTo(w - m, m); ctx.lineTo(w - m, m + s); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(m, h - m - s); ctx.lineTo(m, h - m); ctx.lineTo(m + s, h - m); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(w - m - s, h - m); ctx.lineTo(w - m, h - m); ctx.lineTo(w - m, h - m - s); ctx.stroke();

  ctx.fillStyle = '#FCEE0A';
  ctx.font = '16px monospace';
  ctx.fillText(`SYNTHETIC FRAME ${w}x${h}`, m + 8, h - m - 12);
}

export function cameraSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

export class CameraCapture {
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private live = false;
  private lastReason: string | undefined;

  get isLive(): boolean {
    return this.live;
  }

  get reason(): string | undefined {
    return this.lastReason;
  }

  /** Ask for the webcam. Never throws - resolves false and records why. */
  async start(): Promise<boolean> {
    if (this.live) return true;
    if (!cameraSupported()) {
      this.lastReason = 'camera API unavailable';
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: TARGET_WIDTH }, height: { ideal: TARGET_HEIGHT } },
        audio: false,
      });

      const v = document.createElement('video');
      v.autoplay = true;
      v.playsInline = true;
      v.muted = true;
      v.srcObject = this.stream;
      await v.play().catch(() => { /* autoplay may need a gesture; capture still works */ });

      // wait briefly for real dimensions
      const started = Date.now();
      while ((v.videoWidth === 0 || v.videoHeight === 0) && Date.now() - started < 2000) {
        await new Promise((r) => setTimeout(r, 50));
      }

      this.video = v;
      this.live = v.videoWidth > 0;
      this.lastReason = this.live ? undefined : 'camera produced no frames';
      if (!this.live) this.stop();
      return this.live;
    } catch (err) {
      const name = (err as any)?.name;
      this.lastReason =
        name === 'NotAllowedError' ? 'camera permission denied'
        : name === 'NotFoundError' ? 'no camera device found'
        : name === 'NotReadableError' ? 'camera is in use by another application'
        : String((err as Error)?.message ?? err);
      this.stop();
      return false;
    }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.video) {
      this.video.srcObject = null;
    }
    this.stream = null;
    this.video = null;
    this.live = false;
  }

  /** Capture one frame. Live camera if available, deterministic synthetic otherwise. */
  capture(): FrameCapture {
    const w = this.video?.videoWidth || TARGET_WIDTH;
    const h = this.video?.videoHeight || TARGET_HEIGHT;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      return { dataUrl: '', width: w, height: h, source: 'synthetic', reason: 'no 2d context' };
    }

    if (this.live && this.video) {
      try {
        ctx.drawImage(this.video, 0, 0, w, h);
        return {
          dataUrl: canvas.toDataURL('image/jpeg', 0.6),
          width: w,
          height: h,
          source: 'camera',
        };
      } catch {
        // fall through to synthetic rather than returning an unusable frame
      }
    }

    drawSynthetic(ctx, w, h);
    return {
      dataUrl: canvas.toDataURL('image/jpeg', 0.6),
      width: w,
      height: h,
      source: 'synthetic',
      reason: this.lastReason,
    };
  }

  /** Paint the live feed behind the HUD reticles, if there is one. */
  drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
    if (!this.live || !this.video) return false;
    try {
      ctx.drawImage(this.video, 0, 0, w, h);
      return true;
    } catch {
      return false;
    }
  }
}

export const camera = new CameraCapture();
