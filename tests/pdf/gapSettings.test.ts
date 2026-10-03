/**
 * light-pdf's scrolling, zoom-ladder, page-margin and find settings — the
 * twelve the gap audit's §8 deferred because they needed the viewer itself.
 *
 * Everything asserted here is a transcription of light-pdf's own code, so the
 * expected values are the reference's, not Eukolia's invention:
 *
 * - `Canvas.cpp:2530-2800` (`OnMouseWheel`) and `:2259-2313` (the smooth-scroll
 *   integrator) for the wheel policy;
 * - `LightPDF.cpp:1126-1150` (`ScrollbarModeFromPrefs`, `ScrollbarsUseOverlay`,
 *   `ScrollbarsOverlayMode`, `ScrollbarsAreHidden`) for the scrollbar modes;
 * - `DisplayModel.cpp:1719-1758` (`MaybeGetNextZoomByIncrement`,
 *   `GetDefaultZoomLevels`) for `ZoomIncrement`/`ZoomLevels`;
 * - `SearchAndDDE.cpp:1458-1488` and `LightPDF.cpp:3173-3210`
 *   (`FormatCursorPositionTemp`) for the forward-search mark and the
 *   cursor-position tip.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { getSettingDescriptor, settingsManager } from '@/core/settings';
import {
  LIGHTPDF_SCROLLBAR_MODES,
  lightPdfFastScrollDistance,
  lightPdfForwardSearchWidth,
  lightPdfPageSpacingFromPrefs,
  lightPdfPointerOverScrollbar,
  lightPdfScrollSensitivity,
  lightPdfScrollbarModeFromPrefs,
  lightPdfScrollbarsHidden,
  lightPdfScrollbarsUseOverlay,
  lightPdfOverlayScrollbarMode,
  lightPdfSmoothScrollDecayRate,
  lightPdfSmoothScrollFriction,
  lightPdfSmoothScrollImpulse,
  lightPdfSmoothScrollStopped,
  lightPdfWindowMarginFromPrefs,
  lightPdfZoomIncrementFromPrefs,
  lightPdfZoomLevelsFromPrefs
} from '@/pdf/lightpdf-settings';
import {
  LightPdfSmoothScroll,
  LIGHTPDF_DELTA_PER_LINE,
  LIGHTPDF_SCROLL_LINE_HEIGHT,
  LIGHTPDF_WHEEL_DELTA,
  lightPdfLineScrollDistance,
  lightPdfWheelDelta,
  planLightPdfLineScroll,
  planLightPdfWheel,
  type LightPdfWheelContext,
  type LightPdfScrollMetrics
} from '@/pdf/lightpdf-scroll';
import { LIGHTPDF_DPI_FACTOR, nextZoomStep } from '@/pdf/lightpdf-layout';
import { formatCursorPosition } from '@/pdf/PdfViewer';
import { LIGHTPDF_ZOOM_MAX, LIGHTPDF_ZOOM_MIN, LIGHTPDF_ZOOM_LEVELS } from '@/pdf/lightpdf-theme';

/**
 * One notch is three lines of `gDeltaPerLine` (40) pixels — 120 px, which is what
 * `lightPdfWheelDelta` reports for a Windows wheel event and what the three lines
 * of `DpiScale(16)` in the reference's distance formula come to.
 */
const NOTCH = LIGHTPDF_WHEEL_DELTA;
/** A notch's distance in pixels at a sensitivity of 1: `(120 / 40) * 16`. */
const NOTCH_PIXELS = 48;
/** The same notch after `ScrollSensitivity` of 2, which is what the plan takes. */
const SCALED_NOTCH = NOTCH * 2;

const written: string[] = [];

const set = (key: string, value: unknown): void => {
  settingsManager.setValue(key, value, 'user');
  written.push(key);
};

afterEach(() => {
  for (const key of written.splice(0)) settingsManager.reset(key, 'user');
});

// ---------------------------------------------------------------------------
// 1. ScrollSensitivity
// ---------------------------------------------------------------------------

