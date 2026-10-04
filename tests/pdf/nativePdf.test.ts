/**
 * Native PDF subsystem tests.
 *
 * These tests exercise the REAL worker binary (`resources/native/eukolia-pdf.exe`)
 * over the real stdio protocol, through the real TypeScript bridge. Nothing is
 * mocked: if the native engine is broken, these fail.
 *
 * A LaTeX fixture is compiled with MiKTeX's `pdflatex` at test time so the suite
 * is self-contained. The compiled `fixture.pdf` is NOT committed - only
 * `fixture.tex` is, so the fixture can be regenerated and modified.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NativePdfEngine, resolveWorkerPath } from '../../src/main/pdf/nativePdfEngine';
import { SyncTexEngine, parseSynctexEdit, parseSynctexView } from '../../src/main/pdf/synctexEngine';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const FIXTURE_TEX = path.join(FIXTURE_DIR, 'fixture.tex');
const FIXTURE_PDF = path.join(FIXTURE_DIR, 'fixture.pdf');
const FIXTURE_SYNCTEX = path.join(FIXTURE_DIR, 'fixture.synctex.gz');

/** Known marker text in `fixture.tex`, asserted on by the tests. */
const MARKER_LINE = { zebrafish: 82, aardvark: 25, betaSection: 63 } as const;

const MARKER = {
  /** Appears once, on the first body page. */
  aardvark: 'AARDVARK',
  /** A standalone word appearing twice on the first body page. */
  marmot: 'marmot',
  /** Appears once, alone, on the last page. */
  zebrafish: 'ZEBRAFISH',
  /**
   * The first body page's only "zebra" text, and a word that merely starts with
   * it -- which is what makes the whole-word assertions meaningful. Deliberately
   * one unbreakable token: a shorter prefix sitting at a line break would be
   * hyphenated by LaTeX.
   */
  prefixOnly: 'ZEBRAQUAGGA'
} as const;

/** Page indices in the fixture: 0 = title, 1 = first body page, 2 = second. */
const BODY_PAGE = 1;
const LAST_PAGE = 2;

function which(tool: string): string | null {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(finder, [tool], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout) return null;
  const first = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  return first ? first.trim() : null;
}

/**
 * Build the worker when it is missing or older than its sources.
 *
 * Building here rather than skipping is deliberate: a missing worker is a
 * failure of the subsystem, not a reason to report green.
 */
