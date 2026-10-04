/**
 * Eukolia — the PDF viewport controller.
 *
 * ## Why this module exists
 *
 * `PDFVIEWER.md` §4 splits the viewer in two:
 *
 * > React owns chrome, document lifecycle, coarse layout/mount windows, and
 * > accessible UI. A viewer controller owns frame-sensitive scroll state, request
 * > scheduling, tile lifetimes, and uploads. React should receive
 * > current-page/zoom/status updates only when useful values change, not a render
 * > for every wheel event or completed pixel block.
 *
 * Today's `PdfViewer` does the first half of that and only part of the second: a
 * `scroll` listener updates `data-` attributes imperatively (good) but the pass
 * that decides what to rasterise is driven from React effects and `setVersion`
 * bumps, so a wheel burst can produce several passes per frame, each of which walks
 * the page list and can call `renderPage` for every ordered page. §7 asks for
 * something narrower:
 *
 * > Publish viewport changes at most once per frame and only when meaningful
 * > geometry/tile visibility changes. Compute visible pages via the existing
 * > indexed/binary-search layout; do not scan every page on every animation frame.
 *
 * This controller is that publication point. It owns:
 *
 *   * the **observed** viewport (scroll offset, size, scale, rotation, DPR, page
 *     count) as plain numbers, updated from cheap reads;
 *   * **coalescing** — many `scroll` events, `ResizeObserver` deliveries and layout
 *     changes collapse into one callback per animation frame;
 *   * **meaningfulness** — a callback only fires when a value the renderer's plan
 *     depends on actually changed, so a scroll of one device pixel inside the same
 *     tile does not re-plan anything;
 *   * **motion state** (direction, speed, whether input is still arriving), which is
 *     what the scheduler's priority ordering and the "reversed direction" rule need.
 *
 * ## What it deliberately does not do
 *
 * It does not own scroll physics — `lightpdf-scroll.ts` is the port of light-pdf's
 * friction/momentum integrator and §2 says to keep its analytic exponential step —
 * and it does not decide *what* to render. It reports what the viewport is; the
 * scheduler decides what that implies. It also never calls `requestAnimationFrame`
 * in a loop: it arms one frame per pending change, so an idle viewer costs nothing.
 *
 * ## Why the plan is a revision counter
 *
 * Consumers must be able to tell "this is a new plan" from "this is the same plan
 * again" without deep-comparing geometry every frame. {@link ViewportState.revision}
 * is a monotonic counter bumped exactly when {@link samePlan} says the plan changed,
 * which is also the key a render request carries so a stale reply can be discarded
 * (§7: requests "carry document token, generation, page, scale, rotation, tile/clip,
 * priority, grid revision, and request ID as needed").
 *
 * Copyright 2026 the Eukolia project authors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** A rectangle in CSS pixels, relative to the scroller's content origin. */
export interface ViewportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Everything the render plan depends on.
 *
 * Deliberately flat and numeric: {@link samePlan} compares field by field, and a
 * nested object would invite a shallow comparison that misses a change.
 */
export interface ViewportState {
  /** Scroll offset of the scroller, in CSS pixels. */
  readonly scrollTop: number;
  readonly scrollLeft: number;
  /** The scroller's client size, in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** CSS pixels per PDF point the layout is using (`LightPdfLayoutPage::zoomReal`). */
  readonly layoutScale: number;
  /** Device pixels per CSS pixel. */
  readonly devicePixelRatio: number;
  /** Display rotation in degrees, as the layout applied it. */
  readonly rotation: number;
  /** Document identity for the loaded file; changes on open and on re-read. */
  readonly generation: number;
  /** How far ahead, in viewports, the viewer wants speculative tiles. */
  readonly renderAheadPages: number;
  /** Monotonic counter, bumped when the plan changed. */
  readonly revision: number;
}

/** Which way the viewport is moving, and how fast. */
export interface ViewportMotion {
  /** -1 up, 0 still, 1 down. */
  readonly direction: -1 | 0 | 1;
  /** CSS pixels per second, smoothed. */
  readonly velocity: number;
  /** True while the reader's own input (wheel, drag, keys) is still arriving. */
  readonly interacting: boolean;
}

