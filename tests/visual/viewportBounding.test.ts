import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { createDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'
import { setProjectMacros } from '@/editor/projectMacros'

/**
 * Bounding the decoration walk to the viewport must change the *cost*, and nothing
 * else.
 *
 * `createDecorations` takes the ranges it is asked about. The application passes a
 * viewport and a test passes nothing — the whole document — and this file is the
 * claim that those two calls agree about everything the viewport contains, and
 * differ only outside it. That is the whole of the change in
 * `atomic-decorations.ts`: on the Stacks project's `cohomology.tex` the
 * whole-document build is 107 ms and a viewport's is a couple, in a frame whose
 * budget is 16 ms.
 *
 * Three things are deliberately still visited outside the requested range, because
 * bounding them would change the *answer* rather than only the cost, and each has a
 * test here:
 *
 *  * `\item` numbering, which is a count from the start of its list;
 *  * the theorem counter, stepped by the chapters and sections above;
 *  * the macro definitions, which a project keeps at the top of the file.
 *
 * **The fixture is deliberately small, and that is a constraint of the grammar
 * rather than of the pass.** CodeMirror's background parser stops after a time
 * budget, so a fixture longer than the budget yields a *partial* tree — and two
 * builds over a partial tree agree about a prefix and nothing else, which is a
 * comparison of two prefixes wearing the clothes of a comparison of two builds.
 * Measured while writing this: a 1 209-line fixture parsed to 3 003 of its 26 249
 * characters. The fixture here is eight chapters and parses to its end.
 */

setProjectMacros({})

/** A document with a real preamble, nested lists, numbered sections and maths. */
const buildDocument = (chapters: number): string => {
  const body: string[] = []
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    body.push(
      `\\chapter{C${chapter}}`,
      `\\section{S${chapter}}`,
      `Text with $a_${chapter}^2$ and \\textbf{bold ${chapter}}.`,
      `\\begin{enumerate}`,
      `\\item First of ${chapter}`,
      `\\item Second of ${chapter}`,
      `\\begin{itemize}`,
      `\\item Nested of ${chapter}`,
      `\\end{itemize}`,
      `\\end{enumerate}`,
      `\\begin{theorem}\\label{thm-${chapter}}`,
      `For every $x$ there is a $y$.`,
      `\\end{theorem}`,
      `\\begin{proof}`,
      `From $x = y$.`,
      `\\end{proof}`,
      `\\[`,
      `  \\sum_{i=1}^{n} i`,
      `\\]`
    )
  }
  return [
    '\\documentclass{article}',
    '\\usepackage{amsmath}',
    '\\newtheorem{theorem}{Theorem}',
    '\\newcommand{\\R}{\\mathbb{R}}',
    '\\begin{document}',
    '\\title{A document}',
    '\\maketitle',
    ...body,
    '\\end{document}',
    ''
  ].join('\n')
}

const createState = (doc: string) =>
  EditorState.create({
    doc,
    extensions: [
      LaTeXLanguage,
      phrases(EUKOLIA_EDITOR_PHRASES),
      filePreview(() => null),
    ],
  })

/** One decoration, flattened to the parts that decide what a reader sees. */
const describeRange = (from: number, to: number, decoration: unknown): string => {
  const spec = (
    decoration as {
      spec?: {
        widget?: unknown
        class?: string
        tagName?: string
        block?: boolean
      }
    }
  ).spec
  const widget = spec?.widget as { constructor: { name: string } } | undefined
  const kind = widget
    ? `widget:${widget.constructor.name}`
    : spec?.class
      ? `class:${spec.class}`
      : spec?.tagName
        ? `tag:${spec.tagName}`
        : 'replace'
  return `${kind}[${from},${to}]${spec?.block ? ':block' : ''}`
}

type DecorationSetLike = {
  between: (
    from: number,
    to: number,
    fn: (from: number, to: number, decoration: unknown) => void
  ) => void
}

const collect = (set: DecorationSetLike, from: number, to: number): string[] => {
  const found: string[] = []
  set.between(from, to, (rangeFrom, rangeTo, decoration) => {
    found.push(describeRange(rangeFrom, rangeTo, decoration))
  })
  return found
}

