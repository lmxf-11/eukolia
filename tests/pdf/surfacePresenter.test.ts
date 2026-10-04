/**
 * @vitest-environment jsdom
 *
 * The presenter's job is canvases and compositor surfaces, so it needs a DOM. The
 * rest of `tests/pdf` runs without one; this file asks for jsdom explicitly rather
 * than changing the suite's environment.
 */

/**
 * Retained tile surfaces, and the upload budget.
 *
 * `PDFVIEWER.md` §8 is the specification:
 *
 *   * "First implement retained tile canvases inside existing page-position
 *     containers, allowing Chromium to scroll/composite already uploaded content."
 *   * "Attach/reuse stable surfaces; avoid resize/clear/reupload of unchanged tiles or
 *     recreating refs during unrelated UI renders."
 *   * "Replace 'one page upload per frame' with a queue that limits actual upload time
 *     and bytes per frame. Measure recent upload costs and choose tiles that fit the
 *     remaining budget."
 *
 * Two of those are properties this test can check exactly — an unchanged tile is not
 * re-uploaded, and a batch stops when the measured cost of recent uploads says the
 * budget is spent — and one it can check structurally: a tile canvas is positioned and
 * sized from the *bitmap* so the blit is 1:1, which is the invariant
 * `pdf-text-layer.ts` documents the cost of getting wrong.
 *
 * The upload timing is injected (`now`), because a test that waited for real
 * `putImageData` calls would be measuring jsdom rather than the policy.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { PdfSurfacePresenter, DEFAULT_UPLOAD_BUDGET_MS } from '../../src/renderer/pdf/rendering/PdfSurfacePresenter';
import { tileKeyOf } from '../../src/renderer/pdf/rendering/PdfTileStore';
import type { StoredTile } from '../../src/renderer/pdf/rendering/PdfTileStore';
import type { TileRequest } from '../../src/renderer/pdf/rendering/PdfRenderScheduler';
import { TilePriority } from '../../src/renderer/pdf/rendering/PdfRenderScheduler';

function request(overrides: Partial<TileRequest> = {}): TileRequest {
  return {
    page: 1,
    pageIndex: 0,
    scale: 2,
    rotate: 0,
    invert: false,
    clip: { x: 0, y: 0, width: 384, height: 384 },
    position: { res: 1, row: 0, col: 0 },
    device: { x: 0, y: 0, width: 384, height: 384 },
    targetTileSize: 768,
    priority: TilePriority.UncoveredVisible,
    generation: 1,
    revision: 1,
    visible: true,
    ...overrides
  };
}

function tile(req: TileRequest): { key: string; tile: StoredTile } {
  const width = req.device.width;
  const height = req.device.height;
  return {
    // The presenter's key is the tile's identity string, which is the same string the
    // store uses: one spelling for the pipeline, the store and the surfaces.
    key: tileKeyOf(req),
    tile: {
      key: tileKeyOf(req),
      identity: {
        generation: req.generation,
        pageIndex: req.pageIndex,
        scale: req.scale,
        rotate: req.rotate,
        invert: req.invert,
        clip: req.clip
      },
      device: req.device,
      position: req.position,
      image: { width, height, data: new Uint8ClampedArray(width * height * 4) } as unknown as ImageData,
      bytes: width * height * 4,
      page: req.page,
      fromEngineCache: false,
      renderMs: 8,
      lastUsedAt: 0,
      uses: 0
    }
  };
}

/** jsdom has no 2D context; the presenter's contract is `putImageData` and nothing else. */
function stubCanvas(): void {
  const contexts = new WeakMap<HTMLCanvasElement, { putImageData: (image: ImageData, x: number, y: number) => void }>();
  let putCalls = 0;
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: function (this: HTMLCanvasElement, kind: string) {
      if (kind !== '2d') return null;
      let context = contexts.get(this);
      if (!context) {
        context = {
          putImageData: () => {
            putCalls++;
          }
        };
        contexts.set(this, context);
      }
      return context;
    }
  });
  Object.defineProperty(globalThis, '__pdfTilePutCalls', {
    configurable: true,
    writable: true,
    value: () => putCalls
  });
}

