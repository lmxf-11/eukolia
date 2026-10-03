/**
 * Eukolia — light-pdf's wheel and scroll policy, ported.
 *
 * This module is a transcription of `Canvas.cpp`'s `OnMouseWheel`
 * (`:2530-2800`) and its smooth-scroll integrator (`:2259-2313`), with the
 * Windows message plumbing reduced to values:
 *
 * - `planLightPdfWheel` is `OnMouseWheel`'s decision tree, in the reference's
 *   own order — fit content, the page slider of `ScrollbarInSinglePage`, page
 *   flipping in the non-continuous modes, the `SIF_PAGE` fraction,
 *   `FastScrollOverScrollbar`, the momentum wheel, and finally the plain
 *   accumulated line scroll (`planLightPdfLineScroll`, `:2753-2775`);
 * - `LightPdfSmoothScroll` is `:2259-2313`: an exact velocity integrator whose
 *   decay is `exp(-friction*50*dt)` with a 5 px/s stop.
 *
 * It is deliberately free of the DOM: the viewer supplies the measured viewport,
 * the pointer's position and the settings, and gets back what to do. That is what
 * makes any of it testable, and it is why the reference's magic numbers
 * (`WHEEL_DELTA`, `gDeltaPerLine`, `DpiScale(16)`) are named constants rather
 * than inline arithmetic.
 *
 * ## Units
 *
 * light-pdf's wheel delta is a Win32 `WHEEL_DELTA` (120) per notch, and its
 * `gDeltaPerLine` divides that into lines (`Canvas.cpp:592-599`). The browser
 * reports a notch three ways, so the event is converted into light-pdf's *line*
 * unit first and everything after that — the accumulator, the notch comparisons,
 * the line scroll — works in the values `OnMouseWheel` works in. Pixels only
 * appear at the two places `Canvas.cpp` converts to them: the line height and the
 * page fraction.
 */

import {
  LIGHTPDF_DELTA_PER_LINE,
  LIGHTPDF_SCROLL_LINE_HEIGHT,
  LIGHTPDF_WHEEL_DELTA,
  lightPdfFastScrollDistance,
  lightPdfPointerOverScrollbar,
  lightPdfSmoothScrollDecay,
  lightPdfSmoothScrollImpulse,
  lightPdfSmoothScrollStopped
} from './lightpdf-settings';

/**
 * `Canvas.cpp:2541` + `:2586-2588` — `GET_WHEEL_DELTA_WPARAM(wp)` after
 * `ScrollSensitivity`, which is the value `OnMouseWheel` reasons with from that
 * line on.
 *
 * Its unit is *pixels*, and a notch is three lines of them: light-pdf's
 * `(delta / gDeltaPerLine) * DpiScale(16)` with `gDeltaPerLine` = `WHEEL_DELTA/3`
 * = 40 and `DpiScale(16)` = 16 makes a line 40 px, so one Windows notch is 120 px
 * and `lightPdfLineScrollDistance(120)` is 48 px — the three lines of 16 px the
 * reference scrolls.
 *
 * The browser reports a notch three ways and light-pdf's engine only sees the
 * third, so the other two are converted: pixels (`deltaMode` 0, the default on
 * Windows) are already the unit, lines (`deltaMode` 1) are `gDeltaPerLine` pixels
 * each, and pages (`deltaMode` 2) are multiplied by the viewport height first. A
 * trackpad's sub-notch deltas pass through unchanged, which is what
 * `Canvas.cpp:2680` calls out ("on sensitive touchpads delta can be very small")
 * — they accumulate to a notch rather than being rounded away.
 *
 * The sensitivity is applied exactly here, so the delta and everything derived from
 * it carry it once: a Windows notch at the default sensitivity of 3 is 360 px, and
 * `lightPdfLineScrollDistance(360)` is 144 px. The momentum path then scales the
 * *impulse* by the sensitivity a second time — `Canvas.cpp:2738` multiplies a
 * `targetDistance` its own `:2587` had already scaled — so a notch that glides
 * travels `24 * S²` (216 px at the default 3), while the plain line path travels
 * `48 * S` (144 px). The two agree only at a sensitivity of 2.
 */
