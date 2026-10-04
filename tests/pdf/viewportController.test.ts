/**
 * The viewport controller: coalescing, and what counts as a change.
 *
 * `PDFVIEWER.md` §7 is the specification here, and every test below is one clause of
 * it:
 *
 *   * "Publish viewport changes at most once per frame" — N `observe` calls between
 *     two frames deliver one callback.
 *   * "only when meaningful geometry/tile visibility changes" — a sub-tile scroll
 *     delivers none at all, and a change of scale, rotation, DPR or generation
 *     always delivers one.
 *   * "Compute visible pages via the existing indexed/binary-search layout; do not
 *     scan every page on every animation frame" — the controller does not know about
 *     pages; it exists so the pass that does can run once per frame instead of once
 *     per event. The test that matters is therefore the *count* of passes.
 *   * "When the user reverses direction, keep reusable cached tiles but demote/cancel
 *     obsolete speculative jobs" — direction and velocity are reported so the
 *     scheduler can act on a reversal.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  MEANINGFUL_TILE_FRACTION,
  PdfViewportController,
  samePlan,
  type ViewportState
} from '../../src/renderer/pdf/rendering/PdfViewportController';

/**
 * A deterministic frame clock.
 *
 * The controller is deliberately given its scheduler rather than reaching for
 * `requestAnimationFrame`, so a test can decide exactly when a frame happens — which
 * is the only way to assert "at most once per frame" without depending on a real
 * display's cadence.
 */
function makeClock(): {
  request: (callback: (timestamp: number) => void) => number;
  cancel: (handle: number) => void;
  runFrame: (timestamp?: number) => void;
  pending: () => number;
} {
  let nextHandle = 1;
  const queued = new Map<number, (timestamp: number) => void>();
  let now = 0;
  return {
    request: (callback) => {
      const handle = nextHandle++;
      queued.set(handle, callback);
      return handle;
    },
    cancel: (handle) => {
      queued.delete(handle);
    },
    runFrame: (timestamp) => {
      now = timestamp ?? now + 1000 / 144;
      const callbacks = [...queued.values()];
      queued.clear();
      for (const callback of callbacks) callback(now);
    },
    pending: () => queued.size
  };
}

function base(overrides: Partial<Omit<ViewportState, 'revision'>> = {}): Partial<Omit<ViewportState, 'revision'>> {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    width: 800,
    height: 600,
    layoutScale: 1,
    devicePixelRatio: 1,
    rotation: 0,
    generation: 1,
    renderAheadPages: 1,
    ...overrides
  };
}

