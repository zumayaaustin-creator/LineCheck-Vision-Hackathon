import { hudStore, Reticle } from '../hud/state';

export interface RecordWasteParams {
  ingredient: string;
  weight_g: number;
  reason: string;
  /** reticle to annotate in place (case-insensitive label match); omit for the generic overlay box */
  target?: string;
}

export interface CalculateYieldParams {
  ap_weight_g: number;
  ep_weight_g: number;
  trim_weight_g?: number;
  target?: string;
}

export interface TareScaleParams {
  unit: 'g' | 'oz' | 'lbs';
}

export interface VerifyPanDepthParams {
  pan_type: string;
  fill_percentage: number;
  target?: string;
}

/**
 * Annotate the reticle(s) already on the photo instead of replacing the whole set with one fixed
 * box. A label is "<base> | <result>": the base never changes, so repeating a command rewrites the
 * result rather than stacking text. Returns how many reticles matched.
 */
function annotateTarget(
  target: string,
  result: string,
  status: Reticle['status'],
  all = false,
): number {
  const key = target.toUpperCase();
  const current = hudStore.getState().reticles;
  let hits = 0;
  const next = current.map((r) => {
    if (!r.label.toUpperCase().includes(key) || (!all && hits > 0)) return r;
    hits += 1;
    return { ...r, label: `${r.label.split(' | ')[0]} | ${result}`, status };
  });
  if (hits > 0) hudStore.setReticles(next);
  return hits;
}

export function record_waste(params: RecordWasteParams) {
  hudStore.setStatus('ALERT');
  if (params.target) {
    // targeted call: mark the item on the photo (or nothing, if it is not on screen) - no stray box
    annotateTarget(params.target, `WASTE ${params.weight_g}g (${params.reason})`, 'breach');
    return { success: true, logged_g: params.weight_g, code: 'WASTE_LOGGED' };
  }
  const alertReticle: Reticle = {
    id: `waste-${Date.now()}`,
    x: 150,
    y: 150,
    width: 300,
    height: 300,
    label: `WASTE: ${params.ingredient.toUpperCase()} (${params.weight_g}g - ${params.reason})`,
    confidence: 0.99,
    status: 'breach',
  };
  hudStore.setReticles([alertReticle]);
  return { success: true, logged_g: params.weight_g, code: 'WASTE_LOGGED' };
}

export function calculate_yield(params: CalculateYieldParams) {
  hudStore.setStatus('PROCESSING');
  const yieldPct = ((params.ep_weight_g / params.ap_weight_g) * 100).toFixed(1);
  if (params.target) {
    annotateTarget(params.target, `YIELD ${yieldPct}%`, 'nominal', true);
    hudStore.setStatus('IDLE');
    return { success: true, yield_percentage: Number(yieldPct) };
  }
  const nominalReticle: Reticle = {
    id: `yield-${Date.now()}`,
    x: 140,
    y: 140,
    width: 320,
    height: 320,
    label: `YIELD: ${yieldPct}% (EP: ${params.ep_weight_g}g / AP: ${params.ap_weight_g}g)`,
    confidence: 0.98,
    status: 'nominal',
  };
  hudStore.setReticles([nominalReticle]);
  // a yield result is informational, not a transient action: settle out of PROCESSING
  hudStore.setStatus('IDLE');
  return { success: true, yield_percentage: Number(yieldPct) };
}

export function tare_scale(params: TareScaleParams) {
  hudStore.setStatus('PROCESSING');
  const tareReticle: Reticle = {
    id: `tare-${Date.now()}`,
    x: 200,
    y: 200,
    width: 200,
    height: 200,
    label: `SCALE ZEROED [${params.unit.toUpperCase()}]`,
    confidence: 1.0,
    status: 'nominal',
  };
  hudStore.setReticles([tareReticle]);
  // tare completes immediately; leaving PROCESSING would strand the status banner
  hudStore.setStatus('IDLE');
  return { success: true, zero_offset: 0, unit: params.unit };
}

