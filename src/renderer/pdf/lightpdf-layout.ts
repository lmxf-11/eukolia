/**
 * Eukolia — light-pdf's page layout, ported.
 *
 * This module is a transcription of the layout half of light-pdf:
 *
 * - `DisplayMode.cpp` — `IsSingle` / `IsContinuous` / `IsFacing` / `IsBookView`
 *   and the `DisplayMode` enum's order (`Settings.h`);
 * - `DisplayModel.cpp` — `SetInitialViewSettings` (how `automatic` resolves),
 *   `FirstPageInARowNo` / `LastPageInARowNo`, `ZoomRealFromVirtualForPage`,
 *   `CalcZoomReal`, `GetZoomReal`, `Relayout`, `ChangeStartPage`,
 *   `CurrentPageNo`, `FirstVisiblePageNo`, `GoToPage`'s scroll arithmetic;
 * - `DocumentLayout.cpp` — `DocumentLayout::Relayout` (the page sheet: columns,
 *   centring, margins, spacing, canvas size) and `RecalcVisibleParts`.
 *
 * It is deliberately a pure function of its inputs: the viewer feeds it the
 * measured viewport and the document's page sizes, and gets back every page's
 * position, the canvas size and the scale actually in use. That is what makes
 * navigation testable without a DOM — and it is the fix for "the requested page
 * has no geometry", because the layout is now defined for *every* page the
 * requested display mode shows, not only for the pages that happen to have been
 * measured:
 *
 * - in the continuous modes every page is laid out (`isShown` is true for all of
 *   them), exactly as `DocumentLayout::Relayout` does, so any page's position is
 *   known;
 * - in single page / facing / book view only the pages of one row are laid out
 *   (`DisplayModel::BuildPagesInfo` / `ChangeStartPage`), which is light-pdf's
 *   behaviour: there, "go to page N" *changes the layout's start page* and
 *   re-runs the layout rather than scrolling to a position that was never
 *   computed. Both paths therefore always produce a geometry for the page being
 *   navigated to.
 */

// The zoom ladder (`DisplayModel.cpp` — `defaultZoomLevels`) lives with the rest
// of the transcribed zoom constants; the module is free of DOM and React code,
// so importing it keeps one definition of the ladder.
import { LIGHTPDF_ZOOM_LEVELS, LIGHTPDF_ZOOM_MAX, LIGHTPDF_ZOOM_MIN } from './lightpdf-theme';

/** `Settings.h` — `enum class DisplayMode`, in its own order. */
export type LightPdfDisplayMode =
  | 'automatic'
  | 'single-page'
  | 'facing'
  | 'book'
  | 'continuous'
  | 'continuous-facing'
  | 'continuous-book';

export const LIGHTPDF_DISPLAY_MODES: readonly LightPdfDisplayMode[] = [
  'automatic',
  'single-page',
  'facing',
  'book',
  'continuous',
  'continuous-facing',
  'continuous-book'
];

/** `DisplayMode.cpp` — `displayModeNames`, used by `DisplayModeFromString`. */
const DISPLAY_MODE_NAMES: Record<string, LightPdfDisplayMode> = {
  automatic: 'automatic',
  'single page': 'single-page',
  facing: 'facing',
  'book view': 'book',
  continuous: 'continuous',
  // `DisplayModeFromString` accepts this spelling too.
  'continuous single page': 'continuous',
  'continuous facing': 'continuous-facing',
  'continuous book view': 'continuous-book'
};

/** Accepts light-pdf's display-mode spellings (and Eukolia's setting values). */
export function lightPdfDisplayModeFromString(value: string, fallback: LightPdfDisplayMode = 'automatic'): LightPdfDisplayMode {
  const direct = LIGHTPDF_DISPLAY_MODES.find((mode) => mode === value);
  if (direct) return direct;
  return DISPLAY_MODE_NAMES[value.trim().toLowerCase()] ?? fallback;
}

/** `DisplayMode.cpp` — `IsSingle`. */
export function isSingleDisplayMode(mode: LightPdfDisplayMode): boolean {
  return mode === 'single-page' || mode === 'continuous';
}

/** `DisplayMode.cpp` — `IsContinuous`. */
export function isContinuousDisplayMode(mode: LightPdfDisplayMode): boolean {
  return mode === 'continuous' || mode === 'continuous-facing' || mode === 'continuous-book';
}

/** `DisplayMode.cpp` — `IsFacing`. */
export function isFacingDisplayMode(mode: LightPdfDisplayMode): boolean {
  return mode === 'facing' || mode === 'continuous-facing';
}

/** `DisplayMode.cpp` — `IsBookView`. */
export function isBookViewDisplayMode(mode: LightPdfDisplayMode): boolean {
  return mode === 'book' || mode === 'continuous-book';
}

/** `DocumentLayout.cpp` — `ColumnsFromDisplayMode`. */
export function columnsFromDisplayMode(mode: LightPdfDisplayMode): 1 | 2 {
  return isSingleDisplayMode(mode) ? 1 : 2;
}

/**
 * `DisplayModel::SetInitialViewSettings` — `automatic` means the continuous form
 * of the document's preferred layout. The engine reports that layout for PDFs
 * (its `/PageLayout` key); Eukolia's frozen PDF contract does not carry it, so
 * `automatic` resolves to the continuous form of the single-page layout, which
 * is what the great majority of PDFs ask for and what the setting documents.
 */
export function resolveDisplayMode(mode: LightPdfDisplayMode): LightPdfDisplayMode {
  if (mode !== 'automatic') return mode;
  return 'continuous';
}

/**
 * `DisplayModel.cpp` — `FirstPageInARowNo`.
 *
 * ```
 * Pages   Result           Pages   Result           Pages   Result (R2L)
 * (1,2)   1                  (1)   1                (2,1)   1
 * (3,4)   3                (2,3)   2                (4,3)   3
 * (5)     5                (4,5)   4                  (5)   5
 * ```
 */
