import {
  EditorState,
  Extension,
  Range,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view'
import { SyntaxNode, Tree } from '@lezer/common'
import { syntaxTree } from '@codemirror/language'
import {
  hasMouseDownEffect,
  mouseDownEffect,
  selectionIntersects,
  extendBackwardsOverEmptyLines,
  extendForwardsOverEmptyLines,
} from './selection'
import { ItemWidget } from './visual-widgets/item'
import { LaTeXWidget } from './visual-widgets/latex'
import { BraceWidget } from './visual-widgets/brace'
import { ancestorNodeOfType } from '../../utils/tree-query'
import { MakeTitleWidget } from './visual-widgets/maketitle'
import { BeginWidget } from './visual-widgets/begin'
import { EndWidget } from './visual-widgets/end'
import {
  getEnvironmentArguments,
  getEnvironmentName,
  getUnstarredEnvironmentName,
  parseFigureData,
  hasMatchingEnvironmentEnd,
  hasMatchingEnvironmentBegin,
} from '../../utils/tree-operations/environments'
import { MathWidget } from './visual-widgets/math'
import { IconBraceWidget } from './visual-widgets/icon-brace'
import { LabelIconWidget } from './visual-widgets/label-icon'
import { TeXWidget } from './visual-widgets/tex'
import {
  createCharacterCommand,
  hasCharacterSubstitution,
} from './visual-widgets/character'
import { centeringNodeForEnvironment } from '../../utils/tree-operations/figure'
import { Frame, FrameWidget } from './visual-widgets/frame'
import { DividerWidget } from './visual-widgets/divider'
import { Preamble, PreambleWidget } from './visual-widgets/preamble'
import { EndDocumentWidget } from './visual-widgets/end-document'
import { EnvironmentLineWidget } from './visual-widgets/environment-line'
import {
  ListEnvironmentName,
  ancestorOfNodeWithType,
  isDirectChildOfEnvironment,
} from '../../utils/tree-operations/ancestors'
import { EditableGraphicsWidget } from './visual-widgets/editable-graphics'
import { EditableInlineGraphicsWidget } from './visual-widgets/editable-inline-graphics'
import {
  CloseBrace,
  OpenBrace,
  CloseBracket,
  OpenBracket,
  OptionalArgument,
  ShortTextArgument,
  TextArgument,
} from '../../lezer-latex/latex.terms.mjs'
import { FootnoteWidget } from './visual-widgets/footnote'
import { getListItems } from '../toolbar/lists'
import { TildeWidget } from './visual-widgets/tilde'
import { BeginTheoremWidget } from './visual-widgets/begin-theorem'
import {
  parseTheoremArguments,
  parseAllTheoremDeclarations,
  TheoremCounterManager,
} from '../../utils/tree-operations/theorems'
import { IndicatorWidget } from './visual-widgets/indicator'
import { TabularWidget } from './visual-widgets/tabular'
import { nextSnippetField, pickedCompletion } from '@codemirror/autocomplete'
import { skipPreambleWithCursor } from './skip-preamble-cursor'
import { TableRenderingErrorWidget } from './visual-widgets/table-rendering-error'
import { GraphicsWidget } from './visual-widgets/graphics'
import { InlineGraphicsWidget } from './visual-widgets/inline-graphics'
import { selectDecoratedArgument } from './select-decorated-argument'
import {
  generateTable,
  ParsedTableData,
  validateParsedTable,
} from '../../components/table-generator/utils'
import { debugConsole } from '@/vendor/overleaf/eukolia/debugging'
import { DescriptionItemWidget } from './visual-widgets/description-item'
import {
  createSpaceCommand,
  hasSpaceSubstitution,
} from '@/vendor/overleaf/extensions/visual/visual-widgets/space'
import {
  mathAncestorNode,
  parseMathContainer,
} from '../../utils/tree-operations/math'
import { nodeHasError } from '../../utils/tree-operations/common'
import { lineContainsOnlyNode } from './utils/line'
import { previewByPathFacet } from '../file-preview'
// Eukolia: the project's macro definitions, which live in a file this document
// `\input`s rather than in its own preamble, and the definitions Eukolia supplies
// for what MathJax does not know at all. See `editor/projectMacros.ts` and
// `visual/builtinPreamble.ts`.
import { effectsCarryProjectMacros, composeMacroPreamble } from '@/editor/projectMacros'
import { builtInMathDefinitions, isUnrenderableMathEnvironment, BUILT_IN_THEOREM_ENVIRONMENTS } from '@/visual/builtinPreamble'
// Eukolia: the document size at which a decoration set stops describing the whole
// document. It moved into `visual/largeDocument.ts` — it is a statement about
// document size, which is what that module is for — and the move left this
// reference behind without the import, so the constant was undefined at the one
// place that decides whether a build is bounded.
import { VIEWPORT_BOUNDED_DECORATION_LINES } from '@/visual/largeDocument'
import { UnrenderableMathWidget } from './visual-widgets/unrenderable-math'
import { QedWidget } from './visual-widgets/qed'

function shouldDecorate(
  state: EditorState,
  extents: { from: number; to: number }
) {
  return state.readOnly || !selectionIntersects(state.selection, extents)
}

function shouldDecorateEnvTag(
  state: EditorState,
  node: { from: number; to: number }
) {
  if (state.readOnly) return true
  return !state.selection.ranges.some(range => {
    if (range.empty) {
      return node.from < range.from && range.from < node.to
    }
    return range.from < node.to && range.to > node.from
  })
}

function shouldDecorateMath(
  state: EditorState,
  ancestorNode: { from: number; to: number }
) {
  if (state.readOnly) return true
  return !state.selection.ranges.some(range => {
    if (range.empty) {
      return ancestorNode.from < range.from && range.from < ancestorNode.to
    }
    return range.from < ancestorNode.to && range.to > ancestorNode.from
  })
}

function shouldDecorateFromLineEdges(
  state: EditorState,
  extents: { from: number; to: number }
) {
  return shouldDecorate(state, {
    from: state.doc.lineAt(extents.from).from,
    to: state.doc.lineAt(extents.to).to,
  })
}

function decorateArgumentBraces(
  startWidget: WidgetType,
  argumentNode: SyntaxNode | null | undefined,
  start: number,
  decorateEmptyArguments = false,
  endWidget?: WidgetType,
  braceTypes = {
    open: OpenBrace,
    close: CloseBrace,
  }
): Range<Decoration>[] {
  if (!argumentNode) {
    return []
  }
  const openBrace = argumentNode.getChild(braceTypes.open)
  const closeBrace = argumentNode.getChild(braceTypes.close)

  if (openBrace && closeBrace) {
    if (
      // Make sure that decoration ranges are non-empty
      openBrace.to > start &&
      (decorateEmptyArguments || argumentNode.to - argumentNode.from > 2)
    ) {
      return [
        Decoration.replace({
          widget: startWidget,
        }).range(start, openBrace.to),

        Decoration.replace({
          widget: endWidget,
        }).range(closeBrace.from, closeBrace.to),
      ]
    }
  }
  return []
}

const hasClosingBrace = (node: SyntaxNode) =>
  node.getChild('EnvNameGroup')?.getChild('CloseBrace')

/**
 * Eukolia — the un-renderable environment a piece of mathematics *is*.
 *
 * The node-based lookup in `parseMathContainer` asks the `$Environment` ancestor
 * what it is called, which is right when the environment is the outermost thing.
 * It is wrong when the environment sits inside display brackets, and that is the
 * shape every real document uses:
 *
 * ```
 * \[
 * \begin{tikzcd} … \end{tikzcd}
 * \]
 * ```
 *
 * There the mathematics handed over is the whole `\begin{tikzcd}…\end{tikzcd}`
 * body, and `mathAncestorNode` reports the `BracketMath` of the brackets — the
 * port's ancestor search stops at the first `$MathContainer`, and the brackets are
 * one. The name is in the content, so it is read from there, which works whichever
 * shape the document used. Only the first `\begin{…}` is considered: it is the
 * environment being rendered, and a nested one inside it is that environment's
 * business.
 */
const unrenderableEnvironmentIn = (content: string): string | null => {
  /**
   * Deliberately not anchored, and that is the whole subtlety.
   *
   * The content this is handed is the text of a `Math` node **including the
   * delimiters** — measured on a real document, `" \\begin{tikzcd} X\\times Z
   * \\ar[r] … \\end{tikzcd} "`, with a leading space where the `\[` was and a
   * trailing one where the `\]` is. An anchored `/^\\begin/` therefore matches
   * nothing, the check falls through, and the environment goes to MathJax anyway —
   * which is exactly how the first version of this helper failed while looking
   * correct.
   */
  const match = /\\begin\s*\{([^}]+)\}/.exec(content)
  if (!match) return null
  const name = match[1].trim()
  return isUnrenderableMathEnvironment(name) ? name : null
}

/**
 * Commands that can only appear in a preamble.
 *
 * This is the whole test for "is this file a preamble fragment" (see the call site
 * in `createDecorations`). It is deliberately tiny, and every entry has to earn its
 * place: a command that *can* appear in a document body must not be here, or a
 * document that uses it would be folded away as a preamble.
 *
 * `\documentclass` and `\usepackage` are the two that LaTeX forbids in a body, and
 * between them they cover every macro file a reader is likely to have. `\newtheorem`
 * and `\theoremstyle` are here because a fragment that only declares its environments
 * — which is a common way to split a long preamble — would otherwise have neither.
 */
const PREAMBLE_ONLY_COMMANDS = new Set([
  'DocumentClass',
  'UsePackage',
  'NewTheoremCommand',
  'TheoremStyleCommand',
])

/** Whether a document with no body contains something only a preamble can hold. */
const hasPreambleOnlyCommand = (tree: Tree): boolean => {
  let found = false
  tree.iterate({
    enter(nodeRef) {
      if (!PREAMBLE_ONLY_COMMANDS.has(nodeRef.name)) return undefined
      found = true
      return false
    },
  })
  return found
}



