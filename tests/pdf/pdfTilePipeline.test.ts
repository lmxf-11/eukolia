/**
 * @vitest-environment jsdom
 *
 * The pipeline's contract with a DOM: canvases come from the presenter, so it needs one.
 */

/**
 * The tiled pipeline: plan, render, upload, fall back, and stop.
 *
 * `PDFTilePipeline` is the seam between the tested modules and the viewer, so this is
 * where the *whole* path is exercised: a viewport moves, the pipeline decides what to
 * rasterise, the scheduler drives the engine, the store keeps the pixels, the presenter
 * puts them on a canvas, and the status the viewer publishes says what happened.
 *
 * The three behaviours that only exist at this level — and that
 * `PDFVIEWER.md` §6/§7/§8 ask for by name — are:
 *
 *   * **generation discipline**: a reply from a document read that has been superseded is
 *     discarded, and a re-read retires the previous read's tiles (§5);
 *   * **stale-result rejection**: a reply whose request the planner has withdrawn never
 *     reaches a surface (§7);
 *   * **budget discipline**: a page below the area threshold is never tiled, so the
 *     whole-page path keeps doing the work where it is cheaper (§6).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { PdfTilePipeline, type PipelinePage, type PipelineViewport } from '../../src/renderer/pdf/rendering/PdfTilePipeline';
import { PdfRenderMetrics } from '../../src/renderer/pdf/rendering/PdfRenderMetrics';
import type { PdfRenderResult } from '../../src/shared/ipc';

/** A US-Letter page in points, as the engine reports it. */
const LETTER = { width: 612, height: 792 };

/** A page laid out at `scale` CSS px per point, with the viewport at the top-left. */
function page(scale: number, offsetY = 0): PipelinePage {
  return {
    page: 1,
    box: LETTER,
    layoutScale: scale,
    sheet: { width: LETTER.width * scale, height: LETTER.height * scale },
    offset: { x: 0, y: offsetY }
  };
}

function viewport(scale: number, overrides: Partial<PipelineViewport> = {}): PipelineViewport {
  const dpr = overrides.devicePixelRatio ?? 1;
  return {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    devicePixelRatio: dpr,
    generation: 1,
    resolution: 1,
    renderScale: scale * dpr,
    invert: false,
    renderAheadPages: 1,
    ...overrides
  };
}

/** An engine that answers with the exact region it was asked for, when told to. */
interface EngineCall {
  pageIndex: number;
  scale: number;
  clip: { x: number; y: number; width: number; height: number };
  tile: { res: number; row: number; col: number };
  targetTileSize: number;
  invert: boolean;
}

function makeEngine(): {
  calls: EngineCall[];
  render: (request: EngineCall, requestId: number) => Promise<PdfRenderResult>;
  /** Replies the engine owes; `resolveAll` settles them in the order they arrived. */
  pending: { resolve: () => void; requestId: number }[];
  resolveAll: () => void;
} {
  const calls: EngineCall[] = [];
  const pending: { resolve: () => void; requestId: number }[] = [];

  const render = (request: EngineCall, requestId: number): Promise<PdfRenderResult> => {
    calls.push(request);
    const width = Math.max(1, Math.round(request.clip.width * request.scale));
    const height = Math.max(1, Math.round(request.clip.height * request.scale));
    const result: PdfRenderResult = {
      requestId,
      page: request.pageIndex,
      width,
      height,
      stride: width * 4,
      channels: 4,
      order: 'rgba',
      pageRect: { ...request.clip },
      pixels: new Uint8Array(width * height * 4),
      fromEngineCache: false
    };
    return new Promise<PdfRenderResult>((resolve) => {
      pending.push({ resolve: () => resolve(result), requestId });
    });
  };

  return {
    calls,
    render,
    pending,
    resolveAll: () => {
      for (const entry of pending.splice(0, pending.length)) entry.resolve();
    }
  };
}

/**
 * Drain the microtask queue until the pipeline has nothing left in flight.
 *
 * A plan queues dozens of tiles and the scheduler admits a few at a time, so a fixed
 * number of `await`s is a guess about how many admissions the budget allows. This waits
 * for the condition instead, with a bound so a regression fails rather than hangs.
 */