describe('ScrollSensitivity (`Canvas.cpp:2586-2588`, `:2738`)', () => {
  it('defaults to 3 and keeps a non-positive value from freezing the wheel', () => {
    // The descriptor carries this application's default, which departs from
    // light-pdf's 2.0 — the same split `pdf.scrollbar` makes below. The guard is
    // light-pdf's own value, kept for input that is missing, non-numeric or
    // non-positive; it deliberately stays at 2.
    expect(getSettingDescriptor('pdf.scrollSensitivity')?.default).toBe(3);
    expect(lightPdfScrollSensitivity(0)).toBe(2);
    expect(lightPdfScrollSensitivity(-1)).toBe(2);
    expect(lightPdfScrollSensitivity(Number.NaN)).toBe(2);
    expect(lightPdfScrollSensitivity(1.5)).toBe(1.5);
  });

  it('scales one wheel notch, as `Canvas.cpp:2586-2588` does', () => {
    // `deltaMode` 0 is pixels, so the notch passes through untouched.
    const notch = lightPdfWheelDelta({ deltaMode: 0, deltaY: NOTCH }, 800);
    expect(notch).toBe(NOTCH);
    // Three lines of 16 px: the 48 px a notch is worth at a sensitivity of 1.
    expect(lightPdfLineScrollDistance(notch, 16)).toBe(NOTCH_PIXELS);
    // The *delta* is multiplied, so the distance is too — 48 px per unit. A
    // sensitivity of 2 gives light-pdf's 96 px; the descriptor's default of 3,
    // which is this viewer's, gives 144 px. (This is the *line-scroll* distance.
    // The momentum path scales the impulse by the sensitivity a second time, so a
    // notch that glides travels `24 * S²` — see `viewerBehaviour.test.ts`.)
    expect(lightPdfLineScrollDistance(lightPdfWheelDelta({ deltaMode: 0, deltaY: NOTCH }, 800, 2), 16)).toBe(96);
    expect(lightPdfLineScrollDistance(lightPdfWheelDelta({ deltaMode: 0, deltaY: NOTCH }, 800, 3), 16)).toBe(144);
    expect(lightPdfLineScrollDistance(lightPdfWheelDelta({ deltaMode: 0, deltaY: NOTCH }, 800, 4), 16)).toBe(192);
    expect(lightPdfWheelDelta({ deltaMode: 0, deltaY: NOTCH }, 800, 2)).toBe(SCALED_NOTCH);
  });

  it('converts the other two browser delta modes to the same notch', () => {
    // `deltaMode` 1 is lines: three of them are a notch, and a line is
    // `gDeltaPerLine` pixels.
    const lines = lightPdfWheelDelta({ deltaMode: 1, deltaY: 3 }, 800);
    expect(lines).toBe(NOTCH);
    expect(lightPdfWheelDelta({ deltaMode: 1, deltaY: 1 }, 800)).toBe(LIGHTPDF_DELTA_PER_LINE);
    expect(lightPdfLineScrollDistance(lines, 16)).toBe(NOTCH_PIXELS);
    // `deltaMode` 2 is pages: a notch is 120 px of an 800 px viewport.
    const pages = lightPdfWheelDelta({ deltaMode: 2, deltaY: NOTCH / 800 }, 800);
    expect(pages).toBe(NOTCH);
    expect(lightPdfLineScrollDistance(pages, 16)).toBe(NOTCH_PIXELS);
    // A trackpad's sub-notch delta keeps its proportion.
    const trackpad = lightPdfWheelDelta({ deltaMode: 0, deltaY: NOTCH / 2 }, 800);
    expect(lightPdfLineScrollDistance(trackpad, 16)).toBe(NOTCH_PIXELS / 2);
  });

  it('scales the smooth-scroll impulse as well, as `:2738` does', () => {
    // `targetDistance * rate(default 0.1 * 50) * sensitivity`.
    expect(lightPdfSmoothScrollImpulse(NOTCH_PIXELS, 1)).toBe(NOTCH_PIXELS * 5);
    expect(lightPdfSmoothScrollImpulse(NOTCH_PIXELS, 2)).toBe(NOTCH_PIXELS * 5 * 2);
  });
});

// ---------------------------------------------------------------------------
// 2. Scrollbars
// ---------------------------------------------------------------------------

describe('Scrollbars (`LightPDF.cpp:1126-1150`)', () => {
  it('reads light-pdf\'s four names, case-insensitively, and defaults to the overlay', () => {
    expect(LIGHTPDF_SCROLLBAR_MODES).toEqual(['windows', 'smart', 'overlay', 'hidden']);
    // light-pdf ships `windows`; the default here is one deliberate departure, and
    // it is the answer to a visible defect — the platform bar is drawn inside the
    // pane and reserves its width, so a page at `fit width` (the tooltip's own
    // recommended reading mode) is laid out for a client box one scrollbar
    // narrower and a strip of background sits beside it at the window's right
    // edge. light-pdf's own overlay bar reserves nothing
    // (`LightPDF.cpp:1140-1150`), and `windows` remains one setting away.
    expect(getSettingDescriptor('pdf.scrollbar')?.default).toBe('smart');
    expect(lightPdfScrollbarModeFromPrefs('smart')).toBe('smart');
    expect(lightPdfScrollbarModeFromPrefs('Smart')).toBe('smart');
    expect(lightPdfScrollbarModeFromPrefs('OVERLAY')).toBe('overlay');
    expect(lightPdfScrollbarModeFromPrefs('hidden')).toBe('hidden');
    // An unset or misspelled value is still light-pdf's `windows`
    // (`ScrollbarModeFromPrefs`), not this application's default: the departure is
    // in the descriptor, so a user who has chosen a mode keeps it.
    expect(lightPdfScrollbarModeFromPrefs('nonsense')).toBe('windows');
    expect(lightPdfScrollbarModeFromPrefs(undefined)).toBe('windows');
  });

  it('maps the modes the way the reference\'s three helpers do', () => {
    // `ScrollbarsAreHidden`
    expect(lightPdfScrollbarsHidden('hidden')).toBe(true);
    for (const mode of ['windows', 'smart', 'overlay'] as const) expect(lightPdfScrollbarsHidden(mode)).toBe(false);
    // `ScrollbarsUseOverlay`
    expect(lightPdfScrollbarsUseOverlay('smart')).toBe(true);
    expect(lightPdfScrollbarsUseOverlay('overlay')).toBe(true);
    expect(lightPdfScrollbarsUseOverlay('windows')).toBe(false);
    expect(lightPdfScrollbarsUseOverlay('hidden')).toBe(false);
    // `ScrollbarsOverlayMode`: only `overlay` pins the bar open.
    expect(lightPdfOverlayScrollbarMode('overlay')).toBe('Thick');
    expect(lightPdfOverlayScrollbarMode('smart')).toBe('Smart');
  });
});