export function lightPdfWheelDelta(
  event: { deltaMode: number; deltaY: number },
  viewportHeight: number,
  sensitivity = 1
): number {
  const pixels =
    event.deltaMode === 2
      ? event.deltaY * viewportHeight
      : event.deltaMode === 1
        ? event.deltaY * LIGHTPDF_DELTA_PER_LINE
        : event.deltaY;
  return pixels * sensitivity;
}

/** `Canvas.cpp` — `si.nPage`, the viewport size in the scrollbar's own units. */
export interface LightPdfScrollMetrics {
  /** `si.nPage`. */
  page: number;
  /** `si.nPos` — the current scroll offset. */
  pos: number;
  /** The largest valid `si.nPos` (`si.nMax - si.nPage + 1`). */
  maxPos: number;
  /** True while vertical overflow exists (`dm->NeedVScroll()`). */
  needVScroll: boolean;
}

/** Which axis a wheel notch scrolls. `Canvas.cpp` calls this `hScroll`. */
export type LightPdfScrollAxis = 'vertical' | 'horizontal';

/** What the viewer should do with one wheel notch. */
export type LightPdfWheelAction =
  /** Nothing: the delta has not accumulated to a notch yet, or hit an edge. */
  | { kind: 'none' }
  /**
   * Turn the page: `1` is `ctrl->GoToNextPage()` (the wheel notch scrolled
   * towards the end of the document) and `-1` is `GoToPrevPage()`.
   */
  | { kind: 'page'; direction: 1 | -1 }
  /** `dm->ScrollBy`, in CSS pixels. Positive Y is down, positive X is right. */
  | { kind: 'scroll'; dx: number; dy: number }
  /**
   * The momentum wheel (`Canvas.cpp:2730-2751`): add `impulse` to the velocity
   * and let `LightPdfSmoothScroll` integrate it.
   */
  | { kind: 'smooth'; impulse: number };

export interface LightPdfWheelContext {
  /**
   * The wheel event in the units `OnMouseWheel` reasons with, produced by
   * `lightPdfWheelDelta`: one notch is `WHEEL_DELTA`, a line is `gDeltaPerLine`,
   * and `ScrollSensitivity` is already folded in.
   */
  delta: number;
  axis: LightPdfScrollAxis;
  /** `IsContinuous(ctrl->GetDisplayMode())`. */
  continuous: boolean;
  /** `zoomVirtual == kZoomFitContent`. */
  fitContent: boolean;
  /** `scrollbarInSinglePage && mode == DisplayMode::SinglePage`. */
  pageSlider: boolean;
  /** `gGlobalPrefs->fastScrollOverScrollbar && pointer over the bar`. */
  fastScrollOverScrollbar: boolean;
  /**
   * `Canvas.cpp:2710-2716` — Alt held: half a page per notch, "useful for
   * browsing long files". light-pdf gets it from `IsAltPressed()`; the browser
   * passes it on the event.
   */
  altHalfPage: boolean;
  /** `gGlobalPrefs->smoothScroll`. */
  smoothScroll: boolean;
  /**
   * `ScrollSensitivity`, which `:2738` applies *again* on top of the already
   * scaled delta when it builds the momentum impulse. It is passed separately
   * because `lightPdfWheelDelta` consumed the first application.
   */
  sensitivity: number;
  /** The scroller's `si`. */
  metrics: LightPdfScrollMetrics;
  /** One line's length in pixels — `DpiScale(hwndCanvas, 16)`. */
  linePixels: number;
}

/**
 * `Canvas.cpp:2530-2800` — `OnMouseWheel`, in the reference's own order.
 *
 * The order is the behaviour: fit content flips pages before the page slider is
 * considered, the page slider turns pages before the non-continuous page flip
 * is, and the momentum wheel is the last branch before the plain line scroll.
 * One qualification, and it is the reference's own: `:2634-2665`'s page flip
 * applies while the page fits (`flipPage`), so a non-continuous layout whose page
 * is taller than the viewport falls past it into the momentum wheel and then the
 * line accumulator, which is how such a page is panned.
 */
