/**
 * Eukolia — opt-in PDF render metrics.
 *
 * ## Why this module exists
 *
 * `PDFVIEWER.md` §10 sets acceptance gates that cannot be met by looking at the
 * application: p95/p99 frame intervals, frames missing one or two refresh budgets,
 * time-to-first-coverage, time-to-target-sharpness, blank-area duration, cache hit
 * ratio, queue age, transport bytes and upload time. Those are numbers, and the
 * document is explicit that they must come from *this* build — §2 and §12 both
 * refuse a reciprocal-paint-duration counter ("a displayed value of 1000 can mean a
 * one-millisecond paint handler") and §53 warns that the source comments' older
 * profiling numbers must not be re-presented as new measurements.
 *
 * So the viewer needs a place to accumulate real observations, and it needs that
 * place to cost nothing when it is off: §9 requires the performance work to leave
 * "new diagnostics behind developer instrumentation, not in normal reading UI", and
 * a counter that allocates a string per tile would be a performance bug in the
 * feature meant to fix performance.
 *
 * ## Design
 *
 * * **Off by default.** {@link PdfRenderMetrics.enabled} is false unless a caller
 *   turns it on, and every recording method returns immediately when it is off. No
 *   allocation, no timer read, no array growth.
 * * **No logging.** The module never writes to the console or the DOM. §4: "opt-in
 *   counters/timings; no per-frame production logging." The probe reads
 *   {@link PdfRenderMetrics.snapshot} and decides what to print.
 * * **Monotonic where it matters.** Durations use `performance.now()` deltas, which
 *   are monotonic; the snapshot's wall-clock stamp exists only so two snapshots can
 *   be told apart. `PDFVIEWER.md` §10: "Use monotonic clocks per process; correlate
 *   by IDs and per-stage duration rather than subtracting unsynchronized clocks."
 * * **Bounded memory.** Per-tile event logs are ring buffers with a fixed capacity,
 *   so a long scroll cannot grow the renderer's heap — which would show up as
 *   exactly the memory growth §10's stability gate is about.
 *
 * ## What it deliberately is not
 *
 * It is not a display-FPS counter and does not claim to be one. {@link FrameIntervals}
 * records `requestAnimationFrame` deltas, and §10 says plainly what that is worth:
 * "rAF is a useful cadence proxy, not proof that every frame reached the display."
 * Presentation timing (DWM, GPU present) is out of reach from a renderer, and the
 * snapshot names its fields accordingly — `frameIntervalMs`, never "fps".
 *
 * Copyright 2026 the Eukolia project authors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** A fixed-capacity ring buffer of numbers. Allocation-free once constructed. */
export class NumberRing {
  private readonly values: Float64Array;
  private cursor = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    this.values = new Float64Array(Math.max(1, Math.floor(capacity)));
  }

  push(value: number): void {
    if (!Number.isFinite(value)) return;
    this.values[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.values.length;
    if (this.filled < this.values.length) this.filled++;
  }

  get length(): number {
    return this.filled;
  }

  clear(): void {
    this.cursor = 0;
    this.filled = 0;
  }

  /** The recorded values, oldest first, as a plain array (the only allocating read). */
  toArray(): number[] {
    const out: number[] = [];
    const size = this.values.length;
    const start = this.filled < size ? 0 : this.cursor;
    for (let i = 0; i < this.filled; i++) out.push(this.values[(start + i) % size]);
    return out;
  }
}

/** count / p50 / p90 / p95 / p99 / max for a ring, or null when it is empty. */
export interface Distribution {
  count: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/**
 * Percentiles of a set of samples.
 *
 * `sorted[Math.floor(q * n)]` with the index clamped, which is the nearest-rank
 * definition: for `n = 100` the p95 is the 96th smallest, and for `n = 1` every
 * percentile is that one sample. Deliberately not interpolated — an interpolated
 * p95 across eight frames would report a frame interval that never happened, and
 * §10 asks for frames missing "one/two refresh budgets", which is a count of real
 * intervals against a real budget.
 */
export function distribution(samples: readonly number[]): Distribution | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
  let sum = 0;
  for (const value of sorted) sum += value;
  return {
    count: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length
  };
}

/**
 * Frame cadence and budget misses, recorded from `requestAnimationFrame`.
 *
 * §10: "Measure p50/p90/p95/p99 frame intervals, frames missing one/two refresh
 * budgets, longest stall". A "budget" is one refresh period, estimated from the
 * shortest interval observed unless the caller knows the display's rate.
 */
