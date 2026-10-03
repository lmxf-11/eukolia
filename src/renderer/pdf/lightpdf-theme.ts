/**
 * Eukolia — light-pdf theme, ported.
 *
 * This module is a **transcription** of light-pdf's colour scheme, not a new
 * design. Every value and every algorithm below comes from a named light-pdf
 * symbol so the mapping stays auditable:
 *
 * | here                                   | light-pdf source                                   |
 * | -------------------------------------- | -------------------------------------------------- |
 * | `LIGHTPDF_THEMES_TXT`                  | `src/Theme.cpp` — the `themesTxt` raw string        |
 * | `lightness` / `adjustLightness`        | `src/base/Color.cpp` — `GetLightness`, `AdjustLightness` |
 * | `adjustLightness2`, `isLightColor`     | `src/base/Color.cpp` — `AdjustLightness2`, `IsLightColor` |
 * | `accentColor`                          | `src/Theme.cpp` — `AccentColor`                     |
 * | `themeMainWindowBackgroundColor()` etc. | `src/Theme.cpp` — the `Theme*Color()` accessors     |
 * | `themeDocumentColors()`                | `src/Theme.cpp` — `ThemeDocumentColors`             |
 * | `themePageRenderColors()`              | `src/Theme.cpp` — `ThemePageRenderColors`           |
 * | `LIGHTPDF_PAGE_*`                      | `src/Settings.h` — `gWindowMarginFields` / `gSizeFields` defaults |
 * | `LIGHTPDF_SELECTION_*`                 | `src/Selection.h` / `src/Selection.cpp`             |
 * | `LIGHTPDF_ZOOM_*`                      | `src/Settings.h`, `src/DisplayModel.cpp`            |
 * | `LIGHTPDF_SCROLLBAR_*`                 | `src/OverlayScrollbar.cpp` / `.h`                   |
 *
 * The C++ returns `COLORREF` values in `0x00bbggrr` (BGR) order. Everything here
 * is normalised to `#rrggbb` strings for the DOM; the conversion happens once,
 * in `bgrToHex()`.
 *
 * light-pdf's theme list is used as-is: the *default* is index 0 ("Light") and
 * dark mode resolves through `SetTheme("System")` → `GetPreferredDarkThemeIndex()`,
 * which looks up the theme named "Dark" — exactly as light-pdf does.
 */

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/**
 * `src/Theme.cpp` — `themesTxt`, transcribed verbatim (name, TextColor,
 * BackgroundColor, ControlBackgroundColor, LinkColor, ColorizeControls).
 * The two `_TRN` comments light-pdf preserves for its translation tables
 * ("Dark", "Darker", "Light") are not needed here.
 */