export function firstPageInARowNo(pageNo: number, columns: number, showCover: boolean): number {
  let target = pageNo;
  if (showCover && columns > 1) target++;
  let firstPageNo = target - ((target - 1) % columns);
  if (showCover && columns > 1 && firstPageNo > 1) firstPageNo--;
  return firstPageNo;
}

/** `DisplayModel.cpp` — `LastPageInARowNo`. */
export function lastPageInARowNo(pageNo: number, columns: number, showCover: boolean, pageCount: number): number {
  let lastPageNo = firstPageInARowNo(pageNo, columns, showCover) + columns - 1;
  if (showCover && pageNo < columns) lastPageNo--;
  return Math.min(lastPageNo, pageCount);
}

// ---------------------------------------------------------------------------
// Zoom — `DisplayModel.cpp`
// ---------------------------------------------------------------------------

/**
 * `Settings.h` — the virtual zoom levels. They are negative sentinels, so a
 * numeric zoom is always a percentage of `kZoomActualSize` (100).
 */
export const LIGHTPDF_ZOOM_VIRTUAL = {
  fitPage: -1,
  fitWidth: -2,
  fitContent: -3,
  shrinkToFit: -4,
  fitByOrientation: -5
} as const;

export type LightPdfZoomVirtual = number;

/** True for the sentinels rather than a real percentage. */
export function isVirtualZoom(zoom: LightPdfZoomVirtual): boolean {
  return Object.values(LIGHTPDF_ZOOM_VIRTUAL).includes(zoom as (typeof LIGHTPDF_ZOOM_VIRTUAL)[keyof typeof LIGHTPDF_ZOOM_VIRTUAL]);
}

/**
 * `DisplayModel::SetInitialViewSettings` — `dpiFactor = screenDPI / fileDPI`.
 * A PDF's natural unit is the point (72/inch) and Windows' screen DPI is 96, so
 * a zoom of 100 % ("actual size") is 96/72 screen pixels per point. Eukolia's
 * page scale is in CSS pixels per point, and a CSS pixel is 1/96 inch, so the
 * same factor converts between light-pdf's zoom percentage and Eukolia's scale.
 */
export const LIGHTPDF_DPI_FACTOR = 96 / 72;

/** light-pdf's zoom percentage → Eukolia's page scale (CSS px per PDF point). */
export function lightPdfScaleFromZoomPercent(percent: number): number {
  return (percent / 100) * LIGHTPDF_DPI_FACTOR;
}

/** Eukolia's page scale → light-pdf's zoom percentage. */
export function lightPdfZoomPercentFromScale(scale: number): number {
  return (scale / LIGHTPDF_DPI_FACTOR) * 100;
}

export interface LightPdfSize {
  dx: number;
  dy: number;
}

export interface LightPdfRect {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export interface LightPdfPageBox {
  width: number;
  height: number;
}

export interface LightPdfWindowMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface LightPdfPageSpacing {
  dx: number;
  dy: number;
}

/** A row of pages, in the sense of `DocumentLayout::Relayout`'s `columnMaxWidth`. */
export interface LightPdfLayoutPage {
  /** 1-based, as everywhere in light-pdf. */
  pageNo: number;
  isShown: boolean;
  /** Per-page scale in CSS pixels per PDF point (`PageInfo::zoomReal`). */
  zoomReal: number;
  /** Display rectangle on the canvas, after zoom and rotation. */
  pos: LightPdfRect;
  /** Page size after rotation, in PDF points (unscaled). */
  size: LightPdfSize;
  /** `PageInfo::visibleRatio`: 0 invisible, 1 fully visible. */
  visibleRatio: number;
  /** The part of the page inside the viewport, offset by the viewport origin. */
  pageOnScreen: LightPdfRect;
}

export interface LightPdfLayout {
  pages: LightPdfLayoutPage[];
  /** `DocumentLayout::canvasSize`. */
  canvasSize: LightPdfSize;
  /** `DocumentLayout::viewPort` — `params.viewPortOffset` after clamping. */
  viewPort: LightPdfRect;
  /** The scale used for pages that do not have their own (`DocumentLayout::zoomReal`). */
  zoomReal: number;
  columns: 1 | 2;
  displayMode: LightPdfDisplayMode;
  startPage: number;
}

export interface LightPdfLayoutParams {
  pageCount: number;
  /** Media boxes in PDF points, unrotated, indexed by `pageNo - 1`. */
  pageBoxes: ReadonlyArray<LightPdfPageBox | undefined>;
  /**
   * Content boxes in PDF points, from which `kZoomFitContent` measures. Missing
   * or empty falls back to the page box, as `ZoomRealFromVirtualForPage` does.
   */
  contentBoxes?: ReadonlyArray<LightPdfRect | undefined>;
  displayMode: LightPdfDisplayMode;
  /** `params.startPage`; ignored in the continuous modes. */
  startPage: number;
  rotation: number;
  viewPortSize: LightPdfSize;
  viewPortOffset: { x: number; y: number };
  /** A real percentage, or one of `LIGHTPDF_ZOOM_VIRTUAL`. */
  zoomVirtual: LightPdfZoomVirtual;
  /**
   * `pageInfo->zoomReal` before this relayout. `kZoomFitContent` deliberately
   * keeps the previous zoom when the new one is barely different
   * (`CalcZoomReal`), so it has to be passed in.
   */
  previousZoomReal?: number;
  /** Page whose content drives `kZoomFitContent` (`CurrentPageNo()`). */
  currentPage: number;
  windowMargin: LightPdfWindowMargin;
  pageSpacing: LightPdfPageSpacing;
  /** `params.displayR2L` — right-to-left rows. */
  displayR2L?: boolean;
}

/** `DocumentLayout::Relayout` — the 612×792 fallback the engine also uses. */
const FALLBACK_PAGE_BOX: LightPdfPageBox = { width: 612, height: 792 };

function pageBoxOf(params: LightPdfLayoutParams, pageNo: number): LightPdfPageBox {
  const box = params.pageBoxes[pageNo - 1];
  if (!box || !(box.width > 0) || !(box.height > 0)) return FALLBACK_PAGE_BOX;
  return box;
}

/** `DocumentLayout.cpp` — `PageSizeAfterRotation` / `NormalizeRotation`. */
export function pageSizeAfterRotation(box: LightPdfPageBox, rotation: number): LightPdfSize {
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized === 90 || normalized === 270) return { dx: box.height, dy: box.width };
  return { dx: box.width, dy: box.height };
}

