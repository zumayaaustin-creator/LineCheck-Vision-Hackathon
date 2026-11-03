import { hudStore, Reticle, type HUDState } from './hud/state';
import { footerText } from './mcp/tier';
import { executeTool, toolDefinitions } from './mcp/tools';
import { metaClient } from './mcp/client';
import { normalizeToHud } from './mcp/normalize';
import { shouldUseMock, mockReason, HUD_SIZE, env } from './config/env';
import { captureUtterance, micSupported } from './mic';
import { runHudSelfTest } from './selftest';
import { camera, cameraSupported } from './camera';
import { WakeWord } from './wakeword';

// ---- Photo Loader / Scene Slots ----
// v2: invalidates scenes cached by earlier builds so the bundled demo photos always load fresh
const SCENE_STORAGE_KEY = 'linecheck-scenes-v2';
const DEMO_FRAMES_DIR = '/demo-frames/';

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

// ---- Scene/Photo Loader State ----
let loadedScenes: Map<number, { dataUrl: string; name: string; width: number; height: number; source: string; loadedAt: string }> = new Map();
let activeScene: number | null = null;
// Closed by default so the photo is unobstructed. T pins the ledger card open, and a freshly
// saved entry flashes it for a few seconds (ledgerFlashUntil).
let telemetryPanelOpen = false;
interface KitchenState {
  wasteLog?: Array<{ ingredient: string; weight_g: number; reason?: string; timestamp: string }>;
  yieldLog?: Array<{ ap_weight_g?: number; ep_weight_g?: number; timestamp: string }>;
  panDepthAudit?: Array<{ panType: string; fillPercentage: number; timestamp: string }>;
}
let kitchenState: KitchenState | null = null;
let ledgerFlashUntil = 0;
let customFrameDataUrl: string | null = null;
let customFrameDims: { width: number; height: number } | null = null;
let activeContainer: string | null = null;
let activeTareGrams = 0;

function saveScenesToStorage(): void {
  try {
    const obj = Object.fromEntries(loadedScenes.entries());
    localStorage.setItem(SCENE_STORAGE_KEY, JSON.stringify(obj));
  } catch (err) {
    console.warn('[HUD] Failed to save scenes to localStorage:', err);
  }
}

function loadScenesFromStorage(): void {
  try {
    const stored = localStorage.getItem(SCENE_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      Object.entries(parsed).forEach(([slot, data]) => {
        const slotNum = Number(slot);
        if ([1, 2, 3, 4].includes(slotNum)) {
          loadedScenes.set(slotNum, data as { dataUrl: string; name: string; width: number; height: number; source: string; loadedAt: string });
        }
      });
    }
  } catch (err) {
    console.warn('[HUD] Failed to load scenes from localStorage:', err);
  }
}

loadScenesFromStorage();

const PROXY_BASE = 'http://127.0.0.1:8790';

// Poll kitchen ledger state from proxy
setInterval(async () => {
  try {
    const resp = await fetch(`${PROXY_BASE}/__kitchen/state`);
    if (resp.ok) {
      const kitchen = await resp.json();
      kitchenState = kitchen;
      activeContainer = kitchen.activeContainer || null;
      activeTareGrams = kitchen.activeTareGrams || 0;
    }
  } catch {}
}, 5000);

