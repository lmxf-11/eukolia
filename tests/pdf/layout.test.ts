/**
 * The PDF pane's layout, ported from light-pdf.
 *
 * `lightpdf-layout.ts` is a transcription of `DisplayMode.cpp`,
 * `DocumentLayout::Relayout` and the layout half of `DisplayModel.cpp`, so these
 * tests are written against the reference's own numbers rather than against the
 * port's output: the window margins (`2 4 2 4`), the page spacing (`4 4`), the
 * row arithmetic of `FirstPageInARowNo`, the "smallest zoom over the shown
 * pages" rule of `CalcZoomReal`, and the `dpiFactor = 96/72` that makes
 * "actual size" mean actual size.
 *
 * The navigation cases matter most: a page must have a scroll target whether the
 * layout has reached it yet or not, which is the bug this module exists to fix.
 */

import { describe, expect, it } from 'vitest';

import {
  LIGHTPDF_DPI_FACTOR,
  LIGHTPDF_ZOOM_VIRTUAL,
  calcZoomReal,
  columnsFromDisplayMode,
  currentPageAt,
  firstPageInARowNo,
  firstVisiblePageNo,
  isBookViewDisplayMode,
  isContinuousDisplayMode,
  isFacingDisplayMode,
  isSingleDisplayMode,
  lastPageInARowNo,
  lightPdfDisplayModeFromString,
  lightPdfLayout,
  lightPdfScaleFromZoomPercent,
  lightPdfZoomPercentFromScale,
  nextZoomStep,
  pageScrollTarget,
  pageSizeAfterRotation,
  pagesToRender,
  pageVisibleAt,
  resolveDisplayMode,
  scrollTopForUnmeasuredPage,
  zoomRealFromVirtualForPage,
  type LightPdfDisplayMode,
  type LightPdfLayoutParams
} from '@/pdf/lightpdf-layout';
import {
  clampRestoredState,
  forgetAllLightPdfStates,
  recallLightPdfState,
  rememberLightPdfState,
  scrollOffsetForRestoredState,
  scrollStateFromOffset
} from '@/pdf/lightpdf-viewstate';

const LETTER = { width: 612, height: 792 };
const VIEWPORT = { dx: 600, dy: 800 };
const WINDOW_MARGIN = { top: 2, right: 4, bottom: 2, left: 4 };
const PAGE_SPACING = { dx: 4, dy: 4 };

it('uses the live horizontal offset to mount pages after a wide sheet is appended', () => {
  const layout = lightPdfLayout(params({ pageCount: 2, pageBoxes: [LETTER, { width: 2400, height: 792 }] }));
  const page = layout.pages[0];
  expect(page.pos.x).toBeGreaterThan(VIEWPORT.dx);
  expect(pagesToRender(layout, 0, 0, page.pos.x)).toContain(1);
  expect(pageVisibleAt(layout, 1, 0, page.pos.x)).toBe(true);
});

/** `DisplayModel::SetInitialViewSettings`'s parameter set, with 3 letter pages. */
function params(overrides: Partial<LightPdfLayoutParams> = {}): LightPdfLayoutParams {
  return {
    pageCount: 3,
    pageBoxes: [LETTER, LETTER, LETTER],
    displayMode: 'continuous',
    startPage: 1,
    rotation: 0,
    viewPortSize: VIEWPORT,
    viewPortOffset: { x: 0, y: 0 },
    zoomVirtual: 100,
    currentPage: 1,
    windowMargin: WINDOW_MARGIN,
    pageSpacing: PAGE_SPACING,
    ...overrides
  };
}

