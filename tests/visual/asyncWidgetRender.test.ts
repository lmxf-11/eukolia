// @vitest-environment jsdom
/**
 * The refresh that keeps the caret in step with an asynchronously rendered widget.
 *
 * Visual Mode typesets mathematics *after* the element that holds it exists, so
 * for a few frames the widget is an empty box and every position after it — and
 * the caret drawn for one — is measured against a gap. Measured in Chromium, a
 * caret logically after `$x^2+y$` was drawn 42 px to its left, inside the SVG,
 * until something made the editor look again.
 *
 * Two things about the refresh are worth pinning, and both are the kind of thing
 * that fails silently:
 *
 *  1. **The transaction must carry a selection.** A CodeMirror *layer* redraws
 *     only when `update.selectionSet` is true, and `selectionSet` is
 *     `transactions.some(tr => tr.selection)` — true for any transaction that
 *     carries one, the same one included. An effects-only transaction therefore
 *     redraws nothing at all, and the caret stays where the empty widget put it.
 *  2. **One refresh per render, not one per transaction.** The refresh is a
 *     transaction, a transaction runs the ported decoration field's update, and
 *     that update rebuilds widgets — which calls `updateDOM`, which renders and
 *     asks for another refresh. Without the guard this is an unbounded loop: the
 *     first version of the module froze the editor re-typesetting its
 *     mathematics for ever.
 *
 * jsdom performs no layout, so the widget's box never appears and the refresh
 * lands on its frame cap; that is fine, because what is asserted here is the
 * *shape* of the transaction and the guard, not the timing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState, StateEffect } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import {
  asyncWidgetRenderEffect,
  refreshAfterAsyncWidgetRender,
} from '@/vendor/overleaf/extensions/visual/async-widget-render'

let view: EditorView | null = null
let host: HTMLElement | null = null

const mount = (): EditorView => {
  host = document.createElement('div')
  document.body.appendChild(host)
  view = new EditorView({
    state: EditorState.create({ doc: 'Text with $x^2$ after.\n' }),
    parent: host,
  })
  return view
}

/** Runs every queued animation frame, which is how the refresh waits. */
const flushFrames = async (count = 14): Promise<void> => {
  for (let i = 0; i < count; i += 1) {
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
  }
}

afterEach(() => {
  view?.destroy()
  view = null
  host?.remove()
  host = null
  vi.restoreAllMocks()
})

