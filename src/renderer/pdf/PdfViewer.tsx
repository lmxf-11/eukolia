/**
 * Eukolia — PDF viewer.
 *
 * Rendering is delegated to the native engine (light-pdf / MuPDF derived) through
 * the IPC contract in `src/shared/ipc.ts`. This component owns the viewing model:
 * the page layout, scrolling, zooming, navigation and history, text selection,
 * search, the outline and SyncTeX highlighting.
 *
 * The model is light-pdf's, transcribed in `lightpdf-layout.ts`
 * (`DisplayMode.cpp`, `DocumentLayout.cpp`, the layout half of
 * `DisplayModel.cpp`) and `lightpdf-viewstate.ts` (`FileState` / `ScrollState`):
 *
 * - `DisplayModel::Relayout` decides where every *shown* page is; in the
 *   continuous display modes that is every page, so any page can be reached by
 *   scrolling to `pos.y - windowMargin.top`; in single page / facing / book view
 *   only the current row is laid out and `GoToPage` moves the layout's start page
 *   instead (`ChangeStartPage`). Navigation therefore always has a target.
 * - Sizes are CSS pixels per PDF point. light-pdf's zoom is a percentage of
 *   "actual size", which is `dpiFactor = screenDPI / fileDPI` device pixels per
 *   point (`DisplayModel::SetInitialViewSettings`); `actual size` is therefore
 *   96/72, not 1.
 * - Zoom, rotation and display-mode changes capture the current `ScrollState`
 *   (page + page-space offset) and restore it after the re-layout, exactly as
 *   `DisplayModel::SetZoomVirtual` does; a mouse-wheel zoom additionally pins the
 *   pixel under the cursor (`CvtFromScreen` → `CvtToScreen` → `ScrollXBy`).
 * - Back / Forward keep `ScrollState`s in a 50-entry history, with light-pdf's
 *   "stable nav point" rule so that plain scrolling and page turns are
 *   remembered without recording every intermediate position.
 *
 * Rendering keeps the Eukolia contract: only pages near the viewport are
 * rasterised, the rest keep their bitmap or a correctly sized placeholder, a
 * superseded render is cancelled, results are cached by
 * (page, scale, invert) with a bounded LRU, and the scroll height never changes
 * underneath the viewport.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PdfLink, PdfOpenResult, PdfRect, PdfRenderResult, PdfSearchMatch, PdfTextBlock } from '../../shared/ipc';
import { settingsManager, setting } from '../core/settings';
import { globalEvents } from '../core/events';
import { NATIVE_SCROLL_ATTRIBUTE } from '../core/smoothScroll';

import { OverlayScrollbar } from './OverlayScrollbar';
import {
  LIGHTPDF_FIND_OTHER_MATCH_COLOR,
  LIGHTPDF_FORWARD_SEARCH_FADE_DELAY_MS,
  LIGHTPDF_FORWARD_SEARCH_FADE_STEPS,
  LIGHTPDF_MAX_RENDER_SCALE,
  LIGHTPDF_SELECTION_COLOR,
  LIGHTPDF_SELECTION_DEFAULT_ALPHA,
  LIGHTPDF_SELECTION_PAD,
  bgrToHex,
  themeControlBackgroundColor,
  themeDocumentColors,
  themeWindowLinkColor,
  themeWindowTextColor,
  withAlpha,
  type LightPdfThemeState
} from './lightpdf-theme';
import {
  LIGHTPDF_ZOOM_VIRTUAL,
  columnsFromDisplayMode,
  currentPageAt,
  firstPageInARowNo,
  isBookViewDisplayMode,
  isContinuousDisplayMode,
  isSingleDisplayMode,
  lightPdfLayout,
  lightPdfScaleFromZoomPercent,
  lightPdfZoomPercentFromScale,
  nextZoomStep,
  pageSizeAfterRotation,
  pageVisibleAt,
  pagesToRender,
  resolveDisplayMode,
  scrollTopForUnmeasuredPage,
  visibleRatioAt,
  type LightPdfDisplayMode,
  type LightPdfLayout,
  type LightPdfLayoutParams,
  type LightPdfPageBox,
  type LightPdfRect
} from './lightpdf-layout';
import {
  clampRestoredState,
  recallLightPdfState,
  rememberLightPdfState,
  scrollOffsetForRestoredState,
  scrollStateFromOffset,
  type LightPdfScrollState
} from './lightpdf-viewstate';
import {
  LightPdfSmoothScroll,
  LIGHTPDF_SCROLL_LINE_HEIGHT,
  lightPdfLineScrollDistance,
  lightPdfPointerOverScrollbar,
  lightPdfWheelDelta,
  planLightPdfWheel,
  type LightPdfWheelAction,
  type LightPdfScrollAxis
} from './lightpdf-scroll';
import {
  lightPdfOverlayScrollbarMode,
  lightPdfScrollbarsHidden,
  lightPdfScrollbarsUseOverlay,
  lightPdfSmoothScrollDecayRate,
  readLightPdfViewerSettings
} from './lightpdf-settings';
import { canvasDisplayBox, pdfRenderScale, renderScaleConstrained, textLayerRuns, type RunMeasurement } from './pdf-text-layer';

export interface PdfViewerHandle {
  /** 1-based page navigation. */
  goToPage(page: number): void;
  nextPage(): void;
  previousPage(): void;
  setZoom(zoom: number): void;
  setZoomMode(mode: PdfZoomMode): void;
  /**
   * `CmdZoomIn` / `CmdZoomOut`: one step of `DisplayModel::GetNextZoomStep`'s
   * ladder, around the current view.
   */
  zoomStep(direction: 1 | -1): void;
  /** Scrolls to a page-space position (PDF points, origin top-left). */
  scrollToPosition(page: number, x: number, y: number, options?: { highlight?: boolean }): void;
  /** Highlights a SyncTeX result box on a page, in PDF points. */
  highlight(page: number, rect: { x: number; y: number; width: number; height: number } | null): void;
  find(query: string, options?: { caseSensitive?: boolean; regex?: boolean; wholeWord?: boolean }): Promise<number>;
  findNext(): void;
  findPrevious(): void;
  clearSearch(): void;
  getZoom(): number;
  getCurrentPage(): number;
  scrollToTop(): void;
  scrollBy(deltaY: number): void;
  /** `DocController::CanNavigate` — history of visited views. */
  canNavigateBack(): boolean;
  canNavigateForward(): boolean;
  navigateBack(): void;
  navigateForward(): void;
  /** `CmdSelectAll` (`Ctrl+A`) — the current page's text (see the note there). */
  selectAll(): void;
  /** `CmdCopySelection` (`Ctrl+C`) — the selection, as text. Returns false when empty. */
  copySelection(): boolean;
  clearSelection(): void;
  getSelectionText(): string;
  /**
   * light-pdf's `CmdStartAutoScroll` (427) — `StartAutoScrollAtCursor`
   * (`Canvas.cpp:1704-1710`): middle-click-style auto-scroll anchored at the
   * pointer, so the palette can reach it without a middle button. Invoking it
   * again, a middle click or a lost focus ends it, as `ToggleAutoScroll` does.
   */
  toggleAutoScroll(): void;
  /**
   * light-pdf's `CmdToggleCursorPosition` (365) — `ToggleCursorPositionInDoc`
   * (`LightPDF.cpp:6323-6356`): the cursor-position tip, cycling pt → mm → in
   * and then off.
   */
  toggleCursorPosition(): void;
}

/**
 * `DisplayMode`-driven zoom modes.
 *
 * `custom` is a plain percentage, `actual` is light-pdf's `kZoomActualSize`
 * (100 %, i.e. 96/72 device pixels per point), `auto` is `kZoomFitByOrientation`
 * and `page-height` is Eukolia's own fit-the-tallest-page mode.
 */
export type PdfZoomMode =
  | 'custom'
  | 'page-width'
  | 'page-fit'
  | 'page-height'
  | 'actual'
  | 'fit-content'
  | 'shrink-to-fit'
  | 'auto';

export interface PdfViewerProps {
  path: string | null;
  /** Page scale in CSS pixels per PDF point; ignored for the fit modes. */
  zoom: number;
  zoomMode?: PdfZoomMode;
  /** light-pdf theme state, so every colour in the pane is the reference's. */
  theme: LightPdfThemeState;
  /** `DocumentLayout::Relayout`'s rotation, in degrees. */
  rotation?: 0 | 90 | 180 | 270;
  /** `GlobalPrefs.DefaultDisplayMode` — inside the viewer's own model. */
  displayMode?: LightPdfDisplayMode;
  onZoomChange?(zoom: number, mode: PdfZoomMode): void;
  onPageChange?(page: number, pageCount: number): void;
  onDocumentLoaded?(info: PdfOpenResult): void;
  onError?(message: string): void;
  /** Ctrl+click in the PDF → inverse SyncTeX. */
  onInverseSearch?(page: number, x: number, y: number): void;
  /** Ctrl+click in the source → forward SyncTeX highlight. */
  invertColors?: boolean;
  handleRef?: React.MutableRefObject<PdfViewerHandle | null>;
  /** `n / m` for the find bar (`SearchAndDDE.cpp` — `ShowMatchCount`). */
  onSearchStateChange?(index: number, total: number): void;
  /** `CmdNavigateBack` / `CmdNavigateForward` enabled state. */
  onNavigationStateChange?(canBack: boolean, canForward: boolean): void;
  /** The scale actually in use — `GetZoomVirtual(true)`. */
  onEffectiveScaleChange?(scale: number): void;
}

/** One laid-out page, in the terms the DOM needs. */
interface PageGeometry {
  /** 1-based. */
  page: number;
  /** The page's own scale (`PageInfo::zoomReal`). */
  zoomReal: number;
  /** Display rectangle on the canvas, after zoom and rotation. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Untransformed page size in CSS pixels, before rotation. */
  sheetWidth: number;
  sheetHeight: number;
}

interface RenderedPage {
  key: string;
  /** The page's pixels, RGBA and ready to blit: putImageData takes them as they are. */
  image: ImageData | null;
  width: number;
  height: number;
  /**
   * Device pixels per PDF point the bitmap was rasterised at — the render's own
   * scale, kept so the canvas's CSS box can be made an exact blit of it
   * (`canvasDisplayBox`) rather than a fractional rescale of it.
   */
  scale: number;
  /**
   * The `key` the canvas is currently holding, or `null` when the bitmap has not
   * been drawn (or was drawn for a scale the canvas no longer shows). A visibility
   * pass that finds this equal to its own key has nothing to do.
   */
  painted: string | null;
  requestId: number | null;
}

/**
 * Pages beyond this distance from the viewport are dropped from the bitmap cache.
 */
const CACHE_RADIUS = 3;

/**
 * How many pixels of parked (unmounted) page canvases the viewer keeps.
 *
 * A page crossing the viewport is unmounted and remounted; keeping its canvas — the
 * backing store *and* the pixels in it — turns that into a DOM move. Six page-width
 * canvases at 125 % is 60 MB, and the pen is a bounded cost rather than a leak: the
 * pages least likely to come back are dropped first, oldest first.
 */
const CANVAS_PARK_MAX_BYTES = 192 * 1024 * 1024;

/**
 * How many canvases may sit in the pen's short-lived hand-off map.
 *
 * A page crossing the viewport is detached and re-attached within one commit, so the
 * map normally holds one or two entries. The cap is what stops it becoming a cache
 * nobody bounded: the render window is a handful of pages, so anything past that is
 * a page that is *gone* and belongs in the byte-capped map instead.
 */
const CANVAS_PARK_HANDOFF_MAX = 8;

/**
 * How long the pane waits, after the last movement, before it asks the engine for
 * pixels at the scale it has stopped on.
 *
 * It is a *trailing* pass, not a debounce that can be postponed forever: the pass
 * always runs, so a page can never be left stretched (a `ResizeObserver` delivery
 * followed by silence is the normal end of a drag). 120 ms is under the ~150 ms a
 * reader notices as "the page is still soft", and long enough that the stream of
 * `ResizeObserver` deliveries a live drag produces collapses into one pass.
 */
const INTERACTION_SETTLE_MS = 120;

/**
 * The fastest rate at which a *continuing* gesture may ask for pixels.
 *
 * The settle above is the end of an interaction; this is what keeps a long one
 * (a slow scroll that lasts for seconds, a drag held against a limit) from leaving
 * the pages it brings into view blank until it stops. One pass per interval is
 * about five a second — enough that content appears as it is scrolled to, and far
 * below the per-frame rate that made a drag ask for 35 whole-page renders.
 */
const INTERACTION_PASS_INTERVAL_MS = 200;

/**
 * How long after a scroll the viewer itself asked for, a scroll event is still
 * treated as that navigation rather than as the reader's gesture.
 *
 * `behavior: 'smooth'` reports over several frames, so the window covers the whole
 * animation; it only suppresses the interaction marking, so mistaking a real scroll
 * inside that window costs nothing but a pass that runs slightly sooner.
 */
const PROGRAMMATIC_SCROLL_MS = 400;

/**
 * How long a queued page may wait for a frame before it is drawn anyway.
 *
 * Two frames at 60 Hz: long enough that the queue is normally drained by
 * `requestAnimationFrame` (which is what keeps one whole-page blit per frame), and
 * short enough that a window whose compositor has stopped drawing still fills in.
 */
const PAINT_FALLBACK_MS = 32;

/** `Selection.cpp` — `SELECT_AUTOSCROLL_AREA_WIDTH` / `_STEP_LENGTH`. */
const SELECT_AUTOSCROLL_AREA_WIDTH = 15;const SELECT_AUTOSCROLL_STEP_LENGTH = 10;
const SELECT_AUTOSCROLL_INTERVAL_MS = 20;

/** `Canvas.cpp` — `SMOOTHSCROLL_SLOW_DOWN_FACTOR` for the middle-button autoscroll. */
const AUTOSCROLL_SLOW_DOWN_FACTOR = 10;
const AUTOSCROLL_INTERVAL_MS = 10;

/** `DisplayModel.cpp` — `kStableNavPointDelayMs` and `MAX_NAV_HISTORY_LEN`. */
const STABLE_NAV_POINT_DELAY_MS = 1500;
const MAX_NAV_HISTORY_LEN = 50;

/**
 * `Canvas.cpp:2458-2495` — with `ZoomIncrement > 0` the wheel's zoom is
 * relative and accumulates (`accumDelta += delta`), so a burst of trackpad
 * events becomes one step. light-pdf shortens a full notch to a delta of 10
 * before accumulating ("WHEEL_DELTA is 120, which is too fast", `:2480-2487`);
 * the accumulator here counts in the browser's own units and fires on
 * `WHEEL_DELTA` of them, which is the same "one notch, one step" rule the
 * discrete path uses and keeps the two consistent.
 */
const WHEEL_ZOOM_ACCUM_DELTA = 120;

/**
 * The interval the wheel handler's head start charges the integrator, in seconds.
 *
 * One frame at the cadence this viewer is designed for. It is not a measurement of
 * the display: an over-estimate makes the first step larger than the frame it lands
 * in would have been (slightly bolder motion, same total distance, because the
 * integrator's decay and the step come from the same exponential), and an
 * under-estimate leaves a fraction of a frame on the floor. 144 Hz is the reporter's
 * own display and sits between the two cases that matter — a 60 Hz panel would get a
 * first step of 4 px instead of 7, and a 240 Hz one of 12 instead of 7.
 */
const MOMENTUM_HEAD_START_SECONDS = 1 / 144;

/** Fallback page size, as the engine uses when a page's geometry is unknown. */
const FALLBACK_PAGE_BOX: LightPdfPageBox = { width: 612, height: 792 };

/** `DisplayModel::RotateBy` — pages whose rotation swaps their axes. */
/**
 * CSS transform that maps an untransformed page (size `w`×`h`, origin top-left)
 * into the rotated display box. Derived from CSS `rotate()` acting on screen
 * coordinates, applied before the translation (`translate(...) rotate(...)`).
 */
function sheetTransform(w: number, h: number, rotation: number): string {
  switch (rotation) {
    case 90:
      return `translate(${h}px, 0px) rotate(90deg)`;
    case 180:
      return `translate(${w}px, ${h}px) rotate(180deg)`;
    case 270:
      return `translate(0px, ${w}px) rotate(270deg)`;
    default:
      return 'none';
  }
}

/** Inverse of `sheetTransform` for a point in display pixels → PDF points. */
function unrotatePoint(
  u: number,
  v: number,
  pageWidth: number,
  pageHeight: number,
  scale: number,
  rotation: number
): { x: number; y: number } {
  const ux = u / scale;
  const vy = v / scale;
  switch (rotation) {
    case 90:
      return { x: vy, y: pageHeight - ux };
    case 180:
      return { x: pageWidth - ux, y: pageHeight - vy };
    case 270:
      return { x: pageWidth - vy, y: ux };
    default:
      return { x: ux, y: vy };
  }
}

