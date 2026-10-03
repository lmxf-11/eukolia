/**
 * Eukolia — light-pdf's viewer keyboard, ported.
 *
 * light-pdf's viewer is driven almost entirely from the keyboard:
 * `Accelerators.cpp` binds scrolling, paging, zooming, rotation, find, history
 * and the view toggles, and `Commands.cpp` names each one. Eukolia's PDF pane
 * reproduced the toolbar and the model but not the keyboard, which left the
 * viewer mouse-only.
 *
 * This module transcribes the accelerators that a *document pane* can honour.
 * The window-level commands (tabs, full screen, presentation mode, printing, the
 * command palette) belong to the application shell rather than to the viewer, so
 * they are not listed here; everything that acts on the document is — including
 * the two pane toggles light-pdf binds to function keys, `F8` (toolbar) and
 * `F12` (bookmarks) — with light-pdf's own key choices and modifiers.
 */

import { LIGHTPDF_CMD, type LightPdfCommandId } from './lightpdf-commands';

/**
 * One accelerator, as `Accelerators.cpp` declares it.
 *
 * `key` is compared against `KeyboardEvent.key`, case-insensitively for single
 * letters, which is how `{FVIRTKEY, 'N', CmdGoToNextPage}` behaves in Win32: the
 * virtual key for a letter is the unshifted letter, so `N` and `n` both match
 * and `Shift+N` does not.
 */
