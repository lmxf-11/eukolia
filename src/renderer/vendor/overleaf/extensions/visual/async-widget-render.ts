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
 * Eukolia: the refresh is **deferred while the editor is being driven**.
 *
 * This is the fix for the scroll stutter, and it is the third attempt at this file, so
 * the measurements that decided it are worth stating exactly. `scripts/probe-scroll.mjs`
 * on `algebra.tex` (47 886 lines, 32 325 inline equations), dropping the refresh
 * transactions between two identical gestures and then restoring them as a control:
 *
 *   | | p50 frame | blocking time in long frames |
 *   |---|---|---|
 *   | refreshes kept | 36.1 ms | **211 ms** |
 *   | refreshes dropped | 12.1 ms | **22 ms** |
 *   | kept again (control for order) | 14.4 ms | — |
 *
 * **Ten times less render-blocking work**, with the control ruling out warm-up drift. The
 * same probe had already ruled out the two things that looked more likely: removing every
 * rendered equation from the DOM changes p50 by 3 ms *in the wrong direction*, and the
 * browser attributes `script 0 ms` to every long frame — the mathematics and this
 * editor's JavaScript are both innocent, and the cost is the ~90 full view updates a
 * gesture was paying for one widget each.
 *
 * A refresh exists so CodeMirror's *layers* re-measure after a widget fills in, which is
 * what keeps the caret beside the mathematics instead of inside the gap it used to be.
 * Nothing about that is urgent: it is a correctness fix for a caret nobody is looking at
 * while the page is moving. So a request that arrives while the editor is being scrolled,
 * typed into or dragged waits until the driving stops, and then every widget that asked
 * is answered by **one** transaction.
 *
 * The alternative — the same dispatch, just coalesced per widget-class or per frame —
 * was tried and does not help: the renderings arrive one per frame as MathJax finishes,
 * so there was never more than one to coalesce and the count stayed at ~90.
 *
 * An idle editor still refreshes immediately, so the caret is never left stale; the
 * quiet window is short enough that a scroll feels continuous and long enough to cover
 * a wheel gesture's frames.
 */
const BUSY_WINDOW_MS = 120

/**
 * The longest a redraw may be deferred, however continuously the editor is driven.
 *
 * Without this the deferral is unbounded in one direction that matters: a reader holding
 * a scroll key, or dragging a scrollbar, keeps the view "busy" for as long as they like,
 * and the caret would stay beside the gap an unrendered widget left for the whole of it.
 * Half a second is long enough that a gesture pays a handful of redraws rather than
 * ninety, and short enough that the caret is never visibly wrong for long.
 */
const MAX_DEFERRAL_MS = 500

/** Views with a refresh owed, and the views being driven right now. */
const pendingRefresh = new Set<EditorView>()
const busyUntil = new WeakMap<EditorView, number>()
/** When the oldest outstanding request arrived, for the deferral cap above. */
const oldestRequest = new WeakMap<EditorView, number>()

/**
 * "The user is driving this view", called from the listeners installed below.
 *
 * `performance.now()`, not `Date.now()`: the comparison is against frame timings from the
 * same clock, and a wall-clock jump (an NTP step, a laptop waking) would otherwise leave
 * the editor believing it was busy for minutes.
 */
const markBusy = (view: EditorView): void => {
  busyUntil.set(view, performance.now() + BUSY_WINDOW_MS)
  /*
   * **Measured, and not applied: hiding the mathematics while scrolling makes it worse.**
   *
   * The reasoning was that on `algebra.tex` a 60-step gesture spends ~1 286 ms of 1 331 ms
   * in time no counter can attribute — `script 0 ms` in every long frame — and the viewport's
   * 1 066 elements are ~950 inside 37 equation widgets, so the cost is the browser's layout
   * and paint of MathJax's SVG structure, which a moving page cannot be reading anyway. The
   * attribute below was set on that basis, with a rule in `visual-editor.css` hiding the SVG
   * and leaving every box's geometry alone.
   *
   * A/B from one build, three passes, line 21 000 of `algebra.tex`:
   *
   *   | | p50 | p90 | max | frames over 33 ms |
   *   |---|---|---|---|---|
   *   | artwork hidden while scrolling | 9.5 ms | 54.1 ms | 177.3 ms | 12.3 |
   *   | untouched | **7.3 ms** | **32.4 ms** | 134.3 ms | **5.3** |
   *
   * Worse on every measure. This is the third time this project has found the same thing
   * (§3.31 hid every SVG, §3.33.1 removed every rendered equation): flipping `visibility` on
   * a thousand elements mid-gesture is itself a style recalculation, and it invalidates more
   * than it saves.
   *
   * `EUKOLIA_NO_SCROLL_HIDE` is the other half of the switch and defaults to *on*, so the
   * attribute is not set and the stylesheet rule is not present to act on it. Both are kept
   * because a rejected experiment that cannot be re-run is a claim, not a result.
   */
  if (!(globalThis as unknown as { __eukoliaScrollHide?: boolean }).__eukoliaScrollHide) return
  view.dom.setAttribute('data-eukolia-scrolling', 'on')
  scheduleIdleMark(view)
}

/**
 * Takes the attribute away once the driving stops.
 *
 * A timer on the same window as `markBusy`'s clock rather than a listener per event: the
 * window is already the definition of "busy", so there is nothing else to track, and the
 * attribute is removed on the first check after the window closes. One timer per gesture,
 * cleared as it fires, so an idle editor runs nothing.
 */
const idleTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>()

const scheduleIdleMark = (view: EditorView): void => {
  if (idleTimers.has(view)) return
  const timer = setTimeout(function check() {
    if (isBusy(view)) {
      idleTimers.set(view, setTimeout(check, BUSY_WINDOW_MS))
      return
    }
    idleTimers.delete(view)
    if (view.dom.isConnected) view.dom.removeAttribute('data-eukolia-scrolling')
  }, BUSY_WINDOW_MS)
  idleTimers.set(view, timer)
}

const isBusy = (view: EditorView): boolean =>
  (busyUntil.get(view) ?? 0) > performance.now()

/**
 * Whether a redraw may wait, which is the deferral rule in one place.
 *
 * Two ways to stop waiting: the driving stopped, or the request has been outstanding
 * longer than {@link MAX_DEFERRAL_MS}. The second is what makes the first safe to state
 * so simply — a reader who never stops scrolling still gets the caret corrected.
 */
const mayDefer = (view: EditorView): boolean => {
  if (!isBusy(view)) return false
  const since = oldestRequest.get(view)
  return since === undefined || performance.now() - since < MAX_DEFERRAL_MS
}

/**
 * Installed once per view, on the events that mean "the user is moving through the
 * document". Capture phase, because the editor's own handlers stop propagation for
 * several of them and a refresh that stops being scheduled is a caret that stays wrong.
 */
const watched = new WeakSet<EditorView>()

const watchInput = (view: EditorView): void => {
  if (watched.has(view)) return
  watched.add(view)
  for (const event of ['wheel', 'scroll', 'keydown', 'pointerdown'] as const) {
    // `scroll` does not bubble, so it is watched on the scroller rather than the editor.
    const target = event === 'scroll' ? view.scrollDOM : view.dom
    target.addEventListener(event, () => markBusy(view), { capture: true, passive: true })
  }
}

const flushRefresh = (view: EditorView): void => {
  pendingRefresh.delete(view)
  oldestRequest.delete(view)
  if (!view.dom.isConnected) return
  /*
   * The selection is re-stated unchanged, and that is the point rather than an
   * oversight: a layer re-measures when `update.selectionSet` is true, and
   * `selectionSet` is `transactions.some(tr => tr.selection)` — true for any transaction
   * that *carries* a selection, the same one included. An effects-only transaction
   * leaves every layer's `update` false, so the caret is never redrawn and the refresh
   * does nothing at all: measured, the caret stayed 41 px left of the mathematics for as
   * long as the editor was left alone.
   */
  view.dispatch({
    selection: view.state.selection,
    effects: asyncWidgetRenderEffect.of(null),
  })
}

const requestRefresh = (view: EditorView): void => {
  watchInput(view)
  if (!pendingRefresh.has(view)) {
    pendingRefresh.add(view)
    oldestRequest.set(view, performance.now())
  }
  scheduleSettle(view)
  if (mayDefer(view)) return

  queueMicrotask(() => {
    if (!pendingRefresh.has(view)) return
    // Busy by the time the microtask ran: wait for the settle instead.
    if (mayDefer(view)) return
    flushRefresh(view)
  })
}

/**
 * The settle that answers every deferred request.
 *
 * A polling check rather than a timer per request, because the deferrals are open-ended:
 * a wheel gesture lasts as long as the user's hand does, and each request that arrived
 * during it must be answered once, at the end. Cheap — one timer per quiet period, and
 * it stops as soon as the view is idle and nothing is pending.
 */
const settleTimers = new WeakMap<EditorView, ReturnType<typeof setInterval>>()

const scheduleSettle = (view: EditorView): void => {
  if (settleTimers.has(view)) return
  const timer = setInterval(() => {
    if (!pendingRefresh.has(view)) {
      clearInterval(timer)
      settleTimers.delete(view)
      return
    }
    if (mayDefer(view)) return
    if (!view.dom.isConnected) {
      pendingRefresh.delete(view)
      oldestRequest.delete(view)
    } else {
      flushRefresh(view)
    }
    clearInterval(timer)
    settleTimers.delete(view)
  }, BUSY_WINDOW_MS)
  settleTimers.set(view, timer)
}

/**
 * Redraws the editor's layers once asynchronously filled widgets have a box.
 *
 * Waits for the *widget itself* to be laid out, which is the only signal that works.
 * The document's height is not one: an inline widget growing from nothing to 41 px does
 * not change the height of a document that has other lines in it — measured, the first
 * version of this used `view.contentHeight` and the loop simply ran out its frames while
 * the line re-laid-out underneath it.
 *
 * Safe to call from any promise continuation: a view that is no longer in the document
 * is left alone, and each frame re-checks, because a document switch or a mode rebuild
 * can destroy the view in between. The loop is bounded, because a render that fails
 * leaves an element that will never lay out, and that must not keep the editor
 * redrawing for ever.
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

  const step = () => {
    if (!view.dom.isConnected) return

    // Width, not height: width is what `replaceChildren` changes for an inline
    // widget, and it is what every position after the widget depends on.
    const laidOut = element.getBoundingClientRect().width > 0
    if (laidOut || attempts >= MAX_FRAMES) {
      requestRefresh(view)
      // And whatever happens to *this* request, the view owes itself a refresh once
      // the driving stops: a request deferred during a scroll has no other waker.
      scheduleSettle(view)
      return
    }

    attempts += 1
    requestAnimationFrame(step)
  }

  requestAnimationFrame(step)
}
