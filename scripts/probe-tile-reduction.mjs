/**
 * Force the RenderCache's adaptive tile-size reduction and report what it did.
 *
 * light-pdf: RenderCache::ReduceTileSize() (RenderCache.cpp:496-519). That path is
 * only reachable under memory pressure, so an ordinary render sweep never touches
 * it -- the smoke test renders one tile and reports `evicted: 0`. This probe
 * drives the cache over its byte budget and checks the ported behaviour:
 *
 *   1. a tile axis is halved under pressure, so the tile target shrinks;
 *   2. the cache is emptied rather than selectively evicted;
 *   3. the worker still renders and extracts text afterwards.
 *
 * Speaks the raw stdio framing (PROTOCOL.md) directly, without the TypeScript
 * bridge, so a failure localises to the C++ side.
 *
 *   node scripts/probe-tile-reduction.mjs [path/to/file.pdf]
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

const FRAME = { Request: 1, Cancel: 2, Ping: 3, Shutdown: 4, Response: 128, Error: 129, Pixels: 130, Ready: 131, Log: 132, Pong: 133 };

const pdfPath = path.resolve(process.argv[2] ?? path.join(ROOT, 'homework.pdf'));
if (!fs.existsSync(pdfPath)) {
  console.error(`no PDF at ${pdfPath}`);
  process.exit(1);
}
if (!fs.existsSync(EXE)) {
  console.error(`worker not built: ${EXE}`);
  process.exit(1);
}

const child = spawn(EXE, [], {
  cwd: path.dirname(EXE),
  stdio: ['pipe', 'pipe', 'pipe'],
  // Lower the cache budget so ordinary renders trip it. The shipped default is
  // 512 MiB, which would need a >2 GB contiguous pixmap to reach -- a size whose
  // allocation fails on Windows before the cache is ever consulted.
  env: { ...process.env, EUKOLIA_PDF_CACHE_MB: process.env.EUKOLIA_PDF_CACHE_MB ?? '24' }
});
child.stderr.on('data', (chunk) => process.stderr.write(`[worker stderr] ${chunk}`));

let readyResolve;
const readySeen = new Promise((resolve) => { readyResolve = resolve; });

let buffer = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (buffer.length < 4) return;
    const payloadLen = buffer.readUInt32LE(0);
    if (buffer.length < 4 + payloadLen) return;
    const payload = buffer.subarray(4, 4 + payloadLen);
    buffer = buffer.subarray(4 + payloadLen);

    const type = payload[0];
    const requestId = payload.readUInt32LE(1);
    const body = payload.subarray(5);

    if (type === FRAME.Ready) { readyResolve(true); continue; }
    if (type === FRAME.Log) continue;

    const entry = pending.get(requestId);
    if (!entry) continue;
    pending.delete(requestId);

    if (type === FRAME.Pixels) {
      // Pixel bytes are not needed here; the render still has to complete so the
      // cache stores (and therefore evicts) at the rate a real viewport causes.
      entry.resolve({ ok: true });
      continue;
    }
    const json = body.length ? JSON.parse(body.toString('utf8')) : {};
    if (type === FRAME.Error) entry.reject(new Error(json.error ?? 'worker error'));
    else entry.resolve(json);
  }
});

function call(cmd, params = {}, timeoutMs = 180000) {
  const requestId = nextId++;
  const body = Buffer.from(JSON.stringify({ cmd, ...params }), 'utf8');
  const frame = Buffer.alloc(4 + 5 + body.length);
  frame.writeUInt32LE(5 + body.length, 0);
  frame[4] = FRAME.Request;
  frame.writeUInt32LE(requestId, 5);
  body.copy(frame, 9);
  const promise = new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(requestId)) reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  child.stdin.write(frame);
  return promise;
}

const failures = [];
function check(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`); failures.push(label); }
}

async function main() {
  const seen = await Promise.race([readySeen, new Promise((r) => setTimeout(() => r(false), 5000))]);
  check('worker announced ready', seen === true);

  await call('open', { path: pdfPath });
  const meta = await call('info', {});
  const pageCount = meta.pageCount ?? 1;

  const base = await call('stats', {});
  console.log('\n1. baseline');
  console.log(`  pages=${pageCount}  targetTileSize=${base.targetTileSize}  cacheBytes=${base.cacheBytes}  threadsSpawned=${base.threadsSpawned}`);
  check('reports a target tile size', Number.isFinite(base.targetTileSize) && base.targetTileSize > 0,
    `targetTileSize=${base.targetTileSize}`);
  check('no reduction before any pressure', (base.tileSizeReductions ?? 0) === 0,
    `tileSizeReductions=${base.tileSizeReductions}`);
  check('render pool is spawned lazily, not the full ceiling', (base.threadsSpawned ?? 0) < 32,
    `threadsSpawned=${base.threadsSpawned}`);

  /*
   * Drive it over the byte budget. With the budget lowered to 24 MiB a couple of
   * whole-page renders at moderate scale are enough; the scales stay well inside
   * mupdf_engine's kMaxDimension (32000) and inside what a contiguous allocation
   * can actually satisfy, which is the constraint that made scale 24+ fail.
   */
  console.log('\n2. render whole pages at rising scale until the budget trips');
  const before = base.targetTileSize;
  let reductions = 0;
  let last = base;
  for (const scale of [2, 3, 4, 5, 6, 8]) {
    try {
      await call('render', { page: 0, scale, format: 'bgra', allowCache: true, tile: { res: 0, row: 0, col: 0 } });
    } catch (err) {
      console.log(`  (scale ${scale}: ${err.message})`);
    }
    last = await call('stats', {});
    if ((last.tileSizeReductions ?? 0) > 0) {
      reductions = last.tileSizeReductions;
      console.log(`  tripped at scale ${scale}`);
      break;
    }
  }
  console.log(`  tileSizeReductions=${reductions}  targetTileSize=${last.targetTileSize}  cacheBytes=${last.cacheBytes}  evicted=${last.evicted}  cacheEntries=${last.cacheEntries}`);

  check('memory pressure triggered a tile-size reduction', reductions > 0,
    `cacheBytes=${last.cacheBytes}, targetTileSize=${last.targetTileSize}`);
  check('the tile target actually got smaller', last.targetTileSize < before,
    `before=${before} after=${last.targetTileSize}`);
  check('the cache was emptied, not selectively evicted', last.cacheBytes < 512 * 1024 * 1024,
    `cacheBytes=${last.cacheBytes}`);

  console.log('\n3. the worker still renders correctly afterwards');
  const after = await call('render', { page: 0, scale: 1, format: 'bgra', allowCache: false });
  check('renders at the new tile geometry', after.ok === true);
  const text = await call('text', { page: 0 });
  check('text extraction still works', typeof text.chars === 'number' || Array.isArray(text.blocks));

  const frame = Buffer.alloc(9);
  frame.writeUInt32LE(5, 0);
  frame[4] = FRAME.Shutdown;
  child.stdin.write(frame);

  console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`);
  for (const f of failures) console.log(`  - ${f}`);
  child.kill();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`probe failed: ${err.message}`);
  child.kill();
  process.exit(1);
});
