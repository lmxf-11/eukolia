/**
 * Robustness probe for the native PDF worker.
 *
 * Hammers the worker with damaged files, out-of-range requests and malformed
 * frames, then asserts that:
 *   - the process is still alive,
 *   - the base context's mupdf error stack is still balanced (depth 0), which is
 *     what trips fz_drop_context's assert in the debug DLL that ships in
 *     resources/native, and
 *   - the worker still answers real requests correctly afterwards.
 *
 * Run: node scripts/stress-native-pdf.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'resources', 'native', 'eukolia-pdf.exe');
const GOOD_PDF = path.join(ROOT, 'tests', 'pdf', 'fixtures', 'fixture.pdf');

const FRAME = { Request: 1, Ping: 3, Shutdown: 4, Response: 128, Error: 129, Pixels: 130, Ready: 131 };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eukolia-stress-'));
const damaged = path.join(tmp, 'damaged.pdf');
{
  // A PDF header followed by garbage: enough to be recognised as a PDF and to
  // make every object lookup fail.
  const bytes = Buffer.concat([
    Buffer.from('%PDF-1.7\n', 'latin1'),
    Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'),
    Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'latin1'),
    Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n', 'latin1'),
    Buffer.from('trailer\n<< /Root 1 0 R /Size 4 >>\nstartxref\n0\n%%EOF\n', 'latin1'),
    Buffer.alloc(2048, 0xab)
  ]);
  fs.writeFileSync(damaged, bytes);
}
const notPdf = path.join(tmp, 'not-a-pdf.pdf');
fs.writeFileSync(notPdf, 'this is definitely not a pdf, it is a text file\n'.repeat(20));

const child = spawn(EXE, [], { cwd: path.dirname(EXE), stdio: ['pipe', 'pipe', 'pipe'] });
let exited = false;
let exitInfo = null;
child.on('exit', (code, signal) => {
  exited = true;
  exitInfo = { code, signal };
});
child.stderr.on('data', (c) => process.stderr.write(`[stderr] ${c}`));

let buf = Buffer.alloc(0);
const pend = new Map();
let id = 1;
let ready = false;

child.stdout.on('data', (ch) => {
  buf = Buffer.concat([buf, ch]);
  for (;;) {
    if (buf.length < 4) return;
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) return;
    const p = buf.subarray(4, 4 + n);
    buf = buf.subarray(4 + n);
    const t = p[0];
    const rid = p.readUInt32LE(1);
    const b = p.subarray(5);
    if (t === FRAME.Ready) {
      ready = true;
      continue;
    }
    if (t === FRAME.Pixels) {
      const hb = b.readUInt32LE(0);
      const h = JSON.parse(b.subarray(4, 4 + hb).toString());
      const e = pend.get(rid);
      if (e) {
        pend.delete(rid);
        e({ ok: true, ...h });
      }
      continue;
    }
    if (t === FRAME.Response || t === FRAME.Error) {
      const j = b.length ? JSON.parse(b.toString()) : {};
      const e = pend.get(rid);
      if (e) {
        pend.delete(rid);
        e(j);
      }
    }
  }
});

function call(cmd, params = {}, timeoutMs = 30000) {
  const i = id++;
  const b = Buffer.from(JSON.stringify({ cmd, ...params }), 'utf8');
  const f = Buffer.alloc(4 + 5 + b.length);
  f.writeUInt32LE(5 + b.length, 0);
  f[4] = FRAME.Request;
  f.writeUInt32LE(i, 5);
  b.copy(f, 9);
  const pr = new Promise((resolve, reject) => {
    pend.set(i, resolve);
    setTimeout(() => {
      if (pend.delete(i)) reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
  });
  child.stdin.write(f);
  return pr;
}

/** Send a raw frame with an arbitrary body, bypassing the JSON helpers. */
function rawFrame(type, requestId, body) {
  const f = Buffer.alloc(4 + 5 + body.length);
  f.writeUInt32LE(5 + body.length, 0);
  f[4] = type;
  f.writeUInt32LE(requestId, 5);
  body.copy(f, 9);
  child.stdin.write(f);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
function check(label, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures.push(label);
  }
}

