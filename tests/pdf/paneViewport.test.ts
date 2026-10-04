// @vitest-environment jsdom
/**
 * The pane's viewport measurement.
 *
 * The layout is built from the scroll container's own size, so that size has to
 * be a measurement of the window and not of anything the layout produced. When
 * an ancestor lets the pane grow to its content, `clientHeight` *is* the canvas
 * height the viewer just computed; feeding it back made
 * `lightPdfLayout` centre the pages inside a phantom viewport, which pushed
 * every page hundreds of pixels down and out of the pane — an empty viewer, with
 * at most the blank top of a page showing.
 *
 * `page-fit` hides it (there the page's height tracks the viewport height, so the
 * two cancel out) and `page-width` exposes it, which is why the regression is
 * tested in the second mode.
 *
 * The harness reports the ancestors the way a browser does — the pane's
 * containing boxes are window-sized, the scroller is not — because that
 * difference is the whole bug.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { PdfOpenResult, PdfRenderResult, PdfSelectRequest } from '../../src/shared/ipc';

const A4 = { width: 595.276, height: 841.89 };
/**
 * The room the window gives the pane. A `let`, so a test can widen or narrow it
 * the way the editor/PDF divider does.
 */
const PANE = { width: 440, height: 533 };

let renderCalls: Array<{ page: number; scale: number }> = [];
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
      await openGate;
      return {
        path,
        pageCount: 2,
        pages: [{ ...A4 }, { ...A4 }],
        outline: [],
        metadata: {},
        needsPassword: false,
        engine: 'test'
      };
    },
    pdfClose: async () => true,
    pdfRender: async (request: { requestId: number; page: number; scale: number; invert?: boolean }): Promise<PdfRenderResult> => {
      renderCalls.push({ page: request.page, scale: request.scale });
      const width = Math.max(1, Math.round(A4.width * request.scale));
      const height = Math.max(1, Math.round(A4.height * request.scale));
      return {
        requestId: request.requestId,
        page: request.page,
        width,
        height,
        stride: width * 4,
        channels: 4,
        order: 'rgba' as const,
        pageRect: { x: 0, y: 0, width: A4.width, height: A4.height },
        // A complete, tightly packed payload: `stride * height` bytes. A stub that
        // declared a page-sized bitmap and handed back four bytes was not describing a
        // render reply, and `describePixelPayload` now says so.
        pixels: new Uint8Array(width * height * 4)
      };
    },
    pdfCancelRender: async () => true,
    pdfText: async () => [],
    pdfOutline: async () => [],
    pdfLinks: async () => [],
    pdfSelect: async (_path: string, request: PdfSelectRequest) => ({ page: request.page, text: '', rects: [] }),
    pdfSearch: async () => [],
    stat: async () => ({ exists: true, mtimeMs: 1, size: 1, isDirectory: false }),
    openExternal: async () => undefined
  };
  (globalThis as unknown as { window: { eukoliaApi: unknown } }).window.eukoliaApi = api;
}

function defineSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => height });
}

/** Both toolbar modes float over the document without consuming viewport space. */
function toolbarPixels(): number {
  return 0;
}

/**
 * Gives the scroller the metrics a browser would give it. `runaway` reproduces a
 * pane an ancestor let grow to its content: `height: 100%` resolves only against
 * a *definite* parent height, so with a parent whose height is `auto` the
 * scroller falls back to `height: auto`, sizes itself to the canvas and grows
 * straight past the parent.
 *
 * A `max-height` on the scroller *itself* does constrain it, and that is the only
 * thing that does — a parent's `max-height` does not make the parent's height
 * definite. Modelling that faithfully is the point of this harness: if the cap
 * ever moves back to the parent, these tests must fail exactly as the browser
 * failed.
 *
 * Width is the other half of the same shape, and it is now the simpler one: the
 * scroller is `width: 100%` of the pane with **no cap of its own**, so its right
 * edge — and the scrollbar drawn against it — is the pane's, however the pane is
 * resized. Every "the right edge does not reach the window" report came from a
 * `max-width` here, because a width cap has to be written from a measurement and
 * a measurement taken inside this subtree sees this subtree's layout rather than
 * the window's. `data-pane-cap` is what `<PdfViewer>` marks its capped boxes with,
 * so a cap that comes back is caught rather than assumed away.
 */
