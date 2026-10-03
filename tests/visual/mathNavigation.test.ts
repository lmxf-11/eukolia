// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing } from '@codemirror/language'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { atomicDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { visualKeymap } from '@/vendor/overleaf/extensions/visual/visual-keymap'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'
import { MathWidget } from '@/vendor/overleaf/extensions/visual/visual-widgets/math'
import {
  clearRenderCache,
  rememberMathSvg,
} from '@/vendor/overleaf/extensions/visual/visual-widgets/math-render-cache'

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

const createEditor = (doc: string, anchor = 0) => {
  const parent = document.createElement('div')
  document.body.append(parent)

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        LaTeXLanguage,
        phrases(EUKOLIA_EDITOR_PHRASES),
        filePreview(() => null),
        atomicDecorations,
        visualKeymap,
      ],
    }),
  })

  forceParsing(view, doc.length, 5000)
  return view
}

/** Stand-in for what MathJax produces: container with SVG. */
const rendered = (label: string): HTMLElement => {
  const container = document.createElement('mjx-container')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '2ex')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('id', `glyph-${label}`)
  svg.appendChild(path)
  container.appendChild(svg)
  return container
}

beforeEach(() => {
  clearRenderCache()
})

describe('Visual Mode: immediate SVG render on leaving math block', () => {
  it('synchronously attaches cached SVG in MathWidget.toDOM without setTimeout', () => {
    const math = 'x^2 + y^2'
    const preamble = ''
    rememberMathSvg(math, false, preamble, rendered('test-svg'))

    const widget = new MathWidget(math, false, preamble)
    const dummyView = {} as EditorView
    const dom = widget.toDOM(dummyView)

    // Synchronously populated without waiting for macrotask/timeout
    expect(dom.querySelector('svg')).not.toBeNull()
    expect(dom.querySelector('#glyph-test-svg, [id$="glyph-test-svg"]')).not.toBeNull()
  })

  it('synchronously updates DOM in MathWidget.updateDOM when cached', () => {
    const math = 'a + b'
    const preamble = ''
    rememberMathSvg(math, false, preamble, rendered('update-svg'))

    const widget = new MathWidget(math, false, preamble)
    const element = document.createElement('span')
    const dummyView = {} as EditorView
    const updated = widget.updateDOM(element, dummyView)

    expect(updated).toBe(true)
    expect(element.querySelector('svg')).not.toBeNull()
    expect(element.querySelector('#glyph-update-svg, [id$="glyph-update-svg"]')).not.toBeNull()
  })
})

describe('Visual Mode: ArrowLeft and ArrowRight navigation into and out of inline math', () => {
  it('jumps into inline math with ArrowRight and steps out at the end', () => {
    // DOC: 'See $x^2$ here'
    // 'See ' is 0..4 (length 4). '$' is at 4. 'x' is at 5. '^' is 6. '2' is 7. closing '$' is 8. ' here' is 9..14.
    const doc = 'See $x^2$ here'
    const dollarPos = doc.indexOf('$') // 4
    const view = createEditor(doc, dollarPos)

    // Before pressing ArrowRight, caret is at 4 (before opening $)
    expect(view.state.selection.main.head).toBe(dollarPos)

    // Press ArrowRight -> jumps INTO math at 'x' (pos 5)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(view.state.selection.main.head).toBe(doc.indexOf('x'))

    // Move caret to end of math content (pos 8, after '2', before closing $)
    view.dispatch({ selection: { anchor: doc.indexOf('2') + 1 } })
    expect(view.state.selection.main.head).toBe(doc.indexOf('2') + 1)

    // Press ArrowRight -> steps OUT of math to after closing $ (pos 9)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(view.state.selection.main.head).toBe(doc.indexOf('$x^2$') + '$x^2$'.length)

    view.destroy()
  })

  it('jumps into inline math with ArrowLeft and steps out at the start', () => {
    const doc = 'See $x^2$ here'
    const afterMath = doc.indexOf('$x^2$') + '$x^2$'.length // pos 9
    const view = createEditor(doc, afterMath)

    // Caret is at 9 (immediately after closing $)
    expect(view.state.selection.main.head).toBe(afterMath)

    // Press ArrowLeft -> jumps INTO math at the end of content (after '2', pos 8)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(view.state.selection.main.head).toBe(doc.indexOf('2') + 1)

    // Move caret to start of math content (at 'x', pos 5)
    view.dispatch({ selection: { anchor: doc.indexOf('x') } })
    expect(view.state.selection.main.head).toBe(doc.indexOf('x'))

    // Press ArrowLeft -> steps OUT of math to before opening $ (pos 4)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(view.state.selection.main.head).toBe(doc.indexOf('$'))

    view.destroy()
  })
})

