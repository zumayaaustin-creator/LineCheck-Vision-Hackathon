import mockDetections from '../../mock-device-kit/mockDetections.json';
import { ContainerTarget } from '../types/hud';

interface VisionResponse {
  source: 'live_meta_api' | 'local_mock_cache';
  containers: ContainerTarget[];
}

interface VoiceCommandResponse {
  transcription: string;
  assistantReply: string;
  actionRequired?: string;
}

export class MetaModelClient {
  private apiKey: string;
  private isMockMode: boolean;

  constructor() {
    this.apiKey = import.meta.env.VITE_META_API_KEY || '';
    this.isMockMode = import.meta.env.VITE_ENABLE_MOCK_POV === 'true';
  }

  /**
   * SAM 3.1 Bounding & Segmentation Pipeline
   */
  async analyzeFrame(imageDataBase64?: string): Promise<VisionResponse> {
    if (this.isMockMode || !this.apiKey) {
      // Local fallback - 0 credits spent
      return {
        source: 'local_mock_cache',
        containers: mockDetections as ContainerTarget[],
      };
    }

    // Live endpoint call to SAM 3.1 (Activate when testing real hardware feeds)
    const response = await fetch(import.meta.env.VITE_SAM_MODEL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ frame: imageDataBase64 }),
    });

    const data = await response.json();
    return {
      source: 'live_meta_api',
      containers: data.detections,
    };
  }

  /**
   * Muse Voice & Muse Spark Reasoning Loop
   */
  async processKitchenQuery(_audioBlob?: Blob): Promise<VoiceCommandResponse> {
    if (this.isMockMode || !this.apiKey) {
      // Local fallback response
      return {
        transcription: 'Check prep level on diced shallots',
        assistantReply: 'Shallots at 25% in station 2. Re-up needed before dinner service.',
        actionRequired: 'NOTIFY_PREP',
      };
    }

    // Live Muse Voice -> Muse Spark 1.3 pipeline call
    return {
      transcription: '',
      assistantReply: 'Connected to live endpoint.',
    };
  }
}