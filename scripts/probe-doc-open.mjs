/**
 * Diagnose "document contains no pages" from the native PDF worker.
 *
 *   node scripts/probe-doc-open.mjs "D:/path/to/file.pdf"
 *
 * Talks the raw stdio framing (PROTOCOL.md) with no TypeScript bridge, so a
 * failure localises to the C++ side. Reports the header, the page count the
 * worker actually sees and the first page's geometry, then renders page 0.
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
if (!target) { console.error('usage: node scripts/probe-doc-open.mjs <file.pdf>'); process.exit(2); }
const pdfPath = path.resolve(target);
if (!fs.existsSync(pdfPath)) { console.error(`no such file: ${pdfPath}`); process.exit(2); }

console.log(`file    : ${pdfPath}`);
console.log(`size    : ${fs.statSync(pdfPath).size.toLocaleString()} bytes`);

const child = spawn(EXE, [], { cwd: path.dirname(EXE), stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (c) => process.stderr.write(`[worker stderr] ${c}`));

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
    const payload = buf.subarray(4, 4 + n);
    buf = buf.subarray(4 + n);
    const type = payload[0];
    const requestId = payload.readUInt32LE(1);
    const body = payload.subarray(5);
    if (type === FRAME.Ready) { readyResolve(true); continue; }
    if (type === FRAME.Log) { console.log(`[worker log] ${body.toString('utf8')}`); continue; }
    const entry = pending.get(requestId);
    if (!entry) continue;
    pending.delete(requestId);
    if (type === FRAME.Pixels) { entry.resolve({ ok: true }); continue; }
    const json = body.length ? JSON.parse(body.toString('utf8')) : {};
    if (type === FRAME.Error) entry.reject(new Error(`${json.error ?? 'error'}${json.code ? ` (${json.code})` : ''}`));
    else entry.resolve(json);
  }
});

function call(cmd, params = {}, ms = 120000) {
  const requestId = nextId++;
  const body = Buffer.from(JSON.stringify({ cmd, ...params }), 'utf8');
  const frame = Buffer.alloc(9 + body.length);
  frame.writeUInt32LE(5 + body.length, 0);
  frame[4] = FRAME.Request;
  frame.writeUInt32LE(requestId, 5);
  body.copy(frame, 9);
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    setTimeout(() => { if (pending.delete(requestId)) reject(new Error(`${cmd} timed out`)); }, ms);
    child.stdin.write(frame);
  });
}

await Promise.race([readySeen, new Promise((r) => setTimeout(() => r(false), 5000))]);

const ready = await call('ready', {}).catch(async () => await call('info', {}).catch(() => ({})));
console.log(`\nworker : ${JSON.stringify(ready).slice(0, 200)}`);

// Timed per call: node's process exit time says nothing about server-side cost,
// because the child keeps the event loop alive after the last reply.
const openStart = performance.now();
try {
  const opened = await call('open', { path: pdfPath });
  console.log(`open   : ok  pages=${opened.pageCount}  (${(performance.now() - openStart).toFixed(1)} ms)`);
} catch (err) {
  console.log(`open   : FAILED after ${(performance.now() - openStart).toFixed(1)} ms -- ${err.message}`);
}

const infoStart = performance.now();
try {
  const info = await call('info', {});
  console.log(`info   : pages=${info.pageCount}  (${(performance.now() - infoStart).toFixed(1)} ms)`);
} catch (err) {
  console.log(`info   : FAILED -- ${err.message}`);
}

for (const page of [0, 1, 240, 241]) {
  const t0 = performance.now();
  try {
    await call('render', { page, scale: 1, format: 'bgra', allowCache: false });
    console.log(`render page ${String(page).padStart(3)} : ok  (${(performance.now() - t0).toFixed(1)} ms)`);
  } catch (err) {
    console.log(`render page ${String(page).padStart(3)} : FAILED -- ${err.message}`);
  }
}

const t0 = performance.now();
try {
  const t = await call('text', { page: 0 });
  console.log(`text page 0  : chars=${t.chars ?? '(n/a)'}  (${(performance.now() - t0).toFixed(1)} ms)`);
} catch (err) {
  console.log(`text page 0  : FAILED -- ${err.message}`);
}

const f = Buffer.alloc(9); f.writeUInt32LE(5, 0); f[4] = FRAME.Shutdown;
child.stdin.write(f);
setTimeout(() => child.kill(), 500);
