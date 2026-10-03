// @vitest-environment jsdom
/**
 * Alignment while typing (Instructions.md §14).
 *
 * §14 asks for three alignment entry points — on demand, on save and *while
 * typing* — and the third one lived in the Monaco host until the editors were
 * unified. `alignWhileTyping.ts` is its replacement: a debounced
 * `formattingEngine.alignAt` pass over the environment the caret is in.
 *
 * These tests type into an unaligned `align` environment and assert that the
 * padding appears, that nothing happens while the setting is off, and that the
 * pass respects `formatting.alignWhileTypingDelayMs` rather than running on
 * every keystroke.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { alignWhileTyping } from '@/visual/alignWhileTyping'
import { eukoliaEditorExtensions } from '@/visual/editorExtensions'
import { createEditorScope, EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'
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
  '\\begin{align}',
  'a &= b \\\\',
  'cc &= d',
  '\\end{align}',
  ''
].join('\n')

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const mount = (extensions: Extension[]): EditorView => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions,
      selection: { anchor: DOC.indexOf('cc &= d') + 2 }
    }),
    parent: host
  })
}

/**
 * Types one character at the caret, the way the browser reports it: a document
 * change with the selection moved past the inserted text.
 */
const type = (view: EditorView, character: string): void => {
  const at = view.state.selection.main.head
  view.dispatch({
    changes: { from: at, insert: character },
    selection: { anchor: at + character.length },
    userEvent: 'input.type'
  })
}

/** The column of each `&`, which alignment makes equal. */
const ampersandColumns = (view: EditorView): number[] =>
  view.state.doc
    .toString()
    .split('\n')
    .filter(line => line.includes('&'))
    .map(line => line.indexOf('&'))

afterEach(() => {
  // Settings are global; a test that changes one must not leak into the next.
  settingsManager.reset('formatting', 'user')
})

describe('alignment while typing', () => {
  it('pads the environment shortly after typing stops', async () => {
    settingsManager.setValue('formatting.alignWhileTyping', true, 'user')
    settingsManager.setValue('formatting.alignWhileTypingDelayMs', 100, 'user')

    const view = mount([alignWhileTyping()])
    expect(new Set(ampersandColumns(view)).size).toBe(2)

    type(view, 'x')
    expect(view.state.doc.toString()).toContain('ccx &= d')

    await wait(350)
    const columns = ampersandColumns(view)
    expect(new Set(columns).size).toBe(1)
    // The typed character is still there: the pass is an edit, not a rewrite.
    expect(view.state.doc.toString()).toContain('ccx')
    view.destroy()
  })

  it('does nothing while the setting is off', async () => {
    settingsManager.setValue('formatting.alignWhileTyping', false, 'user')
    settingsManager.setValue('formatting.alignWhileTypingDelayMs', 100, 'user')

    const view = mount([alignWhileTyping()])
    type(view, 'x')
    await wait(350)

    expect(new Set(ampersandColumns(view)).size).toBe(2)
    view.destroy()
  })

  it('waits for the configured delay instead of running per keystroke', async () => {
    settingsManager.setValue('formatting.alignWhileTyping', true, 'user')
    settingsManager.setValue('formatting.alignWhileTypingDelayMs', 400, 'user')

    const view = mount([alignWhileTyping()])
    type(view, 'x')
    // Well inside the delay: nothing has run yet.
    await wait(120)
    expect(new Set(ampersandColumns(view)).size).toBe(2)

    await wait(600)
    expect(new Set(ampersandColumns(view)).size).toBe(1)
    view.destroy()
  })

  it('is mounted by the editor’s own extension set', async () => {
    settingsManager.setValue('formatting.alignWhileTyping', true, 'user')
    settingsManager.setValue('formatting.alignWhileTypingDelayMs', 100, 'user')

    const scope = createEditorScope({
      id: 'align',
      filePath: 'D:/project/homework.tex',
      projectRoot: 'D:/project',
      text: DOC,
      files: [{ path: 'D:/project/homework.tex' }],
      phrases: EUKOLIA_EDITOR_PHRASES
    })
    const view = mount([
      eukoliaEditorExtensions({
        scope,
        fileName: 'homework.tex',
        theme: 'light',
        startVisual: false
      })
    ])

    type(view, 'x')
    await wait(600)
    expect(new Set(ampersandColumns(view)).size).toBe(1)
    view.destroy()
  })
})
