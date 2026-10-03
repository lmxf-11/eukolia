// @vitest-environment jsdom
/**
 * Focus Mode's floating PDF viewer: the state machine `focusFloat.ts` owns, and
 * the wire from the Alt key to it.
 *
 * The reducer is pure, so the rules are asserted directly: a tap must not flash
 * the overlay, a chord must cancel one that a hold had asked for, a release must
 * not take the viewer away from a pointer that is using it, and a layout that is
 * not Focus Mode must not have one at all. Everything below the reducer is the
 * DOM wiring, which the gesture tests drive with real events.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';

import {
  FOCUS_FLOAT_CLOSED,
  FOCUS_FLOAT_DEFAULT_WIDTH,
  FOCUS_FLOAT_HOLD_MS,
  FOCUS_FLOAT_MAX_WIDTH,
  FOCUS_FLOAT_MIN_WIDTH,
  clampFocusFloatWidth,
  focusFloatReducer,
  focusFloatWidth,
  focusFloatWidthAfterDrag,
  useFocusPdfFloat,
  type FocusFloatState
} from '../../src/renderer/ui/focusFloat';
import { getSettingDescriptor, settingsManager } from '../../src/renderer/core/settings';

const open: FocusFloatState = { open: true, pointerInside: false };
const openUnderPointer: FocusFloatState = { open: true, pointerInside: true };

describe('focusFloatReducer — the rules the overlay is held to', () => {
  it('opens on a hold, and only while the layout can show it', () => {
    expect(focusFloatReducer(FOCUS_FLOAT_CLOSED, 'hold', true)).toEqual(open);
    // An overlay in a layout that has its own docked pane is not a request to
    // open: Focus Mode is what makes it possible.
    expect(focusFloatReducer(FOCUS_FLOAT_CLOSED, 'hold', false)).toEqual(FOCUS_FLOAT_CLOSED);
    // Holding again while it is open changes nothing (Alt is held, not pressed).
    expect(focusFloatReducer(open, 'hold', true)).toBe(open);
  });

  it('offers the viewer to a smooth (fine-grained) scroll wheel', () => {
    // A wheel event is not a key, so it does not reach the modifier hook at all —
    // but the state it must not disturb is the same one a release consults.
    expect(focusFloatReducer(open, 'release', true)).toEqual(FOCUS_FLOAT_CLOSED);
  });

  it('closes on a release only when nothing is using it', () => {
    expect(focusFloatReducer(open, 'release', true)).toEqual(FOCUS_FLOAT_CLOSED);
    // The pointer is inside: the reader is scrolling, selecting or about to click
    // a link, and letting go of Alt must not take the page away.
    expect(focusFloatReducer(openUnderPointer, 'release', true)).toBe(openUnderPointer);
  });

  it('closes when the pointer leaves, and only then', () => {
    expect(focusFloatReducer(openUnderPointer, 'pointer-leave', true)).toEqual(FOCUS_FLOAT_CLOSED);
    // A pointer that was never inside leaves nothing to do.
    expect(focusFloatReducer(open, 'pointer-leave', true)).toBe(open);
    expect(focusFloatReducer(FOCUS_FLOAT_CLOSED, 'pointer-leave', true)).toBe(FOCUS_FLOAT_CLOSED);
  });

  it('toggles from the palette, and refuses outside Focus Mode', () => {
    expect(focusFloatReducer(FOCUS_FLOAT_CLOSED, 'toggle', true)).toEqual(open);
    expect(focusFloatReducer(open, 'toggle', true)).toEqual(FOCUS_FLOAT_CLOSED);
    expect(focusFloatReducer(open, 'toggle', false)).toEqual(FOCUS_FLOAT_CLOSED);
  });

  it('is closed by a layout that stops being Focus Mode', () => {
    expect(focusFloatReducer(openUnderPointer, 'reset', true)).toEqual(FOCUS_FLOAT_CLOSED);
    // And a hold that arrives while the overlay is impossible closes a stale one
    // rather than leaving it on screen over a layout that has its own pane.
    expect(focusFloatReducer(open, 'hold', false)).toEqual(FOCUS_FLOAT_CLOSED);
  });
});

describe('the overlay\'s width', () => {
  it('is its own setting, with the descriptor\'s own bounds', () => {
    const descriptor = getSettingDescriptor('pdf.focusFloatWidth');
    expect(descriptor?.category).toBe('PDF');
    expect(descriptor?.type).toBe('number');
    expect(focusFloatWidth()).toBe(FOCUS_FLOAT_DEFAULT_WIDTH);
    expect(descriptor?.min).toBe(FOCUS_FLOAT_MIN_WIDTH);
    expect(descriptor?.max).toBe(FOCUS_FLOAT_MAX_WIDTH);
    // It is deliberately not the split ratio or the sidebar: Focus Mode has no
    // second pane for either to describe.
    expect(getSettingDescriptor('pdf.focusFloatWidth')?.key).not.toBe('appearance.sidebarWidth');
  });

  it('clamps a nonsense value instead of writing one', () => {
    expect(clampFocusFloatWidth(0)).toBe(FOCUS_FLOAT_MIN_WIDTH);
    expect(clampFocusFloatWidth(-100)).toBe(FOCUS_FLOAT_MIN_WIDTH);
    expect(clampFocusFloatWidth(99_999)).toBe(FOCUS_FLOAT_MAX_WIDTH);
    expect(clampFocusFloatWidth(Number.NaN)).toBe(FOCUS_FLOAT_DEFAULT_WIDTH);
    expect(clampFocusFloatWidth(640.4)).toBe(640);
  });

  it('grows when the pointer drags the left edge leftwards', () => {
    // The overlay is anchored to the right edge, so the sign is the sidebar's
    // opposite: a pointer moving left makes it wider.
    expect(focusFloatWidthAfterDrag(720, 1000, 900)).toBe(820);
    expect(focusFloatWidthAfterDrag(720, 1000, 1100)).toBe(620);
    // Clamped to the range the setting accepts, so the drag cannot write a value
    // the descriptor would reject.
    expect(focusFloatWidthAfterDrag(400, 1000, 2000)).toBe(FOCUS_FLOAT_MIN_WIDTH);
    expect(focusFloatWidthAfterDrag(1500, 1000, 0)).toBe(FOCUS_FLOAT_MAX_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// The wiring: the Alt key, through the hook, to the overlay's state
// ---------------------------------------------------------------------------

interface Harness {
  root: Root;
  host: HTMLElement;
  read(): { open: boolean };
  setEnabled(enabled: boolean): Promise<void>;
  pointerInside(inside: boolean): Promise<void>;
  toggle(): Promise<void>;
  unmount(): Promise<void>;
}

/**
 * The hook's state as the last committed render saw it.
 *
 * `latest` is what the probe component was handed, which is what a real overlay
 * would be drawn from, so a test reads committed state rather than a queued
 * update.
 */
