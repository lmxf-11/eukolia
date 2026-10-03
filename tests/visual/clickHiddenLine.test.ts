/**
 * Where a click on a line the editor has hidden puts the caret.
 *
 * Visual Mode replaces a hidden environment's `\begin{…}` and `\end{…}` with a
 * block strip apiece. Clicking the *far* half of such a strip — the lower half of
 * a closing one, which is where a reader aims — has to put the caret at the end of
 * the source the strip stands for: `\end{figure}`. Measured in the running
 * application before the fix, it landed on the blank line *after* it, because the
 * port's edge decoration extends forwards over the empty lines around an
 * environment and the caret escape then carries a position at a line's end to the
 * start of the next line.
 *
 * The near half is deliberately not answered here. The port's own escape already
 * gives it a visible line — the far side of the hidden range, which is the line
 * before the environment — and that is a sensible place to be for a click above a
 * strip. Widening this to both halves was tried and reverted: it moved the caret
 * onto the hidden `\begin` line, which then had to be revealed to be of any use and
 * was not what the report asked for.
 *
 * jsdom lays nothing out, so the layout is modelled here — see `layoutByOffset`.
 * The *decision* under test is the real one; the appearance probe measures the same
 * decision in the running application, where the layout is the browser's.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

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

const rect = {
  top: 0,
  bottom: 16,
  left: 0,
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
  '\\documentclass{article}',
  '\\begin{document}',
  'Text above.',
  '',
  '\\begin{figure}',
  '\\centering',
  '\\includegraphics{plot.pdf}',
  '\\caption{A caption}',
  '\\end{figure}',
  '',
  '\\begin{verbatim}',
  'raw $source$ here',
  '\\end{verbatim}',
  '',
  '\\end{document}',
  '',
].join('\n')

const lineOf = (needle: string): number => {
  const at = DOC.indexOf(needle)
  if (at < 0) throw new Error(`fixture has no ${needle}`)
  return DOC.slice(0, at).split('\n').length
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Gives every element in the editor a rectangle in document order, and teaches
 * `posAtCoords` to resolve against it.
 *
 * jsdom lays nothing out, so without this every box is 0×0 and `posAtCoords`
 * answers the same position for every point — which makes the test meaningless
 * rather than failing, because the fix decides from the position the click resolves
 * to. The model's rule is the browser's: a point on a strip resolves to that
 * strip's near or far side by which half was clicked, and a point between strips
 * resolves to the source on the line after.
 */
function layoutByOffset(view: import('@codemirror/view').EditorView): void {
  const BAND = 20
  const LEFT = 0
  const WIDTH = 400

  const rectFor = (top: number): DOMRect =>
    ({
      top,
      bottom: top + BAND,
      left: LEFT,
      right: LEFT + WIDTH,
      width: WIDTH,
      height: BAND,
      x: LEFT,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect

  const positionOf = (element: Element): number => {
    try {
      return Math.max(0, view.posAtDOM(element, 0))
    } catch {
      return 0
    }
  }

  const widgetBoxes = [
    ...view.dom.querySelectorAll(
      '.ol-cm-environment-edge,.ol-cm-unrenderable-math,.ol-cm-preamble-widget'
    ),
  ].map(widget => ({ widget, top: positionOf(widget) * BAND }))

  const original = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (!view.dom.contains(this) && this !== view.dom) return original.call(this)
    const found = widgetBoxes.find(entry => entry.widget === this)
    if (found) return rectFor(found.top)
    if (this === view.contentDOM || this === view.dom) {
      const bottom = Math.max(BAND, DOC.length * BAND)
      return {
        top: 0,
        bottom,
        left: LEFT,
        right: LEFT + WIDTH,
        width: WIDTH,
        height: bottom,
        x: LEFT,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect
    }
    return rectFor(0)
  }

  view.posAtCoords = ((coords: { x: number; y: number }) => {
    for (const entry of widgetBoxes) {
      if (coords.y >= entry.top && coords.y < entry.top + BAND) {
        const at = positionOf(entry.widget)
        const line = view.state.doc.lineAt(Math.max(0, Math.min(at, view.state.doc.length)))
        // The near half resolves *to* the strip, the far half *past* it.
        return coords.y <= entry.top + BAND / 2 ? line.from : line.to + 1
      }
    }
    const number = Math.min(
      view.state.doc.lines,
      Math.max(1, Math.floor(coords.y / BAND) + 1)
    )
    return view.state.doc.line(number).from
  }) as typeof view.posAtCoords
}

/** Clicks a strip at a fraction of its height, looked up fresh each time. */
async function clickStrip(
  view: import('@codemirror/view').EditorView,
  selector: string,
  fraction: number
): Promise<number> {
  const widget = view.dom.querySelector(selector)
  if (!widget) throw new Error(`no strip for ${selector}`)
  const box = widget.getBoundingClientRect()
  widget.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height * fraction,
    })
  )
  await wait(40)
  return view.state.selection.main.head
}

