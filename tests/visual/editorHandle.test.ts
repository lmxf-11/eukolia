// @vitest-environment jsdom
/**
 * The one editor's imperative handle, and the position guarantee across a mode
 * switch.
 *
 * `AppState.editorHandleRef` is how the application drives the editor — the
 * breadcrumbs, SyncTeX, the command registry and the VS Code host bridge never
 * touch the component. This file mounts the real host component, then exercises
 * every method of the contract in `src/renderer/editor/editorHandle.ts` against
 * the live CodeMirror view, including the clamping the contract promises for
 * out-of-range input.
 *
 * The last two tests cover what the whole change was for: Code Mode and Visual
 * Mode are one editor, so switching between them keeps the caret, and the handle
 * keeps answering for the rebuilt view without the application being told.
 *
 * jsdom performs no layout, so nothing here asserts on pixels: scroll calls are
 * asserted to be answered and to not throw, and CodeMirror measures text through
 * the client-rect stubs below.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { EditorView } from '@codemirror/view'
import type { EditorHandle } from '@/editor/editorHandle'
import { settingsManager } from '@/core/settings'

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
  toJSON: () => ({}),
}
const rectList = [rect] as unknown as DOMRectList
Range.prototype.getClientRects = () => rectList
Range.prototype.getBoundingClientRect = () => rect as DOMRect
Element.prototype.getClientRects = () => rectList

const DOC = [
  '\\section{Introduction}',
  '',
  'Hello world.',
  '',
  '\\begin{align}',
  'a &= b \\\\',
  'cc &= d',
  '\\end{align}',
  '',
].join('\n')

const ALIGN_START = DOC.indexOf('\\begin{align}')
const ALIGN_END = DOC.indexOf('\\end{align}')

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// React's `act` refuses to flush effects unless it is told it is driving a test.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let handleRef: React.MutableRefObject<EditorHandle | null>
let HostComponent: React.ComponentType<Record<string, unknown>>
/** The document the host is believed to hold, updated by `applyChange`. */
let text = DOC
/** The mode the host is told to show, flipped by the mode-switch test. */
let startVisual = false
/** Number of times the host reported an edit, for the insert/wrap tests. */
let reportedChanges = 0

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(
      React.createElement(HostComponent, {
        getText: () => text,
        applyChange: (change: { from: number; to: number; insert: string }) => {
          text = text.slice(0, change.from) + change.insert + text.slice(change.to)
          reportedChanges += 1
        },
        filePath: 'D:/project/homework.tex',
        theme: 'light',
        startVisual,
        handleRef,
      })
    )
  })
}

const handle = (): EditorHandle => {
  const current = handleRef.current
  if (!current) throw new Error('the editor did not publish a handle')
  return current
}

const view = (): EditorView => {
  const editor = handle().getEditor() as EditorView | null
  if (!editor) throw new Error('the handle has no editor')
  return editor
}

/** The caret offset, read back through the contract. */
const caret = (): number => handle().getCursorOffset() as number

beforeAll(async () => {
  const { VisualEditor } = await import('@/visual/VisualEditor')
  HostComponent = VisualEditor as unknown as React.ComponentType<
    Record<string, unknown>
  >
  handleRef = { current: null }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)

  await render()
  // The host builds its CodeMirror view in an effect, then reports the caret.
  for (let attempt = 0; attempt < 40 && !handleRef.current; attempt++) {
    await wait(25)
  }
}, 60000)

afterAll(async () => {
  await act(async () => {
    root.unmount()
  })
  host.remove()
})

