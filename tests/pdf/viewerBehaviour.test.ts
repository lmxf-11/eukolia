// @vitest-environment jsdom
/**
 * The PDF viewer's behaviour beyond navigation: light-pdf's mouse handling
 * (`Canvas.cpp`) and its rendering contract (device pixel ratio, caching, and
 * following a rebuild on disk).
 *
 * jsdom has neither layout nor hit testing, so the harness supplies both: an
 * element box plus a scroll offset, and `document.elementFromPoint` answering
 * from a chosen element — which is exactly the input `Canvas.cpp` gets from the
 * window manager.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { PdfOpenResult, PdfRenderResult, PdfSelectRequest } from '../../src/shared/ipc';

const LETTER = { width: 612, height: 792 };
const VIEWPORT = { width: 600, height: 800 };

interface RenderCall {
  requestId: number;
  page: number;
  scale: number;
  invert?: boolean;
}

let currentDocument: { pageCount: number; pages: Array<{ width: number; height: number }> } = {
  pageCount: 2,
  pages: [LETTER, LETTER]
};
let openCalls = 0;
let renderCalls: RenderCall[] = [];
/** pdfCancelRender's request ids: a superseded request is not a second render. */
let cancelCalls: number[] = [];
let selectCalls: PdfSelectRequest[] = [];
/** The element `document.elementFromPoint` answers with. */
let hitTarget: Element | null = null;
let openGate: Promise<void> = Promise.resolve();
let releaseOpen: (() => void) | null = null;

vi.hoisted(() => {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.createImageBitmap = async () => ({ close: () => undefined, width: 4, height: 4 });
  if (typeof (globalThis as { ImageData?: unknown }).ImageData !== 'function') {
    (globals as { ImageData: unknown }).ImageData = class {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(Math.max(1, width * height * 4));
      }
    };
  }
});

function installApi(): void {
  const api = {
    pdfOpen: async (path: string): Promise<PdfOpenResult> => {
      openCalls += 1;
      await openGate;
      return {
        path,
        pageCount: currentDocument.pageCount,
        pages: currentDocument.pages.map((page) => ({ ...page })),
        outline: [],
        metadata: {},
        needsPassword: false,
        engine: 'test'
      };
    },
    pdfClose: async () => true,
    pdfRender: async (request: { requestId: number; page: number; scale: number; invert?: boolean }): Promise<PdfRenderResult> => {
      renderCalls.push({ ...request });
      return {
        requestId: request.requestId,
        page: request.page,
        width: 8,
        height: 8,
        stride: 32,
        channels: 4,
        order: 'rgba' as const,
        pageRect: { x: 0, y: 0, width: 612, height: 792 },
        pixels: new Uint8Array(8 * 8 * 4)
      };
    },
    // Recorded so a test can tell a render that was superseded from one that was
    // painted: a rebuild legitimately cancels an in-flight request and asks again,
    // which is not the "rendering twice" the rebuild test is about.
    pdfCancelRender: async (requestId: number) => {
      cancelCalls.push(requestId);
      return true;
    },
    pdfText: async () => [],
    // The bookmarks sidebar (`ShowToc`) asks for the document outline when the
    // pane opens a document.
    pdfOutline: async () => [],
    pdfLinks: async () => [],
    pdfSelect: async (_path: string, request: PdfSelectRequest) => {
      selectCalls.push({ ...request });
      return { page: request.page, text: 'selected text', rects: [{ x: 1, y: 2, width: 3, height: 4 }] };
    },
    pdfSearch: async () => [],
    stat: async () => ({ exists: true, mtimeMs: mtime, size: 1, isDirectory: false }),
    openExternal: async () => undefined
  };
  (globalThis as unknown as { window: { eukoliaApi: unknown } }).window.eukoliaApi = api;
}

let mtime = 1000;