/** `documentLayout.cpp` — `RectF(PointF(), row).IsEmpty()`. */
function isDegenerate(size: LightPdfSize): boolean {
  return !(size.dx > 0) || !(size.dy > 0);
}

/**
 * `DisplayModel::ZoomRealFromVirtualForPage`.
 *
 * Returns the scale (CSS px per PDF point) for one page, resolving every
 * virtual zoom the way light-pdf does, including `kZoomFitByOrientation`
 * (issue #702) and `kZoomShrinkToFit`'s clamp to 100 %.
 */
export function zoomRealFromVirtualForPage(params: LightPdfLayoutParams, pageNo: number): number {
  let zoomVirtual = params.zoomVirtual;
  if (zoomVirtual === LIGHTPDF_ZOOM_VIRTUAL.fitByOrientation) {
    zoomVirtual = params.viewPortSize.dx > params.viewPortSize.dy ? LIGHTPDF_ZOOM_VIRTUAL.fitWidth : LIGHTPDF_ZOOM_VIRTUAL.fitPage;
  }
  const isShrinkToFit = zoomVirtual === LIGHTPDF_ZOOM_VIRTUAL.shrinkToFit;
  if (isShrinkToFit) zoomVirtual = LIGHTPDF_ZOOM_VIRTUAL.fitPage;

  if (
    zoomVirtual !== LIGHTPDF_ZOOM_VIRTUAL.fitWidth &&
    zoomVirtual !== LIGHTPDF_ZOOM_VIRTUAL.fitPage &&
    zoomVirtual !== LIGHTPDF_ZOOM_VIRTUAL.fitContent
  ) {
    // `zoomVirtual * 0.01f * dpiFactor`
    return lightPdfScaleFromZoomPercent(zoomVirtual);
  }

  const columns = columnsFromDisplayMode(params.displayMode);
  const fitToContent = zoomVirtual === LIGHTPDF_ZOOM_VIRTUAL.fitContent;
  let row: LightPdfSize;

  if (fitToContent && columns > 1) {
    // Fit the content of all the pages in the same row into the visible area.
    const first = firstPageInARowNo(pageNo, columns, isBookViewDisplayMode(params.displayMode));
    const last = lastPageInARowNo(pageNo, columns, isBookViewDisplayMode(params.displayMode), params.pageCount);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let offsetX = 0;
    for (let page = first; page <= last; page++) {
      const pageBox = pageSizeAfterRotation(pageBoxOf(params, page), params.rotation);
      const content = contentBoxForPage(params, page);
      const box = content ?? { x: 0, y: 0, dx: pageBox.dx, dy: pageBox.dy };
      minX = Math.min(minX, box.x + offsetX);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + offsetX + box.dx);
      maxY = Math.max(maxY, box.y + box.dy);
      offsetX += pageBox.dx + params.pageSpacing.dx;
    }
    row = { dx: maxX - minX, dy: maxY - minY };
  } else {
    row = pageSizeAfterRotation(pageBoxOf(params, pageNo), params.rotation);
    if (fitToContent) {
      // `PageSizeAfterRotation(pageNo, fitToContent)`: the content box instead
      // of the media box.
      const content = contentBoxForPage(params, pageNo);
      if (content) row = { dx: content.dx, dy: content.dy };
    }
    row.dx *= columns;
    row.dx += params.pageSpacing.dx * (columns - 1);
  }

  if (isDegenerate(row)) return 0;

  const areaForPagesDx = params.viewPortSize.dx - params.windowMargin.left - params.windowMargin.right;
  const areaForPagesDy = params.viewPortSize.dy - params.windowMargin.top - params.windowMargin.bottom;
  if (areaForPagesDx <= 0 || areaForPagesDy <= 0) return 0;

  const zoomX = areaForPagesDx / row.dx;
  const zoomY = areaForPagesDy / row.dy;
  let zoom = zoomX < zoomY || zoomVirtual === LIGHTPDF_ZOOM_VIRTUAL.fitWidth ? zoomX : zoomY;
  if (isShrinkToFit) {
    const maxZoom = 1 * LIGHTPDF_DPI_FACTOR;
    if (zoom > maxZoom) zoom = maxZoom;
  }
  return zoom;
}

/** The page's content box, after rotation, in PDF points; `null` when unknown. */
function contentBoxForPage(params: LightPdfLayoutParams, pageNo: number): LightPdfRect | null {
  const box = params.contentBoxes?.[pageNo - 1];
  if (!box || !(box.dx > 0) || !(box.dy > 0)) return null;
  const rotated = ((params.rotation % 360) + 360) % 360;
  if (rotated === 90 || rotated === 270) {
    return { x: box.y, y: box.x, dx: box.dy, dy: box.dx };
  }
  return box;
}

/**
 * `DisplayModel::CalcZoomReal` — the layout-wide `zoomReal` plus the per-page
 * values. The fit modes use the *smallest* zoom over the shown pages so the
 * largest page fits; `kZoomFitContent` only ever zooms in, and not for a
 * marginal gain (`zoomReal / newZoom < 0.95`).
 */
