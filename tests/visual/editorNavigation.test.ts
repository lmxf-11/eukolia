// @vitest-environment jsdom
/**
 * LaTeX intelligence is mounted on the one editor.
 *
 * Go to definition, Find All References, clickable document links, completion and
 * hover used to be Monaco language providers in `monacoLatex.ts`, so all of them
 * had to be carried over to CodeMirror for Code Mode to keep them. The adapter
 * modules own the resolution; this file checks the half that belongs to the
 * editor host — that the extension set actually mounts them, that navigation is
 * bound only when a host was supplied (a key binding that resolves to nothing
 * would be worse than no key binding), that links are decorated, and that
 * Eukolia's completion source *joins* the language's own sources rather than
 * replacing them.
 */
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

import { eukoliaEditorExtensions } from '@/visual/editorExtensions'
import { createEditorScope, EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'
import { latexCompletionSource } from '@/editor/cmCompletion'
import {
  DOCUMENT_LINK_CLASS,
  MISSING_DOCUMENT_LINK_CLASS,
} from '@/editor/cmNavigation'

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

// Both on the first line: jsdom renders only the caret's line, and that is where
// the link decorations have to be observable.
const DOC = '\\input{chapters/intro} — see https://example.com\n\nMore text.\n'

const host = {
  openFile: () => undefined,
  showReferences: () => undefined,
}

const build = (
  navigation?: typeof host
): { state: EditorState; view: EditorView } => {
  const scope = createEditorScope({
    id: 'intelligence',
    filePath: 'D:/project/homework.tex',
    projectRoot: 'D:/project',
    text: DOC,
    files: [{ path: 'D:/project/homework.tex' }],
    phrases: EUKOLIA_EDITOR_PHRASES,
  })

  const container = document.createElement('div')
  document.body.appendChild(container)

  const state = EditorState.create({
    doc: DOC,
    extensions: eukoliaEditorExtensions({
      scope,
      fileName: 'homework.tex',
      theme: 'light',
      startVisual: false,
      navigation,
    }),
    selection: { anchor: 0 },
  })
  const view = new EditorView({ state, parent: container })
  return { state, view }
}

const keys = (state: EditorState): string[] =>
  state
    .facet(keymap)
    .flat()
    .map(binding => binding.key ?? binding.mac ?? '')
    .filter(Boolean)

/**
 * Lets the ported LaTeX language finish loading before the test ends.
 *
 * It loads asynchronously and imports its lint Web Worker on the way, so a test
 * that finishes first leaves that import to run against a torn-down environment —
 * which Vitest reports as an unhandled error, even though every assertion passed.
 */
const settle = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 300))

describe('LaTeX navigation on the unified editor', () => {
  it('binds go to definition and Find All References when a host is supplied', async () => {
    const { state, view } = build(host)
    expect(keys(state)).toContain('F12')
    expect(keys(state)).toContain('Shift-F12')
    await settle()
    view.destroy()
  })

  it('binds neither when the host omits navigation', async () => {
    const { state, view } = build()
    expect(keys(state)).not.toContain('F12')
    expect(keys(state)).not.toContain('Shift-F12')
    // The links go with it: they exist to be followed through the host.
    expect(view.dom.querySelector(`.${DOCUMENT_LINK_CLASS}`)).toBeNull()
    expect(view.dom.querySelector(`.${MISSING_DOCUMENT_LINK_CLASS}`)).toBeNull()
    await settle()
    view.destroy()
  })

  it('decorates a URL as clickable and an \\input path as a link', async () => {
    const { view } = build(host)
    // The URL resolves without a project index; the `\input` path does not,
    // because nothing has indexed `chapters/intro` here — it is still decorated,
    // as a link that must not look clickable.
    expect(
      view.dom.querySelectorAll(`.${DOCUMENT_LINK_CLASS}`).length
    ).toBeGreaterThan(0)
    expect(
      view.dom.querySelectorAll(`.${MISSING_DOCUMENT_LINK_CLASS}`).length
    ).toBeGreaterThan(0)
    await settle()
    view.destroy()
  })
})

describe('LaTeX completion on the unified editor', () => {
  it("joins the language's own sources rather than replacing them", async () => {
    const { state, view } = build(host)

    // `autoComplete({ enabled: true })` mounts CodeMirror's `autocompletion`
    // with no `override`, so this is the list it will draw from: Eukolia's
    // registry source is registered as language data beside whatever the loaded
    // LaTeX language contributes, which is what makes it a merge.
    const sources = state.languageDataAt<unknown>('autocomplete', 0)
    expect(sources).toContain(latexCompletionSource)

    await settle()
    view.destroy()
  })
})