function makeScrollable(element: HTMLElement, options: { runaway: boolean }): void {
  const contentHeight = (): number => {
    const host = element.firstElementChild as HTMLElement | null;
    const declared = host ? Number.parseFloat(host.style.height || '0') : 0;
    return Number.isFinite(declared) && declared > 0 ? declared : PANE.height;
  };
  const contentWidth = (): number => {
    const host = element.firstElementChild as HTMLElement | null;
    const declared = host ? Number.parseFloat(host.style.width || '0') : 0;
    return Number.isFinite(declared) && declared > 0 ? declared : PANE.width;
  };
  /**
   * The scroller's own box.
   *
   * Height: `height: 100%` of the pane less whatever the toolbar takes above it,
   * narrowed by its own `max-height`. With `runaway` the parent has no definite
   * height at all, so `height: 100%` resolves to `auto` and the scroller sizes
   * itself to the canvas — which is the runaway the cap exists for.
   */
  const ownHeight = (): number => {
    const room = Math.max(0, PANE.height - toolbarPixels());
    const natural = options.runaway ? Math.max(room, contentHeight()) : room;
    const cap = Number.parseFloat(element.style.maxHeight || '0');
    return Number.isFinite(cap) && cap > 0 ? Math.min(natural, cap) : natural;
  };
  /**
   * The scroller's own box on the other axis: `width: 100%` of the pane, and
   * nothing else.
   *
   * There is no width runaway to model. `height: 100%` resolves to `auto` when a
   * parent's height is indefinite, which is what lets a scroller size itself to
   * its content vertically; `width: 100%` always resolves against the pane, so the
   * scroller's right edge is the pane's whether the pages inside it are wider or
   * narrower. `scrollWidth` is then the pages' extent, which is what
   * `scrollWidth` below reports — the two being equal would mean the scroller had
   * grown to its content, which is the bug this shape exists to catch.
   */
  const ownWidth = (): number => {
    const cap = Number.parseFloat(element.style.maxWidth || '0');
    return Number.isFinite(cap) && cap > 0 ? Math.min(PANE.width, cap) : PANE.width;
  };
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: ownWidth });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: ownHeight });
  Object.defineProperty(element, 'scrollWidth', {
    configurable: true,
    get: () => Math.max(contentWidth(), element.clientWidth)
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => Math.max(contentHeight(), element.clientHeight)
  });
  let top = 0;
  let left = 0;
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, Number(value) || 0));
    }
  });
  Object.defineProperty(element, 'scrollLeft', {
    configurable: true,
    get: () => left,
    set: (value: number) => {
      left = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, Number(value) || 0));
    }
  });
  (element as unknown as { scrollTo: unknown }).scrollTo = (options_?: ScrollToOptions | number, y?: number) => {
    if (typeof options_ === 'number') {
      element.scrollTop = y ?? 0;
      return;
    }
    if (options_ && typeof options_.top === 'number') element.scrollTop = options_.top;
    if (options_ && typeof options_.left === 'number') element.scrollLeft = options_.left;
  };
}

const resizeCallbacks: Array<() => void> = [];

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
  scroller: HTMLElement;
  root: Root;
  unmount(): Promise<void>;
}

/**
 * A document path unique to each mount.
 *
 * The viewer remembers a document's view — display mode, zoom, rotation, scroll —
 * per path, and writes it back when it unmounts. That record is what a reopened
 * file is restored from, so a test that reuses a path inherits the previous
 * test's zoom mode, and the failure lands in the *next* test's numbers. A fresh
 * path per mount is what makes these tests independent of each other's order.
 */