export const LIGHTPDF_THEMES_TXT = String.raw`Themes [
    [
        Name = Light
        TextColor = #000000
        BackgroundColor = #f2f2f2
        ControlBackgroundColor = #ffffff
        LinkColor = #0020a0
        ColorizeControls = false
    ]
    [
        Name = Light Warm
        TextColor = #333333
        BackgroundColor = #ebe6da
        ControlBackgroundColor = #f5f1e8
        LinkColor = #0020a0
        ColorizeControls = true
    ]
    [
        Name = Dark from 3.5
        TextColor = #bac9d0
        BackgroundColor = #263238
        ControlBackgroundColor = #263238
        LinkColor = #8aa3b0
        ColorizeControls = true
    ]
    [
        Name = Darker
        TextColor = #c3c3c6
        BackgroundColor = #2d2d30
        ControlBackgroundColor = #2d2d30
        LinkColor = #9999a0
        ColorizeControls = true
    ]
    [
        Name = Dark
        TextColor = #F9FAFB
        BackgroundColor = #000000
        ControlBackgroundColor = #000000
        LinkColor = #6B7280
        ColorizeControls = true
    ]
    [
        Name = Dark background Bright text
        TextColor = #ffffff
        BackgroundColor = #2d2d30
        ControlBackgroundColor = #2d2d30
        LinkColor = #9999a0
        ColorizeControls = true
    ]
    [
        Name = Solarized Light
        TextColor = #212323
        BackgroundColor = #fdf6e3
        ControlBackgroundColor = #eee8d5
        LinkColor = #9999a0
        ColorizeControls = true
    ]
    [
        Name = Solarized Dark
        TextColor = #839496
        BackgroundColor = #002b36
        ControlBackgroundColor = #073642
        LinkColor = #268bd2
        ColorizeControls = true
    ]
    [
        Name = Dracula
        TextColor = #f8f8f2
        BackgroundColor = #282a36
        ControlBackgroundColor = #44475a
        LinkColor = #8be9fd
        ColorizeControls = true
    ]
    [
        Name = Nebula
        TextColor = #CBE3E7
        BackgroundColor = #100E23
        ControlBackgroundColor = #1E1C31
        LinkColor = #91DDFF
        ColorizeControls = true
    ]
    [
        Name = Greeny
        TextColor = #FDD085
        BackgroundColor = #4F6232
        ControlBackgroundColor = #1E3304
        LinkColor = #A2E53B
        ColorizeControls = true
    ]
    [
        Name = Choco
        TextColor = #D7AD62
        BackgroundColor = #2A1104
        ControlBackgroundColor = #172736
        LinkColor = #E8CD12
        ColorizeControls = true
    ]
    [
        Name = Purpy
        TextColor = #E2C3C3
        BackgroundColor = #20222A
        ControlBackgroundColor = #1E0126
        LinkColor = #EFF0B8
        ColorizeControls = true
    ]
]
`;

export interface LightPdfTheme {
  name: string;
  /** `Theme.cpp` TextColor */
  textColor: string;
  /** `Theme.cpp` BackgroundColor */
  backgroundColor: string;
  /** `Theme.cpp` ControlBackgroundColor */
  controlBackgroundColor: string;
  /** `Theme.cpp` LinkColor */
  linkColor: string;
  /** `Theme.cpp` ColorizeControls */
  colorizeControls: boolean;
}

/** Parses the `themesTxt` block above with light-pdf's own field names. */
function parseThemes(text: string): LightPdfTheme[] {
  const themes: LightPdfTheme[] = [];
  // Each entry is a `[ ... ]` block; fields are `Key = Value` lines.
  for (const block of text.split('[').slice(1)) {
    const body = block.split(']')[0];
    const field = (key: string): string => {
      const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm').exec(body);
      return match ? match[1].trim() : '';
    };
    const name = field('Name');
    if (!name) continue;
    themes.push({
      name,
      textColor: field('TextColor'),
      backgroundColor: field('BackgroundColor'),
      controlBackgroundColor: field('ControlBackgroundColor'),
      linkColor: field('LinkColor'),
      colorizeControls: field('ColorizeControls').toLowerCase() === 'true'
    });
  }
  return themes;
}

export const LIGHTPDF_THEMES: readonly LightPdfTheme[] = parseThemes(LIGHTPDF_THEMES_TXT);

/**
 * The theme names, in light-pdf's own order.
 *
 * Exposed so the settings list is generated from `Theme.cpp`'s table rather than
 * duplicating the names, which would drift the moment either side changed.
 */
export const LIGHTPDF_THEME_NAMES: readonly string[] = LIGHTPDF_THEMES.map(
  (theme) => theme.name
);

/** The index of a named theme, or `null` when there is no such theme. */
export function lightPdfThemeIndexByName(name: string): number | null {
  const index = LIGHTPDF_THEMES.findIndex(
    (theme) => theme.name.toLowerCase() === name.trim().toLowerCase()
  );
  return index >= 0 ? index : null;
}

/** `Theme.cpp` — `gThemeLight = (*gThemes)[0]`. */
export const LIGHTPDF_THEME_LIGHT_INDEX = 0;

/** `Theme.cpp` — `GetPreferredDarkThemeIndex()` falls back to the theme named "Dark". */
export function lightPdfDarkThemeIndex(): number {
  const index = LIGHTPDF_THEMES.findIndex((theme) => theme.name.toLowerCase() === 'dark');
  return index >= 0 ? index : LIGHTPDF_THEME_LIGHT_INDEX;
}

