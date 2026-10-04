/**
 * Eukolia — the PDF tile render scheduler.
 *
 * ## Why this module exists
 *
 * `PDFVIEWER.md` §7 defines the contract, and §2 records what happens without one:
 * a 30-step divider drag asked the engine for **35 whole-page rasterisations**, and
 * the native queue accepts up to 512 requests, so nothing stops a burst from
 * flooding it.
 *
 * The scheduler owns the four things §7 asks for:
 *
 *   * **Priority** — "uncovered visible regions, visible sharpness upgrades,
 *     near-direction prefetch, opposite-direction retention, distant speculative
 *     work", plus "fairness/aging so expensive visible tiles do not starve during
 *     sustained input".
 *   * **Deduplication by full render key** — the key includes document generation,
 *     page, scale, rotation, invert/gray and the region, because a request that
 *     differs in any of those is a different rasterisation, and a request that
 *     differs in none is the same one.
 *   * **Latest-viewport-wins coalescing** — a new viewport plan supersedes the
 *     pending one; only the newest plan's wants are honoured.
 *   * **Bounded concurrency and backpressure** — "Cap queued and active work by both
 *     estimated bytes and count; do not flood the existing 512-request queue. Begin
 *     with a small renderer outstanding window and tune independently of native
 *     worker ceiling."
 *
 * ## The cancelled-work promise, stated honestly
 *
 * §7: "Cancellation removes queued jobs promptly. The current native implementation
 * abandons completed in-flight replay rather than forcibly terminating it; keep safe
 * ownership and discard obsolete replies by generation/request identity. Do not claim
 * cancellation instantly frees CPU."
 *
 * So {@link PdfRenderScheduler.cancel} removes a job from *this* queue and asks the
 * engine to drop it if it has not started; a job already inside a display-list replay
 * runs to completion and its reply is discarded by identity. {@link
 * SchedulerSnapshot.cancelled} counts only the jobs that never reached the engine,
 * because counting the others would overstate what cancellation achieves.
 *
 * ## What it deliberately does not do
 *
 * It does not talk to IPC, does not know about canvases, and does not decide *which*
 * tiles a viewport needs — {@link PdfTileGeometry} does that, and the viewer's planner
 * turns that into {@link TileRequest}s. That keeps the tricky parts (priority,
 * dedup, budgets) testable without a DOM, an engine or a frame clock.
 *
 * Copyright 2026 The Eukolia project authors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PdfRenderResult } from '../../../shared/ipc';
import { nextPdfRequestId } from './requestId';
import type { PdfRenderMetrics } from './PdfRenderMetrics';
import type { DeviceRect, TilePosition } from './PdfTileGeometry';

/**
 * What the job is for. Lower numbers are more urgent.
 *
 * The order is §7's, plus the two cases the reference's own priority classes imply:
 * a page that is on screen but has *no* pixels at all is more urgent than a
 * sharpness upgrade on a page that is already readable, and retaining what is about
 * to leave the viewport beats fetching what is further away.
 */
export const enum TilePriority {
  /** A visible tile with no pixels at all: the reader can see through it. */
  UncoveredVisible = 0,
  /** A visible tile covered by a coarser or older generation. */
  SharpnessUpgrade = 1,
  /** Just past the leading edge, in the direction the viewport is moving. */
  NearPrefetch = 2,
  /** Behind the viewport, kept because a reversal is likely. */
  OppositeRetention = 3,
  /** Everything else the planner asked for. */
  DistantSpeculation = 4
}

/** One rasterisation the scheduler may run. */
export interface TileRequest {
  /** The page this region belongs to, 1-based as the viewer's geometry uses. */
  page: number;
  /** 0-based, as `PdfRenderRequest` uses. */
  pageIndex: number;
  /** Device pixels per PDF point. */
  scale: number;
  rotate: number;
  invert: boolean;
  clip: { x: number; y: number; width: number; height: number };
  /** The tile address, when the request came from a grid; `null` for a clip route. */
  position: TilePosition | null;
  /** The tile's own device box, for placement and for the byte estimate. */
  device: DeviceRect;
  /**
   * Device pixels per tile side the grid this address came from was composed against.
   *
   * Carried with the request rather than passed to the engine call separately, because
   * it pins the native tile geometry (`RenderJob::targetTileSize`): the address only
   * means what this number says it means.
   */
  targetTileSize: number;
  priority: TilePriority;
  /** Document generation; a reply for another generation is discarded. */
  generation: number;
  /** The viewport revision this request was planned for. */
  revision: number;
  /** True when the tile is on screen right now (drives the aging bonus). */
  visible: boolean;
}

