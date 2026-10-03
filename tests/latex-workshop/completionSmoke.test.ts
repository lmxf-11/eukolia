/**
 * End-to-end smoke test for the ported completion providers.
 *
 * The per-completer suites live in `completion.test.ts`; this file checks the
 * dispatch table from `out/src/completion/latex.js` as a whole: which provider a
 * line selects, and that the required cases from the Eukolia brief work against
 * a small in-memory project (`\begin{…}`, `\cite{…}`, `\ref{…}`, `\input{…}`).
 */

import { describe, expect, it } from 'vitest'

import {
  provideAtSuggestions,
  provideLatexCompletions
} from '../../src/renderer/vendor/latex-workshop/completion/latex'
import type {
  CompletionContext,
  CompletionProjectState
} from '../../src/renderer/vendor/latex-workshop/completion/types'
import { mergeSettings } from '../../src/renderer/vendor/latex-workshop/settings'

const URI = 'D:/proj/main.tex'

const BIB = `@article{knuth1984,
  author = {Donald E. Knuth},
  title = {The TeXbook},
  journal = {Addison-Wesley},
  year = {1984}
}

@book{lamport1994,
  author = {Leslie Lamport},
  title = {LaTeX: A Document Preparation System},
  year = {1994}
}
`

export function projectState(overrides: Partial<CompletionProjectState> = {}): CompletionProjectState {
  return {
    labels: () => [
      { name: 'sec:intro', file: URI, line: 3 },
      { name: 'fig:one', file: URI, line: 9 }
    ],
    citedKeys: () => ['knuth1984'],
    bibEntries: () => [
      {
        key: 'knuth1984',
        type: 'article',
        title: 'The TeXbook',
        authors: ['Donald E. Knuth'],
        year: '1984',
        journal: 'Addison-Wesley',
        source: 'D:/proj/refs.bib',
        line: 1
      },
      {
        key: 'lamport1994',
        type: 'book',
        title: 'LaTeX: A Document Preparation System',
        authors: ['Leslie Lamport'],
        year: '1994',
        source: 'D:/proj/refs.bib',
        line: 8
      }
    ],
    macros: () => [],
    documentEnvironments: () => ['myenv'],
    packages: () => ['amsmath'],
    documentClass: () => 'article',
    glossaryEntries: () => [],
    files: () => [
      { path: 'D:/proj/main.tex', name: 'main.tex', relativePath: 'main.tex', isDirectory: false },
      { path: 'D:/proj/chapters/one.tex', name: 'one.tex', relativePath: 'chapters/one.tex', isDirectory: false }
    ],
    graphicsPaths: () => ['D:/proj/figures'],
    documentText: () => 'See \\cite{knuth1984}.\n',
    ...overrides
  }
}

function context(line: string, project: CompletionProjectState = projectState()): CompletionContext {
  return {
    args: {
      uri: URI,
      langId: 'latex',
      line,
      character: line.length,
      settings: mergeSettings()
    },
    project
  }
}

describe('ported completion dispatch (out/src/completion/latex.js)', () => {
  it('completes environments inside \\begin{', () => {
    // The reference returns the whole list and lets the editor filter by the
    // typed prefix, so the assertion is on the data rather than the prefix.
    const items = provideLatexCompletions(context('\\begin{fig'))
    const labels = items.map((item) => item.label)
    expect(labels).toContain('itemize')
    expect(labels).toContain('equation')
    // `documentEnvironments` from the analysed document is merged in.
    expect(labels).toContain('myenv')
    const itemize = items.find((item) => item.label === 'itemize')!
    expect(itemize.insertText).toContain('itemize}')
    expect(itemize.kind).toBe(8 /* CompletionItemKind.Module, as in the reference */)
  })

  it('completes citations from the bibliography and drops those already cited', () => {
    const items = provideLatexCompletions(context('See \\cite{'))
    const labels = items.map((item) => item.label)
    expect(labels).toContain('lamport1994')
    // `knuth1984` already appears in the document text, so the ported
    // "already used in this file" filter removes it.
    expect(labels).not.toContain('knuth1984')
  })

  it('completes labels inside \\ref{', () => {
    const items = provideLatexCompletions(context('See \\ref{'))
    expect(items.map((item) => item.label)).toContain('sec:intro')
  })

  it('completes project files inside \\input{', () => {
    const items = provideLatexCompletions(context('\\input{'))
    // The reference completes from the current directory (and `\\graphicspath`
    // directories), so `main.tex` is offered and `chapters/one.tex` is not.
    expect(items.map((item) => item.label)).toEqual(['main.tex'])
  })

  it('completes packages inside \\usepackage{', () => {
    const items = provideLatexCompletions(context('\\usepackage{ams'))
    expect(items.map((item) => item.label)).toContain('amsmath')
  })

  it('completes commands after a backslash', () => {
    const items = provideLatexCompletions(context('\\docu'))
    const labels = items.map((item) => item.label)
    expect(labels).toContain('\\begin')
    expect(labels).toContain('\\beginend')
    // The macro completer also offers environment names (without a backslash),
    // exactly like the reference's `macro.js`.
    expect(labels).toContain('itemize')
    expect(items.length).toBeGreaterThan(100)
  })

  it('returns nothing when no provider applies', () => {
    expect(provideLatexCompletions(context('plain text'))).toHaveLength(0)
  })

  it('completes @-suggestions', () => {
    const items = provideAtSuggestions(context('@.'))
    expect(items.length).toBeGreaterThan(0)
    expect(items.map((item) => item.insertText ?? item.label).join(' ')).toContain('\\cdot')
  })

  it('does not return completions for a doubled backslash', () => {
    expect(provideLatexCompletions(context('a \\\\'))).toHaveLength(0)
  })
})
