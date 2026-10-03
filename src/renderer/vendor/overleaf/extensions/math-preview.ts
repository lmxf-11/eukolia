import { EditorView, showTooltip, Tooltip, ViewPlugin } from '@codemirror/view'
import {
  Compartment,
  EditorState,
  Extension,
  StateEffect,
  StateField,
  TransactionSpec,
} from '@codemirror/state'
import { loadMathJax } from '@/vendor/overleaf/eukolia/load-mathjax'
import { descendantsOfNodeWithType } from '../utils/tree-query'
import {
  MathContainer,
  mathAncestorNode,
  parseMathContainer,
} from '../utils/tree-operations/math'
import { documentCommands } from '../languages/latex/document-commands'
import { debugConsole } from '@/vendor/overleaf/eukolia/debugging'
import { nodeHasError } from '../utils/tree-operations/common'
import { documentEnvironments } from '../languages/latex/document-environments'
import { repositionAllTooltips } from './tooltips-reposition'
import { closeAllContextMenusEffect } from '../utils/close-all-context-menus-effect'
// Eukolia: the project's macros, for the same reason `atomic-decorations.ts`
// needs them — they are defined in a file this document `\input`s.
import { composeMacroPreamble } from '@/editor/projectMacros'
import { builtInMathDefinitions } from '@/visual/builtinPreamble'
import { rememberMathSvg } from './visual/visual-widgets/math-render-cache'
// Eukolia: one notch over the hover preview has to move the editor, and the shell
// already owns what a notch means. See the wheel listener in `buildTooltip`.
import {
  scrollElementBy,
  smoothScrollDuration,
  wheelDelta,
} from '@/core/smoothScroll'

const HIDE_TOOLTIP_EVENT = 'editor:hideMathTooltip'

export const mathPreview = (enabled: boolean): Extension => {
  return mathPreviewConf.of(
    enabled ? [mathPreviewTheme, mathPreviewStateField] : [mathPreviewTheme]
  )
}

export const hideTooltipEffect = StateEffect.define<null>()

const mathPreviewConf = new Compartment()

export const setMathPreview = (enabled: boolean): TransactionSpec => ({
  effects: mathPreviewConf.reconfigure(enabled ? mathPreviewStateField : []),
})

export const mathPreviewStateField = StateField.define<{
  tooltip: Tooltip | null
  hide: boolean
}>({
  create: buildInitialState,

  update(state, tr) {
    for (const effect of tr.effects) {
      if (effect.is(hideTooltipEffect)) {
        return { tooltip: null, hide: true }
      }
      if (effect.is(closeAllContextMenusEffect)) {
        return { tooltip: null, hide: state.hide }
      }
    }

    if (tr.docChanged || tr.selection) {
      const mathContainer = getMathContainer(tr.state)

      if (mathContainer) {
        if (state.hide) {
          return { tooltip: null, hide: true }
        } else {
          const mathContent = buildTooltipContent(tr.state, mathContainer)

          return {
            tooltip: buildTooltip(mathContainer, mathContent),
            hide: false,
          }
        }
      }

      return { tooltip: null, hide: false }
    }

    return state
  },

  provide: field => [
    showTooltip.compute([field], state => state.field(field).tooltip),

    ViewPlugin.define(view => {
      const hideTooltip = () => {
        view.dispatch({
          effects: hideTooltipEffect.of(null),
        })
      }

      window.addEventListener(HIDE_TOOLTIP_EVENT, hideTooltip)

      return {
        destroy() {
          window.removeEventListener(HIDE_TOOLTIP_EVENT, hideTooltip)
        },
      }
    }),
  ],
})

function buildInitialState(state: EditorState) {
  const mathContainer = getMathContainer(state)

  if (mathContainer) {
    const mathContent = buildTooltipContent(state, mathContainer)

    return {
      tooltip: buildTooltip(mathContainer, mathContent),
      mathContent,
      hide: false,
    }
  }

  return { tooltip: null, hide: false, mathContent: null }
}

