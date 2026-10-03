/**
 * Eukolia — switching between Code Mode and Visual Mode.
 *
 * One `EditorView` serves both modes: everything that differs between them is
 * mounted through a compartment (the ported `visual()` set, and every extension
 * wrapped in `visualOnly` / `sourceOnly`), so a mode switch is a transaction, not
 * a rebuild. The `EditorState`, the document, the selection and the viewport
 * element all survive it — which is why the caret and the document are simply
 * still there, with nothing captured and nothing restored.
 *
 * The *viewport* is the one thing that needs holding. CodeMirror keeps a scroll
 * anchor line across a re-layout by itself (`measure()` in `@codemirror/view`
 * adjusts `scrollTop` by the anchor line's change in position), and that is
 * normally enough. When the viewport is scrolled away from the caret it is not:
 * the adjustment is computed against heights that are still arriving, so it can
 * aim past the end of the re-laid-out content and let the browser clamp the
 * result — which leaves the viewport at the end of the document, next to the
 * caret, instead of on the line the user was reading. Measured in the running
 * application: a request for 389 px in a 381 px scroll range.
 *
 * ## What is held, and why it is the caret's line
 *
 * The two modes lay the same source out at different heights — a rendered
 * figure or a collapsed environment is taller than its source, a paragraph is
 * shorter — so "the same top line" and "the same place on screen" are genuinely
 * different targets, and they cannot both be met. The one the user reads by is
 * the second: the caret's line should still sit where it sat, **relative to the
 * viewport** (a third of the way down is still a third of the way down), not at
 * the same distance from a top line that has moved.
 *
 * So the position travels as the caret line's viewport fraction, and it is
 * re-applied through CodeMirror's own mechanism for exactly this:
 * `EditorView.scrollSnapshot()`, whose `isSnapshot` scroll target is resolved
 * from **line geometry** inside the measure that follows the reconfiguration
 * (`ViewState.scrollIntoView` → `DocView.scrollIntoView`), so it needs no
 * rendered coordinates and is applied after the DOM has been re-rendered. That
 * also makes it immune to the browser scrolling the caret into view mid-render,
 * which is the other way this position can be taken.
 *
 * `ScrollTarget` is not exported by `@codemirror/view`, so the library's own
 * snapshot is taken and its two fields are replaced: the anchor becomes the
 * caret's line and the margin becomes `caretMargin(fraction, height)` (a pixel
 * value the two modes share, because the viewport element — and therefore its
 * height — is the same before and after). That is a deliberate, recorded
 * dependency on a class the library owns, and it is what keeps the switch to
 * **one** write of `scrollTop`: a `requestMeasure` write would leave the view's
 * scroll anchor stale, and the anchoring that runs after it would write the
 * same position a second time.
 *
 * The target can be past the end of the scroller, exactly as CodeMirror's own
 * top-line snapshot can be (`ARCHITECTURE.md` records that overshoot: 389 px in
 * a 381 px range). The browser clamps the scroll offset, and that clamp can only
 * move the viewport *towards* the document end, so the caret line's top stays
 * between the viewport's top and bottom for every fraction in `[0, 1]`.
 *
 * This is safe *because* a mode switch changes neither the document nor the
 * state: the offsets the snapshot carries still mean what they meant when it was
 * taken. A rebuild — another document, a setting that shapes the editor — cannot
 * use it for the same reason in reverse, and restores a line-based position
 * instead (`scrollRestore.ts`).
 */

import { EditorSelection, type StateEffect } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { isVisual, setVisualMode } from './editorExtensions'

/** Where the caret's line sat in the viewport: `0` at the top, `1` at the bottom. */
export interface CaretViewport {
  /** The caret's character offset when the position was taken, for the record. */
  offset: number
  /** The caret line's top, as a fraction of the viewport height. */
  fraction: number
}

/** A caret at the very top when a viewport has no measurable height yet. */
export const DEFAULT_CARET_FRACTION = 0.5

/** A viewport fraction, clamped into the viewport; a non-number reads as the middle. */
export function clampCaretFraction(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CARET_FRACTION
  return Math.min(1, Math.max(0, value))
}

/**
 * The margin the scroll target carries: how far below the viewport top the
 * caret line's top belongs, in pixels.
 *
 * Pure, so the arithmetic that decides where the caret lands is testable without
 * a layout. Together with the browser's clamp of the scroll offset into the
 * scroller's range, it is what keeps the caret line on screen whatever fraction
 * was carried over — see the test for the property, and the note at the top of
 * this module for why the clamp is the browser's: it is the browser's for
 * CodeMirror's own scroll snapshot too, which can likewise ask for a position
 * past the end of the content.
 */
export function caretMargin(fraction: number, viewportHeight: number): number {
  const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0
  return clampCaretFraction(fraction) * height
}

/**
 * The caret line's position in the viewport, or `null` when the view has no
 * measurable height — a view that has never been laid out has no viewport to
 * hold, and a fraction of zero height would be meaningless.
 */
export function captureCaretViewport(view: EditorView): CaretViewport | null {
  const height = view.scrollDOM.clientHeight
  if (!(height > 0)) return null

  const offset = view.state.selection.main.head
  const topInViewport = view.lineBlockAt(offset).top - view.scrollDOM.scrollTop
  return { offset, fraction: clampCaretFraction(topInViewport / height) }
}

/** The shape of the scroll target the library's snapshot carries. */
interface SnapshotTarget {
  /** A `SelectionRange`, as `EditorView.scrollSnapshot()` puts in it. */
  range: { head: number }
  yMargin: number
}

/**
 * A scroll snapshot anchored on the caret's line, `fraction` of the viewport
 * down from the top. See the note at the top of this module for why the
 * library's own snapshot is re-pointed rather than a target built from scratch.
 *
 * The anchor is the offset the fraction was measured from, not the live caret:
 * the two are the same position — a reconfiguration does not move the selection —
 * and taking both from one measurement is what keeps the pair consistent.
 */
function caretScrollSnapshot(
  view: EditorView,
  held: CaretViewport
): StateEffect<unknown> {
  const snapshot = view.scrollSnapshot()
  const target = (snapshot as unknown as { value: SnapshotTarget }).value
  target.range = EditorSelection.cursor(held.offset)
  target.yMargin = caretMargin(held.fraction, view.scrollDOM.clientHeight)
  return snapshot as StateEffect<unknown>
}

/**
 * Switches the editor to `showVisual` (or to source mode), holding the caret
 * line's position in the viewport across the re-layout. Returns whether it
 * changed anything: an editor already in the requested mode is left alone, so a
 * redundant call cannot disturb it.
 */
export function switchEditorMode(view: EditorView, showVisual: boolean): boolean {
  if (isVisual(view) === showVisual) return false

  // Taken before the reconfiguration, from the layout the user is looking at.
  const held = captureCaretViewport(view)

  view.dispatch(setVisualMode(showVisual))

  // Re-applied after it, resolved inside the measure that follows — the caret's
  // line is found again by geometry, so it does not matter that the new layout
  // has not been painted yet.
  if (held) view.dispatch({ effects: caretScrollSnapshot(view, held) })
  return true
}
