/**
 * Eukolia — light-pdf's per-document view state, ported.
 *
 * light-pdf remembers, per file, the display mode, the zoom, the rotation and
 * the scroll position, and restores them the next time the file is opened:
 * `Settings.h`'s `FileState` (and its `TabState` subset) hold
 *
 *     filePath, displayMode, pageNo, zoom, rotation, scrollPos{x,y}
 *
 * `DisplayModel::GetDisplayState` fills them in, `ReplaceDocumentInCurrentTab`
 * reads them back through `SetInitialViewSettings` + `Relayout` +
 * `SetScrollState`, and `GlobalPrefs.RememberStatePerDocument` decides whether
 * they are used at all.
 *
 * The key property of light-pdf's `ScrollState` is that the scroll position is
 * stored in *page space* (`DisplayModel.h`: "coordinates are in user space units
 * (per page)"), not as a pixel offset: the view is restored to the same place on
 * the same page whatever the window size or zoom happens to be when the document
 * is reopened. `{x: -1, y: -1}` means "that axis was showing its margin, so do not
 * restore it".
 *
 * Eukolia keeps the same records in memory, keyed by resolved PDF path. They are
 * deliberately not written to the settings file: the settings schema is owned
 * outside the PDF viewer, and light-pdf's own file-state list is a separate
 * store (`FileHistory`) rather than a setting.
 */

import type { LightPdfDisplayMode } from './lightpdf-layout';

/** `DisplayModel.h` — `ScrollState`, in page-space units. */
export interface LightPdfScrollState {
  /** 1-based page. */
  page: number;
  /** Points from the page's left edge, or `-1` for "not scrolled horizontally". */
  x: number;
  /** Points from the page's top edge, or `-1` for "not scrolled vertically". */
  y: number;
}

/** `Settings.h` — `FileState`, reduced to the fields a PDF pane can restore. */
export interface LightPdfDocumentState {
  path: string;
  /** `DisplayModeToString` of the resolved display mode. */
  displayMode: LightPdfDisplayMode;
  /** `FileState.pageNo`. */
  pageNo: number;
  /** `FileState.scrollPos`, in page space. */
  scrollPos: { x: number; y: number };
  /** Eukolia's page scale (CSS px per PDF point) — light-pdf's `zoom`, un-stringified. */
  zoom: number;
  /** The zoom mode the scale came from, so `fit page` reopens as `fit page`. */
  zoomMode: string;
  /** `FileState.rotation`, a multiple of 90. */
  rotation: number;
}

/**
 * `LightStartup.cpp` clamps a restored page into the document and drops the
 * scroll position when it had to: a page number that no longer exists must not
 * drag the rest of the state with it.
 */
export function clampRestoredState(
  state: LightPdfDocumentState,
  pageCount: number
): LightPdfDocumentState {
  const page = Math.max(1, Math.min(Math.round(state.pageNo) || 1, Math.max(1, pageCount)));
  if (page !== state.pageNo) {
    return { ...state, pageNo: page, scrollPos: { x: -1, y: -1 } };
  }
  return { ...state, pageNo: page };
}

/** How many documents' view states are remembered; light-pdf keeps a file history. */
const MAX_REMEMBERED_DOCUMENTS = 50;

const remembered = new Map<string, LightPdfDocumentState>();

function keyOf(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/** `DisplayModel::GetDisplayState` — remember a document's view. */
export function rememberLightPdfState(state: LightPdfDocumentState): void {
  if (!state.path) return;
  const key = keyOf(state.path);
  remembered.delete(key);
  remembered.set(key, state);
  while (remembered.size > MAX_REMEMBERED_DOCUMENTS) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) break;
    remembered.delete(oldest);
  }
}

/** `gFileHistory.FindByPath` — the remembered view, or `null`. */
export function recallLightPdfState(path: string): LightPdfDocumentState | null {
  if (!path) return null;
  const state = remembered.get(keyOf(path));
  return state ? { ...state, scrollPos: { ...state.scrollPos } } : null;
}

/** Drops every remembered view. Used when the workspace is closed and by tests. */
export function forgetAllLightPdfStates(): void {
  remembered.clear();
}

/**
 * `ScrollState` → the scroll offset that reproduces it, for a page whose
 * layout rectangle is known.
 *
 * `DisplayModel::SetScrollState` converts the stored page-space point back to
 * screen coordinates (`CvtToScreen(state.page, newPtD)`) and hands it to
 * `GoToPage`, which in the continuous modes positions the page at
 * `pos.y - windowMargin.top + scrollY`. A negative coordinate means the axis was
 * showing its margin, which is `GoToPage`'s `scrollY = 0` / "keep the horizontal
 * offset" case.
 */
export function scrollOffsetForRestoredState(
  pageTop: number,
  pageLeft: number,
  state: LightPdfScrollState,
  scale: number,
  windowMarginTop: number
): { top: number; left: number } {
  const top = state.y < 0 ? pageTop - windowMarginTop : pageTop + state.y * scale - windowMarginTop;
  const left = state.x < 0 ? pageLeft : pageLeft + state.x * scale;
  return { top: Math.max(0, top), left: Math.max(0, left) };
}

/**
 * The inverse: the `ScrollState` for a live scroll offset.
 *
 * `DisplayModel::GetScrollState` starts from the first visible page and converts
 * the top-left of the visible part of that page back to page space, leaving an
 * axis at `-1` when the page was not scrolled past the viewport edge in it.
 */
export function scrollStateFromOffset(
  pages: ReadonlyArray<{ pageNo: number; x: number; y: number; dx: number; dy: number; zoomReal: number }>,
  scrollTop: number,
  scrollLeft: number,
  currentPage: number
): LightPdfScrollState {
  // `FirstVisiblePageNo`: the first page the viewport touches at all.
  const first = pages.find((page) => page.y + page.dy > scrollTop && page.x + page.dx > scrollLeft) ?? null;
  if (!first || !(first.zoomReal > 0)) return { page: currentPage, x: -1, y: -1 };

  const x = first.x <= scrollLeft ? (scrollLeft - first.x) / first.zoomReal : -1;
  const y = first.y <= scrollTop ? (scrollTop - first.y) / first.zoomReal : -1;
  return { page: first.pageNo, x, y };
}
