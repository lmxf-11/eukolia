/**
 * Eukolia — putting the viewport back when the editor is rebuilt.
 *
 * **Not** for a mode switch: Code Mode and Visual Mode are one `EditorView` whose
 * mode-dependent extensions live in compartments, so switching mode is a
 * transaction that leaves the state, the selection and the viewport element
 * exactly where they were. The switch holds its own position — the caret line's
 * place in the viewport — through CodeMirror's scroll snapshot, in
 * `modeSwitch.ts`, because the two modes lay the same source out at different
 * heights and a remembered *line* would not put the caret where the reader left
 * it. Nothing here is involved in that path.
 *
 * This module is for the rebuilds that remain: a different document, the theme,
 * or an `editor.*` setting — anything that decides how the editor is
 * *constructed*. Those really do produce a new view, so the position the user was
 * reading has to be carried over explicitly, and it travels as the *line* that
 * was at the top of the viewport: the unit both modes can reproduce, since a line
 * is taller in Visual Mode than in source mode and the same scroll offset is a
 * different line in each. This module turns that line back into a scroll offset.
 *
 * ## Why not `EditorView.scrollIntoView`
 *
 * That is the obvious call, and it is what this code did first. It cannot reach a
 * line the view has not rendered, and it fails **silently** when it cannot:
 *
 * ```text
 * ViewState.scrollIntoView:  let rect = this.coordsAt(range.head, …); if (!rect) return
 * DocView.coordsAt:          answers from the rendered children only
 * ```
 *
 * A freshly built view has rendered the first screenful, so restoring a position
 * near the end of the document did nothing at all — the view stayed at
 * `scrollTop: 0`, exactly as if the restore had never run — while the identical
 * code worked with the viewport at the top of the document, where the target
 * line *is* rendered.
 *
 * `lineBlockAt` answers for every line: from the height oracle — an estimate —
 * while a region is unmeasured, exactly once it has been measured. Scrolling by
 * that geometry is what CodeMirror itself does for a scroll snapshot
 * (`EditorView.scrollSnapshot` builds a `ScrollTarget` with `isSnapshot: true`,
 * and `ViewState.scrollIntoView` then assigns
 * `scrollDom.scrollTop = lineBlockAt(pos).top - yMargin`). Assigning `scrollTop`
 * is safe: the browser fires `scroll`, and the view measures and re-renders the
 * new viewport. An estimate is corrected by running the restore again once the
 * parse has settled, which is why the host calls these more than once.
 */

import type { EditorView } from '@codemirror/view'

import { scrollLineFor, type ModeSwitchSnapshot } from './mode'

/** The largest scroll offset the viewport can take. */
const maximumScrollTop = (view: EditorView): number =>
  Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight)

/**
 * The 1-based number of the line at the top of the viewport — the line the user
 * sees first, and the position this module exists to put back.
 *
 * `lineBlockAtHeight` takes a pixel height measured from the top of the document
 * and returns a **`BlockInfo`**, so the offset to ask `lineAt` about is its
 * `.from`. Leaving that step out is not a small mistake: `lineAt` then receives
 * an object, every bound check against it is false, CodeMirror walks off the end
 * of the text's children and reads `.length` of `undefined` — a `TypeError` from
 * inside `@codemirror/state` that says nothing about a pixel height having been
 * passed where a document offset belongs. This function is the one place the
 * rule lives, so the capture and the restore cannot drift apart, and it is
 * tested against heights past the end of the content for exactly that reason.
 *
 * A height past the end of the content — a short document, a tall viewport, a
 * scroller with bottom padding — resolves to the last line, which is correct:
 * the last line is the topmost line on screen.
 *
 * The default height is the scroller's own geometry (`scrollTop`, via the top of
 * the scroller and the document's top edge); an explicit one is accepted so a
 * caller can ask the question without touching the scroller.
 */
export function topVisibleLine(view: EditorView, height?: number): number {
  const at =
    height ?? view.scrollDOM.getBoundingClientRect().top - view.documentTop
  return view.state.doc.lineAt(view.lineBlockAtHeight(at).from).number
}

/**
 * The document offset whose line belongs at the top of the viewport: the line
 * the snapshot recorded, clamped into the document.
 *
 * Never the caret's line: with the viewport at the top of a long document and
 * the caret below it, that is what used to throw the position away.
 */
export function restoreOffsetFor(
  view: EditorView,
  snapshot: ModeSwitchSnapshot
): number {
  const line = Math.max(1, Math.min(scrollLineFor(snapshot), view.state.doc.lines))
  return view.state.doc.line(line).from
}

/**
 * Puts the line at `offset` at the top of the viewport, and returns the scroll
 * offset it moved to.
 *
 * The offset is clamped to the viewport's own limits, so a line closer to the
 * end of the document than one screenful simply lands at the bottom — where it
 * already is — instead of asking the scroller for a position it does not have.
 *
 * A direct `scrollTop` write is only reported to CodeMirror by the browser on the
 * next `scroll` event, so the position is applied again by the callers' second
 * pass rather than assumed here (see the host: the pass after the eager parse).
 */
export function scrollLineToTop(view: EditorView, offset: number): number {
  const target = Math.min(view.lineBlockAt(offset).top, maximumScrollTop(view))
  const clamped = Math.max(0, target)
  view.scrollDOM.scrollTop = clamped
  return clamped
}

/**
 * Brings the caret back on screen with the smallest scroll that does it, and
 * returns the scroll offset it moved to — or `null` when the caret was already
 * visible, or when the view has no layout to reason about yet.
 *
 * This is what keeps a caret that sat below the fold in the old mode from being
 * hidden by the new one's taller lines, without giving up the recorded top line
 * when the caret is visible anyway.
 */
export function revealCaretIfOffscreen(view: EditorView): number | null {
  const scroller = view.scrollDOM
  const height = scroller.clientHeight
  if (height <= 0) return null

  const block = view.lineBlockAt(view.state.selection.main.head)
  const top = scroller.scrollTop
  if (block.top >= top - 1 && block.bottom <= top + height + 1) return null

  // Above the viewport: its top goes to the top. Below: its bottom goes to the
  // bottom, which moves the viewport as little as the caret needs.
  const wanted = block.top < top ? block.top : block.bottom - height
  const target = Math.max(0, Math.min(wanted, maximumScrollTop(view)))
  scroller.scrollTop = target
  return target
}