describe('PdfViewportController', () => {
  let controller: PdfViewportController;
  let clock: ReturnType<typeof makeClock>;
  let deliveries: ViewportState[];

  beforeEach(() => {
    controller = new PdfViewportController({ tileDevicePx: 768 });
    clock = makeClock();
    controller.useFrameScheduler(clock.request, clock.cancel);
    deliveries = [];
    controller.subscribe((state) => deliveries.push(state));
  });

  it('coalesces a burst of observations into one callback per frame', () => {
    controller.observe(base({ scrollTop: 0 }));
    clock.runFrame();
    deliveries.length = 0;

    // Sixty scroll events in one frame — a trackpad gesture at 144 Hz is far fewer,
    // but a wheel burst or a `scroll` event storm is not bounded by the frame rate.
    for (let i = 1; i <= 60; i++) controller.observe({ scrollTop: i * 40 });
    expect(deliveries).toHaveLength(0);
    expect(clock.pending()).toBe(1);

    clock.runFrame();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].scrollTop).toBe(2400);
    expect(clock.pending()).toBe(0);
  });

  it('delivers nothing when the movement is smaller than a tile', () => {
    controller.observe(base({ scrollTop: 0 }));
    clock.runFrame();
    deliveries.length = 0;

    // Three steps of a quarter of the threshold each: half a tile of travel in total,
    // which is a slow trackpad drag. The plan's inputs — which tiles intersect the
    // viewport — are unchanged, so there is nothing to publish.
    const step = 768 * MEANINGFUL_TILE_FRACTION * 0.25;
    for (const index of [1, 2, 3]) {
      controller.observe({ scrollTop: step * index });
      clock.runFrame();
    }
    expect(deliveries).toHaveLength(0);
    // The state still tracks the real offset, even when no plan is published: the
    // controller reports what the viewport is, and the *plan* callback is the thing
    // that is rare.
    expect(controller.getState().scrollTop).toBeCloseTo(step * 3, 6);
  });

  it('delivers once the movement crosses the meaningful threshold', () => {
    controller.observe(base({ scrollTop: 0 }));
    clock.runFrame();
    deliveries.length = 0;

    controller.observe({ scrollTop: 768 * MEANINGFUL_TILE_FRACTION });
    clock.runFrame();
    expect(deliveries).toHaveLength(1);
  });

  it('publishes a new revision for every plan change and reuses it otherwise', () => {
    controller.observe(base());
    clock.runFrame();
    const first = controller.getState().revision;

    // A change that is not a plan change keeps the revision: a reply that carries it
    // is still current.
    controller.observe({ scrollTop: 10 });
    clock.runFrame();
    expect(controller.getState().revision).toBe(first);

    // Each of these changes what the plan means, so each must be a new revision.
    for (const patch of [
      { layoutScale: 2 },
      { rotation: 90 },
      { devicePixelRatio: 1.25 },
      { generation: 2 },
      { width: 900 },
      { height: 700 },
      { renderAheadPages: 2 }
    ]) {
      const before = controller.getState().revision;
      controller.observe(patch);
      clock.runFrame();
      expect(controller.getState().revision).toBeGreaterThan(before);
    }
  });

  it('treats a rotation change as a plan change even at the same scale', () => {
    // Rotation is a CSS transform on the sheet, so it changes which *device* pixels
    // are on screen without changing a single page's scale. A plan comparison that
    // only looked at scroll and scale would miss it and leave the viewport covered by
    // tiles that are now off screen.
    const a: ViewportState = { ...(base() as ViewportState), revision: 0 };
    const b: ViewportState = { ...a, rotation: 90 };
    expect(samePlan(a, b, 768)).toBe(false);
  });

  it('reports direction and velocity from successive observations', () => {
    const clockNow = { value: 0 };
    const realNow = performance.now;
    performance.now = () => clockNow.value;
    try {
      controller.observe(base({ scrollTop: 0 }));
      clockNow.value += 16;
      for (let i = 1; i <= 10; i++) {
        clockNow.value += 16;
        controller.observe({ scrollTop: i * 120 });
      }
      const down = controller.getMotion();
      expect(down.direction).toBe(1);
      expect(down.velocity).toBeGreaterThan(0);

      for (let i = 9; i >= 0; i--) {
        clockNow.value += 16;
        controller.observe({ scrollTop: i * 120 });
      }
      const up = controller.getMotion();
      expect(up.direction).toBe(-1);
      expect(up.velocity).toBeLessThan(0);
    } finally {
      performance.now = realNow;
    }
  });

  it('marks an interaction and clears it after the hold', async () => {
    controller.observe(base());
    clock.runFrame();
    controller.beginInteraction(20);
    expect(controller.getMotion().interacting).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(controller.getMotion().interacting).toBe(false);
  });

  it('invalidate forces a delivery at the same geometry', () => {
    controller.observe(base());
    clock.runFrame();
    deliveries.length = 0;
    controller.invalidate();
    clock.runFrame();
    expect(deliveries).toHaveLength(1);
  });

  it('flush delivers without waiting for a frame', () => {
    controller.observe(base());
    clock.runFrame();
    deliveries.length = 0;
    controller.invalidate();
    // A frame is queued, but `flush` must not need it.
    controller.flush();
    expect(deliveries).toHaveLength(1);
    // …and the queued frame must not deliver a second time for the same change.
    clock.runFrame();
    expect(deliveries).toHaveLength(1);
  });

  it('delivers synchronously when no frame scheduler was supplied', () => {
    const bare = new PdfViewportController();
    const seen: ViewportState[] = [];
    bare.subscribe((state) => seen.push(state));
    bare.observe(base({ scrollTop: 5000 }));
    expect(seen).toHaveLength(1);
    expect(seen[0].scrollTop).toBe(5000);
  });

  it('stops delivering after dispose', () => {
    controller.observe(base());
    clock.runFrame();
    deliveries.length = 0;
    controller.invalidate();
    controller.dispose();
    clock.runFrame();
    expect(deliveries).toHaveLength(0);
  });
});
