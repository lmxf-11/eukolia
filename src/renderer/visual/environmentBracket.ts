import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { getEnvironmentName } from '@/vendor/overleaf/utils/tree-operations/environments'
import { setting, settingsManager } from '../core/settings'

const bracketStart = Decoration.line({ class: 'eu-cm-env-bracket-start' })
const bracketMid = Decoration.line({ class: 'eu-cm-env-bracket-mid' })
const bracketCusp = Decoration.line({ class: 'eu-cm-env-bracket-cusp' })
const bracketEnd = Decoration.line({ class: 'eu-cm-env-bracket-end' })
const bracketSingle = Decoration.line({ class: 'eu-cm-env-bracket-single' })

export interface EnvironmentInfo {
  startLine: number
  endLine: number
  name: string
  beginPos: number
  endPos: number
  beginFrom: number
  beginTo: number
  endFrom: number
  endTo: number
  depth: number
  treeMaxDepth: number
}

/**
 * Environments that must NOT have connecting brackets.
 * Connecting brackets belong to document/prose structural blocks (theorems,
 * proofs, definitions, lemmas, propositions, quotes, etc.), NOT math blocks
 * (equations, alignments, matrices, cases, etc.) or the outer document wrapper.
 */
export const EXCLUDED_ENVIRONMENTS = new Set([
  'document',
  // Math equation and display environments
  'equation',
  'align',
  'alignat',
  'flalign',
  'gather',
  'gathered',
  'multline',
  'eqnarray',
  'split',
  'aligned',
  'alignedat',
  'math',
  'displaymath',
  'subequations',
  'tikzcd',
  // Math matrices and arrays
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'smallmatrix',
  'psmallmatrix',
  'bsmallmatrix',
  'Bsmallmatrix',
  'vsmallmatrix',
  'Vsmallmatrix',
  'array',
  'subarray',
  // Cases environments
  'cases',
  'case',
  'dcases',
  'rcases',
  'drcases',
  // IEEE and custom equation variants
  'IEEEeqnarray',
  'IEEEeqnarraybox',
])

/**
 * Checks whether an environment should be excluded from receiving brackets.
 * Returns true if the environment is a math environment, inside a math container,
 * or the outer document environment.
 */
export function isExcludedEnvironment(
  name: string,
  node?: SyntaxNode | null
): boolean {
  if (!name) return true
  const baseName = name.replace(/\*$/, '').trim().toLowerCase()
  if (EXCLUDED_ENVIRONMENTS.has(baseName)) {
    return true
  }
  if (node) {
    let p = node.parent
    while (p) {
      if (
        p.type.is('$MathContainer') ||
        p.type.is('EquationEnvironment') ||
        p.type.is('EquationArrayEnvironment')
      ) {
        return true
      }
      p = p.parent
    }
  }
  return false
}

/**
 * Finds the closest (innermost) environment containing pos.
 * Verifies that \begin and \end match, and that the environment is a valid
 * non-excluded document environment (ignoring math environments like equation, aligned, gather).
 */
export function findClosestEnvironment(
  state: EditorState,
  pos: number
): EnvironmentInfo | null {
  const tree = syntaxTree(state)
  let node: SyntaxNode | null = tree.resolveInner(pos, -1)

  while (node) {
    const begin = node.getChild('BeginEnv')
    const end = node.getChild('EndEnv')

    if (begin && end) {
      const beginName = getEnvironmentName(begin, state) || ''
      const endName = getEnvironmentName(end, state) || ''
      if (
        beginName &&
        beginName === endName &&
        !isExcludedEnvironment(beginName, node)
      ) {
        if (pos >= begin.from && pos <= end.to) {
          const startLine = state.doc.lineAt(begin.from).number
          const endLine = state.doc.lineAt(end.to).number
          return {
            startLine,
            endLine,
            name: beginName,
            beginPos: begin.from,
            endPos: end.to,
            beginFrom: begin.from,
            beginTo: begin.to,
            endFrom: end.from,
            endTo: end.to,
            depth: 0,
            treeMaxDepth: 0,
          }
        }
      }
    }

    if (!node.parent) break
    node = node.parent
  }

  return null
}

/**
 * Finds all valid closed LaTeX environments in the document (excluding math and document environments).
 * Computes nesting depth (0 for outermost) and treeMaxDepth for each environment.
 */