function ensureWorkerBuilt(): string {
  const existing = resolveWorkerPath();
  const sources = [
    path.join(REPO_ROOT, 'src', 'native', 'pdf', 'src', 'worker_main.cpp'),
    path.join(REPO_ROOT, 'src', 'native', 'pdf', 'src', 'mupdf_engine.cpp'),
    path.join(REPO_ROOT, 'src', 'native', 'pdf', 'src', 'render_cache.cpp'),
    path.join(REPO_ROOT, 'src', 'native', 'pdf', 'src', 'render_cache.h'),
    path.join(REPO_ROOT, 'src', 'native', 'pdf', 'src', 'mupdf_engine.h'),
    path.join(REPO_ROOT, 'src', 'native', 'pdf', 'src', 'protocol.h'),
    path.join(REPO_ROOT, 'src', 'native', 'pdf', 'src', 'json.h'),
    path.join(REPO_ROOT, 'src', 'native', 'pdf', 'src', 'json_parse.h'),
    path.join(REPO_ROOT, 'src', 'native', 'pdf', 'src', 'geom.h')
  ];
  const script = path.join(REPO_ROOT, 'scripts', 'build-native-pdf.mjs');
  expect(fs.existsSync(script), `native build script missing at ${script}`).toBe(true);

  const needsBuild =
    !existing ||
    sources.some((source) => !fs.existsSync(source) || fs.statSync(source).mtimeMs > fs.statSync(existing).mtimeMs);

  if (needsBuild) {
    const result = spawnSync(process.execPath, [script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 900_000,
      windowsHide: true
    });
    if (result.status !== 0) {
      throw new Error(`failed to build the native PDF worker:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    }
  }

  const worker = resolveWorkerPath();
  expect(worker, 'eukolia-pdf.exe must exist after the build').not.toBeNull();
  expect(fs.existsSync(worker as string)).toBe(true);
  return worker as string;
}

/** Compile the LaTeX fixture into a real PDF, failing loudly if pdflatex is absent. */
function ensureFixturePdf(): void {
  expect(fs.existsSync(FIXTURE_TEX), `fixture source missing at ${FIXTURE_TEX}`).toBe(true);

  const pdflatex = which('pdflatex');
  expect(
    pdflatex,
    'pdflatex is required to build the PDF fixture; install MiKTeX (https://miktex.org)'
  ).not.toBeNull();

  const pdfIsFresh =
    fs.existsSync(FIXTURE_PDF) &&
    fs.statSync(FIXTURE_PDF).mtimeMs >= fs.statSync(FIXTURE_TEX).mtimeMs &&
    fs.existsSync(FIXTURE_SYNCTEX);

  if (pdfIsFresh) return;

  // Two passes so the table of contents (and therefore the page count the
  // expectations rely on) is stable. -synctex=1 produces fixture.synctex.gz.
  for (let pass = 0; pass < 2; pass++) {
    const result = spawnSync(
      pdflatex as string,
      ['-interaction=nonstopmode', '-halt-on-error', '-synctex=1', 'fixture.tex'],
      { cwd: FIXTURE_DIR, encoding: 'utf8', timeout: 300_000, windowsHide: true }
    );
    if (result.status !== 0) {
      const log = fs.existsSync(path.join(FIXTURE_DIR, 'fixture.log'))
        ? fs.readFileSync(path.join(FIXTURE_DIR, 'fixture.log'), 'utf8').slice(-4000)
        : '';
      throw new Error(
        `pdflatex failed on pass ${pass + 1} (exit ${result.status}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}\n--- log tail ---\n${log}`
      );
    }
  }

  expect(fs.existsSync(FIXTURE_PDF), 'pdflatex must have produced fixture.pdf').toBe(true);
  expect(fs.existsSync(FIXTURE_SYNCTEX), 'pdflatex must have produced fixture.synctex.gz').toBe(true);
}

/** Count distinct 4-byte pixel values in a sampled grid. */
function distinctPixelValues(pixels: Uint8Array, channels: number, width: number, height: number): number {
  const seen = new Set<number>();
  const samples = 4096;
  const stride = Math.max(1, Math.floor((width * height) / samples));
  for (let index = 0; index < width * height; index += stride) {
    const offset = index * channels;
    if (offset + channels > pixels.length) break;
    let value = 0;
    for (let channel = 0; channel < channels; channel++) {
      value = (value << 8) | pixels[offset + channel];
    }
    seen.add(value >>> 0);
    if (seen.size > 256) break;
  }
  return seen.size;
}

/** Fraction of sampled pixels that are pure white in BGR (or BGRA) order. */
function whiteFraction(pixels: Uint8Array, channels: number): number {
  if (pixels.length === 0) return 1;
  let white = 0;
  let total = 0;
  // Step by whole pixels: stepping by channel*N can land on the same channel
  // offset every time and bias the sample.
  for (let index = 0; (index + 1) * channels <= pixels.length; index += 37) {
    const offset = index * channels;
    total++;
    if (pixels[offset] === 255 && pixels[offset + 1] === 255 && pixels[offset + 2] === 255) white++;
  }
  return total === 0 ? 1 : white / total;
}

let engine: NativePdfEngine;
let docId = '';
let workerPath = '';
let pageCount = 0;

beforeAll(async () => {
  // Everything the suite needs is prepared here rather than inside an individual
  // test: the worker binary is built when stale or missing, the LaTeX fixture is
  // compiled, and the document is opened. That makes the file order-independent
  // and means `-t <name>` runs a single test against a live document instead of
  // failing with "no document is open".
  workerPath = ensureWorkerBuilt();
  ensureFixturePdf();
  engine = new NativePdfEngine({ workerPath, autoBuild: false, maxRestarts: 1 });

  const opened = await engine.openDocument(FIXTURE_PDF);
  docId = opened.docId;
  pageCount = opened.open.pageCount;

  // The page content the tests assert on must actually be where they expect it;
  // a fixture edit that shifts the layout should fail here, not in ten unrelated
  // assertions.
  expect(pageCount, 'the fixture must have title, contents and body pages').toBe(3);
  const bodyText = (await engine.getPageText(BODY_PAGE)).text;
  expect(bodyText).toContain(MARKER.aardvark);
  expect(bodyText).toContain(MARKER.prefixOnly);
  const lastText = (await engine.getPageText(LAST_PAGE)).text;
  expect(lastText).toContain(MARKER.zebrafish);
  expect(lastText).not.toContain(MARKER.prefixOnly);
}, 900_000);

afterAll(async () => {
  if (engine) {
    await engine.dispose();
  }
});

describe('native PDF worker availability', () => {
  it('locates a built worker binary', () => {
    expect(workerPath).toBeTruthy();
    expect(fs.existsSync(workerPath)).toBe(true);
    // The worker is useless without its runtime next to it.
    const runtime = path.join(path.dirname(workerPath), 'libmupdf.dll');
    expect(fs.existsSync(runtime), `libmupdf.dll must sit beside ${path.basename(workerPath)}`).toBe(true);
  });

  it('reports availability and completes the protocol handshake', async () => {
    expect(engine.isAvailable()).toBe(true);
    expect(await engine.ping()).toBe(true);
    const ready = engine.getReadyInfo();
    expect(ready).not.toBeNull();
    expect(ready?.protocolVersion).toBe(1);
    expect(ready?.engine).toBe('eukolia-mupdf');
    expect(ready?.commands).toContain('render');
    expect(ready?.commands).toContain('search');
  });
});

describe('document opening', () => {
  it('opens the fixture and reports its real page count and page sizes', async () => {
    const opened = await engine.openDocument(FIXTURE_PDF);
    docId = opened.docId;
    pageCount = opened.open.pageCount;

    expect(docId).toMatch(/^[0-9a-f]{12}:\d+$/);
    // The fixture has a title page, a table of contents and one body page.
    expect(opened.open.pageCount).toBeGreaterThanOrEqual(3);
    expect(opened.open.pages).toHaveLength(opened.open.pageCount);
    expect(opened.open.needsPassword).toBe(false);
    expect(opened.open.engine).toBe('eukolia-mupdf');

    // A4 or US Letter geometry, in PDF points, all pages the same size here.
    for (const page of opened.open.pages) {
      expect(page.width).toBeGreaterThan(400);
      expect(page.width).toBeLessThan(700);
      expect(page.height).toBeGreaterThan(600);
      expect(page.height).toBeLessThan(900);
      expect(page.rotate).toBe(0);
    }
    // US Letter (612 x 792 pt) is the LaTeX article default; assert the aspect
    // ratio and a plausible point range rather than the exact size.
    expect(opened.open.pages[0].height / opened.open.pages[0].width).toBeCloseTo(792 / 612, 2);
  });

  it('fails loudly for a file that does not exist', async () => {
    await expect(engine.openDocument(path.join(FIXTURE_DIR, 'definitely-missing.pdf'))).rejects.toThrow(/not found/i);
  });

  it('rejects an out-of-range page rather than returning a blank image', async () => {
    await expect(
      engine.renderPage(9001, { page: pageCount + 50, scale: 1 })
    ).rejects.toThrow(/out of range/i);
  });
});

describe('page rendering', () => {
  it('renders an integer device-space tile like the matching whole-page region at fractional scale', async () => {
    const scale = 2.125;
    const full = await engine.renderPage(91001, { page: 2, scale, format: 'rgba' });
    const x = 128, y = 240, width = 384, height = 384;
    const tile = await engine.renderPage(91002, { page: 2, scale, format: 'rgba',
      clip: { x: x / scale, y: y / scale, width: width / scale, height: height / scale } });
    expect([tile.width, tile.height]).toEqual([width, height]);
    let differences = 0;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width * 4; col++) {
        if (tile.pixels[row * tile.stride + col] !== full.pixels[(y + row) * full.stride + x * 4 + col]) differences++;
      }
    }
    expect(differences).toBe(0);
  });

  it('renders a page with the expected pixel dimensions and real content', async () => {
    const scale = 1.5;
    const result = await engine.renderPage(1001, { page: 2, scale, format: 'rgba' });

    // The last page carries the drawn body text and the table.
    expect(result.page).toBe(2);
    expect(result.channels).toBe(4);
    // RGBA, not BGRA: the pixels go straight into a canvas `ImageData`, and asking
    // the engine for the byte order the canvas wants is what removed a per-pixel
    // swap over every rendered page (see `mupdf_engine.cpp`).
    expect(result.order).toBe('rgba');
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);

    const geometry = engine.getPageGeometry(2);
    expect(geometry).not.toBeNull();
    // MuPDF rounds the clip outwards to pixel boundaries, so allow one pixel of
    // slack on each axis.
    expect(Math.abs(result.width - geometry!.width * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(result.height - geometry!.height * scale)).toBeLessThanOrEqual(2);

    // The blob must match the declared geometry exactly, stride included.
    expect(result.pixels).toBeInstanceOf(Uint8Array);
    expect(result.pixels.byteLength).toBe(result.stride * result.height);
    expect(result.stride).toBeGreaterThanOrEqual(result.width * result.channels);
    expect(result.blobBytes).toBe(result.pixels.byteLength);

    // It must have actually rendered something: not a blank page.
    const distinct = distinctPixelValues(result.pixels, result.channels, result.width, result.height);
    expect(distinct, 'rendered page must not be a single flat colour').toBeGreaterThan(3);

    // ...and it must look like a text page: mostly white with dark glyphs.
    const white = whiteFraction(result.pixels, result.channels);
    expect(white).toBeGreaterThan(0.5);
    expect(white).toBeLessThan(1);

    // A page-space rectangle covering the whole page must be reported.
    expect(result.pageRect.width).toBeGreaterThan(400);
    expect(result.pageRect.height).toBeGreaterThan(600);
    expect(result.fromCache).toBe(false);

    // The view matrix maps fitz page space (y down) onto MuPDF device space
    // (y up), so it is a scale with a negative y term. The x term is positive.
    expect(result.view.pageRotate).toBe(0);
    expect(result.view.userRotate).toBe(0);
    expect(result.view.a).toBeCloseTo(scale, 5);
    expect(result.view.d).toBeCloseTo(-scale, 5);
    expect(result.view.b).toBeCloseTo(0, 5);
    expect(result.view.c).toBeCloseTo(0, 5);
  });

  it('serves the second identical request from the render cache', async () => {
    const first = await engine.renderPage(1002, { page: 2, scale: 1.25, format: 'bgra' });
    expect(first.fromCache).toBe(false);
    const digest = crypto.createHash('sha256').update(first.pixels).digest('hex');

    const second = await engine.renderPage(1003, { page: 2, scale: 1.25, format: 'bgra' });
    expect(second.fromCache).toBe(true);
    expect(second.pixels.byteLength).toBe(first.pixels.byteLength);
    expect(crypto.createHash('sha256').update(second.pixels).digest('hex')).toBe(digest);
  });

  it('renders a sub-rectangle (clip) at the requested size in page space', async () => {
    const scale = 2;
    const clip = { x: 60, y: 60, width: 200, height: 100 };
    const result = await engine.renderPage(1004, { page: 2, scale, clip, format: 'bgra', allowCache: false });

    expect(Math.abs(result.width - clip.width * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(result.height - clip.height * scale)).toBeLessThanOrEqual(2);
    // The reported page rectangle must be the clipped region, within a pixel.
    expect(result.pageRect.x).toBeGreaterThanOrEqual(clip.x - 2 / scale);
    expect(result.pageRect.y).toBeGreaterThanOrEqual(clip.y - 2 / scale);
    expect(result.pageRect.width).toBeLessThan(clip.width + 4 / scale);
    expect(result.pageRect.height).toBeLessThan(clip.height + 4 / scale);
  });

  it('renders grey and inverted variants', async () => {
    const grey = await engine.renderPage(1005, { page: 2, scale: 1, format: 'gray', allowCache: false });
    expect(grey.channels).toBe(1);
    expect(grey.order).toBe('gray');
    expect(grey.stride).toBe(grey.width);

    const normal = await engine.renderPage(1006, { page: 2, scale: 1, format: 'bgra', allowCache: false });
    const inverted = await engine.renderPage(1007, { page: 2, scale: 1, format: 'bgra', invert: true, allowCache: false });

    expect(inverted.pixels.byteLength).toBe(normal.pixels.byteLength);
    // Inverting must change the image: a white background becomes dark.
    expect(whiteFraction(inverted.pixels, inverted.channels)).toBeLessThan(
      whiteFraction(normal.pixels, normal.channels)
    );
  });

  it('describes a tile grid whose rects lie inside the page', async () => {
    const tiles = await engine.getTiles(2, 4);
    expect(tiles.page).toBe(2);
    expect(tiles.tiles.length).toBeGreaterThanOrEqual(1);
    const geometry = engine.getPageGeometry(2)!;

    for (const tile of tiles.tiles) {
      expect(tile.res).toBe(tiles.res);
      expect(tile.rect.x).toBeGreaterThanOrEqual(-0.5);
      expect(tile.rect.y).toBeGreaterThanOrEqual(-0.5);
      expect(tile.rect.x + tile.rect.width).toBeLessThanOrEqual(geometry.width + 0.5);
      expect(tile.rect.y + tile.rect.height).toBeLessThanOrEqual(geometry.height + 0.5);
    }
  });

  it('renders an individual tile', async () => {
    const tiles = await engine.getTiles(2, 4);
    const tile = tiles.tiles[0];
    const rendered = await engine.renderPage(1008, { page: 2, scale: 4, tile, format: 'bgra', allowCache: false });
    expect(rendered.width).toBeGreaterThan(0);
    expect(rendered.height).toBeGreaterThan(0);
    expect(rendered.pixels.byteLength).toBe(rendered.stride * rendered.height);
  });

  it('accepts a viewport update and reports cache/prefetch statistics', async () => {
    const result = await engine.setViewport({
      visiblePages: [2],
      adjacentPages: [1],
      nearbyPages: [0],
      scale: 1,
      prefetch: true
    });
    expect(result.ok).toBe(true);
    expect(result.queued).toBeGreaterThanOrEqual(1);
    expect(result.cacheEntries).toBeGreaterThanOrEqual(0);

    const stats = await engine.getStats();
    expect(stats.rendered).toBeGreaterThan(0);
    expect(stats.cacheEntries).toBeGreaterThan(0);
    expect(stats.cacheBytes).toBeGreaterThan(0);
  });

  it('keeps the worker usable when cancelling a queued render', async () => {
    // Queue a large render, cancel it immediately, then prove the engine is
    // still healthy by rendering something else successfully.
    const pending = engine.renderPage(2001, { page: 0, scale: 6, format: 'bgra', allowCache: false });
    const cancelled = await engine.cancelRender(2001);
    expect(typeof cancelled).toBe('boolean');

    const settled = await pending.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    // Either outcome is legitimate: the render may already have started before
    // the cancel arrived. What matters is that the worker stayed alive.
    expect(['resolved', 'rejected']).toContain(settled);

    const after = await engine.renderPage(2002, { page: 2, scale: 1, format: 'bgra' });
    expect(after.ok).toBe(true);
    expect(after.pixels.byteLength).toBeGreaterThan(0);
  }, 60_000);

  it('rejects an absurd scale instead of allocating for it', async () => {
    await expect(engine.renderPage(2003, { page: 0, scale: 500 })).rejects.toThrow(/rejected/i);
  });
});

describe('structured text extraction', () => {
  it('extracts real strings with block/line/span structure', async () => {
    // Page 1 (0-based) is the first body page, which carries "Alpha Section";
    // page 0 is the title page and page 2 is the second body page.
    const page = 1;
    const text = await engine.getPageText(page);
    expect(text.ok).toBe(true);
    expect(text.page).toBe(page);
    expect(text.width).toBeGreaterThan(400);
    expect(text.height).toBeGreaterThan(600);

    // Real extracted content, not an empty placeholder.
    expect(text.text.length).toBeGreaterThan(200);
    expect(text.blocks.length).toBeGreaterThan(0);

    const allSpans = text.blocks.flatMap((block) => block.lines.flatMap((line) => line.spans));
    expect(allSpans.length).toBeGreaterThan(0);

    const flat = allSpans.map((span) => span.text).join(' ').replace(/\s+/g, ' ');
    expect(flat).toContain('Alpha Section');
    expect(flat).toContain('AARDVARK');

    // Every span must carry a plausible font and geometry in PDF points.
    for (const span of allSpans) {
      expect(typeof span.font).toBe('string');
      expect(span.size).toBeGreaterThan(0);
      expect(span.size).toBeLessThan(72);
      expect(span.bbox.width).toBeGreaterThanOrEqual(0);
      expect(span.bbox.height).toBeGreaterThan(0);
      expect(span.bbox.x).toBeGreaterThanOrEqual(-1);
      expect(span.bbox.y).toBeGreaterThanOrEqual(-1);
      expect(span.bbox.x + span.bbox.width).toBeLessThan(text.width + 1);
      expect(span.bbox.y + span.bbox.height).toBeLessThan(text.height + 1);
    }

    // Block boxes must enclose their lines, and lines their spans.
    for (const block of text.blocks) {
      for (const line of block.lines) {
        expect(line.bbox.y).toBeGreaterThanOrEqual(block.bbox.y - 1);
        expect(line.bbox.y + line.bbox.height).toBeLessThanOrEqual(block.bbox.y + block.bbox.height + 1);
        for (const span of line.spans) {
          expect(span.bbox.y).toBeGreaterThanOrEqual(line.bbox.y - 1.5);
        }
      }
    }
  });

  it('extracts text on every page of the fixture', async () => {
    for (let page = 0; page < pageCount; page++) {
      const text = await engine.getPageText(page);
      expect(text.ok).toBe(true);
      expect(text.text.trim().length, `page ${page} must have text`).toBeGreaterThan(0);
    }
  });

  it('reports page-space boxes that agree with where the pixels were drawn', async () => {
    // Cross-check that page-space coordinates and the rasterised output describe
    // the same place. The strongest assumption-free statement is an asymmetry
    // one: the marker's own box is full of glyph ink, and the band at the
    // vertically mirrored position (same x, y counted from the other edge) is
    // not. A box that was offset, flipped, or scaled would fail this, because no
    // real page is mirror-symmetric about its horizontal centre.
    const page = LAST_PAGE;
    const search = await engine.search({ query: MARKER.zebrafish, page, maxResults: 5 });
    expect(search.matches).toHaveLength(1);
    const rects = search.matches[0].rects;
    expect(rects.length).toBeGreaterThanOrEqual(1);
    const box = rects[rects.length - 1];

    const scale = 1;
    const rendered = await engine.renderPage(3001, { page, scale, format: 'bgra', allowCache: false });
    const channels = rendered.channels;
    const geometry = engine.getPageGeometry(page)!;
    expect(rendered.width).toBeGreaterThanOrEqual(Math.floor(geometry.width * scale));

    const inkFraction = (x0: number, y0: number, x1: number, y1: number): number => {
      let ink = 0;
      let total = 0;
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(rendered.height, Math.ceil(y1)); y++) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(rendered.width, Math.ceil(x1)); x++) {
          const offset = y * rendered.stride + x * channels;
          if (offset + 2 >= rendered.pixels.length) continue;
          total++;
          // The page background is white; anything meaningfully darker is ink.
          if (rendered.pixels[offset] < 200 && rendered.pixels[offset + 1] < 200) ink++;
        }
      }
      return total === 0 ? 0 : ink / total;
    };

    const boxInk = inkFraction(
      box.x * scale,
      box.y * scale,
      (box.x + box.width) * scale,
      (box.y + box.height) * scale
    );
    expect(boxInk, 'the reported box for the marker must contain dark glyphs').toBeGreaterThan(0.1);

    // The mirrored band: same x range, the same height, measured up from the
    // bottom of the page instead of down from the top.
    const bandHeight = box.height * scale;
    const mirroredTop = rendered.height - (box.y * scale + bandHeight);
    const mirroredInk = inkFraction(box.x * scale, mirroredTop, (box.x + box.width) * scale, mirroredTop + bandHeight);
    expect(
      boxInk,
      `the marker box must carry more ink (${boxInk.toFixed(3)}) than its vertical mirror (${mirroredInk.toFixed(3)})`
    ).toBeGreaterThan(mirroredInk * 3 + 0.05);
  });

  it('exposes one glyph per codepoint, with line breaks marked', async () => {
    const glyphs = await engine.getPageGlyphs(BODY_PAGE);
    expect(glyphs.glyphs.length).toBeGreaterThan(0);

    let lineBreaks = 0;
    let codepoints = 0;
    let withBox = 0;
    for (const glyph of glyphs.glyphs) {
      if (glyph.lineBreak) {
        lineBreaks++;
        continue;
      }
      codepoints++;
      expect(glyph.x, 'a non-break glyph must carry a box').toBeTypeOf('number');
      expect(glyph.y).toBeTypeOf('number');
      expect(glyph.width).toBeGreaterThanOrEqual(0);
      // Height is legitimately 0 for a space: MuPDF reports space glyphs with no
      // vertical extent.
      expect(glyph.height).toBeGreaterThanOrEqual(0);
      if ((glyph.height ?? 0) > 0) withBox++;
    }
    expect(lineBreaks, 'the page text contains newlines, so breaks must be marked').toBeGreaterThan(0);
    expect(withBox).toBeGreaterThan(100);
    // One entry per codepoint, the '\n' separators included -- this is the
    // invariant light-pdf asserts on, and selection/search depend on it.
    expect(codepoints + lineBreaks).toBe(glyphs.text.length);
  });

  it('returns a text selection with rects and the selected string', async () => {
    const glyphs = await engine.getPageGlyphs(BODY_PAGE);
    const firstGlyph = glyphs.glyphs.find((glyph) => !glyph.lineBreak);
    expect(firstGlyph).toBeDefined();

    const selection = await engine.select({
      page: BODY_PAGE,
      mode: 'word',
      x: (firstGlyph!.x ?? 0) + (firstGlyph!.width ?? 0) / 2,
      y: (firstGlyph!.y ?? 0) + (firstGlyph!.height ?? 0) / 2
    });

    expect(selection.ok).toBe(true);
    expect(selection.text.length).toBeGreaterThan(0);
    expect(selection.rects.length).toBeGreaterThan(0);
    expect(selection.endGlyph).toBeGreaterThanOrEqual(selection.startGlyph);
    for (const rect of selection.rects) {
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
    }
  });
});

describe('search', () => {
  it('finds a known word and returns plausible rectangles', async () => {
    const result = await engine.search({ query: MARKER.zebrafish, maxResults: 50 });

    expect(result.ok).toBe(true);
    expect(result.matches.length).toBeGreaterThanOrEqual(1);

    // The standalone marker is on the last page. (The first body page contains
    // the longer ZEBRAFISHZED, so a substring search legitimately finds both.)
    const match = result.matches.find((m) => m.page === LAST_PAGE);
    expect(match, 'the standalone marker must be found on the last page').toBeDefined();
    expect(match!.text.toUpperCase()).toContain(MARKER.zebrafish);
    expect(match!.rects.length).toBeGreaterThanOrEqual(1);

    const geometry = engine.getPageGeometry(match!.page)!;
    for (const rect of match!.rects) {
      expect(rect.width).toBeGreaterThan(1);
      expect(rect.height).toBeGreaterThan(1);
      expect(rect.height).toBeLessThan(60);
      expect(rect.x).toBeGreaterThanOrEqual(-1);
      expect(rect.x + rect.width).toBeLessThanOrEqual(geometry.width + 1);
      expect(rect.y).toBeGreaterThanOrEqual(-1);
      expect(rect.y + rect.height).toBeLessThanOrEqual(geometry.height + 1);
    }
  });

  it('is case-insensitive by default and case-sensitive on request', async () => {
    const insensitive = await engine.search({ query: 'zebrafish', maxResults: 20 });
    expect(insensitive.matches.length).toBeGreaterThanOrEqual(1);

    const sensitiveWrongCase = await engine.search({ query: 'zebrafish', matchCase: true, maxResults: 20 });
    expect(sensitiveWrongCase.matches).toHaveLength(0);

    const sensitiveRightCase = await engine.search({ query: MARKER.zebrafish, matchCase: true, maxResults: 20 });
    expect(sensitiveRightCase.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('honours whole-word matching', async () => {
    // The fixture's first body page contains ZEBRAQUAGGA, the only text there
    // holding those five letters; the last page holds a standalone ZEBRAFISH. So
    // "zebra" as a substring matches both, while as a whole word it matches
    // neither, and the full words match either way.
    const substring = await engine.search({ query: 'zebra', maxResults: 20 });
    expect(substring.matches.length).toBeGreaterThanOrEqual(2);
    expect(substring.matches.some((m) => m.page === BODY_PAGE)).toBe(true);
    expect(substring.matches.some((m) => m.page === LAST_PAGE)).toBe(true);

    const wholeWordPrefix = await engine.search({ query: 'zebra', wholeWord: true, maxResults: 20 });
    expect(wholeWordPrefix.matches, 'a whole-word search must not match a prefix').toHaveLength(0);

    // The complete words do match as whole words, which keeps the assertion above
    // from being vacuous.
    const fullToken = await engine.search({ query: MARKER.prefixOnly, wholeWord: true, maxResults: 20 });
    expect(fullToken.matches.length).toBeGreaterThanOrEqual(1);
    for (const match of fullToken.matches) {
      expect(match.page).toBe(BODY_PAGE);
      expect(match.text.toUpperCase()).toBe(MARKER.prefixOnly);
    }

    const standalone = await engine.search({ query: MARKER.zebrafish, wholeWord: true, maxResults: 20 });
    expect(standalone.matches.length).toBeGreaterThanOrEqual(1);
    for (const match of standalone.matches) {
      expect(match.page).toBe(LAST_PAGE);
      expect(match.text.toUpperCase()).toBe(MARKER.zebrafish);
    }

    // A word that occurs twice as a real word matches both times.
    const twice = await engine.search({ query: MARKER.marmot, wholeWord: true, maxResults: 20 });
    expect(twice.matches.length).toBeGreaterThanOrEqual(2);
    for (const match of twice.matches) {
      expect(match.page).toBe(BODY_PAGE);
    }
  });

  it('searches a single page on request', async () => {
    // AARDVARK is on the first body page (index 1) and nowhere else.
    const onTitlePage = await engine.search({ query: MARKER.aardvark, page: 0, maxResults: 20 });
    expect(onTitlePage.matches).toHaveLength(0);

    const onBodyPage = await engine.search({ query: MARKER.aardvark, page: BODY_PAGE, maxResults: 20 });
    expect(onBodyPage.matches.length).toBeGreaterThanOrEqual(1);
    for (const match of onBodyPage.matches) {
      expect(match.page).toBe(BODY_PAGE);
    }

    // The same query scoped to the last page finds nothing.
    const onLastPage = await engine.search({ query: MARKER.aardvark, page: LAST_PAGE, maxResults: 20 });
    expect(onLastPage.matches).toHaveLength(0);
  });

  it('reports truncation when the result cap is reached', async () => {
    const result = await engine.search({ query: 'the', maxResults: 3 });
    expect(result.matches.length).toBeLessThanOrEqual(3);
    if (result.matches.length === 3) {
      expect(result.truncated).toBe(true);
    }
  });

  it('returns no matches for a word that is not in the document', async () => {
    const result = await engine.search({ query: 'XYZZYNOTPRESENT', maxResults: 20 });
    expect(result.matches).toHaveLength(0);
  });
});

describe('links and outline', () => {
  it('returns a real nested outline whose entries point at real pages', async () => {
    const outline = await engine.getOutline();
    expect(outline.ok).toBe(true);
    // hyperref emits /Outlines bookmarks for \section and \subsection, so this is
    // a genuine PDF outline and not a synthesised one.
    expect(outline.outline.length).toBeGreaterThanOrEqual(3);

    const walk = (
      items: typeof outline.outline,
      visit: (item: (typeof outline.outline)[number]) => void
    ): void => {
      for (const item of items) {
        visit(item);
        walk(item.children, visit);
      }
    };

    const titles: string[] = [];
    walk(outline.outline, (item) => titles.push(item.title));
    const joined = titles.join(' | ');
    expect(joined).toContain('Alpha Section');
    expect(joined).toContain('Beta Section');
    expect(joined).toContain('Alpha Subsection');

    let withPages = 0;
    walk(outline.outline, (item) => {
      if (item.page !== null) {
        withPages++;
        expect(item.page).toBeGreaterThanOrEqual(1);
        expect(item.page).toBeLessThanOrEqual(pageCount);
      }
    });
    expect(withPages).toBeGreaterThanOrEqual(3);

    // The fixture nests a subsection under a section. This is what shows the
    // outline is a tree rather than a flat list.
    const alpha = outline.outline.find((item) => item.title.includes('Alpha Section'));
    expect(alpha).toBeDefined();
    expect(alpha!.children.length).toBeGreaterThanOrEqual(1);
    expect(alpha!.children.some((child) => child.title.includes('Alpha Subsection'))).toBe(true);

    // Sections land on the pages the fixture puts them on.
    const beta = outline.outline.find((item) => item.title.includes('Beta Section'));
    expect(beta?.page).toBe(LAST_PAGE + 1);
  });

  it('returns a link array for every page (possibly empty)', async () => {
    for (let page = 0; page < pageCount; page++) {
      const links = await engine.getLinks(page);
      expect(links.ok).toBe(true);
      expect(links.page).toBe(page);
      expect(Array.isArray(links.links)).toBe(true);
      for (const link of links.links) {
        expect(link.rect.width).toBeGreaterThan(0);
        expect(link.rect.height).toBeGreaterThan(0);
        if (link.page !== null) {
          expect(link.page).toBeGreaterThanOrEqual(1);
          expect(link.page).toBeLessThanOrEqual(pageCount);
        }
      }
    }
  });

  it('resolves internal cross-references and passes external URLs through', async () => {
    // The fixture cross-references Beta Section from the Alpha Subsection page,
    // and links to https://example.com/eukolia.
    const links = (await engine.getLinks(BODY_PAGE)).links;
    expect(links.length).toBeGreaterThanOrEqual(1);

    const internal = links.filter((link) => link.page !== null);
    expect(internal.length, 'the \\ref must produce a resolvable internal link').toBeGreaterThanOrEqual(1);
    for (const link of internal) {
      expect(link.page).toBe(LAST_PAGE + 1);
      // Link boxes are in page space, so they must lie on the page.
      const geometry = engine.getPageGeometry(BODY_PAGE)!;
      expect(link.rect.x).toBeGreaterThanOrEqual(-1);
      expect(link.rect.x + link.rect.width).toBeLessThanOrEqual(geometry.width + 1);
      expect(link.rect.y + link.rect.height).toBeLessThanOrEqual(geometry.height + 1);
    }

    const external = links.filter((link) => link.uri?.startsWith('http'));
    expect(external.length, 'the \\href must produce an external link').toBeGreaterThanOrEqual(1);
    expect(external[0].page).toBeNull();
  });
});

describe('SyncTeX', () => {
  it('parses the record grammar of both directions', () => {
    const view = parseSynctexView(
      [
        'This is SyncTeX command line utility, version 1.5',
        'SyncTeX result begin',
        'Output:fixture.pdf',
        'Page:3',
        'x:114.42',
        'y:258.21',
        'h:71.99',
        'v:260.33',
        'W:120.5',
        'H:7.57',
        'before:',
        'offset:-1',
        'middle:',
        'after:',
        'SyncTeX result end'
      ].join('\n')
    );
    expect(view).toHaveLength(1);
    expect(view[0].page).toBe(3);
    expect(view[0].x).toBeCloseTo(114.42, 2);
    expect(view[0].w).toBeCloseTo(120.5, 2);
    expect(view[0].hh).toBeCloseTo(7.57, 2);

    const edit = parseSynctexEdit(
      [
        'This is SyncTeX command line utility, version 1.5',
        'SyncTeX result begin',
        'Output:fixture.pdf',
        'Input:D:/x/fixture.tex',
        'Line:64',
        'Column:-1',
        'Offset:0',
        'Context:',
        'SyncTeX result end'
      ].join('\n')
    );
    expect(edit).not.toBeNull();
    expect(edit!.line).toBe(64);
    expect(edit!.column).toBe(-1);
    expect(edit!.input).toBe('D:/x/fixture.tex');
  });

  it('returns null when the client produced no result block', () => {
    expect(parseSynctexView('SyncTeX Warning: No tag for ./fixture.tex')).toHaveLength(0);
    expect(parseSynctexEdit('SyncTeX Warning: No tag for ./fixture.tex')).toBeNull();
  });

  it('round-trips forward and inverse search against a real PDF', async () => {
    const synctex = new SyncTexEngine();

    const forward = await synctex.sourceToDoc({
      synctexPath: FIXTURE_PDF,
      file: FIXTURE_TEX,
      line: MARKER_LINE.zebrafish
    });
    expect(forward, 'forward search must find the marker line').not.toBeNull();
    expect(forward!.page).toBeGreaterThanOrEqual(1);
    expect(forward!.page).toBeLessThanOrEqual(pageCount);
    expect(forward!.x).toBeGreaterThan(0);
    expect(forward!.y).toBeGreaterThan(0);
    expect(typeof forward!.raw).toBe('string');

    const inverse = await synctex.docToSource({
      synctexPath: FIXTURE_PDF,
      page: forward!.page,
      x: forward!.x,
      y: forward!.y
    });
    expect(inverse, 'inverse search at the forward result must resolve').not.toBeNull();
    expect(path.basename(inverse!.file)).toBe('fixture.tex');
    expect(path.isAbsolute(inverse!.file)).toBe(true);
    expect(fs.existsSync(inverse!.file)).toBe(true);
    // The round trip must land on the same source line, or very close to it.
    expect(Math.abs(inverse!.line - MARKER_LINE.zebrafish)).toBeLessThanOrEqual(2);
    expect(inverse!.raw).toContain('SyncTeX result');

    // A second marker proves the mapping is not just "line 1 of the file".
    const beta = await synctex.sourceToDoc({
      synctexPath: FIXTURE_PDF,
      file: FIXTURE_TEX,
      line: MARKER_LINE.betaSection
    });
    expect(beta).not.toBeNull();
    expect(beta!.page).toBeGreaterThanOrEqual(1);
    expect(beta!.page).toBeLessThanOrEqual(pageCount);
  });

  it('falls back to the .synctex.gz index when the command-line client is disabled', async () => {
    const synctex = new SyncTexEngine();
    // Force the fallback path by pointing the binary at a path that does not exist.
    synctex.configure(path.join(FIXTURE_DIR, 'no-such-synctex.exe'));
    expect(synctex.hasCommandLineClient()).toBe(false);

    const forward = await synctex.sourceToDoc({
      synctexPath: FIXTURE_SYNCTEX,
      file: FIXTURE_TEX,
      line: MARKER_LINE.betaSection
    });
    expect(forward).not.toBeNull();
    expect(forward!.page).toBeGreaterThanOrEqual(1);

    const inverse = await synctex.docToSource({
      synctexPath: FIXTURE_SYNCTEX,
      page: forward!.page,
      x: forward!.x,
      y: forward!.y
    });
    expect(inverse).not.toBeNull();
    expect(path.basename(inverse!.file)).toBe('fixture.tex');
  });

  it('returns null for a document with no SyncTeX data', async () => {
    const synctex = new SyncTexEngine();
    const forward = await synctex.sourceToDoc({
      synctexPath: path.join(FIXTURE_DIR, 'definitely-missing.pdf'),
      file: path.join(FIXTURE_DIR, 'definitely-missing.tex'),
      line: 1
    });
    expect(forward).toBeNull();
  });
});

describe('document lifecycle', () => {
  it('retains immutable old pages through a truncated rewrite and a failed reload', async () => {
    const directory = fs.mkdtempSync(path.join(REPO_ROOT, '.scratch', 'pdf-swap-'));
    const file = path.join(directory, 'live.pdf');
    const bytes = fs.readFileSync(FIXTURE_PDF);
    fs.writeFileSync(file, bytes);
    const preview = new NativePdfEngine({ workerPath, autoBuild: false, maxRestarts: 0 });
    try {
      const original = await preview.openDocument(file);
      // No page has been decoded in this engine yet. Restoring pointers to an
      // open file handle cannot make this work after truncation; a snapshot can.
      fs.writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 3)));
      await expect(preview.reloadDocument()).rejects.toThrow();
      expect(preview.getOpenDocument()?.docId).toBe(original.docId);
      expect((await preview.getPageText(LAST_PAGE)).text).toContain(MARKER.zebrafish);
      const raster = await preview.renderPage(90001, { page: BODY_PAGE, scale: 1, format: 'rgba', allowCache: false });
      expect(whiteFraction(raster.pixels, raster.channels)).toBeLessThan(1);
      fs.writeFileSync(file, bytes);
      const identical = await preview.openDocument(file, undefined, true);
      expect(identical.open.unchanged).toBe(true);
      expect(identical.docId).toBe(original.docId);
      // Repeated successful commits exercise the old page/list/document drop
      // order after those resources have actually been used.
      for (let i = 0; i < 4; i++) {
        fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from(`\n% revision ${i}\n`)]));
        const next = await preview.openDocument(file, undefined, true);
        expect(next.docId).not.toBe(original.docId);
        expect((await preview.getPageText(BODY_PAGE)).text).toContain(MARKER.aardvark);
        await preview.renderPage(90002 + i, { page: BODY_PAGE, scale: 1, format: 'rgba', allowCache: false });
      }
    } finally {
      await preview.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it('reports cache statistics and then closes the document', async () => {
    const stats = await engine.getStats();
    expect(stats.ok).toBe(true);
    expect(stats.servedFromCache).toBeGreaterThan(0);

    await expect(engine.closeDocument()).resolves.toBe(true);
    // After closing, page work must be refused rather than silently returning
    // data for a stale document.
    await expect(engine.getPageText(0)).rejects.toThrow(/no document/i);
  });
});
