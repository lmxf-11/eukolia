/**
 * Eukolia — canonical PDF tile geometry.
 *
 * ## Why this module exists
 *
 * `PdfViewer` asks the engine for **whole page** bitmaps and uploads them with one
 * `putImageData` per page (`PDFVIEWER.md` §1-2). A page-wide upload at a 144 Hz
 * cadence is larger than a frame, and at high zoom it is both larger than a frame
 * and larger than the reader can see. The replacement is regional: rasterise the
 * visible part of the page, in tiles, and upload them under a time budget.
 *
 * That only works if every consumer agrees on one geometry. A tile that is a pixel
 * off produces a visible seam; a tile whose row convention is flipped upside down
 * relative to the PDF produces a page made of shuffled bands; a tile requested for
 * the wrong device scale is soft. So this module is the single place where
 *
 *   * the **unrotated page box** in PDF points,
 *   * the **render scale** in device pixels per point (`pdfRenderScale`), and
 *   * a **tile address** `(res, row, col)`
 *
 * become rectangles — in both directions — plus the helpers the scheduler needs to
 * iterate what is visible.
 *
 * ## The coordinate contract
 *
 * This is deliberately the same contract the native worker uses, because the two
 * have to agree exactly (`PDFVIEWER.md` §6, "Use one geometry/coordinate contract
 * for raster tiles, hit testing, selection, highlights, links, and SyncTeX"):
 *
 *   * **Page space** is *fitz* page space: 72 dpi, origin at the top-left of the
 *     page box, y **descending** (`mupdf_engine.h` `PageView::mediaBox`). The native
 *     renderer, the text layer, selection, links and SyncTeX all work in it.
 *   * **Device space** is page space scaled uniformly: `devicePx = pagePt * scale`.
 *     One device pixel per PDF point at `scale == 1`.
 *
 * ## The page's own `/Rotate` is already applied; the reader's is not
 *
 * A PDF page may declare `/Rotate 90|180|270`, and the native engine bakes it into
 * the space every coordinate it reports lives in: `slot.mediaBox` is
 * `fz_transform_rect(mbox, pageCtm)`, "the rectangle the *content* occupies, and that
 * is the rotated one", because `fz_run_page` and `fz_new_display_list_from_page`
 * apply the page transform before anything else sees the content
 * (`mupdf_engine.cpp`, and `tests/pdf/pageRotation.test.ts` pins it). So a
 * `/Rotate 90` A4 page spans 792x612 in page space, and its text boxes, link
 * rectangles and selection rectangles are all in that same rotated box.
 *
 * The **reader's** rotation — `PdfViewerProps.rotation` — is a separate thing: it is
 * applied by the viewer as a CSS transform on the page sheet (`sheetTransform`), and
 * it is **not** a raster concern. That is the whole reason this module can exist: a
 * tile rectangle and a text-layer run are both in page space, so they cannot drift
 * apart, and the browser rotates the assembled sheet once.
 *
 * The consequence for callers is one rule, and it is enforced rather than documented:
 * **a tile render is always requested with `rotate: 0`.** Asking the engine to rotate
 * as well would either double-apply the page's `/Rotate` or produce a raster in a
 * space no other coordinate uses, and it would double the render cache's variants
 * (`CacheKey::rotation`) for pixels the compositor could have turned for free.
 * {@link assertRenderRotation} checks it.
 *
 * ## The grid, and why the *worker* decides it
 *
 * A tile address is `(res, row, col)` with `res = 0` meaning "the whole page" and
 * `2^res` cells per axis. Row 0 is the **bottom** row in page space, because y
 * descends and the native `GetTileRect` keeps the reference's convention
 * (`render_cache.cpp`). {@link tileRectDevice} therefore flips the row, and it is
 * the only place that does: "Never apply page rotation twice" has a sibling rule
 * here — never flip the row twice.
 *
 * The resolution for a given page and scale is computed by
 * {@link tileResForDeviceBox}, and **the native cache computes the same number with
 * the same formula** (`RenderCache::TileResFor`, ported from light-pdf's
 * `GetTileRes`). Duplicating a formula across a process boundary is a real risk —
 * a divergence means the renderer asks for addresses the worker's grid does not
 * have, or draws its tiles in the wrong places. Two things keep it honest, and both
 * are tested:
 *
 *   1. `tests/pdf/tileGeometry.test.ts` asserts this implementation and the
 *      worker's own `tiles` reply agree on the resolution for real page boxes and
 *      scales.
 *   2. The renderer only ever sends a tile **rect**, never a bare address (see
 *      {@link tileRenderRequest}), so even a resolution disagreement cannot move
 *      pixels to the wrong place — it can only change how they are grouped. The
 *      worker answers with the rectangle it actually drew, in page points, and
 *      that is what the surface is positioned with.
 *
 * ## Why there is no raster gutter
 *
 * `PDFVIEWER.md` §6 suggests "a small raster gutter (initially 1–2 pixels) for
 * antialiasing" around each tile's core rectangle. That is what light-pdf needs,
 * because it blits tiles with `BitBlt`/`StretchBlt` into a GDI surface and a tile
 * whose edge is half a pixel wide has to be given one. Here it would be actively
 * wrong:
 *
 *   * The tiles are composited by Chromium as ordinary `<canvas>` elements, each
 *     reproducing the rectangle MuPDF drew for its own clip. A gutter would make
 *     adjacent canvases *overlap*, and two antialiased half-transparent edges on
 *     top of each other darken the seam. Without a gutter the edges abut and
 *     Chromium's own bilinear resampling of the two abutting surfaces is
 *     continuous across the boundary, which is the same way a single whole-page
 *     canvas behaves at its interior pixel boundaries.
 *   * The clip is derived from **integer device edges**, so MuPDF's outward
 *     rounding (`fz_round_rect`) lands on the same integers and the tile covers
 *     exactly its cell — there is no fractional remainder for a gutter to hide.
 *   * At the page's outer edge the divergence that *can* appear (MuPDF draws one
 *     device pixel more than the layout's box) is handled by placing the surface
 *     where the render says it goes, not by padding it.
 *
 * So {@link visibleTiles} emits a gap-free, overlap-free cover of the page's device
 * box whose boundaries are exact integers, and each tile's page-space clip is the
 * inverse image of that integer boundary.
 *
 * Copyright 2026 the Eukolia project authors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PdfRect } from '../../../shared/ipc';

/** The largest tile resolution whose `(row, col)` fit 16 bits. Mirrors `kMaxTileRes`. */
export const MAX_TILE_RES = 15;

