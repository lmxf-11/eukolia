import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { createDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'
import { setProjectMacros } from '@/editor/projectMacros'
import { syntaxTree } from '@codemirror/language'

setProjectMacros({})

const doc = [
  '\\documentclass{article}',
  '\\newtheorem{theorem}{Theorem}',
  '\\begin{document}',
  '\\section{First}',
  '\\begin{theorem}\\label{thm:one}',
  'A statement.',
  '\\end{theorem}',
  '\\begin{itemize}',
  '\\item One',
  '\\item Two',
  '\\end{itemize}',
  'Strong \\textbf{strong text} here.',
  '\\end{document}',
  '',
].join('\n')

describe('diagnosis: which branches run', () => {
  it('prints every decoration the walk produced', () => {
    const state = EditorState.create({
      doc,
      extensions: [
        LaTeXLanguage,
        phrases(EUKOLIA_EDITOR_PHRASES),
        filePreview(() => null),
      ],
    })
    const tree = syntaxTree(state)
    // eslint-disable-next-line no-console
    console.log('tree length', tree.length, 'doc length', doc.length)

    const { decorations } = createDecorations(state, tree, [])
    const found: string[] = []
    decorations.between(0, doc.length, (from, to, decoration) => {
      const spec = (
        decoration as {
          spec?: { widget?: { constructor: { name: string } }; class?: string }
        }
      ).spec
      const widget = spec?.widget?.constructor.name
      found.push(
        `${widget ?? spec?.class ?? 'range'} [${from},${to}] ${JSON.stringify(doc.slice(from, to))}`
      )
    })
    // eslint-disable-next-line no-console
    console.log(found.join('\n'))
    expect(tree.length).toBe(doc.length)
  })
})
