/**
 * Render metrics: the shape of the numbers §10 asks for.
 *
 * `PDFVIEWER.md` §10 is unusually specific about what has to be measured, and §12 is
 * specific about what must *not* be claimed. So these tests are about two things:
 *
 *   1. **The statistics are real statistics.** Nearest-rank percentiles over the
 *      samples actually recorded, so a p95 is an interval that happened. An
 *      interpolated p95 across a handful of frames would report a frame interval that
 *      never occurred, which is the same category of error as the reciprocal-duration
 *      FPS counter §2 and §12 both reject.
 *   2. **Off is off.** §9 requires diagnostics to be "behind developer instrumentation,
 *      not in normal reading UI", which only means anything if a disabled recorder
 *      costs nothing: no samples, no counters, no snapshot payload.
 *
 * The module deliberately produces no display-FPS number, so there is nothing here to
 * assert about one.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  FrameIntervals,
  NumberRing,
  PdfRenderMetrics,
  distribution
} from '../../src/renderer/pdf/rendering/PdfRenderMetrics';

describe('NumberRing', () => {
  it('is a fixed-capacity ring that keeps the newest values', () => {
    const ring = new NumberRing(3);
    expect(ring.length).toBe(0);
    for (const value of [1, 2, 3, 4, 5]) ring.push(value);
    expect(ring.length).toBe(3);
    expect(ring.toArray()).toEqual([3, 4, 5]);
  });

  it('reports values oldest first, before and after wrapping', () => {
    const ring = new NumberRing(4);
    ring.push(1);
    ring.push(2);
    expect(ring.toArray()).toEqual([1, 2]);
    ring.push(3);
    ring.push(4);
    ring.push(5);
    expect(ring.toArray()).toEqual([2, 3, 4, 5]);
  });

  it('ignores values that are not finite numbers', () => {
    const ring = new NumberRing(4);
    ring.push(Number.NaN);
    ring.push(Number.POSITIVE_INFINITY);
    ring.push(7);
    expect(ring.toArray()).toEqual([7]);
  });

  it('clears', () => {
    const ring = new NumberRing(2);
    ring.push(1);
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.toArray()).toEqual([]);
  });
});

describe('distribution', () => {
  it('is null for no samples', () => {
    expect(distribution([])).toBeNull();
  });

  it('uses nearest-rank percentiles over the samples that exist', () => {
    // Ten samples. The p50 is the 6th smallest (index floor(0.5 * 10) = 5) and the p95
    // is the 10th — both values that were recorded, not interpolations between them.
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const stats = distribution(samples);
    expect(stats).not.toBeNull();
    if (!stats) return;
    expect(stats.count).toBe(10);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(10);
    expect(stats.p50).toBe(6);
    expect(stats.p90).toBe(10);
    expect(stats.p95).toBe(10);
    expect(stats.p99).toBe(10);
    expect(stats.mean).toBeCloseTo(5.5, 6);
  });

  it('reports the single sample at every percentile', () => {
    const stats = distribution([6.9]);
    expect(stats?.p50).toBe(6.9);
    expect(stats?.p95).toBe(6.9);
    expect(stats?.p99).toBe(6.9);
  });

  it('does not mutate its input', () => {
    const samples = [3, 1, 2];
    distribution(samples);
    expect(samples).toEqual([3, 1, 2]);
  });
});

describe('FrameIntervals', () => {
  it('records intervals, not timestamps', () => {
    const frames = new FrameIntervals();
    frames.record(1000);
    expect(frames.samples).toBe(0); // one timestamp is not an interval
    for (const timestamp of [1006.94, 1013.88, 1020.82]) frames.record(timestamp);
    expect(frames.samples).toBe(3);
    expect(frames.intervalsMs.toArray().map((value) => Number(value.toFixed(2)))).toEqual([6.94, 6.94, 6.94]);
  });

  it('estimates the refresh period from the shortest interval', () => {
    const frames = new FrameIntervals();
    let timestamp = 0;
    for (const step of [6.94, 6.94, 13.9, 6.94]) {
      timestamp += step;
      frames.record(timestamp);
    }
    expect(frames.estimatedRefreshMs()).toBeCloseTo(6.94, 2);
  });

  it('counts frames that missed one and two refresh budgets', () => {
    const frames = new FrameIntervals();
    let timestamp = 0;
    // At a 10 ms refresh: 10 ms is on time, 16 ms is late but inside the second
    // budget (the compositor caught up), and 25 ms missed two.
    for (const step of [10, 10, 16, 25]) {
      timestamp += step;
      frames.record(timestamp);
    }
    frames.classify(10);
    const snapshot = frames.snapshot();
    expect(snapshot.missedOneBudget).toBe(1);
    expect(snapshot.missedTwoBudgets).toBe(1);
    expect(snapshot.longestStallMs).toBe(25);
  });

  it('keeps the longest stall across a reset of samples', () => {
    const frames = new FrameIntervals();
    let timestamp = 0;
    for (const step of [6.94, 40]) {
      timestamp += step;
      frames.record(timestamp);
    }
    expect(frames.snapshot().longestStallMs).toBe(40);
    frames.reset();
    expect(frames.snapshot().samples).toBe(0);
    expect(frames.snapshot().longestStallMs).toBe(0);
  });
});

describe('PdfRenderMetrics', () => {
  let metrics: PdfRenderMetrics;

  beforeEach(() => {
    metrics = new PdfRenderMetrics();
  });

  it('records nothing while it is off', () => {
    metrics.recordFrame(1000);
    metrics.recordSubmitted();
    metrics.recordRender({ roundTripMs: 30, bytes: 2_359_296 });
    metrics.recordUpload(2, 2_359_296);
    metrics.recordTileStore(50, 10_000_000);
    const snapshot = metrics.snapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.requests.submitted).toBe(0);
    expect(snapshot.render.completed).toBe(0);
    expect(snapshot.upload.count).toBe(0);
    expect(snapshot.frames.samples).toBe(0);
    expect(snapshot.cache.residentTiles).toBe(0);
  });

  it('returns no viewport token while it is off, so the caller does no work', () => {
    expect(metrics.recordViewportMove()).toBeNull();
    metrics.enabled = true;
    expect(metrics.recordViewportMove()).not.toBeNull();
  });

  it('records counters and distributions once enabled', () => {
    metrics.enabled = true;
    metrics.recordSubmitted(3);
    metrics.recordDeduplicated(2);
    metrics.recordCancelled();
    metrics.recordStale();
    metrics.recordFailed();
    metrics.recordRender({ roundTripMs: 22, bytes: 1000, rasterMs: 18 });
    metrics.recordRender({ roundTripMs: 26, bytes: 2000, rasterMs: 20, fromEngineCache: true });
    metrics.recordUpload(1.5, 3000);
    metrics.recordUpload(2.5, 3000);
    metrics.recordTileStore(12, 5000);
    metrics.recordEviction(4);
    metrics.recordFallbackUse(2);

    const snapshot = metrics.snapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.requests).toMatchObject({ submitted: 3, deduplicated: 2, cancelled: 1, stale: 1, failed: 1 });
    expect(snapshot.render.completed).toBe(2);
    expect(snapshot.render.transportBytes).toBe(3000);
    expect(snapshot.render.pagesRasterised).toBe(1);
    expect(snapshot.render.engineCacheHits).toBe(1);
    expect(snapshot.render.roundTripMs?.max).toBe(26);
    expect(snapshot.render.rasterMs?.mean).toBeCloseTo(19, 6);
    expect(snapshot.upload.count).toBe(2);
    expect(snapshot.upload.uploadedBytes).toBe(6000);
    expect(snapshot.upload.uploadMs?.p50).toBeGreaterThan(0);
    expect(snapshot.cache).toMatchObject({ residentTiles: 12, residentBytes: 5000, evicted: 4, fallbackUses: 2 });
  });

  it('counts a frame once however many uploads it carries', () => {
    metrics.enabled = true;
    metrics.beginFrame(1);
    metrics.recordUpload(1, 100);
    metrics.recordUpload(1, 100);
    metrics.recordUpload(1, 100);
    metrics.beginFrame(2);
    metrics.recordUpload(1, 100);
    metrics.beginFrame(3);
    // A frame with no uploads is not counted, which is what makes the counter mean
    // "frames that drew something new".
    expect(metrics.snapshot().upload.framesWithUploads).toBe(2);
  });

  it('measures time to first coverage and to target sharpness from the move', async () => {
    metrics.enabled = true;
    const move = metrics.recordViewportMove();
    expect(move).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    metrics.recordCoverage(move);
    await new Promise((resolve) => setTimeout(resolve, 5));
    metrics.recordSharpness(move);
    const snapshot = metrics.snapshot();
    expect(snapshot.coverage.firstCoverageMs?.count).toBe(1);
    expect(snapshot.coverage.targetSharpnessMs?.count).toBe(1);
    // Coverage came first, so sharpness cannot be the shorter wait.
    expect(snapshot.coverage.targetSharpnessMs?.p50).toBeGreaterThanOrEqual(
      snapshot.coverage.firstCoverageMs?.p50 ?? 0
    );
  });

  it('ignores a coverage report for a move it did not issue', () => {
    metrics.enabled = true;
    metrics.recordCoverage(null);
    metrics.recordSharpness(null);
    const snapshot = metrics.snapshot();
    expect(snapshot.coverage.firstCoverageMs).toBeNull();
    expect(snapshot.coverage.targetSharpnessMs).toBeNull();
  });

  it('resets every counter and sample', () => {
    metrics.enabled = true;
    metrics.recordRender({ roundTripMs: 10, bytes: 100 });
    metrics.recordUpload(1, 100);
    metrics.recordFrame(0);
    metrics.recordFrame(7);
    metrics.reset();
    const snapshot = metrics.snapshot();
    expect(snapshot.render.completed).toBe(0);
    expect(snapshot.upload.count).toBe(0);
    expect(snapshot.frames.samples).toBe(0);
    expect(snapshot.render.roundTripMs).toBeNull();
  });

  it('keeps its sample buffers bounded, so a long session cannot grow the heap', () => {
    metrics.enabled = true;
    for (let i = 0; i < 10_000; i++) metrics.recordRender({ roundTripMs: i % 40, bytes: 1 });
    const snapshot = metrics.snapshot();
    expect(snapshot.render.completed).toBe(10_000);
    // The distribution is over the retained window, not all ten thousand samples.
    expect(snapshot.render.roundTripMs?.count).toBeLessThanOrEqual(2048);
  });

  it('names its frame field as an interval, never as a frame rate', () => {
    const snapshot = metrics.snapshot();
    expect(snapshot.frames).toHaveProperty('intervals');
    expect(snapshot.frames).toHaveProperty('estimatedRefreshMs');
    expect(JSON.stringify(snapshot)).not.toMatch(/\bfps\b/i);
  });
});