/**
 * `Theme.cpp` — `SetTheme("System")` resolves the OS preference to
 * `GetPreferredLightThemeIndex()` / `GetPreferredDarkThemeIndex()`. Eukolia's
 * light/dark setting is the equivalent input; there is no separate light-pdf
 * theme picker yet, so "Light" and "Dark" are the two resolvable endpoints.
 */
export function lightPdfThemeIndexFor(appearance: 'light' | 'dark'): number {
  return appearance === 'dark' ? lightPdfDarkThemeIndex() : LIGHTPDF_THEME_LIGHT_INDEX;
}

// ---------------------------------------------------------------------------
// Colour maths — `src/base/Color.cpp`
// ---------------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** `Color.cpp` — `UnpackColor` (COLORREF is 0x00bbggrr). */
export function unpackColor(color: number): Rgb {
  return { r: color & 0xff, g: (color >> 8) & 0xff, b: (color >> 16) & 0xff };
}

/** `Color.cpp` — `MkColor`. */
export function mkColor(r: number, g: number, b: number): number {
  return (r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16);
}

/** `Color.cpp` — `GetLightness`. */
export function getLightness(color: number): number {
  const { r, g, b } = unpackColor(color);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return (max + min) / 2;
}

/** `Color.cpp` — `IsLightColor`. */
export function isLightColor(color: number): boolean {
  const { r, g, b } = unpackColor(color);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return y > 127.5;
}

/** `Color.cpp` — `AdjustLightness`. */
export function adjustLightness(color: number, factor: number): number {
  const { r: R0, g: G0, b: B0 } = unpackColor(color);
  const M = Math.max(R0, G0, B0);
  const m = Math.min(R0, G0, B0);
  if (M === m) {
    // for grayscale values, lightness is proportional to the color value
    const x = clamp(Math.floor(M * factor + 0.5), 0, 255);
    return mkColor(x, x, x);
  }
  const C = M - m;
  const Ha = Math.abs(M === R0 ? G0 - B0 : M === G0 ? B0 - R0 : R0 - G0);
  let L2 = M + m;
  const S = C / (L2 > 255 ? 510 - L2 : L2);

  L2 = clamp(L2 * factor, 0, 510);
  const C1 = (L2 > 255 ? 510 - L2 : L2) * S;
  const X1 = (C1 * Ha) / C;
  const m1 = (L2 - C1) / 2;
  const R = Math.floor((M === R0 ? C1 : m !== R0 ? X1 : 0) + m1 + 0.5);
  const G = Math.floor((M === G0 ? C1 : m !== G0 ? X1 : 0) + m1 + 0.5);
  const B = Math.floor((M === B0 ? C1 : m !== B0 ? X1 : 0) + m1 + 0.5);
  return mkColor(R, G, B);
}

/** `Color.cpp` — `AdjustLightness2` (adjusts lightness in 1/255 units). */
export function adjustLightness2(color: number, units: number): number {
  const lightness = getLightness(color);
  const delta = clamp(units, -lightness, 255 - lightness);
  if (lightness === 0) {
    const x = Math.floor(delta + 0.5);
    return mkColor(x, x, x);
  }
  return adjustLightness(color, 1 + delta / lightness);
}

/** `Theme.cpp` — `AccentColor`. */
export function accentColor(color: number, light: number, dark = 0): number {
  const darkUnits = dark === 0 ? light : dark;
  if (isLightColor(color)) {
    return adjustLightness2(color, -light);
  }
  return adjustLightness2(color, darkUnits);
}

/** `#rrggbb` → `COLORREF`, i.e. the inverse of `bgrToHex`. */
export function hexToColor(hex: string): number {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  if (!Number.isFinite(value)) return 0;
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return mkColor(r, g, b);
}

