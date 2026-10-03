/**
 * Eukolia — LaTeX Workshop port: completion provider tests.
 *
 * The providers are exercised against plain `CompletionProjectState` literals
 * (no `vscode`, no editor) and the real `data/latex-workshop` data files, so
 * every assertion is a real reference-data assertion rather than a stub.
 */

import path from 'path'

import { beforeAll, describe, expect, it } from 'vitest'

import { provideBibtexCompletions } from '../../src/renderer/vendor/latex-workshop/completion/bibtex'
import {
  preloadCompletionData,
  provideAtSuggestions,
  provideCompletionOfType,
  provideLatexCompletions
} from '../../src/renderer/vendor/latex-workshop/completion/latex'
import { CompletionItemKind } from '../../src/renderer/vendor/latex-workshop/completion/types'
import type {
  CitationCompletionEntry,
  CompletionContext,
  CompletionProjectState,
  FileCompletionEntry,
  LabelCompletionEntry
} from '../../src/renderer/vendor/latex-workshop/completion/types'
import { mergeSettings, type LwSettings } from '../../src/renderer/vendor/latex-workshop/settings'

const root = path.resolve('eukolia-completion-fixture')
const uri = path.join(root, 'main.tex')

function makeState(overrides: Partial<CompletionProjectState> = {}): CompletionProjectState {
  return {
    labels: () => [],
    citedKeys: () => [],
    bibEntries: () => [],
    macros: () => [],
    documentEnvironments: () => [],
    packages: () => [],
    documentClass: () => undefined,
    glossaryEntries: () => [],
    files: () => [],
    graphicsPaths: () => [],
    documentText: () => undefined,
    ...overrides
  }
}

function makeContext(
  line: string,
  state: CompletionProjectState,
  settings: LwSettings = {},
  character = line.length
): CompletionContext {
  return {
    args: {
      uri,
      langId: 'latex',
      line,
      character,
      settings: mergeSettings(settings)
    },
    project: state
  }
}

describe('environment completion', () => {
  let context: CompletionContext

  beforeAll(async () => {
    // `latex-document` (and `tex`) are loaded through the async package bridge,
    // exactly as a real request would.
    context = makeContext('\\begin{fig', makeState())
    await preloadCompletionData(context)
  })

  it('completes \\begin{fig to the figure environment with a begin/end snippet', () => {
    const items = provideCompletionOfType('environment', context)
    const figure = items.find((item) => item.label === 'figure')
    expect(figure).toBeDefined()
    expect(figure?.insertText).toBe('figure}\n\t${0:${TM_SELECTED_TEXT}}\n\\end{figure}')
    expect(figure?.detail).toBe('\\begin{figure}\n...\n\\end{figure}')
    expect(figure?.documentation).toContain('From package: latex-document')
  })

  it('completes default environments from environments.json', () => {
    const items = provideCompletionOfType('environment', makeContext('\\begin{tab', makeState()))
    const table = items.find((item) => item.label === 'table')
    expect(table).toBeDefined()
    expect(table?.insertText).toBe('table}\n\t${0:${TM_SELECTED_TEXT}}\n\\end{table}')
  })

  it('adds environments defined in the document', () => {
    const state = makeState({ documentEnvironments: () => ['myenv'] })
    const items = provideCompletionOfType('environment', makeContext('\\begin{mye', state))
    const custom = items.find((item) => item.label === 'myenv')
    expect(custom).toBeDefined()
    expect(custom?.insertText).toBe('myenv}\n\t$0\n\\end{myenv}')
  })

  it('is reached by the dispatcher', () => {
    const items = provideLatexCompletions(context)
    expect(items.some((item) => item.label === 'figure')).toBe(true)
  })
})