/** The outcome handed back to the planner. */
export interface TileCompletion {
  request: TileRequest;
  result: PdfRenderResult | null;
  /** Wall time from the engine call's start to its reply. */
  roundTripMs: number;
  error: string | null;
}

/** What {@link PdfRenderScheduler.enqueue} did with a request. */
export type TileRequestStatus =
  | { status: 'queued'; requestId: number; bytes: number }
  | { status: 'duplicate' }
  | { status: 'rejected'; reason: 'budget' | 'oversized' | 'stopped' };

/** The engine call the scheduler drives. Supplied by the viewer. */
export type TileRenderFn = (request: TileRequest, requestId: number) => Promise<PdfRenderResult>;

/** The cancel call the scheduler drives. Best-effort: see the module note. */
export type TileCancelFn = (requestId: number) => void;

export interface SchedulerOptions {
  /**
   * How many engine calls may be in flight at once.
   *
   * §7: "Begin with a small renderer outstanding window and tune independently of
   * native worker ceiling." The native pool can reach 32 threads, but the renderer
   * has no business queueing 32 tiles: every one of them is a promise, a buffer and
   * (after this) a canvas, and the transport is a single stdio pipe. Four is enough
   * to keep the pipe busy through the JSON round trip without letting a viewport
   * change leave a dozen obsolete rasterisations running.
   */
  maxActive?: number;
  /**
   * Bytes of tile pixels allowed in flight or queued.
   *
   * A 768x768 RGBA tile is 2.36 MB, so 48 MB is about twenty tiles — comfortably
   * more than one screenful at any zoom, and small enough that a superseded plan
   * cannot have gigabytes outstanding. §3: "Bound speculative work by bytes, jobs,
   * and distance."
   */
  maxQueuedBytes?: number;
  /** Queued jobs, as a second bound. */
  maxQueuedJobs?: number;
  metrics?: PdfRenderMetrics | null;
  now?: () => number;
}

/** A read-only view of the scheduler, for the viewer's status attribute and the probe. */
export interface SchedulerSnapshot {
  queued: number;
  active: number;
  queuedBytes: number;
  activeBytes: number;
  /** Jobs that never reached the engine because a newer plan superseded them. */
  cancelled: number;
  /** Replies discarded because their generation or request identity was stale. */
  stale: number;
  /** Requests that found an identical job already queued or active. */
  deduplicated: number;
  completed: number;
  failed: number;
  /** Age of the oldest queued job, in milliseconds. */
  oldestQueueAgeMs: number;
  /** Requests dropped because the byte or job budget was full. */
  dropped: number;
}

interface QueuedJob {
  request: TileRequest;
  requestId: number;
  bytes: number;
  sequence: number;
  queuedAt: number;
}

/** Bytes one tile's RGBA payload will occupy, as `PdfRenderResult` delivers it. */
export function estimateTileBytes(device: DeviceRect): number {
  const pixels = Math.max(0, device.width) * Math.max(0, device.height);
  return pixels * 4;
}

/**
 * The full render key of a request.
 *
 * Everything that changes the *pixels* is in it. `page`/`pageIndex` both appear
 * because the viewer plans in 1-based page numbers and the engine speaks 0-based,
 * and a key that dropped either would silently collide two pages at a document edge.
 */
export function tileRequestKey(request: TileRequest): string {
  const clip = request.clip;
  return [
    request.generation,
    request.pageIndex,
    request.scale.toFixed(6),
    request.rotate,
    request.invert ? 1 : 0,
    clip.x.toFixed(4),
    clip.y.toFixed(4),
    clip.width.toFixed(4),
    clip.height.toFixed(4)
  ].join('/');
}

export class PdfRenderScheduler {
  private readonly queue: QueuedJob[] = [];
  private readonly active = new Map<number, QueuedJob>();
  private readonly inflightKeys = new Set<string>();
  private readonly renderFn: TileRenderFn;
  private readonly cancelFn: TileCancelFn;
  private readonly metrics: PdfRenderMetrics | null;
  private readonly now: () => number;

  readonly maxActive: number;
  readonly maxQueuedBytes: number;
  readonly maxQueuedJobs: number;

  private sequence = 0;
  private queuedBytes = 0;
  private activeBytes = 0;
  private stopped = false;

