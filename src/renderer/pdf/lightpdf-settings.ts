/**
 * Eukolia — light-pdf's viewer preferences, read from Eukolia's settings store.
 *
 * light-pdf keeps its viewer preferences in `LightPDF-settings.txt`
 * (`GlobalPrefs`), defines them in `cmd/gen-settings.ts` and normalises them in
 * `AppSettings.cpp`. Eukolia's settings schema holds the same preferences under
 * `pdf.*` keys, so this module is the one place that turns a raw setting value
 * into the value light-pdf's own code would compute — including its fallbacks,
 * its clamps and the legacy spellings it still migrates.
 *
 * Every function here takes the *raw* value rather than reading the store, so
 * the conversions are testable without a settings backend and so the pane can
 * re-read them whenever the Settings UI changes.
 */

import { setting } from '../core/settings';
import {
  LIGHTPDF_FORWARD_SEARCH_COLOR,
  LIGHTPDF_FORWARD_SEARCH_DEFAULT_WIDTH,
  LIGHTPDF_PAGE_SPACING,
  LIGHTPDF_WINDOW_MARGIN,
  LIGHTPDF_ZOOM_MAX,
  LIGHTPDF_ZOOM_MIN
} from './lightpdf-theme';

/** `LightPDF.cpp:1152` — `gToolbarModeNames = "show\0hide\0overlay\0"`. */
export type LightPdfToolbarMode = 'show' | 'hide' | 'overlay';

/** `LightPDF.cpp:1182` — `gToolbarPositionNames = "top\0bottom\0"`. */
export type LightPdfToolbarPosition = 'top' | 'bottom';

/** `LightPDF.cpp:1126` — `gScrollbarModeNames = "windows\0smart\0overlay\0hidden\0"`. */
export type LightPdfScrollbarMode = 'windows' | 'smart' | 'overlay' | 'hidden';

/** `LightPDF.h` — `kScrollbarWindows` … `kScrollbarHidden`, in the array's own order. */
export const LIGHTPDF_SCROLLBAR_MODES: readonly LightPdfScrollbarMode[] = ['windows', 'smart', 'overlay', 'hidden'];

/** `Canvas.cpp` — one wheel notch is this many `DpiScale(16)`-pixel lines. */
export const LIGHTPDF_WHEEL_DELTA = 120;
export const LIGHTPDF_WHEEL_LINES_PER_NOTCH = 3;
export const LIGHTPDF_SCROLL_LINE_HEIGHT = 16;

/**
 * `Canvas.cpp:2667-2668` — `gDeltaPerLine` is the wheel delta one *line* costs.
 * light-pdf reads it from `SPI_GETWHEELSCROLLLINES` (3 lines per notch by
 * default, which is Windows' own default), and `< 0` means "the user asked for
 * page-at-a-time scrolling", which `Canvas.cpp:2692-2708` honours by scrolling
 * a fraction of the page per notch.
 */
export const LIGHTPDF_DELTA_PER_LINE = LIGHTPDF_WHEEL_DELTA / LIGHTPDF_WHEEL_LINES_PER_NOTCH;

/** `Canvas.cpp:2274` — "less than 5 pixels/sec is stopped". */
export const LIGHTPDF_SMOOTH_SCROLL_STOP_VELOCITY = 5;

/**
 * `Canvas.cpp:2737` — the integrator's *default* decay rate is
 * `0.1 * 50.0`, i.e. the rate `SmoothScrollFriction`'s own default of 0.2
 * produces. The impulse is scaled by it so friction changes how long the
 * momentum lasts without changing how far one notch ultimately goes.
 */
export const LIGHTPDF_SMOOTH_SCROLL_DEFAULT_DECAY_RATE = 0.1 * 50;

/** `Canvas.cpp:2286` — the decay rate never falls below 1 (a friction of 0). */
export const LIGHTPDF_SMOOTH_SCROLL_MIN_DECAY_RATE = 1;

/** `gen-settings.ts:746` — `SmoothScrollFriction`'s own default. */
export const LIGHTPDF_DEFAULT_SMOOTH_SCROLL_FRICTION = 0.2;

/**
 * `PdfDarkMode.h:56` — `enum class DocumentColorsFollowTheme`.
 *
 * `off` keeps the page colours the document declares, `smart` recolours text and
 * background but not images (MuPDF object-level dark mode), `legacy` recolours
 * the whole rasterised page (light-pdf's pre-3.7 behaviour).
 */