describe('Visual Mode: ArrowDown and ArrowUp navigation for inline and display math', () => {
  it('steps out of inline math to the line below with ArrowDown', () => {
    const doc = 'See $x^2$ here\nSecond line text'
    const view = createEditor(doc, doc.indexOf('x'))

    // Inside math at 'x' (column 5)
    expect(view.state.selection.main.head).toBe(doc.indexOf('x'))

    // Press ArrowDown -> steps out of math to second line at column 5
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const line2 = view.state.doc.line(2)
    expect(view.state.selection.main.head).toBe(line2.from + 5)

    view.destroy()
  })

  it('steps out of inline math to the line above with ArrowUp', () => {
    const doc = 'First line text\nSee $x^2$ here'
    const view = createEditor(doc, doc.indexOf('$x') + 1)

    // Inside math on second line at 'x'
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2)

    // Press ArrowUp -> steps out of math to first line
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1)

    view.destroy()
  })

  it('jumps down into display math from line above and steps out to line below', () => {
    const doc = 'Text above\n\\[\n  gHg^{-1} = H\n\\]\nText below'
    const view = createEditor(doc, 4) // On line 1 at column 4

    // Press ArrowDown from line 1 -> jumps into display math content line (line 3)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const currentLine = view.state.doc.lineAt(view.state.selection.main.head)
    expect(currentLine.number).toBe(3) // content line '  gHg^{-1} = H'
    expect(currentLine.text).toContain('gHg')

    // Press ArrowDown from content line -> steps out of display math to line 5 ('Text below')
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const exitLine = view.state.doc.lineAt(view.state.selection.main.head)
    expect(exitLine.number).toBe(5)
    expect(exitLine.text).toBe('Text below')

    view.destroy()
  })

  it('jumps up into display math from line below and steps out to line above', () => {
    const doc = 'Text above\n\\[\n  gHg^{-1} = H\n\\]\nText below'
    const line5 = doc.indexOf('Text below') + 4
    const view = createEditor(doc, line5)

    // Press ArrowUp from line 5 -> jumps into display math content line (line 3)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    const currentLine = view.state.doc.lineAt(view.state.selection.main.head)
    expect(currentLine.number).toBe(3)
    expect(currentLine.text).toContain('gHg')

    // Press ArrowUp from content line -> steps out of display math to line 1 ('Text above')
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    const exitLine = view.state.doc.lineAt(view.state.selection.main.head)
    expect(exitLine.number).toBe(1)
    expect(exitLine.text).toBe('Text above')

    view.destroy()
  })

  it('navigates multiline equation environment line-by-line before exiting', () => {
    const doc = 'Above\n\\begin{align}\n  a &= b \\\\\n  c &= d\n\\end{align}\nBelow'
    const view = createEditor(doc, 2) // Line 1

    // Press ArrowDown -> enters first content line (Line 3: '  a &= b \\')
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)

    // Move to Line 4 ('  c &= d')
    view.dispatch({ selection: { anchor: doc.indexOf('c &= d') } })
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4)

    // Press ArrowDown from last content line -> exits to line below ('Below', Line 6)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const exitLine = view.state.doc.lineAt(view.state.selection.main.head)
    expect(exitLine.number).toBe(6)
    expect(exitLine.text).toBe('Below')

    view.destroy()
  })

  it('jumps into display math with ArrowRight from the line above and ArrowLeft from the line below', () => {
    const doc = 'Above\n\\[\n  x + y\n\\]\nBelow'
    const view = createEditor(doc, 5) // At end of 'Above' (pos 5, line.to)

    // Press ArrowRight at end of Line 1 -> jumps into display math content line (Line 3)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toContain('x + y')

    // Move to start of Line 5 ('Below')
    const line5From = view.state.doc.line(5).from
    view.dispatch({ selection: { anchor: line5From } })

    // Press ArrowLeft at start of Line 5 -> jumps into display math content line (Line 3)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toContain('x + y')

    view.destroy()
  })

  it('jumps into and out of single-line display math', () => {
    const doc = 'Above\n\\[ x = 1 \\]\nBelow'
    const view = createEditor(doc, 2) // Line 1

    // Press ArrowDown -> enters single-line display math (Line 2)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2)

    // Press ArrowDown -> steps out to Line 3 ('Below')
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('Below')

    view.destroy()
  })
})