export class FrameIntervals {
  private readonly intervals: NumberRing;
  private lastTimestamp: number | null = null;
  private missedOne = 0;
  private missedTwo = 0;
  private longestStallMs = 0;
  private sampleCount = 0;

  constructor(capacity = 2048) {
    this.intervals = new NumberRing(capacity);
  }

  /**
   * Record one animation frame.
   *
   * The first call establishes the origin and records nothing: an interval needs two
   * timestamps.
   */
  record(timestampMs: number): void {
    if (!Number.isFinite(timestampMs)) return;
    const previous = this.lastTimestamp;
    this.lastTimestamp = timestampMs;
    if (previous === null) return;
    const delta = timestampMs - previous;
    if (!(delta > 0)) return;
    this.intervals.push(delta);
    this.sampleCount++;
    if (delta > this.longestStallMs) this.longestStallMs = delta;
  }

  get samples(): number {
    return this.sampleCount;
  }

  get intervalsMs(): NumberRing {
    return this.intervals;
  }

  /**
   * Classify the recorded intervals against a refresh period.
   *
   * Counts are *cumulative* until {@link reset}, because a budget miss that showed
   * up once should not be forgotten because the next second was clean.
   */
  classify(refreshMs: number): void {
    if (!(refreshMs > 0)) return;
    this.missedOne = 0;
    this.missedTwo = 0;
    for (const interval of this.intervals.toArray()) {
      if (interval > refreshMs * 2) this.missedTwo++;
      else if (interval > refreshMs * 1.5) this.missedOne++;
    }
  }

  reset(): void {
    this.intervals.clear();
    this.lastTimestamp = null;
    this.missedOne = 0;
    this.missedTwo = 0;
    this.longestStallMs = 0;
    this.sampleCount = 0;
  }

  /** The shortest observed interval, which is the best available refresh estimate. */
  estimatedRefreshMs(): number | null {
    const samples = this.intervals.toArray();
    if (samples.length === 0) return null;
    let shortest = samples[0];
    for (const value of samples) if (value < shortest) shortest = value;
    return shortest;
  }

  snapshot(): {
    samples: number;
    intervals: Distribution | null;
    estimatedRefreshMs: number | null;
    missedOneBudget: number;
    missedTwoBudgets: number;
    longestStallMs: number;
  } {
    return {
      samples: this.sampleCount,
      intervals: distribution(this.intervals.toArray()),
      estimatedRefreshMs: this.estimatedRefreshMs(),
      missedOneBudget: this.missedOne,
      missedTwoBudgets: this.missedTwo,
      longestStallMs: this.longestStallMs
    };
  }
}

/** Counters and timings the viewer accumulates while rendering tiles. */
export interface PdfRenderMetricsSnapshot {
  /** Wall clock at snapshot time, for telling two snapshots apart. Not used for durations. */
  at: number;
  enabled: boolean;
  frames: ReturnType<FrameIntervals['snapshot']>;
  requests: {
    /** Requests handed to the scheduler. */
    submitted: number;
    /** Requests that found a tile already resident. */
    deduplicated: number;
    /** Requests withdrawn before the engine ran them. */
    cancelled: number;
    /** Replies discarded because their generation or request id had been superseded. */
    stale: number;
    /** Replies that failed. */
    failed: number;
  };
  render: {
    /** Round trips that asked the engine for pixels. */
    completed: number;
    /** Native raster time reported by the engine, per reply. */
    rasterMs: Distribution | null;
    /** Wall time from submit to reply, per reply (includes IPC and native work). */
    roundTripMs: Distribution | null;
    /** Bytes received across the process boundary. */
    transportBytes: number;
    /** Pages rasterised; the warm-scroll gate is that this stops growing (§10). */
    pagesRasterised: number;
    /** Replies the engine served from its own cache. */
    engineCacheHits: number;
  };
  upload: {
    /** `drawImage`/`putImageData` calls into a tile surface. */
    count: number;
    /** Time spent uploading, per call. */
    uploadMs: Distribution | null;
    /** Bytes uploaded. */
    uploadedBytes: number;
    /** Frames on which at least one upload happened. */
    framesWithUploads: number;
  };
  coverage: {
    /** Tile that first covered part of the viewport, after the viewport moved. */
    firstCoverageMs: Distribution | null;
    /** Tile that reached the generation the viewport asked for. */
    targetSharpnessMs: Distribution | null;
  };
  cache: {
    /** Tiles resident in the renderer's tile store. */
    residentTiles: number;
    residentBytes: number;
    /** Evictions from the tile store. */
    evicted: number;
    /** Tiles that were served from a coarser or older generation as a fallback. */
    fallbackUses: number;
  };
}