/**
 * Device pixels per tile side, before the fit-mode halving.
 *
 * `PDFVIEWER.md` §6 asks for a prototype in the 512–1024 range and warns that
 * "these are experimental ranges, not an asserted optimum". 768 is the middle of
 * the range and a multiple of 32, and — unlike the reference's screen-sized tile —
 * it does not change with the window size, so the same page rasterises into the
 * same addresses on every machine and a cached tile survives a window resize.
 */
export const TILE_TARGET_PX = 768;

/**
 * Below this device-pixel area a page is rendered whole instead of tiled.
 *
 * `PDFVIEWER.md` §6: "Retain a whole-page path for sufficiently small pages where
 * tiling adds overhead. Select based on pixel area and measured upload/raster cost,
 * not a universal zoom percentage." A tile request costs a JSON round trip, a
 * promise, a canvas and a compositor layer; a 400x500 page at 1x is one 0.8 MB
 * upload that beats four tiles of 0.2 MB each on every one of those. 1.5 M device
 * pixels is roughly a US-Letter page at 1.5x, i.e. where one page-wide upload stops
 * fitting comfortably inside a 144 Hz frame.
 */
export const WHOLE_PAGE_MAX_DEVICE_AREA = 1_500_000;

/**
 * The minimum number of tiles before tiling is worth its overhead.
 *
 * Even above the area threshold, a page that resolves to a single tile
 * (`res == 0`) is a whole page with extra steps.
 */
