/**
 * Math Mode — the editing context where the caret sits inside a mathematical
 * region (`$…$`, `$$…$$`, `\[…\]`, `equation`, `align`, …).
 *
 * There is one editor and one document (see `editorExtensions.ts`), but the
 * caret means something different in each of two contexts, and the difference is
 * *visible*: `atomic-decorations.ts` only replaces a mathematical region with a
 * rendered widget while the selection is **outside** it, so entering one reveals
 * its LaTeX source in place of the mathematics. Math Mode is exactly that — the
 * caret is in a region whose source is showing, and what is being edited is
 * source rather than prose.
 *
 * Two things follow, and this module supplies both:
 *
 *  1. **A flag the stylesheet can key off.** `mathCaretAttribute` puts
 *     `data-caret-math` on the editor element and keeps it current, so the caret
 *     can be drawn in its own colour while mathematics is being edited;
 *     `visual-editor.css` owns what that colour is.
 *  2. **A class for the revealed source.** `mathSourceDecorations` marks the
 *     region with `eu-cm-math-source`, which gives the source the *same*
 *     typography as every other piece of code the editor shows — the font stack
 *     the ported theme puts on the editor as `--source-font-family`, and the
 *     size, weight and line height `editor.fontFamily` / `editor.fontSize`
 *     already give Code Mode. Without it the source inherits the visual
 *     surface's prose face at 1.15×, so identical text was set two different
 *     ways depending on which context it appeared in.
 *
 * **Which regions count as mathematics is not decided here.**
 * `mathAncestorNode` — the ported reference's own detector, used by
 * `atomic-decorations.ts` to decide what to render — is the single source of
 * truth, so the caret can never claim to be in mathematics the editor has not
 * actually revealed, nor claim to be outside mathematics that it has. The
 * detector accepts exactly three node families: `$MathContainer` (which the
 * grammar makes of `$…$`, `\(…\)` and `\[…\]` alike), `EquationEnvironment` and
 * `EquationArrayEnvironment`.
 *
 * One consequence is worth stating because it looks like a bug and is not:
 * `\(…\)` **is** mathematics here. The lezer grammar declares `ParenMath` a
 * `$MathContainer`, and `atomic-decorations.ts` renders it — measured in the
 * running application, a document with `\(a + b\)` and `\[c + d\]` produces two
 * mathematics widgets and no error. The caret therefore reports the
 * mathematical context inside them, and would be coloured the same way as inside
 * `$…$`, which is the correct answer rather than a leak.
 *
 * The other boundary is CodeMirror's containment convention: a caret at a
 * region *end* is inside it (`regionContains` is inclusive), so the colour does
 * not drop a keystroke early while the closing delimiter is still being typed.
 */