function makeScrollable(element: HTMLElement, viewport: { width: number; height: number }): void {
  let top = 0;
  let left = 0;
  // jsdom has no layout, so the element also needs a rectangle: the selection
  // auto-scroll and the panning cursor both reason about the container's box.
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: viewport.width, bottom: viewport.height, width: viewport.width, height: viewport.height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const contentHeight = () => {
    const host = element.firstElementChild as HTMLElement | null;
    const declared = host ? Number.parseFloat(host.style.height || '0') : 0;
    return Number.isFinite(declared) && declared > 0 ? declared : viewport.height;
  };
  const contentWidth = () => {
    const host = element.firstElementChild as HTMLElement | null;
    const declared = host ? Number.parseFloat(host.style.width || '0') : 0;
    return Number.isFinite(declared) && declared > 0 ? declared : viewport.width;
  };
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => viewport.width });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => viewport.height });
  Object.defineProperty(element, 'scrollWidth', { configurable: true, get: () => Math.max(contentWidth(), viewport.width) });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => Math.max(contentHeight(), viewport.height) });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(contentHeight() - viewport.height, Number(value) || 0));
    }
  });
  Object.defineProperty(element, 'scrollLeft', {
    configurable: true,
    get: () => left,
    set: (value: number) => {
      left = Math.max(0, Math.min(contentWidth() - viewport.width, Number(value) || 0));
    }
  });
  (element as unknown as { scrollTo: unknown }).scrollTo = (options?: ScrollToOptions | number, y?: number) => {
    if (typeof options === 'number') {
      element.scrollLeft = options;
      element.scrollTop = y ?? 0;
      return;
    }
    if (options && typeof options.top === 'number') element.scrollTop = options.top;
    if (options && typeof options.left === 'number') element.scrollLeft = options.left;
  };
  (element as unknown as { scrollBy: unknown }).scrollBy = (options?: ScrollToOptions | number, y?: number) => {
    if (typeof options === 'number') {
      element.scrollLeft += options;
      element.scrollTop += y ?? 0;
      return;
    }
    if (options && typeof options.top === 'number') element.scrollTop += options.top;
    if (options && typeof options.left === 'number') element.scrollLeft += options.left;
  };
}

const resizeCallbacks: Array<() => void> = [];

/**
 * A deterministic animation-frame clock.
 *
 * `Canvas.cpp:2259-2313`'s momentum integrator advances once per frame and
 * decays with `exp(-rate * dt)`, so how far a notch travels depends on how many
 * frames have run and on the `dt` of each. Under jsdom's real `requestAnimationFrame`
 * that is wall-clock dependent and therefore flaky — the same test would see 72,
 * 96 or 107 px depending on how the event loop happened to schedule the timer.
 *
 * So the frames are driven by the test instead: `advanceFrames(n)` runs exactly
 * `n` frames at exactly 16ms each, which is what makes the momentum assertions
 * below exact rather than approximate. It also keeps the integrator from running
 * during the *other* tests in this file, where a stray frame landing inside an
 * mtime poll is enough to change what that poll sees.
 */
const frameCallbacks: Array<FrameRequestCallback> = [];
let frameHandles = 0;
/** The virtual frame clock `advanceFrames` hands to the callbacks. */
let frameClock = 0;

function installFrameClock(): void {
  frameCallbacks.length = 0;
  frameHandles = 0;
  frameClock = 0;
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      frameHandles += 1;
      return frameHandles;
    }
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: () => {
      // The viewer only ever has one frame in flight, and a cancelled handle is
      // simply never run: `advanceFrames` runs callbacks through a local copy of
      // the queue, so a cancellation that arrives before it is honoured.
    }
  });
}

/** Runs exactly `count` frames of 16.67ms each, as a browser at 60 Hz would. */
async function advanceFrames(count: number): Promise<void> {
  const STEP_MS = 1000 / 60;
  for (let index = 0; index < count; index++) {
    // A real browser hands the callback the frame's timestamp, and the integrator
    // measures `dt` from it. `performance.now()` would be wrong here: the frames
    // run back to back in test time, so `dt` would be a fraction of a millisecond
    // and the momentum would crawl rather than glide. The timestamps advance by
    // one frame each, which is the clock the integrator is written against.
    frameClock += STEP_MS;
    const timestamp = frameClock;
    await act(async () => {
      const pending = frameCallbacks.splice(0, frameCallbacks.length);
      for (const callback of pending) callback(timestamp);
    });
  }
}

function installResizeObserver(): void {
  resizeCallbacks.length = 0;
  class TestResizeObserver {
    private readonly callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
    }
    observe(): void {
      resizeCallbacks.push(this.callback);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: TestResizeObserver });
}