export function planLightPdfWheel(
  context: LightPdfWheelContext,
  accum: number
): { action: LightPdfWheelAction; accum: number } {
  const { delta, axis, metrics } = context;
  const vertical = axis === 'vertical';
  // A whole notch in the same unit as `delta`.
  const notch = LIGHTPDF_WHEEL_DELTA;

  // `:2590-2603` — fit content: always flip the page, whatever the scrollbar
  // state, once a whole notch has accumulated.
  if (vertical && context.fitContent) {
    const next = accum + delta;
    if (next >= notch) return { action: { kind: 'page', direction: 1 }, accum: next - notch };
    if (next <= -notch) return { action: { kind: 'page', direction: -1 }, accum: next + notch };
    return { action: { kind: 'none' }, accum: next };
  }

  // `:2605-2632` — the page slider turns one page per notch while the page fits;
  // when it does not, the continuous path below takes over.
  if (context.pageSlider && vertical && !metrics.needVScroll) {
    const next = accum + delta;
    if (next >= notch) return { action: { kind: 'page', direction: 1 }, accum: next - notch };
    if (next <= -notch) return { action: { kind: 'page', direction: -1 }, accum: next + notch };
    return { action: { kind: 'none' }, accum: next };
  }

  // `:2634-2665` — the other non-continuous modes flip whole pages while the page
  // fits, and otherwise fall through to the momentum wheel and the line scroll.
  const nonContinuousFlip = vertical && !context.continuous && !context.pageSlider && !metrics.needVScroll;
  if (nonContinuousFlip) {
    const next = accum + delta;
    if (next >= notch) return { action: { kind: 'page', direction: 1 }, accum: next - notch };
    if (next <= -notch) return { action: { kind: 'page', direction: -1 }, accum: next + notch };
    return { action: { kind: 'none' }, accum: next };
  }

  // `:2667-2669` — `gDeltaPerLine == 0` means the system asked for no wheel
  // scrolling at all.
  if (LIGHTPDF_DELTA_PER_LINE === 0) return { action: { kind: 'none' }, accum };

  // `:2671-2690` — the page slider over content that does not fit scrolls a
  // `SIF_PAGE` fraction per notch, so pages turn at the boundaries.
  if (context.pageSlider && vertical && metrics.needVScroll) {
    const scrollBy = -Math.trunc((metrics.page * delta * 30) / notch);
    if (scrollBy === 0) return { action: { kind: 'none' }, accum };
    return { action: { kind: 'scroll', dx: 0, dy: -scrollBy }, accum };
  }

  // `:2710-2716` — Alt scrolls half a page per notch. The viewer keeps
  // light-pdf's meaning for Alt+wheel by routing it here.
  if (vertical && context.altHalfPage) {
    return {
      action: { kind: 'scroll', dx: 0, dy: lightPdfFastScrollDistance(delta > 0 ? 1 : -1, metrics.page) },
      accum
    };
  }

  // `:2718-2728` — `FastScrollOverScrollbar`: half a page while the pointer is
  // over the bar.
  if (context.fastScrollOverScrollbar) {
    return {
      action: { kind: 'scroll', dx: 0, dy: lightPdfFastScrollDistance(delta > 0 ? 1 : -1, metrics.page) },
      accum
    };
  }

  // `:2692-2708` — `gDeltaPerLine < 0` is the system's "one screen at a time"
  // setting: a fraction of the page per notch.
  if (LIGHTPDF_DELTA_PER_LINE < 0) {
    const scrollBy = Math.trunc((metrics.page * delta) / notch);
    if (scrollBy === 0) return { action: { kind: 'none' }, accum };
    return axis === 'vertical'
      ? { action: { kind: 'scroll', dx: 0, dy: scrollBy }, accum }
      : { action: { kind: 'scroll', dx: scrollBy, dy: 0 }, accum };
  }

  // `:2730-2751` — the momentum wheel: an impulse into the integrator rather
  // than a distance.
  //
  // The reference guards this with `!isCont`, which in `Canvas.cpp` is
  // `IsContinuous(...)` — so the momentum wheel is the *continuous* layout's
  // wheel, and the non-continuous modes never reach it (they flip whole pages
  // above, or fall into the line scroll below). That is also the only reading
  // that makes sense of the reference: a non-continuous page is paged, not
  // scrolled, so a velocity integrator there would have nothing to move.
  //
  // Every event with a delta fires, and the accumulator is left at zero. That is
  // the one place this deliberately departs from the reference, and it is the
  // whole of "the wheel sometimes does not respond":
  //
  //   * `Canvas.cpp:2740` is reached once per `WM_MOUSEWHEEL`, and Windows only
  //     sends one when a whole `WHEEL_DELTA` (120) has been turned up. The
  //     browser sends an event per hardware report instead — a mouse at a
  //     100-pixel notch *and* every few pixels of a trackpad gesture — so a
  //     `WHEEL_DELTA` threshold on this path means most events are consumed by
  //     `preventDefault` and then answered with "nothing", because the gate
  //     below has not been reached yet. Scrolling stops for as long as that
  //     lasts, which on a slow spin is most of the gesture.
  //   * The momentum path is a velocity integrator, and a velocity is additive:
  //     two events of half a notch are one notch of impulse, delivered as two
  //     accelerations rather than as one. There is nothing for the accumulator
  //     to do, because a sub-notch event is not discarded — it is *applied*.
  //
  // The distance a notch travels is unchanged — `lightPdfLineScrollDistance(delta)`
  // is still what the impulse is built from, so a 120-pixel event still lands its
  // notch's own distance, and the same events arriving one at a time still land the
  // same total. What changes is when they land: on the event rather than after the
  // next one has made up the difference.
  //
  // With nothing to scroll there is no momentum to start either: a document
  // shorter than its viewport would otherwise feed an impulse into an integrator
  // that can only stop at the boundary on the next frame.
  if (context.smoothScroll && vertical && delta !== 0 && metrics.maxPos > 0) {
    return {
      action: {
        kind: 'smooth',
        impulse: lightPdfSmoothScrollImpulse(
          lightPdfLineScrollDistance(delta, context.linePixels),
          context.sensitivity
        )
      },
      accum: 0
    };
  }

  return planLightPdfLineScroll(delta, accum, axis, context.linePixels);
}

