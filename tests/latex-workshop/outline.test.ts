/**
 * Structural parsing and outline construction — ported from LaTeX Workshop
 * `out/src/outline/structure/latex.js`, on top of the reference's own
 * unified-latex parser (`resources/unified.js`).
 */

import { describe, expect, it } from 'vitest'

import { LatexDocumentAnalyzer } from '../../src/renderer/parser/latexAnalyzer'
import { SECTIONING_ORDER } from '../../src/renderer/document/analysisTypes'
import { buildProjectStructure } from '../../src/renderer/parser/latexProject'
import { MemoryFileProvider } from '../../src/renderer/vendor/latex-workshop/fs/memoryFileProvider'
import { traverseSectionTree } from '../../src/renderer/vendor/latex-workshop/parser/structure'
import { TeXElementType } from '../../src/renderer/vendor/latex-workshop/types'
import { tokenizeLatex } from '../../src/renderer/vendor/latex-workshop/tokenizer'

const ROOT = 'D:/proj'
const MAIN = `${ROOT}/main.tex`

const DOCUMENT = `\\documentclass{article}
\\begin{document}
\\section{Introduction}
\\label{sec:intro}
Some intro text.
\\subsection{Motivation}
\\label{sec:motivation}
Details.
\\subsubsection{Details of details}
\\section{Preliminaries}
\\subsection{Categories}
\\section{Homotopy Theory}
\\end{document}
`

describe('LatexDocumentAnalyzer outline', () => {
  const analyzer = new LatexDocumentAnalyzer()
  const analysis = analyzer.analyze(DOCUMENT, MAIN)

  it('builds a nested outline from a multi-section document', () => {
    expect(analysis.outline.map((item) => item.title)).toEqual(['Introduction', 'Preliminaries', 'Homotopy Theory'])
    const intro = analysis.outline[0]
    expect(intro.command).toBe('section')
    expect(intro.level).toBe(2)
    expect(intro.line).toBe(3)
    expect(intro.offset).toBe(DOCUMENT.indexOf('\\section{Introduction}'))
    expect(intro.children.map((child) => child.title)).toEqual(['Motivation'])
    expect(intro.children[0].level).toBe(3)
    expect(intro.children[0].children.map((child) => child.title)).toEqual(['Details of details'])
    expect(intro.children[0].children[0].level).toBe(4)
    expect(analysis.outline[1].children.map((child) => child.title)).toEqual(['Categories'])
    expect(analysis.outline[2].children).toEqual([])
  })

  it('attaches each label to the section that contains it', () => {
    expect(analysis.outline[0].labels).toEqual(['sec:intro'])
    expect(analysis.outline[0].children[0].labels).toEqual(['sec:motivation'])
    expect(analysis.labels.map((label) => label.name)).toEqual(['sec:intro', 'sec:motivation'])
    expect(analysis.labels[0].line).toBe(4)
  })

  it('collects sectioning, environments, citations, macros and includes', () => {
    const text = `\\documentclass{article}
\\usepackage{amsmath}
\\newcommand{\\R}[1]{\\mathbb{R}^{#1}}
\\def\\foo#1#2{#1+#2}
\\begin{document}
\\section{One}
See \\cite{knuth1984,lamport1994} and \\input{chapters/two}.
\\begin{figure}
\\caption{A figure}
\\end{figure}
\\begin{itemize}
\\item x
\\end{itemize}
\\end{document}
`
    const result = analyzer.analyze(text, MAIN)
    expect(result.sectioning).toHaveLength(1)
    expect(result.sectioning[0]).toMatchObject({ command: 'section', title: 'One', line: 6, starred: false })
    expect(result.citations).toHaveLength(1)
    expect(result.citations[0].keys).toEqual(['knuth1984', 'lamport1994'])
    expect(result.citations[0].command).toBe('cite')
    expect(result.includedFiles.map((file) => [file.command, file.path])).toEqual([['input', 'chapters/two']])
    const macros = result.macroDefinitions.map((macro) => macro.name)
    expect(macros).toContain('R')
    expect(macros).toContain('foo')
    const R = result.macroDefinitions.find((macro) => macro.name === 'R')!
    expect(R.args).toBe(1)
    expect(R.definition).toContain('\\mathbb{R}')
    const foo = result.macroDefinitions.find((macro) => macro.name === 'foo')!
    expect(foo.primitive).toBe(true)
    expect(foo.args).toBe(2)
    expect(result.environments.map((env) => env.name)).toEqual(['document', 'figure', 'itemize'])
    expect(result.environments[1].nested).toBe(true)
    expect(result.environments[1].line).toBe(8)
  })

  it('marks starred sections', () => {
    const result = analyzer.analyze('\\section*{Unnumbered}\\section{Numbered}', MAIN)
    expect(result.sectioning.map((section) => section.starred)).toEqual([true, false])
  })

  /**
   * `\paragraph` and `\subparagraph` are the two finest levels LaTeX has, and
   * they were missing from the outline entirely.
   *
   * The cause is worth stating because it is not where it looks. This key is
   * what builds the parser's signature table as well as the outline's level
   * index, so a command missing from it is not skipped in the outline — its
   * braces are never parsed as an argument at all, and no later stage can
   * recover it. The reference's five-level default therefore reduced a document
   * whose structure lives at paragraph level to an outline that looked broken,
   * with nothing in the UI able to explain why.
   */
  it('builds a full-depth outline down to \\paragraph and \\subparagraph', () => {
    const text = `\\documentclass{book}
\\begin{document}
\\part{Foundations}
\\chapter{Introduction}
\\section{Scope}
\\subsection{Detail}
\\subsubsection{More detail}
\\paragraph{Inline heading}
\\subparagraph{Finest heading}
\\end{document}
`
    const result = analyzer.analyze(text, MAIN)

    // Every level is collected, in document order and at the right depth.
    expect(result.sectioning.map((section) => [section.command, section.title])).toEqual([
      ['part', 'Foundations'],
      ['chapter', 'Introduction'],
      ['section', 'Scope'],
      ['subsection', 'Detail'],
      ['subsubsection', 'More detail'],
      ['paragraph', 'Inline heading'],
      ['subparagraph', 'Finest heading']
    ])
    // And each nests inside the one above it, so the outline is a single chain
    // rather than seven siblings.
    const chain = result.outline
    expect(chain).toHaveLength(1)
    expect(chain[0].command).toBe('part')
    const levels = [chain[0].level]
    let node = chain[0]
    while (node.children.length > 0) {
      node = node.children[0]
      levels.push(node.level)
    }
    expect(levels).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(node.command).toBe('subparagraph')
  })

  it('recognizes the same sectioning levels the outline model lists', () => {
    // `SECTIONING_ORDER` is the single statement of what counts as a sectioning
    // command; the parser's signature table is derived from settings instead, so
    // the two drifted and the tail of the list was silently unreachable.
    const recognized = analyzer.analyze('\\part{P}\\paragraph{Para}', MAIN).sectioning.map((s) => s.command)
    expect(recognized).toContain('paragraph')
    expect([...SECTIONING_ORDER]).toEqual([
      'part',
      'chapter',
      'section',
      'subsection',
      'subsubsection',
      'paragraph',
      'subparagraph'
    ])
  })
})

