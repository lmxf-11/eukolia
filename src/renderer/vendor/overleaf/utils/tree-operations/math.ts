import { getEnvironmentName } from './environments'
import { EditorState } from '@codemirror/state'
import { SyntaxNode, SyntaxNodeRef } from '@lezer/common'
import { ancestorNodeOfType } from './ancestors'
import { nodeHasError } from './common'

export type MathContainer = {
  content: string
  displayMode: boolean
  passToMathJax: boolean
  pos: number
}

export const mathAncestorNode = (
  state: EditorState,
  pos: number,
  side: -1 | 0 | 1 = 0
) =>
  ancestorNodeOfType(state, pos, '$MathContainer', side) ||
  ancestorNodeOfType(state, pos, 'EquationEnvironment', side) ||
  // NOTE: EquationArrayEnvironment can be nested inside EquationEnvironment
  ancestorNodeOfType(state, pos, 'EquationArrayEnvironment', side)

export const parseMathContainer = (
  state: EditorState,
  nodeRef: SyntaxNodeRef,
  ancestorNode: SyntaxNode
): MathContainer | null => {
  if (nodeHasError(ancestorNode)) {
    return null
  }

  // the content of the Math element, without braces
  const innerContent = state.doc.sliceString(nodeRef.from, nodeRef.to).trim()

  if (!innerContent.length) {
    return null
  }

  let content = innerContent
  let displayMode = false
  let passToMathJax = true
  let pos = nodeRef.from

  if (ancestorNode.type.is('$Environment')) {
    const environmentName = getEnvironmentName(ancestorNode, state)
    if (environmentName) {
      // use the outer content of environments that MathJax supports
      // https://docs.mathjax.org/en/latest/input/tex/macros/index.html#environments
      //
      // Eukolia had `passToMathJax = false` for `tikzcd` here, because MathJax
      // could not read the environment and a `tex2svgPromise` on its body never
      // settled — an empty widget with no error and no source. The port in
      // `public/mathjax/input/tex/extensions/tikzcd.js` renders it, so the
      // environment is ordinary mathematics again and is handed over like any
      // other. Whether a construct is un-renderable is decided in one place now,
      // by `isUnrenderableMathEnvironment` in the decoration pass.
      if (environmentName !== 'math' && environmentName !== 'displaymath') {
        content = state.doc
          .sliceString(ancestorNode.from, ancestorNode.to)
          .trim()
        pos = ancestorNode.from
      }

      if (environmentName !== 'math') {
        displayMode = true
      }
    }
  } else {
    if (
      ancestorNode.type.is('BracketMath') ||
      Boolean(ancestorNode.getChild('DisplayMath'))
    ) {
      displayMode = true
    }
  }

  return { content, displayMode, passToMathJax, pos }
}
