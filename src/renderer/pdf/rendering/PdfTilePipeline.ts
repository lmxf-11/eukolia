/**
 * Eukolia — the tiled render pipeline, wired to one document.
 *
 * ## Why this module exists
 *
 * `PdfViewer.tsx` is five thousand lines that own the document lifecycle, the layout
 * model, selection, search, SyncTeX and the chrome. Dropping a scheduler, a tile
 * store, a surface presenter and a viewport controller into it directly would mean
 * four more pieces of state in a component that re-renders on every page crossing,
 * and `PDFVIEWER.md` §4 is explicit that this is the wrong shape:
 *
 * > React owns chrome, document lifecycle, coarse layout/mount windows, and
 * > accessible UI. A viewer controller owns frame-sensitive scroll state, request
 * > scheduling, tile lifetimes, and uploads. React should receive current-page/zoom/
 * > status updates only when useful values change, not a render for every wheel event
 * > or completed pixel block.
 *
 * So this class owns the frame-sensitive half, and the viewer owns a single reference
 * to it. The viewer's job becomes: tell it which pages are where, tell it what the
 * viewport shows, tell it where the DOM hosts are, and draw whatever it says is ready.
 * Every policy decision — tiling or not, which tiles, in what order, how many, when to
 * stop uploading, what to drop — lives here or in the module it delegates to.
 *
 * ## What it is *not*
 *
 * It does not replace the whole-page path. `PDFVIEWER.md` §11 phase 3 asks for exactly
 * that arrangement: "Retain current page presentation as a rollback path during
 * development", and §6 wants a whole-page path kept "for sufficiently small pages where
 * tiling adds overhead". A page below {@link WHOLE_PAGE_MAX_DEVICE_AREA} is never
 * tiled, and a document whose worker cannot tile
 * (`PdfTileCapabilities.tiledRender === false`) is never tiled at all.
 *
 * ## The three-generation rule
 *
 * `PDFVIEWER.md` §6: "Keep old-scale/coarse pixels behind newly arriving tiles and
 * replace only valid covered areas… Track coverage and generation per surface." The
 * pipeline holds three things apart, and they are easy to conflate:
 *
 *   * the **generation** the viewer's planner is asking for (document revision ×
 *     scale × invert) — a reply from any other one is discarded;
 *   * the **exact** tiles of the current plan, which the surfaces show on top;
 *   * the **fallback** tiles of another scale of the same generation, shown underneath
 *     so a zoom or a resize is continuous rather than blank.
 *
 * Copyright 2026 the Eukolia project authors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PdfRect, PdfRenderResult } from '../../../shared/ipc';
import { describePixelPayload, toImageData } from '../pdf-image';
import {
  DEFAULT_UPLOAD_BUDGET_MS,
  PdfRenderMetrics,
  PdfRenderScheduler,
  PdfSurfacePresenter,
  PdfTileStore,
  TILE_TARGET_PX,
  TilePriority,
  WHOLE_PAGE_MAX_DEVICE_AREA,
  gridSize,
  overscanForViewport,
  pageDeviceBox,
  tileKeyOf,
  tileResForDeviceBox,
  tileSpecFor,
  visibleTiles,
  type DeviceRect,
  type SchedulerSnapshot,
  type TilePosition,
  type TileRequest,
  type TileRequestStatus
} from './index';

/** One page the viewer has laid out, as the pipeline needs to see it. */
export interface PipelinePage {
  /** 1-based page number, the viewer's own convention. */
  page: number;
  /** The page's box in PDF points, already carrying its own `/Rotate`. */
  box: { width: number; height: number };
  /** The page's scale in CSS pixels per point (`LightPdfLayoutPage::zoomReal`). */
  layoutScale: number;
  /** The page sheet's box in CSS pixels, after the viewer's rotation. */
  sheet: { width: number; height: number };
  /** The sheet's offset in the scroller's content space, in CSS pixels. */
  offset: { x: number; y: number };
  rotation?: number;
}

/** What the viewport shows, in the scroller's content space, in CSS pixels. */
export interface PipelineViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  devicePixelRatio: number;
  /** Document revision; a re-read of the file is a new one. */
  generation: number;
  resolution: number;
  /** CSS pixels per point for the *scale* being rasterised (not the layout scale). */
  renderScale: number;
  invert: boolean;
  /** `pdf.renderAheadPages`, as the overscan policy uses it. */
  renderAheadPages: number;
}

