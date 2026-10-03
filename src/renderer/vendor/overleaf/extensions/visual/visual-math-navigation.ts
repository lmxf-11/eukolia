import { EditorSelection, SelectionRange } from '@codemirror/state'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import {
  mathAncestorNode,
  parseMathContainer,
} from '../../utils/tree-operations/math'
import { descendantsOfNodeWithType } from '../../utils/tree-query'
import type { SyntaxNode } from '@lezer/common'
import { setting } from '@core/settings'

/**
 * Creates an EditorSelection instance preserving goalColumn so CodeMirror's
 * transaction resolution does not discard the stored vertical offset.
 */
function makeSelection(pos: number, goalColumn?: number): EditorSelection {
  return EditorSelection.create([
    EditorSelection.cursor(pos, undefined, undefined, goalColumn),
  ])
}

/**
 * Calculates the line boundaries for display math:
 * - startLine: line where the opening delimiter / \begin begins
 * - endLine: line where the closing delimiter / \end ends
 * - firstContentLine: first line containing actual formula content
 * - lastContentLine: last line containing actual formula content
 */
export function getDisplayMathLineRange(
  state: EditorState,
  container: SyntaxNode
): { firstContentLine: number; lastContentLine: number; startLine: number; endLine: number } {
  const startLine = state.doc.lineAt(container.from).number
  const endLine = state.doc.lineAt(container.to).number

  let firstContentLine = startLine
  if (startLine < endLine) {
    const startText = state.doc.line(startLine).text.trim()
    const afterOpen = startText.replace(/^(\\(\[|\$\$)|\\begin\{[^}]*\})/, '').trim()
    if (afterOpen.length === 0) {
      firstContentLine = startLine + 1
    }
  }

  let lastContentLine = endLine
  if (endLine > startLine) {
    const endText = state.doc.line(endLine).text.trim()
    const beforeClose = endText.replace(/(\\(\]|\$\$)|\\end\{[^}]*\})$/, '').trim()
    if (beforeClose.length === 0) {
      lastContentLine = endLine - 1
    }
  }

  while (firstContentLine < lastContentLine && state.doc.line(firstContentLine).text.trim() === '') {
    firstContentLine++
  }
  while (lastContentLine > firstContentLine && state.doc.line(lastContentLine).text.trim() === '') {
    lastContentLine--
  }

  return { firstContentLine, lastContentLine, startLine, endLine }
}

export function getMathEntryStart(state: EditorState, container: SyntaxNode): number {
  const [mathNode] = descendantsOfNodeWithType(container, 'Math', 'Math')
  const parsed = mathNode ? parseMathContainer(state, mathNode, container) : null
  if (parsed?.displayMode) {
    const { firstContentLine, startLine } = getDisplayMathLineRange(state, container)
    if (firstContentLine > startLine) {
      const line = state.doc.line(firstContentLine)
      const trimmedOffset = line.text.search(/\S/)
      return trimmedOffset > 0 ? line.from + trimmedOffset : line.from
    }
  }
  return mathNode ? mathNode.from : container.from + 1
}

export function getMathEntryEnd(state: EditorState, container: SyntaxNode): number {
  const [mathNode] = descendantsOfNodeWithType(container, 'Math', 'Math')
  const parsed = mathNode ? parseMathContainer(state, mathNode, container) : null
  if (parsed?.displayMode) {
    const { lastContentLine, endLine } = getDisplayMathLineRange(state, container)
    if (lastContentLine < endLine) {
      const line = state.doc.line(lastContentLine)
      return line.to
    }
  }
  return mathNode ? mathNode.to : container.to - 1
}

/**
 * Finds all math containers ($MathContainer, EquationEnvironment, EquationArrayEnvironment)
 * that intersect or are active on the given line.
 */
export function getMathContainersOnLine(
  state: EditorState,
  line: { from: number; to: number }
): SyntaxNode[] {
  const tree = syntaxTree(state)
  const mathContainers: SyntaxNode[] = []
  const seen = new Set<number>()

  tree.iterate({
    from: line.from,
    to: line.to,
    enter(nodeRef) {
      if (
        nodeRef.type.is('$MathContainer') ||
        nodeRef.type.is('EquationEnvironment') ||
        nodeRef.type.is('EquationArrayEnvironment')
      ) {
        if (!seen.has(nodeRef.from)) {
          seen.add(nodeRef.from)
          mathContainers.push(nodeRef.node)
        }
        return false
      }
    },
  })

  if (mathContainers.length === 0) {
    const ancestor =
      mathAncestorNode(state, line.from) ??
      mathAncestorNode(state, line.to) ??
      mathAncestorNode(state, Math.floor((line.from + line.to) / 2))
    if (ancestor && !seen.has(ancestor.from)) {
      mathContainers.push(ancestor)
    }
  }

  return mathContainers
}

function findWidgetElementForNode(view: EditorView, node: SyntaxNode): HTMLElement | null {
  const elements = view.dom.querySelectorAll<HTMLElement>('.ol-cm-math')
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]
    try {
      const pos = view.posAtDOM(el)
      if (pos >= node.from && pos <= node.to) {
        return el
      }
    } catch {
      // Element might be detached or measuring
    }
  }
  return null
}

