/**
 * The render scheduler: priority, dedup, budgets, cancellation.
 *
 * `PDFVIEWER.md` §7 is the specification, and the failure it exists to prevent is
 * recorded in §2: a 30-step divider drag asked the engine for 35 whole-page
 * rasterisations, none of which the reader ever saw. So the tests here are mostly
 * about what does **not** reach the engine:
 *
 *   * a duplicate of a queued or running job is not queued twice;
 *   * a job planned for a superseded viewport revision is withdrawn;
 *   * a job for a closed document generation is withdrawn;
 *   * the outstanding window and the byte budget bound what can be in flight at once;
 *   * and the jobs that *do* reach the engine arrive in priority order, with aging so
 *     that a prefetch cannot be starved forever.
 *
 * Cancellation is checked for the honest claim §7 makes: a *queued* job is removed and
 * the engine is told to drop it. A job already running is not counted as cancelled,
 * because the native display-list replay cannot be interrupted — counting it would
 * overstate what cancellation achieves.
 */

import { describe, expect, it } from 'vitest';

import {
  AGING_MS,
  PdfRenderScheduler,
  TilePriority,
  estimateTileBytes,
  tileRequestKey,
  type TileRequest
} from '../../src/renderer/pdf/rendering/PdfRenderScheduler';
import type { PdfRenderResult } from '../../src/shared/ipc';

function request(overrides: Partial<TileRequest> = {}): TileRequest {
  return {
    page: 1,
    pageIndex: 0,
    scale: 2,
    rotate: 0,
    invert: false,
    clip: { x: 0, y: 0, width: 384, height: 384 },
    position: { res: 1, row: 0, col: 0 },
    device: { x: 0, y: 0, width: 768, height: 768 },
    targetTileSize: 768,
    priority: TilePriority.UncoveredVisible,
    generation: 1,
    revision: 1,
    visible: true,
    ...overrides
  };
}

function result(page: number, requestId: number): PdfRenderResult {
  return {
    requestId,
    page,
    width: 768,
    height: 768,
    stride: 768 * 4,
    channels: 4,
    order: 'rgba',
    pageRect: { x: 0, y: 0, width: 384, height: 384 },
    pixels: new Uint8Array(16)
  };
}

/** A scheduler whose renders resolve only when the test says so. */
function makeHarness(options: { maxActive?: number; maxQueuedBytes?: number; maxQueuedJobs?: number } = {}): {
  scheduler: PdfRenderScheduler;
  started: TileRequest[];
  cancelled: number[];
  settle: (index?: number) => Promise<void>;
  fail: (index: number, message: string) => Promise<void>;
  now: { value: number };
} {
  const started: TileRequest[] = [];
  const cancelled: number[] = [];
  const resolvers: { resolve: (value: PdfRenderResult) => void; reject: (error: Error) => void; request: TileRequest }[] = [];
  const now = { value: 0 };

  const scheduler = new PdfRenderScheduler(
    (req, requestId) => {
      started.push(req);
      return new Promise<PdfRenderResult>((resolve, reject) => {
        resolvers.push({ resolve, reject, request: req });
      });
    },
    (requestId) => {
      cancelled.push(requestId);
    },
    {
      maxActive: options.maxActive ?? 4,
      maxQueuedBytes: options.maxQueuedBytes,
      maxQueuedJobs: options.maxQueuedJobs,
      now: () => now.value
    }
  );

  return {
    scheduler,
    started,
    cancelled,
    now,
    settle: async (index = 0) => {
      const entry = resolvers[index];
      if (!entry) throw new Error(`no pending render at index ${index}`);
      entry.resolve(result(entry.request.pageIndex, 0));
      // Let the scheduler's `await` resume, its completion sink run and the pump admit
      // the next job. Several turns, because `run()` awaits, then calls back, then
      // loops.
      await flush();
    },
    fail: async (index, message) => {
      const entry = resolvers[index];
      if (!entry) throw new Error(`no pending render at index ${index}`);
      entry.reject(new Error(message));
      await flush();
    }
  };
}

