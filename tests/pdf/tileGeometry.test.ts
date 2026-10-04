/**
 * Tile geometry: the grid, the row convention, and the cover of a page.
 *
 * This is the module everything else trusts, so the tests here are about the
 * invariants rather than about examples. `PDFVIEWER.md` §6 names them directly:
 *
 *   * "Adjacent tiles must share exact edges at all zooms/DPRs" — asserted here as
 *     *the tiles of a page tile it exactly*: for every zoom, DPR and page size in
 *     the sweep, the sum of the tiles' areas equals the page's area and no two tiles
 *     overlap. That is a stronger statement than "the seams look fine", and it is
 *     the one that catches the rounding bug this code was written to avoid (rounding
 *     a tile *width* and then multiplying drifts by up to `count - 1` pixels).
 *   * "Preserve the reference's lower-origin tile-row convention or explicitly
 *     translate it at one boundary; browser CSS is top-down" — the row flip is
 *     asserted against the reference's own formula, `GetTileRect` in
 *     `render_cache.cpp`, transcribed into the test. Row 0 must be the bottom row.
 *   * "Test nonzero CropBox origins, intrinsic PDF rotation, user rotation, mixed
 *     sizes, and fractional DPR" — the sweep covers fractional DPR and mixed page
 *     sizes; nonzero CropBox origins and intrinsic rotation are handled upstream by
 *     the engine (it reports a page box anchored at 0,0 that already carries
 *     `/Rotate`, see `mupdf_engine.cpp` and `pageRotation.test.ts`), and the
 *     "user rotation is not a raster concern" rule is asserted separately.
 *   * "Use authoritative returned rectangles/dimensions rather than assuming
 *     requested floating-point clips round identically in MuPDF" — that is the
 *     worker agreement test, which runs the real worker.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_TILE_RES,
  TILE_TARGET_PX,
  WHOLE_PAGE_MAX_DEVICE_AREA,
  assertRenderRotation,
  deviceRectToPageClip,
  gridSize,
  pageBoxFromSheet,
  pageDeviceBox,
  rawTileRes,
  shouldTilePage,
  tileDeviceRect,
  tileResForDeviceBox,
  tileSpecFor,
  visibleTiles,
  type DeviceRect
} from '../../src/renderer/pdf/rendering/PdfTileGeometry';
import { resolveWorkerPath } from '../../src/main/pdf/nativePdfEngine';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** `FrameType.Ready`: the worker's startup handshake, which is not a reply. */
const FRAME_READY = 131;

/** A page's device box for a given page size in points and a device scale. */
function box(widthPt: number, heightPt: number, scale: number): DeviceRect {
  return pageDeviceBox({ width: widthPt, height: heightPt }, scale);
}

/** The sweep's scales: reading zooms, and both fit modes' neighbourhoods. */

/** The pages this sweep covers: A4/Letter/A0-ish and a wide and a tall extreme. */
const PAGE_SIZES: { width: number; height: number }[] = [
  { width: 595, height: 842 }, // A4
  { width: 612, height: 792 }, // US Letter
  { width: 400, height: 400 }, // square, and a size that divides badly
  { width: 2384, height: 3370 }, // A0
  { width: 1600, height: 400 }, // wide
  { width: 300, height: 2400 } // tall
];

const SCALES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8, 16];

/**
 * A sweep is a property test, so it collects failures and reports them together.
 *
 * `PDFVIEWER.md` §6 asks for "nonzero CropBox origins, intrinsic PDF rotation, user
 * rotation, mixed sizes, and fractional DPR" to be tested, which is a cross product
 * rather than an example. Asserting each of the tens of thousands of individual facts
 * through `expect` costs far more than the arithmetic it is checking — the first version
 * of this test spent its whole 30 s timeout in vitest's matcher — so each property
 * accumulates the first few counterexamples and the test asserts once.
 */
class Counterexamples {
  private readonly lines: string[] = [];