describe('citation completion', () => {
  const bibEntries: CitationCompletionEntry[] = [
    {
      key: 'knuth1984',
      type: 'book',
      title: 'The TeXbook',
      author: 'Donald E. Knuth',
      year: '1984',
      source: '/fixture/refs.bib',
      line: 3,
      fields: { author: 'Donald E. Knuth', title: 'The TeXbook', publisher: 'Addison-Wesley', year: '1984' }
    },
    {
      key: 'lamport1994',
      type: 'book',
      title: 'LaTeX: A Document Preparation System',
      author: 'Leslie Lamport',
      year: '1994',
      source: '/fixture/refs.bib',
      line: 12,
      fields: {
        author: 'Leslie Lamport',
        title: 'LaTeX: A Document Preparation System',
        publisher: 'Addison-Wesley',
        year: '1994'
      }
    },
    {
      key: 'k84paper',
      type: 'article',
      title: 'A paper',
      author: 'Someone',
      year: '2020',
      source: '/fixture/refs.bib',
      line: 21,
      fields: { author: 'Someone', title: 'A paper', year: '2020' }
    },
    {
      key: 'textools2021',
      type: 'article',
      title: 'Tools for TeX',
      author: 'Someone Else',
      year: '2021',
      source: '/fixture/refs.bib',
      line: 30,
      fields: { author: 'Someone Else', title: 'Tools for TeX', year: '2021' }
    }
  ]

  it('returns the fixture keys of \\cite{', () => {
    const items = provideCompletionOfType('citation', makeContext('\\cite{', makeState({ bibEntries: () => bibEntries })))
    expect(items.map((item) => item.label).sort()).toEqual(['k84paper', 'knuth1984', 'lamport1994', 'textools2021'])
  })

  it('ranks the fuzzy matches, best first', () => {
    const state = makeState({ bibEntries: () => bibEntries })
    // `tex` is part of the citation key of `textools2021` and of the title of
    // `knuth1984`; a key match outweighs a title match.
    const items = provideCompletionOfType('citation', makeContext('\\cite{tex', state))
    expect(items.map((item) => item.label)).toEqual(['textools2021', 'knuth1984'])
    expect(items[0].sortText).toBe('0000')
    expect(items[1].sortText).toBe('0001')
    expect(items[0].filterText).toBe('tex')
  })

  it('drops scattered subsequence matches, as the reference ranker does', () => {
    const state = makeState({ bibEntries: () => bibEntries })
    const items = provideCompletionOfType('citation', makeContext('\\cite{k84', state))
    expect(items.map((item) => item.label)).toEqual(['k84paper'])
  })

  it('excludes a key already cited in the same file', () => {
    const document = '\\documentclass{article}\n\\begin{document}\nSee \\cite{knuth1984}.\n\\cite{'
    const state = makeState({ bibEntries: () => bibEntries, documentText: () => document })
    const items = provideCompletionOfType('citation', makeContext('\\cite{', state))
    expect(items.map((item) => item.label)).not.toContain('knuth1984')
    expect(items.map((item) => item.label)).toContain('lamport1994')
  })

  it('honours intellisense.citation.max.completion.items', () => {
    const state = makeState({ bibEntries: () => bibEntries })
    const items = provideCompletionOfType(
      'citation',
      makeContext('\\cite{', state, { 'intellisense.citation.max.completion.items': 1 })
    )
    expect(items).toHaveLength(1)
  })

  it('documents the entry with the configured citation format', () => {
    const state = makeState({ bibEntries: () => bibEntries })
    const items = provideCompletionOfType('citation', makeContext('\\cite{', state))
    const knuth = items.find((item) => item.label === 'knuth1984')
    expect(knuth?.documentation).toContain('Author: Donald E. Knuth')
    expect(knuth?.documentation).toContain('Title: The TeXbook')
  })

  it('is reached by the dispatcher through the citation regexes', () => {
    const state = makeState({ bibEntries: () => bibEntries })
    const items = provideLatexCompletions(makeContext('\\cite{lam', state))
    expect(items.map((item) => item.label)).toEqual(['lamport1994'])
  })
})

describe('package and class completion', () => {
  it('completes package names of \\usepackage{', () => {
    const items = provideCompletionOfType('package', makeContext('\\usepackage{', makeState()))
    const amsmath = items.find((item) => item.label === 'amsmath')
    expect(amsmath).toBeDefined()
    expect(amsmath?.detail).toBe('AMS mathematical facilities for LaTeX')
    expect(amsmath?.documentation).toBe('[https://ctan.org/pkg/amsmath](https://ctan.org/pkg/amsmath)')
  })

  it('completes class names of \\documentclass{', () => {
    const items = provideCompletionOfType('documentclass', makeContext('\\documentclass{', makeState()))
    expect(items.some((item) => item.label === 'article')).toBe(true)
  })
})

describe('reference completion', () => {
  const labels: LabelCompletionEntry[] = [
    { name: 'sec:intro', file: uri, line: 3, text: '\\section{Introduction}\nmore\nlines', section: 'Introduction' },
    { name: 'fig:one', file: uri, line: 20, text: '\\begin{figure}\n...' }
  ]

  it('completes the project labels of \\ref{ and \\eqref{', () => {
    const state = makeState({ labels: () => labels })
    for (const line of ['\\ref{', '\\eqref{']) {
      const items = provideCompletionOfType('reference', makeContext(line, state))
      expect(items.map((item) => item.label).sort()).toEqual(['fig:one', 'sec:intro'])
      expect(items[0].kind).toBe(CompletionItemKind.Reference)
      expect(items[0].textEdit?.range.start.character).toBe(line.length)
      expect(items[0].textEdit?.newText).toBe('sec:intro')
    }
  })

  it('carries the definition location as provider data', () => {
    const state = makeState({ labels: () => labels })
    const items = provideCompletionOfType('reference', makeContext('\\ref{', state))
    expect(items[0].data).toMatchObject({ file: uri, line: 3 })
  })
})

