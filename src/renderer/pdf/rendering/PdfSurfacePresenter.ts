/**
 * Eukolia — retained tile surfaces, and bounded uploads.
 *
 * ## Why this module exists
 *
 * `PDFVIEWER.md` §4 lists `PdfSurfacePresenter.ts` as "retained surfaces, bounded
 * uploads, atomic refinement and disposal", and §8 says what has to change:
 *
 * > Replace "one page upload per frame" with a queue that limits actual upload time
 * > and bytes per frame. Measure recent upload costs and choose tiles that fit the
 * > remaining budget. At 144 Hz the total frame budget is approximately 6.94 ms;
 * > reserve most of it for browser/editor work. Start with a conservative 1–2 ms
 * > upload target and tune from traces, without starving visible content.
 *
 * The viewer's current `schedulePaint` is exactly the thing to replace: it drains
 * **one whole page blit per frame**. That was the right fix for its problem — three
 * pages finishing together was three whole-page `drawImage` calls in one frame, one
 * dropped frame in an otherwise vsync-locked scroll — but it cannot tell a 2 ms
 * upload from a 20 ms one, so a large page and a small one cost the same amount of
 * the frame. A tile presenter can: it measures what the last few uploads actually
 * cost and admits only what fits.
 *
 * ## What "retained" means here
 *
 * §8: "Attach/reuse stable surfaces; avoid resize/clear/reupload of unchanged tiles
 * or recreating refs during unrelated UI renders." So a tile's canvas is created
 * once per tile identity and then *kept*: a re-plan that still wants the tile does
 * nothing at all, and a tile that leaves the viewport keeps its canvas and its pixels
 * until the store evicts it. That is the same principle as the viewer's existing
 * canvas parking (`canvasParkRef`), applied per tile instead of per page.
 *
 * ## Backing store vs CSS box
 *
 * A canvas is displayed by scaling its backing store into its CSS box, and when the
 * two disagree the compositor resamples — `pdf-text-layer.ts` documents the measured
 * cost of that (a 0.14 % error cost 25 % of edge energy). So a tile canvas is sized
 * from the bitmap it holds (`width`/`height` device pixels) and given a CSS box of
 * exactly `device / devicePixelRatio`, positioned at `device.x / dpr`,
 * `device.y / dpr` inside the page sheet. The blit is then 1:1 by construction, and
 * adjacent tiles abut because {@link PdfTileGeometry} gives them exact shared integer
 * edges.
 *
 * ## Why the presenter owns no policy
 *
 * It does not decide which tiles to upload or when to stop; {@link PdfSurfacePresenter.enqueueUpload}
 * takes an already-chosen list and {@link PdfSurfacePresenter.pump} uploads what fits
 * in the budget. That keeps the interesting decision (which tile matters) in the
 * planner where the viewport is known, and this module's job — canvases, bytes,
 * timing — testable on its own.
 *
 * Copyright 2026 The Eukolia project authors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DeviceRect } from './PdfTileGeometry';
import type { PdfRenderMetrics } from './PdfRenderMetrics';
import type { StoredTile } from './PdfTileStore';

/**
 * How much of a frame may be spent uploading tile pixels.
 *
 * §8: "Start with a conservative 1–2 ms upload target and tune from traces". 2 ms of
 * a 6.94 ms 144 Hz frame leaves 4.9 ms for everything else the frame has to do,
 * which is the reserve §8 asks for. It is a *target*, not a cap: when the queue holds
 * a tile the reader can see, being 1 ms over is better than a blank cell, so
 * {@link PdfSurfacePresenter.pump} always admits at least one upload per frame.
 */
export const DEFAULT_UPLOAD_BUDGET_MS = 2;

/**
 * How many recent uploads the estimate is taken over.
 *
 * "Recent" rather than average-of-all: the cost depends on the tile size and on what
 * else the compositor is doing, and an average over a whole session would lag a zoom
 * change by hundreds of tiles. Eight is roughly one screenful of tiles at a 768-pixel
 * target, i.e. long enough to be stable within one plan and short enough to react to
 * the next.
 */
const UPLOAD_HISTORY = 8;