/**
 * The recorder. One instance belongs to a viewer; it is enabled by the probe
 * through `window.__eukoliaPdfMetrics`.
 */
export class PdfRenderMetrics {
  enabled = false;
  readonly frames = new FrameIntervals();

  private readonly raster = new NumberRing(2048);
  private readonly roundTrip = new NumberRing(2048);
  private readonly upload = new NumberRing(2048);
  private readonly firstCoverage = new NumberRing(2048);
  private readonly sharpness = new NumberRing(2048);

  private counters = {
    submitted: 0,
    deduplicated: 0,
    cancelled: 0,
    stale: 0,
    failed: 0,
    completed: 0,
    transportBytes: 0,
    pagesRasterised: 0,
    engineCacheHits: 0,
    uploads: 0,
    uploadedBytes: 0,
    framesWithUploads: 0,
    evicted: 0,
    fallbackUses: 0
  };

  private residentTiles = 0;
  private residentBytes = 0;
  /** Set by the viewer so an upload can be attributed to a frame. */
  private uploadFrameId = 0;
  private lastUploadFrameId = -1;

  /** Called once per animation frame by the viewer's frame loop. */
  recordFrame(timestampMs: number): void {
    if (!this.enabled) return;
    this.frames.record(timestampMs);
  }

  /** Begins a new frame; uploads recorded before the next call belong to it. */
  beginFrame(frameId: number): void {
    if (!this.enabled) return;
    this.uploadFrameId = frameId;
  }

  recordSubmitted(count = 1): void {
    if (!this.enabled) return;
    this.counters.submitted += count;
  }

  recordDeduplicated(count = 1): void {
    if (!this.enabled) return;
    this.counters.deduplicated += count;
  }

  recordCancelled(count = 1): void {
    if (!this.enabled) return;
    this.counters.cancelled += count;
  }

  recordStale(count = 1): void {
    if (!this.enabled) return;
    this.counters.stale += count;
  }

  recordFailed(count = 1): void {
    if (!this.enabled) return;
    this.counters.failed += count;
  }

  /**
   * One completed engine round trip.
   *
   * `transportBytes` is the payload as the renderer received it — the RGBA buffer,
   * not the JSON header, which is the number §8's "bounded tile payloads" is about.
   */
  recordRender(options: {
    rasterMs?: number;
    roundTripMs: number;
    bytes: number;
    fromEngineCache?: boolean;
  }): void {
    if (!this.enabled) return;
    this.counters.completed++;
    this.counters.transportBytes += Math.max(0, options.bytes);
    if (!options.fromEngineCache) this.counters.pagesRasterised++;
    else this.counters.engineCacheHits++;
    if (typeof options.rasterMs === 'number') this.raster.push(options.rasterMs);
    this.roundTrip.push(options.roundTripMs);
  }

  /** One upload into a tile surface. */
  recordUpload(uploadMs: number, bytes: number): void {
    if (!this.enabled) return;
    this.counters.uploads++;
    this.counters.uploadedBytes += Math.max(0, bytes);
    this.upload.push(uploadMs);
    if (this.lastUploadFrameId !== this.uploadFrameId) {
      this.lastUploadFrameId = this.uploadFrameId;
      this.counters.framesWithUploads++;
    }
  }

  /**
   * A viewport move began.
   *
   * Returns a token the caller passes back to {@link recordCoverage} /
   * {@link recordSharpness}; `null` when metrics are off, so the caller does no work.
   */
  recordViewportMove(): { at: number } | null {
    if (!this.enabled) return null;
    return { at: performance.now() };
  }

  /** The first tile of a new viewport became visible. */
  recordCoverage(move: { at: number } | null): void {
    if (!this.enabled || !move) return;
    const delta = performance.now() - move.at;
    if (delta >= 0) this.firstCoverage.push(delta);
  }

