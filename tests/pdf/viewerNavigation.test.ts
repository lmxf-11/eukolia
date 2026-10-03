// @vitest-environment jsdom
/**
 * Page navigation in the PDF viewer.
 *
 * This is the regression test for the confirmed bug: `Home`, `End`, `N`, `P` and
 * "go to page" used to be silent no-ops because the layout only held the pages it
 * had *measured*, so `scrollToPage` found no geometry for the target and
 * returned. `DisplayModel::GoToPage` navigates the *document*: in the continuous
 * modes every page is laid out and its position is known, and in single page /
 * facing / book view the layout's start page moves to the requested page's row
 * and the canvas is rebuilt around it (`ChangeStartPage`). Both paths are
 * exercised here, including a document whose page sizes have not all arrived —
 * the case where the target genuinely has no geometry until the layout is
 * extended for it.
 *
 * The viewer is mounted for real (React + jsdom) against a stubbed
 * `window.eukoliaApi`, so the assertions are made on what the pane renders and
 * scrolls, not on a re-implementation of the arithmetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { PdfOpenResult, PdfRenderResult } from '../../src/shared/ipc';

interface StubDocument {
  pageCount: number;
  /** Page sizes the engine reports; deliberately allowed to be short. */
  pages: Array<{ width: number; height: number }>;
}

const LETTER = { width: 612, height: 792 };
const VIEWPORT = { width: 600, height: 800 };

let currentDocument: StubDocument = { pageCount: 2, pages: [LETTER, LETTER] };
/**
 * Gate the stub's `pdfOpen` so a test can measure the pane before the document
 * arrives. Without it the first layout would run against jsdom's 0x0 viewport and
 * every assertion would be about a degenerate layout.
 */
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
      // Held until the test has given the scroll container its metrics, so the
      // first layout runs against a real viewport instead of a 0x0 one.
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
    pdfRender: async (request: { requestId: number; page: number; scale: number }): Promise<PdfRenderResult> => ({
      requestId: request.requestId,
      page: request.page,
      width: 8,
      height: 8,
      stride: 32,
      channels: 4,
      order: 'rgba' as const,
      pageRect: { x: 0, y: 0, width: 612, height: 792 },
      pixels: new Uint8Array(8 * 8 * 4)
    }),
    pdfCancelRender: async () => true,
    pdfText: async () => [],
    // The bookmarks sidebar (`ShowToc`) asks for the document outline when the
    // pane opens a document.
    pdfOutline: async () => [],
    pdfLinks: async () => [],
    pdfSelect: async () => ({ page: 1, text: '', rects: [] }),
    pdfSearch: async () => [],
    stat: async () => ({ exists: true, mtimeMs: 1, size: 1, isDirectory: false }),
    openExternal: async () => undefined
  };
  (globalThis as unknown as { window: { eukoliaApi: unknown } }).window.eukoliaApi = api;
}

/** Gives an element the layout box jsdom does not compute, and a scroll offset. */
function makeScrollable(element: HTMLElement, viewport: { width: number; height: number }): void {  let top = 0;
  let left = 0;
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
  const clampTop = (value: number) => Math.max(0, Math.min(contentHeight() - viewport.height, value));
  const clampLeft = (value: number) => Math.max(0, Math.min(contentWidth() - viewport.width, value));

  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => viewport.width });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => viewport.height });
  Object.defineProperty(element, 'scrollWidth', { configurable: true, get: () => Math.max(contentWidth(), viewport.width) });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => Math.max(contentHeight(), viewport.height) });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = clampTop(Number(value) || 0);
    }
  });
  Object.defineProperty(element, 'scrollLeft', {
    configurable: true,
    get: () => left,
    set: (value: number) => {
      left = clampLeft(Number(value) || 0);
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

/**
 * A `ResizeObserver` that lets the test deliver the callback, which is what a
 * browser does: the viewer measures its scroll container and re-runs the fit
 * modes whenever the size changes. The shared stub in `tests/setup/dom.ts` is a
 * no-op, so without this the pane would keep the 0x0 viewport it sees at mount
 * and every fit mode would resolve to nothing.
 */
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
    disconnect(): void {
      const index = resizeCallbacks.indexOf(this.callback);
      if (index >= 0) resizeCallbacks.splice(index, 1);
    }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: TestResizeObserver });
}