export function calcZoomReal(params: LightPdfLayoutParams): { zoomReal: number; pageZooms: number[] } {
  const pageZooms = new Array<number>(params.pageCount).fill(0);
  const shown = shownPages(params);
  const zoomVirtual = params.zoomVirtual;

  if (zoomVirtual === LIGHTPDF_ZOOM_VIRTUAL.fitContent) {
    let newZoom = zoomRealFromVirtualForPage(params, params.currentPage);
    if (newZoom > 8) newZoom = 8;
    const previous = params.previousZoomReal ?? 0;
    let zoomReal = previous;
    const fitPage = zoomRealFromVirtualForPage({ ...params, zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitPage }, params.currentPage);
    if (newZoom < previous || previous === 0 || previous / newZoom < 0.95 || previous < fitPage) {
      zoomReal = newZoom;
    }
    if (!(zoomReal > 0.01)) zoomReal = newZoom;
    pageZooms.fill(zoomReal);
    return { zoomReal, pageZooms };
  }

  if (
    zoomVirtual === LIGHTPDF_ZOOM_VIRTUAL.fitWidth ||
    zoomVirtual === LIGHTPDF_ZOOM_VIRTUAL.fitPage ||
    zoomVirtual === LIGHTPDF_ZOOM_VIRTUAL.shrinkToFit ||
    zoomVirtual === LIGHTPDF_ZOOM_VIRTUAL.fitByOrientation
  ) {
    let minZoom = Number.POSITIVE_INFINITY;
    for (const pageNo of shown) {
      const zoom = zoomRealFromVirtualForPage(params, pageNo);
      pageZooms[pageNo - 1] = zoom;
      minZoom = Math.min(minZoom, zoom);
    }
    const zoomReal = minZoom === Number.POSITIVE_INFINITY ? 1 : minZoom;
    return { zoomReal, pageZooms };
  }

  const zoomReal = lightPdfScaleFromZoomPercent(zoomVirtual);
  pageZooms.fill(zoomReal);
  return { zoomReal, pageZooms };
}

/** The pages the display mode lays out (`PageInfo::isShown`). */
function shownPages(params: LightPdfLayoutParams): number[] {
  const mode = params.displayMode;
  const pages: number[] = [];
  if (isContinuousDisplayMode(mode)) {
    for (let pageNo = 1; pageNo <= params.pageCount; pageNo++) pages.push(pageNo);
    return pages;
  }
  const columns = columnsFromDisplayMode(mode);
  let start = clamp(params.startPage, 1, Math.max(1, params.pageCount));
  if (isBookViewDisplayMode(mode) && start === 1 && columns > 1) start--;
  for (let pageNo = 1; pageNo <= params.pageCount; pageNo++) {
    if (start <= pageNo && pageNo < start + columns) pages.push(pageNo);
  }
  return pages;
}

/**
 * `DisplayModel::GetZoomReal` — the scale a page is displayed at. In the
 * continuous modes it is the page's own value; in the facing modes both pages of
 * a row share the smaller of the two so the pair fits together.
 *
 * A zero is a real answer: it is what the fit modes return while the viewport has
 * no area (`ZoomRealFromVirtualForPage` bails out when the area is not positive),
 * and light-pdf paints nothing until a real size arrives rather than inventing a
 * scale.
 */
export function getZoomReal(params: LightPdfLayoutParams, pageNo: number, pageZooms: readonly number[]): number {
  const mode = params.displayMode;
  if (isContinuousDisplayMode(mode)) return pageZooms[pageNo - 1] ?? 0;
  if (isSingleDisplayMode(mode)) return zoomRealFromVirtualForPage(params, pageNo);
  const rowStart = firstPageInARowNo(pageNo, columnsFromDisplayMode(mode), isBookViewDisplayMode(mode));
  if (rowStart === params.pageCount || (rowStart === 1 && isBookViewDisplayMode(mode))) {
    return zoomRealFromVirtualForPage(params, rowStart);
  }
  return Math.min(
    zoomRealFromVirtualForPage(params, rowStart),
    zoomRealFromVirtualForPage(params, rowStart + 1)
  );
}

/**
 * `DisplayModel::Relayout` + `DocumentLayout::Relayout`: lays out the shown
 * pages on the canvas and reports where every page ended up.
 */
