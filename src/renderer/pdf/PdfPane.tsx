/**
 * Eukolia — the PDF pane.
 *
 * light-pdf's document window is a toolbar strip on top of a canvas, so the
 * Eukolia PDF pane is the same: `LightPdfToolbar` (light-pdf's
 * `gToolbarButtons[]`), then the viewer, then light-pdf's floating find bar.
 *
 * Everything this component holds is state light-pdf keeps per window or per
 * document:
 *
 * - the display mode (`FileState::displayMode`, `pdf.scrollMode` as the default
 *   for a document that has none), toggled by `CmdToggleContinuousView` and set
 *   by the two layout buttons through `ChangeZoomLevel`;
 * - the zoom and its mode (`FileState::zoom` + `DisplayMode`, `pdf.defaultZoom`
 *   as the default), stepped by `CmdZoomIn`/`CmdZoomOut` through the viewer's
 *   `GetNextZoomStep`;
 * - the rotation (`FileState::rotation`);
 * - the find bar's query and options, and the page counter shown in the
 *   toolbar's page box.
 *
 * The zoom in/out buttons and the two layout buttons behave as light-pdf's do:
 * `LightPDF.cpp` — `ChangeZoomLevel(win, kZoomFitWidth, true)` for "fit width and
 * continuous" and `ChangeZoomLevel(win, kZoomFitPage, false)` for "fit a single
 * page", each remembering the previous zoom and mode so pressing the same button
 * again returns to it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PdfViewer, type PdfViewerHandle, type PdfZoomMode } from './PdfViewer';
import { LightPdfFindBar, LightPdfToolbar } from './LightPdfToolbar';
import { LightPdfProperties } from './LightPdfProperties';
import { LightPdfToc } from './LightPdfToc';
import { LIGHTPDF_CMD } from './lightpdf-commands';
import type { LightPdfCommandId } from './lightpdf-commands';
import {
  matchViewerAccelerator,
  runViewerCommand,
  type LightPdfViewerActions
} from './lightpdf-keyboard';
import {
  LIGHTPDF_DPI_FACTOR,
  isBookViewDisplayMode,
  isContinuousDisplayMode,
  lightPdfDisplayModeFromString,
  resolveDisplayMode,
  type LightPdfDisplayMode
} from './lightpdf-layout';
import {
  LIGHTPDF_SCROLLBAR_MODES,
  readLightPdfViewerSettings,
  toggledToolbarMode
} from './lightpdf-settings';
import {
  LIGHTPDF_LINK_OUTLINE_COLOR,
  LIGHTPDF_LINK_OUTLINE_INFLATE,
  LIGHTPDF_LINK_OUTLINE_WIDTH,
  LIGHTPDF_MAX_RENDER_SCALE,
  LIGHTPDF_PAGE_INFO_DEFAULT,
  LIGHTPDF_TOOLBAR_HIDE_DELAY_MS,
  LIGHTPDF_TOOLBAR_REVEAL_BAND,
  accentColor,
  bgrToHex,
  documentColorsAreDark,
  lightPdfRenderScaleConstrained,
  lightPdfThemeIndexByName,
  lightPdfThemeIndexFor,
  lightPdfThemeState,
  lightPdfToolbarBarHeight,
  themeNotificationsBackgroundColor,
  themeNotificationsHighlightTextColor,
  type LightPdfThemeState
} from './lightpdf-theme';
import { recallLightPdfState } from './lightpdf-viewstate';
import { globalEvents } from '../core/events';
import { setting, settingsManager } from '../core/settings';
import type { PdfOpenResult, PdfOutlineItem } from '../../shared/ipc';

export interface PdfPaneProps {  path: string | null;
  /** Eukolia's resolved appearance; light-pdf's "Light" / "Dark" theme follows it. */
  appearance: 'light' | 'dark';
  invertColors: boolean;
  handleRef: React.MutableRefObject<PdfViewerHandle | null>;
  initialZoom?: number;
  initialZoomMode?: PdfZoomMode;
  onZoomChange?(zoom: number, mode: PdfZoomMode): void;
  onPageChange?(page: number, pageCount: number): void;
  onDocumentLoaded?(info: PdfOpenResult): void;
  onError?(message: string): void;
  onInverseSearch?(page: number, x: number, y: number): void;
  /** light-pdf's `CmdOpenFile`: pick another document to view. */
  onOpenFile(): void;
  /** light-pdf's `CmdInvertColors` (`Shift+I`). */
  onToggleInvertColors?(): void;
  /** light-pdf's `CmdReloadDocument` (`R`): re-read the file from disk. */
  onReload?(): void;
  /**
   * The pointer left the pane.
   *
   * Focus Mode's floating viewer uses this to decide when a viewer it is holding
   * open — because the pointer was using it — should slide away. Nothing
   * light-pdf does depends on it: a docked pane has nowhere to go.
   */
  onPointerLeave?(): void;
}

/** The zoom level and its mode, as light-pdf keeps them per document. */
interface ZoomState {
  zoom: number;
  mode: PdfZoomMode;
}

/**
 * The narrowest pane that still has room for the bookmarks sidebar beside a
 * usable page: light-pdf's own sidebar width (`TableOfContents.cpp`'s
 * `SidebarDx` default, `light-pdf`'s `SidebarDx = 0` meaning "its own") plus a
 * page's worth of reading width.
 *
 * Below it the sidebar is put away rather than compressing the viewer, which is
 * what a reader dragging the divider wants: the pane shows the document, and the
 * bookmarks come back the moment there is room. It is not a preference — light-pdf
 * has no such state, because its sidebar is a window dimension and its window has
 * a minimum width — it is what stops a fixed-width sibling from pushing the page
 * out of the pane it is supposed to fit.
 */
export const LIGHTPDF_TOC_MIN_PANE_WIDTH = 420;

/**
 * Whether the bookmarks sidebar is shown: the `ShowToc` preference, a document
 * with bookmarks to show, and a pane with room for both
 * (`LIGHTPDF_TOC_MIN_PANE_WIDTH`).
 *
 * A pane that has not been measured yet (`paneWidth` 0 — still hidden, or not
 * laid out) counts as room. The alternative is a sidebar that flickers away
 * during the first measurement of every pane that is in fact wide enough, and a
 * pane that really is narrow reports its width on the next layout.
 */