let mountSerial = 0;

async function mount(options: { runaway: boolean }): Promise<Mounted> {
  const { PdfPane } = await import('../../src/renderer/pdf/PdfPane');
  mountSerial += 1;
  const path = `D:/docs/viewer-${mountSerial}.pdf`;
  const handle: { current: import('../../src/renderer/pdf/PdfViewer').PdfViewerHandle | null } = { current: null };
  const host = document.createElement('div');
  document.body.appendChild(host);
  // The pane's own box: the room the window gave it, which is what an ancestor
  // reports however tall the scroller inside it has grown.
  defineSize(host, PANE.width, PANE.height);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(PdfPane as never, {
        path,
        appearance: 'light',
        invertColors: false,
        handleRef: handle,
        onOpenFile: () => undefined
      } as never)
    );
  });
  const scroller = host.querySelector('[data-testid="pdf-scroll-container"]') as HTMLElement;
  // The pane the viewer measures: its own content box, which is what reports the
  // room it has now that the viewer no longer caps its width. jsdom reports 0 for
  // every box, so the pane has to be told its size — and it is the *only* box
  // that has to be.
  if (scroller.parentElement) defineSize(scroller.parentElement, PANE.width, PANE.height);  makeScrollable(scroller, options);
  await act(async () => {
    for (const callback of [...resizeCallbacks]) callback();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  releaseOpen?.();
  await settle(60);
  /**
   * And wait for the page to be *drawn*, not merely asked for.
   *
   * A bitmap is drawn in the frame after the render returns — the viewer keeps one
   * whole-page `drawImage` per frame, so that a scroll whose pages all arrive
   * together cannot drop a frame — and the render itself resolves on the worker's
   * reply. A fixed wait therefore races both of them.
   */
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !/^painted page /.test(scroller.dataset.renderStatus ?? '')) {
    await settle(20);
  }
  return {
    host,
    scroller,
    root,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    }
  };
}

/** The top of page 1's box, in the canvas, relative to the container's top. */
function pageTop(view: Mounted): number {
  const page = view.host.querySelector('[data-page="1"]') as HTMLElement | null;
  return page ? Number.parseFloat(page.style.top || '0') : Number.NaN;
}

/** The laid-out width of page 1, which is what a fit mode decides. */
function pageWidth(view: Mounted): number {
  const page = view.host.querySelector('[data-page="1"]') as HTMLElement | null;
  return Number.parseFloat(page?.style.width ?? '0');
}

/**
 * The nearest ancestor that reports a size — the room the pane was given, as the
 * viewer's own `containingBound` reads it.
 */
function nearestAncestorHeight(element: HTMLElement): number {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.clientHeight > 0) return node.clientHeight;
  }
  return Number.NaN;
}

beforeEach(async () => {
  renderCalls = [];
  installApi();
  installResizeObserver();
  openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  // The document's own box: a browser reports the window here, and it is what
  // bounds a pane whose scroller has grown past it.
  defineSize(document.body, PANE.width, PANE.height);
  defineSize(document.documentElement, PANE.width, PANE.height);
  const { forgetAllLightPdfStates } = await import('../../src/renderer/pdf/lightpdf-viewstate');
  forgetAllLightPdfStates();
});

/**
 * The settings these tests write are shared by the whole file — one
 * `settingsManager`, and the viewer reads it live — so every test starts from the
 * defaults. Without this a test that asked for `page-fit` left the next one at
 * `page-fit`, and the failure it caused was in the *next* test's numbers rather
 * than in its own.
 */