export interface LightPdfAccelerator {
  command: LightPdfCommandId;
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/**
 * `Accelerators.cpp` — the viewer's own bindings.
 *
 * Order matters only for readability; resolution rejects a match whose
 * modifiers do not match exactly, so overlapping entries cannot shadow each
 * other.
 */
export const LIGHTPDF_VIEWER_ACCELERATORS: readonly LightPdfAccelerator[] = [
  // ------------------------------------------------------------- scrolling
  // `{FVIRTKEY, 'K', CmdScrollUp}` and the vi-style j/k/h/l block.
  { command: LIGHTPDF_CMD.CmdScrollUp, key: 'k' },
  { command: LIGHTPDF_CMD.CmdScrollDown, key: 'j' },
  { command: LIGHTPDF_CMD.CmdScrollLeft, key: 'h' },
  { command: LIGHTPDF_CMD.CmdScrollRight, key: 'l' },
  { command: LIGHTPDF_CMD.CmdScrollUp, key: 'ArrowUp' },
  { command: LIGHTPDF_CMD.CmdScrollDown, key: 'ArrowDown' },
  // Shift slows the vertical scroll to a half page.
  { command: LIGHTPDF_CMD.CmdScrollUpHalfPage, key: 'ArrowUp', shift: true },
  { command: LIGHTPDF_CMD.CmdScrollDownHalfPage, key: 'ArrowDown', shift: true },
  // Horizontal arrows are Prev/Next tab in light-pdf's window; the shell owns
  // tab switching here, so the viewer binds Ctrl+arrows to horizontal paging
  // instead and leaves the bare arrows alone.
  { command: LIGHTPDF_CMD.CmdScrollLeftPage, key: 'ArrowLeft', shift: true },
  { command: LIGHTPDF_CMD.CmdScrollRightPage, key: 'ArrowRight', shift: true },
  // Space, Return, PageDown and Ctrl+Down all scroll a page down.
  { command: LIGHTPDF_CMD.CmdScrollDownPage, key: ' ' },
  { command: LIGHTPDF_CMD.CmdScrollDownPage, key: 'Enter' },
  { command: LIGHTPDF_CMD.CmdScrollDownPage, key: 'PageDown' },
  { command: LIGHTPDF_CMD.CmdScrollDownPage, key: 'ArrowDown', ctrl: true },
  // …and their inverses scroll a page up.
  { command: LIGHTPDF_CMD.CmdScrollUpPage, key: ' ', shift: true },
  { command: LIGHTPDF_CMD.CmdScrollUpPage, key: 'Enter', shift: true },
  { command: LIGHTPDF_CMD.CmdScrollUpPage, key: 'PageUp' },
  { command: LIGHTPDF_CMD.CmdScrollUpPage, key: 'ArrowUp', ctrl: true },

  // -------------------------------------------------------------- paging
  { command: LIGHTPDF_CMD.CmdGoToNextPage, key: 'n' },
  { command: LIGHTPDF_CMD.CmdGoToPrevPage, key: 'p' },
  { command: LIGHTPDF_CMD.CmdGoToFirstPage, key: 'Home' },
  { command: LIGHTPDF_CMD.CmdGoToFirstPage, key: 'Home', ctrl: true },
  { command: LIGHTPDF_CMD.CmdGoToLastPage, key: 'End' },
  { command: LIGHTPDF_CMD.CmdGoToLastPage, key: 'End', ctrl: true },
  { command: LIGHTPDF_CMD.CmdGoToPage, key: 'g' },
  { command: LIGHTPDF_CMD.CmdGoToPage, key: 'g', ctrl: true },

  // ------------------------------------------------------------- history
  { command: LIGHTPDF_CMD.CmdNavigateBack, key: 'Backspace' },
  { command: LIGHTPDF_CMD.CmdNavigateBack, key: 'ArrowLeft', alt: true },
  { command: LIGHTPDF_CMD.CmdNavigateForward, key: 'Backspace', shift: true },
  { command: LIGHTPDF_CMD.CmdNavigateForward, key: 'ArrowRight', alt: true },

  // ---------------------------------------------------------------- zoom
  { command: LIGHTPDF_CMD.CmdZoomFitPage, key: '0', ctrl: true },
  { command: LIGHTPDF_CMD.CmdZoomActualSize, key: '1', ctrl: true },
  { command: LIGHTPDF_CMD.CmdZoomFitWidth, key: '2', ctrl: true },
  { command: LIGHTPDF_CMD.CmdZoomFitContent, key: '3', ctrl: true },
  // `{FCONTROL | FVIRTKEY, 'Y', CmdZoomCustom}` — light-pdf's "Zoom: Custom..."
  // dialog ("Magnification:"), which is how a reader reaches an arbitrary zoom.
  { command: LIGHTPDF_CMD.CmdZoomCustom, key: 'y', ctrl: true },
  // `{FCONTROL | FVIRTKEY, VK_ADD, CmdZoomIn}` and the OEM plus/minus variants;
  // the bare `+` is *not* a binding in light-pdf.
  { command: LIGHTPDF_CMD.CmdZoomIn, key: '+', ctrl: true },
  { command: LIGHTPDF_CMD.CmdZoomIn, key: '=', ctrl: true },
  { command: LIGHTPDF_CMD.CmdZoomOut, key: '-', ctrl: true },
  // `{FSHIFT | FCONTROL | FVIRTKEY, VK_ADD, CmdRotateRight}`, which is why the
  // zoom bindings above are declared without the shift modifier.
  { command: LIGHTPDF_CMD.CmdRotateRight, key: '+', ctrl: true, shift: true },
  { command: LIGHTPDF_CMD.CmdRotateRight, key: '=', ctrl: true, shift: true },
  { command: LIGHTPDF_CMD.CmdRotateLeft, key: '-', ctrl: true, shift: true },
  { command: LIGHTPDF_CMD.CmdRotateLeft, key: '[' },
  { command: LIGHTPDF_CMD.CmdRotateRight, key: ']' },

  // ------------------------------------------------------------ view layout
  // `{FCONTROL | FVIRTKEY, '6'|'7'|'8', CmdSinglePageView|CmdFacingView|CmdBookView}`
  // (and their numpad twins), light-pdf's three non-continuous layouts.
  { command: LIGHTPDF_CMD.CmdSinglePageView, key: '6', ctrl: true },
  { command: LIGHTPDF_CMD.CmdFacingView, key: '7', ctrl: true },
  { command: LIGHTPDF_CMD.CmdBookView, key: '8', ctrl: true },

  // ---------------------------------------------------------------- find
  { command: LIGHTPDF_CMD.CmdFindFirst, key: 'f', ctrl: true },
  { command: LIGHTPDF_CMD.CmdFindNext, key: 'F3' },
  { command: LIGHTPDF_CMD.CmdFindPrev, key: 'F3', shift: true },
  // `{FCONTROL | FVIRTKEY, VK_F3, CmdFindNextSel}` and its shifted twin: search
  // for the selected text without opening the find bar.
  { command: LIGHTPDF_CMD.CmdFindNextSel, key: 'F3', ctrl: true },
  { command: LIGHTPDF_CMD.CmdFindPrevSel, key: 'F3', ctrl: true, shift: true },

  // ----------------------------------------------------------- selection
  // `{FCONTROL | FVIRTKEY, 'A', CmdSelectAll}`,
  // `{FCONTROL | FVIRTKEY, 'C', CmdCopySelection}` and its `Ctrl+Insert` twin.
  { command: LIGHTPDF_CMD.CmdSelectAll, key: 'a', ctrl: true },
  { command: LIGHTPDF_CMD.CmdCopySelection, key: 'c', ctrl: true },
  { command: LIGHTPDF_CMD.CmdCopySelection, key: 'Insert', ctrl: true },

  // ------------------------------------------------------------ view state
  { command: LIGHTPDF_CMD.CmdToggleContinuousView, key: 'c' },
  { command: LIGHTPDF_CMD.CmdToggleZoom, key: 'z' },
  { command: LIGHTPDF_CMD.CmdInvertColors, key: 'i', shift: true },
  { command: LIGHTPDF_CMD.CmdTogglePageInfo, key: 'i' },
  // `{FVIRTKEY, 'M', CmdToggleCursorPosition}` — light-pdf's cursor-position tip.
  { command: LIGHTPDF_CMD.CmdToggleCursorPosition, key: 'm' },
  // `{FVIRTKEY, VK_F8, CmdToggleToolbar}` — the pinned/overlay toolbar.
  { command: LIGHTPDF_CMD.CmdToggleToolbar, key: 'F8' },
  // `{FVIRTKEY, VK_F12, CmdToggleBookmarks}` — the bookmarks sidebar.
  { command: LIGHTPDF_CMD.CmdToggleBookmarks, key: 'F12' },
  // `{FVIRTKEY, 'R', CmdReloadDocument}` and `{FCONTROL | FVIRTKEY, 'D',
  // CmdProperties}`.
  { command: LIGHTPDF_CMD.CmdReloadDocument, key: 'r' },
  { command: LIGHTPDF_CMD.CmdProperties, key: 'd', ctrl: true }
];

/** Normalises a key for comparison: single letters are case-insensitive. */
function sameKey(eventKey: string, bindingKey: string): boolean {
  if (bindingKey.length === 1) return eventKey.toLowerCase() === bindingKey.toLowerCase();
  return eventKey === bindingKey;
}

/**
 * Resolves a keyboard event to a viewer command, or `null`.
 *
 * Modifiers must match exactly: `N` must not fire while Ctrl is held, and
 * `Ctrl+0` must not fire for a bare `0`.
 */
export function matchViewerAccelerator(event: {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): LightPdfCommandId | null {
  if (event.metaKey) return null;

  for (const accelerator of LIGHTPDF_VIEWER_ACCELERATORS) {
    if (!sameKey(event.key, accelerator.key)) continue;
    if (Boolean(accelerator.ctrl) !== event.ctrlKey) continue;
    if (Boolean(accelerator.shift) !== event.shiftKey) continue;
    if (Boolean(accelerator.alt) !== event.altKey) continue;
    return accelerator.command;
  }
  return null;
}

/** Everything the viewer can do in response to a key. */
export interface LightPdfViewerActions {
  scrollBy(deltaY: number): void;
  scrollByPage(direction: -1 | 1): void;
  scrollHorizontally(deltaX: number): void;
  scrollHorizontallyPage(direction: -1 | 1): void;
  goToPage(page: number): void;
  nextPage(): void;
  previousPage(): void;
  firstPage(): void;
  lastPage(): void;
  navigateBack(): void;
  navigateForward(): void;
  setZoomMode(mode: 'page-fit' | 'page-width' | 'actual' | 'custom' | 'fit-content' | 'shrink-to-fit' | 'auto'): void;
  setZoom(zoom: number): void;
  getZoom(): number;
  /**
   * `DisplayModel::GetNextZoomStep` — one step of the zoom ladder, which is what
   * `CmdZoomIn` / `CmdZoomOut` do in light-pdf (`ZoomIncrement` defaults to 0, so
   * the ladder decides, not a fixed factor). Supplied by the PDF pane; when it is
   * absent the caller falls back to a multiplicative step, which is light-pdf's
   * `MaybeGetNextZoomByIncrement` behaviour for a positive `ZoomIncrement`.
   */
  zoomStep?(direction: 1 | -1): void;
  /** Fit the page's *content* box, light-pdf's `CmdZoomFitContent`. */
  fitContent(): void;
  rotate(delta: -1 | 1): void;
  openFind(): void;
  findNext(): void;
  findPrevious(): void;
  /** Selects every page's text, light-pdf's `CmdSelectAll`. */
  selectAll(): void;
  /** Copies the selection; returns `false` when there is nothing to copy. */
  copySelection(): boolean;
  toggleContinuous(): void;
  toggleZoom(): void;
  invertColors(): void;
  togglePageInfo(): void;
  /** Prompts for a page number, light-pdf's `CmdGoToPage`. */
  promptForPage(pageCount: number): void;
  pageCount(): number;
  /**
   * light-pdf's `CmdSinglePageView` / `CmdFacingView` / `CmdBookView`
   * (`Ctrl+6` / `Ctrl+7` / `Ctrl+8`): the non-continuous form of one layout
   * family, which is what those menu items select.
   */
  setDisplayMode(mode: 'single-page' | 'facing' | 'book'): void;
  /** light-pdf's `CmdZoomCustom` (`Ctrl+Y`) — the "Magnification:" prompt. */
  promptForZoom(): void;
  /**
   * light-pdf's `CmdFindNextSel` / `CmdFindPrevSel` (`Ctrl+F3` /
   * `Ctrl+Shift+F3`): search for the selected text. `-1` searches backwards.
   */
  findSelection(direction: 1 | -1): void;
  /** light-pdf's `CmdToggleToolbar` (`F8`). */
  toggleToolbar(): void;
  /** light-pdf's `CmdToggleBookmarks` (`F12`) — the bookmarks sidebar. */
  toggleBookmarks(): void;
  /** light-pdf's `CmdToggleLinks` — the `ShowLinks` link rectangles. */
  toggleLinks(): void;
  /** light-pdf's `CmdCopyFilePath`. */
  copyFilePath(): void;
  /** light-pdf's `CmdReloadDocument` (`R`). */
  reloadDocument(): void;
  /** light-pdf's `CmdProperties` (`Ctrl+D`) — the document properties dialog. */
  showProperties(): void;
  /**
   * light-pdf's `CmdStartAutoScroll` (427) — `StartAutoScrollAtCursor`
   * (`Canvas.cpp:1704-1710`): middle-click-style auto-scroll anchored at the
   * pointer, so it can be started without a middle button.
   */
  toggleAutoScroll(): void;
  /**
   * light-pdf's `CmdToggleCursorPosition` (365) — `ToggleCursorPositionInDoc`
   * (`LightPDF.cpp:6323-6356`): the cursor-position tip, which cycles its unit
   * through pt → mm → in and then removes itself.
   */
  toggleCursorPosition(): void;
  /** light-pdf's `CmdChangeScrollbar` (232) — `Dialog_ChangeScrollbar`. */
  changeScrollbar(): void;
  /** light-pdf's `CmdFindToggleMatchWholeWord` (434) — the find bar's toggle. */
  toggleFindWholeWord(): void;
}

/** light-pdf's `kZoomMin` / `kZoomMax` as Eukolia's zoom steps. */
const ZOOM_STEP = 1.25;

/**
 * Runs a viewer command.
 *
 * Returns `true` when the key was consumed, so the caller knows whether to
 * `preventDefault`: a key the viewer does not use must still reach the rest of
 * the application.
 */
export function runViewerCommand(
  command: LightPdfCommandId,
  actions: LightPdfViewerActions
): boolean {
  switch (command) {
    // ----------------------------------------------------------- scrolling
    case LIGHTPDF_CMD.CmdScrollUp:
      actions.scrollBy(-60);
      return true;
    case LIGHTPDF_CMD.CmdScrollDown:
      actions.scrollBy(60);
      return true;
    case LIGHTPDF_CMD.CmdScrollLeft:
      actions.scrollHorizontally(-60);
      return true;
    case LIGHTPDF_CMD.CmdScrollRight:
      actions.scrollHorizontally(60);
      return true;
    case LIGHTPDF_CMD.CmdScrollUpHalfPage:
      actions.scrollByPage(-1);
      return true;
    case LIGHTPDF_CMD.CmdScrollDownHalfPage:
      actions.scrollByPage(1);
      return true;
    case LIGHTPDF_CMD.CmdScrollUpPage:
      actions.scrollByPage(-1);
      return true;
    case LIGHTPDF_CMD.CmdScrollDownPage:
      actions.scrollByPage(1);
      return true;
    case LIGHTPDF_CMD.CmdScrollLeftPage:
      actions.scrollHorizontallyPage(-1);
      return true;
    case LIGHTPDF_CMD.CmdScrollRightPage:
      actions.scrollHorizontallyPage(1);
      return true;

    // -------------------------------------------------------------- paging
    case LIGHTPDF_CMD.CmdGoToNextPage:
      actions.nextPage();
      return true;
    case LIGHTPDF_CMD.CmdGoToPrevPage:
      actions.previousPage();
      return true;
    case LIGHTPDF_CMD.CmdGoToFirstPage:
      actions.firstPage();
      return true;
    case LIGHTPDF_CMD.CmdGoToLastPage:
      actions.lastPage();
      return true;
    case LIGHTPDF_CMD.CmdGoToPage:
      actions.promptForPage(actions.pageCount());
      return true;

    // ------------------------------------------------------------- history
    case LIGHTPDF_CMD.CmdNavigateBack:
      actions.navigateBack();
      return true;
    case LIGHTPDF_CMD.CmdNavigateForward:
      actions.navigateForward();
      return true;

    // ---------------------------------------------------------------- zoom
    case LIGHTPDF_CMD.CmdZoomFitPage:
      actions.setZoomMode('page-fit');
      return true;
    case LIGHTPDF_CMD.CmdZoomFitWidth:
      actions.setZoomMode('page-width');
      return true;
    case LIGHTPDF_CMD.CmdZoomActualSize:
      // light-pdf's `kZoomActualSize` is 100%.
      actions.setZoomMode('actual');
      return true;
    case LIGHTPDF_CMD.CmdZoomFitContent:
      actions.fitContent();
      return true;
    // `kZoomShrinkToFit`: fit page, never above 100 % (`DisplayModel.cpp:727-732`).
    case LIGHTPDF_CMD.CmdZoomShrinkToFit:
      actions.setZoomMode('shrink-to-fit');
      return true;
    // `kZoomFitByOrientation`: fit width in a landscape viewport, else fit page.
    case LIGHTPDF_CMD.CmdZoomFitByOrientation:
      actions.setZoomMode('auto');
      return true;
    case LIGHTPDF_CMD.CmdZoomCustom:
      actions.promptForZoom();
      return true;
    case LIGHTPDF_CMD.CmdZoomIn:
      if (actions.zoomStep) actions.zoomStep(1);
      else actions.setZoom(actions.getZoom() * ZOOM_STEP);
      return true;
    case LIGHTPDF_CMD.CmdZoomOut:
      if (actions.zoomStep) actions.zoomStep(-1);
      else actions.setZoom(actions.getZoom() / ZOOM_STEP);
      return true;

    // ---------------------------------------------------------- view layout
    case LIGHTPDF_CMD.CmdSinglePageView:
      actions.setDisplayMode('single-page');
      return true;
    case LIGHTPDF_CMD.CmdFacingView:
      actions.setDisplayMode('facing');
      return true;
    case LIGHTPDF_CMD.CmdBookView:
      actions.setDisplayMode('book');
      return true;

    // ------------------------------------------------------------ rotation
    case LIGHTPDF_CMD.CmdRotateLeft:
      actions.rotate(-1);
      return true;
    case LIGHTPDF_CMD.CmdRotateRight:
      actions.rotate(1);
      return true;

    // ---------------------------------------------------------------- find
    case LIGHTPDF_CMD.CmdFindFirst:
      actions.openFind();
      return true;
    case LIGHTPDF_CMD.CmdFindNext:
      actions.findNext();
      return true;
    case LIGHTPDF_CMD.CmdFindPrev:
      actions.findPrevious();
      return true;
    case LIGHTPDF_CMD.CmdFindNextSel:
      actions.findSelection(1);
      return true;
    case LIGHTPDF_CMD.CmdFindPrevSel:
      actions.findSelection(-1);
      return true;

    // ----------------------------------------------------------- selection
    case LIGHTPDF_CMD.CmdSelectAll:
      actions.selectAll();
      return true;
    case LIGHTPDF_CMD.CmdCopySelection:
      actions.copySelection();
      return true;

    // ------------------------------------------------------------ view state
    case LIGHTPDF_CMD.CmdToggleContinuousView:
      actions.toggleContinuous();
      return true;
    case LIGHTPDF_CMD.CmdToggleZoom:
      actions.toggleZoom();
      return true;
    case LIGHTPDF_CMD.CmdInvertColors:
      actions.invertColors();
      return true;
    case LIGHTPDF_CMD.CmdTogglePageInfo:
      actions.togglePageInfo();
      return true;
    case LIGHTPDF_CMD.CmdToggleCursorPosition:
      actions.toggleCursorPosition();
      return true;
    case LIGHTPDF_CMD.CmdStartAutoScroll:
      actions.toggleAutoScroll();
      return true;
    case LIGHTPDF_CMD.CmdChangeScrollbar:
      actions.changeScrollbar();
      return true;
    case LIGHTPDF_CMD.CmdFindToggleMatchWholeWord:
      actions.toggleFindWholeWord();
      return true;
    case LIGHTPDF_CMD.CmdToggleToolbar:
      actions.toggleToolbar();
      return true;
    case LIGHTPDF_CMD.CmdToggleBookmarks:
      actions.toggleBookmarks();
      return true;
    case LIGHTPDF_CMD.CmdToggleLinks:
      actions.toggleLinks();
      return true;
    case LIGHTPDF_CMD.CmdCopyFilePath:
      actions.copyFilePath();
      return true;
    case LIGHTPDF_CMD.CmdReloadDocument:
      actions.reloadDocument();
      return true;
    case LIGHTPDF_CMD.CmdProperties:
      actions.showProperties();
      return true;

    default:
      return false;
  }
}
