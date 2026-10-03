// @vitest-environment jsdom
/**
 * The shell's wheel: one handler, one easing, every surface.
 *
 * These cover what a notch *means* (which element it moves, and what it must
 * leave alone: the PDF viewer, xterm, Ctrl+wheel's zoom), what it is worth in
 * pixels, how it glides, and that `ScrollArea` is one surface of many rather than
 * an implementation of its own. That last point is the reason the module exists —
 * "smooth scrolling" used to mean two different things depending on which panel
 * the pointer happened to be over.
 *
 * The animation is frames, so frames are a test step here: `requestAnimationFrame`
 * is replaced by a queue the test pumps, which is what makes "the glide is not a
 * jump" an assertion rather than a timing guess.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CTRL_WHEEL_ATTRIBUTE,
  NATIVE_SCROLL_ATTRIBUTE,
  canScroll,
  installSmoothWheelScrolling,
  isTrackpadWheel,
  normalizeWheelDelta,
  planWheelScroll,
  scrollElementTo,
  scrollableAncestor,
  stopScrollAnimation,
  wheelDelta,
} from '@/core/smoothScroll';
import { settingsManager } from '@/core/settings';
import { ScrollArea } from '@/ui/components/ScrollArea';

// ------------------------------------------------------------------ harness

interface Metrics {
  clientHeight?: number;
  scrollHeight?: number;
  clientWidth?: number;
  scrollWidth?: number;
}

/** A scroll container with the measurements jsdom cannot take itself. */
const scroller = (metrics: Metrics = {}, overflow: { y?: string; x?: string } = {}): HTMLDivElement => {
  const element = document.createElement('div');
  element.style.overflowY = overflow.y ?? 'auto';
  element.style.overflowX = overflow.x ?? 'hidden';
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => metrics.clientHeight ?? 100 });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight ?? 1000 });
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => metrics.clientWidth ?? 100 });
  Object.defineProperty(element, 'scrollWidth', { configurable: true, get: () => metrics.scrollWidth ?? 100 });
  document.body.appendChild(element);
  return element;
};

/** A wheel event delivered over `element`, as the browser would deliver it. */
const wheel = (element: Element, init: WheelEventInit = {}): WheelEvent => {
  const event = new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event;
};

/**
 * jsdom's computed style does not expand the `overflow` shorthand, which is how
 * `ScrollArea` writes it, so a test that wants that box to read as scrollable
 * spells the two longhands out. Chromium reports them either way.
 */
const readableOverflow = (element: HTMLElement): void => {
  element.style.overflowY = 'auto';
  element.style.overflowX = 'hidden';
};

const metric = (element: Element, name: 'clientHeight' | 'scrollHeight' | 'clientWidth' | 'scrollWidth', value: number): void => {
  Object.defineProperty(element, name, { configurable: true, get: () => value });
};

/** Frames waiting for the test to run them. */
let frames: Array<{ handle: number; callback: FrameRequestCallback }> = [];
let nextHandle = 0;

/** Runs the queued frames, the way the browser would on its next paints. */
const pump = (count = 1, step = 32): void => {
  for (let index = 1; index <= count; index++) {
    const due = frames;
    frames = [];
    for (const frame of due) frame.callback(index * step);
  }
};

let disposeEngine: () => void;

beforeEach(() => {
  frames = [];
  nextHandle = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push({ handle: ++nextHandle, callback });
    return nextHandle;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames = frames.filter((frame) => frame.handle !== id);
  });

  settingsManager.reset('scrolling.smooth');
  settingsManager.reset('scrolling.smoothDurationMs');
  settingsManager.reset('scrolling.trackpadMomentum');

  document.body.innerHTML = '';
  disposeEngine = installSmoothWheelScrolling();
});

afterEach(() => {
  disposeEngine();
  vi.unstubAllGlobals();
});

const renderComponent = async (element: React.ReactElement): Promise<HTMLElement> => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return container;
};

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// -------------------------------------------------------------- the decision