  check(ok: boolean, describe: () => string): void {
    if (ok) return;
    if (this.lines.length < 8) this.lines.push(describe());
  }

  assertEmpty(what: string): void {
    expect(this.lines.length === 0 ? [] : this.lines, `${what}: ${this.lines.length} counterexample(s)`).toEqual([]);
  }
}

describe('tile grid geometry', () => {
  it('tiles a page exactly at every size and zoom', () => {
    const failures = new Counterexamples();
    for (const page of PAGE_SIZES) {
      for (const scale of SCALES) {
        const device = pageDeviceBox(page, scale);
        if (device.width <= 0 || device.height <= 0) {
          failures.check(false, () => `page ${JSON.stringify(page)} at scale ${scale} has an empty device box`);
          continue;
        }
        const where = () => `page ${page.width}x${page.height} pt at scale ${scale}`;
        const res = tileResForDeviceBox(device.width, device.height, false, TILE_TARGET_PX);
        const count = gridSize(res);
        const tiles: DeviceRect[] = [];
        for (let row = 0; row < count; row++) {
          for (let col = 0; col < count; col++) {
            tiles.push(tileDeviceRect(device, { res, row, col }));
          }
        }

        // 1. Every tile has integer device edges.
        for (const tile of tiles) {
          failures.check(
            Number.isInteger(tile.x) &&
              Number.isInteger(tile.y) &&
              Number.isInteger(tile.width) &&
              Number.isInteger(tile.height),
            () => `${where()}: tile ${JSON.stringify(tile)} has fractional edges`
          );
        }

        // 2. The areas sum to the page's area. Because no two tiles overlap (3) and
        //    every tile lies inside the box (4), an exact area sum *is* a cover: a gap
        //    or a double-cover would have to change it.
        const totalArea = tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0);
        failures.check(
          totalArea === device.width * device.height,
          () => `${where()}: tiles cover ${totalArea} device px, page is ${device.width * device.height}`
        );

        // 3. No two tiles overlap. Rows are compared against the single row below them
        //    rather than against every other tile: a quadratic check over 36 tiles x 6
        //    pages x 11 zooms is millions of comparisons and tells you no more than the
        //    adjacent-row check does.
        const byRow = new Map<number, DeviceRect[]>();
        for (const tile of tiles) {
          const list = byRow.get(tile.y);
          if (list) list.push(tile);
          else byRow.set(tile.y, [tile]);
        }
        const rowKeys = [...byRow.keys()].sort((a, b) => a - b);
        for (let r = 0; r < rowKeys.length; r++) {
          const sorted = [...(byRow.get(rowKeys[r]) as DeviceRect[])].sort((a, b) => a.x - b.x);
          for (let i = 1; i < sorted.length; i++) {
            // Within a row, each tile starts exactly where the previous one ended.
            failures.check(
              sorted[i].x === sorted[i - 1].x + sorted[i - 1].width,
              () => `${where()}: row ${rowKeys[r]} has a gap or overlap at column ${i}`
            );
          }
          if (r + 1 >= rowKeys.length) continue;
          for (const other of byRow.get(rowKeys[r + 1]) as DeviceRect[]) {
            for (const tile of sorted) {
              const overlapX = Math.min(tile.x + tile.width, other.x + other.width) - Math.max(tile.x, other.x);
              const overlapY = Math.min(tile.y + tile.height, other.y + other.height) - Math.max(tile.y, other.y);
              failures.check(
                overlapX <= 0 || overlapY <= 0,
                () => `${where()}: tiles ${JSON.stringify(tile)} and ${JSON.stringify(other)} intersect`
              );
            }
          }
        }

        // 4. Every tile lies inside the page box.
        for (const tile of tiles) {
          failures.check(
            tile.x >= 0 &&
              tile.y >= 0 &&
              tile.x + tile.width <= device.width &&
              tile.y + tile.height <= device.height,
            () => `${where()}: tile ${JSON.stringify(tile)} leaves the ${device.width}x${device.height} box`
          );
        }
      }
    }
    failures.assertEmpty('tile covers');
  });

  /**
   * The grid is a *device*-pixel grid, so a fractional DPR changes nothing about it.
   *
   * That is the claim that makes a display change cheap: the tiles already rasterised
   * are still the right pixels, and only the CSS boxes they are displayed in move. The
   * test is that the two DPRs produce byte-identical grids for the same device box,
   * which is what lets `PdfSurfacePresenter.setDevicePixelRatio` re-measure instead of
   * re-rasterise.
   */
  it('produces the same grid at every device pixel ratio', () => {
    const failures = new Counterexamples();
    for (const page of PAGE_SIZES) {
      for (const scale of SCALES) {
        // The device box is the same at every DPR — the DPR decides how many CSS pixels
        // it is displayed across — so any difference here is a DPR leaking into geometry.
        const device = pageDeviceBox(page, scale);
        if (device.width <= 0) continue;
        const res = tileResForDeviceBox(device.width, device.height, false, TILE_TARGET_PX);
        const reference = JSON.stringify(device) + '|' + String(res);
        for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
          // The CSS box is what changes, and it is what the presenter divides by.
          const cssWidth = device.width / dpr;
          const cssHeight = device.height / dpr;
          const recovered = pageDeviceBox(
            { width: cssWidth * dpr, height: cssHeight * dpr },
            1
          );
          failures.check(
            JSON.stringify(recovered) === JSON.stringify(device) && String(res) === reference.split('|')[1],
            () => `page ${page.width}x${page.height} at scale ${scale} and DPR ${dpr} changed the device grid`
          );
        }
      }
    }
    failures.assertEmpty('DPR-invariant grid');
  });

  it('covers a visible region with the tiles that intersect it', () => {
    const page = box(612, 792, 4);
    const res = tileResForDeviceBox(page.width, page.height, false, 512);
    expect(gridSize(res)).toBeGreaterThan(1);

    // A window that deliberately straddles tile boundaries in both axes.
    const visible: DeviceRect = { x: 200, y: 300, width: 900, height: 1100 };
    const picked = visibleTiles(page, res, visible);

    // Every point of the visible window is inside at least one picked tile…
    for (let y = visible.y; y < visible.y + visible.height; y += 17) {
      for (let x = visible.x; x < visible.x + visible.width; x += 17) {
        const inside = picked.some(
          (tile) => x >= tile.device.x && x < tile.device.x + tile.device.width && y >= tile.device.y && y < tile.device.y + tile.device.height
        );
        expect(inside).toBe(true);
      }
    }
    // …and no tile that does *not* intersect the window was picked.
    for (const tile of picked) {
      const overlapX = Math.min(tile.device.x + tile.device.width, visible.x + visible.width) - Math.max(tile.device.x, visible.x);
      const overlapY = Math.min(tile.device.y + tile.device.height, visible.y + visible.height) - Math.max(tile.device.y, visible.y);
      expect(overlapX).toBeGreaterThan(0);
      expect(overlapY).toBeGreaterThan(0);
    }
  });

  it('orders visible tiles nearest the window centre first', () => {
    const page = box(612, 792, 4);
    const res = tileResForDeviceBox(page.width, page.height, false, 400);
    const visible: DeviceRect = { x: 0, y: 0, width: 400, height: 400 };
    const picked = visibleTiles(page, res, visible);
    const centreX = visible.x + visible.width / 2;
    const centreY = visible.y + visible.height / 2;
    const distances = picked.map((tile) =>
      Math.hypot(tile.device.x + tile.device.width / 2 - centreX, tile.device.y + tile.device.height / 2 - centreY)
    );
    for (let i = 1; i < distances.length; i++) expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
  });
});