/** `COLORREF` → `#rrggbb` for use in the DOM. */
export function bgrToHex(color: number): string {
  const { r, g, b } = unpackColor(color);
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------------------
// Theme accessors — `src/Theme.cpp`
// ---------------------------------------------------------------------------

export interface LightPdfThemeState {
  index: number;
  theme: LightPdfTheme;
  /**
   * `Theme.cpp` — `gGlobalPrefs->documentColorsFollowTheme`, default `"off"`.
   * When off (light-pdf's default) `ThemeDocumentColors` returns the window
   * text colour and never applies the lightness accent.
   */
  documentColorsFollowTheme: boolean;
  /**
   * `gGlobalPrefs->mainWindowBackground` (`Settings.h:1180`, default
   * `#80fff200`). `Theme.cpp:469-479` applies it to the **light theme only**,
   * and treats the compiled default as "not set" (`IsDefaultMainWinColor`,
   * `Theme.cpp:305`). `null` means "not set".
   */
  mainWindowBackground?: string | null;
  /**
   * `gGlobalPrefs->fixedPageUI.windowBgCol` (`gen-settings.ts:284`), which
   * `Canvas.cpp:1996-2001` uses as the canvas colour for PDF documents when it
   * parses as a colour. `null` means "not set", light-pdf's default.
   */
  windowBgCol?: string | null;
}

export function lightPdfThemeState(
  index: number,
  documentColorsFollowTheme = false,
  options: { mainWindowBackground?: string | null; windowBgCol?: string | null } = {}
): LightPdfThemeState {
  const clamped = index >= 0 && index < LIGHTPDF_THEMES.length ? index : LIGHTPDF_THEME_LIGHT_INDEX;
  return {
    index: clamped,
    theme: LIGHTPDF_THEMES[clamped],
    documentColorsFollowTheme,
    mainWindowBackground: options.mainWindowBackground ?? null,
    windowBgCol: options.windowBgCol ?? null
  };
}

/** `Theme.cpp` — `ThemeWindowBackgroundColor`. */
export function themeWindowBackgroundColor(state: LightPdfThemeState): number {
  return hexToColor(state.theme.backgroundColor);
}

/** `Theme.cpp` — `ThemeWindowTextColor`. */
export function themeWindowTextColor(state: LightPdfThemeState): number {
  return hexToColor(state.theme.textColor);
}

/** `Theme.cpp` — `ThemeControlBackgroundColor`. */
export function themeControlBackgroundColor(state: LightPdfThemeState): number {
  return hexToColor(state.theme.controlBackgroundColor);
}

/** `Theme.cpp` — `ThemeWindowControlBackgroundColor` (same field). */
export const themeWindowControlBackgroundColor = themeControlBackgroundColor;

/** `Theme.cpp` — `ThemeWindowLinkColor`. */
export function themeWindowLinkColor(state: LightPdfThemeState): number {
  return hexToColor(state.theme.linkColor);
}

/**
 * `Theme.cpp:469-479` — `ThemeMainWindowBackgroundColor`. For the light theme
 * (index 0) light-pdf lets `gGlobalPrefs->mainWindowBackground` override the
 * theme's own background, but only when it is not the compiled default
 * (`IsDefaultMainWinColor`, `Theme.cpp:305`); every other theme ignores it, and
 * so does this function when the preference is unset (`null`).
 */
export function themeMainWindowBackgroundColor(state: LightPdfThemeState): number {
  if (state.index === LIGHTPDF_THEME_LIGHT_INDEX && state.mainWindowBackground) {
    return hexToColor(state.mainWindowBackground);
  }
  return hexToColor(state.theme.backgroundColor);
}

/**
 * `Theme.cpp` — `ThemeWindowTextDisabledColor`: blend the text colour halfway
 * toward the background so disabled text is muted but visible.
 */
export function themeWindowTextDisabledColor(state: LightPdfThemeState): number {
  const text = unpackColor(themeWindowTextColor(state));
  const background = unpackColor(themeMainWindowBackgroundColor(state));
  return mkColor(
    Math.trunc((text.r + background.r) / 2),
    Math.trunc((text.g + background.g) / 2),
    Math.trunc((text.b + background.b) / 2)
  );
}

export interface LightPdfDocumentColors {
  /** Canvas background around the pages. */
  background: number;
  /** Text drawn on the canvas (page-placeholder / error text). */
  text: number;
}

/**
 * `Theme.cpp` — `ThemeDocumentColors`. This is the colour of the canvas the
 * pages sit on; it is *not* affected by `FixedPageUI.TextColor` /
 * `BackgroundColor`, which only affect page rendering.
 *
 * `Canvas.cpp:1996-2001` lets `FixedPageUI.WindowBgCol` override the canvas
 * colour for PDF documents when it is set, which is the one preference that
 * colours the page area directly.
 */
export function themeDocumentColors(state: LightPdfThemeState): LightPdfDocumentColors {
  let background =
    state.windowBgCol && !isDefaultWindowBgCol(state.windowBgCol)
      ? hexToColor(state.windowBgCol)
      : themeMainWindowBackgroundColor(state);
  const text = themeWindowTextColor(state);
  if (!state.documentColorsFollowTheme) {
    return { background, text };
  }
  if (state.index < 3) {
    background = accentColor(background, 8);
  }
  return { background, text };
}

/**
 * `Canvas.cpp:1997-2000` applies `WindowBgCol` whenever it parses as a colour;
 * an empty value is light-pdf's default and means "no override".
 */
export function isDefaultWindowBgCol(value: string | null): boolean {
  return value === null || value.trim() === '';
}

export interface LightPdfPageRenderColors {
  /** Substituted for black in a rendered page. */
  text: number;
  /** Substituted for white in a rendered page. */
  background: number;
}

/**
 * `Theme.cpp` — `ThemePageRenderColors` with light-pdf's default
 * `FixedPageUI.TextColor = #000000` / `BackgroundColor = #ffffff`. With
 * `DocumentColorsFollowTheme` off (light-pdf's default) pages always render
 * black-on-white, whatever the UI theme is; that is why the Eukolia viewer
 * keeps its own `pdf.invertColors` setting as the only way to recolour pages.
 */
export function themePageRenderColors(state: LightPdfThemeState): LightPdfPageRenderColors {
  const text = hexToColor('#000000');
  const background = hexToColor('#ffffff');
  if (!state.documentColorsFollowTheme) {
    return { text, background };
  }
  if (state.index === LIGHTPDF_THEME_LIGHT_INDEX) {
    return { text: background, background: text };
  }
  let bg = themeMainWindowBackgroundColor(state);
  if (state.index < 3) {
    bg = accentColor(bg, 8);
  }
  return { text: themeWindowTextColor(state), background: bg };
}

/** `Theme.cpp` — `ThemeNotificationsBackgroundColor`. */
export function themeNotificationsBackgroundColor(state: LightPdfThemeState): number {
  return adjustLightness2(themeWindowBackgroundColor(state), 10);
}

/** `Theme.cpp` — `ThemeNotificationsHighlightColor`. */
export function themeNotificationsHighlightColor(state: LightPdfThemeState): number {
  if (state.theme.colorizeControls) {
    return accentColor(themeWindowBackgroundColor(state), 20);
  }
  return hexToColor('#ffee70'); // yellowish
}

/** `Theme.cpp` — `ThemeNotificationsHighlightTextColor`. */
export function themeNotificationsHighlightTextColor(state: LightPdfThemeState): number {
  if (state.theme.colorizeControls) {
    return accentColor(themeWindowTextColor(state), 20);
  }
  return hexToColor('#8d0801'); // reddish
}

// ---------------------------------------------------------------------------
// Page presentation — `src/Settings.h` defaults + `src/Canvas.cpp`
// ---------------------------------------------------------------------------

/**
 * `Settings.h` — `gWindowMarginFields` default: Top 2, Right 4, Bottom 2,
 * Left 4. `DocumentLayout::Relayout` starts the canvas at `windowMargin.top`.
 */
export const LIGHTPDF_WINDOW_MARGIN = { top: 2, right: 4, bottom: 2, left: 4 } as const;

/**
 * `Settings.h` — `gSizeFields` default (Dx 4, Dy 4) used for
 * `FixedPageUI.PageSpacing`: the horizontal and vertical distance between two
 * pages. `DocumentLayout::Relayout` advances by `pageSpacing.dy` per row.
 */
export const LIGHTPDF_PAGE_SPACING = { dx: 4, dy: 4 } as const;

/**
 * `Canvas.cpp` — `#ifdef DRAW_PAGE_SHADOWS` is **not** compiled in
 * (`DisplayModel.h` has it commented out), so `PaintPageFrameAndShadow` takes
 * the `#else` branch: a `PS_NULL` pen and a brush filled with the placeholder
 * colour, i.e. **no border and no drop shadow**. The constants below are kept
 * so the decision is auditable rather than looking like an omission.
 */
export const LIGHTPDF_DRAW_PAGE_SHADOWS = false;
export const LIGHTPDF_PAGE_BORDER_SIZE = 1; // `Canvas.cpp` BORDER_SIZE
export const LIGHTPDF_PAGE_SHADOW_OFFSET = 4; // `Canvas.cpp` SHADOW_OFFSET

/**
 * `Canvas.cpp` — when a page has no bitmap yet, `DrawDocument` paints
 * `colPlaceholder` (which is `ThemeDocumentColors`'s background) behind it, so
 * an incoming page never flashes a different colour. The first paint of a tab
 * uses the main-window background instead (`firstDocPaint`).
 */
export function themePlaceholderColor(state: LightPdfThemeState): number {
  return themeDocumentColors(state).background;
}

// ---------------------------------------------------------------------------
// Selection, find and forward-search colours
// ---------------------------------------------------------------------------

/** `Settings.h` — `FixedPageUI.SelectionColor` default. */
export const LIGHTPDF_SELECTION_COLOR = '#ffff00';
/** `Selection.h` — `kSelectionDefaultAlpha`, used when the colour has no alpha. */
export const LIGHTPDF_SELECTION_DEFAULT_ALPHA = 0x5f;
/** `Selection.cpp` — `PaintSelection` pads the rectangles by 2px and outlines them. */
export const LIGHTPDF_SELECTION_PAD = 2;
/** `SearchAndDDE.cpp` — `kFindOtherMatchColor`. */
export const LIGHTPDF_FIND_OTHER_MATCH_COLOR = '#ff9632';
/** `Settings.h` — `ForwardSearch.HighlightColor` default. */
export const LIGHTPDF_FORWARD_SEARCH_COLOR = '#6581ff';
/**
 * `Settings.h` — `ForwardSearch.HighlightWidth` default (15) as
 * `SearchAndDDE.cpp:1478` reads it: a value that is not positive means 15.
 * `HIDE_FWDSRCHMARK_DELAY_IN_MS` / `HIDE_FWDSRCHMARK_STEPS`
 * (`SearchAndDDE.h:31,33`) are the fade-out the non-permanent highlight gets.
 */
export const LIGHTPDF_FORWARD_SEARCH_DEFAULT_WIDTH = 15;
export const LIGHTPDF_FORWARD_SEARCH_FADE_DELAY_MS = 400;
export const LIGHTPDF_FORWARD_SEARCH_FADE_STEPS = 5;
/** `SearchAndDDE.cpp` — the status counter of the find UI: `"%d / %d"`. */
export const LIGHTPDF_FIND_STATUS_SEPARATOR = ' / ';

/**
 * `Canvas.cpp:1829-1857` — `DebugShowLinks`, the whole of light-pdf's `ShowLinks`
 * support: a `PS_SOLID, 1` pen in `RGB(0x00, 0x00, 0xff)` (line 1836), drawn
 * around each visible element's rectangle after `Inflate(2, 2)` (line 1853).
 */
export const LIGHTPDF_LINK_OUTLINE_COLOR = '#0000ff';
export const LIGHTPDF_LINK_OUTLINE_WIDTH = 1;
export const LIGHTPDF_LINK_OUTLINE_INFLATE = 2;

/**
 * The page box is part of light-pdf's toolbar until `CmdTogglePageInfo` (`I`)
 * removes it (`Toolbar.cpp:102-104`, `UpdateToolbarState`), so the viewer starts
 * with it visible.
 */
export const LIGHTPDF_PAGE_INFO_DEFAULT = true;

/**
 * `PdfDarkModeColor.cpp:28-32` — `DarkChromeActive`: dark page rendering is
 * active when the effective page background is dark, which
 * `ThemePageRenderColors` decides from `DocumentColorsFollowTheme` and the
 * current theme. With the preference off (light-pdf's default) the page
 * background is white, so this is false and pages keep their own colours.
 */
export function documentColorsAreDark(state: LightPdfThemeState): boolean {
  return !isLightColor(themePageRenderColors(state).background);
}

/** `#rrggbb` + alpha → `rgba(...)` as the DOM wants it. */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = unpackColor(hexToColor(hex));
  return `rgba(${r}, ${g}, ${b}, ${(alpha / 255).toFixed(4)})`;
}