describe('display modes', () => {
  it('classifies the modes as DisplayMode.cpp does', () => {
    const single = ['single-page', 'continuous'] as const;
    for (const mode of single) expect(isSingleDisplayMode(mode), mode).toBe(true);
    expect(isSingleDisplayMode('facing')).toBe(false);

    for (const mode of ['continuous', 'continuous-facing', 'continuous-book'] as const) {
      expect(isContinuousDisplayMode(mode), mode).toBe(true);
    }
    expect(isContinuousDisplayMode('single-page')).toBe(false);
    expect(isContinuousDisplayMode('facing')).toBe(false);

    expect(isFacingDisplayMode('facing')).toBe(true);
    expect(isFacingDisplayMode('continuous-facing')).toBe(true);
    expect(isFacingDisplayMode('book')).toBe(false);

    expect(isBookViewDisplayMode('book')).toBe(true);
    expect(isBookViewDisplayMode('continuous-book')).toBe(true);
    expect(isBookViewDisplayMode('facing')).toBe(false);
  });

  it('gives two columns to every non-single mode', () => {
    expect(columnsFromDisplayMode('single-page')).toBe(1);
    expect(columnsFromDisplayMode('continuous')).toBe(1);
    expect(columnsFromDisplayMode('facing')).toBe(2);
    expect(columnsFromDisplayMode('book')).toBe(2);
    expect(columnsFromDisplayMode('continuous-facing')).toBe(2);
    expect(columnsFromDisplayMode('continuous-book')).toBe(2);
  });

  it('accepts light-pdf\'s own spellings, case-insensitively', () => {
    expect(lightPdfDisplayModeFromString('single page')).toBe('single-page');
    expect(lightPdfDisplayModeFromString('Book View')).toBe('book');
    expect(lightPdfDisplayModeFromString('CONTINUOUS FACING')).toBe('continuous-facing');
    // The legacy alias `DisplayModeFromString` special-cases.
    expect(lightPdfDisplayModeFromString('continuous single page')).toBe('continuous');
    expect(lightPdfDisplayModeFromString('nonsense', 'facing')).toBe('facing');
    // The setting's own values are already light-pdf's canonical names.
    expect(lightPdfDisplayModeFromString('continuous-book')).toBe('continuous-book');
  });

  it('resolves automatic to the continuous form of the single-page layout', () => {
    expect(resolveDisplayMode('automatic')).toBe('continuous');
    expect(resolveDisplayMode('facing')).toBe('facing');
  });
});

describe('row arithmetic — FirstPageInARowNo / LastPageInARowNo', () => {
  it('reproduces the reference table for facing (no cover)', () => {
    // Pages   Result        Pages   Result
    // (1,2)   1             (2,3)   2
    expect(firstPageInARowNo(1, 2, false)).toBe(1);
    expect(firstPageInARowNo(2, 2, false)).toBe(1);
    expect(firstPageInARowNo(3, 2, false)).toBe(3);
    expect(firstPageInARowNo(4, 2, false)).toBe(3);
    expect(firstPageInARowNo(5, 2, false)).toBe(5);
  });

  it('reserves the cover column in book view', () => {
    // Pages   Result
    // (1)     1
    // (2,3)   2
    // (4,5)   4
    expect(firstPageInARowNo(1, 2, true)).toBe(1);
    expect(firstPageInARowNo(2, 2, true)).toBe(2);
    expect(firstPageInARowNo(3, 2, true)).toBe(2);
    expect(firstPageInARowNo(4, 2, true)).toBe(4);
    expect(firstPageInARowNo(5, 2, true)).toBe(4);
  });

  it('clamps the last page of a row to the document', () => {
    expect(lastPageInARowNo(5, 2, false, 5)).toBe(5);
    expect(lastPageInARowNo(3, 2, false, 5)).toBe(4);
    expect(lastPageInARowNo(1, 2, true, 5)).toBe(1);
    expect(lastPageInARowNo(4, 2, true, 5)).toBe(5);
  });
});

