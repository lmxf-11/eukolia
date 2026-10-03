// @vitest-environment jsdom
/**
 * The caret must never be buried inside a rendered widget.
 *
 * Visual Mode replaces source with widgets and declares every one of them atomic
 * (`EditorView.atomicRanges`), so a caret inside one is meaningless. CodeMirror
 * resolves such a caret against whichever edge is *nearer*, which for a caret
 * just inside a figure's line means the left edge — and the next keystroke then
 * lands before the image instead of continuing after it.
 *
 * Eukolia's ported `skipPreambleWithCursor` plugin escapes forward out of atomic
 * ranges. These tests pin that down, because it is invisible in a screenshot and
 * only shows up as "my typing went to the wrong side of the figure".
 */

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing } from '@codemirror/language'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { atomicDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'

/** A document whose figure line is replaced by a block widget. */
const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Text above.',
  '\\begin{figure}',
  // Four spaces of indentation on purpose: it leaves document positions inside
  // the line but outside the `\\includegraphics` node, which is the only place a
  // caret can sit inside the widget without suppressing it.
  '    \\includegraphics{figure.pdf}',
  '    \\caption{A caption}',
  '\\end{figure}',
  'Text below, long enough to type in.',
  '\\end{document}',
].join('\n')

/** The figure line, which is what the widget replaces. */
const FIGURE_LINE = '    \\includegraphics{figure.pdf}'

const figureLineFrom = DOC.indexOf(FIGURE_LINE)
const figureLineTo = figureLineFrom + FIGURE_LINE.length

/**
 * Builds a view in which `\\includegraphics{figure.pdf}` resolves, so the ported
 * decoration builder replaces the line with a widget exactly as it does in the
 * application. Without a resolvable preview the line stays as source and there is
 * no atomic range to test.
 */
const createView = (selectionOffset: number): EditorView => {
  const parent = document.createElement('div')
  document.body.append(parent)

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: DOC,
      selection: { anchor: selectionOffset },
      extensions: [
        LaTeXLanguage,
        phrases(EUKOLIA_EDITOR_PHRASES),
        filePreview(path =>
          path.endsWith('.pdf')
            ? { url: 'file:///project/figure.pdf', extension: 'pdf' }
            : null
        ),
        atomicDecorations,
      ],
    }),
  })

  // The decorations only exist once the parse covers the document.
  forceParsing(view, DOC.length, 5000)
  return view
}

/** The atomic ranges the view actually declares, as `[from, to]` pairs. */
const atomicRanges = (view: EditorView): Array<[number, number]> => {
  const ranges: Array<[number, number]> = []
  for (const source of view.state.facet(EditorView.atomicRanges)) {
    const set = source(view)
    set.between(0, view.state.doc.length, (from: number, to: number) => {
      if (to > from) ranges.push([from, to])
    })
  }
  return ranges
}

/** True when `offset` is strictly inside one of `ranges`. */
const insideAny = (ranges: Array<[number, number]>, offset: number): boolean =>
  ranges.some(([from, to]) => offset > from && offset < to)