// ---------------------------------------------------------------------------
// 3. ScrollbarInSinglePage
// ---------------------------------------------------------------------------

describe('ScrollbarInSinglePage (`Canvas.cpp:639-693`, `:3199-3202`)', () => {
  it('defaults off and turns the wheel into a page turn in single-page view', () => {
    expect(getSettingDescriptor('pdf.scrollbarInSinglePage')?.default).toBe(false);

    const context = wheelContext({
      delta: SCALED_NOTCH,
      continuous: false,
      pageSlider: true,
      metrics: metrics({ needVScroll: false })
    });
    expect(planLightPdfWheel(context, 0).action).toEqual({ kind: 'page', direction: 1 });
    // …and the other way for the opposite notch.
    expect(planLightPdfWheel({ ...context, delta: -SCALED_NOTCH }, 0).action).toEqual({
      kind: 'page',
      direction: -1
    });
  });

  it('scrolls a page fraction per notch while the page does not fit (`:2671-2690`)', () => {
    // `scrollBy = -MulDiv(si.nPage, delta * 30, WHEEL_DELTA)`, with `delta` the
    // sensitivity-scaled notch.
    const context = wheelContext({
      delta: SCALED_NOTCH,
      continuous: false,
      pageSlider: true,
      metrics: metrics({ needVScroll: true, page: 800 })
    });
    expect(planLightPdfWheel(context, 0).action).toEqual({ kind: 'scroll', dx: 0, dy: 800 * 60 });
  });
});

// ---------------------------------------------------------------------------
// 4. SmoothScrollFriction
// ---------------------------------------------------------------------------