export function verify_pan_depth(params: VerifyPanDepthParams) {
  const isWarning = params.fill_percentage < 20 || params.fill_percentage > 90;
  hudStore.setStatus(isWarning ? 'ALERT' : 'IDLE');
  if (params.target) {
    annotateTarget(params.target, `${params.fill_percentage}%`, isWarning ? 'breach' : 'nominal');
    return { success: true, fill_percentage: params.fill_percentage, nominal: !isWarning };
  }
  const panReticle: Reticle = {
    id: `pan-${Date.now()}`,
    x: 160,
    y: 160,
    width: 280,
    height: 280,
    label: `${params.pan_type.toUpperCase()} DEPTH: ${params.fill_percentage}%`,
    confidence: 0.95,
    status: isWarning ? 'warning' : 'nominal',
  };
  hudStore.setReticles([panReticle]);
  return { success: true, fill_percentage: params.fill_percentage, nominal: !isWarning };
}
/**
 * WebMCP Tool Definitions & Dispatch Registry
 */
export const toolDefinitions = [
  {
    name: 'record_waste',
    description: 'Logs kitchen prep scrap or spoil waste directly onto the HUD with weight and reason.',
    parameters: {
      type: 'object',
      properties: {
        ingredient: { type: 'string', description: 'Name of the ingredient (e.g., pork shoulder, onions)' },
        weight_g: { type: 'number', description: 'Grams wasted or trimmed' },
        reason: { type: 'string', description: 'Reason for waste (e.g., spoilage, silver skin, fat trim)' },
      },
      required: ['ingredient', 'weight_g', 'reason'],
    },
  },
  {
    name: 'calculate_yield',
    description: 'Calculates culinary yield percentage (EP / AP * 100) and displays the calculation on the HUD.',
    parameters: {
      type: 'object',
      properties: {
        ap_weight_g: { type: 'number', description: 'As Purchased weight in grams' },
        ep_weight_g: { type: 'number', description: 'Edible Portion weight in grams' },
        trim_weight_g: { type: 'number', description: 'Optional trim weight in grams' },
      },
      required: ['ap_weight_g', 'ep_weight_g'],
    },
  },
  {
    name: 'tare_scale',
    description: 'Zeroes the virtual or hardware scale readout and draws a calibration reticle.',
    parameters: {
      type: 'object',
      properties: {
        unit: { type: 'string', enum: ['g', 'oz', 'lbs'], description: 'Measurement unit' },
      },
      required: ['unit'],
    },
  },
  {
    name: 'verify_pan_depth',
    description: 'Validates line prep container fill level against par and marks warning if under 20% or over 90%.',
    parameters: {
      type: 'object',
      properties: {
        pan_type: { type: 'string', description: 'Pan size (e.g., 1/6 pan, 1/9 pan, hotel pan)' },
        fill_percentage: { type: 'number', description: 'Current estimated fill percentage (0-100)' },
      },
      required: ['pan_type', 'fill_percentage'],
    },
  },
];

/**
 * Validate a tool call against the schema Spark was given, before any handler runs.
 *
 * Spark is handed these definitions (the proxy injects `tools.json` when a caller forgets), but a
 * stale prompt or an older integration can still send the wrong field names - the earlier design
 * used `item` / `quantity` / `unit` instead of `ingredient` / `weight_g`. Without this guard,
 * `record_waste` throws a TypeError on `undefined.toUpperCase()` inside a path that is supposed to
 * degrade, and the HUD loses the screen it was drawing.
 */
export function validateArgs(name: string, args: Record<string, unknown>): string | null {
  const def = toolDefinitions.find((d) => d.name === name);
  if (!def) return null; // unknown tools are the switch default's problem, and still throw

  const required = def.parameters.required;
  const missing = required.filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    return `missing ${missing.join(', ')} - expected ${required.join(', ')}`;
  }

  const properties = def.parameters.properties as unknown as Record<string, { type?: string }>;
  for (const [key, spec] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined) continue;
    if (spec.type === 'number' && typeof value !== 'number') return `${key} must be a number`;
    if (spec.type === 'string' && typeof value !== 'string') return `${key} must be a string`;
  }
  return null;
}

export async function executeTool(name: string, args: Record<string, unknown>) {
  const invalid = validateArgs(name, args);
  if (invalid) {
    return { success: false, code: 'INVALID_ARGS', error: `Tool "${name}" rejected: ${invalid}` };
  }

  switch (name) {
    case 'record_waste':
      return record_waste(args as unknown as RecordWasteParams);
    case 'calculate_yield':
      return calculate_yield(args as unknown as CalculateYieldParams);
    case 'tare_scale':
      return tare_scale(args as unknown as TareScaleParams);
    case 'verify_pan_depth':
      return verify_pan_depth(args as unknown as VerifyPanDepthParams);
    default:
      throw new Error(`Tool "${name}" not recognized in kitchen WebMCP registry.`);
  }
}