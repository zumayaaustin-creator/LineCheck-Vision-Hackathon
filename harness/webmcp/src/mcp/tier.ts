/**
 * Model-tier + proxy-telemetry helpers.
 *
 * Deliberately dependency-free (no `import.meta`, no DOM) so the node-side tests import the same
 * code the HUD runs. `config/env.ts` cannot be used here for exactly that reason: it reads
 * `import.meta.env` at module scope and is therefore bundler-only.
 */

export type ModelTier = 'primary' | 'open-weights';

export const MODEL_TIERS: readonly ModelTier[] = ['primary', 'open-weights'];

/** what each tier is expected to be served by; shown before a response arrives */
export const TIER_MODEL_ID: Record<ModelTier, string> = {
  primary: 'muse-spark-1.3',
  'open-weights': 'muse-spark-open-1026',
};

export interface ProxyTelemetry {
  modelTier: ModelTier | null;
  modelId: string;
  cached: boolean | null;
  ledgerSpentUsd: number | null;
  lastError: string | null;
}

export interface TierRefusal {
  code: 'tier_not_configured' | 'unknown_model_tier';
  message: string;
}

/** headers may be a real `Headers` instance or a plain record (tests, fixtures) */
export type HeaderBag =
  | { get(name: string): string | null }
  | Record<string, string | undefined>
  | null
  | undefined;

export function tierHeader(tier: ModelTier): Record<string, string> {
  return { 'x-model-tier': tier };
}

export function toggleTier(tier: ModelTier): ModelTier {
  return tier === 'primary' ? 'open-weights' : 'primary';
}

export function asTier(value: unknown): ModelTier | null {
  return value === 'primary' || value === 'open-weights' ? value : null;
}

export function headerValue(headers: HeaderBag, name: string): string | null {
  if (!headers) return null;
  const withGet = headers as { get?: (n: string) => string | null };
  if (typeof withGet.get === 'function') {
    const v = withGet.get(name);
    return v === null || v === undefined ? null : String(v);
  }
  const rec = headers as Record<string, string | undefined>;
  const v = rec[name] ?? rec[name.toLowerCase()];
  return v === undefined ? null : String(v);
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Read the proxy's serving telemetry off a Spark response.
 *
 * `_meta` is authoritative - the proxy stamps it when it serves, never before it caches - and the
 * response headers are the fallback for a body that is not JSON or a caller that kept only the
 * headers.
 */
export function readTelemetry(body: unknown, headers?: HeaderBag): ProxyTelemetry {
  const rawMeta =
    body && typeof body === 'object' ? (body as { _meta?: unknown })._meta : undefined;
  const meta =
    rawMeta && typeof rawMeta === 'object' ? (rawMeta as Record<string, unknown>) : undefined;

  const cacheHeader = headerValue(headers, 'X-Proxy-Cache');
  const cached =
    typeof meta?.cached === 'boolean'
      ? meta.cached
      : cacheHeader === null
        ? null
        : cacheHeader === 'hit';

  return {
    modelTier: asTier(meta?.modelTier) ?? asTier(headerValue(headers, 'X-Model-Tier')),
    modelId:
      (typeof meta?.modelId === 'string' ? meta.modelId : null) ??
      headerValue(headers, 'X-Model-Id') ??
      '',
    cached,
    ledgerSpentUsd:
      finiteNumber(meta?.ledgerSpentUsd) ?? finiteNumber(headerValue(headers, 'X-Proxy-Ledger-Usd')),
    lastError: null,
  };
}

/**
 * Turn a proxy tier refusal into one line a human can read on the HUD.
 *
 * Only the two 400s the proxy defines are handled here; anything else is an ordinary HTTP
 * failure and must stay one, so a 500 is never dressed up as a tier problem.
 */
export function classifyTierRefusal(status: number, payload: unknown): TierRefusal | null {
  if (status !== 400) return null;
  const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  const code = body?.error;
  const tier =
    asTier(body?.tier) ?? (typeof body?.tier === 'string' ? body.tier : 'unknown');

  if (code === 'tier_not_configured') {
    return {
      code,
      message: `TIER UNAVAILABLE: ${tier} - set META_OPEN_WEIGHTS_SPARK_URL on the proxy`,
    };
  }
  if (code === 'unknown_model_tier') {
    return { code, message: `TIER UNKNOWN: ${tier} - proxy knows primary, open-weights` };
  }
  return null;
}

/**
 * The Spark request, built in one place so the header the proxy routes on is unit-testable
 * without a bundler. `tier` is sent ONLY as a header: putting it in the body would change the
 * proxy's content-addressed cache key for otherwise identical requests.
 */
export function sparkRequestInit(
  transcript: string,
  tools: Array<{ name: string }>,
  tier: ModelTier,
  apiKey = '',
): { method: string; headers: Record<string, string>; body: string } {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...tierHeader(tier),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ transcript, tools }),
  };
}

export function cacheLabel(cached: boolean | null): string {
  return cached === null ? 'CACHE:--' : cached ? 'CACHE:HIT' : 'CACHE:MISS';
}

export function formatLedgerUsd(usd: number | null): string {
  return usd === null ? '$--.-----' : `$${usd.toFixed(5)}`;
}

export interface FooterText {
  tier: string;
  model: string;
  cache: string;
  ledger: string;
}

export function footerText(t: {
  modelTier: ModelTier;
  modelId: string;
  cached: boolean | null;
  ledgerSpentUsd: number | null;
}): FooterText {
  return {
    tier: `TIER:${t.modelTier}`,
    model: `MUSE:${t.modelId || TIER_MODEL_ID[t.modelTier]}`,
    cache: cacheLabel(t.cached),
    ledger: `LEDGER:${formatLedgerUsd(t.ledgerSpentUsd)}`,
  };
}