export function findAllEnvironments(state: EditorState): EnvironmentInfo[] {
  const tree = syntaxTree(state)
  const envs: Array<Omit<EnvironmentInfo, 'depth' | 'treeMaxDepth'>> = []
  const seenBegins = new Set<number>()

  tree.iterate({
    enter(nodeRef) {
      const node = nodeRef.node
      const begin = node.getChild('BeginEnv')
      const end = node.getChild('EndEnv')

      if (begin && end) {
        if (seenBegins.has(begin.from)) return
        const beginName = getEnvironmentName(begin, state) || ''
        const endName = getEnvironmentName(end, state) || ''
        if (
          beginName &&
          beginName === endName &&
          !isExcludedEnvironment(beginName, node)
        ) {
          seenBegins.add(begin.from)
          const startLine = state.doc.lineAt(begin.from).number
          const endLine = state.doc.lineAt(end.to).number
          envs.push({
            startLine,
            endLine,
            name: beginName,
            beginPos: begin.from,
            endPos: end.to,
            beginFrom: begin.from,
            beginTo: begin.to,
            endFrom: end.from,
            endTo: end.to,
          })
        }
      }
    },
  })

  envs.sort((a, b) => a.beginPos - b.beginPos)

  const fullEnvs: EnvironmentInfo[] = envs.map(e => ({
    ...e,
    depth: 0,
    treeMaxDepth: 0,
  }))

  // 1. Calculate nesting depth for each environment:
  // depth = count of strictly enclosing environments
  for (let i = 0; i < fullEnvs.length; i++) {
    const cur = fullEnvs[i]
    let depth = 0
    for (let j = 0; j < fullEnvs.length; j++) {
      if (i === j) continue
      const other = fullEnvs[j]
      if (
        other.beginPos <= cur.beginPos &&
        cur.endPos <= other.endPos &&
        (other.beginPos < cur.beginPos || cur.endPos < other.endPos)
      ) {
        depth++
      }
    }
    cur.depth = depth
  }

  // 2. Calculate treeMaxDepth for each environment:
  // Find root ancestor (enclosing environment with depth 0)
  // and compute max depth among all environments in that tree.
  for (let i = 0; i < fullEnvs.length; i++) {
    const cur = fullEnvs[i]
    let root = cur
    if (cur.depth > 0) {
      for (let j = 0; j < fullEnvs.length; j++) {
        const other = fullEnvs[j]
        if (
          other.depth === 0 &&
          other.beginPos <= cur.beginPos &&
          cur.endPos <= other.endPos
        ) {
          root = other
          break
        }
      }
    }

    let maxD = root.depth
    for (let j = 0; j < fullEnvs.length; j++) {
      const other = fullEnvs[j]
      if (other.beginPos >= root.beginPos && other.endPos <= root.endPos) {
        if (other.depth > maxD) {
          maxD = other.depth
        }
      }
    }
    cur.treeMaxDepth = maxD
  }

  return fullEnvs
}

function buildBracketDecorations(view: EditorView): DecorationSet {
  const sel = view.state.selection.main
  const env = findClosestEnvironment(view.state, sel.head)
  if (!env) return Decoration.none

  const builder = new RangeSetBuilder<Decoration>()
  const { startLine, endLine } = env
  const midLineNum = Math.floor((startLine + endLine) / 2)

  for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
    const line = view.state.doc.line(lineNum)
    let dec: Decoration
    if (startLine === endLine) {
      dec = bracketSingle
    } else if (lineNum === startLine) {
      dec = bracketStart
    } else if (lineNum === endLine) {
      dec = bracketEnd
    } else if (lineNum === midLineNum) {
      dec = bracketCusp
    } else {
      dec = bracketMid
    }
    builder.add(line.from, line.from, dec)
  }

  return builder.finish()
}

/**
 * A CodeMirror ViewPlugin that renders left brackets sticking out of the editor.
 * When visual.displayAllEnvironmentBrackets is enabled, all LaTeX environments
 * render brackets, and nested environments render nested non-overlapping brackets.
 * When disabled (default), only the closest environment containing the caret is shown.
 * Math environments (equation, align, gather, aligned, cases, etc.) are excluded.
 */