beforeEach(async () => {
  const { settingsManager } = await import('../../src/renderer/core/settings');
  settingsManager.reset('pdf.defaultZoom', 'user');
  settingsManager.reset('pdf.scrollbar', 'user');
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('a pane that fits its window', () => {
  it('lays page 1 out at the window margin and paints it', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings');
    settingsManager.setValue('pdf.defaultZoom', 'page-fit', 'user');
    const view = await mount({ runaway: false });

    expect(pageTop(view)).toBe(2);
    expect(view.scroller.dataset.renderStatus).toMatch(/^painted page \d/);
    // The pixels reached a canvas: jsdom cannot give one, and that is reported
    // rather than left to look like a blank page.
    expect(view.scroller.dataset.paintStatus).toMatch(/^page \d+( drawn|: no 2D context)/);
    expect(renderCalls.length).toBeGreaterThan(0);
    await view.unmount();
  });
});

describe('a pane an ancestor let grow to its content', () => {
  /**
   * The shape that produced the blank viewer: a scroller that reports the canvas
   * height instead of the room the pane was given. Every test here asserts the
   * containment invariant directly as well as the layout, because the invariant is
   * what the layout depends on.
   */
  const expectContained = (view: Mounted): void => {
    const height = view.scroller.clientHeight;
    // Never larger than the box that contains it — the number that was 1578 in a
    // 472px parent, and the number the layout was then built around.
    expect(height).toBeLessThanOrEqual(nearestAncestorHeight(view.scroller));
    // And never larger than the room the window gave the pane.
    expect(height).toBeLessThanOrEqual(PANE.height);
    // A scroll container that reports a viewport must be able to scroll the
    // content that does not fit, or the page below the window is unreachable.
    expect(view.scroller.scrollHeight).toBeGreaterThan(height);
  };

  it('does not centre the pages inside the phantom viewport (page-width)', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings');
    settingsManager.setValue('pdf.defaultZoom', 'page-width', 'user');
    const view = await mount({ runaway: true });

    expectContained(view);
    // `lightPdfLayout` starts the canvas at `windowMargin.top`; the shift this
    // guards against is `(viewPortSize.dy - canvasDy) / 2`, which was ~320px for
    // a two-page A4 at fit-width in this pane — far enough down that the reader
    // saw only the canvas background.
    expect(pageTop(view)).toBe(2);
    await view.unmount();
  });

  it('does not centre the pages inside the phantom viewport (page-fit)', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings');
    settingsManager.setValue('pdf.defaultZoom', 'page-fit', 'user');
    const view = await mount({ runaway: true });

    expectContained(view);
    // `page-fit` is the mode the runaway hides in: the page's height tracks the
    // viewport, so the shift is small enough that the page still shows. It must
    // start at the window margin like any other.
    expect(pageTop(view)).toBe(2);
    expect(view.scroller.dataset.renderStatus).toMatch(/^painted page \d/);
    await view.unmount();
  });

  it('bounds the scroller itself, and only the scroller', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings');
    settingsManager.setValue('pdf.defaultZoom', 'page-width', 'user');
    const view = await mount({ runaway: true });

    // The cap has to be on the scroller: `height: 100%` resolves only against a
    // definite parent height, so a cap on the parent alone leaves the scroller at
    // `height: auto` and it sizes itself to its content.
    expect(view.scroller.style.maxHeight).toBe(`${PANE.height}px`);
    const bounded = view.host.querySelector('[data-scrollbar-mode]') as HTMLElement | null;
    // And it belongs *only* there. On the viewer's root the same cap constrains
    // nothing — a parent `max-height` does not make the child's `height: 100%`
    // definite — while inflating the box the viewer measures its viewport from,
    // which is the runaway the cap exists to stop: the pages were then laid out
    // for a canvas the viewer had written itself.
    expect(bounded?.style.maxHeight).toBe('');
    expectContained(view);
    await view.unmount();
  });
});

/**
 * The same containment question one axis over.
 *
 * The height bug was a scroller that grew to its content and then had its own
 * grown height fed back to the layout as the room the pane was given. Width has
 * the same shape and it is the axis that decides whether a page *fits*, so it is
 * worth pinning separately — and the failure it produces is different: a page
 * wider than the pane is not blank, it is **clipped**, with its right-hand side
 * out of reach. Reachable is therefore the property under test, not merely
 * small: whenever the canvas is wider than the viewport the reader has to have
 * a control that gets to it.
 */