describe('which surface a notch moves', () => {
  it('takes the innermost scroller rather than the outermost', () => {
    const outer = scroller({ scrollHeight: 2000 });
    const inner = scroller({ scrollHeight: 400 });
    outer.appendChild(inner);
    const target = document.createElement('span');
    inner.appendChild(target);

    expect(scrollableAncestor(target, 'y')).toEqual({ element: inner, axis: 'y' });
  });

  it('moves a horizontal strip sideways, because that is the only axis it has', () => {
    // The tab strip: a plain notch has to move it, or the tabs past the edge are
    // unreachable with a wheel.
    const strip = scroller({ clientHeight: 30, scrollHeight: 30, clientWidth: 300, scrollWidth: 900 }, { y: 'hidden', x: 'auto' });
    const tab = document.createElement('div');
    strip.appendChild(tab);

    expect(scrollableAncestor(tab, 'y')).toEqual({ element: strip, axis: 'x' });
  });

  it('gives a box that scrolls both ways the axis the event asked for', () => {
    const box = scroller({ clientHeight: 100, scrollHeight: 900, clientWidth: 200, scrollWidth: 800 }, { y: 'auto', x: 'auto' });

    expect(scrollableAncestor(box, 'y')?.axis).toBe('y');
    expect(scrollableAncestor(box, 'x')?.axis).toBe('x');
  });

  it('leaves a box whose content fits exactly where it is', () => {
    // Taking the notch for a box that cannot move swallows the wheel: the bar
    // and the content do not scroll and nothing else gets a turn.
    const fits = scroller({ clientHeight: 400, scrollHeight: 400 });

    expect(canScroll(fits, 'y')).toBe(false);
    expect(scrollableAncestor(fits, 'y')).toBeNull();
  });

  it('ignores a clipped overflow, however much of it there is', () => {
    const clipped = scroller({ clientHeight: 100, scrollHeight: 900 }, { y: 'hidden' });

    expect(canScroll(clipped, 'y')).toBe(false);
    expect(scrollableAncestor(clipped, 'y')).toBeNull();
  });
});

describe('what the shell leaves to somebody else', () => {
  it('stands down when a handler already took the notch', () => {
    const element = scroller();
    const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
    event.preventDefault();

    expect(planWheelScroll(event, element)).toBeNull();
  });

  it('stops at a surface that owns its own scrolling', () => {
    const native = scroller({ scrollHeight: 500 });
    native.setAttribute(NATIVE_SCROLL_ATTRIBUTE, 'true');
    const inner = scroller({ scrollHeight: 400 });
    native.appendChild(inner);
    const target = document.createElement('span');
    inner.appendChild(target);

    // The PDF viewer and the terminal say so themselves, and a walk that went
    // past them would animate a `scrollTop` their own engine is already driving.
    expect(scrollableAncestor(target, 'y')).toBeNull();
    expect(planWheelScroll(new WheelEvent('wheel', { deltaY: 120, cancelable: true }), target)).toBeNull();
  });

  it('leaves Ctrl+wheel to the browser everywhere the zoom is what it means', () => {
    const element = scroller();

    expect(planWheelScroll(new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, cancelable: true }), element)).toBeNull();
  });

  it('scrolls Ctrl+wheel inside a surface that claims it, and blocks the zoom when nothing scrolls', () => {
    const popup = document.createElement('div');
    popup.setAttribute(CTRL_WHEEL_ATTRIBUTE, 'true');
    const list = scroller({ scrollHeight: 2000 });
    popup.appendChild(list);
    document.body.appendChild(popup);

    const overList = new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, cancelable: true });
    expect(planWheelScroll(overList, list)).toMatchObject({ element: list, axis: 'y', claimsCtrlWheel: true });

    // Over the popup's backdrop there is nothing to scroll, and the claim still
    // says the zoom must not run: the popup covers the window while Ctrl is held.
    const overBackdrop = new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, cancelable: true });
    expect(planWheelScroll(overBackdrop, popup)).toMatchObject({ element: null, claimsCtrlWheel: true });
  });

  it('reads Shift and a tilt wheel as the sideways request they are', () => {
    const box = scroller({ clientHeight: 100, scrollHeight: 900, clientWidth: 200, scrollWidth: 800 }, { y: 'auto', x: 'auto' });

    expect(planWheelScroll(new WheelEvent('wheel', { deltaY: 120, shiftKey: true, cancelable: true }), box)?.axis).toBe('x');
    expect(planWheelScroll(new WheelEvent('wheel', { deltaY: 4, deltaX: 60, cancelable: true }), box)?.axis).toBe('x');
  });
});