/** The engine call the pipeline drives, supplied by the viewer. */
export type PipelineRenderFn = (
  request: {
    pageIndex: number;
    scale: number;
    clip: PdfRect;
    tile: { res: number; row: number; col: number };
    targetTileSize: number;
    invert: boolean;
  },
  requestId: number
) => Promise<PdfRenderResult>;

export type PipelineCancelFn = (requestId: number) => void;

export interface PipelineOptions {
  render: PipelineRenderFn;
  cancel: PipelineCancelFn;
  metrics?: PdfRenderMetrics | null;
  uploadBudgetMs?: number;
  /** Device pixels per tile side. Defaults to {@link TILE_TARGET_PX}. */
  targetTileSize?: number;
  maxActive?: number;
  maxQueuedBytes?: number;
  onStatus?: (status: PipelineStatus) => void;
  now?: () => number;
  /** Wake the host's frame pump when asynchronous work becomes ready. */
  onNeedsFrame?: () => void;
  onError?: (message: string) => void;
}

/** What the viewer publishes as `data-pdf-tiles`, for probes and for the status line. */
export interface PipelineStatus {
  /** True when this document's worker can tile and at least one page is being tiled. */
  active: boolean;
  /** Pages currently rendered in tiles rather than whole. */
  tiledPages: number;
  residentTiles: number;
  residentBytes: number;
  queuedUploads: number;
  surfaces: number;
  /** Milliseconds the last upload batch took. */
  lastUploadMs: number;
  scheduler: SchedulerSnapshot;
}

/**
 * The tile target when the caller names none.
 *
 * `PDFVIEWER.md` §6 asks for the 512–1024 range to be prototyped and measured rather
 * than asserted; `TILE_TARGET_PX` is that range's middle and lives in the geometry
 * module with the formula that consumes it, so a tuning change happens in one place.
 */
const DEFAULT_TARGET_TILE_SIZE = TILE_TARGET_PX;

export class PdfTilePipeline {
  private readonly store: PdfTileStore;
  private readonly scheduler: PdfRenderScheduler;
  private readonly metrics: PdfRenderMetrics | null;
  private readonly renderFn: PipelineRenderFn;
  private readonly onStatus: ((status: PipelineStatus) => void) | null;
  private readonly onNeedsFrame: () => void;
  private readonly onError: (message: string) => void;
  private preservingFallback = false;
  private covered = false;

  private readonly hosts = new Map<number, HTMLElement>();
  private readonly presenters = new Map<number, PdfSurfacePresenter>();
  /** Pages the pipeline decided to tile, and why not when it did not. */
  private readonly tiledPages = new Set<number>();
  /** The tiles the current plan wants, so a re-plan can tell what changed. */
  private readonly wanted = new Map<string, TileRequest>();
  /** The request id of each in-flight or queued job, by tile key. */
  private readonly requestIds = new Map<string, number>();

  readonly targetTileSize: number;

