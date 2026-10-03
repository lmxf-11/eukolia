/**
 * light-pdf's viewer preferences, as `pdf.*` settings.
 *
 * The conversions here are transcriptions of light-pdf's own code — the
 * `Toolbar`/`ShowToolbar` fallback (`LightPDF.cpp:1154-1161`), the `ToolbarSize`
 * clamp (`AppSettings.cpp:390-393`), the `DocumentColorsFollowTheme` spellings
 * (`PdfDarkModeColor.cpp:34-55`) and the `MainWindowBackground` "compiled
 * default means unset" rule (`Theme.cpp:305`) — so the tests assert the exact
 * values those functions produce, including the legacy spellings they migrate.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  LIGHTPDF_DEFAULT_MAIN_WINDOW_BACKGROUND,
  LIGHTPDF_DEFAULT_TOOLBAR_SIZE,
  isDefaultMainWindowBackground,
  lightPdfDocumentColorsFollowThemeFromPrefs,
  lightPdfOptionalColor,
  lightPdfToolbarIconSize,
  lightPdfToolbarModeFromPrefs,
  lightPdfToolbarPositionFromPrefs,
  readLightPdfViewerSettings,
  toggledToolbarMode
} from '@/pdf/lightpdf-settings';
import { settingsManager, getSettingDescriptor } from '@/core/settings';
import { lightPdfScaleFromZoomPercent } from '@/pdf/lightpdf-layout';
import {
  LIGHTPDF_MAX_RENDER_SCALE,
  LIGHTPDF_ZOOM_MAX,
  lightPdfRenderScaleConstrained
} from '@/pdf/lightpdf-theme';

const written: string[] = [];

const set = (key: string, value: unknown): void => {
  settingsManager.setValue(key, value, 'user');
  written.push(key);
};

afterEach(() => {
  for (const key of written.splice(0)) settingsManager.reset(key, 'user');
});

describe('toolbar mode — light-pdf `Toolbar` + `ShowToolbar`', () => {
  it('accepts the three names light-pdf knows, case-insensitively', () => {
    expect(lightPdfToolbarModeFromPrefs('show', false)).toBe('show');
    expect(lightPdfToolbarModeFromPrefs('hide', true)).toBe('hide');
    expect(lightPdfToolbarModeFromPrefs('overlay', false)).toBe('overlay');
    // `SeqStrIndexIS` is case-insensitive in light-pdf.
    expect(lightPdfToolbarModeFromPrefs('Overlay', true)).toBe('overlay');
  });

  it('falls back to the legacy `ShowToolbar` boolean, as `ToolbarModeFromPrefs` does', () => {
    expect(lightPdfToolbarModeFromPrefs('', false)).toBe('hide');
    expect(lightPdfToolbarModeFromPrefs(null, true)).toBe('show');
    // An unknown name is treated exactly like an unset one.
    expect(lightPdfToolbarModeFromPrefs('nonsense', false)).toBe('hide');
    // `ShowToolbar`'s own default is true, so an unset pair means "show".
    expect(lightPdfToolbarModeFromPrefs(undefined, undefined)).toBe('show');
  });

  it('flips only between show and hide, as `CmdToggleToolbar` does', () => {
    expect(toggledToolbarMode('show')).toBe('hide');
    expect(toggledToolbarMode('hide')).toBe('show');
    expect(toggledToolbarMode('overlay')).toBe('hide');
  });
});

describe('toolbar position — `ToolbarPositionFromPrefs`', () => {
  it('is `top` unless the value is exactly `bottom`', () => {
    expect(lightPdfToolbarPositionFromPrefs('bottom')).toBe('bottom');
    expect(lightPdfToolbarPositionFromPrefs('BOTTOM')).toBe('bottom');
    expect(lightPdfToolbarPositionFromPrefs('top')).toBe('top');
    expect(lightPdfToolbarPositionFromPrefs('')).toBe('top');
    expect(lightPdfToolbarPositionFromPrefs(null)).toBe('top');
  });
});

describe('toolbar size — `ToolbarSize` is the icon size', () => {
  it('defaults to 18 when unset, as `AppSettings.cpp:390-393` does', () => {
    expect(lightPdfToolbarIconSize(0)).toBe(LIGHTPDF_DEFAULT_TOOLBAR_SIZE);
    expect(lightPdfToolbarIconSize(undefined)).toBe(18);
    expect(lightPdfToolbarIconSize(Number.NaN)).toBe(18);
  });

  it('clamps to light-pdf\'s 8…64 range and rounds', () => {
    expect(lightPdfToolbarIconSize(4)).toBe(8);
    expect(lightPdfToolbarIconSize(200)).toBe(64);
    expect(lightPdfToolbarIconSize(24.6)).toBe(25);
    expect(lightPdfToolbarIconSize(24)).toBe(24);
  });
});

describe('document colours — `DocumentColorsFollowTheme`', () => {
  it('reads its three names and migrates the pre-3.7 spellings', () => {
    expect(lightPdfDocumentColorsFollowThemeFromPrefs('off')).toBe('off');
    expect(lightPdfDocumentColorsFollowThemeFromPrefs('smart')).toBe('smart');
    expect(lightPdfDocumentColorsFollowThemeFromPrefs('legacy')).toBe('legacy');
    // `PdfDarkModeColor.cpp:44-53` migrates `DocumentColorMode`'s values.
    expect(lightPdfDocumentColorsFollowThemeFromPrefs('auto')).toBe('smart');
    expect(lightPdfDocumentColorsFollowThemeFromPrefs('black')).toBe('legacy');
    expect(lightPdfDocumentColorsFollowThemeFromPrefs('none')).toBe('off');
    expect(lightPdfDocumentColorsFollowThemeFromPrefs('light')).toBe('off');
    // Anything unrecognised is off, the setting's own default.
    expect(lightPdfDocumentColorsFollowThemeFromPrefs('')).toBe('off');
    expect(lightPdfDocumentColorsFollowThemeFromPrefs(null)).toBe('off');
  });
});

describe('colours and the compiled default', () => {
  it('accepts light-pdf colour syntax and rejects anything else', () => {
    expect(lightPdfOptionalColor('#202020')).toBe('#202020');
    expect(lightPdfOptionalColor('#80fff200')).toBe('#80fff200');
    expect(lightPdfOptionalColor('')).toBeNull();
    expect(lightPdfOptionalColor('red')).toBeNull();
    expect(lightPdfOptionalColor(undefined)).toBeNull();
  });

  it('treats `MainWindowBackground`\'s compiled default as "not set"', () => {
    expect(isDefaultMainWindowBackground(LIGHTPDF_DEFAULT_MAIN_WINDOW_BACKGROUND)).toBe(true);
    expect(isDefaultMainWindowBackground(LIGHTPDF_DEFAULT_MAIN_WINDOW_BACKGROUND.toUpperCase())).toBe(true);
    expect(isDefaultMainWindowBackground(null)).toBe(true);
    expect(isDefaultMainWindowBackground('#f2f2f2')).toBe(false);
  });
});

describe('readLightPdfViewerSettings', () => {
  it('reads every honoured preference with its default', () => {
    const settings = readLightPdfViewerSettings();
    expect(settings).toEqual({
      toolbarMode: 'show',
      toolbarPosition: 'top',
      toolbarSize: 18,
      showToc: true,
      showLinks: false,
      documentColorsFollowTheme: 'off',
      windowBackgroundColor: null,
      mainWindowBackground: null,
      // Two deliberate departures from light-pdf's own defaults: the overlay
      // scrollbar, and a wheel sensitivity of 3 rather than 2 (the guard in
      // `lightPdfScrollSensitivity` keeps light-pdf's 2 for nonsense input).
      scrollbarMode: 'smart',
      scrollbarInSinglePage: false,
      scrollSensitivity: 3,
      smoothScroll: true,
      smoothScrollFriction: 0.2,
      fastScrollOverScrollbar: false,
      zoomLevels: [],
      zoomIncrement: 0,
      windowMargin: { top: 2, right: 4, bottom: 2, left: 4 },
      pageSpacing: { dx: 4, dy: 4 },
      selectionToolbar: true,
      forwardSearch: { color: '#6581ff', width: 15, offset: 0, permanent: false }
    });
  });

  it('follows the settings store', () => {
    set('pdf.toolbar', 'overlay');
    set('pdf.toolbarPosition', 'bottom');
    set('pdf.toolbarSize', 40);
    set('pdf.showToc', false);
    set('pdf.showLinks', true);
    set('pdf.documentColorsFollowTheme', 'legacy');
    set('pdf.windowBackgroundColor', '#101010');
    set('pdf.mainWindowBackground', '#f2f2f2');
    set('pdf.scrollbar', 'smart');
    set('pdf.scrollbarInSinglePage', true);
    set('pdf.scrollSensitivity', 1.5);
    set('pdf.smoothScroll', false);
    set('pdf.smoothScrollFriction', 0.5);
    set('pdf.fastScrollOverScrollbar', true);
    set('pdf.zoomLevels', [50, 200, 100]);
    set('pdf.zoomIncrement', 25);
    set('pdf.windowMargin', '8 8 8 8');
    set('pdf.pageSpacing', '12 6');
    set('pdf.selectionToolbar', false);
    set('pdf.forwardSearchHighlightColor', '#ff0000');
    set('pdf.forwardSearchHighlightWidth', 30);
    set('pdf.forwardSearchHighlightOffset', 12);
    set('pdf.forwardSearchHighlightPermanent', true);

    expect(readLightPdfViewerSettings()).toEqual({
      toolbarMode: 'overlay',
      toolbarPosition: 'bottom',
      toolbarSize: 40,
      showToc: false,
      showLinks: true,
      documentColorsFollowTheme: 'legacy',
      windowBackgroundColor: '#101010',
      mainWindowBackground: '#f2f2f2',
      scrollbarMode: 'smart',
      scrollbarInSinglePage: true,
      scrollSensitivity: 1.5,
      smoothScroll: false,
      smoothScrollFriction: 0.5,
      fastScrollOverScrollbar: true,
      // `AppSettings.cpp:349-355` sorts the custom ladder.
      zoomLevels: [50, 100, 200],
      zoomIncrement: 25,
      windowMargin: { top: 8, right: 8, bottom: 8, left: 8 },
      pageSpacing: { dx: 12, dy: 6 },
      selectionToolbar: false,
      forwardSearch: { color: '#ff0000', width: 30, offset: 12, permanent: true }
    });
  });

  it('reports the light theme default as "not set" rather than as a colour', () => {
    // The schema's default is light-pdf's own default, which
    // `Theme.cpp:305` treats as "do not override the theme".
    expect(readLightPdfViewerSettings().mainWindowBackground).toBeNull();
    set('pdf.mainWindowBackground', LIGHTPDF_DEFAULT_MAIN_WINDOW_BACKGROUND);
    expect(readLightPdfViewerSettings().mainWindowBackground).toBeNull();
  });
});

describe('the render scale is not a setting any more', () => {
  it('offers no device-pixel ceiling in the schema', () => {
    // It was a fidelity limit, not a preference: at its default of 4 the engine
    // was asked for fewer device pixels than the page occupied from 400 % zoom
    // (320 % on a 125 %-scale display), and the canvas stretched the bitmap.
    // Memory is bounded by the page cache instead, which is still a setting.
    expect(getSettingDescriptor('pdf.devicePixelRatioCap')).toBeUndefined();
    expect(getSettingDescriptor('pdf.maxCachedPages')?.default).toBe(24);
  });

  it('keeps the whole-page guard clear of normal reading zooms', () => {
    // 100 %, 200 % and 400 % on 100 %- and 200 %-scale displays: never limited.
    for (const percent of [100, 200, 400]) {
      for (const dpr of [1, 1.25, 1.5, 2]) {
        const zoomReal = lightPdfScaleFromZoomPercent(percent);
        expect(
          lightPdfRenderScaleConstrained(zoomReal, dpr),
          `${percent}% at dpr ${dpr} must not be limited`
        ).toBe(false);
      }
    }
  });

  it('reports being limited at light-pdf\'s own maximum zoom', () => {
    // The guard is an allocation bound for whole-page rendering; beyond it the
    // pane says so rather than silently showing a smaller bitmap.
    const zoomReal = lightPdfScaleFromZoomPercent(LIGHTPDF_ZOOM_MAX);
    expect(lightPdfRenderScaleConstrained(zoomReal, 1)).toBe(true);
    // A scale that is exactly the guard is not constrained: the bitmap still
    // matches the sheet.
    expect(lightPdfRenderScaleConstrained(LIGHTPDF_MAX_RENDER_SCALE, 1)).toBe(false);
    expect(lightPdfRenderScaleConstrained(LIGHTPDF_MAX_RENDER_SCALE + 0.01, 1)).toBe(true);
  });

  it('treats a missing or nonsensical device pixel ratio as 1', () => {
    expect(lightPdfRenderScaleConstrained(1, 0)).toBe(false);
    expect(lightPdfRenderScaleConstrained(1, Number.NaN)).toBe(false);
    expect(lightPdfRenderScaleConstrained(0, 2)).toBe(false);
    expect(lightPdfRenderScaleConstrained(Number.NaN, 2)).toBe(false);
  });
});
