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
})
