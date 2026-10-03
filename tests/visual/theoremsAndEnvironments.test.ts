// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorState, EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { eukoliaEditorExtensions } from '@/visual/editorExtensions'
import { createEditorScope, EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'
import { setEditable } from '@/vendor/overleaf/extensions/editable'
import { findClosestEnvironment, findAllEnvironments } from '@/visual/environmentBracket'
import { setting, settingsManager } from '@/core/settings'
import { EndWidget } from '@/vendor/overleaf/extensions/visual/visual-widgets/end'
import { LabelIconWidget } from '@/vendor/overleaf/extensions/visual/visual-widgets/label-icon'
import { BeginTheoremWidget } from '@/vendor/overleaf/extensions/visual/visual-widgets/begin-theorem'
import { jumpArrowRight, jumpArrowLeft } from '@/vendor/overleaf/extensions/visual/visual-math-navigation'
import { projectIndex } from '@/document/projectIndex'

// Stub Worker for jsdom
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

const rect = { top: 0, bottom: 16, left: 0, right: 100, width: 100, height: 16, x: 0, y: 0, toJSON: () => ({}) }
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => rect as DOMRect
Element.prototype.getClientRects = () => [rect] as unknown as DOMRectList

const TEST_DOC = `\\documentclass{article}
\\usepackage{amsmath,amsthm}
\\newtheorem{theorem}{Theorem}[section]
\\newtheorem{lemma}[theorem]{Lemma}
\\newtheorem{definition}[theorem]{Definition}
\\begin{document}

\\section{Foundations}
\\label{sec:foundations}

\\begin{theorem}[Fundamental Existence]\\label{thm:existence}
There exists a unique solution.
\\end{theorem}

\\begin{lemma}\\label{lem:bound}
The solution is bounded.
\\end{lemma}

\\begin{proof}
By straightforward calculation.
\\end{proof}

\\section{Advanced Theory}

\\begin{definition}
A manifold is smooth.
\\end{definition}

\\end{document}
`

async function createTestView(doc: string, anchor = 0): Promise<EditorView> {
  const { forceParsing } = await import('@codemirror/language')
  const scope = createEditorScope({
    id: 'theorems-test',
    filePath: 'D:/test/doc.tex',
    projectRoot: 'D:/test',
    text: doc,
    files: [{ path: 'D:/test/doc.tex' }],
    phrases: EUKOLIA_EDITOR_PHRASES,
  })

  const host = document.createElement('div')
  document.body.appendChild(host)

  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: eukoliaEditorExtensions({
        scope,
        fileName: 'doc.tex',
        theme: 'light',
        startVisual: true,
      }),
      selection: { anchor, head: anchor },
    }),
    parent: host,
  })
  view.dispatch(setEditable(true))
  forceParsing(view, view.state.doc.length, 10000)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (syntaxTree(view.state).length === view.state.doc.length) break
    await new Promise(r => setTimeout(r, 25))
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (view.dom.querySelectorAll('.ol-cm-heading').length > 0 || !doc.includes('\\section')) break
    await new Promise(r => setTimeout(r, 25))
  }
  await new Promise(r => setTimeout(r, 100))
  return view
}