export type LightPdfDocumentColorsFollowTheme = 'off' | 'smart' | 'legacy';

/** `Settings.h:1180` — the compiled default of `MainWindowBackground`. */
export const LIGHTPDF_DEFAULT_MAIN_WINDOW_BACKGROUND = '#80fff200';

/** `Toolbar.cpp` — `kDefaultIconSize`, and `AppSettings.cpp:390-393`'s clamp. */
export const LIGHTPDF_DEFAULT_TOOLBAR_SIZE = 18;
export const LIGHTPDF_TOOLBAR_SIZE_MIN = 8;
export const LIGHTPDF_TOOLBAR_SIZE_MAX = 64;

/**
 * `LightPDF.cpp:1154-1161` — `ToolbarModeFromPrefs`.
 *
 * `Toolbar` (3.7) is the real preference; `ShowToolbar` is the older boolean it
 * replaced, and an unset or misspelled `Toolbar` still falls back to it
 * (`AppSettings.cpp:400-407`). The values are case-insensitive in light-pdf
 * (`SeqStrIndexIS`).
 */
export function lightPdfToolbarModeFromPrefs(toolbar: unknown, showToolbar: unknown): LightPdfToolbarMode {
  const name = typeof toolbar === 'string' ? toolbar.trim().toLowerCase() : '';
  if (name === 'show' || name === 'hide' || name === 'overlay') return name;
  return showToolbar === false ? 'hide' : 'show';
}

/** `LightPDF.cpp:1184-1190` — `ToolbarPositionFromPrefs`; anything else is `top`. */
export function lightPdfToolbarPositionFromPrefs(position: unknown): LightPdfToolbarPosition {
  const name = typeof position === 'string' ? position.trim().toLowerCase() : '';
  return name === 'bottom' ? 'bottom' : 'top';
}

/**
 * `AppSettings.cpp:390-393` — `ToolbarSize` is the icon size, not the bar
 * height: `0` means "not set" and becomes 18 (`Toolbar.cpp:1281-1283`: "we call
 * it ToolbarSize for users, but it's really size of the icon"), and the value is
 * clamped to 8…64.
 */
export function lightPdfToolbarIconSize(value: unknown): number {
  const size = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(size) || size === 0) return LIGHTPDF_DEFAULT_TOOLBAR_SIZE;
  return Math.min(LIGHTPDF_TOOLBAR_SIZE_MAX, Math.max(LIGHTPDF_TOOLBAR_SIZE_MIN, Math.round(size)));
}

/**
 * `PdfDarkModeColor.cpp:34-55` — `DocumentColorsFollowThemeFromString`, including
 * the pre-3.7 spellings it still migrates (`auto` → smart, `black` → legacy,
 * `none`/`light` → off). Anything unrecognised is `off`, which is also the
 * setting's default (`gen-settings.ts:784-791`).
 */
export function lightPdfDocumentColorsFollowThemeFromPrefs(value: unknown): LightPdfDocumentColorsFollowTheme {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (name) {
    case 'smart':
    case 'auto':
      return 'smart';
    case 'legacy':
    case 'black':
      return 'legacy';
    default:
      return 'off';
  }
}

/**
 * `Canvas.cpp:2710-2716`, `:2718-2728` — a half-page step: `SB_HALF_PAGEDOWN`
 * advances by `si.nPage / 2`, i.e. half the viewport, and `SB_HALF_PAGEUP`
 * retreats by the same. `direction` is the scroll direction, so `1` is "towards
 * the end of the document", which is a positive `yOffset`.
 */
export function lightPdfFastScrollDistance(direction: 1 | -1, viewportHeight: number): number {
  return direction * (viewportHeight / 2);
}

/**
 * `Canvas.cpp:2718-2722` — the pointer is "over the scrollbar" when it is
 * further right than the canvas: `pt.x > win->canvasRc.dx`. In the browser the
 * scroller's own scrollbar occupies `clientWidth … clientWidth + barWidth`, and
 * `offsetWidth` includes it, so the same test is `innerWidth > clientWidth` plus
 * the pointer being past the client box.
 */