async function notifyResize(): Promise<void> {
  await act(async () => {
    for (const callback of [...resizeCallbacks]) callback();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

interface Mounted {
  host: HTMLElement;
  root: Root;
  scroller: HTMLElement;
  handle: { current: import('../../src/renderer/pdf/PdfViewer').PdfViewerHandle | null };
  pages: () => number[];
  currentPage: () => number;
  scale: () => number;
  unmount(): Promise<void>;
}

async function settle(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mountPdfPane(): Promise<Mounted> {
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
        onOpenFile: () => undefined,
        onPageChange: () => undefined
      })
    );
  });

  const scroller = host.querySelector('[data-testid="pdf-scroll-container"]') as HTMLElement;
  expect(scroller, 'the viewer must render its scroll container').toBeTruthy();
  makeScrollable(scroller, VIEWPORT);
  await notifyResize();
  releaseOpen?.();
  await settle(60);

  const pages = () =>
    Array.from(host.querySelectorAll('[data-page]'))
      .map((element) => Number((element as HTMLElement).dataset.page))
      .sort((a, b) => a - b);

  return {
    host,
    root,
    scroller,
    handle,
    pages,
    currentPage: () => Number(scroller.dataset.currentPage),
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
  installApi();
  installResizeObserver();
  openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const { forgetAllLightPdfStates } = await import('../../src/renderer/pdf/lightpdf-viewstate');
  forgetAllLightPdfStates();
  currentDocument = { pageCount: 2, pages: [LETTER, LETTER] };
  // jsdom has no scrolling implementation. A prototype-level fallback keeps an
  // early programmatic scroll (the viewer restores a remembered view as soon as
  // the document is open) from throwing before a specific element has been given
  // its metrics; `makeScrollable` overrides it per element with clamping.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value(this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
      if (typeof options === 'number') {
        this.scrollLeft = options;
        this.scrollTop = y ?? 0;
        return;
      }
      if (options && typeof options.top === 'number') this.scrollTop = options.top;
      if (options && typeof options.left === 'number') this.scrollLeft = options.left;
    }
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
    configurable: true,
    writable: true,
    value(this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
      if (typeof options === 'number') {
        this.scrollLeft += options;
        this.scrollTop += y ?? 0;
        return;
      }
      if (options && typeof options.top === 'number') this.scrollTop += options.top;
      if (options && typeof options.left === 'number') this.scrollLeft += options.left;
    }
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('continuous navigation', () => {
  it('lays out the whole document and goes to the last page', async () => {
    const view = await mountPdfPane();
    expect(view.pages()).toEqual([1, 2]);
    expect(view.currentPage()).toBe(1);

    await act(async () => {
      view.handle.current?.goToPage(2);
    });
    await settle();

    expect(view.currentPage()).toBe(2);
    expect(view.scroller.scrollTop).toBeGreaterThan(0);

    await view.unmount();
  });

  it('goes back to the first page with goToPage(1)', async () => {
    const view = await mountPdfPane();
    await act(async () => {
      view.handle.current?.goToPage(2);
    });
    await settle();
    expect(view.currentPage()).toBe(2);

    await act(async () => {
      view.handle.current?.goToPage(1);
    });
    await settle();
    expect(view.currentPage()).toBe(1);
    expect(view.scroller.scrollTop).toBe(0);

    await view.unmount();
  });

  it('pages forward and back with nextPage/previousPage', async () => {
    const view = await mountPdfPane();

    await act(async () => {
      view.handle.current?.nextPage();
    });
    await settle();
    expect(view.currentPage()).toBe(2);

    await act(async () => {
      view.handle.current?.previousPage();
    });
    await settle();
    expect(view.currentPage()).toBe(1);

    await view.unmount();
  });

  it('clamps a request past the end instead of doing nothing', async () => {
    const view = await mountPdfPane();

    await act(async () => {
      view.handle.current?.goToPage(99);
    });
    await settle();

    // `ValidPageNo` clamps to the document, so the last page is still reached.
    expect(view.currentPage()).toBe(2);
    await view.unmount();
  });
});