// ---------------------------------------------------------------------------
// Zoom — `src/Settings.h` + `src/DisplayModel.cpp`
// ---------------------------------------------------------------------------

/** `Settings.h` — `kZoomMin` / `kZoomMax`, in percents. */
export const LIGHTPDF_ZOOM_MIN = 8.33;
export const LIGHTPDF_ZOOM_MAX = 6400;
/** `Settings.h` — `kZoomActualSize`. */
export const LIGHTPDF_ZOOM_ACTUAL = 100;

/**
 * The whole-page render guard, in device pixels per PDF point.
 *
 * light-pdf has no equivalent: it rasterises only the tiles that are on screen,
 * so its picture is always as sharp as the display however far the reader zooms.
 * Eukolia's engine renders a whole page per request, so an unbounded scale turns
 * a high zoom of a large page into a multi-gigapixel allocation. This is that
 * allocation guard and nothing more — it is not a fidelity preference, and it is
 * deliberately far outside normal reading:
 *
 * - 16 device px/pt is 1600 % zoom on a 100 %-scale display and 800 % on a 200 %
 *   one, against light-pdf's own `kZoomMax` of 6400 %;
 * - `pdfRenderScale` (`pdf-text-layer.ts`) applies it, and
 *   `renderScaleConstrained` reports when it bites so the pane can say so rather
 *   than silently stretching a smaller bitmap across the page
 *   (`PdfPane`'s render-scale notice).
 */
