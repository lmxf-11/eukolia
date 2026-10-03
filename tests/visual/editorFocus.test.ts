// @vitest-environment jsdom
/**
 * The editor's own focus reports — what `files.autoSave: "onFocusChange"` saves on.
 *
 * The mode is only as good as this signal: if the editor never says it lost
 * focus, the buffer is never written, and if it says so when it did not, a write
 * happens for nothing. So the three cases are pinned on the real host component
 * with a live CodeMirror view: focus kept, focus lost, and the surface going away
 * while it held focus.
 *
 * jsdom is why `document.hasFocus` is stubbed below. CodeMirror decides whether
 * it holds focus with `document.hasFocus() && activeElement === contentDOM`, and
 * jsdom reports `false` for the first part unconditionally — with the stub, the
 * editor behaves here the way it does in a real window.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { EditorView } from '@codemirror/view'
import type { EditorHandle } from '@/editor/editorHandle'

// jsdom performs no layout, and CodeMirror measures text through client rects.
const rect = {
  top: 0,
  left: 0,
  bottom: 16,
  right: 100,
  width: 100,
  height: 16,
  x: 0,
  y: 0,
  toJSON: () => ({})
}
const rectList = [rect] as unknown as DOMRectList
Range.prototype.getClientRects = () => rectList
Range.prototype.getBoundingClientRect = () => rect as DOMRect
Element.prototype.getClientRects = () => rectList

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// React's `act` refuses to flush effects unless it is told it is driving a test.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let HostComponent: React.ComponentType<Record<string, unknown>>
let handleRef: React.MutableRefObject<EditorHandle | null>
/** Every report the host made, in order. */
let reports: boolean[]
/** The path the host renders, changed by the rebuild test. */
let filePath: string
let mounted: { root: Root; host: HTMLElement } | null = null

const render = async (): Promise<void> => {
  if (!mounted) throw new Error('nothing is mounted')
  await act(async () => {
    mounted!.root.render(
      React.createElement(HostComponent, {
        getText: () => 'Hello world.',
        applyChange: () => undefined,
        filePath,
        theme: 'light',
        startVisual: false,
        handleRef,
        onFocusChange: (focused: boolean) => reports.push(focused)
      })
    )
  })
}

/** Mounts the host and answers with the view behind its handle. */
const mountEditor = async (): Promise<EditorView> => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  handleRef = { current: null }
  reports = []
  filePath = 'D:/project/homework.tex'
  mounted = { root: createRoot(host), host }
  await render()
  for (let attempt = 0; attempt < 40 && !handleRef.current; attempt++) await wait(25)
  const view = handleRef.current?.getEditor() as EditorView | null
  if (!view) throw new Error('the editor did not publish a view')
  return view
}

const unmountEditor = async (): Promise<void> => {
  if (!mounted) return
  const current = mounted
  mounted = null
  await act(async () => {
    current.root.unmount()
  })
  current.host.remove()
}

/** Puts focus on the editor and waits out CodeMirror's focus-change timer. */
const focusEditor = async (view: EditorView): Promise<void> => {
  await act(async () => {
    view.focus()
  })
  await wait(40)
}

beforeAll(async () => {
  const { VisualEditor } = await import('@/visual/VisualEditor')
  HostComponent = VisualEditor as unknown as React.ComponentType<Record<string, unknown>>
}, 60000)

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(async () => {
  await unmountEditor()
  vi.restoreAllMocks()
})

describe('the editor reporting its own focus', () => {
  it('reports gaining focus, and losing it', async () => {
    const view = await mountEditor()

    await focusEditor(view)
    expect(reports).toEqual([true])

    await act(async () => {
      view.contentDOM.blur()
    })
    await wait(40)

    // The loss is what the autosave listens for; the gain is reported so both
    // directions of the same signal are visible to a host.
    expect(reports).toEqual([true, false])
  })

  it('reports a loss when the surface goes away while it held focus', async () => {
    const view = await mountEditor()
    await focusEditor(view)
    expect(reports).toEqual([true])

    // Nothing blurs the editor here: the whole surface is removed from under it,
    // which is what opening the settings pane from the keyboard does.
    await act(async () => {
      mounted!.root.unmount()
    })
    mounted = null

    expect(reports).toEqual([true, false])
  })

  it('does not report a loss for a rebuild that carries the focus across', async () => {
    const view = await mountEditor()
    await focusEditor(view)

    // A rebuild (a different document) destroys the view and builds another; the
    // focus is handed to the new one rather than dropped, so there is nothing to
    // save and no loss to report.
    filePath = 'D:/project/chapter2.tex'
    await render()
    await wait(40)

    const rebuilt = handleRef.current?.getEditor() as EditorView | null
    expect(rebuilt).not.toBe(view)
    expect(reports).not.toContain(false)
  })
})