describe('what a notch is worth in pixels', () => {
  it('carries a pixel notch through as it arrives', () => {
    expect(wheelDelta({ deltaY: 100, deltaMode: 0 }, 'y', 400)).toBe(100);
  });

  it('converts a line notch, which is what a classic wheel reports', () => {
    expect(wheelDelta({ deltaY: 3, deltaMode: 1 }, 'y', 400)).toBe(48);
    expect(normalizeWheelDelta({ deltaY: 3, deltaMode: 1 }, 400)).toBe(48);
  });

  it('converts a page notch against the surface it is scrolling', () => {
    expect(wheelDelta({ deltaY: 1, deltaMode: 2 }, 'y', 240)).toBe(240);
  });

  it('uses deltaY for a horizontal strip, and deltaX for a tilt wheel', () => {
    expect(wheelDelta({ deltaY: 120, deltaX: 0, deltaMode: 0 }, 'x', 400)).toBe(120);
    expect(wheelDelta({ deltaY: 0, deltaX: 60, deltaMode: 0 }, 'x', 400)).toBe(60);
  });

  it('is nothing at all when the event carries no distance', () => {
    expect(wheelDelta({ deltaY: 0, deltaMode: 0 }, 'y', 400)).toBe(0);
  });

  it('reads a fractional pixel delta as a trackpad', () => {
    expect(isTrackpadWheel({ deltaY: 12.5, deltaMode: 0 })).toBe(true);
    expect(isTrackpadWheel({ deltaY: 120, deltaMode: 0 })).toBe(false);
    expect(isTrackpadWheel({ deltaY: 3, deltaMode: 1 })).toBe(false);
  });
});

// ------------------------------------------------------------------ the glide

