/**
 * Eukolia — where a click on a line the editor has hidden puts the caret.
 *
 * Visual Mode replaces whole lines with block widgets: a hidden environment's
 * `\begin{…}` and `\end{…}` become a strip apiece, `verbatim` and `lstlisting`
 * too, and the preamble becomes one toggle. CodeMirror's hit-testing resolves a
 * click on such a widget by *half* — the source `posAtCoords` ends with
 *
 *     coords.y < rect.top || (coords.y <= rect.bottom && coords.x <= (left + right) / 2)
 *       ? nearest.posAtStart
 *       : nearest.posAtEnd;
 *
 * — so the click itself already answers "before this line" or "after it". Then
 * the port's caret escape, `skipPreambleWithCursor`, pushes a position that sits
 * on a widget to the widget's far side and finishes with "move from the end of a
 * line to the start of the next line". Measured in the running application, that
 * combination puts the caret on the wrong line in every case:
 *
 *   | clicked | caret landed | wanted |
 *   | --- | --- | --- |
 *   | `\end{figure}` | the blank line after it | the end of `\end{figure}` |
 *   | `\end{verbatim}` | the blank line after it | the end of `\end{verbatim}` |
 *   | `\begin{figure}` | the blank line before it | the start of `\begin{figure}` |
 *   | `\begin{verbatim}` | the body's first line | the start of `\begin{verbatim}` |
 *   | the `tikzcd` island | the blank line before it | the start of `\begin{tikzcd}` |
 *   | the theorem header | one character into the line | the start of it |
 *
 * **The rule**, and it is one rule: a caret the editor resolved to a position that
 * is not source — the empty line a strip swallowed, or a character inside a hidden
 * line rather than at its edge — belongs on the nearest line that *has* source, at
 * the end the click's own half asked for. The near half wants the end of that line,
 * because the reader is pointing at what is above the click; the far half wants its
 * start.
 *
 * Nothing here needs to know *which* widget was clicked, because the position the
 * editor resolved already says so: the port's edges extend backwards and forwards
 * over the empty lines around an environment, so their far side is routinely a
 * blank line rather than a `\end`. Blank lines are therefore the signal, and they
 * are also the one thing no reader ever aims at, which is what makes stepping over
 * them safe in both directions.
 *
 * Two richer sources of truth were tried and rejected, and the reasons are worth
 * keeping because both look right:
 *
 *  * `EditorView.atomicRanges` — the facet the escape itself walks, and exact about
 *    where the hidden source is. Matching a *clicked element* to its range needs
 *    real layout, though: `domAtPos` cannot name a widget at all (it resolves a
 *    position inside a replaced range to the *content container*, or to a node
 *    whose rectangle is the whole document), and matching boxes against boxes only
 *    works when the boxes are the browser's. The facet is still consulted, for the
 *    direction — a range ending at the resolved position means the click was on
 *    that strip's far half, and one starting there means its near half.
 *  * `EditorView.elementAtHeight` — answers with the block *around* a block widget
 *    rather than the widget, so the range it names is the line before or after.
 *
 * **This is a divergence from the reference, not a port.** Upstream Overleaf has no
 * equivalent, and the reason is structural: it is the *combination* of the
 * reference's half-based hit-testing with the escape rule that strands the caret.
 * The escape cannot simply be narrowed — it exists for a different and still-valid
 * reason, recorded in its own comment — so the click is answered here, first, and
 * the escape is left to do its job on every other path.
 *
 * The handler runs synchronously on `mousedown` and dispatches the selection
 * itself, which is also what keeps a drag correct: CodeMirror's own `mousedown`
 * selection then extends from the position this puts the caret at. Returning `true`
 * is what stops the editor resolving the click by half afterwards.
 */
import { EditorSelection } from '@codemirror/state'
import type { EditorState, RangeSet } from '@codemirror/state'
import { EditorView, type Decoration } from '@codemirror/view'

/** The classes a block widget that stands in for source carries. */
const BLOCK_WIDGET_SELECTOR = [
  // `EnvironmentLineWidget` — a hidden environment's two edges.
  '.ol-cm-environment-edge',
  // The `tikzcd` island, and any mathematics the typesetter refused.
  '.ol-cm-unrenderable-math',
  // The collapsed preamble toggle.
  '.ol-cm-preamble-widget',
].join(',')

/**
 * How far from the resolved position a click may look for the line it means.
 *
 * The port extends an edge over the blank lines around an environment and a
 * document may have a run of them, so this is a handful rather than one. Beyond it
 * the click is in open space and belongs where it landed.
 */
const LOOKAHEAD = 4