describe('the editor handle', () => {
  it('is published with the live CodeMirror view behind it', () => {
    expect(handleRef.current).not.toBeNull()
    expect(view().state.doc.toString()).toBe(DOC)
  })

  it('reports and restores the selection as character offsets', () => {
    handle().setSelectionOffsets(4, 15)
    expect(handle().getSelectionOffsets()).toEqual({
      from: 4,
      to: 15,
      anchor: 4,
      head: 15,
    })

    // A backwards selection keeps its direction, as CodeMirror reports it.
    handle().setSelectionOffsets(15, 4)
    expect(handle().getSelectionOffsets()).toEqual({
      from: 4,
      to: 15,
      anchor: 15,
      head: 4,
    })
    expect(caret()).toBe(4)
  })

  it('reveals a 1-based line/column, and a raw offset', () => {
    handle().revealPosition(3, 3)
    const thirdLine = view().state.doc.line(3)
    expect(caret()).toBe(thirdLine.from + 2)

    handle().revealOffset(ALIGN_END + 1)
    expect(caret()).toBe(ALIGN_END + 1)
  })

  it('clamps positions that are outside the document instead of throwing', () => {
    handle().revealPosition(10_000, 10_000)
    expect(caret()).toBe(DOC.length)

    handle().revealPosition(-5, -5)
    expect(caret()).toBe(0)

    handle().revealOffset(-100)
    expect(caret()).toBe(0)

    handle().revealOffset(DOC.length + 100)
    expect(caret()).toBe(DOC.length)

    handle().setSelectionOffsets(-20, DOC.length + 20)
    expect(handle().getSelectionOffsets()).toEqual({
      from: 0,
      to: DOC.length,
      anchor: 0,
      head: DOC.length,
    })
  })

  it('answers the scroll calls without needing a laid-out scroller', () => {
    expect(typeof handle().getScrollTop()).toBe('number')
    expect(() => handle().setScrollTop(120)).not.toThrow()
  })

  it('inserts text at the caret, replacing the selection', () => {
    handle().setSelectionOffsets(0, 5)
    const before = text
    handle().insertText('REPLACED')

    expect(reportedChanges).toBeGreaterThan(0)
    expect(text.startsWith('REPLACED')).toBe(true)
    expect(text).toBe(`REPLACED${before.slice(5)}`)
    // The caret follows the insertion.
    expect(caret()).toBe('REPLACED'.length)
  })

  it('wraps the selection, and selects the placeholder when there is none', () => {
    handle().setSelectionOffsets(0, 'REPLACED'.length)
    handle().wrapSelection('\\textbf{', '}', 'text')
    expect(text.startsWith('\\textbf{REPLACED}')).toBe(true)
    // A wrapped selection leaves the caret after the closing delimiter.
    expect(caret()).toBe('\\textbf{REPLACED}'.length)

    // With nothing selected the placeholder is inserted and left selected.
    handle().setSelectionOffsets(0, 0)
    handle().wrapSelection('\\emph{', '}', 'here')
    expect(text.startsWith('\\emph{here}')).toBe(true)
    expect(handle().getSelectionOffsets()).toEqual({
      from: '\\emph{'.length,
      to: '\\emph{here'.length,
      anchor: '\\emph{'.length,
      head: '\\emph{here'.length,
    })
  })

  it('aligns ampersands with Eukolia’s own aligner', async () => {
    // Put the document back to the fixture, then align it.
    handle().setSelectionOffsets(0, text.length)
    handle().insertText(DOC)

    const before = text
    handle().alignAmpersands('document')

    const aligned = view().state.doc.toString()
    expect(aligned).not.toBe(before)
    // Both ampersands of the `align` environment share a column. The aligner
    // pads the ampersand itself, so the lines read `a  & = b` afterwards.
    const columns = aligned
      .split('\n')
      .filter(line => line.includes('&'))
      .map(line => line.indexOf('&'))
    expect(columns).toHaveLength(2)
    expect(columns[0]).toBe(columns[1])

    // `scope: 'selection'` only touches environments the selection covers.
    handle().setSelectionOffsets(0, view().state.doc.length)
    handle().insertText(DOC)
    const untouched = text
    expect(untouched).toBe(DOC)

    handle().setSelectionOffsets(0, 8)
    handle().alignAmpersands('selection')
    expect(view().state.doc.toString()).toBe(untouched)

    // ...and aligns when the selection does cover the environment.
    handle().setSelectionOffsets(
      ALIGN_START,
      ALIGN_END + '\\end{align}'.length
    )
    handle().alignAmpersands('selection')
    expect(view().state.doc.toString()).not.toBe(untouched)
  })
})

