/**
 * smoothScroll — the one wheel handler for the whole shell.
 *
 * Smooth scrolling is a core product requirement (Instructions.md §35), and the
 * requirement is about the *application*, not about a list: one notch has to feel
 * the same over the file tree, the editor, the palette, the panels, menus, modals
 * and the tab manager. `ScrollArea` gave that to the surfaces built on it and left
 * every other scroller — CodeMirror's `.cm-scroller`, the bottom panel's frames,
 * the title bar's menus, the vendored widgets — to the browser, which is exactly
 * the inconsistency this module removes.
 *
 * One listener on the window owns the wheel for the whole shell, so there is one
 * easing curve, one duration setting and one accumulation rule behind every
 * surface. It listens in the **bubble** phase, which is what lets a surface that
 * genuinely owns its own scrolling win:
 *
 *  - the PDF viewer runs its own engine (light-pdf's momentum wheel, later a
 *    different engine entirely), so its subtree is marked `data-native-scroll`;
 *  - xterm converts a notch to arrow keys on the alternate screen — the wheel is
 *    how `less` and `vim` are scrolled — so the terminal is marked the same way
 *    and uses xterm's own smooth scroll, driven by the same duration setting.
 *
 * A listener that already handled the event says so: this handler stands down on
 * `defaultPrevented`, so anything that calls `preventDefault` keeps the notch.
 *
 * Ctrl+wheel belongs to the browser's zoom — except inside a surface marked
 * `data-ctrl-wheel-scroll`, which is the tab manager: that popup only exists while
 * `Ctrl` is held, so a notch there could otherwise never scroll it at all.
 */

import { settingsManager } from './settings';

/**
 * Marks a subtree whose scrolling belongs to something else.
 *
 * The walk up from the event target stops at the first element carrying it, so a
 * surface can own its scrolling without this module knowing what it is.
 */
export const NATIVE_SCROLL_ATTRIBUTE = 'data-native-scroll';

/**
 * Marks a subtree where Ctrl+wheel scrolls instead of zooming.
 *
 * Nothing else in the shell wants this: Ctrl+wheel is zoom everywhere, and the
 * surfaces that need it (the tab manager) say so themselves.
 */
export const CTRL_WHEEL_ATTRIBUTE = 'data-ctrl-wheel-scroll';

/** Which offset a scroll moves. */
export type ScrollAxis = 'y' | 'x';

/** The subset of `WheelEvent` the heuristics need; keeps the helpers testable. */
export interface WheelLike {
  deltaY: number;
  deltaX?: number;
  deltaMode: number;
}

/** Clamps a scroll offset into `[0, maximum]`. */
export function clampScrollTop(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  const limit = Math.max(0, maximum);
  return Math.min(Math.max(value, 0), limit);
}

/**
 * True when a wheel event most likely came from a trackpad.
 *
 * Trackpads report pixel deltas (`deltaMode === 0`) and, because of momentum and
 * sub-pixel precision, either fractional values or small magnitudes. Mouse wheels
 * report either line/page deltas or a large fixed pixel step.
 */
export function isTrackpadWheel(event: WheelLike): boolean {
  if (event.deltaMode !== 0) return false;
  return !Number.isInteger(event.deltaY) || Math.abs(event.deltaY) < 50;
}

/** Converts line/page deltas into pixels so the animation speed is consistent. */
export function normalizeWheelDelta(event: WheelLike, viewportHeight: number, lineHeight = 16): number {
  if (event.deltaMode === 1) return event.deltaY * lineHeight;
  if (event.deltaMode === 2) return event.deltaY * Math.max(1, viewportHeight);
  return event.deltaY;
}

/** The configured animation duration, in milliseconds. */
export function smoothScrollDuration(): number {
  const value = settingsManager.getValue('scrolling.smoothDurationMs');
  const duration = typeof value === 'number' && Number.isFinite(value) ? value : 180;
  return Math.min(Math.max(duration, 0), 1000);
}

/** Whether smooth scrolling is enabled at all. */
export function smoothScrollingEnabled(): boolean {
  return Boolean(settingsManager.getValue('scrolling.smooth'));
}

/** Whether trackpad momentum should be left to the platform. */
export function trackpadMomentumEnabled(): boolean {
  return Boolean(settingsManager.getValue('scrolling.trackpadMomentum'));
}

