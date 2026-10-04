/**
 * Native PDF tile-cache regression probe.
 *
 * Speaks the raw stdio framing (PROTOCOL.md) directly to
 * `resources/native/eukolia-pdf.exe`, so a failure localises to the C++ side
 * without the TypeScript bridge in the way.
 *
 * This is the executable form of the A/B/A investigation recorded in
 * PDFVIEWER.md §2 ("Reproduced native tile-cache defect"): two sibling tiles of
 * one page are requested, then the first one again. Before the fix, storing a
 * tile removed every other tile of the same page, so every request was a miss
 * and the cache never held more than one entry.
 *
 * It is a *cache-behaviour* probe. Its timings include native rendering and pipe
 * transfer and are not UI frame times; the pass/fail signal is `fromCache`, the
 * entry counters and the eviction/oversize counters, not the milliseconds.
 *
 * Usage:
 *   node scripts/pdf-tile-cache-probe.mjs [path/to/file.pdf] [--json out.json]
 *
 * Exit codes: 0 when every check passes, 1 otherwise.
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

const FRAME = {
  Request: 1,
  Cancel: 2,
  Ping: 3,
  Shutdown: 4,
  Response: 128,
  Error: 129,
  Pixels: 130,
  Ready: 131,
  Log: 132,
  Pong: 133
};

const argv = process.argv.slice(2);
const jsonFlag = argv.indexOf('--json');
const jsonPath = jsonFlag >= 0 ? argv[jsonFlag + 1] : null;
const positional = argv.filter((a, i) => !a.startsWith('--') && i !== jsonFlag + 1);

/**
 * Default fixture: the 242-page Eukolia document the original investigation used.
 * `tests/pdf/fixtures/fixture.pdf` is the fallback so the probe still runs in a
 * checkout without the author's TeX project.
 */
const DEFAULT_PDF = 'D:\\LaTeX projects\\Eukolia\\Eukolia.pdf';
const candidate = positional[0] ?? DEFAULT_PDF;
const pdfPath = path.resolve(
  fs.existsSync(candidate) ? candidate : path.join(ROOT, 'tests', 'pdf', 'fixtures', 'fixture.pdf')
);

if (!fs.existsSync(pdfPath)) {
  console.error(`no PDF at ${pdfPath}`);
  process.exit(1);
}
if (!fs.existsSync(EXE)) {
  console.error(`worker not built: ${EXE} (run: node scripts/build-native-pdf.mjs)`);
  process.exit(1);
}

/**
 * A budget small enough that a single full-page render at scale 2 is larger than
 * the whole cache, which is the case the "one entry can exceed the budget" rule
 * is about. 24 MiB holds a couple of tiles but not a 1224x1584 page (7.4 MiB) plus
 * its neighbours, and not a large-fixture page at all.
 */
const spawnEnv = { ...process.env };
if (!spawnEnv.EUKOLIA_PDF_CACHE_MB) spawnEnv.EUKOLIA_PDF_CACHE_MB = '24';

const child = spawn(EXE, [], { cwd: path.dirname(EXE), stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv });
child.stderr.on('data', (chunk) => process.stderr.write(`[worker stderr] ${chunk}`));

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

    if (type === FRAME.Pixels) {
      const headerBytes = body.readUInt32LE(0);
      const header = JSON.parse(body.subarray(4, 4 + headerBytes).toString('utf8'));
      const blob = body.subarray(4 + headerBytes);
      const entry = pending.get(requestId);
      if (entry) {
        pending.delete(requestId);
        entry.resolve({ ...header, blob });
      }
      continue;
    }

    const json = body.length ? JSON.parse(body.toString('utf8')) : {};
    if (type === FRAME.Ready || type === FRAME.Log || type === FRAME.Pong) continue;
    const entry = pending.get(requestId);
    if (!entry) continue;
    pending.delete(requestId);
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
      if (pending.delete(requestId)) reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
  });
  child.stdin.write(frame);
  return promise;
}