export const MIN_TILES_FOR_TILING = 2;

/**
 * A page's box in PDF points, in the one space every reported coordinate uses.
 *
 * For a page whose own `/Rotate` is non-zero this is the **rotated** box, because
 * that is what the engine's `mediaBox` is (see the module note). It is anchored at
 * `(0, 0)`, so `width`/`height` are the only members that carry information — the
 * origin is named anyway so every conversion below reads as arithmetic rather than
 * as a convention.
 *
 * `PdfOpenResult.pages[].width/height`, the worker's `open`/`info` reply, the
 * `tiles` reply and every text/link/selection rectangle are all in this box.
 */
export interface PageBox {
  readonly width: number;
  readonly height: number;
}

/**
 * The page box in points for a page the viewer's layout has already measured.
 *
 * `sheet` is the page's box in **CSS** pixels after the *display* rotation (the
 * viewer's `rotation`), and `layoutScale` is CSS pixels per point, so
 * `sheet / layoutScale` is the box in points — and because both sides went through
 * the same rotation the result is the engine's own rotated `mediaBox`, whichever
 * quarter turn was applied. Undoing the display rotation explicitly instead would be
 * a second implementation of `pageSizeAfterRotation`, and the two would eventually
 * disagree.
 */
export function pageBoxFromSheet(
  sheet: { width: number; height: number },
  layoutScale: number
): PageBox {
  const scale = Number.isFinite(layoutScale) && layoutScale > 0 ? layoutScale : 1;
  return { width: sheet.width / scale, height: sheet.height / scale };
}

/**
 * Fail loudly on a tile render that asked the engine to rotate.
 *
 * See the module note: the display rotation is a CSS transform on the assembled
 * sheet, and the page's own `/Rotate` is already inside the engine's page space.
 * A non-zero `rotate` on a tile request means one of those is being applied a second
 * time, which is a silent visual defect rather than a crash — so it is a throw.
 */
export function assertRenderRotation(rotate: number): void {
  const normalized = ((Math.trunc(rotate) % 360) + 360) % 360;
  if (normalized !== 0) {
    throw new Error(
      `tile rendering must not rotate the raster (got ${rotate}); the display rotation is a CSS transform ` +
        'and the page\'s own /Rotate is already in the engine\'s page space'
    );
  }
}

/** A tile address, mirroring `TilePosition` in `render_cache.h`. */
export interface TilePosition {
  readonly res: number;
  /** 0 is the **bottom** row in page space; see the module note. */
  readonly row: number;
  readonly col: number;
}

/** An axis-aligned rectangle in device pixels, top-left origin, y descending. */
export interface DeviceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One tile to render: its address, its exact device box, and its page-space clip. */
export interface TileSpec {
  readonly position: TilePosition;
  /** Exact integer device-pixel box; adjacent tiles share these edges. */
  readonly device: DeviceRect;
  /** The page-space rectangle to rasterise, in PDF points (`PdfRenderRequest.clip`). */
  readonly clip: PdfRect;
  /** Device pixels covered, for the scheduler's byte estimate. */
  readonly devicePixels: number;
}

// ---------------------------------------------------------------------------
// Page box -> device box
// ---------------------------------------------------------------------------

/**
 * The page's full box in device pixels.
 *
 * `Math.round`, not `Math.ceil`: this is the box the *layout* occupies, and it has
 * to agree with the canvas the viewer already sizes from the layout
 * (`canvasBackingSize`). Whether the rasteriser produces one pixel more is a
 * separate question, answered by the render's own reported dimensions.
 */
