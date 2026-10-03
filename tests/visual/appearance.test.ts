// @vitest-environment jsdom
/**
 * Visual Mode appearance.
 *
 * These assertions describe what the Overleaf-derived visual editor is supposed
 * to look like in the DOM, using the real extension set and the real smoke
 * fixture. The smoke probe measures the same surface from outside the
 * application; a regression here (a heading that goes back to being a plain
 * span, a list that loses its markup, a gutter that reappears, an editor that
 * is locked) would otherwise only show up in a two-minute end-to-end run.
 *
 * jsdom performs no layout, so CodeMirror's viewport covers only the caret's
 * line. `reveal()` moves the caret, which is exactly what scrolling does in the
 * application, and the decorations for that range are then asserted on.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { EditorView } from '@codemirror/view'

// The ported LaTeX language constructs a lint Web Worker on import; jsdom has
// no `Worker`, so a minimal stub keeps the language loadable.
class WorkerStub {
  onmessage: ((event: MessageEvent) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
Object.defineProperty(globalThis, 'Worker', {
  configurable: true,
  writable: true,
  value: WorkerStub,
})

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

const DOC = fs.readFileSync(
  path.resolve(__dirname, '..', 'smoke', 'fixture', 'homework.tex'),
  'utf8'
)

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Mounts the visual editor exactly as `VisualEditor.tsx` does. */
async function mount(
  doc: string,
  { visual = true, anchor = 0 }: { visual?: boolean; anchor?: number } = {}
): Promise<EditorView> {
  const { EditorState } = await import('@codemirror/state')
  const { EditorView } = await import('@codemirror/view')
  const { forceParsing, syntaxTree } = await import('@codemirror/language')
  const { eukoliaEditorExtensions } = await import('@/visual/editorExtensions')
  const { createEditorScope, EUKOLIA_EDITOR_PHRASES } = await import(
    '@/visual/scope'
  )
  const { setEditable } = await import('@vendor/overleaf/extensions/editable')

  const scope = createEditorScope({
    id: 'appearance',
    filePath: 'D:/project/homework.tex',
    projectRoot: 'D:/project',
    text: doc,
    files: [{ path: 'D:/project/homework.tex' }],
    phrases: EUKOLIA_EDITOR_PHRASES,
  })

  const host = document.createElement('div')
  document.body.appendChild(host)

  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: eukoliaEditorExtensions({
        scope,
        fileName: 'homework.tex',
        theme: 'light',
        startVisual: visual,
      }),
      selection: { anchor, head: anchor },
    }),
    parent: host,
  })
  view.dispatch(setEditable(true))

  // The parser runs lazily; the editor forces it once the language has loaded.
  // The ported `skipPreambleWithCursor` plugin reacts on the update after the
  // tree becomes complete, so the mount is not settled until it has.
  forceParsing(view, view.state.doc.length, 10000)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (syntaxTree(view.state).length === view.state.doc.length) break
    await wait(25)
  }
  await wait(150)

  return view
}

/**
 * Moves the caret to `offset` and waits for CodeMirror to render that line,
 * which is the jsdom equivalent of scrolling it into view.
 */
async function reveal(view: EditorView, offset: number): Promise<void> {
  const { EditorSelection } = await import('@codemirror/state')
  const { EditorView } = await import('@codemirror/view')
  view.dispatch({
    selection: EditorSelection.cursor(offset),
    effects: EditorView.scrollIntoView(offset),
  })
  await wait(30)
}

const offsetsOf = (needle: string): number[] => {
  const offsets: number[] = []
  let index = DOC.indexOf(needle)
  while (index >= 0) {
    offsets.push(index + 1)
    index = DOC.indexOf(needle, index + 1)
  }
  return offsets
}

/** Reveals every occurrence of `needle` and collects the matching elements. */
async function collect(
  view: EditorView,
  needle: string,
  selector: string
): Promise<Element[]> {
  const found = new Map<string, Element>()
  for (const offset of offsetsOf(needle)) {
    await reveal(view, offset)
    for (const element of view.dom.querySelectorAll(selector)) {
      found.set(`${element.tagName}:${element.textContent}`, element)
    }
  }
  return [...found.values()]
}

let view: EditorView

beforeAll(async () => {
  view = await mount(DOC)
}, 60000)