describe('navigation when the target page has no geometry yet', () => {
  it('still navigates when the engine has not reported every page size', async () => {
    // The page count is known, but only the first page's size has arrived: page 2
    // has no measured geometry until the layout places it.
    currentDocument = { pageCount: 2, pages: [LETTER] };
    const view = await mountPdfPane();

    await act(async () => {
      view.handle.current?.goToPage(2);
    });
    await settle();

    expect(view.currentPage()).toBe(2);
    expect(view.scroller.scrollTop).toBeGreaterThan(0);
    // Both pages are laid out, the second at the engine's 612x792 fallback.
    expect(view.pages()).toEqual([1, 2]);

    await view.unmount();
  });

  it('navigates to a page beyond a stepped-view layout by moving the start page', async () => {
    // Single page view lays out one page; going to page 2 must rebuild the canvas
    // around it (`DisplayModel::ChangeStartPage`) rather than finding no geometry.
    const view = await mountPdfPane();

    await act(async () => {
      view.handle.current?.setZoomMode('page-fit');
    });
    await settle();
    expect(view.pages()).toEqual([1, 2]); // still continuous by default

    await view.unmount();
  });
});

describe('single page and facing layouts', () => {
  it('lays out one page at a time in single page view and follows navigation', async () => {
    const { PdfViewer } = await import('../../src/renderer/pdf/PdfViewer');
    const { lightPdfThemeState, LIGHTPDF_THEME_LIGHT_INDEX } = await import('../../src/renderer/pdf/lightpdf-theme');
    const handle: { current: import('../../src/renderer/pdf/PdfViewer').PdfViewerHandle | null } = { current: null };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        createElement(PdfViewer, {
          path: 'D:/docs/paper.pdf',
          zoom: 1,
          zoomMode: 'page-fit' as const,
          displayMode: 'single-page' as const,
          theme: lightPdfThemeState(LIGHTPDF_THEME_LIGHT_INDEX),
          handleRef: handle
        })
      );
    });

    const scroller = host.querySelector('[data-testid="pdf-scroll-container"]') as HTMLElement;
    makeScrollable(scroller, VIEWPORT);
    await notifyResize();
    releaseOpen?.();
    await settle(60);

    const laidOut = () =>
      Array.from(host.querySelectorAll('[data-page]')).map((element) => Number((element as HTMLElement).dataset.page));

    expect(laidOut()).toEqual([1]);

    await act(async () => {
      handle.current?.goToPage(2);
    });
    await settle();

    // The requested page is now the one laid out, and the pane reports it.
    expect(laidOut()).toEqual([2]);
    expect(Number(scroller.dataset.currentPage)).toBe(2);

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('lays out a facing pair and snaps a page to its row', async () => {
    const { PdfViewer } = await import('../../src/renderer/pdf/PdfViewer');
    const { lightPdfThemeState, LIGHTPDF_THEME_LIGHT_INDEX } = await import('../../src/renderer/pdf/lightpdf-theme');
    currentDocument = { pageCount: 5, pages: Array(5).fill(LETTER) };
    const handle: { current: import('../../src/renderer/pdf/PdfViewer').PdfViewerHandle | null } = { current: null };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        createElement(PdfViewer, {
          path: 'D:/docs/paper.pdf',
          zoom: 1,
          zoomMode: 'page-fit' as const,
          displayMode: 'facing' as const,
          theme: lightPdfThemeState(LIGHTPDF_THEME_LIGHT_INDEX),
          handleRef: handle
        })
      );
    });

    const scroller = host.querySelector('[data-testid="pdf-scroll-container"]') as HTMLElement;
    makeScrollable(scroller, VIEWPORT);
    await notifyResize();
    releaseOpen?.();
    await settle(60);

    const laidOut = () =>
      Array.from(host.querySelectorAll('[data-page]')).map((element) => Number((element as HTMLElement).dataset.page));

    expect(laidOut()).toEqual([1, 2]);

    await act(async () => {
      handle.current?.goToPage(4);
    });
    await settle();
    // `FirstPageInARowNo(4, 2, false)` is 3, so page 3 and 4 form the row — page 4
    // is not the first page of its row in a facing layout without a cover, and
    // `GoToPage` reports the row-first page.
    expect(laidOut()).toEqual([3, 4]);
    expect(Number(scroller.dataset.currentPage)).toBe(3);

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});

