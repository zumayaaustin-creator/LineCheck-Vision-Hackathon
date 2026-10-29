import { hudStore, Reticle } from './hud/state';
import { executeTool } from './mcp/tools';

const canvas = document.querySelector<HTMLCanvasElement>('#hud-canvas') || document.querySelector<HTMLCanvasElement>('canvas');
if (!canvas) {
  console.error('[HUD] Canvas element not found!');
}

const ctx = canvas?.getContext('2d');
if (canvas) {
  canvas.width = 600;
  canvas.height = 600;
}

function render() {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, 600, 600);

  // The store is private state + a getter, so read a snapshot per frame
  const state = hudStore.getState();

  // Status banner. The HTML header occupies canvas-space y 12-31, so drawing at y=25
  // put this text underneath the title. Move it clear of the header.
  ctx.font = '10px monospace';
  ctx.fillStyle = state.status === 'ALERT' ? '#BD00FF' : '#00F0FF';
  ctx.fillText(`STATUS: ${state.status}`, 20, 48);

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

// Keyboard Test Harness
window.addEventListener('keydown', async (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

  switch (e.key) {
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