export function tocIsShown(tocOpen: boolean, hasOutline: boolean, paneWidth: number): boolean {
  if (!tocOpen || !hasOutline) return false;
  return paneWidth === 0 || paneWidth >= LIGHTPDF_TOC_MIN_PANE_WIDTH;
}

/**
 * `DisplayMode.cpp` — `ZoomFromString`, for the values Eukolia's
 * `pdf.defaultZoom` setting offers. `auto` is light-pdf's "fit by orientation"
 * (`kZoomFitByOrientation`, issue #702).
 */
function zoomModeFromSetting(value: string): PdfZoomMode | null {
  switch (value) {
    case 'auto':
      return 'auto';
    case 'page-width':
      return 'page-width';
    case 'page-fit':
      return 'page-fit';
    case 'page-height':
      return 'page-height';
    case 'actual':
      return 'actual';
    case 'fit-content':
      return 'fit-content';
    case 'shrink-to-fit':
      return 'shrink-to-fit';
    case 'custom':
      return 'custom';
    default:
      return null;
  }
}

/** `GlobalPrefs.DefaultDisplayMode` / `pdf.scrollMode`. */
function displayModeFromSetting(value: string): LightPdfDisplayMode {
  return lightPdfDisplayModeFromString(value, 'continuous');
}

export const PdfPane: React.FC<PdfPaneProps> = (props) => {
  /**
   * Default zoom is `fit width` (`pdf.defaultZoom`), which in
   * `DocumentLayout::Relayout` is `kZoomFitWidth`;
   * and a remembered `FileState` wins over both (`ReplaceDocumentInCurrentTab`).
   */
  const [zoomState, setZoomState] = useState<ZoomState>(() => ({
    zoom: props.initialZoom ?? 1,
    mode: zoomModeFromSetting(setting.str('pdf.defaultZoom')) ?? props.initialZoomMode ?? 'page-width'
  }));
  const [displayMode, setDisplayMode] = useState<LightPdfDisplayMode>(() => displayModeFromSetting(setting.str('pdf.scrollMode')));
  const [rotation, setRotation] = useState<0 | 90 | 270 | 180>(0);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [navigation, setNavigation] = useState({ back: false, forward: false });
  /** Scale actually in use, after the fit modes are resolved (see `PdfViewer`). */
  const [effectiveScale, setEffectiveScale] = useState(zoomState.zoom);

  const [findOpen, setFindOpen] = useState(false);
  /** light-pdf's `CmdTogglePageInfo` (`I`): the page box above the page. */
  // light-pdf shows the page box unless CmdTogglePageInfo turns it off, so the
  // default is on.
  const [pageInfoVisible, setPageInfoVisible] = useState(LIGHTPDF_PAGE_INFO_DEFAULT);
  const [findQuery, setFindQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  /**
   * `CmdFindToggleMatchWholeWord` (434) — `FindBar.cpp`'s whole-word toggle. The
   * engine (`worker_main.cpp:1155`, `Search.cpp`'s `SetMatchWholeWord`) and the
   * find bar's button (`LIGHTPDF_FIND_BAR_BUTTONS`) both already had it; what was
   * missing was the option travelling from the bar to the viewer's `find`, which
   * is what this state and `runSearch` do.
   *
   * Deliberately *not* a setting. light-pdf has no `GlobalPrefs` key for it —
   * `FindBar.cpp` keeps the flag in the find window — and Eukolia's settings
   * schema only carries light-pdf's own preferences, so inventing
   * `pdf.findWholeWord` would put a control in the Settings UI that the reference
   * does not have.
   */
  const [wholeWord, setWholeWord] = useState(false);
  const [findState, setFindState] = useState({ index: 0, total: 0 });
  const [findAnchor, setFindAnchor] = useState(4);
  const findButtonRef = useRef<HTMLButtonElement | null>(null);
  /** Bumped on every settings change so the theme below is re-read. */
  const [settingsRevision, setSettingsRevision] = useState(0);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * `WindowTab`'s `prevZoomVirtual` / `prevDisplayMode`, which
   * `ChangeZoomLevel` remembers so a second press of the same toolbar button
   * returns to the zoom and mode the user had before.
   */
  const previousViewRef = useRef<{ zoom: number; mode: PdfZoomMode; displayMode: LightPdfDisplayMode } | null>(null);
  /** The setting values last acted on, so unrelated changes are ignored. */
  const appliedSettingsRef = useRef<{ defaultZoom: string; scrollMode: string; toolbar: string; showToc: boolean } | null>(null);

  /**
   * Every light-pdf viewer preference Eukolia honours, re-read whenever the
   * Settings UI changes anything (`lightpdf-settings.ts` is the one place that
   * knows how each raw value is normalised).
   */
  const viewerSettings = useMemo(() => {
    void settingsRevision;
    return readLightPdfViewerSettings();
  }, [settingsRevision]);

  /**
   * `WindowTab::showToc`, which `CmdToggleBookmarks` (`F12`) flips for the open
   * document, while `ShowToc` only decides the default for a document that has
   * none of its own (`showTocByDefault`, `LightPDF.cpp:1597-1598, 1648-1668`).
   */
  const [tocOpen, setTocOpen] = useState(viewerSettings.showToc);
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);
  const [documentInfo, setDocumentInfo] = useState<PdfOpenResult | null>(null);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [toolbarRevealed, setToolbarRevealed] = useState(true);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const overlayHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * How much room the pane has, so the bookmarks sidebar can stand down when
   * there is not enough for it and a page (`LIGHTPDF_TOC_MIN_PANE_WIDTH`).
   *
   * The sidebar is a fixed 220 px with `flexShrink: 0` — light-pdf's own
   * `SidebarDx`, a remembered window dimension rather than something the layout
   * negotiates — so a pane narrower than that pushed the *viewer* past the
   * window's right edge instead of narrowing it: the viewer's right edge left the
   * window, and the page beside it was fitted to a width nobody could see. The
   * sidebar is what gives way now.
   */
  const [paneWidth, setPaneWidth] = useState(0);

  /**
   * The viewer's theme.
   *
   * light-pdf's `Theme` preference names one of its own themes; `auto` follows
   * the application, which is the behaviour Eukolia had before the preference
   * existed. An unknown name falls back to the same automatic choice rather than
   * leaving the chrome uncoloured. `DocumentColorsFollowTheme`,
   * `MainWindowBackground` and `FixedPageUI.WindowBgCol` travel with it, because
   * the ported `Theme.cpp` accessors (`themeDocumentColors`,
   * `themeMainWindowBackgroundColor`) are what read them.
   */
  const theme: LightPdfThemeState = useMemo(() => {
    const configured = setting.str('pdf.lightPdfTheme');
    const named = configured && configured !== 'auto' ? lightPdfThemeIndexByName(configured) : null;
    return lightPdfThemeState(named ?? lightPdfThemeIndexFor(props.appearance), viewerSettings.documentColorsFollowTheme !== 'off', {
      mainWindowBackground: viewerSettings.mainWindowBackground,
      windowBgCol: viewerSettings.windowBackgroundColor
    });
    // `settingsManager` emits on every change; the pane re-reads the value then.
  }, [props.appearance, viewerSettings]);

  /**
   * light-pdf's `DocumentColorsFollowTheme` recolours the pages as well as the
   * canvas: `ThemePageRenderColors` returns the substitution pair and
   * `DarkChromeActive` (`PdfDarkModeColor.cpp:28-32`) is true whenever that
   * background is dark. Eukolia's engine recolours the rasterised page
   * (`fz_invert_pixmap`, `mupdf_engine.cpp:785-789`), which is light-pdf's
   * `legacy` path, so the two switches are combined here rather than pretending
   * the engine can substitute the two page colours separately. Eukolia's own
   * `pdf.invertColors` still wins on its own.
   */
  const invertColors = props.invertColors || documentColorsAreDark(theme);

  /**
   * Whether the floating toolbar is on screen. It is always shown in the pinned
   * mode, and in the overlay mode it is revealed by proximity — except while the
   * find bar is open, because the bar lives inside the toolbar host and must not
   * disappear with it (light-pdf's find bar is a separate window, so it stays
   * while the toolbar hides; the pane keeps the host visible instead).
   */
  const toolbarVisible = viewerSettings.toolbarMode !== 'overlay' || toolbarRevealed || findOpen;

  /**
   * When the whole-page render guard (`LIGHTPDF_MAX_RENDER_SCALE`) asks for fewer
   * device pixels than the sheet occupies, the page is displayed from a smaller
   * bitmap — the one way this viewer can be softer than the display. It needs a
   * zoom far outside normal reading, and light-pdf has no such state at all
   * (it rasterises only on-screen tiles), so it is reported rather than left
   * silent: a quietly soft page is the defect this port exists to remove.
   */
  const renderScaleConstrained = lightPdfRenderScaleConstrained(effectiveScale, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);

  /** `ToolbarAtBottom()` (`LightPDF.cpp:1192-1194`). */
  const toolbarAtBottom = viewerSettings.toolbarPosition === 'bottom';
  /**
   * The bar's height, which the find bar has to clear: light-pdf's toolbar is
   * `ToolbarSize`'s icon box rounded up to 4 plus its padding
   * (`Toolbar.cpp:1402-1417`), i.e. 26px at the default icon size of 18.
   */
  const toolbarBarHeight = lightPdfToolbarBarHeight(viewerSettings.toolbarSize);

  /**
   * `UpdateOverlayToolbarForMouse` (`Toolbar.cpp:623-635`): an overlay toolbar is
   * revealed while the cursor is inside a band spanning the canvas width at the
   * toolbar's edge, extending `DpiScale(16)` past it toward the page
   * (`OverlayToolbarShouldShowForCursor`, `Toolbar.cpp:577-598`), and hidden
   * `kDelayToolbarHide` (500 ms) after the cursor leaves it, so moving away and
   * back does not flash it.
   */
  const cancelOverlayHide = useCallback(() => {
    if (overlayHideTimerRef.current !== null) {
      clearTimeout(overlayHideTimerRef.current);
      overlayHideTimerRef.current = null;
    }
  }, []);

  const onOverlayPointerMove = useCallback(
    (event: React.MouseEvent) => {
      if (viewerSettings.toolbarMode !== 'overlay') return;
      const rect = toolbarRef.current?.getBoundingClientRect();
      if (!rect) return;
      const band = LIGHTPDF_TOOLBAR_REVEAL_BAND;
      const near = event.clientY >= rect.top - band && event.clientY <= rect.bottom + band;
      if (near) {
        cancelOverlayHide();
        setToolbarRevealed(true);
        return;
      }
      if (!toolbarRevealed || overlayHideTimerRef.current !== null) return;
      overlayHideTimerRef.current = setTimeout(() => {
        overlayHideTimerRef.current = null;
        setToolbarRevealed(false);
      }, LIGHTPDF_TOOLBAR_HIDE_DELAY_MS);
    },
    [viewerSettings.toolbarMode, toolbarRevealed, cancelOverlayHide]
  );

  const onOverlayPointerLeave = useCallback(() => {
    if (viewerSettings.toolbarMode !== 'overlay' || !toolbarRevealed) return;
    if (overlayHideTimerRef.current !== null) return;
    overlayHideTimerRef.current = setTimeout(() => {
      overlayHideTimerRef.current = null;
      setToolbarRevealed(false);
    }, LIGHTPDF_TOOLBAR_HIDE_DELAY_MS);
  }, [viewerSettings.toolbarMode, toolbarRevealed]);

  useEffect(
    () => () => {
      if (overlayHideTimerRef.current !== null) clearTimeout(overlayHideTimerRef.current);
    },
    []
  );

  const applyZoom = useCallback(
    (zoom: number, mode: PdfZoomMode) => {
      setZoomState({ zoom, mode });
      props.onZoomChange?.(zoom, mode);
    },
    [props]
  );

  // `DisplayModel::SetDisplayMode`, including `keepContinuous` for the toggle.
  const changeDisplayMode = useCallback((mode: LightPdfDisplayMode, keepContinuous = false) => {
    setDisplayMode((current) => {
      if (current === mode) return current;
      if (keepContinuous && isContinuousDisplayMode(current)) {
        switch (mode) {
          case 'single-page':
            return 'continuous';
          case 'facing':
            return 'continuous-facing';
          case 'book':
            return 'continuous-book';
          default:
            break;
        }
      }
      return mode;
    });
  }, []);

  /**
   * `LightPDF.cpp` — `ChangeZoomLevel(win, zoom, pagesContinuously)`: set the
   * display mode and the zoom together, remembering the previous pair so the
   * button toggles back.
   */
  const changeZoomLevel = useCallback(
    (mode: PdfZoomMode, target: LightPdfDisplayMode) => {
      const currentDisplay = displayMode;
      if (currentDisplay !== target || zoomState.mode !== mode) {
        const previous = previousViewRef.current;
        if (currentDisplay !== target) changeDisplayMode(target);
        setZoomState({ zoom: zoomState.zoom, mode });
        props.onZoomChange?.(zoomState.zoom, mode);
        previousViewRef.current = previous ?? { zoom: zoomState.zoom, mode: zoomState.mode, displayMode: currentDisplay };
        return;
      }
      // Pressing the same button again restores the remembered view.
      const previous = previousViewRef.current;
      if (!previous) return;
      previousViewRef.current = null;
      if (previous.displayMode !== currentDisplay) changeDisplayMode(previous.displayMode);
      setZoomState({ zoom: previous.zoom, mode: previous.mode });
      props.onZoomChange?.(previous.zoom, previous.mode);
    },
    [displayMode, zoomState, changeDisplayMode, props]
  );

  const runSearch = useCallback(
    async (query: string, caseSensitive: boolean, matchWholeWord = wholeWord) => {
      const handle = props.handleRef.current;
      if (!handle) return;
      if (!query.trim()) {
        handle.clearSearch();
        setFindState({ index: 0, total: 0 });
        return;
      }
      await handle.find(query, { caseSensitive, wholeWord: matchWholeWord });
    },
    [props.handleRef, wholeWord]
  );

  /**
   * `CmdFindToggleMatchWholeWord` (434) — flip the toggle and re-run the search.
   *
   * The state is set here rather than in each of the three call sites because the
   * pending search below has to see the new value in the same tick.
   */
  const setFindWholeWord = useCallback(
    (next: boolean) => {
      setWholeWord(next);
      setFindOpen(true);
      void runSearch(findQuery, matchCase, next);
    },
    [findQuery, matchCase, runSearch]
  );

  const onQueryChange = useCallback(
    (query: string) => {
      setFindQuery(query);
      // Find-as-you-type, coalesced so a fast typist does not queue one native
      // search per keystroke (Instructions.md §60/§61).
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(() => {
        searchTimerRef.current = null;
        void runSearch(query, matchCase);
      }, 200);
    },
    [runSearch, matchCase]
  );

  useEffect(
    () => () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    },
    []
  );

  // The viewer reads several light-pdf preferences (its theme, its selection
  // colour, its display mode); re-reading them when the settings change keeps
  // the pane in step with the Settings UI without prop-drilling every key.
  useEffect(() => settingsManager.on('change', () => setSettingsRevision((value) => value + 1)), []);

  /**
   * `pdf.defaultZoom` and `pdf.scrollMode` are the defaults a document opens
   * with (`GlobalPrefs.defaultZoom` / `DefaultDisplayMode`), and a change to
   * either is applied to the open document too: the Settings UI is live, and a
   * setting that only takes effect on the next document reads as broken.
   */
  useEffect(() => {
    const defaultZoom = setting.str('pdf.defaultZoom');
    const scrollMode = setting.str('pdf.scrollMode');
    const toolbar = setting.str('pdf.toolbar');
    const showToc = setting.bool('pdf.showToc');
    const previous = appliedSettingsRef.current;
    appliedSettingsRef.current = { defaultZoom, scrollMode, toolbar, showToc };

    if (previous?.scrollMode !== scrollMode) {
      const mode = displayModeFromSetting(scrollMode);
      setDisplayMode((current) => (current === mode ? current : mode));
    }
    if (previous && previous.defaultZoom !== defaultZoom) {
      const mode = zoomModeFromSetting(defaultZoom);
      if (mode) applyZoom(zoomState.zoom, mode);
    }
    // `ShowOrHideToolbar` (`Toolbar.cpp:652-680`): switching back to a pinned
    // toolbar shows it immediately; switching *to* the overlay leaves it to the
    // proximity rule, so it starts hidden like light-pdf's.
    if (previous && previous.toolbar !== toolbar) {
      setToolbarRevealed(viewerSettings.toolbarMode !== 'overlay');
    }
    // `ShowToc` is a preference, so changing it in the Settings UI applies to the
    // open document as well. Only a real change is acted on: `F12` flips the
    // document's own `showToc`, and re-applying the preference on every
    // unrelated settings change would undo it.
    if (previous && previous.showToc !== showToc) setTocOpen(showToc);
  }, [settingsRevision, applyZoom, zoomState.zoom, viewerSettings.toolbarMode]);

  /**
   * Opening a document restores its remembered view
   * (`ReplaceDocumentInCurrentTab`), or the configured defaults when it has
   * none.
   */
  useEffect(() => {
    previousViewRef.current = null;
    // `showTocByDefault` (`LightPDF.cpp:1597-1598`): the preference only decides
    // what a document without a remembered state starts with, and every document
    // starts a fresh `WindowTab::showToc`.
    setTocOpen(setting.bool('pdf.showToc'));
    setPropertiesOpen(false);
    setOutline([]);
    setDocumentInfo(null);
    const saved = props.path ? recallLightPdfState(props.path) : null;
    if (saved) {
      setDisplayMode(saved.displayMode);
      setZoomState({ zoom: saved.zoom, mode: (zoomModeFromSetting(saved.zoomMode) ?? 'custom') as PdfZoomMode });
      setRotation((((saved.rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270);
      props.onZoomChange?.(saved.zoom, (zoomModeFromSetting(saved.zoomMode) ?? 'custom') as PdfZoomMode);
      return;
    }
    setDisplayMode(displayModeFromSetting(setting.str('pdf.scrollMode')));
    const mode = zoomModeFromSetting(setting.str('pdf.defaultZoom'));
    if (mode) {
      setZoomState((current) => ({ zoom: current.zoom, mode }));
      props.onZoomChange?.(zoomState.zoom, mode);
    }
    // Only a document change re-reads the defaults.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path]);

  /**
   * The document's bookmarks for the sidebar. `pdfOutline` is asked once per
   * document, as `TableOfContents.cpp` fills its tree when the document is
   * loaded; the tree itself is built from the same `PdfOutlineItem` shape the
   * engine's outline has.
   */
  useEffect(() => {
    if (!props.path) {
      setOutline([]);
      return;
    }
    let cancelled = false;
    void window.eukoliaApi
      .pdfOutline(props.path)
      .then((items) => {
        if (!cancelled) setOutline(items);
      })
      .catch(() => {
        if (!cancelled) setOutline([]);
      });
    return () => {
      cancelled = true;
    };
  }, [props.path]);

  const toggleFind = useCallback(() => {
    setFindOpen((open) => {
      if (open) {
        props.handleRef.current?.clearSearch();
        setFindQuery('');
        setFindState({ index: 0, total: 0 });
        return false;
      }
      // `FindBar.cpp` — `PositionFindBar` centres the bar under the Search button.
      const button = findButtonRef.current;
      const toolbar = button?.closest('[data-testid="pdf-toolbar"]') as HTMLElement | null;
      if (button && toolbar) {
        const buttonRect = button.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        setFindAnchor(buttonRect.left - toolbarRect.left);
      }
      return true;
    });
  }, [props.handleRef]);

  /**
   * `DisplayModel::RotateBy` — the rotation is part of the view, so the viewer
   * keeps the current page and offset through the re-layout.
   */
  const rotate = useCallback((delta: number) => {
    setRotation((current) => (((current + delta) % 360 + 360) % 360) as 0 | 90 | 180 | 270);
  }, []);

  // ------------------------------------------------------------ keyboard
  //
  // light-pdf's viewer is driven from the keyboard; the accelerators are
  // transcribed in `lightpdf-keyboard.ts` with light-pdf's own key choices.
  // They are handled while the pane has focus, so the same keys keep their
  // normal meaning in the editor next to it.
  const rootRef = useRef<HTMLDivElement | null>(null);

  /**
   * The pane's own width, for the bookmarks sidebar's stand-down test.
   *
   * A `ResizeObserver` on the pane rather than a `window` listener: the pane is
   * resized by the splitter, not only by the window, and the splitter is exactly
   * the case this exists for.
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setPaneWidth((previous) => (previous === root.clientWidth ? previous : root.clientWidth));
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(root);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const actionsRef = useRef<LightPdfViewerActions | null>(null);
  actionsRef.current = {
    scrollBy: (deltaY) => props.handleRef.current?.scrollBy(deltaY),
    scrollByPage: (direction) => {
      // `UpdateScrollbars` — a page step is `nPage = 0.95 * viewPort.dy`, so the
      // top of the previous page stays visible.
      const height = rootRef.current?.clientHeight ?? 600;
      const scroller = rootRef.current?.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]');
      const before = scroller?.scrollTop ?? 0;
      props.handleRef.current?.scrollBy(direction * height * 0.95);
      // `CmdScrollDownPage` flips the page only when the scroll did not move.
      if (scroller && scroller.scrollTop === before) {
        if (direction > 0) props.handleRef.current?.nextPage();
        else props.handleRef.current?.previousPage();
      }
    },
    scrollHorizontally: (deltaX) => {
      const scroller = rootRef.current?.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]');
      if (scroller) scroller.scrollLeft += deltaX;
    },
    scrollHorizontallyPage: (direction) => {
      const scroller = rootRef.current?.querySelector<HTMLElement>('[data-testid="pdf-scroll-container"]');
      if (scroller) scroller.scrollLeft += direction * scroller.clientWidth * 0.95;
    },
    goToPage: (page) => props.handleRef.current?.goToPage(page),
    nextPage: () => props.handleRef.current?.nextPage(),
    previousPage: () => props.handleRef.current?.previousPage(),
    firstPage: () => props.handleRef.current?.goToPage(1),
    lastPage: () => props.handleRef.current?.goToPage(Math.max(1, pageCount)),
    navigateBack: () => props.handleRef.current?.navigateBack(),
    navigateForward: () => props.handleRef.current?.navigateForward(),
    setZoomMode: (mode) => applyZoom(zoomState.zoom, mode),
    setZoom: (zoom) => applyZoom(Math.max(0.1, Math.min(8, zoom)), 'custom'),
    // `CmdZoomIn` / `CmdZoomOut` step `GetNextZoomStep`'s ladder in the viewer,
    // which is where the viewport and the page sizes are known.
    zoomStep: (direction) => props.handleRef.current?.zoomStep(direction),
    getZoom: () => effectiveScale,
    // `kZoomFitContent` fits the page's content box rather than its media box;
    // the viewer measures the box from the page's text through the existing
    // `pdf:text` contract and the resolution happens in the layout.
    fitContent: () => applyZoom(zoomState.zoom, 'fit-content'),
    rotate: (delta) => rotate(delta * 90),
    openFind: () => {
      if (!findOpen) toggleFind();
    },
    findNext: () => props.handleRef.current?.findNext(),
    findPrevious: () => props.handleRef.current?.findPrevious(),
    selectAll: () => props.handleRef.current?.selectAll(),
    copySelection: () => props.handleRef.current?.copySelection() ?? false,
    // `ToggleContinuousView`: flip continuity inside the current layout family
    // (single page, facing or book view), as `LightPDF.cpp` does.
    toggleContinuous: () =>
      changeDisplayMode(isContinuousDisplayMode(resolveDisplayMode(displayMode)) ? nonContinuousForm(displayMode) : continuousForm(displayMode)),
    // `WindowTab::ToggleZoom`: fit page → fit width → fit content → shrink to fit.
    toggleZoom: () => {
      const next: PdfZoomMode =
        zoomState.mode === 'page-fit'
          ? 'page-width'
          : zoomState.mode === 'page-width'
            ? 'fit-content'
            : zoomState.mode === 'fit-content'
              ? 'shrink-to-fit'
              : 'page-fit';
      applyZoom(zoomState.zoom, next);
    },
    invertColors: () => props.onToggleInvertColors?.(),
    togglePageInfo: () => setPageInfoVisible((visible) => !visible),
    promptForPage: (count) => {
      const answer = window.prompt(`Go to page (1–${count}):`, String(page));
      if (answer === null) return;
      const target = Number.parseInt(answer, 10);
      if (Number.isFinite(target)) props.handleRef.current?.goToPage(target);
    },
    pageCount: () => pageCount,
    // `CmdSinglePageView` / `CmdFacingView` / `CmdBookView` (`Ctrl+6/7/8`).
    setDisplayMode: (mode) => changeDisplayMode(mode),
    /**
     * `CmdZoomCustom` (`Ctrl+Y`) — `Dialog_CustomZoom`'s "Magnification:" field,
     * which takes light-pdf's zoom percentage ("100%" is actual size) rather
     * than Eukolia's page scale.
     */
    promptForZoom: () => {
      const percent = Number.parseFloat(String(effectiveScale / LIGHTPDF_DPI_FACTOR * 100));
      const answer = window.prompt('Magnification (%):', String(Math.round(percent)));
      if (answer === null) return;
      const requested = Number.parseFloat(answer);
      if (!Number.isFinite(requested) || requested <= 0) return;
      applyZoom((requested / 100) * LIGHTPDF_DPI_FACTOR, 'custom');
    },
    /**
     * `CmdFindNextSel` / `CmdFindPrevSel` (`Ctrl+F3` / `Ctrl+Shift+F3`): run the
     * find bar's search on the selected text, which is how light-pdf's
     * "Find Next Selection" works (`FindBar.cpp`'s `SetFindTextAndFocus` path).
     */
    findSelection: (direction) => {
      const handle = props.handleRef.current;
      if (!handle) return;
      const selection = handle.getSelectionText().trim();
      if (!selection) return;
      const query = selection.replace(/\s+/g, ' ');
      setFindOpen(true);
      setFindQuery(query);
      void (async () => {
        await handle.find(query, { caseSensitive: matchCase, wholeWord });
        if (direction < 0) handle.findPrevious();
        else handle.findNext();
      })();
    },
    // `CmdToggleToolbar` (`F8`): `SetToolbarMode` flips between show and hide,
    // and the setting is the one source of truth the pane re-reads.
    toggleToolbar: () => {
      const next = toggledToolbarMode(viewerSettings.toolbarMode);
      settingsManager.setValue('pdf.toolbar', next, 'user');
      setToolbarRevealed(true);
    },
    // `CmdToggleBookmarks` (`F12`) flips the open document's `showToc`.
    toggleBookmarks: () => setTocOpen((open) => !open),
    // `CmdToggleLinks`: the `ShowLinks` preference, which is what
    // `DebugShowLinks` reads.
    toggleLinks: () => settingsManager.setValue('pdf.showLinks', !viewerSettings.showLinks, 'user'),
    // `CmdCopyFilePath`.
    copyFilePath: () => {
      if (props.path) void navigator.clipboard?.writeText(props.path);
    },
    // `CmdReloadDocument` (`R`).
    reloadDocument: () => props.onReload?.(),
    // `CmdProperties` (`Ctrl+D`).
    showProperties: () => setPropertiesOpen(true),
    // `CmdStartAutoScroll` (427) — `StartAutoScrollAtCursor` (`Canvas.cpp:1704`).
    toggleAutoScroll: () => props.handleRef.current?.toggleAutoScroll(),
    // `CmdToggleCursorPosition` (`M`).
    toggleCursorPosition: () => props.handleRef.current?.toggleCursorPosition(),
    /**
     * `CmdChangeScrollbar` (232) — `Dialog_ChangeScrollbar`
     * (`LightDialogs.cpp`): a four-way picker over `gScrollbarModeNames`. The
     * same prompt-over-a-list shape as `CmdZoomCustom`'s magnification field.
     */
    changeScrollbar: () => {
      const modes = LIGHTPDF_SCROLLBAR_MODES;
      const current = setting.str('pdf.scrollbar');
      const answer = window.prompt(`Scrollbars (${modes.join(' / ')}):`, current);
      if (answer === null) return;
      const name = answer.trim().toLowerCase();
      if (!modes.includes(name as (typeof modes)[number])) return;
      settingsManager.setValue('pdf.scrollbar', name, 'user');
    },
    // `CmdFindToggleMatchWholeWord` (434) — the find bar's whole-word button,
    // which is reachable from the palette too.
    toggleFindWholeWord: () => setFindWholeWord(!wholeWord)
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Keys typed into the find box or the page field belong to those controls.
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }

      const command = matchViewerAccelerator({
        key: event.key,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey
      });
      if (command === null) return;

      const actions = actionsRef.current;
      if (!actions) return;
      if (!runViewerCommand(command, actions)) return;

      event.preventDefault();
      event.stopPropagation();
    };

    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, []);

  /**
   * The application's command palette reaches the viewer's commands through this
   * channel, so a command has one implementation whether it arrives from a key,
   * the toolbar or the palette — which is how light-pdf's single `Cmd*` dispatch
   * works (`LightPDF.cpp`'s command switch, enumerated for the palette by
   * `CommandPaletteCollect.cpp`).
   */
  useEffect(
    () =>
      globalEvents.on('pdf:command', (command: unknown) => {
        const actions = actionsRef.current;
        if (!actions || typeof command !== 'number') return;
        runViewerCommand(command as LightPdfCommandId, actions);
      }),
    []
  );

  return (
    <div
      ref={rootRef}
      // Focusable so the viewer's own keys work once it has been clicked, and
      // only then: the shortcut set must not swallow keys meant for the editor.
      tabIndex={0}
      data-testid="pdf-pane-root"
      data-toolbar-mode={viewerSettings.toolbarMode}
      data-toolbar-position={viewerSettings.toolbarPosition}
      onMouseDown={() => rootRef.current?.focus()}
      onMouseMove={onOverlayPointerMove}
      onMouseLeave={onOverlayPointerLeave}
      onPointerLeave={props.onPointerLeave}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minWidth: 0, outline: 'none' }}
    >
      {/*
        `Canvas.cpp:1829-1857` — light-pdf's `ShowLinks` draws a 1px blue
        rectangle, inflated by 2px, around every link rectangle. The viewer
        renders the link rectangles already, so the preference is applied to them
        here rather than rebuilding the page.
      */}
      {viewerSettings.showLinks && (
        <style>{`
          [data-testid="pdf-pane-root"] [data-link] {
            outline: ${LIGHTPDF_LINK_OUTLINE_WIDTH}px solid ${LIGHTPDF_LINK_OUTLINE_COLOR};
            outline-offset: ${LIGHTPDF_LINK_OUTLINE_INFLATE}px;
          }
        `}</style>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
        {/*
          `ShowToc`: light-pdf shows the bookmarks sidebar only when the document
          has one, and `CmdToggleBookmarks` (`F12`) flips it for the open
          document (`LightPDF.cpp:1597-1598, 1648-1668`) — and only while the pane
          has room for it and a page (`LIGHTPDF_TOC_MIN_PANE_WIDTH`). A pane with
          no `clientWidth` yet (still hidden, or not laid out) counts as room: the
          sidebar's absence during the first measurement would be a flicker, and a
          pane that really is narrow reports its width on the next layout.
        */}
        {tocIsShown(tocOpen, outline.length > 0, paneWidth) && (
          <LightPdfToc
            outline={outline}
            theme={theme}
            currentPage={page}
            onGoToPage={(target) => props.handleRef.current?.goToPage(target)}
            onClose={() => setTocOpen(false)}
          />
        )}

        <div
          style={{
            position: 'relative',
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: toolbarAtBottom ? 'column-reverse' : 'column'
          }}
        >
          {/*
            `Toolbar`/`ShowToolbar` + `ToolbarPosition`. An overlay toolbar
            (`ToolbarModeIsOverlay`, `LightPDF.cpp:1163-1165`) floats over the
            page, sized to its natural width and centred (`OverlayToolbarRect`,
            `Toolbar.cpp:545-558`), and is revealed by proximity.
          */}
          <div
            ref={toolbarRef}
            data-testid="pdf-toolbar-host"
            style={
              viewerSettings.toolbarMode === 'overlay'
                ? {
                    position: 'absolute',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    [toolbarAtBottom ? 'bottom' : 'top']: 0,
                    zIndex: 15,
                    opacity: toolbarVisible ? 1 : 0,
                    pointerEvents: toolbarVisible ? 'auto' : 'none',
                    transition: 'opacity 120ms linear'
                  }
                : { position: 'relative', flexShrink: 0 }
            }
          >
            {viewerSettings.toolbarMode !== 'hide' && (
              <ToolbarHost
                findButtonRef={findButtonRef}
                toolbar={
                  <LightPdfToolbar
                    page={page}
                    pageCount={pageCount}
                    pageInfoVisible={pageInfoVisible}
                    zoom={effectiveScale}
                    zoomMode={zoomState.mode}
                    displayMode={resolveDisplayMode(displayMode)}
                    theme={theme}
                    iconSize={viewerSettings.toolbarSize}
                    edge={toolbarAtBottom ? 'top' : 'bottom'}
                    canNavigateBack={navigation.back}
                    canNavigateForward={navigation.forward}
                    findOpen={findOpen}
                    onOpenFile={props.onOpenFile}
                    onGoToPage={(target) => props.handleRef.current?.goToPage(target)}
                    onPreviousPage={() => props.handleRef.current?.previousPage()}
                    onNextPage={() => props.handleRef.current?.nextPage()}
                    onNavigateBack={() => props.handleRef.current?.navigateBack()}
                    onNavigateForward={() => props.handleRef.current?.navigateForward()}
                    onZoomFitWidthAndContinuous={() => changeZoomLevel('page-width', 'continuous')}
                    onZoomFitPageAndSinglePage={() => changeZoomLevel('page-fit', 'single-page')}
                    onRotateLeft={() => rotate(-90)}
                    onRotateRight={() => rotate(90)}
                    onZoomIn={() => props.handleRef.current?.zoomStep(1)}
                    onZoomOut={() => props.handleRef.current?.zoomStep(-1)}
                    onToggleFind={toggleFind}
                  />
                }
                findBar={
                  findOpen ? (
                    <LightPdfFindBar
                      theme={theme}
                      anchorLeft={findAnchor}
                      matchCase={matchCase}
                      wholeWord={wholeWord}
                      placement={toolbarAtBottom ? 'above' : 'below'}
                      barHeight={toolbarBarHeight}
                      status={findState.total > 0 ? `${findState.index} / ${findState.total}` : findQuery ? '0 / 0' : ''}
                      query={findQuery}
                      onQueryChange={onQueryChange}
                      onToggleMatchCase={() => {
                        const next = !matchCase;
                        setMatchCase(next);
                        void runSearch(findQuery, next);
                      }}
                      onToggleMatchWholeWord={() => setFindWholeWord(!wholeWord)}
                      onFindNext={() => props.handleRef.current?.findNext()}
                      onFindPrevious={() => props.handleRef.current?.findPrevious()}
                      onClose={() => {
                        props.handleRef.current?.clearSearch();
                        setFindOpen(false);
                        setFindQuery('');
                        setFindState({ index: 0, total: 0 });
                      }}
                    />
                  ) : null
                }
              />
            )}
            {/*
              With the toolbar hidden the find bar has no button to sit under, so
              it is anchored at the pane's own edge — light-pdf's find bar is a
              separate floating window that outlives the toolbar
              (`FindBar.cpp`, `ShowOrHideToolbar`, `Toolbar.cpp:652-680`).
            */}
            {viewerSettings.toolbarMode === 'hide' && findOpen && (
              <div style={{ position: 'absolute', [toolbarAtBottom ? 'bottom' : 'top']: 0, left: 0, zIndex: 20 }}>
                <LightPdfFindBar
                  theme={theme}
                  anchorLeft={findAnchor}
                  matchCase={matchCase}
                  wholeWord={wholeWord}
                  placement="below"
                  barHeight={0}
                  status={findState.total > 0 ? `${findState.index} / ${findState.total}` : findQuery ? '0 / 0' : ''}
                  query={findQuery}
                  onQueryChange={onQueryChange}
                  onToggleMatchCase={() => {
                    const next = !matchCase;
                    setMatchCase(next);
                    void runSearch(findQuery, next);
                  }}
                  onToggleMatchWholeWord={() => setFindWholeWord(!wholeWord)}
                  onFindNext={() => props.handleRef.current?.findNext()}
                  onFindPrevious={() => props.handleRef.current?.findPrevious()}
                  onClose={() => {
                    props.handleRef.current?.clearSearch();
                    setFindOpen(false);
                    setFindQuery('');
                    setFindState({ index: 0, total: 0 });
                  }}
                />
              </div>
            )}
          </div>

          <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
            <PdfViewer
              path={props.path}
              zoom={zoomState.zoom}
              zoomMode={zoomState.mode}
              displayMode={displayMode}
              theme={theme}
              rotation={rotation}
              handleRef={props.handleRef}
              invertColors={invertColors}
              onZoomChange={(zoom, mode) => {
                setZoomState({ zoom, mode });
                props.onZoomChange?.(zoom, mode);
              }}
              onPageChange={(nextPage, count) => {
                setPage(nextPage);
                setPageCount(count);
                props.onPageChange?.(nextPage, count);
              }}
              onDocumentLoaded={(info) => {
                setPageCount(info.pageCount);
                // Kept for `CmdProperties` (`Ctrl+D`), whose window shows the
                // document's own metadata (`LightProperties.cpp`).
                setDocumentInfo(info);
                // The page has to be pulled inside the new document in the same
                // breath as its length. The two arrive separately — the open reports
                // the count, a view change reports the page — and a document that
                // opens already laid out need not produce a view change, so a page
                // left over from a longer document survived and the toolbar read
                // `Page 2 / 1` after a failing build replaced a two-page PDF with a
                // one-page one. The viewer resets to page 1 (or a remembered page)
                // on open and reports the real value on its next view change; until
                // then this is what keeps the two consistent.
                setPage((previous) => Math.min(Math.max(1, previous), Math.max(1, info.pageCount)));
                props.onDocumentLoaded?.(info);
              }}
              onError={props.onError}
              onInverseSearch={props.onInverseSearch}
              onSearchStateChange={(index, total) => setFindState({ index, total })}
              onEffectiveScaleChange={setEffectiveScale}
              onNavigationStateChange={(back, forward) => setNavigation((previous) => (previous.back === back && previous.forward === forward ? previous : { back, forward }))}
            />

            {/* `CmdProperties` (`Ctrl+D`) — `Dialog_ShowProperties`. */}
            {propertiesOpen && documentInfo && (
              <LightPdfProperties
                info={documentInfo}
                currentPage={page}
                theme={theme}
                onClose={() => setPropertiesOpen(false)}
              />
            )}

            {/*
              The render-scale notice: light-pdf shows transient notifications in
              the canvas (`ThemeNotificationsBackgroundColor` /
              `ThemeNotificationsHighlightColor`, `BuildZoomString`), and this is
              that shape — the one state in which Eukolia's page can be less sharp
              than the display, said out loud instead of hidden.
            */}
            {renderScaleConstrained && (
              <div
                role="status"
                data-testid="pdf-render-scale-notice"
                style={{
                  position: 'absolute',
                  left: 8,
                  bottom: 8,
                  zIndex: 18,
                  padding: '2px 8px',
                  background: bgrToHex(themeNotificationsBackgroundColor(theme)),
                  color: bgrToHex(themeNotificationsHighlightTextColor(theme)),
                  border: `1px solid ${bgrToHex(accentColor(themeNotificationsBackgroundColor(theme), 40))}`,
                  fontFamily: 'Segoe UI, system-ui, sans-serif',
                  fontSize: 12,
                  pointerEvents: 'none'
                }}
              >
                Zoom is past the maximum render scale ({LIGHTPDF_MAX_RENDER_SCALE} device pixels per point); the page is shown from a smaller bitmap.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/** `ToggleContinuousView` — the continuous form of the current layout family. */
function continuousForm(mode: LightPdfDisplayMode): LightPdfDisplayMode {
  switch (mode) {
    case 'facing':
    case 'continuous-facing':
      return 'continuous-facing';
    case 'book':
    case 'continuous-book':
      return 'continuous-book';
    default:
      return 'continuous';
  }
}

/** `ToggleContinuousView` — the single-page form of the current layout family. */
function nonContinuousForm(mode: LightPdfDisplayMode): LightPdfDisplayMode {
  switch (mode) {
    case 'facing':
    case 'continuous-facing':
      return 'facing';
    case 'book':
    case 'continuous-book':
      return 'book';
    default:
      return 'single-page';
  }
}

/**
 * Gives the find button a ref so the floating find bar can be anchored under it
 * (`FindBar.cpp` — `PositionFindBar`) without threading a ref through the whole
 * toolbar table.
 */
const ToolbarHost: React.FC<{
  toolbar: React.ReactNode;
  findBar: React.ReactNode;
  findButtonRef: React.MutableRefObject<HTMLButtonElement | null>;
}> = ({ toolbar, findBar, findButtonRef }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // The toolbar renders its buttons from light-pdf's table; the Find button is
  // identified by its own command id (`CmdFindFirst = 264`) so the floating bar
  // can be anchored under it, as `FindBar.cpp`'s `PositionFindBar` does.
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      hostRef.current = node;
      findButtonRef.current = (node?.querySelector(`[data-command="${LIGHTPDF_CMD.CmdFindFirst}"]`) as HTMLButtonElement | null) ?? null;
    },
    [findButtonRef]
  );

  return (
    <div ref={attach} style={{ position: 'relative', flexShrink: 0 }}>
      {toolbar}
      {findBar}
    </div>
  );
};