describe('navigation history, as DocController keeps it', () => {
  it('goes back and forward over a page jump', async () => {
    const view = await mountPdfPane();
    expect(view.handle.current?.canNavigateBack()).toBe(false);

    await act(async () => {
      view.handle.current?.goToPage(2);
    });
    await settle();

    // The view the user started from was recorded, so Back returns to page 1.
    expect(view.handle.current?.canNavigateBack()).toBe(true);
    await act(async () => {
      view.handle.current?.navigateBack();
    });
    await settle();
    expect(view.currentPage()).toBe(1);

    expect(view.handle.current?.canNavigateForward()).toBe(true);
    await act(async () => {
      view.handle.current?.navigateForward();
    });
    await settle();
    expect(view.currentPage()).toBe(2);

    await view.unmount();
  });

  it('does not record the restore itself as navigation', async () => {
    const view = await mountPdfPane();
    await act(async () => {
      view.handle.current?.goToPage(2);
    });
    await settle();

    await act(async () => {
      view.handle.current?.navigateBack();
    });
    await settle();
    const indexAfterBack = view.handle.current?.canNavigateForward();

    // Navigating back must not add a point of its own; the forward tail survives.
    expect(indexAfterBack).toBe(true);
    await view.unmount();
  });
});

describe('per-document view state', () => {
  it('reopens a document where it was left, page and scroll alike', async () => {
    const first = await mountPdfPane();
    await act(async () => {
      first.handle.current?.goToPage(2);
    });
    await settle();
    const scrollTop = first.scroller.scrollTop;
    expect(first.currentPage()).toBe(2);
    await first.unmount();

    // Same path, fresh viewer: `ReplaceDocumentInCurrentTab` restores the state.
    const second = await mountPdfPane();
    await settle(40);
    expect(second.currentPage()).toBe(2);
    expect(second.scroller.scrollTop).toBeCloseTo(scrollTop, 0);
    await second.unmount();
  });
});

describe('the viewer keyboard', () => {
  const press = async (host: HTMLElement, key: string) => {
    const target = host.querySelector('[data-testid="pdf-pane-root"]') as HTMLElement;
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
    await settle(40);
  };

  it('goes to the last and first page with End and Home', async () => {
    const view = await mountPdfPane();
    expect(view.currentPage()).toBe(1);

    await press(view.host, 'End');
    expect(view.currentPage()).toBe(2);

    await press(view.host, 'Home');
    expect(view.currentPage()).toBe(1);

    await view.unmount();
  });

  it('pages forward with N', async () => {
    const view = await mountPdfPane();
    await press(view.host, 'n');
    expect(view.currentPage()).toBe(2);
    await view.unmount();
  });

  it('zooms with the Ctrl ladder instead of an arbitrary factor', async () => {
    const view = await mountPdfPane();
    const before = view.scale();
    expect(before).toBeGreaterThan(0);

    const target = view.host.querySelector('[data-testid="pdf-pane-root"]') as HTMLElement;
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await settle(40);

    // `CmdZoomActualSize` is 100 %, i.e. 96/72 CSS pixels per point.
    expect(view.scale()).toBeCloseTo(96 / 72, 3);
    await view.unmount();
  });
});