/** Whether a node overlaps any of the ranges a build was asked for. */
const intersectsAny = (
  ranges: readonly { from: number; to: number }[],
  node: { from: number; to: number }
): boolean => {
  for (const range of ranges) {
    if (node.from < range.to && node.to > range.from) return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 * Eukolia — the context a bounded walk has to start with.
 *
 * Three things the decoration walk accumulates are **not** properties of the
 * viewport: which list environment is open (and how many items it has seen), where
 * the theorem counter stands, and which macros have been defined. A walk that begins
 * in the middle of the document has to be told them, or an `\item` in view is
 * numbered 1, a theorem is numbered from the wrong section, and the mathematics on
 * screen is typeset without the project's macros.
 *
 * The first version of the bound got them by walking from position 0 and skipping
 * only the *decorating* work — which is correct, and is not a bound at all: the walk
 * is still linear in the document, and it measured 55 ms against the whole-document
 * build's 75 ms on `cohomology.tex`, both of them in a frame whose budget is 16 ms.
 * `@lezer/common` offers no way to begin an iteration in the middle of a tree while
 * keeping the ancestors' context, so the context is *scanned* to the boundary here
 * and the walk starts at the boundary with it.
 *
 * The scan is O(position) but it is the cheapest possible such pass: one string
 * comparison per node against a switch, no widget, no decoration, no `DecorationSet`
 * range, no `sliceDoc` except for a macro definition. Measured on `cohomology.tex`
 * at line 7 264 it is well under a millisecond, against the ~55 ms the full walk
 * costs — and it is memoised per `Tree`, so the walk that follows a keystroke reuses
 * the answer it computed for the previous one.
 * ------------------------------------------------------------------ */

/** The accumulated state of a decoration walk at one document position. */
interface WalkContext {
  listEnvironment: ListEnvironmentName | undefined
  listEnvironmentStack: ListEnvironmentName[]
  ordinal: number
  ordinalStack: number[]
  listDepth: number
  /** The macro definitions seen, in order — what the mathematics is typeset with. */
  commandDefinitions: string
}

const EMPTY_CONTEXT: WalkContext = {
  listEnvironment: undefined,
  listEnvironmentStack: [],
  ordinal: 0,
  ordinalStack: [],
  listDepth: 0,
  commandDefinitions: '',
}

/** The definition nodes whose text becomes part of the macro preamble. */
const DEFINES_A_MACRO = new Set([
  'NewCommand',
  'RenewCommand',
  'Def',
  'RenewEnvironment',
  'NewEnvironment',
  'Let',
])

/**
 * The node types `scanContextUpTo` counts, and therefore the ones the walk that
 * follows it must not count a second time.
 *
 * Kept beside the scan rather than inside the walk, because the two are one rule
 * stated twice and they have to agree: a type added to the scan and forgotten here
 * is an ordinal or a theorem number counted twice. `viewportBounding.test.ts` is the
 * guard on that agreement.
 */
const isCountedByTheScan = (type: { is(name: string): boolean; name: string }): boolean =>
  type.name === 'Item' ||
  type.name === 'SectioningCommand' ||
  DEFINES_A_MACRO.has(type.name)

/**
 * The counters a sectioning command steps.
 *
 * A `Record` rather than the walk's own `if`/`else if` chain, because the scan below
 * has to step the *same* counter for the *same* control sequence and the two must not
 * be able to disagree: a section counted twice would shift every theorem number after
 * it.
 */
type CounterStep = 'stepChapter' | 'stepSection' | 'stepSubsection' | 'stepSubsubsection'

const COUNTER_STEP: Record<string, CounterStep> = {
  chapter: 'stepChapter',
  section: 'stepSection',
  subsection: 'stepSubsection',
  subsubsection: 'stepSubsubsection',
}

/**
 * The counter named by a control sequence, or null for one that steps none.
 *
 * `\section*` is not numbered, which is why the star is tested — the walk's own
 * version of this rule is in the `$SectioningCtrlSeq` branch below.
 */
const counterStepFor = (controlSequence: string): CounterStep | null =>
  controlSequence.endsWith('*') ? null : (COUNTER_STEP[controlSequence] ?? null)

/**
 * The context the walk should have when it reaches `end`, computed by a cheap pass.
 *
 * A **complete** pass over the prefix, from position 0 to `end`, so that it and the
 * walk that follows it partition the document exactly: everything ending at or before
 * `end` is counted here, everything after it is decorated there. That exactness is
 * the whole difficulty, and it is not something `@lezer/common`'s `iterate` bounds
 * give: a query with `to: end` visits nodes *starting* before `end`, so a node that
 * straddles the boundary is visited by the scan and again by the walk — which
 * double-counted an `\item` ordinal and was caught by
 * `viewportBounding.test.ts`. The guard at the top of the walk (`nodeRef.to <= end`)
 * is what splits them.
 *
 * The list context is carried by `BeginEnv`/`EndEnv` rather than by the
 * `$Environment` node that contains them, because that is where the environment's
 * name is — and it is the `BeginEnv` node that made the first version of the bound
 * wrong.
 *
 * `theoremCounterManager` is stepped in place: it is the same object the walk then
 * continues with, which is what makes the numbering continuous rather than restarted.
 */
const scanContextUpTo = (
  state: EditorState,
  tree: Tree,
  end: number,
  theoremCounterManager: TheoremCounterManager
): WalkContext => {
  const context: WalkContext = {
    listEnvironment: undefined,
    listEnvironmentStack: [],
    ordinal: 0,
    ordinalStack: [],
    listDepth: 0,
    commandDefinitions: '',
  }

  const isListEnvironment = (
    name: string | undefined | null
  ): name is ListEnvironmentName =>
    name === 'itemize' || name === 'enumerate' || name === 'description'

  tree.iterate({
    from: 0,
    to: end,
    enter(nodeRef) {
      /*
       * A node that straddles the boundary belongs to the walk, not to the scan.
       *
       * `iterate({to: end})` visits nodes that *begin* before `end`, so the last
       * group of nodes it hands over can reach past it — the `Item` node of the item
       * sitting on the boundary line is the case that matters, and counting it here
       * as well as there numbered every item in the document one too high. The test
       * is on `nodeRef.from`, matching the walk's own `contextEnd` test, so the two
       * passes agree about which of them owns a straddling node.
       */
      if (nodeRef.from >= end) return false

      switch (nodeRef.name) {
        case 'BeginEnv': {
          const envName = getUnstarredEnvironmentName(nodeRef.node, state)
          if (isListEnvironment(envName)) {
            if (context.listEnvironment) {
              context.listEnvironmentStack.push(context.listEnvironment)
              context.ordinalStack.push(context.ordinal)
            }
            context.listEnvironment = envName
            context.ordinal = 0
            context.listDepth += 1
          }
          return undefined
        }
        case 'EndEnv': {
          const envName = getUnstarredEnvironmentName(nodeRef.node, state)
          if (isListEnvironment(envName)) {
            if (context.listEnvironment === envName) {
              context.listEnvironment = context.listEnvironmentStack.pop()
              context.ordinal = context.ordinalStack.pop() ?? 0
            }
            context.listDepth = Math.max(0, context.listDepth - 1)
          }
          return undefined
        }
        case 'Item':
          context.ordinal += 1
          return undefined
        case 'SectioningCommand': {
          const controlSequence = nodeRef.node.getChild('$CtrlSeq')
          if (controlSequence) {
            const step = counterStepFor(
              state.sliceDoc(controlSequence.from + 1, controlSequence.to)
            )
            if (step) theoremCounterManager[step]()
          }
          // The walk reaches the same command again through its `$SectioningCtrlSeq`
          // child, so descending into it would step the counter twice.
          return false
        }
        default:
          break
      }
      if (DEFINES_A_MACRO.has(nodeRef.name)) {
        const content = state.sliceDoc(nodeRef.from, nodeRef.to)
        if (content) context.commandDefinitions += `${content}\n`
      }
      return undefined
    },
  })

  return context
}

/**
 * Memoised `scanContextUpTo`, per tree.
 *
 * A tree is replaced when the parse advances and is *reused* by every transaction
 * that does not move the parse, so a rebuild caused by the selection or by the
 * viewport moving a few lines gets the previous scan's answer for nothing. The key is
 * the boundary as well as the tree, because scrolling moves it.
 *
 * One entry per tree, which is all that can be reused: the tree changes more often
 * than the boundary does while typing.
 */
const contextCache = new WeakMap<Tree, { end: number; context: WalkContext }>()

const contextAt = (
  state: EditorState,
  tree: Tree,
  end: number,
  theoremCounterManager: TheoremCounterManager
): WalkContext => {
  const cached = contextCache.get(tree)
  if (cached && cached.end === end) return cached.context
  const context = scanContextUpTo(state, tree, end, theoremCounterManager)
  contextCache.set(tree, { end, context })
  return context
}

/**
 * Eukolia — where the document's preamble ends.
 *
 * Lifted out of the decoration walk, which used to discover it while building
 * widgets for the whole file. The answer is a property of the **document**, not of
 * the viewport: it is the position of the first `\begin{document}`'s content, or of
 * `\maketitle`, or of the last `\title`/`\author`/`\Affil` before them. The walk
 * below needs it to decide what a viewport decorates — the preamble is a block
 * decoration from position 0, so a reader scrolled to line 9 000 must still see it
 * collapsed — and it must be the same answer whatever part of the file is on
 * screen. Computing it here, once, is what lets the decoration walk skip the rest
 * of the document instead of reconstructing this by looking at every node in it.
 *
 * `seenDocumentEnvironment` is returned rather than folded in because the caller
 * needs it for the second half of the rule: a file with no document environment at
 * all is entirely preamble, but only if it holds a command only a preamble can
 * (see `hasPreambleOnlyCommand`).
 */
const scanPreamble = (
  state: EditorState,
  tree: Tree
): { preamble: Preamble; seenDocumentEnvironment: boolean } => {
  const preamble: Preamble = { from: 0, to: 0, authors: [] }
  let seenDocumentEnvironment = false

  tree.iterate({
    enter(nodeRef) {
      const node = nodeRef.node
      if (node.type.is('Maketitle')) {
        // end the preamble at \maketitle, if it's directly inside the document environment
        const parentEnvironment = ancestorOfNodeWithType(node, '$Environment')
        if (parentEnvironment?.type.is('DocumentEnvironment')) {
          preamble.to = node.from
        }
      } else if (node.type.is('DocumentEnvironment')) {
        // only count the first instance of DocumentEnvironment
        if (!seenDocumentEnvironment) {
          preamble.to = node.getChild('Content')?.from ?? node.from
          seenDocumentEnvironment = true
          // The preamble cannot extend past this point and nothing later can move
          // it, so the rest of the document is not this scan's business.
          return false
        }
      } else if (node.type.is('Title')) {
        const argument = node.getChild('TextArgument')
        if (argument) {
          preamble.title = {
            node: argument,
            content: state.sliceDoc(argument.from, argument.to),
          }
          preamble.to = node.to
        }
      } else if (node.type.is('Author')) {
        const argument = node.getChild('TextArgument')
        if (argument) {
          preamble.authors.push({
            node: argument,
            content: state.sliceDoc(argument.from, argument.to),
          })
          preamble.to = node.to
        }
      } else if (node.type.is('Affil') || node.type.is('Affiliation')) {
        const argument = node.getChild('TextArgument')
        if (argument) {
          preamble.to = node.to
        }
      }
      return undefined
    },
  })

  return { preamble, seenDocumentEnvironment }
}

/**
 * The decorations the visual editor paints, for the ranges it was asked about.
 *
 * **Eukolia, and the change that makes a large document usable.** The reference —
 * and this function until it was measured — walks the *whole* syntax tree and
 * builds a widget object for every construct in the document, on every rebuild,
 * and a rebuild is per keystroke. Measured on the Stacks project's `cohomology.tex`
 * (14 529 lines, 519 KB, 7 300 inline mathematics regions) that is **107 ms** of
 * decoration building in a frame whose budget is 16 ms, for a document whose
 * visible part is thirty lines; the probe's own numbers agree (118 ms per typed
 * character, a worst frame of 1 445 ms). None of that work can be seen.
 *
 * So the walk is bounded: `ranges` are the parts of the document the caller wants
 * decorated — the viewport, in the application — and a construct that does not
 * overlap one is skipped before it is turned into a widget. Three things are
 * deliberately *not* bounded, because they are whole-document facts and bounding
 * them would change the answer rather than only the cost:
 *
 *  * the **list context** (`startListEnvironment`/`endListEnvironment` and the item
 *    ordinal), because `\item` numbering is a count from the start of the document
 *    and a reader scrolled to item 9 must see "9";
 *  * the **theorem counter** (`$SectioningCtrlSeq`), for the same reason: a theorem
 *    in view is numbered by the sections before it;
 *  * the **macro definitions** gathered along the way, because a viewport equation
 *    may use one.
 *
 * Those three are the `invocationObligatory` set below, and they are cheap — a
 * comparison and two string slices per node, against constructing a `Decoration`,
 * a `MathWidget` and a `DecorationSet` range per equation. Everything else is
 * behind `intersectsAny`.
 *
 * `ranges` must be ordered and non-overlapping (`view.visibleRanges` is both), and
 * empty means **the whole document** — which is what a caller with no viewport
 * wants and what a test reading decorations out of a bare `EditorState` gets.
 */
export const createDecorations = (
  state: EditorState,
  tree: Tree,
  ranges: readonly { from: number; to: number }[]
): {
  decorations: DecorationSet
  atomicDecorations: DecorationSet
  preamble: Preamble
} => {
  // Opt-in profiling, read by `scripts/probe-visual.mjs`. Nothing in the
  // application installs it, so the cost when it is absent is one property read.
  const profiling = (globalThis as unknown as {
    __eukoliaDecorationProfile?: {
      rebuilds: number
      ms: number
      preambleMs: number
      rangeMs: number
      ranges: number
      widgets: number
    }
  }).__eukoliaDecorationProfile
  const startedAt = profiling ? performance.now() : 0
  let preambleSpent = 0
  let widgetCount = 0
  void startedAt
  const previewByPath = state.facet(previewByPathFacet)
  const decorations: Range<Decoration>[] = []

  /*
   * What to decorate, and the walk's own bounds.
   *
   * Empty `ranges` means the whole document, so `bounded` is false and the walk runs
   * from 0 with every construct in span. The application always passes a viewport;
   * this is the shape a test or a headless consumer gets.
   *
   * When it *is* bounded, the walk begins at the range and is handed the context it
   * would have accumulated by then (`scanContextUpTo`) — see the note above that
   * function for why walking from 0 and skipping the decorating work is not a bound
   * at all. `walkFrom` is therefore the range's own start, not 0, and every node
   * before it is dismissed by the tree iterator itself rather than by a comparison.
   */
  const bounded = ranges.length > 0
  const walkTo = bounded ? ranges[ranges.length - 1].to : state.doc.length
  const walkFrom = bounded ? ranges[0].from : 0
  /**
   * Where the scan's counting stops and this walk's begins — the same position as
   * `walkFrom`, and that is the point.
   *
   * The two passes partition the document: `scanContextUpTo` counts everything
   * *beginning* before this position, the walk owns everything from here on. No
   * overlap and no gap, which is what makes the ordinals and the theorem numbers come
   * out the same as the reference's single walk from 0.
   *
   * An earlier version gave the walk a margin above the range so that a container
   * opening just above the viewport would be *entered* — the tree iterator does not
   * descend into a node that ends before its `from`, so a table whose `\begin` line
   * is one line above the range is never visited. That is real, and the margin does
   * not fix it: a node in the margin is walked and then refused by `inSpan`, so its
   * begin line goes undecorated either way. What the margin actually bought was a
   * straddling `\item` counted twice, and it took three attempts to get the two
   * passes to agree about it. The one-line window it was meant to close is instead
   * covered by the margin the *range* carries: `buildSpanFor` asks for half a screen
   * either side of CodeMirror's own viewport, which is forty-odd lines of reach.
   */
  const contextEnd = walkFrom
  const inSpan = (node: { from: number; to: number }): boolean =>
    !bounded || intersectsAny(ranges, node)

  const theoremDeclarations = parseAllTheoremDeclarations(state, tree)
  const theoremCounterManager = new TheoremCounterManager(theoremDeclarations)

  /*
   * Eukolia: the context the walk begins with.
   *
   * Unbounded, that is nothing — the walk starts at position 0 and accumulates it
   * all itself, exactly as the reference does. Bounded, it is what
   * `scanContextUpTo` read off the document above the viewport, and the walk starts
   * at the viewport with it. The two are the same state by construction; the
   * theorem counter is the one piece that has to be *shared* rather than copied,
   * because the scan leaves it standing where the walk needs it.
   *
   * The macro definitions are the one piece that differs in kind. They accumulate
   * text, and a project's macros live in the preamble the viewport is nowhere near,
   * so a bounded walk has no way to see them — but it does not need to *see* them,
   * only to know them, and the scan has already gathered every definition above the
   * viewport. Definitions *below* the viewport are the ones a scrolled-past screen
   * loses, and they are lost the same way an unbounded walk loses them for a
   * document whose definitions come last: the mathematics is typeset with what is in
   * force above it, which is exactly what LaTeX does.
   */
  const context: WalkContext = bounded
    ? contextAt(state, tree, contextEnd, theoremCounterManager)
    : EMPTY_CONTEXT

  const listEnvironmentStack = context.listEnvironmentStack
  let currentListEnvironment = context.listEnvironment
  const ordinalStack = context.ordinalStack
  let currentOrdinal = context.ordinal
  let listDepth = context.listDepth
  let commandDefinitions = context.commandDefinitions

  /** The document's `\newtheorem` declarations, looked up first. */
  const theoremEnvironments = new Map<string, string>()

  const builtInTheoremEnvironments = new Map<string, string>(
    BUILT_IN_THEOREM_ENVIRONMENTS.map(name => [
      name,
      // `\begin{proof}` reads "Proof", everything else is capitalised.
      name.charAt(0).toUpperCase() + name.slice(1),
    ])
  )

  for (const [name, decl] of theoremDeclarations.entries()) {
    theoremEnvironments.set(name, decl.printName)
  }

  // Eukolia: the preamble's bounds are a property of the document, so they are
  // scanned for once rather than discovered by the bounded walk below. See
  // `scanPreamble`.
  const { preamble, seenDocumentEnvironment } = scanPreamble(state, tree)

  /**
   * Eukolia: the widget preamble, composed once per rebuild rather than per widget.
   *
   * Every widget built in one pass sees the same `commandDefinitions` — the
   * document's macro definitions, gathered during the same tree walk — so the
   * composed string is identical for all of them. Composing it per widget built a
   * multi-kilobyte string, and joined three of them, once per equation in the
   * document: on a page of mathematics that is the same string assembled a hundred
   * times in a single pass. The last result is kept instead, keyed on its input, so
   * the cost is one composition per distinct set of definitions rather than one per
   * equation.
   *
   * This is the only per-widget cost in the pass that does not depend on the
   * widget, and it is deliberately the only thing memoized here.
   */
  let lastDefinitions: string | null = null
  let lastComposed = ''
  const composedFor = (definitions: string): string => {
    if (definitions === lastDefinitions) return lastComposed
    const before = profiling ? performance.now() : 0
    lastDefinitions = definitions
    const customTheorems = [...theoremDeclarations.keys()]
      .filter(name => !BUILT_IN_THEOREM_ENVIRONMENTS.includes(name as any))
      .map(name => `\\newenvironment{${name}}{\\textbf{${theoremDeclarations.get(name)?.printName ?? name}}\\quad}{\\par}`)
      .join('\n')
    lastComposed = composeMacroPreamble(
      [builtInMathDefinitions(), customTheorems, definitions].filter(Boolean).join('\n')
    )
    if (profiling) preambleSpent += performance.now() - before
    return lastComposed
  }

  const startListEnvironment = (envName: ListEnvironmentName) => {
    if (currentListEnvironment) {
      listEnvironmentStack.push(currentListEnvironment)
      ordinalStack.push(currentOrdinal)
    }
    currentListEnvironment = envName
    currentOrdinal = 0
  }

  const endListEnvironment = () => {
    currentListEnvironment = listEnvironmentStack.pop()
    currentOrdinal = ordinalStack.pop() ?? 0
  }

  tree.iterate({
    /*
     * Eukolia: bounded at both ends, and the lower one is the whole of the saving.
     *
     * The reference walks from 0 with no upper bound. A walk that starts at the
     * requested range is only correct because the context it would have accumulated
     * by then is handed in (see `context` above); a walk that starts at 0 and merely
     * *skips* the decorating work is correct too, and linear in the document, which
     * is what the first version of this measured: 55 ms against the whole-document
     * build's 75 ms, in a frame whose budget is 16 ms.
     */
    from: walkFrom,
    to: walkTo,
    enter(nodeRef) {
      if (nodeRef.type.is('$Environment')) {
        const envName = getUnstarredEnvironmentName(nodeRef.node, state)
        const hideInEnvironmentTypes = [
          'figure',
          'table',
          'verbatim',
          'lstlisting',
          'quote',
          'quotation',
          'quoting',
          'displayquote',
        ]
        if (envName && hideInEnvironmentTypes.includes(envName)) {
          const beginNode = nodeRef.node.getChild('BeginEnv')
          const endNode = nodeRef.node.getChild('EndEnv')
          if (
            beginNode &&
            endNode &&
            hasClosingBrace(beginNode) &&
            hasClosingBrace(endNode)
          ) {
            const beginLine = state.doc.lineAt(beginNode.from)
            const endLine = state.doc.lineAt(endNode.from)

            const begin = {
              from: beginLine.from,
              to: extendForwardsOverEmptyLines(state.doc, beginLine),
            }
            const end = {
              from: extendBackwardsOverEmptyLines(state.doc, endLine),
              to: endLine.to,
            }

            if (shouldDecorate(state, { from: begin.from, to: end.to })) {
              decorations.push(
                Decoration.replace({
                  widget: new EnvironmentLineWidget(envName, 'begin'),
                  block: true,
                }).range(begin.from, begin.to),
                Decoration.replace({
                  widget: new EnvironmentLineWidget(envName, 'end'),
                  block: true,
                }).range(end.from, end.to)
              )

              const centeringNode = centeringNodeForEnvironment(nodeRef)

              if (centeringNode) {
                const line = state.doc.lineAt(centeringNode.from)
                const from = extendBackwardsOverEmptyLines(state.doc, line)
                const to = extendForwardsOverEmptyLines(state.doc, line)

                decorations.push(
                  Decoration.replace({
                    block: true,
                  }).range(from, to)
                )
              }
            }
          }
        } else if (nodeRef.type.is('ListEnvironment')) {
          const beginNode = nodeRef.node.getChild('BeginEnv')
          const endNode = nodeRef.node.getChild('EndEnv')

          if (
            beginNode &&
            endNode &&
            hasClosingBrace(beginNode) &&
            hasClosingBrace(endNode)
          ) {
            const beginLine = state.doc.lineAt(beginNode.from)
            const endLine = state.doc.lineAt(endNode.from)

            const begin = {
              from: beginLine.from,
              to: extendForwardsOverEmptyLines(state.doc, beginLine),
            }
            const end = {
              from: extendBackwardsOverEmptyLines(state.doc, endLine),
              to: endLine.to,
            }

            if (
              !selectionIntersects(state.selection, begin) &&
              !selectionIntersects(state.selection, end) &&
              getListItems(nodeRef.node).length > 0 // not empty
            ) {
              if (lineContainsOnlyNode(beginLine, beginNode)) {
                decorations.push(
                  Decoration.replace({
                    block: true,
                  }).range(begin.from, begin.to)
                )
              }
              if (lineContainsOnlyNode(endLine, endNode)) {
                decorations.push(
                  Decoration.replace({
                    block: true,
                  }).range(end.from, end.to)
                )
              }
            }
          }
        } else if (nodeRef.type.is('TabularEnvironment')) {
          if (shouldDecorate(state, nodeRef)) {
            const tabularNode = nodeRef.node
            const tableNode = ancestorOfNodeWithType(
              tabularNode,
              'TableEnvironment'
            )
            const directChild = isDirectChildOfEnvironment(
              tabularNode.parent,
              tableNode
            )

            let parsedTableData: ParsedTableData | null = null
            let validTable = false
            try {
              parsedTableData = generateTable(tabularNode, state)
              validTable = validateParsedTable(parsedTableData)
            } catch (e) {
              debugConsole.error(e)
            }

            if (parsedTableData && validTable) {
              decorations.push(
                Decoration.replace({
                  widget: new TabularWidget(
                    parsedTableData,
                    tabularNode,
                    state.doc.sliceString(
                      (tableNode ?? tabularNode).from,
                      (tableNode ?? tabularNode).to
                    ),
                    tableNode,
                    directChild
                  ),
                  block: true,
                }).range(nodeRef.from, nodeRef.to)
              )
              return false
            } else {
              // Show error message
              decorations.push(
                Decoration.widget({
                  widget: new TableRenderingErrorWidget(tableNode),
                  block: true,
                }).range(nodeRef.from, nodeRef.from)
              )
            }
          }
        }
      } else if (nodeRef.type.is('BeginEnv')) {
        // the beginning of an environment, with an environment name argument
        const envName = getUnstarredEnvironmentName(nodeRef.node, state)

        if (envName) {
          switch (envName) {
            case 'itemize':
            case 'enumerate':
            case 'description':
              startListEnvironment(envName)
              listDepth++
              break

            case 'abstract':
              if (shouldDecorate(state, nodeRef)) {
                decorations.push(
                  Decoration.replace({
                    widget: new BeginWidget(envName),
                    block: true,
                  }).range(nodeRef.from, nodeRef.to)
                )
              }
              break
            case 'frame':
              if (shouldDecorate(state, nodeRef)) {
                const parent = nodeRef.node.parent
                if (parent?.type.is('Environment')) {
                  const args = getEnvironmentArguments(parent)
                  if (!args) {
                    break
                  }

                  if (args.length > 0) {
                    const title = args[0]
                    if (!title) {
                      break
                    }
                    let to = title.to
                    const titleTextNode = title.getChild('LongArg')
                    if (!titleTextNode) {
                      break
                    }
                    const frame: Frame = {
                      title: {
                        node: title,
                        content: state.sliceDoc(
                          titleTextNode.from,
                          titleTextNode.to
                        ),
                      },
                    }
                    if (args.length > 1) {
                      // We have a subtitle too
                      const subtitle = args[1]
                      if (subtitle) {
                        const subtitleTextNode = subtitle.getChild('LongArg')
                        if (subtitleTextNode) {
                          to = subtitle.to
                          frame.subtitle = {
                            node: subtitle,
                            content: state.sliceDoc(
                              subtitleTextNode.from,
                              subtitleTextNode.to
                            ),
                          }
                        }
                      }
                    }
                    decorations.push(
                      Decoration.replace({
                        widget: new FrameWidget(frame),
                        block: true,
                      }).range(nodeRef.from, to)
                    )
                  }
                }
              }
              break
            default:
              {
                const theoremName = theoremEnvironments.get(envName)

                if (theoremName && hasMatchingEnvironmentEnd(nodeRef.node, state)) {
                  // Counting follows the document, even when this header is disclosed.
                  const number = theoremCounterManager.formatNumber(envName)
                  if (!shouldDecorateEnvTag(state, nodeRef)) break
                  const argumentNode = nodeRef.node
                    .getChild('OptionalArgument')
                    ?.getChild('ShortOptionalArg')

                  decorations.push(
                    Decoration.replace({
                      widget: new BeginTheoremWidget(
                        envName,
                        theoremName,
                        argumentNode,
                        number,
                        nodeRef.from,
                        nodeRef.to
                      ),
                      block: false,
                    }).range(nodeRef.from, nodeRef.to)
                  )
                }

                // do nothing
              }
              break
          }
        }
      } else if (nodeRef.type.is('EndEnv')) {
        // the end of an environment, with an environment name argument
        const envName = getEnvironmentName(nodeRef.node, state)

        if (envName) {
          switch (envName) {
            case 'itemize':
            case 'enumerate':
            case 'description':
              if (currentListEnvironment === envName) {
                endListEnvironment()
              }
              listDepth--
              break

            case 'abstract':
              if (shouldDecorate(state, nodeRef)) {
                decorations.push(
                  Decoration.replace({
                    widget: new EndWidget(envName, nodeRef.from),
                    block: true,
                  }).range(nodeRef.from, nodeRef.to)
                )
              }
              break
            case 'document':
              if (shouldDecorate(state, nodeRef)) {
                decorations.push(
                  Decoration.replace({
                    widget: new EndDocumentWidget(),
                    block: true,
                  }).range(nodeRef.from, nodeRef.to)
                )
              }
              break
            case 'frame':
              if (shouldDecorate(state, nodeRef)) {
                decorations.push(
                  Decoration.replace({
                    widget: new DividerWidget(),
                    block: true,
                  }).range(nodeRef.from, nodeRef.to)
                )
              }
              break
            default:
              if (theoremEnvironments.has(envName) && hasMatchingEnvironmentBegin(nodeRef.node, state)) {
                if (shouldDecorateEnvTag(state, nodeRef)) {
                  decorations.push(
                    Decoration.replace({
                      widget: new EndWidget(envName, nodeRef.from),
                      block: true,
                    }).range(nodeRef.from, nodeRef.to)
                  )
                }
              }
              // do nothing
              break
          }
        }
      } else if (nodeRef.type.is('$SectioningCtrlSeq')) {
        const ancestorNode = ancestorNodeOfType(
          state,
          nodeRef.to,
          'SectioningCommand'
        )
        if (ancestorNode) {
          // a section (or subsection, etc) command
          const argumentNode = ancestorNode.getChild('SectioningArgument')
          if (argumentNode) {
            const openBrace = argumentNode.getChild(OpenBrace)
            const closeBrace = argumentNode.getChild(CloseBrace)
            if (!openBrace || !closeBrace) {
              return false
            }
            const sectionCtrlSeqNode = ancestorNode.getChild('$CtrlSeq')
            if (!sectionCtrlSeqNode) {
              return false
            }
            /*
             * Eukolia: the theorem counter is stepped here, and the reason is that
             * this branch is the one that has the *ancestor*.
             *
             * `theoremCounterManager` numbers a theorem by the chapters and sections
             * above it, so every sectioning command has to step it whether or not it
             * is on screen. This walk does that only for commands at or after
             * `contextEnd` — the guard at the top of the `enter` refuses anything
             * earlier when it is a `SectioningCommand`, and `scanContextUpTo` has
             * already stepped the counter for every one of those. The two are one
             * rule stated in two places, which is why the scan and this branch share
             * `counterStepFor`.
             */
            const secCmd = state.sliceDoc(
              sectionCtrlSeqNode.from + 1,
              sectionCtrlSeqNode.to
            )
            const step = counterStepFor(secCmd)
            if (step) theoremCounterManager[step]()

            const titleNode = argumentNode.getChild('LongArg')
            if (!titleNode) {
              return false
            }
            const title = state.sliceDoc(titleNode.from, titleNode.to)
            if (!title.trim()) {
              return false
            }

            const showBraces =
              selectionIntersects(state.selection, sectionCtrlSeqNode) ||
              selectionIntersects(state.selection, openBrace) ||
              selectionIntersects(state.selection, closeBrace)

            decorations.push(
              Decoration.replace({
                widget: new BraceWidget(showBraces ? '{' : ''),
              }).range(nodeRef.from, titleNode.from)
            )

            decorations.push(
              Decoration.replace({
                widget: new BraceWidget(showBraces ? '}' : ''),
              }).range(closeBrace.from, closeBrace.to)
            )

            return false
          }
        }
      } else if (nodeRef.type.is('VerbCommand')) {
        if (shouldDecorate(state, nodeRef)) {
          // \verb content (text only)
          const contentNode = nodeRef.node.getChild('VerbContent')

          if (contentNode) {
            if (contentNode.to - contentNode.from > 2) {
              decorations.push(
                Decoration.replace({}).range(nodeRef.from, contentNode.from + 1)
              )

              decorations.push(
                Decoration.replace({}).range(nodeRef.to - 1, nodeRef.to)
              )
            }
          }
        }

        return false // no markup in verbatim content
      } else if (
        nodeRef.type.is('NewCommand') ||
        nodeRef.type.is('RenewCommand') ||
        nodeRef.type.is('Def')
      ) {
        const nameNode =
          nodeRef.node.getChild('LiteralArgContent') ??
          nodeRef.node.getChild('Csname') ??
          nodeRef.node.getChild('CtrlSym')
        if (nameNode) {
          const name = state.sliceDoc(nameNode.from, nameNode.to).trim()
          if (/^\\\w+/.test(name)) {
            const content = state.sliceDoc(nodeRef.from, nodeRef.to)
            if (content) {
              commandDefinitions += `${content}\n`
            }
          }
        }
      } else if (
        nodeRef.type.is('RenewEnvironment') ||
        nodeRef.type.is('NewEnvironment')
      ) {
        const nameNode = nodeRef.node.getChild('LiteralArgContent')
        if (nameNode) {
          const name = state.sliceDoc(nameNode.from, nameNode.to).trim()
          if (/^\w+/.test(name)) {
            const content = state.sliceDoc(nodeRef.from, nodeRef.to)
            if (content) {
              commandDefinitions += `${content}\n`
            }
          }
        }
      } else if (nodeRef.type.is('Let')) {
        const commandNodes = nodeRef.node.getChildren('Csname')
        if (commandNodes.length !== 2) {
          return
        }
        const nameNode = commandNodes[0]
        if (nameNode) {
          // We support more flexible names in let (Csname) than in newcommand
          const name = state.sliceDoc(nameNode.from, nameNode.to).trim()
          if (name.length > 1 && name.startsWith('\\')) {
            const content = state.sliceDoc(nodeRef.from, nodeRef.to)
            if (content) {
              commandDefinitions += `${content}\n`
            }
          }
        }
      } else if (nodeRef.type.is('Cite')) {
        // \cite command with a bibkey argument
        if (shouldDecorate(state, nodeRef)) {
          const argumentNode = nodeRef.node
            .getChild('BibKeyArgument')
            ?.getChild('ShortTextArgument')

          decorations.push(
            ...decorateArgumentBraces(
              new IconBraceWidget('📚'),
              argumentNode,
              nodeRef.from
            )
          )
        }

        return false // no markup in cite content
      } else if (nodeRef.type.is('Ref')) {
        // \ref command with a ref label argument

        const argumentNode = nodeRef.node
          .getChild('RefArgument')
          ?.getChild('ShortTextArgument')

        const shouldShowBraces =
          !shouldDecorate(state, nodeRef) ||
          argumentNode?.from === argumentNode?.to

        decorations.push(
          ...decorateArgumentBraces(
            new IconBraceWidget(shouldShowBraces ? '🏷{' : '🏷'),
            argumentNode,
            nodeRef.from,
            true,
            new BraceWidget(shouldShowBraces ? '}' : '')
          )
        )

        return false // no markup in ref content
      } else if (nodeRef.type.is('Label')) {
        if (shouldDecorateEnvTag(state, nodeRef) && !nodeHasError(nodeRef.node)) {
          decorations.push(Decoration.replace({
            widget: new LabelIconWidget(nodeRef.from),
          }).range(nodeRef.from, nodeRef.to))
        }

        return false // no markup in label content
      } else if (nodeRef.type.is('Include')) {
        // \include (a file path)
        if (shouldDecorate(state, nodeRef)) {
          const argumentNode = nodeRef.node
            .getChild('IncludeArgument')
            ?.getChild('FilePathArgument')
          decorations.push(
            ...decorateArgumentBraces(
              new IconBraceWidget('🔗'),
              argumentNode,
              nodeRef.from
            )
          )
        }

        return false // no markup in include content
      } else if (nodeRef.type.is('Input')) {
        // \input (a file path)
        // TODO: Ensure this works with BareFilePathArgument
        if (shouldDecorate(state, nodeRef)) {
          const contentNode = nodeRef.node.getChild('InputArgument')

          if (contentNode) {
            if (contentNode.to - contentNode.from > 2) {
              decorations.push(
                Decoration.replace({
                  widget: new IconBraceWidget('🔗'),
                }).range(nodeRef.from, contentNode.from + 1)
              )

              decorations.push(
                Decoration.replace({
                  widget: new BraceWidget(),
                }).range(nodeRef.to - 1, nodeRef.to)
              )
            }
          }
        }

        return false // no markup in input content
      } else if (nodeRef.type.is('Math')) {
        // math equations
        const ancestorNode = mathAncestorNode(state, nodeRef.from)

        if (
          ancestorNode &&
          !nodeHasError(ancestorNode) &&
          shouldDecorateMath(state, ancestorNode)
        ) {
          const math = parseMathContainer(state, nodeRef, ancestorNode)

          // Eukolia: a mathematical environment MathJax cannot render at all —
          // `tikzcd` — is shown as explained source rather than handed over.
          //
          // **Handing it over is worse than an error box: it never comes back.**
          // Measured against MathJax 4.4.1, `tex2svgPromise` on a `tikzcd` body does
          // not reject and does not resolve — a probe left it running for 300
          // seconds. The widget that asked for it is therefore an element that is
          // *never filled*: not a diagram, not an error, not even the source, just a
          // blank box, and because the promise never settles the `.finally` that
          // re-measures the caret never runs either.
          //
          // The environment name is taken from the mathematics as well as from the
          // node, and the second source is the one that matters here. A `tikzcd`
          // written inside `\[…\]` — which is how every real document writes it —
          // has `mathAncestorNode` return the **`BracketMath`** of the brackets, not
          // the `$Environment` of the diagram: the port's ancestor search stops at
          // the first `$MathContainer`, and the brackets are one. So the node-based
          // lookup returned `null`, the check below never fired, and the whole
          // `\begin{tikzcd}…\end{tikzcd}` went to MathJax as display mathematics.
          // Reading the name out of the content finds it either way.
          const environmentName =
            (ancestorNode.type.is('$Environment')
              ? getUnstarredEnvironmentName(ancestorNode, state)
              : null) ?? unrenderableEnvironmentIn(math?.content ?? '')

          if (isUnrenderableMathEnvironment(environmentName)) {
            const from = math?.pos ?? ancestorNode.from
            const to = math
              ? math.pos + math.content.length
              : ancestorNode.to
            decorations.push(
              Decoration.replace({
                widget: new UnrenderableMathWidget(
                  environmentName as string,
                  state.sliceDoc(from, to)
                ),
                block: true,
              }).range(from, to)
            )
            return false
          }

          if (math && math.passToMathJax) {
            widgetCount += 1
            decorations.push(
              Decoration.replace({
                widget: new MathWidget(
                  math.content,
                  math.displayMode,
                  // Eukolia: the definitions Eukolia supplies, then the project’s,
                  // then the document’s own. `composeMacroPreamble` puts the
                  // caller’s text last so the document wins, and the built-ins go
                  // before that: they define what MathJax does not know at all
                  // (`\qedhere`, the `amsthm` environments), which is a different
                  // problem from a macro the project defines.
                  composedFor(commandDefinitions)
                ),
                block: math.displayMode,
              }).range(ancestorNode.from, ancestorNode.to)
            )
          }
        }

        return false // never decorate inside math
      } else if (nodeRef.type.is('HrefCommand')) {
        // a hyperlink with URL and content arguments
        const urlArgumentNode = nodeRef.node.getChild('UrlArgument')
        const urlNode = urlArgumentNode?.getChild('LiteralArgContent')
        const contentArgumentNode = nodeRef.node.getChild('ShortTextArgument')
        const contentNode = contentArgumentNode?.getChild('ShortArg')

        if (urlArgumentNode && urlNode && contentArgumentNode && contentNode) {
          const shouldShowBraces =
            !shouldDecorate(state, nodeRef) ||
            contentNode.from === contentNode.to

          const url = state.sliceDoc(urlNode.from, urlNode.to)

          // avoid decorating when the URL spans multiple lines, as the argument node is probably unclosed
          if (!url.includes('\n')) {
            decorations.push(
              ...decorateArgumentBraces(
                new BraceWidget(shouldShowBraces ? '{' : ''),
                contentArgumentNode,
                nodeRef.from,
                true,
                new BraceWidget(shouldShowBraces ? '}' : '')
              )
            )
          }
        }
      } else if (nodeRef.type.is('UrlCommand')) {
        // a hyperlink with URL and content arguments
        const argumentNode = nodeRef.node.getChild('UrlArgument')

        if (argumentNode) {
          const contentNode = argumentNode.getChild('LiteralArgContent')

          const shouldShowBraces =
            !shouldDecorate(state, nodeRef) ||
            contentNode?.from === contentNode?.to

          decorations.push(
            ...decorateArgumentBraces(
              new BraceWidget(shouldShowBraces ? '{' : ''),
              argumentNode,
              nodeRef.from,
              false,
              new BraceWidget(shouldShowBraces ? '}' : '')
            )
          )
        }
      } else if (nodeRef.type.is('Tilde')) {
        // a tilde (non-breaking space)
        if (shouldDecorate(state, nodeRef)) {
          decorations.push(
            Decoration.replace({
              widget: new TildeWidget(),
            }).range(nodeRef.from, nodeRef.to)
          )
        }
      } else if (nodeRef.type.is('LineBreak')) {
        // line break
        const optionalArgument = nodeRef.node.getChild('OptionalArgument')
        if (!optionalArgument || shouldDecorate(state, optionalArgument)) {
          decorations.push(
            Decoration.replace({
              widget: new IndicatorWidget('\u21A9'),
            }).range(nodeRef.from, nodeRef.to)
          )
        }
        return false
      } else if (nodeRef.type.is('Caption')) {
        if (shouldDecorate(state, nodeRef)) {
          // a caption
          const argumentNode = nodeRef.node.getChild('TextArgument')
          decorations.push(
            ...decorateArgumentBraces(
              new BraceWidget(),
              argumentNode,
              nodeRef.from
            )
          )
        }
      } else if (
        nodeRef.type.is('IncludeGraphics') ||
        nodeRef.type.is('IncludeSvg')
      ) {
        // \includegraphics or \includesvg with a file path argument
        const isIncludeSvg = nodeRef.type.is('IncludeSvg')
        if (shouldDecorate(state, nodeRef)) {
          const argumentNodeName = isIncludeSvg
            ? 'IncludeSvgArgument'
            : 'IncludeGraphicsArgument'
          const filePathArgument = nodeRef.node
            .getChild(argumentNodeName)
            ?.getChild('FilePathArgument')
            ?.getChild('LiteralArgContent')

          if (filePathArgument) {
            const filePath = state.doc.sliceString(
              filePathArgument.from,
              filePathArgument.to
            )

            // \includegraphics doesn't support SVG
            if (!isIncludeSvg && filePath.toLowerCase().endsWith('.svg')) {
              return false
            }

            if (isIncludeSvg && previewByPath(filePath)?.extension !== 'svg') {
              return false
            }

            if (filePath) {
              const environmentNode = ancestorNodeOfType(
                state,
                nodeRef.from,
                'FigureEnvironment'
              )
              const centered = Boolean(
                environmentNode && centeringNodeForEnvironment(environmentNode)
              )
              const figureData = environmentNode
                ? parseFigureData(environmentNode, state)
                : null

              const line = state.doc.lineAt(nodeRef.from)

              if (lineContainsOnlyNode(line, nodeRef)) {
                const Widget = state.readOnly
                  ? GraphicsWidget
                  : EditableGraphicsWidget
                decorations.push(
                  Decoration.replace({
                    widget: new Widget(filePath, centered, figureData),
                    block: true,
                  }).range(line.from, line.to)
                )
              } else {
                const Widget = state.readOnly
                  ? InlineGraphicsWidget
                  : EditableInlineGraphicsWidget
                decorations.push(
                  Decoration.replace({
                    widget: new Widget(filePath, centered, figureData),
                  }).range(nodeRef.from, nodeRef.to)
                )
              }
            }

            return false
          }
        }
      } else if (nodeRef.type.is('Maketitle')) {
        if (shouldDecorate(state, nodeRef)) {
          const line = state.doc.lineAt(nodeRef.from)
          const from = extendBackwardsOverEmptyLines(state.doc, line)
          const { to } = state.doc.lineAt(nodeRef.to)

          if (shouldDecorate(state, { from, to })) {
            decorations.push(
              Decoration.replace({
                widget: new MakeTitleWidget(preamble),
                block: true,
              }).range(from, to)
            )
          }

          return false
        }
      } else if (nodeRef.type.is('Item')) {
        // only decorate \item inside a list
        if (currentListEnvironment) {
          currentOrdinal++
          const line = state.doc.lineAt(nodeRef.from)
          const onlySpaceBeforeNode = /^\s*$/.test(
            state.sliceDoc(line.from, nodeRef.from)
          )
          const from = onlySpaceBeforeNode ? line.from : nodeRef.from

          if (currentListEnvironment === 'description') {
            const argumentNode = nodeRef.node.getChild(OptionalArgument)
            const to = argumentNode ? argumentNode.from : nodeRef.to

            const onlySpaceAfterNode =
              !argumentNode && /^\s*$/.test(state.sliceDoc(nodeRef.to, line.to))

            if (!onlySpaceAfterNode) {
              // decorate the \item command and subsequent whitespace, if there is other content on the line
              decorations.push(
                Decoration.replace({
                  widget: new DescriptionItemWidget(listDepth),
                }).range(from, to)
              )
            }

            if (argumentNode) {
              // decorate the optional argument
              const decorateBrackets = shouldDecorate(state, argumentNode)

              decorations.push(
                ...decorateArgumentBraces(
                  new BraceWidget(decorateBrackets ? '' : '['),
                  argumentNode,
                  argumentNode.from,
                  false,
                  new BraceWidget(decorateBrackets ? '' : ']'),
                  { open: OpenBracket, close: CloseBracket }
                )
              )
            }
          } else {
            // Keep each item semantic while retaining the reference marker widget.
            // Per-line wrappers also work when the list begins outside the viewport.
            if (line.to > from) {
              decorations.push(
                Decoration.mark({
                  tagName: currentListEnvironment === 'enumerate' ? 'ol' : 'ul',
                  attributes: currentListEnvironment === 'enumerate'
                    ? { start: String(currentOrdinal), class: 'ol-cm-list' }
                    : { class: 'ol-cm-list' },
                }).range(from, line.to),
                Decoration.mark({ tagName: 'li', class: 'ol-cm-list-item' }).range(from, line.to)
              )
            }
            decorations.push(
              Decoration.replace({
                widget: new ItemWidget(
                  currentListEnvironment || 'document',
                  currentOrdinal,
                  listDepth
                ),
              }).range(from, nodeRef.to)
            )
            return false
          }
        }
      } else if (nodeRef.type.is('NewTheoremCommand')) {
        const result = parseTheoremArguments(state, nodeRef.node)
        if (result) {
          const { name, label } = result
          theoremEnvironments.set(name, label)
        }
      } else if (
        nodeRef.type.is('TextColorCommand') ||
        nodeRef.type.is('ColorBoxCommand')
      ) {
        if (shouldDecorate(state, nodeRef)) {
          const colorArgumentNode = nodeRef.node.getChild(ShortTextArgument)
          const contentArgumentNode = nodeRef.node.getChild(TextArgument)
          if (colorArgumentNode && contentArgumentNode) {
            // command name and opening brace
            decorations.push(
              ...decorateArgumentBraces(
                new BraceWidget(),
                contentArgumentNode,
                nodeRef.from
              )
            )
          }
        }
      } else if (nodeRef.type.is('$ToggleTextFormattingCommand')) {
        const textArgumentNode = nodeRef.node.getChild('TextArgument')
        if (shouldDecorate(state, nodeRef)) {
          decorations.push(...decorateArgumentBraces(
            new BraceWidget(), textArgumentNode, nodeRef.from
          ))
        }
      } else if (nodeRef.type.is('$OtherTextFormattingCommand')) {
        // markup that can't be toggled using toolbar buttons/keyboard shortcuts
        const textArgumentNode = nodeRef.node.getChild('TextArgument')
        if (shouldDecorate(state, nodeRef)) {
          decorations.push(
            ...decorateArgumentBraces(
              new BraceWidget(),
              textArgumentNode,
              nodeRef.from
            )
          )
        }
      } else if (
        nodeRef.type.is('FootnoteCommand') ||
        nodeRef.type.is('EndnoteCommand')
      ) {
        const textArgumentNode = nodeRef.node.getChild('TextArgument')
        if (textArgumentNode) {
          if (state.readOnly && selectionIntersects(state.selection, nodeRef)) {
            // a special case for a read-only document:
            // always display the content, styled differently from the main content.
            decorations.push(
              ...decorateArgumentBraces(
                new BraceWidget(),
                textArgumentNode,
                nodeRef.from
              ),
              Decoration.mark({
                class: 'ol-cm-footnote ol-cm-footnote-view',
              }).range(textArgumentNode.from, textArgumentNode.to)
            )
          } else {
            if (shouldDecorate(state, nodeRef)) {
              // collapse the footnote when the selection is outside it
              decorations.push(
                Decoration.replace({
                  widget: new FootnoteWidget(
                    nodeRef.type.is('FootnoteCommand') ? 'footnote' : 'endnote'
                  ),
                }).range(nodeRef.from, nodeRef.to)
              )
              return false
            }
          }
        }
      } else if (nodeRef.type.is('UnknownCommand')) {
        // a command that's not defined separately by the grammar
        const commandNode = nodeRef.node
        const commandNameNode = commandNode.getChild('$CtrlSeq')

        if (commandNameNode) {
          const commandName = state.doc
            .sliceString(commandNameNode.from, commandNameNode.to)
            .trim()

          if (commandName.length > 0) {
            const textArgumentNode = commandNode.getChild('TextArgument')

            if (commandName === '\\stag' && textArgumentNode) {
              if (shouldDecorateEnvTag(state, nodeRef) && !nodeHasError(nodeRef.node)) {
                decorations.push(Decoration.replace({
                  widget: new LabelIconWidget(nodeRef.from),
                }).range(nodeRef.from, nodeRef.to))
              }
              return false
            } else if (commandName === '\\keywords') {
              if (shouldDecorate(state, nodeRef)) {
                // command name and opening brace
                decorations.push(
                  ...decorateArgumentBraces(
                    new BraceWidget('keywords: '),
                    textArgumentNode,
                    nodeRef.from
                  )
                )
                return false
              }
            } else if (commandName === '\\LaTeX') {
              if (shouldDecorate(state, nodeRef)) {
                decorations.push(
                  Decoration.replace({
                    widget: new LaTeXWidget(),
                  }).range(nodeRef.from, nodeRef.to)
                )
                return false
              }
            } else if (commandName === '\\TeX') {
              if (shouldDecorate(state, nodeRef)) {
                decorations.push(
                  Decoration.replace({
                    widget: new TeXWidget(),
                  }).range(nodeRef.from, nodeRef.to)
                )
                return false
              }
            } else if (commandName === '\\ce') {
              // Chemical equation/formula, from the `mhchem` CTAN package.
              // Handled by the MathJaX mhchem extension:
              // https://docs.mathjax.org/en/latest/input/tex/extensions/mhchem.html
              if (textArgumentNode && shouldDecorate(state, nodeRef)) {
                const innerContent = state.doc
                  .sliceString(
                    textArgumentNode.from + 1,
                    textArgumentNode.to - 1
                  )
                  .trim()

                if (innerContent.length) {
                  const outerContent = state.doc.sliceString(
                    nodeRef.from,
                    nodeRef.to
                  )

                  decorations.push(
                    Decoration.replace({
                      widget: new MathWidget(outerContent, false),
                    }).range(nodeRef.from, nodeRef.to)
                  )
                }

                return false
              }
            } else if (commandName === '\\qedhere') {
              // Eukolia: the AMS end-of-proof mark.
              //
              // This command never reaches the typesetter, whatever the preamble
              // defines: it is written *after* the mathematics — `Indeed $x =
              // y$.\qedhere` — so it is ordinary source on the line, outside the
              // `$…$` region. Defining it for MathJax therefore changed nothing
              // about what a reader saw, which is why the report saw the literal
              // text after the macro had been defined.
              //
              // It is also the mark's own tradition to be *hidden* and drawn: a
              // reader is meant to see the square, not the command.
              if (shouldDecorate(state, nodeRef)) {
                decorations.push(
                  Decoration.replace({
                    widget: new QedWidget(),
                  }).range(nodeRef.from, nodeRef.to)
                )
                return false
              }
            } else if (hasCharacterSubstitution(commandName)) {
              if (shouldDecorate(state, nodeRef)) {
                const replacement = createCharacterCommand(commandName)
                if (replacement) {
                  decorations.push(
                    Decoration.replace({
                      widget: replacement,
                    }).range(nodeRef.from, nodeRef.to)
                  )
                  return false
                }
              }
            } else if (hasSpaceSubstitution(commandName)) {
              if (shouldDecorate(state, nodeRef)) {
                const replacement = createSpaceCommand(commandName)
                if (replacement) {
                  decorations.push(
                    Decoration.replace({
                      widget: replacement,
                    }).range(nodeRef.from, nodeRef.to)
                  )
                  return false
                }
              }
            }
          }
        }
      }

    },
  })
  /*
   * Eukolia: a preamble *fragment* is entirely preamble.
   *
   * Everything above sets `preamble.to` from something that marks where the body
   * begins — `\begin{document}`, `\maketitle`, `\title`, `\author`. A file reached
   * by `\input{macros}` from the root document has none of those, because it has no
   * body at all: `macros.tex` of a real project is 37 lines of `\usepackage`,
   * `\newtheorem`, `\let` and `\newcommand`, and it never contains a
   * `\begin{document}`.
   *
   * With `preamble.to` left at 0 the whole preamble block below is skipped, and the
   * consequence is not subtle: the file gets no `ol-cm-preamble-line`, so none of
   * the preamble’s styling applies to it, and every line is rendered as ordinary
   * document text. A reader opening their macro file in Visual Mode sees their
   * definitions set as prose — which is what "portions of the code are erroneously
   * rendered as plain text" is describing.
   *
   * **"Has no `\begin{document}`" is not the test, and the first version of this
   * made that mistake.** Plenty of documents have no `\begin{document}` yet — a
   * paragraph of prose, a test fixture, a file the reader has just started — and
   * treating all of them as one long preamble collapsed their text behind a toggle.
   * Measured, that broke `\emph{normal}` in a bare sentence, which is a document and
   * not a fragment.
   *
   * What distinguishes a fragment is that it contains something *only a preamble
   * can contain*. `\documentclass` and `\usepackage` are the two that cannot appear
   * in a body at all, so a file with no document environment and one of these is a
   * preamble and nothing else. A file with neither keeps the behaviour it had.
   *
   * It is safe to collapse because the preamble is not hidden, only folded, and its
   * toggle is a real button that expands it with the caret at the top of the file
   * (`visual-widgets/preamble.ts`); `clickOnHiddenLine` already routes clicks on it
   * to that button rather than to the caret.
   */
  if (!seenDocumentEnvironment && hasPreambleOnlyCommand(tree)) {
    preamble.to = state.doc.length
  }

  if (preamble.to > 0) {
    // add environmentclass names to each line of the preamble
    // note: this should be in markDecorations,
    // but the preamble extents are calculated in this extension.
    const endLine = state.doc.lineAt(preamble.to).number
    /*
     * Eukolia: the *visible* lines of it, when the caller bounded the build.
     *
     * A preamble is one `Decoration.line` per line, and a Stacks chapter’s is nine
     * hundred of them — positions, not widgets, but still a thousand ranges rebuilt
     * per keystroke to style lines that are nine thousand lines off screen.
     *
     * The two lines that carry meaning — the first and the last of the block — are
     * always included whether or not they are on screen, because they are what the
     * stylesheet keys the block’s top and bottom edges off, and a build scoped to a
     * viewport deep inside the document would otherwise drop both. The block
     * decoration below is deliberately **not** bounded at all: it is what collapses
     * the preamble, and a reader who has scrolled into the body is exactly the reader
     * who needs it.
     */
    const visibleFrom = bounded
      ? state.doc.lineAt(Math.max(0, ranges[0].from)).number
      : 1
    const visibleTo = bounded
      ? state.doc.lineAt(Math.min(state.doc.length, ranges[ranges.length - 1].to))
          .number
      : endLine
    for (let lineNumber = 1; lineNumber <= endLine; ++lineNumber) {
      const isEdge = lineNumber === 1 || lineNumber === endLine
      if (!isEdge && (lineNumber < visibleFrom || lineNumber > visibleTo)) {
        continue
      }
      const line = state.doc.line(lineNumber)
      const classes = ['ol-cm-preamble-line']
      if (lineNumber === 1) {
        classes.push('ol-cm-environment-first-line')
      }
      if (lineNumber === endLine) {
        classes.push('ol-cm-environment-last-line')
      }
      decorations.push(
        Decoration.line({
          class: classes.join(' '),
        }).range(line.from)
      )
    }

    // hide the preamble. We use selectionIntersects directly, so that it also
    // expands in readOnly mode.
    const isExpanded = selectionIntersects(state.selection, preamble)
    if (!isExpanded) {
      decorations.push(
        Decoration.replace({
          widget: new PreambleWidget(isExpanded),
          block: true,
        }).range(0, preamble.to)
      )
    } else {
      decorations.push(
        Decoration.widget({
          widget: new PreambleWidget(isExpanded),
          block: true,
          side: -1,
        }).range(0)
      )
    }
  }

  const built = Decoration.set(decorations, true)
  const atomicRanges = decorations.filter(
    range =>
      !(range.value.spec?.widget instanceof MathWidget) &&
      !(range.value.spec?.widget instanceof UnrenderableMathWidget) &&
      !(range.value.spec?.widget instanceof BeginWidget) &&
      !(range.value.spec?.widget instanceof EndWidget) &&
      !(range.value.spec?.widget instanceof LabelIconWidget)
  )
  const builtAtomic = Decoration.set(atomicRanges, true)

  // Eukolia: opt-in profiling, read by `scripts/probe-visual.mjs`. Nothing in the
  // application installs a profiler, so the cost of the counters when it is absent
  // is one property read per rebuild. Kept rather than removed because the numbers
  // they produce are what the performance work in `ARCHITECTURE.md` §3.23 rests on,
  // and a claim about a rebuild’s cost that cannot be re-measured is a claim that
  // will rot.
  if (profiling) {
    const finishedAt = performance.now()
    profiling.rebuilds += 1
    profiling.ms += finishedAt - startedAt
    profiling.preambleMs += preambleSpent
    profiling.ranges += decorations.length
    profiling.widgets += widgetCount
    profiling.rangeMs += finishedAt - startedAt - preambleSpent
  }

  return { decorations: built, atomicDecorations: builtAtomic, preamble }
}

/**
 * What the visual editor should paint, as of one build.
 *
 * `builtFrom`/`builtTo` are the part of the document this set describes, and they are
 * what makes the pass *incremental* rather than merely bounded: a set built for lines
 * 100–140 is still the right answer while the viewport is anywhere inside those
 * lines, so scrolling past a hundred positions costs nothing. They are `-1` when the
 * set describes the whole document, which is what a caller with no view gets and what
 * means "always correct, never rebuild for a viewport".
 */
interface DecorationState {
  mousedown: boolean
  decorations: DecorationSet
  atomicDecorations: DecorationSet
  preamble: Preamble
  previousTree: Tree
  /**
   * Eukolia: which decorations the selection was intersecting when this set was
   * built. `selectionSignature` explains what it is for.
   */
  selectionKey: string
  builtFrom: number
  builtTo: number
  builtTreeLength: number
}

/**
 * Eukolia — the part of the document a set of decorations has to describe.
 *
 * A fraction of the viewport either side, so that the ordinary scroll — a wheel
 * notch, a caret moving a line, `scrollIntoView` — stays inside what has already been
 * built and costs nothing. This matters more than it looks: the port rebuilds on
 * `viewportChanged`, and scrolling redraws the viewport several times per step
 * (measured at 3.6–11.3 updates per step on a 665-line chapter), so a set built for
 * exactly the visible range is a set rebuilt several times per wheel notch.
 *
 * A *fraction* rather than a fixed number of lines, because the two are not the same
 * question at both ends of the size range: half a screen is 15 lines on a large-font
 * display and 60 on a small one, and it is the screen that decides how far a wheel
 * notch travels. CodeMirror’s own viewport already carries a margin, so this is on
 * top of one rather than instead of one.
 *
 * **An empty answer means the whole document**, which is what a document below
 * `VIEWPORT_BOUNDED_DECORATION_LINES` gets and what a caller with no view gets. See
 * that constant for why the bound is not free and where the two costs cross.
 */
const buildSpanFor = (
  view: EditorView
): { from: number; to: number }[] => {
  const viewport = view.viewport
  if (!viewport) return []
  const doc = view.state.doc
  if (doc.lines <= VIEWPORT_BOUNDED_DECORATION_LINES) return []
  const visible = viewport.to - viewport.from
  const margin = Math.max(1, Math.ceil(visible / 2))
  const firstLine = doc.lineAt(Math.max(0, viewport.from - margin))
  const lastLine = doc.lineAt(Math.min(doc.length, viewport.to + margin))
  /*
   * `firstLine.from` to `lastLine.to`, and the two ends are not symmetric for a
   * reason worth stating: `doc.lineAt(pos)` answers with the line **containing**
   * `pos`, and it is the line object’s `from` and `to` that give the range. Using
   * `lastLine.from` — which reads perfectly well and was the first version of this —
   * ends the span at the *start* of the last line, so a viewport whose end lands
   * mid-line produced a span ending before the viewport did, and the field then
   * rebuilt on every viewport change: the exact churn the margin exists to remove.
   */
  return [{ from: firstLine.from, to: lastLine.to }]
}

/**
 * Eukolia: "the viewport has moved; rebuild for this range".
 *
 * A `StateField` has no view — `create` and `update` are handed an `EditorState` and
 * a `Transaction` and nothing else — so the field cannot ask what is on screen, and
 * this effect is how the plugin inside the same extension tells it. It carries the
 * range rather than a flag so that the field rebuilds for exactly the range asked
 * for, and the field records what it built (`builtFrom`/`builtTo`) so a viewport that
 * is still inside that range produces no effect at all.
 */
const rebuildForViewportEffect = StateEffect.define<{
  from: number
  to: number
}>()
export const atomicDecorations: Extension = [
  StateField.define<DecorationState>({
    create(state) {
      const previousTree = syntaxTree(state)
      const { decorations, atomicDecorations, preamble } = createDecorations(
        state,
        previousTree,
        []
      )

      return {
        mousedown: false,
        decorations,
        atomicDecorations,
        preamble,
        previousTree,
        selectionKey: selectionSignature(state, previousTree),
        builtFrom: -1,
        builtTo: -1,
        builtTreeLength: previousTree.length,
      }
    },
    update(value, tr) {
      for (const effect of tr.effects) {
        // store the "mousedown" value when it changes
        if (effect.is(mouseDownEffect)) {
          value = {
            ...value,
            mousedown: effect.value,
          }
        }
      }

      /*
       * Eukolia: an edit does not have to rebuild the decorations.
       *
       * The reference rebuilds whenever the tree's identity changed, which for a
       * document being typed into is *every keystroke* — the tree is re-parsed and
       * is therefore a new object. Measured on this application's densest file (665
       * lines, 372 inline maths and 13 display) that is 25 rebuilds for 25 typed
       * characters, 8.4–13.2 ms each and ~387 widget objects per rebuild, for a
       * decoration set that is a pure function of the tree and of *which constructs
       * the selection intersects*.
       *
       * So the identity check is gone and the signature decides. The signature
       * carries the parsed region's length, which is the part of the tree's identity
       * that can change what the decorations say — it moves when the parse advances
       * and is stable once the parse has settled — and the construct set around the
       * caret, which changes when the caret enters or leaves something. A keystroke
       * that does neither leaves the answer unchanged, so the existing set is still
       * correct and only needs its ranges moved: `map` shifts them by the change,
       * which is what the "still parsing" branch below has always done for a tree
       * that has not grown.
       *
       * `previousTree` is kept for the parsing-in-progress test above, which needs the
       * tree's type and length rather than its identity.
       */
      const tree = syntaxTree(tr.state)

      // The requested build range, if this transaction carries one. See
      // `rebuildForViewportEffect`.
      let requested: { from: number; to: number }[] | null = null
      for (const effect of tr.effects) {
        if (effect.is(rebuildForViewportEffect)) {
          requested = [{ from: effect.value.from, to: effect.value.to }]
        }
      }

      /*
       * Eukolia: the two ways a rebuild is *required* rather than merely allowed.
       *
       *  1. `parseAdvanced` — the tree has grown past what this set describes. A
       *     set built for lines 100–140 says nothing about line 400, so a parse that
       *     reaches a line inside the built range has to be turned into widgets
       *     there. This replaces the reference's `tree !== previousTree` test, which
       *     was true on every keystroke and bought a whole-document rebuild for it.
       *  2. `movedOutOfRange` — the caller asked for a part of the document this set
       *     does not describe. A viewport scroll is the case.
       *
       * The signature is the third, and the only one about *correctness* rather than
       * coverage: a caret entering an equation has to reveal its source.
       */
      const parseAdvanced = tree.length > value.builtTreeLength
      const key = selectionSignature(tr.state, tree)
      const movedOutOfRange =
        requested !== null &&
        (value.builtFrom < 0 ||
          requested[0].from < value.builtFrom ||
          requested[0].to > value.builtTo)

      if (
        // only update the decorations when the mouse is not making a selection
        !value.mousedown &&
        (parseAdvanced ||
          key !== value.selectionKey ||
          hasMouseDownEffect(tr) ||
          movedOutOfRange ||
          // Eukolia: the project's macro definitions changed. The mathematics on
          // screen was typeset with the old ones, and a `MathWidget` holds its
          // preamble from construction, so the only way to re-typeset it is to
          // build the widgets again. Without this the decorations are positions
          // and would otherwise be perfectly valid — which is exactly why the
          // re-typeset has to be asked for here rather than inferred.
          effectsCarryProjectMacros(tr.effects))
      ) {
        /*
         * Which part of the document to build, when a rebuild is happening for the
         * selection's sake rather than the viewport's.
         *
         * A selection rebuild has to leave the *existing* range in place and only
         * redo what it covers — the caret revealing an equation is a fact about the
         * equation on screen, and widening the build to the whole document because
         * the caret moved would be the 107 ms rebuild this pass exists to have
         * removed. A document whose set covers everything (`builtFrom < 0`) keeps
         * covering everything, which is what a caller with no view asked for.
         */
        const span =
          requested ??
          (value.builtFrom < 0
            ? []
            : [{ from: value.builtFrom, to: value.builtTo }])
        const built = createDecorations(tr.state, tree, span)
        value = {
          ...value,
          decorations: built.decorations,
          atomicDecorations: built.atomicDecorations,
          preamble: built.preamble,
          selectionKey: key,
          previousTree: tree,
          builtTreeLength: tree.length,
          builtFrom: span.length ? span[0].from : -1,
          builtTo: span.length ? span[span.length - 1].to : -1,
        }
      } else if (tr.docChanged) {
        // The set is still the right answer, and its ranges have moved with the
        // text. `builtFrom`/`builtTo` move with them.
        value = {
          ...value,
          decorations: value.decorations.map(tr.changes),
          atomicDecorations: value.atomicDecorations.map(tr.changes),
          builtFrom:
            value.builtFrom < 0
              ? -1
              : tr.changes.mapPos(value.builtFrom, -1),
          builtTo:
            value.builtTo < 0 ? -1 : tr.changes.mapPos(value.builtTo, 1),
        }
      }

      return value
    },
    provide(field) {
      return [
        EditorView.decorations.from(field, field => field.decorations),
        EditorView.atomicRanges.from(field, value => () => value.atomicDecorations),
        /*
         * Eukolia: tells the field which part of the document is on screen.
         *
         * The field cannot ask (`StateField` has no view), so this is the one thing
         * in the extension that reads `view.viewport` — and it reads nothing else,
         * and only when the answer has changed enough to matter. `builtFrom`/
         * `builtTo` are the field's own record of what it describes, so the effect
         * is not dispatched while the viewport is still inside it: without that
         * check this ran several times per wheel notch, which is the churn
         * `markDecorations` records having measured and removed for the same reason.
         */
        ViewPlugin.define(view => {
          let pending = false

          const askNow = (): void => {
            pending = false
            const span = buildSpanFor(view)
            if (!span.length) return
            const current = view.state.field(field, false)
            if (!current) return
            if (
              current.builtFrom >= 0 &&
              span[0].from >= current.builtFrom &&
              span[span.length - 1].to <= current.builtTo
            ) {
              return
            }
            view.dispatch({
              effects: rebuildForViewportEffect.of({
                from: span[0].from,
                to: span[span.length - 1].to,
              }),
            })
          }

          /*
           * Deferred out of the update, and that is not a detail.
           *
           * A plugin is constructed *inside* an update, and `view.dispatch` from
           * there throws "Calls to EditorView.update are not allowed while an update
           * is in progress" — measured, it took out this plugin on every mount and
           * left the decorations describing the whole document, which is the state
           * this change exists to leave.
           *
           * The obvious deferral is `view.requestMeasure`, which is what
           * `viewportStability` uses for its own layout read. It is **not enough
           * here**, and the second failure is worth recording: `coordsAtPos` flushes
           * a pending measure synchronously (`readMeasured` in `@codemirror/view`),
           * so a measure requested during a keymap handler runs its `write` from
           * inside an update — the same throw, arriving from a completely different
           * place (`jumpArrowDown` in `visual-math-navigation.ts`).
           *
           * A task is outside both: an update cannot be in progress when it runs, and
           * it runs before the next frame is painted, so a viewport's worth of
           * widgets is built for the frame the viewport became visible in. One task
           * per viewport change, coalesced by `pending`, because a scroll redraws the
           * viewport several times per step.
           */
          const ask = (): void => {
            if (pending) return
            pending = true
            window.setTimeout(askNow)
          }

          // Once on mount, so what is on screen is built for the screen rather than
          // for the document; the first `update` after it is a no-op, because the
          // range asked for is then the range built.
          ask()

          return {
            update(update) {
              if (update.viewportChanged || update.docChanged) ask()
              for (const tr of update.transactions) {
                if (tr.annotation(pickedCompletion)?.label === '\\href{}{}') {
                  window.setTimeout(() => nextSnippetField(view))
                }
              }
            },
          }
        }),
        skipPreambleWithCursor(field),
        selectDecoratedArgument(field),
      ]
    },
  }),
]

/**
 * Eukolia — what a selection change can actually change, as a comparable key.
 *
 * The reference rebuilds the entire decoration set on *every* selection change, with a
 * `TODO` beside it asking whether the changed ranges could be updated instead. Measured
 * on a 500-line document: 7.2 ms per rebuild, a hundred and nine rebuilds for a hundred
 * arrow-key presses, and 8 719 widget constructions for a caret that moved across one
 * screen — 787 ms of script to move the cursor.
 *
 * Almost none of that work can be affected by the selection. Everything the decorations
 * depend on does so through `shouldDecorate`, which asks one question: *does the
 * selection intersect this construct’s extents?* The answer is a set of
 * **constructs**, not a set of nodes and not a position — so the key names the
 * constructs the selection is inside, and nothing else:
 *
 *  * not the selection’s offsets, because two carets inside the same paragraph
 *    produce the same answer to every `shouldDecorate` call in the document;
 *  * not the ordinary nodes under the caret;
 *  * not the constructs’ *extents*, either, because an edit lengthens the construct
 *    it is typed into and would then look like a different construct.
 *
 * The constructs are found with the tree’s own range query rather than by walking the
 * caret’s ancestor chain, because `resolveInner` resolves to a node *inside* the
 * mathematics rather than to the container — the chain never named a
 * `$MathContainer`, so the key never changed when the caret entered an equation and the
 * source was never revealed.
 */
const selectionSignature = (state: EditorState, tree: Tree): string => {
  /*
   * The parsed region’s length is part of the key.
   *
   * It moves when the parse advances and is stable once the parse has settled, which
   * is the part of the tree’s identity that can change what the decorations say. Both
   * it and the construct set are needed: dropping either leaves the pass unable to
   * rebuild on a document whose parse completes before the first decoration build, so
   * the preamble widget, the theorem headers and the label icons never appear.
   */
  const parts: string[] = [`L${tree.length}`]

  for (const range of state.selection.ranges) {
    // One character either side, because a caret at a construct’s edge is inside it.
    const from = Math.max(0, range.from - 1)
    const to = Math.min(state.doc.length, range.to + 1)

    const touched: string[] = []
    tree.iterate({
      from,
      to,
      enter(nodeRef) {
        /*
         * `is` and not a name comparison, and this is the trap in the whole idea:
         * `$MathContainer` is a lezer **alias**, not a node name. The tree reports
         * `DollarMath`, `ParenMath`, `BracketMath` and `Environment` — the concrete
         * types — so comparing `type.name` against `'$MathContainer'` matches
         * nothing at all, and the first version of this key did exactly that.
         */
        if (
          !nodeRef.type.is('$MathContainer') &&
          !nodeRef.type.is('$Environment') &&
          !nodeRef.type.is('BeginEnv') &&
          !nodeRef.type.is('EndEnv') &&
          !nodeRef.type.is('Label') &&
          !nodeRef.type.is('UnknownCommand') &&
          !nodeRef.type.is('$ToggleTextFormattingCommand') &&
          !nodeRef.type.is('$OtherTextFormattingCommand') &&
          !nodeRef.type.is('Preamble')
        ) {
          return
        }

        const isMath =
          nodeRef.type.is('$MathContainer') ||
          nodeRef.name === 'EquationEnvironment' ||
          nodeRef.name === 'EquationArrayEnvironment'

        const isInside = range.empty
          ? nodeRef.from < range.from && range.from < nodeRef.to
          : nodeRef.from < range.to && range.from < nodeRef.to

        if (isMath) {
          touched.push(`${nodeRef.name}@${nodeRef.from}:${isInside ? 'in' : 'out'}`)
          return
        }

        if (
          nodeRef.type.is('BeginEnv') ||
          nodeRef.type.is('EndEnv') ||
          nodeRef.type.is('Label') ||
          nodeRef.type.is('$ToggleTextFormattingCommand') ||
          nodeRef.type.is('$OtherTextFormattingCommand')
        ) {
          touched.push(`${nodeRef.name}@${nodeRef.from}:${isInside ? 'in' : 'out'}`)
          return
        }

        if (nodeRef.type.is('UnknownCommand')) {
          const cmdName = state.doc.sliceString(
            nodeRef.from,
            Math.min(nodeRef.to, nodeRef.from + 5)
          )
          if (cmdName === '\\stag') {
            touched.push(`Label@${nodeRef.from}:${isInside ? 'in' : 'out'}`)
            return
          }
          return
        }

        // The start only: an edit inside the construct moves its end, and the
        // construct is the same construct.
        touched.push(`${nodeRef.name}@${nodeRef.from}`)
      },
    })

    // Sorted, so two selections touching the same constructs in different orders
    // agree, and capped so a selection spanning a file cannot build a key the size
    // of the file. The cap only makes the key more conservative.
    touched.sort()
    parts.push(touched.slice(0, 32).join(','))
  }

  return parts.join('|')
}