/** One tile canvas, kept alive across plans. */
interface TileSurface {
  canvas: HTMLCanvasElement;
  /** The tile identity currently drawn, so an unchanged tile is not re-uploaded. */
  drawnKey: string;
  /**
   * The tile's device box, in the page's unrotated device space.
   *
   * Kept because a DPR change re-measures every surface's CSS box and must not move
   * one of them to the origin while doing it.
   */
  device: DeviceRect;
  deviceWidth: number;
  deviceHeight: number;
  scale: number;
}

/** A tile waiting to be uploaded, with where it goes. */
export interface PendingUpload {
  /** The store's identity string; the presenter keys its surfaces on it. */
  key: string;
  tile: StoredTile;
}

function sameRect(a: DeviceRect, b: DeviceRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export interface PresenterOptions {
  /** Upload time allowed per frame, in milliseconds. */
  uploadBudgetMs?: number;
  /** Hard cap on resident tile canvases, independent of the store's byte budget. */
  maxSurfaces?: number;
  metrics?: PdfRenderMetrics | null;
  now?: () => number;
}

export interface PresenterSnapshot {
  surfaces: number;
  queuedUploads: number;
  /** Milliseconds the last upload took. */
  lastUploadMs: number;
  /** Mean upload time over the recent window, used to size the next batch. */
  meanUploadMs: number;
  /** Frames on which at least one upload ran. */
  framesWithUploads: number;
  uploads: number;
  /** Tiles whose canvas existed and already held the right pixels: nothing to do. */
  skippedUnchanged: number;
}

/**
 * Owns the page's tile canvases and uploads their pixels under a time budget.
 *
 * One presenter belongs to one page sheet. Its {@link PdfSurfacePresenter.host} is
 * the element tiles are appended to; tiles are positioned absolutely inside it with
 * the page's own CSS pixel size as the containing block.
 */
export class PdfSurfacePresenter {
  readonly host: HTMLElement;
  private readonly surfaces = new Map<string, TileSurface>();
  private readonly uploads: PendingUpload[] = [];
  private readonly recentUploadMs: number[] = [];
  private readonly metrics: PdfRenderMetrics | null;
  private readonly now: () => number;

  readonly uploadBudgetMs: number;
  readonly maxSurfaces: number;

  private devicePixelRatio: number;
  private pageBox: { width: number; height: number } | null = null;

  setLayout(box: { width: number; height: number }, _scale: number): void {
    this.pageBox = box;
    for (const surface of this.surfaces.values()) this.applyCssBox(surface);
  }

  hasPainted(key: string): boolean {
    return this.surfaces.get(key)?.drawnKey === key;
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of this.surfaces.keys()) if (!keys.has(key)) this.release(key);
  }

  promote(key: string): void {
    const surface = this.surfaces.get(key);
    if (surface) surface.canvas.style.zIndex = '1';
  }

  demote(): void {
    for (const surface of this.surfaces.values()) surface.canvas.style.zIndex = '0';
  }
  private framesWithUploads = 0;
  private uploadCount = 0;
  private skippedUnchanged = 0;

  constructor(host: HTMLElement, options: PresenterOptions = {}) {
    this.host = host;
    this.uploadBudgetMs = Math.max(0.1, options.uploadBudgetMs ?? DEFAULT_UPLOAD_BUDGET_MS);
    this.maxSurfaces = Math.max(1, options.maxSurfaces ?? 256);
    this.metrics = options.metrics ?? null;
    this.now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.devicePixelRatio = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  }

  /**
   * Tell the presenter the display scale.
   *
   * A DPR change invalidates every surface's CSS box, not its pixels: the bitmap is
   * still the right number of device pixels, only the size it should be *displayed*
   * at moved. So the canvases are re-measured rather than re-created.
   */
  setDevicePixelRatio(dpr: number): void {
    const next = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    if (next === this.devicePixelRatio) return;
    this.devicePixelRatio = next;
    for (const surface of this.surfaces.values()) this.applyCssBox(surface);
  }

  /**
   * Add a tile to the upload queue.
   *
   * A tile already resident and already drawn is dropped here rather than in the
   * planner, because this is where "already drawn" is actually known — the planner
   * knows what the *store* has, not what the compositor shows. §8: "avoid
   * resize/clear/reupload of unchanged tiles".
   */
  enqueueUpload(key: string, tile: StoredTile): void {
    const surface = this.surfaces.get(key);
    if (surface && surface.drawnKey === key && surface.deviceWidth === tile.image.width && surface.deviceHeight === tile.image.height) {
      this.skippedUnchanged++;
      return;
    }
    // Newest wins: two entries for one region in one frame is a plan change, and the
    // later one is the tile the store just accepted.
    const at = this.uploads.findIndex((pending) => pending.key === key);
    if (at >= 0) this.uploads.splice(at, 1);
    this.uploads.push({ key, tile });
  }

  /** How many uploads are waiting. */
  get queuedUploads(): number {
    return this.uploads.length;
  }

  /**
   * Upload as much as fits in this frame's budget.
   *
   * The batch size is chosen from the *measured* cost of recent uploads rather than
   * from a fixed tile count, per §8. At least one upload always runs: a frame that
   * shows nothing new because the budget was spent on a previous frame is the
   * "smooth scrolling over blank pages" failure §10 names.
   *
   * Returns the number of uploads performed and the milliseconds they took.
   */
  pump(budgetMs = this.uploadBudgetMs): { uploads: number; ms: number } {
    if (this.uploads.length === 0) return { uploads: 0, ms: 0 };

    const estimate = this.meanUploadMs();
    let spent = 0;
    let count = 0;
    while (this.uploads.length > 0) {
      if (count > 0 && spent + estimate > budgetMs) break;
      const pending = this.uploads.shift() as PendingUpload;
      const started = this.now();
      const uploaded = this.upload(pending);
      const elapsed = this.now() - started;
      spent += elapsed;
      count++;
      if (!uploaded) continue;
      this.recordUpload(elapsed, pending.tile);
    }
    if (count > 0) this.framesWithUploads++;
    return { uploads: count, ms: spent };
  }

  /** Drop the queue without uploading (a plan that was superseded entirely). */
  clearQueue(): void {
    this.uploads.length = 0;
  }

  /**
   * Remove the surface for a tile the store evicted.
   *
   * The canvas is released rather than parked: the store's budget already decided
   * these pixels are not worth their bytes, and keeping the canvas would keep exactly
   * the GPU backing the budget was meant to bound.
   */
  release(key: string): void {
    for (let i = this.uploads.length - 1; i >= 0; i--) {
      if (this.uploads[i].key === key) this.uploads.splice(i, 1);
    }
    const surface = this.surfaces.get(key);
    if (!surface) return;
    this.surfaces.delete(key);
    surface.canvas.remove();
  }

  /** Remove every surface. For a page unmount or a document change. */
  dispose(): void {
    for (const surface of this.surfaces.values()) surface.canvas.remove();
    this.surfaces.clear();
    this.uploads.length = 0;
    this.recentUploadMs.length = 0;
  }

  snapshot(): PresenterSnapshot {
    return {
      surfaces: this.surfaces.size,
      queuedUploads: this.uploads.length,
      lastUploadMs: this.recentUploadMs.length > 0 ? this.recentUploadMs[this.recentUploadMs.length - 1] : 0,
      meanUploadMs: this.meanUploadMs(),
      framesWithUploads: this.framesWithUploads,
      uploads: this.uploadCount,
      skippedUnchanged: this.skippedUnchanged
    };
  }

  // ------------------------------------------------------------------ internals

  private meanUploadMs(): number {
    if (this.recentUploadMs.length === 0) return 0;
    let sum = 0;
    for (const value of this.recentUploadMs) sum += value;
    return sum / this.recentUploadMs.length;
  }

  private recordUpload(ms: number, tile: StoredTile): void {
    this.uploadCount++;
    this.recentUploadMs.push(ms);
    if (this.recentUploadMs.length > UPLOAD_HISTORY) this.recentUploadMs.shift();
    this.metrics?.recordUpload(ms, tile.bytes);
  }

  /** Draw one tile into its surface. Returns false when there was nothing to draw. */
  private upload(pending: PendingUpload): boolean {
    const { tile } = pending;
    if (tile.image.width <= 0 || tile.image.height <= 0) return false;
    const surface = this.surfaceFor(pending.key, tile);
    const context = surface.canvas.getContext('2d');
    if (!context) return false;
    // `putImageData` writes the rectangle outright — it is not a composite, so
    // clearing first would be a second full-surface pass for nothing. The viewer's
    // `paint` already learned this for whole pages; the same reasoning holds per tile.
    context.putImageData(tile.image, 0, 0);
    surface.drawnKey = pending.key;
    return true;
  }

  private surfaceFor(key: string, tile: StoredTile): TileSurface {
    const existing = this.surfaces.get(key);
    if (existing) {
      const resized = existing.deviceWidth !== tile.image.width || existing.deviceHeight !== tile.image.height;
      if (resized) {
        existing.canvas.width = tile.image.width;
        existing.canvas.height = tile.image.height;
        existing.deviceWidth = tile.image.width;
        existing.deviceHeight = tile.image.height;
        existing.drawnKey = '';
      }
      // The device box can move without the bitmap changing size (a re-plan at the same
      // scale), so the CSS box is re-applied whenever either differs.
      if (resized || !sameRect(existing.device, tile.device)) {
        existing.device = tile.device;
        this.applyCssBox(existing);
      }
      return existing;
    }

    const canvas = document.createElement('canvas');
    canvas.width = tile.image.width;
    canvas.height = tile.image.height;
    canvas.dataset.pdfTile = key;
    canvas.setAttribute('aria-hidden', 'true');
    const surface: TileSurface = {
      canvas,
      drawnKey: '',
      device: tile.device,
      deviceWidth: tile.image.width,
      deviceHeight: tile.image.height,
      scale: tile.identity.scale
    };
    this.applyCssBox(surface);
    this.host.appendChild(canvas);
    this.surfaces.set(key, surface);
    this.enforceSurfaceBudget();
    return surface;
  }

  /**
   * Position a surface so its backing store maps 1:1 onto the display.
   *
   * `left`/`top` come from the tile's device box, which is in the page's *unrotated*
   * device space; the page sheet's own rotation is a CSS transform on an ancestor, so
   * a tile never applies rotation itself. The *size* is derived from the bitmap
   * (`deviceWidth / dpr`), not from the tile's nominal box, so MuPDF's outward rounding
   * of the last row or column cannot introduce a fractional rescale — the defect
   * `canvasDisplayBox` documents at 25 % of edge energy for a 0.14 % error.
   */
  private applyCssBox(surface: TileSurface): void {
    const dpr = this.devicePixelRatio;
    const canvas = surface.canvas;
    canvas.style.position = 'absolute';
    canvas.style.left = `${surface.device.x / dpr}px`;
    canvas.style.top = `${surface.device.y / dpr}px`;
    canvas.style.width = `${surface.deviceWidth / dpr}px`;
    canvas.style.height = `${surface.deviceHeight / dpr}px`;
    if (this.pageBox) {
      const width = this.pageBox.width * surface.scale;
      const height = this.pageBox.height * surface.scale;
      canvas.style.left = `${surface.device.x / width * 100}%`;
      canvas.style.top = `${surface.device.y / height * 100}%`;
      canvas.style.width = `${surface.deviceWidth / width * 100}%`;
      canvas.style.height = `${surface.deviceHeight / height * 100}%`;
    }
    canvas.style.imageRendering = 'auto';
    canvas.style.pointerEvents = 'none';
  }

  /**
   * Keep the number of compositor surfaces bounded.
   *
   * §8: "Bound the number of compositor surfaces as well as their pixels." Each
   * canvas is a compositor layer; a 4K page at a 384-pixel tile target is more than a
   * hundred of them, and a browser starts merging or rasterising tiles itself once
   * there are too many. The oldest surfaces go first, which is the same order the
   * store evicts in.
   */
  private enforceSurfaceBudget(): void {
    if (this.surfaces.size <= this.maxSurfaces) return;
    const excess = this.surfaces.size - this.maxSurfaces;
    const keys = [...this.surfaces.keys()].slice(0, excess);
    for (const key of keys) this.release(key);
  }
}