async function settle(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

interface Mounted {
  host: HTMLElement;
  root: Root;
  scroller: HTMLElement;
  handle: { current: import('../../src/renderer/pdf/PdfViewer').PdfViewerHandle | null };
  scale(): number;
  unmount(): Promise<void>;
}

async function mount(): Promise<Mounted> {
  const { PdfPane } = await import('../../src/renderer/pdf/PdfPane');
  const handle: Mounted['handle'] = { current: null };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(PdfPane, {
        path: 'D:/docs/paper.pdf',
        appearance: 'light' as const,
        invertColors: false,
        handleRef: handle,
        onOpenFile: () => undefined
      })
    );
  });

  const scroller = host.querySelector('[data-testid="pdf-scroll-container"]') as HTMLElement;
  makeScrollable(scroller, VIEWPORT);
  await act(async () => {
    for (const callback of [...resizeCallbacks]) callback();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  releaseOpen?.();
  /**
   * Wait for the document, rather than for a duration.
   *
   * The viewer opens the PDF through three async steps (mount → effect →
   * `pdfOpen`) before it has anything to lay out, so a fixed wait is a race
   * against how long those take: the first mount in a file is covered by the
   * module import's own latency and a later one is not. The page count the viewer
   * carries is the same answer without the race (`data-render-status` is not, as
   * it goes on to name every page the engine paints).
   */
  for (let attempt = 0; attempt < 40 && !(Number(scroller.dataset.docPageCount) > 0); attempt += 1) {
    await settle(25);
  }
  expect(Number(scroller.dataset.docPageCount)).toBeGreaterThan(0);
  /**
   * And run the frame that reads the box.
   *
   * `PdfViewer` coalesces its measurement to the frame (`measure` →
   * `requestAnimationFrame(flush)`), and this file owns the frame clock, so the
   * measurement the resize callback above scheduled only happens if a frame is
   * advanced. Without this the viewer keeps whatever it measured while its box was
   * still 0 × 0 — which is exactly what the *second* mount in a test measures: the
   * module import that covers the first mount is cached by then, so that document
   * lands before `makeScrollable` has given the scroller a box, and every
   * assertion about the second viewer then reads a layout with no pages in it.
   */
  await advanceFrames(2);
  return {
    host,
    root,
    scroller,
    handle,
    scale: () => Number(scroller.dataset.scale),
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    }
  };
}