async function settle(pipeline: PdfTilePipeline, engine: ReturnType<typeof makeEngine>): Promise<void> {
  for (let round = 0; round < 400; round++) {
    if (engine.pending.length === 0 && pipeline.status().scheduler.active === 0) return;
    engine.resolveAll();
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
  throw new Error('the pipeline never settled');
}

function stubCanvas(): void {
  Object.defineProperty(globalThis, 'ImageData', { configurable: true, writable: true, value: class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  } });
  // jsdom has no 2D context. The presenter only needs `putImageData` to succeed.
  const context = { putImageData: () => undefined };
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: (kind: string) => (kind === '2d' ? context : null)
  });
}

describe('tile integration regressions', () => {
  beforeEach(stubCanvas);
  it('wakes an idle viewer on completion and restores cached pixels after remount', async () => {
    const engine = makeEngine(); let wakes = 0;
    const pipeline = new PdfTilePipeline({render: engine.render, cancel: () => undefined, onNeedsFrame: () => { wakes++; }});
    const host = document.createElement('div');
    pipeline.setPageHost(1, host);
    pipeline.setViewport(viewport(6, { renderAheadPages: 0 }));
    pipeline.plan([page(6)]);
    await settle(pipeline, engine);
    expect(wakes).toBeGreaterThan(0);
    pipeline.pumpUploads();
    expect(host.querySelector('canvas')).not.toBeNull();
    const requests = engine.calls.length;
    pipeline.setPageHost(1, null);
    const replacement = document.createElement('div');
    pipeline.setPageHost(1, replacement);
    pipeline.plan([page(6)]);
    expect(replacement.querySelector('canvas')).not.toBeNull();
    expect(engine.calls.length).toBe(requests);
    pipeline.dispose();
  });

  it('uses point-space clips and bounded surfaces at high zoom', async () => {
    const engine = makeEngine();
    const pipeline = new PdfTilePipeline({render: engine.render, cancel: () => undefined});
    pipeline.setPageHost(1, document.createElement('div'));
    pipeline.setViewport(viewport(12, {renderAheadPages: 0}));
    pipeline.plan([page(12)]);
    await settle(pipeline, engine);
    expect(engine.calls.length).toBeGreaterThan(0);
    for (const call of engine.calls) {
      expect(call.clip.width * call.scale).toBeLessThanOrEqual(1024);
      expect(call.clip.height * call.scale).toBeLessThanOrEqual(1024);
      expect(call.clip.x + call.clip.width).toBeLessThanOrEqual(LETTER.width);
    }
    pipeline.dispose();
  });
});