export function lightPdfLayout(params: LightPdfLayoutParams): LightPdfLayout {
  const mode = params.displayMode;
  const columns = columnsFromDisplayMode(mode);
  const viewPortSize = {
    dx: Math.max(0, Math.round(params.viewPortSize.dx)),
    dy: Math.max(0, Math.round(params.viewPortSize.dy))
  };

  const pageCount = Math.max(1, params.pageCount);
  const effective: LightPdfLayoutParams = { ...params, pageCount };
  const { zoomReal, pageZooms } = calcZoomReal(effective);

  const shown = new Set(shownPages(effective));
  const pages: LightPdfLayoutPage[] = [];
  for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
    pages.push({
      pageNo,
      isShown: shown.has(pageNo),
      zoomReal: shown.has(pageNo) ? getZoomReal(effective, pageNo, pageZooms) : 0,
      pos: { x: 0, y: 0, dx: 0, dy: 0 },
      size: pageSizeAfterRotation(pageBoxOf(effective, pageNo), params.rotation),
      visibleRatio: 0,
      pageOnScreen: { x: 0, y: 0, dx: 0, dy: 0 }
    });
  }

  // ---- DocumentLayout::Relayout -------------------------------------------
  let startPage = clamp(effective.startPage, 1, pageCount);
  effective.startPage = startPage;
  let firstShown = startPage;
  if (isBookViewDisplayMode(mode) && firstShown === 1 && columns > 1) firstShown--;

  let currentY = params.windowMargin.top;
  const columnMaxWidth: [number, number] = [0, 0];
  let pageInARow = 0;
  let rowMaxPageDy = 0;

  for (const page of pages) {
    if (!page.isShown) continue;
    const zoom = page.zoomReal;
    const pos: LightPdfRect = {
      x: 0,
      y: currentY,
      // `(int)(pageSize.dx * zoom + 0.499f)`
      dx: Math.trunc(page.size.dx * zoom + 0.499),
      dy: Math.trunc(page.size.dy * zoom + 0.499)
    };
    rowMaxPageDy = Math.max(rowMaxPageDy, pos.dy);

    if (isBookViewDisplayMode(mode) && page.pageNo === 1 && columns - pageInARow > 1) {
      pageInARow++;
    }
    columnMaxWidth[pageInARow] = Math.max(columnMaxWidth[pageInARow], pos.dx);
    page.pos = pos;
    pageInARow++;
    if (pageInARow === columns) {
      currentY += rowMaxPageDy + params.pageSpacing.dy;
      rowMaxPageDy = 0;
      pageInARow = 0;
    }
  }

  if (pageInARow !== 0) currentY += rowMaxPageDy + params.pageSpacing.dy;
  let canvasDy = currentY + params.windowMargin.bottom - params.pageSpacing.dy;

  if (columns === 2 && pageCount === 1) {
    if (isBookViewDisplayMode(mode)) columnMaxWidth[0] = columnMaxWidth[1];
    else columnMaxWidth[1] = columnMaxWidth[0];
  }

  let canvasDx =
    params.windowMargin.left + columnMaxWidth[0] + (columns === 2 ? params.pageSpacing.dx + columnMaxWidth[1] : 0) + params.windowMargin.right;

  let offX = 0;
  if (canvasDx < viewPortSize.dx) {
    offX = Math.trunc((viewPortSize.dx - canvasDx) / 2);
    canvasDx = viewPortSize.dx;
  }

  pageInARow = 0;
  let pageOffX = offX + params.windowMargin.left;
  for (const page of pages) {
    if (!page.isShown) continue;
    if (isBookViewDisplayMode(mode) && page.pageNo === 1) {
      pageOffX += columnMaxWidth[pageInARow] + params.pageSpacing.dx;
      pageInARow++;
    }
    if (columns === 1) {
      page.pos.x = pageOffX + Math.trunc((columnMaxWidth[0] - page.pos.dx) / 2);
    } else if (pageInARow === 0) {
      page.pos.x = pageOffX + columnMaxWidth[0] - page.pos.dx;
    } else {
      page.pos.x = pageOffX;
    }
    if (isBookViewDisplayMode(mode) && page.pageNo === 1 && !isContinuousDisplayMode(mode)) {
      page.pos.x =
        offX +
        params.windowMargin.left +
        Math.trunc((columnMaxWidth[0] + params.pageSpacing.dx + columnMaxWidth[1] - page.pos.dx) / 2);
    }
    if (params.displayR2L && columns > 1) {
      page.pos.x = canvasDx - page.pos.x - page.pos.dx;
    }
    pageOffX += columnMaxWidth[pageInARow] + params.pageSpacing.dx;
    pageInARow++;
    if (pageInARow === columns) {
      pageOffX = offX + params.windowMargin.left;
      pageInARow = 0;
    }
  }

  if (canvasDy < viewPortSize.dy) {
    const offY = params.windowMargin.top + Math.trunc((viewPortSize.dy - canvasDy) / 2);
    for (const page of pages) {
      if (page.isShown) page.pos.y += offY;
    }
  }

  if (params.zoomVirtual === LIGHTPDF_ZOOM_VIRTUAL.fitPage && !isContinuousDisplayMode(mode)) {
    canvasDy = Math.min(canvasDy, viewPortSize.dy);
    canvasDx = Math.min(canvasDx, viewPortSize.dx);
  }

  const canvasSize = { dx: Math.max(canvasDx, viewPortSize.dx), dy: Math.max(canvasDy, viewPortSize.dy) };
  const viewPort: LightPdfRect = {
    x: params.viewPortOffset.x,
    y: params.viewPortOffset.y,
    dx: viewPortSize.dx,
    dy: viewPortSize.dy
  };
  if (viewPort.x > canvasSize.dx - viewPort.dx) viewPort.x = Math.max(0, canvasSize.dx - viewPort.dx);
  if (viewPort.y > canvasSize.dy - viewPort.dy) viewPort.y = Math.max(0, canvasSize.dy - viewPort.dy);

  const layout: LightPdfLayout = {
    pages,
    canvasSize,
    viewPort,
    zoomReal,
    columns,
    displayMode: mode,
    startPage
  };
  recalcVisibleParts(layout);
  return layout;
}

/** `DocumentLayout::RecalcVisibleParts`. */
export function recalcVisibleParts(layout: LightPdfLayout): void {
  for (const page of layout.pages) {
    const visible = intersect(page.pos, layout.viewPort);
    page.visibleRatio = 0;
    if (!isEmpty(visible) && !isEmpty(page.pos)) {
      page.visibleRatio = (visible.dx * visible.dy) / (page.pos.dx * page.pos.dy);
    }
    page.pageOnScreen = { ...page.pos, x: page.pos.x - layout.viewPort.x, y: page.pos.y - layout.viewPort.y };
  }
}

/**
 * `DisplayModel::CurrentPageNo` — in the continuous modes the most visible page
 * wins; when nothing is visible the first or last page is reported, so the page
 * box never goes blank.
 */
export function currentPageNo(layout: LightPdfLayout): number {
  if (!isContinuousDisplayMode(layout.displayMode)) return layout.startPage;

  let mostVisible = 0;
  let ratio = 0;
  for (const page of layout.pages) {
    if (page.visibleRatio > ratio) {
      mostVisible = page.pageNo;
      ratio = page.visibleRatio;
    }
  }
  if (mostVisible === 0) {
    const first = layout.pages[0];
    if (first && layout.viewPort.y > first.pos.y + first.pos.dy) return layout.pages.length;
    return 1;
  }
  return mostVisible;
}

