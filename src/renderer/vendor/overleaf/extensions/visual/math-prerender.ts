import { ViewPlugin, ViewUpdate } from '@codemirror/view'
import { EditorState, Extension } from '@codemirror/state'
import { loadMathJax } from '@/vendor/overleaf/eukolia/load-mathjax'
import { composeMacroPreamble } from '@/editor/projectMacros'
import { builtInMathDefinitions } from '@/visual/builtinPreamble'
import { documentCommands } from '../../languages/latex/document-commands'
import { documentEnvironments } from '../../languages/latex/document-environments'
import { descendantsOfNodeWithType } from '../../utils/tree-query'
import {
  mathAncestorNode,
  parseMathContainer,
} from '../../utils/tree-operations/math'
import { nodeHasError } from '../../utils/tree-operations/common'
import {
  cachedMathSvg,
  markPreambleParsed,
  preambleParsed,
  rememberMathSvg,
} from './visual-widgets/math-render-cache'

function getPreamble(state: EditorState): string {
  let definitions = ''
  const envState = state.field(documentEnvironments, false)
  if (envState?.items) {
    for (const env of envState.items) {
      if (env.type === 'definition') {
        definitions += `${env.raw}\n`
      }
    }
  }
  const cmdState = state.field(documentCommands, false)
  if (cmdState?.items) {
    for (const cmd of cmdState.items) {
      if (cmd.type === 'definition' && cmd.raw) {
        definitions += `${cmd.raw}\n`
      }
    }
  }
  return composeMacroPreamble(
    [builtInMathDefinitions(), definitions].filter(Boolean).join('\n')
  )
}

/**
 * Pre-renders active math in the background while the user has the caret inside
 * a math block, warming the SVG render cache so that when the caret leaves the block,
 * the SVG is inserted immediately with zero delay.
 */
export const mathPreRender: Extension = ViewPlugin.fromClass(
  class {
    private timeoutId: ReturnType<typeof setTimeout> | null = null
    private lastKey = ''

    update(update: ViewUpdate) {
      if (!update.docChanged && !update.selectionSet) return

      const state = update.state
      const sel = state.selection.main
      if (!sel.empty) return

      const ancestor = mathAncestorNode(state, sel.from)
      if (!ancestor || nodeHasError(ancestor)) return

      const [mathNode] = descendantsOfNodeWithType(ancestor, 'Math', 'Math')
      if (!mathNode) return

      const math = parseMathContainer(state, mathNode, ancestor)
      if (!math || !math.content.trim()) return

      if (this.timeoutId !== null) {
        clearTimeout(this.timeoutId)
      }
      this.timeoutId = setTimeout(() => {
        this.runPreRender(state, math.content, math.displayMode)
      }, 100)
    }

    private async runPreRender(
      state: EditorState,
      content: string,
      displayMode: boolean
    ) {
      const preamble = getPreamble(state)
      const key = `${content}:${displayMode}:${preamble}`
      if (key === this.lastKey) return
      this.lastKey = key

      if (cachedMathSvg(content, displayMode, preamble)) return

      try {
        const MathJax = await loadMathJax()
        if (preamble && !preambleParsed(preamble)) {
          try {
            await MathJax.tex2svgPromise(preamble)
            markPreambleParsed(preamble)
          } catch {
            // ignore preamble parsing error
          }
        }
        const svg = await MathJax.tex2svgPromise(content, {
          display: displayMode,
        })
        rememberMathSvg(content, displayMode, preamble, svg)
      } catch {
        // Ignore math typesetting errors during background pre-rendering
      }
    }

    destroy() {
      if (this.timeoutId !== null) {
        clearTimeout(this.timeoutId)
      }
    }
  }
)
