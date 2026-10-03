import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing, syntaxTree } from '@codemirror/language'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { atomicDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'

const doc = `\\documentclass{article}
\\begin{document}
Here is \\textbf{strong text} and \\textit{emphasized text}.
And here is \\texttt{code text} and \\emph{italic text}.
\\end{document}
`

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('diagnosis: the rendered text', () => {
  it('prints what the DOM says', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          LaTeXLanguage,
          phrases(EUKOLIA_EDITOR_PHRASES),
          filePreview(() => null),
          atomicDecorations,
        ],
        selection: { anchor: 0 },
      }),
      parent: host,
    })
    forceParsing(view, view.state.doc.length, 10000)
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (syntaxTree(view.state).length === view.state.doc.length) break
      await wait(25)
    }
    await wait(150)
    view.measure()

    // eslint-disable-next-line no-console
    console.log('TEXT:', JSON.stringify(view.dom.textContent))
    // eslint-disable-next-line no-console
    console.log('HTML:', view.dom.innerHTML.slice(0, 1200))
    view.destroy()
    host.remove()
    expect(true).toBe(true)
  })
})
