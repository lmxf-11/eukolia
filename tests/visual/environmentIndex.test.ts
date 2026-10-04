import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { findAllEnvironments, findClosestEnvironment, findEnvironmentsInRange } from '@/visual/environmentIndex'

function parsed(doc: string) {
  const state = EditorState.create({ doc, extensions: [LaTeXLanguage] })
  expect(ensureSyntaxTree(state, doc.length, 5000)?.length).toBe(doc.length)
  return state.update({}).state
}
const source = String.raw`\begin{document}
\begin{theorem}
Outer
\begin{proof}
Inner
\begin{equation}x=1\end{equation}
\end{proof}
\end{theorem}
\begin{lemma}Sibling\end{lemma}
\end{document}`

describe('environment structure index', () => {
  it('preserves nesting and root-wide bracket offsets while excluding mathematics', () => {
    const state = parsed(source)
    expect(findAllEnvironments(state).map(e => [e.name, e.depth, e.treeMaxDepth])).toEqual([
      ['theorem', 0, 1], ['proof', 1, 1], ['lemma', 0, 0],
    ])
    const inside = source.indexOf('Inner')
    expect(findEnvironmentsInRange(state, inside, inside + 5).map(e => e.name)).toEqual(['theorem', 'proof'])
    expect(findClosestEnvironment(state, inside)?.name).toBe('proof')
  })

  it('reuses the parsed structure across selection and viewport queries', () => {
    const state = parsed(source)
    const initial = findAllEnvironments(state)
    const walk = vi.spyOn(syntaxTree(state), 'iterate')
    try {
      const moved = state.update({ selection: { anchor: source.indexOf('Sibling') } }).state
      expect(findAllEnvironments(moved)).toBe(initial)
      for (let i = 0; i < source.length; i++) findEnvironmentsInRange(moved, i, i + 5)
      expect(walk).not.toHaveBeenCalled()
    } finally { walk.mockRestore() }
  })

  it('invalidates after edits and excludes an unfinished environment', () => {
    const state = parsed(source)
    findAllEnvironments(state)
    const at = source.indexOf('\\end{lemma}')
    const changed = state.update({ changes: { from: at, to: at + '\\end{lemma}'.length, insert: '' } }).state
    ensureSyntaxTree(changed, changed.doc.length, 5000)
    expect(findAllEnvironments(changed.update({}).state).map(e => e.name)).toEqual(['theorem', 'proof'])
  })

  it('refreshes the index when parsing advances without a document edit', () => {
    const chunk = String.raw`\begin{theorem}Text\end{theorem}` + '\n'
    const state = EditorState.create({ doc: chunk.repeat(600), extensions: [LaTeXLanguage] })
    const initial = findAllEnvironments(state)
    ensureSyntaxTree(state, state.doc.length, 5000)
    const parsedState = state.update({}).state
    expect(parsedState.doc).toBe(state.doc)
    const complete = findAllEnvironments(parsedState)
    expect(complete).toHaveLength(600)
    if (syntaxTree(state) !== syntaxTree(parsedState)) expect(complete).not.toBe(initial)
  })

  it('returns only the visible siblings in a long document', () => {
    const chunk = String.raw`\begin{theorem}Text\end{theorem}` + '\n'
    const state = parsed(chunk.repeat(600))
    expect(findAllEnvironments(state)).toHaveLength(600)
    const at = chunk.length * 400 + chunk.indexOf('Text')
    const found = findEnvironmentsInRange(state, at, at + 2)
    expect(found).toHaveLength(1)
    expect(found[0].beginFrom).toBe(chunk.length * 400)
  })
})