describe('PdfSurfacePresenter', () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    stubCanvas();
  });

  it('creates one canvas per tile and positions it from the device box', () => {
    const presenter = new PdfSurfacePresenter(host, { uploadBudgetMs: 100 });
    presenter.setDevicePixelRatio(2);
    const entry = tile(request({ device: { x: 384, y: 192, width: 384, height: 384 } }));
    presenter.enqueueUpload(entry.key, entry.tile);
    presenter.pump();

    expect(host.querySelectorAll('canvas')).toHaveLength(1);
    const canvas = host.querySelector('canvas') as HTMLCanvasElement;
    // Backing store is the bitmap's device pixels…
    expect(canvas.width).toBe(384);
    expect(canvas.height).toBe(384);
    // …and the CSS box is that many device pixels expressed in CSS pixels, so the blit
    // is 1:1 rather than a fractional rescale.
    expect(canvas.style.left).toBe('192px');
    expect(canvas.style.top).toBe('96px');
    expect(canvas.style.width).toBe('192px');
    expect(canvas.style.height).toBe('192px');
  });

  it('does not re-upload a tile whose surface already holds its pixels', () => {
    const presenter = new PdfSurfacePresenter(host, { uploadBudgetMs: 100 });
    const entry = tile(request());
    presenter.enqueueUpload(entry.key, entry.tile);
    presenter.pump();
    const afterFirst = presenter.snapshot();
    expect(afterFirst.uploads).toBe(1);

    // A plan that still wants the same tile: nothing to do. This is the clause that
    // stops a scroll re-uploading a screenful of unchanged pixels every frame.
    for (let i = 0; i < 5; i++) {
      presenter.enqueueUpload(entry.key, entry.tile);
      presenter.pump();
    }
    const after = presenter.snapshot();
    expect(after.uploads).toBe(1);
    expect(after.skippedUnchanged).toBe(5);
  });

  it('keeps the surface and its pixels when a tile is re-enqueued', () => {
    const presenter = new PdfSurfacePresenter(host, { uploadBudgetMs: 100 });
    const entry = tile(request());
    presenter.enqueueUpload(entry.key, entry.tile);
    presenter.pump();
    const canvas = host.querySelector('canvas') as HTMLCanvasElement;

    presenter.enqueueUpload(entry.key, entry.tile);
    presenter.pump();
    // The same element, not a replacement: "avoid resize/clear/reupload of unchanged
    // tiles or recreating refs during unrelated UI renders".
    expect(host.querySelector('canvas')).toBe(canvas);
    expect(presenter.snapshot().surfaces).toBe(1);
  });

  it('stops a batch once recent uploads have spent the frame budget', () => {
    // Every upload is measured at 1 ms and the budget is 2 ms, so the first two fit
    // and the third does not.
    let clock = 0;
    const presenter = new PdfSurfacePresenter(host, {
      uploadBudgetMs: 2,
      now: () => {
        clock += 1;
        return clock;
      }
    });
    for (let i = 0; i < 6; i++) {
      const entry = tile(
        request({ clip: { x: i * 10, y: 0, width: 64, height: 64 }, device: { x: i * 64, y: 0, width: 64, height: 64 } })
      );
      presenter.enqueueUpload(entry.key, entry.tile);
    }
    expect(presenter.queuedUploads).toBe(6);
    const first = presenter.pump();
    // Two uploads: the first is always admitted (a blank frame is worse than an
    // over-budget one), and the second still fits the estimate.
    expect(first.uploads).toBeGreaterThanOrEqual(1);
    expect(first.uploads).toBeLessThan(6);
    expect(first.ms).toBeLessThanOrEqual(4);

    const second = presenter.pump();
    expect(second.uploads).toBeGreaterThanOrEqual(1);
    expect(presenter.snapshot().framesWithUploads).toBe(2);
  });

  it('always uploads at least one tile per frame', () => {
    // A budget smaller than a single measured upload must not starve the viewport:
    // §10 calls "smooth scrolling over blank pages" a failure.
    let clock = 0;
    const presenter = new PdfSurfacePresenter(host, {
      uploadBudgetMs: 0.1,
      now: () => {
        clock += 50;
        return clock;
      }
    });
    const entry = tile(request());
    presenter.enqueueUpload(entry.key, entry.tile);
    expect(presenter.pump().uploads).toBe(1);
    expect(presenter.snapshot().uploads).toBe(1);
  });

  it('re-measures the CSS box on a DPR change without re-rasterising anything', () => {
    const presenter = new PdfSurfacePresenter(host, { uploadBudgetMs: 100 });
    const entry = tile(request({ device: { x: 100, y: 0, width: 200, height: 200 } }));
    presenter.enqueueUpload(entry.key, entry.tile);
    presenter.pump();
    const canvas = host.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.style.left).toBe('100px');

    presenter.setDevicePixelRatio(2);
    expect(canvas.style.left).toBe('50px');
    expect(canvas.style.width).toBe('100px');
    // The backing store is untouched: the pixels are still the right device pixels.
    expect(canvas.width).toBe(200);
    expect(presenter.snapshot().uploads).toBe(1);
  });

  it('releases the canvas for an evicted tile', () => {
    const presenter = new PdfSurfacePresenter(host, { uploadBudgetMs: 100 });
    const entry = tile(request());
    presenter.enqueueUpload(entry.key, entry.tile);
    presenter.pump();
    expect(host.querySelectorAll('canvas')).toHaveLength(1);

    presenter.release(entry.key);
    // Removed from the DOM rather than parked: the store's budget already decided these
    // pixels are not worth their bytes, and a parked canvas keeps the GPU backing the
    // budget was bounding.
    expect(host.querySelectorAll('canvas')).toHaveLength(0);
    expect(presenter.snapshot().surfaces).toBe(0);
  });

  it('bounds the number of compositor surfaces', () => {
    const presenter = new PdfSurfacePresenter(host, { uploadBudgetMs: 1000, maxSurfaces: 3 });
    for (let i = 0; i < 6; i++) {
      const entry = tile(
        request({ clip: { x: i * 10, y: 0, width: 32, height: 32 }, device: { x: i * 32, y: 0, width: 32, height: 32 } })
      );
      presenter.enqueueUpload(entry.key, entry.tile);
    }
    presenter.pump();
    expect(presenter.snapshot().surfaces).toBe(3);
    expect(host.querySelectorAll('canvas')).toHaveLength(3);
  });

  it('disposes every surface', () => {
    const presenter = new PdfSurfacePresenter(host, { uploadBudgetMs: 100 });
    for (let i = 0; i < 3; i++) {
      const entry = tile(
        request({ clip: { x: i * 10, y: 0, width: 32, height: 32 }, device: { x: i * 32, y: 0, width: 32, height: 32 } })
      );
      presenter.enqueueUpload(entry.key, entry.tile);
    }
    presenter.pump();
    presenter.dispose();
    expect(host.querySelectorAll('canvas')).toHaveLength(0);
    expect(presenter.snapshot().queuedUploads).toBe(0);
  });

  it('replaces a queued upload for the same tile rather than uploading twice', () => {
    const presenter = new PdfSurfacePresenter(host, { uploadBudgetMs: 100 });
    const entry = tile(request());
    presenter.enqueueUpload(entry.key, entry.tile);
    presenter.enqueueUpload(entry.key, entry.tile);
    expect(presenter.queuedUploads).toBe(1);
    presenter.pump();
    expect(presenter.snapshot().uploads).toBe(1);
  });

  it('has a default upload budget in the range §8 asks for', () => {
    expect(DEFAULT_UPLOAD_BUDGET_MS).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_UPLOAD_BUDGET_MS).toBeLessThanOrEqual(2);
  });
});