async function loadDemoFrame(slot: number): Promise<{ dataUrl: string; name: string; width: number; height: number; source: string; loadedAt: string } | null> {
  const url = `${DEMO_FRAMES_DIR}scene-${slot}.jpg`;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      resolve({
        dataUrl,
        name: `Demo Scene ${slot}`,
        width: img.width,
        height: img.height,
        source: 'demo',
        loadedAt: new Date().toISOString(),
      });
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function loadScene(slot: number): Promise<void> {
  if (loadedScenes.has(slot)) {
    const scene = loadedScenes.get(slot)!;
    customFrameDataUrl = scene.dataUrl;
    customFrameDims = { width: scene.width, height: scene.height };
    activeScene = slot;
    console.log(`[HUD] Loaded scene ${slot}: ${scene.name} (${scene.source})`);
    return;
  }
  const demo = await loadDemoFrame(slot);
  if (demo) {
    loadedScenes.set(slot, demo);
    saveScenesToStorage();
    customFrameDataUrl = demo.dataUrl;
    customFrameDims = { width: demo.width, height: demo.height };
    activeScene = slot;
    console.log(`[HUD] Loaded demo scene ${slot}`);
    return;
  }
  customFrameDataUrl = null;
  customFrameDims = null;
  activeScene = slot;
  console.log(`[HUD] Scene ${slot}: using synthetic grid`);
}

function handleFileDrop(file: File): void {
  if (!file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      let slot = 1;
      for (let i = 1; i <= 4; i++) {
        if (!loadedScenes.has(i)) {
          slot = i;
          break;
        }
      }
      if (loadedScenes.size >= 4) slot = 1;
      const scene = {
        dataUrl,
        name: file.name,
        width: img.width,
        height: img.height,
        source: 'drag',
        loadedAt: new Date().toISOString(),
      };
      loadedScenes.set(slot, scene);
      saveScenesToStorage();
      customFrameDataUrl = scene.dataUrl;
      customFrameDims = { width: img.width, height: img.height };
      activeScene = slot;
      console.log(`[HUD] Dropped image -> slot ${slot}: ${scene.name}`);
    };
    img.src = e.target?.result as string;
  };
  reader.readAsDataURL(file);
}

function setupDragAndDrop(): void {
  const canvasEl = (document.querySelector('#hud-canvas') || document.querySelector('canvas')) as HTMLCanvasElement | null;
  if (!canvasEl) return;
  canvasEl.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).style.borderColor = '#FCEE0A';
  });
  canvasEl.addEventListener('dragleave', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).style.borderColor = '#00F0FF';
  });
  canvasEl.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).style.borderColor = '#00F0FF';
    if (e.dataTransfer?.files.length) {
      handleFileDrop(e.dataTransfer.files[0]);
    }
  });
  canvasEl.addEventListener('click', async (e: MouseEvent) => {
    const canvasEl = document.querySelector('#hud-canvas') || document.querySelector('canvas');
    if (!canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x > 450 && y > 500) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png';
      input.onchange = (e) => {
        const target = e.target as HTMLInputElement;
        if (target?.files?.length) handleFileDrop(target.files[0]);
      };
      input.click();
    }
  });
}

// Initialize scenes on startup
(async () => {
  await loadScene(1);
  setupDragAndDrop();
})();

/**
 * Spend readout. Polled from the proxy's local /__usage endpoint on a slow timer - a GET
 * against localhost that never touches the paid path, so it cannot spend anything.
 */
let budgetText = '';
let wakeText = '';
let lastFrameText = '';

async function refreshBudget() {
  const u = await metaClient.getUsage();
  budgetText = u
    ? `BUDGET: $${(u.remainingUsd ?? 0).toFixed(2)} left  (spent $${(u.totalSpendUsd ?? 0).toFixed(2)} / ${u.paidCalls ?? 0} calls / ${u.cacheHits ?? 0} cached)`
    : '';
}
void refreshBudget();
setInterval(() => { void refreshBudget(); }, 10000);

/**
 * Draw loop. This is pure rendering of current state: it must never call the Meta API.
 * SAM 3.1 is snapshot-only (see triggerSnapshot) so an animation frame can never spend
 * credits.
 */
/**
 * Strip geometry, declared before the first draw call.
 *
 * `render()` runs at module scope, so these must be initialised before it is reached - a `const`
 * placed next to the drawing functions below would be in its temporal dead zone when the first
 * frame is drawn, which is a blank HUD and a ReferenceError, not a layout bug.
 *
 * The strip sits above the HTML `.hud-footer` (which overlays the last ~24px of the frame).
 */
const FOOTER_STRIP_H = 18;
const FOOTER_STRIP_GAP = 26;
const FOOTER_STRIP_Y = HUD_SIZE - FOOTER_STRIP_GAP - FOOTER_STRIP_H;
const WARNING_PILL_H = 18;

