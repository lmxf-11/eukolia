/**
 * Root-document detection — ported from LaTeX Workshop `out/src/core/root.js`.
 *
 * Covers the two required scenarios: a `% !TeX root` magic comment and root
 * resolution through a nested `\input` graph, plus the `subfiles` rule and the
 * synchronous detection used by the workspace service.
 */

import { describe, expect, it } from 'vitest'

import {
  createRootDocumentService,
  detectRootDocument,
  detectRootDocumentSync
} from '../../src/renderer/document/rootDoc'
import { MemoryFileProvider } from '../../src/renderer/vendor/latex-workshop/fs/memoryFileProvider'

const ROOT = 'D:/proj'

/** The ported detector returns OS-native absolute paths; compare slash-insensitively. */
function norm(value: string | null | undefined): string | null | undefined {
  return value?.replace(/\\/g, '/')
}

const MAIN = `\\documentclass{article}
\\begin{document}
\\input{chapters/ch1}
\\end{document}
`

const CH1 = `\\section{One}
\\input{ch2}
`

const CH2 = `\\subsection{Two}
\\input{../shared/macros}
`

const MACROS = `\\newcommand{\\R}{\\mathbb{R}}
`

const MAGIC_CH1 = `% !TeX root = ../main.tex
\\section{One}
`

function project(extra: Array<{ path: string; content: string }> = []): MemoryFileProvider {
  return new MemoryFileProvider([
    { path: `${ROOT}/main.tex`, content: MAIN },
    { path: `${ROOT}/chapters/ch1.tex`, content: CH1 },
    { path: `${ROOT}/chapters/ch2.tex`, content: CH2 },
    { path: `${ROOT}/shared/macros.tex`, content: MACROS },
    ...extra
  ])
}

function service(fs: MemoryFileProvider) {
  return createRootDocumentService({
    fs,
    workspaceFolders: [ROOT],
    getWorkspaceFolder: () => ROOT
  })
}