describe('the glide', () => {
  it('takes the notch from the browser and eases towards the target', () => {
    const element = scroller({ clientHeight: 100, scrollHeight: 1000 });
    const event = wheel(element, { deltaY: 120 });

    expect(event.defaultPrevented).toBe(true);
    pump(1);
    // One frame in, the offset has moved and has not arrived: this is the whole
    // difference between smooth scrolling and a jump.
    expect(element.scrollTop).toBeGreaterThan(0);
    expect(element.scrollTop).toBeLessThan(120);

    pump(40);
    expect(element.scrollTop).toBeCloseTo(120, 1);
    expect(frames).toHaveLength(0);
  });

  it('adds a second notch to the first rather than restarting from the pixels', () => {
    const element = scroller({ clientHeight: 100, scrollHeight: 1000 });
    wheel(element, { deltaY: 120 });
    pump(1);
    const midway = element.scrollTop;
    wheel(element, { deltaY: 120 });
    pump(60);

    // The second notch was aimed 240px out, not 120px past wherever the glide
    // happened to be when it arrived.
    expect(midway).toBeLessThan(120);
    expect(element.scrollTop).toBeCloseTo(240, 1);
  });

  it('stops at the end of the content instead of running past it', () => {
    const element = scroller({ clientHeight: 100, scrollHeight: 400 });
    wheel(element, { deltaY: 900 });
    pump(60);

    expect(element.scrollTop).toBe(300);
  });

  it('follows a scrollbar drag instead of overwriting it', () => {
    const element = scroller({ clientHeight: 100, scrollHeight: 1000 });
    element.scrollTop = 500;
    // A drag fires `scroll` without any wheel of ours; the next notch has to add
    // to where the user put the bar, not to where the last glide was aimed.
    element.dispatchEvent(new Event('scroll'));
    wheel(element, { deltaY: 100 });
    pump(60);

    expect(element.scrollTop).toBeCloseTo(600, 1);
  });

  it('passes a trackpad notch through untouched while momentum is respected', () => {
    const element = scroller({ clientHeight: 100, scrollHeight: 1000 });
    const event = wheel(element, { deltaY: 12.5 });

    expect(event.defaultPrevented).toBe(false);
    expect(frames).toHaveLength(0);
    expect(element.scrollTop).toBe(0);
  });

  it('animates a trackpad notch when momentum is not respected', () => {
    settingsManager.setValue('scrolling.trackpadMomentum', false, 'user');
    const element = scroller({ clientHeight: 100, scrollHeight: 1000 });
    const event = wheel(element, { deltaY: 12.5 });

    expect(event.defaultPrevented).toBe(true);
    pump(40);
    expect(element.scrollTop).toBeCloseTo(12.5, 1);
  });

  it('does nothing at all when smooth scrolling is switched off', () => {
    settingsManager.setValue('scrolling.smooth', false, 'user');
    const element = scroller({ clientHeight: 100, scrollHeight: 1000 });
    const event = wheel(element, { deltaY: 120 });

    // The browser's own scrolling is what "off" means, everywhere at once.
    expect(event.defaultPrevented).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it('jumps when the platform asked for less motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query }));
    const element = scroller({ clientHeight: 100, scrollHeight: 1000 });
    const event = wheel(element, { deltaY: 120 });

    expect(event.defaultPrevented).toBe(true);
    expect(frames).toHaveLength(0);
    expect(element.scrollTop).toBe(120);
  });

  it('does not fight a surface whose CSS already glides its scrollTop', () => {
    const element = scroller({ clientHeight: 100, scrollHeight: 1000 });
    element.style.cssText = 'overflow-y: auto; scroll-behavior: smooth';
    if (getComputedStyle(element).scrollBehavior !== 'smooth') return; // jsdom without the property

    wheel(element, { deltaY: 120 });
    // Frame-by-frame writes against `scroll-behavior: smooth` would start a new
    // browser glide per frame, so the behaviour is suspended for the glide and
    // handed back when it settles.
    expect(element.style.scrollBehavior).toBe('auto');
    pump(40);
    expect(element.scrollTop).toBeCloseTo(120, 1);
    expect(element.style.scrollBehavior).toBe('smooth');
  });

  it('stops a glide where it is when asked', () => {
    const element = scroller({ clientHeight: 100, scrollHeight: 1000 });
    wheel(element, { deltaY: 300 });
    pump(1);
    const stopped = element.scrollTop;
    stopScrollAnimation(element);
    pump(20);

    expect(element.scrollTop).toBeCloseTo(stopped, 1);
  });
});

// ------------------------------------------------------- ScrollArea delegates

describe('ScrollArea is one surface among many', () => {
  it('hands its box to the same handler', async () => {
    const container = await renderComponent(
      React.createElement(ScrollArea, { style: { height: 100 }, children: React.createElement('span', { 'data-testid': 'row' }) })
    );
    const box = container.querySelector('[data-scroll]') as HTMLElement;
    const row = container.querySelector('[data-testid="row"]') as HTMLElement;
    readableOverflow(box);
    metric(box, 'clientHeight', 100);
    metric(box, 'scrollHeight', 900);

    const event = wheel(row, { deltaY: 150 });
    expect(event.defaultPrevented).toBe(true);
    pump(40);

    expect(box.scrollTop).toBeCloseTo(150, 1);
  });

  it('gives the box back to the browser when it was asked to', async () => {
    const container = await renderComponent(
      React.createElement(ScrollArea, {
        smooth: false,
        style: { height: 100 },
        children: React.createElement('span', { 'data-testid': 'row' }),
      })
    );
    const box = container.querySelector('[data-scroll]') as HTMLElement;
    const row = container.querySelector('[data-testid="row"]') as HTMLElement;
    metric(box, 'clientHeight', 100);
    metric(box, 'scrollHeight', 900);

    expect(box.hasAttribute(NATIVE_SCROLL_ATTRIBUTE)).toBe(true);
    expect(wheel(row, { deltaY: 150 }).defaultPrevented).toBe(false);
  });

  it('glides for a list that has to keep its selection in view, and jumps when asked to be exact', async () => {
    const handle: { current: { scrollTo(top: number, animated?: boolean): void } | null } = { current: null };
    const container = await renderComponent(
      React.createElement(ScrollArea, { handleRef: handle as never, style: { height: 100 }, children: React.createElement('span') })
    );
    const box = container.querySelector('[data-scroll]') as HTMLElement;
    metric(box, 'clientHeight', 100);
    metric(box, 'scrollHeight', 900);

    act(() => handle.current?.scrollTo(200, true));
    expect(box.scrollTop).toBe(0);
    pump(40);
    expect(box.scrollTop).toBeCloseTo(200, 1);

    act(() => handle.current?.scrollTo(50));
    expect(box.scrollTop).toBe(50);
  });
});

describe('the shell installs one handler, once', () => {
  it('returns the same disposer for a second install, and takes its listeners away', () => {
    const again = installSmoothWheelScrolling();
    expect(again).toBe(disposeEngine);

    const element = scroller({ clientHeight: 100, scrollHeight: 900 });
    again();
    expect(wheel(element, { deltaY: 120 }).defaultPrevented).toBe(false);
  });
});

describe('the helper a caller may want directly', () => {
  it('scrolls an element to an offset without the wheel being involved', () => {
    const element = scroller({ clientHeight: 100, scrollHeight: 900 });
    scrollElementTo(element, 400, { animated: true });
    pump(40);

    expect(element.scrollTop).toBeCloseTo(400, 1);
  });
});