describe('SmoothScrollFriction (`Canvas.cpp:2283-2287`)', () => {
  it('defaults to light-pdf\'s 0.2 and derives the decay rate `friction * 50`', () => {
    expect(getSettingDescriptor('pdf.smoothScrollFriction')?.default).toBe(0.2);
    expect(lightPdfSmoothScrollDecayRate(0.2)).toBe(10);
    expect(lightPdfSmoothScrollDecayRate(1)).toBe(50);
    // `:2286` — the rate never falls below 1, so a friction of 0 still decays.
    expect(lightPdfSmoothScrollDecayRate(0)).toBe(1);
    // Anything outside 0…1 is the default, not a nonsense rate.
    expect(lightPdfSmoothScrollFriction(2)).toBe(0.2);
    expect(lightPdfSmoothScrollFriction(-1)).toBe(0.2);
    expect(lightPdfSmoothScrollFriction(Number.NaN)).toBe(0.2);
    expect(lightPdfSmoothScrollFriction(0.75)).toBe(0.75);
  });

  it('stops below 5 px/s (`:2274-2276`)', () => {
    expect(lightPdfSmoothScrollStopped(4.9)).toBe(true);
    expect(lightPdfSmoothScrollStopped(-4.9)).toBe(true);
    expect(lightPdfSmoothScrollStopped(5)).toBe(false);
  });

  it('integrates an impulse into exactly the distance a plain notch would scroll', () => {
    // One notch at a sensitivity of 2: 96 px. The impulse is `distance * rate` for
    // the *same* rate the
    // velocity decays at, which an exponential decay integrates back to the
    // distance itself — this is what the viewer pairs
    // (`lightPdfSmoothScrollDecayRate(smoothScrollFriction)` and
    // `lightPdfSmoothScrollImpulse(distance, sensitivity)`).
    const distance = 96;
    const rate = lightPdfSmoothScrollDecayRate(0.2);
    const impulse = distance * rate;
    const smooth = new LightPdfSmoothScroll(rate);
    // `Canvas.cpp:2741` — the velocity is *reduced* by the impulse, and the
    // viewer passes the downward impulse negated.
    smooth.addImpulse(-impulse);
    expect(smooth.active).toBe(true);

    let offset = 0;
    // 120 frames at 60 fps is two seconds — far longer than the momentum lasts.
    for (let frame = 0; frame < 120 && smooth.active; frame += 1) {
      smooth.tick(offset, 1 / 60, (delta) => {
        offset += delta;
        return offset;
      });
    }
    // The integrator rounds per frame, so the momentum lands within a few pixels
    // of the ideal rather than on it.
    expect(Math.abs(offset - distance)).toBeLessThan(distance / 4);
    expect(smooth.active).toBe(false);
    expect(smooth.currentVelocity).toBe(0);
  });

  it('stops at a boundary instead of pushing past it (`:2297-2304`)', () => {
    const smooth = new LightPdfSmoothScroll(lightPdfSmoothScrollDecayRate(0.2));
    smooth.addImpulse(-lightPdfSmoothScrollImpulse(96, 1));
    const offset = 0;
    // A scroller that refuses to move *because it is at the end of the document*:
    // the reference zeroes the velocity there (`:2297-2300`). The boundary has to
    // be named, because a browser rounds `scrollTop` — writing 1 at the top reads
    // back as a pixel of movement, so "it did not move" is not the same question
    // there as it is on Win32.
    smooth.tick(offset, 1 / 60, () => offset, { max: 0 });
    expect(smooth.active).toBe(false);
  });

  it('does not mistake a rounded scroll for the end of the document', () => {
    // The regression, in the form the browser presents it: `scrollTop` lands on a
    // grid (`1 / devicePixelRatio`), so a frame that asked for 0.4 px reads back as
    // 0 px of movement. Read as "nothing moved, so we are at the boundary", that
    // zeroed the momentum a fifth of the way into every notch — one notch
    // delivered 68 px of its 96.
    const rate = lightPdfSmoothScrollDecayRate(0.2);
    const smooth = new LightPdfSmoothScroll(rate);
    smooth.addImpulse(-lightPdfSmoothScrollImpulse(96, 2));
    let offset = 0;
    const MAX = 10_000;
    /** A scroller on a 0.8 px grid, which is `devicePixelRatio` 1.25. */
    const scrollBy = (delta: number): number => {
      offset = Math.max(0, Math.min(MAX, Math.round((offset + delta) * 1.25) / 1.25));
      return offset;
    };
    for (let frame = 0; frame < 400 && smooth.active; frame += 1) {
      smooth.tick(offset, 1 / 144, scrollBy, { max: MAX });
    }
    // The whole notch arrives, less the integrator's stop tail — not three
    // quarters of it.
    expect(offset).toBeGreaterThan(90);
    expect(offset).toBeLessThanOrEqual(96);
  });

  it('banks a burst of notches into one gesture', () => {
    // `Canvas.cpp:2741` is `velocity -= impulse`, so a notch that arrives while
    // the view is still gliding *adds* to that glide. Six notches therefore land
    // six notches — the regression this pins is a caller that re-anchored the
    // exact offset on every event, which left a burst looking like one notch.
    //
    // (The re-seeding rule is still the reference's — `:2745-2749` seeds only
    // when `wasStopped` — but this test does not hinge on it: the distance a notch
    // travels lives in the velocity, which is additive either way. What it pins is
    // that nothing between the events takes the gesture away.)
    const impulse = lightPdfSmoothScrollImpulse(96, 2);
    const rate = lightPdfSmoothScrollDecayRate(0.2);
    /**
     * One gesture: six notches with frames between them, run through a scroller
     * that lands on a grid (`1 / devicePixelRatio`, so 0.8 px at 1.25).
     */
    const gesture = (seedPerEvent: boolean): number => {
      const smooth = new LightPdfSmoothScroll(rate);
      let offset = 0;
      const scrollBy = (delta: number): number => {
        offset = Math.max(0, Math.round((offset + delta) * 1.25) / 1.25);
        return offset;
      };
      for (let notch = 0; notch < 6; notch += 1) {
        if (seedPerEvent || !smooth.active) smooth.reseed(offset);
        smooth.addImpulse(-impulse);
        // Frames pass between the notches, as they do for a real wheel: without
        // them every event would seed the same offset and the gesture would be
        // indistinguishable from one event.
        for (let frame = 0; frame < 3; frame += 1) smooth.tick(offset, 1 / 144, scrollBy, { max: 100_000 });
      }
      for (let frame = 0; frame < 600 && smooth.active; frame += 1) smooth.tick(offset, 1 / 144, scrollBy, { max: 100_000 });
      return offset;
    };

    const banked = gesture(false);
    // Six notches of 96 px, less the integrator's stop tail.
    expect(banked).toBeGreaterThan(6 * 96 - 12);
    expect(banked).toBeLessThanOrEqual(6 * 96);
    // And seeding once is never worse than seeding per event: the residual a
    // running glide carries survives.
    expect(banked).toBeGreaterThanOrEqual(gesture(true));
  });

  it('clamps a stalled frame instead of teleporting (`:2270-2272`)', () => {
    const smooth = new LightPdfSmoothScroll(10);
    smooth.addImpulse(-960);
    let offset = 0;
    smooth.tick(offset, 5, (delta) => {
      offset += delta;
      return offset;
    });
    // `dt > 0.1` becomes 0.016, so one huge frame moves at most a frame's worth.
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(16);
  });
});

// ---------------------------------------------------------------------------
// 5. FastScrollOverScrollbar
// ---------------------------------------------------------------------------