describe('file completion', () => {
  const files: FileCompletionEntry[] = [
    { path: path.join(root, 'main.tex'), name: 'main.tex', relativePath: 'main.tex', isDirectory: false },
    { path: path.join(root, 'chapters'), name: 'chapters', relativePath: 'chapters', isDirectory: true },
    {
      path: path.join(root, 'chapters', 'intro.tex'),
      name: 'intro.tex',
      relativePath: 'chapters/intro.tex',
      isDirectory: false
    }
  ]

  it('completes the project files of \\input{', () => {
    const state = makeState({ files: () => files })
    const items = provideCompletionOfType('input', makeContext('\\input{', state))
    expect(items.map((item) => item.label).sort()).toEqual(['chapters/', 'main.tex'])
    const folder = items.find((item) => item.label === 'chapters/')
    expect(folder?.kind).toBe(CompletionItemKind.Folder)
    expect(items.find((item) => item.label === 'main.tex')?.kind).toBe(CompletionItemKind.File)
  })

  it('descends into the typed folder', () => {
    const state = makeState({ files: () => files })
    const line = '\\input{chapters/'
    const items = provideCompletionOfType('input', makeContext(line, state))
    expect(items.map((item) => item.label)).toEqual(['intro.tex'])
    expect(items[0].textEdit?.range.start.character).toBe(line.lastIndexOf('/') + 1)
  })

  it('drops the extension for \\include{', () => {
    const state = makeState({ files: () => files })
    const items = provideCompletionOfType('input', makeContext('\\include{', state))
    expect(items.find((item) => item.label === 'main.tex')?.insertText).toBe('main')
  })
})

describe('command completion', () => {
  it('returns \\documentclass for \\doc', () => {
    const items = provideCompletionOfType('macro', makeContext('\\doc', makeState()))
    expect(items.map((item) => item.label)).toContain('\\documentclass{}')
    expect(items.map((item) => item.label)).toContain('\\documentclass[]{}')
  })

  it('is reached by the dispatcher', () => {
    const items = provideLatexCompletions(makeContext('\\doc', makeState()))
    expect(items.some((item) => item.label === '\\documentclass{}')).toBe(true)
  })

  it('adds the macros defined in the document', () => {
    const state = makeState({
      macros: () => [{ name: 'mycmd', args: 2, definition: '\\newcommand{\\mycmd}[2]{#1#2}', file: uri, line: 4 }]
    })
    const items = provideCompletionOfType('macro', makeContext('\\myc', state))
    const mycmd = items.find((item) => item.label === '\\mycmd{}{}')
    expect(mycmd).toBeDefined()
    expect(mycmd?.insertText).toBe('mycmd{${1}}{${2}}')
    expect(mycmd?.documentation).toBe('`mycmd`')
    expect(mycmd?.filterText).toBe('mycmd')
  })

  it('clears the suggestions when two backslashes precede the cursor', () => {
    expect(provideLatexCompletions(makeContext('\\\\', makeState()))).toEqual([])
  })
})

describe('argument key completion', () => {
  it('completes the documented keys of an environment argument', async () => {
    const state = makeState({ packages: () => ['babel'] })
    const context = makeContext('\\begin{otherlanguage*}[', state)
    await preloadCompletionData(context)
    const items = provideCompletionOfType('argument', context)
    expect(items.map((item) => item.label)).toEqual(['date', 'captions'])
    expect(items[0].kind).toBe(CompletionItemKind.Constant)
    expect(items[0].insertText).toBe('date')
  })
})

describe('close environment completion', () => {
  it('suggests \\end{...} for a closed \\begin{...}', () => {
    const items = provideLatexCompletions(makeContext('\\begin{figure}', makeState()))
    expect(items).toHaveLength(1)
    expect(items[0].label).toBe('\\end{figure}')
    expect(items[0].insertText).toBe('\n${0}\n\\end{figure}')
  })
})

describe('script completion', () => {
  it('collects ^{...} from the document when enabled', () => {
    const state = makeState({ documentText: () => 'The mass is $m^{2}$ and the charge $q^{3}$.' })
    const settings = { 'intellisense.subsuperscript.enabled': true }
    const items = provideCompletionOfType('subsuper', makeContext('^{', state, settings))
    expect(items.map((item) => item.label)).toEqual(['2', '3'])
    expect(items[0].kind).toBe(CompletionItemKind.Constant)
  })

  it('is off by default', () => {
    const state = makeState({ documentText: () => 'The mass is $m^{2}$.' })
    expect(provideCompletionOfType('subsuper', makeContext('^{', state))).toEqual([])
  })
})

