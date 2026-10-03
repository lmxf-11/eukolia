import { DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import {
  EditorSelection,
  EditorState,
  RangeSet,
  StateField,
} from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { collapsePreambleEffect, Preamble } from './visual-widgets/preamble'
/**
 * A view plugin that moves the cursor from the start of the preamble into the document body when the doc is opened.
 *
 * Eukolia divergences from the reference, both in the escape and both recorded
 * here because this file is a port:
 *
 *  * The reference only ever escapes the cursor *once*, when the parse of the
 *    opened document completes (`checkedOnce` below). Eukolia also escapes after
 *    an edit, after the atomic decoration set is rebuilt, and after the editor's
 *    geometry changed. The last of the three is what covers a widget that
 *    finishes rendering after the cursor was placed beside it: an SVG that
 *    loads, a PDF page that is rasterised, an image that reports its intrinsic
 *    size. None of those is a document change or a decoration rebuild — the
 *    widget's box simply changes height, which re-lays-out the content around
 *    it and lets the browser (and CodeMirror's own atomic-range resolution) move
 *    the caret against the widget's edges. Without that trigger the caret is
 *    left on the wrong side of a rendered figure with nothing having "moved" it.
 *
 *  * `skipAtomicRanges` treats a position sitting on a range's **left edge** as
 *    inside it and pushes it to the far side, which is the reference's rule
 *    (`between(pos, pos, …)` with no left-edge exclusion). Eukolia narrowed it
 *    to positions *strictly* inside while keeping the left edge for the preamble
 *    escape only, on the theory that a caret parked before a figure was placed
 *    there deliberately. That theory does not hold for the block replacements
 *    Visual Mode builds: the decoration that replaces an `\includegraphics` line
 *    covers the whole line, so its left edge is the line's first *character* —
 *    invisible indentation, not a place anyone reads — and CodeMirror's own
 *    caret motion lands there: `skipAtoms` in `@codemirror/view` biases a caret
 *    moving *backwards* onto a widget to the near edge (`oldPos.head >
 *    pos.from ? -1 : 1`), so ArrowUp onto a figure line, a click on the left
 *    half of a figure or a restored position all resolve to `from`. The caret
 *    then sits to the left of the image and the next keystroke lands *before*
 *    the command. Positions strictly before a range are never touched, and a
 *    caret inside the source a widget replaced (`shouldDecorate` in
 *    `atomic-decorations.ts`) reveals the source instead of leaving a range
 *    behind, so no deliberate position is lost by the wider rule.
 */
export const skipPreambleWithCursor = (
  field: StateField<{ preamble: Preamble; decorations: DecorationSet }>
) =>
  ViewPlugin.define((view: EditorView) => {
    let checkedOnce = false

    /**
     * True when the atomic decoration set was rebuilt for this update, which is
     * what can turn a position that was plain source into one inside a widget.
     *
     * Comparing identity rather than contents is deliberate: the field rebuilds
     * its decoration set whenever the parse advances or the selection moves, and
     * a rebuild is exactly the event that can swallow a caret.
     */
    const decorationsChanged = (update: ViewUpdate): boolean => {
      const after = update.state.field(field, false)
      if (!after) return false
      const before = update.startState.field(field, false)
      return before?.decorations !== after.decorations
    }

    const escapeFromAtomicRanges = (
      selection: EditorSelection,
      force = false
    ) => {
      const originalSelection = selection

      const atomicRangeSets = view.state
        .facet(EditorView.atomicRanges)
        .map(item => item(view))

      for (const [index, range] of selection.ranges.entries()) {
        const anchor = skipAtomicRanges(
          view.state,
          atomicRangeSets,
          range.anchor
        )
        const head = skipAtomicRanges(
          view.state,
          atomicRangeSets,
          range.head
        )

        if (anchor !== range.anchor || head !== range.head) {
          selection = selection.replaceRange(
            EditorSelection.range(anchor, head),
            index
          )
        }
      }

      if (force || selection !== originalSelection) {
        window.setTimeout(() => {
          view.dispatch({
            selection,
            scrollIntoView: false,
          })
        })
      }
    }

    const escapeFromPreamble = () => {
      const preamble = view.state.field(field, false)?.preamble
      if (preamble) {
        escapeFromAtomicRanges(
          EditorSelection.create([EditorSelection.cursor(preamble.to + 1)]),
          true
        )
      }
    }

    return {
      update(update) {
        // A caret must never come to rest on the near side of a rendered widget.
        //
        // Visual Mode replaces source with atomic widgets, so a caret at or
        // inside one is meaningless — and CodeMirror resolves it against
        // whichever edge is nearer, which for a caret just inside a figure means
        // the left edge: the next keystroke lands before the image instead of
        // after it. This escape pushes it to the right of the widget instead.
        //
        // It runs when an edit, a decoration rebuild or a change of the layout
        // could have put the caret there. It deliberately does *not* run on a
        // plain selection change on its own: keyboard motion already skips
        // atomic ranges, so a caret the user moved never rests inside one, and
        // re-running the escape there would fight deliberate navigation. (The
        // decoration field happens to rebuild on any selection transaction, so
        // the escape does run for those too; the rule above is what keeps that
        // harmless.)
        if (
          update.docChanged ||
          update.geometryChanged ||
          decorationsChanged(update)
        ) {
          escapeFromAtomicRanges(update.state.selection)
        }

        if (checkedOnce) {
          if (
            update.transactions.some(tr =>
              tr.effects.some(effect => effect.is(collapsePreambleEffect))
            )
          ) {
            escapeFromPreamble()
          }
          return
        }

        const { state } = update

        if (syntaxTree(state).length === state.doc.length) {
          checkedOnce = true

          // Only move the cursor if we're at the default position (0) and haven't scrolled away.
          // Otherwise switching back and forth between source/RT or scrolling while parsing
          // would jump the scroll position.
          const isAtTop = (view.scrollDOM?.scrollTop ?? 0) <= 10
          if (
            isAtTop &&
            state.selection.eq(
              EditorSelection.create([EditorSelection.cursor(0)])
            )
          ) {
            escapeFromPreamble()
          } else {
            escapeFromAtomicRanges(state.selection)
          }
        }
      },
    }
  })

/**
 * The far side of every atomic range `pos` touches.
 *
 * A position that is at or inside a range — `from <= pos < to` — is pushed to
 * the range's end; a position strictly before or after one is left alone. Ranges
 * are followed to a fixed point, so a caret inside nested decorations comes out
 * past all of them.
 *
 * Eukolia divergence from the reference, and the reason for it:
 *
 * The reference then moves a position that landed on a line's end to the start of
 * the next line, unconditionally. That is wrong when the widget is a *block strip
 * standing in for that line*, which is what Visual Mode builds for a hidden
 * environment's `\begin{…}` and `\end{…}`. A click near the bottom of such a strip
 * asks for the end of `\end{figure}`, and the reference's rule then moved the caret
 * one further — onto the blank line after the environment, which is routinely what
 * the port's own `extendForwardsOverEmptyLines` had put there:
 *
 *   | clicked | caret landed | wanted |
 *   | --- | --- | --- |
 *   | `\end{figure}` | the blank line after it | the end of `\end{figure}` |
 *   | `\end{verbatim}` | the blank line after it | the end of `\end{verbatim}` |
 *
 * So a position that is the far edge of a range ending at a line's end stays there:
 * the range's own extent decides, and the caret stops where the source the strip
 * stands for stops. Every other position keeps the reference's rule, which the
 * figure-cursor tests below still hold it to.
 */
const skipAtomicRanges = (
  state: EditorState,
  rangeSets: RangeSet<any>[],
  pos: number
) => {
  let oldPos
  do {
    oldPos = pos

    for (const rangeSet of rangeSets) {
      // The query window is one character wide on purpose. `between` visits the
      // ranges *touching* the queried region, and the zero-length query
      // `between(pos, pos, …)` this used to make never reached a range that
      // merely contains `pos`, so the escape silently did nothing.
      rangeSet.between(Math.max(0, pos - 1), pos + 1, (from, to) => {
        if (from <= pos && to > pos) {
          pos = to
        }
      })
    }

    // move from the end of a line to the start of the next line — unless this
    // position *is* the far edge of a range that ends here, which is a hidden
    // line's own end and where a click on its strip asked to be
    if (
      pos !== oldPos &&
      state.doc.lineAt(pos).to === pos &&
      !endsAtomicRange(rangeSets, pos)
    ) {
      pos++
    }
  } while (pos !== oldPos)

  return Math.min(pos, state.doc.length)
}

/** Whether an atomic range ends exactly at `pos`. */
const endsAtomicRange = (rangeSets: RangeSet<any>[], pos: number): boolean => {
  let ends = false
  for (const rangeSet of rangeSets) {
    rangeSet.between(Math.max(0, pos - 1), pos + 1, (from, to) => {
      if (to === pos && to > from) ends = true
    })
  }
  return ends
}