describe('a page wider than the pane', () => {
  const fitWidth = PANE.width;
  /** 100 % zoom on A4 is 96/72 * 595.276 = 793.7 CSS px, far wider than the pane. */
  const ACTUAL_WIDTH = Math.round((595.276 * 96) / 72);

  it('keeps a fit mode inside the pane, so nothing is clipped at all', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings');
    settingsManager.setValue('pdf.defaultZoom', 'page-fit', 'user');
    const view = await mount({ runaway: true });

    const page = view.host.querySelector('[data-page="1"]') as HTMLElement | null;
    const width = Number.parseFloat(page?.style.width ?? '0');
    // The page plus the window margin fits the pane: `WindowMargin` is 2 4 2 4,
    // so a fit-width page is the pane's width less its own side margins.
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(PANE.width);
    // Nothing to scroll, so nothing to reach.
    expect(view.scroller.scrollWidth).toBeLessThanOrEqual(view.scroller.clientWidth);
    await view.unmount();
  });

  it('lets the reader reach the right edge when the page is wider than the pane', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings');
    settingsManager.setValue('pdf.defaultZoom', 'actual', 'user');
    // The overlay bar is what a `smart`/`overlay` pane has instead of the native
    // one; a horizontal bar that does not exist makes the right edge unreachable.
    settingsManager.setValue('pdf.scrollbar', 'smart', 'user');
    // No `runaway`: a page wider than the pane overflows a scroller that is
    // exactly the pane's width. The runaway is a *height* failure — `height: 100%`
    // resolving to `auto` — and modelling it on the width axis would hide the very
    // overflow this test is about.
    const view = await mount({ runaway: false });

    const page = view.host.querySelector('[data-page="1"]') as HTMLElement | null;
    // `actual` is 100 % of the file's own size: far wider than this pane, whatever
    // the fit modes would have done with it.
    expect(Number.parseFloat(page?.style.width ?? '0')).toBeGreaterThan(PANE.width);
    // The scroller is only as wide as its content once the page has been laid
    // out, so the metrics are read again the way a browser would after a paint.
    await act(async () => {
      for (const callback of [...resizeCallbacks]) callback();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // The scroller really can move horizontally...
    expect(view.scroller.scrollWidth).toBeGreaterThan(view.scroller.clientWidth);
    view.scroller.scrollLeft = 100_000;
    expect(view.scroller.scrollLeft).toBe(view.scroller.scrollWidth - view.scroller.clientWidth);
    // ...and the reader has a control that moves it. light-pdf creates one
    // overlay bar per axis (`LightPDF.cpp:1226`, `:1281`).
    const horizontal = view.host.querySelector('[data-orientation="horizontal"]') as HTMLElement | null;
    expect(horizontal, 'a wider-than-pane canvas needs a horizontal overlay bar').not.toBeNull();
    expect(horizontal?.dataset.scrollbarState).toBe('AlwaysThick');
    const thumb = horizontal?.querySelector('[data-testid="pdf-overlay-scrollbar-thumb"]') as HTMLElement | null;
    /**
     * The thumb is proportional to the visible fraction of the canvas —
     * `GetThumbRect`'s `trackLen * page / range` — and it is inside the track
     * rather than off the end of it.
     *
     * The track is the bar's own extent, which is the owner's width: the pane's.
     * jsdom reports 0 for a box's rectangle, so the width comes from the scroller
     * the bar measures itself against, and the track's own end insets are read off
     * the bar rather than restated here — a duplicated constant would make this
     * assertion agree with itself instead of with the component.
     */
    const track = view.scroller.clientWidth;
    const range = view.scroller.scrollWidth;
    const inset = Number.parseFloat(getComputedStyle(horizontal as Element).getPropertyValue('--eu-overlay-inset') || '0') || 0;
    const usableTrack = Math.max(0, track - inset * 2);
    const expectedThumb = Math.max(16, (usableTrack * track) / range);
    const thumbWidth = Number.parseFloat(thumb?.style.width ?? '0');
    expect(thumbWidth).toBeGreaterThan(0);
    expect(thumbWidth).toBeLessThanOrEqual(track);
    // Proportional, and the *point* of a proportional thumb is that it is shorter
    // than its track whenever there is anything to scroll to.
    expect(thumbWidth).toBeLessThan(track);
    expect(thumbWidth).toBeGreaterThanOrEqual(Math.min(expectedThumb, 16));
    expect(track - thumbWidth).toBeGreaterThanOrEqual(Number.parseFloat(thumb?.style.left ?? '0'));
    await view.unmount();
  });

  it('draws no horizontal bar when there is nothing to the right', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings');
    settingsManager.setValue('pdf.defaultZoom', 'page-fit', 'user');
    settingsManager.setValue('pdf.scrollbar', 'smart', 'user');
    const view = await mount({ runaway: true });

    // A bar with nothing to scroll is a dead control, so it must not be drawn.
    expect(view.host.querySelector('[data-orientation="horizontal"]')).toBeNull();
    // The vertical bar is still there for the two-page document's vertical range.
    expect(view.host.querySelector('[data-orientation="vertical"]')).not.toBeNull();
    await view.unmount();
  });
});

