/**
 * Bounded microphone capture.
 *
 * Voice is push-to-talk, not an always-on listener: one press records a fixed, short
 * window and hands that single Blob to Muse. This keeps the same rule as SAM - a wake
 * event triggers exactly one call, never a continuous stream.
 *
 * Every failure mode (no device, permission denied, unsupported browser) resolves to a
 * clear thrown error so the HUD can report it without breaking the render loop.
 */

export interface MicOptions {
  /** how long to record, in ms */
  durationMs?: number;
  /** preferred container; the browser picks the first it supports */
  mimeTypes?: string[];
}

const DEFAULT_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export function micSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof (globalThis as any).MediaRecorder !== 'undefined'
  );
}

function pickMime(candidates: string[]): string | undefined {
  const MR = (globalThis as any).MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') return undefined;
  return candidates.find((t) => MR.isTypeSupported(t));
}

/**
 * Record a single bounded window and return it as a Blob.
 * Throws with a human-readable message on any failure.
 */
export async function captureUtterance(options: MicOptions = {}): Promise<Blob> {
  const { durationMs = 2200, mimeTypes = DEFAULT_MIME_CANDIDATES } = options;

  if (!micSupported()) {
    throw new Error('microphone capture is unavailable in this browser context');
  }

  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    const mimeType = pickMime(mimeTypes);
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: BlobPart[] = [];

    recorder.addEventListener('dataavailable', (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });

    const done = new Promise<void>((resolve, reject) => {
      recorder.addEventListener('stop', () => resolve());
      recorder.addEventListener('error', (e: Event) =>
        reject(new Error(`MediaRecorder error: ${(e as any)?.error?.name ?? 'unknown'}`)),
      );
      // safety net: never hang the caller if 'stop' is never delivered
      setTimeout(() => {
        if (recorder.state !== 'inactive') {
          try { recorder.stop(); } catch { /* already stopping */ }
        }
      }, durationMs + 700);
    });

    recorder.start();
    await new Promise((r) => setTimeout(r, durationMs));
    if (recorder.state !== 'inactive') recorder.stop();
    await done;

    if (chunks.length === 0) {
      throw new Error('microphone produced no audio data');
    }
    return new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
  } catch (err) {
    const name = (err as any)?.name;
    if (name === 'NotAllowedError') throw new Error('microphone permission denied');
    if (name === 'NotFoundError') throw new Error('no microphone device found');
    if (name === 'NotReadableError') throw new Error('microphone is in use by another application');
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    // always release the device, otherwise the browser keeps the recording indicator lit
    stream?.getTracks().forEach((t) => t.stop());
  }
}
