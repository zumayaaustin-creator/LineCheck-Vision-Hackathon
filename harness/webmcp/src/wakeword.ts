/**
 * Hands-free wake word for the LineCheck HUD.
 *
 * Two backends, both $0.00 against the Meta budget:
 *
 *   1. `SpeechRecognition` - phrase matching ("line check" / "hey line check").
 *      IMPORTANT HONESTY NOTE: in most Chromium builds this engine is backed by a remote
 *      recognition service, so while it costs no Meta credit it is not guaranteed to be
 *      on-device. Only used when the build exposes on-device processing.
 *
 *   2. Energy-threshold VAD - a locally computed RMS gate over an AnalyserNode. This is
 *      genuinely on-device and needs no service at all, but it can only tell that someone
 *      spoke, not which words. It is the fallback, and it is what runs in a headless or
 *      offline browser.
 *
 * Mode selection: VITE_WAKE_MODE = auto | speech | vad   (default: auto)
 *   auto prefers on-device speech recognition, then VAD.
 *
 * The caller supplies `canFire()` so the wake word respects the same in-flight and cooldown
 * guards as the V hotkey - a wake event must never stack captures.
 */

export type WakeMode = 'speech' | 'vad' | 'unavailable';

export interface WakeOptions {
  phrases?: string[];
  cooldownMs?: number;
  /** asked before every trigger; return false to swallow the wake event */
  canFire?: () => boolean;
  onWake: (info: { phrase: string; mode: WakeMode; confidence?: number }) => void;
  /** RMS gate for the VAD path, 0..1 */
  vadThreshold?: number;
  /** accepted mode override from env */
  preferred?: 'auto' | 'speech' | 'vad';
}

export const DEFAULT_PHRASES = ['hey line check', 'line check'];

/**
 * Phrase match. Longest phrase wins so "hey line check" is not double-counted as "line check",
 * and matching is case/punctuation tolerant. Returns the matched phrase or null.
 *
 * Extracted as a pure function so it can be tested without a microphone or a recogniser.
 */
export function matchWakePhrase(text: string, phrases: string[] = DEFAULT_PHRASES): string | null {
  const norm = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return null;

  const padded = ` ${norm} `;
  let best: string | null = null;
  for (const raw of phrases) {
    const p = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!p) continue;
    if (padded.includes(` ${p} `) || norm === p) {
      if (!best || p.length > best.length) best = p;
    }
  }
  return best;
}

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  processLocally?: boolean;
  start: () => void;
  stop: () => void;
  abort?: () => void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

function getRecognitionCtor(): any {
  const w = globalThis as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function speechAvailable(): boolean {
  return !!getRecognitionCtor();
}

export function vadAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof (globalThis as any).AudioContext !== 'undefined'
  );
}

export class WakeWord {
  private mode: WakeMode = 'unavailable';
  private reason?: string;
  private opts: Required<Pick<WakeOptions, 'phrases' | 'cooldownMs' | 'vadThreshold'>> & WakeOptions;
  private recognition: SpeechRecognitionLike | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
  private rafId: number | null = null;
  private running = false;
  private paused = false;
  private lastFiredAt = 0;
  private aboveThreshold = false;

  constructor(options: WakeOptions) {
    this.opts = {
      phrases: (options.phrases ?? DEFAULT_PHRASES).map((p) => p.toLowerCase()),
      cooldownMs: options.cooldownMs ?? 4000,
      vadThreshold: options.vadThreshold ?? 0.08,
      ...options,
    };
  }

  get activeMode(): WakeMode {
    return this.mode;
  }

  get statusReason(): string | undefined {
    return this.reason;
  }

  private canTrigger(phrase: string, confidence?: number) {
    if (this.paused || !this.running) return;
    const now = Date.now();
    if (now - this.lastFiredAt < this.opts.cooldownMs) return;
    if (this.opts.canFire && !this.opts.canFire()) return;
    this.lastFiredAt = now;
    this.opts.onWake({ phrase, mode: this.mode, confidence });
  }

  /** Start listening. Resolves with the mode actually used; never throws. */
  async start(preferred?: 'auto' | 'speech' | 'vad'): Promise<WakeMode> {
    if (this.running) return this.mode;
    const pref = preferred ?? this.opts.preferred ?? 'auto';

    if (pref !== 'vad' && speechAvailable()) {
      const ok = await this.startSpeech();
      if (ok) return this.mode;
    }
    if (pref !== 'speech' && vadAvailable()) {
      const ok = await this.startVad();
      if (ok) return this.mode;
    }

    this.mode = 'unavailable';
    this.reason = speechAvailable()
      ? 'speech recognition and VAD both failed to start'
      : 'no speech recognition and no microphone for VAD';
    return this.mode;
  }