export const environmentBracketPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    bracketSvg: SVGSVGElement | null = null
    unsub: (() => void) | null = null
    /** The bracket markup last written, so an unchanged pass writes nothing. */
    writtenPaths = ''
    /** The height last written, for the same reason. */
    writtenHeight = ''

    constructor(view: EditorView) {
      if (typeof document !== 'undefined') {
        this.bracketSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        this.bracketSvg.setAttribute('class', 'eu-cm-env-bracket-svg')
        this.bracketSvg.style.position = 'absolute'
        this.bracketSvg.style.pointerEvents = 'none'
        this.bracketSvg.style.zIndex = '4'
        this.bracketSvg.style.overflow = 'visible'
        this.bracketSvg.style.left = '0px'
        this.bracketSvg.style.top = '0px'
        this.bracketSvg.style.width = '100%'
        this.bracketSvg.style.height = '100%'
        this.bracketSvg.style.color = 'var(--eu-editor-fg, currentColor)'
        this.bracketSvg.style.display = 'none'
        view.scrollDOM.appendChild(this.bracketSvg)
      }

      this.decorations = buildBracketDecorations(view)
      this.scheduleUpdate(view)

      this.unsub = settingsManager.on('change', payload => {
        const p = payload as { key?: string; section?: string; reset?: boolean; resetAll?: boolean } | undefined
        if (
          !p?.key ||
          p.key === 'visual.displayAllEnvironmentBrackets' ||
          p.section === 'visual' ||
          p.reset ||
          p.resetAll
        ) {
          this.decorations = buildBracketDecorations(view)
          this.scheduleUpdate(view)
        }
      })
    }

    update(update: ViewUpdate) {
      /*
       * The line decorations say which lines belong to the environment the caret
       * is inside, so they are a function of the document and the selection and of
       * nothing else — `buildBracketDecorations` reads `state.selection.main` and
       * the syntax tree, never the viewport. Rebuilding them on a viewport or
       * geometry change was therefore pure waste on every scroll step: a fresh
       * `DecorationSet` over every line of the environment, handed to CodeMirror
       * for a set that had not changed.
       *
       * The *measurement* below is a different question and does have to follow
       * the viewport: it positions the drawn bracket from the widget that renders
       * `\begin`/`\end`, and which of those CodeMirror has rendered depends on
       * where the viewport is.
       */
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildBracketDecorations(update.view)
      }
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.geometryChanged
      ) {
        this.scheduleUpdate(update.view)
      }
    }

    scheduleUpdate(view: EditorView) {
      view.requestMeasure({
        read: (view) => {
          const displayAll = setting.bool('visual.displayAllEnvironmentBrackets')
          let envsToRender: EnvironmentInfo[] = []

          if (displayAll) {
            envsToRender = findAllEnvironments(view.state)
          } else {
            const sel = view.state.selection.main
            const env = findClosestEnvironment(view.state, sel.head)
            if (env) {
              envsToRender = [{ ...env, depth: 0, treeMaxDepth: 0 }]
            }
          }

          if (envsToRender.length === 0 || typeof document === 'undefined') return null

          try {
            const scrollRect = view.scrollDOM.getBoundingClientRect()
            const scrollTop = view.scrollDOM.scrollTop
            const scrollLeft = view.scrollDOM.scrollLeft
            const contentRect = view.contentDOM.getBoundingClientRect()
            const contentLeft = contentRect.left - scrollRect.left + scrollLeft

            const beginWidgets = view.dom.querySelectorAll<HTMLElement>('.ol-cm-begin')
            const endWidgets = view.dom.querySelectorAll<HTMLElement>('.ol-cm-end')

            /*
             * Which `\begin`/`\end` widget renders which position, indexed once
             * for the whole pass.
             *
             * The lookup below used to be an attribute selector per environment,
             * and on a miss — which is the *normal* case for the far end of an
             * environment, since CodeMirror only renders the viewport — a scan
             * over every rendered widget calling `view.posAtDOM` on each, inside a
             * `try`, to tolerate the ±2 the widget's own position can differ by.
             * Both halves are per-environment work over a per-viewport list, so
             * measuring a whole document (`displayAllEnvironmentBrackets`) made
             * the pass quadratic in exactly the case the setting exists to serve.
             * The index answers the direct hit for every environment at once, and
             * the tolerant scan stays as the fallback for the ones it cannot.
             */
            const beginWidgetByFrom = new Map<string, HTMLElement>()
            for (let i = 0; i < beginWidgets.length; i++) {
              const from = beginWidgets[i].dataset.from
              if (from !== undefined && !beginWidgetByFrom.has(from)) {
                beginWidgetByFrom.set(from, beginWidgets[i])
              }
            }
            const endWidgetByFrom = new Map<string, HTMLElement>()
            for (let i = 0; i < endWidgets.length; i++) {
              const from = endWidgets[i].dataset.from
              if (from !== undefined && !endWidgetByFrom.has(from)) {
                endWidgetByFrom.set(from, endWidgets[i])
              }
            }

            const beginCenterYMap = new Map<EnvironmentInfo, number | null>()
            const endCenterYMap = new Map<EnvironmentInfo, number | null>()
            const resolvedBeginLeftMap = new Map<EnvironmentInfo, number>()
            const resolvedEndLeftMap = new Map<EnvironmentInfo, number>()
            const minLeftMap = new Map<EnvironmentInfo, number>()

            for (const env of envsToRender) {
              // 1. Locate \\begin{} SVG or line center
              let beginCenterY: number | null = null
              let beginLeft: number | null = null
              let beginWidget: HTMLElement | null =
                beginWidgetByFrom.get(String(env.beginFrom)) ?? null

              if (!beginWidget) {
                for (let i = 0; i < beginWidgets.length; i++) {
                  const w = beginWidgets[i]
                  try {
                    const p = view.posAtDOM(w)
                    if (Math.abs(p - env.beginFrom) <= 2) {
                      beginWidget = w
                      break
                    }
                  } catch {}
                }
              }

              if (beginWidget) {
                const bRect = beginWidget.getBoundingClientRect()
                beginCenterY = (bRect.top + bRect.bottom) / 2 - scrollRect.top + scrollTop
                beginLeft = bRect.left - scrollRect.left + scrollLeft
              } else {
                const coords =
                  view.coordsAtPos(env.beginFrom) ??
                  view.coordsAtPos(view.state.doc.line(env.startLine).from)
                if (coords) {
                  beginCenterY = (coords.top + coords.bottom) / 2 - scrollRect.top + scrollTop - 2
                  beginLeft = coords.left - scrollRect.left + scrollLeft
                } else {
                  try {
                    const block = view.lineBlockAt(env.beginFrom)
                    beginCenterY = block.top + block.height / 2 - 2
                  } catch {
                    beginCenterY = null
                  }
                }
              }

              // 2. Locate \\end{} SVG or line center
              let endCenterY: number | null = null
              let endLeft: number | null = null
              let endWidget: HTMLElement | null =
                endWidgetByFrom.get(String(env.endFrom)) ?? null

              if (!endWidget) {
                for (let i = 0; i < endWidgets.length; i++) {
                  const w = endWidgets[i]
                  try {
                    const p = view.posAtDOM(w)
                    if (Math.abs(p - env.endFrom) <= 2) {
                      endWidget = w
                      break
                    }
                  } catch {}
                }
              }

              if (endWidget) {
                const eRect = endWidget.getBoundingClientRect()
                endCenterY = (eRect.top + eRect.bottom) / 2 - scrollRect.top + scrollTop
                endLeft = eRect.left - scrollRect.left + scrollLeft
              } else {
                const coords =
                  view.coordsAtPos(env.endFrom) ??
                  view.coordsAtPos(view.state.doc.line(env.endLine).from)
                if (coords) {
                  endCenterY = (coords.top + coords.bottom) / 2 - scrollRect.top + scrollTop
                  endLeft = coords.left - scrollRect.left + scrollLeft
                } else {
                  try {
                    const block = view.lineBlockAt(env.endFrom)
                    endCenterY = block.top + block.height / 2
                  } catch {
                    endCenterY = null
                  }
                }
              }

              // Fallback resolution for left alignment
              let fallbackLeft: number = Math.max(contentLeft, 24)
              if (beginLeft === null && endLeft === null) {
                try {
                  const curCoords = view.coordsAtPos(view.state.selection.main.head)
                  if (curCoords) {
                    fallbackLeft = curCoords.left - scrollRect.left + scrollLeft
                  }
                } catch {}
              }

              const resolvedBeginLeft = beginLeft ?? endLeft ?? fallbackLeft
              const resolvedEndLeft = endLeft ?? beginLeft ?? fallbackLeft
              const minLeft = Math.min(resolvedBeginLeft, resolvedEndLeft)

              beginCenterYMap.set(env, beginCenterY)
              endCenterYMap.set(env, endCenterY)
              resolvedBeginLeftMap.set(env, resolvedBeginLeft)
              resolvedEndLeftMap.set(env, resolvedEndLeft)
              minLeftMap.set(env, minLeft)
            }

            // Find root ancestor for each environment
            const rootMap = new Map<EnvironmentInfo, EnvironmentInfo>()
            for (const env of envsToRender) {
              let root = env
              if (env.depth > 0) {
                for (const other of envsToRender) {
                  if (
                    other.depth === 0 &&
                    other.beginPos <= env.beginPos &&
                    env.endPos <= other.endPos
                  ) {
                    root = other
                    break
                  }
                }
              }
              rootMap.set(env, root)
            }

            // Compute minimum minLeft for each tree
            const treeMinLeftMap = new Map<EnvironmentInfo, number>()
            for (const env of envsToRender) {
              const root = rootMap.get(env)!
              const mLeft = minLeftMap.get(env)!
              const currentMin = treeMinLeftMap.get(root)
              if (currentMin === undefined || mLeft < currentMin) {
                treeMinLeftMap.set(root, mLeft)
              }
            }

            const paths: Array<{ pathD: string; botY: number; name: string; depth: number }> = []

            for (const env of envsToRender) {
              const root = rootMap.get(env)!
              const treeMinLeft = treeMinLeftMap.get(root) ?? minLeftMap.get(env)!
              const resolvedBeginLeft = resolvedBeginLeftMap.get(env)!
              const resolvedEndLeft = resolvedEndLeftMap.get(env)!
              const beginCenterY = beginCenterYMap.get(env)
              const endCenterY = endCenterYMap.get(env)

              const step = 7
              const treeMaxDepth = env.treeMaxDepth
              const depth = env.depth
              const stepOffset = treeMaxDepth - depth

              const baseMargin =
                treeMaxDepth === 0
                  ? Math.max(4, treeMinLeft - 18)
                  : Math.max(4 + treeMaxDepth * step, treeMinLeft - 18)
              const marginX = Math.max(4, baseMargin - stepOffset * step)

              const beginX = Math.max(marginX + 6, resolvedBeginLeft - 3)
              const endX = Math.max(marginX + 6, resolvedEndLeft - 3)

              let topY = Math.round(beginCenterY ?? Math.max(0, (env.startLine - 1) * 24))
              let botY = Math.round(endCenterY ?? Math.max(topY + 24, env.endLine * 24))
              if (Math.abs(botY - topY) < 6) {
                topY = topY - 4
                botY = botY + 4
              }

              // Thin square bracket with smooth 3px corner:
              const r = 3
              const pathD =
                botY - topY > r * 2
                  ? `M ${beginX} ${topY} L ${marginX + r} ${topY} Q ${marginX} ${topY} ${marginX} ${topY + r} L ${marginX} ${botY - r} Q ${marginX} ${botY} ${marginX + r} ${botY} L ${endX} ${botY}`
                  : `M ${beginX} ${topY} L ${marginX} ${topY} L ${marginX} ${botY} L ${endX} ${botY}`

              paths.push({ pathD, botY, name: env.name, depth })
            }

            const maxBotY = paths.length > 0 ? Math.max(...paths.map(p => p.botY)) : 0
            const fullHeight = Math.max(
              view.scrollDOM.scrollHeight,
              view.contentDOM.offsetHeight,
              maxBotY + 50
            )

            return { paths, fullHeight }
          } catch {
            return null
          }
        },
        write: (data, view) => {
          if (!this.bracketSvg) {
            this.bracketSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
            this.bracketSvg.setAttribute('class', 'eu-cm-env-bracket-svg')
            this.bracketSvg.style.position = 'absolute'
            this.bracketSvg.style.pointerEvents = 'none'
            this.bracketSvg.style.zIndex = '4'
            this.bracketSvg.style.overflow = 'visible'
            this.bracketSvg.style.left = '0px'
            this.bracketSvg.style.top = '0px'
            this.bracketSvg.style.width = '100%'
            this.bracketSvg.style.color = 'var(--eu-editor-fg, currentColor)'
            view.scrollDOM.appendChild(this.bracketSvg)
          } else if (this.bracketSvg.parentElement !== view.scrollDOM) {
            view.scrollDOM.appendChild(this.bracketSvg)
          }

          if (!data || data.paths.length === 0) {
            this.writtenPaths = ''
            this.bracketSvg.style.display = 'none'
            return
          }

          /*
           * The pass re-runs on every viewport change, and most of them resolve to
           * the bracket that is already drawn: both ends of the environment are
           * rendered, so the geometry comes from the same two elements as last
           * time. Writing it again would replace the height of a child of the
           * scroller — invalidating the layout the next read of `scrollHeight`
           * depends on — and re-parse every path through `innerHTML`, which is a
           * DOM rebuild of the whole drawing, for a picture that has not changed.
           */
          const markup = data.paths
            .map(
              p =>
                `<path d="${p.pathD}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" data-name="${p.name}" data-depth="${p.depth}"/>`
            )
            .join('')
          const height = `${data.fullHeight}px`
          if (this.writtenPaths === markup && this.writtenHeight === height) return

          this.writtenPaths = markup
          this.writtenHeight = height
          this.bracketSvg.style.height = height
          this.bracketSvg.style.display = 'block'
          this.bracketSvg.innerHTML = markup
        },
      })
    }

    destroy() {
      this.unsub?.()
      this.bracketSvg?.remove()
      this.bracketSvg = null
    }
  },
  {
    decorations: v => v.decorations,
  }
)

export const environmentBracket = (): Extension => [environmentBracketPlugin]