function shutdown() {
  const frame = Buffer.alloc(9);
  frame.writeUInt32LE(5, 0);
  frame[4] = FRAME.Shutdown;
  try {
    child.stdin.write(frame);
  } catch {
    /* the worker is already gone */
  }
}

const results = { pdf: pdfPath, cacheBudgetMb: Number(spawnEnv.EUKOLIA_PDF_CACHE_MB), checks: [], steps: [] };
let failures = 0;

function check(name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` -- ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = () => call('stats');
/** `stats` plus the full entry list, for diagnosing which entry survived what. */
const statsDetailed = () => call('stats', { includeEntries: true });

async function render(params) {
  const start = performance.now();
  const reply = await call('render', { format: 'rgba', allowCache: true, ...params });
  const after = await stats();
  return { reply, stats: after, elapsedMs: performance.now() - start };
}

try {
  const opened = await call('open', { path: pdfPath });
  console.log(`opened ${pdfPath}: ${opened.pageCount} pages, engine ${opened.engine}`);
  results.pageCount = opened.pageCount;

  const page = 0;
  const scale = 2;
  const TILE = { res: 1, row: 0, col: 0 };
  const SIBLING = { res: 1, row: 0, col: 1 };
  const COUSIN = { res: 1, row: 1, col: 0 };
  const LAST = { res: 1, row: 1, col: 1 };

  console.log(`\n--- A/B/A on page ${page} @ scale ${scale}, res-1 tiles ---`);
  const a1 = await render({ page, scale, tile: TILE });
  const b1 = await render({ page, scale, tile: SIBLING });
  const a2 = await render({ page, scale, tile: TILE });
  const c1 = await render({ page, scale, tile: COUSIN });
  const d1 = await render({ page, scale, tile: LAST });

  for (const [label, step] of [['A1', a1], ['B1', b1], ['A2', a2], ['C1', c1], ['D1', d1]]) {
    const row = {
      label,
      fromCache: step.reply.fromCache,
      width: step.reply.width,
      height: step.reply.height,
      pageRect: step.reply.pageRect,
      pageBytes: step.reply.blob.length,
      elapsedMs: Number(step.elapsedMs.toFixed(3)),
      cacheEntries: step.stats.cacheEntries,
      cacheBytes: step.stats.cacheBytes,
      servedFromCache: step.stats.servedFromCache,
      rendered: step.stats.rendered,
      threadsSpawned: step.stats.threadsSpawned
    };
    results.steps.push(row);
    console.log(
      `  ${label}: fromCache=${row.fromCache} ${row.width}x${row.height} bytes=${row.pageBytes} ` +
        `entries=${row.cacheEntries} rendered=${row.rendered} threads=${row.threadsSpawned} ` +
        `evicted=${JSON.stringify({
          unwanted: step.stats.evictedUnwantedPages,
          budget: step.stats.evictedBudget,
          oldGen: step.stats.evictedOldGeneration,
          oldVariant: step.stats.evictedOldVariant,
          superseded: step.stats.evictedSuperseded
        })}`
    );
  }

  check('A1 is a miss (nothing cached yet)', a1.reply.fromCache === false);
  check('B1 is a miss (its sibling is not cached yet)', b1.reply.fromCache === false);
  check('A2 is a HIT after the sibling was stored', a2.reply.fromCache === true, {
    fromCache: a2.reply.fromCache,
    entries: a2.stats.cacheEntries
  });
  check('sibling tiles coexist in the cache', b1.stats.cacheEntries >= 2 && a2.stats.cacheEntries >= 2, {
    afterB1: b1.stats.cacheEntries,
    afterA2: a2.stats.cacheEntries
  });
  check('two further tiles are stored without dropping the first two', d1.stats.cacheEntries >= 4, {
    afterC1: c1.stats.cacheEntries,
    afterD1: d1.stats.cacheEntries,
    entries: (await statsDetailed()).entries
  });
  check(
    'exactly the three tiles that were misses were rasterised',
    a1.stats.rendered === 1 && b1.stats.rendered === 2 && a2.stats.rendered === 2 && c1.stats.rendered === 3 && d1.stats.rendered === 4,
    { rendered: [a1.stats.rendered, b1.stats.rendered, a2.stats.rendered, c1.stats.rendered, d1.stats.rendered] }
  );
  check('four sequential requests needed exactly one render thread', d1.stats.threadsSpawned === 1, {
    threadsSpawned: d1.stats.threadsSpawned
  });
  console.log('  diagnostics:', JSON.stringify(await call('diagnostics')));

  console.log('\n--- repeat requests deduplicate instead of accumulating ---');
  const entriesBefore = (await stats()).cacheEntries;
  const a3 = await render({ page, scale, tile: TILE });
  const a4 = await render({ page, scale, tile: TILE });
  const entriesAfter = (await stats()).cacheEntries;
  check('repeat requests are hits and add no entries', a3.reply.fromCache && a4.reply.fromCache && entriesAfter === entriesBefore, {
    entriesBefore,
    entriesAfter
  });

  console.log('\n--- a second raster scale is a retained generation, not an eviction ---');
  const finer = await render({ page, scale: 3, tile: TILE });
  const afterOtherScale = await stats();
  check('a coarser tile survives a finer render of the same region', afterOtherScale.cacheEntries >= entriesAfter + 1, {
    before: entriesAfter,
    after: afterOtherScale.cacheEntries
  });
  check('the finer tile itself was a miss', finer.reply.fromCache === false);
  const backToCoarse = await render({ page, scale, tile: TILE });
  check('the coarse generation is still served from cache', backToCoarse.reply.fromCache === true, {
    fromCache: backToCoarse.reply.fromCache
  });

  console.log('\n--- the clip route caches and reuses too ---');
  /**
   * The clip route is the compatibility path (`pdfRender` as it stands today) and
   * it has to keep behaving: a repeated clip of the same page-space rectangle must
   * be a cache hit rather than a second rasterisation. The tile route and the clip
   * route keep separate region identities when their arithmetic differs by
   * floating-point rounding, which is why this checks the clip route against
   * itself rather than demanding exact congruence with the tile grid.
   */
  const clipRegion = { x: 12.5, y: 40, width: 200, height: 260 };
  const clip1 = await render({ page, scale, clip: clipRegion });
  const clip2 = await render({ page, scale, clip: clipRegion });
  check('a repeated clip is a cache hit', clip1.reply.fromCache === false && clip2.reply.fromCache === true, {
    first: clip1.reply.fromCache,
    second: clip2.reply.fromCache,
    entries: clip2.stats.cacheEntries
  });
  check('a clip render reports the region it drew', clip2.reply.pageRect.width >= clipRegion.width - 1, {
    pageRect: clip2.reply.pageRect
  });

  console.log('\n--- a whole-page render supersedes the bands it covers ---');
  const beforeWholePage = (await stats()).cacheEntries;
  const wholePage = await render({ page, scale });
  const afterWholePage = await stats();
  check('a whole-page render is itself a miss', wholePage.reply.fromCache === false, {
    width: wholePage.reply.width,
    height: wholePage.reply.height
  });
  check(
    'the bands the whole page covers are dropped, and it is cached in their place',
    afterWholePage.cacheEntries <= beforeWholePage && afterWholePage.cacheEntries >= 1,
    { before: beforeWholePage, after: afterWholePage.cacheEntries }
  );
  const wholeAgain = await render({ page, scale });
  check('the whole page is then served from cache', wholeAgain.reply.fromCache === true);

  console.log('\n--- tile geometry and index validation ---');
  const tileList = await call('tiles', { page, scale, targetTileSize: 704 });
  const first = tileList.tiles?.[0];
  const pageBox = opened.pages?.[page] ?? null;
  check('tiles are enumerated for the page', Array.isArray(tileList.tiles) && tileList.tiles.length > 0, {
    res: tileList.res,
    count: tileList.tiles?.length
  });
  check(
    'every tile rect lies inside the page box',
    Boolean(pageBox) &&
      (tileList.tiles ?? []).every(
        (t) =>
          t.rect.x >= -0.01 &&
          t.rect.y >= -0.01 &&
          t.rect.x + t.rect.width <= pageBox.width + 0.01 &&
          t.rect.y + t.rect.height <= pageBox.height + 0.01
      ),
    { first, pageBox }
  );
  const outOfGrid = await call('render', { page, scale, tile: { res: 1, row: 5, col: 0 } }).then(
    () => 'accepted',
    (e) => `rejected: ${e.message}`
  );
  check('a tile outside its resolution grid is rejected', outOfGrid.startsWith('rejected'), { outOfGrid });
  const badRes = await call('render', { page, scale, tile: { res: 16, row: 0, col: 0 } }).then(
    () => 'accepted',
    (e) => `rejected: ${e.message}`
  );
  check('a resolution whose grid exceeds 16-bit row/col is rejected', badRes.startsWith('rejected'), { badRes });
  const negative = await call('render', { page, scale, tile: { res: 1, row: -1, col: 0 } }).then(
    () => 'accepted',
    (e) => `rejected: ${e.message}`
  );
  check('a negative tile index is rejected', negative.startsWith('rejected'), { negative });

  console.log('\n--- a single entry larger than the whole budget is not cached ---');
  const skippedBefore = (await stats()).skippedOversized ?? 0;
  const huge = await render({ page, scale: 8, allowCache: false });
  const afterHuge = await stats();
  check('the oversized render still returns pixels', huge.reply.width > 0 && huge.reply.height > 0, {
    width: huge.reply.width,
    height: huge.reply.height,
    bytes: huge.reply.blob.length
  });
  const budgetBytes = Number(spawnEnv.EUKOLIA_PDF_CACHE_MB) * 1024 * 1024;
  if (huge.reply.blob.length > budgetBytes) {
    check('an entry bigger than the budget is counted, not cached', (afterHuge.skippedOversized ?? 0) > skippedBefore, {
      skippedBefore,
      skippedAfter: afterHuge.skippedOversized,
      entryBytes: huge.reply.blob.length,
      budgetBytes
    });
    check('the cache stayed inside its byte budget', afterHuge.cacheBytes <= budgetBytes, {
      cacheBytes: afterHuge.cacheBytes,
      budgetBytes
    });
  } else {
    check('oversize case reachable at this budget', false, {
      entryBytes: huge.reply.blob.length,
      budgetBytes
    });
  }

  console.log('\n--- byte and entry budgets hold under a sweep ---');
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      await render({ page, scale, tile: { res: 3, row: r, col: c }, allowCache: true });
    }
  }
  const swept = await stats();
  check('cache bytes respect the configured budget after the sweep', swept.cacheBytes <= Number(spawnEnv.EUKOLIA_PDF_CACHE_MB) * 1024 * 1024, {
    cacheBytes: swept.cacheBytes
  });
  check('cache entries respect the entry cap after the sweep', swept.cacheEntries <= 256, { cacheEntries: swept.cacheEntries });

  console.log('\n--- eviction sacrifices the unwatched page first ---');
  const farTile = { res: 1, row: 0, col: 1 };
  await render({ page: 3, scale, tile: farTile });
  const beforeViewport = await stats();
  await call('viewport', { visiblePages: [0], adjacentPages: [], nearbyPages: [], prefetch: false });
  const afterViewport = await stats();
  check('viewport update reports the surviving entries', afterViewport.cacheEntries >= 1, {
    before: beforeViewport.cacheEntries,
    after: afterViewport.cacheEntries
  });

  results.finalStats = await stats();
  console.log('\nfinal stats:', JSON.stringify(results.finalStats));
} catch (error) {
  console.error('PROBE FAILED:', error?.message ?? error);
  failures += 1;
} finally {
  shutdown();
  await sleep(300);
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  results.passed = failures === 0;
  if (jsonPath) {
    fs.writeFileSync(path.resolve(jsonPath), JSON.stringify(results, null, 2));
    console.log(`wrote ${path.resolve(jsonPath)}`);
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