describe('one editor, two modes', () => {
  it('switches mode on the same view, and keeps the caret', async () => {
    const { isVisual } = await import('@/visual/editorExtensions')

    handle().setSelectionOffsets(0, text.length)
    handle().insertText(DOC)
    handle().revealOffset(DOC.indexOf('cc &= d') + 3)
    const caretBefore = caret()
    const editorBefore = view()

    expect(isVisual(editorBefore)).toBe(false)

    startVisual = true
    await render()
    await wait(100)

    // This assertion is the whole guarantee: the mode changed *on the same
    // EditorView*. Nothing was captured and nothing was restored — the state,
    // the selection and the viewport are the objects they were a moment ago,
    // which is why the caret and the scroll cannot drift.
    expect(isVisual(view())).toBe(true)
    expect(view()).toBe(editorBefore)
    expect(caret()).toBe(caretBefore)
    expect(view().state.doc.toString().replace(/\r\n/g, '\n')).toBe(DOC)

    startVisual = false
    await render()
    await wait(100)
    expect(isVisual(view())).toBe(false)
    expect(view()).toBe(editorBefore)
    expect(caret()).toBe(caretBefore)
  })

  it('keeps focus and the published view across the switch', async () => {
    // Focus matters because every editor key binding is a DOM key map, and the
    // published view is what the end-to-end probe reads: with the view reused
    // rather than replaced, both simply stay valid.
    const before = view()
    handle().focus()
    expect(before.hasFocus).toBe(true)

    startVisual = true
    await render()
    await wait(100)

    expect(view()).toBe(before)
    expect(before.hasFocus).toBe(true)
    expect((window as unknown as { __cmView?: unknown }).__cmView).toBe(before)
    expect(document.querySelectorAll('.cm-editor')).toHaveLength(1)

    startVisual = false
    await render()
    await wait(100)
    expect(view()).toBe(before)
    expect(before.hasFocus).toBe(true)
  })

  it('focuses the caret on a switch into Visual Mode, without disturbing the document', async () => {
    // `showContentWhenParsed` (ported, and load-bearing: it is what releases the
    // read-only editor) focuses the editor when it reveals the content. That is
    // the caret ending up active — which the port used to miss, because it
    // focused the editor *element* rather than the contenteditable.
    //
    // Where the viewport goes is a separate question, and is pinned by
    // `modeSwitch.test.ts`: the switch holds it with a scroll snapshot, which is
    // a deliberate write, so this test asserts the caret and the document only.
    const editor = view()

    // Focus somewhere that is not the editor, so the reveal path runs at all.
    document.body.setAttribute('tabindex', '-1')
    ;(document.body as HTMLElement).focus()
    expect(editor.hasFocus).toBe(false)

    // Wait for the precondition the ported reveal plugin checks: a fully parsed
    // document. `showContentWhenParsed` reveals the content and focuses the editor
    // straight away only when the syntax tree covers the document; otherwise it
    // arms a *five-second* fallback, which is far longer than a test can wait. The
    // language loads asynchronously, so a test that asserts the reveal has to wait
    // for it rather than race it.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (
        (await import('@codemirror/language')).syntaxTree(editor.state).length >=
        editor.state.doc.length
      ) {
        break
      }
      await wait(50)
    }

    startVisual = true
    await render()
    await wait(300)

    expect(editor.hasFocus).toBe(true)
    expect(document.activeElement).toBe(editor.contentDOM)
    expect(view()).toBe(editor)

    startVisual = false
    await render()
    await wait(100)
  })

  it('brings the visual decorations up on the live view, and takes them away again', async () => {
    // The point of the live switch is that the *extension set* changes, not just
    // a flag: the ported visual extensions have to start rendering on the view
    // that is already there, and stop when the mode goes back.
    const hasHeading = (editor: EditorView): boolean =>
      editor.dom.querySelector('h2.ol-cm-command-section') !== null
    const settled = async (predicate: () => boolean): Promise<boolean> => {
      for (let attempt = 0; attempt < 40 && !predicate(); attempt++) await wait(50)
      return predicate()
    }

    expect(hasHeading(view())).toBe(false)

    startVisual = true
    await render()
    expect(await settled(() => hasHeading(view()))).toBe(true)

    startVisual = false
    await render()
    expect(await settled(() => !hasHeading(view()))).toBe(true)
  })

  it('rebuilds — and restores the caret — when a setting that shapes the editor changes', async () => {
    // A rebuild is still the right answer for a genuine structural change. This
    // is the path `scrollRestore.ts` exists for, and it has to keep the caret.
    const before = view()
    handle().revealOffset(DOC.indexOf('cc &= d') + 3)
    const caretBefore = caret()

    await act(async () => {
      settingsManager.setValue('editor.tabSize', 4, 'user')
      await wait(200)
    })

    expect(view()).not.toBe(before)
    expect(caret()).toBe(caretBefore)
    expect((window as unknown as { __cmView?: unknown }).__cmView).toBe(view())

    await act(async () => {
      settingsManager.reset('editor', 'user')
    })
  })

  it('leaves exactly one editor in the document', async () => {
    expect(document.querySelectorAll('.cm-editor')).toHaveLength(1)
    expect(document.contains(view().dom)).toBe(true)
    await render()
    await wait(100)
    expect(document.querySelectorAll('.cm-editor')).toHaveLength(1)
    expect((window as unknown as { __cmView?: unknown }).__cmView).toBe(view())
  })

  it('answers with null once the editor is gone, rather than a stale position', async () => {
    await act(async () => {
      root.render(React.createElement(React.Fragment))
    })
    expect(handle().getEditor()).toBeNull()
    expect(handle().getSelectionOffsets()).toBeNull()
    expect(handle().getCursorOffset()).toBeNull()
    expect(() => handle().revealPosition(1, 1)).not.toThrow()
  })
})