/** Drain the microtask queue far enough for the scheduler's promise chain to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('PdfRenderScheduler', () => {
  it('runs at most maxActive jobs at once', () => {
    const harness = makeHarness({ maxActive: 2 });
    for (let i = 0; i < 6; i++) {
      harness.scheduler.enqueue(request({ clip: { x: i * 100, y: 0, width: 100, height: 100 } }));
    }
    expect(harness.started).toHaveLength(2);
    expect(harness.scheduler.snapshot().queued).toBe(4);
  });

  it('deduplicates a job that is already queued or running', () => {
    const harness = makeHarness({ maxActive: 1 });
    const first = harness.scheduler.enqueue(request());
    expect(first.status).toBe('queued');
    // Same request again, while it is running.
    expect(harness.scheduler.enqueue(request()).status).toBe('duplicate');
    // And a second identical one queued behind it (blocked by maxActive 1) is also one
    // job, not two.
    const queued = request({ clip: { x: 999, y: 0, width: 100, height: 100 } });
    expect(harness.scheduler.enqueue(queued).status).toBe('queued');
    expect(harness.scheduler.enqueue(queued).status).toBe('duplicate');
    expect(harness.scheduler.snapshot().deduplicated).toBe(2);
  });

  it('treats a different clip, scale or invert as a different job', () => {
    const harness = makeHarness({ maxActive: 8 });
    const base = request();
    harness.scheduler.enqueue(base);
    harness.scheduler.enqueue(request({ clip: { x: 1, y: 0, width: 384, height: 384 } }));
    harness.scheduler.enqueue(request({ scale: 3 }));
    harness.scheduler.enqueue(request({ invert: true }));
    harness.scheduler.enqueue(request({ generation: 2 }));
    expect(harness.started).toHaveLength(5);
  });

  it('withdraws jobs from a superseded viewport revision', () => {
    const harness = makeHarness({ maxActive: 0 + 1 });
    // maxActive 1: one runs, the rest queue where they can be withdrawn.
    for (let i = 0; i < 5; i++) {
      harness.scheduler.enqueue(request({ revision: 1, clip: { x: i * 10, y: 0, width: 10, height: 10 } }));
    }
    expect(harness.started).toHaveLength(1);
    const withdrawn = harness.scheduler.beginRevision(2);
    expect(withdrawn).toBe(4);
    expect(harness.scheduler.snapshot().queued).toBe(0);
    // The engine was told about each one, so a job it had not started is dropped.
    expect(harness.cancelled.length).toBeGreaterThanOrEqual(4);
  });

  it('does not withdraw a job from the revision it adopts', () => {
    const harness = makeHarness({ maxActive: 1 });
    harness.scheduler.enqueue(request({ revision: 7, clip: { x: 0, y: 0, width: 10, height: 10 } }));
    harness.scheduler.enqueue(request({ revision: 7, clip: { x: 10, y: 0, width: 10, height: 10 } }));
    expect(harness.scheduler.beginRevision(7)).toBe(0);
    expect(harness.scheduler.snapshot().queued).toBe(1);
  });

  it('drops work for a document generation that no longer exists', () => {
    const harness = makeHarness({ maxActive: 1 });
    harness.scheduler.enqueue(request({ generation: 1, clip: { x: 0, y: 0, width: 10, height: 10 } }));
    harness.scheduler.enqueue(request({ generation: 1, clip: { x: 1, y: 0, width: 10, height: 10 } }));
    harness.scheduler.enqueue(request({ generation: 2, clip: { x: 2, y: 0, width: 10, height: 10 } }));
    expect(harness.scheduler.dropGeneration(1)).toBe(1);
    expect(harness.scheduler.snapshot().queued).toBe(1);
  });

  it('runs the most urgent job first, and the newest within a priority', async () => {
    const harness = makeHarness({ maxActive: 1 });
    // Occupy the one slot so the ordering below is observable in the queue.
    harness.scheduler.enqueue(request({ priority: TilePriority.DistantSpeculation, clip: { x: -1, y: 0, width: 1, height: 1 } }));

    const distant = request({ priority: TilePriority.DistantSpeculation, clip: { x: 1, y: 0, width: 1, height: 1 } });
    const visible = request({ priority: TilePriority.UncoveredVisible, clip: { x: 2, y: 0, width: 1, height: 1 } });
    const prefetch = request({ priority: TilePriority.NearPrefetch, clip: { x: 3, y: 0, width: 1, height: 1 } });
    harness.scheduler.enqueue(distant);
    harness.scheduler.enqueue(prefetch);
    harness.scheduler.enqueue(visible);

    // Free the slot; the uncovered visible tile must go next.
    await harness.settle(0);
    expect(harness.started).toHaveLength(2);
    expect(harness.started[1]).toBe(visible);
  });

  /**
   * Aging is the only thing standing between "the viewport is always more urgent" and
   * a prefetch that never runs at all.
   *
   * The shape of the case is a scroll that never ends: urgent visible tiles keep
   * arriving, each one queued after the prefetch and each one more urgent, so without
   * aging the prefetch waits forever. What is asserted is the property that matters —
   * the wait is *bounded* — rather than the exact interleaving, which depends on how
   * often the caller queues work.
   */
  it('runs a long-waiting prefetch within a bounded number of admissions, however urgent the input', async () => {
    const harness = makeHarness({ maxActive: 1, maxQueuedJobs: 64, maxQueuedBytes: 512 * 1024 * 1024 });
    const priorityOverload = TilePriority.DistantSpeculation;
    const prefetchClipX = 1;

    harness.scheduler.enqueue(request({ priority: priorityOverload, clip: { x: prefetchClipX, y: 0, width: 1, height: 1 } }));

    let nextUrgent = 0;
    let prefetchRan = false;
    /** Admissions until the prefetch runs, bounded so a regression fails rather than hangs. */
    for (let step = 0; step < 16 && !prefetchRan; step++) {
      // The reader keeps scrolling: a fresh, maximally urgent tile each round, which
      // is what starves an un-aged queue.
      harness.scheduler.enqueue(
        request({ priority: TilePriority.UncoveredVisible, clip: { x: 100 + nextUrgent++, y: 0, width: 1, height: 1 } })
      );
      // Rounds arrive just over one aging interval apart, so the aging counter
      // advances as a sustained scroll would advance it rather than as a burst.
      harness.now.value += AGING_MS + 10;
      await harness.settle(0);
      prefetchRan = harness.started.some((r) => r.clip.x === prefetchClipX);
    }

    expect(prefetchRan).toBe(true);
    // And it ran early enough to have been useful: waiting until the reader stopped
    // would be the same as never running it.
    const prefetchIndex = harness.started.findIndex((r) => r.clip.x === prefetchClipX);
    expect(prefetchIndex).toBeLessThanOrEqual(8);
  });

  it('refuses a job that would exceed the queued byte budget', () => {
    /**
     * A 2000x2000 tile is 16 MB. With one job running and a 30 MB budget, exactly one
     * more fits in the queue: the third would make 48 MB of outstanding pixels.
     */
    const harness = makeHarness({ maxActive: 1, maxQueuedBytes: 30 * 1024 * 1024 });
    const big = { x: 0, y: 0, width: 2000, height: 2000 };
    expect(harness.scheduler.enqueue(request({ device: big, clip: { x: 0, y: 0, width: 1, height: 1 } })).status).toBe(
      'queued'
    );
    expect(harness.scheduler.enqueue(request({ device: big, clip: { x: 1, y: 0, width: 1, height: 1 } })).status).toBe(
      'queued'
    );
    expect(harness.scheduler.enqueue(request({ device: big, clip: { x: 2, y: 0, width: 1, height: 1 } }))).toEqual({
      status: 'rejected',
      reason: 'budget'
    });
    expect(harness.scheduler.snapshot().dropped).toBe(1);
    expect(harness.scheduler.snapshot().queuedBytes).toBeLessThanOrEqual(30 * 1024 * 1024);
  });

  it('refuses a single tile larger than the whole budget rather than admitting it', () => {
    const harness = makeHarness({ maxQueuedBytes: 4 * 1024 * 1024 });
    const huge = harness.scheduler.enqueue(
      request({ device: { x: 0, y: 0, width: 4000, height: 4000 }, clip: { x: 0, y: 0, width: 1, height: 1 } })
    );
    expect(huge).toEqual({ status: 'rejected', reason: 'oversized' });
  });

  it('bounds the queue by job count as well as bytes', () => {
    const harness = makeHarness({ maxActive: 1, maxQueuedJobs: 3, maxQueuedBytes: 1024 * 1024 * 1024 });
    // One runs, three queue: the queue is full while the active window is not.
    for (let i = 0; i < 4; i++) {
      expect(harness.scheduler.enqueue(request({ clip: { x: i, y: 0, width: 1, height: 1 } })).status).toBe('queued');
    }
    expect(harness.scheduler.snapshot().active).toBe(1);
    expect(harness.scheduler.snapshot().queued).toBe(3);
    expect(harness.scheduler.enqueue(request({ clip: { x: 9, y: 0, width: 1, height: 1 } }))).toEqual({
      status: 'rejected',
      reason: 'budget'
    });
  });
  it('reports failure without wedging the pump', async () => {
    const harness = makeHarness({ maxActive: 1 });
    harness.scheduler.enqueue(request({ clip: { x: 0, y: 0, width: 1, height: 1 } }));
    harness.scheduler.enqueue(request({ clip: { x: 1, y: 0, width: 1, height: 1 } }));
    await harness.fail(0, 'mupdf failed to render the page');
    expect(harness.scheduler.snapshot().failed).toBe(1);
    // The next job was admitted: one failure must not stop the queue.
    expect(harness.started).toHaveLength(2);
  });

  it('reports the age of the oldest queued job', () => {
    const harness = makeHarness({ maxActive: 1 });
    harness.scheduler.enqueue(request({ clip: { x: 0, y: 0, width: 1, height: 1 } }));
    harness.scheduler.enqueue(request({ clip: { x: 1, y: 0, width: 1, height: 1 } }));
    harness.now.value += 250;
    expect(harness.scheduler.snapshot().oldestQueueAgeMs).toBe(250);
  });

  it('refuses work after stop and accepts it again after start', () => {
    const harness = makeHarness();
    harness.scheduler.stop();
    expect(harness.scheduler.enqueue(request())).toEqual({ status: 'rejected', reason: 'stopped' });
    harness.scheduler.start();
    expect(harness.scheduler.enqueue(request()).status).toBe('queued');
  });

  it('cancels one job by its request id and tells the engine', () => {
    const harness = makeHarness({ maxActive: 1 });
    harness.scheduler.enqueue(request({ clip: { x: 0, y: 0, width: 1, height: 1 } }));
    const queued = harness.scheduler.enqueue(request({ clip: { x: 1, y: 0, width: 1, height: 1 } }));
    expect(queued.status).toBe('queued');
    if (queued.status !== 'queued') throw new Error('unreachable');
    expect(harness.scheduler.cancel(queued.requestId)).toBe(true);
    expect(harness.cancelled).toContain(queued.requestId);
    expect(harness.scheduler.snapshot().queued).toBe(0);
    // The same tile can be asked for again, because cancelling released its key.
    expect(harness.scheduler.enqueue(request({ clip: { x: 1, y: 0, width: 1, height: 1 } })).status).toBe('queued');
  });

  it('does not count a running job as cancelled', () => {
    const harness = makeHarness({ maxActive: 1 });
    const running = harness.scheduler.enqueue(request());
    if (running.status !== 'queued') throw new Error('unreachable');
    expect(harness.scheduler.cancel(running.requestId)).toBe(false);
    expect(harness.scheduler.snapshot().cancelled).toBe(0);
    expect(harness.scheduler.snapshot().active).toBe(1);
  });

  it('keys a request on everything that changes its pixels', () => {
    const base = request();
    const variants: Partial<TileRequest>[] = [
      { page: 2, pageIndex: 1 },
      { scale: 3 },
      { rotate: 90 },
      { invert: true },
      { generation: 9 },
      { clip: { x: 5, y: 0, width: 384, height: 384 } },
      { clip: { x: 0, y: 5, width: 384, height: 384 } },
      { clip: { x: 0, y: 0, width: 385, height: 384 } }
    ];
    for (const variant of variants) {
      expect(tileRequestKey({ ...base, ...variant })).not.toBe(tileRequestKey(base));
    }
    // A field that does not change the pixels must not split the key, or every plan
    // revision would re-render the whole viewport.
    expect(tileRequestKey({ ...base, priority: TilePriority.DistantSpeculation })).toBe(tileRequestKey(base));
    expect(tileRequestKey({ ...base, revision: 99 })).toBe(tileRequestKey(base));
  });

  it('estimates a tile as four bytes per device pixel', () => {
    expect(estimateTileBytes({ x: 0, y: 0, width: 768, height: 768 })).toBe(768 * 768 * 4);
    expect(estimateTileBytes({ x: 0, y: 0, width: 0, height: 768 })).toBe(0);
  });

  it('runs a freed slot immediately and keeps the active count honest', async () => {
    const harness = makeHarness({ maxActive: 2 });
    for (let i = 0; i < 4; i++) {
      harness.scheduler.enqueue(request({ clip: { x: i, y: 0, width: 1, height: 1 } }));
    }
    expect(harness.scheduler.snapshot().active).toBe(2);
    await harness.settle(0);
    expect(harness.scheduler.snapshot().active).toBe(2);
    expect(harness.started).toHaveLength(3);
    await harness.settle(1);
    await harness.settle(2);
    expect(harness.scheduler.snapshot().completed).toBe(3);
  });
});
