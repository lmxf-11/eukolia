// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing } from '@codemirror/language'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { atomicDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { visualKeymap } from '@/vendor/overleaf/extensions/visual/visual-keymap'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'
import { MathWidget } from '@/vendor/overleaf/extensions/visual/visual-widgets/math'
import { settingsManager } from '@core/settings'

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

const getMathWidgets = (view: EditorView) => {
  const widgets: any[] = []
  for (const value of view.state.facet(EditorView.decorations)) {
    const set = typeof value === 'function' ? value(view) : value
    set.between(0, view.state.doc.length, (from, to, decoration) => {
      const spec = (decoration as any).spec
      if (spec?.widget instanceof MathWidget) {
        widgets.push({ from, to, math: spec.widget.math, displayMode: spec.widget.displayMode })
      }
    })
  }
  return widgets
}

describe('Visual Math Navigation & Rendering', () => {
  it('checks inline math decoration when cursor is placed around and inside', () => {
    const doc = 'See $x^2$ here'
    const view = createEditor(doc, 0)
    expect(getMathWidgets(view)).toHaveLength(1)

    // Move to 4 (before $)
    view.dispatch({ selection: { anchor: 4 } })
    expect(getMathWidgets(view)).toHaveLength(1)

    // Press ArrowRight to enter inline math
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(view.state.selection.main.head).toBe(5)
    expect(getMathWidgets(view)).toHaveLength(0) // Raw LaTeX revealed

    // Move to 9 (after closing $)
    view.dispatch({ selection: { anchor: 9 } })
    expect(getMathWidgets(view)).toHaveLength(1) // Rendered to SVG

    // Press ArrowLeft to re-enter inline math
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(view.state.selection.main.head).toBe(8)
    expect(getMathWidgets(view)).toHaveLength(0) // Raw LaTeX revealed

    view.destroy()
  })

  it('checks display math \\[ ... \\]', () => {
    const doc = 'Above\n\\[\n  x + y = z\n\\]\nBelow'
    const view = createEditor(doc, 0)
    expect(getMathWidgets(view)).toHaveLength(1)

    // Arrow down from line 1 into display math
    view.dispatch({ selection: { anchor: 2 } })
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
    expect(getMathWidgets(view)).toHaveLength(0) // Raw LaTeX revealed

    // Arrow down out of display math into "Below"
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5)
    expect(getMathWidgets(view)).toHaveLength(1) // Immediately rendered back to SVG

    view.destroy()
  })

  it('checks math environment \\begin{equation}', () => {
    const doc = 'Above\n\\begin{equation}\n  x + y = z\n\\end{equation}\nBelow'
    const view = createEditor(doc, 0)
    expect(getMathWidgets(view)).toHaveLength(1)

    // Arrow down from line 1 into equation environment
    view.dispatch({ selection: { anchor: 2 } })
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
    expect(getMathWidgets(view)).toHaveLength(0) // Raw LaTeX revealed

    // Arrow down from content line to step out to Below (line 5)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5)
    expect(getMathWidgets(view)).toHaveLength(1) // Immediately rendered back to SVG

    view.destroy()
  })

  it('checks clicking on inline math widget', () => {
    const doc = 'See $x^2$ here'
    const view = createEditor(doc, 0)
    expect(getMathWidgets(view)).toHaveLength(1)

    const widgetDom = view.dom.querySelector('.ol-cm-math')
    expect(widgetDom).not.toBeNull()

    // Simulate clicking on the widget
    if (widgetDom) {
      widgetDom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 50, clientY: 8 }))
      widgetDom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: 50, clientY: 8 }))
      widgetDom.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 50, clientY: 8 }))
    }
    // Selection should be inside formula and widget removed
    expect(view.state.selection.main.head).toBeGreaterThanOrEqual(5)
    expect(view.state.selection.main.head).toBeLessThanOrEqual(8)
    expect(getMathWidgets(view)).toHaveLength(0)

    view.destroy()
  })

  it('checks clicking on display math widget', () => {
    const doc = 'Above\n\\[\n  x + y = z\n\\]\nBelow'
    const view = createEditor(doc, 0)
    expect(getMathWidgets(view)).toHaveLength(1)

    const widgetDom = view.dom.querySelector('.ol-cm-math')
    expect(widgetDom).not.toBeNull()

    if (widgetDom) {
      widgetDom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 50, clientY: 8 }))
    }
    // Should be inside content line 3 and widget removed
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
    expect(getMathWidgets(view)).toHaveLength(0)

    view.destroy()
  })

  it('checks clicking on equation environment widget', () => {
    const doc = 'Above\n\\begin{equation}\n  x + y = z\n\\end{equation}\nBelow'
    const view = createEditor(doc, 0)
    expect(getMathWidgets(view)).toHaveLength(1)

    const widgetDom = view.dom.querySelector('.ol-cm-math')
    expect(widgetDom).not.toBeNull()

    if (widgetDom) {
      widgetDom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 50, clientY: 8 }))
    }
    // Should be inside content line 3 and widget removed
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
    expect(getMathWidgets(view)).toHaveLength(0)

    view.destroy()
  })

  it('jumps into and out of inline math with ArrowDown and ArrowUp when column matches', () => {
    const doc = 'Above line of text here\nHere is $x^2 + y^2 = z^2$ formula\nBelow line of text here'
    const view = createEditor(doc, 0)
    expect(getMathWidgets(view)).toHaveLength(1)

    // Position cursor on Line 1 at column 12 (above $x^2 + y^2 = z^2$)
    const line1 = view.state.doc.line(1)
    view.dispatch({ selection: { anchor: line1.from + 12 } })

    // Press ArrowDown -> should jump into the inline math on Line 2
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const posAfterDown = view.state.selection.main.head
    const line2 = view.state.doc.line(2)
    expect(posAfterDown).toBeGreaterThanOrEqual(line2.from + 9) // strictly inside $...$
    expect(posAfterDown).toBeLessThanOrEqual(line2.from + 24)
    expect(getMathWidgets(view)).toHaveLength(0) // Raw LaTeX revealed

    // Press ArrowDown again -> should step out to Line 3
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
    expect(getMathWidgets(view)).toHaveLength(1) // Immediately rendered back to SVG

    // Press ArrowUp -> should jump back into inline math on Line 2
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    const posAfterUp = view.state.selection.main.head
    expect(posAfterUp).toBeGreaterThanOrEqual(line2.from + 9)
    expect(posAfterUp).toBeLessThanOrEqual(line2.from + 24)
    expect(getMathWidgets(view)).toHaveLength(0) // Raw LaTeX revealed

    // Press ArrowUp again -> should step out to Line 1
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1)
    expect(getMathWidgets(view)).toHaveLength(1) // Immediately rendered back to SVG

    view.destroy()
  })

  it('does not jump into inline math if column is outside the math formula', () => {
    const doc = 'Above line of text here\nHere is $x^2 + y^2 = z^2$ formula\nBelow line of text here'
    const view = createEditor(doc, 0)
    expect(getMathWidgets(view)).toHaveLength(1)

    // Position cursor on Line 1 at column 2 (over 'Ab', outside math column 8-25)
    view.dispatch({ selection: { anchor: 2 } })

    // Press ArrowDown -> should land on Line 2 outside math
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2)
    // Widget should remain rendered because cursor is in normal text
    expect(getMathWidgets(view)).toHaveLength(1)

    view.destroy()
  })

  it('jumps into display math with indentation using ArrowDown and ArrowUp', () => {
    const doc = 'Above\n  \\begin{equation}\n    x + y = z\n  \\end{equation}\nBelow'
    const view = createEditor(doc, 2) // Line 1
    expect(getMathWidgets(view)).toHaveLength(1)

    // Arrow down into indented equation
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
    expect(getMathWidgets(view)).toHaveLength(0) // Raw LaTeX revealed

    // Arrow down out to Below (Line 5)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5)
    expect(getMathWidgets(view)).toHaveLength(1) // Immediately rendered back to SVG

    // Arrow up back into indented equation
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
    expect(getMathWidgets(view)).toHaveLength(0) // Raw LaTeX revealed

    // Arrow up back to Above (Line 1)
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1)
    expect(getMathWidgets(view)).toHaveLength(1) // Immediately rendered back to SVG

    view.destroy()
  })

  it('jumps into single-line display math using ArrowDown and ArrowUp', () => {
    const doc = 'Above\n\\[ x = y + z \\]\nBelow'
    const view = createEditor(doc, 2) // Line 1
    expect(getMathWidgets(view)).toHaveLength(1)

    // Arrow down into single-line display math
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2)
    expect(getMathWidgets(view)).toHaveLength(0) // Raw LaTeX revealed

    // Arrow down out to Below
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
    expect(getMathWidgets(view)).toHaveLength(1) // Immediately rendered back to SVG

    // Arrow up into single-line display math
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2)
    expect(getMathWidgets(view)).toHaveLength(0) // Raw LaTeX revealed

    // Arrow up out to Above
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1)
    expect(getMathWidgets(view)).toHaveLength(1) // Immediately rendered back to SVG

    view.destroy()
  })

  it('maintains goalColumn across vertical navigation through math blocks', () => {
    const doc = 'Above line of text here\nHere is $x^2 + y^2 = z^2$ formula\nBelow line of text here'
    const view = createEditor(doc, 0)

    // Position cursor with an explicit goalColumn (e.g. 100px)
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(12, 0, undefined, 100)]),
    })
    expect(view.state.selection.main.goalColumn).toBe(100)

    // Arrow down into inline math
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.selection.main.goalColumn).toBe(100)
    expect(getMathWidgets(view)).toHaveLength(0) // Raw LaTeX revealed

    // Arrow down out to line 3
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(view.state.selection.main.goalColumn).toBe(100)
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
    expect(getMathWidgets(view)).toHaveLength(1) // Restored to SVG

    // Arrow up back into inline math
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(view.state.selection.main.goalColumn).toBe(100)
    expect(getMathWidgets(view)).toHaveLength(0) // Raw LaTeX revealed

    // Arrow up out to line 1
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(view.state.selection.main.goalColumn).toBe(100)
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1)
    expect(getMathWidgets(view)).toHaveLength(1) // Restored to SVG

    view.destroy()
  })

  it('jumps past display math without revealing code when visual.revealCodeOnVerticalJump is false', () => {
    settingsManager.setValue('visual.revealCodeOnVerticalJump', false)
    try {
      // 1. Multiline display math
      const docMulti = 'Above\n\\[\n  x + y = z\n\\]\nBelow'
      const viewMulti = createEditor(docMulti, 2) // Line 1
      expect(getMathWidgets(viewMulti)).toHaveLength(1)

      // Arrow down: skips equation block, lands directly on Line 5 ("Below")
      viewMulti.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(viewMulti.state.doc.lineAt(viewMulti.state.selection.main.head).number).toBe(5)
      expect(getMathWidgets(viewMulti)).toHaveLength(1) // Still rendered as SVG, never expanded

      // Arrow up: skips equation block, lands directly on Line 1 ("Above")
      viewMulti.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      expect(viewMulti.state.doc.lineAt(viewMulti.state.selection.main.head).number).toBe(1)
      expect(getMathWidgets(viewMulti)).toHaveLength(1) // Still rendered as SVG
      viewMulti.destroy()

      // 2. Single-line display math
      const docSingle = 'Above\n\\[ x = y + z \\]\nBelow'
      const viewSingle = createEditor(docSingle, 2) // Line 1
      expect(getMathWidgets(viewSingle)).toHaveLength(1)

      // Arrow down: skips Line 2, lands on Line 3 ("Below")
      viewSingle.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(viewSingle.state.doc.lineAt(viewSingle.state.selection.main.head).number).toBe(3)
      expect(getMathWidgets(viewSingle)).toHaveLength(1)

      // Arrow up: skips Line 2, lands on Line 1 ("Above")
      viewSingle.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      expect(viewSingle.state.doc.lineAt(viewSingle.state.selection.main.head).number).toBe(1)
      expect(getMathWidgets(viewSingle)).toHaveLength(1)
      viewSingle.destroy()
    } finally {
      settingsManager.setValue('visual.revealCodeOnVerticalJump', true)
    }
  })

  it('jumps past inline math without revealing code when visual.revealCodeOnVerticalJump is false', () => {
    settingsManager.setValue('visual.revealCodeOnVerticalJump', false)
    try {
      const doc = 'Above line of text here\nHere is $x^2 + y^2 = z^2$ formula\nBelow line of text here'
      const view = createEditor(doc, 0)
      expect(getMathWidgets(view)).toHaveLength(1)

      // Cursor on Line 1 at col 12 (vertically above math formula)
      const line1 = view.state.doc.line(1)
      view.dispatch({ selection: { anchor: line1.from + 12 } })

      // ArrowDown: lands on Line 2 outside formula without revealing code
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2)
      expect(getMathWidgets(view)).toHaveLength(1) // Remains SVG, not revealed

      // ArrowDown: lands on Line 3
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3)
      expect(getMathWidgets(view)).toHaveLength(1)

      // ArrowUp: lands on Line 2 outside formula without revealing code
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2)
      expect(getMathWidgets(view)).toHaveLength(1)

      // ArrowUp: lands on Line 1
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1)
      expect(getMathWidgets(view)).toHaveLength(1)

      view.destroy()
    } finally {
      settingsManager.setValue('visual.revealCodeOnVerticalJump', true)
    }
  })
})