describe('page geometry — DocumentLayout::Relayout', () => {
  it('stacks continuous pages from windowMargin.top with pageSpacing.dy between them', () => {
    const layout = lightPdfLayout(params({ zoomVirtual: 100 }));
    const scale = lightPdfScaleFromZoomPercent(100); // 96/72
    const pageHeight = Math.trunc(LETTER.height * scale + 0.499);

    expect(layout.pages).toHaveLength(3);
    expect(layout.pages.every((page) => page.isShown)).toBe(true);
    expect(layout.pages[0].pos.y).toBe(2);
    expect(layout.pages[1].pos.y).toBe(2 + pageHeight + 4);
    expect(layout.pages[2].pos.y).toBe(2 + 2 * (pageHeight + 4));
    // `canvasDy = currPosY + windowMargin.bottom - pageSpacing.dy`
    expect(layout.canvasSize.dy).toBe(2 + 3 * (pageHeight + 4) - 4 + 2);
    // `canvasSize` never shrinks below the viewport.
    expect(layout.canvasSize.dx).toBeGreaterThanOrEqual(VIEWPORT.dx);
  });

  it('centres a page narrower than the canvas and fills the viewport width', () => {
    const narrow = { width: 300, height: 400 };
    const layout = lightPdfLayout(params({ pageCount: 1, pageBoxes: [narrow], zoomVirtual: 100 }));
    const scale = lightPdfScaleFromZoomPercent(100);
    const width = Math.trunc(narrow.width * scale + 0.499);

    // `canvasDx < viewPort.dx` → the canvas is widened and `offX` centres it.
    expect(layout.canvasSize.dx).toBe(VIEWPORT.dx);
    expect(layout.pages[0].pos.x).toBe(Math.trunc((VIEWPORT.dx - (WINDOW_MARGIN.left + width + WINDOW_MARGIN.right)) / 2) + WINDOW_MARGIN.left);
  });

  it('centres a short page vertically inside the viewport, as the reference does', () => {
    const short = { width: 300, height: 100 };
    const layout = lightPdfLayout(params({ pageCount: 1, pageBoxes: [short], zoomVirtual: 100 }));
    const height = Math.trunc(short.height * LIGHTPDF_DPI_FACTOR + 0.499);
    const canvasDy = WINDOW_MARGIN.top + height + PAGE_SPACING.dy + WINDOW_MARGIN.bottom - PAGE_SPACING.dy;
    // `DocumentLayout::Relayout` *adds* this offset to a position that already
    // starts at `windowMargin.top`, so the top margin is counted twice when the
    // canvas is shorter than the viewport. The port reproduces it.
    const offY = WINDOW_MARGIN.top + Math.trunc((VIEWPORT.dy - canvasDy) / 2);

    expect(layout.canvasSize.dy).toBe(VIEWPORT.dy);
    expect(layout.pages[0].pos.y).toBe(WINDOW_MARGIN.top + offY);
  });

  it('lays out only the start page in single page mode and the pair in facing mode', () => {
    const single = lightPdfLayout(params({ displayMode: 'single-page', startPage: 2 }));
    expect(single.pages.filter((page) => page.isShown).map((page) => page.pageNo)).toEqual([2]);

    const facing = lightPdfLayout(params({ displayMode: 'facing', startPage: 2 }));
    expect(facing.pages.filter((page) => page.isShown).map((page) => page.pageNo)).toEqual([2, 3]);

    const book = lightPdfLayout(params({ displayMode: 'book', startPage: 2 }));
    expect(book.pages.filter((page) => page.isShown).map((page) => page.pageNo)).toEqual([2, 3]);

    // Cover: startPage 1 shows page 1 alone on its row.
    const cover = lightPdfLayout(params({ displayMode: 'book', startPage: 1 }));
    expect(cover.pages.filter((page) => page.isShown).map((page) => page.pageNo)).toEqual([1]);
  });

  it('places the two pages of a facing row side by side, right page first', () => {
    const layout = lightPdfLayout(params({ displayMode: 'continuous-facing' }));
    const scale = lightPdfScaleFromZoomPercent(100);
    const width = Math.trunc(LETTER.width * scale + 0.499);
    const page1 = layout.pages[0];
    const page2 = layout.pages[1];
    const page3 = layout.pages[2];
    expect(page1.pos.y).toBe(page2.pos.y);
    // Column 0 is right-aligned, column 1 left-aligned, `pageSpacing.dx` apart.
    expect(page2.pos.x - (page1.pos.x + width)).toBe(PAGE_SPACING.dx);
    // Page 3 starts the next row.
    expect(page3.pos.y).toBe(page1.pos.y + page1.pos.dy + PAGE_SPACING.dy);
  });

  it('swaps the axes of a rotated page', () => {
    expect(pageSizeAfterRotation(LETTER, 0)).toEqual({ dx: 612, dy: 792 });
    expect(pageSizeAfterRotation(LETTER, 90)).toEqual({ dx: 792, dy: 612 });
    expect(pageSizeAfterRotation(LETTER, 180)).toEqual({ dx: 612, dy: 792 });
    expect(pageSizeAfterRotation(LETTER, 270)).toEqual({ dx: 792, dy: 612 });
    expect(pageSizeAfterRotation(LETTER, 450)).toEqual({ dx: 792, dy: 612 });

    const layout = lightPdfLayout(params({ rotation: 90, zoomVirtual: 100 }));
    const scale = lightPdfScaleFromZoomPercent(100);
    expect(layout.pages[0].pos.dx).toBe(Math.trunc(792 * scale + 0.499));
    expect(layout.pages[0].pos.dy).toBe(Math.trunc(612 * scale + 0.499));
  });

  it('clamps the canvas to the viewport for fit-page in a non-continuous mode', () => {
    const layout = lightPdfLayout(params({ displayMode: 'single-page', zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitPage }));
    expect(layout.canvasSize.dx).toBe(VIEWPORT.dx);
    expect(layout.canvasSize.dy).toBe(VIEWPORT.dy);
  });

  it('falls back to the engine\'s 612x792 for a page whose size is unknown', () => {
    const layout = lightPdfLayout(params({ pageBoxes: [LETTER], pageCount: 2, zoomVirtual: 100 }));
    const scale = lightPdfScaleFromZoomPercent(100);
    expect(layout.pages[1].size).toEqual({ dx: 612, dy: 792 });
    expect(layout.pages[1].pos.dy).toBe(Math.trunc(792 * scale + 0.499));
  });
});