  private viewport: PipelineViewport = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    devicePixelRatio: 1,
    generation: 0,
    resolution: 0,
    renderScale: 1,
    invert: false,
    renderAheadPages: 1
  };
  private moveToken: { at: number } | null = null;
  private converged = false;
  private lastUploadMs = 0;

  constructor(options: PipelineOptions) {
    this.renderFn = options.render;
    this.metrics = options.metrics ?? null;
    this.onStatus = options.onStatus ?? null;
    this.onNeedsFrame = options.onNeedsFrame ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.uploadBudgetMs = options.uploadBudgetMs ?? DEFAULT_UPLOAD_BUDGET_MS;
    this.targetTileSize = Math.max(64, Math.round(options.targetTileSize ?? DEFAULT_TARGET_TILE_SIZE));

    this.store = new PdfTileStore({
      maxBytes: Math.max(8 * 1024 * 1024, (options.maxQueuedBytes ?? 48 * 1024 * 1024) * 4),
      maxTiles: 512
    });
    this.store.onEvict = (tile) => {
      // The surface holds the pixels (a canvas is not free), so an evicted tile must
      // give its canvas back: the store's budget decided those bytes are not worth
      // holding, and a parked canvas would keep exactly the GPU backing it bounded.
      if (!this.preservingFallback) for (const presenter of this.presenters.values()) presenter.release(tile.key);
    };

    this.scheduler = new PdfRenderScheduler(
      (request, requestId) => this.runRender(request, requestId),
      options.cancel ?? (() => undefined),
      {
        maxActive: options.maxActive ?? 4,
        maxQueuedBytes: options.maxQueuedBytes ?? 48 * 1024 * 1024,
        maxQueuedJobs: 32,
        metrics: this.metrics,
        now: options.now
      }
    );
    this.scheduler.onComplete = (completion) => this.onTileComplete(completion);
  }

  // ------------------------------------------------------------------ wiring

  /** Attach a DOM host for a page's tile canvases. */
  setPageHost(page: number, host: HTMLElement | null): void {
    const existing = this.presenters.get(page);
    if (!host) {
      this.hosts.delete(page);
      if (existing) {
        existing.dispose();
        this.presenters.delete(page);
      }
      this.tiledPages.delete(page);
      return;
    }
    if (existing && this.hosts.get(page) === host) return;
    if (existing) existing.dispose();
    this.hosts.set(page, host);
    this.presenters.set(page, new PdfSurfacePresenter(host, { uploadBudgetMs: this.uploadBudgetMs, metrics: this.metrics }));
  }

  /** The upload budget per frame, in milliseconds. */
  uploadBudgetMs = DEFAULT_UPLOAD_BUDGET_MS;

  /** Publish the viewport. Call from the coalesced frame callback, not per event. */
  setViewport(viewport: PipelineViewport): void {
    const previousGeneration = this.viewport.generation;
    const generationChanged = viewport.generation !== this.viewport.generation;
    const scaleChanged = viewport.renderScale !== this.viewport.renderScale;
    const dprChanged = viewport.devicePixelRatio !== this.viewport.devicePixelRatio;
    const moved =
      viewport.x !== this.viewport.x ||
      viewport.y !== this.viewport.y ||
      viewport.width !== this.viewport.width ||
      viewport.height !== this.viewport.height;
    this.viewport = viewport;

    if (generationChanged) {
      // §5: "old generations cannot reenter after reload". Queued work for the previous
      // revision is withdrawn and its store entries dropped, while the pixels already
      // on screen stay until new ones arrive — which is the viewer's existing rebuild
      // behaviour and is what §6 asks to preserve.
      this.scheduler.dropGeneration(previousGeneration);
      this.preservingFallback = true;
      this.store.beginGeneration(viewport.generation);
      this.preservingFallback = false;
      this.wanted.clear();
      this.requestIds.clear();
    } else if (this.store.currentGeneration !== viewport.generation) {
      this.store.beginGeneration(viewport.generation);
    }
    if (scaleChanged || dprChanged) {
      for (const presenter of this.presenters.values()) presenter.setDevicePixelRatio(viewport.devicePixelRatio);
    }
    if (moved || scaleChanged || generationChanged) {
      this.converged = false;
      this.covered = false;
      this.moveToken = this.metrics?.recordViewportMove() ?? null;
    }
  }

  /** True when this page's device area and grid make tiling worthwhile. */
  shouldTile(page: PipelinePage): boolean {
    const device = pageDeviceBox(page.box, page.layoutScale * this.viewport.devicePixelRatio);
    if (device.width <= 0 || device.height <= 0) return false;
    const res = tileResForDeviceBox(device.width, device.height, false, this.targetTileSize);
    const grid = gridSize(res);
    if (grid * grid < 2) return false;
    // The same area threshold the geometry module owns, so the policy cannot drift.
    return device.width * device.height > WHOLE_PAGE_MAX_DEVICE_AREA;
  }

  /**
   * Plan the tiles the viewport needs, and queue what is missing.
   *
   * Called once per plan revision, never per frame: everything in it is either
   * arithmetic over the mounted pages or a store lookup, and the store lookups are what
   * make a re-plan cheap (a tile that is resident contributes nothing).
   *
   * The priority each tile gets is `PDFVIEWER.md` §7's order, and it is decided from two
   * rectangles per page rather than from a zoom threshold:
   *
   *   1. a tile of the viewport with no pixels at all — `UncoveredVisible`;
   *   2. a tile of the viewport that only has a coarser fallback —
   *      `SharpnessUpgrade`;
   *   3. a tile just outside it, within the overscan — `NearPrefetch`;
   *   4. anything further — `DistantSpeculation`.
   */
  plan(pages: readonly PipelinePage[]): number {
    let scheduled = 0;
    const wantedKeys = new Set<string>();
    this.tiledPages.clear();
    for (const presenter of this.presenters.values()) presenter.demote();

    for (const page of pages) {
      if (!this.shouldTile(page)) {
        this.presenters.get(page.page)?.retain(new Set());
        continue;
      }
      this.tiledPages.add(page.page);

      const renderScale = page.layoutScale * this.viewport.devicePixelRatio;
      const device = pageDeviceBox(page.box, renderScale);
      const res = tileResForDeviceBox(device.width, device.height, false, this.targetTileSize);
      // The viewer plans in content space but a tile lives in the page's own device
      // space, so both rectangles are translated here. Doing it here rather than asking
      // the caller for a per-page rect keeps one definition of "what this page shows".
      const dpr = this.viewport.devicePixelRatio;
      const x = this.viewport.x - page.offset.x;
      const y = this.viewport.y - page.offset.y;
      const w = this.viewport.width;
      const h = this.viewport.height;
      const unrotate = (u: number, v: number) => {
        switch (page.rotation) {
          case 90: return { x: v, y: page.sheet.height - u };
          case 180: return { x: page.sheet.width - u, y: page.sheet.height - v };
          case 270: return { x: page.sheet.width - v, y: u };
          default: return { x: u, y: v };
        }
      };
      const a = unrotate(x, y), b = unrotate(x + w, y + h);
      const ratio = renderScale / page.layoutScale;
      const viewportRect: DeviceRect = {
        x: Math.min(a.x, b.x) * ratio, y: Math.min(a.y, b.y) * ratio,
        width: Math.abs(b.x - a.x) * ratio, height: Math.abs(b.y - a.y) * ratio
      };
      const overscan = overscanForViewport(Math.max(viewportRect.width, viewportRect.height), this.viewport.renderAheadPages);
      const overscanRect: DeviceRect = {
        x: viewportRect.x - overscan,
        y: viewportRect.y - overscan,
        width: viewportRect.width + overscan * 2,
        height: viewportRect.height + overscan * 2
      };
      const tiles = visibleTiles(device, res, viewportRect, overscan);

      this.presenters.get(page.page)?.setLayout(page.box, page.layoutScale);
      for (const tile of tiles) {
        const spec = tileSpecFor(device, tile.position, renderScale);
        const onScreen = intersects(spec.device, viewportRect);
        const near = onScreen || intersects(spec.device, overscanRect);
        const request = this.buildRequest(page, spec, res, onScreen, near, renderScale);
        const keyString = tileKeyOf(request);
        wantedKeys.add(keyString);

        // A tile already resident needs no job, whatever its priority.
        this.wanted.set(keyString, request);
        const resident = this.store.get(request);
        if (resident) {
          this.presenters.get(page.page)?.enqueueUpload(keyString, resident);
          this.presenters.get(page.page)?.promote(keyString);
          continue;
        }
        if (this.enqueueIfNeeded(request, keyString)) scheduled++;
      }
    }

    // Everything no longer wanted is withdrawn. `PDFVIEWER.md` §7: "When the user
    // reverses direction, keep reusable cached tiles but demote/cancel obsolete
    // speculative jobs" — the *cached* tiles stay, the jobs go.
    for (const keyString of [...this.wanted.keys()]) {
      if (wantedKeys.has(keyString)) continue;
      const requestId = this.requestIds.get(keyString);
      if (requestId !== undefined) this.scheduler.cancel(requestId);
      this.requestIds.delete(keyString);
      this.wanted.delete(keyString);
    }

    this.pumpUploads();
    return scheduled;
  }

  /**
   * Upload what fits in this frame.
   *
   * The viewer calls this from its animation frame, once, after planning. Separating it
   * from {@link plan} is what keeps the upload budget a *frame* budget: a plan can run
   * several times between frames (a resize, a zoom, a page crossing), and the uploads
   * must still be spread across frames rather than repeated with each plan.
   */
  pumpUploads(): void {
    let spent = 0;
    for (const presenter of this.presenters.values()) {
      if (spent >= this.uploadBudgetMs) break;
      const result = presenter.pump(this.uploadBudgetMs - spent);
      spent += result.ms;
    }
    this.lastUploadMs = spent;
    for (const request of this.wanted.values()) {
      const key = tileKeyOf(request);
      const presenter = this.presenters.get(request.page);
      presenter?.promote(key);
      if (!this.covered && request.visible && presenter?.hasPainted(key)) {
        this.covered = true;
        this.metrics?.recordCoverage(this.moveToken);
      }
    }
    if (this.status().queuedUploads > 0) this.onNeedsFrame();
    if (!this.converged && this.isConverged()) {
      this.converged = true;
      this.metrics?.recordSharpness(this.moveToken);
      const keep = new Set(this.wanted.keys());
      for (const presenter of this.presenters.values()) presenter.retain(keep);
    }
    this.publishStatus();
  }

  /** Force the next plan to re-request everything (a reload, a rollback, a settings change). */
  invalidate(): void {
    for (const [keyString, request] of this.wanted) {
      const requestId = this.requestIds.get(keyString);
      if (requestId !== undefined) this.scheduler.cancel(requestId);
      this.requestIds.delete(keyString);
      this.wanted.delete(keyString);
      void request;
    }
    this.store.clear();
    this.converged = false;
  }

  /** Drop everything for a page that left the mounted window. */
  forgetPage(page: number): void {
    const index = page - 1;
    this.tiledPages.delete(page);
    // Withdraw the jobs too, not just the pixels: a page that scrolled out of the
    // mounted window is exactly the speculative work §7 wants cancelled first.
    for (const [keyString, request] of [...this.wanted]) {
      if (request.pageIndex !== index) continue;
      const requestId = this.requestIds.get(keyString);
      if (requestId !== undefined) this.scheduler.cancel(requestId);
      this.requestIds.delete(keyString);
      this.wanted.delete(keyString);
    }
    this.store.dropPage(index);
    const presenter = this.presenters.get(page);
    if (presenter) presenter.dispose();
    this.publishStatus();
  }

  /** Tear the pipeline down: every surface, every job, every tile. */
  dispose(): void {
    this.scheduler.stop();
    this.scheduler.onComplete = null;
    for (const presenter of this.presenters.values()) presenter.dispose();
    this.presenters.clear();
    this.hosts.clear();
    this.store.clear();
    this.wanted.clear();
    this.requestIds.clear();
    this.tiledPages.clear();
  }

  status(): PipelineStatus {
    const storeTiles = this.store.size;
    let queuedUploads = 0;
    let surfaces = 0;
    for (const presenter of this.presenters.values()) {
      const snapshot = presenter.snapshot();
      queuedUploads += snapshot.queuedUploads;
      surfaces += snapshot.surfaces;
    }
    return {
      active: this.tiledPages.size > 0,
      tiledPages: this.tiledPages.size,
      residentTiles: storeTiles,
      residentBytes: this.store.residentBytes,
      queuedUploads,
      surfaces,
      lastUploadMs: this.lastUploadMs,
      scheduler: this.scheduler.snapshot()
    };
  }

  // ------------------------------------------------------------------ internals

  private buildRequest(
    page: PipelinePage,
    spec: { position: TilePosition; device: DeviceRect; clip: { x: number; y: number; width: number; height: number } },
    res: number,
    onScreen: boolean,
    near: boolean,
    renderScale: number
  ): TileRequest {
    void res;
    const fallback = this.store.coverageFor({
      page: page.page,
      pageIndex: page.page - 1,
      scale: renderScale,
      rotate: 0,
      invert: this.viewport.invert,
      clip: spec.clip,
      position: spec.position,
      device: spec.device,
      targetTileSize: this.targetTileSize,
      priority: TilePriority.UncoveredVisible,
      generation: this.viewport.generation,
      revision: this.viewport.resolution,
      visible: onScreen
    } satisfies TileRequest);
    /**
     * The fallback answer is what separates "the reader can see through this" from "the
     * reader can read this, slightly soft" — which is §7's first two priority levels and
     * the difference between a blank page and a progressive one.
     */
    const priority = onScreen
      ? fallback.fallback.length > 0
        ? TilePriority.SharpnessUpgrade
        : TilePriority.UncoveredVisible
      : near
        ? TilePriority.NearPrefetch
        : TilePriority.DistantSpeculation;

    return {
      page: page.page,
      pageIndex: page.page - 1,
      scale: renderScale,
      // Always 0: the page's own `/Rotate` is already inside the engine's page space and
      // the viewer's rotation is a CSS transform. See `PdfTileGeometry`.
      rotate: 0,
      invert: this.viewport.invert,
      clip: spec.clip,
      position: spec.position,
      device: spec.device,
      targetTileSize: this.targetTileSize,
      priority,
      generation: this.viewport.generation,
      revision: this.viewport.resolution,
      visible: onScreen
    };
  }

  private enqueueIfNeeded(request: TileRequest, keyString: string): boolean {
    if (this.requestIds.has(keyString)) return false;
    const status: TileRequestStatus = this.scheduler.enqueue(request);
    if (status.status === 'queued') {
      this.requestIds.set(keyString, status.requestId);
      return true;
    }
    if (status.status === 'duplicate') {
      const id = this.scheduler.requestIdFor(request);
      if (id !== undefined) this.requestIds.set(keyString, id);
      return false;
    }
    // Rejected: the tile stays uncovered, and the next plan asks again once the queue
    // has drained. Nothing else to do here — dropping it from `wanted` would only make
    // the next plan re-derive the same request, and the request is already recorded as
    // wanted so `isConverged` stays false until it really arrives.
    return false;
  }

  private async runRender(request: TileRequest, requestId: number): Promise<PdfRenderResult> {
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const result = await this.renderFn(
      {
        pageIndex: request.pageIndex,
        scale: request.scale,
        clip: request.clip,
        tile: request.position ?? { res: 0, row: 0, col: 0 },
        targetTileSize: request.targetTileSize,
        invert: request.invert
      },
      requestId
    );
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
    this.metrics?.recordRender({
      roundTripMs: elapsed,
      bytes: result.pixels?.byteLength ?? 0,
      fromEngineCache: result.fromEngineCache === true
    });
    return result;
  }

  /**
   * A tile arrived.
   *
   * `PDFVIEWER.md` §7: replies "identify the same generation/key" and stale ones are
   * discarded by identity. The request id is the identity here: a reply whose id is no
   * longer the one the pipeline is waiting for belongs to a superseded plan, and
   * drawing it would put old pixels on top of new ones.
   */
  private onTileComplete(completion: {
    request: TileRequest;
    result: PdfRenderResult | null;
    roundTripMs: number;
    error: string | null;
  }): void {
    const keyString = tileKeyOf(completion.request);
    const expected = this.requestIds.get(keyString);
    if (completion.result && expected !== completion.result.requestId) return;
    this.requestIds.delete(keyString);

    if (completion.error !== null || !completion.result) {
      if (expected !== undefined && completion.error && !/cancel/i.test(completion.error)) this.onError(completion.error);
      return;
    }
    if (expected === undefined) return; // already withdrawn
    if (completion.request.generation !== this.viewport.generation) {
      this.metrics?.recordStale();
      return;
    }

    const result = completion.result;
    const problem = describePixelPayload(result);
    if (problem !== null) {
      // `PDFVIEWER.md` §7 asks for a malformed-payload test; the cheapest correct answer
      // is to refuse the reply and let the plan ask again, rather than build an
      // `ImageData` over a buffer that does not describe the rectangle it claims.
      this.metrics?.recordFailed();
      this.onError(problem);
      return;
    }

    let image: ImageData;
    try {
      image = toImageData(result);
    } catch (error) {
      this.metrics?.recordFailed();
      this.onError(String(error));
      return;
    }

    const stored = this.store.put({
      key: keyString,
      identity: {
        generation: completion.request.generation,
        pageIndex: completion.request.pageIndex,
        scale: completion.request.scale,
        rotate: completion.request.rotate,
        invert: completion.request.invert,
        clip: completion.request.clip
      },
      device: completion.request.device,
      position: completion.request.position,
      image,
      bytes: image.data.byteLength,
      page: completion.request.page,
      fromEngineCache: result.fromEngineCache === true,
      renderMs: completion.roundTripMs
    });
    if (!stored) {
      // The store refused it (larger than the whole budget); the plan asks for a
      // smaller grid next time. Nothing to draw.
      return;
    }

    const presenter = this.presenters.get(completion.request.page);
    const storedTile = this.store.get(completion.request);
    if (presenter && storedTile) presenter.enqueueUpload(keyString, storedTile);

    this.metrics?.recordTileStore(this.store.size, this.store.residentBytes);
    this.publishStatus();
    this.onNeedsFrame();
  }

  /**
   * True when every tile the current plan wants is resident.
   *
   * This is §10's "time-to-target-sharpness": the moment the viewport holds the
   * resolution it asked for. Reported to the metrics only when it changes, so a scroll
   * reports one sharpness time per viewport move rather than one per arriving tile.
   */
  private isConverged(): boolean {
    if (this.wanted.size === 0) return this.tiledPages.size > 0;
    for (const request of this.wanted.values()) {
      if (request.visible && !this.presenters.get(request.page)?.hasPainted(tileKeyOf(request))) return false;
    }
    return true;
  }

  private publishStatus(): void {
    this.onStatus?.(this.status());
  }
}

/** Whether two device rectangles share any area. */
function intersects(a: DeviceRect, b: DeviceRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
