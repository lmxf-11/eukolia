/**
 * Eukolia — the floating PDF viewer Focus Mode gets from the Alt key.
 *
 * Focus Mode (`Instructions.md` §42) is the editor alone: there is no pane
 * beside it, so the viewer cannot be docked there without giving up the thing
 * the layout is for. Holding Alt therefore floats it over the right-hand side of
 * the window — the same gesture shape as light-pdf's `Overlay` toolbar, which
 * appears while the pointer is near it rather than occupying the layout — and
 * letting go puts it away.
 *
 * Three details are decisions rather than transcription, because there is no
 * reference for this: light-pdf has no focus mode and no floating document
 * window. Each is here rather than in `App.tsx` so it can be asserted without a
 * window.
 *
 * 1. **A tap does not flash the overlay.** Alt is a modifier, so it is pressed
 *    on the way to somewhere else constantly — `Alt+Tab` to another window,
 *    `Alt+Left` for Back, and Eukolia's own `Ctrl+Alt+…` layout keys. Revealing
 *    on the key down and hiding on the key up would draw a viewer across the
 *    editor for the duration of every one of them. The reveal waits
 *    `FOCUS_FLOAT_HOLD_MS`; a tap is over before then, a hold is not, and any
 *    other key pressed during the hold cancels it outright.
 *
 * 2. **A release does not take the viewer away from the pointer.** An overlay
 *    with an active text selection, a thumb under the cursor or a link about to
 *    be clicked is being *used*, and a reader who lets go of Alt must not lose
 *    the page they were reading. While the pointer is inside the overlay it
 *    stays; it leaves when the pointer does (`mouseleave`). That is also what
 *    keeps `Alt+Left` / `Alt+Right` — the viewer's own history navigation —
 *    working inside it: the pointer is over the overlay, so the release cannot
 *    close the pane the shortcut is about to act on.
 *
 * 3. **Its width is its own.** `appearance.sidebarWidth` and the split ratio
 *    both describe a two-pane window; neither says how much of a one-pane window
 *    an overlay should cover. `pdf.focusFloatWidth` is that number, and the
 *    overlay's left edge is a drag handle that writes it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { setting, settingsManager } from '../core/settings';

/** How long Alt must be held before the overlay appears. */
export const FOCUS_FLOAT_HOLD_MS = 260;

/** The overlay's width bounds, matching the `pdf.focusFloatWidth` descriptor. */
export const FOCUS_FLOAT_MIN_WIDTH = 320;
export const FOCUS_FLOAT_MAX_WIDTH = 1600;
export const FOCUS_FLOAT_DEFAULT_WIDTH = 720;

/** Clamps a width into the range the setting allows. */
export function clampFocusFloatWidth(width: number): number {
  if (!Number.isFinite(width)) return FOCUS_FLOAT_DEFAULT_WIDTH;
  return Math.min(FOCUS_FLOAT_MAX_WIDTH, Math.max(FOCUS_FLOAT_MIN_WIDTH, Math.round(width)));
}

/**
 * The overlay's width in pixels. Read live rather than captured, so the Settings
 * UI and the drag handle agree about it.
 */
export function focusFloatWidth(): number {
  const value = setting.num('pdf.focusFloatWidth');
  if (!Number.isFinite(value) || value <= 0) return FOCUS_FLOAT_DEFAULT_WIDTH;
  return clampFocusFloatWidth(value);
}

/** What a state transition asks for. */
export type FocusFloatAction =
  /** Alt has been held for `FOCUS_FLOAT_HOLD_MS`. */
  | 'hold'
  /** Alt came up, or a chord was pressed during the hold. */
  | 'release'
  /** The pointer left the overlay. */
  | 'pointer-leave'
  /** The command palette's toggle. */
  | 'toggle'
  /** The layout left Focus Mode, or the PDF pane was collapsed. */
  | 'reset';

export interface FocusFloatState {
  open: boolean;
  /**
   * True while the pointer is over the overlay, which is what makes a release
   * leave it alone (decision 2 above). Carried in the state rather than read
   * from the DOM at release time, so the release consults the same value the
   * last pointer event wrote.
   */
  pointerInside: boolean;
}

export const FOCUS_FLOAT_CLOSED: FocusFloatState = { open: false, pointerInside: false };

/**
 * The overlay's state machine, pure so both rules above can be asserted directly
 * rather than through a rendered window.
 *
 * `enabled` is the layout's answer to "is the overlay possible at all" — Focus
 * Mode, with a document whose PDF is on screen. A `hold` while it is false is
 * not a request to open, and a layout that stops being Focus Mode resets the
 * state rather than leaving a floating pane over a layout that has its own.
 */
