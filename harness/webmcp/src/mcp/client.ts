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

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface SpendUsage {
  paidCalls: number;
  totalSpendUsd: number;
  remainingUsd: number;
  cacheHits: number;
  sessionRemainingUsd?: number;
  maxSpendUsd?: number;
}

export interface VoiceCommandResponse {
  transcription: string;
  assistantReply: string;
  actionRequired?: string;
  source: 'live_meta_api' | 'local_mock_cache';
  /** the WebMCP tool a Muse utterance resolves to, ready for executeTool() */
  toolCall?: ToolCall;
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
          // proxy mode: the proxy injects the credential, so none is sent from the browser
          ...(env.metaApiKey ? { Authorization: `Bearer ${env.metaApiKey}` } : {}),
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
  async processKitchenQuery(audioBlob?: Blob, hint?: string): Promise<VoiceCommandResponse> {
    if (shouldUseMock()) {
      return {
        source: 'local_mock_cache',
        transcription: 'Check prep level on diced shallots',
        assistantReply: 'Shallots at 25% in station 2. Re-up needed before dinner service.',
        actionRequired: 'NOTIFY_PREP',
        toolCall: { name: 'verify_pan_depth', arguments: { pan_type: '1/6 Pan', fill_percentage: 25 } },
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
    // optional scenario hint so the mock server can return a specific utterance
    if (hint) body.append('hint', hint);

    const response = await fetch(env.museEndpoint, {
      method: 'POST',
      headers: env.metaApiKey ? { Authorization: `Bearer ${env.metaApiKey}` } : {},
      body,
    });
    if (!response.ok) throw new Error(`Muse HTTP ${response.status}`);

    const data = (await response.json()) as {
      transcription?: string;
      reply?: string;
      action?: string;
      tool?: { name?: string; arguments?: Record<string, unknown> };
    };
    return {
      source: 'live_meta_api',
      transcription: data.transcription ?? '',
      assistantReply: data.reply ?? '',
      actionRequired: data.action,
      toolCall:
        data.tool?.name !== undefined
          ? { name: data.tool.name, arguments: data.tool.arguments ?? {} }
          : undefined,
    };
  }

  /**
   * Muse Spark 1.3 hop: given a transcript and the available tools, pick one tool + arguments.
   * Kept separate from transcription so the chain
   *   transcribe -> dispatch -> executeTool
   * is three observable steps rather than one opaque call.
   */
  async resolveTool(
    transcript: string,
    tools: Array<{ name: string }>,
  ): Promise<{ toolCall: ToolCall; source: 'live_meta_api' | 'local_mock_cache'; confidence: number }> {
    // offline fallback: pick by keyword using the same rules the mock uses
    const localFallback = (): { toolCall: ToolCall; confidence: number } => {
      const low = transcript.toLowerCase();
      if (/waste|trim|spoilage|scrap|log/.test(low)) {
        return { toolCall: { name: 'record_waste', arguments: { ingredient: 'Salmon Trim', weight_g: 907, reason: 'Trim waste' } }, confidence: 0.9 };
      }
      if (/yield|edible|as purchased/.test(low)) {
        return { toolCall: { name: 'calculate_yield', arguments: { ap_weight_g: 6804, ep_weight_g: 4762, trim_weight_g: 2042 } }, confidence: 0.9 };
      }
      if (/tare|zero|calibrat/.test(low)) {
        return { toolCall: { name: 'tare_scale', arguments: { unit: 'g' } }, confidence: 0.9 };
      }
      return { toolCall: { name: 'verify_pan_depth', arguments: { pan_type: '4-inch Hotel Pan', fill_percentage: 15 } }, confidence: 0.6 };
    };

    if (shouldUseMock() || !env.museSparkEndpoint) {
      const f = localFallback();
      return { ...f, source: 'local_mock_cache' };
    }

    const response = await fetch(env.museSparkEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.metaApiKey ? { Authorization: `Bearer ${env.metaApiKey}` } : {}),
      },
      body: JSON.stringify({ transcript, tools }),
    });
    if (!response.ok) throw new Error(`Muse Spark HTTP ${response.status}`);

    const data = (await response.json()) as {
      tool?: { name?: string; arguments?: Record<string, unknown> };
      confidence?: number;
    };
    if (!data.tool?.name) {
      const f = localFallback();
      return { ...f, source: 'local_mock_cache' };
    }
    return {
      toolCall: { name: data.tool.name, arguments: data.tool.arguments ?? {} },
      source: 'live_meta_api',
      confidence: data.confidence ?? 0,
    };
  }

  /** read the proxy's spend ledger; never a paid call, purely informational */
  async getUsage(): Promise<SpendUsage | null> {
    if (!env.proxyUsageUrl) return null;
    try {
      const r = await fetch(env.proxyUsageUrl, { method: 'GET' });
      if (!r.ok) return null;
      return (await r.json()) as SpendUsage;
    } catch {
      return null;
    }
  }
}

export const metaClient = new MetaModelClient();