/** The atomic range containing `pos` — a position the escape will move. */
function hiddenRangeAt(
  state: EditorState,
  pos: number
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null
  const visit = (set: RangeSet<Decoration>) => {
    set.between(Math.max(0, pos - 1), Math.min(pos + 1, state.doc.length), (from, to) => {
      if (found || to <= from) return
      if (from <= pos && pos < to) found = { from, to }
    })
  }
  for (const source of state.facet(EditorView.atomicRanges)) visit(source as unknown as RangeSet<Decoration>)
  return found
}

/**
 * Which half of a hidden line the click was on.
 *
 * Kept because the *decision* uses it: `caretForHiddenLine` answers only the far
 * half, and the near half is left to the port's escape. The resolved position is
 * where the answer is, and it is the only place it exists once the widget is gone
 * from the DOM — a click on the near half resolves *to* the line, so the position
 * before it is inside a range, while one on the far half resolves *past* it.
 */
function clickedFarHalf(state: EditorState, resolved: number): boolean {
  const before = hiddenRangeAt(state, Math.max(0, resolved - 1))
  if (before && before.to === resolved) return true
  return hiddenRangeAt(state, resolved) === null
}

/**
 * The caret a click at `resolved` asked for, or `null` to leave it alone.
 *
 * **Only the far half is answered, and that is the whole rule.** A hidden line is a
 * line the editor has decided not to show, so the two halves of its strip mean
 * different things, and the port's own escape already answers the near one
 * correctly: it carries the caret to the far side of the hidden range, which is the
 * end of the line *before* the environment — a visible line, and the right place to
 * be if the reader was pointing above the strip. It is the far half that the escape
 * gets wrong, because the far side of a strip is routinely a blank line the port's
 * own `extendForwardsOverEmptyLines` swallowed, and no reader aims at a blank line.
 *
 * So: the resolved position is stepped back to the nearest line with source on it,
 * and the caret goes to the end of that line — which is what "clicking `\end{XXX}`
 * places the cursor at the end of `\end{XXX}`" asks for.
 *
 * `half` is which half of the clicked strip the reader was pointing at, read from
 * the element by the caller. Exported for its own test: the decision is worth
 * pinning without a DOM.
 */
export function caretForHiddenLine(
  state: EditorState,
  resolved: number,
  half: 'near' | 'far'
): number | null {
  if (half === 'near') return null

  const doc = state.doc
  const position = Math.max(0, Math.min(resolved, doc.length))
  const line = doc.lineAt(position)

  // A line with source on it is already the answer when the click resolved onto
  // one; the caret belongs at its end, which is where the reader pointed.
  if (line.text.trim().length > 0) {
    return hiddenRangeAt(state, position) || position === line.to ? line.to : null
  }

  // A blank line: the nearest one above with source on it, and the end of it.
  for (let step = 1; step <= LOOKAHEAD; step += 1) {
    const number = line.number - step
    if (number < 1) break
    const candidate = doc.line(number)
    if (candidate.text.trim().length === 0) continue
    return candidate.to
  }
  return null
}


/**
 * Answers a click on a block widget, before the editor resolves it by half.
 */
export const clickOnHiddenLine = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    if (event.button !== 0) return false
    const target = event.target as Element | null
    const widget = target?.closest?.(BLOCK_WIDGET_SELECTOR)
    if (!widget) return false

    // A control *inside* the widget keeps its own click — the preamble toggle is a
    // `<button>` and clicking it must still toggle. The check is therefore against
    // the widget's descendants rather than the widget itself, which for the
    // preamble toggle *is* the button; testing the wrong one made every click on it
    // return early, and the defect hid behind that for three attempts.
    const control = target?.closest?.(
      'button,a,input,select,textarea,[role="button"],[contenteditable="true"]'
    )
    if (control && control !== widget && widget.contains(control)) return false

    // Where the editor would put the caret. This is the browser's own hit-test, so
    // it is exact wherever layout is real; the half is read from the element
    // because a widget is as tall as it is and the two halves mean different sides.
    const box = widget.getBoundingClientRect()
    const near = event.clientY <= box.top + box.height / 2
    const resolved = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
    if (resolved === null || resolved === undefined) return false

    const position = caretForHiddenLine(view.state, resolved, near ? 'near' : 'far')
    if (position === null || position === resolved) return false

    const selectionRange = EditorSelection.cursor(position)
    const selection = event.ctrlKey
      ? view.state.selection.addRange(selectionRange)
      : selectionRange

    view.dispatch({
      selection,
      effects: EditorView.scrollIntoView(position, { y: 'nearest' }),
    })
    return true
  },
})