export const LIGHTPDF_MAX_RENDER_SCALE = 16;

/**
 * True when the guard above asks for fewer device pixels than the sheet occupies,
 * i.e. when the page is about to be displayed from a smaller bitmap.
 *
 * The same predicate as `renderScaleConstrained` in `pdf-text-layer.ts`, with the
 * ceiling fixed instead of passed in, so the pane can warn without depending on
 * the renderer's module.
 */
export function lightPdfRenderScaleConstrained(zoomReal: number, devicePixelRatio: number): boolean {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const scale = zoomReal * dpr;
  if (!Number.isFinite(scale) || scale <= 0) return false;
  return scale > LIGHTPDF_MAX_RENDER_SCALE;
}

/**
 * `DisplayModel.cpp` — `defaultZoomLevels`. Zoom in/out steps through this
 * ladder whenever `ZoomIncrement` is zero or negative, which is light-pdf's
 * default (`Settings.h`: `ZoomIncrement` default `"0"`).
 *
 * The ladder is applied in `lightpdf-layout.ts`'s `nextZoomStep`, which
 * reproduces `GetNextZoomStep` including the fit-page / fit-width levels it
 * interpolates into the ladder, so there is one implementation of the step.
 */
export const LIGHTPDF_ZOOM_LEVELS: readonly number[] = [
  8.33, 12.5, 18 /* added */, 25, 33.33, 50, 66.67, 75, 100, 125, 150, 200, 300, 400, 600, 800, 1000 /* added */, 1200,
  1600, 2000 /* added */, 2400, 3200, 4800 /* added */, 6400
];