describe('zoom — ZoomRealFromVirtualForPage / CalcZoomReal', () => {
  it('treats a numeric zoom as a percentage of actual size (96/72)', () => {
    expect(lightPdfScaleFromZoomPercent(100)).toBeCloseTo(96 / 72, 10);
    expect(lightPdfZoomPercentFromScale(96 / 72)).toBeCloseTo(100, 10);
    expect(zoomRealFromVirtualForPage(params({ zoomVirtual: 100 }), 1)).toBeCloseTo(96 / 72, 10);
    expect(zoomRealFromVirtualForPage(params({ zoomVirtual: 50 }), 1)).toBeCloseTo(48 / 72, 10);
  });

  it('fits the page into the viewport minus the window margins', () => {
    const fitPage = zoomRealFromVirtualForPage(params({ zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitPage, displayMode: 'single-page' }), 1);
    expect(fitPage).toBeCloseTo(Math.min((VIEWPORT.dx - 8) / 612, (VIEWPORT.dy - 4) / 792), 10);

    const fitWidth = zoomRealFromVirtualForPage(params({ zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitWidth, displayMode: 'single-page' }), 1);
    expect(fitWidth).toBeCloseTo((VIEWPORT.dx - 8) / 612, 10);
  });

  it('caps shrink-to-fit at actual size', () => {
    // A tiny page would fit at a huge zoom; shrink-to-fit must not magnify.
    const tiny = { width: 20, height: 20 };
    const shrink = zoomRealFromVirtualForPage(
      params({ pageCount: 1, pageBoxes: [tiny], displayMode: 'single-page', zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.shrinkToFit }),
      1
    );
    expect(shrink).toBeCloseTo(LIGHTPDF_DPI_FACTOR, 10);

    const fit = zoomRealFromVirtualForPage(
      params({ pageCount: 1, pageBoxes: [tiny], displayMode: 'single-page', zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitPage }),
      1
    );
    expect(fit).toBeGreaterThan(LIGHTPDF_DPI_FACTOR);
  });

  it('resolves fit-by-orientation from the viewport aspect', () => {
    const landscape = zoomRealFromVirtualForPage(
      params({ viewPortSize: { dx: 1000, dy: 500 }, displayMode: 'single-page', zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitByOrientation }),
      1
    );
    const fitWidth = zoomRealFromVirtualForPage(
      params({ viewPortSize: { dx: 1000, dy: 500 }, displayMode: 'single-page', zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitWidth }),
      1
    );
    expect(landscape).toBeCloseTo(fitWidth, 10);

    const portrait = zoomRealFromVirtualForPage(
      params({ viewPortSize: { dx: 500, dy: 1000 }, displayMode: 'single-page', zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitByOrientation }),
      1
    );
    const fitPage = zoomRealFromVirtualForPage(
      params({ viewPortSize: { dx: 500, dy: 1000 }, displayMode: 'single-page', zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitPage }),
      1
    );
    expect(portrait).toBeCloseTo(fitPage, 10);
  });

  it('fits the content box for fit-content and falls back to the page box without one', () => {
    const contentBoxes = [{ x: 100, y: 200, dx: 300, dy: 300 }];
    const withContent = zoomRealFromVirtualForPage(
      params({ pageCount: 1, contentBoxes, displayMode: 'single-page', zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitContent }),
      1
    );
    expect(withContent).toBeCloseTo(Math.min((VIEWPORT.dx - 8) / 300, (VIEWPORT.dy - 4) / 300), 10);

    const withoutContent = zoomRealFromVirtualForPage(
      params({ pageCount: 1, displayMode: 'single-page', zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitContent }),
      1
    );
    const fitPage = zoomRealFromVirtualForPage(
      params({ pageCount: 1, displayMode: 'single-page', zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitPage }),
      1
    );
    expect(withoutContent).toBeCloseTo(fitPage, 10);
  });

  it('uses the smallest zoom over the shown pages for the document-wide value', () => {
    const mixed = { pageCount: 2, pageBoxes: [LETTER, { width: 1224, height: 792 }], zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitWidth };
    const { zoomReal, pageZooms } = calcZoomReal(params({ ...mixed, displayMode: 'single-page', startPage: 1 }));
    // Only page 1 is shown, so the wide page does not affect the zoom...
    expect(zoomReal).toBeCloseTo(zoomRealFromVirtualForPage(params({ ...mixed, displayMode: 'single-page' }), 1), 10);

    // ...but in continuous mode it does, because both pages are laid out.
    const continuous = calcZoomReal(params({ ...mixed, displayMode: 'continuous' }));
    expect(continuous.zoomReal).toBeCloseTo((VIEWPORT.dx - 8) / 1224, 10);
    expect(continuous.pageZooms[0]).toBeCloseTo((VIEWPORT.dx - 8) / 612, 10);
    expect(continuous.pageZooms[1]).toBeCloseTo((VIEWPORT.dx - 8) / 1224, 10);
  });

  it('caps fit-content at 800 % and keeps the previous zoom for a marginal gain', () => {
    const contentBoxes = [{ x: 10, y: 10, dx: 1, dy: 1 }];
    const capped = calcZoomReal(
      params({ pageCount: 1, contentBoxes, displayMode: 'single-page', zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitContent, previousZoomReal: 0 })
    );
    expect(capped.zoomReal).toBe(8);

    const contentBoxes2 = [{ x: 0, y: 0, dx: 300, dy: 300 }];
    // The new zoom here is 1.9733; a previous zoom of 1.95 is within 5 % of it and
    // already above the fit-page zoom, so `CalcZoomReal` keeps it rather than
    // throwing away a prerendered page.
    const previous = 1.95;
    const stable = calcZoomReal(
      params({
        pageCount: 1,
        contentBoxes: contentBoxes2,
        displayMode: 'single-page',
        zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitContent,
        previousZoomReal: previous
      })
    );
    expect(stable.zoomReal).toBe(previous);

    // A real change does replace it.
    const changed = calcZoomReal(
      params({
        pageCount: 1,
        contentBoxes: contentBoxes2,
        displayMode: 'single-page',
        zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitContent,
        previousZoomReal: 5
      })
    );
    expect(changed.zoomReal).toBeCloseTo(Math.min((VIEWPORT.dx - 8) / 300, (VIEWPORT.dy - 4) / 300), 10);
  });
});