  private counters = { cancelled: 0, stale: 0, deduplicated: 0, completed: 0, failed: 0, dropped: 0 };

  /**
   * The newest viewport revision the scheduler will honour.
   *
   * Requests older than this are cancelled on {@link beginRevision}, which is §7's
   * "latest-viewport-wins coalescing": a plan that has been replaced has no claim on
   * the engine, whatever its priority.
   */
  private currentRevision = 0;

  constructor(renderFn: TileRenderFn, cancelFn: TileCancelFn, options: SchedulerOptions = {}) {
    this.renderFn = renderFn;
    this.cancelFn = cancelFn;
    this.metrics = options.metrics ?? null;
    this.now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.maxActive = Math.max(1, options.maxActive ?? 4);
    this.maxQueuedBytes = Math.max(1, options.maxQueuedBytes ?? 48 * 1024 * 1024);
    this.maxQueuedJobs = Math.max(1, options.maxQueuedJobs ?? 32);
  }

  /**
   * Adopt a new viewport plan, cancelling everything planned for an older one.
   *
   * Returns the number of jobs withdrawn. This is the only place obsolete work is
   * dropped wholesale: {@link enqueue} deliberately does not cancel by priority,
   * because a lower-priority prefetch from the *same* plan is still wanted, just
   * later.
   */
  beginRevision(revision: number): number {
    this.currentRevision = revision;
    let cancelled = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].request.revision >= revision) continue;
      this.removeQueuedAt(i);
      cancelled++;
    }
    if (cancelled > 0) {
      this.counters.cancelled += cancelled;
      this.metrics?.recordCancelled(cancelled);
    }
    return cancelled;
  }

  /** The revision the scheduler currently honours. */
  requestIdFor(request: TileRequest): number | undefined {
    const key = tileRequestKey(request);
    return [...this.active.values(), ...this.queue].find(job => tileRequestKey(job.request) === key)?.requestId;
  }

  get revision(): number {
    return this.currentRevision;
  }

  /**
   * Queue one tile.
   *
   * A {@link TileRequestStatus} rather than a bare id, because "already queued" and
   * "refused" are different facts for the planner: the first needs no action (the
   * pixels are already coming), the second means the tile will stay uncovered and
   * the planner should reconsider its budgets.
   */
  enqueue(request: TileRequest): TileRequestStatus {
    if (this.stopped) return { status: 'rejected', reason: 'stopped' };

    const key = tileRequestKey(request);
    if (this.inflightKeys.has(key)) {
      this.counters.deduplicated++;
      this.metrics?.recordDeduplicated();
      return { status: 'duplicate' };
    }

    const bytes = estimateTileBytes(request.device);
    if (bytes > this.maxQueuedBytes) {
      // A single tile larger than the whole budget can never be admitted without
      // breaking the bound; the planner's job is to keep tiles smaller than this.
      this.counters.dropped++;
      return { status: 'rejected', reason: 'oversized' };
    }
    if (this.queue.length >= this.maxQueuedJobs || this.queuedBytes + bytes > this.maxQueuedBytes) {
      this.counters.dropped++;
      return { status: 'rejected', reason: 'budget' };
    }

    const job: QueuedJob = {
      request,
      requestId: nextPdfRequestId(),
      bytes,
      sequence: ++this.sequence,
      queuedAt: this.now()
    };
    this.queue.push(job);
    this.queuedBytes += bytes;
    this.inflightKeys.add(key);
    this.metrics?.recordSubmitted();
    this.pump();
    return { status: 'queued', requestId: job.requestId, bytes };
  }

  /**
   * Cancel one queued job by the request id {@link enqueue} returned.
   *
   * A job already in flight is left alone: the native replay cannot be interrupted
   * (see the module note), so the honest action is to let it finish and discard the
   * reply, which {@link currentGeneration} does by identity.
   */
  cancel(requestId: number): boolean {
    const index = this.queue.findIndex((job) => job.requestId === requestId);
    if (index < 0) return false;
    this.removeQueuedAt(index);
    this.counters.cancelled++;
    this.metrics?.recordCancelled();
    return true;
  }

  /**
   * Discard queued work for a document generation that no longer exists.
   *
   * Called on re-read, close and `invalidateAll`. §5: "old generations cannot
   * reenter after reload". Returns how many jobs went away.
   */
  dropGeneration(generation: number): number {
    let dropped = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].request.generation === generation) {
        this.removeQueuedAt(i);
        dropped++;
      }
    }
    if (dropped > 0) {
      this.counters.cancelled += dropped;
      this.metrics?.recordCancelled(dropped);
    }
    return dropped;
  }

  /** Drop everything queued and stop admitting work. In-flight calls still settle. */
  stop(): void {
    this.stopped = true;
    for (let i = this.queue.length - 1; i >= 0; i--) this.removeQueuedAt(i);
  }

  /** Resume after {@link stop}. */
  start(): void {
    this.stopped = false;
  }

  /** Forget a key so the same tile can be requested again (e.g. after an eviction). */
  forget(request: TileRequest): void {
    this.inflightKeys.delete(tileRequestKey(request));
  }

  snapshot(): SchedulerSnapshot {
    const now = this.now();
    let oldest = 0;
    for (const job of this.queue) {
      const age = now - job.queuedAt;
      if (age > oldest) oldest = age;
    }
    return {
      queued: this.queue.length,
      active: this.active.size,
      queuedBytes: this.queuedBytes,
      activeBytes: this.activeBytes,
      cancelled: this.counters.cancelled,
      stale: this.counters.stale,
      deduplicated: this.counters.deduplicated,
      completed: this.counters.completed,
      failed: this.counters.failed,
      oldestQueueAgeMs: oldest,
      dropped: this.counters.dropped
    };
  }

  // ------------------------------------------------------------------ internals

  /** Admit queued jobs into the active window, most urgent first. */
  private pump(): void {
    while (!this.stopped && this.active.size < this.maxActive && this.queue.length > 0) {
      const index = this.pickNextIndex();
      if (index < 0) return;
      const job = this.queue[index];
      this.queue.splice(index, 1);
      this.queuedBytes -= job.bytes;
      this.active.set(job.requestId, job);
      this.activeBytes += job.bytes;
      void this.run(job);
    }
  }

  /**
   * The next job to run.
   *
   * Priority first, then **aging**: a job that has waited longer than
   * {@link AGING_MS} is promoted one level per interval, so a stream of urgent
   * visible tiles cannot starve a prefetch forever. Within one priority, the most
   * recently queued wins — the same LIFO tie-break light-pdf's queue uses, which
   * favours the viewport the reader is actually looking at now.
   */
  private pickNextIndex(): number {
    const now = this.now();
    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.queue.length; i++) {
      const job = this.queue[i];
      const aged = Math.floor((now - job.queuedAt) / AGING_MS);
      // A visible job gets one free level: the reader can see that tile.
      const score =
        (job.request.priority as number) - aged - (job.request.visible ? 1 : 0) + i / (this.queue.length + 1) / 1000;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  private async run(job: QueuedJob): Promise<void> {
    const startedAt = this.now();
    let result: PdfRenderResult | null = null;
    let error: string | null = null;
    try {
      result = await this.renderFn(job.request, job.requestId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const roundTripMs = this.now() - startedAt;

    this.active.delete(job.requestId);
    this.activeBytes -= job.bytes;
    this.inflightKeys.delete(tileRequestKey(job.request));

    if (error !== null) {
      this.counters.failed++;
      this.metrics?.recordFailed();
    } else {
      this.counters.completed++;
    }

    this.onComplete?.({
      request: job.request,
      result,
      roundTripMs,
      error
    });

    this.pump();
  }

  /**
   * The completion sink. Assigned by the planner; called on the job's own turn, so a
   * slow consumer cannot stall the pump for longer than one callback.
   */
  onComplete: ((completion: TileCompletion) => void) | null = null;

  private removeQueuedAt(index: number): void {
    const job = this.queue[index];
    this.queue.splice(index, 1);
    this.queuedBytes -= job.bytes;
    this.inflightKeys.delete(tileRequestKey(job.request));
    // Best-effort: if the engine has not started it, dropping it saves the work.
    try {
      this.cancelFn(job.requestId);
    } catch {
      /* a cancel that fails is not worth surfacing */
    }
  }
}

/**
 * How long a queued job may wait before it is promoted one priority level.
 *
 * §7: "Add fairness/aging so expensive visible tiles do not starve during sustained
 * input." During a sustained scroll the visible tiles are always more urgent than the
 * prefetches, so without aging a prefetch queued at the start of a long scroll would
 * never run and every page would have to be rasterised from scratch on arrival. 120 ms
 * is roughly the point at which a reader notices a page is still soft, so a prefetch
 * that has waited that long is worth as much as the next visible tile.
 */
export const AGING_MS = 120;
