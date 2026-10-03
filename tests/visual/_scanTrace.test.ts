import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'

const chapters = 8
const body: string[] = []
for (let c = 1; c <= chapters; c += 1) {
  body.push(
    `\\chapter{C${c}}`, `\\section{S${c}}`,
    `Text with $a_${c}^2$ and \\textbf{bold ${c}}.`,
    `\\begin{enumerate}`, `\\item First of ${c}`, `\\item Second of ${c}`,
    `\\begin{itemize}`, `\\item Nested of ${c}`, `\\end{itemize}`,
    `\\end{enumerate}`,
    `\\begin{theorem}\\label{thm-${c}}`, `For every $x$ there is a $y$.`, `\\end{theorem}`,
    `\\begin{proof}`, `From $x = y$.`, `\\end{proof}`, `\\[`, `  \\sum_{i=1}^{n} i`, `\\]`
  )
}
const doc = ['\\documentclass{article}','\\usepackage{amsmath}','\\newtheorem{theorem}{Theorem}','\\newcommand{\\R}{\\mathbb{R}}','\\begin{document}','\\title{A document}','\\maketitle',...body,'\\end{document}',''].join('\n')

describe('tree around 1700-1760', () => {
  it('prints', () => {
    const state = EditorState.create({ doc, extensions: [LaTeXLanguage, phrases(EUKOLIA_EDITOR_PHRASES), filePreview(() => null)] })
    const tree = syntaxTree(state)
    const out: string[] = []
    tree.iterate({ from: 1600, to: 1800, enter(n) {
      out.push(`${n.name}@${n.from}-${n.to} ${JSON.stringify(doc.slice(n.from, Math.min(n.to, n.from + 20)))}`)
    }})
    // eslint-disable-next-line no-console
    console.log(out.join('\n'))
    expect(true).toBe(true)
  })
})