/**
 * Whether the platform asked for less motion.
 *
 * The stylesheet already collapses CSS transitions for this, and an animation
 * driven from here has to honour it too: a glide is motion.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ------------------------------------------------------------------ measuring

function readOffset(element: HTMLElement, axis: ScrollAxis): number {
  return axis === 'y' ? element.scrollTop : element.scrollLeft;
}

function writeOffset(element: HTMLElement, axis: ScrollAxis, value: number): void {
  if (axis === 'y') element.scrollTop = value;
  else element.scrollLeft = value;
}

function maxOffset(element: HTMLElement, axis: ScrollAxis): number {
  const content = axis === 'y' ? element.scrollHeight - element.clientHeight : element.scrollWidth - element.clientWidth;
  return Math.max(0, content);
}

/** The overflow values that make an element a scroll container on that axis. */
function scrollsWhenOverflowing(overflow: string): boolean {
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
}

/**
 * Whether an element can move on an axis right now.
 *
 * Both halves matter: `overflow: hidden` clips without scrolling, and an
 * `overflow: auto` box whose content happens to fit has nothing to give — taking
 * the notch for it would swallow the wheel and scroll nothing. The hidden panels
 * of the bottom bar are the common case of the second, since a `display: none`
 * element measures zero.
 */
export function canScroll(element: HTMLElement, axis: ScrollAxis): boolean {
  const style = getComputedStyle(element);
  const overflow = axis === 'y' ? style.overflowY : style.overflowX;
  if (!scrollsWhenOverflowing(overflow)) return false;
  return maxOffset(element, axis) > 1;
}

/**
 * The axes an element scrolls on, from **one** computed style.
 *
 * `scrollableAncestor` asks about both axes of every element between the pointer
 * and the scroller, and asking `canScroll` twice resolved the same element's
 * style twice for two properties of one object. A computed style is a style
 * resolution — the reason this walk is not free even when it ends where it
 * started — so the answer is taken once and split here.
 *
 * The overflow test comes before the measurement on each axis, which is what
 * keeps the common ancestor — `overflow: visible`, one of a dozen in CodeMirror's
 * content tree — from costing a layout read: only a box that *could* scroll is
 * asked how far it can.
 */
function scrollAxes(element: HTMLElement): { vertical: boolean; horizontal: boolean } {
  const style = getComputedStyle(element);
  return {
    vertical:
      scrollsWhenOverflowing(style.overflowY) &&
      element.scrollHeight - element.clientHeight > 1,
    horizontal:
      scrollsWhenOverflowing(style.overflowX) &&
      element.scrollWidth - element.clientWidth > 1,
  };
}

/**
 * The innermost scrollable element at or above `node`.
 *
 * An element that scrolls on one axis only decides the axis itself, which is what
 * makes a plain notch move a horizontal strip sideways — and an element that
 * scrolls both ways takes the axis the event asked for (Shift, or a tilt wheel's
 * dominant `deltaX`).
 *
 * A `data-native-scroll` ancestor ends the search before it starts: the mark is a
 * claim on a whole subtree, so a scrollable box *inside* one (the PDF viewer's
 * scroller inside the viewer, xterm's viewport inside the terminal) is that
 * engine's to move, not this module's.
 */
export function scrollableAncestor(
  node: Element | null,
  preferred: ScrollAxis
): { element: HTMLElement; axis: ScrollAxis } | null {
  if (!node || node.closest(`[${NATIVE_SCROLL_ATTRIBUTE}]`)) return null;
  for (let element: Element | null = node; element; element = element.parentElement) {
    const { vertical, horizontal } = scrollAxes(element as HTMLElement);
    if (!vertical && !horizontal) continue;
    if (vertical && horizontal) return { element: element as HTMLElement, axis: preferred };
    return { element: element as HTMLElement, axis: vertical ? 'y' : 'x' };
  }
  return null;
}

