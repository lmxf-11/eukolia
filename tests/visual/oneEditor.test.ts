/**
 * One editor, two modes — and the caret that belongs to both.
 *
 * This is the structural half of "the code displayed in Visual Mode and Math Mode
 * must use identical styling": the two modes cannot drift in type because they
 * are not two surfaces. There is one `EditorView` for the whole shell, the mode
 * is a compartment reconfigured on it, and Math Mode is not a third surface
 * either — it is the caret sitting inside a mathematical region, reported as
 * `data-caret-math` so the stylesheet can colour the caret.
 *
 * What these assert is therefore an invariant rather than a value: switching the
 * mode must not replace the editor, and entering mathematics must not either.
 * `scripts/probe-visual.mjs` measures the resulting type in the real
 * application, where the stylesheets and the platform fonts are in play.
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'

// The ported LaTeX language constructs a lint Web Worker on import; jsdom has no
// `Worker`, so a minimal stub keeps the language loadable.
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
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => rect as DOMRect
Element.prototype.getClientRects = () => [rect] as unknown as DOMRectList

const DOC = [
  '\\documentclass{article}',
  '\\usepackage{amsmath}',
  '\\begin{document}',
  'Prose with $x^2$ inline, and \\(not mathematics\\) either.',
  '',
  '\\begin{equation}',
  'E = mc^2',
  '\\end{equation}',
  '\\end{document}',
  '',
].join('\n')

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function mount(visual: boolean) {
  const { EditorState } = await import('@codemirror/state')
  const { EditorView } = await import('@codemirror/view')
  const { forceParsing, syntaxTree } = await import('@codemirror/language')
  const { eukoliaEditorExtensions } = await import('@/visual/editorExtensions')
  const { createEditorScope, EUKOLIA_EDITOR_PHRASES } = await import('@/visual/scope')
  const { setEditable } = await import('@vendor/overleaf/extensions/editable')

  const scope = createEditorScope({
    id: `one-editor-${visual}`,
    filePath: 'D:/project/main.tex',
    projectRoot: 'D:/project',
    text: DOC,
    files: [{ path: 'D:/project/main.tex' }],
    phrases: EUKOLIA_EDITOR_PHRASES,
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: eukoliaEditorExtensions({
        scope,
        fileName: 'main.tex',
        theme: 'dark',
        startVisual: visual,
      }),
      selection: { anchor: 1 },
    }),
    parent: host,
  })
  view.dispatch(setEditable(true))
  forceParsing(view, view.state.doc.length, 10000)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (syntaxTree(view.state).length === view.state.doc.length) break
    await wait(25)
  }
  await wait(120)
  return view
}

async function putCaret(
  view: Awaited<ReturnType<typeof mount>>,
  offset: number
): Promise<string | null> {
  const { EditorSelection } = await import('@codemirror/state')
  view.dispatch({ selection: EditorSelection.cursor(offset) })
  await wait(40)
  return view.dom.getAttribute('data-caret-math')
}

let visual: Awaited<ReturnType<typeof mount>>

beforeAll(async () => {
  visual = await mount(true)
}, 60000)

describe('the mode is a setting on one editor, not a second editor', () => {
  it('flips the mode on the live view without replacing it', async () => {
    const { setVisualMode } = await import('@/visual/editorExtensions')

    const before = visual.dom.getAttribute('data-mode')
    const element = visual.dom
    const content = visual.contentDOM

    visual.dispatch(setVisualMode(false))
    await wait(60)
    expect(visual.dom.getAttribute('data-mode')).not.toBe(before)
    // The same DOM: a rebuilt editor would be a different element, and that is
    // what "one editor, two modes" rules out.
    expect(visual.dom).toBe(element)
    expect(visual.contentDOM).toBe(content)

    visual.dispatch(setVisualMode(true))
    await wait(60)
    expect(visual.dom.getAttribute('data-mode')).toBe(before)
    expect(visual.dom).toBe(element)
  })

  it('keeps the gutter mounted across the switch', async () => {
    const numbers = visual.dom.querySelector('.cm-lineNumbers')
    expect(numbers, 'no gutter to begin with').not.toBeNull()
    expect(visual.dom.querySelector('.cm-foldGutter')).not.toBeNull()
  })
})

describe('Math Mode is where the caret is, not what the editor is', () => {
  it('reports the mathematical context only inside a mathematical region', async () => {
    // Both region boundaries, from the outside in and back out.
    const inside = DOC.indexOf('$x^2') + 2
    const before = DOC.indexOf('$x^2') - 1
    const after = DOC.indexOf('and', inside)

    expect(await putCaret(visual, before)).not.toBe('on')
    expect(await putCaret(visual, inside)).toBe('on')
    expect(await putCaret(visual, after)).not.toBe('on')
  })

  it('reports it inside a display environment too, from the body onwards', async () => {
    // Measured boundary, and the exact one rather than the expected one: the
    // region's `Math` node begins where the environment's *content* begins, so a
    // caret in the `\begin{equation}` declaration is outside it while a caret at
    // the newline that opens the body is inside. Reading it as "the whole
    // environment" would colour the caret while the declaration is being typed.
    const declaration = DOC.indexOf('\\begin{equation}')
    const body = DOC.indexOf('E = mc^2')

    expect(await putCaret(visual, declaration + 2)).not.toBe('on')
    expect(await putCaret(visual, body)).toBe('on')
    expect(await putCaret(visual, body + 2)).toBe('on')
    // And outside it again, so the flag is not simply latched on.
    expect(await putCaret(visual, DOC.indexOf('Prose') + 3)).not.toBe('on')
  })

  it('treats the parenthesised delimiter as mathematics, as the grammar does', async () => {
    // Worth pinning because it reads like a bug and is not: the lezer grammar
    // declares `ParenMath` a `$MathContainer`, and `atomic-decorations.ts`
    // renders it — measured in the running application, `\(a + b\)` produces a
    // mathematics widget. A caret inside is editing mathematics, so the caret
    // reports the mathematical context.
    const paren = DOC.indexOf('\\(not mathematics\\)')
    expect(paren).toBeGreaterThan(0)
    expect(await putCaret(visual, paren + 4)).toBe('on')

    // And the boundary is the region's own, not the whole line.
    expect(await putCaret(visual, paren - 2)).not.toBe('on')
  })

  it('marks the revealed source so it can be set as code', async () => {
    await putCaret(visual, DOC.indexOf('$x^2') + 2)
    // The class is the mechanism the stylesheet rule in `codeTypography.test.ts`
    // selects; the two together are what keep the source at the code size.
    expect(visual.dom.querySelector('.eu-cm-math-source')).not.toBeNull()
  })
})