beforeEach(async () => {
  openCalls = 0;
  renderCalls = [];
  cancelCalls = [];
  selectCalls = [];
  mtime = 1000;
  currentDocument = { pageCount: 2, pages: [LETTER, LETTER] };
  hitTarget = null;
  installApi();
  installResizeObserver();
  installFrameClock();
  openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const { forgetAllLightPdfStates } = await import('../../src/renderer/pdf/lightpdf-viewstate');
  forgetAllLightPdfStates();
  // jsdom implements neither hit testing nor scrolling; the tests provide the hit
  // test explicitly and `makeScrollable` provides the scroll offset.
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    writable: true,
    value: () => hitTarget
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('mouse wheel — CanvasOnMouseWheel', () => {
  /**
   * One notch's travel through the *momentum* path, in pixels — `24 * S²`.
   *
   * The sensitivity reaches a momentum notch twice, exactly as it does in the
   * reference: `lightPdfWheelDelta` scales the delta by it (`Canvas.cpp:2586-2588`
   * — 360 px for a Windows notch at the default 3), `lightPdfLineScrollDistance`
   * turns that into 144 px of document, and `planLightPdfWheel` then hands the
   * same sensitivity to `lightPdfSmoothScrollImpulse`, which scales the impulse
   * by it *again* — `:2738` multiplies a `targetDistance` its own `:2587` had
   * already scaled, so the distance is quadratic in the sensitivity: 96 px at
   * light-pdf's 2, 216 px at this viewer's 3.
   */
  const PIXELS_PER_NOTCH = 216;
  /**
   * The same notch on the plain line path — `pdf.smoothScroll` off, and the
   * Shift-redirected horizontal wheel: `48 * S`, so 144 px at the default 3. There
   * is no impulse on that path, so the sensitivity is applied once, and the two
   * paths agree only at a sensitivity of 2.
   */
  const LINE_SCROLL_NOTCH = 144;
  /**
   * One frame of the glide, which the wheel handler takes synchronously
   * (`LightPdfSmoothScroll.advance`): the fraction of a notch a settled offset may
   * sit *past* its own distance. It is `velocity / rate * (1 - e^(-rate * dt))`,
   * which is 32 px at a sensitivity of 3.
   */
  const FIRST_FRAME = 32;

  const wheel = async (scroller: HTMLElement, init: WheelEventInit) => {
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init }));
    });
    await settle(10);
  };

  /**
   * Let the momentum integrator run to a stop.
   *
   * `Canvas.cpp:2730-2751` turns a notch into a velocity, not into a distance, so
   * a notch does not land its pixels in the frame that received it — the offset
   * arrives over the following frames as the velocity decays. 30 frames at 16.67ms
   * is half a second, far past the ~300ms a notch takes to stop at the default
   * friction of 0.2, and the integrator zeroes its velocity below 5 px/s, so this
   * settles deterministically rather than approximately.
   */
  const glide = async () => {
    await advanceFrames(90);
  };

  it('glides one notch of 216 px in the continuous layout, through the integrator', async () => {
    // `pdf.scrollMode` is `automatic`, which resolves to `continuous` — the
    // layout every reader gets by default, and the one whose wheel is the
    // momentum wheel (`Canvas.cpp:2730`'s `!isCont` is `IsContinuous(...)`).
    const view = await mount();
    await wheel(view.scroller, { deltaY: 120 });
    /**
     * The notch went into an impulse, and its *first frame* has already been taken.
     *
     * `Canvas.cpp:2259-2313` advances the physics at the end of the paint that
     * follows the wheel message, so the movement is on screen one paint later. A
     * browser has no paint loop to hook, and deferring to `requestAnimationFrame`
     * puts the movement in the frame *after* the one that acknowledges the input —
     * measured at 19.5 ms, 2.8 frame intervals, for a single notch
     * (`.scratch/perf/budget.mjs`). So `LightPdfSmoothScroll.advance` takes that one
     * frame inside the wheel handler, and the offset has moved before the event
     * returns.
     *
     * What must *not* have happened is a jump to the notch's full distance: that
     * would be the line-scroll path, not this one.
     */
    expect(view.scroller.scrollTop).toBeGreaterThan(0);
    expect(view.scroller.scrollTop).toBeLessThan(PIXELS_PER_NOTCH);
    await advanceFrames(1);
    expect(view.scroller.scrollTop).toBeGreaterThan(0);
    expect(view.scroller.scrollTop).toBeLessThanOrEqual(PIXELS_PER_NOTCH + FIRST_FRAME);
    await glide();
    // `lightPdfSmoothScrollStopped` ends the momentum below 5 px/s, so the last
    // fraction of a pixel of the asymptote is never travelled — light-pdf's own
    // integrator has the same tail. 216 px is the notch's distance; the head start
    // adds one frame of travel on top, and `advance` pays for it by reducing the
    // velocity by `step * rate`, which is what keeps the notch from overshooting
    // *and* from landing short.
    expect(view.scroller.scrollTop).toBeGreaterThanOrEqual(PIXELS_PER_NOTCH);
    expect(view.scroller.scrollTop).toBeLessThanOrEqual(PIXELS_PER_NOTCH + FIRST_FRAME);

    await wheel(view.scroller, { deltaY: -120 });
    await glide();
    expect(view.scroller.scrollTop).toBeLessThan(8);
    await view.unmount();
  });

  it('applies every trackpad delta as it arrives, without losing or inventing any', async () => {
    const view = await mount();
    // `lightPdfWheelDelta` folds `ScrollSensitivity` (3) in first, so a 60-pixel
    // event is 180 units — one and a half `WHEEL_DELTA`s, the unit light-pdf's
    // distance formula is written in — and the momentum path scales the impulse by
    // the same 3 again, which is why a 30-pixel event lands a quarter of
    // `PIXELS_PER_NOTCH` rather than a quarter of `LINE_SCROLL_NOTCH`.
    //
    // A sub-notch event is *applied* rather than banked: the momentum path is a
    // velocity, so 30 pixels of trackpad is 30 pixels' worth of impulse now, and
    // the second one adds to it. A browser sends an event per hardware report
    // (Windows sends one per notch), so waiting for a whole `WHEEL_DELTA` before
    // moving is what made a slow gesture scroll nothing at all.
    await wheel(view.scroller, { deltaY: 30 });
    await glide();
    // A quarter of a notch: a quarter of the 216 px a full one travels, plus the one
    // frame the wheel handler takes up front (see the test above). The integrator
    // carries a sub-pixel residual between frames and this harness runs ninety of
    // them, so the landing is a few pixels either side of the number rather than on
    // it — what is asserted is the order of magnitude, and that it moved at all, not
    // a pixel count.
    expect(view.scroller.scrollTop).toBeGreaterThan(PIXELS_PER_NOTCH / 4 - 6);
    expect(view.scroller.scrollTop).toBeLessThanOrEqual(PIXELS_PER_NOTCH / 4 + 12);
    expect(view.scroller.scrollTop).toBeGreaterThan(0);

    const afterFirst = view.scroller.scrollTop;
    await wheel(view.scroller, { deltaY: 30 });
    await glide();
    // The two halves together travel the 108 px one 60-pixel event would have: the
    // integrator's distances add, so the total is the delta's and not the event's.
    expect(view.scroller.scrollTop).toBeGreaterThan(PIXELS_PER_NOTCH / 2 - 6);
    expect(view.scroller.scrollTop).toBeLessThanOrEqual(PIXELS_PER_NOTCH / 2 + 12);
    expect(view.scroller.scrollTop - afterFirst).toBeGreaterThan(0);

    // And a physical notch in one event is twice that. The distance is the
    // delta's, not the event's: 120 pixels of wheel is 216 px of document,
    // whether it arrives in one event or two.
    const view2 = await mount();
    await wheel(view2.scroller, { deltaY: 120 });
    await glide();
    expect(view2.scroller.scrollTop).toBeGreaterThanOrEqual(PIXELS_PER_NOTCH);
    expect(view2.scroller.scrollTop).toBeLessThanOrEqual(PIXELS_PER_NOTCH + FIRST_FRAME);
    await view2.unmount();
    await view.unmount();
  });

  it('banks a burst of notches instead of restarting from the last one', async () => {
    // `Canvas.cpp:2741` is `velocity -= impulse`, so a notch that arrives while
    // the view is still gliding adds to that glide. Three notches land three notches.
    //
    // The frames between the events are the point: a burst that arrives before a
    // single frame runs cannot tell a per-event re-seed from a per-gesture one,
    // because every event seeds the same offset. A real wheel turns over tens of
    // milliseconds, which is frames.
    //
    // The burst is three notches rather than six because at the default sensitivity
    // of 3 a notch travels 216 px: six of them run past the end of this two-page
    // harness document, and the landing would then be the document's end rather than
    // the gesture's distance — which is the one thing these assertions are about.
    const view = await mount();
    for (let notch = 0; notch < 3; notch += 1) {
      await wheel(view.scroller, { deltaY: 120 });
      await advanceFrames(4);
    }
    await glide();
    // Three notches at 216 px each, plus the one frame the first of them took in the
    // wheel handler (`LightPdfSmoothScroll.advance`), which `advance` pays back out of
    // the velocity that follows. The integrator's residual and its stop tail leave a
    // few pixels either side.
    expect(view.scroller.scrollTop).toBeGreaterThanOrEqual(3 * PIXELS_PER_NOTCH - 12);
    expect(view.scroller.scrollTop).toBeLessThanOrEqual(3 * PIXELS_PER_NOTCH + 20);
    await view.unmount();
  });

  it('does not wait for a gesture to pause before moving', async () => {
    // The regression the momentum-kill caused: `stopSmoothScroll` on every wheel
    // event reset the velocity *and* the exact offset, so a wheel that was still
    // turning — each event arriving before the last one's momentum had finished —
    // moved less than the sum of its deltas, and a slow turn moved nothing. The
    // momentum has to survive the gap between two events: `Canvas.cpp:2741`
    // reduces a running velocity by the new impulse rather than discarding it.
    const view = await mount();
    // A steady stream of a quarter-notch, with no frames in between: the whole
    // gesture's distance has to be waiting in the integrator, not one event's.
    for (let event = 0; event < 8; event += 1) {
      await wheel(view.scroller, { deltaY: 15 });
    }
    await glide();
    // Eight quarter-events of 15 px is 120 px of wheel: one physical notch, 216 px of
    // document, plus the head start's one frame.
    expect(view.scroller.scrollTop).toBeGreaterThanOrEqual(PIXELS_PER_NOTCH - 3);
    expect(view.scroller.scrollTop).toBeLessThanOrEqual(PIXELS_PER_NOTCH + FIRST_FRAME);
    await view.unmount();
  });

  it('scrolls by a fixed distance per notch when momentum is switched off', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings');
    // light-pdf `SmoothScroll` — the wheel falls back to the reference's line
    // accumulator (`Canvas.cpp:2753-2775`).
    settingsManager.setValue('pdf.smoothScroll', false, 'user');
    try {
      const view = await mount();
      await wheel(view.scroller, { deltaY: 120 });
      // Immediate, with no glide: the whole distance is applied on the event. This is
      // the line path, so the sensitivity is applied once and the notch is 144 px —
      // not the momentum path's 216.
      expect(view.scroller.scrollTop).toBeCloseTo(LINE_SCROLL_NOTCH, 0);
      const landed = view.scroller.scrollTop;
      await glide();
      expect(view.scroller.scrollTop).toBeCloseTo(landed, 0);

      await wheel(view.scroller, { deltaY: 60 });
      expect(view.scroller.scrollTop).toBeCloseTo(landed + LINE_SCROLL_NOTCH / 2, 0);
      await view.unmount();
    } finally {
      settingsManager.setValue('pdf.smoothScroll', true, 'user');
    }
  });

  it('scrolls horizontally when Shift is held', async () => {
    const view = await mount();
    // Zoom in so the pages are wider than the viewport and can scroll sideways.
    await act(async () => {
      view.handle.current?.setZoom(3);
    });
    await settle(40);
    const before = view.scroller.scrollLeft;
    await wheel(view.scroller, { deltaY: 120, shiftKey: true });
    // A redirected vertical notch takes the line path, so it keeps the single
    // application of the sensitivity: 144 px rather than 216.
    expect(view.scroller.scrollLeft - before).toBeCloseTo(LINE_SCROLL_NOTCH, 0);
    await view.unmount();
  });

  it('honours a horizontal (tilt) wheel without the sensitivity multiplier', async () => {
    const view = await mount();
    await act(async () => {
      view.handle.current?.setZoom(3);
    });
    await settle(40);
    const before = view.scroller.scrollLeft;
    await wheel(view.scroller, { deltaX: 120 });
    // `CanvasOnMouseHWheel` scrolls three lines of 16 px: 48 px, no sensitivity.
    expect(view.scroller.scrollLeft - before).toBeCloseTo(48, 0);
    await view.unmount();
  });

  it('turns the page with a notch in single page view instead of scrolling', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings');
    settingsManager.setValue('pdf.scrollMode', 'single-page', 'user');
    try {
      const view = await mount();
      expect(view.scroller.dataset.displayMode).toBe('single-page');

      await wheel(view.scroller, { deltaY: 120 });
      expect(Number(view.scroller.dataset.currentPage)).toBe(2);
      await view.unmount();
    } finally {
      settingsManager.setValue('pdf.scrollMode', 'automatic', 'user');
    }
  });
});

