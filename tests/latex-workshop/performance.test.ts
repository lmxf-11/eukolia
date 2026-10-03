/**
 * Performance guard for the ported analysis pipeline.
 *
 * `DocumentModel` re-analyses on every buffer change, so the ported parser must
 * stay well inside an interactive budget on a realistically sized document
 * (Instructions.md §60, §62). The bound is deliberately generous — this is a
 * regression guard, not a benchmark.
 */

import { describe, expect, it } from 'vitest'

import { LatexDocumentAnalyzer } from '../../src/renderer/parser/latexAnalyzer'

const CHUNK = `\\section{Section}
\\label{sec:x}
Some text with \\cite{a,b} and $x^2+y^2$ math.
\\begin{itemize}
\\item one
\\item two
\\end{itemize}
\\subsection{Sub}
More text \\textbf{bold} and \\emph{italic}.
`

function buildDocument(repeats: number): string {
  return `\\documentclass{article}
\\newcommand{\\R}{\\mathbb{R}}
\\begin{document}
${CHUNK.repeat(repeats)}\\end{document}
`
}

describe('ported analyzer performance', () => {
  it('analyses a ~2000 line document within the interactive budget', () => {
    const analyzer = new LatexDocumentAnalyzer()
    const document = buildDocument(250)
    // Warm up: the vendored unified-latex parser builds its tables on first use.
    analyzer.analyze(document, 'D:/proj/big.tex')

    const started = Date.now()
    const analysis = analyzer.analyze(document, 'D:/proj/big.tex')
    const elapsed = Date.now() - started

    expect(analysis.outline.length).toBeGreaterThanOrEqual(250)
    expect(analysis.labels.length).toBe(250)
    expect(analysis.citations.length).toBe(250)
    expect(analysis.macroDefinitions.map((macro) => macro.name)).toEqual(['R'])
    // Observed around 40 ms isolated and ~1.4 s while the whole suite runs in
    // parallel; 4000 ms is a wide regression margin, not a benchmark.
    expect(elapsed).toBeLessThan(4000)
  })
})