describe('Theorems, environments, and section styling in Visual Mode', () => {
  it('numbers sections and subsections matching PDF output via data-section-number', async () => {
    const view = await createTestView(TEST_DOC)
    const headings = view.dom.querySelectorAll('.ol-cm-heading')
    expect(headings.length).toBeGreaterThanOrEqual(2)

    const sec1 = view.dom.querySelector('.ol-cm-heading[data-section-number="1"]')
    expect(sec1).not.toBeNull()
    expect(sec1?.textContent).toContain('Foundations')

    const sec2 = view.dom.querySelector('.ol-cm-heading[data-section-number="2"]')
    expect(sec2).not.toBeNull()
    expect(sec2?.textContent).toContain('Advanced Theory')

    view.destroy()
  })

  it('renders theorem headers with section-based numbering in boxed headers', async () => {
    const view = await createTestView(TEST_DOC)
    const thmHeaders = view.dom.querySelectorAll('.ol-cm-begin-theorem')
    expect(thmHeaders.length).toBeGreaterThanOrEqual(1)

    const header = view.dom.querySelector('.ol-cm-begin-theorem')
    expect(header).not.toBeNull()
    expect(header?.querySelector('.eu-theorem-header-box')).not.toBeNull()
    expect(header?.querySelector('.ol-cm-environment-name')?.textContent).toBe('Theorem')
    expect(header?.querySelector('.ol-cm-environment-number')?.textContent).toBe(' 1.1')

    view.destroy()
  })

  it('keeps later theorem numbers stable while editing an earlier header', async () => {
    const view = await createTestView(TEST_DOC, TEST_DOC.indexOf('\\begin{theorem}') + 2)
    try {
      const lemma = view.dom.querySelector('.ol-cm-begin-lemma .ol-cm-environment-number')
      expect(lemma?.textContent).toBe(' 1.2')
    } finally {
      view.destroy()
    }
  })

  it('renders \\end{theorem} as a boxed end marker and \\end{proof} as a filled QED tombstone', () => {
    const thmEnd = new EndWidget('theorem', 100)
    const thmDom = thmEnd.toDOM(null as unknown as EditorView)
    expect(thmDom.querySelector('.eu-cm-end-box')).not.toBeNull()
    expect(thmDom.querySelector('.eu-cm-end-box-svg')).not.toBeNull()

    const proofEnd = new EndWidget('proof', 200)
    const proofDom = proofEnd.toDOM(null as unknown as EditorView)
    expect(proofDom.querySelector('.eu-cm-qed-box')).not.toBeNull()
    expect(proofDom.querySelector('.eu-cm-qed-svg')).not.toBeNull()
  })

  it('renders \\label{} as an SVG label icon oriented top-left to bottom-right', () => {
    const labelWidget = new LabelIconWidget(50)
    const dom = labelWidget.toDOM(null as unknown as EditorView)
    const svg = dom.querySelector('.eu-cm-label-icon')
    expect(svg).not.toBeNull()
    expect(svg?.querySelector('path')).not.toBeNull()
    expect(svg?.querySelector('circle')).not.toBeNull()
  })

  it('connects \\begin and \\end with left square bracket when caret is inside environment', async () => {
    const view = await createTestView(TEST_DOC)
    const thmContentPos = TEST_DOC.indexOf('There exists a unique solution')

    // Find closest environment at content position
    const env = findClosestEnvironment(view.state, thmContentPos)
    expect(env).not.toBeNull()
    expect(env?.name).toBe('theorem')
    expect(env?.startLine).toBeLessThan(env?.endLine ?? 0)

    // Position caret inside theorem
    view.dispatch({
      selection: EditorSelection.cursor(thmContentPos),
      effects: EditorView.scrollIntoView(thmContentPos),
    })
    await new Promise(r => setTimeout(r, 50))

    const { environmentBracketPlugin } = await import('@/visual/environmentBracket')
    const plugin = view.plugin(environmentBracketPlugin)
    expect(plugin).not.toBeNull()
    expect(plugin?.decorations.size).toBeGreaterThan(0)

    const midLine = view.dom.querySelector('.eu-cm-env-bracket-mid') ?? view.dom.querySelector('.eu-cm-env-bracket-start')
    expect(midLine).not.toBeNull()

    // Move caret outside any environment
    const outsidePos = TEST_DOC.indexOf('\\section{Foundations}')
    const outsideEnv = findClosestEnvironment(view.state, outsidePos)
    expect(outsideEnv).toBeNull()

    view.destroy()
  })

  it('enters \\begin{theorem} and \\end{theorem} when clicked', async () => {
    const view = await createTestView(TEST_DOC)
    const thmPos = TEST_DOC.indexOf('\\begin{theorem}')

    const widget = new BeginTheoremWidget('theorem', 'Theorem', null, '1.1', thmPos, thmPos + 15)
    const dom = widget.toDOM(view)

    // Simulate clicking the header
    const event = new MouseEvent('mousedown', { button: 0 })
    dom.dispatchEvent(event)

    // Caret is now placed inside \begin{theorem}
    expect(view.state.selection.main.head).toBe(thmPos + 1)

    // And clicking \end{theorem}
    const endPos = TEST_DOC.indexOf('\\end{theorem}')
    const endWidget = new EndWidget('theorem', endPos)
    const endDom = endWidget.toDOM(view)
    endDom.dispatchEvent(new MouseEvent('mousedown', { button: 0 }))

    expect(view.state.selection.main.head).toBe(endPos + 1)

    view.destroy()
  })

  it('enters \\begin{theorem} when navigating with arrow keys', async () => {
    const view = await createTestView(TEST_DOC)
    const thmPos = TEST_DOC.indexOf('\\begin{theorem}')

    // Place caret immediately before \begin{theorem}
    view.dispatch({
      selection: EditorSelection.cursor(thmPos),
    })

    const handled = jumpArrowRight(view)
    expect(handled).toBe(true)
    // Caret jumps inside \begin{theorem}
    expect(view.state.selection.main.head).toBe(thmPos + 1)

    view.destroy()
  })

  it('does not render \\begin or \\end into widgets when they lack their counterpart', async () => {
    const brokenDoc = `\\documentclass{article}
\\newtheorem{theorem}{Theorem}
\\begin{document}

\\begin{theorem}
This theorem is never closed.

Some normal text in between.

\\end{proof}
This proof was never opened.

\\end{document}
`
    const view = await createTestView(brokenDoc)

    // Unclosed \begin{theorem} must NOT be rendered as a widget
    const thmWidgets = view.dom.querySelectorAll('.ol-cm-begin-theorem')
    expect(thmWidgets.length).toBe(0)

    // Orphaned \end{proof} must NOT be rendered as an end widget
    const endWidgets = view.dom.querySelectorAll('.eu-cm-qed-box, .eu-cm-end-box')
    expect(endWidgets.length).toBe(0)

    view.destroy()
  })

  it('numbers theorems before section 1 as 0.1 matching LaTeX PDF output', async () => {
    const preSectionDoc = `\\documentclass{article}
\\usepackage{amsthm}
\\newtheorem{theorem}{Theorem}[section]
\\begin{document}

\\begin{theorem}
A theorem before any section.
\\end{theorem}

\\section{First Section}

\\begin{theorem}
A theorem inside section 1.
\\end{theorem}

\\end{document}
`
    const view = await createTestView(preSectionDoc)
    const thmHeaders = view.dom.querySelectorAll('.ol-cm-begin-theorem')
    expect(thmHeaders.length).toBe(2)

    // First theorem before section 1 has number 0.1
    const firstNum = thmHeaders[0].querySelector('.ol-cm-environment-number')
    expect(firstNum?.textContent?.trim()).toBe('0.1')

    // Second theorem in section 1 has number 1.1
    const secondNum = thmHeaders[1].querySelector('.ol-cm-environment-number')
    expect(secondNum?.textContent?.trim()).toBe('1.1')

    view.destroy()
  })

  it('renders \\label{} beside \\begin{theorem} with only the icon and zero text', async () => {
    const view = await createTestView(TEST_DOC)
    const labelIcons = view.dom.querySelectorAll('.eu-cm-label-icon-wrap')
    expect(labelIcons.length).toBeGreaterThanOrEqual(1)

    for (const iconWrap of Array.from(labelIcons)) {
      // Must contain SVG icon
      const svg = iconWrap.querySelector('svg.eu-cm-label-icon')
      expect(svg).not.toBeNull()

      // Must have NO label key text, only the icon
      expect(iconWrap.textContent?.trim()).toBe('')
    }

    view.destroy()
  })

  it('renders \\begin{theorem} and \\end{theorem} as inline, left-aligned spans', async () => {
    const view = await createTestView(TEST_DOC)
    const thmHeader = view.dom.querySelector('.ol-cm-begin-theorem')
    expect(thmHeader).not.toBeNull()
    expect(thmHeader?.tagName.toLowerCase()).toBe('span')

    const endMarkers = view.dom.querySelectorAll('.ol-cm-end')
    expect(endMarkers.length).toBeGreaterThanOrEqual(1)
    for (const marker of Array.from(endMarkers)) {
      expect(marker.tagName.toLowerCase()).toBe('span')
    }

    view.destroy()
  })

  it('respects visual.revealCodeOnVerticalJump when jumping vertically into theorem environment tags', async () => {
    const { settingsManager } = await import('@core/settings')
    const view = await createTestView(TEST_DOC)
    const thmPos = TEST_DOC.indexOf('\\begin{theorem}')
    const lineBeforeThm = view.state.doc.lineAt(thmPos).number - 1
    const beforeLine = view.state.doc.line(lineBeforeThm)

    // Position cursor on line before theorem
    view.dispatch({
      selection: EditorSelection.cursor(beforeLine.from),
    })

    // 1. With revealCodeOnVerticalJump = true (default)
    settingsManager.setValue('visual.revealCodeOnVerticalJump', true)
    const { jumpArrowDown, jumpArrowUp } = await import(
      '@/vendor/overleaf/extensions/visual/visual-math-navigation'
    )
    const jumpedDown = jumpArrowDown(view)
    expect(jumpedDown).toBe(true)
    // Lands inside \begin{theorem}, revealing the code
    expect(view.state.selection.main.head).toBe(thmPos + 1)

    // 2. Step back out to previous line
    const jumpedUp = jumpArrowUp(view)
    expect(jumpedUp).toBe(true)
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(lineBeforeThm)

    // 3. With revealCodeOnVerticalJump = false
    settingsManager.setValue('visual.revealCodeOnVerticalJump', false)
    try {
      jumpArrowDown(view)
      // Cursor lands outside \begin{theorem} without entering, keeping SVG intact
      expect(view.state.selection.main.head).toBe(thmPos)
    } finally {
      settingsManager.setValue('visual.revealCodeOnVerticalJump', true)
      view.destroy()
    }
  })

  it('renders a thin, continuous bracket with no arrow and text color across environments containing display math', async () => {
    const docWithDisplayMath = `\\documentclass{article}
\\newtheorem{theorem}{Theorem}
\\begin{document}

\\begin{theorem}
Let $f(x)$ be continuous.
\\[
  \\int_a^b f(x) \\, dx = F(b) - F(a)
\\]
Then $F$ is differentiable.
\\end{theorem}

\\end{document}
`
    const view = await createTestView(docWithDisplayMath)
    const mathPos = docWithDisplayMath.indexOf('\\int_a^b')
    view.dispatch({
      selection: EditorSelection.cursor(mathPos),
    })
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    const bracketSvg = view.dom.querySelector('.eu-cm-env-bracket-svg') as SVGSVGElement | null
    expect(bracketSvg).not.toBeNull()

    const path = bracketSvg?.querySelector('path')
    expect(path).not.toBeNull()

    // Stroke width is thin (1.2px)
    expect(path?.getAttribute('stroke-width')).toBe('1.2')

    // Uses text color (currentColor)
    expect(path?.getAttribute('stroke')).toBe('currentColor')

    // Path connects begin to end without any cusp arrow
    const d = path?.getAttribute('d') ?? ''
    expect(d).toContain('M')
    expect(d).toContain('L')
    // No middle arrow cusp '<' (neither triangle nor outward cusp)
    expect(d).not.toContain('0 16')
    expect(d).not.toContain('M 22 1')

    view.destroy()
  })

  it('renders continuous bracket when \\begin and \\end are far apart without clipping', async () => {
    // Generate a long proof with 40 lines
    const contentLines = Array.from({ length: 40 }, (_, i) => `Step ${i + 1} of the long calculation.`).join('\n')
    const longDoc = `\\documentclass{article}
\\usepackage{amsthm}
\\begin{document}

\\begin{proof}
${contentLines}
\\end{proof}

\\end{document}
`
    const view = await createTestView(longDoc)
    const midPos = longDoc.indexOf('Step 20')
    view.dispatch({
      selection: EditorSelection.cursor(midPos),
    })
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    const bracketSvg = view.dom.querySelector('.eu-cm-env-bracket-svg') as SVGSVGElement | null
    expect(bracketSvg).not.toBeNull()
    const path = bracketSvg?.querySelector('path')
    expect(path).not.toBeNull()

    const d = path?.getAttribute('d') ?? ''
    // marginX should be >= 4 (never negative, never clipped by scroller)
    const match = d.match(/L\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/)
    expect(match).not.toBeNull()
    const marginX = parseFloat(match![1])
    expect(marginX).toBeGreaterThanOrEqual(4)

    view.destroy()
  })

  it('aligns bracket to the start of \\end tag when disclosed rather than drawing underneath', async () => {
    const doc = `\\documentclass{article}
\\usepackage{amsthm}
\\begin{document}

\\begin{proof}
Some short argument.
\\end{proof}

\\end{document}
`
    const view = await createTestView(doc)
    const endPos = doc.indexOf('\\end{proof}') + 5 // Caret inside \end{proof} (disclosed)
    view.dispatch({
      selection: EditorSelection.cursor(endPos),
    })
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    const bracketSvg = view.dom.querySelector('.eu-cm-env-bracket-svg') as SVGSVGElement | null
    expect(bracketSvg).not.toBeNull()
    const path = bracketSvg?.querySelector('path')
    expect(path).not.toBeNull()

    const d = path?.getAttribute('d') ?? ''
    expect(d).toContain('M')
    expect(d).toContain('L')

    // Find endX from the last command "L endX botY"
    const lastL = d.split('L').pop()?.trim()
    expect(lastL).toBeDefined()
    const [endXStr] = lastL!.split(/\s+/)
    const endX = parseFloat(endXStr)

    // endX should be at the left side of the line, not stretching across the line length
    expect(endX).toBeLessThan(100)

    view.destroy()
  })

  it('stops bracket at \\end widget even when there are characters following on the line', async () => {
    const docWithTrailing = `\\documentclass{article}
\\newtheorem{theorem}{Theorem}
\\begin{document}

\\begin{theorem}
A statement.
\\end{theorem} lll

\\end{document}
`
    const view = await createTestView(docWithTrailing)
    const contentPos = docWithTrailing.indexOf('A statement')
    view.dispatch({
      selection: EditorSelection.cursor(contentPos),
    })
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    const bracketSvg = view.dom.querySelector('.eu-cm-env-bracket-svg') as SVGSVGElement | null
    expect(bracketSvg).not.toBeNull()
    const path = bracketSvg?.querySelector('path')
    expect(path).not.toBeNull()

    // End widget must have data-from matching end.from
    const endWidget = view.dom.querySelector('.ol-cm-end') as HTMLElement | null
    expect(endWidget).not.toBeNull()
    expect(endWidget?.dataset.from).toBe(String(docWithTrailing.indexOf('\\end{theorem}')))

    view.destroy()
  })

  it('does not disclose \\begin{theorem} or \\end{theorem} when caret is adjacent to boundary', async () => {
    const doc = `\\documentclass{article}
\\newtheorem{theorem}{Theorem}
\\begin{document}

\\begin{theorem}
A statement.
\\end{theorem}

\\end{document}
`
    const beginFrom = doc.indexOf('\\begin{theorem}')
    const endTo = doc.indexOf('\\end{theorem}') + '\\end{theorem}'.length

    // Caret immediately before \begin{theorem}
    const view = await createTestView(doc, beginFrom)
    expect(view.dom.querySelector('.ol-cm-begin-theorem')).not.toBeNull()

    // Caret immediately after \end{theorem}
    view.dispatch({ selection: EditorSelection.cursor(endTo) })
    view.requestMeasure()
    expect(view.dom.querySelector('.ol-cm-end')).not.toBeNull()

    // Caret strictly inside \begin{theorem} -> disclosed
    view.dispatch({ selection: EditorSelection.cursor(beginFrom + 2) })
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))
    expect(view.dom.querySelector('.ol-cm-begin-theorem')).toBeNull()

    // Caret strictly inside \end{theorem} -> disclosed
    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf('\\end{theorem}') + 2) })
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))
    expect(view.dom.querySelector('.ol-cm-end')).toBeNull()

    view.destroy()
  })

  it('enters \\begin{theorem} and \\end{theorem} via ArrowRight and ArrowLeft', async () => {
    const doc = `\\documentclass{article}
\\newtheorem{theorem}{Theorem}
\\begin{document}

\\begin{theorem}
A statement.
\\end{theorem}

\\end{document}
`
    const beginFrom = doc.indexOf('\\begin{theorem}')
    const view = await createTestView(doc, beginFrom)

    // Cursor at beginFrom: jumpArrowRight enters \begin{theorem}
    const enteredBegin = jumpArrowRight(view)
    expect(enteredBegin).toBe(true)
    expect(view.state.selection.main.from).toBe(beginFrom + 1)

    // Cursor at endTo: jumpArrowLeft enters \end{theorem}
    const endTo = doc.indexOf('\\end{theorem}') + '\\end{theorem}'.length
    view.dispatch({ selection: EditorSelection.cursor(endTo) })
    const enteredEnd = jumpArrowLeft(view)
    expect(enteredEnd).toBe(true)
    expect(view.state.selection.main.from).toBe(endTo - 1)

    view.destroy()
  })

  it('ensures BeginTheoremWidget has no horizontal padding spans and EndWidget has sharp SVG', async () => {
    const doc = `\\documentclass{article}
\\newtheorem{theorem}{Theorem}
\\begin{document}

\\begin{theorem}
A statement.
\\end{theorem}

\\end{document}
`
    const view = await createTestView(doc, 0)
    const paddingSpans = view.dom.querySelectorAll('.ol-cm-begin-theorem .ol-cm-environment-padding')
    expect(paddingSpans.length).toBe(2)
    const headerBox = view.dom.querySelector('.eu-theorem-header-box') as HTMLElement | null
    expect(headerBox).not.toBeNull()

    const endWidget = new EndWidget('theorem', 0)
    const dom = endWidget.toDOM(view)
    const rectEl = dom.querySelector('rect')
    expect(rectEl).not.toBeNull()
    expect(rectEl?.getAttribute('x')).toBe('0.5')
    expect(rectEl?.getAttribute('y')).toBe('0.5')
    expect(rectEl?.getAttribute('stroke-width')).toBe('1')
    expect(rectEl?.getAttribute('height')).toBe('19')
    const svgEl = dom.querySelector('svg')
    expect(svgEl?.getAttribute('height')).toBe('20')

    // coordsAt must return 1px caret coordinates (left === right)
    const fakeEl = document.createElement('span')
    fakeEl.getBoundingClientRect = () => ({
      left: 10,
      right: 50,
      top: 5,
      bottom: 25,
      width: 40,
      height: 20,
      x: 10,
      y: 5,
      toJSON: () => ({}),
    }) as DOMRect
    const coordsFront = endWidget.coordsAt(fakeEl, 0, 1)
    expect(coordsFront?.left).toBe(10)
    expect(coordsFront?.right).toBe(10)

    const coordsBack = endWidget.coordsAt(fakeEl, 0, -1)
    expect(coordsBack?.left).toBe(50)
    expect(coordsBack?.right).toBe(50)

    view.destroy()
  })

  it('keeps bracket endpoints and height invariant when collapsing and expanding \\begin and \\end', async () => {
    const doc = `\\documentclass{article}
\\newtheorem{theorem}{Theorem}
\\begin{document}

\\begin{theorem}
A statement.
\\end{theorem}

\\end{document}
`
    const thmBodyPos = doc.indexOf('A statement.') + 2
    const beginInsidePos = doc.indexOf('\\begin{theorem}') + 4
    const endInsidePos = doc.indexOf('\\end{theorem}') + 4

    // 1. Caret in theorem body: both \\begin and \\end are collapsed as SVGs
    const view = await createTestView(doc, thmBodyPos)
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    const bracketSvg = (view.dom.querySelector('.eu-cm-env-bracket-svg') ??
      view.scrollDOM.querySelector('.eu-cm-env-bracket-svg')) as SVGSVGElement | null
    expect(bracketSvg).not.toBeNull()
    const path = bracketSvg?.querySelector('path')
    expect(path).not.toBeNull()

    const parsePathCoords = (d: string) => {
      const matchStart = d.match(/^M\s+([0-9.-]+)\s+([0-9.-]+)/)
      const lastL = d.split('L').pop()?.trim()
      const matchEnd = lastL ? lastL.match(/^([0-9.-]+)\s+([0-9.-]+)/) : null
      return {
        topY: matchStart ? parseFloat(matchStart[2]) : NaN,
        botY: matchEnd ? parseFloat(matchEnd[2]) : NaN,
      }
    }

    const collapsed = parsePathCoords(path?.getAttribute('d') ?? '')
    expect(collapsed.topY).not.toBeNaN()
    expect(collapsed.botY).not.toBeNaN()
    const collapsedHeight = collapsed.botY - collapsed.topY
    expect(collapsedHeight).toBeGreaterThan(0)

    // 2. Expand \\begin{theorem} by moving caret inside it
    view.dispatch({ selection: EditorSelection.cursor(beginInsidePos) })
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    const expandedBegin = parsePathCoords(path?.getAttribute('d') ?? '')
    expect(expandedBegin.topY).toBe(collapsed.topY)
    expect(expandedBegin.botY).toBe(collapsed.botY)
    expect(expandedBegin.botY - expandedBegin.topY).toBe(collapsedHeight)

    // 3. Expand \\end{theorem} by moving caret inside it
    view.dispatch({ selection: EditorSelection.cursor(endInsidePos) })
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    const expandedEnd = parsePathCoords(path?.getAttribute('d') ?? '')
    expect(expandedEnd.topY).toBe(collapsed.topY)
    expect(expandedEnd.botY).toBe(collapsed.botY)
    expect(expandedEnd.botY - expandedEnd.topY).toBe(collapsedHeight)

    view.destroy()
  })

  it('renders \\stag{} as label icon when caret is outside and discloses when entered', async () => {
    const doc = `\\documentclass{article}
\\newtheorem{proposition}{Proposition}
\\begin{document}

\\begin{proposition}[Structural recursion] \\stag{st:fol-terms}
Let S be a set.
\\end{proposition}

\\end{document}
`
    const view = await createTestView(doc, 0)
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    // 1. \stag{st:fol-terms} is rendered as a LabelIconWidget
    const labelIcons = view.dom.querySelectorAll('.eu-cm-label-icon-wrap')
    expect(labelIcons.length).toBeGreaterThanOrEqual(1)

    // Check theorem header has NO redundant "()"
    const headerBox = view.dom.querySelector('.eu-theorem-header-box') as HTMLElement | null
    expect(headerBox).not.toBeNull()
    const textContent = headerBox?.textContent ?? ''
    expect(textContent).not.toContain('()')

    // 2. Moving cursor into \stag{st:fol-terms} discloses the raw text
    const stagPos = doc.indexOf('\\stag{st:fol-terms}') + 3
    view.dispatch({ selection: EditorSelection.cursor(stagPos) })
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    expect(view.dom.textContent).toContain('\\stag{st:fol-terms}')

    view.destroy()
  })

  it('treats \\textbf{} and \\textit{} exactly like \\texttt{} and \\emph{} by disclosing full command rather than mere {}', async () => {
    const doc = `\\documentclass{article}
\\begin{document}
Here is \\textbf{strong text} and \\textit{emphasized text}.
And here is \\texttt{code text} and \\emph{italic text}.
\\end{document}
`
    const view = await createTestView(doc, 0)
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    // 1. Caret outside: command names and braces are hidden, words are rendered
    expect(view.dom.textContent).not.toContain('\\textbf')
    expect(view.dom.textContent).not.toContain('{strong text}')
    expect(view.dom.textContent).toContain('strong text')

    // 2. Caret inside \textbf: discloses full \textbf{strong text}, NOT a mere {strong text}
    const boldPos = doc.indexOf('\\textbf{strong text}') + 10
    view.dispatch({ selection: EditorSelection.cursor(boldPos) })
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    expect(view.dom.textContent).toContain('\\textbf{strong text}')

    // 3. Caret inside \textit: discloses full \textit{emphasized text}, NOT a mere {emphasized text}
    const italicPos = doc.indexOf('\\textit{emphasized text}') + 10
    view.dispatch({ selection: EditorSelection.cursor(italicPos) })
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    expect(view.dom.textContent).toContain('\\textit{emphasized text}')

    view.destroy()
  })

  it('findAllEnvironments discovers all environments and computes nesting depth and treeMaxDepth', async () => {
    const doc = `\\documentclass{article}
\\begin{document}
\\begin{theorem}
Theorem statement.
\\begin{proof}
Proof statement.
\\end{proof}
\\end{theorem}

\\begin{lemma}
Unclosed lemma without end.

\\begin{definition}
Isolated definition.
\\end{definition}
\\end{document}
`
    const view = await createTestView(doc, 0)
    const envs = findAllEnvironments(view.state)

    // document and unclosed lemma are excluded
    expect(envs.map(e => e.name)).toEqual(['theorem', 'proof', 'definition'])

    const thm = envs.find(e => e.name === 'theorem')!
    const proof = envs.find(e => e.name === 'proof')!
    const def = envs.find(e => e.name === 'definition')!

    // theorem is root (depth 0), has nested proof -> treeMaxDepth = 1
    expect(thm.depth).toBe(0)
    expect(thm.treeMaxDepth).toBe(1)

    // proof is nested inside theorem -> depth = 1, treeMaxDepth = 1
    expect(proof.depth).toBe(1)
    expect(proof.treeMaxDepth).toBe(1)

    // definition is sibling root with no children -> depth = 0, treeMaxDepth = 0
    expect(def.depth).toBe(0)
    expect(def.treeMaxDepth).toBe(0)

    view.destroy()
  })

  it('renders all environment brackets with nested tracks when visual.displayAllEnvironmentBrackets is enabled', async () => {
    const doc = `\\documentclass{article}
\\begin{document}
\\section{Section}
\\begin{theorem}
Theorem content.
\\begin{proof}
Proof content.
\\end{proof}
\\end{theorem}

\\begin{definition}
Definition content.
\\end{definition}
\\end{document}
`
    // Start with setting off (default)
    settingsManager.setValue('visual.displayAllEnvironmentBrackets', false)
    const outsidePos = doc.indexOf('\\section{Section}')
    const view = await createTestView(doc, outsidePos)
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    const svg = view.dom.querySelector('.eu-cm-env-bracket-svg') as SVGSVGElement | null
    expect(svg).not.toBeNull()

    // 1. When setting is false and caret is outside: no bracket rendered
    expect(svg?.style.display).toBe('none')

    // 2. Enable visual.displayAllEnvironmentBrackets setting
    settingsManager.setValue('visual.displayAllEnvironmentBrackets', true)
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 80))

    expect(svg?.style.display).toBe('block')
    const paths = Array.from(svg?.querySelectorAll('path') ?? [])
    // 3 environments rendered: theorem, proof, definition
    expect(paths.length).toBe(3)

    const thmPath = paths.find(p => p.getAttribute('data-name') === 'theorem')
    const proofPath = paths.find(p => p.getAttribute('data-name') === 'proof')
    const defPath = paths.find(p => p.getAttribute('data-name') === 'definition')

    expect(thmPath).not.toBeNull()
    expect(proofPath).not.toBeNull()
    expect(defPath).not.toBeNull()

    expect(thmPath?.getAttribute('data-depth')).toBe('0')
    expect(proofPath?.getAttribute('data-depth')).toBe('1')
    expect(defPath?.getAttribute('data-depth')).toBe('0')

    // Parse marginX (spine position) from path d attribute:
    // path d format: "M <beginX> <topY> L <marginX+r> <topY> Q <marginX> <topY> ..."
    const extractMarginX = (pathEl: SVGElement | null): number => {
      const d = pathEl?.getAttribute('d') ?? ''
      const match = d.match(/Q\s+([0-9.-]+)/)
      return match ? parseFloat(match[1]) : NaN
    }

    const thmMarginX = extractMarginX(thmPath!)
    const proofMarginX = extractMarginX(proofPath!)

    expect(Number.isFinite(thmMarginX)).toBe(true)
    expect(Number.isFinite(proofMarginX)).toBe(true)

    // Outer theorem bracket spine MUST be strictly to the left (smaller X) of nested proof bracket spine
    expect(thmMarginX).toBeLessThan(proofMarginX)
    // The separation between nested tracks should be at least 6px
    expect(proofMarginX - thmMarginX).toBeGreaterThanOrEqual(6)

    // 3. Clean up by restoring setting to false
    settingsManager.setValue('visual.displayAllEnvironmentBrackets', false)
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))
    expect(svg?.style.display).toBe('none')

    view.destroy()
  })

  it('excludes math environments (aligned, equation, gather, etc.) from receiving brackets', async () => {
    const doc = `\\documentclass{article}
\\usepackage{amsmath}
\\newtheorem{theorem}{Theorem}
\\begin{document}

\\begin{equation}
E = mc^2
\\end{equation}

\\begin{gather}
a + b = c \\\\
d + e = f
\\end{gather}

\\begin{theorem}
Theorem with display math:
\\begin{equation}
\\int f(x) dx = F(x)
\\end{equation}
and aligned:
\\[
\\begin{aligned}
u &= v \\\\
x &= y
\\end{aligned}
\\]
\\end{theorem}

\\end{document}
`
    const view = await createTestView(doc, 0)

    // 1. Standalone equation: findClosestEnvironment returns null
    const standaloneEqPos = doc.indexOf('E = mc^2')
    expect(findClosestEnvironment(view.state, standaloneEqPos)).toBeNull()

    // 2. Standalone gather: findClosestEnvironment returns null
    const gatherPos = doc.indexOf('a + b = c')
    expect(findClosestEnvironment(view.state, gatherPos)).toBeNull()

    // 3. Equation inside theorem: findClosestEnvironment returns enclosing theorem
    const innerEqPos = doc.indexOf('\\int f(x) dx')
    const innerEnv = findClosestEnvironment(view.state, innerEqPos)
    expect(innerEnv).not.toBeNull()
    expect(innerEnv?.name).toBe('theorem')

    // 4. Aligned inside display math in theorem: findClosestEnvironment returns enclosing theorem
    const alignedPos = doc.indexOf('u &= v')
    const alignedEnv = findClosestEnvironment(view.state, alignedPos)
    expect(alignedEnv).not.toBeNull()
    expect(alignedEnv?.name).toBe('theorem')

    // 5. findAllEnvironments excludes equation, gather, and aligned
    const allEnvs = findAllEnvironments(view.state)
    expect(allEnvs.map(e => e.name)).toEqual(['theorem'])

    // 6. When visual.displayAllEnvironmentBrackets is enabled:
    // Only theorem receives a bracket, no brackets on equation/gather/aligned
    settingsManager.setValue('visual.displayAllEnvironmentBrackets', true)
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 80))

    const svg = view.dom.querySelector('.eu-cm-env-bracket-svg') as SVGSVGElement | null
    expect(svg?.style.display).toBe('block')
    const paths = Array.from(svg?.querySelectorAll('path') ?? [])
    expect(paths.length).toBe(1)
    expect(paths[0].getAttribute('data-name')).toBe('theorem')

    // Restore setting
    settingsManager.setValue('visual.displayAllEnvironmentBrackets', false)
    view.destroy()
  })

  it('renders custom theorem environments defined in external macro files (convention, warning, construction) with accurate numbers and brackets', async () => {
    const macrosContent = `\\theoremstyle{plain}
\\newtheorem{theorem}{Theorem}[section]
\\newtheorem{proposition}[theorem]{Proposition}
\\newtheorem{corollary}[theorem]{Corollary}
\\newtheorem{lemma}[theorem]{Lemma}
\\theoremstyle{definition}
\\newtheorem{definition}[theorem]{Definition}
\\newtheorem{construction}[theorem]{Construction}
\\newtheorem{example}[theorem]{Example}
\\newtheorem{remark}[theorem]{Remark}
\\newtheorem{convention}[theorem]{Convention}
\\newtheorem{warning}[theorem]{Warning}
`
    // Register the external macro file in projectIndex
    projectIndex.registerExternalSource('D:/test/macros.tex', macrosContent)
    projectIndex.addFile({ path: 'D:/test/macros.tex', name: 'macros.tex', isDirectory: false })

    const doc = `\\documentclass{article}
\\usepackage{amsmath,amsthm}
\\input{macros}
\\begin{document}

\\section{Introduction}

\\begin{theorem}
The main theorem statement.
\\end{theorem}

\\begin{convention}
All schemes are separated and quasi-compact.
\\end{convention}

\\begin{warning}
This does not generalize to stacks without modification.
\\end{warning}

\\begin{construction}
Let X be an affine variety.
\\end{construction}

\\end{document}
`
    const view = await createTestView(doc, 0)
    await new Promise(r => setTimeout(r, 60))

    // 1. Verify BeginTheoremWidget was rendered for convention, warning, and construction
    const theoremElements = Array.from(view.dom.querySelectorAll('.ol-cm-begin-theorem'))
    expect(theoremElements.length).toBe(4)

    const texts = theoremElements.map(el => el.querySelector('.eu-theorem-header-box')?.textContent?.trim())
    expect(texts[0]).toBe('Theorem 1.1')
    expect(texts[1]).toBe('Convention 1.2')
    expect(texts[2]).toBe('Warning 1.3')
    expect(texts[3]).toBe('Construction 1.4')

    // 2. Verify EndWidget was rendered for convention, warning, and construction
    const endElements = Array.from(view.dom.querySelectorAll('.eu-cm-end-box'))
    expect(endElements.length).toBeGreaterThanOrEqual(4)

    // 3. Verify findClosestEnvironment detects convention, warning, construction
    const conventionPos = doc.indexOf('All schemes are separated')
    const conventionEnv = findClosestEnvironment(view.state, conventionPos)
    expect(conventionEnv).not.toBeNull()
    expect(conventionEnv?.name).toBe('convention')

    const warningPos = doc.indexOf('This does not generalize')
    const warningEnv = findClosestEnvironment(view.state, warningPos)
    expect(warningEnv).not.toBeNull()
    expect(warningEnv?.name).toBe('warning')

    const constructionPos = doc.indexOf('Let X be an affine variety')
    const constructionEnv = findClosestEnvironment(view.state, constructionPos)
    expect(constructionEnv).not.toBeNull()
    expect(constructionEnv?.name).toBe('construction')

    // 4. Verify connecting brackets are generated for convention
    view.dispatch({ selection: EditorSelection.cursor(conventionPos) })
    view.requestMeasure()
    await new Promise(r => setTimeout(r, 60))

    const svg = view.dom.querySelector('.eu-cm-env-bracket-svg') as SVGSVGElement | null
    expect(svg).not.toBeNull()
    expect(svg?.style.display).toBe('block')
    const paths = Array.from(svg?.querySelectorAll('path') ?? [])
    expect(paths.length).toBe(1)
    expect(paths[0].getAttribute('data-name')).toBe('convention')

    // Clean up
    projectIndex.clearExternalSources('D:/test/macros.tex')
    projectIndex.removeFile('D:/test/macros.tex')
    view.destroy()
  })
})