/**
 * Active scene photo, decoded once per source. Declared before the first draw for the same
 * reason as the strip geometry above: render() runs at module scope.
 */
let sceneImg: HTMLImageElement | null = null;
let sceneImgSrc: string | null = null;

/**
 * Draw the loaded photo "contained" inside the square canvas: the whole picture, aspect ratio
 * preserved, dark bars on the short side. Never stretched or cropped, so reticle coordinates
 * authored against a photo's contained position stay exact. Returns false if nothing was drawn.
 */
function drawSceneBackground(): boolean {
  if (!ctx || !customFrameDataUrl || !customFrameDims) return false;
  if (sceneImgSrc !== customFrameDataUrl) {
    const src = customFrameDataUrl;
    sceneImgSrc = src;
    sceneImg = null;
    const img = new Image();
    img.onload = () => {
      if (sceneImgSrc === src) sceneImg = img; // ignore a decode that lost a race with a scene switch
    };
    img.src = src;
  }
  if (!sceneImg) return false;
  const { width: w, height: h } = customFrameDims;
  const scale = Math.min(HUD_SIZE / w, HUD_SIZE / h);
  const dw = w * scale;
  const dh = h * scale;
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, HUD_SIZE, HUD_SIZE);
  ctx.drawImage(sceneImg, (HUD_SIZE - dw) / 2, (HUD_SIZE - dh) / 2, dw, dh);
  return true;
}

function drawFrame() {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, HUD_SIZE, HUD_SIZE);

  const state = hudStore.getState();

  // A loaded scene photo wins over the camera, matching triggerSnapshot, which also prefers the
  // custom frame. With no scene loaded, the live camera is drawn behind the reticles.
  if (!drawSceneBackground() && camera.isLive) camera.drawBackground(ctx, HUD_SIZE, HUD_SIZE);

  // Status banner. The HTML header occupies canvas-space y 12-31, so this sits below it.
  ctx.font = '10px monospace';
  ctx.fillStyle = state.status === 'ALERT' ? '#BD00FF' : '#00F0FF';
  ctx.fillText(`STATUS: ${state.status}`, 20, 48);

  // Mock/live indicator, so a mock run is never mistaken for a live one
  const mock = shouldUseMock();
  ctx.fillStyle = mock ? '#FCEE0A' : '#00F0FF';
  ctx.fillText(`SAM 3.1: ${mock ? `MOCK (${mockReason() ?? 'default'})` : 'LIVE'}`, 20, 62);

  // frame source + wake-word state
  if (lastFrameText || wakeText) {
    ctx.font = '10px monospace';
    ctx.fillStyle = '#00F0FF';
    ctx.fillText(`${lastFrameText}${wakeText ? '  ' + wakeText : ''}`, 20, 90);
  }

  // Spend readout, only when a proxy is actually reporting a ledger
  if (budgetText) {
    const exhausted = budgetText.startsWith('BUDGET: $0.00');
    ctx.fillStyle = exhausted ? '#BD00FF' : '#FCEE0A';
    ctx.font = '10px monospace';
    ctx.fillText(budgetText, 20, 76);
  }

  // Draw Reticles
  state.reticles.forEach((r: Reticle) => {
    const stroke = r.status === 'breach' ? '#BD00FF' : r.status === 'warning' ? '#FCEE0A' : '#00F0FF';
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.width, r.height);

    // Size the label plate to the text, not the reticle, or long labels spill out of it.
    // A box flush against the right edge (x + width === 600) would otherwise push its
    // plate past the canvas and get visually clipped, so clamp the plate into bounds and
    // clip the text to the plate.
    ctx.font = 'bold 11px monospace';
    const labelW = Math.min(HUD_SIZE, Math.max(r.width, Math.ceil(ctx.measureText(r.label).width) + 12));
    const labelX = Math.max(0, Math.min(r.x, HUD_SIZE - labelW));

    ctx.fillStyle = 'rgba(5, 5, 5, 0.9)';
    ctx.fillRect(labelX, r.y - 18, labelW, 18);
    ctx.strokeRect(labelX, r.y - 18, labelW, 18);

    ctx.save();
    ctx.beginPath();
    ctx.rect(labelX, r.y - 18, labelW, 18);
    ctx.clip();
    ctx.fillStyle = stroke;
    ctx.fillText(r.label, labelX + 6, r.y - 5);
    ctx.restore();
  });

  // Drawn last, so a reticle can never sit on top of the telemetry strip or the warning pill.
  drawTelemetryFooter(state);
  drawTierWarning(state);
  
  // Draw telemetry panel if open
  if (telemetryPanelOpen || Date.now() < ledgerFlashUntil) {
    drawTelemetryPanel(hudStore.getState());
  }
}

