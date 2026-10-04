/**
 * Time the full sequence a PDF pane performs on open/reload.
 *
 *   node scripts/probe-reload-cost.mjs "D:/path/to/file.pdf"
 *
 * `open` alone is fast, but a reload is not one call: the pane opens the document,
 * asks for the layout, then renders every page in the viewport. Those later steps
 * are what decide whether a rebuild looks like an update or like a reload, so this
 * measures each one separately rather than stopping at the first reply.
 *
 * Copyright 2026 the Eukolia project authors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'resources', 'native', 'eukolia-pdf.exe');

const FRAME = { Request: 1, Shutdown: 4, Response: 128, Error: 129, Pixels: 130, Ready: 131, Log: 132 };

const target = process.argv[2];
if (!target) { console.error('usage: node scripts/probe-reload-cost.mjs <file.pdf>'); process.exit(2); }
const pdfPath = path.resolve(target);

const child = spawn(EXE, [], { cwd: path.dirname(EXE), stdio: ['pipe', 'pipe', 'pipe'] });
let readyResolve;
const readySeen = new Promise((r) => { readyResolve = r; });
let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (buf.length < 4) return;
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) return;
    const p = buf.subarray(4, 4 + n);
    buf = buf.subarray(4 + n);
    const type = p[0];
    const rid = p.readUInt32LE(1);
    const body = p.subarray(5);
    if (type === FRAME.Ready) { readyResolve(true); continue; }
    if (type === FRAME.Log) continue;
    const e = pending.get(rid);
    if (!e) continue;
    pending.delete(rid);
    if (type === FRAME.Pixels) { e.resolve({ ok: true, bytes: body.length }); continue; }
    const j = body.length ? JSON.parse(body.toString('utf8')) : {};
    if (type === FRAME.Error) e.reject(new Error(j.error ?? 'error'));
    else e.resolve(j);
  }
});

function call(cmd, params = {}, ms = 120000) {
  const rid = nextId++;
  const body = Buffer.from(JSON.stringify({ cmd, ...params }), 'utf8');
  const frame = Buffer.alloc(9 + body.length);
  frame.writeUInt32LE(5 + body.length, 0);
  frame[4] = FRAME.Request;
  frame.writeUInt32LE(rid, 5);
  body.copy(frame, 9);
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject });
    setTimeout(() => { if (pending.delete(rid)) reject(new Error(`${cmd} timed out`)); }, ms);
    child.stdin.write(frame);
  });
}

async function timed(label, fn) {
  const t0 = performance.now();
  try {
    const value = await fn();
    console.log(`  ${label.padEnd(34)} ${(performance.now() - t0).toFixed(1).padStart(8)} ms`);
    return value;
  } catch (err) {
    console.log(`  ${label.padEnd(34)} ${(performance.now() - t0).toFixed(1).padStart(8)} ms  FAILED: ${err.message}`);
    return null;
  }
}

await Promise.race([readySeen, new Promise((r) => setTimeout(r, 5000))]);
console.log(`file: ${pdfPath}`);
console.log(`size: ${fs.statSync(pdfPath).size.toLocaleString()} bytes\n`);

console.log('cold worker (what a rebuild triggers):');
const opened = await timed('open', () => call('open', { path: pdfPath }));
const pages = opened?.pageCount ?? 0;
console.log(`  pages=${pages}`);

// The pane asks for the layout right after opening, to place every page.
await timed('layout (all pages)', () =>
  call('layout', { startPage: 1, viewPortWidth: 900, viewPortHeight: 1200, zoomVirtual: 100, dpiFactor: 1 }));

// Then the first screenful. Two rows of tiles is what a viewport actually needs.
const firstScreen = Math.min(8, pages);
await timed(`render first ${firstScreen} page(s) @1.0`, async () => {
  for (let p = 0; p < firstScreen; p++) {
    await call('render', { page: p, scale: 1, format: 'bgra', allowCache: true });
  }
});

await timed('stats', () => call('stats', {}));

// A second pass, now that everything needed is cached: this is the cost the user
// pays when a rebuild produced identical output.
console.log('\nwarm worker (same pages again):');
await timed('open again', () => call('open', { path: pdfPath }));
await timed('render first 8 again', async () => {
  for (let p = 0; p < firstScreen; p++) {
    await call('render', { page: p, scale: 1, format: 'bgra', allowCache: true });
  }
});

const f = Buffer.alloc(9); f.writeUInt32LE(5, 0); f[4] = FRAME.Shutdown;
child.stdin.write(f);
setTimeout(() => child.kill(), 400);