import {
  EditorState,
  type Extension,
  type Range,
  type SelectionRange,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'

import { mathAncestorNode } from '@/vendor/overleaf/utils/tree-operations/math'

/**
 * The class the revealed mathematical source carries.
 *
 * Deliberately *not* an `ol-cm-*` name: `ol-*` belongs to the ported Overleaf
 * theme, and how Eukolia sets source is Eukolia's own decision.
 */
export const MATH_SOURCE_CLASS = 'eu-cm-math-source'

/**
 * The attribute reporting whether the caret is in mathematics. `on` / `off`
 * matches `data-caret-smooth`, which the same element already carries.
 */
export const MATH_ATTRIBUTE = 'data-caret-math'

/** A mathematical region: the span of the source a caret inside it reveals. */
export interface MathRegion {
  from: number
  to: number
}

/**
 * The region a `Math` node belongs to, or `null` when it is not mathematics.
 *
 * The region is the `Math` node's own span — the content, without the `$` or
 * `\[` delimiters, which is exactly what `atomic-decorations.ts` replaces with a
 * widget, and therefore exactly the source that appears when the caret arrives.
 */
export function mathRegionOf(
  state: EditorState,
  mathNode: SyntaxNode
): MathRegion | null {
  if (!mathAncestorNode(state, mathNode.from)) return null
  return { from: mathNode.from, to: mathNode.to }
}

/**
 * Whether an offset is in a region.
 *
 * `from <= pos <= to`: the end offset is **inside**. A region's span is the
 * mathematics itself, so its `to` is the offset the closing delimiter sits at —
 * the far side of the last character, which is where the caret lands when it
 * walks back from the delimiter, and where it sits while the closing `$` is
 * being typed in `$Hom(A)$`. Treating that position as prose put the caret back
 * to its ordinary colour one keystroke too early, while the mathematics was
 * still on screen and still being edited. This is the same rule the port's
 * `selectionIntersects` uses, and it is deliberately the same rule: the caret
 * colour and the question "has the caret left this construct" must not disagree
 * about where a construct ends.
 *
 * The offset *after* the closing delimiter — `$x^2$|` — is not in the region,
 * and that is the boundary the two questions share.
 */
export const regionContains = (region: MathRegion, pos: number): boolean =>
  region.from <= pos && pos <= region.to

/**
 * Whether a selection range sits within a region.
 *
 * An empty range is the caret, answered by `regionContains`. A non-empty range
 * has to fit entirely: a selection that runs out of the mathematics is a
 * selection of prose as well, and reporting it as mathematics would tint the
 * caret for a drag that mostly covers the line around an equation.
 */
export function rangeInRegion(range: SelectionRange, region: MathRegion): boolean {
  if (range.empty) return regionContains(region, range.from)
  return region.from <= range.from && range.to <= region.to
}

/**
 * The `Math` node that places `pos` inside mathematics, or `null`.
 *
 * The search is bounded to the line `pos` sits on: a region containing `pos`
 * necessarily overlaps that line, and a line holds only a handful of nodes. This
 * stays exact without either a whole-document scan or a cache that would have to
 * be invalidated as the tree grows.
 *
 * It is a search of the tree's `Math` nodes rather than `resolveInner`, because
 * `resolveInner` answers a *different* question and gets this one wrong: at the
 * offset a closing delimiter sits at it resolves to the delimiter node, which is
 * a sibling of `Math` inside the container rather than a descendant of it, so the
 * caret was reported as prose while it was on the last character of the
 * mathematics. The node's own span is the truth, and comparing against it does
 * not depend on which node the parser happens to return.
 */
export function mathNodeAt(
  state: EditorState,
  pos: number,
  tree: Tree = syntaxTree(state)
): SyntaxNode | null {
  const clamped = Math.max(0, Math.min(pos, state.doc.length))
  const line = state.doc.lineAt(clamped)

  let match: { node: SyntaxNode; region: MathRegion } | undefined

  tree.iterate({
    from: line.from,
    to: line.to,
    enter(nodeRef) {
      if (!nodeRef.type.is('Math')) return
      const region = mathRegionOf(state, nodeRef.node)
      if (region && regionContains(region, clamped)) {
        match = { node: nodeRef.node, region }
        return false
      }
    },
  })

  return match ? match.node : null
}

/** Whether `pos` sits inside a mathematical region. */
export const inMathAt = (state: EditorState, pos: number): boolean =>
  mathNodeAt(state, pos) !== null

/**
 * Whether the current selection is editing mathematics.
 *
 * A selection spanning several regions counts as mathematics only when every
 * part of it is: prose selected alongside an equation is prose being edited.
 */
export function isMathContext(
  state: EditorState,
  tree: Tree = syntaxTree(state)
): boolean {
  return state.selection.ranges.every(range => {
    const node = mathNodeAt(state, range.from, tree)
    if (!node) return false
    const region = mathRegionOf(state, node)
    return region !== null && rangeInRegion(range, region)
  })
}

/**
 * The mark decorations for every mathematical region in a state, within `ranges`.
 *
 * **Eukolia: bounded to the viewport, because a whole-document pass per keystroke is
 * what made a large file unusable.** An empty `ranges` means the whole document, which
 * is what the mount uses and what the tests use; the plugin below passes the viewport.
 *
 * The measurement that forced it, from `scripts/probe-keystroke.mjs` on a 14 529-line
 * Stacks chapter: one keystroke walked **253 535 tree nodes over the whole document**
 * in **48.9 ms**, and it was the single most expensive thing a keystroke did — larger
 * than CodeMirror's own transaction, and about a third of the whole keystroke. This
 * function was the caller (`mathSourceMarks` in the profile's stack). The tree is
 * 519 286 characters and this walked all of it to collect ~400 marks, of which a
 * viewport shows a handful.
 *
 * `mathNodeAt`, twenty lines above, had already been given exactly this treatment for
 * exactly this reason — its comment says a bounded line "stays exact without either a
 * whole-document scan or a cache that would have to be invalidated as the tree grows".
 * The same holds here: a mark outside the viewport is not rendered, so building it is
 * work nobody sees.
 *
 * A range whose ends fall inside a `Math` node still yields that node, because
 * `iterate` visits any node that *begins* before `to` — the node is handed over and its
 * own span, not the range, decides the mark. That is why the regions stay exact at the
 * edges rather than being clipped to the viewport.
 */
export function mathSourceMarks(
  state: EditorState,
  ranges: readonly { from: number; to: number }[] = []
): Range<Decoration>[] {
  const marks: Range<Decoration>[] = []
  const seen = new Set<string>()

  const tree = syntaxTree(state)
  const document = [{ from: 0, to: state.doc.length }]
  for (const range of ranges.length > 0 ? ranges : document) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(nodeRef) {
        if (!nodeRef.type.is('Math')) return
        const region = mathRegionOf(state, nodeRef.node)
        if (!region || region.to <= region.from) return

        const key = `${region.from}:${region.to}`
        if (seen.has(key)) return
        seen.add(key)

        marks.push(
          Decoration.mark({ class: MATH_SOURCE_CLASS }).range(region.from, region.to)
        )
      },
    })
  }

  return marks
}