/** The controller's public surface for a consumer. */
export interface ViewportListener {
  (state: ViewportState, motion: ViewportMotion): void;
}

/**
 * The fraction of a tile that must change visibility before a move counts as
 * meaningful.
 *
 * Zero would fire the plan callback for every sub-pixel scroll, which is exactly the
 * per-frame React churn §4 rules out. A quarter of a tile is small enough that a
 * newly needed tile is requested well before it is needed — a tile is 768 device
 * pixels, so a quarter is under 200 device pixels of travel, well inside one
 * frame's scroll at any plausible speed — and large enough that a slow trackpad
 * drag produces a handful of plans rather than hundreds.
 */
export const MEANINGFUL_TILE_FRACTION = 0.25;

/** How quickly the velocity estimate decays when motion stops, per frame. */
const VELOCITY_DECAY = 0.75;

/** Movement below this (CSS px/s) counts as still. */
const STILL_VELOCITY = 8;

/**
 * True when two states imply the same render plan.
 *
 * `scrollTop`/`scrollLeft` are compared with a tolerance derived from the tile size
 * rather than exactly: the plan's inputs are "which tiles intersect the viewport",
 * and a sub-tile move does not change that answer. Every other field is compared
 * exactly, because each of them changes the *scale or the geometry* of every tile.
 */
export function samePlan(a: ViewportState, b: ViewportState, tileDevicePx: number): boolean {
  const tolerance = Math.max(1, tileDevicePx * MEANINGFUL_TILE_FRACTION);
  return (
    Math.abs(a.scrollTop - b.scrollTop) < tolerance &&
    Math.abs(a.scrollLeft - b.scrollLeft) < tolerance &&
    a.width === b.width &&
    a.height === b.height &&
    a.layoutScale === b.layoutScale &&
    a.devicePixelRatio === b.devicePixelRatio &&
    a.rotation === b.rotation &&
    a.generation === b.generation &&
    a.renderAheadPages === b.renderAheadPages
  );
}

/**
 * Coalesces viewport input into at most one callback per animation frame.
 *
 * The owner of a controller calls {@link observe} whenever something may have
 * changed — a scroll event, a resize delivery, a zoom, a new document — and receives
 * callbacks from its own `requestAnimationFrame`. There is no polling and no
 * interval: between changes the controller holds no timer.
 */
export class PdfViewportController {
  private state: ViewportState;
  private listener: ViewportListener | null = null;
  private frameHandle: number | null = null;
  private cancelFrame: ((handle: number) => void) | null = null;
  private requestFrame: ((callback: (timestamp: number) => void) => number) | null = null;

  private revision = 0;
  private lastPlan: ViewportState;
  private lastFrameTimestamp: number | null = null;
  private velocity = 0;
  private direction: -1 | 0 | 1 = 0;
  private interacting = false;
  private interactionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly interactionHoldMs: number;
  private readonly tileDevicePx: number;
  private pending = false;
  /** Guards against a listener that calls `observe` re-entrantly from its callback. */
  private delivering = false;

  constructor(options: { tileDevicePx?: number; interactionHoldMs?: number } = {}) {
    this.tileDevicePx = options.tileDevicePx ?? 768;
    this.interactionHoldMs = options.interactionHoldMs ?? 160;
    const initial: ViewportState = {
      scrollTop: 0,
      scrollLeft: 0,
      width: 0,
      height: 0,
      layoutScale: 1,
      devicePixelRatio: 1,
      rotation: 0,
      generation: 0,
      renderAheadPages: 1,
      revision: 0
    };
    this.state = initial;
    this.lastPlan = initial;
  }

  /**
   * Supply the frame scheduler.
   *
   * Injected rather than reached for directly so a test can drive the controller
   * deterministically (and so a non-browser host does not need rAF at all).
   */
  useFrameScheduler(
    request: (callback: (timestamp: number) => void) => number,
    cancel: (handle: number) => void
  ): void {
    this.requestFrame = request;
    this.cancelFrame = cancel;
  }

  getState(): ViewportState {
    return this.state;
  }

  getMotion(): ViewportMotion {
    return { direction: this.direction, velocity: this.velocity, interacting: this.interacting };
  }