/** The `start` attribute on the list markup, which is the item's ordinal. */
const ordinalsIn = (
  set: DecorationSetLike,
  from: number,
  to: number
): string[] => {
  const found: string[] = []
  set.between(from, to, (_from, _to, decoration) => {
    const start = (
      decoration as { spec?: { attributes?: Record<string, string> } }
    ).spec?.attributes?.start
    if (start) found.push(start)
  })
  return found
}

/**
 * The line number of the first second-item ordinal at or after `from`.
 *
 * A search rather than an offset, because the fixture's shape is not the pass's
 * contract: what is being tested is that the walk numbers an item it reaches without
 * having started at the top, and which line that turns out to be is the fixture's
 * business.
 */
const nearestSecondItemLine = (
  set: DecorationSetLike,
  from: number,
  state: EditorState,
  into: () => void
): number => {
  let found = -1
  set.between(from, state.doc.length, (rangeFrom, _to, decoration) => {
    const start = (
      decoration as { spec?: { attributes?: Record<string, string> } }
    ).spec?.attributes?.start
    if (start === '2' && found < 0) found = state.doc.lineAt(rangeFrom).number
  })
  into()
  return found
}

describe('a viewport-bounded build says the same thing about the viewport', () => {
  const source = buildDocument(8)
  const state = createState(source)
  const parsed = ensureSyntaxTree(state, state.doc.length, 10000) ?? syntaxTree(state)

  it('has a fixture the parser finishes, or the comparison means nothing', () => {
    expect(parsed.length).toBe(state.doc.length)
    expect(state.doc.lines).toBeGreaterThan(100)
  })

  it('agrees with the whole-document build, range for range, inside the viewport', () => {
    // Deep in the document: a real prefix to accumulate through, which is the part
    // of the cost the bound does not remove and must not get wrong.
    const middle = Math.floor(state.doc.lines / 2)
    const first = state.doc.line(middle)
    const last = state.doc.line(middle + 20)
    const viewport = [{ from: first.from, to: last.to }]

    const whole = createDecorations(state, parsed, [])
    const bounded = createDecorations(state, parsed, viewport)

    const inViewportWhole = collect(whole.decorations, first.from, last.to)
    const inViewportBounded = collect(bounded.decorations, first.from, last.to)

    expect(inViewportBounded.length).toBeGreaterThan(0)
    expect(inViewportBounded).toEqual(inViewportWhole)

    // And the saving: the bounded set says nothing outside the viewport except the
    // whole-document pieces it is required to keep — the collapsed preamble, and the
    // first and last lines of it that carry the block's edge styling.
    const wholeCount = collect(whole.decorations, 0, state.doc.length).length
    const boundedCount = collect(bounded.decorations, 0, state.doc.length).length
    expect(boundedCount).toBeLessThan(wholeCount / 2)

    // And the cost: the bound has to be worth having, not merely correct.
    const time = (fn: () => unknown): number => {
      fn()
      const started = performance.now()
      for (let index = 0; index < 10; index += 1) fn()
      return (performance.now() - started) / 10
    }
    const wholeMs = time(() => createDecorations(state, parsed, []))
    const boundedMs = time(() => createDecorations(state, parsed, viewport))

    // eslint-disable-next-line no-console
    console.log(
      [
        `fixture: ${state.doc.lines} lines, ${source.length} chars`,
        `whole-document ranges: ${wholeCount} in ${wholeMs.toFixed(2)} ms`,
        `viewport ranges: ${boundedCount} in ${boundedMs.toFixed(2)} ms (20 lines in the middle)`,
        `  -> ${(wholeMs / Math.max(boundedMs, 0.001)).toFixed(1)}x less work per rebuild`,
      ].join('\n')
    )

    // Wall-clock timings are diagnostic only: parallel native-render tests can
    // deschedule this worker. The range-count bound above measures saved work.
  })

  it('gives the same answer whether the context was scanned or replayed', () => {
    /*
     * The checkpoint cache replays from a boundary it has already counted rather than
     * walking from position 0 again, and that is only sound if the replay produces
     * exactly what the full pass would have. Everything the walk accumulates is
     * monotone in the document position except the list nesting, which the context
     * carries in its own stacks — so this is the test that says the two are the same
     * function and not merely similar ones.
     *
     * The buildings are each built **thrice**: once cold, once after a neighbour has
     * been built (so a checkpoint exists to replay from), and once again for the same
     * boundary (so the cache is hit outright). All three have to agree, and `\item`
     * numbering is what notices when they do not.
     */
    const line = (number: number) => {
      const at = state.doc.line(number)
      return { from: at.from, to: at.to }
    }
    const atLine = (number: number) =>
      ordinalsIn(
        createDecorations(state, parsed, [line(number)]).decorations,
        line(number).from,
        line(number).to
      )

    // A line in the second half of the document, so a replay has real ground to cross.
    const secondItems: number[] = []
    const wholeSet = createDecorations(state, parsed, []).decorations
    wholeSet.between(0, state.doc.length, (from, _to, decoration) => {
      const start = (
        decoration as { spec?: { attributes?: Record<string, string> } }
      ).spec?.attributes?.start
      if (start === '2') secondItems.push(state.doc.lineAt(from).number)
    })
    expect(secondItems.length).toBeGreaterThan(0)
    const target = secondItems[secondItems.length - 1]

    const cold = atLine(target)
    // A neighbour first, which is what leaves a checkpoint behind.
    atLine(Math.max(1, target - 3))
    const replayed = atLine(target)
    const fromCache = atLine(target)

    // eslint-disable-next-line no-console
    console.log(
      `line ${target} "\\item" ordinals — cold ${JSON.stringify(cold)}, ` +
        `after a neighbour ${JSON.stringify(replayed)}, again ${JSON.stringify(fromCache)}`
    )
    expect(cold).toEqual(['2'])
    expect(replayed).toEqual(cold)
    expect(fromCache).toEqual(cold)
  })

  it('numbers every \\item in the document the same way a whole-document build does', () => {
    /*
     * Every numbered list line in the later half of the document, compared one by
     * one. The ordinal is a count from the start of the item's own list, so a build
     * that began its walk at the viewport would number the first item it met "1" —
     * and this is the test that caught exactly that, twice, in two different forms.
     *
     * Each line is built for *on its own*, which is the harshest version of the
     * question: a real viewport is twenty lines and carries twenty chances to get the
     * context right; a one-line range has to have it right on arrival.
     */
    const wholeSet = createDecorations(state, parsed, []).decorations
    const half = state.doc.line(Math.floor(state.doc.lines / 2))

    const numbered: { line: number; ordinals: string[] }[] = []
    wholeSet.between(half.from, state.doc.length, (from, _to, decoration) => {
      const start = (
        decoration as { spec?: { attributes?: Record<string, string> } }
      ).spec?.attributes?.start
      if (start) {
        numbered.push({ line: state.doc.lineAt(from).number, ordinals: [start] })
      }
    })

    // Enough of them that "the context was right" is a statement about a sequence
    // rather than about one lucky line.
    expect(numbered.length).toBeGreaterThan(4)

    const disagreements: string[] = []
    for (const { line } of numbered) {
      const docLine = state.doc.line(line)
      const bounded = createDecorations(state, parsed, [
        { from: docLine.from, to: docLine.to },
      ]).decorations
      const expected = ordinalsIn(wholeSet, docLine.from, docLine.to)
      const actual = ordinalsIn(bounded, docLine.from, docLine.to)
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        disagreements.push(
          `line ${line} ${JSON.stringify(docLine.text)}: expected ${JSON.stringify(
            expected
          )}, got ${JSON.stringify(actual)}`
        )
      }
    }
    expect(disagreements).toEqual([])
  })

  it('numbers a theorem from the sections above it, not from the viewport', () => {
    const whole = createDecorations(state, parsed, [])
    const at = source.indexOf('\\begin{theorem}\\label{thm-6}')
    expect(at).toBeGreaterThan(0)
    const line = state.doc.lineAt(at)

    const headerOf = (set: DecorationSetLike) =>
      collect(set, line.from, line.to).filter(entry => entry.includes('Theorem'))
    expect(headerOf(whole.decorations).length).toBeGreaterThan(0)

    const bounded = createDecorations(state, parsed, [
      { from: line.from, to: line.to },
    ])
    expect(headerOf(bounded.decorations)).toEqual(headerOf(whole.decorations))
  })
})