describe('the reference row convention', () => {
  /**
   * light-pdf's `GetTileRect` (via `render_cache.cpp`), transcribed.
   *
   * `rect.y = pageRect.y + (2^res - row - 1) * rect.dy`, so tile row 0 is the row at
   * the **top of the rectangle's coordinate range** — and because page space descends
   * in y, that is the *lowest* y, i.e. the bottom of the page on screen. This test is
   * the reason that sentence is in the module doc: getting it backwards produces a
   * page assembled from vertically mirrored bands, which looks like a rendering bug
   * rather than an addressing one.
   */
  function referenceTileRect(
    page: { width: number; height: number },
    res: number,
    row: number,
    col: number
  ): { x: number; y: number; width: number; height: number } {
    const n = 1 << res;
    const dx = page.width / n;
    const dy = page.height / n;
    return { x: col * dx, y: (n - row - 1) * dy, width: dx, height: dy };
  }

  it('matches GetTileRect row for row when the page divides evenly', () => {
    // 512x512 at 1x, res 2: divides into 4x4 of 128 exactly, so the reference's
    // multiply-the-cell and this module's round-the-edge agree bit for bit.
    const page = { width: 512, height: 512 };
    const device = pageDeviceBox(page, 1);
    const res = 2;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const mine = tileDeviceRect(device, { res, row, col });
        const theirs = referenceTileRect(page, res, row, col);
        expect({ x: mine.x, y: mine.y, width: mine.width, height: mine.height }).toEqual(theirs);
      }
    }
  });

  it('puts row 0 at the bottom of the device box', () => {
    const device = pageDeviceBox({ width: 400, height: 800 }, 1);
    const bottom = tileDeviceRect(device, { res: 1, row: 0, col: 0 });
    const top = tileDeviceRect(device, { res: 1, row: 1, col: 0 });
    expect(bottom.y).toBe(400);
    expect(top.y).toBe(0);
    expect(bottom.y).toBeGreaterThan(top.y);
  });

  it('clamps an out-of-range address instead of reading another tile', () => {
    const device = pageDeviceBox({ width: 400, height: 800 }, 1);
    const clamped = tileDeviceRect(device, { res: 1, row: 9, col: -3 });
    const valid = tileDeviceRect(device, { res: 1, row: 1, col: 0 });
    expect(clamped).toEqual(valid);
  });
});