/**
 * `Canvas.cpp:2732-2734` — the distance a wheel delta asks for, in pixels:
 * `delta / gDeltaPerLine` lines of `DpiScale(16)` pixels each. `delta` has
 * already been scaled by `ScrollSensitivity` (`lightPdfWheelDelta`), so a Windows
 * notch at the default sensitivity of 3 is 360 → nine lines → 144 px.
 */
export function lightPdfLineScrollDistance(delta: number, pixelsPerLine: number): number {
  return (delta / LIGHTPDF_DELTA_PER_LINE) * pixelsPerLine;
}

/**
 * The decay rate the momentum impulse is scaled by, in one place.
 *
 * `Canvas.cpp:2737` calls `0.1 * 50` the "default decay rate": it is
 * `SmoothScrollFriction`'s own default times 50, and the comment there explains
 * why the impulse uses the default rather than the configured value — the impulse
 * sets *how far* a notch travels (`∫ v·e^(-rate·t) dt = v/rate`), and scaling it
 * by the live rate would make the distance depend on the friction.
 */
export const LIGHTPDF_MOMENTUM_DECAY_RATE = 0.1 * 50;
/**
 * `Canvas.cpp:2753-2775` — the plain line scroll: whole `gDeltaPerLine` steps
 * become `SB_LINEUP` / `SB_LINEDOWN` scrolls, each of `pixelsPerLine` pixels.
 *
 * The reference moves a whole line per step and keeps the remainder in
 * `wheelAccumDelta`, so a sub-notch trackpad event loses its distance until the
 * next one arrives. Eukolia moves by the exact fraction as well, so a half-notch
 * event moves half a notch at once and a notch's worth of events moves exactly
 * one notch — the accumulator is still reported, but as the sub-line total the
 * next event adds to rather than as a rounding buffer.
 *
 * `SB_LINEDOWN` moves the view *down*, i.e. a positive wheel delta scrolls
 * towards the end of the document.
 */
