export type HUDStatus = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'ALERT';
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
}

type Listener = (state: HUDState) => void;

class HUDStore {
  private state: HUDState = {
    status: 'IDLE',
    telemetry: { fps: 60, latencyMs: 12, apiCreditSpent: 0.0 },
    reticles: [
      {
        id: 'initial-target',
        x: 180,
        y: 180,
        width: 240,
        height: 240,
        label: 'HOTEL PAN 1/3 (SYS)',
        confidence: 0.94,
        status: 'nominal',
      },
    ],
    audioLevel: 15,
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