export function lightPdfPointerOverScrollbar(
  pointerX: number,
  rect: { left: number },
  scroller: { clientWidth: number; clientHeight: number; scrollHeight: number }
): boolean {
  // The bar exists when the content overflows and the platform draws one; its
  // strip is the client box's right edge onwards, so a pointer past
  // `clientWidth` is over it.
  const visible = scroller.scrollHeight > scroller.clientHeight;
  return visible && pointerX - rect.left > scroller.clientWidth;
}

/** A colour setting in light-pdf's `#aarrggbb`/`#rrggbb` form, or `null` when unset. */
export function lightPdfOptionalColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(trimmed) ? trimmed : null;
}

/**
 * `LightPDF.cpp:1126-1134` — `ScrollbarModeFromPrefs`: an unknown or unset
 * `Scrollbars` string is `windows`, which is `kScrollbarWindows` and the
 * setting's own default. `SeqStrIndexIS` compares case-insensitively.
 */
export function lightPdfScrollbarModeFromPrefs(value: unknown): LightPdfScrollbarMode {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LIGHTPDF_SCROLLBAR_MODES.find((mode) => mode === name) ?? 'windows';
}

/** `LightPDF.cpp:1136-1138` — `ScrollbarsAreHidden`. */
export function lightPdfScrollbarsHidden(mode: LightPdfScrollbarMode): boolean {
  return mode === 'hidden';
}

/**
 * `LightPDF.cpp:1140-1143` — `ScrollbarsUseOverlay`: `smart` and `overlay` both
 * replace the platform scrollbar with light-pdf's own overlay window.
 */
export function lightPdfScrollbarsUseOverlay(mode: LightPdfScrollbarMode): boolean {
  return mode === 'smart' || mode === 'overlay';
}

/**
 * `LightPDF.cpp:1145-1150` — `ScrollbarsOverlayMode`: only `overlay` pins the
 * overlay bar open (`OverlayScrollbar::Mode::Thick`); `smart` lets it hide
 * itself and thicken by proximity.
 */
export function lightPdfOverlayScrollbarMode(mode: LightPdfScrollbarMode): 'Smart' | 'Thick' {
  return mode === 'overlay' ? 'Thick' : 'Smart';
}

/**
 * `Canvas.cpp:2586-2588` — the wheel delta is multiplied by `ScrollSensitivity`
 * unless that is exactly 1. A non-positive or non-numeric value would freeze or
 * invert the wheel, so it is treated as unset and light-pdf's 2.0 is used.
 */
export function lightPdfScrollSensitivity(value: unknown): number {
  const sensitivity = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(sensitivity) || sensitivity <= 0) return 2;
  return sensitivity;
}

/**
 * `gen-settings.ts:746` — `SmoothScrollFriction` is documented as "0 to 1,
 * higher is faster stop", and `Canvas.cpp:2286` floors the derived decay rate at
 * 1 so 0 still decays. A value outside the range, or nonsense, is light-pdf's
 * own default of 0.2.
 */
export function lightPdfSmoothScrollFriction(value: unknown): number {
  const friction = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(friction) || friction < 0 || friction > 1) return LIGHTPDF_DEFAULT_SMOOTH_SCROLL_FRICTION;
  return friction;
}

/**
 * `Canvas.cpp:2285-2287` — the smooth-scroll decay rate is
 * `SmoothScrollFriction * 50`, floored at 1 so a friction of 0 still decays.
 */
export function lightPdfSmoothScrollDecayRate(friction: unknown): number {
  return Math.max(LIGHTPDF_SMOOTH_SCROLL_MIN_DECAY_RATE, lightPdfSmoothScrollFriction(friction) * 50);
}

/**
 * `Canvas.cpp:2732-2734` — the distance one wheel notch asks for:
 * `delta / gDeltaPerLine` lines of `DpiScale(16)` pixels. `gDeltaPerLine` is
 * `WHEEL_DELTA / SPI_GETWHEELSCROLLLINES`, and the browser reports a notch as
 * `WHEEL_DELTA / 3` (`deltaMode` 1) or as raw pixels (`deltaMode` 0), which is
 * converted to lines before it gets here.
 */
export function lightPdfWheelNotchDistance(lines: number): number {
  return lines * LIGHTPDF_SCROLL_LINE_HEIGHT;
}