export function planLightPdfLineScroll(
  delta: number,
  accum: number,
  axis: LightPdfScrollAxis,
  pixelsPerLine: number
): { action: LightPdfWheelAction; accum: number } {
  let next = accum + delta;
  let steps = 0;
  while (next <= -LIGHTPDF_DELTA_PER_LINE) {
    next += LIGHTPDF_DELTA_PER_LINE;
    steps -= 1;
  }
  while (next >= LIGHTPDF_DELTA_PER_LINE) {
    next -= LIGHTPDF_DELTA_PER_LINE;
    steps += 1;
  }

  /**
   * The distance this event asks for, from **its own** delta.
   *
   * Not from `accum + delta`, which is what it used to be, and the difference is
   * not a rounding detail. The accumulator below still carries the sub-line part
   * of the running total — that is the reference's `wheelAccumDelta`, and the
   * page-flip paths above genuinely need it to know when a whole notch has turned
   * — but the distance has already been applied for that part, because this path
   * applies the exact fraction of every event rather than discarding it until a
   * whole line has gathered (see the note on the momentum path). Adding the
   * carried remainder into the distance a second time charged the reader for it
   * twice: two 60-unit events, one notch between them, moved `24 + 32 = 56` px
   * where the contract is one notch's 48, and the surplus was
   * `0.4 × the previous remainder` on *every* event after the first — up to a
   * whole line of drift per event, compounding. It hid on a mouse, whose notches
   * are whole multiples of `gDeltaPerLine` and leave no remainder; a trackpad,
   * whose deltas are a few units each, spent most of its travel on the carried
   * remainder and over-ran by several times the distance the finger asked for.
   *
   * The accumulator is deliberately still *reported*, so the two paths (this one
   * and the page flip) share one accumulator and one lifecycle.
   */
  const distance = lightPdfLineScrollDistance(delta, pixelsPerLine);
  if (steps === 0 && distance === 0) return { action: { kind: 'none' }, accum: next };
  return axis === 'vertical'
    ? { action: { kind: 'scroll', dx: 0, dy: distance }, accum: next }
    : { action: { kind: 'scroll', dx: distance, dy: 0 }, accum: next };
}

/**
 * `Canvas.cpp:2259-2313` — the smooth-scroll integrator.
 *
 * A wheel notch adds an impulse to the velocity; every tick moves the view by
 * `velocity * dt` and multiplies the velocity by `exp(-decayRate * dt)`; below
 * 5 px/s the momentum is over and the exact offset is dropped. `exact` follows
 * the fractional position so that a slow tick still moves once it has
 * accumulated a whole pixel — that is what `smoothScrollExactY` is for.
 *
 * The reference clamps `dt` to `[0.001, 0.1]` (`:2271-2272`), which is what
 * keeps a stalled frame from teleporting the view. This keeps those clamps and
 * one difference of its own, which is worth stating because it is a deliberate
 * departure:
 *
 * ## The step is exact, so the distance a notch travels does not depend on the
 * ## frame rate
 *
 * `Canvas.cpp:2283-2287` advances the position by the velocity it is *about* to
 * decay:
 *
 * ```
 * exact += velocity * dt;                  // Canvas.cpp:2283
 * velocity *= exp(-decayRate * dt);        // Canvas.cpp:2287
 * ```
 *
 * An exponentially decaying velocity travels `∫ v·e^(-rate·t) dt = v/rate` in
 * total, and that is exactly what `lightPdfSmoothScrollImpulse` scales the
 * impulse for — so one notch is supposed to land `targetDistance` pixels from
 * where it started, whatever the friction is. The forward-Euler step above does
 * not quite do that: it uses the pre-decay velocity for the whole interval, so it
 * overshoots by `rate·dt/2` — about 7 % at the reference's own `rate` of 10 and
 * 60 fps, and about 32 % at 15 fps. The distance a notch travels would then
 * depend on how fast the machine draws frames, which is not something a reader
 * can be asked to reason about.
 *
 * This integrates the same decay exactly instead:
 *
 * ```
 * exact += velocity * (1 - exp(-decayRate·dt)) / decayRate;
 * velocity *= exp(-decayRate·dt);
 * ```
 *
 * which is the same curve, lands the same total distance at every frame rate, and
 * tends to the reference's own step as `dt → 0`. The behaviour a reader sees —
 * an impulse, a glide, a stop below 5 px/s, boundary clamping — is unchanged; only
 * the frame-rate dependence is.
 */
export class LightPdfSmoothScroll {
  /** `win->smoothScrollVelocityY`, in pixels per second (negative is down). */
  private velocity = 0;
  /** `win->smoothScrollExactY` — the unrounded position, 0 when not scrolling. */
  private exact = 0;

  public constructor(private readonly decayRate: number) {}

  /** `win->smoothScrollVelocityY != 0.0` — whether a tick is needed at all. */
  public get active(): boolean {
    return this.velocity !== 0;
  }