describe('the zoom ladder — GetNextZoomStep', () => {
  it('steps to the next and previous default level', () => {
    const at = (percent: number, direction: 1 | -1) =>
      nextZoomStep(params({ displayMode: 'single-page', zoomVirtual: 100 }), {
        direction,
        currentZoomReal: lightPdfScaleFromZoomPercent(percent)
      });

    expect(at(100, 1)).toEqual({ kind: 'percent', percent: 125 });
    expect(at(100, -1)).toEqual({ kind: 'percent', percent: 75 });
    expect(at(1200, 1)).toEqual({ kind: 'percent', percent: 1600 });
    expect(at(8.33, -1)).toEqual({ kind: 'percent', percent: 8.33 });
  });

  it('interpolates the fit-page and fit-width levels into the ladder', () => {
    // A viewport that makes fit-page land at ~55 % and fit-width at ~60 %, both
    // between the 50 % and 66.67 % ladder steps.
    const viewPortSize = { dx: 500, dy: 585 };
    const fitPagePercent = lightPdfZoomPercentFromScale(
      zoomRealFromVirtualForPage(params({ viewPortSize, displayMode: 'single-page', zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitPage }), 1)
    );
    const fitWidthPercent = lightPdfZoomPercentFromScale(
      zoomRealFromVirtualForPage(params({ viewPortSize, displayMode: 'single-page', zoomVirtual: LIGHTPDF_ZOOM_VIRTUAL.fitWidth }), 1)
    );
    expect(fitPagePercent).toBeGreaterThan(50);
    expect(fitPagePercent).toBeLessThan(66.67);
    expect(fitWidthPercent).toBeGreaterThan(fitPagePercent);

    const step = nextZoomStep(params({ viewPortSize, displayMode: 'single-page', zoomVirtual: 100 }), {
      direction: 1,
      currentZoomReal: lightPdfScaleFromZoomPercent(50)
    });
    expect(step).toEqual({ kind: 'mode', mode: 'page-fit' });
  });
});