function tryMoveVertically(
  view: EditorView,
  start: SelectionRange,
  forward: boolean
): SelectionRange | null {
  try {
    const doc = view.dom.ownerDocument || document
    const root = (view.root as any)?.elementFromPoint ? view.root : doc
    if (typeof (root as any).elementFromPoint === 'function') {
      return view.moveVertically(start, forward)
    }
  } catch {
    // If layout is not ready or measuring fails
  }
  return null
}

function findMathAtTarget(
  state: EditorState,
  view: EditorView,
  pos: number,
  forward: boolean,
  goalColumn: number | undefined
): { container: SyntaxNode; isDisplay: boolean } | null {
  // 1. Is pos strictly inside a math container?
  const inside = mathAncestorNode(state, pos)
  if (inside) {
    const [mathNode] = descendantsOfNodeWithType(inside, 'Math', 'Math')
    const parsed = mathNode ? parseMathContainer(state, mathNode, inside) : null
    return { container: inside, isDisplay: parsed?.displayMode ?? false }
  }

  // 2. Is pos at the start or end boundary of a math container?
  const mathBefore = mathAncestorNode(state, pos, 1)
  if (mathBefore && mathBefore.from === pos) {
    const [mathNode] = descendantsOfNodeWithType(mathBefore, 'Math', 'Math')
    const parsed = mathNode ? parseMathContainer(state, mathNode, mathBefore) : null
    return { container: mathBefore, isDisplay: parsed?.displayMode ?? false }
  }

  const mathAfter = mathAncestorNode(state, pos, -1)
  if (mathAfter && mathAfter.to === pos) {
    const [mathNode] = descendantsOfNodeWithType(mathAfter, 'Math', 'Math')
    const parsed = mathNode ? parseMathContainer(state, mathNode, mathAfter) : null
    return { container: mathAfter, isDisplay: parsed?.displayMode ?? false }
  }

  // 3. What if pos is on a line that contains a display math block?
  const line = state.doc.lineAt(pos)
  const mathOnLine = getMathContainersOnLine(state, line)
  for (const m of mathOnLine) {
    const [mathNode] = descendantsOfNodeWithType(m, 'Math', 'Math')
    const parsed = mathNode ? parseMathContainer(state, mathNode, m) : null
    if (parsed?.displayMode) {
      return { container: m, isDisplay: true }
    }
  }

  return null
}

function isCaretAlignedWithMath(
  view: EditorView,
  container: SyntaxNode,
  col: number,
  goalColumn: number | undefined,
  targetLine: { from: number; to: number; text: string }
): boolean {
  const [mathNode] = descendantsOfNodeWithType(container, 'Math', 'Math')
  const parsed = mathNode ? parseMathContainer(view.state, mathNode, container) : null
  if (parsed?.displayMode) {
    return true
  }

  // 1. Check visual DOM rect if goalColumn and widget DOM exist
  if (goalColumn !== undefined) {
    const contentRect = view.contentDOM.getBoundingClientRect()
    const caretX = contentRect.left + goalColumn
    const widgetEl = findWidgetElementForNode(view, container)
    if (widgetEl) {
      const rect = widgetEl.getBoundingClientRect()
      if (rect.width > 0 && caretX >= rect.left - 4 && caretX <= rect.right + 4) {
        return true
      }
    }
  }

  // 2. Check column alignment
  const mathStartCol = Math.max(0, container.from - targetLine.from)
  const mathEndCol = Math.max(0, container.to - targetLine.from)

  if (targetLine.text.trim() === view.state.sliceDoc(container.from, container.to).trim()) {
    return true
  }

  return col >= mathStartCol && col <= mathEndCol
}

