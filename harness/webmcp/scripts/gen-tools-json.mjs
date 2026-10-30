#!/usr/bin/env node
/**
 * Regenerate harness/webmcp/tools.json from src/mcp/tools.ts.
 *
 * tools.ts is the single source of truth for the WebMCP tool schemas. The proxy needs the same
 * definitions as JSON (it injects them when a caller forgets to send `tools`), and a hand-copied
 * second version would drift the moment a parameter changes. Run this after editing tools.ts:
 *
 *   npm run gen:tools
 *
 * The extraction is textual on purpose - tools.ts is TypeScript, so a .mjs script cannot import
 * it without a build step - and it fails loudly rather than emitting a stale file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, '..', 'src', 'mcp', 'tools.ts');
const outPath = join(here, '..', 'tools.json');

const src = readFileSync(srcPath, 'utf8');
const marker = 'export const toolDefinitions = [';
const start = src.indexOf(marker);
if (start === -1) throw new Error(`${srcPath}: could not find "${marker}"`);
const open = start + marker.length - 1;
const close = src.indexOf('\n];', open);
if (close === -1) throw new Error(`${srcPath}: unterminated toolDefinitions array`);

const literal = src.slice(open, close + 2);
const tools = new Function(`return ${literal}`)();

if (!Array.isArray(tools) || tools.length === 0) throw new Error('parsed zero tools');
for (const t of tools) {
  if (!t?.name) throw new Error(`a tool has no name: ${JSON.stringify(t).slice(0, 120)}`);
  if (!t?.parameters) throw new Error(`tool ${t.name} has no parameters block`);
}

writeFileSync(outPath, `${JSON.stringify(tools, null, 2)}\n`);
console.log(`wrote ${tools.length} tool schemas -> ${outPath}: ${tools.map((t) => t.name).join(', ')}`);