describe('project structure across \\input files', () => {
  it('follows the inclusion graph and splices sub-file sections', async () => {
    const fs = new MemoryFileProvider([
      {
        path: MAIN,
        content: '\\documentclass{article}\n\\begin{document}\n\\section{Main section}\n\\input{chapters/one}\n\\end{document}\n'
      },
      { path: `${ROOT}/chapters/one.tex`, content: '\\section{Chapter one}\n\\subsection{Nested}\n' }
    ])
    const structure = await buildProjectStructure(MAIN, { fs, numberSections: false })
    expect(structure.files.map((file) => file.replace(/\\/g, '/'))).toEqual([MAIN, `${ROOT}/chapters/one.tex`])
    expect(structure.outline.map((item) => item.title)).toEqual(['Main section', 'Chapter one'])
    expect(structure.outline[1].command).toBe('section')
    expect(structure.outline[1].children.map((child) => child.title)).toEqual(['Nested'])
    expect(structure.outline[1].line).toBe(1)
    // The reference's TeXElement tree is available too.
    expect(structure.elements.some((element) => element.type === TeXElementType.Section)).toBe(true)
  })

  it('keeps the reference section numbering when asked for it', async () => {
    const fs = new MemoryFileProvider([{ path: MAIN, content: DOCUMENT }])
    const numbered = await buildProjectStructure(MAIN, { fs })
    expect(numbered.elements[0].label).toMatch(/^\d+ /)
  })

  it('navigates the structure tree by file and line', async () => {
    const fs = new MemoryFileProvider([
      { path: MAIN, content: '\\documentclass{article}\n\\section{One}\n\\input{two}\n\\section{Three}\n' },
      { path: `${ROOT}/two.tex`, content: '\\section{Two}\n' }
    ])
    const structure = await buildProjectStructure(MAIN, { fs, numberSections: false })
    const twoFile = structure.files.find((file) => file.endsWith('two.tex'))!
    const node = traverseSectionTree(structure.elements, twoFile, 0)
    expect(node?.name).toBe('section')
    expect(node?.filePath).toBe(twoFile)
  })
})

describe('tokenizer derived from syntax/LaTeX.tmLanguage.json', () => {
  it('classifies comments, commands, sections, citations, labels and math', () => {
    const text = [
      '% a comment',
      '\\documentclass{article}',
      '\\usepackage{amsmath}',
      '\\section{Intro}',
      '\\label{sec:intro}',
      'See \\cite{knuth1984} and \\ref{sec:intro}.',
      'Math: $a+b$ and \\[c+d\\].',
      '\\begin{verbatim}',
      '\\raw',
      '\\end{verbatim}'
    ].join('\n')
    const tokens = tokenizeLatex(text)
    const byType = (type: string) => tokens.filter((token) => token.type === type)
    expect(byType('comment')[0].text).toBe('% a comment')
    expect(byType('class').map((token) => token.text)).toEqual(['\\documentclass{article}'])
    expect(byType('package').map((token) => token.text)).toEqual(['\\usepackage{amsmath}'])
    expect(byType('section').map((token) => token.text)).toEqual(['\\section{Intro}'])
    expect(byType('label').map((token) => token.text)).toEqual(['\\label{sec:intro}'])
    expect(byType('citation').map((token) => token.text)).toEqual(['\\cite{knuth1984}'])
    expect(byType('reference').map((token) => token.text)).toEqual(['\\ref{sec:intro}'])
    expect(byType('mathInline').map((token) => token.text)).toEqual(['$a+b$'])
    expect(byType('mathBlock').map((token) => token.text)).toEqual(['\\[c+d\\]'])
    expect(byType('verbatim')).toHaveLength(1)
    expect(byType('verbatim')[0].text).toContain('\\raw')
  })

  it('produces non-overlapping tokens in source order', () => {
    const text = '\\section{A} text \\cite{b} % note\n'
    const tokens = tokenizeLatex(text)
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i].start).toBeGreaterThanOrEqual(tokens[i - 1].end)
    }
    expect(tokens[tokens.length - 1].text).toBe('% note')
  })

  it('tolerates incomplete input while typing', () => {
    const tokens = tokenizeLatex('\\begin{fig')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].text).toBe('\\begin{fig')
  })
})