function calculateTargetPosInMath(
  view: EditorView,
  container: SyntaxNode,
  col: number,
  goalColumn: number | undefined,
  targetLine: { from: number; to: number; number: number; text: string },
  isDownDirection: boolean
): number {
  const { state } = view
  const [mathNode] = descendantsOfNodeWithType(container, 'Math', 'Math')
  const parsed = mathNode ? parseMathContainer(state, mathNode, container) : null
  const isDisplay = parsed?.displayMode ?? false

  const contentRect = view.contentDOM.getBoundingClientRect()
  const caretX = goalColumn !== undefined ? contentRect.left + goalColumn : undefined

  if (isDisplay) {
    const { firstContentLine, lastContentLine, startLine, endLine } =
      getDisplayMathLineRange(state, container)

    const contentLineNum = isDownDirection ? firstContentLine : lastContentLine
    const contentLine = state.doc.line(contentLineNum)

    const entryStart = getMathEntryStart(state, container)
    const entryEnd = getMathEntryEnd(state, container)

    if (firstContentLine > startLine && lastContentLine < endLine) {
      const indent = contentLine.text.search(/\S/)
      const contentStart = contentLine.from + (indent >= 0 ? indent : 0)
      const contentEnd = contentLine.to

      if (caretX !== undefined) {
        const widgetEl = findWidgetElementForNode(view, container)
        if (widgetEl) {
          const svgEl = widgetEl.querySelector('svg') || widgetEl
          const rect = svgEl.getBoundingClientRect()
          if (rect.width > 0) {
            const ratio = Math.max(0, Math.min(1, (caretX - rect.left) / rect.width))
            const rawTarget = Math.round(contentStart + ratio * (contentEnd - contentStart))
            return Math.max(contentStart, Math.min(contentEnd, rawTarget))
          }
        }
      }

      const targetPos = contentLine.from + Math.max(0, col)
      return Math.max(contentStart, Math.min(contentEnd, targetPos))
    } else {
      if (caretX !== undefined) {
        const widgetEl = findWidgetElementForNode(view, container)
        if (widgetEl) {
          const svgEl = widgetEl.querySelector('svg') || widgetEl
          const rect = svgEl.getBoundingClientRect()
          if (rect.width > 0) {
            const ratio = Math.max(0, Math.min(1, (caretX - rect.left) / rect.width))
            const rawTarget = Math.round(entryStart + ratio * (entryEnd - entryStart))
            return Math.max(entryStart, Math.min(entryEnd, rawTarget))
          }
        }
      }

      const lineCol = Math.max(0, col)
      const mathStartCol = Math.max(0, container.from - targetLine.from)
      const mathEndCol = Math.max(mathStartCol + 1, container.to - targetLine.from)
      const ratio = Math.max(0, Math.min(1, (lineCol - mathStartCol) / (mathEndCol - mathStartCol)))
      const rawTarget = Math.round(entryStart + ratio * (entryEnd - entryStart))
      return Math.max(entryStart, Math.min(entryEnd, rawTarget))
    }
  } else {
    const entryStart = getMathEntryStart(state, container)
    const entryEnd = getMathEntryEnd(state, container)

    if (caretX !== undefined) {
      const widgetEl = findWidgetElementForNode(view, container)
      if (widgetEl) {
        const rect = widgetEl.getBoundingClientRect()
        if (rect.width > 0) {
          const ratio = Math.max(0, Math.min(1, (caretX - rect.left) / rect.width))
          const rawTarget = Math.round(entryStart + ratio * (entryEnd - entryStart))
          return Math.max(entryStart, Math.min(entryEnd, rawTarget))
        }
      }
    }

    const mathStartCol = Math.max(0, container.from - targetLine.from)
    const mathEndCol = Math.max(mathStartCol + 1, container.to - targetLine.from)
    const ratio = Math.max(0, Math.min(1, (col - mathStartCol) / (mathEndCol - mathStartCol)))
    const rawTarget = Math.round(entryStart + ratio * (entryEnd - entryStart))
    return Math.max(entryStart, Math.min(entryEnd, rawTarget))
  }
}

function isMathEnvironmentNode(state: EditorState, node: SyntaxNode): boolean {
  if (
    node.parent &&
    (node.parent.type.is('EquationEnvironment') ||
      node.parent.type.is('EquationArrayEnvironment') ||
      node.parent.type.is('$MathContainer'))
  ) {
    return true
  }
  return mathAncestorNode(state, node.from) !== null
}

export function getEnvTagAtPos(
  state: EditorState,
  pos: number,
  side: number = 0
): { type: 'begin' | 'end'; from: number; to: number } | null {
  const tree = syntaxTree(state)
  const probePos = side > 0 ? pos : side < 0 ? Math.max(0, pos - 1) : pos
  let node: SyntaxNode | null = tree.resolveInner(probePos, side >= 0 ? 1 : -1)
  while (node) {
    if (node.type.is('BeginEnv') || node.type.is('EndEnv')) {
      if (isMathEnvironmentNode(state, node)) {
        return null
      }
      return {
        type: node.type.is('BeginEnv') ? 'begin' : 'end',
        from: node.from,
        to: node.to,
      }
    }
    if (!node.parent || node.parent.type.is('Document')) break
    node = node.parent
  }
  return null
}

export function getEnvTagsOnLine(
  state: EditorState,
  line: { from: number; to: number }
): { type: 'begin' | 'end'; from: number; to: number }[] {
  const tree = syntaxTree(state)
  const tags: { type: 'begin' | 'end'; from: number; to: number }[] = []
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(nodeRef) {
      if (nodeRef.type.is('BeginEnv') || nodeRef.type.is('EndEnv')) {
        if (!isMathEnvironmentNode(state, nodeRef.node)) {
          tags.push({
            type: nodeRef.type.is('BeginEnv') ? 'begin' : 'end',
            from: nodeRef.from,
            to: nodeRef.to,
          })
        }
        return false
      }
    },
  })
  return tags
}

/**
 * Handles ArrowRight navigation for visual math:
 * - When immediately before an inline or display math block, jumps into the math content.
 * - When at the end of the math formula inside a math block, steps out to after the block.
 */