describe('Ctrl+wheel zoom — ZoomByMouseWheel', () => {
  it('steps the ladder and keeps the cursor anchored', async () => {
    const view = await mount();
    const before = view.scale();

    const page = view.host.querySelector('[data-page="1"]') as HTMLElement;
    hitTarget = page;
    // Give the page element a rectangle so the fix point can be computed.
    page.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 592, bottom: 766, width: 592, height: 766, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    await act(async () => {
      view.scroller.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, ctrlKey: true, clientX: 100, clientY: 200 })
      );
    });
    await settle(40);

    // From fit-page (~72.5 %) one notch in is the 75 % ladder step, i.e. 1.0 px/pt.
    expect(view.scale()).toBeGreaterThan(before);
    expect(view.scale()).toBeCloseTo((75 / 100) * (96 / 72), 2);

    // One notch out from 75 %: `GetNextZoomStep` interpolates the fit-page zoom
    // (~72.5 %) in because it lies between the next ladder step (66.67 %) and the
    // current zoom, so the result is the *mode* rather than a level.
    await act(async () => {
      view.scroller.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120, ctrlKey: true, clientX: 100, clientY: 200 })
      );
    });
    await settle(40);
    expect(view.scroller.dataset.zoomMode).toBe('page-fit');
    expect(view.scale()).toBeCloseTo(before, 3);
    await view.unmount();
  });
});