// ---------------------------------------------------------------------------
// Overlay scrollbar — `src/OverlayScrollbar.cpp` / `.h`
// ---------------------------------------------------------------------------

export const LIGHTPDF_SCROLLBAR = {
  /** `OverlayScrollbarCreate` — `sb->thinWidth = DpiScale(hwndOwner, 4)`. */
  thinWidth: 4,
  /** `OverlayScrollbarCreate` — `sb->thickWidth = DpiScale(hwndOwner, 16)`. */
  thickWidth: 16,
  /** `OverlayScrollbar.cpp` — `kMinThumbSize`. */
  minThumbSize: 20,
  /** `OverlayScrollbar.cpp` — `kAlphaThin`. */
  alphaThin: 180,
  /** `OverlayScrollbar.cpp` — `kAlphaThick` (default theme only). */
  alphaThick: 220,
  /** `OverlayScrollbar.cpp` — `gThickVisibilityDistance`. */
  thickVisibilityDistance: 32,
  /** `OverlayScrollbar.h` — `showAfterScrollMs`. */
  showAfterScrollMs: 5000,
  /** `OverlayScrollbar.h` — `hideAfterMouseStopMs`. */
  hideAfterMouseStopMs: 3000,
  /** `OverlayScrollbar.cpp` — `kMouseTrackIntervalMs`. */
  mouseTrackIntervalMs: 50,
  /** `OverlayScrollbar.cpp` — `gThickArrows`: filled triangles, not chevrons. */
  thickArrows: true,
  /** `OverlayScrollbar.cpp` — `WM_MOUSEMOVE` drag + `SB_LINEUP` repeat timing. */
  repeatInitialDelayMs: 250,
  repeatRateMs: 400
} as const;