export function jumpArrowRight(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const pos = sel.from

  // Environment tag navigation (\begin{...} and \end{...})
  const insideEnvTag = getEnvTagAtPos(state, pos, 0)
  if (insideEnvTag) {
    if (pos === insideEnvTag.from) {
      view.dispatch({
        selection: EditorSelection.cursor(insideEnvTag.from + 1),
        scrollIntoView: true,
      })
      return true
    }
    if (pos >= insideEnvTag.to - 1 && pos < insideEnvTag.to) {
      view.dispatch({
        selection: EditorSelection.cursor(insideEnvTag.to),
        scrollIntoView: true,
      })
      return true
    }
  }

  const nextEnvTag = getEnvTagAtPos(state, pos, 1)
  if (nextEnvTag && nextEnvTag.from === pos) {
    view.dispatch({
      selection: EditorSelection.cursor(nextEnvTag.from + 1),
      scrollIntoView: true,
    })
    return true
  }

  // Case 1: Cursor is inside a math container
  const insideMath = mathAncestorNode(state, pos)
  if (insideMath) {
    const innerEnd = getMathEntryEnd(state, insideMath)
    if (pos >= innerEnd) {
      view.dispatch({
        selection: EditorSelection.cursor(insideMath.to),
        scrollIntoView: true,
      })
      return true
    }
    return false
  }

  // Case 2: Cursor is immediately before a math container
  const nextMath = mathAncestorNode(state, pos, 1)
  if (nextMath && nextMath.from === pos) {
    const innerStart = getMathEntryStart(state, nextMath)
    view.dispatch({
      selection: EditorSelection.cursor(innerStart),
      scrollIntoView: true,
    })
    return true
  }

  // Case 3: Cursor is at end of line, and next line has display math
  const line = state.doc.lineAt(pos)
  if (pos === line.to && line.number < state.doc.lines) {
    const nextLine = state.doc.line(line.number + 1)
    const mathOnTarget = getMathContainersOnLine(state, nextLine)
    for (const m of mathOnTarget) {
      const [mathNode] = descendantsOfNodeWithType(m, 'Math', 'Math')
      const parsed = mathNode ? parseMathContainer(state, mathNode, m) : null
      if (parsed?.displayMode) {
        const innerStart = getMathEntryStart(state, m)
        view.dispatch({
          selection: EditorSelection.cursor(innerStart),
          scrollIntoView: true,
        })
        return true
      }
    }
  }

  return false
}

/**
 * Handles ArrowLeft navigation for visual math:
 * - When immediately after an inline or display math block, jumps into the math content.
 * - When at the start of the math formula inside a math block, steps out to before the block.
 */
export function jumpArrowLeft(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const pos = sel.from

  // Environment tag navigation (\begin{...} and \end{...})
  const insideEnvTag = getEnvTagAtPos(state, pos, 0)
  if (insideEnvTag) {
    if (pos > insideEnvTag.from && pos <= insideEnvTag.from + 1) {
      view.dispatch({
        selection: EditorSelection.cursor(insideEnvTag.from),
        scrollIntoView: true,
      })
      return true
    }
    if (pos === insideEnvTag.to) {
      view.dispatch({
        selection: EditorSelection.cursor(insideEnvTag.to - 1),
        scrollIntoView: true,
      })
      return true
    }
  }

  const prevEnvTag = getEnvTagAtPos(state, pos, -1)
  if (prevEnvTag && prevEnvTag.to === pos) {
    view.dispatch({
      selection: EditorSelection.cursor(prevEnvTag.to - 1),
      scrollIntoView: true,
    })
    return true
  }

  // Case 1: Cursor is inside a math container
  const insideMath = mathAncestorNode(state, pos)
  if (insideMath) {
    const innerStart = getMathEntryStart(state, insideMath)
    if (pos <= innerStart) {
      view.dispatch({
        selection: EditorSelection.cursor(insideMath.from),
        scrollIntoView: true,
      })
      return true
    }
    return false
  }

  // Case 2: Cursor is immediately after a math container
  const prevMath = mathAncestorNode(state, pos, -1)
  if (prevMath && prevMath.to === pos) {
    const innerEnd = getMathEntryEnd(state, prevMath)
    view.dispatch({
      selection: EditorSelection.cursor(innerEnd),
      scrollIntoView: true,
    })
    return true
  }

  // Case 3: Cursor is at start of line, and previous line ends with display math
  const line = state.doc.lineAt(pos)
  if (pos === line.from && line.number > 1) {
    const prevLine = state.doc.line(line.number - 1)
    const mathOnTarget = getMathContainersOnLine(state, prevLine)
    for (const m of mathOnTarget) {
      const [mathNode] = descendantsOfNodeWithType(m, 'Math', 'Math')
      const parsed = mathNode ? parseMathContainer(state, mathNode, m) : null
      if (parsed?.displayMode) {
        const innerEnd = getMathEntryEnd(state, m)
        view.dispatch({
          selection: EditorSelection.cursor(innerEnd),
          scrollIntoView: true,
        })
        return true
      }
    }
  }

  return false
}

/**
 * Handles ArrowDown navigation for visual math, consistent with the editor width and native movement:
 * - When moving vertically, delegates to native moveVertically to respect wrapped lines, width, and goal column.
 * - When the vertical trajectory hits an inline or display math widget, enters the formula at the proportional X position.
 * - When inside a display math block on its last content line, steps out to the visual line below.
 * - When inside inline math, steps out to the visual line below at the matching goal column / X.
 */
