/**
 * Single place that reads Vite env. Mock-first is the default: live Meta endpoints are
 * only used when VITE_USE_MOCK_META is explicitly "false" AND a key + endpoint exist.
 *
 * Why the double default: an unset flag, a typo, or a missing .env must never silently
 * start spending SAM 3.1 credits. Failure here has to fall back to the local mock, not
 * to the paid path.
 */

import { HUD_SIZE } from './constants';

export { HUD_SIZE };

const raw = import.meta.env;

function isExplicitlyOff(v: string | undefined): boolean {
  return v === 'false' || v === '0';
}

export const env = {
  /** true unless explicitly disabled */
  useMockMeta: !isExplicitlyOff(raw.VITE_USE_MOCK_META),
  /**
   * Proxy mode: the browser calls a server-side proxy (see harness/proxy-server.mjs) that
   * holds the credential. No key belongs in this bundle, so requiring one here would
   * wrongly force the mock path.
   */
  useProxy: raw.VITE_USE_PROXY === 'true',
  metaApiKey: raw.VITE_META_API_KEY ?? '',
  samEndpoint: raw.VITE_SAM_MODEL_ENDPOINT ?? '',
  museEndpoint: raw.VITE_MUSE_AUDIO_ENDPOINT ?? '',
  museSparkEndpoint: raw.VITE_MUSE_SPARK_ENDPOINT ?? '',
  /** optional: GET <url> returns the proxy's /__usage JSON, shown as a budget readout */
  proxyUsageUrl: raw.VITE_PROXY_USAGE_URL ?? '',
  /** hard floor between paid calls, regardless of how often the UI asks */
  minSnapshotIntervalMs: Number(raw.VITE_SNAPSHOT_MIN_INTERVAL_MS ?? 1500),
  /** source frame geometry the live model returns boxes in */
  sourceWidth: Number(raw.VITE_SOURCE_FRAME_WIDTH ?? 1280),
  sourceHeight: Number(raw.VITE_SOURCE_FRAME_HEIGHT ?? 720),
} as const;

/**
 * Mock is used when the flag is on (default), or when the live path is not fully
 * configured. Never returns false just because a flag was set.
 */
export function shouldUseMock(): boolean {
  if (env.useMockMeta) return true;
  if (!env.samEndpoint) return true;
  // in proxy mode the credential lives server-side, so its absence here is correct
  if (!env.useProxy && !env.metaApiKey) return true;
  return false;
}

/** Human-readable reason, surfaced in the HUD so a mock run is never mistaken for live. */
export function mockReason(): string | null {
  if (env.useMockMeta) return 'VITE_USE_MOCK_META';
  if (!env.samEndpoint) return 'no VITE_SAM_MODEL_ENDPOINT';
  if (!env.useProxy && !env.metaApiKey) return 'no VITE_META_API_KEY';
  return null;
}
