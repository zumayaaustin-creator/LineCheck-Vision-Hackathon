/**
 * Muse Spark 1.3 mock - tool selection from a transcript.
 *
 * The real pipeline is: Muse Voice Transcribe -> Muse Spark 1.3 (picks a tool + arguments) ->
 * WebMCP execution. This fixture implements the middle hop so the whole chain can run without
 * touching Meta: it takes a transcript and the available tool definitions and returns exactly
 * one tool call.
 *
 * Matching is keyword-based on purpose - it is a stand-in, not a parser. Units are resolved to
 * grams here, mirroring where a real Spark parser would normalise them, so tools.ts only ever
 * receives grams.
 */

const LB_TO_G = 453.59237;

function gramsFrom(text) {
  // "2 pounds" / "15 lb" / "10.5 pounds"
  const lb = text.match(/(\d+(?:\.\d+)?)\s*(?:pounds?|lbs?)\b/i);
  if (lb) return Math.round(parseFloat(lb[1]) * LB_TO_G);
  const kg = text.match(/(\d+(?:\.\d+)?)\s*(?:kilograms?|kgs?)\b/i);
  if (kg) return Math.round(parseFloat(kg[1]) * 1000);
  const g = text.match(/(\d+(?:\.\d+)?)\s*(?:grams?|g)\b/i);
  if (g) return Math.round(parseFloat(g[1]));
  const oz = text.match(/(\d+(?:\.\d+)?)\s*(?:ounces?|oz)\b/i);
  if (oz) return Math.round(parseFloat(oz[1]) * 28.349523125);
  return null;
}

/** pull the pan label out of "4-inch hotel pan", "1/6 pan", "deep half pan" */
function panLabel(text) {
  const inch = text.match(/(\d+(?:\.\d+)?)[- ]?inch\s*([a-z ]*pan)/i);
  if (inch) return `${inch[1]}-inch ${inch[2].trim()}`.replace(/\s+/g, ' ');
  const frac = text.match(/((?:1\/\d+)|(?:half|third|quarter|full))\s*([a-z ]*pan)/i);
  if (frac) return `${frac[1]} ${frac[2].trim()}`.replace(/\s+/g, ' ');
  return null;
}

function fillFrom(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/i);
  return m ? Math.min(100, Math.max(0, parseFloat(m[1]))) : null;
}

/**
 * @param {string} transcript
 * @param {Array<{name:string}>} tools  available tool names from src/mcp/tools.ts
 * @returns {{tool: {name: string, arguments: object}, confidence: number, rationale: string}}
 */
export function dispatch(transcript, tools = []) {
  const t = String(transcript || '');
  const low = t.toLowerCase();
  const has = (name) => tools.length === 0 || tools.some((x) => x.name === name);

  // record_waste
  if (has('record_waste') && /\b(waste|trim|spoilage|scrap|throw out|log)\b/.test(low)) {
    const weight = gramsFrom(low) ?? 0;
    return {
      tool: {
        name: 'record_waste',
        arguments: {
          ingredient: /salmon/.test(low) ? 'Salmon Trim'
            : /chicken/.test(low) ? 'Chicken Trim'
            : /pork/.test(low) ? 'Pork Collar'
            : 'Unspecified',
          weight_g: weight || 907,
          reason: /trim/.test(low) ? 'Trim waste' : /spoil/.test(low) ? 'Spoilage' : 'Logged waste',
        },
      },
      confidence: 0.94,
      rationale: 'waste/trim vocabulary + a resolvable weight',
    };
  }

  // calculate_yield - needs two weights
  if (has('calculate_yield') && /\b(yield|edible|as purchased|ap|ep)\b/.test(low)) {
    const all = [...low.matchAll(/(\d+(?:\.\d+)?)\s*(?:pounds?|lbs?|kilograms?|kgs?|grams?|g)\b/gi)];
    let ap = null, ep = null;
    if (all.length >= 2) {
      const toG = (s) => gramsFrom(s);
      ap = toG(all[0][0]);
      ep = toG(all[1][0]);
    }
    if (!ap) ap = 6804;
    if (!ep) ep = 4762;
    return {
      tool: {
        name: 'calculate_yield',
        arguments: { ap_weight_g: ap, ep_weight_g: ep, trim_weight_g: Math.max(0, ap - ep) },
      },
      confidence: 0.91,
      rationale: 'yield vocabulary + two resolvable weights',
    };
  }

  // tare_scale
  if (has('tare_scale') && /\b(tare|zero|zeroed|calibrat)/.test(low)) {
    const unit = /\bounces?\b|\boz\b/.test(low) ? 'oz' : /\blbs?\b|\bpounds?\b/.test(low) ? 'lbs' : 'g';
    return {
      tool: { name: 'tare_scale', arguments: { unit } },
      confidence: 0.97,
      rationale: 'tare/zero verb',
    };
  }

  // verify_pan_depth
  if (has('verify_pan_depth') && /\b(depth|fill|pan)\b/.test(low)) {
    return {
      tool: {
        name: 'verify_pan_depth',
        arguments: {
          pan_type: panLabel(t) ?? 'Unspecified Pan',
          fill_percentage: fillFrom(t) ?? 15,
        },
      },
      confidence: 0.89,
      rationale: 'pan vocabulary + pan label or fill percentage',
    };
  }

  return {
    tool: { name: 'verify_pan_depth', arguments: { pan_type: 'Unspecified Pan', fill_percentage: 15 } },
    confidence: 0.35,
    rationale: 'no strong match - defaulted so the chain still completes',
  };
}