async function mount(): Promise<import('@codemirror/view').EditorView> {
  const { EditorState } = await import('@codemirror/state')
  const { EditorView } = await import('@codemirror/view')
  const { forceParsing, syntaxTree } = await import('@codemirror/language')
  const { eukoliaEditorExtensions } = await import('@/visual/editorExtensions')
  const { createEditorScope, EUKOLIA_EDITOR_PHRASES } = await import('@/visual/scope')
  const { setEditable } = await import('@vendor/overleaf/extensions/editable')

  const scope = createEditorScope({
    id: 'click-hidden-line',
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
        startVisual: true,
      }),
      // Outside the preamble and outside every hidden environment, so every strip
      // is painted rather than revealing its source.
      selection: { anchor: DOC.indexOf('Text above') + 3 },
    }),
    parent: host,
  })
  view.dispatch(setEditable(true))

  forceParsing(view, view.state.doc.length, 10000)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (syntaxTree(view.state).length === view.state.doc.length) break
    await wait(25)
  }
  layoutByOffset(view)
  await wait(150)
  return view
}

describe('a click on a hidden environment line', () => {
  it('paints the strips this fix is about', async () => {
    // Without these there is nothing to click and the tests below would pass
    // vacuously.
    const view = await mount()
    try {
      expect(
        view.dom.querySelector('.ol-cm-environment-figure.ol-cm-environment-bottom'),
        'the figure has no closing strip'
      ).not.toBeNull()
      expect(
        view.dom.querySelector('.ol-cm-environment-verbatim.ol-cm-environment-bottom'),
        'verbatim has no closing strip'
      ).not.toBeNull()
    } finally {
      view.destroy()
    }
  })

  it('puts the caret at the end of `\\end{figure}`', async () => {
    const view = await mount()
    try {
      const caret = await clickStrip(
        view,
        '.ol-cm-environment-figure.ol-cm-environment-bottom',
        0.8
      )
      const line = view.state.doc.lineAt(caret)
      expect(line.text, `caret landed on ${JSON.stringify(line.text)}`).toBe('\\end{figure}')
      expect(caret, 'the caret is not at the end of the line').toBe(line.to)
    } finally {
      view.destroy()
    }
  })

  it('puts the caret at the end of `\\end{verbatim}`', async () => {
    const view = await mount()
    try {
      const caret = await clickStrip(
        view,
        '.ol-cm-environment-verbatim.ol-cm-environment-bottom',
        0.8
      )
      const line = view.state.doc.lineAt(caret)
      expect(line.text, `caret landed on ${JSON.stringify(line.text)}`).toBe('\\end{verbatim}')
      expect(caret).toBe(line.to)
    } finally {
      view.destroy()
    }
  })

  it('never lands on the blank line the edge decoration swallowed', async () => {
    // The port extends a closing edge over the blank line after the environment, so
    // the far side of the strip is that empty line rather than the `\end`. The line
    // the reader means is the one with the source on it.
    const view = await mount()
    try {
      const caret = await clickStrip(
        view,
        '.ol-cm-environment-figure.ol-cm-environment-bottom',
        0.8
      )
      const line = view.state.doc.lineAt(caret)
      expect(line.text.trim().length, 'the caret landed on a blank line').toBeGreaterThan(0)
      expect(line.number).toBe(lineOf('\\end{figure}'))
    } finally {
      view.destroy()
    }
  })

  it('leaves the near half to the port, which already gives it a visible line', async () => {
    // Deliberately a loose assertion. Which *visible* line the near half lands on is
    // the port's business and depends on how far into the line CodeMirror's own
    // hit-test went, plus whether revealing the source shifted the range out from
    // under the caret — three lines were observed across runs, all of them plausible.
    // What this fix owns is the far half, and what it must not do is drag the near
    // half onto a hidden or blank line while repairing it.
    const view = await mount()
    try {
      const caret = await clickStrip(
        view,
        '.ol-cm-environment-figure.ol-cm-environment-top',
        0.2
      )
      const line = view.state.doc.lineAt(caret)
      expect(line.text.trim().length, 'the caret landed on a blank line').toBeGreaterThan(0)
      expect(
        Math.abs(line.number - lineOf('\\begin{figure}')),
        `the caret landed on line ${line.number}, far from the strip`
      ).toBeLessThanOrEqual(2)
    } finally {
      view.destroy()
    }
  })

  it('leaves the preamble toggle clickable', async () => {
    // The toggle is a `<button>`, and the widget this handler answers for *is* that
    // button — so the "keep controls clickable" guard has to test the widget's
    // descendants rather than the widget itself. Testing the wrong one made every
    // click return early, and the defect hid behind it.
    const view = await mount()
    try {
      const button = view.dom.querySelector('.ol-cm-preamble-widget')
      expect(button, 'the preamble toggle is missing').not.toBeNull()
      const box = button!.getBoundingClientRect()
      button!.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
        })
      )
      await wait(60)
      // The click handler did not move the caret into the preamble; what the toggle
      // does with the click is its own business.
      expect(view.state.selection.main.head).not.toBe(0)
    } finally {
      view.destroy()
    }
  })
})