describe('page clips', () => {
  it('round-trips a device box through page space', () => {
    const scale = 3.5;
    const device = pageDeviceBox({ width: 595, height: 842 }, scale);
    const spec = tileSpecFor(device, { res: 1, row: 1, col: 0 }, scale);
    expect(spec.clip.x).toBeCloseTo(spec.device.x / scale, 6);
    expect(spec.clip.y).toBeCloseTo(spec.device.y / scale, 6);
    expect(spec.clip.width).toBeCloseTo(spec.device.width / scale, 6);
    expect(spec.clip.height).toBeCloseTo(spec.device.height / scale, 6);
  });

  it('keeps every clip inside the page box', () => {
    const scale = 2;
    const page = { width: 595, height: 842 };
    const device = pageDeviceBox(page, scale);
    const res = tileResForDeviceBox(device.width, device.height, false, 512);
    const count = gridSize(res);
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        const spec = tileSpecFor(device, { res, row, col }, scale);
        expect(spec.clip.x).toBeGreaterThanOrEqual(0);
        expect(spec.clip.y).toBeGreaterThanOrEqual(0);
        expect(spec.clip.x + spec.clip.width).toBeLessThanOrEqual(page.width + 1e-9);
        expect(spec.clip.y + spec.clip.height).toBeLessThanOrEqual(page.height + 1e-9);
      }
    }
  });

  it('recovers the page box from the layout sheet size and scale', () => {
    for (const page of PAGE_SIZES) {
      for (const scale of [0.5, 1, 1.25, 3]) {
        const sheet = { width: page.width * scale, height: page.height * scale };
        const recovered = pageBoxFromSheet(sheet, scale);
        expect(recovered.width).toBeCloseTo(page.width, 6);
        expect(recovered.height).toBeCloseTo(page.height, 6);
      }
    }
  });
});

