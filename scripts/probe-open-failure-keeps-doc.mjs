/**
 * Verify that a FAILED open does not destroy the document on screen.
 *
 *   node scripts/probe-open-failure-keeps-doc.mjs [valid.pdf]
 *
 * A LaTeX build rewrites the PDF in place, so the pane re-opens on every finished
 * build and a read that lands mid-write fails. Before this, `PdfEngine::Open`
 * called `CloseDocument()` first, so that failure left the engine holding *no*
 * document — the pane went blank and the next build had nothing to keep.
 *
 * The sequence that must hold:
 *
 *   1. open a good document and render pages   -> cached pixels exist
 *   2. open a BROKEN file (must fail)          -> document NOT closed
 *   3. render the same pages again             -> they still work, still cached
 *   4. open a DIFFERENT good document          -> normal replacement still works
 *   5. open the FIRST document again           -> normal replacement still works
 *
 * Steps 4 and 5 are the guard against "keep the old one" turning into "never
 * release anything".
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

const FRAME = { Request: 1, Shutdown: 4, Response: 128, Error: 129, Pixels: 130, Ready: 131, Log: 132 };
const good = path.resolve(process.argv[2] ?? 'D:\\LaTeX projects\\Eukolia\\Eukolia.pdf');
const broken = path.join(os.tmpdir(), 'eukolia-broken.pdf');
const other = path.join(os.tmpdir(), 'eukolia-other.pdf');

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
    if (type === FRAME.Pixels) { e.resolve({ ok: true }); continue; }
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

const failures = [];
const check = (label, ok, detail) => {
  if (ok) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`); failures.push(label); }
};
async function renderPages(count) {
  for (let p = 0; p < count; p++) {
    await call('render', { page: p, scale: 1, format: 'bgra', allowCache: true });
  }
}

await Promise.race([readySeen, new Promise((r) => setTimeout(r, 5000))]);
const PAGES = 6;

/* Fixtures: a broken PDF, and a second valid one. */
fs.writeFileSync(broken, Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1'));
fs.copyFileSync(good, other);

/* 1. a good document, with cached pixels ----------------------------------- */
console.log(`\ngood  : ${good}`);
const open1 = await call('open', { path: good });
await renderPages(PAGES);
const stats1 = await call('stats', {});
console.log(`  pages=${open1.pageCount}  cacheEntries=${stats1.cacheEntries}`);
check('good document opens', open1.pageCount > 0);

/* 2. a broken file must fail ----------------------------------------------- */
let failed = false;
let failureMessage = '';
try {
  await call('open', { path: broken });
} catch (err) { failed = true; failureMessage = err.message; }
console.log(`\nbroken: ${failureMessage}`);
check('broken file fails to open', failed);

/* 3. the original document must still be there ----------------------------- */
const stats2 = await call('stats', {});
check('the render cache survived the failed open', stats2.cacheEntries >= PAGES,
  `cacheEntries=${stats2.cacheEntries}`);
let stillRenders = true;
try {
  await renderPages(PAGES);
} catch (err) { stillRenders = false; console.log(`  render after failure: ${err.message}`); }
check('the previous document still renders after a failed open', stillRenders);
const stats3 = await call('stats', {});
check('those renders were cache hits, not a re-parse',
  stats3.servedFromCache > stats2.servedFromCache,
  `servedFromCache ${stats2.servedFromCache} -> ${stats3.servedFromCache}`);

/* 4. replacing with a different document still works ----------------------- */
const open2 = await call('open', { path: other }).catch((e) => ({ error: e.message }));
check('a different document still opens (the old one is released)',
  open2.pageCount > 0, `error=${open2.error ?? 'none'}`);

/* 5. and back again -------------------------------------------------------- */
const open3 = await call('open', { path: good }).catch((e) => ({ error: e.message }));
check('the original document opens again', open3.pageCount === open1.pageCount,
  `${open1.pageCount} vs ${open3.pageCount} error=${open3.error ?? 'none'}`);

const f = Buffer.alloc(9); f.writeUInt32LE(5, 0); f[4] = FRAME.Shutdown;
child.stdin.write(f);
await new Promise((r) => setTimeout(r, 800));
for (const p of [broken, other]) { try { fs.rmSync(p, { force: true }); } catch { /* temp */ } }

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`);
for (const x of failures) console.log(`  - ${x}`);
process.exitCode = failures.length === 0 ? 0 : 1;