/**
 * The pane's right edge, which is the same question one axis over and one level
 * out: not "can the reader reach the page's right edge", but "does the viewer
 * reach the window's".
 *
 * Nothing in the viewer may decide its own width. The scroller is `width: 100%`
 * of the pane with no cap of its own, so its right edge — and the scrollbar drawn
 * against it — is the pane's, at every width and in every scrollbar mode. Two
 * earlier revisions had a `max-width` here, written from a measurement taken
 * inside the subtree it was sizing, and both produced the same report: the
 * viewer's right edge floating free of the window while the pane reached it.
 */
describe('the viewer fills the pane', () => {
  /** Chromium's classic Windows scrollbar, the width the smoke run reports. */
  const SCROLLBAR = 17;

  const overflows = (element: HTMLElement): boolean => {
    const host = element.firstElementChild as HTMLElement | null;
    const declared = host ? Number.parseFloat(host.style.height || '0') : 0;
    return declared > PANE.height;
  };

  it('never caps its own width, on the root or on the scroller', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings');
    const before = {
      zoom: settingsManager.getValue('pdf.defaultZoom'),
      scrollbar: settingsManager.getValue('pdf.scrollbar')
    };
    settingsManager.setValue('pdf.defaultZoom', 'page-fit', 'user');
    settingsManager.setValue('pdf.scrollbar', 'windows', 'user');
    const view = await mount({ runaway: false });

    const root = view.host.querySelector('[data-scrollbar-mode]') as HTMLElement | null;
    expect(root?.style.maxWidth).toBe('');
    expect(view.scroller.style.maxWidth).toBe('');
    // No box the viewer caps is left marked for the measurement that used to lift
    // those caps; a `data-pane-cap` here would mean the caps came back.
    expect(view.host.querySelectorAll('[data-pane-cap]')).toHaveLength(0);
    // The height cap stays: that runaway is real (see `makeScrollable`).
    expect(view.scroller.style.maxHeight).not.toBe('');
    await view.unmount();
    // Left as it was found: the settings store is shared by the whole file.
    settingsManager.setValue('pdf.defaultZoom', before.zoom, 'user');
    settingsManager.setValue('pdf.scrollbar', before.scrollbar, 'user');
  });

  it('reserves no strip for the bar by default, so a fitted page reaches the edge', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings');
    // `page-width`, not `page-fit`: an A4 page in a pane this shape is fitted by
    // its *height*, so `page-fit` would say nothing about the right edge.
    settingsManager.setValue('pdf.defaultZoom', 'page-width', 'user');
    settingsManager.setValue('pdf.scrollbar', 'smart', 'user');
    const view = await mount({ runaway: false });

    // light-pdf's overlay bar floats over the page, so the scroller is the whole
    // pane and a fit-width page differs from it by the window margin alone
    // (`pdf.windowMargin` is `2 4 2 4`, so four pixels a side).
    expect(view.scroller.clientWidth).toBe(PANE.width);
    expect(PANE.width - pageWidth(view)).toBeCloseTo(8, 0);
    await view.unmount();
  });

  it('hands the page the pane less the bar, when the bar reserves its width', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings');
    settingsManager.setValue('pdf.defaultZoom', 'page-width', 'user');
    settingsManager.setValue('pdf.scrollbar', 'windows', 'user');
    const view = await mount({ runaway: false });

    // A platform bar takes its width out of the scroller's client box while the
    // scroller still occupies the whole pane — `offsetWidth` is the box, the
    // difference is the bar. The fit follows the *client* box, so the page does
    // not hang under the bar.
    const gutter = SCROLLBAR;
    Object.defineProperty(view.scroller, 'offsetWidth', { configurable: true, get: () => PANE.width });
    Object.defineProperty(view.scroller, 'clientWidth', { configurable: true, get: () => PANE.width - gutter });
    await act(async () => {
      for (const callback of [...resizeCallbacks]) callback();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(pageWidth(view)).toBeLessThanOrEqual(view.scroller.clientWidth);
    // The page is fitted for the room the pages have, not for the pane: it is the
    // client box less the window margin, not the pane less the margin.
    expect(PANE.width - gutter - pageWidth(view)).toBeCloseTo(8, 0);
    // …and the pane is still the pane: the bar is inside it, and the viewer's box
    // carries no cap of its own.
    expect(view.scroller.style.maxWidth).toBe('');
    await view.unmount();
  });
});