export function focusFloatReducer(state: FocusFloatState, action: FocusFloatAction, enabled: boolean): FocusFloatState {
  switch (action) {
    case 'hold':
      if (!enabled) return state.open || state.pointerInside ? FOCUS_FLOAT_CLOSED : state;
      return state.open ? state : { open: true, pointerInside: state.pointerInside };
    case 'release':
      // Decision 2: the pointer is using it.
      if (state.pointerInside) return state;
      return state.open ? FOCUS_FLOAT_CLOSED : state;
    case 'pointer-leave':
      if (!state.pointerInside) return state;
      return state.open ? { open: false, pointerInside: false } : FOCUS_FLOAT_CLOSED;
    case 'toggle':
      if (!enabled) return FOCUS_FLOAT_CLOSED;
      return state.open ? { open: false, pointerInside: false } : { open: true, pointerInside: false };
    case 'reset':
    default:
      return FOCUS_FLOAT_CLOSED;
  }
}

/** The key name the DOM reports for each modifier this hook accepts. */
function modifierKeyName(modifier: 'alt' | 'control' | 'shift'): string {
  switch (modifier) {
    case 'control':
      return 'Control';
    case 'shift':
      return 'Shift';
    default:
      return 'Alt';
  }
}

/**
 * Tracks a modifier key and reports the three things the overlay needs: that it
 * has been held long enough, that it came up, and that a chord was pressed while
 * it was down.
 *
 * The listeners are on the window because the modifier is pressed wherever the
 * focus happens to be — the editor, the title bar, the overlay itself. `blur` is
 * treated as a release: the key up of an `Alt+Tab` is delivered to the window
 * the user switched *to*, so without this the overlay would remain up in a
 * window nobody is looking at.
 */
export function useModifierHold(
  modifier: 'alt' | 'control' | 'shift',
  handlers: { onHold(): void; onRelease(): void },
  holdMs = FOCUS_FLOAT_HOLD_MS
): void {
  // In a ref, so the effect subscribes once and a re-render cannot drop a
  // pending hold or fire a stale callback.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const name = modifierKeyName(modifier);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancelHold = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== name) {
        // A chord: the modifier is down but the user is going somewhere else.
        // Whatever the hold had asked for is taken back, but a key repeat of the
        // chord must not re-send a release on every repeat.
        if (!event.repeat) {
          cancelHold();
          handlersRef.current.onRelease();
        }
        return;
      }
      if (event.repeat || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        handlersRef.current.onHold();
      }, holdMs);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== name) return;
      cancelHold();
      handlersRef.current.onRelease();
    };

    const onBlur = () => {
      cancelHold();
      handlersRef.current.onRelease();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      cancelHold();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [modifier, holdMs]);
}

/**
 * The overlay's state, wired to the Alt key and to the layout.
 *
 * `enabled` is the caller's answer to "could a floating viewer be shown now":
 * Focus Mode with a document open. Anything else leaves the overlay closed, and
 * a layout that leaves Focus Mode closes it — the docked pane and the floating
 * one are never both on screen.
 */
export function useFocusPdfFloat(enabled: boolean): {
  open: boolean;
  setPointerInside(inside: boolean): void;
  toggle(): void;
} {
  const [state, setState] = useState<FocusFloatState>(FOCUS_FLOAT_CLOSED);
  // The reducer needs the current `enabled` and the key listeners are subscribed
  // once, so it is read through a ref rather than closed over.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  /**
   * Every transition goes through the functional form of `setState`, so it is
   * applied to the state React has committed rather than to the one the caller's
   * closure was built from.
   *
   * That is not a style preference. A transition that does nothing — the pointer
   * moving *onto* an overlay that is already open, say — returns the state object
   * it was given, so React skips the re-render, and a handler React is still
   * holding from an earlier render would then read `pointerInside` as it was
   * before the pointer arrived. That is exactly the value a release consults, so
   * the stale read is an overlay that either closes while it is being used or
   * stays after the pointer has gone. Reading it inside the updater means every
   * transition sees the state the last one produced.
   */
  const dispatch = useCallback((action: FocusFloatAction) => {
    setState((previous) => focusFloatReducer(previous, action, enabledRef.current));
  }, []);

  useModifierHold('alt', {
    onHold: () => dispatch('hold'),
    onRelease: () => dispatch('release')
  });

  useEffect(() => {
    if (!enabled) dispatch('reset');
  }, [enabled, dispatch]);

  const setPointerInside = useCallback(
    (inside: boolean) => {
      if (inside) {
        setState((previous) => (previous.pointerInside ? previous : { ...previous, pointerInside: true }));
        return;
      }
      dispatch('pointer-leave');
    },
    [dispatch]
  );

  const toggle = useCallback(() => dispatch('toggle'), [dispatch]);

  return { open: state.open && enabled, setPointerInside, toggle };
}

/**
 * The overlay's width after a drag on its left edge.
 *
 * `startWidth + (startX - clientX)` is the drag expressed as a width: the
 * overlay is anchored to the right edge, so moving the pointer left makes it
 * wider — the opposite sign to the sidebar's arithmetic in `App.tsx`, which is
 * anchored to the left.
 */
export function focusFloatWidthAfterDrag(startWidth: number, startX: number, clientX: number): number {
  return clampFocusFloatWidth(startWidth + (startX - clientX));
}

/** Persists a dragged width, so the overlay opens at the same size next time. */
export function rememberFocusFloatWidth(width: number): void {
  settingsManager.setValue('pdf.focusFloatWidth', clampFocusFloatWidth(width), 'user');
}