describe('glossary completion', () => {
  const document = [
    '\\newglossaryentry{foo}{name={Foo},description={A foo}}',
    '\\newacronym{api}{API}{Application Programming Interface}'
  ].join('\n')
  const state = makeState({
    documentText: () => document,
    glossaryEntries: () => [
      { name: 'foo', file: uri, line: 1 },
      { name: 'api', file: uri, line: 2 }
    ]
  })

  it('offers glossaries and acronyms for \\gls{', () => {
    const items = provideCompletionOfType('glossary', makeContext('\\gls{', state))
    expect(items.map((item) => item.label).sort()).toEqual(['api', 'foo'])
    expect(items.find((item) => item.label === 'foo')?.detail).toBe('A foo')
  })

  it('offers acronyms only for \\acrshort{', () => {
    const items = provideCompletionOfType('glossary', makeContext('\\acrshort{', state))
    expect(items.map((item) => item.label)).toEqual(['api'])
  })
})

describe('import file completion', () => {
  const files: FileCompletionEntry[] = [
    { path: path.join(root, 'main.tex'), name: 'main.tex', relativePath: 'main.tex', isDirectory: false },
    { path: path.join(root, 'chapters'), name: 'chapters', relativePath: 'chapters', isDirectory: true },
    {
      path: path.join(root, 'chapters', 'intro.tex'),
      name: 'intro.tex',
      relativePath: 'chapters/intro.tex',
      isDirectory: false
    }
  ]

  it('lists the files of the \\import source directory', () => {
    const state = makeState({ files: () => files })
    const items = provideCompletionOfType('import', makeContext('\\import{chapters/}{', state))
    expect(items.map((item) => item.label)).toEqual(['intro.tex'])
  })

  it('lists only directories while the \\subimport source directory is empty', () => {
    const state = makeState({ files: () => files })
    const items = provideCompletionOfType('subimport', makeContext('\\subimport{}{', state))
    expect(items.map((item) => item.label)).toEqual(['chapters/'])
  })
})

describe('.bib file completion', () => {
  it('completes entry types after @', () => {
    const state = makeState({ documentText: () => '@arti' })
    const context = makeContext('@arti', state)
    context.args.langId = 'bibtex'
    const items = provideBibtexCompletions(context)
    const article = items.find((item) => item.label === 'article')
    expect(article).toBeDefined()
    expect(article?.insertText?.startsWith('article{${0:key}')).toBe(true)
    expect(article?.documentation).toBe('Add a @article entry')
  })

  it('completes the values of a field from the other entries', () => {
    const text = '@article{a,\n  journal = {Journal of Foo},\n  journal = \n}'
    const state = makeState({ documentText: () => text })
    const context = makeContext('  journal = ', state)
    // The cursor's line number is optional metadata of `CompletionArgs`; the
    // provider needs it to locate the cursor line inside the document text.
    ;(context.args as { lineNumber?: number }).lineNumber = 2
    const items = provideBibtexCompletions(context)
    expect(items).toEqual([{ label: 'Journal of Foo', kind: CompletionItemKind.Text }])
  })
})

describe('@ suggestion completion', () => {
  it('completes @ suggestions from at-suggestions.json', () => {
    const items = provideAtSuggestions(makeContext('@', makeState()))
    const cdot = items.find((item) => item.label === '@.')
    expect(cdot).toBeDefined()
    expect(cdot?.insertText).toBe('\\cdot')
    expect(cdot?.kind).toBe(CompletionItemKind.Function)
    expect(cdot?.textEdit?.range.start.character).toBe(0)
    expect(cdot?.textEdit?.range.end.character).toBe(1)
  })

  it('honours intellisense.atSuggestion.trigger.latex', () => {
    const items = provideAtSuggestions(makeContext('@', makeState(), { 'intellisense.atSuggestion.trigger.latex': '#' }))
    expect(items).toEqual([])
  })

  it('adds user @ snippets and removes them from the defaults', () => {
    const items = provideAtSuggestions(
      makeContext('@', makeState(), { 'intellisense.atSuggestion.user': { '@.': '\\cdots' } })
    )
    expect(items.find((item) => item.label === '@.')?.insertText).toBe('\\cdots')
    expect(items.find((item) => item.label === '@.')?.documentation).toBe('User defined @suggestion')
  })
})
