/**
 * Pinpoints which worker command leaks an mupdf error-stack frame.
 * Development tool; the invariant it checks is also asserted at runtime by the
 * dispatcher in worker_main.cpp (which logs a `log` frame on any leak).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'resources', 'native', 'eukolia-pdf.exe');
const GOOD = path.join(ROOT, 'tests', 'pdf', 'fixtures', 'fixture.pdf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eukolia-depth-'));
const notPdf = path.join(tmp, 'not-a-pdf.pdf');
fs.writeFileSync(notPdf, 'not a pdf at all\n'.repeat(50));

const child = spawn(EXE, [], { cwd: path.dirname(EXE), stdio: ['pipe', 'pipe', 'pipe'] });
let buf = Buffer.alloc(0);
const pend = new Map();
let id = 1;

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
    if (t === 131) continue;
    if (t === 132) {
      console.log(`   > ${b.toString()}`);
      continue;
    }
    if (t === 130) {
      const hb = b.readUInt32LE(0);
      const h = JSON.parse(b.subarray(4, 4 + hb).toString());
      const e = pend.get(rid);
      if (e) {
        pend.delete(rid);
        e({ ok: true, ...h });
      }
      continue;
    }
    if (t === 128 || t === 129) {
      const j = b.length ? JSON.parse(b.toString()) : {};
      const e = pend.get(rid);
      if (e) {
        pend.delete(rid);
        e(j);
      }
    }
  }
});

function call(cmd, params = {}, timeoutMs = 20000) {
  const i = id++;
  const b = Buffer.from(JSON.stringify({ cmd, ...params }), 'utf8');
  const f = Buffer.alloc(4 + 5 + b.length);
  f.writeUInt32LE(5 + b.length, 0);
  f[4] = 1;
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

const depth = async () => (await call('debugErrorState')).stackDepth;

const main = async () => {
  console.log(`start depth            = ${await depth()}`);
  for (const file of [notPdf, GOOD, notPdf, GOOD, GOOD]) {
    const r = await call('open', { path: file });
    console.log(`after open ${path.basename(file).padEnd(14)} = ${await depth()}  (ok=${r.ok})`);
  }
  const steps = [
    ['render ok', 'render', { page: 2, scale: 1, format: 'bgra', allowCache: false }],
    ['render bad page', 'render', { page: 99, scale: 1 }],
    ['render bad scale', 'render', { page: 0, scale: 1e9 }],
    ['render empty clip', 'render', { page: 0, scale: 1, clip: { x: 0, y: 0, width: 0, height: 0 } }],
    ['text ok', 'text', { page: 2 }],
    ['text bad page', 'text', { page: 99 }],
    ['glyphs ok', 'glyphs', { page: 2 }],
    ['links ok', 'links', { page: 2 }],
    ['outline ok', 'outline', {}],
    ['search ok', 'search', { query: 'ZEBRAFISH' }],
    ['search empty', 'search', { query: '' }],
    ['select ok', 'select', { page: 2, mode: 'word', x: 100, y: 300 }],
    ['select bad page', 'select', { page: 99, mode: 'word', x: 1, y: 1 }],
    ['tiles ok', 'tiles', { page: 2, scale: 1 }],
    ['tiles bad page', 'tiles', { page: 99, scale: 1 }],
    ['viewport ok', 'viewport', { visiblePages: [2], adjacentPages: [1], nearbyPages: [0], scale: 1 }],
    ['viewport bogus', 'viewport', { visiblePages: [-1, 999], scale: 1 }],
    ['pageContentBox ok', 'pageContentBox', { page: 2 }],
    ['pageContentBox bad', 'pageContentBox', { page: 99 }],
    ['fontList ok', 'fontList', { firstPage: 0, lastPage: 2 }],
    ['stats ok', 'stats', {}],
    ['close', 'close', {}]
  ];
  for (const [label, cmd, params] of steps) {
    const r = await call(cmd, params).catch((e) => ({ ok: false, error: e.message }));
    const d = await depth();
    console.log(`${label.padEnd(22)} depth=${d}${r.ok === false ? ' (error)' : ''}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  const f = Buffer.alloc(9);
  f.writeUInt32LE(5, 0);
  f[4] = 4;
  child.stdin.write(f);
  setTimeout(() => {
    console.log('exit code:', child.exitCode);
    process.exit(0);
  }, 3000);
};

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