describe('PdfTilePipeline', () => {
  let host: HTMLElement;
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    stubCanvas();
    engine = makeEngine();
  });

  function makePipeline(overrides: { metrics?: PdfRenderMetrics; maxActive?: number } = {}): PdfTilePipeline {
    return new PdfTilePipeline({
      render: engine.render,
      cancel: () => undefined,
      metrics: overrides.metrics ?? null,
      maxActive: overrides.maxActive ?? 4,
      targetTileSize: 256
    });
  }

  it('does not tile a page whose device area is below the threshold', () => {
    const pipeline = makePipeline();
    pipeline.setViewport(viewport(1));
    // Letter at 1x is 0.48 M device px: one upload, no tile round trips.
    expect(pipeline.shouldTile(page(1))).toBe(false);
    expect(pipeline.plan([page(1)])).toBe(0);
    expect(engine.calls).toHaveLength(0);
    expect(pipeline.status().tiledPages).toBe(0);
  });

  it('tiles a page once its device area is worth the overhead, and stops when it is not', () => {
    const pipeline = makePipeline();
    pipeline.setViewport(viewport(4));
    expect(pipeline.shouldTile(page(4))).toBe(true);
    // Letter at 4x is 7.75 M device px.
    expect(pipeline.plan([page(4)])).toBeGreaterThan(1);
    expect(engine.calls.length).toBeGreaterThan(1);
    expect(pipeline.status().tiledPages).toBe(1);

    // Zooming back out returns the page to the whole-page path (§6).
    pipeline.setViewport(viewport(1));
    pipeline.plan([page(1)]);
    expect(pipeline.status().tiledPages).toBe(0);
  });

  it('requests tiles that cover the viewport and no others', async () => {
    const pipeline = makePipeline();
    pipeline.setViewport(viewport(6, { devicePixelRatio: 1, renderAheadPages: 0 }));
    pipeline.setPageHost(1, host);
    pipeline.plan([page(6)]);

    // Every call is inside the page box and inside the viewport plus overscan.
    await settle(pipeline, engine);
    const box = { width: LETTER.width * 6, height: LETTER.height * 6 };
    for (const call of engine.calls) {
      expect(call.clip.x).toBeGreaterThanOrEqual(0);
      expect(call.clip.y).toBeGreaterThanOrEqual(0);
      expect((call.clip.x + call.clip.width) * 6).toBeLessThanOrEqual(box.width + 2);
      expect((call.clip.y + call.clip.height) * 6).toBeLessThanOrEqual(box.height + 2);
    }
    // The first visible band must have been asked for: the reader starts at the top of
    // the page, which is the highest device y, so a plan that only asked for the bottom
    // would be a row-convention bug.
    // MuPDF clips are top-down; only tile *addresses* have a bottom-origin row.
    expect(Math.min(...engine.calls.map((call) => call.clip.y))).toBe(0);
    expect(engine.calls.every((call) => call.clip.y < 600 / 6)).toBe(true);

    await settle(pipeline, engine);
    pipeline.pumpUploads();
    expect(host.querySelectorAll('canvas').length).toBeGreaterThan(0);
    expect(pipeline.status().residentTiles).toBeGreaterThan(0);
  });

  it('does not re-request a tile it already has', async () => {
    const pipeline = makePipeline();
    pipeline.setViewport(viewport(6, { renderAheadPages: 0 }));
    pipeline.setPageHost(1, host);
    pipeline.plan([page(6)]);
    await settle(pipeline, engine);
    const first = engine.calls.length;
    expect(first).toBeGreaterThan(0);

    // The same plan again: everything it wanted is resident, so nothing is asked for.
    const scheduled = pipeline.plan([page(6)]);
    expect(scheduled).toBe(0);
    expect(engine.calls.length).toBe(first);
  });

  it('withdraws queued jobs when the viewport moves away', async () => {
    const cancelled: number[] = [];
    const pipeline = new PdfTilePipeline({
      render: engine.render,
      cancel: (requestId) => cancelled.push(requestId),
      maxActive: 1,
      targetTileSize: 256
    });
    pipeline.setViewport(viewport(6, { renderAheadPages: 0 }));
    pipeline.plan([page(6)]);
    const queued = pipeline.status().scheduler.queued;
    expect(queued).toBeGreaterThan(0);

    // Scroll far past the page: its tiles are no longer wanted.
    pipeline.setViewport(viewport(6, { y: LETTER.height * 6, renderAheadPages: 0 }));
    pipeline.plan([page(6)]);
    await Promise.resolve();

    expect(cancelled.length).toBeGreaterThan(0);
    expect(pipeline.status().scheduler.queued).toBeLessThan(queued);
  });

  it('retires the previous document generation and its tiles on a re-read', async () => {
    const pipeline = makePipeline();
    pipeline.setViewport(viewport(6, { generation: 1, renderAheadPages: 0 }));
    pipeline.setPageHost(1, host);
    pipeline.plan([page(6)]);
    await settle(pipeline, engine);
    const beforeReload = pipeline.status().residentTiles;
    expect(beforeReload).toBeGreaterThan(0);

    // A re-read: new generation, new revision, same geometry.
    pipeline.setViewport(viewport(6, { generation: 2, resolution: 2, renderAheadPages: 0 }));
    expect(pipeline.status().residentTiles).toBe(0);
    // …and the plan asks again, for the new generation's pixels.
    const scheduled = pipeline.plan([page(6)]);
    expect(scheduled).toBeGreaterThan(0);
    expect(engine.calls.length).toBeGreaterThan(beforeReload);
  });

  it('discards a reply whose region the planner has withdrawn', async () => {
    const pipeline = makePipeline();
    pipeline.setViewport(viewport(6, { renderAheadPages: 0 }));
    pipeline.setPageHost(1, host);
    pipeline.plan([page(6)]);
    const inflight = engine.pending.length;
    expect(inflight).toBeGreaterThan(0);

    // The reader jumps to a different document generation before the reply lands.
    pipeline.setViewport(viewport(6, { generation: 2, resolution: 2, renderAheadPages: 0 }));
    // Resolve the *old* replies now: they must not become tiles of the new generation.
    for (const entry of engine.pending.splice(0, inflight)) entry.resolve();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(pipeline.status().residentTiles).toBe(0);
  });

  it('refuses a malformed payload instead of drawing it', async () => {
    const pipeline = makePipeline();
    // A reply that claims a tile-sized bitmap and hands back nothing.
    const badEngine = new PdfTilePipeline({
      render: async (_request, requestId) => ({
        requestId,
        page: 0,
        width: 256,
        height: 256,
        stride: 256 * 4,
        channels: 4,
        order: 'rgba',
        pageRect: { x: 0, y: 0, width: 32, height: 32 },
        pixels: new Uint8Array(4)
      }),
      cancel: () => undefined,
      targetTileSize: 256
    });
    badEngine.setViewport(viewport(6, { renderAheadPages: 0 }));
    badEngine.setPageHost(1, host);
    badEngine.plan([page(6)]);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(badEngine.status().residentTiles).toBe(0);
    pipeline.dispose();
    badEngine.dispose();
  });

  it('reports a status the viewer can publish', async () => {
    const seen: string[] = [];
    const pipeline = new PdfTilePipeline({
      render: engine.render,
      cancel: () => undefined,
      targetTileSize: 256,
      onStatus: (status) => seen.push(`${status.tiledPages}:${status.residentTiles}`)
    });
    pipeline.setViewport(viewport(6, { renderAheadPages: 0 }));
    pipeline.plan([page(6)]);
    expect(seen.length).toBeGreaterThan(0);
    expect(pipeline.status().active).toBe(true);
    expect(pipeline.status().scheduler.active + pipeline.status().scheduler.queued).toBeGreaterThan(0);
  });

  it('records its work in the metrics when they are switched on', async () => {
    const metrics = new PdfRenderMetrics();
    metrics.enabled = true;
    const pipeline = makePipeline({ metrics });
    pipeline.setViewport(viewport(6, { renderAheadPages: 0 }));
    pipeline.setPageHost(1, host);
    pipeline.plan([page(6)]);
    await settle(pipeline, engine);
    pipeline.pumpUploads();

    const snapshot = metrics.snapshot();
    expect(snapshot.requests.submitted).toBeGreaterThan(0);
    expect(snapshot.render.completed).toBeGreaterThan(0);
    expect(snapshot.render.transportBytes).toBeGreaterThan(0);
    expect(snapshot.upload.count).toBeGreaterThan(0);
    expect(snapshot.cache.residentTiles).toBeGreaterThan(0);
  });

  it('disposes every surface and stops the scheduler', async () => {
    const pipeline = makePipeline();
    pipeline.setViewport(viewport(6, { renderAheadPages: 0 }));
    pipeline.setPageHost(1, host);
    pipeline.plan([page(6)]);
    await settle(pipeline, engine);
    pipeline.pumpUploads();
    expect(host.querySelectorAll('canvas').length).toBeGreaterThan(0);

    pipeline.dispose();
    expect(host.querySelectorAll('canvas')).toHaveLength(0);
    expect(pipeline.status().surfaces).toBe(0);
    expect(pipeline.status().residentTiles).toBe(0);
  });

  it('never asks the engine to rotate the raster', () => {
    // The page's own `/Rotate` is inside the engine's page space and the viewer's
    // rotation is a CSS transform; a tile request that rotated would apply one of them
    // twice. The pipeline has no rotation input at all, which is how that is enforced.
    const pipeline = makePipeline();
    pipeline.setViewport(viewport(6, { renderAheadPages: 0 }));
    pipeline.plan([page(6)]);
    expect(engine.calls.length).toBeGreaterThan(0);
    // The render function the pipeline calls has no `rotate` member at all, which is how
    // that is enforced; this asserts the shape of what it *does* send, which is the
    // contract the viewer maps onto `pdfRender`.
    for (const call of engine.calls) {
      expect(Object.keys(call).sort()).toEqual(['clip', 'invert', 'pageIndex', 'scale', 'targetTileSize', 'tile']);
      expect(call.targetTileSize).toBe(256);
    }
  });
});