  /** The velocity, for diagnostics and tests. */
  public get currentVelocity(): number {
    return this.velocity;
  }

  /** `win->smoothScrollVelocityY -= impulse` (`Canvas.cpp:2741`). */
  public addImpulse(impulse: number): void {
    this.velocity -= impulse;
  }

  /**
   * Re-anchor the exact offset to the view's real position, leaving the
   * momentum running.
   *
   * This is `Canvas.cpp:2745-2749`'s `wasStopped` seed, and the caller is
   * responsible for the condition: the reference seeds the exact offset *only*
   * when the momentum had stopped, because `exact` is not the view's position but
   * the position the impulses have asked for. Each impulse's share of the total
   * is whatever has not been travelled yet, so re-anchoring mid-glide discards
   * the distance every earlier impulse still owed — a burst of six notches then
   * lands one notch.
   *
   * What it is for is a momentum that is starting: `tick`'s own correction only
   * fires once the view is more than a pixel from where the integrator believes
   * it is, and a fresh impulse should begin from the real offset rather than
   * discovering it a frame later.
   */
  public reseed(offset: number): void {
    this.exact = offset;
  }

  /**
   * `win->smoothScrollExactY` — the position the impulses have asked for, which
   * is ahead of the view by however much has not been travelled yet.
   *
   * Exposed because that is the quantity the wheel's contract is about, and the
   * one thing an end-to-end test on a virtual frame clock cannot see: a caller
   * that re-seeds this per event rather than per gesture throws the outstanding
   * distance away, and the visible symptom (a burst of notches landing one) only
   * appears when frames run between the events.
   */
  public get exactPosition(): number {
    return this.exact;
  }

  /**
   * The glide's first step, taken synchronously where the notch arrives.
   *
   * light-pdf advances the physics at the end of the next paint after the wheel
   * message, so the movement is on screen one paint later. A browser has no paint
   * loop to hook — deferring to `requestAnimationFrame` puts the movement in the
   * frame *after* the one that acknowledges the input — so one frame of the glide is
   * taken in the wheel handler instead. Measured with `.scratch/perf/budget.mjs`: a
   * single notch took **19.5 ms (2.8 frame intervals)** to move the view, against
   * 4.7 ms when a glide was already running.
   *
   * ## The notch still travels exactly its own distance
   *
   * This is where it is easy to get wrong, and getting it wrong is invisible in the
   * arithmetic and obvious in the hand. An exponential glide travels
   * `velocity / rate` in total, and it advances `exact` towards that while moving the
   * view towards `exact` — so the invariant between them is `exact = view + velocity /
   * rate`. Moving the view by `step` without touching the velocity breaks it (the
   * glide then delivers `velocity / rate` *on top of* the step, and every notch
   * overshoots by its own first frame). The correction is the one the reference makes
   * at `Canvas.cpp:2297-2304`: the position and the velocity are adjusted together.
   * Reducing the velocity by `step·rate` restores the invariant, and the notch still
   * lands `impulse / rate` from where it started — the same distance, arriving one
   * frame earlier, which is the entire point.
   *
   * Returns the distance the caller should move the view by.
   */
  public advance(offset: number, dt: number): number {
    if (this.velocity === 0) return 0;
    if (lightPdfSmoothScrollStopped(this.velocity)) {
      this.stop();
      return 0;
    }
    // The same seed and drift correction the tick performs, for the same reasons.
    if (this.exact === 0 || Math.abs(offset - this.exact) > 1) this.exact = offset;
    let step = dt;
    if (step <= 0) step = 0.001;
    if (step > 0.1) step = 0.016;
    const { distance } = this.stepBy(step);
    // What the early frame delivered is paid for out of what the glide would still
    // have delivered, so the total is `velocity / rate` either way.
    this.velocity += distance * this.decayRate;
    this.exact += distance;
    return distance;
  }

  /** `win->smoothScrollVelocityY = 0.0; win->smoothScrollExactY = 0.0` (`:2275-2276`). */
  public stop(): void {
    this.velocity = 0;
    this.exact = 0;
  }