/** `OverlayScrollbar.cpp` — `ThemeTrackColor`: the control background itself. */
export function themeTrackColor(state: LightPdfThemeState): number {
  return themeControlBackgroundColor(state);
}

/** `OverlayScrollbar.cpp` — `ThemeThumbColor`. */
export function themeThumbColor(state: LightPdfThemeState): number {
  return accentColor(themeControlBackgroundColor(state), 100);
}

/** `OverlayScrollbar.cpp` — `ThemeThumbHoverColor`. */
export function themeThumbHoverColor(state: LightPdfThemeState): number {
  return accentColor(themeControlBackgroundColor(state), 140);
}

/** `OverlayScrollbar.cpp` — `ThemeArrowColor`. */
export function themeArrowColor(state: LightPdfThemeState): number {
  return themeThumbHoverColor(state);
}

// ---------------------------------------------------------------------------
// Toolbar metrics — `src/Toolbar.cpp`
// ---------------------------------------------------------------------------

export const LIGHTPDF_TOOLBAR_METRICS = {
  /** `Toolbar.cpp` — `kDefaultIconSize`. */
  defaultIconSize: 18,
  /** `Toolbar.cpp` — `kButtonSpacingX` between buttons, in the toolbar metrics. */
  buttonSpacingX: 4,
  /** `Toolbar.cpp` — `kTextPaddingRight`: distance between label and edit field. */
  textPaddingRight: 6,
  /**
   * `Toolbar.cpp` — `iconDy` is `RoundUp(DpiScale(iconSize), 4)`; the toolbar
   * height is the icon box plus the 6px padding Win32's toolbar adds.
   */
  iconPadding: 6
} as const;

/**
 * `Toolbar.cpp:1402-1417` — the toolbar's height: `iconDy` is
 * `RoundUp(DpiScale(iconSize), 4)` and Win32's toolbar adds its own padding, so
 * the default `ToolbarSize` of 18 gives a 20px icon box and light-pdf's 26px bar.
 */
export function lightPdfToolbarBarHeight(iconSize: number): number {
  const iconBox = Math.ceil(Math.max(1, iconSize) / 4) * 4;
  return iconBox + LIGHTPDF_TOOLBAR_METRICS.iconPadding;
}

/**
 * `Toolbar.cpp:588-591` — `OverlayToolbarShouldShowForCursor` builds a reveal
 * band over the toolbar extended by `DpiScale(16)` toward the page, so an
 * overlay toolbar appears before the cursor reaches it.
 */
export const LIGHTPDF_TOOLBAR_REVEAL_BAND = 16;

/** `Toolbar.h:26-27` — `kDelayToolbarHide`, the overlay toolbar's hide delay. */
export const LIGHTPDF_TOOLBAR_HIDE_DELAY_MS = 500;
