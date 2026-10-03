import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { createDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'

const doc = `\\documentclass{article}
\\begin{document}
Here is \\textbf{strong text} and \\textit{emphasized text}.
And here is \\texttt{code text} and \\emph{italic text}.
\\end{document}
`

describe('diagnosis: the preamble block', () => {
  it('reports where the preamble ends and what it collapses', () => {
    const state = EditorState.create({
      doc,
      extensions: [
        LaTeXLanguage,
        phrases(EUKOLIA_EDITOR_PHRASES),
        filePreview(() => null),
      ],
    })
    const tree = syntaxTree(state)
    const nodes: string[] = []
    tree.iterate({
      enter(node) {
        if (
          /DocumentEnvironment|BeginEnv|Maketitle|Title|Author|Affil|Preamble|DocumentClass/.test(
            node.name
          )
        ) {
          nodes.push(`${node.name}@${node.from}-${node.to}`)
        }
      },
    })

    const built = createDecorations(state, tree, [])
    const { preamble } = built
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ docLength: doc.length, preamble, nodes }, null, 1))

    const decorations: string[] = []
    built.decorations.between(0, doc.length, (from, to, decoration) => {
      const spec = (decoration as { spec?: { widget?: { constructor: { name: string } } } })
        .spec
      if (spec?.widget) {
        decorations.push(`${spec.widget.constructor.name}@${from}-${to}`)
      }
    })
    // eslint-disable-next-line no-console
    console.log('widgets:', decorations.join(', '))
    expect(true).toBe(true)
  })
})