describe('Visual Mode document structure', () => {
  it('renders \\section and \\subsection as real heading elements', async () => {
    const headings = [
      ...(await collect(view, '\\section{', 'h1,h2,h3,h4,h5,h6')),
      ...(await collect(view, '\\subsection{', 'h1,h2,h3,h4,h5,h6')),
    ]
    const text = headings.map(heading => heading.textContent)

    expect(text).toContain('Group structure and morphisms')
    expect(text).toContain('Cosets and Normal Subgroups')
    expect(text).toContain('Quotient Group Construction')
    // The command and its braces are replaced, so a heading is plain text.
    expect(text.join('\n')).not.toContain('\\section')
    // The reference's own styling classes are still on the same element.
    expect(view.dom.querySelector('h2.ol-cm-command-section')).not.toBeNull()
    expect(view.dom.querySelector('h3.ol-cm-command-subsection')).not.toBeNull()
  })

  it('maps LaTeX sectioning commands onto HTML heading levels', async () => {
    const { sectionHeadingTag } = await import(
      '@/vendor/overleaf/extensions/visual/mark-decorations'
    )
    expect(sectionHeadingTag('part')).toBe('h1')
    expect(sectionHeadingTag('chapter')).toBe('h1')
    expect(sectionHeadingTag('section')).toBe('h2')
    expect(sectionHeadingTag('subsection')).toBe('h3')
    expect(sectionHeadingTag('subsubsection')).toBe('h4')
    expect(sectionHeadingTag('paragraph')).toBe('h5')
    expect(sectionHeadingTag('subparagraph')).toBe('h6')
  })

  it('renders itemize and enumerate as real list elements', async () => {
    const lists = await collect(view, '\\begin{itemize}', 'ul,ol')
    for (const offset of offsetsOf('\\begin{enumerate}')) {
      await reveal(view, offset)
      for (const element of view.dom.querySelectorAll('ul,ol')) {
        lists.push(element)
      }
    }

    expect(lists.some(list => list.tagName === 'UL')).toBe(true)
    expect(lists.some(list => list.tagName === 'OL')).toBe(true)
    // CodeMirror renders a zero-length wrapper for a decoration that starts
    // outside the rendered range, so only the populated ones are counted.
    const populated = lists.filter(list => (list.textContent ?? '').trim())
    expect(populated.length).toBeGreaterThanOrEqual(2)
    expect(view.dom.querySelectorAll('li').length).toBeGreaterThan(0)
  })

  it('replaces \\item with the reference item widget', async () => {
    // The caret is placed after the list so the items are not expanded.
    await reveal(view, DOC.indexOf('\\end{enumerate}'))
    const markers = await collect(view, '\\item', '.ol-cm-item')
    expect(markers.length).toBeGreaterThan(0)
  })

  it('renders the theorem header as the reference flex row', async () => {
    await reveal(view, DOC.indexOf('\\begin{definition}') + 1)
    const header = view.dom.querySelector('.ol-cm-begin-theorem')
    expect(header).not.toBeNull()
    expect(header?.querySelector('.ol-cm-environment-name')?.textContent).toBe(
      'Definition'
    )
    expect(header?.querySelectorAll('.ol-cm-environment-padding').length).toBe(2)
  })
})

describe('Visual Mode entry state', () => {
  it('collapses the preamble and keeps the caret out of it', async () => {
    // A fresh mount on purpose: the tests above scroll the shared editor through
    // the whole document, and CodeMirror only renders the visible viewport, so
    // the preamble is no longer in the DOM by the time we get here. Entry state
    // is what this test is about, so it gets its own editor.
    const fresh = await mount(DOC)

    expect(fresh.dom.querySelector('.ol-cm-preamble-expanded')).toBeNull()
    expect(fresh.dom.querySelector('.ol-cm-preamble-widget')).not.toBeNull()
    // The toggle's *label*, not its phrase key. The key used to be what the
    // button said — `show_document_preamble` and `hide_document_preamble` were
    // missing from the phrase table, and `state.phrase` answers with its argument
    // when it finds nothing — so this assertion was pinning a developer's string
    // as the expected UI, and the control's accessible name with it.
    expect(fresh.dom.textContent).toContain('Show preamble')
    // The ported `skipPreambleWithCursor` plugin moved the caret out of the
    // preamble, which ends at `\begin{document}` (offset 618).
    const caret = fresh.state.selection.main.anchor
    expect(caret).toBeGreaterThan(618)
    expect(caret).toBeLessThan(DOC.indexOf('\\end{document}'))

    fresh.destroy()
  })

  it('is editable, so decorations expand around the caret', () => {
    // `editable()` starts the document read-only; the host releases it. A
    // read-only visual editor can never reveal the source of the construct
    // under the caret, which is the point of the visual editor.
    expect(view.state.readOnly).toBe(false)
  })
})

