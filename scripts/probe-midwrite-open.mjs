/**
 * Verify that a mid-write `open` is survived, using the real worker.
 *
 *   node scripts/probe-midwrite-open.mjs
 *
 * `pdflatex` truncates its output and refills it in place, so a reader that
 * arrives during the build sees a real file with a valid `%PDF-` header and no
 * usable page tree. This reproduces that: a background writer empties the file and
 * refills it in chunks, while the reader opens it repeatedly through the same
 * retry policy `src/main/ipc/pdfHandler.ts` uses.
 *
 * The point is to prove the two halves of that policy independently:
 *   - a file that is STILL MOVING is retried and eventually opens;
 *   - a file that is BROKEN AND STATIC fails immediately, with its real error,
 *     rather than being retried for 1.5 s.
 *
 * Copyright 2026 the Eukolia project authors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'resources', 'native', 'eukolia-pdf.exe');

const source = process.argv[2] ?? 'D:\\LaTeX projects\\Eukolia\\Eukolia.pdf';
const target = path.join(os.tmpdir(), 'eukolia-midwrite.pdf');

const FRAME = { Request: 1, Shutdown: 4, Response: 128, Error: 129, Pixels: 130, Ready: 131, Log: 132 };

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
    if (type === FRAME.Pixels) { e.resolve({ ok: true }); continue; }
    const j = body.length ? JSON.parse(body.toString('utf8')) : {};
    if (type === FRAME.Error) e.reject(new Error(j.error ?? 'error'));
    else e.resolve(j);
  }
});

function call(cmd, params = {}, ms = 60000) {
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

/* --- the policy under test, mirrored from src/main/ipc/pdfHandler.ts --------- */
const delaysMs = [150, 300, 450, 600];
function mightBePartialRead(error) {
  const m = String(error?.message ?? '').toLowerCase();
  return ['no pages', 'array not closed', 'unexpected end of file', 'unexpected eof', 'premature end',
    'cannot find startxref', 'no objects found', 'syntax error', 'broken file', 'invalid key in dict']
    .some((s) => m.includes(s));
}
function fileStamp(p) {
  try { const s = fs.statSync(p); return `${s.size}:${s.mtimeMs}`; } catch { return null; }
}
async function openTolerant(p) {
  let stamp = fileStamp(p);
  for (let attempt = 0; ; attempt++) {
    try {
      return { result: await call('open', { path: p }), attempts: attempt + 1, waited: delaysMs.slice(0, attempt).reduce((a, b) => a + b, 0) };
    } catch (error) {
      if (attempt >= delaysMs.length || !mightBePartialRead(error)) throw Object.assign(error, { attempts: attempt + 1 });
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
      const next = fileStamp(p);
      if (next === null || next === stamp) throw Object.assign(error, { attempts: attempt + 1 });
      stamp = next;
    }
  }
}

await Promise.race([readySeen, new Promise((r) => setTimeout(r, 5000))]);
const bytes = fs.readFileSync(source);
console.log(`source: ${source}`);
console.log(`        ${bytes.length.toLocaleString()} bytes\n`);

/* --- 1. a file that is still being written --------------------------------- */
console.log('1. open while a writer is refilling the file in place');
fs.writeFileSync(target, Buffer.alloc(0));
const chunk = Math.ceil(bytes.length / 12);
let written = 0;
const writer = (async () => {
  while (written < bytes.length) {
    fs.appendFileSync(target, bytes.subarray(written, Math.min(written + chunk, bytes.length)));
    written += chunk;
    await new Promise((r) => setTimeout(r, 120));
  }
})();

const t0 = performance.now();
try {
  const out = await openTolerant(target);
  console.log(`  PASS  opened after ${out.attempts} attempt(s), ${(performance.now() - t0).toFixed(0)} ms`);
  console.log(`        pages=${out.result.pageCount}`);
} catch (err) {
  console.log(`  FAIL  never opened: ${err.message} (after ${err.attempts} attempt(s))`);
}
await writer;

/* --- 2. a broken file that never changes ----------------------------------- */
console.log('\n2. open a broken file that is NOT changing (must fail fast)');
fs.writeFileSync(target, Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1'));
const t1 = performance.now();
try {
  const out = await openTolerant(target);
  console.log(`  FAIL  unexpectedly opened: pages=${out.result.pageCount}`);
} catch (err) {
  const ms = performance.now() - t1;
  console.log(`  PASS  failed after ${ms.toFixed(0)} ms with ${err.attempts} attempt(s): ${err.message}`);
  // One attempt is the assertion that matters: the mtime gate is what stops a
  // damaged file from being retried. The wall time includes spawning the worker
  // and its initial scan, so it is only a sanity bound, not a budget.
  if (err.attempts !== 1) console.log(`  FAIL  retried a static file ${err.attempts} times`);
  if (ms > 2000) console.log(`  FAIL  took ${ms.toFixed(0)} ms to surface a real error`);
}

const f = Buffer.alloc(9); f.writeUInt32LE(5, 0); f[4] = FRAME.Shutdown;
child.stdin.write(f);
// Wait for the worker to exit before deleting: it holds the opened document's file
// handle for as long as it lives, and an unlink under it is EPERM.
await new Promise((r) => setTimeout(r, 800));
try { fs.rmSync(target, { force: true }); } catch { /* temp file; the OS reclaims it */ }