/** The element a wheel event is over, ignoring the window itself. */
function elementFromTarget(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

/** What a notch asks this shell to do. */
export interface WheelPlan {
  /** The element the notch moves, or `null` when there is nothing here to move. */
  element: HTMLElement | null;
  axis: ScrollAxis;
  /** True when the surface claims Ctrl+wheel, so the browser must not zoom. */
  claimsCtrlWheel: boolean;
}

/**
 * Decides what a wheel event means, or `null` when it is not ours at all.
 *
 * `null` is the answer for anything the browser or another handler should deal
 * with: an event somebody already prevented, a `data-native-scroll` subtree, or
 * Ctrl+wheel outside a surface that claims it (that one is the browser's zoom).
 */
export function planWheelScroll(event: WheelEvent, target: EventTarget | null): WheelPlan | null {
  if (event.defaultPrevented) return null;
  const node = elementFromTarget(target);
  if (!node) return null;
  // A subtree that owns its scrolling is not ours at all — which is a different
  // answer from "ours, but nothing here can scroll", and the two must not be
  // confused: only the second may block the browser.
  if (node.closest(`[${NATIVE_SCROLL_ATTRIBUTE}]`)) return null;

  const claimsCtrlWheel = node.closest(`[${CTRL_WHEEL_ATTRIBUTE}]`) !== null;
  if (event.ctrlKey && !claimsCtrlWheel) return null;

  // Shift and a tilt wheel both mean "sideways"; everything else is vertical.
  const horizontalIntent = event.shiftKey || Math.abs(event.deltaX ?? 0) > Math.abs(event.deltaY);
  const preferred: ScrollAxis = horizontalIntent ? 'x' : 'y';
  const found = scrollableAncestor(node, preferred);

  return { element: found?.element ?? null, axis: found?.axis ?? preferred, claimsCtrlWheel };
}

/**
 * The pixels one notch moves `element`.
 *
 * The axis's own delta leads, and the other one is the fallback: a plain wheel
 * over a horizontal strip carries its distance in `deltaY`, and a tilt wheel over
 * a vertical list carries almost none of it in `deltaX`.
 */
export function wheelDelta(event: WheelLike, axis: ScrollAxis, viewportSize: number): number {
  const primary = axis === 'y' ? event.deltaY : event.deltaX ?? 0;
  const fallback = axis === 'y' ? event.deltaX ?? 0 : event.deltaY;
  const raw = primary !== 0 ? primary : fallback;
  if (raw === 0) return 0;
  return normalizeWheelDelta({ deltaY: raw, deltaMode: event.deltaMode }, viewportSize);
}

// ------------------------------------------------------------------ animation

/**
 * One gliding scroll per element.
 *
 * The state is keyed by the element, so two surfaces never share a target and a
 * removed element takes its state with it.
 */
interface ScrollAnimation {
  /** Where the glide is heading, in pixels. */
  target: number;
  axis: ScrollAxis;
  /** The configured duration, read once per notch. */
  duration: number;
  frame: number | null;
  lastFrame: number;
}

const animations = new WeakMap<HTMLElement, ScrollAnimation>();

/**
 * Elements whose CSS `scroll-behavior: smooth` is being held back.
 *
 * Assigning `scrollTop` on an element with smooth behaviour asks the browser to
 * glide — which is a second animator writing the same offset, frame by frame
 * against this one. The strip that glides to the active tab is written that way,
 * so while a glide of ours is running its own behaviour is suspended and the
 * value it had is put back afterwards.
 */
const suspendedBehavior = new WeakMap<HTMLElement, string>();

function suspendSmoothBehavior(element: HTMLElement): void {
  if (suspendedBehavior.has(element)) return;
  if (getComputedStyle(element).scrollBehavior !== 'smooth') return;
  suspendedBehavior.set(element, element.style.scrollBehavior);
  element.style.scrollBehavior = 'auto';
}

function resumeSmoothBehavior(element: HTMLElement): void {
  const previous = suspendedBehavior.get(element);
  if (previous === undefined) return;
  suspendedBehavior.delete(element);
  element.style.scrollBehavior = previous;
}

/** Stops an element's glide where it is, as a scrollbar drag or a trackpad does. */
export function stopScrollAnimation(element: HTMLElement): void {
  const state = animations.get(element);
  if (!state) return;
  if (state.frame !== null) cancelAnimationFrame(state.frame);
  state.frame = null;
  state.lastFrame = 0;
  state.target = readOffset(element, state.axis);
  resumeSmoothBehavior(element);
}

/**
 * Glides an element to an offset.
 *
 * `animated` is what the palette's "keep the highlighted row in view" asks for;
 * without it the offset is simply applied, which is what callers that have to be
 * exact (restoring a saved position) want. Reduced motion turns every glide into
 * that exact jump.
 */
export function scrollElementTo(
  element: HTMLElement,
  offset: number,
  options: { axis?: ScrollAxis; animated?: boolean; duration?: number } = {}
): void {
  const axis = options.axis ?? 'y';
  const target = clampScrollTop(offset, maxOffset(element, axis));
  const duration = options.animated && !prefersReducedMotion() ? options.duration ?? smoothScrollDuration() : 0;

  if (duration <= 0 || typeof requestAnimationFrame !== 'function') {
    stopScrollAnimation(element);
    suspendSmoothBehavior(element);
    writeOffset(element, axis, target);
    resumeSmoothBehavior(element);
    return;
  }
  animate(element, axis, target, duration);
}

/** Moves an element by a notch, adding to a glide that is already running. */
export function scrollElementBy(element: HTMLElement, axis: ScrollAxis, delta: number, duration = smoothScrollDuration()): void {
  const state = animations.get(element);
  // While a glide is running the notch adds to its target rather than to the
  // pixels under it, so a fast wheel arrives where it was aimed instead of
  // losing whatever the animation had not covered yet.
  const base = state && state.frame !== null ? state.target : readOffset(element, axis);
  scrollElementTo(element, base + delta, { axis, animated: true, duration });
}

function animate(element: HTMLElement, axis: ScrollAxis, target: number, duration: number): void {
  let state = animations.get(element);
  if (!state) {
    state = { target, axis, duration, frame: null, lastFrame: 0 };
    animations.set(element, state);
  }
  state.target = target;
  state.axis = axis;
  state.duration = duration;
  if (state.frame !== null) return;
  suspendSmoothBehavior(element);

  const step = (timestamp: number): void => {
    const elapsed = state.lastFrame === 0 ? 16 : Math.min(timestamp - state.lastFrame, 64);
    state.lastFrame = timestamp;

    const current = readOffset(element, state.axis);
    const remaining = state.target - current;
    if (Math.abs(remaining) < 0.5) {
      writeOffset(element, state.axis, state.target);
      state.frame = null;
      state.lastFrame = 0;
      resumeSmoothBehavior(element);
      return;
    }

    // Exponential approach: ~95% of the distance is covered in `duration`.
    const tau = Math.max(state.duration, 1) / 3;
    writeOffset(element, state.axis, current + remaining * (1 - Math.exp(-elapsed / tau)));
    state.frame = requestAnimationFrame(step);
  };

  state.frame = requestAnimationFrame(step);
}

// -------------------------------------------------------------------- install

let installedDispose: (() => void) | null = null;

/**
 * Takes the wheel for the whole shell, once.
 *
 * Installing twice is a no-op that returns the same disposer, because the shell
 * is mounted under `StrictMode` and a second listener would animate every notch
 * twice.
 */
export function installSmoothWheelScrolling(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (installedDispose) return installedDispose;

  const onWheel = (event: WheelEvent): void => {
    if (!smoothScrollingEnabled()) return;

    const plan = planWheelScroll(event, event.target);
    if (!plan) return;

    if (!plan.element) {
      // A surface that claims Ctrl+wheel: nothing here can scroll, but the zoom
      // must not run either — the popup covers the window while Ctrl is held.
      if (plan.claimsCtrlWheel) event.preventDefault();
      return;
    }

    const { element, axis } = plan;

    // A trackpad's own momentum is better than an animation of it (and the two
    // fight frame by frame over `scrollTop`), so the notch is passed through
    // untouched while that setting is on. Ctrl+wheel never passes through: on a
    // surface that claims it, the browser would zoom instead.
    if (!event.ctrlKey && trackpadMomentumEnabled() && isTrackpadWheel(event)) {
      stopScrollAnimation(element);
      return;
    }

    const delta = wheelDelta(event, axis, axis === 'y' ? element.clientHeight : element.clientWidth);
    if (delta === 0) return;

    event.preventDefault();
    scrollElementBy(element, axis, delta, smoothScrollDuration());
  };

  /**
   * Keeps a glide in step with scrolling nobody asked this module for: a
   * scrollbar drag, a keyboard page, `scrollIntoView` from the palette.
   */
  const onScroll = (event: Event): void => {
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;
    const state = animations.get(element);
    if (state && state.frame === null) state.target = readOffset(element, state.axis);
  };

  window.addEventListener('wheel', onWheel, { passive: false });
  // Scroll events do not bubble, but they do travel down to the target, so a
  // capture listener on the window sees every element that scrolls.
  window.addEventListener('scroll', onScroll, true);

  const dispose = (): void => {
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('scroll', onScroll, true);
    if (installedDispose === dispose) installedDispose = null;
  };
  installedDispose = dispose;
  return dispose;
}
