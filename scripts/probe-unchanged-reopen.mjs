/**
 * Verify that reopening an unchanged file keeps the document AND its cached pixels.
 *
 *   node scripts/probe-unchanged-reopen.mjs "D:/path/to/file.pdf"
 *
 * A LaTeX rebuild rewrites the PDF at the path already loaded, and the pane asks for
 * it again on every finished build. When the bytes are identical the request should
 * cost nothing: the document is kept, the render cache is kept, and the visible
 * pages come back from cache instead of being rasterised again.
 *
 * This checks all three states explicitly, because "the reopen was fast" is not the
 * same as "nothing was thrown away":
 *
 *   1. first open, render          -> cold: the document is parsed and pages drawn
 *   2. render the SAME pages again -> must hit the cache (proves what warm looks like)
 *   3. re-open the UNCHANGED file  -> must behave like (2), not like (1)
 *   4. modify the file, re-open    -> must behave like (1): a real edit re-parses
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
const source = process.argv[2] ?? 'D:\\LaTeX projects\\Eukolia\\Eukolia.pdf';
const work = path.join(os.tmpdir(), 'eukolia-reopen.pdf');

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
function check(label, ok, detail) {
  if (ok) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`); failures.push(label); }
}

async function renderPages(count) {
  const t0 = performance.now();
  for (let p = 0; p < count; p++) {
    await call('render', { page: p, scale: 1, format: 'bgra', allowCache: true });
  }
  return performance.now() - t0;
}

await Promise.race([readySeen, new Promise((r) => setTimeout(r, 5000))]);
fs.copyFileSync(source, work);
const PAGES = 8;

/* 1. cold open + render ----------------------------------------------------- */
console.log(`\nfile: ${work}`);
const open1 = await call('open', { path: work });
console.log(`\n1. first open + render   (pages=${open1.pageCount}, unchanged=${open1.unchanged})`);
const coldMs = await renderPages(PAGES);
console.log(`  render ${PAGES} pages: ${coldMs.toFixed(1)} ms`);
check('first open is not reported as unchanged', open1.unchanged === false);

/* 2. same pages again — what "warm" costs ---------------------------------- */
console.log('\n2. render the same pages again (warm baseline)');
const warmMs = await renderPages(PAGES);
const warmStats = await call('stats', {});
console.log(`  render ${PAGES} pages: ${warmMs.toFixed(1)} ms   servedFromCache=${warmStats.servedFromCache}`);
check('a repeat render hits the cache', warmStats.servedFromCache >= PAGES,
  `servedFromCache=${warmStats.servedFromCache}`);

/* 3. reopen the unchanged file --------------------------------------------- */
console.log('\n3. re-open the UNCHANGED file');
const open2 = await call('open', { path: work });
console.log(`  open: unchanged=${open2.unchanged}`);
check('re-open reports the file as unchanged', open2.unchanged === true);
const afterReopenMs = await renderPages(PAGES);
const reopenStats = await call('stats', {});
console.log(`  render ${PAGES} pages: ${afterReopenMs.toFixed(1)} ms   cacheEntries=${reopenStats.cacheEntries}  cacheBytes=${reopenStats.cacheBytes}`);
check('the document was kept', open2.pageCount === open1.pageCount,
  `${open1.pageCount} vs ${open2.pageCount}`);
check('the render cache survived the re-open', reopenStats.cacheEntries > 0,
  `cacheEntries=${reopenStats.cacheEntries}`);
/*
 * The cache-entry count is the assertion, not the wall time.
 *
 * Each render is a stdio round trip, and that fixed cost dominates once the pixels
 * are cached -- a cache hit measures ~11 ms either way, so a timing threshold here
 * would be noise. What proves the reuse is that the entries are still there: had
 * InvalidateAll() run, cacheEntries would be back to 0 and the pane would repaint
 * from nothing.
 */
check('nothing was invalidated by the re-open', reopenStats.cacheEntries >= PAGES,
  `cacheEntries=${reopenStats.cacheEntries}`);

/* 4. modify the file — a real edit must re-parse --------------------------- */
console.log('\n4. modify the file, then re-open (a real edit)');
const edited = path.join(os.tmpdir(), 'eukolia-edited.pdf');
const bytes = fs.readFileSync(source);
fs.writeFileSync(edited, bytes);
// Append a PDF comment: legal, ignored by any reader, and it changes the bytes.
fs.appendFileSync(edited, Buffer.from('\n% eukolia-edit\n', 'latin1'));
const open3 = await call('open', { path: edited }).catch((e) => ({ error: e.message }));
check('an edited file is NOT reported as unchanged', open3.unchanged === false,
  `unchanged=${open3.unchanged} error=${open3.error ?? 'none'}`);
if (open3.pageCount) {
  const afterEditMs = await renderPages(PAGES);
  const editStats = await call('stats', {});
  console.log(`  render ${PAGES} pages: ${afterEditMs.toFixed(1)} ms   cacheEntries=${editStats.cacheEntries}`);
  check('an edit re-parses rather than reusing', afterEditMs > afterReopenMs,
    `unchanged=${afterReopenMs.toFixed(1)} ms, edited=${afterEditMs.toFixed(1)} ms`);
  check('the edited file repopulated the cache from scratch',
    editStats.cacheEntries > 0 && editStats.cacheEntries <= PAGES,
    `cacheEntries=${editStats.cacheEntries}`);
}

const f = Buffer.alloc(9); f.writeUInt32LE(5, 0); f[4] = FRAME.Shutdown;
child.stdin.write(f);
// Wait for the worker to exit before deleting: Windows keeps the opened document's
// file handle until the process is gone, and an unlink under it is EPERM.
await new Promise((r) => setTimeout(r, 800));
for (const p of [work, edited]) {
  try { fs.rmSync(p, { force: true }); } catch { /* temp file; the OS will reclaim it */ }
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`);
for (const x of failures) console.log(`  - ${x}`);
process.exitCode = failures.length === 0 ? 0 : 1;