export function pageDeviceBox(page: PageBox, scale: number): DeviceRect {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 0;
  if (s === 0 || !(page.width > 0) || !(page.height > 0)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: 0,
    y: 0,
    width: Math.max(0, Math.round(page.width * s)),
    height: Math.max(0, Math.round(page.height * s))
  };
}

/** Device pixels in a rectangle, or 0 for an empty one. */
export function deviceArea(rect: DeviceRect): number {
  return rect.width > 0 && rect.height > 0 ? rect.width * rect.height : 0;
}

// ---------------------------------------------------------------------------
// Grid resolution
// ---------------------------------------------------------------------------

/**
 * The tile resolution for a device box, per axis, with the reference's fit-mode
 * discount.
 *
 * Ported from light-pdf's `RenderCache::GetTileRes` (via
 * `RenderCache::TileResFor`), including its two deliberate oddities, because a
 * divergence here is a divergence from the grid the native cache has already
 * cached tiles in:
 *
 *   * the two axes are combined by **geometric mean** rather than by their maximum,
 *     "so the tile area does not get too small in comparison to the target size";
 *   * the fit-mode discount is applied when the page **fits inside a single tile**
 *     (`width <= tileSize || height < tileSize`) — note `<=` on one axis and `<` on
 *     the other, which is the reference's own inconsistency and is kept so the two
 *     implementations stay identical.
 *
 * The exponent is not clamped here: {@link tileResForDeviceBox} clamps, and the
 * unclamped value is what {@link rawTileRes} exposes for the agreement test against
 * the worker.
 */
function tileResExponent(widthPx: number, heightPx: number, fitMode: boolean, targetPx: number): number {
  if (!(widthPx > 0) || !(heightPx > 0)) return 0;
  const target = targetPx > 0 ? targetPx : TILE_TARGET_PX;
  const factorW = widthPx / (target + 1);
  const factorH = heightPx / (target + 1);
  let factorAvg = Math.sqrt(factorW * factorH);
  if (fitMode || widthPx <= target || heightPx < target) factorAvg /= 2;
  if (!(factorAvg > 1.5)) return 0;
  return Math.ceil(Math.log(factorAvg) / Math.log(2));
}

/**
 * The tile resolution the native cache would choose for this device box.
 *
 * `PDFVIEWER.md` §6 calls the fit modes out: light-pdf uses larger tiles when
 * fitting the page or the width, because the whole page is on screen and there is
 * nothing to gain from small tiles. This viewer has the same fit modes
 * (`PdfZoomMode`), so it passes the same flag.
 */
export function tileResForDeviceBox(
  widthPx: number,
  heightPx: number,
  fitMode = false,
  targetPx = TILE_TARGET_PX
): number {
  const exponent = tileResExponent(widthPx, heightPx, fitMode, targetPx);
  if (!Number.isFinite(exponent) || exponent <= 0) return 0;
  return Math.min(MAX_TILE_RES, exponent);
}

/** {@link tileResForDeviceBox} without the 16-bit clamp, for cross-checking the worker. */
export function rawTileRes(widthPx: number, heightPx: number, fitMode = false, targetPx = TILE_TARGET_PX): number {
  const exponent = tileResExponent(widthPx, heightPx, fitMode, targetPx);
  return Number.isFinite(exponent) && exponent > 0 ? exponent : 0;
}

/** Number of tiles per axis at a resolution: `2^res`. */
export function gridSize(res: number): number {
  if (!Number.isFinite(res) || res <= 0) return 1;
  return 1 << Math.min(MAX_TILE_RES, Math.floor(res));
}

// ---------------------------------------------------------------------------
// Tile address -> rectangles
// ---------------------------------------------------------------------------

/** The index-range of one grid cell along an axis of `extent` device pixels. */
function cellEdges(extent: number, count: number, index: number): { start: number; end: number } {
  const start = Math.round((extent * index) / count);
  const end = Math.round((extent * (index + 1)) / count);
  return { start, end: Math.max(start, end) };
}