/** `DisplayModel::FirstVisiblePageNo`; `-1` when nothing is visible. */
export function firstVisiblePageNo(layout: LightPdfLayout): number {
  for (const page of layout.pages) {
    if (page.visibleRatio > 0) return page.pageNo;
  }
  return -1;
}

/**
 * The page the viewer is on, for a scroll offset that is *not* the one the
 * layout was built with.
 *
 * `DisplayModel::CurrentPageNo` works off `PageInfo::visibleRatio`, which
 * `RecalcVisibleParts` recomputes from the live viewport on every scroll. Eukolia
 * computes the same ratio on demand instead of rebuilding the whole layout for
 * each scroll event, which keeps scrolling free of layout work while producing
 * the identical answer.
 */
export function currentPageAt(layout: LightPdfLayout, scrollTop: number, scrollLeft = layout.viewPort.x): number {
  if (!isContinuousDisplayMode(layout.displayMode)) return layout.startPage;
  /**
   * The pages that can have a non-zero visible ratio are a *contiguous run* of the
   * laid-out pages, because the layout orders them by their top edge. So the run is
   * found by binary search and walked, rather than by testing every page and
   * allocating an intersection rectangle for each.
   *
   * That matters because this is called on the scroll path — once per frame during
   * a glide — and a 200-page document made it 200 allocations per frame, which the
   * profiler showed up as garbage collection: 580 ms of GC in a 6.4 s scroll, with
   * `MajorGC` instances of 4–5 ms showing as dropped frames.
   */
  const dy = layout.viewPort.dy;
  const dx = layout.viewPort.dx;
  const bottom = scrollTop + dy;
  let low = 0;
  let high = layout.pages.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    const page = layout.pages[mid];
    if (page.pos.y + page.pos.dy <= scrollTop) low = mid + 1;
    else high = mid;
  }
  let mostVisible = 0;
  let ratio = 0;
  for (let index = low; index < layout.pages.length; index += 1) {
    const page = layout.pages[index];
    if (!page.isShown || page.pos.y >= bottom) break;
    const overlapY = Math.min(page.pos.y + page.pos.dy, bottom) - Math.max(page.pos.y, scrollTop);
    if (overlapY <= 0) continue;
    const overlapX = Math.min(page.pos.x + page.pos.dx, scrollLeft + dx) - Math.max(page.pos.x, scrollLeft);
    if (overlapX <= 0) continue;
    const pageRatio = (overlapX * overlapY) / (page.pos.dx * page.pos.dy);
    if (pageRatio > ratio) {
      mostVisible = page.pageNo;
      ratio = pageRatio;
    }
  }
  if (mostVisible === 0) {
    const first = layout.pages[0];
    if (first && scrollTop > first.pos.y + first.pos.dy) return layout.pages.length;
    return 1;
  }
  return mostVisible;
}

/** True while any part of the page is inside the viewport at `scrollTop`. */
export function pageVisibleAt(layout: LightPdfLayout, pageNo: number, scrollTop: number): boolean {
  const page = layout.pages[pageNo - 1];
  if (!page) return false;
  // Numeric rather than `intersect` + `isEmpty`: this runs once per candidate page
  // per pass, and a rectangle object per page is pure garbage on the scroll path.
  const { x, y, dx, dy } = page.pos;
  return (
    y + dy > scrollTop &&
    y < scrollTop + layout.viewPort.dy &&
    x + dx > layout.viewPort.x &&
    x < layout.viewPort.x + layout.viewPort.dx
  );
}

/**
 * `PageInfo::visibleRatio` for a scroll offset that is not the layout's own —
 * `RecalcVisibleParts` recomputed against the live viewport, which is what
 * `GoToNextPage`'s "fully display the current page first" test needs.
 */
export function visibleRatioAt(layout: LightPdfLayout, pageNo: number, scrollTop: number, scrollLeft = layout.viewPort.x): number {
  const page = layout.pages[pageNo - 1];
  if (!page || isEmpty(page.pos)) return 0;
  const overlapY = Math.min(page.pos.y + page.pos.dy, scrollTop + layout.viewPort.dy) - Math.max(page.pos.y, scrollTop);
  const overlapX = Math.min(page.pos.x + page.pos.dx, scrollLeft + layout.viewPort.dx) - Math.max(page.pos.x, scrollLeft);
  if (overlapY <= 0 || overlapX <= 0) return 0;
  return (overlapX * overlapY) / (page.pos.dx * page.pos.dy);
}

/**
 * The pages to rasterise: everything the viewport touches, plus `padding`
 * pixels of prefetch above and below, ordered by distance from the viewport.
 *
 * light-pdf rasterises `PageVisibleNearby` pages (`RenderVisibleParts`), i.e.
 * the visible pages and their neighbours; the padding here is Eukolia's
 * `pdf.renderAheadPages` expressed the same way, in viewport heights.
 *
 * The candidates are a contiguous run of the laid-out pages (they are ordered by
 * their top edge), so the run is found by binary search and the padding is applied
 * by extending it — which keeps the cost proportional to the pages actually near
 * the viewport rather than to the document.
 */
export function pagesToRender(layout: LightPdfLayout, scrollTop: number, padding: number): number[] {
  const top = scrollTop - padding;
  const bottom = scrollTop + layout.viewPort.dy + padding;
  const pages = layout.pages;
  let low = 0;
  let high = pages.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (pages[mid].pos.y + pages[mid].pos.dy <= top) low = mid + 1;
    else high = mid;
  }
  const candidates: number[] = [];
  const viewPortX = layout.viewPort.x;
  const viewPortDx = layout.viewPort.dx;
  for (let index = low; index < pages.length; index += 1) {
    const page = pages[index];
    if (page.pos.y >= bottom) break;
    if (!page.isShown) continue;
    if (!(page.pos.y + page.pos.dy > top)) continue;
    if (!(page.pos.x + page.pos.dx > viewPortX && page.pos.x < viewPortX + viewPortDx)) continue;
    candidates.push(page.pageNo);
  }
  // Nearest first, so a burst of work favours what is on screen. The comparator
  // reads the layout rather than a parallel array of objects.
  const yOf = (pageNo: number): number => pages[pageNo - 1]?.pos.y ?? 0;
  candidates.sort((a, b) => Math.abs(yOf(a) - scrollTop) - Math.abs(yOf(b) - scrollTop));
  return candidates;
}