export function jumpArrowDown(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const pos = sel.from
  const curLine = state.doc.lineAt(pos)
  const col = pos - curLine.from

  let goal = sel.goalColumn
  if (goal == null) {
    const coords = view.coordsAtPos(pos, sel.assoc || -1)
    if (coords) {
      goal = coords.left - view.contentDOM.getBoundingClientRect().left
    }
  }

  const revealOnVerticalJump = setting.bool('visual.revealCodeOnVerticalJump')

  // Case 0: Cursor is inside an environment tag (\begin{...} or \end{...})
  const insideEnv = getEnvTagAtPos(state, pos, 0)
  if (insideEnv) {
    if (curLine.number < state.doc.lines) {
      const nextLine = state.doc.line(curLine.number + 1)
      const targetPos = Math.min(nextLine.to, nextLine.from + col)
      const envOnTarget = getEnvTagsOnLine(state, nextLine).find(
        t => targetPos >= t.from && targetPos <= t.to
      )
      if (envOnTarget) {
        if (revealOnVerticalJump) {
          view.dispatch({
            selection: makeSelection(envOnTarget.from + 1, goal),
            scrollIntoView: true,
          })
          return true
        } else {
          const safePos =
            targetPos - envOnTarget.from < envOnTarget.to - targetPos
              ? envOnTarget.from
              : envOnTarget.to
          view.dispatch({
            selection: makeSelection(safePos, goal),
            scrollIntoView: true,
          })
          return true
        }
      }
      view.dispatch({
        selection: makeSelection(targetPos, goal),
        scrollIntoView: true,
      })
      return true
    }
    return false
  }

  // Case 1: Cursor is inside a math container
  const insideMath = mathAncestorNode(state, pos)
  if (insideMath) {
    const [mathNode] = descendantsOfNodeWithType(insideMath, 'Math', 'Math')
    const parsed = mathNode ? parseMathContainer(state, mathNode, insideMath) : null
    const displayMode = parsed?.displayMode ?? false

    if (displayMode) {
      const { lastContentLine, endLine } = getDisplayMathLineRange(state, insideMath)
      if (curLine.number < lastContentLine && curLine.number < endLine) {
        // Move down within multiline display math source
        const nativeMoved = tryMoveVertically(view, sel, true)
        if (nativeMoved && nativeMoved.head < insideMath.to && nativeMoved.head > pos) {
          view.dispatch({ selection: nativeMoved, scrollIntoView: true })
          return true
        }
        const nextLine = state.doc.line(curLine.number + 1)
        const targetPos = Math.min(nextLine.to, nextLine.from + col)
        view.dispatch({
          selection: makeSelection(targetPos, goal),
          scrollIntoView: true,
        })
        return true
      } else {
        // Step out to the line below display math
        const nextLineNumber = endLine + 1
        if (nextLineNumber <= state.doc.lines) {
          const nextLine = state.doc.line(nextLineNumber)
          const targetPos = Math.min(nextLine.to, nextLine.from + (goal != null ? Math.round(goal / view.defaultCharacterWidth) : col))
          view.dispatch({
            selection: makeSelection(targetPos, goal),
            scrollIntoView: true,
          })
          return true
        } else {
          view.dispatch({
            selection: makeSelection(state.doc.length, goal),
            scrollIntoView: true,
          })
          return true
        }
      }
    } else {
      // Inside inline math: step out to the visual line below
      const nativeMoved = tryMoveVertically(view, sel, true)
      if (nativeMoved && (nativeMoved.head < insideMath.from || nativeMoved.head > insideMath.to)) {
        if (revealOnVerticalJump) {
          const mathTarget = findMathAtTarget(state, view, nativeMoved.head, true, nativeMoved.goalColumn ?? goal)
          if (mathTarget) {
            const targetLine = state.doc.lineAt(nativeMoved.head)
            const targetPos = calculateTargetPosInMath(view, mathTarget.container, nativeMoved.head - targetLine.from, nativeMoved.goalColumn ?? goal, targetLine, true)
            view.dispatch({
              selection: makeSelection(targetPos, nativeMoved.goalColumn ?? goal),
              scrollIntoView: true,
            })
            return true
          }
        }
        view.dispatch({ selection: nativeMoved, scrollIntoView: true })
        return true
      }

      if (curLine.number < state.doc.lines) {
        const nextLine = state.doc.line(curLine.number + 1)
        if (revealOnVerticalJump) {
          const mathOnTarget = getMathContainersOnLine(state, nextLine)
          for (const m of mathOnTarget) {
            if (isCaretAlignedWithMath(view, m, col, goal, nextLine)) {
              const targetPos = calculateTargetPosInMath(view, m, col, goal, nextLine, true)
              view.dispatch({
                selection: makeSelection(targetPos, goal),
                scrollIntoView: true,
              })
              return true
            }
          }
        }
        const targetPos = Math.min(nextLine.to, nextLine.from + col)
        view.dispatch({
          selection: makeSelection(targetPos, goal),
          scrollIntoView: true,
        })
        return true
      }
      return false
    }
  }

  // Case 2: Cursor is NOT inside a math container
  const nativeMoved = tryMoveVertically(view, sel, true)
  if (nativeMoved) {
    const envTarget = getEnvTagAtPos(state, nativeMoved.head, 0)
    if (envTarget) {
      if (revealOnVerticalJump) {
        view.dispatch({
          selection: makeSelection(envTarget.from + 1, nativeMoved.goalColumn ?? goal),
          scrollIntoView: true,
        })
        return true
      } else {
        const safePos =
          nativeMoved.head - envTarget.from < envTarget.to - nativeMoved.head
            ? envTarget.from
            : envTarget.to
        view.dispatch({
          selection: makeSelection(safePos, nativeMoved.goalColumn ?? goal),
          scrollIntoView: true,
        })
        return true
      }
    }

    const mathTarget = findMathAtTarget(state, view, nativeMoved.head, true, nativeMoved.goalColumn ?? goal)
    if (mathTarget) {
      if (revealOnVerticalJump) {
        const targetLine = state.doc.lineAt(nativeMoved.head)
        const targetPos = calculateTargetPosInMath(
          view,
          mathTarget.container,
          nativeMoved.head - targetLine.from,
          nativeMoved.goalColumn ?? goal,
          targetLine,
          true
        )
        view.dispatch({
          selection: makeSelection(targetPos, nativeMoved.goalColumn ?? goal),
          scrollIntoView: true,
        })
        return true
      } else {
        if (mathTarget.isDisplay) {
          const { endLine } = getDisplayMathLineRange(state, mathTarget.container)
          const nextLineNumber = endLine + 1
          if (nextLineNumber <= state.doc.lines) {
            const nextLine = state.doc.line(nextLineNumber)
            const targetPos = Math.min(
              nextLine.to,
              nextLine.from + (goal != null ? Math.round(goal / view.defaultCharacterWidth) : col)
            )
            view.dispatch({
              selection: makeSelection(targetPos, goal),
              scrollIntoView: true,
            })
            return true
          } else {
            view.dispatch({
              selection: makeSelection(state.doc.length, goal),
              scrollIntoView: true,
            })
            return true
          }
        } else {
          let targetPos = nativeMoved.head
          if (targetPos > mathTarget.container.from && targetPos < mathTarget.container.to) {
            targetPos = (targetPos - mathTarget.container.from < mathTarget.container.to - targetPos)
              ? mathTarget.container.from
              : mathTarget.container.to
          }
          view.dispatch({
            selection: makeSelection(targetPos, nativeMoved.goalColumn ?? goal),
            scrollIntoView: true,
          })
          return true
        }
      }
    }
    view.dispatch({ selection: nativeMoved, scrollIntoView: true })
    return true
  }

  // Fallback if native vertical jump is not measurable (e.g. headless tests)
  if (curLine.number < state.doc.lines) {
    const nextLine = state.doc.line(curLine.number + 1)
    const targetColPos = Math.min(nextLine.to, nextLine.from + col)
    const envOnTarget = getEnvTagsOnLine(state, nextLine).find(
      t => targetColPos >= t.from && targetColPos <= t.to
    )
    if (envOnTarget) {
      if (revealOnVerticalJump) {
        view.dispatch({
          selection: makeSelection(envOnTarget.from + 1, goal),
          scrollIntoView: true,
        })
        return true
      } else {
        const safePos =
          targetColPos - envOnTarget.from < envOnTarget.to - targetColPos
            ? envOnTarget.from
            : envOnTarget.to
        view.dispatch({
          selection: makeSelection(safePos, goal),
          scrollIntoView: true,
        })
        return true
      }
    }

    const mathOnTarget = getMathContainersOnLine(state, nextLine)
    for (const m of mathOnTarget) {
      if (isCaretAlignedWithMath(view, m, col, goal, nextLine)) {
        if (revealOnVerticalJump) {
          const targetPos = calculateTargetPosInMath(view, m, col, goal, nextLine, true)
          view.dispatch({
            selection: makeSelection(targetPos, goal),
            scrollIntoView: true,
          })
          return true
        } else {
          const [mathNode] = descendantsOfNodeWithType(m, 'Math', 'Math')
          const parsed = mathNode ? parseMathContainer(state, mathNode, m) : null
          if (parsed?.displayMode) {
            const { endLine } = getDisplayMathLineRange(state, m)
            const nextLineNumber = endLine + 1
            if (nextLineNumber <= state.doc.lines) {
              const afterLine = state.doc.line(nextLineNumber)
              const targetPos = Math.min(
                afterLine.to,
                afterLine.from + (goal != null ? Math.round(goal / view.defaultCharacterWidth) : col)
              )
              view.dispatch({
                selection: makeSelection(targetPos, goal),
                scrollIntoView: true,
              })
              return true
            } else {
              view.dispatch({
                selection: makeSelection(state.doc.length, goal),
                scrollIntoView: true,
              })
              return true
            }
          } else {
            let targetPos = Math.min(nextLine.to, nextLine.from + col)
            if (targetPos > m.from && targetPos < m.to) {
              targetPos = (targetPos - m.from < m.to - targetPos) ? m.from : m.to
            }
            view.dispatch({
              selection: makeSelection(targetPos, goal),
              scrollIntoView: true,
            })
            return true
          }
        }
      }
    }
    const targetPos = Math.min(nextLine.to, nextLine.from + col)
    view.dispatch({
      selection: makeSelection(targetPos, goal),
      scrollIntoView: true,
    })
    return true
  }

  return false
}