describe('root document detection (ported core/root.js)', () => {
  it('resolves the root of a deeply \\input-ed file through the workspace scan', async () => {
    const detector = service(project())
    const root = await detector.findRootFrom(`${ROOT}/shared/macros.tex`)
    expect(norm(root)).toBe(`${ROOT}/main.tex`)
  })

  it('follows the inclusion graph to decide between two \\documentclass files', async () => {
    const fs = project([
      { path: `${ROOT}/other.tex`, content: '\\documentclass{book}\\begin{document}Other\\end{document}\n' }
    ])
    const detector = service(fs)
    const root = await detector.findRootFrom(`${ROOT}/chapters/ch2.tex`)
    expect(norm(root)).toBe(`${ROOT}/main.tex`)
  })

  it('honours a % !TeX root magic comment', async () => {
    const fs = project([{ path: `${ROOT}/chapters/ch1.tex`, content: MAGIC_CH1 }])
    const detector = service(fs)
    const root = await detector.findRootFrom(`${ROOT}/chapters/ch1.tex`)
    expect(norm(root)).toBe(`${ROOT}/main.tex`)
  })

  it('follows a chain of magic comments and stops on a loop', async () => {
    const fs = new MemoryFileProvider([
      { path: `${ROOT}/a.tex`, content: '% !TeX root = b.tex\n\\section{A}\n' },
      { path: `${ROOT}/b.tex`, content: '% !TeX root = c.tex\n\\documentclass{article}\n' },
      { path: `${ROOT}/c.tex`, content: '% !TeX root = b.tex\n\\begin{document}\\end{document}\n' }
    ])
    const detector = service(fs)
    expect(norm(await detector.findRootFrom(`${ROOT}/a.tex`))).toBe(`${ROOT}/b.tex`)
  })

  it('uses the subfiles rule to pick the parent document', async () => {
    const fs = new MemoryFileProvider([
      { path: `${ROOT}/main.tex`, content: '\\documentclass{article}\\begin{document}\\subfile{chapters/ch1}\\end{document}\n' },
      { path: `${ROOT}/chapters/ch1.tex`, content: '\\documentclass[../main.tex]{subfiles}\n\\begin{document}\\section{One}\\end{document}\n' }
    ])
    const detector = service(fs)
    expect(norm(await detector.findRootFrom(`${ROOT}/chapters/ch1.tex`))).toBe(`${ROOT}/main.tex`)
    expect(norm(detector.state.subfiles.path)).toBe(`${ROOT}/chapters/ch1.tex`)
  })

  it('keeps the current root while it still includes the file', async () => {
    const fs = project()
    const detector = service(fs)
    await detector.findRoot(`${ROOT}/main.tex`)
    expect(norm(detector.rootFile)).toBe(`${ROOT}/main.tex`)
    // `findFromRoot` consults the cached inclusion set.
    await detector.refreshProject(`${ROOT}/main.tex`)
    expect([...detector.getIncludedTeX()].map((file) => norm(file)!)).toEqual([`${ROOT}/main.tex`, `${ROOT}/chapters/ch1.tex`, `${ROOT}/chapters/ch2.tex`, `${ROOT}/shared/macros.tex`])
    expect(norm(await detector.findRootFrom(`${ROOT}/chapters/ch2.tex`))).toBe(`${ROOT}/main.tex`)
  })

  it('refreshes the inclusion graph and reports the visited files', async () => {
    const fs = project()
    const detector = service(fs)
    const files = (await detector.refreshProject(`${ROOT}/main.tex`)).map((file) => norm(file)!)
    expect(files).toEqual([`${ROOT}/main.tex`, `${ROOT}/chapters/ch1.tex`, `${ROOT}/chapters/ch2.tex`, `${ROOT}/shared/macros.tex`])
    expect(detector.getTeXChildren(`${ROOT}/main.tex`).map((file) => norm(file)!)).toEqual([`${ROOT}/chapters/ch1.tex`])
  })

  it('getDirtyOrRoot prefers a dirty root buffer and otherwise the known root', async () => {
    const fs = project()
    const detector = service(fs)
    await detector.findRoot(`${ROOT}/main.tex`, MAIN)
    expect(norm(detector.getDirtyOrRoot(`${ROOT}/main.tex`, true))).toBe(`${ROOT}/main.tex`)
    // A dirty *included* file is not a root.
    expect(norm(detector.getDirtyOrRoot(`${ROOT}/chapters/ch1.tex`, true))).toBe(`${ROOT}/main.tex`)
  })

  it('detects the root from a file list (async convenience API)', async () => {
    const detected = await detectRootDocument([
      { path: `${ROOT}/macros.tex`, name: 'macros.tex', content: '% !TeX root = main.tex\n\\newcommand{\\R}{\\mathbb{R}}' },
      { path: `${ROOT}/main.tex`, name: 'main.tex', content: '\\documentclass{article}\n\\begin{document}Hi\\end{document}' }
    ])
    expect(norm(detected)).toBe(`${ROOT}/main.tex`)
  })

  it('provides a synchronous detection over a known file set', () => {
    const files = [
      { path: 'd:/proj/macros.tex', name: 'macros.tex', isDirectory: false },
      { path: 'd:/proj/main.tex', name: 'main.tex', isDirectory: false }
    ]
    const contents = new Map([
      ['d:/proj/macros.tex', '% !TeX root = main.tex\n\\newcommand{\\R}{\\mathbb{R}}'],
      ['d:/proj/main.tex', '\\documentclass{article}\n\\begin{document}Hi\\end{document}']
    ])
    expect(norm(detectRootDocumentSync(files, contents))).toBe('d:/proj/main.tex')
  })

  it('prefers the candidate that includes the others', () => {
    const files = [
      { path: 'd:/p/a.tex', name: 'a.tex', isDirectory: false },
      { path: 'd:/p/b.tex', name: 'b.tex', isDirectory: false }
    ]
    const contents = new Map([
      ['d:/p/a.tex', '\\documentclass{article}\\begin{document}\\input{b.tex}\\end{document}'],
      ['d:/p/b.tex', '\\documentclass{article}\\begin{document}Independent\\end{document}']
    ])
    expect(norm(detectRootDocumentSync(files, contents))).toBe('d:/p/a.tex')
  })

  it('returns null when nothing looks like a root', () => {
    const files = [{ path: 'd:/p/a.tex', name: 'a.tex', isDirectory: false }]
    expect(detectRootDocumentSync(files, new Map([['d:/p/a.tex', '\\section{No class here}']]))).toBeNull()
  })
})