describe('the current page and the render set', () => {
  it('reports the most visible page and follows the scroll offset', () => {
    const layout = lightPdfLayout(params({ zoomVirtual: 100 }));
    const pageHeight = layout.pages[0].pos.dy + PAGE_SPACING.dy;

    expect(currentPageAt(layout, 0)).toBe(1);
    expect(currentPageAt(layout, pageHeight + 10)).toBe(2);
    expect(currentPageAt(layout, 2 * pageHeight + 10)).toBe(3);
  });

  it('reports the start page in the non-continuous modes, whatever the offset', () => {
    const layout = lightPdfLayout(params({ displayMode: 'single-page', startPage: 2 }));
    expect(currentPageAt(layout, 0)).toBe(2);
    expect(currentPageAt(layout, 10_000)).toBe(2);
  });

  it('orders the pages to render by distance from the viewport', () => {
    const layout = lightPdfLayout(params({ zoomVirtual: 100 }));
    expect(pagesToRender(layout, 0, 0)).toEqual([1]);
    // Prefetching a viewport height reaches page 2, nearest first.
    expect(pagesToRender(layout, 0, VIEWPORT.dy)).toEqual([1, 2]);
    expect(firstVisiblePageNo(layout)).toBe(1);
  });
});

describe('navigation targets', () => {
  it('scrolls a laid-out page to `pos.y - windowMargin.top`', () => {
    const layout = lightPdfLayout(params({ zoomVirtual: 100 }));
    const target = pageScrollTarget(layout, 2, { windowMargin: WINDOW_MARGIN });
    expect(target.y).toBe(layout.pages[1].pos.y - WINDOW_MARGIN.top);
  });

  it('clamps the target to the scrollable range', () => {
    const layout = lightPdfLayout(params({ zoomVirtual: 100 }));
    const target = pageScrollTarget(layout, 3, { windowMargin: WINDOW_MARGIN });
    expect(target.y).toBeLessThanOrEqual(layout.canvasSize.dy - layout.viewPort.dy);
    expect(target.y).toBeGreaterThanOrEqual(0);
  });

  it('computes a target for a page the layout has not reached, from the page sizes', () => {
    // The bug this guards: `geometry` used to be empty for pages the layout had
    // not measured, so `Home`, `End`, `N`, `P` and "go to page" did nothing. The
    // target is now computable from the page sizes and the known spacing, exactly
    // as `DocumentLayout::Relayout` would place the rows above the page.
    const scale = lightPdfScaleFromZoomPercent(100);
    const pageHeight = Math.trunc(792 * scale + 0.499);
    const canvasDy = 2 + 5 * (pageHeight + PAGE_SPACING.dy) - PAGE_SPACING.dy + 2;

    const top = scrollTopForUnmeasuredPage(4, {
      pageCount: 5,
      pageBoxes: [LETTER, LETTER, LETTER, LETTER, LETTER],
      columns: 1,
      rotation: 0,
      zoomReal: scale,
      windowMargin: WINDOW_MARGIN,
      pageSpacing: PAGE_SPACING,
      canvasDy,
      viewPortDy: VIEWPORT.dy
    });

    expect(top).toBe(3 * (pageHeight + PAGE_SPACING.dy));
    expect(top).toBeLessThanOrEqual(canvasDy - VIEWPORT.dy);
  });

  it('accounts for the two columns of a facing layout when computing that target', () => {
    const scale = lightPdfScaleFromZoomPercent(100);
    const pageHeight = Math.trunc(792 * scale + 0.499);
    const canvasDy = 2 + 3 * (pageHeight + PAGE_SPACING.dy) - PAGE_SPACING.dy + 2;

    const top = scrollTopForUnmeasuredPage(5, {
      pageCount: 6,
      pageBoxes: [LETTER, LETTER, LETTER, LETTER, LETTER, LETTER],
      columns: 2,
      rotation: 0,
      zoomReal: scale,
      windowMargin: WINDOW_MARGIN,
      pageSpacing: PAGE_SPACING,
      canvasDy,
      viewPortDy: 100
    });

    // Page 5 is the first page of the third row.
    expect(top).toBe(2 * (pageHeight + PAGE_SPACING.dy));
  });

  it('gives every page a target in continuous mode, including the last', () => {
    const layout = lightPdfLayout(params({ pageCount: 6, pageBoxes: Array(6).fill(LETTER) }));
    for (let page = 1; page <= 6; page++) {
      const geometry = layout.pages[page - 1];
      expect(geometry.isShown, `page ${page} must be laid out`).toBe(true);
      const target = pageScrollTarget(layout, page, { windowMargin: WINDOW_MARGIN });
      expect(Number.isFinite(target.y), `page ${page} must have a target`).toBe(true);
    }
  });
});