/** Union of a page's text boxes: Eukolia's content box for `kZoomFitContent`. */
function contentBoxOf(blocks: readonly PdfTextBlock[]): PdfRect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const block of blocks) {
    for (const line of block.lines) {
      for (const span of line.spans) {
        if (!(span.bbox.width > 0) || !(span.bbox.height > 0)) continue;
        found = true;
        minX = Math.min(minX, span.bbox.x);
        minY = Math.min(minY, span.bbox.y);
        maxX = Math.max(maxX, span.bbox.x + span.bbox.width);
        maxY = Math.max(maxY, span.bbox.y + span.bbox.height);
      }
    }
  }
  if (!found) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export const PdfViewer: React.FC<PdfViewerProps> = ({
  path,
  zoom,
  zoomMode = 'page-width',
  theme,
  rotation = 0,
  displayMode = 'continuous',
  onZoomChange,
  onPageChange,
  onDocumentLoaded,
  onError,
  onInverseSearch,
  invertColors = false,
  handleRef,
  onSearchStateChange,
  onNavigationStateChange,
  onEffectiveScaleChange
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** The viewer's own box, which is what owns the wheel for the whole subtree. */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  /**
   * The display's scale factor, live. It is what the render scale multiplies
   * `zoomReal` by and what the canvas's CSS box is divided by, so the bitmap is
   * always exactly as many device pixels as the box it is displayed in.
   */
  const canvasDevicePixelRatio = useDevicePixelRatio();
  /** The scroller is also held as state so `OverlayScrollbar` can measure it. */
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  /** Stable callback ref: an inline one would detach and reattach every render. */
  const attachScroller = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element;
    setScroller(element);
  }, []);

  const [pdfDoc, setPdfDoc] = useState<PdfOpenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [startPage, setStartPage] = useState(1);
  const [version, setVersion] = useState(0);
  /** Bumped when a page's content box (from its text layer) becomes known. */
  const [contentVersion, setContentVersion] = useState(0);
  const [settingsRevision, setSettingsRevision] = useState(0);

  const renderedRef = useRef(new Map<number, RenderedPage>());
  /**
   * Native renders in flight, by page.
   *
   * The `key` is carried alongside the request id because the interesting case is
   * a request that is still running for a scale the layout has *left*: it has to
   * be recognised as obsolete (cancelled, and its result discarded) rather than
   * waited for, which is what the bare request id could not express.
   */
  const inFlightRef = useRef(new Map<string, { requestId: number; key: string }>());
  /**
   * True while the reader is moving something — dragging the divider, dragging the
   * window edge, or scrolling.
   *
   * While it is set nothing is rasterised (`renderPage`) and the text layer is not
   * rebuilt: the layout and the canvas's CSS box follow the gesture, the compositor
   * scales the bitmap the canvas already holds, and one pass at the end asks for
   * the scale the gesture stopped on. Without it a single drag issued 35
   * whole-page renders, none of which was ever displayed.
   */
  const interactingRef = useRef(false);
  /**
   * True while the *scale* is moving — a divider drag, a window edge, a wheel zoom.
   *
   * Separate from `interactingRef` because the two gestures want opposite things
   * from the rasteriser. A resize invalidates every bitmap it passes through, so
   * rendering during one is work that is guaranteed to be thrown away; a *scroll*
   * invalidates nothing and is the one gesture where a page genuinely has no pixels
   * to show — the page arriving at the bottom of the viewport has either never been
   * rendered or had its canvas replaced when it remounted. Suppressing renders
   * during a scroll is therefore exactly backwards: it is what leaves a page blank
   * while the reader is looking at it. Measured, the canvas a remounting page gets
   * is a bare 300x150 element with no pixels and `data-painted` unset, and it stayed
   * that way until the reader stopped moving — the blank sheet is the whole of
   * "sometimes it does not respond".
   */
  const resizingRef = useRef(false);
  /** The trailing pass that ends an interaction; see `settle`. */
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The settle pass itself, held in a ref because `renderPage` and the measurement
   * effect need to *schedule* it while it is defined further down the file (it
   * depends on `updateVisiblePages`).
   */
  const settleRef = useRef<() => void>(() => undefined);
  /** When the last pass was allowed, so a long gesture cannot run them per event. */
  const lastSettleAtRef = useRef(0);
  /** Until when a scroll event belongs to a navigation the viewer started. */
  const programmaticScrollUntilRef = useRef(0);
  const markInteracting = useCallback((allowPasses: boolean) => {
    interactingRef.current = true;
    /**
     * `allowPasses` is the whole difference between a scroll and a resize, and it
     * is what the rasteriser gates on: a resize is a stream of scales, each of
     * which invalidates the last, so nothing may be rendered during one; a scroll
     * invalidates nothing and must be rendered *through*, because pages arriving at
     * the viewport edge have no pixels at all.
     */
    resizingRef.current = !allowPasses;
    const now = performance.now();
    /**
     * A *stream* — a scroll, which brings pages into view that have no bitmap at
     * all — still gets passes while it runs, at a fixed rate rather than at the
     * event rate: scrolling slowly for seconds must not leave those pages blank
     * until the reader stops.
     *
     * A *resize* gets none. Every scale a drag passes through is thrown away by the
     * next one, so a mid-drag render is work with nothing to show for it — measured,
     * the throttled passes cost the drag its frame budget (p95 13.9 ms against
     * 7.2 ms) and bought only a sharper intermediate frame that the reader is still
     * dragging away from. The page does not go blank: it is the bitmap it already
     * had, scaled by the compositor, until the trailing pass replaces it.
     */
    if (allowPasses && now - lastSettleAtRef.current >= INTERACTION_PASS_INTERVAL_MS) {
      lastSettleAtRef.current = now;
      settleRef.current();
    }
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      lastSettleAtRef.current = performance.now();
      settleRef.current();
    }, INTERACTION_SETTLE_MS);
  }, []);
  const visiblePagesRef = useRef(new Set<number>());
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const textRefs = useRef(new Map<number, HTMLDivElement>());
  const textCacheRef = useRef(new Map<number, PdfTextBlock[]>());
  const contentBoxRef = useRef(new Map<number, PdfRect>());
  const highlightRef = useRef<{ page: number; rect: { x: number; y: number; width: number; height: number } } | null>(null);
  /** `fwdSearchMark.hideStep` — bumped on every new result so the fade restarts. */
  const highlightSerialRef = useRef(0);
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Live scroll offset; the layout is independent of it (see `pagesToRender`). */
  const scrollRef = useRef({ x: 0, y: 0 });
  /** `pageInfo->zoomReal` before the current layout, for `kZoomFitContent`. */
  const previousZoomRef = useRef(0);
  /**
   * A `ScrollState` captured before a view change (zoom, rotation, display mode)
   * and restored once the new layout exists — `DisplayModel::SetZoomVirtual`'s
   * `GetScrollState()` / `SetScrollState()` pair.
   */
  const pendingScrollStateRef = useRef<LightPdfScrollState | null>(null);
  /** The pixel that must stay put across a zoom (`fixPt`), in client coordinates. */
  const pendingZoomAnchorRef = useRef<{
    page: number;
    offsetX: number;
    offsetY: number;
    clientX: number;
    clientY: number;
    scale: number;
    rotation: number;
  } | null>(null);

  const [searchMatches, setSearchMatches] = useState<PdfSearchMatch[]>([]);
  const [searchIndex, setSearchIndex] = useState(0);

  /**
   * `DisplayModel`'s navigation history: `ScrollState`s with a cursor, plus the
   * stable-nav-point bookkeeping that decides when a plain scroll has been dwelt
   * on long enough to deserve an entry.
   */
  const historyRef = useRef<{
    entries: LightPdfScrollState[];
    index: number;
    pending: LightPdfScrollState | null;
    pendingAt: number;
    lastCommitted: LightPdfScrollState | null;
  }>({ entries: [], index: -1, pending: null, pendingAt: 0, lastCommitted: null });
  const [historyVersion, setHistoryVersion] = useState(0);

  /**
   * Last render outcome, surfaced as a `data-` attribute on the scroller.
   *
   * A PDF pane that stays blank is otherwise indistinguishable from a slow one,
   * and this is the only state that explains which page was requested, painted,
   * superseded or failed.
   *
   * It is *not* React state, and that is the point: it changes on every render
   * request and every paint, and as state each of those re-rendered the viewer —
   * on a 200-page document the profiler put React's scheduler
   * (`performWorkUntilDeadline`) at the top of the scroll's cost, with individual
   * commits of 5–12 ms. A diagnostic that is only ever read back out of the DOM
   * is written straight to the DOM instead.
   */
  const renderStatusRef = useRef('idle');
  const setRenderStatus = useCallback((value: string) => {
    renderStatusRef.current = value;
    const scroller = containerRef.current;
    if (scroller) scroller.dataset.renderStatus = value;
  }, []);
  /**
   * What the last `paint` actually did, surfaced as a `data-` attribute.
   *
   * `data-render-status` says what the *engine* produced; this says whether those
   * pixels reached a canvas. They are different questions, and the gap between
   * them is a page sheet with its white background and no glyphs — a blank page
   * that only differs from a working one by the absence of ink nobody reported.
   */
  const paintStatusRef = useRef('idle');
  const setPaintStatus = useCallback((value: string) => {
    paintStatusRef.current = value;
    const scroller = containerRef.current;
    if (scroller) scroller.dataset.paintStatus = value;
  }, []);
  const renderAttemptsRef = useRef(0);
  const updateCallsRef = useRef(0);

  const selectionColor = useMemo(() => {
    void settingsRevision;
    return setting.str('pdf.selectionColor') || LIGHTPDF_SELECTION_COLOR;
  }, [settingsRevision]);
  const selectionAlpha = useMemo(() => {
    void settingsRevision;
    const configured = setting.num('pdf.selectionAlpha');
    return Number.isFinite(configured) ? configured : LIGHTPDF_SELECTION_DEFAULT_ALPHA;
  }, [settingsRevision]);

  const [selection, setSelection] = useState<{
    text: string;
    rects: PdfRect[];
    page: number;
  } | null>(null);
  /** Read by the copy command without re-subscribing the key handler. */
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  /** Where the current drag started, in PDF coordinates. */
  const anchorRef = useRef<{ page: number; x: number; y: number } | null>(null);
  /** Discards a reply from a gesture the user has already moved past. */
  const selectionRequestRef = useRef(0);

  // The viewer reads several light-pdf preferences (its theme, its selection
  // colour, its display mode); re-reading them when the settings change keeps the
  // pane in step with the Settings UI without re-opening the document.
  useEffect(() => settingsManager.on('change', () => setSettingsRevision((value) => value + 1)), []);

  /**
   * The light-pdf preferences `Canvas.cpp` owns — the wheel policy, the
   * scrollbar mode, the smooth-scroll integrator and the page margins.
   *
   * They are read here rather than prop-drilled because every one of them is
   * live: the Settings UI writes the store and this memo re-reads it, so a change
   * takes effect on the open document. `readLightPdfViewerSettings` is the one
   * place that knows each value's light-pdf default and clamp.
   */
  const viewerSettings = useMemo(() => {
    void settingsRevision;
    return readLightPdfViewerSettings();
  }, [settingsRevision]);

  const scrollSensitivity = viewerSettings.scrollSensitivity;
  const { scrollbarMode, scrollbarInSinglePage, fastScrollOverScrollbar, windowMargin, pageSpacing } = viewerSettings;
  /**
   * `DocumentLayout::Relayout` starts the canvas at `windowMargin.top`, and
   * `GoToPage` offsets by it; the viewer itself needs the top and bottom for
   * revealing a page and for Eukolia's `page-height` fit mode.
   */
  const PAGE_MARGIN_TOP = windowMargin.top;
  const PAGE_MARGIN_BOTTOM = windowMargin.bottom;

  /**
   * `CmdToggleCursorPosition` (`M`) — `LightPDF.cpp:6323-6356`. The tip cycles
   * its unit pt → mm → in and removes itself on the fourth press
   * (`cursorPosUnit` is a file-static in light-pdf; this is its state).
   */
  const [cursorPositionUnit, setCursorPositionUnit] = useState<'pt' | 'mm' | 'in' | 'off'>('off');
  const [cursorPosition, setCursorPosition] = useState<{ x: number; y: number } | null>(null);
  /** Read by the pointer listener without re-subscribing it. */
  const cursorPositionUnitRef = useRef(cursorPositionUnit);
  cursorPositionUnitRef.current = cursorPositionUnit;

  /**
   * The wheel handler and the scroller's own listeners are subscribed once, so
   * the values they read live in refs. That is what makes a settings change take
   * effect without re-subscribing mid-gesture (`Canvas.cpp` reads `gGlobalPrefs`
   * on every message, which is the behaviour being matched).
   */
  const wheelSettingsRef = useRef({
    scrollSensitivity,
    // light-pdf `SmoothScroll` (`gen-settings.ts:740-745`), read live on every
    // notch the way `Canvas.cpp:2730` reads `gGlobalPrefs->smoothScroll`.
    smoothScroll: viewerSettings.smoothScroll,
    // `Canvas.cpp:639-642` — the slider is a property of the *display mode*, not
    // of the resolved layout, and `displayMode` is already in scope here.
    pageSlider: scrollbarInSinglePage && displayMode === 'single-page',
    fastScrollOverScrollbar
  });
  // Re-published on every render, which is what makes the comment above true: the
  // wheel listener is subscribed once, and a `useRef` initialiser runs once, so
  // without this line the handler would keep reading the settings the pane was
  // mounted with — changing `pdf.scrollSensitivity` would do nothing until some
  // unrelated re-render happened to replace the value. `zoomSettingsRef` below has
  // always done this; this one had not.
  wheelSettingsRef.current = {
    scrollSensitivity,
    smoothScroll: viewerSettings.smoothScroll,
    pageSlider: scrollbarInSinglePage && displayMode === 'single-page',
    fastScrollOverScrollbar
  };
  const zoomSettingsRef = useRef({ zoomLevels: viewerSettings.zoomLevels, zoomIncrement: viewerSettings.zoomIncrement });
  zoomSettingsRef.current = { zoomLevels: viewerSettings.zoomLevels, zoomIncrement: viewerSettings.zoomIncrement };
  /** `Canvas.cpp:2593` — `wheelAccumDelta`, one ref because the handler is one closure. */
  const wheelAccumRef = useRef(0);
  /** `Canvas.cpp:2463-2489` — `ZoomByMouseWheel`'s own `accumDelta`. */
  const wheelZoomAccumRef = useRef(0);
  /**
   * The page steps are defined further down the file than the listeners that
   * need them, and a listener subscribed once must still call the current
   * callback. The refs are written where those callbacks are created below.
   */
  const nextPageRef = useRef<() => void>(() => undefined);
  const previousPageRef = useRef<() => void>(() => undefined);
  /** Latest pointer position; the wheel policy and the autoscroll both read it. */
  const pointerRef = useRef({ clientX: 0, clientY: 0 });
  /** True once the pointer has been seen over the scroller, for the palettes. */
  const pointerInsideRef = useRef(false);

  /** The pointer left the page: the cursor-position tip goes with it. */
  const onMouseLeave = useCallback(() => {
    pointerInsideRef.current = false;
    if (cursorPositionUnitRef.current !== 'off') setCursorPosition(null);
  }, []);

  /** Dragging with the middle button, or `CmdStartAutoScroll` (`Canvas.cpp:1694`). */
  const autoScrollRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setInterval> } | null>(null);

  /** `Canvas.cpp:2553-2556` — a wheel notch ends an autoscroll. */
  const stopAutoScroll = useCallback(() => {
    const active = autoScrollRef.current;
    if (!active) return;
    clearInterval(active.timer);
    autoScrollRef.current = null;
    const container = containerRef.current;
    if (container) container.style.cursor = '';
  }, []);
  const forwardSearch = viewerSettings.forwardSearch;
  const selectionToolbarEnabled = viewerSettings.selectionToolbar;

  /**
   * Callbacks are held in refs so the asynchronous render path never depends on
   * their identity. A parent that passes inline arrow functions would otherwise
   * give `renderPage` a new identity on every parent render, which restarts the
   * visibility pass and can starve rendering entirely.
   */
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onPageChangeRef = useRef(onPageChange);
  onPageChangeRef.current = onPageChange;
  const onDocumentLoadedRef = useRef(onDocumentLoaded);
  onDocumentLoadedRef.current = onDocumentLoaded;
  const onSearchStateRef = useRef(onSearchStateChange);
  onSearchStateRef.current = onSearchStateChange;
  const onEffectiveScaleChangeRef = useRef(onEffectiveScaleChange);
  onEffectiveScaleChangeRef.current = onEffectiveScaleChange;

  const documentColors = useMemo(() => themeDocumentColors(theme), [theme]);
  const backdrop = bgrToHex(documentColors.background);
  const canvasText = bgrToHex(documentColors.text);

  // --------------------------------------------------------------- geometry

  /**
   * Viewport size: the room the pages have, measured so the fit modes re-run when
   * the pane is resized.
   *
   * Three numbers, each taken from the box that knows it, and the asymmetry is the
   * point rather than an accident of history.
   *
   * - **Width is the pane's.** The scroller's width is a consequence of the
   *   viewer's own layout, and reading it here is how the viewer's right edge came
   *   loose from the window: a width cap had to be written from a measurement, and
   *   a measurement taken inside this subtree sees the subtree rather than the
   *   pane. The pane's content box is the first box above the viewer and reports
   *   the room whatever the viewer has done inside it.
   * - **Height is the scroller's**, not the pane's, because the toolbar is inside
   *   the pane above the scroller: the pane's height is 26 px more than the room
   *   the pages have, and a viewport that much too tall centres every page half of
   *   it below the pane's top. The scroller's own box is exactly that room.
   * - **The guard is `containingBound`'s height**, and it is what keeps the
   *   scroller's height from being an answer the viewer wrote itself: with a pane
   *   an ancestor let grow to its content, `height: 100%` resolves to `auto`, the
   *   scroller sizes itself to the canvas it just computed, and that canvas height
   *   would come back as the viewport. `Math.min` against the containing boxes is
   *   what stops it.
   *
   * `ready` is false until the document has arrived, and the layout ignores the
   * size until then: the viewer's first render is still building itself — the
   * toolbar, the page sheets and the canvas host all appear after it — so a
   * measurement taken then can read a half-built box and keep it, because nothing
   * resizes the pane again once the document has landed.
   */
  const [containerSize, setContainerSize] = useState<{ width: number; height: number; ready: boolean }>({
    width: 0,
    height: 0,
    ready: false
  });
  /**
   * The height the viewer's own box may not exceed — the runaway guard, and the
   * only cap left.
   *
   * It is the smallest box containing the scroller (`containingBound`), which is
   * what stops a pane an ancestor let grow to its content from staying that tall:
   * without a definite parent height, `height: 100%` on the scroller resolves to
   * `auto`, the scroller sizes itself to the canvas it just computed, and that
   * canvas height is then fed back as the viewport.
   *
   * There was a matching `max-width` until now, and it was the source of every
   * "the right edge does not reach the window" report: a width cap has to be
   * written from a measurement, a measurement taken inside this subtree sees the
   * subtree's own layout rather than the window's, and the two together let the
   * viewer's right edge float free of the pane it was in. Width has no runaway to
   * guard against — the scroller's width comes from the pane, not from the pages
   * inside it — so the width is simply the pane's.
   */
  const [paneBound, setPaneBound] = useState<{ width: number; height: number } | null>(null);
  /** The last measured viewport, so a *change* can be told from a repeat delivery. */
  const lastMeasuredRef = useRef<{ width: number; height: number } | null>(null);
  /**
   * The scroller's range, refreshed after every commit and read by the wheel and
   * the momentum instead of the layout (see `readScrollRange`).
   */
  const scrollRangeRef = useRef<ScrollRange>({ maxTop: 0, maxLeft: 0, clientHeight: 0, clientWidth: 0 });
  /** The range, re-read when the layout can have changed — never on a scroll frame. */
  const refreshScrollRange = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    scrollRangeRef.current = readScrollRange(container);
  }, []);
  /**
   * The pages with DOM, as a set rather than a range, because the layout's page
   * order is not guaranteed to be a plain sequence in every display mode (facing
   * and book view lay out rows). Kept as state because mounting and unmounting is
   * exactly what React has to be told about.
   */
  const [mountedPageNumbers, setMountedPageNumbers] = useState<ReadonlySet<number>>(() => new Set<number>());
  /** The same set for the effects that build text layers, without re-subscribing. */
  const mountedPageNumbersRef = useRef<ReadonlySet<number>>(mountedPageNumbers);
  mountedPageNumbersRef.current = mountedPageNumbers;

  useEffect(() => {
    // `scroller` is state, not just the ref: the scroll container only exists
    // once a path has been given, so a mount-only effect would measure nothing
    // and every fit mode would silently fall back to 100 %.
    const container = scroller;
    if (!container) return;
    const pane = container.parentElement;
    if (!pane) return;

    /**
     * One measurement per frame, at most.
     *
     * A `ResizeObserver` fires for every box that changed, and a drag of the
     * editor/PDF divider changes several of them per frame; each measurement
     * commits a state update and therefore a re-layout of every page. Coalescing
     * them to the frame is what keeps the drag responsive, and
     * `getBoundingClientRect` is deliberately not used to force the read — the
     * observer's own delivery is already after layout, so the numbers are there
     * to be read.
     */
    let frame = 0;
    const flush = () => {
      frame = 0;
      const bound = containingBound(container);
      /**
       * The pane's width, less the width a platform scrollbar reserves out of it.
       *
       * A pane on `pdf.scrollbar = windows` hands a bar's width of the pane to the
       * bar rather than to the pages, and the scroller's own two boxes are how much:
       * `offsetWidth` is the box the viewer occupies, `clientWidth` the part the
       * pages get. A fit-width page sized for the pane would hang under the bar.
       * The default (`smart`) and `overlay`/`hidden` reserve nothing, so the
       * subtraction is nil for them and the page takes the whole pane.
       */
      const gutter = Math.max(0, container.offsetWidth - container.clientWidth);
      // The pane is the room; the scroller is the same room minus a platform bar's
      // gutter, and the fallback for a pane that reports nothing (a document
      // without layout, or a box that is still hidden).
      const paneWidth = pane.clientWidth > 0 ? pane.clientWidth : container.clientWidth;
      const width = Math.max(1, paneWidth - gutter);
      /**
       * The height is the **viewer's own** box, not the pane's and not the
       * scroller's.
       *
       * - The pane's is too tall by the toolbar, which sits inside it above the
       *   scroller; a viewport that much too tall centres every page half of the
       *   excess below the pane's top.
       * - The scroller's is the answer to the question — it *is* the room the pages
       *   have — but it cannot be asked when an ancestor has let the pane grow to
       *   its content, because then it has sized itself to the canvas: asking it
       *   feeds that canvas height back as the viewport, which is the runaway the
       *   height cap exists for.
       *
       * The viewer's own box is neither: it is the pane less the toolbar, and the
       * cap on the scroller keeps it from being inflated by the pages inside it.
       */
      const viewer = container.closest('[data-scrollbar-mode]') as HTMLElement | null;
      const guard = bound?.height && bound.height > 0 ? bound.height : Number.POSITIVE_INFINITY;
      const measured = viewer && viewer.clientHeight > 0 ? viewer.clientHeight : container.clientHeight;
      const height = Math.max(1, Math.min(measured, guard));
      // The scroller's own range, cached here because this is a place that already
      // has the box in hand (the wheel and the momentum must not read layout).
      scrollRangeRef.current = readScrollRange(container);
      /**
       * A changed measurement *is* a resize in progress, and it is where the
       * interaction is declared: the pane's box follows the gesture immediately
       * (this commit and the layout it drives), while the pixels wait for the
       * settle. Reading the previous size from a ref rather than inside the state
       * updater keeps the state update pure and the side effect where it belongs.
       */
      const previousSize = lastMeasuredRef.current;
      /**
       * A size change is an interaction only once there is something on screen to
       * keep there. The first measurements of a viewer — the pane laying itself out,
       * a document being replaced — are not a drag, and treating them as one would
       * hold the very first paint back until the settle; with a bitmap already
       * painted, a size change means the reader is moving something, and the pixels
       * can wait for the trailing pass.
       */
      if (previousSize && (previousSize.width !== width || previousSize.height !== height) && renderedRef.current.size > 0) {
        markInteracting(false);
      }
      lastMeasuredRef.current = { width, height };
      setContainerSize((previous) =>
        previous.ready && previous.width === width && previous.height === height
          ? previous
          : { width, height, ready: true }
      );
      setPaneBound((previous) =>
        (previous === null) === (bound === null) &&
        previous?.width === bound?.width &&
        previous?.height === bound?.height
          ? previous
          : bound
      );
    };
    const measure = () => {
      if (frame) return;
      frame = requestAnimationFrame(flush);
    };

    flush();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    // Both boxes: the pane is the room, and the scroller is the part of it the
    // pages get (a platform scrollbar takes its width out of the second one, and
    // that difference is the fit's business too).
    observer?.observe(pane);
    observer?.observe(container);
    // The pane's box is laid out by the window, which need not resize the pane
    // itself when the window changes (a window that is only moved, a zoom).
    window.addEventListener('resize', measure);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
    // `pdfDoc` is a dependency on purpose, and it is the one that matters at
    // mount: the viewer's first render is still building itself — the toolbar,
    // the page sheets and the canvas host all appear after it — so a measurement
    // taken then can read a half-built box and keep it, because nothing resizes
    // the pane again once the document has arrived. Re-measuring when the document
    // lands is what makes the first fit correct rather than the first fit lucky.
  }, [scroller, pdfDoc]);

  const resolvedDisplayMode = useMemo(() => resolveDisplayMode(displayMode), [displayMode]);
  const pageCount = pdfDoc?.pageCount ?? 0;

  /**
   * `Canvas.cpp:639-642` — `scrollbarInSinglePage` turns the bar into a page
   * slider, and only in the non-continuous single-page layout
   * (`gGlobalPrefs->scrollbarInSinglePage && mode == DisplayMode::SinglePage`).
   */
  const pageSlider = scrollbarInSinglePage && resolvedDisplayMode === 'single-page';
  /** `LightPDF.cpp:1140-1143` — `windows` uses the platform bar, not the overlay. */
  const useOverlayScrollbar = lightPdfScrollbarsUseOverlay(scrollbarMode);
  const pageSliderRef = useRef(pageSlider);
  pageSliderRef.current = pageSlider;
  /** The page the slider is on, for a navigation that has to write the bar. */
  const currentPageRef = useRef(currentPage);
  /**
   * The wheel handler reads the display mode and the zoom mode on every notch
   * rather than closing over them, so a settings change reaches it live.
   */
  const displayModeRef = useRef(resolvedDisplayMode);
  displayModeRef.current = resolvedDisplayMode;
  const zoomModeRef = useRef(zoomMode);
  zoomModeRef.current = zoomMode;

  const pageBoxes = useMemo<ReadonlyArray<LightPdfPageBox | undefined>>(
    () => (pdfDoc ? pdfDoc.pages.map((page) => ({ width: page.width, height: page.height })) : []),
    [pdfDoc]
  );

  const contentBoxes = useMemo<ReadonlyArray<LightPdfRect | undefined>>(() => {
    void contentVersion;
    return pageBoxes.map((_, index) => {
      const box = contentBoxRef.current.get(index + 1);
      return box ? { x: box.x, y: box.y, dx: box.width, dy: box.height } : undefined;
    });
  }, [pageBoxes, contentVersion]);

  /**
   * The tallest page after rotation, used by Eukolia's `page-height` fit mode
   * (light-pdf has no such mode; it is the height analogue of `fit width`).
   */
  const tallestPageHeight = useMemo(() => {
    let tallest = 0;
    for (const box of pageBoxes) {
      const size = pageSizeAfterRotation(box ?? FALLBACK_PAGE_BOX, rotation);
      tallest = Math.max(tallest, size.dy);
    }
    return tallest;
  }, [pageBoxes, rotation]);

  /** `zoomVirtual`: a percentage, or one of `LIGHTPDF_ZOOM_VIRTUAL`'s sentinels. */
  const zoomVirtual = useMemo(() => {
    switch (zoomMode) {
      case 'page-fit':
        return LIGHTPDF_ZOOM_VIRTUAL.fitPage;
      case 'page-width':
        return LIGHTPDF_ZOOM_VIRTUAL.fitWidth;
      case 'actual':
        return 100;
      case 'fit-content':
        return LIGHTPDF_ZOOM_VIRTUAL.fitContent;
      case 'shrink-to-fit':
        return LIGHTPDF_ZOOM_VIRTUAL.shrinkToFit;
      case 'auto':
        return LIGHTPDF_ZOOM_VIRTUAL.fitByOrientation;
      case 'page-height': {
        const available = containerSize.height - PAGE_MARGIN_TOP - PAGE_MARGIN_BOTTOM;
        const scale = tallestPageHeight > 0 && available > 0 ? available / tallestPageHeight : zoom;
        return lightPdfZoomPercentFromScale(scale);
      }
      default:
        return lightPdfZoomPercentFromScale(zoom);
    }
  }, [zoomMode, zoom, containerSize.height, tallestPageHeight]);

  /**
   * What the layout is told the current page is.
   *
   * `DisplayModel::CalcZoomReal` reads `params.currentPage` in **one** branch —
   * `kZoomFitContent` (`lightpdf-layout.ts:393,397`), where the zoom has to follow
   * the page being read — and there is nothing else in the layout that depends on
   * it. Passing the live value in every mode made `currentPage` a dependency of
   * the layout memo below, and `currentPage` changes on every page crossing: a
   * scroll through a 500-page document rebuilt the whole layout — `pageCount`
   * page objects, a `pageCount`-long zoom array, and a `shownPages` walk — several
   * times a second, then cascaded into `geometryByPage`, `contentBoxes` and the
   * visibility passes that depend on them. In the modes that do not read it, the
   * only value that can produce the same layout is a constant.
   */
  const layoutCurrentPage =
    zoomVirtual === LIGHTPDF_ZOOM_VIRTUAL.fitContent ? currentPage : 1;

  const layout: LightPdfLayout = useMemo(() => {
    const params: LightPdfLayoutParams = {
      pageCount: Math.max(1, pageCount),
      pageBoxes,
      contentBoxes,
      displayMode: resolvedDisplayMode,
      startPage,
      rotation,
      // The pane, less the width a platform scrollbar reserves out of it. A pane
      // on the overlay bar (`pdf.scrollbar`, `smart`/`overlay`/`hidden`) hands the
      // page all of it.
      viewPortSize: { dx: containerSize.ready ? containerSize.width : 1, dy: containerSize.ready ? containerSize.height : 1 },
      // The page positions do not depend on the scroll offset; visibility is
      // computed from the live offset on demand (`currentPageAt`,
      // `pagesToRender`), so scrolling never rebuilds the layout.
      viewPortOffset: { x: 0, y: 0 },
      zoomVirtual,
      previousZoomReal: previousZoomRef.current,
      currentPage: layoutCurrentPage,
      windowMargin,
      pageSpacing
    };
    return lightPdfLayout(pageCount > 0 ? params : { ...params, pageCount: 1, pageBoxes: [] });
  }, [pageCount, pageBoxes, contentBoxes, resolvedDisplayMode, startPage, rotation, containerSize, zoomVirtual, layoutCurrentPage, windowMargin, pageSpacing]);

  /** The scale in use (`GetZoomVirtual(true)`, as a CSS-pixels-per-point scale). */
  const effectiveScale = layout.zoomReal || zoom;
  const scaleRef = useRef(effectiveScale);
  scaleRef.current = effectiveScale;

  useEffect(() => {
    previousZoomRef.current = layout.zoomReal;
  }, [layout]);

  // ---------------------------------------------------------------- open/close

  /**
   * Bumped whenever the PDF on disk changes or a failed open should be retried.
   * Re-running the open effect on a token (rather than on `path`) is what makes
   * the viewer follow a rebuild: after `latexmk` rewrites the file the path is
   * unchanged, so a path-only effect would keep showing the old document — or,
   * worse, keep showing "not found" if the viewer happened to open before the
   * first build finished.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const diskMtimeRef = useRef<number | null>(null);
  /**
   * True while a re-open is in flight.
   *
   * A ref, not the `loading` state: the mtime poll's interval closure captures
   * whatever `loading` was when it was created, so a second poll tick could
   * arrive before React re-rendered and queue a *second* re-open of the same
   * rebuild — two open/render passes where one is correct.
   */
  const reloadingRef = useRef(false);
  /** A view restored from `lightpdf-viewstate`, applied once the layout exists. */
  const restoreStateRef = useRef<LightPdfScrollState | null>(null);

  useEffect(() => {
    diskMtimeRef.current = null;
  }, [path]);

  useEffect(() => {
    if (!path) {
      setPdfDoc(null);
      setError(null);
      renderedRef.current.clear();
      textCacheRef.current.clear();
      textLayerScaleRef.current.clear();
      contentBoxRef.current.clear();
      measureCacheRef.current.clear();
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    reloadingRef.current = true;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        // The file's state *before* the engine reads it. A build rewrites the PDF
        // in place, so an open that races the compiler can read a half-written
        // file — one whose page count is smaller than the finished document's —
        // and once it succeeds the modification-time poll cannot notice, because
        // the timestamp it records afterwards is already the final one. Comparing
        // the two reads is what detects "the file changed while we were opening
        // it", and the reload below is the one re-open that catches up.
        const before = await window.eukoliaApi.stat(path).catch(() => null);
        const info = await window.eukoliaApi.pdfOpen(path);
        if (cancelled) return;

        const stat = await window.eukoliaApi.stat(path);
        diskMtimeRef.current = stat.exists ? stat.mtimeMs : null;

        // The document was replaced underneath the read: open it again, once, now
        // that the file has settled. Reported so a persistent failure is visible
        // rather than showing a document that is quietly the wrong one.
        if (before?.exists && stat.exists && before.mtimeMs !== stat.mtimeMs) {
          setRenderStatus('reopening after the file changed mid-read');
          setReloadToken((value) => value + 1);
          return;
        }

        // `ReplaceDocumentInCurrentTab` — the remembered `FileState` decides the
        // page and the scroll position; without one the document opens at page 1.
        const saved = recallLightPdfState(path);
        const restored = saved ? clampRestoredState(saved, info.pageCount) : null;

        setPdfDoc(info);
        setCurrentPage(restored ? restored.pageNo : 1);
        setStartPage(restored ? restored.pageNo : 1);
        previousZoomRef.current = 0;
        restoreStateRef.current = restored
          ? { page: restored.pageNo, x: restored.scrollPos.x, y: restored.scrollPos.y }
          : null;
        renderedRef.current.clear();
        textCacheRef.current.clear();
        textLayerScaleRef.current.clear();
        contentBoxRef.current.clear();
        measureCacheRef.current.clear();
        inFlightRef.current.clear();
        setSearchMatches([]);
        // `navHistory` starts empty with the cursor at 0, exactly as
        // `DisplayModel` has it: the first view change records where the user was.
        historyRef.current = { entries: [], index: 0, pending: null, pendingAt: 0, lastCommitted: null };
        setHistoryVersion((value) => value + 1);
        setRenderStatus('opened');
        setVersion((value) => value + 1);
        onDocumentLoadedRef.current?.(info);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        onErrorRef.current?.(message);

        // A PDF that does not exist yet is the normal state while a build is
        // running, so the open is retried rather than left as a dead end.
        if (/not found|no such file|does not exist/i.test(message)) {
          retryTimer = setTimeout(() => {
            if (!cancelled) setReloadToken((value) => value + 1);
          }, 1500);
        }
      } finally {
        if (!cancelled) {
          reloadingRef.current = false;
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      void window.eukoliaApi.pdfClose(path).catch(() => undefined);
    };
  }, [path, reloadToken]);

  /**
   * Watches the file's modification time so a rebuild is picked up
   * automatically — the same behaviour a LaTeX user expects from an external
   * compiler writing the PDF. The open effect owns the document, so a reload is a
   * single re-open (`reloadToken`), never a second render pass on top of the old
   * bitmaps: `renderedRef` and the in-flight map are cleared by that effect.
   */
  useEffect(() => {
    if (!path || !pdfDoc) return;

    let cancelled = false;
    const interval = setInterval(() => {
      void (async () => {
        try {
          const stat = await window.eukoliaApi.stat(path);
          if (cancelled || !stat.exists) return;
          if (diskMtimeRef.current !== null && stat.mtimeMs !== diskMtimeRef.current && !reloadingRef.current) {
            // The mtime is remembered before the token changes so a poll that
            // arrives while the re-open is running cannot queue a second one.
            diskMtimeRef.current = stat.mtimeMs;
            setReloadToken((value) => value + 1);
          }
        } catch {
          /* a transient stat failure is not worth reporting */
        }
      })();
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [path, pdfDoc]);

  // ------------------------------------------------------------- page geometry

  const geometryByPage = useMemo(() => {
    const map = new Map<number, PageGeometry>();
    if (!pdfDoc) return map;
    for (const page of layout.pages) {
      if (!page.isShown) continue;
      map.set(page.pageNo, {
        page: page.pageNo,
        zoomReal: page.zoomReal || effectiveScale,
        x: page.pos.x,
        y: page.pos.y,
        width: page.pos.dx,
        height: page.pos.dy,
        sheetWidth: page.size.dx * (page.zoomReal || effectiveScale),
        sheetHeight: page.size.dy * (page.zoomReal || effectiveScale)
      });
    }
    return map;
  }, [layout, pdfDoc, effectiveScale]);

  /** The pages to rasterise at the current scroll offset, nearest first. */
  const visiblePageNumbers = useCallback(
    (scrollTop: number): number[] => {
      const prefetchDistance = setting.num('pdf.renderAheadPages') * ((containerRef.current?.clientHeight ?? 0) || 1);
      return pagesToRender(layout, scrollTop, prefetchDistance);
    },
    [layout]
  );

  // ---------------------------------------------------------------- rendering

  /**
   * Draws a rendered bitmap onto its page's canvas.
   *
   * The outcome is reported rather than assumed, because the two ways this can
   * fail look identical to the reader — a page sheet with its white background
   * and no glyphs — and one of them is worth retrying:
   *
   * - `no-canvas`: the page has no canvas (it is not laid out in this mode, or
   *   the layout changed under the request). The pixels were never shown, so the
   *   caller must not cache them; the next visibility pass will ask again.
   * - `no-context`: the canvas exists but gives no 2D context. Nothing can draw
   *   into it in this document, so the bitmap is still the best answer the viewer
   *   has — but it is said out loud instead of leaving a blank page unexplained.
   *
   * `putImageData` is the blit: no `ImageBitmap` to build and no second copy of a
   * 10 MB page — the renderer's own buffer *is* the canvas's pixels.
   */
  const paint = useCallback(
    (pageNumber: number, image: ImageData, width: number, height: number): 'painted' | 'no-canvas' | 'no-context' => {
      const canvas = canvasRefs.current.get(pageNumber);
      if (!canvas) return 'no-canvas';
      const context = canvas.getContext('2d');
      if (!context) return 'no-context';
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      // The blit replaces every pixel, so clearing first is a second full-surface
      // pass over 10 MB for nothing: `putImageData` is not a composite, it writes
      // the rectangle outright, alpha included. Measured on a 1400x1812 page, the
      // `clearRect` was 34 ms of the 250 ms the pixel path cost a twelve-page
      // scroll, and removing it changes no pixel of the result.
      context.putImageData(image, 0, 0);
      canvas.dataset.painted = '1';
      return 'painted';
    },
    []
  );

  /**
   * The holding pen for canvases whose page has left the mounted window.
   *
   * A page crossing the viewport is unmounted and remounted, and a fresh canvas
   * costs a 10 MB backing-store allocation plus a full `putImageData` of the page
   * (26 ms for a 1400x1812 page, measured): the two most expensive things the
   * viewer does per page crossing, both of them to reproduce pixels it already has.
   *
   * A pool was tried before and measured neutral, but it pooled the wrong thing —
   * a free list of freshly created canvases, which still allocates and still blits.
   * Parking the canvas *with its pixels* removes both: coming back into view is a
   * DOM move.
   *
   * The pen is bounded by pixel count, not by entry count: six page-width canvases
   * at 125 % is 60 MB, which is the price of a page crossing that costs nothing,
   * and a pen of a dozen 4K pages would be a leak.
   */
  const canvasParkRef = useRef<{
    /** The detached box canvases are moved into while their page is not mounted. */
    box: HTMLDivElement | null;
    /** Detached in this commit: a hand-off, not a cache. */
    detached: Map<number, HTMLCanvasElement>;
    /** Pages that really left the window, capped by `CANVAS_PARK_MAX_BYTES`. */
    unmounted: Map<number, HTMLCanvasElement>;
    bytes: number;
  }>({
    box: null,
    detached: new Map(),
    unmounted: new Map(),
    bytes: 0
  });
  /**
   * How the pen is actually being used, written to the scroller as `data-canvas-park`
   * (`unmounted+detached/parks/takes/misses/boxes`). A probe cannot tell "the pen is
   * broken" from "no page has left the window yet" — both leave an empty pen — and
   * this is the count that did.
   */
  const parkStatsRef = useRef({ park: 0, take: 0, miss: 0, noHolder: 0, freshPage: 0 });

  /**
   * Moves a canvas out of the tree without losing its pixels.
   *
   * The canvas goes into a detached box rather than into the shared pen, and the
   * map keeps pointing at it: React calls a ref callback with `null` and then with
   * the element again on every render for which the callback's identity changed, so
   * "detach" almost always means "re-attach in a moment" and a round trip through a
   * shared map is pure overhead. The detached box holds it until the next attach
   * claims it; a canvas nobody claims stays in `unmounted` and is capped there.
   */
  const parkCanvas = useCallback(
    (pageNumber: number, canvas: HTMLCanvasElement) => {
      const pen = canvasParkRef.current;
      if (typeof document === 'undefined') return;
      // Already parked: React calls the detach path more than once for one unmount,
      // and moving it again would only re-append the same node.
      if (pen.detached.get(pageNumber) === canvas) return;
      if (pen.unmounted.get(pageNumber) === canvas) return;
      if (!pen.box || !pen.box.isConnected) {
        const box = document.createElement('div');
        box.dataset.canvasPark = '';
        box.setAttribute('aria-hidden', 'true');
        box.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;contain:strict';
        // Appended after the canvas host, never before it: the scroller's first
        // element child is the canvas host, and a box in front of it moves every
        // page in the document.
        (containerRef.current ?? document.body).appendChild(box);
        pen.box = box;
        parkStatsRef.current.noHolder += 1;
      }
      pen.box.appendChild(canvas);
      pen.detached.set(pageNumber, canvas);
      parkStatsRef.current.park += 1;
      /**
       * The hand-off map is bounded too, because nothing else bounds it.
       *
       * `takeParkedCanvas` drains it whenever a page comes back for a canvas, and
       * during a scroll that happens constantly — but a document that is closed, a
       * display mode that stops showing a page, a list of pages that unmount together
       * and are never asked for again would leave their canvases in here, outside the
       * byte cap that only `unmounted` is subject to. Past a small window, they are
       * candidates rather than hand-offs.
       */
      while (pen.detached.size > CANVAS_PARK_HANDOFF_MAX) {
        const oldest = pen.detached.keys().next();
        if (oldest.done) break;
        if (oldest.value === pageNumber) break;
        const canvasToCap = pen.detached.get(oldest.value);
        pen.detached.delete(oldest.value);
        if (!canvasToCap) continue;
        pen.unmounted.set(oldest.value, canvasToCap);
        pen.bytes += canvasToCap.width * canvasToCap.height * 4;
      }
      // And the byte cap, here rather than only in the take path: a document the
      // reader never scrolls again would otherwise hold every canvas it ever made.
      while (pen.bytes > CANVAS_PARK_MAX_BYTES && pen.unmounted.size > 0) {
        const oldest = pen.unmounted.keys().next();
        if (oldest.done) break;
        const victim = pen.unmounted.get(oldest.value);
        pen.unmounted.delete(oldest.value);
        if (!victim) continue;
        pen.bytes -= victim.width * victim.height * 4;
        victim.remove();
        delete victim.dataset.painted;
      }
    },
    []
  );

  /**
   * The canvas for a page that really did leave the mounted window.
   *
   * `detached` is a short-lived hand-off and must not be treated as a cache — a page
   * crossing the viewport is detached and re-attached in the same commit, and a page
   * that is *gone* has to give its 10 MB back. So a canvas that is still unclaimed
   * when a later attach for a *different* page arrives is moved into `unmounted`,
   * where the byte cap applies.
   */
  const takeParkedCanvas = useCallback((pageNumber: number): HTMLCanvasElement | null => {
    const pen = canvasParkRef.current;
    for (const [other, canvas] of pen.detached) {
      if (other === pageNumber) continue;
      pen.detached.delete(other);
      pen.unmounted.set(other, canvas);
      pen.bytes += canvas.width * canvas.height * 4;
    }
    const canvas = pen.detached.get(pageNumber) ?? pen.unmounted.get(pageNumber) ?? null;
    if (!canvas) {
      parkStatsRef.current.miss += 1;
      return null;
    }
    pen.detached.delete(pageNumber);
    if (pen.unmounted.get(pageNumber) === canvas) {
      pen.unmounted.delete(pageNumber);
      pen.bytes -= canvas.width * canvas.height * 4;
    }
    parkStatsRef.current.take += 1;
    // Bounded: the oldest page in the pen is the least likely to come back.
    while (pen.bytes > CANVAS_PARK_MAX_BYTES && pen.unmounted.size > 0) {
      const oldest = pen.unmounted.keys().next();
      if (oldest.done) break;
      const victim = pen.unmounted.get(oldest.value);
      pen.unmounted.delete(oldest.value);
      if (victim) {
        pen.bytes -= victim.width * victim.height * 4;
        victim.remove();
        delete victim.dataset.painted;
      }
    }
    return canvas;
  }, []);

  /**
   * Hand a canvas to a page.
   *
   * The pixels are what matter, and they are kept in two places: the parked canvas
   * itself (bounded by `CANVAS_PARK_MAX_BYTES`) and the page's `ImageData` in
   * `renderedRef` (bounded by `pdf.maxCachedPages`). A page coming back into view
   * therefore shows its content in the frame it mounts, whether it finds its own
   * canvas in the pen or has to blit the cached pixels into a new one — and only a
   * page the engine has never drawn waits for the engine.
   *
   * That, and asking for the page when there are no pixels to blit, is what stops
   * the blank sheet: nothing used to repaint a remounted canvas — the visibility
   * pass that mounted it had already run, and the interaction flag suppressed the
   * render that would have followed — so the reader saw an empty page until they
   * stopped scrolling. Measured with `.scratch/perf/blank.mjs`: every canvas on
   * screen reported `data-painted` unset and a fully transparent centre pixel,
   * indefinitely.
   */
  const attachPageCanvas = useCallback(
    (pageNumber: number, host: HTMLElement | null) => {
      if (!host) {
        const canvas = canvasRefs.current.get(pageNumber);
        canvasRefs.current.delete(pageNumber);
        if (canvas) {
          canvas.remove();
          // The canvas — and the 10 MB of pixels in it — goes to the holding pen
          // rather than to the garbage collector. See `canvasParkRef`.
          parkCanvas(pageNumber, canvas);
        }
        // The canvas is gone; the *pixels* are still in `renderedRef` and the
        // backing store is in the pen, so the next attach is a move rather than a
        // re-render. The entry's own `image` must not be dropped here — an earlier
        // version cleared it, which turned every remount into a fresh engine round
        // trip and left the page blank for its duration.
        const entry = renderedRef.current.get(pageNumber);
        if (entry) entry.painted = null;
        return;
      }
      /**
       * Re-attach in place.
       *
       * The ref is stable (`attachCanvasRef`), so React no longer detaches and
       * re-attaches it on every render — but this is the branch that made that
       * difference measurable, and it is what makes a genuine remount cheap. Before
       * it, a sixty-notch scroll reported **76 detach/re-attach cycles for six
       * pages**, each one a fresh 10 MB backing store and a full re-blit; with it,
       * the same scroll reports none. A canvas that is already in this host is a
       * no-op; one that is in the pen's detached box is a DOM move.
       *
       * The test is the parent, not `isConnected`: a callback ref element is not
       * necessarily connected yet at the moment React calls it, and a test harness
       * that renders into a detached container would never connect it at all.
       */
      const existing = canvasRefs.current.get(pageNumber);
      if (existing) {
        if (existing.parentElement !== host) host.replaceChildren(existing);
        canvasParkRef.current.detached.delete(pageNumber);
        return;
      }
      /**
       * A parked canvas is reattached as it is: its pixels are still in it, so the
       * page is on screen in the frame it mounts — no allocation of a 10 MB backing
       * store, no re-blit of the `ImageData` (measured at 26 ms for a 1400x1812
       * page), and no flash of an empty sheet.
       */
      const parked = takeParkedCanvas(pageNumber);
      if (parked) {
        host.replaceChildren(parked);
        canvasRefs.current.set(pageNumber, parked);
        const entry = renderedRef.current.get(pageNumber);
        if (entry) entry.painted = entry.key;
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      host.replaceChildren(canvas);
      canvasRefs.current.set(pageNumber, canvas);
      parkStatsRef.current.freshPage += 1;

      const entry = renderedRef.current.get(pageNumber);
      if (!entry || !entry.image) {
        // No pixels for this page yet: ask, and let the pass decide whether the
        // request is one the engine should be given right now.
        if (entry) entry.painted = null;
        renderPageRef.current?.(pageNumber);
        return;
      }
      /**
       * Pixels exist. Blit them in this frame, before the page can be painted
       * empty by the compositor, and only then ask whether they are still the
       * right scale.
       */
      const painted = paint(pageNumber, entry.image, entry.width, entry.height);
      if (painted !== 'no-canvas') entry.painted = entry.key;
      renderPageRef.current?.(pageNumber);
    },
    [paint, parkCanvas, takeParkedCanvas]
  );

  /**
   * The queue of bitmaps waiting for a frame to be drawn in.
   *
   * `drawImage` of a whole page is a millisecond or three, and renders land in
   * bursts — three pages of a scroll arriving in the same frame is a frame over
   * budget (measured: a 13.9–20.8 ms frame in an otherwise vsync-locked scroll,
   * which is exactly one dropped frame). Draining one page per frame spreads that
   * work over frames the compositor is not already busy with, and costs a page at
   * most a frame of latency. Measured over three scrolls that each rasterised a
   * page mid-flight: worst frame 7.7 ms, against 13.9–20.8 ms before.
   *
   * The timer is the fallback, not the mechanism: a `requestAnimationFrame` that
   * never runs (a window the compositor has stopped drawing, jsdom in the tests)
   * must not leave a page blank — the queue has to make progress either way, and
   * whichever trigger fires first cancels the other.
   */
  const paintQueueRef = useRef<Array<() => void>>([]);
  const paintScheduledRef = useRef(false);
  const schedulePaint = useCallback((job: () => void) => {
    paintQueueRef.current.push(job);
    if (paintScheduledRef.current) return;
    function pump(): void {
      if (!paintScheduledRef.current) return; // the other trigger already ran
      paintScheduledRef.current = false;
      const next = paintQueueRef.current.shift();
      if (next) next();
      // The rest waits for the next frame: one whole-page blit per frame is the
      // point of the queue.
      if (paintQueueRef.current.length > 0) arm();
    }
    function arm(): void {
      paintScheduledRef.current = true;
      const frame = requestAnimationFrame(() => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        pump();
      });
      const timer = setTimeout(pump, PAINT_FALLBACK_MS);
    }
    arm();
  }, []);

  const renderPage = useCallback(
    async (page: PageGeometry): Promise<void> => {
      if (!path || !pdfDoc) return;
      /**
       * Nothing is rasterised while the *scale* is moving.
       *
       * A divider drag changes the fit scale every frame, and each of those scales
       * is a whole-page MuPDF render: measured in the running application, one
       * 30-step drag asked the engine for **35 rasterisations** and ran 26
       * visibility passes. None of them was ever seen — the drag ends on a
       * different scale than every one of them — but they saturate the engine for
       * the whole gesture, which is what makes the pane feel heavy, and the bitmap
       * that finally lands is for a scale the drag passed through rather than for
       * the one it stopped on.
       *
       * The page does not go blank in the meantime: the canvas keeps its pixels and
       * the compositor scales them to the sheet for free. `settle` asks for the
       * real thing, once, when the movement stops.
       *
       * A *scroll* is deliberately not this. It invalidates no bitmap, and it is the
       * one gesture where a page really can have nothing to show — the page arriving
       * at the edge of the viewport is either new or re-mounted with a bare canvas.
       * Suppressing renders for it is what left those pages blank while the reader
       * was looking at them (see `attachPageCanvas`).
       */
      if (resizingRef.current) return;
      // One device pixel per PDF point per CSS pixel, so the canvas draws the
      // bitmap 1:1. `pdfRenderScale` owns that product; `pdf-text-layer.ts`
      // documents why it is `zoomReal * dpr` and not something else. The only
      // ceiling is the whole-page allocation guard (`LIGHTPDF_MAX_RENDER_SCALE`),
      // which never binds in normal reading and is reported when it does — a page
      // must not be quietly softer than the display can show.
      const devicePixelRatio = canvasDevicePixelRatio;
      const scale = pdfRenderScale(page.zoomReal, devicePixelRatio, LIGHTPDF_MAX_RENDER_SCALE);
      const key = `${page.page}:${scale.toFixed(4)}:${invertColors ? 1 : 0}`;
      const cacheKey = `${page.page}`;
      const cached = renderedRef.current.get(page.page);

      if (cached && cached.key === key && cached.image && cached.painted !== key) {
        const cachedOutcome = paint(page.page, cached.image, cached.width, cached.height);
        if (cachedOutcome !== 'no-canvas') {
          cached.painted = key;
          setPaintStatus(
            cachedOutcome === 'painted'
              ? `page ${page.page} drawn ${cached.width}x${cached.height}`
              : `page ${page.page}: no 2D context, ${cached.width}x${cached.height} not drawn`
          );
          return;
        }
        // The cached pixels never reached a canvas — the page is not laid out any
        // more. Drop the entry so the request below asks the engine again, instead
        // of "painting" the same undrawn bitmap on every pass and leaving the
        // reader with a white sheet and no explanation.
        renderedRef.current.delete(page.page);
        setPaintStatus(`page ${page.page}: no canvas in this layout`);
        setRenderStatus(`retrying page ${page.page}: it has no canvas in this layout`);
      }

      // The canvas already holds this page at this scale: re-blitting the same
      // pixels is work with nothing to show for it, and a scroll runs this pass
      // repeatedly.
      if (cached && cached.key === key && cached.image && cached.painted === key) return;

      const existing = inFlightRef.current.get(cacheKey);
      if (existing) {
        /**
         * A request for the same page at the same scale: leave it alone — cancelling
         * and restarting it would mean nothing ever completes when the visibility
         * pass runs more than once.
         *
         * A request for a *different* scale (a zoom, or the end of a resize) is
         * obsolete, and the slot is taken over. Dropping the new request instead —
         * which is what this branch used to do — is one of the ways a page stayed
         * soft: the older render landed, painted its own scale, and no further pass
         * was coming to ask for the scale the layout had moved to.
         */
        if (existing.key === key) return;
        void window.eukoliaApi.pdfCancelRender(existing.requestId).catch(() => undefined);
        setRenderStatus(`superseded page ${page.page} (r${existing.requestId})`);
      }

      const requestId = nextRequestId();
      inFlightRef.current.set(cacheKey, { requestId, key });
      renderAttemptsRef.current += 1;
      setRenderStatus(`requested page ${page.page} (r${requestId})`);

      try {
        const result: PdfRenderResult = await window.eukoliaApi.pdfRender({
          requestId,
          path,
          page: page.page - 1,
          scale,
          invert: invertColors,
          allowCache: true
        });

        if (inFlightRef.current.get(cacheKey)?.requestId !== requestId) {
          setRenderStatus(`superseded page ${page.page} (r${requestId})`);
          return; // superseded: the slot now belongs to a newer request
        }

        const image = toImageData(result);
        // The in-flight marker is deliberately *not* cleared before the bitmap is
        // cached: a visibility pass that ran while the bitmap was being decoded
        // would see neither an in-flight request nor a cached bitmap and ask for
        // the same page a second time.
        if (inFlightRef.current.get(cacheKey)?.requestId !== requestId) {
          setRenderStatus(`discarded page ${page.page} (r${requestId})`);
          return;
        }

        /**
         * The bitmap is cached now and *drawn* on the next free frame.
         *
         * Renders arrive in bursts — three pages of a scroll finishing together is
         * three whole-page `drawImage` calls in one frame, which is one dropped
         * frame in an otherwise vsync-locked scroll (measured: 13.9–20.8 ms against
         * a 6.9 ms cadence). Drawing one page per frame spreads that work, and the
         * record says `painted: null` until the queue has drawn it, so a visibility
         * pass in between cannot conclude the canvas already holds these pixels.
         */
        renderedRef.current.set(page.page, {
          key,
          image,
          width: result.width,
          height: result.height,
          // The scale the pixels were actually produced at: the render's own
          // scale, which is what decides whether the canvas can be blitted 1:1
          // (`canvasDisplayBox`).
          scale,
          painted: null,
          requestId
        });
        schedulePaint(() => {
          const entry = renderedRef.current.get(page.page);
          // Superseded between the queue and the frame: the canvas must show the
          // newest pixels, not merely the first ones that were ready.
          if (!entry || entry.image !== image || entry.key !== key) return;
          const painted = paint(page.page, image, result.width, result.height);
          if (painted === 'no-canvas') {
            // The page left the layout before its frame came round. Nothing was
            // drawn, so nothing stays cached: the next pass asks again.
            if (renderedRef.current.get(page.page) === entry) {
              renderedRef.current.delete(page.page);
            }
            setPaintStatus(`page ${page.page}: no canvas for ${result.width}x${result.height}`);
            setRenderStatus(`failed page ${page.page}: no canvas for ${result.width}x${result.height}`);
            return;
          }
          if (painted === 'painted') entry.painted = key;
          setPaintStatus(
            painted === 'painted'
              ? `page ${page.page} drawn ${result.width}x${result.height}`
              : `page ${page.page}: no 2D context, ${result.width}x${result.height} not drawn`
          );
          setRenderStatus(`painted page ${page.page} ${result.width}x${result.height}`);
        });
      } catch (err) {
        // A cancelled render rejects; that is expected and must stay quiet.
        // Anything else is a real failure and is surfaced in the pane as well as
        // reported upward, so a blank page is never left unexplained.
        const message = err instanceof Error ? err.message : String(err);
        if (!/cancel/i.test(message)) {
          setError(message);
          onErrorRef.current?.(message);
        }
        setRenderStatus(`failed page ${page.page}: ${message}`);
      } finally {
        if (inFlightRef.current.get(cacheKey)?.requestId === requestId) inFlightRef.current.delete(cacheKey);
      }
    },
    [path, pdfDoc, invertColors, paint, schedulePaint, canvasDevicePixelRatio]
  );

  /**
   * `renderPage` by page number, for callers that only know which page they need.
   *
   * A ref, because the caller is `attachPageCanvas`, which is a React ref callback
   * declared above `renderPage` and must not be rebuilt when `renderPage`'s
   * dependencies change — a ref callback whose identity changes is detached and
   * re-attached by React, which would recreate every page canvas on every render.
   */
  const renderPageRef = useRef<((pageNumber: number) => void) | null>(null);
  renderPageRef.current = (pageNumber: number) => {
    const geometry = geometryByPage.get(pageNumber);
    if (geometry) void renderPage(geometry);
  };

  /**
   * Stable ref callbacks, built once.
   *
   * React compares a ref by identity and detaches the old one — calling it with
   * `null` — whenever it changes. An inline `ref={(el) => attach(el, page)}` is a new
   * function on every render, so a viewer that re-renders on every page crossing
   * detaches and re-attaches every mounted page's canvas and text layer with it:
   * 282 mutation records for a sixty-notch scroll, 132 of them these two. Each one is
   * a DOM move inside the scroller, which invalidates paint for the frame it lands
   * in — work caused by the shape of the code rather than by anything the reader did.
   *
   * The page number comes from the element's own `data-page`, which is what makes one
   * callback serve every page.
   */
  const attachCanvasRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const pageNumber = Number(element.dataset.canvasFor || 0);
      if (pageNumber > 0) attachPageCanvas(pageNumber, element);
    },
    [attachPageCanvas]
  );
  const attachTextRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const pageNumber = Number(element.dataset.textLayer || 0);
    if (pageNumber > 0) textRefs.current.set(pageNumber, element);
  }, []);

  /** Chooses which pages to render now and which to prefetch. */  const updateVisiblePages = useCallback(() => {
    updateCallsRef.current += 1;
    const container = containerRef.current;
    if (!container || pageCount === 0) return;

    const scrollTop = container.scrollTop;
    const ordered = visiblePageNumbers(scrollTop);
    const visible = new Set<number>();

    // Pages actually touching the viewport (the prefetch window is only for
    // rendering, exactly as `PageVisible`/`PageVisibleNearby` differ in light-pdf).
    for (const pageNo of ordered) {
      if (pageVisibleAt(layout, pageNo, scrollTop)) visible.add(pageNo);
    }

    visiblePagesRef.current = visible;

    /**
     * The mounted window is the render window.
     *
     * `ordered` is every page that touches the viewport plus the prefetch
     * lookahead, so mounting exactly it means a page gets its DOM a whole viewport
     * before it is seen, and the DOM of a 200-page document is the same size as
     * that of a three-page one. Updating the state *only when the set changes* is
     * what keeps the cost on the scroll path proportional to the crossing rather
     * than to the document: one page remounts, not the document.
     *
     * Nothing else here re-renders React: the pass exists to mount what is coming,
     * unmount what has gone and ask for the bitmaps — the scroll path's own
     * `data-` attributes are written imperatively.
     */
    const window = new Set(ordered);
    setMountedPageNumbers((previous) => {
      if (previous.size === window.size) {
        let same = true;
        for (const pageNo of window) {
          if (!previous.has(pageNo)) {
            same = false;
            break;
          }
        }
        if (same) return previous;
      }
      return window;
    });

    for (const pageNo of ordered) {
      const page = geometryByPage.get(pageNo);
      if (page) void renderPage(page);
    }

    // Evict far-away bitmaps so memory stays bounded.
    const maxCached = setting.num('pdf.maxCachedPages');
    if (renderedRef.current.size > maxCached) {
      const keep = new Set(ordered.slice(0, maxCached));
      for (const [pageNumber, rendered] of renderedRef.current) {
        if (keep.has(pageNumber)) continue;
        if (Math.abs(pageNumber - currentPage) <= CACHE_RADIUS) continue;
        
        renderedRef.current.delete(pageNumber);
      }
    }
  }, [pageCount, visiblePageNumbers, layout, geometryByPage, renderPage, currentPage]);

  /**
   * The end of an interaction: one pass, at the scale the reader stopped on.
   *
   * This is also what makes the *final* frame correct rather than lucky. The
   * interaction suppresses rasterisation, so the last thing that happened before
   * this was a layout change with no render for it; the pass re-requests whatever
   * is not at the current scale and re-blits whatever is, and `setVersion` rebuilds
   * the text layer, which was skipped for the same reason.
   */
  useEffect(() => {
    settleRef.current = () => {
      interactingRef.current = false;
      resizingRef.current = false;
      updateVisiblePages();
      setVersion((value) => value + 1);
    };
  }, [updateVisiblePages]);

  // Re-render when the scale, the layout, the display mode or the display's own
  // scale factor changes: a window moved to a display with a different DPR needs
  // every page rasterised again at the new resolution, not merely re-measured.
  useEffect(() => {
    updateVisiblePages();
  }, [updateVisiblePages, effectiveScale, pdfDoc, rotation, resolvedDisplayMode, canvasDevicePixelRatio]);

  /**
   * The scroll range follows the content, so it is re-read whenever the content can
   * have changed — a new document, a new layout, a new viewport — and never on a
   * scroll frame. Passive on purpose: it runs after the frame that changed the
   * layout, so the read never forces layout inside a commit.
   */
  useEffect(() => {
    refreshScrollRange();
  }, [refreshScrollRange, layout, containerSize.ready, containerSize.width, containerSize.height, pdfDoc, scroller]);

  /**
   * The pages that get DOM — which is not the same set as the pages that are
   * *laid out*.
   *
   * The layout positions every page (cheap arithmetic, and the canvas host's size
   * is what gives the scroller its range), but a 200-page document does not need
   * 200 page elements: light-pdf draws into one window and blits cached bitmaps, so
   * its per-frame cost has nothing to do with the page count. Mounting a div, a
   * canvas and a text layer per page puts that cost straight into the browser's
   * style, layout and paint work on every scroll frame — measured on a 200-page
   * document, the p99 frame was 14 ms and the worst 34.7 ms against a 6.9 ms
   * cadence, while the three-page fixture stayed at 7.5 ms.
   *
   * The window is the one `updateVisiblePages` already computes for rendering —
   * the pages that touch the viewport plus `pdf.renderAheadPages` viewports of
   * lookahead — so what is mounted is what is rendered, with no second policy to
   * keep in step, and a page is mounted a whole viewport before it is seen.
   *
   * Declared *here*, with the other hooks, and that is not a style choice: it used
   * to sit below the `!path` early return, which meant the viewer called one more
   * hook the moment it was given a path than it had while it was showing "No PDF
   * yet." — React error #310, "Rendered more hooks than during the previous
   * render", which unmounts the whole tree and leaves a blank window. That is
   * exactly what opening a PDF from an already-open pane did, and the packaged
   * app's log said so in as many words.
   */
  const shownPages = useMemo(() => layout.pages.filter((page) => page.isShown), [layout]);
  const mountedPages = useMemo(() => {
    if (mountedPageNumbers.size === 0) {
      // Before the first visibility pass there is no window yet; one page is enough
      // to establish the layout and the scroll range, and the pass that runs in the
      // same commit fills the rest in.
      const first = shownPages[0];
      return first ? [first] : [];
    }
    return shownPages.filter((page) => mountedPageNumbers.has(page.pageNo));
  }, [shownPages, mountedPageNumbers]);

  /**
   * The diagnostics that change with every render request and every frame, written
   * to the DOM rather than through React.
   *
   * All of them are read back out of the attributes by probes and by the smoke
   * harness, and none is ever rendered — but as React state or props each change
   * re-rendered the viewer, which on a 200-page document put React's scheduler at
   * the top of the scroll profile (`performWorkUntilDeadline`, 5–12 ms a commit).
   * This effect runs after a commit and writes the current values, so the
   * attributes are correct whenever the DOM is read, and a change that happens
   * between commits (a paint landing mid-scroll) costs one property write instead
   * of a re-render. It is declared here, with the other effects, because a hook
   * below the viewer's early return would be called on some renders and not
   * others.
   */
  useEffect(() => {
    const scroller = containerRef.current;
    if (!scroller) return;
    scroller.dataset.renderStatus = renderStatusRef.current;
    scroller.dataset.paintStatus = paintStatusRef.current;
    scroller.dataset.renderAttempts = String(renderAttemptsRef.current);
    scroller.dataset.updateCalls = String(updateCallsRef.current);
    scroller.dataset.visiblePages = String(visiblePagesRef.current.size);
    scroller.dataset.selectionLength = String(selection?.text.length ?? 0);
    scroller.dataset.currentPage = String(currentPage);
    const park = parkStatsRef.current;
    scroller.dataset.canvasPark = `${canvasParkRef.current.unmounted.size}+${canvasParkRef.current.detached.size}/${park.park}/${park.take}/${park.miss}/${park.noHolder}`;
  });

  // --------------------------------------------------------- view state / layout
  //
  // Every explicit view change follows `DisplayModel`: capture the `ScrollState`,
  // let the layout change, then restore the state (and, for a wheel zoom, the
  // pixel under the cursor) once the new geometry exists.

  /**
   * `DisplayModel::GetScrollState`, in the viewer's terms: the current page plus
   * the offset to its top-left corner in page space, with an axis at `-1` when
   * that page has not been scrolled past the viewport edge in it.
   */
  const currentScrollState = useCallback((): LightPdfScrollState => {
    const container = containerRef.current;
    const page = layout.pages[currentPage - 1];
    if (!container || !page || !page.isShown) return { page: currentPage, x: -1, y: -1 };
    return scrollStateFromOffset(
      [{ pageNo: page.pageNo, x: page.pos.x, y: page.pos.y, dx: page.pos.dx, dy: page.pos.dy, zoomReal: page.zoomReal }],
      container.scrollTop,
      container.scrollLeft,
      currentPage
    );
  }, [layout, currentPage]);

  /** `GetScrollState` at the point a page begins, for history comparisons. */
  const scrollStateKey = (state: LightPdfScrollState): string =>
    `${state.page}:${state.x < 0 ? 'm' : Math.round(state.x)}:${state.y < 0 ? 'm' : Math.round(state.y)}`;

  /**
   * `IsMeaningfullyDifferentNavScrollState`: a different page, or more than half
   * a viewport away in either axis.
   */
  const meaningfullyDifferent = useCallback(
    (a: LightPdfScrollState, b: LightPdfScrollState): boolean => {
      if (a.page <= 0 || b.page <= 0) return true;
      if (a.page !== b.page) return true;
      const container = containerRef.current;
      const minDx = Math.max(32, (container?.clientWidth ?? 0) * 0.5);
      const minDy = Math.max(32, (container?.clientHeight ?? 0) * 0.5);
      const ax = a.x < 0 ? 0 : a.x;
      const bx = b.x < 0 ? 0 : b.x;
      const ay = a.y < 0 ? 0 : a.y;
      const by = b.y < 0 ? 0 : b.y;
      return Math.abs(ax - bx) > minDx || Math.abs(ay - by) > minDy;
    },
    []
  );

  /**
   * `DisplayModel::AddNavPoint`.
   *
   * `entries[0 .. index - 1]` are the Back entries and `entries[index ..]` the
   * Forward ones, which is exactly what `navHistoryIdx` means in light-pdf: the
   * entry the cursor sits *after*. Appending truncates the Forward tail, and an
   * entry equal to the one behind the cursor is not repeated.
   */
  const addNavPoint = useCallback(
    (state?: LightPdfScrollState) => {
      const history = historyRef.current;
      const next = state ?? currentScrollState();
      if (next.page <= 0) return;
      history.entries = history.entries.slice(0, Math.max(0, history.index));
      if (history.index > 0 && history.entries[history.index - 1] && scrollStateKey(history.entries[history.index - 1]) === scrollStateKey(next)) {
        return;
      }
      if (history.index >= MAX_NAV_HISTORY_LEN) {
        history.entries = history.entries.slice(history.entries.length - MAX_NAV_HISTORY_LEN + 1);
        history.index = MAX_NAV_HISTORY_LEN - 1;
      }
      history.entries.push(next);
      history.index += 1;
      setHistoryVersion((value) => value + 1);
    },
    [currentScrollState]
  );

  /**
   * `ShouldCommitStableNavPointBeforeViewChange`: remember the view the user
   * dwelled on, so Back reaches it, without recording every intermediate scroll.
   */
  const beforeViewChange = useCallback(() => {
    const history = historyRef.current;
    const current = currentScrollState();
    if (current.page <= 0) return;
    const now = Date.now();
    if (!history.pending) {
      history.pending = current;
      history.pendingAt = now;
      history.lastCommitted = current;
      addNavPoint(current);
      return;
    }
    if (meaningfullyDifferent(current, history.pending)) {
      history.pending = current;
      history.pendingAt = now;
      return;
    }
    if (now - history.pendingAt < STABLE_NAV_POINT_DELAY_MS) return;
    if (history.lastCommitted && !meaningfullyDifferent(current, history.lastCommitted)) return;
    history.lastCommitted = current;
    addNavPoint(current);
  }, [currentScrollState, addNavPoint, meaningfullyDifferent]);

  /** `RememberStableNavPointCandidateAfterViewChange`. */
  const afterViewChange = useCallback(() => {
    const state = currentScrollState();
    if (state.page <= 0) return;
    historyRef.current.pending = state;
    historyRef.current.pendingAt = Date.now();
  }, [currentScrollState]);

  /** Scene change of zoom / display mode, keeping light-pdf's anchor. */
  const beginViewChange = useCallback(() => {
    beforeViewChange();
    pendingScrollStateRef.current = currentScrollState();
  }, [beforeViewChange, currentScrollState]);

  /** `SetScrollState`: restore the captured view once the new layout exists. */
  useEffect(() => {
    const state = pendingScrollStateRef.current;
    if (!state || pageCount === 0) return;
    const page = geometryByPage.get(state.page);
    if (!page || !(page.width > 0) || !(page.height > 0)) {
      // The layout has not reached this page yet, or the viewport has not been
      // measured: keep the state for the layout that can honour it.
      return;
    }
    pendingScrollStateRef.current = null;
    const container = containerRef.current;
    if (!container) return;
    const target = scrollOffsetForRestoredState(page.y, page.x, state, page.zoomReal, PAGE_MARGIN_TOP);
    container.scrollTo({ top: target.top, left: target.left, behavior: 'auto' });
    scrollRef.current = { x: container.scrollLeft, y: container.scrollTop };
  }, [geometryByPage, pageCount]);

  // `SetZoomVirtual`'s fix point: put the pixel that was under the cursor back
  // where it was (CvtFromScreen before, CvtToScreen after, then ScrollXBy/YBy).
  useEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    const container = containerRef.current;
    if (!anchor || !container) return;
    pendingZoomAnchorRef.current = null;
    const element = container.querySelector(`[data-page="${anchor.page}"]`) as HTMLElement | null;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const ratio = effectiveScale / (anchor.scale || effectiveScale);
    const swapAxes = anchor.rotation === 90 || anchor.rotation === 270;
    const offsetX = (swapAxes ? anchor.offsetY : anchor.offsetX) * ratio;
    const offsetY = (swapAxes ? anchor.offsetX : anchor.offsetY) * ratio;
    const dx = rect.left + offsetX - anchor.clientX;
    const dy = rect.top + offsetY - anchor.clientY;
    if (dx !== 0) container.scrollLeft = container.scrollLeft + dx;
    if (dy !== 0) container.scrollTop = container.scrollTop + dy;
    scrollRef.current = { x: container.scrollLeft, y: container.scrollTop };
  }, [effectiveScale, geometryByPage]);

  // Restore a remembered view on open, once the layout and page sizes exist.
  useEffect(() => {
    const state = restoreStateRef.current;
    const container = containerRef.current;
    if (!state || !container || pageCount === 0) return;
    const page = geometryByPage.get(state.page);
    // A page with no box yet means the viewport has not been measured (a pane
    // that is still hidden or zero-sized). Keep the state and apply it to the
    // first layout that has a real size, rather than scrolling to a position
    // computed from a degenerate one.
    if (!page || !(page.width > 0) || !(page.height > 0)) return;
    restoreStateRef.current = null;
    const target = scrollOffsetForRestoredState(page.y, page.x, state, page.zoomReal, PAGE_MARGIN_TOP);
    container.scrollTo({ top: target.top, left: target.left, behavior: 'auto' });
    scrollRef.current = { x: container.scrollLeft, y: container.scrollTop };
    onPageChangeRef.current?.(state.page, pageCount);
  }, [geometryByPage, pageCount]);

  // Remember the view per document, as `GetDisplayState` does before a save.
  //
  // The payload is kept in a ref refreshed on every scroll and navigation: React
  // detaches the callback ref (and therefore `containerRef.current`) before the
  // passive cleanup runs, so reading the scroller there would save a scroll
  // position that never existed.
  const savedViewRef = useRef<{ page: number; x: number; y: number }>({ page: 1, x: -1, y: -1 });

  // Kept in step on every render, not only on scroll: a page jump changes the
  // remembered view without a scroll event (`PageNoChanged`).
  useEffect(() => {
    if (pageCount === 0 || !containerRef.current) return;
    const state = currentScrollState();
    if (state.page <= 0) return;
    savedViewRef.current = { page: state.page, x: state.x, y: state.y };
  });

  useEffect(() => {
    if (!path || !pdfDoc) return;
    return () => {
      const saved = savedViewRef.current;
      rememberLightPdfState({
        path,
        displayMode: resolvedDisplayMode,
        zoom: scaleRef.current,
        zoomMode,
        rotation,
        pageNo: saved.page,
        scrollPos: { x: saved.x, y: saved.y }
      });
    };
  }, [path, pdfDoc, resolvedDisplayMode, zoomMode, rotation]);

  // -------------------------------------------------------- navigation history

  /**
   * The scroll path, in two halves.
   *
   * A scroll event does the cheap part and gets out of the way: it asks for one
   * frame of work, re-arms the render pass, and marks the interaction. Everything
   * derived from the offset — which page is current, the page-space position the
   * view is remembered at, the scrollbar's thumb — happens once per *frame*, and
   * only the parts that changed reach React.
   *
   * This is the shape of light-pdf's own scroll path: `CanvasOnMouseWheel` does
   * offset arithmetic, updates the scrollbar and posts a repaint
   * (`Canvas.cpp:2553-2774` → `ScheduleRepaint`, `LightPDF.cpp:938`), and the work
   * that depends on the new offset happens when that posted task is drained
   * (`OnTimer` → `WM_PAINT` → `OnPaintDocument`), never inside the input event.
   * A browser fires a scroll event per frame during a glide, so doing per-event
   * work here is doing it per frame with extra steps — and on a 200-page document
   * it measured as 996 ms of scripting plus 580 ms of garbage collection in a
   * 6.4 s scroll, with individual 4–5 ms `MajorGC` pauses landing as dropped
   * frames.
   */
  const frameWorkRef = useRef(0);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const pageCountRef = useRef(pageCount);
  pageCountRef.current = pageCount;

  const runScrollFrame = useCallback(() => {
    frameWorkRef.current = 0;
    const container = containerRef.current;
    if (!container) return;
    const scrollTop = container.scrollTop;
    const scrollLeft = container.scrollLeft;
    scrollRef.current.x = scrollLeft;
    scrollRef.current.y = scrollTop;

    const state = layoutRef.current;
    const page = currentPageAt(state, scrollTop, scrollLeft);
    if (page !== currentPageRef.current) {
      // Written before the state update so a second frame in the same burst does
      // not repeat the whole computation for an answer it already has.
      currentPageRef.current = page;
      setCurrentPage(page);
      // The document's page count, not the number of pages laid out: light-pdf
      // reports `PageCount()` and the toolbar shows that total.
      onPageChangeRef.current?.(page, pageCountRef.current);
    }

    // `GetScrollState`: the offset in page space, with an axis left at -1 when the
    // page was not scrolled past the viewport edge in it. Found by walking from the
    // page the viewport starts on rather than by scanning the document.
    //
    // The walk starts at the page the viewport starts on, which is a binary search
    // and not an assumption: the layout orders the pages by their top edge, which is
    // the ordering `currentPageAt` and `pagesToRender` already search. It used to
    // start at zero — the comment above was the intent, the code was not — and in
    // continuous display every page is `isShown`, so the loop ran once per page
    // *above* the viewport on every scroll frame: four hundred iterations a frame,
    // per frame, at page four hundred of a five-hundred-page document, in the one
    // function whose whole purpose is to stay proportional to what is visible.
    const pages = state.pages;
    let low = 0;
    let high = pages.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (pages[mid].pos.y + pages[mid].pos.dy <= scrollTop) low = mid + 1;
      else high = mid;
    }
    // Every page from `low` on ends below the viewport top, so the first shown one
    // is the answer — the same page the scan from zero arrived at.
    let index = low;
    while (index < pages.length && !pages[index].isShown) index += 1;
    const firstVisible = pages[index];
    if (firstVisible && firstVisible.zoomReal > 0) {
      const saved = savedViewRef.current;
      saved.page = firstVisible.pageNo;
      saved.x = firstVisible.pos.x <= scrollLeft ? (scrollLeft - firstVisible.pos.x) / firstVisible.zoomReal : -1;
      saved.y = firstVisible.pos.y <= scrollTop ? (scrollTop - firstVisible.pos.y) / firstVisible.zoomReal : -1;
    }
  }, []);

  const scheduleScrollFrame = useCallback(() => {
    if (frameWorkRef.current) return;
    frameWorkRef.current = requestAnimationFrame(runScrollFrame);
  }, [runScrollFrame]);

  // Scroll handling: record the offset, then do the work on the next frame.
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || pageCountRef.current === 0) return;
    scrollRef.current.x = container.scrollLeft;
    scrollRef.current.y = container.scrollTop;
    scheduleScrollFrame();

    if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    renderTimerRef.current = setTimeout(() => {
      renderTimerRef.current = null;
      updateVisiblePages();
    }, 60);

    // A scroll is an interaction, and the one kind that is allowed to rasterise
    // while it runs: pages coming into view have no bitmap to show at all, so the
    // passes are throttled rather than withheld (see `markInteracting`).
    //
    // Unless the viewer itself asked for this scroll: a page jump, a search hit or a
    // restored view must show its content immediately, not after the settle.
    if (performance.now() >= programmaticScrollUntilRef.current) markInteracting(true);
  }, [scheduleScrollFrame, updateVisiblePages, markInteracting]);  // -------------------------------------------------------------------- search

  const publishSearchState = useCallback((index: number, total: number) => {
    onSearchStateRef.current?.(index, total);
  }, []);

  // ---------------------------------------------------------------- navigation

  /** `ValidPageNo` — the document's page count, never the pages laid out so far. */
  const pageLimit = useCallback(() => pageCount || layout.pages.length || 1, [pageCount, layout.pages.length]);

  /**
   * Cancels any in-flight momentum. Declared as a ref because `stopSmoothScroll`
   * lives further down the file than the navigation callbacks that need it, and a
   * `useCallback` that closed over it directly would have to be rebuilt whenever
   * it changed.
   */
  const cancelMomentumRef = useRef<() => void>(() => undefined);

  const scrollToOffset = useCallback((top: number, left?: number) => {
    const container = containerRef.current;
    if (!container) return;
    // A navigation is a decision about where the view should be, so it ends any
    // momentum still gliding towards where the *wheel* last pointed. Two animation
    // policies aimed at one scroller is the one thing that makes smooth scrolling
    // feel worse than none: the browser's own animation for `behavior: 'smooth'`
    // below and the integrator's per-frame writes fight over the same offset.
    // `Canvas.cpp:2450-2454` does the same on a view change, zeroing both the
    // velocity and the exact offset.
    cancelMomentumRef.current();
    /**
     * A navigation scroll is not an *interaction*.
     *
     * It arrives as a scroll event like any other, and marking it as one would hold
     * the target page's bitmap back until the settle — a page jump that takes
     * 200 ms to show its own content, for no gain: the reader asked for that page
     * and is not dragging anything. The window is a timestamp rather than a flag
     * because a `behavior: 'smooth'` scroll reports over several frames.
     */
    programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_MS;
    container.scrollTo({
      // `Canvas.cpp:653-693` — with the page slider up, `SB_THUMBTRACK`'s
      // `si.nTrackPos` *is* the page number, so the bar's position is the page
      // rather than a page-space offset, and `nPage` is one page.
      top: Math.max(0, pageSliderRef.current ? currentPageRef.current - 1 : top),
      ...(left === undefined ? {} : { left: Math.max(0, left) }),
      behavior: setting.bool('scrolling.smooth') ? 'smooth' : 'auto'
    });
    scrollRef.current = { x: container.scrollLeft, y: container.scrollTop };
  }, []);

  /**
   * `DisplayModel::GoToPage(pageNo, scrollY, addNavPt, scrollX)`.
   *
   * This is the navigation fix: the target is always defined. The layout lays out
   * *every* page in the continuous modes, so a page's position is known and the
   * viewport is scrolled to `pos.y - windowMargin.top + scrollY`; in single page,
   * facing and book view only the current row has a position, so going to a page
   * moves the layout's start page (`ChangeStartPage`) and the row is laid out
   * around the requested page before the scroll is applied. There is no path on
   * which the requested page simply has no geometry.
   */
  const goToPage = useCallback(
    (page: number, options: { scrollY?: number; record?: boolean } = {}) => {
      const container = containerRef.current;
      const limit = pageLimit();
      const requested = Math.round(page);
      if (!Number.isFinite(requested)) return;
      const target = Math.min(limit, Math.max(1, requested));

      if (options.record !== false) beforeViewChange();

      const columns = columnsFromDisplayMode(resolvedDisplayMode);
      const showCover = isBookViewDisplayMode(resolvedDisplayMode);
      // In facing/book view a row starts at `FirstPageInARowNo`.
      const rowFirst = isSingleDisplayMode(resolvedDisplayMode) ? target : firstPageInARowNo(target, columns, showCover);

      if (!isContinuousDisplayMode(resolvedDisplayMode)) {
        // `ChangeStartPage` — the canvas is rebuilt around `rowFirst`, so the page
        // gets its geometry on the next layout rather than not at all.
        setStartPage(rowFirst);
        setCurrentPage(rowFirst);
        onPageChangeRef.current?.(rowFirst, pageCount);
        scrollToOffset(options.scrollY ?? 0, 0);
        afterViewChange();
        return;
      }

      const geometry = geometryByPage.get(target);
      let top: number;
      if (geometry) {
        const page = layout.pages[target - 1];
        const clamped = Math.max(0, Math.min(layout.canvasSize.dy - layout.viewPort.dy, page.pos.y - PAGE_MARGIN_TOP + (options.scrollY ?? 0)));
        top = clamped;
        // `GoToPage`'s horizontal rules: keep the current offset unless the page
        // is entirely off to the left.
        if (container && container.scrollLeft >= page.pos.x + page.pos.dx) {
          container.scrollLeft = page.pos.x;
        }
      } else {
        // The page has no geometry because its size is not known yet: compute the
        // offset from the page sizes and the known spacing, which is the same
        // arithmetic `DocumentLayout::Relayout` performs for the rows above it.
        top = scrollTopForUnmeasuredPage(target, {
          pageCount: limit,
          pageBoxes,
          columns,
          rotation,
          zoomReal: effectiveScale,
          windowMargin,
          pageSpacing,
          canvasDy: layout.canvasSize.dy,
          viewPortDy: layout.viewPort.dy
        });
      }

      // With the page slider up the bar's position is the page number
      // (`Canvas.cpp:653-693`); `scrollToOffset` applies that, so the page is
      // recorded first and the computed offset is irrelevant there.
      currentPageRef.current = target;
      scrollToOffset(top);
      setCurrentPage(target);
      onPageChangeRef.current?.(target, pageCount);
      afterViewChange();
    },
    [
      pageLimit, beforeViewChange, resolvedDisplayMode, pageCount, geometryByPage, layout, pageBoxes, rotation,
      effectiveScale, scrollToOffset, afterViewChange, windowMargin, pageSpacing
    ]
  );

  /**
   * `Canvas.cpp:639-693`, `:3199-3202` — `ScrollbarInSinglePage` makes the bar a
   * page slider: its position is the page number, and its thumb is one page
   * tall. `SB_THUMBTRACK`'s `si.nTrackPos + 1` is the browser's `scrollTop`
   * likewise, so the slider is modelled by letting the scroll range be
   * `pageCount` pages long while only the first page's worth is reachable.
   *
   * The scroller's resting `scrollTop` is therefore the page number minus one,
   * exactly as `GetScrollPos(hwndCanvas, SB_VERT) == CurrentPageNo() - 1` is in
   * light-pdf's single-page mode.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!pageSlider) {
      container.style.height = '';
      delete container.dataset.pageSlider;
      return;
    }
    container.dataset.pageSlider = String(Math.max(1, pageCount));
    // `nMax` is the page count, so the thumb is `nPage / nMax` of the track.
    container.style.height = `${Math.max(1, pageCount) * 100}%`;
    return () => {
      container.style.height = '';
      delete container.dataset.pageSlider;
    };
  }, [pageSlider, pageCount]);

  /** `Canvas.cpp:653-693` — `OnVScroll`'s page-slider branch. */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pageSlider) return;
    // The page the slider is known to be showing. A programmatic scroll (a
    // `GoToPage` from the toolbar, a key, a link) leaves `scrollTop` at 0 for
    // pages beyond the first, and without this the listener would read that 0
    // back as "the reader dragged the thumb to page 1".
    let applied = currentPageRef.current;
    const onScroll = () => {
      const page = Math.min(Math.max(1, pageCount), Math.round(container.scrollTop) + 1);
      if (page === applied) return;
      applied = page;
      // `SB_THUMBTRACK: targetPage = si.nTrackPos + 1`, then `GoToPage`.
      goToPage(page, { scrollY: 0 });
    };
    container.addEventListener('scroll', onScroll);
    return () => container.removeEventListener('scroll', onScroll);
  }, [pageSlider, pageCount, goToPage]);

  /** `DisplayModel::GoToNextPage`. */
  const nextPage = useCallback(() => {
    const container = containerRef.current;
    const limit = pageLimit();
    const columns = columnsFromDisplayMode(resolvedDisplayMode);
    const scrollTop = container?.scrollTop ?? 0;
    const current = currentPageAt(layout, scrollTop, container?.scrollLeft ?? 0);

    if (isContinuousDisplayMode(resolvedDisplayMode)) {
      // Fully display the current page if the previous row is still visible.
      const previousRow = current - columns;
      if (previousRow >= 1 && pageVisibleAt(layout, previousRow, scrollTop) && visibleRatioAt(layout, current, scrollTop) < 1) {
        goToPage(current);
        return;
      }
    }
    const firstPageInNewRow = firstPageInARowNo(current + columns, columns, isBookViewDisplayMode(resolvedDisplayMode));
    if (firstPageInNewRow > limit) {
      // `CmdGoToLastPage`'s caller falls back to `SB_BOTTOM`.
      scrollToOffset(Math.max(0, layout.canvasSize.dy - layout.viewPort.dy));
      return;
    }
    goToPage(firstPageInNewRow);
  }, [pageLimit, resolvedDisplayMode, layout, goToPage, scrollToOffset]);
  nextPageRef.current = nextPage;

  /** `DisplayModel::GoToPrevPage(scrollY)`. */
  const previousPage = useCallback(
    (scrollY = 0) => {
      const container = containerRef.current;
      const limit = pageLimit();
      const columns = columnsFromDisplayMode(resolvedDisplayMode);
      const scrollTop = container?.scrollTop ?? 0;
      const current = currentPageAt(layout, scrollTop, container?.scrollLeft ?? 0);
      const page = layout.pages[current - 1];

      // `GoToPrevPage`: `std::max(-pageInfo->pageOnScreen.y, 0) > scrollY` means the
      // page's top has scrolled above the viewport, so show it before turning back.
      if (isContinuousDisplayMode(resolvedDisplayMode) && page && Math.max(scrollTop - page.pos.y, 0) > scrollY) {
        // The current page is not fully visible: show it first.
        goToPage(current);
        return;
      }
      const firstPageInNewRow = firstPageInARowNo(current - columns, columns, isBookViewDisplayMode(resolvedDisplayMode));
      if (firstPageInNewRow < 1 || current === 1) {
        scrollToOffset(0);
        return;
      }
      goToPage(firstPageInNewRow, { scrollY });
    },
    [pageLimit, resolvedDisplayMode, layout, goToPage, scrollToOffset]
  );
  previousPageRef.current = previousPage;

  const firstPage = useCallback(() => {
    goToPage(1);
  }, [goToPage, pageLimit]);

  const lastPage = useCallback(() => {
    const container = containerRef.current;
    const columns = columnsFromDisplayMode(resolvedDisplayMode);
    const firstPageInLastRow = firstPageInARowNo(pageLimit(), columns, isBookViewDisplayMode(resolvedDisplayMode));
    const current = currentPageAt(layout, container?.scrollTop ?? 0, container?.scrollLeft ?? 0);
    if (current === firstPageInLastRow) {
      scrollToOffset(Math.max(0, layout.canvasSize.dy - layout.viewPort.dy));
      return;
    }
    goToPage(firstPageInLastRow);
  }, [pageLimit, resolvedDisplayMode, layout, goToPage, scrollToOffset]);

  /**
   * `DisplayModel::SetScrollState` — restore a remembered view.
   *
   * Used by Back / Forward and by the per-document restore. A restore must not
   * itself be recorded as navigation, which is why it does not call
   * `beforeViewChange`.
   */
  const restoreScrollState = useCallback(
    (state: LightPdfScrollState) => {
      const container = containerRef.current;
      if (!container) return;
      const page = geometryByPage.get(state.page);
      if (!page) {
        // Not part of this layout: move the layout's start page to it, exactly as
        // `GoToPage` does in the non-continuous modes.
        setStartPage(state.page);
        setCurrentPage(state.page);
        onPageChangeRef.current?.(state.page, pageCount);
        return;
      }
      const target = scrollOffsetForRestoredState(page.y, page.x, state, page.zoomReal, PAGE_MARGIN_TOP);
      container.scrollTo({ top: target.top, left: target.left, behavior: 'auto' });
      scrollRef.current = { x: container.scrollLeft, y: container.scrollTop };
      setCurrentPage(state.page);
      onPageChangeRef.current?.(state.page, pageCount);
    },
    [geometryByPage, pageCount]
  );

  const find = useCallback(
    async (query: string, options?: { caseSensitive?: boolean; regex?: boolean; wholeWord?: boolean }): Promise<number> => {
      if (!path || !query.trim()) {
        setSearchMatches([]);
        publishSearchState(0, 0);
        return 0;
      }
      const matches = await window.eukoliaApi.pdfSearch(path, query, {
        caseSensitive: options?.caseSensitive ?? false,
        regex: options?.regex ?? false,
        wholeWord: options?.wholeWord ?? false,
        maxResults: 500
      });
      setSearchMatches(matches);
      setSearchIndex(0);
      if (matches.length > 0) goToPage(matches[0].page);
      // `SearchAndDDE.cpp` — `ShowMatchCount` shows `"n / m"` with n 1-based.
      publishSearchState(matches.length > 0 ? 1 : 0, matches.length);
      return matches.length;
    },
    [path, publishSearchState, goToPage]
  );

  const stepSearch = useCallback(
    (delta: number) => {
      if (searchMatches.length === 0) return;
      const next = (searchIndex + delta + searchMatches.length) % searchMatches.length;
      setSearchIndex(next);
      goToPage(searchMatches[next].page);
      publishSearchState(next + 1, searchMatches.length);
    },
    [searchMatches, searchIndex, goToPage, publishSearchState]
  );

  // ---------------------------------------------------------------- zoom

  /**
   * `DisplayModel::SetZoomVirtual(zoom, fixPt)`.
   *
   * The anchor is a `ScrollState` (page + page-space point) captured before the
   * re-layout and restored after it, so a zoom keeps the page and the place on
   * it; `anchor` additionally pins a client pixel, which is what a mouse-wheel
   * zoom passes so the point under the cursor stays under the cursor.
   */
  const applyZoom = useCallback(
    (nextZoom: number, mode: PdfZoomMode = 'custom', anchor?: { clientX: number; clientY: number; page: number; offsetX: number; offsetY: number }) => {
      beginViewChange();
      if (anchor && containerRef.current) {
        pendingZoomAnchorRef.current = {
          page: anchor.page,
          offsetX: anchor.offsetX,
          offsetY: anchor.offsetY,
          clientX: anchor.clientX,
          clientY: anchor.clientY,
          scale: scaleRef.current,
          rotation
        };
      }
      onZoomChange?.(clampScale(nextZoom), mode);
    },
    [beginViewChange, onZoomChange, rotation]
  );

  const applyZoomMode = useCallback(
    (mode: PdfZoomMode) => {
      beforeViewChange();
      const state = currentScrollState();
      // `SetZoomVirtual`: a fit-type zoom drops the anchor (`ss.x = ss.y = -1`) and
      // lets `GoToPage` scroll to the page — or, for fit-content, the content —
      // start, rather than keeping a fraction that no longer means anything.
      const scrollToFitPage =
        mode === 'page-fit' || mode === 'page-width' || mode === 'page-height' || mode === 'fit-content' || mode === 'shrink-to-fit' || mode === 'auto';
      pendingScrollStateRef.current = scrollToFitPage ? { page: state.page, x: -1, y: -1 } : state;
      onZoomChange?.(scaleRef.current, mode);
    },
    [beforeViewChange, currentScrollState, onZoomChange]
  );

  /** `CmdZoomIn` / `CmdZoomOut`: the ladder, then a zoom about the cursor. */
  const stepZoom = useCallback(
    (direction: 1 | -1, clientX?: number, clientY?: number) => {
      const step = nextZoomStep(
        {
          pageCount: Math.max(1, pageCount),
          pageBoxes,
          contentBoxes,
          displayMode: resolvedDisplayMode,
          startPage,
          rotation,
          viewPortSize: { dx: containerSize.ready ? containerSize.width : 1, dy: containerSize.ready ? containerSize.height : 1 },
          viewPortOffset: { x: 0, y: 0 },
          zoomVirtual,
          previousZoomReal: previousZoomRef.current,
          currentPage,
          windowMargin,
          pageSpacing
        },
        {
          direction,
          currentZoomReal: scaleRef.current,
          // light-pdf `ZoomLevels` / `ZoomIncrement`: read from the settings at
          // the moment of the step, so a change applies to the open document.
          ...zoomSettingsRef.current
        }
      );
      if (step.kind === 'mode') {
        applyZoomMode(step.mode);
        return;
      }
      const anchor = clientX === undefined || clientY === undefined ? undefined : anchorAt(clientX, clientY);
      applyZoom(lightPdfScaleFromZoomPercent(step.percent), 'custom', anchor);
    },
    [pageCount, pageBoxes, contentBoxes, resolvedDisplayMode, startPage, rotation, containerSize, zoomVirtual, currentPage, windowMargin, pageSpacing, applyZoom, applyZoomMode]
  );

  /** The cursor's page and offset inside it, for a wheel zoom's fix point. */
  const anchorAt = useCallback(
    (clientX: number, clientY: number): { clientX: number; clientY: number; page: number; offsetX: number; offsetY: number } | undefined => {
      const container = containerRef.current;
      if (!container) return undefined;
      const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      const pageElement = element?.closest('[data-page]') as HTMLElement | null;
      if (!pageElement) return undefined;
      const page = Number(pageElement.dataset.page);
      const rect = pageElement.getBoundingClientRect();
      if (!Number.isFinite(page)) return undefined;
      return { clientX, clientY, page, offsetX: clientX - rect.left, offsetY: clientY - rect.top };
    },
    []
  );

  /**
   * `Canvas.cpp:2730-2751` — the momentum wheel's integrator, and
   * `:2259-2313`'s tick.
   *
   * It is deliberately **not** owned by React. The integrator, the frame handle
   * and the running tick live in one mutable object for the viewer's whole life,
   * and the only things that stop them are the viewer going away and a
   * navigation that decides where the view should be.
   *
   * That is not tidiness. A momentum is a multi-frame animation, while every
   * effect that touches the viewer is re-subscribed whenever one of its
   * dependencies changes — and React runs a re-subscribed effect's *cleanup*
   * first. An effect that stopped the momentum in its cleanup therefore killed
   * the glide it was in the middle of, and the numbers it left behind looked
   * nothing like a physics problem: one notch delivered 68 px of its 96, a burst
   * of six delivered 128 px of its 576, and every one of them was "the wheel
   * sometimes does not respond". Nothing inside the integrator could see it,
   * because the integrator was right — it was the loop around it that had been
   * switched off.
   */
  const momentumRef = useRef<{
    integrator: LightPdfSmoothScroll;
    frame: number;
    tick: ((timestamp: number) => void) | null;
  } | null>(null);
  if (momentumRef.current === null) {
    momentumRef.current = {
      integrator: new LightPdfSmoothScroll(lightPdfSmoothScrollDecayRate(viewerSettings.smoothScrollFriction)),
      frame: 0,
      tick: null
    };
  }
  /** `SmoothScrollFriction` is live, as `Canvas.cpp:2285` reads it per tick. */
  const smoothScrollFriction = viewerSettings.smoothScrollFriction;
  useEffect(() => {
    const momentum = momentumRef.current;
    if (!momentum) return;
    // A friction change re-creates the integrator, exactly as
    // `gGlobalPrefs->smoothScrollFriction` being read on every tick means.
    momentum.integrator = new LightPdfSmoothScroll(lightPdfSmoothScrollDecayRate(smoothScrollFriction));
    momentum.tick = null;
    if (momentum.frame) {
      cancelAnimationFrame(momentum.frame);
      momentum.frame = 0;
    }
  }, [smoothScrollFriction]);

  /** `win->smoothScrollVelocityY = 0; exactY = 0` and the frame loop with it. */
  const stopSmoothScroll = useCallback(() => {
    const momentum = momentumRef.current;
    if (!momentum) return;
    momentum.integrator.stop();
    momentum.tick = null;
    if (momentum.frame) {
      cancelAnimationFrame(momentum.frame);
      momentum.frame = 0;
    }
  }, []);
  // Published for the navigation callbacks above, which are created before this
  // one exists. A navigation is a decision about *where* the view should be, so
  // it ends a momentum aimed at where the wheel last pointed — the reference
  // does the same on a view change (`Canvas.cpp:2450-2454`).
  cancelMomentumRef.current = stopSmoothScroll;

  /**
   * The reading the momentum loop measures its `dt` from.
   *
   * light-pdf measures `dt` with `QueryPerformanceCounter`; the browser's own frame
   * timestamp is the same reading, and taking it from the callback rather than
   * calling `performance.now()` inside the tick keeps `dt` tied to the frame the
   * callback belongs to. It lives in a ref rather than in the tick's closure because
   * the wheel handler's head start advances the physics too, and both must measure
   * from the same reading. (`frameTimeMs` is the seam the tests drive the integrator
   * through, since a frame they run themselves has no real elapsed time between it
   * and the last one.)
   */
  const lastFrameAtRef = useRef(0);

  /**
   * One step of the glide: the integrator's own tick, with the viewer's scroll
   * write and clamp.
   *
   * Shared by the momentum loop and by the wheel handler's head start, so the two
   * cannot drift apart: there is one definition of what "advance the momentum"
   * means, and the head start is not an approximation of the loop but the loop's own
   * arithmetic, run once, early.
   */
  const applyMomentumDelta = useCallback(
    (offset: number, integrator: LightPdfSmoothScroll, dt: number): { delta: number; at: number } => {
      const container = containerRef.current;
      if (!container) return { delta: 0, at: offset };
      let applied = 0;
      let at = offset;
      integrator.tick(
        offset,
        dt,
        (delta) => {
          // One write, no reads: the offset the integrator works from is the one the
          // scroll listener and this loop keep in `scrollRef`, and the bound is the
          // cached range. Asking the DOM here cost four layout reads per frame.
          const range = scrollRangeRef.current;
          const next = delta !== 0 ? Math.max(0, Math.min(range.maxTop, scrollRef.current.y + delta)) : scrollRef.current.y;
          if (next !== scrollRef.current.y) container.scrollTop = next;
          applied = delta;
          scrollRef.current.y = next;
          at = next;
          return next;
        },
        { max: scrollRangeRef.current.maxTop }
      );
      return { delta: applied, at };
    },
    []
  );

  /**
   * One impulse. `Canvas.cpp:2741` — the velocity is *reduced* by it, so a notch
   * that arrives while the view is still gliding adds to that glide rather than
   * replacing it, and the exact offset is seeded only when the momentum had
   * stopped (`:2745-2749`).
   */
  const addMomentumImpulse = useCallback((impulse: number) => {
    const container = containerRef.current;
    const momentum = momentumRef.current;
    if (!container || !momentum) return;
    const { integrator } = momentum;
    const stopped = !integrator.active;
    if (stopped) integrator.reseed(container.scrollTop);
    integrator.addImpulse(-impulse);
    if (!stopped || momentum.tick) return;

    /**
     * The notch's first step happens *here*, inside the wheel event.
     *
     * This is the one place the reference's own shape could not be transcribed
     * directly, and the reason the wheel felt a frame behind it. light-pdf seeds the
     * velocity in the wheel message and advances the physics at the end of the next
     * `WM_PAINT` (`Canvas.cpp:2259-2313`), so the paint that follows the input
     * already shows movement — the reader waits at most one paint, typically 2-6 ms.
     * A browser has no such loop to hook: deferring to `requestAnimationFrame` means
     * the frame that acknowledges the input still shows the *old* offset, and the
     * movement appears in the one after it. Measured with `.scratch/perf/budget.mjs`,
     * a single notch took **19.5 ms (2.8 frame intervals)** to move the view, against
     * 4.7 ms when a glide was already running — the extra frame being exactly this
     * deferral.
     *
     * So one frame of the glide is taken now, through the integrator's own
     * `advance()`, which keeps the notch's total travel at `impulse / rate` by paying
     * for the step out of the velocity. `lastFrameAtRef` is seeded one frame *in the
     * past* so the loop that follows belongs to the same timeline: the first tick then
     * charges the interval this step already covered instead of charging it twice.
     * (`frameTimeMs()` is the same reading the rAF callback will carry, in the same
     * base, which is what makes that subtraction meaningful.)
     */
    const headStart = MOMENTUM_HEAD_START_SECONDS;
    const firstStep = integrator.advance(container.scrollTop, headStart);
    if (firstStep !== 0) {
      const range = scrollRangeRef.current;
      const next = Math.max(0, Math.min(range.maxTop, container.scrollTop + firstStep));
      container.scrollTop = next;
      scrollRef.current.y = next;
      // The frame the step was taken in, so the loop's first `dt` is the remainder of
      // that frame rather than a whole one.
      lastFrameAtRef.current = frameTimeMs() - headStart * 1000;
    } else {
      lastFrameAtRef.current = frameTimeMs();
    }
    const tick = (timestamp: number) => {
      momentum.frame = 0;
      /**
       * The frame's own timestamp, always — never a fallback to `performance.now()`.
       *
       * The seed above put `lastFrameAtRef` in the frame clock's timeline, so the two
       * readings must come from the same source for the difference to mean anything.
       * A guard that preferred `performance.now()` when the timestamp looked "too
       * small" was wrong in a way that is invisible in the browser and total in a
       * harness with a virtual clock: a frame clock that starts at zero failed the
       * comparison every time, `dt` was pinned at 0, and the velocity decayed while
       * the view moved one pixel per frame — the glide's shape, with none of its
       * speed. (`frameTimeMs` is the seam that keeps the two producers honest.)
       */
      const now = frameTimeMs(timestamp);
      const dt = Math.max(0, (now - lastFrameAtRef.current) / 1000);
      lastFrameAtRef.current = now;
      applyMomentumDelta(scrollRef.current.y, integrator, dt);
      // The scroll listener keeps `scrollRef` in step with the DOM for anything that
      // scrolls the view behind the integrator's back (a trackpad's own momentum, a
      // scrollbar drag), so there is nothing to re-read here.
      // `:2308-2310` — repaint only while the momentum lasts, and only while
      // this callback is still the live one: a stop during the tick clears the
      // tick, and re-arming after that would restart a momentum that has ended.
      if (integrator.active && momentum.tick === tick) {
        momentum.frame = requestAnimationFrame(tick);
      } else if (momentum.tick === tick) {
        momentum.tick = null;
      }
    };
    momentum.tick = tick;
    momentum.frame = requestAnimationFrame(tick);
  }, [applyMomentumDelta]);

  // Wheel: scrolling and Ctrl+wheel zoom, `CanvasOnMouseWheel`.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /**
     * `CanvasOnMouseWheel`'s decision, with the metrics it needs: `si.nPage` is
     * the viewport, `si.nPos` the offset, `si.nMax - si.nPage` the largest valid
     * offset.
     */
    const planWheel = (
      delta: number,
      axis: LightPdfScrollAxis,
      options: { fitContent: boolean; altHalfPage: boolean }
    ): LightPdfWheelAction => {
      const live = wheelSettingsRef.current;
      const plan = planLightPdfWheel(
        {
          delta,
          axis,
          continuous: isContinuousDisplayMode(displayModeRef.current),
          fitContent: options.fitContent,
          pageSlider: pageSliderRef.current,
          fastScrollOverScrollbar:
            live.fastScrollOverScrollbar &&
            lightPdfPointerOverScrollbar(
              pointerRef.current.clientX,
              container.getBoundingClientRect(),
              container
            ),
          altHalfPage: options.altHalfPage,
          // light-pdf's own `SmoothScroll` preference, not the app-wide
          // `scrolling.smooth`: the momentum wheel is a velocity integrator with
          // its own friction, and gating it on a generic animation toggle meant it
          // could be switched off by accident — or left on and never reached.
          smoothScroll: wheelSettingsRef.current.smoothScroll,
          // `Canvas.cpp:2738` multiplies the *already scaled* delta by the
          // sensitivity once more when it builds the impulse.
          sensitivity: wheelSettingsRef.current.scrollSensitivity,
          // From the cached range and the tracked offset, not from the layout: a
          // notch must not read `scrollHeight`/`clientHeight`/`scrollTop`, which on
          // a 200-page document can force a synchronous layout before the view can
          // move — the wheel's own latency, and the one thing the reader feels.
          metrics: {
            page: scrollRangeRef.current.clientHeight,
            pos: scrollRef.current.y,
            maxPos: scrollRangeRef.current.maxTop,
            needVScroll: scrollRangeRef.current.maxTop > 1
          },
          // `DpiScale(hwndCanvas, 16)`: the browser already works in device
          // pixels, so the DPI scale is 1.
          linePixels: LIGHTPDF_SCROLL_LINE_HEIGHT
        },
        wheelAccumRef.current
      );
      wheelAccumRef.current = plan.accum;
      return plan.action;
    };

    /** `Canvas.cpp:2672-2708`/`:2718-2728` — a scroll-message path, in pixels. */
    const applyScrollAction = (action: LightPdfWheelAction, horizontal: boolean): void => {
      if (action.kind !== 'scroll') return;
      const range = scrollRangeRef.current;
      if (horizontal) {
        const next = Math.max(0, Math.min(range.maxLeft, scrollRef.current.x + action.dx));
        scrollRef.current.x = next;
        container.scrollLeft = next;
        return;
      }
      /**
       * The offset is taken from `scrollRef` (which the scroll listener keeps in
       * step with the DOM) and clamped against the cached range, so a notch costs
       * one property write and no layout reads at all. The boundary test that used
       * to compare a read-back against `before` is the same test, computed from the
       * clamped value: a notch that cannot move the view is a notch at the edge.
       */
      const before = scrollRef.current.y;
      const next = Math.max(0, Math.min(range.maxTop, before + action.dy));
      scrollRef.current.y = next;
      if (next !== before) container.scrollTop = next;
      // At a boundary the continuous modes flip the page, as light-pdf does.
      else if (action.dy !== 0 && isContinuousDisplayMode(displayModeRef.current)) {
        if (action.dy > 0) nextPageRef.current();
        else previousPageRef.current();
      }
    };

    const onWheel = (event: WheelEvent) => {
      // `isZooming = isCtrl || isRightButton(wheel)`
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        if (!setting.bool('scrolling.mouseWheelZoom')) return;
        // `ZoomByMouseWheel`: `discreteWheelZoom` unless `ZoomIncrement` is
        // positive, and the step happens about the cursor.
        const accum = wheelZoomAccumRef.current + event.deltaY;
        if (zoomSettingsRef.current.zoomIncrement > 0 && Math.abs(accum) < WHEEL_ZOOM_ACCUM_DELTA) {
          wheelZoomAccumRef.current = accum;
          return;
        }
        wheelZoomAccumRef.current = 0;
        // A wheel zoom is a stream of scale changes, exactly like a drag: the
        // pages follow the layout, and the pixels arrive once the wheel stops.
        markInteracting(false);
        stepZoom(accum < 0 ? 1 : -1, event.clientX, event.clientY);
        return;
      }

      // Stop a middle-button autoscroll, as light-pdf ignores the wheel while it
      // is running (`:2553-2556`).
      stopAutoScroll();

      // The momentum is deliberately *not* stopped here, and that is the whole
      // of "the wheel sometimes does not respond": `Canvas.cpp:2741` *reduces*
      // the velocity by the new impulse, so the reference accelerates a glide
      // that is already running rather than cancelling it. Zeroing it here threw
      // away everything the previous notch had asked for and left the view
      // waiting for the next one to arrive — the momentum of a real wheel
      // outlives the gap between two notches, and it is exactly that overlap
      // which makes the reference's scrolling feel continuous. A view change
      // still stops it (`scrollToOffset`), which is what the reference's own
      // `:2450-2454` does on the same occasions.

      const sensitivity = wheelSettingsRef.current.scrollSensitivity;
      // `hScroll` when Shift is held; a tilt wheel sends `deltaX` instead.
      const horizontalTilt = !event.shiftKey && event.deltaX !== 0 && event.deltaY === 0;
      if (event.shiftKey || horizontalTilt) {
        event.preventDefault();
        const delta = lightPdfWheelDelta(
          horizontalTilt ? { deltaMode: 0, deltaY: event.deltaX } : event,
          scrollRangeRef.current.clientHeight,
          horizontalTilt ? 1 : sensitivity
        );
        // `Canvas.cpp:2586-2588` scales a Shift-wheel, which is a vertical notch
        // redirected sideways. A tilt wheel is `CanvasOnMouseHWheel`, whose
        // `SB_LINELEFT`/`SB_LINERIGHT` steps are one line of 16 px each — its own
        // multiplier is 1.
        const action = planWheel(delta, 'horizontal', { fitContent: false, altHalfPage: false });
        // A sub-line delta does not reach a whole `SB_LINE` step, but it still has
        // to move: the exact fraction is applied here, as on the vertical path.
        if (action.kind === 'scroll') applyScrollAction(action, true);
        else {
          container.scrollLeft = clampScrollLeft(
            container,
            container.scrollLeft + lightPdfLineScrollDistance(delta, LIGHTPDF_SCROLL_LINE_HEIGHT)
          );
          scrollRef.current = { x: container.scrollLeft, y: container.scrollTop };
        }
        return;
      }

      if (event.deltaY === 0) return;
      event.preventDefault();

      const delta = lightPdfWheelDelta(event, scrollRangeRef.current.clientHeight, sensitivity);
      const action = planWheel(delta, 'vertical', { fitContent: zoomModeRef.current === 'fit-content', altHalfPage: event.altKey });
      switch (action.kind) {
        case 'page':
          wheelAccumRef.current = 0;
          if (action.direction > 0) nextPageRef.current();
          else previousPageRef.current();
          return;
        case 'smooth': {
          // `Canvas.cpp:2740-2751`: one impulse into the momentum, which is
          // additive — the seeding rules live in `addMomentumImpulse`.
          addMomentumImpulse(action.impulse);
          return;
        }
        case 'scroll':
          applyScrollAction(action, false);
          return;
        default:
          return;
      }
    };

    container.addEventListener('wheel', onWheel, { passive: false });

    /*
     * …and the same handler on the viewer's own box, because the scroller is not
     * the only part of the viewer a wheel can land on.
     *
     * The overlay scrollbar is a *sibling* of the scroller inside this root (it
     * has to be: it is drawn over the pages, not inside the flow that scrolls), and
     * with `pdf.scrollbar` at its default `smart` the native bar is suppressed and
     * the overlay's host box is a full-height strip 4 px wide, 16 px when the
     * pointer is near it. A notch over that strip targets the bar, bubbles past the
     * scroller — not an ancestor of it — and reaches the window, where
     * `core/smoothScroll` declines it because this subtree is marked
     * `data-native-scroll` and `html`/`body` have nothing to scroll. The notch did
     * nothing at all, and it was most likely to happen just after a scroll, when
     * the bar has been shown.
     *
     * The root listener is the fallback rather than a second owner: the scroller's
     * own listener is deeper, so it runs first for anything inside the pages and
     * its `preventDefault` is what this one checks. Nothing is handled twice, and
     * the scroller's behaviour is unchanged.
     */
    const root = rootRef.current;
    const onRootWheel = (event: WheelEvent) => {
      if (event.defaultPrevented) return;
      onWheel(event);
    };
    root?.addEventListener('wheel', onRootWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', onWheel);
      root?.removeEventListener('wheel', onRootWheel);
      // The momentum is deliberately *not* stopped here. This effect is
      // re-subscribed whenever one of its dependencies changes, and React runs
      // the old cleanup first — so stopping the glide here killed it in the
      // middle, which is what "the wheel sometimes does not respond" was. The
      // momentum belongs to `momentumRef`, which nothing but a navigation and
      // the viewer's own unmount stops.
    };
  }, [stepZoom, stopAutoScroll, stopSmoothScroll, addMomentumImpulse]);

  // Ctrl + click → inverse SyncTeX.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onClick = (event: MouseEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (!setting.bool('pdf.synctexInverseSearch') || !onInverseSearch) return;

      const target = event.target as HTMLElement;
      const pageElement = target.closest('[data-page]') as HTMLElement | null;
      if (!pageElement) return;

      const pageNumber = Number(pageElement.dataset.page);
      const rect = pageElement.getBoundingClientRect();
      const source = pdfDoc?.pages[pageNumber - 1];
      const geometry = geometryByPage.get(pageNumber);
      if (!source || !geometry) return;
      const { x, y } = unrotatePoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
        source.width,
        source.height,
        geometry.zoomReal,
        rotation
      );
      if (Number.isFinite(pageNumber) && Number.isFinite(x) && Number.isFinite(y)) {
        event.preventDefault();
        onInverseSearch(pageNumber, x, y);
      }
    };

    container.addEventListener('click', onClick);
    return () => container.removeEventListener('click', onClick);
  }, [onInverseSearch, rotation, pdfDoc, geometryByPage]);

  // ---------------------------------------------------- hand panning / autoscroll
  //
  // light-pdf has no hand tool: middle-drag starts its auto-scroll
  // (`OnMouseMiddleButtonDown`), and a left-drag that does not start over text (or
  // that holds Shift) pans the page (`OnMouseLeftButtonDown`, `StartMouseDrag`).
  //
  // `autoScrollRef` and `stopAutoScroll` are declared with the other refs above
  // the wheel handler, because light-pdf stops an autoscroll on any wheel notch
  // (`Canvas.cpp:2553-2556`) and the wheel listener is subscribed once.

  const startAutoScroll = useCallback(
    (clientX: number, clientY: number) => {
      const container = containerRef.current;
      if (!container) return;
      stopAutoScroll();
      container.style.cursor = 'all-scroll';
      const origin = { x: clientX, y: clientY };
      let accumX = 0;
      let accumY = 0;
      const timer = setInterval(() => {
        const current = pointerRef.current;
        const scale = AUTOSCROLL_INTERVAL_MS / 20;
        accumX += ((current.clientX - origin.x) / AUTOSCROLL_SLOW_DOWN_FACTOR) * scale;
        accumY += ((current.clientY - origin.y) / AUTOSCROLL_SLOW_DOWN_FACTOR) * scale;
        const dx = Math.trunc(accumX);
        const dy = Math.trunc(accumY);
        if (dx === 0 && dy === 0) return;
        accumX -= dx;
        accumY -= dy;
        container.scrollLeft = clampScrollLeft(container, container.scrollLeft + dx);
        container.scrollTop = clampScrollTop(container, container.scrollTop + dy);
      }, AUTOSCROLL_INTERVAL_MS);
      autoScrollRef.current = { x: clientX, y: clientY, timer };
    },
    [stopAutoScroll]
  );

  /**
   * `Canvas.cpp:1694-1710` — `ToggleAutoScroll` / `StartAutoScrollAtCursor`:
   * the command anchors the auto-scroll at the pointer, so a reader who has just
   * clicked into the page can start the same gesture a middle click would.
   */
  const toggleAutoScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (autoScrollRef.current) {
      stopAutoScroll();
      return;
    }
    const rect = container.getBoundingClientRect();
    const pointer = pointerRef.current;
    const inside =
      pointerInsideRef.current &&
      pointer.clientX >= rect.left &&
      pointer.clientX <= rect.right &&
      pointer.clientY >= rect.top &&
      pointer.clientY <= rect.bottom;
    // `HwndGetCursorPos(hwndCanvas)` clamps into the canvas, which for a pointer
    // outside the pane is the nearest edge.
    const x = inside ? pointer.clientX : rect.left + rect.width / 2;
    const y = inside ? pointer.clientY : rect.top + rect.height / 2;
    startAutoScroll(x, y);
  }, [startAutoScroll, stopAutoScroll]);

  // ------------------------------------------------------------ text selection
  //
  // `TextSelection.cpp` is one of the files PORTING.md records as compiled
  // unchanged, so the glyph hit-testing, word and line snapping all already
  // exist in the native engine; what was missing was the interaction that drives
  // them. Light-pdf selects with a drag, doubles and triples extend to a word or
  // a line, and copies the selection as text.

  /** Maps a pointer position to a page and a point in PDF coordinates. */
  const pointAt = useCallback(
    (event: { clientX: number; clientY: number }): { page: number; x: number; y: number } | null => {
      const container = containerRef.current;
      if (!container) return null;
      // `elementFromPoint` is used rather than `event.target` because the
      // rectangles are painted as overlay elements, so the event target during a
      // drag is the highlight rather than the page underneath it.
      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const pageElement = target?.closest('[data-page]') as HTMLElement | null;
      if (!pageElement) return null;

      const pageNumber = Number(pageElement.dataset.page);
      const source = pdfDoc?.pages[pageNumber - 1];
      const geometry = geometryByPage.get(pageNumber);
      if (!source || !geometry || !Number.isFinite(pageNumber)) return null;

      const rect = pageElement.getBoundingClientRect();
      const { x, y } = unrotatePoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
        source.width,
        source.height,
        geometry.zoomReal,
        rotation
      );
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { page: pageNumber, x, y };
    },
    [pdfDoc, geometryByPage, rotation]
  );

  const runSelection = useCallback(
    (
      mode: 'range' | 'word' | 'line',
      start: { page: number; x: number; y: number },
      end: { page: number; x: number; y: number }
    ) => {
      selectionRequestRef.current += 1;
      const requestId = selectionRequestRef.current;
      void window.eukoliaApi
        .pdfSelect(path ?? '', {
          page: start.page,
          mode,
          startX: start.x,
          startY: start.y,
          endX: end.x,
          endY: end.y,
          x: end.x,
          y: end.y
        })
        .then((result) => {
          // A newer drag has already been sent; dropping this reply keeps the
          // highlight from snapping back to where the pointer used to be.
          if (requestId !== selectionRequestRef.current) return;
          setSelection({ text: result.text, rects: result.rects ?? [], page: result.page });
        })
        .catch(() => {
          if (requestId === selectionRequestRef.current) setSelection(null);
        });
    },
    [path]
  );

  /**
   * The live gesture.
   *
   * It is a ref rather than a closure variable on purpose: the listeners below are
   * re-subscribed whenever their dependencies change (a page change, a new zoom),
   * and a drag or an auto-scroll in progress must survive that — light-pdf's
   * `MouseAction` is window state, not a property of one event handler.
   */
  const gestureRef = useRef<{
    dragging: boolean;
    panning: boolean;
    panOrigin: { x: number; y: number } | null;
    /** Consecutive clicks without movement, for double/triple-click selection. */
    clickRun: number;
    autoScrollTimer: ReturnType<typeof setInterval> | null;
  }>({ dragging: false, panning: false, panOrigin: null, clickRun: 0, autoScrollTimer: null });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const gesture = gestureRef.current;

    /** `Selection.cpp` — `SELECT_AUTOSCROLL_AREA_WIDTH` / `_STEP_LENGTH`. */
    const edgeAutoscroll = () => {
      const rect = container.getBoundingClientRect();
      const point = pointerRef.current;
      let dx = 0;
      let dy = 0;
      if (point.clientX - rect.left < SELECT_AUTOSCROLL_AREA_WIDTH) dx = -SELECT_AUTOSCROLL_STEP_LENGTH;
      else if (rect.right - point.clientX < SELECT_AUTOSCROLL_AREA_WIDTH) dx = SELECT_AUTOSCROLL_STEP_LENGTH;
      if (point.clientY - rect.top < SELECT_AUTOSCROLL_AREA_WIDTH) dy = -SELECT_AUTOSCROLL_STEP_LENGTH;
      else if (rect.bottom - point.clientY < SELECT_AUTOSCROLL_AREA_WIDTH) dy = SELECT_AUTOSCROLL_STEP_LENGTH;
      if (dx === 0 && dy === 0) return;
      const beforeX = container.scrollLeft;
      const beforeY = container.scrollTop;
      container.scrollLeft = clampScrollLeft(container, beforeX + dx);
      container.scrollTop = clampScrollTop(container, beforeY + dy);
      // The anchor stays in document coordinates: compensate for what was achieved.
      if (anchorRef.current) {
        anchorRef.current = {
          ...anchorRef.current,
          x: anchorRef.current.x + (beforeX - container.scrollLeft) / scaleRef.current,
          y: anchorRef.current.y + (beforeY - container.scrollTop) / scaleRef.current
        };
      }
    };

    const ensureEdgeTimer = () => {
      if (gesture.autoScrollTimer) return;
      gesture.autoScrollTimer = setInterval(() => {
        if (!gesture.dragging) return;
        const point = pointAt(pointerRef.current);
        const anchor = anchorRef.current;
        const rect = container.getBoundingClientRect();
        const nearEdge =
          pointerRef.current.clientX - rect.left < SELECT_AUTOSCROLL_AREA_WIDTH ||
          rect.right - pointerRef.current.clientX < SELECT_AUTOSCROLL_AREA_WIDTH ||
          pointerRef.current.clientY - rect.top < SELECT_AUTOSCROLL_AREA_WIDTH ||
          rect.bottom - pointerRef.current.clientY < SELECT_AUTOSCROLL_AREA_WIDTH;
        if (!nearEdge) return;
        edgeAutoscroll();
        if (anchor && point) runSelection('range', anchor, point);
      }, SELECT_AUTOSCROLL_INTERVAL_MS);
    };

    const onMouseDown = (event: MouseEvent) => {
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY };

      if (event.button === 1) {
        // `OnMouseMiddleButtonDown` — a middle click toggles auto-scrolling.
        event.preventDefault();
        if (autoScrollRef.current) stopAutoScroll();
        else startAutoScroll(event.clientX, event.clientY);
        return;
      }
      if (event.button === 2) {
        stopAutoScroll();
        return;
      }
      if (event.button !== 0) return;
      stopAutoScroll();
      if (event.ctrlKey || event.metaKey) return; // Ctrl+click is inverse search.

      const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const overLink = Boolean(element?.closest('[data-link]'));
      const overText = Boolean(element?.closest('[data-text-layer]'));
      if (overLink) return;

      const point = pointAt(event);
      if (!point) return;

      // `OnMouseLeftButtonDown`: a drag that does not start over text, or that
      // holds Shift, pans the document instead of selecting.
      if (event.shiftKey || !overText) {
        gesture.panning = true;
        gesture.dragging = false;
        gesture.panOrigin = { x: event.clientX, y: event.clientY };
        container.style.cursor = 'grabbing';
        event.preventDefault();
        return;
      }

      gesture.clickRun = event.detail > 0 ? event.detail : 1;
      gesture.dragging = true;
      anchorRef.current = point;

      if (gesture.clickRun >= 3) {
        runSelection('line', point, point);
        ensureEdgeTimer();
        return;
      }
      if (gesture.clickRun === 2) {
        runSelection('word', point, point);
        ensureEdgeTimer();
        return;
      }

      // A fresh drag clears the previous selection immediately, so the old
      // highlight does not linger while the new one is being computed.
      setSelection(null);
      ensureEdgeTimer();
    };

    const onMouseMove = (event: MouseEvent) => {
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      pointerInsideRef.current = true;
      updateCursorPosition(event);

      if (gesture.panning && gesture.panOrigin) {
        // The document follows the cursor (`MoveDocBy(dragPrevPos - pos)`).
        const dx = gesture.panOrigin.x - event.clientX;
        const dy = gesture.panOrigin.y - event.clientY;
        gesture.panOrigin = { x: event.clientX, y: event.clientY };
        container.scrollLeft = clampScrollLeft(container, container.scrollLeft + dx);
        container.scrollTop = clampScrollTop(container, container.scrollTop + dy);
        return;
      }

      if (!gesture.dragging || gesture.clickRun > 1) return;
      const anchor = anchorRef.current;
      const point = pointAt(event);
      if (!anchor || !point) return;
      runSelection('range', anchor, point);
    };

    const onMouseUp = () => {
      gesture.dragging = false;
      gesture.panning = false;
      gesture.panOrigin = null;
      anchorRef.current = null;
      container.style.cursor = '';
      if (gesture.autoScrollTimer) {
        clearInterval(gesture.autoScrollTimer);
        gesture.autoScrollTimer = null;
      }
    };

    const onBlur = () => {
      stopAutoScroll();
      onMouseUp();
    };

    /**
     * `LightPDF.cpp:6323-6355` — the cursor-position tip follows the pointer
     * while it is on. The state only changes when the *rounded* position does,
     * so a drag over a page does not re-render per pixel.
     */
    const updateCursorPosition = (event: { clientX: number; clientY: number }) => {
      if (cursorPositionUnitRef.current === 'off') return;
      const point = pointAt(event);
      if (!point) return;
      const x = Math.round(point.x * 10) / 10;
      const y = Math.round(point.y * 10) / 10;
      setCursorPosition((previous) => (previous && previous.x === x && previous.y === y ? previous : { x, y }));
    };

    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('mousemove', onMouseMove);
    container.addEventListener('mouseleave', onMouseLeave);
    // On the window, so a drag that ends outside the pane still finishes.
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onBlur);
    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      container.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('mouseleave', onMouseLeave);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onBlur);
      stopAutoScroll();
    };
  }, [pointAt, runSelection, startAutoScroll, stopAutoScroll, onMouseLeave]);

  /** light-pdf's `CmdCopySelection` (`Ctrl+C`): the selection, as text. */
  const copySelection = useCallback((): boolean => {
    const current = selectionRef.current;
    if (!current?.text) return false;
    void navigator.clipboard.writeText(current.text);
    return true;
  }, []);

  /**
   * light-pdf's `CmdSelectAll` (`Ctrl+A`).
   *
   * light-pdf selects from the first to the last page in one gesture
   * (`Selection.cpp` — `OnSelectAll`), because `TextSelection::SelectUpTo` walks
   * every page in the range. Eukolia's frozen selection contract carries one page
   * and a page-less rectangle list (`src/shared/ipc.ts`), so a multi-page
   * selection cannot be expressed: the command selects the current page's text,
   * which is the largest selection the contract can carry.
   */
  const selectAll = useCallback(() => {
    if (!pdfDoc) return;
    selectionRequestRef.current += 1;
    const requestId = selectionRequestRef.current;
    const page = Math.min(Math.max(1, currentPage), pageLimit());
    void window.eukoliaApi
      .pdfSelect(path ?? '', { page, mode: 'range', startX: 0, startY: 0, endX: 1e6, endY: 1e6, x: 1e6, y: 1e6 })
      .then((result) => {
        if (!result || requestId !== selectionRequestRef.current) return;
        setSelection({ text: result.text, rects: result.rects ?? [], page: result.page });
      })
      .catch(() => undefined);
  }, [pdfDoc, currentPage, pageLimit, path]);

  // ------------------------------------------------------------ SyncTeX

  const highlight = useCallback((page: number, rect: { x: number; y: number; width: number; height: number } | null) => {
    highlightRef.current = rect ? { page, rect } : null;
    // `fwdSearchMark.hideStep = 0` (`SearchAndDDE.cpp:1624`): a new result starts
    // the fade over again.
    highlightSerialRef.current += 1;
    setVersion((value) => value + 1);
  }, []);

  const scrollToPosition = useCallback(
    (page: number, x: number, y: number, options: { highlight?: boolean } = {}) => {
      // `pdf.synctexForwardSearch` gates forward search, whose only entry point in
      // the PDF subsystem is this reveal.
      if (!setting.bool('pdf.synctexForwardSearch')) return;
      goToPage(page, { record: true });
      const geometry = geometryByPage.get(Math.min(pageLimit(), Math.max(1, Math.round(page))));
      const container = containerRef.current;
      if (geometry && container) {
        const top = geometry.y + y * geometry.zoomReal - container.clientHeight * 0.3;
        scrollToOffset(Math.max(0, Math.min(layout.canvasSize.dy - layout.viewPort.dy, top)));
      }
      if (options.highlight !== false && setting.bool('pdf.highlightSyncPosition')) {
        highlight(page, { x, y, width: 4, height: 14 });
      }
    },
    [goToPage, geometryByPage, pageLimit, scrollToOffset, layout, highlight]
  );

  // Cancel outstanding renders when the viewer unmounts.
  useEffect(() => {
    return () => {
      /*
       * The momentum frame loop first, and it is the one cleanup here that is not
       * merely tidiness.
       *
       * `tick` re-arms itself while the integrator is still moving, and the
       * integrator only stops moving because a tick decays its velocity — but a
       * tick cannot run once the scroller is gone: `applyMomentumDelta` returns
       * before reaching `integrator.tick` when `containerRef.current` is null, so
       * the velocity never decays, `integrator.active` stays true for ever, and
       * the tail re-arms a frame handle on every frame of the window's life. The
       * guard that ends the loop is the very thing the missing container prevents
       * from running.
       *
       * Closing a PDF mid-glide is the ordinary way to reach it: the scroller
       * unmounts (the viewer falls back to "No PDF yet."), `containerRef` is
       * nulled, and the orphaned loop keeps its closure and its velocity with
       * nothing left to move. Nothing else can stop it either — a remount builds a
       * fresh `momentumRef`, so the runaway handle is unreachable.
       */
      stopSmoothScroll();
      for (const request of inFlightRef.current.values()) {
        void window.eukoliaApi.pdfCancelRender(request.requestId).catch(() => undefined);
      }
      inFlightRef.current.clear();
      for (const rendered of renderedRef.current.values()) 
      renderedRef.current.clear();
      // A queued draw whose entry has just gone would be a no-op anyway; dropping
      // it keeps the queue from being drained for a viewer that no longer exists.
      paintQueueRef.current.length = 0;
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    };
  }, [stopSmoothScroll]);

  // External forward-search requests.
  useEffect(() => {
    const off = globalEvents.on<{ page: number; x: number; y: number; width: number; height: number }>('pdf:highlight', (payload) => {
      if (!payload) return;
      scrollToPosition(payload.page, payload.x, payload.y);
      if (setting.bool('pdf.highlightSyncPosition')) {
        highlight(payload.page, { x: payload.x, y: payload.y, width: payload.width, height: payload.height });
      }
    });
    return off;
  }, [scrollToPosition, highlight]);

  // Load the text layer for pages as they become visible, used for selection and
  // for the content box `kZoomFitContent` measures.
  useEffect(() => {
    if (!path) return;
    let cancelled = false;

    const load = async () => {
      /**
       * The text layer is geometry, not appearance, so it follows the same rule as
       * the pixels: it waits for the movement to stop. Its runs are placed from
       * `zoomReal` with one `measureText` per span (hundreds per page), and a page
       * that is merely *scrolling* into view wants none of that rebuilt — the runs
       * are placed against the page, not the viewport, so a scroll cannot change a
       * single one of them, and the settle pass rebuilds whatever a remount lost.
       */
      if (interactingRef.current || resizingRef.current) return;
      /**
       * Only the mounted pages have a host to lay runs into, so only they are built
       * — the text for a page that is not in the DOM is a `pdfText` call and a
       * hundred spans of work with nowhere to go.
       */
      const mounted = mountedPageNumbersRef.current;
      for (const pageNumber of visiblePagesRef.current) {
        if (!mounted.has(pageNumber)) continue;
        /**
         * A page whose text is already known still has to be laid out again: the
         * runs are positioned from `zoomReal`, so their boxes are a function of the
         * scale. Skipping cached pages — which is what this loop used to do — left
         * every run at the scale it was first built for, which is invisible (the
         * layer is transparent) right up to the moment a selection starts in the
         * wrong place, or a drag that should select text pans the page instead.
         */
        const known = textCacheRef.current.get(pageNumber);
        if (known) {
          // Through the frame queue: laying out a page's runs is hundreds of DOM
          // nodes, and doing that for every page that just mounted lands in the
          // same frame the bitmaps do. One page per frame keeps the burst off the
          // frame the reader is waiting on.
          schedulePaint(() => renderTextLayer(pageNumber, known));
          continue;
        }
        try {
          const blocks = await window.eukoliaApi.pdfText(path, pageNumber - 1);
          if (cancelled) return;
          textCacheRef.current.set(pageNumber, blocks);
          const box = contentBoxOf(blocks);
          if (box) {
            contentBoxRef.current.set(pageNumber, box);
            setContentVersion((value) => value + 1);
          }
          schedulePaint(() => renderTextLayer(pageNumber, blocks));
        } catch {
          /* a page without text is normal for scanned documents */
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
    // `geometryByPage` is what the runs are placed against, and `renderTextLayer`
    // is rebuilt whenever it changes, so depending on it is depending on the
    // callback without naming it before its declaration.
  }, [path, version, effectiveScale, geometryByPage, mountedPageNumbers, schedulePaint]);

  // `kZoomFitContent` needs the current page's content box, which may not be in
  // the visible set yet; light-pdf asks the engine for it on demand.
  useEffect(() => {
    if (!path || zoomMode !== 'fit-content') return;
    const page = Math.min(Math.max(1, currentPage), pageLimit());
    if (contentBoxRef.current.has(page)) return;
    let cancelled = false;
    void window.eukoliaApi
      .pdfText(path, page - 1)
      .then((blocks) => {
        if (cancelled) return;
        const box = contentBoxOf(blocks);
        if (!box) return;
        contentBoxRef.current.set(page, box);
        setContentVersion((value) => value + 1);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path, zoomMode, currentPage, pageLimit, contentVersion]);

  /**
   * Measures a run the way the browser will lay it out, so the text layer can be
   * given the PDF run's own geometry instead of whatever the fallback font
   * happens to produce.
   *
   * One shared 2D context is reused: creating a canvas per span would be
   * thousands of canvases per page, and the context is only ever interrogated for
   * metrics, never painted.
   */
  const measureCanvasRef = useRef<CanvasRenderingContext2D | null>(null);
  /**
   * `measureText` results, by `text|fontSize|family`.
   *
   * The layer is rebuilt whenever the scale changes, and a page has hundreds of
   * spans whose strings repeat heavily (the same word, the same size, the same
   * face), so the same measurement is asked for over and over. Measuring is a font
   * shaping call in the browser — cheap once, not cheap a thousand times per scale
   * step — and the answer cannot change while the font stack and the size are the
   * same, which is what the key says.
   */
  const measureCacheRef = useRef(new Map<string, RunMeasurement>());
  const measureRun = useCallback(
    (text: string, fontSize: number, fontFamily: string): RunMeasurement | null => {
      const key = `${fontSize}|${fontFamily}|${text}`;
      const cached = measureCacheRef.current.get(key);
      if (cached) return cached;
      if (!measureCanvasRef.current) {
        const canvas = document.createElement('canvas');
        measureCanvasRef.current = canvas.getContext('2d');
      }
      const context = measureCanvasRef.current;
      if (!context) return null;
      context.font = `${fontSize}px ${fontFamily}`;
      const metrics = context.measureText(text);
      // `fontBoundingBoxAscent` is the distance from the line box's top to the
      // baseline, which is exactly the quantity `RunMeasurement.ascent` names.
      // Browsers that do not implement it report `undefined`; the geometry then
      // falls back to the conventional 0.8 em.
      const ascent = typeof metrics.fontBoundingBoxAscent === 'number' ? metrics.fontBoundingBoxAscent : 0;
      const measurement = { width: metrics.width, ascent };
      // Bounded: a very long document at very many zoom steps must not grow this
      // without limit. Dropping it wholesale is right — the entries are pure
      // functions of their key and the next rebuild refills what it needs.
      if (measureCacheRef.current.size > 8192) measureCacheRef.current.clear();
      measureCacheRef.current.set(key, measurement);
      return measurement;
    },
    []
  );

  /**
   * The scale each page's text layer was last built at.
   *
   * The runs are positioned from `zoomReal`, so a scale change invalidates the layer —
   * and *only* a scale change does. A scroll moves the viewport, not the runs, so
   * rebuilding on a scroll is hundreds of `span`s, a `measureText` each and a style
   * recalculation per page, for a layer whose boxes did not move. Measured with
   * `.scratch/perf/velocity.mjs`, that rebuild was the whole of the late-frame cost at
   * speed: **20 frames over a vsync in 828, and only 13 new nodes in the frames that
   * had any — no page mount, no canvas, no engine request**.
   */
  const textLayerScaleRef = useRef(new Map<number, number>());

  /**
   * Builds the transparent HTML text layer for a page.
   *
   * The geometry is `pdf-text-layer.ts`'s: each run gets the PDF span's own box,
   * the font size MuPDF reports, a font stack chosen from the embedded face's
   * PostScript name, and a `scaleX` that stretches the chosen font's advance
   * width onto the PDF run's advance width. That last part is what makes the
   * layer line up with the glyphs underneath — without it the run's width is the
   * browser's guess and the hit target drifts off the end of the line.
   */
  const renderTextLayer = useCallback(
    (pageNumber: number, blocks: PdfTextBlock[]): void => {
      const host = textRefs.current.get(pageNumber);
      const page = geometryByPage.get(pageNumber);
      if (!host || !page) return;
      // The layer already stands at this scale, so its boxes are the ones it would
      // build. The host is checked for children as well: a page that remounted has a
      // new, empty host whatever the map says.
      if (textLayerScaleRef.current.get(pageNumber) === page.zoomReal && host.childElementCount > 0) return;

      const runs = textLayerRuns(blocks, page.zoomReal, measureRun);
      const elements = runs.map((run) => {
        const element = document.createElement('span');
        element.textContent = run.text;
        // Recorded so a probe can check the layer against the PDF geometry
        // without reverse-engineering styles.
        element.dataset.pdfRun = run.font;
        element.style.position = 'absolute';
        element.style.left = `${run.left}px`;
        element.style.top = `${run.top}px`;
        element.style.width = `${run.width}px`;
        element.style.height = `${run.height}px`;
        element.style.fontSize = `${run.fontSize}px`;
        element.style.fontFamily = run.fontFamily;
        element.style.lineHeight = '1';
        // The run must not wrap: a span that broke across two lines would put
        // half its text outside the PDF box it is standing in for.
        element.style.whiteSpace = 'pre';
        // The bitmap supplies the appearance; the layer supplies the geometry.
        element.style.color = 'transparent';
        // Scale about the run's own top-left corner, which is the origin
        // `left`/`top` were resolved against, so the stretch moves the right edge
        // only and never the box the run stands in.
        element.style.transformOrigin = '0 0';
        element.style.transform = `scaleX(${run.scaleX})`;
        element.style.cursor = 'text';
        return element;
      });

      host.replaceChildren(...elements);
      textLayerScaleRef.current.set(pageNumber, page.zoomReal);
    },
    [geometryByPage, measureRun]
  );

  // --------------------------------------------------------------- handle API

  const canNavigateBack = historyRef.current.index > 0;
  const canNavigateForward = historyRef.current.index >= 0 && historyRef.current.index < historyRef.current.entries.length - 1;

  useEffect(() => {
    onNavigationStateChange?.(canNavigateBack, canNavigateForward);
  }, [canNavigateBack, canNavigateForward, onNavigationStateChange]);

  useEffect(() => {
    onEffectiveScaleChangeRef.current?.(effectiveScale);
  }, [effectiveScale]);

  // A display-mode change keeps the current page, as `SetDisplayMode` does.
  useEffect(() => {
    if (pageCount === 0) return;
    if (!isContinuousDisplayMode(resolvedDisplayMode)) {
      setStartPage((previous) => (previous === currentPage ? previous : currentPage));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedDisplayMode, pageCount]);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      goToPage: (page) => goToPage(page),
      nextPage,
      previousPage: () => previousPage(),
      setZoom: (zoomValue) => applyZoom(zoomValue, 'custom'),
      setZoomMode: (mode) => applyZoomMode(mode),
      zoomStep: (direction) => stepZoom(direction),
      scrollToPosition,
      highlight,
      find,
      findNext: () => stepSearch(1),
      findPrevious: () => stepSearch(-1),
      clearSearch: () => {
        setSearchMatches([]);
        publishSearchState(0, 0);
      },
      getZoom: () => scaleRef.current,
      getCurrentPage: () => currentPage,
      selectAll,
      copySelection,
      clearSelection: () => setSelection(null),
      getSelectionText: () => selectionRef.current?.text ?? '',
      scrollToTop: () => scrollToOffset(0),
      scrollBy: (deltaY) => scrollToOffset((containerRef.current?.scrollTop ?? 0) + deltaY),
      toggleAutoScroll,
      // `LightPDF.cpp:6323-6356` — pt → mm → in → off.
      toggleCursorPosition: () => {
        setCursorPositionUnit((current) => {
          const next = current === 'pt' ? 'mm' : current === 'mm' ? 'in' : current === 'in' ? 'off' : 'pt';
          if (next === 'off') setCursorPosition(null);
          else {
            const container = containerRef.current;
            if (container && pointerInsideRef.current) {
              const point = pointAt(pointerRef.current);
              if (point) setCursorPosition({ x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 });
            }
          }
          return next;
        });
      },
      canNavigateBack: () => historyRef.current.index > 0,
      canNavigateForward: () => historyRef.current.index < historyRef.current.entries.length,
      // `DisplayModel::Navigate(-1)`: write the live view into the cursor's slot,
      // step the cursor, then restore. A restore is not itself navigation.
      navigateBack: () => {
        const history = historyRef.current;
        if (history.index <= 0) return;
        const current = currentScrollState();
        if (history.index < history.entries.length) history.entries[history.index] = current;
        else history.entries.push(current);
        history.index -= 1;
        setHistoryVersion((value) => value + 1);
        restoreScrollState(history.entries[history.index]);
      },
      navigateForward: () => {
        const history = historyRef.current;
        if (history.index >= history.entries.length) return;
        const current = currentScrollState();
        if (history.index < history.entries.length) history.entries[history.index] = current;
        else history.entries.push(current);
        history.index += 1;
        setHistoryVersion((value) => value + 1);
        restoreScrollState(history.entries[history.index]);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    handleRef, goToPage, nextPage, previousPage, applyZoom, applyZoomMode, stepZoom, scrollToPosition, highlight, find,
    stepSearch, publishSearchState, selectAll, copySelection, currentPage, historyVersion, scrollToOffset,
    currentScrollState, restoreScrollState, toggleAutoScroll, pointAt
  ]);

  // ------------------------------------------------------------------ render

  if (!path) {
    return (
      <div style={{ ...centered, background: backdrop }}>
        <div style={{ color: canvasText, fontSize: 13, textAlign: 'center', opacity: 0.7 }}>
          No PDF yet.
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>Build the project to produce one.</div>
        </div>
      </div>
    );
  }

  /**
   * `Canvas.cpp:3191-3219` — the platform scrollbar is hidden outright in
   * `hidden` mode and replaced by light-pdf's own overlay window in `smart` and
   * `overlay`; only `windows` leaves it alone. The page slider forces it back
   * because there is nothing else to turn pages with.
   */
  const suppressNativeScrollbar = useOverlayScrollbar || (lightPdfScrollbarsHidden(scrollbarMode) && !pageSlider);

  /**
   * `LightPDF.cpp:1217` — `showHScroll = (viewPort.dx < canvas.dx) && !hideScrollbar`:
   * the horizontal overlay bar exists only while the canvas is wider than the
   * viewport. Reading it from the layout rather than from the scroller's own
   * metrics keeps it a function of the document, not of a measurement taken
   * after the last paint.
   */
  const showHorizontalOverlay =
    suppressNativeScrollbar && !lightPdfScrollbarsHidden(scrollbarMode) && layout.canvasSize.dx > containerSize.width + 1;

  return (
    <div
      ref={rootRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        // The viewer fills the pane and nothing else. There is deliberately no
        // `max-width`: the pane's right edge is the window's right edge, and a
        // cap of the viewer's own would let its right edge float free of it —
        // which is exactly what it did, because the cap had to be written from a
        // measurement and a measurement taken from inside this subtree sees the
        // subtree's own layout rather than the window's.
        //
        // No `max-height` either, and for a subtler reason. The height cap belongs
        // on the *scroller*, which is the box the pages are inside; on this root it
        // constrains nothing — a `max-height` on a parent does not make that
        // parent's height definite, so `height: 100%` on the child still resolves
        // to `auto` — it only inflates this box, and this box is what reports the
        // viewport the pages are laid out in. With the cap here the viewer measured
        // the canvas as its own viewport and drew blank where the pages should be.
        background: backdrop
      }}
      data-scrollbar-mode={scrollbarMode}
      // The viewer owns its own wheel: a notch is a light-pdf scroll plan — the
      // momentum integrator, the page turn, the Ctrl+wheel zoom — or, later, the
      // plan of whichever engine replaces it. The shell's smooth-scroll handler
      // stops at this attribute, so the two never write `scrollTop` at once.
      {...{ [NATIVE_SCROLL_ATTRIBUTE]: 'true' }}
    >
      {suppressNativeScrollbar && (
        <style>{`
          [data-eukolia-pdf-scroll] { scrollbar-width: none; -ms-overflow-style: none; }
          [data-eukolia-pdf-scroll]::-webkit-scrollbar { width: 0; height: 0; }
        `}</style>
      )}
      {/*
        `SearchAndDDE.cpp:1485` — the forward-search mark's alpha is
        `0x5f * (HIDE_FWDSRCHMARK_STEPS - hideStep) / HIDE_FWDSRCHMARK_STEPS`, one
        step per decay interval, so it fades out in equal fifths.
      */}
      <style>{`
        @keyframes eukolia-pdf-fwdsearch-fade {
          from { opacity: 1; }
          to { opacity: 0; }
        }
      `}</style>
      <div
        ref={attachScroller}
        onScroll={handleScroll}
        data-eukolia-pdf-scroll=""
        style={{
          width: '100%',
          height: '100%',
          // The scroller carries the height bound itself, not only its parent.
          //
          // `height: 100%` resolves only against a *definite* parent height, and a
          // `max-height` does not make a box definite — so a scroller relying on
          // its parent's cap falls back to `height: auto`, sizes itself to the
          // canvas (1578px in a 472px parent), and grows straight past it. That is
          // the runaway: `clientHeight` then reports the canvas height the viewer
          // computed, the layout is built around it, and `DocumentLayout::Relayout`
          // centres the pages inside it, hundreds of pixels below the pane.
          //
          // A block with `overflow: auto` and a `max-height` of its own scrolls at
          // that height instead, which is the whole point of a scroll container and
          // cannot be undone by an ancestor.
          //
          // No `max-width` for the same reason the root has none: the width comes
          // from the pane, and the scroller's right edge — and the scrollbar drawn
          // against it — is the pane's.
          maxHeight: paneBound ? paneBound.height : undefined,
          overflow: 'auto',
          overscrollBehavior: 'contain'
        }}
        data-testid="pdf-scroll-container"
        // Which document this viewer actually holds. The pane follows the last
        // build's output, so after a failing build of another file it is showing
        // *that* file's PDF — a one-page document where the root document has
        // two. Naming the document here is what turns "the page commands do
        // nothing" into "the page commands are correct for the document on
        // screen", which is the difference between a viewer bug and a fixture
        // that asserted against the wrong build.
        data-document-path={path ?? ''}
        // `data-render-status`, `data-paint-status`, `data-render-attempts`,
        // `data-update-calls`, `data-visible-pages` and `data-selection-length` are
        // written imperatively (see `setRenderStatus` and the effect below): they
        // change many times a second while pages are being rasterised, and as React
        // attributes each change re-rendered the whole viewer.
        data-scale={effectiveScale.toFixed(3)}
        data-display-mode={resolvedDisplayMode}
        data-zoom-mode={zoomMode}
        // The viewer's own view of the document, next to the pane's copy of it
        // (`LightPdfToolbar`'s `data-page-count`). The page commands compute their
        // target from the pane's copy, so when the two disagree, `End` and `N`
        // silently do nothing while every direct viewer call keeps working.
        data-doc-page-count={pageCount}
        data-start-page={startPage}
        data-rotation={rotation}
        // True when the whole-page allocation guard (`LIGHTPDF_MAX_RENDER_SCALE`)
        // is asking for fewer device pixels than the sheet occupies — i.e. when
        // the guard, not the engine and not this viewer, is what makes the page
        // soft. It is a diagnostic, not a fault, and it needs a zoom far outside
        // normal reading (1600 % on a 100 %-scale display) to say yes.
        data-render-scale-constrained={renderScaleConstrained(effectiveScale, canvasDevicePixelRatio, LIGHTPDF_MAX_RENDER_SCALE) ? '1' : '0'}
      >
        <div
          ref={canvasHostRef}
          style={{ position: 'relative', width: layout.canvasSize.dx, height: layout.canvasSize.dy }}
        >          {mountedPages.map((page) => {
            const geometry = geometryByPage.get(page.pageNo);
            if (!geometry) return null;
            const rendered = renderedRef.current.get(page.pageNo);
            /**
             * The canvas's CSS box, which is *not* the sheet's: the engine rounds
             * the page's device box outward and the layout rounds the sheet to a
             * fraction, so a sheet-sized canvas is a fractional rescale of its own
             * backing store and the compositor filters every glyph edge. Sized from
             * the bitmap it is an exact blit — the 1:1 case the measurement in
             * `canvasDisplayBox` documents.
             */
            const canvasBox = canvasDisplayBox(
              rendered ? { width: rendered.width, height: rendered.height, scale: rendered.scale } : undefined,
              { width: geometry.sheetWidth, height: geometry.sheetHeight },
              geometry.zoomReal,
              canvasDevicePixelRatio
            );
            const activeHighlight = highlightRef.current?.page === page.pageNo ? highlightRef.current.rect : null;
            const matches = searchMatches.filter((match) => match.page === page.pageNo);
            const currentMatch = searchMatches[searchIndex];

            return (
              <div
                key={page.pageNo}
                data-page={page.pageNo}
                style={{
                  position: 'absolute',
                  left: geometry.x,
                  top: geometry.y,
                  width: geometry.width,
                  height: geometry.height,
                  // `Canvas.cpp` — the placeholder is `ThemeDocumentColors`'s
                  // background, so an unrendered page never flashes a different
                  // colour and a page in flight is invisible rather than white.
                  background: backdrop,
                  overflow: 'hidden'
                }}
              >
                {/* The sheet carries the page bitmap, its text layer and its
                    links; rotating the sheet keeps all three consistent. */}
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: geometry.sheetWidth,
                    height: geometry.sheetHeight,
                    transformOrigin: '0 0',
                    transform: sheetTransform(geometry.sheetWidth, geometry.sheetHeight, rotation),
                    background: rendered?.image ? '#ffffff' : 'transparent'
                  }}
                >
                  {/*
                    The canvas is *hosted*, not rendered: React owns this box, the
                    pool owns the canvas inside it (`attachPageCanvas`). That is what
                    lets a page hand its 10 MB backing store to the next page instead
                    of allocating a new one at the moment it scrolls into view.
                    `data-canvas-width` is how the box tells the pool which size it
                    wants, so a pooled canvas of the right size is preferred.
                  */}
                  <div
                    ref={attachCanvasRef}
                    data-canvas-for={page.pageNo}
                    data-canvas-width={Math.round(canvasBox.width * canvasDevicePixelRatio)}
                    style={{ width: canvasBox.width, height: canvasBox.height }}
                  />

                  <div
                    ref={attachTextRef}
                    data-text-layer={page.pageNo}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      // The runs inside are transparent and supply geometry only:
                      // hit testing ("is the pointer over text?"), and the PDF
                      // boxes the viewer reasons about. The rasterised page
                      // supplies the appearance.
                      //
                      // `userSelect` is off on purpose. Selection here is
                      // light-pdf's own model, not the DOM's: the gesture layer
                      // asks the native `TextSelection` for the rectangles
                      // (`runSelection` → `pdfSelect`) and paints them itself, and
                      // the copy command reads that text back. Leaving the browser
                      // free to select the same text as well would paint a second,
                      // differently-shaped highlight over the first — the spans
                      // carry a `scaleX`, so the browser's highlight would not even
                      // agree with ours about where the run ends.
                      //
                      // `mixBlendMode: 'multiply'` used to be here. It was not in
                      // light-pdf — nothing in the reference blends its text layer
                      // — and a blend mode forces this subtree into its own
                      // compositing group, which changes how the page beneath it is
                      // rasterised. The glyphs are transparent, so the blend bought
                      // nothing, and it was removed.
                      userSelect: 'none'
                    }}
                  />

                  {/*
                    The user's own selection, painted the way `Selection.cpp`
                    paints it: `FixedPageUI.SelectionColor` at
                    `kSelectionDefaultAlpha`, padded by two pixels so adjacent
                    line rectangles read as one block rather than as stripes.
                  */}
                  {selection?.page === page.pageNo &&
                    selection.rects.map((rect, rectIndex) => (
                      <div
                        key={`${page.pageNo}-selection-${rectIndex}`}
                        data-testid="pdf-selection-rect"
                        style={{
                          position: 'absolute',
                          left: rect.x * geometry.zoomReal - LIGHTPDF_SELECTION_PAD,
                          top: rect.y * geometry.zoomReal - LIGHTPDF_SELECTION_PAD,
                          width: Math.max(2, rect.width * geometry.zoomReal + LIGHTPDF_SELECTION_PAD * 2),
                          height: Math.max(2, rect.height * geometry.zoomReal + LIGHTPDF_SELECTION_PAD * 2),
                          background: withAlpha(selectionColor, selectionAlpha),
                          pointerEvents: 'none'
                        }}
                      />
                    ))}

                  {matches.map((match, index) => {
                    const isCurrent = currentMatch === match;
                    return (
                      <React.Fragment key={`${page.pageNo}-match-${index}`}>
                        {match.rects.map((rect, rectIndex) => (
                          <div
                            key={`${page.pageNo}-match-${index}-${rectIndex}`}
                            style={{
                              position: 'absolute',
                              // `Selection.cpp` — `PaintTransparentRectangles(pad)`.
                              left: rect.x * geometry.zoomReal - LIGHTPDF_SELECTION_PAD,
                              top: rect.y * geometry.zoomReal - LIGHTPDF_SELECTION_PAD,
                              width: Math.max(2, rect.width * geometry.zoomReal + LIGHTPDF_SELECTION_PAD * 2),
                              height: Math.max(2, rect.height * geometry.zoomReal + LIGHTPDF_SELECTION_PAD * 2),
                              // `SearchAndDDE.cpp` — the current match uses
                              // `FixedPageUI.SelectionColor`, the rest use
                              // `kFindOtherMatchColor`; both at `kSelectionDefaultAlpha`.
                              background: withAlpha(
                                isCurrent ? selectionColor : LIGHTPDF_FIND_OTHER_MATCH_COLOR,
                                selectionAlpha
                              ),
                              pointerEvents: 'none'
                            }}
                          />
                        ))}
                      </React.Fragment>
                    );
                  })}

                  {/*
                    `SearchAndDDE.cpp:1458-1488` — `PaintForwardSearchMark`.

                    With `ForwardSearch.HighlightOffset` at its default of 0 the
                    highlight is the result rectangle itself, inflated by 2 points
                    the way `CvtToScreen` + `PaintTransparentRectangles` paint it.
                    Above 0 the style changes to a marker in the page's left
                    margin: `rect.x = pageOnScreen.x + offset * zoom`, width
                    `HighlightWidth * zoom`, grown 4 points above and below.
                    `HighlightPermanent` decides whether it fades away
                    (`HIDE_FWDSRCHMARK_DELAY_IN_MS` / `_STEPS`, `:1485`).
                  */}
                  {activeHighlight && (
                    <div
                      data-testid="pdf-forward-search-mark"
                      data-permanent={forwardSearch.permanent ? '1' : '0'}
                      // A new result re-keys the element so the fade starts over.
                      key={`fwd-${highlightSerialRef.current}`}
                      style={{
                        position: 'absolute',
                        ...(forwardSearch.offset > 0
                          ? {
                              left: forwardSearch.offset * geometry.zoomReal,
                              top: activeHighlight.y * geometry.zoomReal - 4,
                              width: Math.max(2, forwardSearch.width * geometry.zoomReal),
                              height: Math.max(2, activeHighlight.height * geometry.zoomReal + 8)
                            }
                          : {
                              left: activeHighlight.x * geometry.zoomReal - 2,
                              top: activeHighlight.y * geometry.zoomReal - 2,
                              width: Math.max(6, activeHighlight.width * geometry.zoomReal + 4),
                              height: Math.max(6, activeHighlight.height * geometry.zoomReal + 4)
                            }),
                        background: withAlpha(forwardSearch.color, selectionAlpha),
                        pointerEvents: 'none',
                        // `HIDE_FWDSRCHMARK_DELAY_IN_MS` then one step per
                        // `HIDE_FWDSRCHMARK_DECAYINTERVAL_IN_MS`; permanent keeps it.
                        animation: forwardSearch.permanent
                          ? undefined
                          : `eukolia-pdf-fwdsearch-fade ${LIGHTPDF_FORWARD_SEARCH_FADE_STEPS * 120}ms linear ${LIGHTPDF_FORWARD_SEARCH_FADE_DELAY_MS}ms forwards`
                      }}
                    />
                  )}

                  <PageLinks path={path} page={page.pageNo} scale={geometry.zoomReal} onGoToPage={(target) => goToPage(target)} />
                </div>

                {!rendered?.image && (
                  // `Canvas.cpp` draws "Couldn't render page %d" in the document
                  // text colour on the canvas; the same colour marks a page that
                  // is still on its way.
                  <div style={{ ...centered, color: canvasText, fontSize: 12, opacity: 0.55 }}>Rendering page {page.pageNo}…</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/*
        `LightPDF.cpp:6323-6356` — `CmdToggleCursorPosition`'s tip. light-pdf's
        is a notification window over the canvas showing
        `FormatCursorPositionTemp`'s "x x y unit"; the unit cycles pt → mm → in
        and the fourth press removes it.
      */}
      {cursorPositionUnit !== 'off' && (
        <div
          data-testid="pdf-cursor-position"
          data-unit={cursorPositionUnit}
          style={{
            position: 'absolute',
            left: 8,
            top: 8,
            zIndex: 12,
            padding: '3px 7px',
            borderRadius: 4,
            background: bgrToHex(themeControlBackgroundColor(theme)),
            color: bgrToHex(themeWindowTextColor(theme)),
            border: `1px solid ${bgrToHex(themeWindowLinkColor(theme))}`,
            fontFamily: 'Segoe UI, system-ui, sans-serif',
            fontSize: 11,
            pointerEvents: 'none',
            whiteSpace: 'nowrap'
          }}
        >
          {cursorPosition ? `Cursor position: ${formatCursorPosition(cursorPosition, cursorPositionUnit)}` : `Cursor position: (${cursorPositionUnit})`}
        </div>
      )}

      <SelectionToolbar
        selection={selection}
        geometry={selection ? geometryByPage.get(selection.page) ?? null : null}
        theme={theme}
        enabled={selectionToolbarEnabled}
        onCopy={copySelection}
      />

      {/*
        `LightPDF.cpp:1145-1150` — `ScrollbarsOverlayMode`: only `overlay`
        (`Mode::Thick`) pins the bar open; `smart` lets it hide itself. `windows`
        and `hidden` draw no overlay at all.

        The horizontal bar is the second of the two light-pdf creates
        (`LightPDF.cpp:1226` for `Type::Horz`, `:1281` for `Type::Vert`), and it
        is the only thing that makes a page wider than the pane reachable when
        the native bar is suppressed. It is therefore pinned to `Thick` even in
        `smart` mode, where the vertical bar is allowed to hide: a bar that
        auto-hides after five seconds is a fine affordance for vertical scrolling
        (the wheel covers that axis) and a dead end for horizontal scrolling,
        where it is the only control there is.
      */}
      {useOverlayScrollbar && (
        <OverlayScrollbar
          scroller={scroller}
          theme={theme}
          contentVersion={version + pageCount}
          mode={lightPdfOverlayScrollbarMode(scrollbarMode)}
        />
      )}
      {showHorizontalOverlay && (
        <OverlayScrollbar
          scroller={scroller}
          theme={theme}
          contentVersion={version + pageCount}
          mode="Thick"
          orientation="horizontal"
        />
      )}

      {loading && (
        <div style={{ ...overlay, background: backdrop }}>
          <div style={{ color: canvasText, fontSize: 13, opacity: 0.7 }}>Opening PDF…</div>
        </div>
      )}

      {error && (
        <div style={{ ...overlay, background: backdrop }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <div style={{ color: '#c0392b', fontWeight: 600, marginBottom: 6 }}>Could not open the PDF</div>
            <div style={{ color: canvasText, fontSize: 12, lineHeight: 1.5 }}>{error}</div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * `SelectionToolbar.cpp:61-84` — light-pdf's floating card next to a text
 * selection. Its candidate buttons are Copy, Translate, Read Aloud, Highlight,
 * Underline, Squiggly and Strike Out; `InitButtons` (`:71-84`) drops the ones
 * `GetCommandVisibility` marks `CommandShouldRemove`, which is why a build with
 * no annotations shows fewer buttons rather than dead ones. Eukolia implements
 * exactly one of those commands, so the card shows exactly one button — the
 * `Annotations.SelectionToolbar` preference is what decides whether it appears.
 *
 * The card's geometry is `SelectionToolbar.cpp:86-92` (a 5px margin, a 2px gap,
 * 10px corner radius, 108 % font), which is why the numbers look arbitrary.
 */
const SelectionToolbar: React.FC<{
  selection: { text: string; rects: PdfRect[]; page: number } | null;
  geometry: PageGeometry | null;
  theme: LightPdfThemeState;
  enabled: boolean;
  onCopy(): boolean;
}> = ({ selection, geometry, theme, enabled, onCopy }) => {
  if (!enabled || !selection?.text || !geometry || selection.rects.length === 0) return null;

  // The selection's own bounding box, in page-space pixels, then converted to a
  // position over the first line's top-left — `SelectionToolbar` is positioned
  // from the selection's screen rectangle.
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const rect of selection.rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  const controlBg = bgrToHex(themeControlBackgroundColor(theme));
  const textColor = bgrToHex(themeWindowTextColor(theme));

  return (
    <div
      data-testid="pdf-selection-toolbar"
      data-commands="CmdCopySelection"
      style={{
        position: 'absolute',
        left: Math.max(0, geometry.x + left * geometry.zoomReal),
        top: Math.max(0, geometry.y + (top + (bottom - top)) * geometry.zoomReal + 5),
        zIndex: 18,
        display: 'flex',
        gap: 2,
        padding: 5,
        borderRadius: 10,
        background: controlBg,
        color: textColor,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
        fontFamily: 'Segoe UI, system-ui, sans-serif',
        fontSize: '108%'
      }}
    >
      <button
        type="button"
        title="Copy"
        // `SelectionToolbar.cpp:64` — the candidate list's first button is
        // `CmdCopySelection, "Copy"`, and it is the one command Eukolia has.
        onClick={(event) => {
          event.stopPropagation();
          onCopy();
        }}
        style={{
          padding: '4px 8px',
          borderRadius: 6,
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer'
        }}
      >
        Copy
      </button>
    </div>
  );
};

/**
 * `LightPDF.cpp:3173-3210` — `FormatCursorPositionTemp`.
 *
 * The position arrives in PDF points; the reference divides it by the engine's
 * *file* DPI (72 for PDF, so it becomes inches, `:3180-3181`) and then multiplies
 * by 72 for `pt`, 25.4 for `mm` and 1 for `in`. It clamps a negative position to
 * zero, prints `"x x y unit"`, and trims the last decimal digit of the two metric
 * units so every unit reads at the same precision (`:3200-3208`).
 */
export function formatCursorPosition(
  point: { x: number; y: number },
  unit: 'pt' | 'mm' | 'in'
): string {
  const factor = unit === 'pt' ? 72 : unit === 'mm' ? 25.4 : 1;
  const format = (value: number): string => {
    const inches = Math.max(0, value) / 72;
    const scaled = inches * factor;
    // `in` keeps its full precision; the metric units lose the last digit.
    const rounded = unit === 'in' ? Math.round(scaled * 100) / 100 : Math.round(scaled * 10) / 10;
    return `${rounded}`;
  };
  return `${format(point.x)} x ${format(point.y)} ${unit}`;
}

/** Internal links inside a page; external links open in the OS browser. */
const PageLinks: React.FC<{
  path: string;
  page: number;
  scale: number;
  onGoToPage(page: number): void;
}> = ({ path, page, scale, onGoToPage }) => {
  const [links, setLinks] = useState<PdfLink[]>([]);

  useEffect(() => {
    let cancelled = false;
    void window.eukoliaApi
      .pdfLinks(path, page - 1)
      .then((result) => {
        if (!cancelled) setLinks(result);
      })
      .catch(() => {
        if (!cancelled) setLinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [path, page]);

  if (links.length === 0) return null;

  return (
    <>
      {links.map((link, index) => (
        <div
          key={`${page}-link-${index}`}
          data-link={`${page}-${index}`}
          title={link.uri ?? (link.page ? `Page ${link.page}` : undefined)}
          onClick={(event) => {
            event.stopPropagation();
            // Light-pdf's Ctrl+click on an internal link opens the document in a
            // new window; Eukolia has one PDF pane, so a modified click is left to
            // the pane's own Ctrl+click binding (inverse SyncTeX) instead of
            // navigating in place as well.
            if (event.ctrlKey || event.metaKey) return;
            if (link.uri) {
              void window.eukoliaApi.openExternal(link.uri);
            } else if (link.page) {
              onGoToPage(link.page);
            }
          }}
          style={{
            position: 'absolute',
            left: link.rect.x * scale,
            top: link.rect.y * scale,
            width: Math.max(4, link.rect.width * scale),
            height: Math.max(4, link.rect.height * scale),
            cursor: 'pointer',
            background: 'transparent'
          }}
        />
      ))}
    </>
  );
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let requestCounter = 0;

function nextRequestId(): number {
  return ++requestCounter;
}

/**
 * The room the pane was given: the smallest box that contains the scroller.
 *
 * The viewer lays out for this, and it is what keeps the pane honest about its
 * own size. A scroll container reports `clientHeight` for the box it was given,
 * and normally that box is the space the pane occupies — but nothing inside the
 * viewer stops an ancestor from letting the pane grow to its content, and then
 * `clientHeight` is the canvas height this viewer computed a moment ago. Laying
 * out from that builds the view around a size the view invented: on every
 * relayout `DocumentLayout::Relayout` centres a canvas that is shorter than the
 * viewport (`offY`), translating the pages down by
 * `(viewPortSize.dy - canvasDy) / 2`.
 *
 * That loop hides in the default mode, because `page-fit` makes a page's height
 * track the viewport height, so the canvas and the phantom viewport agree and
 * the shift is nil — a pane can report a viewport of 1578px inside an 864px
 * window and still look right. Any mode whose page height comes from the *width*
 * — `page-width`, or a numeric zoom — makes the canvas far shorter than the
 * phantom viewport instead, and the pages are pushed hundreds of pixels down out
 * of the pane: the reader sees the canvas background and, at most, the blank top
 * of a page.
 *
 * The boxes containing the pane are laid out by the window, not by the pane's
 * content, so the smallest of them is a size the content cannot inflate. In a
 * pane that fits — every healthy window — no containing box is smaller than the
 * scroller itself, so bounding the viewer by it changes nothing.
 *
 * The root element is left out deliberately: it reports the initial containing
 * block, so a document taller than the window would answer with the whole
 * document. A box that reports no size is skipped — a document without layout
 * has nothing to say about how much room the pane was given.
 *
 * The scroller is measured by its **border box** rather than its client box, so
 * that the bound is the room the pane was given even when the pane has a
 * platform scrollbar up. `clientWidth` excludes that bar, so a scroller with one
 * reports a box narrower than the room it occupies — and a `max-width` written
 * from that number shrinks the scroller to it, which is the one way this cap
 * could pull the pane in behind the bar that caused the measurement.
 * `offsetWidth` includes the bar, so it is the box the pane actually occupies.
 */
function containingBound(container: HTMLElement): { width: number; height: number } | null {
  const document = container.ownerDocument;
  let width = Number.POSITIVE_INFINITY;
  let height = Number.POSITIVE_INFINITY;
  for (let node = container.parentElement; node && node !== document?.documentElement; node = node.parentElement) {
    if (node.clientWidth > 0) width = Math.min(width, node.clientWidth);
    if (node.clientHeight > 0) height = Math.min(height, node.clientHeight);
  }
  const own = outerBox(container);
  if (!Number.isFinite(width) && !Number.isFinite(height)) return null;
  return {
    width: Number.isFinite(width) ? width : own.width,
    height: Number.isFinite(height) ? height : own.height
  };
}

/**
 * A scroll container's own box, scrollbar included — `offsetWidth` /
 * `offsetHeight`, falling back to the client box for an element that is not
 * rendered (`offsetWidth` is 0 there, and 0 would collapse the pane).
 *
 * The application sets `box-sizing: border-box` globally, so these are the same
 * pixels a `max-width`/`max-height` is written in.
 */
function outerBox(element: HTMLElement): { width: number; height: number } {
  return {
    width: element.offsetWidth > 0 ? element.offsetWidth : element.clientWidth,
    height: element.offsetHeight > 0 ? element.offsetHeight : element.clientHeight
  };
}

/** `limitValue` for a scroller's own metrics. */
function clampScrollTop(container: HTMLElement, value: number): number {
  return Math.max(0, Math.min(container.scrollHeight - container.clientHeight, value));
}

/**
 * The scroller's range, kept as a value instead of asked for on every frame.
 *
 * `scrollHeight` and `clientHeight` are *layout* reads. On a 200-page document the
 * scroller is 136,400 px tall, so a read that lands while the layout is dirty —
 * which is exactly what a React commit during a scroll leaves behind — forces a
 * synchronous layout of the whole content before the frame can be drawn. The
 * momentum integrator did four such reads per frame (`tick`'s clamp, the `max`
 * bound, and two read-backs to detect a boundary), and the wheel handler did three
 * per notch.
 *
 * light-pdf never re-queries layout on this path: the scroll range lives in the
 * scrollbar's `SCROLLINFO` and the page geometry, and a scroll tick only reads and
 * writes the position (`Canvas.cpp:623-747`). This is the same idea, refreshed
 * when the layout can have changed rather than when the offset does.
 */
function readScrollRange(container: HTMLElement): ScrollRange {
  return {
    maxTop: Math.max(0, container.scrollHeight - container.clientHeight),
    maxLeft: Math.max(0, container.scrollWidth - container.clientWidth),
    clientHeight: container.clientHeight,
    clientWidth: container.clientWidth
  };
}

interface ScrollRange {
  maxTop: number;
  maxLeft: number;
  clientHeight: number;
  clientWidth: number;
}

function clampScrollLeft(container: HTMLElement, value: number): number {
  return Math.max(0, Math.min(container.scrollWidth - container.clientWidth, value));
}

/** `SetZoomVirtual` clamps a numeric zoom to `[kZoomMin, kZoomMax]` percents. */
function clampScale(scale: number): number {
  const percent = lightPdfZoomPercentFromScale(scale);
  const clamped = Math.max(8.33, Math.min(6400, percent));
  return lightPdfScaleFromZoomPercent(clamped);
}

/**
 * The clock the momentum integrator measures `dt` with, in milliseconds.
 *
 * `Canvas.cpp:2262-2267` reads `QueryPerformanceCounter`; the equivalent here is
 * the frame timestamp the browser hands a `requestAnimationFrame` callback, so
 * that is preferred when there is one and `performance.now()` is the fallback for
 * the first tick (which starts the clock before any frame exists).
 *
 * It is a named function rather than an inline `performance.now()` for one
 * reason: a test that runs the frames itself has no real time between them, so
 * `dt` would be a fraction of a millisecond and a notch would crawl instead of
 * gliding. `tests/pdf/viewerBehaviour.test.ts` installs its own clock here and
 * gets an exact, repeatable travel distance — the integrator's arithmetic is
 * still the viewer's.
 */
function frameTimeMs(timestamp?: number): number {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;
  return typeof performance === 'undefined' ? 0 : performance.now();
}

/**
 * Converts a native render result into the pixels a canvas takes: an `ImageData`.
 *
 * The native engine returns raw pixels in BGRA or RGB order; `ImageData`
 * requires RGBA, so the channels are swapped once here rather than in the paint
 * loop.
 */
function toImageData(result: PdfRenderResult): ImageData {
  const { pixels, width, height, order } = result;
  let rgba: Uint8ClampedArray;

  /**
   * The path every page takes.
   *
   * The worker sends one tightly packed buffer per render, so the only work needed
   * is the channel swap — done **in place**, on the buffer that arrived — and an
   * `ImageData` built *over* that same buffer. The previous version allocated twice
   * as much as the page on every render (a swapped copy plus the `ImageData`
   * buffer): 10 MB per A4 page at 125 %, which the profiler caught as 530 ms of
   * garbage collection inside a 6.4 s scroll, with 4–6 ms `MajorGC` pauses landing
   * as dropped frames.
   */
  const expected = width * height * 4;
  if (pixels.byteLength === expected && (order === 'bgra' || order === 'rgba')) {
    if (order === 'bgra') {
      for (let i = 0; i < pixels.length; i += 4) {
        const blue = pixels[i];
        pixels[i] = pixels[i + 2];
        pixels[i + 2] = blue;
      }
    }
    if (width <= 0 || height <= 0) {
      throw new Error(`The PDF engine returned an empty bitmap for this page (${width}x${height}).`);
    }
    // `as ArrayBuffer`: the IPC reply is never a `SharedArrayBuffer`, and
    // `ImageData`'s constructor is typed to reject one.
    const view = new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, expected);
    return new ImageData(view, width, height);
  }

  if (order === 'rgba') {
    rgba = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  } else if (order === 'bgra') {
    rgba = new Uint8ClampedArray(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
      rgba[i] = pixels[i + 2];
      rgba[i + 1] = pixels[i + 1];
      rgba[i + 2] = pixels[i];
      rgba[i + 3] = pixels[i + 3];
    }
  } else if (order === 'bgr') {
    rgba = new Uint8ClampedArray((pixels.length / 3) * 4);
    for (let source = 0, target = 0; source < pixels.length; source += 3, target += 4) {
      rgba[target] = pixels[source + 2];
      rgba[target + 1] = pixels[source + 1];
      rgba[target + 2] = pixels[source];
      rgba[target + 3] = 255;
    }
  } else {
    rgba = new Uint8ClampedArray((pixels.length / 3) * 4);
    for (let source = 0, target = 0; source < pixels.length; source += 3, target += 4) {
      rgba[target] = pixels[source];
      rgba[target + 1] = pixels[source + 1];
      rgba[target + 2] = pixels[source + 2];
      rgba[target + 3] = 255;
    }
  }

  if (width <= 0 || height <= 0) {
    throw new Error(`The PDF engine returned an empty bitmap for this page (${width}x${height}).`);
  }

  // Built via the sized constructor and `set` so the buffer type matches
  // whatever `pixels` came back as, without an unchecked cast.
  const imageData = new ImageData(width, height);
  imageData.data.set(rgba);
  return imageData;
}

/**
 * The device pixel ratio, tracked live.
 *
 * Everything about a page's sharpness is derived from this number: the scale the
 * engine rasterises at, and the CSS box the canvas is displayed in. Reading
 * `window.devicePixelRatio` once and keeping it in a variable would go stale the
 * moment the window is dragged to a display with a different scale factor — the
 * canvas would then be sized for the old grid (turning an exact blit into a
 * fractional one) and the next render would ask for the wrong resolution, with
 * nothing to trigger a repaint.
 *
 * `matchMedia` is the only notification available: there is no `dppx` change
 * event, so a query for the *current* ratio is armed, and re-armed whenever it
 * fires.
 */
function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let query: MediaQueryList | null = null;
    const arm = () => {
      query?.removeEventListener('change', onChange);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener('change', onChange);
    };
    function onChange() {
      setRatio(window.devicePixelRatio || 1);
      arm();
    }
    arm();
    return () => query?.removeEventListener('change', onChange);
  }, []);
  return ratio;
}

const centered: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center'
};

const overlay: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--eu-bg-overlay)',
  backdropFilter: 'blur(1px)'
};

export { clampScale as clampZoom };