describe('render rotation', () => {
  it('accepts 0 and its full turns', () => {
    expect(() => assertRenderRotation(0)).not.toThrow();
    expect(() => assertRenderRotation(360)).not.toThrow();
    expect(() => assertRenderRotation(-360)).not.toThrow();
  });

  it('refuses a raster rotation, which would apply a quarter turn twice', () => {
    for (const rotate of [90, 180, 270, -90]) {
      expect(() => assertRenderRotation(rotate)).toThrow(/must not rotate the raster/);
    }
  });
});

describe('the whole-page threshold', () => {
  it('keeps a small page whole and tiles a large one', () => {
    const small = pageDeviceBox({ width: 300, height: 400 }, 1); // 120k device px
    const large = pageDeviceBox({ width: 1400, height: 1812 }, 2); // 10.1M device px
    expect(small.width * small.height).toBeLessThanOrEqual(WHOLE_PAGE_MAX_DEVICE_AREA);
    expect(shouldTilePage(small, tileResForDeviceBox(small.width, small.height))).toBe(false);
    expect(shouldTilePage(large, tileResForDeviceBox(large.width, large.height))).toBe(true);
  });

  it('never tiles when the grid is a single cell', () => {
    const device: DeviceRect = { x: 0, y: 0, width: 4000, height: 4000 };
    // res 0 is one cell, so a tile would be the whole page with a round trip added.
    expect(shouldTilePage(device, 0)).toBe(false);
    expect(shouldTilePage(device, 1)).toBe(true);
  });
});

