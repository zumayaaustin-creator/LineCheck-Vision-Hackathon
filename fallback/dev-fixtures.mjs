/**
 * Rehearsal fixtures for the fallback route: a primary Meta edge that is DOWN (503 on Spark, healthy
 * on SAM/Muse) and an open-weight fallback that answers in the vLLM shape.
 *
 * Two roles:
 *   1. `node fallback/dev-fixtures.mjs` then point the proxy at 8901/8902 to rehearse the failover
 *      before a demo - no credits, no Modal account, no GPU.
 *   2. `node fallback/dev-fixtures.mjs --e2e` also starts a static server for a prebuilt HUD bundle,
 *      which is the browser proof described in fallback/README.md.
 *
 * No dependencies: Node's http only, same rule as the rest of the harness.
 */
import { createServer } from 'node:http';

const json = (res, code, obj, extra = {}) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), ...extra });
  res.end(b);
};

const read = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => resolve(raw));
});

// 8901: the primary Meta side (SAM + Muse audio are healthy; Spark is overloaded)
createServer(async (req, res) => {
  const body = await read(req);
  if (req.url?.startsWith('/sam-3.1/segment')) {
    return json(res, 200, {
      detections: [{
        id: 'd1', label: 'HOTEL PAN', x: 120, y: 90, width: 240, height: 180,
        confidence: 0.93, status: 'nominal',
      }],
      matches: 1,
    });
  }
  if (req.url?.startsWith('/muse-audio/transcribe')) {
    return json(res, 200, {
      transcript: 'we threw away nine hundred grams of salmon trim',
      durationSeconds: 3.2,
    });
  }
  if (req.url?.startsWith('/muse-spark/dispatch')) {
    console.log('primary spark -> 503 (simulated overload)');
    return json(res, 503, { error: 'model_overloaded', message: 'capacity exhausted' });
  }
  return json(res, 404, { error: 'not_found', path: req.url, body: body.slice(0, 80) });
}).listen(8901, '127.0.0.1', () => console.log('fixtures (primary) on 8901'));

// 8902: the open-weight fallback (vLLM shape, JSON tool reply instead of tool_calls)
createServer(async (req, res) => {
  const body = await read(req);
  if (req.url === '/health') return json(res, 200, { status: 'ok' });
  if (req.url?.startsWith('/v1/chat/completions')) {
    console.log('fallback served a completion');
    return json(res, 200, {
      id: 'chatcmpl-fallback',
      object: 'chat.completion',
      model: 'llama-3.2-11b-vision',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '{"tool":{"name":"record_waste","arguments":{"ingredient":"salmon trim","weight_g":900,"reason":"trim waste"}}}',
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 96, completion_tokens: 34, total_tokens: 130 },
    });
  }
  return json(res, 404, { error: 'not_found', path: req.url, body: body.slice(0, 80) });
}).listen(8902, '127.0.0.1', () => console.log('fallback on 8902'));

// Optional third server: serve a prebuilt HUD bundle so the failover can be proven in a browser.
const STATIC_ROOT = process.env.E2E_STATIC_DIR || null;
if (process.argv.includes('--e2e') && STATIC_ROOT) {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const rel = url === '/' ? '/index.html' : url;
    try {
      const buf = await readFile(path.join(STATIC_ROOT, rel.replace(/\.\./g, '')));
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(String(rel))] || 'application/octet-stream', 'Content-Length': buf.length });
      res.end(buf);
    } catch {
      const buf = await readFile(path.join(STATIC_ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': buf.length });
      res.end(buf);
    }
  }).listen(Number(process.env.E2E_STATIC_PORT || 8099), '127.0.0.1', () => console.log('hud bundle on 8099'));
}