  /**
   * The velocity's decay over `dt`, and the distance it covers over the same
   * interval, committed together. Both come from the same exponential, so they
   * cannot disagree.
   */
  private stepBy(dt: number): { decay: number; distance: number } {
    const decay = Math.exp(-this.decayRate * dt);
    // `∫₀^dt v·e^(-rate·t) dt`. The `rate → 0` limit is `v·dt`, which is also what
    // the arithmetic below tends to as the decay tends to 1 (the decay rate is
    // floored at 1 by `lightPdfSmoothScrollDecayRate`, so this is a guard rather
    // than a reachable case).
    const distance = this.velocity * (1 - decay) / this.decayRate;
    this.velocity *= decay;
    return { decay, distance };
  }

  /**
   * One tick. `offset` is the view's current `yOffset()`. `scrollBy` performs
   * `dm->ScrollYBy(delta, false, true)` and returns the offset it achieved, so a
   * boundary stop is observed rather than assumed: calling it with 0 reads it
   * back.
   *
   * `clamp` is the largest offset the view can reach. It is not a convenience —
   * it is what makes the reference's boundary test mean anything on a scroller
   * that does not land where it is put, and it is worth stating why, because
   * getting it wrong is invisible in the arithmetic and obvious to the reader.
   *
   * ## A browser's `scrollTop` does not land where it is put
   *
   * `Canvas.cpp:2301-2304` is `exact = GetScrollPos()` after a scroll, and on
   * Win32 that is the position asked for. A browser rounds `scrollTop` to the
   * device-pixel grid — at `devicePixelRatio` 1.25 the grid is 0.8 px — so a
   * scroll that asked for 6.33 px lands on 6.4, and *assigning the achieved
   * position back every frame* throws away the difference each time. Over a notch
   * that is a few per cent per frame: `exact` reached 73.6 px of its 96 and froze
   * there while the velocity decayed through 40 px/s of perfectly good momentum.
   * The integrator therefore carries the residual — the distance the view has not
   * yet been given — rather than discarding it, and only a scroll that was
   * refused outright (the end of the document) takes it away.
   *
   * ## The boundary has to be named
   *
   * `:2297-2300` is `GetScrollPos() == yOffset()`, which on Win32 means the
   * scroll did not happen at all, because `SB_THUMBPOSITION` lands on the
   * position it was given. A browser rounds, so writing `1` at the top of a
   * document reads back as a pixel of movement and the test fired in the middle
   * of every notch, zeroing the momentum a fifth of the way in. `clamp` is that
   * test read from a scroller that reports its own grid.
   */
  public tick(offset: number, dt: number, scrollBy: (delta: number) => number, clamp?: { max: number }): void {
    if (this.velocity === 0) return;

    let step = dt;
    if (step <= 0) step = 0.001;
    if (step > 0.1) step = 0.016;

    if (lightPdfSmoothScrollStopped(this.velocity)) {
      // `:2274-2276` — less than 5 px/s is stopped.
      this.stop();
      return;
    }

    // The view is authoritative: this is a correction for a position that moved
    // underneath the momentum (a scrollbar drag, a page turn, a re-layout). The
    // tolerance is `:2279`'s one pixel, read against the exact offset itself
    // rather than against its rounding — a scroller's grid is its device pixel
    // ratio, not a whole pixel, so the residual the integrator carries sits inside
    // a rounding step and must not be mistaken for drift.
    if (this.exact === 0 || Math.abs(offset - this.exact) > 1) this.exact = offset;

    const { distance } = this.stepBy(step);
    this.exact += distance;

    const desiredDelta = Math.round(this.exact) - offset;
    if (desiredDelta === 0) return;

    const requested = offset + desiredDelta;
    const achieved = scrollBy(desiredDelta);
    const atEnd = clamp !== undefined && (achieved <= 0 || achieved >= clamp.max);
    if (atEnd && achieved !== requested) {
      // `:2297-2300` — the view is at the end of the document and the wheel is
      // still asking to leave it. The momentum is over.
      this.velocity = 0;
      this.exact = achieved;
      return;
    }
    // The position the impulses have asked for still stands, residual and all:
    // the view landed on its grid, and the part it could not take is still owed.
    this.exact = requested;
  }
}

/** Re-exported so the viewer has one import for the whole wheel policy. */
export {
  LIGHTPDF_DELTA_PER_LINE,
  LIGHTPDF_SCROLL_LINE_HEIGHT,
  LIGHTPDF_WHEEL_DELTA,
  lightPdfPointerOverScrollbar,
  lightPdfSmoothScrollStopped
};