const renderMath = async (
  content: string,
  displayMode: boolean,
  element: HTMLElement,
  definitions: string
) => {
  const MathJax = await loadMathJax()

  MathJax.texReset([0]) // equation numbering is disabled, but this is still needed

  try {
    await MathJax.tex2svgPromise(definitions)
  } catch {
    // ignore errors thrown during parsing command definitions
  }

  const metrics = MathJax.getMetricsFor(element, displayMode)
  const math = await MathJax.tex2svgPromise(content, {
    ...metrics,
    containerWidth: 100000,
    display: displayMode,
  })
  rememberMathSvg(content, displayMode, definitions, math)
  element.textContent = ''
  element.append(math)
}

function buildTooltip(
  mathContainer: MathContainer,
  mathContent: HTMLDivElement | null
): Tooltip | null {
  if (!mathContent || !mathContainer) {
    return null
  }

  return {
    pos: mathContainer.pos,
    above: true,
    strictSide: true,
    arrow: false,
    create(view) {
      const dom = document.createElement('div')
      dom.classList.add('ol-cm-math-tooltip-container')
      const innerElt = document.createElement('div')
      innerElt.classList.add('ol-cm-math-tooltip')
      innerElt.id = 'ol-cm-math-tooltip'
      innerElt.appendChild(mathContent)
      dom.appendChild(innerElt)

      /*
       * The preview must not swallow the wheel.
       *
       * CodeMirror mounts a tooltip in `view.dom` — `.cm-editor` — unless a facet
       * says otherwise, and `.cm-scroller` is a *sibling* of `.cm-editor`, not an
       * ancestor of it. Measured in the running application, the chain from this
       * tooltip is `tooltip-container` → `.cm-editor` → `body`, with nothing
       * scrollable anywhere along it, and `scroller.contains(tooltip)` is false
       * while the scroller has 5 682 px to give.
       *
       * A wheel event over the tooltip is therefore a wheel event over nothing.
       * The shell's own handler walks up from the event target looking for
       * something to scroll, finds nothing, and — correctly — does not
       * `preventDefault`; the browser's default action then looks for a scrollable
       * ancestor of the tooltip, finds none either, and moves nothing. Measured:
       * one notch with the pointer over the preview left `scrollTop` at exactly
       * 175.2, and the same notch with the pointer 40 px away moved it to 411.2.
       *
       * A reader scrolling while looking at the equation they are scrolling past
       * finds the editor frozen, which is what was reported. The tooltip is not
       * interactive except for the menu portalled into it, so the whole of it
       * belongs to the surface underneath: the notch is redirected to the editor's
       * own scroller, through the same animation the shell uses everywhere else, so
       * one notch over the preview feels like one notch over the text.
       *
       * A capture listener on the container, because the shell's handler is on the
       * window in the bubble phase and would otherwise process the same event a
       * second time and scroll twice as far.
       */
      const onWheel = (event: WheelEvent): void => {
        // Counted for `scripts/probe-visual.mjs`, which is the only reader: whether
        // this listener runs at all is otherwise invisible from outside, and a
        // wheel over the preview that does nothing looks identical to a wheel the
        // listener never saw.
        const counters = (globalThis as unknown as {
          __eukoliaTooltipWheel?: {
            seen: number
            threw: string | null
            hasScrollDom: boolean
            delta: number | null
          }
        }).__eukoliaTooltipWheel
        if (counters) {
          counters.seen += 1
          counters.hasScrollDom = Boolean(view.scrollDOM)
        }
        try {
          if (event.defaultPrevented) return
          const scroller = view.scrollDOM
          const delta = wheelDelta(event, 'y', scroller.clientHeight)
          if (counters) counters.delta = delta
          if (delta === 0) return
          // Ours now: the shell must not also claim it, and the browser must not
          // scroll whatever it would have picked for a target outside the scroller.
          event.preventDefault()
          event.stopPropagation()
          scrollElementBy(scroller, 'y', delta, smoothScrollDuration())
        } catch (error) {
          if (counters) counters.threw = String(error).slice(0, 200)
        }
      }
      dom.addEventListener('wheel', onWheel, { capture: true, passive: false })

      return { dom, overlap: true, offset: { x: 0, y: 8 } }
    },
  }
}

const getMathContainer = (state: EditorState) => {
  const range = state.selection.main

  if (!range.empty) {
    return null
  }

  // if anywhere inside Math, find the whole Math node
  const ancestorNode = mathAncestorNode(state, range.from)
  if (!ancestorNode) return null

  const [node] = descendantsOfNodeWithType(ancestorNode, 'Math', 'Math')
  if (!node) return null

  if (nodeHasError(ancestorNode)) return null

  return parseMathContainer(state, node, ancestorNode)
}