  subscribe(listener: ViewportListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  /**
   * Replace the observed values.
   *
   * Called for *every* scroll event and resize delivery; it does only arithmetic and
   * a comparison, so calling it at input rate is the intended use. The listener runs
   * from the next animation frame, at most once, and only if the plan changed.
   */
  observe(next: Partial<Omit<ViewportState, 'revision'>>): void {
    const merged: ViewportState = { ...this.state, ...next, revision: this.state.revision };
    this.updateMotion(merged);
    const changedPlan = !samePlan(this.lastPlan, merged, this.tileDevicePx);
    if (changedPlan) {
      this.revision++;
      this.state = { ...merged, revision: this.revision };
      this.lastPlan = this.state;
    } else {
      this.state = merged;
    }
    if (changedPlan) this.schedule();
  }

  /**
   * Mark the reader as interacting until {@link endInteraction}.
   *
   * §7 wants obsolete speculative work demoted during input; that needs the
   * scheduler to know input is still arriving, and the *hold* is what stops a
   * "settle" pass from firing in the gap between two wheel events of one gesture.
   */
  beginInteraction(holdMs = this.interactionHoldMs): void {
    this.interacting = true;
    if (this.interactionTimer !== null) clearTimeout(this.interactionTimer);
    if (holdMs > 0) {
      this.interactionTimer = setTimeout(() => {
        this.interactionTimer = null;
        this.interacting = false;
        this.notify();
      }, holdMs);
    }
  }

  endInteraction(): void {
    if (this.interactionTimer !== null) {
      clearTimeout(this.interactionTimer);
      this.interactionTimer = null;
    }
    if (!this.interacting) return;
    this.interacting = false;
    this.notify();
  }

  /**
   * Force the next frame to deliver, even if the plan looks unchanged.
   *
   * For the cases the plan comparison cannot see: a re-read of the file at the same
   * geometry (`generation` covers that, but a caller may not know it changed), a
   * manual "reload the pixels" pass, the end of a settle timer.
   */
  invalidate(): void {
    this.revision++;
    this.state = { ...this.state, revision: this.revision };
    this.lastPlan = this.state;
    this.schedule();
  }

  /** Deliver immediately rather than on the next frame. For tests and for `settle`. */
  flush(): void {
    this.cancelPending();
    this.notify();
  }

  dispose(): void {
    this.cancelPending();
    if (this.interactionTimer !== null) {
      clearTimeout(this.interactionTimer);
      this.interactionTimer = null;
    }
    this.listener = null;
  }

  // ------------------------------------------------------------------ internals

  private updateMotion(next: ViewportState): void {
    const previous = this.lastFrameTimestamp;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const deltaMs = previous === null ? 0 : now - previous;
    const moved = next.scrollTop - this.state.scrollTop;
    if (deltaMs > 0 && deltaMs < 250) {
      const instant = (moved / deltaMs) * 1000;
      this.velocity = this.velocity * VELOCITY_DECAY + instant * (1 - VELOCITY_DECAY);
    } else if (deltaMs >= 250) {
      this.velocity = 0;
    }
    if (Math.abs(this.velocity) < STILL_VELOCITY) {
      this.velocity = 0;
      this.direction = 0;
    } else {
      this.direction = this.velocity > 0 ? 1 : -1;
    }
    this.lastFrameTimestamp = now;
  }

  private schedule(): void {
    // Already armed, or already inside a delivery (in which case the delivery's own
    // frame is the coalescing point).
    if (this.frameHandle !== null || this.delivering) {
      this.pending = true;
      return;
    }
    if (!this.requestFrame) {
      // No scheduler supplied: deliver synchronously rather than silently dropping
      // the change. A host that cannot schedule frames has no frame to coalesce to.
      this.notify();
      return;
    }
    this.pending = true;
    this.frameHandle = this.requestFrame(() => {
      this.frameHandle = null;
      this.pending = false;
      this.notify();
    });
  }

  private cancelPending(): void {
    if (this.frameHandle !== null && this.cancelFrame) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.pending = false;
  }

  private notify(): void {
    const listener = this.listener;
    if (!listener || this.delivering) return;
    this.delivering = true;
    try {
      listener(this.state, this.getMotion());
    } finally {
      this.delivering = false;
    }
  }
}
