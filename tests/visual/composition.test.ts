import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import {
  buildScopeMetadata,
  eukoliaEditorExtensions,
  isVisualModeFile,
  scopePreviewByPath,
  setVisualMode,
} from '@/visual/editorExtensions'
import { createEditorScope, EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'
import { isVisual } from '@/vendor/overleaf/extensions/visual/visual'

const DOC = [
  '\\documentclass{article}',
  '\\newcommand{\\R}{\\mathbb{R}}',
  '\\begin{document}',
  '\\section{Groups}',
  '',
  'A subgroup \\(H\\leq G\\) is \\emph{normal} if',
  '',
  '\\[',
  '  gHg^{-1}=H.',
  '\\]',
  '\\end{document}',
  '',
].join('\n')

const scope = () =>
  createEditorScope({
    id: 'composition',
    filePath: 'D:/project/main.tex',
    projectRoot: 'D:/project',
    text: DOC,
    files: [{ path: 'D:/project/main.tex' }],
    macroTable: { '\\R': '\\mathbb{R}' },
    phrases: EUKOLIA_EDITOR_PHRASES,
  })

describe('Visual Mode extension composition', () => {
  it('builds a valid Extension array for a LaTeX document', () => {
    const extensions = eukoliaEditorExtensions({
      scope: scope(),
      fileName: 'main.tex',
      theme: 'dark',
      startVisual: true,
    })

    expect(Array.isArray(extensions)).toBe(true)
    expect(extensions.length).toBeGreaterThan(30)
  })

  it('creates an EditorState from the composed extensions', () => {
    // This is the strongest check available without a DOM: every extension in
    // the composed set is instantiated and its facets resolved by CodeMirror.
    const state = EditorState.create({
      doc: DOC,
      extensions: eukoliaEditorExtensions({
        scope: scope(),
        fileName: 'main.tex',
        theme: 'light',
        startVisual: true,
      }),
    })

    expect(state.doc.toString()).toBe(DOC)
    // Visual Mode is on, and switching it off is a real transaction spec.
    expect(isVisual({ state } as unknown as EditorView)).toBe(true)

    const update = state.update(setVisualMode(false))
    expect(isVisual({ state: update.state } as unknown as EditorView)).toBe(
      false
    )
  })

  it('starts with the visual extensions disabled when asked to', () => {
    const state = EditorState.create({
      doc: DOC,
      extensions: eukoliaEditorExtensions({
        scope: scope(),
        fileName: 'main.tex',
        theme: 'dark',
        startVisual: false,
      }),
    })
    expect(isVisual({ state } as unknown as EditorView)).toBe(false)
  })

  it('exposes the document phrases on the editor state', () => {
    const state = EditorState.create({
      doc: DOC,
      extensions: eukoliaEditorExtensions({
        scope: scope(),
        fileName: 'main.tex',
        theme: 'dark',
      }),
    })
    expect(
      state.phrase('sorry_your_table_cant_be_displayed_at_the_moment')
    ).toBe(EUKOLIA_EDITOR_PHRASES.sorry_your_table_cant_be_displayed_at_the_moment)
  })

  it('claims LaTeX buffers and declines others', () => {
    expect(isVisualModeFile('main.tex')).toBe(true)
    expect(isVisualModeFile('refs.bib')).toBe(false)
  })

  it('exposes the preview resolver and metadata to the extension set', () => {
    const editorScope = createEditorScope({
      filePath: 'D:/project/main.tex',
      projectRoot: 'D:/project',
      files: [{ path: 'D:/project/figure.png' }],
      images: {
        'D:/project/figure.png': {
          url: 'file:///D:/project/figure.png',
          extension: 'png',
        },
      },
      macroTable: { '\\R': '\\mathbb{R}' },
    })

    expect(scopePreviewByPath(editorScope)('figure.png')?.extension).toBe('png')
    expect(buildScopeMetadata(editorScope).commands[0].caption).toBe('\\R')
  })
})
