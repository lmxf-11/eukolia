// @vitest-environment jsdom
/**
 * The caret line's place in the viewport, held across a mode switch.
 *
 * Code Mode and Visual Mode lay the same source out at different heights, so
 * "the same top line" and "the same place on screen" are different targets and
 * cannot both be met. The user's requirement is the second one: a caret line a
 * third of the way down the viewport in Code Mode must still be about a third of
 * the way down in Visual Mode.
 *
 * What travels is a *fraction*, and what is applied is a *margin* — how far
 * below the viewport top the caret line belongs, in pixels. Both are pure
 * functions of numbers the switch has before it changes anything, so they are
 * tested here without a layout; `modeSwitch.test.ts` covers the switch that
 * uses them, and the end-to-end probe measures the fraction before and after a
 * real switch in a real window.
 *
 * The clamp of the scroll offset into the scroller's range is the browser's, not
 * this module's — CodeMirror's own scroll snapshot relies on it in the same way,
 * and `ARCHITECTURE.md` records that it can ask for 389 px in a 381 px range.
 * The property test below therefore clamps exactly as the browser does, which is
 * what makes "the caret can never be scrolled off screen" checkable.
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CARET_FRACTION,
  caretMargin,
  clampCaretFraction,
} from '@/visual/modeSwitch'

describe('the caret line’s viewport fraction', () => {
  it('clamps a fraction into the viewport', () => {
    expect(clampCaretFraction(0)).toBe(0)
    expect(clampCaretFraction(1)).toBe(1)
    expect(clampCaretFraction(0.33)).toBeCloseTo(0.33)
    expect(clampCaretFraction(-2)).toBe(0)
    expect(clampCaretFraction(4)).toBe(1)
  })

  it('reads a value it cannot use as the middle of the viewport', () => {
    // A fraction can only come out of a division by a viewport height, which the
    // capture guards against; these are the belt-and-braces cases.
    expect(clampCaretFraction(Number.NaN)).toBe(DEFAULT_CARET_FRACTION)
    expect(clampCaretFraction(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CARET_FRACTION)
  })
})

describe('the margin the scroll target carries', () => {
  it('is the fraction of the viewport the caret line sat at', () => {
    expect(caretMargin(0, 600)).toBe(0)
    expect(caretMargin(1, 600)).toBe(600)
    expect(caretMargin(1 / 3, 600)).toBeCloseTo(200)
  })

  it('is clamped into the viewport and survives a fraction it cannot use', () => {
    expect(caretMargin(-1, 600)).toBe(0)
    expect(caretMargin(9, 600)).toBe(600)
    expect(caretMargin(Number.NaN, 600)).toBe(DEFAULT_CARET_FRACTION * 600)
    // A pane that has not been laid out has no margin to ask for.
    expect(caretMargin(0.5, 0)).toBe(0)
    expect(caretMargin(0.5, Number.NaN)).toBe(0)
  })

  it('never puts the caret line off screen, whatever the viewport does', () => {
    // Realistic inputs: a document of `documentHeight` pixels, a viewport of
    // `viewport` pixels, and a scroller that can therefore move by
    // `documentHeight - viewport`. The caret line can be anywhere inside it.
    const viewport = 480
    for (const documentHeight of [200, 480, 1000, 20_000, 25_000]) {
      const maxScrollTop = Math.max(0, documentHeight - viewport)
      for (const fraction of [0, 0.1, 0.33, 0.5, 0.9, 1]) {
        for (const caretTop of [
          0,
          37,
          documentHeight / 2,
          Math.max(0, documentHeight - 1),
        ]) {
          const margin = caretMargin(fraction, viewport)
          // The browser clamps the requested offset into the scroller's range.
          const requested = caretTop - margin
          const scrollTop = Math.min(Math.max(0, requested), maxScrollTop)
          const topInViewport = caretTop - scrollTop
          expect(topInViewport).toBeGreaterThanOrEqual(-0.001)
          expect(topInViewport).toBeLessThanOrEqual(viewport + 0.001)
        }
      }
    }
  })
})