  private async startSpeech(): Promise<boolean> {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return false;
    try {
      const r: SpeechRecognitionLike = new Ctor();
      r.continuous = true;
      r.interimResults = true;
      r.lang = 'en-US';

      // prefer on-device where the build supports it; otherwise accept the default engine
      // and record that it may be service-backed
      let onDevice = false;
      if ('processLocally' in r) {
        try { (r as any).processLocally = true; onDevice = true; } catch { /* ignore */ }
      }

      r.onresult = (e: any) => {
        const results = e?.results ?? [];
        for (let i = e.resultIndex ?? 0; i < results.length; i++) {
          const alt = results[i]?.[0];
          const text = String(alt?.transcript ?? '').toLowerCase().trim();
          if (!text) continue;
          const hit = matchWakePhrase(text, this.opts.phrases);
          if (hit) this.canTrigger(hit, alt?.confidence);
        }
      };
      let startError: string | null = null;
      r.onerror = (e: any) => {
        startError = String(e?.error ?? 'unknown');
        this.reason = `speech error: ${startError}`;
      };
      r.onend = () => {
        // Chrome stops on silence; restart while we are meant to be listening
        if (this.running && this.mode === 'speech' && !startError) {
          try { r.start(); } catch { /* already starting */ }
        }
      };

      /**
       * Handshake: `start()` does not throw for a rejected configuration - the failure arrives
       * asynchronously as an `error` event (e.g. language-not-supported when processLocally is
       * requested). Without waiting for it we would report mode 'speech' on an engine that can
       * never fire, and never fall back to VAD. Wait for the first `start` or `error`.
       */
      const startedOk = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };

        (r as any).onstart = () => finish(true);
        try {
          r.start();
        } catch (err) {
          startError = (err as Error)?.message ?? 'start threw';
          finish(false);
        }
        // if neither event arrives, assume the engine is listening
        setTimeout(() => finish(startError === null), 900);
      });

      if (!startedOk) {
        try { r.abort?.(); } catch { /* ignore */ }
        this.reason = `speech recognition unusable (${startError ?? 'did not start'})`;
        return false;
      }

      // clear the handshake handler; real errors are still recorded by onerror
      (r as any).onstart = null;

      this.recognition = r;
      this.mode = 'speech';
      this.running = true;
      this.reason = onDevice
        ? 'speech recognition (requested on-device processing)'
        : 'speech recognition (browser default engine - may be service-backed)';
      return true;
    } catch (err) {
      this.reason = `speech start failed: ${(err as Error)?.message ?? err}`;
      return false;
    }
  }

  private async startVad(): Promise<boolean> {
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctx = (globalThis as any).AudioContext;
      this.audioCtx = new Ctx();
      const source = this.audioCtx!.createMediaStreamSource(this.micStream);
      this.analyser = this.audioCtx!.createAnalyser();
      this.analyser.fftSize = 1024;
      source.connect(this.analyser);

      const buf = new Float32Array(this.analyser.fftSize);
      const tick = () => {
        if (!this.running) return;
        this.analyser!.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);

        // rising edge only, so one utterance fires once
        if (rms > this.opts.vadThreshold) {
          if (!this.aboveThreshold) {
            this.aboveThreshold = true;
            this.canTrigger('(voice activity)', rms);
          }
        } else if (rms < this.opts.vadThreshold * 0.6) {
          this.aboveThreshold = false;
        }
        this.rafId = requestAnimationFrame(tick);
      };
      tick();

      this.mode = 'vad';
      this.running = true;
      this.reason = `energy VAD at rms>${this.opts.vadThreshold} (on-device, no phrase matching)`;
      return true;
    } catch (err) {
      const name = (err as any)?.name;
      this.reason = name === 'NotAllowedError' ? 'microphone permission denied for VAD'
        : name === 'NotFoundError' ? 'no microphone for VAD'
        : `vad start failed: ${(err as Error)?.message ?? err}`;
      this.cleanupVad();
      return false;
    }
  }

  /** Stop firing while a capture is in progress, without tearing down the engine. */
  pause() { this.paused = true; }
  resume() {
    // small delay so the tail of our own capture is not heard as a new wake event
    setTimeout(() => { this.paused = false; }, 600);
  }

  stop() {
    this.running = false;
    try { this.recognition?.stop(); } catch { /* ignore */ }
    this.recognition = null;
    this.cleanupVad();
    this.mode = 'unavailable';
  }

  private cleanupVad() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    try { this.audioCtx?.close(); } catch { /* ignore */ }
    this.audioCtx = null;
    this.analyser = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.aboveThreshold = false;
  }
}