/** the continuous loop; `F` calls drawFrame() directly so the footer is honest immediately */
function render(): void {
  drawFrame();
  requestAnimationFrame(render);
}
render();

/**
 * Clamped telemetry strip inside the 600x600 boundary.
 *
 * Sits above the HTML `.hud-footer` (which overlays the last ~24px of the frame) rather than
 * under it, and clips itself, so nothing it draws can leave the canvas or cover the footer.
 */
// ---- Telemetry Panel ----
/** Newest-first rows for the ledger card, one per saved waste / yield / pan-depth entry. */
function ledgerRows(k: KitchenState | null): Array<{ at: string; text: string; color: string }> {
  if (!k) return [];
  const rows: Array<{ at: string; text: string; color: string }> = [];
  for (const w of k.wasteLog ?? []) {
    rows.push({ at: w.timestamp, text: `WASTE  ${w.ingredient}  -${w.weight_g}g  ${w.reason ?? ''}`.trimEnd(), color: '#BD00FF' });
  }
  for (const y of k.yieldLog ?? []) {
    const pct = y.ap_weight_g && y.ep_weight_g !== undefined ? ((y.ep_weight_g / y.ap_weight_g) * 100).toFixed(1) : '?';
    rows.push({ at: y.timestamp, text: `YIELD  ${pct}%  EP ${y.ep_weight_g ?? '?'}g / AP ${y.ap_weight_g ?? '?'}g`, color: '#00F0FF' });
  }
  for (const p of k.panDepthAudit ?? []) {
    const off = p.fillPercentage < 20 || p.fillPercentage > 90;
    rows.push({ at: p.timestamp, text: `PAN    ${p.panType}  ${p.fillPercentage}%`, color: off ? '#FCEE0A' : '#00F0FF' });
  }
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/**
 * Kitchen ledger card, drawn INSIDE the 600x600 frame (the old panel was drawn at x=610+, outside
 * the canvas, so it never showed). Anchored above the telemetry strip; the latest four entries.
 */
function drawTelemetryPanel(_state: HUDState): void {
  if (!ctx) return;
  const rows = ledgerRows(kitchenState);
  const shown = rows.slice(0, 4);
  const x = 12;
  const w = HUD_SIZE - 24;
  const rowH = 14;
  const h = 26 + Math.max(1, shown.length) * rowH + 6;
  const y = FOOTER_STRIP_Y - 6 - h;

  ctx.save();
  ctx.fillStyle = 'rgba(5, 5, 5, 0.88)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#00F0FF';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  // keep every string inside the card
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = '#FCEE0A';
  ctx.fillText(`KITCHEN LEDGER  ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`, x + 8, y + 15);
  ctx.font = '10px monospace';
  ctx.fillStyle = '#7ad';
  const scale = `${activeContainer ?? 'no container'}  tare ${activeTareGrams}g`;
  ctx.fillText(scale, x + w - 8 - ctx.measureText(scale).width, y + 15);

  ctx.font = '11px monospace';
  if (shown.length === 0) {
    ctx.fillStyle = '#6a7a80';
    ctx.fillText('No entries yet. Press V to log one.', x + 8, y + 26 + rowH - 3);
  }
  shown.forEach((r, i) => {
    ctx.fillStyle = r.color;
    ctx.fillText(r.text, x + 8, y + 26 + (i + 1) * rowH - 3);
  });
  ctx.restore();
}

function drawTelemetryFooter(state: HUDState): void {
  if (!ctx) return;
  const tierColor = state.modelTier === 'open-weights' ? '#BD00FF' : '#00F0FF';
  const y = FOOTER_STRIP_Y;
  const midY = y + FOOTER_STRIP_H / 2 + 1;

  ctx.fillStyle = '#050505';
  ctx.fillRect(0, y, HUD_SIZE, FOOTER_STRIP_H);
  ctx.strokeStyle = tierColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y + 0.5);
  ctx.lineTo(HUD_SIZE, y + 0.5);
  ctx.stroke();

  const seg = footerText({
    modelTier: state.modelTier,
    modelId: state.proxy.modelId,
    cached: state.proxy.cached,
    ledgerSpentUsd: state.proxy.ledgerSpentUsd,
  });

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y, HUD_SIZE, FOOTER_STRIP_H);
  ctx.clip();
  ctx.font = 'bold 10px monospace';
  ctx.textBaseline = 'middle';

  const right = `${seg.cache}  ${seg.ledger}`;
  const rightWidth = ctx.measureText(right).width;
  const margin = 12;
  const maxLeft = HUD_SIZE - margin * 2 - rightWidth;

  // Degrade rather than overprint: full label, then tier only, then nothing. The ledger side is
  // the part that must survive, because it is the number that costs money.
  let left = `${seg.model}  ${seg.tier}`;
  if (ctx.measureText(left).width > maxLeft) left = seg.tier;
  if (ctx.measureText(left).width > maxLeft) left = '';

  ctx.textAlign = 'left';
  ctx.fillStyle = tierColor;
  ctx.fillText(left, 12, midY);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#FCEE0A';
  ctx.fillText(right, HUD_SIZE - 12, midY);
  ctx.restore();
}

