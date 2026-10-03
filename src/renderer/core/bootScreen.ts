/**
 * Eukolia — the loading screen's bridge.
 *
 * The screen itself is `#eukolia-boot` in `index.html`, painted by the browser
 * from the parsed document before any module exists — which is why it is what the
 * user sees: the window is shown as soon as the document is asked for, not when
 * the entry bundle has painted (`createWindow` in `src/main/main.ts`).
 *
 * That makes the hand-off the interesting part, and it is in two halves:
 *
 *  - **What it says.** `setBootStatus` reports the stage the renderer is at, so a
 *    launch that takes a moment says what it is doing rather than showing an
 *    ellipsis. The text goes through `textContent`, never markup.
 *  - **When it goes.** `dismissBootScreen` is called in the same commit that puts
 *    the shell on screen, so the two overlap: the shell is already painted
 *    underneath while the screen fades. A screen that vanished first would leave a
 *    blank frame; one that waited for the shell to settle would cover it.
 *
 * Both are no-ops when the element is absent — in a test runner, in a window that
 * has already handed over, and in a build whose `index.html` predates this file.
 * The loading screen is a nicety, and nothing in the application may depend on it.
 */

interface BootBridge {
  setStatus?(text: string): void;
  dismiss?(): void;
}

function bridge(): BootBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { __eukoliaBoot?: BootBridge }).__eukoliaBoot;
}

/** Reports what the launch is doing, for the loading screen to show. */
export function setBootStatus(text: string): void {
  try {
    bridge()?.setStatus?.(text);
  } catch {
    /* the loading screen must never be able to fail a launch */
  }
}

/**
 * Takes the loading screen away.
 *
 * Safe to call more than once: the boot script owns the one-shot flag, so a
 * second call from a re-render, a StrictMode double-invoke or a late effect does
 * nothing.
 */
export function dismissBootScreen(): void {
  try {
    bridge()?.dismiss?.();
  } catch {
    /* as above */
  }
}
