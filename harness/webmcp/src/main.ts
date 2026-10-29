import { hudStore, Reticle } from './hud/state';
import { executeTool } from './mcp/tools';
import { metaClient } from './mcp/client';
import { normalizeToHud } from './mcp/normalize';
import { shouldUseMock, mockReason, HUD_SIZE } from './config/env';

const canvas =
  document.querySelector<HTMLCanvasElement>('#hud-canvas') ||
  document.querySelector<HTMLCanvasElement>('canvas');
if (!canvas) {
  console.error('[HUD] Canvas element not found!');
}

const ctx = canvas?.getContext('2d');
if (canvas) {
  canvas.width = HUD_SIZE;
  canvas.height = HUD_SIZE;
}

/**
 * Draw loop. This is pure rendering of current state: it must never call the Meta API.
 * SAM 3.1 is snapshot-only (see triggerSnapshot) so an animation frame can never spend
 * credits.
 */
function render() {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, HUD_SIZE, HUD_SIZE);

  const state = hudStore.getState();

  // Status banner. The HTML header occupies canvas-space y 12-31, so this sits below it.
  ctx.font = '10px monospace';
  ctx.fillStyle = state.status === 'ALERT' ? '#BD00FF' : '#00F0FF';
  ctx.fillText(`STATUS: ${state.status}`, 20, 48);

  // Mock/live indicator, so a mock run is never mistaken for a live one
  const mock = shouldUseMock();
  ctx.fillStyle = mock ? '#FCEE0A' : '#00F0FF';
  ctx.fillText(`SAM 3.1: ${mock ? `MOCK (${mockReason() ?? 'default'})` : 'LIVE'}`, 20, 62);

  // Draw Reticles
  state.reticles.forEach((r: Reticle) => {
    const stroke = r.status === 'breach' ? '#BD00FF' : r.status === 'warning' ? '#FCEE0A' : '#00F0FF';
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.width, r.height);

    // Size the label plate to the text, not the reticle, or long labels spill out of it
    ctx.font = 'bold 11px monospace';
    const labelW = Math.max(r.width, Math.ceil(ctx.measureText(r.label).width) + 12);
    ctx.fillStyle = 'rgba(5, 5, 5, 0.9)';
    ctx.fillRect(r.x, r.y - 18, labelW, 18);
    ctx.strokeRect(r.x, r.y - 18, labelW, 18);

    ctx.fillStyle = stroke;
    ctx.fillText(r.label, r.x + 6, r.y - 5);
  });

  requestAnimationFrame(render);
}
render();

// Console exposure
(window as any).executeTool = executeTool;
(window as any).hudStore = hudStore;
(window as any).metaClient = metaClient;
// exposed so the coordinate contract can be checked from the console / an e2e pass
(window as any).normalizeToHud = normalizeToHud;

/**
 * Snapshot: the ONLY path that can hit SAM 3.1.
 * Guarded so repeated presses cannot stack calls; the client also throttles internally.
 */
let snapshotInFlight = false;
let lastSnapshotAt = 0;

async function triggerSnapshot() {
  const now = Date.now();
  if (snapshotInFlight) {
    console.log('[HUD] snapshot ignored: call already in flight');
    return;
  }
  if (now - lastSnapshotAt < 400) {
    console.log('[HUD] snapshot ignored: debounced');
    return;
  }
  snapshotInFlight = true;
  lastSnapshotAt = now;
  hudStore.setStatus('PROCESSING');

  try {
    const result = await metaClient.analyzeFrame();
    const breach = result.containers.some((c) => c.status === 'breach');
    const warn = result.containers.some((c) => c.status === 'warning');

    hudStore.setReticles(result.containers);
    hudStore.setStatus(breach ? 'ALERT' : warn ? 'ALERT' : 'IDLE');

    if (result.throttled) console.log('[HUD] snapshot throttled by client, showing last result');
    console.log(`[HUD] snapshot: ${result.source} -> ${result.containers.length} containers`);
  } catch (err) {
    console.error('[HUD] snapshot failed:', err);
    hudStore.setStatus('IDLE');
  } finally {
    snapshotInFlight = false;
  }
}

(window as any).triggerSnapshot = triggerSnapshot;

// Keyboard Test Harness
window.addEventListener('keydown', async (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

  switch (e.key) {
    case 's':
    case 'S':
      await triggerSnapshot();
      break;
    case '1':
      console.log('[HUD] tare_scale');
      await executeTool('tare_scale', { unit: 'g' });
      break;
    case '2':
      console.log('[HUD] calculate_yield');
      await executeTool('calculate_yield', { ap_weight_g: 2200, ep_weight_g: 1650, trim_weight_g: 550 });
      break;
    case '3':
      console.log('[HUD] verify_pan_depth (warning)');
      await executeTool('verify_pan_depth', { pan_type: '1/6 Pan', fill_percentage: 15 });
      break;
    case '4':
      console.log('[HUD] record_waste (alert)');
      await executeTool('record_waste', { ingredient: 'Pork Collar', weight_g: 450, reason: 'Heavy Silver Skin Trim' });
      break;
    case '0':
      console.log('[HUD] Clear');
      hudStore.setStatus('IDLE');
      hudStore.setReticles([]);
      break;
  }
});