/**
 * Tier warning pill. Nothing in here touches `reticles` or `status`: a refused tier is a
 * configuration notice, not a reason to blank the screen.
 */
function drawTierWarning(state: HUDState): void {
  if (!ctx) return;
  const message = state.proxy.lastError;
  if (!message) return;

  ctx.save();
  ctx.font = 'bold 10px monospace';
  ctx.textBaseline = 'middle';
  const width = Math.min(HUD_SIZE - 24, Math.ceil(ctx.measureText(message).width) + 16);
  const y = FOOTER_STRIP_Y - WARNING_PILL_H - 6;
  ctx.fillStyle = 'rgba(5, 5, 5, 0.92)';
  ctx.fillRect(12, y, width, WARNING_PILL_H);
  ctx.strokeStyle = '#BD00FF';
  ctx.lineWidth = 1;
  ctx.strokeRect(12.5, y + 0.5, width - 1, WARNING_PILL_H - 1);
  ctx.beginPath();
  ctx.rect(12, y, width, WARNING_PILL_H);
  ctx.clip();
  ctx.fillStyle = '#BD00FF';
  ctx.fillText(message, 20, y + WARNING_PILL_H / 2 + 1);
  ctx.restore();
}

// Console exposure
(window as any).executeTool = executeTool;
(window as any).hudStore = hudStore;
(window as any).metaClient = metaClient;
// exposed so the coordinate contract can be checked from the console / an e2e pass
(window as any).normalizeToHud = normalizeToHud;
// coordinate-contract self-test, runnable from the console or CI with no test runner
(window as any).runHudSelfTest = runHudSelfTest;

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
    let frame;
    if (customFrameDataUrl && customFrameDims) {
      // Use custom loaded frame
      frame = {
        dataUrl: customFrameDataUrl,
        width: customFrameDims.width,
        height: customFrameDims.height,
        source: activeScene ? `scene-${activeScene}` : 'custom',
        reason: null,
      };
      lastFrameText = `FRAME: scene-${activeScene} ${customFrameDims.width}x${customFrameDims.height}`;
    } else {
      frame = camera.capture();
      lastFrameText = `FRAME: ${frame.source} ${frame.width}x${frame.height}`;
    }
    if (frame.reason) console.log(`[HUD] frame fallback: ${frame.reason}`);
    console.log(`[HUD] snapshot frame: ${frame.source} ${frame.width}x${frame.height}`);

    // only the bundled demo photos have hand-placed boxes; a dropped photo must not borrow them
    const demoSlot =
      activeScene !== null && customFrameDataUrl && loadedScenes.get(activeScene)?.source === 'demo'
        ? activeScene
        : null;
    const result = await metaClient.analyzeFrame(
      frame.dataUrl,
      { width: frame.width, height: frame.height },
      demoSlot,
    );
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