/**
 * `Canvas.cpp:2730-2751` — one wheel notch's impulse into the smooth-scroll
 * integrator.
 *
 * The reference writes `targetDistance * 0.1 * 50 * ScrollSensitivity`, where
 * `0.1` is the *default* value of `SmoothScrollFriction` (its comment at `:2736`
 * calls the `0.1 * 50` the "default decay rate"), so the impulse is the target
 * distance times the rate the velocity decays at. That is the quantity an
 * exponential decay travels exactly (`∫ v·e^(-rate·t) dt = v/rate`), which is
 * what makes one notch of momentum scrolling land where the same notch lands
 * without momentum. `ScrollSensitivity` is applied on top, exactly as `:2738`
 * does.
 */
export function lightPdfSmoothScrollImpulse(targetDistance: number, sensitivity: number): number {
  return targetDistance * LIGHTPDF_SMOOTH_SCROLL_DEFAULT_DECAY_RATE * sensitivity;
}

/**
 * `Canvas.cpp:2283-2287` — one tick of the integrator's velocity. light-pdf
 * calls this towards negative Y for a downward wheel notch.
 */
export function lightPdfSmoothScrollDecay(velocity: number, decayRate: number, dt: number): number {
  return velocity * Math.exp(-decayRate * dt);
}

/** `Canvas.cpp:2274-2276` — below 5 px/s the momentum is over. */
export function lightPdfSmoothScrollStopped(velocity: number): boolean {
  return Math.abs(velocity) < LIGHTPDF_SMOOTH_SCROLL_STOP_VELOCITY;
}

/** One reading of every light-pdf viewer preference Eukolia honours. */
export interface LightPdfViewerSettings {
  /** light-pdf `Toolbar` / `ShowToolbar` (`gen-settings.ts:706-720`). */
  toolbarMode: LightPdfToolbarMode;
  /** light-pdf `ToolbarPosition` (`gen-settings.ts:715-720`). */
  toolbarPosition: LightPdfToolbarPosition;
  /** light-pdf `ToolbarSize` (`gen-settings.ts:799`). */
  toolbarSize: number;
  /** light-pdf `ShowToc` (`gen-settings.ts:729-734`). */
  showToc: boolean;
  /** light-pdf `ShowLinks` (`gen-settings.ts:735`). */
  showLinks: boolean;
  /** light-pdf `DocumentColorsFollowTheme` (`gen-settings.ts:784-791`). */
  documentColorsFollowTheme: LightPdfDocumentColorsFollowTheme;
  /**
   * light-pdf `FixedPageUI.WindowBgCol` (`gen-settings.ts:284`) — the PDF
   * canvas background, `null` when unset (`Canvas.cpp:1996-2001`).
   */
  windowBackgroundColor: string | null;
  /**
   * light-pdf `MainWindowBackground` (`gen-settings.ts:652`) — overrides the
   * light theme's window background and therefore the canvas
   * (`Theme.cpp:469-479`), `null` for the compiled default.
   */
  mainWindowBackground: string | null;
  /** light-pdf `Scrollbars` (`gen-settings.ts:738-743`). */
  scrollbarMode: LightPdfScrollbarMode;
  /** light-pdf `ScrollbarInSinglePage` (`gen-settings.ts:744`). */
  scrollbarInSinglePage: boolean;
  /** light-pdf `ScrollSensitivity` (`gen-settings.ts:747`). */
  scrollSensitivity: number;
  /** light-pdf `SmoothScroll` (`gen-settings.ts:740-745`), the momentum wheel. */
  smoothScroll: boolean;
  /** light-pdf `SmoothScrollFriction` (`gen-settings.ts:746`). */
  smoothScrollFriction: number;
  /** light-pdf `FastScrollOverScrollbar` (`gen-settings.ts:764-768`). */
  fastScrollOverScrollbar: boolean;
  /** light-pdf `ZoomLevels` (`gen-settings.ts:834-840`), empty for the built-in ladder. */
  zoomLevels: number[];
  /** light-pdf `ZoomIncrement` (`gen-settings.ts:842-848`), 0 for the ladder. */
  zoomIncrement: number;
  /**
   * light-pdf `FixedPageUI.WindowMargin` (`gen-settings.ts:232-237`) — the
   * `compactStruct`'s four fields, in its own order.
   */
  windowMargin: LightPdfWindowMargin;
  /** light-pdf `FixedPageUI.PageSpacing` (`gen-settings.ts:246`). */
  pageSpacing: { dx: number; dy: number };
  /** light-pdf `Annotations.SelectionToolbar` (`gen-settings.ts:445-450`). */
  selectionToolbar: boolean;
  /** light-pdf `ForwardSearch` (`gen-settings.ts:213-230`). */
  forwardSearch: LightPdfForwardSearchSettings;
}