describe('refreshing after an asynchronous widget render', () => {
  it('dispatches a transaction that carries the selection, so a layer redraws', async () => {
    const mounted = mount()
    const element = document.createElement('span')
    host?.appendChild(element)

    const transactions: Array<{ hasSelection: boolean; hasEffect: boolean }> = []
    const capture = EditorView.updateListener.of(update => {
      for (const transaction of update.transactions) {
        if (!transaction.effects.some(effect => effect.is(asyncWidgetRenderEffect))) continue
        transactions.push({
          // What a layer reads: `selectionSet` is
          // `transactions.some(tr => tr.selection)` — true for a transaction that
          // *carries* a selection, the same one included. An effects-only
          // transaction leaves the cursor layer's `update` false and the caret is
          // never redrawn.
          hasSelection: Boolean(transaction.selection),
          hasEffect: true,
        })
      }
    })
    mounted.dispatch({ effects: StateEffect.appendConfig.of(capture) })
    transactions.length = 0

    refreshAfterAsyncWidgetRender(mounted, element)
    await flushFrames()

    expect(transactions).toHaveLength(1)
    expect(
      transactions[0].hasSelection,
      'the refresh carried no selection, so no layer redraws and the caret stays put'
    ).toBe(true)
    // The selection it carries is the one already in force: nothing moves.
    expect(mounted.state.selection.main.anchor).toBe(0)
  })

  it('refreshes once per element, however many times a render reports back', async () => {
    const mounted = mount()
    let dispatches = 0
    const listener = EditorView.updateListener.of(update => {
      for (const transaction of update.transactions) {
        if (transaction.effects.some(effect => effect.is(asyncWidgetRenderEffect))) {
          dispatches += 1
        }
      }
    })
    mounted.dispatch({ effects: StateEffect.appendConfig.of(listener) })

    const element = document.createElement('span')
    host?.appendChild(element)

    // The same element reporting three times is one render asked about three
    // times — and a rebuild that hands back a new element is a new render.
    refreshAfterAsyncWidgetRender(mounted, element)
    refreshAfterAsyncWidgetRender(mounted, element)
    refreshAfterAsyncWidgetRender(mounted, element)
    await flushFrames(30)

    expect(dispatches).toBe(1)

    // A different element — a rebuilt widget — gets its own refresh.
    const rebuilt = document.createElement('span')
    host?.appendChild(rebuilt)
    refreshAfterAsyncWidgetRender(mounted, rebuilt)
    await flushFrames(30)

    expect(dispatches).toBe(2)
  })

  it('does nothing once the view has been destroyed', async () => {
    const mounted = mount()
    const element = document.createElement('span')
    host?.appendChild(element)

    mounted.destroy()
    view = null
    // The refresh runs from a promise continuation, so a document switch or a
    // mode rebuild can land in between. Dispatching to a destroyed view throws
    // from inside CodeMirror; this must not.
    expect(() => refreshAfterAsyncWidgetRender(mounted, element)).not.toThrow()
    await flushFrames()

    // And it is not rescued by the frame callback either.
    expect(() => refreshAfterAsyncWidgetRender(mounted, element)).not.toThrow()
  })

  it('coalesces every widget that becomes measurable together into one transaction', async () => {
    const mounted = mount()
    let dispatches = 0
    const listener = EditorView.updateListener.of(update => {
      for (const transaction of update.transactions) {
        if (transaction.effects.some(effect => effect.is(asyncWidgetRenderEffect))) {
          dispatches += 1
        }
      }
    })
    mounted.dispatch({ effects: StateEffect.appendConfig.of(listener) })

    const elements = Array.from({ length: 25 }, () => document.createElement('span'))
    for (const element of elements) host?.appendChild(element)

    // Twenty-five equations finishing in the same frame, which is what a scroll into a
    // dense passage does.
    for (const element of elements) refreshAfterAsyncWidgetRender(mounted, element)
    await flushFrames(30)

    expect(dispatches).toBe(1)

    // And a later batch is a second transaction, not a lost one: the coalescing is per
    // frame, not once for the life of the view.
    const later = document.createElement('span')
    host?.appendChild(later)
    refreshAfterAsyncWidgetRender(mounted, later)
    await flushFrames(30)

    expect(dispatches).toBe(2)
  })

  it('defers the redraw while the editor is being scrolled, and answers once it stops', async () => {
    /*
     * The fix for the scroll stutter, and the measurement that decided it — from
     * `scripts/probe-scroll.mjs` on `algebra.tex` (47 886 lines), dropping the refresh
     * transactions between two identical gestures and restoring them as a control:
     *
     *   | | p50 frame | blocking time in long frames |
     *   |---|---|---|
     *   | refreshes kept | 36.1 ms | 211 ms |
     *   | refreshes dropped | 12.1 ms | 22 ms |
     *   | kept again (control for order) | 14.4 ms | — |
     *
     * Ten times less render-blocking work. The same probe had already ruled out the
     * mathematics itself — removing every rendered equation from the DOM moves p50 by
     * 3 ms *in the wrong direction* — and the browser attributes `script 0 ms` to every
     * long frame. So the cost was this loop: ~90 whole view updates per gesture, one per
     * widget, for a caret nobody looks at while the page is moving.
     *
     * Two properties are load-bearing and both fail silently: a redraw must **not**
     * happen while the page is moving, and one must **still** happen after it stops —
     * otherwise the caret stays beside the gap an unrendered widget left, which is the
     * bug this whole file exists to prevent.
     */
    const mounted = mount()
    let dispatches = 0
    const listener = EditorView.updateListener.of(update => {
      for (const transaction of update.transactions) {
        if (transaction.effects.some(effect => effect.is(asyncWidgetRenderEffect))) {
          dispatches += 1
        }
      }
    })
    mounted.dispatch({ effects: StateEffect.appendConfig.of(listener) })

    const elements = Array.from({ length: 12 }, () => document.createElement('span'))
    for (const element of elements) host?.appendChild(element)

    // A wheel gesture, then the widgets finishing underneath it.
    mounted.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
    for (const element of elements) refreshAfterAsyncWidgetRender(mounted, element)
    await flushFrames(2)

    expect(dispatches, 'a redraw ran while the page was being scrolled').toBe(0)

    // The gesture stops. The requests made during it are still owed one redraw, and
    // nothing else will wake them.
    await new Promise(resolve => setTimeout(resolve, 220))
    await flushFrames(4)

    expect(dispatches, 'the deferred redraw never arrived, so the caret stays stale').toBe(1)
  })
})