let latest: { open: boolean; setPointerInside(inside: boolean): void; toggle(): void } | null = null;

const FloatProbe: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const float = useFocusPdfFloat(enabled);
  latest = float;
  return createElement('div', { 'data-open': float.open ? '1' : '0' });
};

async function mount(): Promise<Harness> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  /**
   * Commits one update and waits for React to process it.
   *
   * The render *and* a turn of the microtask queue inside `act` are both
   * required: React does not run a `setState` updater at the call site, so an
   * `act` that returns before yielding leaves the update queued and the test
   * reading the state from before it.
   */
  const flush = async (render: () => void) => {
    await act(async () => {
      render();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  await flush(() => root.render(createElement(FloatProbe, { enabled: true })));
  return {
    root,
    host,
    read: () => ({ open: latest?.open ?? false }),
    setEnabled: (next) => flush(() => root.render(createElement(FloatProbe, { enabled: next }))),
    pointerInside: (inside) => flush(() => latest?.setPointerInside(inside)),
    toggle: () => flush(() => latest?.toggle()),
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    }
  };
}

const key = async (type: 'keydown' | 'keyup', keyName: string, init: KeyboardEventInit = {}) => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent(type, { key: keyName, bubbles: true, cancelable: true, ...init }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** Waits past the hold, which a real press would spend being held down. */
const holdLongEnough = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, FOCUS_FLOAT_HOLD_MS + 40));
  });
};

beforeEach(() => {
  vi.useRealTimers();
  latest = null;
  settingsManager.reset('pdf.focusFloatWidth', 'user');
});

afterEach(() => {
  document.body.replaceChildren();
  settingsManager.reset('pdf.focusFloatWidth', 'user');
});

describe('the Alt key', () => {
  it('reveals the viewer when held, and puts it away when let go', async () => {
    const view = await mount();
    expect(view.read().open).toBe(false);

    await key('keydown', 'Alt');
    // A hold is not a tap: nothing has appeared yet.
    expect(view.read().open).toBe(false);
    await holdLongEnough();
    expect(view.read().open).toBe(true);

    await key('keyup', 'Alt');
    expect(view.read().open).toBe(false);
    await view.unmount();
  });

  it('does not flash the viewer for a tap, or for a chord', async () => {
    const view = await mount();

    // Alt+Tab: the modifier is down and up again inside the hold's window.
    await key('keydown', 'Alt');
    await key('keydown', 'Tab', { altKey: true });
    await key('keyup', 'Tab', { altKey: true });
    expect(view.read().open).toBe(false);
    await holdLongEnough();
    // …and the hold that was cancelled must not fire late.
    expect(view.read().open).toBe(false);
    await key('keyup', 'Alt');

    // Alt+Left (the viewer's own Back): held long enough to have revealed, the
    // chord takes it back rather than leaving an overlay over the editor.
    await key('keydown', 'Alt');
    await holdLongEnough();
    expect(view.read().open).toBe(true);
    await key('keydown', 'ArrowLeft', { altKey: true });
    expect(view.read().open).toBe(false);
    await key('keyup', 'Alt');
    await view.unmount();
  });

  it('leaves the viewer up while the pointer is using it', async () => {
    const view = await mount();
    await key('keydown', 'Alt');
    await holdLongEnough();
    expect(view.read().open).toBe(true);

    // The pointer moves onto the overlay — the viewer is being read.
    await view.pointerInside(true);
    await key('keyup', 'Alt');
    expect(view.read().open).toBe(true);

    // It leaves when the pointer does.
    await view.pointerInside(false);
    expect(view.read().open).toBe(false);
    await view.unmount();
  });

  it('closes the viewer when the window loses focus mid-hold', async () => {
    const view = await mount();
    await key('keydown', 'Alt');
    await holdLongEnough();
    expect(view.read().open).toBe(true);

    // `Alt+Tab` delivers the key up to the window the user switched to, so the
    // overlay must not be left standing in a window nobody is looking at.
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.read().open).toBe(false);
    await view.unmount();
  });

  it('has no overlay outside Focus Mode', async () => {
    const view = await mount();
    await view.setEnabled(false);
    await key('keydown', 'Alt');
    await holdLongEnough();
    expect(view.read().open).toBe(false);
    await key('keyup', 'Alt');

    // And the palette's toggle is refused there too.
    await view.toggle();
    expect(view.read().open).toBe(false);
    await view.unmount();
  });
});
