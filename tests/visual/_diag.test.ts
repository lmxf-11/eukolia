import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { createDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'
import { mathAncestorNode, parseMathContainer } from '@/vendor/overleaf/utils/tree-operations/math'

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

describe('why is the display widget missing', () => {
  it('asks parseMathContainer directly', () => {
    const state = EditorState.create({ doc, extensions: [LaTeXLanguage, phrases(EUKOLIA_EDITOR_PHRASES), filePreview(() => null)] })
    const tree = syntaxTree(state)
    const at = doc.indexOf('\\sum_{i=1}^{n} i') + 3
    const node = tree.resolveInner(at, 1)
    // eslint-disable-next-line no-console
    console.log('node at', at, '=', node.name, node.from, node.to)
    const ancestor = mathAncestorNode(state, node.from)
    // eslint-disable-next-line no-console
    console.log('mathAncestorNode =', ancestor ? `${ancestor.name}@${ancestor.from}-${ancestor.to}` : 'null')
    if (ancestor) {
      const math = parseMathContainer(state, node, ancestor)
      // eslint-disable-next-line no-console
      console.log('parseMathContainer =', JSON.stringify({ pos: math?.pos, len: math?.content.length, displayMode: math?.displayMode, passToMathJax: math?.passToMathJax, content: math?.content.slice(0, 40) }))
    }
    expect(true).toBe(true)
  })
})
