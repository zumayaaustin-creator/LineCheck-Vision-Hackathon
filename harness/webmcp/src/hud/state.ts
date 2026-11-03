import { toggleTier, type ModelTier } from '../mcp/tier';

export type HUDStatus = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'ALERT';
export type { ModelTier };
export type ReticleStatus = 'nominal' | 'warning' | 'breach';

export interface Reticle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  confidence: number;
  status: ReticleStatus;
}

export interface HUDState {
  status: HUDStatus;
  telemetry: {
    fps: number;
    latencyMs: number;
    apiCreditSpent: number;
  };
  reticles: Reticle[];
  audioLevel: number;
  /** which Spark route the HUD asks the proxy for; toggled with `F` */
  modelTier: ModelTier;
  /**
   * Last serving facts the proxy reported. `lastError` drives the warning pill and is the only
   * field here that a failure writes - the reticles are never cleared by a failed call.
   */
  proxy: {
    modelId: string;
    cached: boolean | null;
    ledgerSpentUsd: number | null;
    lastError: string | null;
  };
}

type Listener = (state: HUDState) => void;

class HUDStore {
  private state: HUDState = {
    status: 'IDLE',
    telemetry: { fps: 60, latencyMs: 12, apiCreditSpent: 0.0 },
    // Start empty: a placeholder box cannot know what the frame shows, and would name something
    // that is not there. Reticles appear only after S (snapshot) or a tool result.
    reticles: [],
    audioLevel: 15,
    modelTier: 'primary',
    proxy: { modelId: '', cached: null, ledgerSpentUsd: null, lastError: null },
  };

  private listeners: Set<Listener> = new Set();

  getState(): HUDState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((l) => l(this.state));
  }

  setStatus(status: HUDStatus) {
    this.state.status = status;
    this.notify();
  }

  setTelemetry(telemetry: Partial<HUDState['telemetry']>) {
    this.state.telemetry = { ...this.state.telemetry, ...telemetry };
    this.notify();
  }

  /** set by the F hotkey and by any response that reports a different tier than requested */
  setModelTier(tier: ModelTier) {
    if (this.state.modelTier === tier) return;
    this.state.modelTier = tier;
    this.notify();
  }

  toggleModelTier(): ModelTier {
    this.state.modelTier = toggleTier(this.state.modelTier);
    this.notify();
    return this.state.modelTier;
  }

  setProxyTelemetry(patch: Partial<HUDState['proxy']>) {
    this.state.proxy = { ...this.state.proxy, ...patch };
    this.notify();
  }

  clearProxyError() {
    if (this.state.proxy.lastError === null) return;
    this.state.proxy = { ...this.state.proxy, lastError: null };
    this.notify();
  }

  setAudioLevel(level: number) {
    this.state.audioLevel = Math.max(0, Math.min(100, level));
    this.notify();
  }

  setReticles(reticles: Reticle[]) {
    this.state.reticles = reticles;
    this.notify();
  }

  addReticle(reticle: Reticle) {
    this.state.reticles.push(reticle);
    this.notify();
  }

  clearReticles() {
    this.state.reticles = [];
    this.notify();
  }
}

export const hudStore = new HUDStore();