/**
 * The exact device-pixel box of a tile.
 *
 * Row 0 is the **bottom** row, matching `RenderCache`'s `GetTileRect`, which keeps
 * light-pdf's lower-origin row convention so tile addresses stay stable across
 * rotations. The flip happens here and nowhere else.
 *
 * The cell edges are `Math.round(extent * i / count)`, not `floor(extent / count) *
 * i`: rounding each *edge* independently is what makes a column of tiles tile the
 * page exactly (no gaps, no overlaps) even when the extent is not divisible by the
 * count. Rounding a width and then multiplying accumulates a drift of up to
 * `count - 1` pixels across the page, which is a visible seam at the far edge.
 */
export function tileDeviceRect(box: DeviceRect, position: TilePosition): DeviceRect {
  const count = gridSize(position.res);
  if (count <= 1) return box;
  const col = clampIndex(position.col, count);
  const row = clampIndex(position.row, count);
  const columns = cellEdges(box.width, count, col);
  // Page space descends in y, so the highest row index is the *topmost* band: the
  // y range is (count - 1 - row) from the top.
  const rows = cellEdges(box.height, count, count - 1 - row);
  return {
    x: box.x + columns.start,
    y: box.y + rows.start,
    width: columns.end - columns.start,
    height: rows.end - rows.start
  };
}

function clampIndex(value: number, count: number): number {
  if (!Number.isFinite(value)) return 0;
  const i = Math.floor(value);
  if (i < 0) return 0;
  if (i >= count) return count - 1;
  return i;
}

/**
 * The page-space clip for a device-pixel box.
 *
 * The inverse of {@link pageDeviceBox}, so the clip and the box describe the same
 * rectangle. `PdfRenderRequest.clip` is in PDF points, which is page space.
 */
export function deviceRectToPageClip(rect: DeviceRect, scale: number): PdfRect {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    x: rect.x / s,
    y: rect.y / s,
    width: rect.width / s,
    height: rect.height / s
  };
}

/** Every tile of a page at a resolution, in row-major order from the bottom row. */
export function allTilesOfPage(box: DeviceRect, res: number, scale: number): TileSpec[] {
  const count = gridSize(res);
  const out: TileSpec[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      out.push(tileSpecFor(box, { res, row, col }, scale));
    }
  }
  return out;
}

/** Attach the page-space clip for a real scale to an address/box pair. */
export function tileSpecFor(box: DeviceRect, position: TilePosition, scale: number): TileSpec {
  const device = tileDeviceRect(box, position);
  return {
    position,
    device,
    clip: deviceRectToPageClip(device, scale),
    devicePixels: deviceArea(device)
  };
}

// ---------------------------------------------------------------------------
// Which tiles does the viewport need?
// ---------------------------------------------------------------------------

/**
 * The device-pixel box of a page whose *unrotated* sheet size is known in CSS pixels.
 *
 * Used by the tests and by callers that already have the unrotated box; the viewer's
 * own planner uses {@link pageDeviceBox} on the box in points, which is the same
 * arithmetic with the display rotation already undone.
 */
export function sheetDeviceBox(sheet: { width: number; height: number }, devicePixelRatio: number): DeviceRect {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    x: 0,
    y: 0,
    width: Math.max(0, Math.round(sheet.width * dpr)),
    height: Math.max(0, Math.round(sheet.height * dpr))
  };
}

/** `a` ∩ `b`, or an empty rectangle when they do not overlap. */
export function intersectDeviceRect(a: DeviceRect, b: DeviceRect): DeviceRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
}

/**
 * The tiles of a page that intersect the visible window, nearest to its centre
 * first.
 *
 * `visible` is in the page's own device space — the caller subtracts the page's
 * offset — and `overscan` grows it in every direction so that a fast scroll has a
 * band of already-rasterised tiles waiting rather than a blank edge.
 *
 * The "nearest first" order is the scheduler's priority input and the reason this
 * returns more than a set: when only part of the viewport fits in an upload budget,
 * the tiles around the reader's gaze are the ones that must arrive.
 */