/**
 * Handles ArrowUp navigation for visual math, consistent with the editor width and native movement:
 * - When moving vertically, delegates to native moveVertically to respect wrapped lines, width, and goal column.
 * - When the vertical trajectory hits an inline or display math widget, enters the formula at the proportional X position.
 * - When inside a display math block on its first content line, steps out to the visual line above.
 * - When inside inline math, steps out to the visual line above at the matching goal column / X.
 */
export function jumpArrowUp(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const pos = sel.from
  const curLine = state.doc.lineAt(pos)
  const col = pos - curLine.from

  let goal = sel.goalColumn
  if (goal == null) {
    const coords = view.coordsAtPos(pos, sel.assoc || -1)
    if (coords) {
      goal = coords.left - view.contentDOM.getBoundingClientRect().left
    }
  }

  const revealOnVerticalJump = setting.bool('visual.revealCodeOnVerticalJump')

  // Case 0: Cursor is inside an environment tag (\begin{...} or \end{...})
  const insideEnv = getEnvTagAtPos(state, pos, 0)
  if (insideEnv) {
    if (curLine.number > 1) {
      const prevLine = state.doc.line(curLine.number - 1)
      const targetPos = Math.min(prevLine.to, prevLine.from + col)
      const envOnTarget = getEnvTagsOnLine(state, prevLine).find(
        t => targetPos >= t.from && targetPos <= t.to
      )
      if (envOnTarget) {
        if (revealOnVerticalJump) {
          view.dispatch({
            selection: makeSelection(envOnTarget.from + 1, goal),
            scrollIntoView: true,
          })
          return true
        } else {
          const safePos =
            targetPos - envOnTarget.from < envOnTarget.to - targetPos
              ? envOnTarget.from
              : envOnTarget.to
          view.dispatch({
            selection: makeSelection(safePos, goal),
            scrollIntoView: true,
          })
          return true
        }
      }
      view.dispatch({
        selection: makeSelection(targetPos, goal),
        scrollIntoView: true,
      })
      return true
    }
    return false
  }

  // Case 1: Cursor is inside a math container
  const insideMath = mathAncestorNode(state, pos)
  if (insideMath) {
    const [mathNode] = descendantsOfNodeWithType(insideMath, 'Math', 'Math')
    const parsed = mathNode ? parseMathContainer(state, mathNode, insideMath) : null
    const displayMode = parsed?.displayMode ?? false

    if (displayMode) {
      const { firstContentLine, startLine } = getDisplayMathLineRange(state, insideMath)
      if (curLine.number > firstContentLine && curLine.number > startLine) {
        // Move up within multiline display math source
        const nativeMoved = tryMoveVertically(view, sel, false)
        if (nativeMoved && nativeMoved.head > insideMath.from && nativeMoved.head < pos) {
          view.dispatch({ selection: nativeMoved, scrollIntoView: true })
          return true
        }
        const prevLine = state.doc.line(curLine.number - 1)
        const targetPos = Math.min(prevLine.to, prevLine.from + col)
        view.dispatch({
          selection: makeSelection(targetPos, goal),
          scrollIntoView: true,
        })
        return true
      } else {
        // Step out to the line above display math
        const prevLineNumber = startLine - 1
        if (prevLineNumber >= 1) {
          const prevLine = state.doc.line(prevLineNumber)
          const targetPos = Math.min(prevLine.to, prevLine.from + (goal != null ? Math.round(goal / view.defaultCharacterWidth) : col))
          view.dispatch({
            selection: makeSelection(targetPos, goal),
            scrollIntoView: true,
          })
          return true
        } else {
          view.dispatch({
            selection: makeSelection(0, goal),
            scrollIntoView: true,
          })
          return true
        }
      }
    } else {
      // Inside inline math: step out to the visual line above
      const nativeMoved = tryMoveVertically(view, sel, false)
      if (nativeMoved && (nativeMoved.head < insideMath.from || nativeMoved.head > insideMath.to)) {
        if (revealOnVerticalJump) {
          const mathTarget = findMathAtTarget(state, view, nativeMoved.head, false, nativeMoved.goalColumn ?? goal)
          if (mathTarget) {
            const targetLine = state.doc.lineAt(nativeMoved.head)
            const targetPos = calculateTargetPosInMath(view, mathTarget.container, nativeMoved.head - targetLine.from, nativeMoved.goalColumn ?? goal, targetLine, false)
            view.dispatch({
              selection: makeSelection(targetPos, nativeMoved.goalColumn ?? goal),
              scrollIntoView: true,
            })
            return true
          }
        }
        view.dispatch({ selection: nativeMoved, scrollIntoView: true })
        return true
      }

      if (curLine.number > 1) {
        const prevLine = state.doc.line(curLine.number - 1)
        if (revealOnVerticalJump) {
          const mathOnTarget = getMathContainersOnLine(state, prevLine)
          for (const m of mathOnTarget) {
            if (isCaretAlignedWithMath(view, m, col, goal, prevLine)) {
              const targetPos = calculateTargetPosInMath(view, m, col, goal, prevLine, false)
              view.dispatch({
                selection: makeSelection(targetPos, goal),
                scrollIntoView: true,
              })
              return true
            }
          }
        }
        const targetPos = Math.min(prevLine.to, prevLine.from + col)
        view.dispatch({
          selection: makeSelection(targetPos, goal),
          scrollIntoView: true,
        })
        return true
      }
      return false
    }
  }

  // Case 2: Cursor is NOT inside a math container
  const nativeMoved = tryMoveVertically(view, sel, false)
  if (nativeMoved) {
    const envTarget = getEnvTagAtPos(state, nativeMoved.head, 0)
    if (envTarget) {
      if (revealOnVerticalJump) {
        view.dispatch({
          selection: makeSelection(envTarget.from + 1, nativeMoved.goalColumn ?? goal),
          scrollIntoView: true,
        })
        return true
      } else {
        const safePos =
          nativeMoved.head - envTarget.from < envTarget.to - nativeMoved.head
            ? envTarget.from
            : envTarget.to
        view.dispatch({
          selection: makeSelection(safePos, nativeMoved.goalColumn ?? goal),
          scrollIntoView: true,
        })
        return true
      }
    }

    const mathTarget = findMathAtTarget(state, view, nativeMoved.head, false, nativeMoved.goalColumn ?? goal)
    if (mathTarget) {
      if (revealOnVerticalJump) {
        const targetLine = state.doc.lineAt(nativeMoved.head)
        const targetPos = calculateTargetPosInMath(
          view,
          mathTarget.container,
          nativeMoved.head - targetLine.from,
          nativeMoved.goalColumn ?? goal,
          targetLine,
          false
        )
        view.dispatch({
          selection: makeSelection(targetPos, nativeMoved.goalColumn ?? goal),
          scrollIntoView: true,
        })
        return true
      } else {
        if (mathTarget.isDisplay) {
          const { startLine } = getDisplayMathLineRange(state, mathTarget.container)
          const prevLineNumber = startLine - 1
          if (prevLineNumber >= 1) {
            const prevLine = state.doc.line(prevLineNumber)
            const targetPos = Math.min(
              prevLine.to,
              prevLine.from + (goal != null ? Math.round(goal / view.defaultCharacterWidth) : col)
            )
            view.dispatch({
              selection: makeSelection(targetPos, goal),
              scrollIntoView: true,
            })
            return true
          } else {
            view.dispatch({
              selection: makeSelection(0, goal),
              scrollIntoView: true,
            })
            return true
          }
        } else {
          let targetPos = nativeMoved.head
          if (targetPos > mathTarget.container.from && targetPos < mathTarget.container.to) {
            targetPos = (targetPos - mathTarget.container.from < mathTarget.container.to - targetPos)
              ? mathTarget.container.from
              : mathTarget.container.to
          }
          view.dispatch({
            selection: makeSelection(targetPos, nativeMoved.goalColumn ?? goal),
            scrollIntoView: true,
          })
          return true
        }
      }
    }
    view.dispatch({ selection: nativeMoved, scrollIntoView: true })
    return true
  }

  if (curLine.number > 1) {
    const prevLine = state.doc.line(curLine.number - 1)
    const targetColPos = Math.min(prevLine.to, prevLine.from + col)
    const envOnTarget = getEnvTagsOnLine(state, prevLine).find(
      t => targetColPos >= t.from && targetColPos <= t.to
    )
    if (envOnTarget) {
      if (revealOnVerticalJump) {
        view.dispatch({
          selection: makeSelection(envOnTarget.from + 1, goal),
          scrollIntoView: true,
        })
        return true
      } else {
        const safePos =
          targetColPos - envOnTarget.from < envOnTarget.to - targetColPos
            ? envOnTarget.from
            : envOnTarget.to
        view.dispatch({
          selection: makeSelection(safePos, goal),
          scrollIntoView: true,
        })
        return true
      }
    }

    const mathOnTarget = getMathContainersOnLine(state, prevLine)
    for (const m of mathOnTarget) {
      if (isCaretAlignedWithMath(view, m, col, goal, prevLine)) {
        if (revealOnVerticalJump) {
          const targetPos = calculateTargetPosInMath(view, m, col, goal, prevLine, false)
          view.dispatch({
            selection: makeSelection(targetPos, goal),
            scrollIntoView: true,
          })
          return true
        } else {
          const [mathNode] = descendantsOfNodeWithType(m, 'Math', 'Math')
          const parsed = mathNode ? parseMathContainer(state, mathNode, m) : null
          if (parsed?.displayMode) {
            const { startLine } = getDisplayMathLineRange(state, m)
            const prevLineNumber = startLine - 1
            if (prevLineNumber >= 1) {
              const aboveLine = state.doc.line(prevLineNumber)
              const targetPos = Math.min(
                aboveLine.to,
                aboveLine.from + (goal != null ? Math.round(goal / view.defaultCharacterWidth) : col)
              )
              view.dispatch({
                selection: makeSelection(targetPos, goal),
                scrollIntoView: true,
              })
              return true
            } else {
              view.dispatch({
                selection: makeSelection(0, goal),
                scrollIntoView: true,
              })
              return true
            }
          } else {
            let targetPos = Math.min(prevLine.to, prevLine.from + col)
            if (targetPos > m.from && targetPos < m.to) {
              targetPos = (targetPos - m.from < m.to - targetPos) ? m.from : m.to
            }
            view.dispatch({
              selection: makeSelection(targetPos, goal),
              scrollIntoView: true,
            })
            return true
          }
        }
      }
    }
    const targetPos = Math.min(prevLine.to, prevLine.from + col)
    view.dispatch({
      selection: makeSelection(targetPos, goal),
      scrollIntoView: true,
    })
    return true
  }

  return false
}