/** Reads every preference above from the settings store. */
export function readLightPdfViewerSettings(): LightPdfViewerSettings {
  const mainWindowBackground = lightPdfOptionalColor(setting.str('pdf.mainWindowBackground'));
  return {
    // The legacy `ShowToolbar` boolean is not a separate key: `pdf.toolbar`
    // always holds one of light-pdf's three names, and `CmdToggleToolbar` keeps
    // the legacy boolean's meaning in step exactly as `SetToolbarMode`
    // (`LightPDF.cpp:1171-1180`) does. `true` is `ShowToolbar`'s own default
    // (`gen-settings.ts:706`), i.e. what light-pdf falls back to.
    toolbarMode: lightPdfToolbarModeFromPrefs(setting.str('pdf.toolbar'), true),
    toolbarPosition: lightPdfToolbarPositionFromPrefs(setting.str('pdf.toolbarPosition')),
    toolbarSize: lightPdfToolbarIconSize(setting.num('pdf.toolbarSize')),
    showToc: setting.bool('pdf.showToc'),
    showLinks: setting.bool('pdf.showLinks'),
    documentColorsFollowTheme: lightPdfDocumentColorsFollowThemeFromPrefs(setting.str('pdf.documentColorsFollowTheme')),
    windowBackgroundColor: lightPdfOptionalColor(setting.str('pdf.windowBackgroundColor')),
    // `Theme.cpp:305`/`469-479`: the compiled default means "not set", so it is
    // reported as `null` and the theme's own colour stays in charge.
    mainWindowBackground: isDefaultMainWindowBackground(mainWindowBackground) ? null : mainWindowBackground,
    scrollbarMode: lightPdfScrollbarModeFromPrefs(setting.str('pdf.scrollbar')),
    scrollbarInSinglePage: setting.bool('pdf.scrollbarInSinglePage'),
    scrollSensitivity: lightPdfScrollSensitivity(setting.num('pdf.scrollSensitivity')),
    smoothScroll: setting.bool('pdf.smoothScroll'),
    smoothScrollFriction: lightPdfSmoothScrollFriction(setting.num('pdf.smoothScrollFriction')),
    fastScrollOverScrollbar: setting.bool('pdf.fastScrollOverScrollbar'),
    zoomLevels: lightPdfZoomLevelsFromPrefs(setting.list('pdf.zoomLevels')),
    zoomIncrement: lightPdfZoomIncrementFromPrefs(setting.num('pdf.zoomIncrement')),
    windowMargin: lightPdfWindowMarginFromPrefs(setting.str('pdf.windowMargin')),
    pageSpacing: lightPdfPageSpacingFromPrefs(setting.str('pdf.pageSpacing')),
    selectionToolbar: setting.bool('pdf.selectionToolbar'),
    forwardSearch: readLightPdfForwardSearchSettings()
  };
}

/**
 * `Settings.h` — the four `ForwardSearch` fields, normalised the way
 * `SearchAndDDE.cpp:1467-1487` reads them.
 */
export interface LightPdfForwardSearchSettings {
  /** `HighlightColor`, painted at `kSelectionDefaultAlpha`. */
  color: string;
  /** `HighlightWidth`, with `SearchAndDDE.cpp:1478`'s "not positive means 15". */
  width: number;
  /** `HighlightOffset` — above 0 the highlight becomes a left-margin marker. */
  offset: number;
  /** `HighlightPermanent` — stop the fade-out timer. */
  permanent: boolean;
}

/** `ForwardSearch`'s four fields, as `SearchAndDDE.cpp` uses them. */
export function readLightPdfForwardSearchSettings(): LightPdfForwardSearchSettings {
  return {
    color: lightPdfOptionalColor(setting.str('pdf.forwardSearchHighlightColor')) ?? LIGHTPDF_FORWARD_SEARCH_COLOR,
    width: lightPdfForwardSearchWidth(setting.num('pdf.forwardSearchHighlightWidth')),
    offset: lightPdfNonNegativeInt(setting.num('pdf.forwardSearchHighlightOffset'), 0),
    permanent: setting.bool('pdf.forwardSearchHighlightPermanent')
  };
}