const buildTooltipContent = (
  state: EditorState,
  math: MathContainer | null
): HTMLDivElement | null => {
  if (!math || !math.content.length) return null

  const element = document.createElement('div')
  element.style.opacity = '0'
  element.textContent = math.content

  let definitions = ''

  const environmentState = state.field(documentEnvironments, false)
  if (environmentState?.items) {
    for (const environment of environmentState.items) {
      if (environment.type === 'definition') {
        definitions += `${environment.raw}\n`
      }
    }
  }

  const commandState = state.field(documentCommands, false)
  if (commandState?.items) {
    for (const command of commandState.items) {
      if (command.type === 'definition' && command.raw) {
        definitions += `${command.raw}\n`
      }
    }
  }

  // Eukolia: the project's own macros, which live in the file this document
  // `\input`s. Both projections above are built from the one file being edited,
  // so without this the preview of an expression using a project macro would be
  // typeset with that macro undefined.
  const preamble = composeMacroPreamble(
    [builtInMathDefinitions(), definitions].filter(Boolean).join('\n')
  )

  renderMath(math.content, math.displayMode, element, preamble)
    .then(() => {
      element.style.opacity = '1'
      repositionAllTooltips()
    })
    .catch(error => {
      debugConsole.error(error)
    })

  return element
}

/**
 * Styles for the preview tooltip
 */
const mathPreviewTheme = EditorView.baseTheme({
  '.cm-tooltip.ol-cm-math-tooltip-container': {
    position: 'relative',
    overflow: 'visible',
    border: '0 !important',
    backgroundColor: 'transparent !important',
    boxShadow: 'none !important',
    margin: '0 !important',
    padding: '0 !important',
  },
  '.ol-cm-math-tooltip': {
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.28), 0 1px 4px rgba(0, 0, 0, 0.12)',
    border: '1px solid var(--eu-border, #232838) !important',
    backgroundColor: 'var(--eu-bg-card, #181b25) !important',
    color: 'var(--eu-visual-fg, #e8ecf4) !important',
    borderRadius: '6px',
    padding: '3px 8px !important',
    display: 'inline-flex !important',
    alignItems: 'center',
    gap: '6px',
    margin: '0 !important',
    lineHeight: '1',
    maxWidth: 'min(1200px, 95vw)',
    boxSizing: 'border-box',
    overflow: 'auto',
  },
  '.ol-cm-math-tooltip > div:not(.dropdown)': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: '1',
    margin: '0',
    padding: '0',
    maxWidth: '100%',
  },
  '.ol-cm-math-tooltip mjx-container, .ol-cm-math-tooltip mjx-container[display="true"]': {
    color: 'var(--eu-visual-fg, #e8ecf4) !important',
    display: 'inline-flex !important',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 !important',
    padding: '0 !important',
    textAlign: 'left !important',
    maxWidth: '100% !important',
    lineHeight: '0 !important',
  },
  '.ol-cm-math-tooltip svg': {
    color: 'var(--eu-visual-fg, #e8ecf4) !important',
    fill: 'currentColor !important',
    display: 'block',
    margin: '0 !important',
  },
  '.math-tooltip-options-toggle': {
    color: 'var(--eu-fg-secondary, #9da5b4) !important',
    background: 'transparent !important',
    border: 'none',
    width: '18px !important',
    height: '18px !important',
    minWidth: '18px !important',
    padding: '0 !important',
    margin: '0 !important',
    display: 'inline-flex !important',
    alignItems: 'center !important',
    justifyContent: 'center !important',
    borderRadius: '4px',
    opacity: '0.6',
    transition: 'opacity 0.15s ease, background-color 0.15s ease',
  },
  '.math-tooltip-options-toggle:hover': {
    color: 'var(--eu-fg-primary, #e2e4ea) !important',
    backgroundColor: 'var(--eu-bg-hover, rgba(255, 255, 255, 0.08)) !important',
    opacity: '1',
  },
  '.math-tooltip-options-keyboard-shortcut': {
    color: 'var(--eu-fg-muted, #7c8294)',
  },
})