/**
 * The pane resizing under the viewer, which is what dragging the editor/PDF
 * divider does.
 *
 * The viewer holds no width of its own — it is `width: 100%` of the pane — so the
 * only thing a resize has to get right is the *fit*: the pages must be laid out
 * for the pane they are in now, not the one they were in a moment ago. Two
 * revisions went wrong here in opposite directions: a `max-width` cap that could
 * not follow the pane outward, and an uncoalesced measurement that re-laid-out
 * every page on every notification.
 */
describe('a pane that resizes', () => {
  const original = { ...PANE };

  afterEach(() => {
    PANE.width = original.width;
    PANE.height = original.height;
  });

  const resizePaneTo = async (view: Mounted, width: number) => {
    PANE.width = width;
    defineSize(view.host, PANE.width, PANE.height);
    if (view.scroller.parentElement) defineSize(view.scroller.parentElement, PANE.width, PANE.height);
    await act(async () => {
      for (const callback of [...resizeCallbacks]) callback();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  };

  it('follows the pane out and back, re-fitting the page each way', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings');
    settingsManager.setValue('pdf.defaultZoom', 'page-width', 'user');
    settingsManager.setValue('pdf.scrollbar', 'smart', 'user');
    const view = await mount({ runaway: false });

    const wide = view.scroller.clientWidth;
    expect(wide).toBe(PANE.width);

    // Dragged in: the scroller follows the pane and the page is re-fitted to it.
    await resizePaneTo(view, 260);
    expect(view.scroller.clientWidth).toBe(260);
    expect(pageWidth(view)).toBeCloseTo(260 - 8, 0);

    // …and dragged back out. Nothing has to be "given back": the scroller is the
    // pane's width whenever it is measured, so the only question is whether the
    // fit re-ran.
    await resizePaneTo(view, wide);
    expect(view.scroller.clientWidth).toBe(wide);
    expect(pageWidth(view)).toBeCloseTo(wide - 8, 0);
    await view.unmount();
  });
});