describe('FastScrollOverScrollbar (`Canvas.cpp:2718-2728`)', () => {
  it('defaults off and is half a page per notch when on', () => {
    expect(getSettingDescriptor('pdf.fastScrollOverScrollbar')?.default).toBe(false);
    const context = wheelContext({
      delta: SCALED_NOTCH,
      continuous: true,
      fastScrollOverScrollbar: true,
      metrics: metrics({ page: 800 })
    });
    // `SB_HALF_PAGEDOWN` advances by `si.nPage / 2`.
    expect(planLightPdfWheel(context, 0).action).toEqual({ kind: 'scroll', dx: 0, dy: 400 });
    expect(planLightPdfWheel({ ...context, delta: -SCALED_NOTCH }, 0).action).toEqual({
      kind: 'scroll',
      dx: 0,
      dy: -400
    });
    expect(lightPdfFastScrollDistance(1, 800)).toBe(400);
  });

  it('only fires when the pointer is past the scroller\'s client box (`pt.x > canvasRc.dx`)', () => {
    // A scroller with vertical overflow has a bar; one whose content fits does
    // not, and then `pt.x > canvasRc.dx` cannot be true.
    const overflowing = { clientWidth: 600, clientHeight: 800, scrollHeight: 1540 };
    const fitting = { clientWidth: 600, clientHeight: 800, scrollHeight: 800 };
    expect(lightPdfPointerOverScrollbar(605, { left: 0 }, overflowing)).toBe(true);
    expect(lightPdfPointerOverScrollbar(590, { left: 0 }, overflowing)).toBe(false);
    expect(lightPdfPointerOverScrollbar(605, { left: 0 }, fitting)).toBe(false);
    // The client box's own left edge is subtracted, as `HwndGetCursorPos` is:
    // 625 - 20 is past the 600 px client width, 620 - 20 is not.
    expect(lightPdfPointerOverScrollbar(625, { left: 20 }, overflowing)).toBe(true);
    expect(lightPdfPointerOverScrollbar(620, { left: 20 }, overflowing)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. ZoomLevels / ZoomIncrement
// ---------------------------------------------------------------------------

describe('ZoomLevels / ZoomIncrement (`DisplayModel.cpp:1719-1758`)', () => {
  it('keeps light-pdf\'s defaults: an empty ladder and an increment of 0', () => {
    expect(getSettingDescriptor('pdf.zoomLevels')?.default).toEqual([]);
    expect(getSettingDescriptor('pdf.zoomIncrement')?.default).toBe(0);
    expect(lightPdfZoomLevelsFromPrefs([])).toEqual([]);
    expect(lightPdfZoomLevelsFromPrefs(undefined)).toEqual([]);
    expect(lightPdfZoomIncrementFromPrefs(0)).toBe(0);
    expect(lightPdfZoomIncrementFromPrefs(-5)).toBe(0);
  });

  it('sorts the ladder and drops anything outside `[kZoomMin, kZoomMax]` (`AppSettings.cpp:349-355`)', () => {
    expect(lightPdfZoomLevelsFromPrefs([200, 50, 100])).toEqual([50, 100, 200]);
    expect(lightPdfZoomLevelsFromPrefs([1, 100, 9000])).toEqual([100]);
    expect(lightPdfZoomLevelsFromPrefs([LIGHTPDF_ZOOM_MIN, LIGHTPDF_ZOOM_MAX])).toEqual([
      LIGHTPDF_ZOOM_MIN,
      LIGHTPDF_ZOOM_MAX
    ]);
    // Strings survive a JSON round-trip of the array setting.
    expect(lightPdfZoomLevelsFromPrefs(['50', '100'])).toEqual([50, 100]);
  });

  it('steps through the custom ladder instead of the built-in one', () => {
    const params = zoomParams();
    // light-pdf's zoom is a percentage; Eukolia's scale is `percent/100 * 96/72`.
    const eighty = (80 / 100) * LIGHTPDF_DPI_FACTOR;
    // At 80 % the built-in ladder's next level is 100.
    expect(nextZoomStep(params, { direction: 1, currentZoomReal: eighty, zoomLevels: [] })).toEqual({
      kind: 'percent',
      percent: 100
    });
    // A custom ladder replaces it outright.
    expect(nextZoomStep(params, { direction: 1, currentZoomReal: eighty, zoomLevels: [150, 300] })).toEqual({
      kind: 'percent',
      percent: 150
    });
    expect(nextZoomStep(params, { direction: -1, currentZoomReal: eighty, zoomLevels: [50, 75] })).toEqual({
      kind: 'percent',
      percent: 75
    });
    // The ladder falls back to `defaultZoomLevels` when every entry is filtered out.
    expect(nextZoomStep(params, { direction: 1, currentZoomReal: eighty, zoomLevels: [0.5] })).toEqual({
      kind: 'percent',
      percent: 100
    });
  });

  it('uses a positive ZoomIncrement as a percentage step, clamped to the target (`:1719-1734`)', () => {
    const params = zoomParams();
    const eighty = (80 / 100) * LIGHTPDF_DPI_FACTOR;
    // `factor = increment / 100 + 1`, relative to the *current* zoom.
    expect(nextZoomStep(params, { direction: 1, currentZoomReal: eighty, zoomIncrement: 10 })).toEqual({
      kind: 'percent',
      percent: 88
    });
    // Zooming *out* divides (`currZoom / factor`), which is not the same as
    // subtracting the percentage: 80 / 1.2 = 66.67.
    expect(nextZoomStep(params, { direction: -1, currentZoomReal: eighty, zoomIncrement: 20 })).toEqual({
      kind: 'percent',
      // `80 / 1.2`, which is not a round number: the step is a factor, not a
      // subtraction.
      percent: expect.closeTo(66.67, 2)
    });
    // At the top of the ladder the step cannot go past it (`kZoomMax`).
    expect(nextZoomStep(params, { direction: 1, currentZoomReal: (6400 / 100) * LIGHTPDF_DPI_FACTOR, zoomIncrement: 10 })).toEqual({
      kind: 'percent',
      percent: LIGHTPDF_ZOOM_MAX
    });
    // An increment of 0 leaves the ladder in charge, which is the default.
    expect(nextZoomStep(params, { direction: 1, currentZoomReal: eighty, zoomIncrement: 0 })).toEqual({
      kind: 'percent',
      percent: 100
    });
  });

  it('has a built-in ladder that starts and ends where light-pdf\'s does', () => {
    expect(LIGHTPDF_ZOOM_LEVELS[0]).toBe(LIGHTPDF_ZOOM_MIN);
    expect(LIGHTPDF_ZOOM_LEVELS[LIGHTPDF_ZOOM_LEVELS.length - 1]).toBe(LIGHTPDF_ZOOM_MAX);
  });
});

// ---------------------------------------------------------------------------
// 7. WindowMargin / PageSpacing
// ---------------------------------------------------------------------------

describe('FixedPageUI.WindowMargin / PageSpacing (`gen-settings.ts:232-246`)', () => {
  it('defaults to the values light-pdf writes into its own settings file', () => {
    // `LightPDF-settings.txt`: `WindowMargin = 2 4 2 4`, `PageSpacing = 4 4`.
    expect(getSettingDescriptor('pdf.windowMargin')?.default).toBe('2 4 2 4');
    expect(getSettingDescriptor('pdf.pageSpacing')?.default).toBe('4 4');
  });

  it('reads light-pdf\'s space-separated form, in the struct\'s own order', () => {
    expect(lightPdfWindowMarginFromPrefs('2 4 2 4')).toEqual({ top: 2, right: 4, bottom: 2, left: 4 });
    expect(lightPdfWindowMarginFromPrefs('10 20 30 40')).toEqual({ top: 10, right: 20, bottom: 30, left: 40 });
    expect(lightPdfPageSpacingFromPrefs('12 6')).toEqual({ dx: 12, dy: 6 });
    // Commas are accepted too, so a hand-typed value is not silently ignored.
    expect(lightPdfPageSpacingFromPrefs('12,6')).toEqual({ dx: 12, dy: 6 });
  });  it('falls back to light-pdf\'s defaults for a malformed line rather than to zero', () => {
    expect(lightPdfWindowMarginFromPrefs('')).toEqual({ top: 2, right: 4, bottom: 2, left: 4 });
    expect(lightPdfWindowMarginFromPrefs('2 4 2')).toEqual({ top: 2, right: 4, bottom: 2, left: 4 });
    expect(lightPdfWindowMarginFromPrefs('a b c d')).toEqual({ top: 2, right: 4, bottom: 2, left: 4 });
    expect(lightPdfWindowMarginFromPrefs('2 4 2 4 8')).toEqual({ top: 2, right: 4, bottom: 2, left: 4 });
    expect(lightPdfWindowMarginFromPrefs(undefined)).toEqual({ top: 2, right: 4, bottom: 2, left: 4 });
    expect(lightPdfPageSpacingFromPrefs('4')).toEqual({ dx: 4, dy: 4 });
  });
});

// ---------------------------------------------------------------------------
// 8. SelectionToolbar
// ---------------------------------------------------------------------------

describe('Annotations.SelectionToolbar (`gen-settings.ts:445-450`)', () => {
  it('is on by default, as light-pdf ships it', () => {
    expect(getSettingDescriptor('pdf.selectionToolbar')?.default).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Whole-word find
// ---------------------------------------------------------------------------

describe('CmdFindToggleMatchWholeWord (`worker_main.cpp:1155`, `Commands.h:434`)', () => {
  it('is engine-side only: no setting, because light-pdf has none either', () => {
    // `FindBar.cpp`'s strip carries the button and `LightPdfFindBar` renders it;
    // the option travels through `PdfViewerHandle.find` into `pdfSearch` and on
    // to the engine's `SetMatchWholeWord`. There is no `GlobalPrefs` key for it
    // in light-pdf, so there is none here — `nativePdf.test.ts` covers the engine
    // half, and `viewerNavigation.test.ts` the find bar.
    expect(getSettingDescriptor('pdf.findWholeWord')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. ForwardSearch.*
// ---------------------------------------------------------------------------

describe('ForwardSearch (`gen-settings.ts:213-230`, `SearchAndDDE.cpp:1458-1488`)', () => {
  it('keeps the reference\'s four defaults', () => {
    expect(getSettingDescriptor('pdf.forwardSearchHighlightColor')?.default).toBe('#6581ff');
    expect(getSettingDescriptor('pdf.forwardSearchHighlightWidth')?.default).toBe(15);
    expect(getSettingDescriptor('pdf.forwardSearchHighlightOffset')?.default).toBe(0);
    expect(getSettingDescriptor('pdf.forwardSearchHighlightPermanent')?.default).toBe(false);
  });

  it('treats a non-positive width as 15, as `SearchAndDDE.cpp:1478` does', () => {
    expect(lightPdfForwardSearchWidth(0)).toBe(15);
    expect(lightPdfForwardSearchWidth(-3)).toBe(15);
    expect(lightPdfForwardSearchWidth(Number.NaN)).toBe(15);
    expect(lightPdfForwardSearchWidth(30)).toBe(30);
    expect(lightPdfForwardSearchWidth(30.4)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 11/12. CmdStartAutoScroll and CmdToggleCursorPosition
// ---------------------------------------------------------------------------

describe('FormatCursorPositionTemp (`LightPDF.cpp:3173-3210`)', () => {
  it('prints points, millimetres and inches as the reference formats them', () => {
    // The position arrives in PDF points; the reference divides by the file DPI
    // (72) first, so 72 pt is 1 in, 72 pt and 25.4 mm.
    expect(formatCursorPosition({ x: 72, y: 144 }, 'pt')).toBe('72 x 144 pt');
    expect(formatCursorPosition({ x: 72, y: 144 }, 'mm')).toBe('25.4 x 50.8 mm');
    expect(formatCursorPosition({ x: 72, y: 144 }, 'in')).toBe('1 x 2 in');
  });

  it('clamps a negative position to zero, as `:3174-3179` does', () => {
    expect(formatCursorPosition({ x: -5, y: -1 }, 'in')).toBe('0 x 0 in');
  });
});

// ---------------------------------------------------------------------------
// The wheel policy's shape
// ---------------------------------------------------------------------------

describe('planLightPdfWheel — the reference\'s order of decisions', () => {
  it('flips the page in a non-continuous layout whose page does not scroll', () => {
    const context = wheelContext({ delta: SCALED_NOTCH, continuous: false, metrics: metrics({ needVScroll: false }) });
    expect(planLightPdfWheel(context, 0).action).toEqual({ kind: 'page', direction: 1 });
  });

  it('holds a sub-notch delta in the accumulator while a notch turns pages', () => {
    const context = wheelContext({ delta: 60, continuous: false, metrics: metrics({ needVScroll: false }) });
    const first = planLightPdfWheel(context, 0);
    expect(first.action).toEqual({ kind: 'none' });
    expect(first.accum).toBe(60);
    // The second half of the notch is the page turn.
    expect(planLightPdfWheel(context, first.accum).action).toEqual({ kind: 'page', direction: 1 });
  });

  it('moves by the accumulated lines in a continuous layout when momentum is off', () => {
    const context = wheelContext({ delta: SCALED_NOTCH, continuous: true, smoothScroll: false });
    // One notch: three lines of 16 px, times the sensitivity.
    expect(planLightPdfWheel(context, 0).action).toEqual({ kind: 'scroll', dx: 0, dy: 96 });
    // A half notch moves half of that, in one event.
    expect(planLightPdfWheel({ ...context, delta: SCALED_NOTCH / 2 }, 0).action).toEqual({ kind: 'scroll', dx: 0, dy: 48 });
  });

  it('turns the wheel into the momentum integrator in a smooth continuous layout', () => {
    // The continuous layout is the one the momentum wheel belongs to:
    // `Canvas.cpp:2730`'s `!isCont` is `IsContinuous(...)`, so the non-continuous
    // modes page (above) and never reach it.
    const context = wheelContext({ delta: SCALED_NOTCH, continuous: true });
    const planned = planLightPdfWheel(context, 0);
    // The notch is already whole, so it fires on the first event.
    expect(planned.action.kind).toBe('smooth');
    // The impulse is the notch's distance at this sensitivity, times the decay rate
    // the integrator will use. The wheel unit is derived through the same
    // conversion the viewer uses, so the assertion cannot drift from it.
    expect(planned.action).toEqual({
      kind: 'smooth',
      impulse: lightPdfSmoothScrollImpulse(lightPdfLineScrollDistance(SCALED_NOTCH, 16), 2)
    });
    // …and the plain path when momentum is off.
    expect(planLightPdfWheel({ ...context, smoothScroll: false }, 0).action).toEqual({
      kind: 'scroll',
      dx: 0,
      dy: 96
    });
  });

  it('fires the momentum integrator on every delta, not once a notch has gathered', () => {
    // The threshold the accumulator enforces belongs to the *page-flip* paths
    // (above): a page turn is a discrete decision and needs a whole notch behind
    // it. The momentum path is a velocity, and a velocity is additive, so a
    // half-notch event is half a notch of impulse delivered now rather than half
    // of one delivered later. That is what the browser needs — it sends an event
    // per hardware report, where Windows sends one per `WHEEL_DELTA` — and it is
    // the difference between a trackpad gesture that glides and one that does
    // nothing until enough events have arrived to satisfy a threshold it was
    // never meant to meet.
    const context = wheelContext({ delta: 60, continuous: true });
    const first = planLightPdfWheel(context, 0);
    expect(first.action).toEqual({
      kind: 'smooth',
      impulse: lightPdfSmoothScrollImpulse(lightPdfLineScrollDistance(60, 16), 2)
    });
    // Nothing is banked: the delta has been applied, not saved.
    expect(first.accum).toBe(0);
    // The two halves still travel the whole notch between them, because the
    // impulse is built from the delta and the integrals add.
    const second = planLightPdfWheel(context, first.accum);
    expect(second.action).toEqual({
      kind: 'smooth',
      impulse: lightPdfSmoothScrollImpulse(lightPdfLineScrollDistance(60, 16), 2)
    });
  });

  it('keeps everything past the notch that fired in the accumulator', () => {
    // A fast spin sends more than a notch in one event. The whole delta is what
    // travels, so a spin's distance stays proportional to it.
    const context = wheelContext({ delta: SCALED_NOTCH * 2, continuous: true });
    const planned = planLightPdfWheel(context, 0);
    expect(planned.action).toEqual({
      kind: 'smooth',
      impulse: lightPdfSmoothScrollImpulse(lightPdfLineScrollDistance(SCALED_NOTCH * 2, 16), 2)
    });
    expect(planned.accum).toBe(0);
  });

  it('starts no momentum when the canvas has nothing to scroll', () => {
    // A document shorter than its viewport: an impulse there could only be
    // stopped at the boundary on the next frame. `maxPos` is the scrollable
    // range (`si.nMax - si.nPage`), so a canvas that fits has none. What is left
    // is the line path below — a distance, which the viewer applies and turns
    // into a page flip when the scroller refuses to move — rather than a
    // velocity with nowhere to go.
    const fitting = metrics({ maxPos: 0, needVScroll: false });
    const context = wheelContext({ delta: SCALED_NOTCH, continuous: true, metrics: fitting });
    expect(planLightPdfWheel(context, 0).action).toEqual({ kind: 'scroll', dx: 0, dy: 96 });
    // The same canvas with momentum off is the same answer: the guard changes
    // which path is taken, not where the reader ends up.
    const plain = wheelContext({ delta: SCALED_NOTCH, continuous: true, smoothScroll: false, metrics: fitting });
    expect(planLightPdfWheel(plain, 0).action).toEqual({ kind: 'scroll', dx: 0, dy: 96 });
  });

  it('does nothing at all when the system reports no wheel lines', () => {
    // `gDeltaPerLine == 0` is `:2667-2669`; the constant here is 40, so the
    // check is asserted through `planLightPdfLineScroll`'s own unit instead.
    expect(LIGHTPDF_DELTA_PER_LINE).toBe(40);
    expect(planLightPdfLineScroll(0, 0, 'vertical', 16).action).toEqual({ kind: 'none' });
  });

  it('scrolls horizontally on the horizontal axis', () => {
    const context = wheelContext({ delta: SCALED_NOTCH, continuous: true, axis: 'horizontal' });
    expect(planLightPdfWheel(context, 0).action).toEqual({ kind: 'scroll', dx: 96, dy: 0 });
  });

  it('charges a carried remainder once, not once per event', () => {
    // The line path applies the exact fraction of every event — the departure the
    // module documents — so the accumulator is a *report*, not a bank. Computing
    // the distance from `accum + delta` while also carrying the sub-line part
    // forward applied that part twice: two 60-unit events, one notch between them,
    // moved 24 + 32 = 56 px where one notch is 48, and the surplus compounded on
    // every event after the first. It hid on a mouse, whose notches are whole
    // multiples of `gDeltaPerLine` and leave no remainder, which is why every
    // assertion above is a whole notch.
    const first = planLightPdfLineScroll(60, 0, 'vertical', 16);
    expect(first.action).toEqual({ kind: 'scroll', dx: 0, dy: 24 });
    const second = planLightPdfLineScroll(60, first.accum, 'vertical', 16);
    expect(second.action).toEqual({ kind: 'scroll', dx: 0, dy: 24 });
    // 120 units of wheel is three lines of 16 px between them, exactly.
    expect(24 + 24).toBe(lightPdfLineScrollDistance(120, 16));
  });

  it('keeps a trackpad gesture proportional to the finger', () => {
    // Deltas dominated by the remainder are where the double count was worst:
    // twelve 10-unit events are 120 units of wheel, one notch.
    let accum = 0;
    let travelled = 0;
    for (let event = 0; event < 12; event += 1) {
      const planned = planLightPdfLineScroll(10, accum, 'vertical', 16);
      accum = planned.accum;
      if (planned.action.kind === 'scroll') travelled += planned.action.dy;
    }
    expect(travelled).toBeCloseTo(lightPdfLineScrollDistance(120, 16), 6);
  });

  it('does the same through the wheel plan with momentum off', () => {
    // The same two events through `planLightPdfWheel`, which is the path the
    // viewer takes when `pdf.smoothScroll` is off and on every Shift-wheel.
    const context = wheelContext({ delta: 60, continuous: true, smoothScroll: false });
    const first = planLightPdfWheel(context, 0);
    expect(first.action).toEqual({ kind: 'scroll', dx: 0, dy: 24 });
    expect(planLightPdfWheel(context, first.accum).action).toEqual({ kind: 'scroll', dx: 0, dy: 24 });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metrics(overrides: Partial<LightPdfScrollMetrics> = {}): LightPdfScrollMetrics {
  return {
    page: 800,
    pos: 0,
    maxPos: 1000,
    needVScroll: true,
    ...overrides
  };
}

function wheelContext(overrides: Partial<LightPdfWheelContext> = {}): LightPdfWheelContext {
  return {
    delta: SCALED_NOTCH,
    axis: 'vertical',
    continuous: true,
    fitContent: false,
    pageSlider: false,
    fastScrollOverScrollbar: false,
    altHalfPage: false,
    smoothScroll: true,
    sensitivity: 2,
    metrics: metrics(),
    linePixels: 16,
    ...overrides
  };
}

/** A one-page, 600×800 layout at 100 %, for the zoom-ladder steps. */
function zoomParams(): Parameters<typeof nextZoomStep>[0] {
  return {
    pageCount: 1,
    pageBoxes: [{ width: 612, height: 792 }],
    contentBoxes: [undefined],
    displayMode: 'continuous',
    startPage: 1,
    rotation: 0,
    viewPortSize: { dx: 600, dy: 800 },
    viewPortOffset: { x: 0, y: 0 },
    zoomVirtual: 100,
    previousZoomReal: 0,
    currentPage: 1,
    windowMargin: { top: 2, right: 4, bottom: 2, left: 4 },
    pageSpacing: { dx: 4, dy: 4 }
  };
}
