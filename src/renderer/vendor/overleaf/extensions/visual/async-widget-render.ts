/**
 * Telling the editor that an asynchronous widget has finished rendering.
 *
 * Visual Mode's mathematics is typeset by MathJax **after** the element that will
 * hold it exists. In the window between the two, the widget is an empty box: the
 * line is shorter than it will be, and every position after the widget — and the
 * caret drawn for one — is measured against a gap that is about to close. A
 * caret placed after an inline `$…$` while its SVG was still rendering was
 * therefore painted where the gap was, which is *inside* or to the left of the
 * mathematics, and it stayed there: nothing re-measured it.
 *
 * The port's own answer is `view.requestMeasure()`, which is right as far as it
 * goes and does not go far enough. `requestMeasure` re-runs the layout and
 * re-measures the document, and `coordsAtPos` then reports the correct
 * position — but the caret is not the document. It is drawn by a CodeMirror
 * *layer*, and a layer asks for a fresh measurement only when its own `update`
 * returns true or the update carried `geometryChanged`
 * (`LayerView.update` in `@codemirror/view`). A measurement that CodeMirror
 * schedules for itself, with no transaction behind it, is not that: the cursor
 * layer keeps the marker it built against the empty widget, and the caret stays
 * where the gap was until the user happens to move it.
 *
 * Dispatching a transaction is what closes the window, because it is the only
 * thing that runs the layers' `update` at all. The effect below is that
 * transaction's reason: it makes the rebuild explicit rather than incidental, so
 * the decoration field that owns the widget sees it too, and so a reader of the
 * dispatcher's logs can see why an empty transaction was sent.
 *
 * Deliberately not a `requestMeasure` *instead of* the dispatch: the measure is
 * still owed — the layout really did change — and CodeMirror does it as part of
 * the update the dispatch triggers.
 *
 * One consequence to be aware of, because it looks like a bug and is not: this
 * dispatch runs from a promise continuation, so it can land *after* the user has
 * destroyed the view (a document switch, a mode rebuild). `view.destroy()` leaves
 * every method in place, and dispatching to a destroyed view throws from deep
 * inside CodeMirror, so the caller checks `dom.isConnected` first — the same test
 * `skip-preamble-cursor.ts` uses for the same reason.
 */

import { StateEffect } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/**
 * "A widget finished rendering asynchronously"; carries no payload.
 *
 * An effect rather than a bare `dispatch({})` so the transaction has a stated
 * reason. State effects are usable without being mounted in the state — an
 * unmounted effect is simply ignored by the fields — so this needs no extension
 * to be attached anywhere for the dispatch to be legal.
 */
export const asyncWidgetRenderEffect = StateEffect.define<null>()

/** How many frames to keep checking for the reflow before giving up. */
const MAX_FRAMES = 10

/**
 * Widget elements that have already been refreshed for their current render.
 *
 * Weak so a discarded widget — every decoration rebuild makes new ones — does not
 * keep its element alive.
 */
const refreshing = new WeakSet<HTMLElement>()

/**
 * Redraws the editor's layers once an asynchronously filled widget has a box.
 *
 * Waits for the *widget itself* to be laid out, which is the only signal that
 * works. The document's height is not one: an inline widget growing from nothing
 * to 41 px does not change the height of a document that has other lines in it —
 * measured, the first version of this used `view.contentHeight` and the loop
 * simply ran out its frames while the line re-laid-out underneath it.
 *
 * Safe to call from any promise continuation: a view that is no longer in the
 * document is left alone, and each frame re-checks, because a document switch or
 * a mode rebuild can destroy the view in between. The loop is bounded, because a
 * render that fails leaves an element that will never lay out, and that must not
 * keep the editor redrawing for ever.
 */
export function refreshAfterAsyncWidgetRender(
  view: EditorView,
  element: HTMLElement
): void {
  if (!view.dom.isConnected) return

  // One refresh per render, and that guard is load-bearing rather than an
  // optimisation. The refresh is a transaction, a transaction runs the ported
  // decoration field's update, and that update rebuilds the widgets — which calls
  // `updateDOM`, which renders again and asks for another refresh. Without this
  // the editor re-typesets its mathematics for ever: measured, the first version
  // of this file drove `MathWidget.updateDOM` in an unbounded loop and froze the
  // page. The element is the right key because a fresh render gets a fresh
  // element (a rebuilt widget is a new `toDOM`), while an in-place re-render is
  // the same one and has nothing new to measure.
  if (refreshing.has(element)) return
  refreshing.add(element)

  let attempts = 0

  const dispatchRefresh = () => {
    view.dispatch({
      selection: view.state.selection,
      effects: asyncWidgetRenderEffect.of(null),
    })
  }

  const step = () => {
    if (!view.dom.isConnected) return

    // Width, not height: width is what `replaceChildren` changes for an inline
    // widget, and it is what every position after the widget depends on.
    const laidOut = element.getBoundingClientRect().width > 0
    if (laidOut || attempts >= MAX_FRAMES) {
      // The selection is re-stated unchanged, and that is the point rather than an
      // oversight: a layer re-measures when `update.selectionSet` is true, and
      // `selectionSet` is `transactions.some(tr => tr.selection)` — true for any
      // transaction that *carries* a selection, the same one included. An
      // effects-only transaction leaves every layer's `update` false, so the caret
      // is never redrawn and the refresh does nothing at all: measured, the caret
      // stayed 41 px left of the mathematics for as long as the editor was left
      // alone.
      dispatchRefresh()
      return
    }

    attempts += 1
    requestAnimationFrame(step)
  }

  requestAnimationFrame(step)
}