/** `DisplayModel::PageVisibleNearby` — used to decide what to prefetch. */
export function pageVisibleNearby(layout: LightPdfLayout, pageNo: number): boolean {
  const columns = columnsFromDisplayMode(layout.displayMode);
  const rowStart = firstPageInARowNo(pageNo, columns, isBookViewDisplayMode(layout.displayMode));
  for (let page = rowStart - columns; page < rowStart + 2 * columns; page++) {
    if (page >= 1 && page <= layout.pages.length && layout.pages[page - 1].visibleRatio > 0) return true;
  }
  return false;
}

/**
 * `DisplayModel::GoToPage`'s scroll arithmetic.
 *
 * Returns the viewport offset (scroll top/left) that shows `pageNo`, in light-pdf's
 * terms: in the continuous modes the page's top is moved to
 * `windowMargin.top` (`viewPort.y = pageInfo->pos.y - windowMargin.top + scrollY`),
 * and a horizontal offset is only applied when the page is not already at least
 * partly in view. The result is clamped to the canvas exactly as light-pdf clamps
 * `viewPort` (`limitValue(viewPort.y, 0, canvasSize.dy - viewPort.dy)`).
 */
export function pageScrollTarget(
  layout: LightPdfLayout,
  pageNo: number,
  options: { scrollY?: number; windowMargin?: LightPdfWindowMargin } = {}
): { x: number; y: number } {
  const margin = options.windowMargin ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const page = layout.pages[pageNo - 1];
  if (!page || !page.isShown) {
    // The page is not part of this layout. In the non-continuous modes that
    // cannot happen once the start page has been moved to the page's row; in
    // the continuous modes every page is laid out. Falling back to the current
    // offset keeps the caller honest rather than scrolling to a bogus place.
    return { x: layout.viewPort.x, y: layout.viewPort.y };
  }

  let x = layout.viewPort.x;
  if (isBookViewDisplayMode(layout.displayMode) && pageNo === 1) {
    // Don't display the blank space beside the cover page.
    x = page.pos.x - margin.left;
  } else if (x >= page.pos.x + page.pos.dx) {
    // Make sure that at least part of the page is visible.
    x = page.pos.x;
  }

  let y = (options.scrollY ?? 0) + layout.viewPort.y;
  if (isContinuousDisplayMode(layout.displayMode)) {
    y = page.pos.y - margin.top + (options.scrollY ?? 0);
  }

  return {
    x: limitValue(x, 0, Math.max(0, layout.canvasSize.dx - layout.viewPort.dx)),
    y: limitValue(y, 0, Math.max(0, layout.canvasSize.dy - layout.viewPort.dy))
  };
}

// ---------------------------------------------------------------------------
// Visual/page-number bound scroll target for a page that has no layout
// ---------------------------------------------------------------------------

/**
 * The scroll offset that brings `pageNo` to the top of the viewport, computed
 * from the page sizes alone.
 *
 * This is the second half of the navigation fix. `lightPdfLayout` gives every
 * shown page a geometry, so navigation inside a laid-out document needs this
 * only when the page's size is not known yet — a document whose page sizes are
 * still arriving, or a layout built before the viewport was measured. light-pdf
 * never needs it because its engine answers `PageMediabox()` for any page on
 * demand (`DisplayModel::BuildPagesInfo` triggers exactly that lazy load); the
 * same arithmetic on the page sizes is the closest equivalent reachable through
 * Eukolia's frozen IPC contract.
 */
export function scrollTopForUnmeasuredPage(
  pageNo: number,
  params: {
    pageCount: number;
    pageBoxes: ReadonlyArray<LightPdfPageBox | undefined>;
    columns: 1 | 2;
    rotation: number;
    zoomReal: number;
    windowMargin: LightPdfWindowMargin;
    pageSpacing: LightPdfPageSpacing;
    canvasDy: number;
    viewPortDy: number;
  }
): number {
  const target = clamp(Math.round(pageNo), 1, Math.max(1, params.pageCount));
  const columns = params.columns;
  const rowStart = columns === 2 ? firstPageInARowNo(target, columns, false) : target;

  let y = params.windowMargin.top;
  for (let page = 1; page < rowStart; page += columns) {
    let rowHeight = 0;
    for (let column = 0; column < columns; column++) {
      const pageNo = page + column;
      if (pageNo > params.pageCount) break;
      const box = params.pageBoxes[pageNo - 1] ?? FALLBACK_PAGE_BOX;
      const size = pageSizeAfterRotation(box, params.rotation);
      rowHeight = Math.max(rowHeight, Math.trunc(size.dy * params.zoomReal + 0.499));
    }
    y += rowHeight + params.pageSpacing.dy;
  }
  if (rowStart > 1) y -= params.windowMargin.top;
  return limitValue(y, 0, Math.max(0, params.canvasDy - params.viewPortDy));
}

// ---------------------------------------------------------------------------
// The zoom ladder — `DisplayModel::GetNextZoomStep`
// ---------------------------------------------------------------------------

/** `DisplayModel.cpp` — `FUZZ`. */
const ZOOM_FUZZ = 0.01;

/**
 * One step of `GetNextZoomStep`: either a numeric zoom percentage, or one of the
 * fit modes the ladder interpolates in when it lies between two steps.
 */