  /** Every visible tile reached the requested generation after a move. */
  recordSharpness(move: { at: number } | null): void {
    if (!this.enabled || !move) return;
    const delta = performance.now() - move.at;
    if (delta >= 0) this.sharpness.push(delta);
  }

  recordTileStore(tiles: number, bytes: number): void {
    if (!this.enabled) return;
    this.residentTiles = tiles;
    this.residentBytes = bytes;
  }

  recordEviction(count = 1): void {
    if (!this.enabled) return;
    this.counters.evicted += count;
  }

  recordFallbackUse(count = 1): void {
    if (!this.enabled) return;
    this.counters.fallbackUses += count;
  }

  snapshot(): PdfRenderMetricsSnapshot {
    const c = this.counters;
    const refreshMs = this.frames.estimatedRefreshMs();
    if (refreshMs !== null) this.frames.classify(refreshMs);
    return {
      at: Date.now(),
      enabled: this.enabled,
      frames: this.frames.snapshot(),
      requests: {
        submitted: c.submitted,
        deduplicated: c.deduplicated,
        cancelled: c.cancelled,
        stale: c.stale,
        failed: c.failed
      },
      render: {
        completed: c.completed,
        rasterMs: distribution(this.raster.toArray()),
        roundTripMs: distribution(this.roundTrip.toArray()),
        transportBytes: c.transportBytes,
        pagesRasterised: c.pagesRasterised,
        engineCacheHits: c.engineCacheHits
      },
      upload: {
        count: c.uploads,
        uploadMs: distribution(this.upload.toArray()),
        uploadedBytes: c.uploadedBytes,
        framesWithUploads: c.framesWithUploads
      },
      coverage: {
        firstCoverageMs: distribution(this.firstCoverage.toArray()),
        targetSharpnessMs: distribution(this.sharpness.toArray())
      },
      cache: {
        residentTiles: this.residentTiles,
        residentBytes: this.residentBytes,
        evicted: c.evicted,
        fallbackUses: c.fallbackUses
      }
    };
  }

  reset(): void {
    this.raster.clear();
    this.roundTrip.clear();
    this.upload.clear();
    this.firstCoverage.clear();
    this.sharpness.clear();
    this.frames.reset();
    this.counters = {
      submitted: 0,
      deduplicated: 0,
      cancelled: 0,
      stale: 0,
      failed: 0,
      completed: 0,
      transportBytes: 0,
      pagesRasterised: 0,
      engineCacheHits: 0,
      uploads: 0,
      uploadedBytes: 0,
      framesWithUploads: 0,
      evicted: 0,
      fallbackUses: 0
    };
    this.lastUploadFrameId = -1;
  }
}

/**
 * The install point the benchmark harness uses.
 *
 * `PDFVIEWER.md` §9: new diagnostics belong behind developer instrumentation, not in
 * normal reading UI. A probe (`scripts/probe-pdf-frames.mjs`) enables this from a
 * client script; nothing in the viewer turns it on by itself, and with it off every
 * recording call is a single boolean test.
 */
declare global {
  interface Window {
    __eukoliaPdfMetrics?: {
      enable(): PdfRenderMetricsSnapshot;
      disable(): void;
      snapshot(): PdfRenderMetricsSnapshot;
      reset(): void;
    };
  }
}

/** Publish `metrics` on `window.__eukoliaPdfMetrics`, returning an uninstall function. */
export function installPdfMetrics(metrics: PdfRenderMetrics): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const had = Object.prototype.hasOwnProperty.call(window, '__eukoliaPdfMetrics');
  const previous = window.__eukoliaPdfMetrics;
  let frame = 0;
  let frameId = 0;
  const sample = (timestamp: number) => {
    frame = 0;
    if (!metrics.enabled) return;
    metrics.recordFrame(timestamp);
    metrics.beginFrame(++frameId);
    frame = requestAnimationFrame(sample);
  };
  window.__eukoliaPdfMetrics = {
    enable: () => {
      metrics.enabled = true;
      metrics.reset();
      if (!frame) frame = requestAnimationFrame(sample);
      return metrics.snapshot();
    },
    disable: () => {
      metrics.enabled = false;
      cancelAnimationFrame(frame);
      frame = 0;
    },
    snapshot: () => metrics.snapshot(),
    reset: () => metrics.reset()
  };
  return () => {
    cancelAnimationFrame(frame);
    if (had) window.__eukoliaPdfMetrics = previous;
    else delete window.__eukoliaPdfMetrics;
  };
}