/**
 * Marks every mathematical region with `eu-cm-math-source`.
 *
 * A view plugin rather than a plain decoration because the regions move with the
 * document. Whether the class is *visible* is a function of the selection —
 * outside mathematics the ported `atomic-decorations.ts` has replaced the whole
 * region with a rendered widget, and a mark that overlaps a replaced range is
 * simply not rendered — so marking unconditionally keeps the rule true the
 * instant the caret arrives, with no second source of truth to keep in step.
 *
 * Rebuilt for the viewport as well as for the document, because the marks are now
 * bounded to it: `atomic-decorations.ts` does the same thing for its widgets, and the
 * two have to agree about which part of the file is "on screen" or a region could be
 * marked here and replaced there. The rule for *when* is the one the ported pass uses —
 * a viewport that has not moved is not a reason to walk anything.
 */
export const mathSourceDecorations: Extension = ViewPlugin.fromClass(
  class {
    public decorations: DecorationSet
    private lastViewport = ''

    constructor(view: EditorView) {
      this.decorations = Decoration.set(
        mathSourceMarks(view.state, viewportRanges(view)),
        true
      )
      this.lastViewport = viewportSignature(view)
    }

    update(update: ViewUpdate): void {
      /*
       * What can change the marks: the document, the parse advancing, and the viewport
       * moving.
       *
       * The parse advancing is the subtle one — the tree arrives in pieces, and this
       * plugin is built against whatever had been parsed when the view mounted. The
       * parsed region's length is the cheap signal for that, and unlike the tree's
       * identity it does not change on every keystroke (see `atomic-decorations.ts`,
       * where that lesson cost three measured attempts).
       *
       * A scroll is not a reason unless it *leaves* what was marked, so the signature
       * is compared rather than the flag consulted: a wheel step within the same
       * viewport does nothing.
       */
      const parsedGrew =
        syntaxTree(update.state).length !== syntaxTree(update.startState).length
      const viewportMoved = update.viewportChanged
      if (!update.docChanged && !parsedGrew && !viewportMoved) return

      const signature = viewportSignature(update.view)
      if (!update.docChanged && !parsedGrew && signature === this.lastViewport) return

      this.lastViewport = signature
      this.decorations = Decoration.set(
        mathSourceMarks(update.state, viewportRanges(update.view)),
        true
      )
    }
  },
  { decorations: instance => instance.decorations }
)

/** The visible ranges, which is what the marks are built for. */
const viewportRanges = (view: EditorView): { from: number; to: number }[] =>
  view.visibleRanges.length > 0
    ? view.visibleRanges.map(range => ({ from: range.from, to: range.to }))
    : [{ from: 0, to: view.state.doc.length }]

/**
 * A cheap identity for "which part of the file is on screen".
 *
 * Length and both ends, because a signature that ignores the position would treat a
 * scroll of a whole screen as no movement when the viewport is a fixed height.
 */
const viewportSignature = (view: EditorView): string =>
  view.visibleRanges.map(range => `${range.from}:${range.to}`).join(',')

/**
 * The editor attribute reporting the current context, recomputed whenever the
 * selection or the document moves.
 *
 * The starting value is written twice on mount — once by the attribute below, so
 * the element is never briefly unmarked for a stylesheet that only matches
 * `on`, and once by the plugin, which is the earliest point the state's tree is
 * available.
 */
export const mathCaretAttribute = (): Extension => [
  EditorView.editorAttributes.of({ [MATH_ATTRIBUTE]: 'off' }),
  ViewPlugin.define(view => {
    let current = isMathContext(view.state)
    apply(view, current)

    return {
      update(update: ViewUpdate) {
        if (!update.selectionSet && !update.docChanged) return
        const next = isMathContext(update.state)
        if (next === current) return
        current = next
        apply(view, next)
      },
    }
  }),
]

const apply = (view: EditorView, inMath: boolean): void => {
  view.dom.setAttribute(MATH_ATTRIBUTE, inMath ? 'on' : 'off')
}
