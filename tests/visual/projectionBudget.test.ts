// @vitest-environment node
/**
 * The projection fields' initial parse is bounded.
 *
 * `documentOutline`, `documentCommands` and `documentEnvironments` are Overleaf
 * projections: each is a `StateField` that parses on creation with a 500 ms budget so
 * that a normal document's projection is complete before anything asks for it. Three
 * fields × 500 ms × every new `EditorState` — and a document being opened creates a
 * few — is what made opening a large file cost seconds *after* the text was already on
 * screen. Measured on a Stacks project chapter: 3.5 s in one task, all of it parsing
 * towards a projection the application has already stopped rendering at that size.
 *
 * Above `LARGE_DOCUMENT_DECORATION_LINES` the first parse now gets the incremental
 * budget instead. These tests hold both halves of that: a normal document still gets
 * a complete projection, and a large one is not parsed to its end while the file is
 * being opened.
 */
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { LanguageSupport, syntaxTree } from '@codemirror/language'

import { documentCommands } from '@/vendor/overleaf/languages/latex/document-commands'
import { documentEnvironments } from '@/vendor/overleaf/languages/latex/document-environments'
import { documentOutline } from '@/vendor/overleaf/languages/latex/document-outline'
import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { ProjectionStatus } from '@/vendor/overleaf/utils/tree-operations/projection'
import { EAGER_PARSE_LINES } from '@/visual/largeDocument'

/**
 * The three projections over the grammar, without the rest of `latex()`: the linter
 * worker is constructed at module scope and has nothing to do with this question.
 */
const projections = () => new LanguageSupport(LaTeXLanguage, [documentOutline, documentCommands, documentEnvironments])

/** A chapter-shaped document of at least `lines` lines. */
function chapter(lines: number): string {
  const block = [
    '\\section{A section with \\emph{formatting} and $x^2 + y^2 = z^2$}',
    '\\label{sec:generated}',
    'Prose with \\cite{key} and a \\begin{theorem}claim\\end{theorem} inline.',
    '\\begin{equation}',
    '  \\label{eq:generated}',
    '  \\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
    '\\end{equation}',
    ''
  ]
  const repeats = Math.ceil(lines / block.length)
  return Array.from({ length: repeats }, (_unused, index) =>
    block.map((line) => line.replace(/generated/g, `g${index}`)).join('\n')
  ).join('\n')
}

const small = chapter(200)
const large = chapter(40_000)

describe('the projection fields', () => {
  it('are mounted with the LaTeX language', () => {
    const state = EditorState.create({ doc: small, extensions: [projections()] })
    expect(state.field(documentEnvironments, false)).toBeDefined()
    expect(state.field(documentOutline, false)).toBeDefined()
  })

  it('complete their projection for a document of a normal size', () => {
    // The behaviour the 500 ms budget exists for, unchanged.
    const state = EditorState.create({ doc: small, extensions: [projections()] })

    expect(state.field(documentEnvironments).status).toBe(ProjectionStatus.Complete)
    expect(state.field(documentOutline).status).toBe(ProjectionStatus.Complete)
    expect(state.field(documentEnvironments).items.length).toBeGreaterThan(0)
  })

  it('do not parse a large document to its end while it is being opened', () => {
    const lines = large.split('\n').length
    expect(lines).toBeGreaterThan(EAGER_PARSE_LINES)

    const state = EditorState.create({ doc: large, extensions: [projections()] })

    // Bounded work: three fields at 20 ms each cannot have parsed a document this
    // size — before the bound, each field was allowed 500 ms and a single create
    // reached well past half of it.
    expect(syntaxTree(state).length).toBeLessThan(large.length / 4)
    // And the projection says so rather than pretending to be complete.
    expect(state.field(documentEnvironments).status).not.toBe(ProjectionStatus.Complete)
  }, 60_000)
})
