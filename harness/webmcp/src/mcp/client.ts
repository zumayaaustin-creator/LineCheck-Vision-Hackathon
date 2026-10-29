import mockDetections from '../../mock-device-kit/mockDetections.json';
import type { ContainerTarget } from '../types/hud';
import { env, shouldUseMock, mockReason, HUD_SIZE } from '../config/env';
import { normalizeToHud, type RawDetection, type SourceFrame } from './normalize';

export interface VisionResponse {
  source: 'live_meta_api' | 'local_mock_cache';
  containers: ContainerTarget[];
  /** why the mock path was chosen, so a mock run can never be mistaken for a live one */
  mockReason?: string | null;
  /** true when a call was suppressed by the throttle */
  throttled?: boolean;
}

export interface VoiceCommandResponse {
  transcription: string;
  assistantReply: string;
  actionRequired?: string;
  source: 'live_meta_api' | 'local_mock_cache';
}

/** Shape of the mock fixture: already in HUD space, so it is passed through unnormalised. */
const MOCK_HUD_SPACE: SourceFrame = { width: HUD_SIZE, height: HUD_SIZE };

export class MetaModelClient {
  private inFlight = false;
  private lastCallAt = 0;
  private lastResponse: VisionResponse | null = null;

  /** source frame geometry the live model returns boxes in */
  private frame: SourceFrame = { width: env.sourceWidth, height: env.sourceHeight };

  get isMockMode(): boolean {
    return shouldUseMock();
  }

  /**
   * One SAM 3.1 segmentation pass.
   *
   * This must be called ONLY from an explicit snapshot event (hotkey / wake word).
   * It is deliberately not safe to call per animation frame: an in-flight guard and a
   * minimum interval both refuse rapid calls, so a stray rAF loop cannot burn credits.
   */
  async analyzeFrame(imageDataBase64?: string): Promise<VisionResponse> {
    if (shouldUseMock()) {
      return {
        source: 'local_mock_cache',
        containers: normalizeToHud(mockDetections as RawDetection[], MOCK_HUD_SPACE),
        mockReason: mockReason(),
      };
    }

    // ---- throttle: never two paid calls at once, never rapid-fire ----
    const now = Date.now();
    if (this.inFlight) {
      return this.lastResponse ?? { source: 'live_meta_api', containers: [], throttled: true };
    }
    if (now - this.lastCallAt < env.minSnapshotIntervalMs) {
      return this.lastResponse ?? { source: 'live_meta_api', containers: [], throttled: true };
    }

    this.inFlight = true;
    this.lastCallAt = now;
    try {
      const response = await fetch(env.samEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.metaApiKey}`,
        },
        body: JSON.stringify({ frame: imageDataBase64, width: this.frame.width, height: this.frame.height }),
      });

      if (!response.ok) {
        throw new Error(`SAM 3.1 HTTP ${response.status}`);
      }

      const data = (await response.json()) as { detections?: RawDetection[] };
      const containers = normalizeToHud(data.detections ?? [], this.frame);
      this.lastResponse = { source: 'live_meta_api', containers };
      return this.lastResponse;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Muse Voice -> Muse Spark reasoning. Also gated: one shot per explicit wake event,
   * never opened on a continuous microphone loop.
   */
  async processKitchenQuery(audioBlob?: Blob): Promise<VoiceCommandResponse> {
    if (shouldUseMock()) {
      return {
        source: 'local_mock_cache',
        transcription: 'Check prep level on diced shallots',
        assistantReply: 'Shallots at 25% in station 2. Re-up needed before dinner service.',
        actionRequired: 'NOTIFY_PREP',
      };
    }

    if (!audioBlob) {
      throw new Error('processKitchenQuery requires an audio blob on the live path');
    }
    if (!env.museEndpoint) {
      throw new Error('VITE_MUSE_AUDIO_ENDPOINT is not set');
    }

    const body = new FormData();
    body.append('audio', audioBlob, 'wake.wav');

    const response = await fetch(env.museEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.metaApiKey}` },
      body,
    });
    if (!response.ok) throw new Error(`Muse HTTP ${response.status}`);

    const data = (await response.json()) as { transcription?: string; reply?: string; action?: string };
    return {
      source: 'live_meta_api',
      transcription: data.transcription ?? '',
      assistantReply: data.reply ?? '',
      actionRequired: data.action,
    };
  }
}

export const metaClient = new MetaModelClient();
