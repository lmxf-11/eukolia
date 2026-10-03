import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import fs from 'node:fs'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { createDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'
import { setProjectMacros } from '@/editor/projectMacros'

/**
 * What one decoration rebuild costs, whole-document against viewport.
 *
 * A measurement rather than a contract: the assertions are deliberately weak, and
 * the numbers are printed. It was written while looking for the reason typing in a
 * real chapter felt slow, and the answer it found is what the viewport bound in
 * `atomic-decorations.ts` was built for — on the Stacks project's `cohomology.tex`
 * (14 529 lines, 519 KB, ~7 300 inline mathematics regions) **107 ms** of decoration
 * building per rebuild, in a frame whose budget is 16 ms, on every keystroke, for a
 * document whose visible part is thirty lines.
 *
 * The two numbers are the same walk over the same tree; the only difference is what
 * it was asked to decorate. That is the whole of the change, stated as a
 * measurement.
 *
 * The documents are the user's own (`D:\LaTeX projects`), so this is skipped where
 * they are absent rather than failing: a test that can only pass on one machine is
 * not a test. Set `EUKOLIA_PERF_DOCUMENT` to measure another one.
 */

const STACKS = 'D:/LaTeX projects/The Stacks project/stacks-project-master'

const candidates = [
  process.env.EUKOLIA_PERF_DOCUMENT,
  `${STACKS}/cohomology.tex`,
  `${STACKS}/examples-stacks.tex`,
].filter((value): value is string => Boolean(value))

const documentPath = candidates.find(candidate => fs.existsSync(candidate))

/** Warm, then the mean of `runs`. The first call of anything here is the slow one. */
const measure = (fn: () => unknown, runs: number): number => {
  fn()
  const started = performance.now()
  for (let index = 0; index < runs; index += 1) fn()
  return (performance.now() - started) / runs
}

/** How much of the document to decorate, for the two calls under comparison. */
const VIEWPORT_LINES = 60

describe.skipIf(!documentPath)('decoration rebuild cost', () => {
  const text = fs.readFileSync(documentPath as string, 'utf8')
  setProjectMacros({})

  const state = EditorState.create({
    doc: text,
    extensions: [
      LaTeXLanguage,
      phrases(EUKOLIA_EDITOR_PHRASES),
      filePreview(() => null),
    ],
  })
  const tree = syntaxTree(state)

  it('builds a viewport in a fraction of the time the whole document takes', () => {
    // Where a reader would be: far enough in that the walk has a real prefix to
    // accumulate through, which is part of what a bounded build still pays.
    const middle = Math.max(1, Math.floor(state.doc.lines / 2))
    const first = state.doc.line(middle)
    const last = state.doc.line(Math.min(state.doc.lines, middle + VIEWPORT_LINES))
    const viewport = [{ from: first.from, to: last.to }]

    const wholeDocument = measure(
      () => createDecorations(state, tree, []),
      5
    )
    const bounded = measure(
      () => createDecorations(state, tree, viewport),
      5
    )

    const wholeRanges = countRanges(createDecorations(state, tree, []).decorations)
    const boundedRanges = countRanges(
      createDecorations(state, tree, viewport).decorations
    )

    // eslint-disable-next-line no-console
    console.log(
      [
        `document: ${documentPath}`,
        `lines: ${state.doc.lines}`,
        `chars: ${text.length}`,
        `whole-document build: ${wholeDocument.toFixed(2)} ms  (${wholeRanges} decoration ranges)`,
        `viewport build (${VIEWPORT_LINES} lines at ${middle}): ${bounded.toFixed(2)} ms  (${boundedRanges} decoration ranges)`,
        `  -> ${(wholeDocument / Math.max(bounded, 0.01)).toFixed(0)}x less work per rebuild`,
      ].join('\n')
    )

    // The claim the pass rests on: what is on screen must fit in a frame. The bound
    // is generous because a cold CI machine is not the machine this was measured on;
    // the *ratio* below is the part that has to hold.
    expect(bounded).toBeLessThan(25)
    expect(bounded).toBeLessThan(wholeDocument)
  })
})

/** How many ranges a decoration set holds, for the report. */
function countRanges(set: { size: number }): number {
  return set.size
}