const main = async () => {
  await sleep(400);
  check('worker became ready', ready);
  check('worker is still running', !exited, JSON.stringify(exitInfo));

  console.log('\n1. damaged and non-PDF inputs');
  for (const [label, file] of [
    ['truncated/garbage PDF', damaged],
    ['plain text file', notPdf],
    ['missing file', path.join(tmp, 'nope.pdf')]
  ]) {
    const result = await call('open', { path: file }).catch((e) => ({ ok: false, error: e.message }));
    // A minimal-but-valid PDF with one page legitimately opens; what matters is
    // that the worker answers and stays alive either way.
    check(`open answered for ${label}`, typeof result?.ok === 'boolean', JSON.stringify(result).slice(0, 120));
    check(`worker alive after ${label}`, !exited);
  }

  // Force real mupdf failures (not just "file not found") through the whole
  // request surface: these are the paths that used to leak error-stack frames.
  for (const [label, cmd, params] of [
    ['text on the damaged doc', 'text', { page: 0 }],
    ['render on the damaged doc', 'render', { page: 0, scale: 1, format: 'bgra', allowCache: false }],
    ['glyphs on the damaged doc', 'glyphs', { page: 0 }],
    ['outline of the damaged doc', 'outline', {}],
    ['search the damaged doc', 'search', { query: 'anything' }]
  ]) {
    const result = await call(cmd, params).catch((e) => ({ ok: false, error: e.message }));
    check(`${label} answered`, typeof result?.ok === 'boolean', JSON.stringify(result).slice(0, 110));
  }
  check('worker alive after damaged-document requests', !exited, JSON.stringify(exitInfo));

  console.log('\n2. open the real fixture and hammer out-of-range requests');
  const opened = await call('open', { path: GOOD_PDF });
  check('real fixture opens', opened.ok === true && opened.pageCount === 3, JSON.stringify(opened).slice(0, 120));

  const badRequests = [
    ['render page -1', 'render', { page: -1, scale: 1 }],
    ['render page 9999', 'render', { page: 9999, scale: 1 }],
    ['render scale 0', 'render', { page: 0, scale: 0 }],
    ['render scale 1e9', 'render', { page: 0, scale: 1e9 }],
    ['render scale NaN', 'render', { page: 0, scale: 'not-a-number' }],
    ['render empty clip', 'render', { page: 0, scale: 1, clip: { x: 0, y: 0, width: 0, height: 0 } }],
    ['render bad tile', 'render', { page: 0, scale: 1, tile: { res: 2, row: 99, col: 99 } }],
    ['render tile res 30', 'render', { page: 0, scale: 1, tile: { res: 30, row: 0, col: 0 } }],
    ['text page 9999', 'text', { page: 9999 }],
    ['glyphs page -5', 'glyphs', { page: -5 }],
    ['links page 9999', 'links', { page: 9999 }],
    ['select page 9999', 'select', { page: 9999, mode: 'range' }],
    ['select word off-page', 'select', { page: 0, mode: 'word', x: 1e7, y: -1e7 }],
    ['search empty query', 'search', { query: '' }],
    ['search huge max', 'search', { query: 'e', maxResults: 999999 }],
    ['tiles page 9999', 'tiles', { page: 9999, scale: 1 }],
    ['viewport bogus pages', 'viewport', { visiblePages: [-1, 9999], adjacentPages: [1e6], nearbyPages: [-1e6], scale: 1 }],
    ['pageContentBox page 9999', 'pageContentBox', { page: 9999 }],
    ['fontList inverted range', 'fontList', { firstPage: 99, lastPage: 0 }],
    ['stats', 'stats', {}],
    ['debugErrorState', 'debugErrorState', {}]
  ];

  for (const [label, cmd, params] of badRequests) {
    try {
      const result = await call(cmd, params);
      const errored = result && result.ok === false;
      const ok = result !== undefined;
      check(`${label} answered (${errored ? 'error' : 'ok'})`, ok, JSON.stringify(result).slice(0, 100));
    } catch (e) {
      check(`${label} answered`, false, e.message);
    }
    if (exited) break;
  }
  check('worker survived the out-of-range sweep', !exited, JSON.stringify(exitInfo));

  console.log('\n3. malformed frames');
  rawFrame(FRAME.Request, 9001, Buffer.from('{ not json at all', 'utf8'));
  rawFrame(FRAME.Request, 9002, Buffer.from('{"cmd":', 'utf8'));
  rawFrame(FRAME.Request, 9003, Buffer.from(JSON.stringify({ cmd: 'no-such-command' }), 'utf8'));
  rawFrame(FRAME.Request, 9004, Buffer.from(JSON.stringify({ noCmd: true }), 'utf8'));
  rawFrame(FRAME.Cancel, 9005, Buffer.from('garbage', 'utf8'));
  rawFrame(FRAME.Ping, 9006, Buffer.alloc(0));
  await sleep(600);
  check('worker survived malformed frames', !exited, JSON.stringify(exitInfo));

  console.log('\n4. it still works');
  const ping = await call('stats').catch((e) => ({ error: e.message }));
  check('stats still answers', ping && ping.ok === true, JSON.stringify(ping).slice(0, 120));

  const render = await call('render', { page: 2, scale: 1, format: 'bgra', allowCache: false });
  check(
    'a real render still succeeds',
    render && render.ok === true && render.width > 0 && render.height > 0,
    JSON.stringify(render).slice(0, 140)
  );

  const text = await call('text', { page: 2 });
  check('real text extraction still succeeds', text && text.ok === true && text.text.length > 100);

  const outline = await call('outline');
  check('outline still succeeds', outline && outline.ok === true && outline.outline.length >= 3);

  console.log('\n5. mupdf error stack balance (this is the crash condition)');
  const state = await call('debugErrorState');
  console.log(`  base context error stack depth = ${state.stackDepth} (capacity ${state.stackCapacity}), errcode=${state.errcode}`);
  check('error stack is balanced (depth 0)', state.stackDepth === 0, `depth=${state.stackDepth}`);

  console.log('\n6. clean shutdown (fz_drop_context must not assert)');
  const shutdownFrame = Buffer.alloc(9);
  shutdownFrame.writeUInt32LE(5, 0);
  shutdownFrame[4] = FRAME.Shutdown;
  child.stdin.write(shutdownFrame);
  for (let i = 0; i < 60 && !exited; i++) await sleep(100);
  check('worker exited', exited, 'still running');
  check('worker exit code is 0', exitInfo?.code === 0, JSON.stringify(exitInfo));

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
};

main().catch((e) => {
  console.error('STRESS PROBE FAILED:', e);
  try {
    child.kill();
  } catch {}
  process.exit(1);
});