export function visibleTiles(
  box: DeviceRect,
  res: number,
  visible: DeviceRect,
  overscanDevicePx = 0
): TileSpec[] {
  const count = gridSize(res);
  const grown: DeviceRect =
    overscanDevicePx > 0
      ? {
          x: visible.x - overscanDevicePx,
          y: visible.y - overscanDevicePx,
          width: visible.width + overscanDevicePx * 2,
          height: visible.height + overscanDevicePx * 2
        }
      : visible;

  const centreX = grown.x + grown.width / 2;
  const centreY = grown.y + grown.height / 2;

  const hits: { spec: TileSpec; distance: number }[] = [];
  const minCol = Math.max(0, Math.floor((grown.x - box.x) / box.width * count) - 1);
  const maxCol = Math.min(count - 1, Math.ceil((grown.x + grown.width - box.x) / box.width * count));
  const minTop = Math.max(0, Math.floor((grown.y - box.y) / box.height * count) - 1);
  const maxTop = Math.min(count - 1, Math.ceil((grown.y + grown.height - box.y) / box.height * count));
  for (let top = minTop; top <= maxTop; top++) {
    const row = count - 1 - top;
    for (let col = minCol; col <= maxCol; col++) {
      const device = tileDeviceRect(box, { res, row, col });
      const overlap = intersectDeviceRect(device, grown);
      if (overlap.width <= 0 || overlap.height <= 0) continue;
      const dx = device.x + device.width / 2 - centreX;
      const dy = device.y + device.height / 2 - centreY;
      hits.push({ spec: tileSpecFor(box, { res, row, col }, 1), distance: Math.hypot(dx, dy) });
    }
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits.map((hit) => hit.spec);
}

/**
 * How far, in device pixels, pre-rasterised tiles should reach past the viewport.
 *
 * `PDFVIEWER.md` §3: "Spend work on the current viewport before speculative
 * content. Bound speculative work by bytes, jobs, and distance." A scroll of one
 * viewport height per second against a ~25 ms rasterisation means the leading edge
 * needs about one viewport of lead to arrive pre-rendered; anything past that is
 * speculative work that competes with the reader.
 *
 * The cap keeps a tall continuous-view layout from turning one page into sixteen
 * speculative tiles: at 768 device pixels a tile, two tiles of lead is at most
 * 1536 device pixels of overscan per edge.
 */
export function overscanForViewport(viewportDevicePx: number, renderAheadPages: number): number {
  const ahead = Number.isFinite(renderAheadPages) && renderAheadPages > 0 ? renderAheadPages : 0;
  const lead = viewportDevicePx * Math.min(ahead, 1);
  return Math.max(0, Math.min(lead, TILE_TARGET_PX * 2));
}

// ---------------------------------------------------------------------------
// Policy: tile or not?
// ---------------------------------------------------------------------------

/**
 * Whether to render this page regionally.
 *
 * `PDFVIEWER.md` §6: "Retain a whole-page path for sufficiently small pages where
 * tiling adds overhead… Select based on pixel area and measured upload/raster cost,
 * not a universal zoom percentage." This is that selection, and it is the *only*
 * one: the viewer must not carry a second zoom threshold that can disagree.
 *
 * Tiling wins when the page's device area is large (one page-wide upload no longer
 * fits a frame) **and** the grid actually has more than one cell (otherwise a tile
 * *is* the whole page, with a round trip added).
 */
export function shouldTilePage(deviceBox: DeviceRect, res: number): boolean {
  if (deviceBox.width <= 0 || deviceBox.height <= 0) return false;
  if (deviceArea(deviceBox) <= WHOLE_PAGE_MAX_DEVICE_AREA) return false;
  return gridSize(res) * gridSize(res) >= MIN_TILES_FOR_TILING;
}