/**
 * Voice: one explicit wake event -> Muse transcript -> WebMCP tool execution.
 * Snapshot-only for the same reason as SAM: never a continuous microphone loop.
 */
let voiceInFlight = false;

async function triggerVoice(hint?: string) {
  if (voiceInFlight) {
    console.log('[HUD] voice ignored: call already in flight');
    return;
  }
  voiceInFlight = true;
  hudStore.setStatus('LISTENING');
  try {
    // Real microphone when the browser allows it; the synthetic Blob keeps the
    // Muse -> WebMCP path testable on machines with no mic (and in headless runs).
    let audio: Blob;
    let captured = false;
    if (micSupported()) {
      try {
        audio = await captureUtterance({ durationMs: 2200 });
        captured = true;
        console.log(`[HUD] mic captured ${(audio.size / 1024).toFixed(1)} KB`);
      } catch (micErr) {
        console.warn(`[HUD] mic unavailable (${(micErr as Error).message}) - using synthetic audio`);
        audio = new Blob([new Uint8Array(2048)], { type: 'audio/wav' });
      }
    } else {
      audio = new Blob([new Uint8Array(2048)], { type: 'audio/wav' });
    }

    // step 1: transcribe
    const result = await metaClient.processKitchenQuery(audio, hint);
    if (captured) console.log('[HUD] voice used real microphone audio');
    console.log(`[HUD] 1/3 transcribe (${result.source}): "${result.transcription}"`);

    // step 2: Muse Spark 1.3 selects a tool from the transcript
    const picked = await metaClient.resolveTool(
      result.transcription,
      toolDefinitions,
      hudStore.getState().modelTier,
    );
    console.log(
      `[HUD] 2/3 spark (${picked.source}, conf ${picked.confidence}, tier ${picked.telemetry.modelTier ?? 'n/a'}` +
        `${picked.refused ? `, REFUSED ${picked.refused.code}` : ''}): ${picked.toolCall.name}`,
    );

    // step 3: WebMCP execution
    console.log('[HUD] 3/3 execute', picked.toolCall.name, JSON.stringify(picked.toolCall.arguments));
    const toolResult = await executeTool(picked.toolCall.name, picked.toolCall.arguments);
    
    // Log to kitchen ledger via proxy
    try {
      const logResp = await fetch(`${PROXY_BASE}/__kitchen/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: picked.toolCall.name,
          ...picked.toolCall.arguments,
        }),
      });
      if (logResp.ok) {
        // the proxy answers with the saved ledger: show the new entry now, not on the next poll
        const saved = (await logResp.json()) as { state?: KitchenState };
        if (saved.state) kitchenState = saved.state;
        ledgerFlashUntil = Date.now() + 8000;
      }
    } catch (err) {
      console.warn('[HUD] Failed to log to kitchen ledger:', err);
    }
    
    return toolResult;
  } catch (err) {
    console.error('[HUD] voice failed:', err);
    hudStore.setStatus('IDLE');
    return;
  } finally {
    voiceInFlight = false;
  }
}

(window as any).triggerVoice = triggerVoice;

/** explicit microphone entry point, surfaced so the capture path can be tested directly */
async function triggerMic() {
  if (!micSupported()) {
    console.warn('[HUD] mic unsupported in this context');
    return;
  }
  console.log('[HUD] mic: capturing 2.2s...');
  await triggerVoice();
}

(window as any).triggerMic = triggerMic;

/**
 * Hands-free wake word. Shares the in-flight guards with S and V so a wake event can never
 * stack a capture on top of one already running. Paused during our own capture so the tail
 * of the recording does not retrigger it.
 */
const wake = new WakeWord({
  phrases: ['hey line check', 'line check'],
  cooldownMs: 4000,
  preferred: env.wakeMode,
  canFire: () => !snapshotInFlight && !voiceInFlight && !wakeBusy,
  onWake: ({ phrase, mode, confidence }) => {
    console.log(`[HUD] wake (${mode}): "${phrase}"${confidence !== undefined ? ' conf ' + confidence.toFixed(2) : ''}`);
    void runWakeChain();
  },
});

let wakeBusy = false;

async function runWakeChain() {
  if (wakeBusy || voiceInFlight) return;
  wakeBusy = true;
  wake.pause();
  try {
    await triggerVoice();
  } finally {
    wakeBusy = false;
    wake.resume();
  }
}

async function toggleWake() {
  if (wake.activeMode !== 'unavailable') {
    wake.stop();
    wakeText = 'WAKE: off';
    console.log('[HUD] wake word stopped');
    return;
  }
  const mode = await wake.start(env.wakeMode);
  wakeText = mode === 'unavailable' ? 'WAKE: unavailable' : `WAKE: ${mode}`;
  console.log(`[HUD] wake word ${mode}${wake.statusReason ? ' - ' + wake.statusReason : ''}`);
}

(window as any).toggleWake = toggleWake;
(window as any).wakeWord = wake;

/**
 * Start the webcam on load; failure is silent and S falls back to a synthetic frame.
 */
async function initCamera() {
  if (!cameraSupported()) {
    lastFrameText = 'FRAME: synthetic (no camera API)';
    return;
  }
  const ok = await camera.start();
  lastFrameText = ok ? 'FRAME: camera live' : `FRAME: synthetic (${camera.reason ?? 'no camera'})`;
  console.log(`[HUD] camera: ${ok ? 'live' : 'unavailable'}${camera.reason ? ' - ' + camera.reason : ''}`);
}
void initCamera();

(window as any).startCamera = initCamera;

// Keyboard Test Harness
window.addEventListener('keydown', async (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

  switch (e.key) {
    case 's':
    case 'S':
      await triggerSnapshot();
      break;
    case 'v':
    case 'V':
      await triggerVoice();
      break;
    case 'm':
    case 'M':
      await triggerMic();
      break;
    case 'w':
    case 'W':
      await toggleWake();
      break;
    case 'c':
    case 'C':
      camera.stop();
      await initCamera();
      break;
    case 'f':
    case 'F': {
      const tier = hudStore.toggleModelTier();
      console.log(`[HUD] model tier -> ${tier}`);
      // Everything below belonged to the tier we just left: the model id and the cache verdict
      // were facts about the OLD route, and leaving them on screen next to the new tier is a
      // contradiction the footer should never show. The ledger is tier-independent, so it stays.
      hudStore.setProxyTelemetry({ modelId: '', cached: null });
      hudStore.clearProxyError();
      drawFrame(); // rAF would pick this up next frame; redraw now so the footer cannot lag
      break;
    }
    case '1':
    case '2':
    case '3':
    case '4':
      await loadScene(parseInt(e.key));
      // boxes belong to the previous photo; clear them so a new scene starts clean (press S)
      hudStore.setReticles([]);
      hudStore.setStatus('IDLE');
      break;
    case 't':
    case 'T':
      telemetryPanelOpen = !telemetryPanelOpen;
      console.log('[HUD] Telemetry panel:', telemetryPanelOpen ? 'open' : 'closed');
      break;
    case '!': // Shift+1
      console.log('[HUD] tare_scale');
      await executeTool('tare_scale', { unit: 'g' });
      break;
    case '@': // Shift+2
      console.log('[HUD] calculate_yield');
      await executeTool('calculate_yield', { ap_weight_g: 2200, ep_weight_g: 1650, trim_weight_g: 550 });
      break;
    case '#': // Shift+3
      console.log('[HUD] verify_pan_depth (warning)');
      await executeTool('verify_pan_depth', { pan_type: '1/6 Pan', fill_percentage: 15 });
      break;
    case '$': // Shift+4
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