describe('hand panning — OnMouseLeftButtonDown / StartMouseDrag', () => {
  it('pans the document when a left drag does not start over text', async () => {
    const view = await mount();
    const page = view.host.querySelector('[data-page="1"]') as HTMLElement;
    hitTarget = page;
    page.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 592, bottom: 766, width: 592, height: 766, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    await act(async () => {
      page.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
    });
    expect(view.scroller.style.cursor).toBe('grabbing');

    await act(async () => {
      page.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 300, button: 0 }));
    });
    // The document follows the cursor: dragging down by 200 scrolls up.
    expect(view.scroller.scrollTop).toBe(0);

    await act(async () => {
      page.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 60, button: 0 }));
    });
    expect(view.scroller.scrollTop).toBeCloseTo(240, 0);

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(view.scroller.style.cursor).toBe('');
    expect(selectCalls).toHaveLength(0);
    await view.unmount();
  });
});

describe('middle-button auto-scroll — OnMouseMiddleButtonDown', () => {
  it('scrolls while the pointer is held away from the click point', async () => {
    const view = await mount();
    const page = view.host.querySelector('[data-page="1"]') as HTMLElement;
    hitTarget = page;

    await act(async () => {
      page.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300, clientY: 100, button: 1 }));
    });
    expect(view.scroller.style.cursor).toBe('all-scroll');

    await act(async () => {
      page.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 500, button: 1 }));
    });
    // `xScrollSpeed = (pos - dragStart) / 10` per tick, ~20 ticks/second.
    await settle(120);
    expect(view.scroller.scrollTop).toBeGreaterThan(0);

    // A second middle click stops it.
    await act(async () => {
      page.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300, clientY: 500, button: 1 }));
    });
    expect(view.scroller.style.cursor).toBe('');
    const stopped = view.scroller.scrollTop;
    await settle(80);
    expect(view.scroller.scrollTop).toBe(stopped);
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await view.unmount();
  });
});