describe('per-document view state', () => {
  it('remembers and recalls a view per path, case- and separator-insensitively', () => {
    forgetAllLightPdfStates();
    rememberLightPdfState({
      path: 'D:\\papers\\Paper.PDF',
      displayMode: 'continuous-facing',
      pageNo: 7,
      scrollPos: { x: 12, y: 34 },
      zoom: 1.5,
      zoomMode: 'custom',
      rotation: 90
    });

    const recalled = recallLightPdfState('d:/papers/paper.pdf');
    expect(recalled?.pageNo).toBe(7);
    expect(recalled?.scrollPos).toEqual({ x: 12, y: 34 });
    expect(recalled?.displayMode).toBe('continuous-facing');
    expect(recallLightPdfState('d:/papers/other.pdf')).toBeNull();
    forgetAllLightPdfStates();
  });

  it('clamps a restored page and drops the scroll position when it had to', () => {
    const state = { path: 'a.pdf', displayMode: 'continuous' as LightPdfDisplayMode, pageNo: 9, scrollPos: { x: 5, y: 6 }, zoom: 1, zoomMode: 'custom', rotation: 0 };
    expect(clampRestoredState(state, 4).pageNo).toBe(4);
    expect(clampRestoredState(state, 4).scrollPos).toEqual({ x: -1, y: -1 });
    // A page that is still valid keeps its position.
    expect(clampRestoredState(state, 12).scrollPos).toEqual({ x: 5, y: 6 });
  });

  it('round-trips a scroll offset through page-space coordinates', () => {
    const pages = [
      { pageNo: 1, x: 4, y: 2, dx: 800, dy: 1000, zoomReal: 1.25 },
      { pageNo: 2, x: 4, y: 1006, dx: 800, dy: 1000, zoomReal: 1.25 }
    ];

    // Scrolled down to the second page but not horizontally at all: the horizontal
    // margin is showing, which light-pdf records as `x = -1`.
    const state = scrollStateFromOffset(pages, 1006 + 250, 0, 1);
    expect(state.page).toBe(2);
    expect(state.y).toBeCloseTo(200, 6);
    expect(state.x).toBe(-1);

    const offset = scrollOffsetForRestoredState(1006, 4, state, 1.25, 2);
    expect(offset.top).toBeCloseTo(1006 + 250 - 2, 6);
    // A negative x keeps the current horizontal offset instead of restoring one.
    expect(offset.left).toBe(4);

    // Scrolled horizontally past the page's left edge: the offset is recorded.
    const scrolled = scrollStateFromOffset(pages, 1006, 24, 1);
    expect(scrolled.x).toBeCloseTo((24 - 4) / 1.25, 6);
    expect(scrollOffsetForRestoredState(1006, 4, scrolled, 1.25, 2).left).toBeCloseTo(4 + 20, 6);
  });
});