export type LightPdfZoomStep = { kind: 'percent'; percent: number } | { kind: 'mode'; mode: 'page-fit' | 'page-width' };

/**
 * `DisplayModel::GetNextZoomStep`.
 *
 * `ZoomIncrement` takes precedence when it is positive
 * (`MaybeGetNextZoomByIncrement`, `DisplayModel.cpp:1719-1734`): `factor` moves
 * the zoom a percentage relative to where it is, clamped to the level being
 * travelled towards. At its default of 0 the ladder decides, and the ladder is
 * `ZoomLevels` when the reader supplied one and `defaultZoomLevels`
 * (`DisplayModel.cpp:1739-1743`) otherwise.
 *
 * The fit-page and fit-width zooms are interpolated into the ladder, which is
 * what makes Ctrl+wheel from a fit mode land on a fit mode when it is the next
 * sensible level rather than jumping past it.
 */
export function nextZoomStep(
  params: LightPdfLayoutParams,
  options: {
    direction: 1 | -1;
    currentZoomReal: number;
    /** light-pdf `ZoomLevels`; empty uses the built-in ladder. */
    zoomLevels?: readonly number[];
    /** light-pdf `ZoomIncrement`, in percent; 0 uses the ladder. */
    zoomIncrement?: number;
  }
): LightPdfZoomStep {
  const towardsLevel = options.direction > 0 ? LIGHTPDF_ZOOM_MAX : LIGHTPDF_ZOOM_MIN;
  // Rounded to two decimals so the scale round-trip through
  // `lightPdfZoomPercentFromScale` cannot move a level by floating-point noise
  // (80 % * 96/72 comes back as 80.00000000000001).
  let currZoom = Math.round(lightPdfZoomPercentFromScale(options.currentZoomReal) * 100) / 100;
  if (currZoom === towardsLevel) return { kind: 'percent', percent: towardsLevel };

  // `MaybeGetNextZoomByIncrement`: a relative step wins over the ladder.
  const increment = options.zoomIncrement ?? 0;
  if (Number.isFinite(increment) && increment > 0) {
    const factor = increment / 100 + 1;
    const stepped = currZoom < towardsLevel ? Math.min(currZoom * factor, towardsLevel) : Math.max(currZoom / factor, towardsLevel);
    return { kind: 'percent', percent: stepped };
  }

  const ladder = customZoomLadder(options.zoomLevels);

  let pageZoom = Number.POSITIVE_INFINITY;
  let widthZoom = Number.POSITIVE_INFINITY;
  for (const pageNo of shownPages(params)) {
    pageZoom = Math.min(pageZoom, zoomRealFromVirtualForPage({ ...params, zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitPage }, pageNo));
    widthZoom = Math.min(widthZoom, zoomRealFromVirtualForPage({ ...params, zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitWidth }, pageNo));
  }
  // `ZoomRealFromVirtualForPage` returns the scale; the ladder is in percents.
  pageZoom = lightPdfZoomPercentFromScale(pageZoom === Number.POSITIVE_INFINITY ? 1 : pageZoom);
  widthZoom = lightPdfZoomPercentFromScale(widthZoom === Number.POSITIVE_INFINITY ? 1 : widthZoom);

  let newZoom = towardsLevel;
  if (currZoom + ZOOM_FUZZ < towardsLevel) {
    for (const level of ladder) {
      if (level - ZOOM_FUZZ > currZoom) {
        newZoom = level;
        break;
      }
    }
    if (currZoom + ZOOM_FUZZ < pageZoom && pageZoom < newZoom - ZOOM_FUZZ) return { kind: 'mode', mode: 'page-fit' };
    if (currZoom + ZOOM_FUZZ < widthZoom && widthZoom < newZoom - ZOOM_FUZZ) return { kind: 'mode', mode: 'page-width' };
  } else if (currZoom - ZOOM_FUZZ > towardsLevel) {
    for (let index = ladder.length - 1; index >= 0; index -= 1) {
      const level = ladder[index];
      if (level + ZOOM_FUZZ < currZoom) {
        newZoom = level;
        break;
      }
    }
    // Skip Fit Width when it equals Fit Page, as light-pdf does.
    if (newZoom + ZOOM_FUZZ < widthZoom && widthZoom < currZoom - ZOOM_FUZZ && widthZoom !== pageZoom) {
      return { kind: 'mode', mode: 'page-width' };
    }
    if (newZoom + ZOOM_FUZZ < pageZoom && pageZoom < currZoom - ZOOM_FUZZ) return { kind: 'mode', mode: 'page-fit' };
  }
  return { kind: 'percent', percent: newZoom };
}

/**
 * `AppSettings.cpp:349-355` — the reader's `ZoomLevels`, sorted ascending with
 * anything outside `[kZoomMin, kZoomMax]` dropped. An empty or absent list
 * leaves `defaultZoomLevels` (`DisplayModel.cpp:1739-1743`) in charge.
 */
function customZoomLadder(zoomLevels: readonly number[] | undefined): readonly number[] {
  if (!zoomLevels || zoomLevels.length === 0) return LIGHTPDF_ZOOM_LEVELS;
  const levels = zoomLevels.filter((level) => Number.isFinite(level) && level >= LIGHTPDF_ZOOM_MIN && level <= LIGHTPDF_ZOOM_MAX);
  if (levels.length === 0) return LIGHTPDF_ZOOM_LEVELS;
  return [...levels].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function limitValue(value: number, minimum: number, maximum: number): number {  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function isEmpty(rect: LightPdfRect): boolean {
  return !(rect.dx > 0) || !(rect.dy > 0);
}

function intersect(a: LightPdfRect, b: LightPdfRect): LightPdfRect {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.dx, b.x + b.dx);
  const y1 = Math.min(a.y + a.dy, b.y + b.dy);
  return { x: x0, y: y0, dx: Math.max(0, x1 - x0), dy: Math.max(0, y1 - y0) };
}
