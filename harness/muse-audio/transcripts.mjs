/**
 * Muse Voice mock contract payloads.
 *
 * Each transcript maps to exactly one WebMCP tool declared in src/mcp/tools.ts, and
 * carries the parsed arguments so the HUD can execute the tool without a second
 * reasoning hop.
 *
 * Units are resolved here on purpose: 2 lb -> 907 g, 15 lb -> 6804 g, 10.5 lb -> 4762 g.
 * That mirrors what a real Muse Spark 1.3 parser is expected to do, so the tool layer
 * only ever receives grams.
 */

export const TRANSCRIPTS = [
  {
    scenario: 'record_waste',
    transcription: 'log 2 pounds of salmon trim waste',
    reply: 'Logged 907 g of salmon trim. That is a 12% loss on the case.',
    action: 'NOTIFY_PREP',
    tool: { name: 'record_waste', arguments: { ingredient: 'Salmon Trim', weight_g: 907, reason: 'Trim waste' } },
  },
  {
    scenario: 'calculate_yield',
    transcription: 'calculate yield on 15 pounds whole chicken down to 10.5 pounds',
    reply: 'Yield is 70%. 4762 g edible from 6804 g as purchased.',
    action: 'DISPLAY_YIELD',
    tool: { name: 'calculate_yield', arguments: { ap_weight_g: 6804, ep_weight_g: 4762, trim_weight_g: 2042 } },
  },
  {
    scenario: 'tare_scale',
    transcription: 'tare scale for deep half pan',
    reply: 'Scale zeroed for a deep half pan.',
    action: 'TARE',
    tool: { name: 'tare_scale', arguments: { unit: 'g' } },
  },
  {
    scenario: 'verify_pan_depth',
    transcription: 'verify pan depth 4-inch hotel pan',
    reply: '4-inch hotel pan is at 15% - under par for dinner service.',
    action: 'CHECK_DEPTH',
    tool: { name: 'verify_pan_depth', arguments: { pan_type: '4-inch Hotel Pan', fill_percentage: 15 } },
  },
];

let cursor = 0;

/**
 * @param {string|null} scenario  force a specific transcript, or null to cycle in order
 */
export function nextTranscript(scenario = null) {
  if (scenario) {
    const found = TRANSCRIPTS.find((t) => t.scenario === scenario);
    if (found) return found;
  }
  const t = TRANSCRIPTS[cursor % TRANSCRIPTS.length];
  cursor += 1;
  return t;
}

export function allScenarios() {
  return TRANSCRIPTS.map((t) => t.scenario);
}