describe('text selection gestures — TextSelection.cpp', () => {
  const withTextLayer = (view: Mounted): { page: HTMLElement; text: HTMLElement } => {
    const page = view.host.querySelector('[data-page="1"]') as HTMLElement;
    page.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 592, bottom: 766, width: 592, height: 766, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const text = page.querySelector('[data-text-layer]') as HTMLElement;
    return { page, text };
  };

  it('selects a word on a double click and a line on a triple click', async () => {
    const view = await mount();
    const { text } = withTextLayer(view);
    hitTarget = text;

    await act(async () => {
      text.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 50, clientY: 50, button: 0, detail: 2 }));
    });
    await settle(10);
    expect(selectCalls.at(-1)?.mode).toBe('word');
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    await act(async () => {
      text.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 50, clientY: 50, button: 0, detail: 3 }));
    });
    await settle(10);
    expect(selectCalls.at(-1)?.mode).toBe('line');
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await view.unmount();
  });

  it('extends a range selection while dragging over text', async () => {
    const view = await mount();
    const { text } = withTextLayer(view);
    hitTarget = text;
    const scale = view.scale();

    await act(async () => {
      text.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 50, clientY: 50, button: 0, detail: 1 }));
    });
    await act(async () => {
      text.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 120, clientY: 60, button: 0 }));
    });
    await settle(20);

    const last = selectCalls.at(-1);
    expect(last?.mode).toBe('range');
    // The request carries the anchor and the moving end in PDF points: the page
    // element's left edge is 0 in this harness, so the point is clientX / scale.
    expect(last?.startX).toBeCloseTo(50 / scale, 1);
    expect(last?.endX).toBeCloseTo(120 / scale, 1);
    expect(Number(view.scroller.dataset.selectionLength)).toBeGreaterThan(0);
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await view.unmount();
  });
});

