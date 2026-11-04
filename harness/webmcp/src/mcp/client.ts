import mockDetections from '../../mock-device-kit/mockDetections.json';
import mockScenes from '../../mock-device-kit/mockScenes.json';
import type { ContainerTarget } from '../types/hud';
import { env, shouldUseMock, mockReason, HUD_SIZE } from '../config/env';
import { normalizeToHud, type RawDetection, type SourceFrame } from './normalize';
import { hudStore } from '../hud/state';
import {
  classifyTierRefusal,
  readTelemetry,
  sparkRequestInit,
  type ModelTier,
  type ProxyTelemetry,
  type TierRefusal,
} from './tier';

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

export interface ResolvedTool {
  toolCall: ToolCall;
  source: 'live_meta_api' | 'local_mock_cache';
  confidence: number;
  /** serving facts the proxy reported for this call (`_meta`, or the response headers) */
  telemetry: ProxyTelemetry;
  /** set when the proxy refused the requested tier; the caller still got a fallback pick */
  refused: TierRefusal | null;
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

/**
 * Mock-mode voice script. Each press of V plays the next line, so the transcript, the tool the
 * HUD runs, and the ledger row it writes all tell one consistent story about the demo photos.
 * Loops after the last line. Mock mode only: live calls never read this.
 */
const MOCK_SCRIPT: Array<{
  transcription: string;
  assistantReply: string;
  actionRequired: string;
  toolCall: ToolCall;
}> = [
  // scene 1 (kitchen line) x4, then scene 3, scene 2, scene 4: three photo changes in the whole take
  {
    transcription: 'Check prep level on the diced onion',
    assistantReply: 'Diced onion at 95% in the 1/6 pan. Overfilled, pull some before it spills.',
    actionRequired: 'NOTIFY_PREP',
    toolCall: { name: 'verify_pan_depth', arguments: { pan_type: '1/6 Pan', fill_percentage: 95, target: 'DICED ONION' } },
  },
  {
    transcription: 'Check the jalapeno pan',
    assistantReply: 'Jalapenos at 55% in the 1/6 pan. Fine for now.',
    actionRequired: 'NOTIFY_PREP',
    toolCall: { name: 'verify_pan_depth', arguments: { pan_type: '1/6 Pan', fill_percentage: 55, target: 'JALAPENOS' } },
  },
  {
    transcription: 'Log salsa waste, three hundred grams, expired',
    assistantReply: 'Logged 300 grams of salsa as expired.',
    actionRequired: 'LOG_WASTE',
    toolCall: { name: 'record_waste', arguments: { ingredient: 'Salsa', weight_g: 300, reason: 'Expired', target: 'SALSA' } },
  },
  {
    transcription: 'Check the black olives',
    assistantReply: 'Black olives at 80% in the 1/6 pan.',
    actionRequired: 'NOTIFY_PREP',
    toolCall: { name: 'verify_pan_depth', arguments: { pan_type: '1/6 Pan', fill_percentage: 80, target: 'BLACK OLIVES' } },
  },
  {
    transcription: 'Log pork roast trim, four hundred fifty grams, fat cap',
    assistantReply: 'Logged 450 grams of pork roast trim as fat cap waste.',
    actionRequired: 'LOG_WASTE',
    toolCall: { name: 'record_waste', arguments: { ingredient: 'Pork Roast', weight_g: 450, reason: 'Fat cap trim', target: 'PORK ROAST' } },
  },
  {
    transcription: 'Yield on the tri-tip, twenty-two hundred purchased, sixteen fifty edible',
    assistantReply: 'Tri-tip yield is 75 percent: 1650 grams edible from 2200 purchased.',
    actionRequired: 'LOG_YIELD',
    toolCall: { name: 'calculate_yield', arguments: { ap_weight_g: 2200, ep_weight_g: 1650, trim_weight_g: 550, target: 'TRI-TIP' } },
  },
  {
    transcription: 'Check the pulled pork half pan',
    assistantReply: 'Pulled pork at 90% in the half pan. Full, hold it hot.',
    actionRequired: 'NOTIFY_PREP',
    toolCall: { name: 'verify_pan_depth', arguments: { pan_type: '1/2 Pan', fill_percentage: 90, target: 'PULLED PORK' } },
  },
];

export class MetaModelClient {
  private inFlight = false;
  private lastCallAt = 0;
  private lastResponse: VisionResponse | null = null;
  /** mock voice script position, and the tool the last scripted line resolves to */
  private mockIndex = 0;
  private pendingMockTool: ToolCall | null = null;

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
  async analyzeFrame(
    imageDataBase64?: string,
    frame?: { width: number; height: number },
    /** demo scene slot (1-4) when the frame is one of the bundled demo photos, else null */
    sceneSlot?: number | null,
  ): Promise<VisionResponse> {
    if (shouldUseMock()) {
      // a bundled demo photo has hand-placed boxes; anything else gets the generic fixture
      const sceneBoxes = sceneSlot != null
        ? (mockScenes as unknown as Record<string, RawDetection[]>)[String(sceneSlot)]
        : undefined;
      return {
        source: 'local_mock_cache',
        containers: normalizeToHud(sceneBoxes ?? (mockDetections as RawDetection[]), MOCK_HUD_SPACE),
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
        // a real captured frame carries its own dimensions; fall back to the configured frame
        const sourceFrame = frame ?? this.frame;
        // Ensure the base64 image data does not include "data:image/jpeg;base64,"
        const cleanBase64 = imageDataBase64 && imageDataBase64.includes(',')
          ? imageDataBase64.split(',')[1]
          : imageDataBase64;
        try {
          const response = await fetch(env.samEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // proxy mode: the proxy injects the credential, so none is sent from the browser
              ...(env.metaApiKey ? { Authorization: `Bearer ${env.metaApiKey}` } : {}),
            },
            body: JSON.stringify({ frame: cleanBase64, width: sourceFrame.width, height: sourceFrame.height }),
          });

          if (!response.ok) {
            // surface the upstream's own explanation: a bare status hides schema vs. credit errors
            const detail = await response.text().catch(() => '');
            throw new Error(`SAM 3.1 HTTP ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ''}`);
          }

          const data = (await response.json()) as { detections?: RawDetection[] };
          const containers = normalizeToHud(data.detections ?? [], sourceFrame);
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
      const line = MOCK_SCRIPT[this.mockIndex % MOCK_SCRIPT.length];
      this.mockIndex += 1;
      // resolveTool() runs next in the chain and must pick THIS line's tool, not re-guess from words
      this.pendingMockTool = line.toolCall;
      return { source: 'local_mock_cache', ...line };
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
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Muse HTTP ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ''}`);
    }

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
    tier: ModelTier = 'primary',
  ): Promise<ResolvedTool> {
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
      return { toolCall: { name: 'verify_pan_depth', arguments: { pan_type: '1/6 Pan', fill_percentage: 25 } }, confidence: 0.6 };
    };

    const offline = (
      telemetry: ProxyTelemetry,
      refused: TierRefusal | null = null,
    ): ResolvedTool => ({ ...localFallback(), source: 'local_mock_cache', telemetry, refused });

    if (shouldUseMock() && this.pendingMockTool) {
      const scripted = this.pendingMockTool;
      this.pendingMockTool = null;
      return {
        toolCall: scripted,
        source: 'local_mock_cache',
        confidence: 0.95,
        telemetry: { modelTier: null, modelId: '', cached: null, ledgerSpentUsd: null, lastError: null },
        refused: null,
      };
    }

    if (shouldUseMock() || !env.museSparkEndpoint) {
      return offline({
        modelTier: null,
        modelId: '',
        cached: null,
        ledgerSpentUsd: null,
        lastError: null,
      });
    }

    const response = await fetch(
      env.museSparkEndpoint,
      sparkRequestInit(transcript, tools, tier, env.metaApiKey),
    );

    if (!response.ok) {
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        /* an empty or non-JSON error body is still an error, just an unlabelled one */
      }

      const refusal = classifyTierRefusal(response.status, payload);
      if (refusal) {
        // A misconfigured tier is a state change, not an exception: the reticles already on
        // screen stay exactly as they are, the next frame draws a warning pill, and the user
        // still gets a locally-resolved tool so the HUD keeps working.
        const telemetry: ProxyTelemetry = {
          modelTier: tier,
          modelId: '',
          cached: null,
          ledgerSpentUsd: null,
          lastError: refusal.message,
        };
        hudStore.setProxyTelemetry({
          modelId: telemetry.modelId,
          cached: telemetry.cached,
          ledgerSpentUsd: telemetry.ledgerSpentUsd,
          lastError: refusal.message,
        });
        console.warn(`[HUD] ${refusal.message} - falling back to local dispatch`);
        return offline(telemetry, refusal);
      }

      throw new Error(`Muse Spark HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      tool?: { name?: string; arguments?: Record<string, unknown> };
      confidence?: number;
      _meta?: Record<string, unknown>;
    };

    const telemetry = readTelemetry(data, response.headers);
    hudStore.setModelTier(telemetry.modelTier ?? tier);
    hudStore.setProxyTelemetry({
      modelId: telemetry.modelId,
      cached: telemetry.cached,
      ledgerSpentUsd: telemetry.ledgerSpentUsd,
      lastError: null,
    });

    if (!data.tool?.name) {
      return { ...localFallback(), source: 'local_mock_cache', telemetry, refused: null };
    }
    return {
      toolCall: { name: data.tool.name, arguments: data.tool.arguments ?? {} },
      source: 'live_meta_api',
      confidence: data.confidence ?? 0,
      telemetry,
      refused: null,
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