/** `SearchAndDDE.cpp:1478` — a `HighlightWidth` that is not positive falls back to 15. */
export function lightPdfForwardSearchWidth(value: unknown): number {
  const width = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(width) || width <= 0) return LIGHTPDF_FORWARD_SEARCH_DEFAULT_WIDTH;
  return Math.round(width);
}

/**
 * `Settings.h` — `WindowMargin` as `DocumentLayout.cpp` reads it.
 *
 * light-pdf writes the four numbers space-separated on one line
 * (`WindowMargin = 2 4 2 4`) because `AdvancedSettingsDialog.cpp:237-240` has no
 * widget for a compact struct; Eukolia's setting holds the same text, so a line
 * copied out of a `LightPDF-settings.txt` can be pasted straight in. Anything
 * that is not four finite numbers leaves light-pdf's own defaults in place,
 * which is what its parser does with a malformed line.
 */
export interface LightPdfWindowMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** `gen-settings.ts:232-237` — the compact struct's field order and defaults. */
export function lightPdfWindowMarginFromPrefs(value: unknown): LightPdfWindowMargin {
  const numbers = lightPdfNumberList(value, 4);
  if (!numbers) return { ...LIGHTPDF_WINDOW_MARGIN };
  return { top: numbers[0], right: numbers[1], bottom: numbers[2], left: numbers[3] };
}

/** `gen-settings.ts:246` — `PageSpacing`'s two fields and their defaults. */
export function lightPdfPageSpacingFromPrefs(value: unknown): { dx: number; dy: number } {
  const numbers = lightPdfNumberList(value, 2);
  if (!numbers) return { ...LIGHTPDF_PAGE_SPACING };
  return { dx: numbers[0], dy: numbers[1] };
}

/**
 * Splits light-pdf's space-separated number list, accepting commas too so a
 * hand-typed value is not silently ignored. Returns `null` unless exactly
 * `expected` finite numbers were found.
 */
function lightPdfNumberList(value: unknown, expected: number): number[] | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length !== expected) return null;
  const numbers = parts.map((part) => Number(part));
  return numbers.every((number) => Number.isFinite(number)) ? numbers : null;
}

/**
 * `AppSettings.cpp:349-355` — the custom zoom ladder: sorted ascending, with
 * anything below `kZoomMin` (8.33) or above `kZoomMax` (6400) dropped. An empty
 * result means the built-in `defaultZoomLevels` (`DisplayModel.cpp:1739-1743`)
 * is used, which is also light-pdf's default.
 */
export function lightPdfZoomLevelsFromPrefs(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const levels: number[] = [];
  for (const entry of value) {
    const level = typeof entry === 'number' ? entry : Number(entry);
    if (!Number.isFinite(level)) continue;
    if (level < LIGHTPDF_ZOOM_MIN || level > LIGHTPDF_ZOOM_MAX) continue;
    levels.push(level);
  }
  return levels.sort((a, b) => a - b);
}

/**
 * `DisplayModel.cpp:1719-1724` — `ZoomIncrement` is a percentage step relative
 * to the current zoom (`factor = increment / 100 + 1`); zero or negative means
 * the ladder decides instead.
 */
export function lightPdfZoomIncrementFromPrefs(value: unknown): number {
  const increment = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(increment) && increment > 0 ? increment : 0;
}

/** Rounds a value to a whole number of points, treating nonsense as `fallback`. */
function lightPdfNonNegativeInt(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.round(number);
}

/**
 * `LightPDF.cpp:1171-1180` — `SetToolbarMode`, as the `CmdToggleToolbar` (`F8`)
 * command uses it: the mode and the legacy boolean are kept in step.
 */
export function toggledToolbarMode(mode: LightPdfToolbarMode): LightPdfToolbarMode {
  return mode === 'hide' ? 'show' : 'hide';
}

/**
 * `Theme.cpp:305` — `IsDefaultMainWinColor`: the compiled default
 * (`#80fff200`, a translucent yellow) means "no override", so a colour that
 * equals it must not be applied.
 */
export function isDefaultMainWindowBackground(value: string | null): boolean {
  return value === null || value.toLowerCase() === LIGHTPDF_DEFAULT_MAIN_WINDOW_BACKGROUND;
}