describe('Visual Mode chrome', () => {
  it('mounts the line-number and fold gutter, exactly as Code Mode does', () => {
    // Visual Mode is the same editor with decorations painted on, so switching
    // from Code Mode must not lose the gutter (Instructions.md §28).
    expect(view.dom.querySelector('.cm-lineNumbers')).not.toBeNull()
    expect(view.dom.querySelector('.cm-foldGutter')).not.toBeNull()
  })

  it('still mounts the gutter when the editor is not visual', async () => {
    const source = await mount(DOC, { visual: false })
    expect(source.dom.querySelector('.cm-lineNumbers')).not.toBeNull()
    // No visual decoration is applied in source mode.
    expect(source.dom.querySelector('.ol-cm-heading')).toBeNull()
    source.destroy()
  })

  it('mounts the toolbar panel', () => {
    expect(view.dom.querySelector('#ol-cm-toolbar-portal')).not.toBeNull()
  })
})

describe('Visual Mode hand-off entry state (Instructions.md §28)', () => {
  it('seeds the caret from a line-based snapshot and reads it back', async () => {
    const { captureSnapshot, getVisualEditorText } = await import(
      '@/visual/VisualEditor'
    )
    const { createSnapshot, countLines, lineStartOffset, offsetAtPosition } =
      await import('@/visual/mode')

    // Line 38 is plain prose with inline mathematics, i.e. real decorated
    // content — the case the hand-off has to survive.
    const line = 38
    const snapshot = createSnapshot(DOC, {
      anchor: { line, column: 3 },
      head: { line, column: 3 },
      topLine: line,
    })
    expect(countLines(DOC)).toBeGreaterThan(line)
    expect(lineStartOffset(DOC, line)).toBeGreaterThan(0)

    const fresh = await mount(DOC, { anchor: snapshot.anchor })
    const seeded = getVisualEditorText(fresh)
    try {
      // The seeded offset is the one the hand-off carried, and CodeMirror
      // resolves it to the same line — the line is the unit that survives the
      // crossing. (A column can be nudged by the visual decorations, and that is
      // precisely why the hand-off carries the line as well as the offset.)
      const captured = captureSnapshot(fresh)
      expect(captured.anchor).toBe(snapshot.anchor)
      expect(captured.anchorPosition.line).toBe(line)
      expect(captured.headPosition.line).toBe(line)

      // The snapshot's length is the document the editor was seeded with, which
      // is the fixture read as text (the file on disk is UTF-8).
      expect(captured.docLength).toBe(fresh.state.doc.length)
      expect(captured.docLength).toBe(seeded.length)

      // Reading the position back and resolving it again is a fixed point: the
      // same offset, on the same line, with the same top line.
      const again = createSnapshot(seeded, {
        anchor: captured.anchorPosition,
        head: captured.headPosition,
        topLine: captured.topLine,
      })
      expect(again.anchor).toBe(captured.anchor)
      expect(again.head).toBe(captured.head)
      expect(again.anchorPosition.line).toBe(line)
      expect(again.topLine).toBe(captured.topLine)

      // The top visible line is a real line number, and its offset is that
      // line's first character. jsdom performs no layout and this fixture's
      // client rects are stubbed to a single 16px line, so the exact value is
      // not meaningful here — that it is a valid line in the document is.
      expect(captured.topLine).toBeGreaterThanOrEqual(1)
      expect(captured.topLine).toBeLessThanOrEqual(fresh.state.doc.lines)
      expect(captured.topOffset).toBe(lineStartOffset(seeded, captured.topLine))
      expect(captured.topOffset).toBe(
        offsetAtPosition(seeded, { line: captured.topLine, column: 1 })
      )
    } finally {
      fresh.destroy()
    }
  })
})