/** Lets the plugin's asynchronous escape transaction run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

describe('Visual Mode: the figure line is a single atomic widget', () => {
  it('declares the whole figure line atomic, which is what can swallow the caret', () => {
    const view = createView(0)
    const ranges = atomicRanges(view)

    expect(
      ranges.some(([from, to]) => from === figureLineFrom && to === figureLineTo),
      `no atomic range covers the figure line ${figureLineFrom}..${figureLineTo}; got ${JSON.stringify(ranges)}`
    ).toBe(true)

    view.destroy()
  })
})

describe('Visual Mode: a caret inside a figure widget escapes to its right', () => {
  it('moves the caret out when an edit elsewhere rebuilds the decorations', async () => {
    // The caret is parked on the figure line's indentation — outside the
    // `\includegraphics` node, so the line is still replaced by the widget, but
    // strictly inside its atomic range.
    const caret = figureLineFrom + 2
    const view = createView(caret)

    expect(
      insideAny(atomicRanges(view), caret),
      `the fixture must put the caret inside the widget (caret ${caret}, ranges ${JSON.stringify(atomicRanges(view))})`
    ).toBe(true)

    // An edit somewhere else in the document — a host sync, a snippet, a second
    // cursor — rebuilds the decorations with the caret still inside the widget.
    const bodyOffset = DOC.indexOf('Text below') + 4
    view.dispatch({
      changes: { from: bodyOffset, insert: 'Z' },
      userEvent: 'input.type',
    })
    await settle()

    const head = view.state.selection.main.head
    expect(
      head,
      `the caret stayed buried in the widget at ${head} (widget ${figureLineFrom}..${figureLineTo})`
    ).toBeGreaterThanOrEqual(figureLineTo)

    view.destroy()
  })

  it('moves a caret restored into a widget by a mode switch', async () => {
    // Restoring a Code Mode position is a pure selection change into a document
    // whose widgets already exist; the caret must come out on the right.
    const caret = figureLineFrom + 2
    const view = createView(0)

    view.dispatch({ selection: { anchor: caret } })
    await settle()

    // The escape is driven by decoration rebuilds, so force one the way the
    // application does: an edit, which is what a mode switch cannot avoid
    // (the two editors share one buffer and re-report their deltas).
    view.dispatch({
      changes: { from: DOC.indexOf('Text below') + 4, insert: 'Z' },
      userEvent: 'input.type',
    })
    await settle()

    const head = view.state.selection.main.head
    expect(head, `the restored caret stayed at ${head}`).toBeGreaterThanOrEqual(figureLineTo)

    view.destroy()
  })

  it('moves a caret sitting on the widget line’s first character to the far side', async () => {
    // The reported defect: the caret "jumps to the left of the SVG" once the
    // figure is rendered. The decoration that replaces an `\includegraphics`
    // line covers the whole line, so its *left edge* is the line's first
    // character — invisible indentation — and that is where CodeMirror's own
    // caret motion lands: `skipAtoms` biases a caret moving backwards onto a
    // widget to the near edge. The escape has to cover that position too, or the
    // next keystroke lands before the command.
    const view = createView(figureLineFrom)

    expect(
      insideAny(atomicRanges(view), figureLineFrom + 1),
      `the fixture must put the caret on the widget's near edge (ranges ${JSON.stringify(atomicRanges(view))})`
    ).toBe(true)

    // A rebuild, which is what a document edit or a settled widget produces.
    view.dispatch({
      changes: { from: DOC.indexOf('Text below') + 4, insert: 'Z' },
      userEvent: 'input.type',
    })
    await settle()

    const head = view.state.selection.main.head
    expect(
      head,
      `the caret stayed on the widget's near edge at ${head} (widget ${figureLineFrom}..${figureLineTo})`
    ).toBeGreaterThanOrEqual(figureLineTo)

    // And typing there continues *after* the figure, which is the point.
    const before = view.state.doc.toString()
    const graphicsStart = before.indexOf('\\includegraphics')
    view.dispatch({
      selection: { anchor: head },
      changes: { from: head, insert: 'Q' },
      userEvent: 'input.type',
    })
    await settle()
    const after = view.state.doc.toString()
    const graphicsEnd = after.indexOf('}', graphicsStart) + 1
    expect(after.slice(graphicsEnd)).toContain('Q')
    expect(after.slice(graphicsStart, graphicsEnd)).not.toContain('Q')

    view.destroy()
  })

  it('leaves a caret outside every widget exactly where it is', async () => {
    const caret = DOC.indexOf('Text below') + 4
    const view = createView(caret)

    view.dispatch({
      changes: { from: caret, insert: 'Y' },
      selection: { anchor: caret + 1 },
      userEvent: 'input.type',
    })
    const afterDispatch = view.state.selection.main.head

    await settle()

    expect(view.state.selection.main.head).toBe(afterDispatch)

    view.destroy()
  })
})