describe('tile resolution', () => {
  it('grows with the page and with the zoom', () => {
    const at1 = tileResForDeviceBox(1200, 1600, false, TILE_TARGET_PX);
    const at2 = tileResForDeviceBox(2400, 3200, false, TILE_TARGET_PX);
    const at4 = tileResForDeviceBox(4800, 6400, false, TILE_TARGET_PX);
    expect(at2).toBeGreaterThanOrEqual(at1);
    expect(at4).toBeGreaterThan(at2);
  });

  it('uses larger tiles in the fit modes', () => {
    // The reference halves the geometric mean factor for fit-page/fit-width, so the
    // resolution is one lower (or equal, never higher).
    const plain = rawTileRes(3000, 4000, false, TILE_TARGET_PX);
    const fit = rawTileRes(3000, 4000, true, TILE_TARGET_PX);
    expect(fit).toBeLessThanOrEqual(plain);
  });

  it('clamps to the largest representable resolution', () => {
    // A page so large that the formula wants more bits than the address fields hold.
    expect(tileResForDeviceBox(200 * 2 ** 20, 200 * 2 ** 20, false, 200)).toBe(MAX_TILE_RES);
    expect(gridSize(MAX_TILE_RES)).toBe(2 ** MAX_TILE_RES);
  });

  it('is 0 for a degenerate box', () => {
    expect(tileResForDeviceBox(0, 100)).toBe(0);
    expect(tileResForDeviceBox(100, 0)).toBe(0);
    expect(tileResForDeviceBox(Number.NaN, 100)).toBe(0);
    expect(pageDeviceBox({ width: 0, height: 0 }, 1)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

/**
 * The renderer's grid and the worker's grid have to be the same grid.
 *
 * `PDFVIEWER.md` §6 makes the risk explicit — the tile address is a contract between
 * two implementations of one formula — and the mitigation is this test: the worker is
 * asked for its own tile list for a page and scale, and the resolutions must agree.
 * That is also the only place `RenderCache::TileResFor`'s port is checked against its
 * original, since `tests/pdf` otherwise never calls the `tiles` route.
 *
 * The test is skipped, not failed, when there is no built worker: `resources/native`
 * is a build output, and a checkout that has not run `npm run build:native` should not
 * report a geometry failure.
 */
describe('agreement with the native worker grid', () => {
  const workerPath = resolveWorkerPath();
  const available = Boolean(workerPath && fs.existsSync(workerPath));

  beforeAll(() => {
    if (!available) {
      console.warn('[tileGeometry] no native worker built; skipping the grid agreement test');
    }
  });

  it.skipIf(!available)('chooses the same resolution as the worker, for real page boxes and scales', async () => {
    const { spawn } = await import('node:child_process');
    const { FrameType, FRAME_HEADER_BYTES } = await import('../../src/main/pdf/workerProtocol');

    const pdfPath = path.join(__dirname, 'fixtures', 'fixture.pdf');
    expect(fs.existsSync(pdfPath)).toBe(true);

    const child = spawn(workerPath as string, [], { cwd: path.dirname(workerPath as string), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

    child.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < FRAME_HEADER_BYTES) return;
        const payloadLen = buffer.readUInt32LE(0);
        if (buffer.length < FRAME_HEADER_BYTES + payloadLen) return;
        const payload = buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + payloadLen);
        buffer = buffer.subarray(FRAME_HEADER_BYTES + payloadLen);
        const type = payload[0];
        const requestId = payload.readUInt32LE(1);
        const body = payload.subarray(5);
        if (type === FRAME_READY || type === FrameType.Log || type === FrameType.Pong) continue;
        const entry = pending.get(requestId);
        if (!entry) continue;
        pending.delete(requestId);
        const json = body.length ? JSON.parse(body.toString('utf8')) : {};
        if (type === FrameType.Error) entry.reject(new Error(json.error ?? 'worker error'));
        else entry.resolve(json);
      }
    });

    const call = (cmd: string, params: Record<string, unknown> = {}): Promise<any> => {
      const requestId = nextId++;
      const body = Buffer.from(JSON.stringify({ cmd, ...params }), 'utf8');
      const frame = Buffer.alloc(FRAME_HEADER_BYTES + 5 + body.length);
      frame.writeUInt32LE(5 + body.length, 0);
      frame[FRAME_HEADER_BYTES] = FrameType.Request;
      frame.writeUInt32LE(requestId, FRAME_HEADER_BYTES + 1);
      body.copy(frame, FRAME_HEADER_BYTES + 5);
      const promise = new Promise<any>((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        setTimeout(() => {
          if (pending.delete(requestId)) reject(new Error(`${cmd} timed out`));
        }, 60_000);
      });
      child.stdin.write(frame);
      return promise;
    };

    try {
      const opened = await call('open', { path: pdfPath });
      expect(opened.pageCount).toBeGreaterThan(0);

      for (const scale of [0.5, 1, 1.25, 2, 4, 8]) {
        const reply = await call('tiles', { page: 0, scale, targetTileSize: TILE_TARGET_PX });
        const widthPt = opened.pages[0].width;
        const heightPt = opened.pages[0].height;
        const device = pageDeviceBox({ width: widthPt, height: heightPt }, scale);
        const mine = tileResForDeviceBox(device.width, device.height, false, TILE_TARGET_PX);
        expect({ scale, res: reply.res }).toEqual({ scale, res: mine });
        expect(reply.tiles.length).toBe(gridSize(mine) ** 2);

        // And the rectangles themselves: the worker reports page-space rects, and
        // they must be the same rectangles this module computed.
        for (const tile of reply.tiles.slice(0, 8)) {
          const mineSpec = tileSpecFor(device, { res: tile.res, row: tile.row, col: tile.col }, scale);
          expect(tile.rect.x).toBeCloseTo(mineSpec.clip.x, 4);
          expect(tile.rect.y).toBeCloseTo(mineSpec.clip.y, 4);
          expect(tile.rect.width).toBeCloseTo(mineSpec.clip.width, 4);
          expect(tile.rect.height).toBeCloseTo(mineSpec.clip.height, 4);
        }
      }
    } finally {
      try {
        const frame = Buffer.alloc(FRAME_HEADER_BYTES + 5);
        frame.writeUInt32LE(5, 0);
        frame[FRAME_HEADER_BYTES] = FrameType.Shutdown;
        child.stdin.write(frame);
      } catch {
        /* already gone */
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      child.kill();
    }
  }, 120_000);
});
