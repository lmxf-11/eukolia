import { useCodeMirrorStateContext } from '@/vendor/overleaf/components/codemirror-context'
import { useCallback } from 'react'
import { getEditorScope } from '@/visual/scope'
import { setEditorSelection } from '@/vendor/overleaf/eukolia/selection-bridge'
import { EditorState } from '@codemirror/state'
import { resolveCommandNode } from '@/vendor/overleaf/extensions/command-tooltip'
import {
  FilePathArgument,
  LiteralArgContent,
} from '@/vendor/overleaf/lezer-latex/latex.terms.mjs'

/**
 * Resolves the file named by an \\input / \\include / \\subfile argument and
 * opens it. Eukolia resolves through the editor scope, which owns the project
 * file list, rather than through Overleaf's file-tree and editor-manager
 * React contexts.
 */
export const useIncludedFile = (argumentType: string) => {
  const state = useCodeMirrorStateContext()

  const openIncludedFile = useCallback(() => {
    const name = readIncludedPath(state, argumentType)
    if (!name) return

    const scope = getEditorScope()
    if (!scope) return

    const files = scope.getProjectFiles()
    const withoutExtension = name.replace(/\.(tex|ltx)$/i, '')
    const match = files.find(file => {
      if (file.isDirectory) return false
      const path = file.path.replace(/\.(tex|ltx)$/i, '')
      return path === withoutExtension || path.endsWith(`/${withoutExtension}`)
    })

    if (match) {
      setEditorSelection({ filePath: match.path, offset: 0 })
    }
  }, [argumentType, state])

  return { openIncludedFile }
}

const readIncludedPath = (
  state: EditorState,
  argumentType: string | number
) => {
  const commandNode = resolveCommandNode(state)
  const argumentNode = commandNode
    ?.getChild(argumentType)
    ?.getChild(FilePathArgument)
    ?.getChild(LiteralArgContent)

  if (argumentNode) {
    return state.sliceDoc(argumentNode.from, argumentNode.to)
  }
}