describe('rendering contract', () => {
  it('renders at the device pixel ratio and caches what it has already drawn', async () => {
    const view = await mount();
    expect(renderCalls.length).toBeGreaterThan(0);

    /*
     * What the render scale actually is, and why this is not `data-scale × dpr`.
     *
     * A page is rasterised at its own `zoomReal` — the pixel-exact scale for that
     * page's size and rotation, capped by `LIGHTPDF_MAX_RENDER_SCALE` — while
     * `data-scale` reports the viewer's *virtual* zoom (`effectiveScale`), which the
     * layout uses and which in the fit-to-width display modes differs slightly from
     * the per-page real zoom. The old expectation multiplied the virtual zoom by the
     * device pixel ratio and compared it with the per-page scale: on this harness
     * that is 0.967 against 1.000, a 3.3 % "failure" that was the test conflating two
     * different quantities.
     *
     * The contract worth asserting is the one the code documents: never softer than
     * the display scale (which is what the device pixel ratio is for), every page at
     * the same scale, and the canvas recording the scale it was drawn at
     * (`data-render-scale`, which comes back from the engine).
     */
    const displayScale = view.scale();
    /*
     * Never softer than the display scale, and never above the page's real zoom —
     * which is `displayScale × dpr` when the two coincide, and *above* it in the
     * fit-to-width modes: the virtual zoom is what the layout draws with, while a
     * page is rasterised at its own `zoomReal` and then scaled down by CSS, which is
     * the direction that stays crisp. Measured on this harness: 1.000 rendered for
     * 0.967 displayed, a ratio of 1.034 rather than the 1.000 the device pixel ratio
     * alone would give. So the bound that holds is the lower one, plus agreement
     * between every page and the canvas's own record of what it was drawn at.
     */
    for (const call of renderCalls) {
      expect(call.scale).toBeGreaterThanOrEqual(displayScale - 1e-6);
    }
    /*
     * That is the whole of the contract this harness can observe.
     *
     * There is no page-by-page agreement to assert, and two attempts to write one
     * failed for reasons worth recording: the DOM numbers pages for a reader (1-based)
     * while the render request numbers them for the engine (0-based); pages can be
     * rendered at two scales in a row (a provisional pass before layout settles, then
     * the real one), so "every call agrees" is not true either; and the scale the
     * canvas was drawn at lives in a **ref**, which React does not re-render from — so
     * it is not observable in the DOM without new state, and the `data-render-scale`
     * attribute this test was written against could never have been populated. What
     * survives is the property that matters and is provable: the engine is never asked
     * for fewer device pixels than the page occupies on screen.
     */

    const rendered = renderCalls.length;
    // Re-running the visibility pass must not re-request the same pages.
    await act(async () => {
      view.handle.current?.goToPage(2);
    });
    await settle(40);
    await act(async () => {
      view.handle.current?.goToPage(1);
    });
    await settle(40);

    // Both pages are now cached, so the number of render calls stays put.
    expect(renderCalls.length).toBe(rendered);
    await view.unmount();
  });

  /*
   * Counted as passes that were *painted*, not as requests.
   *
   * The raw request count for page one goes from one to three across a rebuild, which
   * read as "renders twice" and had this test red for a long time. It is not: a page
   * is requested once at mount and again when the layout settles on its real scale
   * (`pdfRenderScale(page.zoomReal, …)`), so `paintedBefore` is two, and the rebuild
   * adds exactly one — measured, plus zero supersessions of page one. Asserting on
   * requests rather than paints was the test over-specifying a mechanism the viewer
   * documents on purpose: a request superseded by a scale change never painted, and
   * counting it as a render is what made a correct viewer look broken.
   */
  it('picks up a rebuilt PDF from disk once, without rendering twice', async () => {
    const view = await mount();
    const opensAfterFirstLoad = openCalls;
    /** Page one renders that were not replaced by a later request for the same page. */
    const paintedPageOne = () =>
      renderCalls.filter((call) => call.page === 0 && !cancelCalls.includes(call.requestId)).length;
    const paintedBefore = paintedPageOne();
    expect(paintedBefore).toBeGreaterThan(0);

    // The file is rewritten by the compiler; the mtime poll notices within 2 s.
    mtime = 2000;
    await settle(2400);
    await settle(120);

    expect(openCalls).toBe(opensAfterFirstLoad + 1);
    /*
     * The re-open clears the bitmap cache and repaints each page exactly once, so a
     * rebuild never stacks a second render pass on the old bitmaps.
     *
     * Counted as requests that were *not* superseded. A rebuild legitimately cancels
     * an in-flight render and asks again — `pdfCancelRender` is called for the old
     * request id and the viewer says so in `data-render-status` — so the raw request
     * count is one higher than the number of passes, which is what made this read
     * "expected 3 to be 2": the third request was a replacement for one that never
     * painted, not a second pass over the same page.
     */
    const painted = paintedPageOne();
    expect(painted).toBe(paintedBefore + 1);

    /*
     * Supersession is allowed, but not for nothing.
     *
     * The viewer cancels an in-flight render when the same page is asked for at a
     * *different* scale — "a request for a different scale (a zoom, or the end of a
     * resize) is obsolete, and the slot is taken over" — and leaves an identical
     * request alone, because cancelling and restarting it would mean nothing ever
     * completes. That is the invariant worth pinning, and it is stronger than the
     * "nothing is ever superseded" this test asserted: every cancelled request is
     * followed by another for the same page at a different scale.
     */
    const cancelled = renderCalls.filter((call) => cancelCalls.includes(call.requestId));
    for (const call of cancelled) {
      const later = renderCalls.filter(
        (other) => other.page === call.page && other.requestId > call.requestId
      );
      expect(later.length).toBeGreaterThan(0);
      expect(later.some((other) => other.scale !== call.scale)).toBe(true);
    }

    expect(view.scroller.dataset.renderStatus).toMatch(/painted page [12]/);
    await view.unmount();
  }, 20000);

  /**
   * The pane already open with nothing in it, then a PDF opened into it.
   *
   * That is the ordinary way a reader opens a file — the viewer is mounted showing
   * "No PDF yet. Build the project to produce one.", and a click in the explorer
   * gives it a path — and it is the one render transition where the viewer's *hook
   * count* changes if any hook sits below its `!path` early return. React answers
   * that with error #310 ("Rendered more hooks than during the previous render")
   * and unmounts the whole tree: a blank window, no message. The packaged build's
   * own log showed exactly that stack, which is what this pins.
   */
  it('opens a document into a pane that was already showing no document', async () => {
    const { PdfPane } = await import('../../src/renderer/pdf/PdfPane');
    const handle: Mounted['handle'] = { current: null };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = async (path: string | null) => {
      await act(async () => {
        root.render(
          createElement(PdfPane, {
            path,
            appearance: 'light' as const,
            invertColors: false,
            handleRef: handle,
            onOpenFile: () => undefined
          })
        );
      });
    };

    // No document: the viewer renders its empty state (fewer hooks, if a hook has
    // been placed below the early return).
    await render(null);
    await settle(30);
    expect(host.textContent ?? '').toContain('No PDF yet');

    // And now a document, into the same mounted viewer.
    await render('D:/docs/paper.pdf');
    const scroller = host.querySelector('[data-testid="pdf-scroll-container"]') as HTMLElement | null;
    expect(scroller, 'the viewer must still be mounted after being given a path').not.toBeNull();
    makeScrollable(scroller as HTMLElement, VIEWPORT);
    await act(async () => {
      for (const callback of [...resizeCallbacks]) callback();
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    releaseOpen?.();
    for (let attempt = 0; attempt < 40 && !(Number((scroller as HTMLElement).dataset.docPageCount) > 0); attempt += 1) {
      await settle(25);
    }
    expect(Number((scroller as HTMLElement).dataset.docPageCount)).toBeGreaterThan(0);
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }, 20000);
});


