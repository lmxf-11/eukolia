/**
 * Ad-hoc protocol smoke test for the native PDF worker.
 *
 * Speaks the raw stdio framing (PROTOCOL.md) directly, without the TypeScript
 * bridge, so a failure localises to the C++ side. Not part of the test suite:
 * run it manually while developing the worker.
 *
 *   node scripts/smoke-native-pdf.mjs [path/to/file.pdf]
 *
 * Copyright 2026 the Eukolia project authors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
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

const child = spawn(EXE, [], { cwd: path.dirname(EXE), stdio: ['pipe', 'pipe', 'pipe'] });
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
    if (type === FRAME.Ready) {
      console.log('READY:', JSON.stringify(json));
      continue;
    }
    if (type === FRAME.Log) {
      console.log('LOG:', JSON.stringify(json));
      continue;
    }
    if (type === FRAME.Pong) {
      console.log('PONG:', JSON.stringify(json));
      continue;
    }
    const entry = pending.get(requestId);
    if (!entry) {
      console.log(`UNSOLICITED ${type}:`, JSON.stringify(json));
      continue;
    }
    pending.delete(requestId);
    if (type === FRAME.Error) entry.reject(new Error(json.error ?? 'worker error'));
    else entry.resolve(json);
  }
});

function call(cmd, params = {}, timeoutMs = 60000) {
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
  child.stdin.write(frame);
}

const main = async () => {
  const readySeen = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    const onData = () => {
      clearTimeout(timer);
      resolve(true);
    };
    // Ready is printed by the frame handler above; give it a tick.
    child.stdout.once('data', onData);
  });
  console.log('ready frame observed:', readySeen);

  console.log('--- ping ---');
  console.log(await call('stats'));

  console.log(`--- open ${pdfPath} ---`);
  const opened = await call('open', { path: pdfPath });
  console.log({
    pageCount: opened.pageCount,
    firstPage: opened.pages?.[0],
    outlineItems: opened.outline?.length ?? 0,
    metadata: opened.metadata,
    engine: opened.engine
  });

  console.log('--- render page 0 @ scale 1.25 ---');
  const renderStart = Date.now();
  const rendered = await call('render', { page: 0, scale: 1.25, format: 'bgra' });
  const digest = crypto.createHash('sha256').update(rendered.blob).digest('hex');
  const distinct = new Set();
  for (let i = 0; i + 4 <= rendered.blob.length && distinct.size < 64; i += 4) {
    distinct.add(rendered.blob.readUInt32LE(i));
  }
  const firstPixel = [...rendered.blob.subarray(0, 4)];
  console.log({
    width: rendered.width,
    height: rendered.height,
    stride: rendered.stride,
    channels: rendered.channels,
    order: rendered.order,
    pageRect: rendered.pageRect,
    fromCache: rendered.fromCache,
    blobBytes: rendered.blob.length,
    sha256: digest,
    firstPixel,
    distinctPixelsSampled: distinct.size,
    ms: Date.now() - renderStart
  });

  console.log('--- render again (cache) ---');
  const cached = await call('render', { page: 0, scale: 1.25, format: 'bgra' });
  console.log({ fromCache: cached.fromCache, sameDigest: crypto.createHash('sha256').update(cached.blob).digest('hex') === digest });

  console.log('--- tiles page 0 @ scale 1.25 ---');
  const tiles = await call('tiles', { page: 0, scale: 1.25 });
  console.log({ res: tiles.res, tileCount: tiles.tiles?.length, first: tiles.tiles?.[0] });

  console.log('--- text page 0 ---');
  const text = await call('text', { page: 0 });
  const allText = (text.blocks ?? [])
    .flatMap((b) => b.lines ?? [])
    .flatMap((l) => l.spans ?? [])
    .map((s) => s.text)
    .join(' ');
  console.log({
    width: text.width,
    height: text.height,
    blockCount: text.blocks?.length,
    chars: text.text?.length,
    sample: allText.slice(0, 160)
  });

  console.log('--- search ---');
  const words = allText.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter((w) => w.length >= 5);
  const query = words[0] ?? 'the';
  const search = await call('search', { query, maxResults: 20 });
  console.log({ query, matches: search.matches?.length, first: search.matches?.[0], truncated: search.truncated });

  console.log('--- links page 0 ---');
  console.log(await call('links', { page: 0 }));

  console.log('--- outline ---');
  console.log(JSON.stringify(await call('outline')).slice(0, 400));

  console.log('--- stats ---');
  console.log(await call('stats'));

  shutdown();
  await new Promise((resolve) => child.on('exit', resolve));
  console.log('worker exited cleanly');
};

main().catch((error) => {
  console.error('SMOKE TEST FAILED:', error.message);
  try {
    child.kill();
  } catch {}
  process.exit(1);
});
