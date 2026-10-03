import { WidgetType } from '@codemirror/view'

/**
 * The QED mark, drawn where the document writes `\qedhere`.
 *
 * `\qedhere` is AMS's way of putting the end-of-proof mark on the *last line of
 * the proof* rather than on a line of its own, and it is written where it reads —
 * after the sentence:
 *
 * ```latex
 * \begin{proof}
 * Indeed $x = y$.\qedhere
 * \end{proof}
 * ```
 *
 * That position is the whole difficulty, and defining the macro for MathJax is
 * not enough to solve it. The command sits **outside** the `$…$` region: the
 * mathematics on that line is `x = y`, and `\qedhere` follows the full stop as
 * ordinary source. Nothing hands it to the typesetter, so no definition in a
 * preamble can ever draw it — which is why the report still saw the literal text
 * after the macro had been defined.
 *
 * So the command is replaced by this widget instead. It draws the same mark
 * MathJax draws for `\blacksquare` — the AMS end-of-proof square — as *text*, so
 * it needs no typesetting, no font beyond the one already in use, and no round
 * trip through a promise that would delay it by a frame.
 *
 * Both spellings of the position are covered by the caller: a `\qedhere` inside a
 * `proof` environment, and one on the last line before `\end{proof}` — the two
 * ways the command is written in the wild, and the second is what a document
 * edited in Visual Mode ends up with, because it is what the author typed.
 */
export class QedWidget extends WidgetType {
  toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.classList.add('ol-cm-qed')
    element.textContent = '\u25a1'
    // Not content: the mark is decoration, and a reader copying the sentence
    // should not get a stray square. The command's own text is what is replaced,
    // so nothing is lost from the source.
    element.setAttribute('aria-hidden', 'true')
    return element
  }

  eq(): boolean {
    // One mark, one appearance: every instance is interchangeable.
    return true
  }

  ignoreEvent(): boolean {
    // Never a target: a click belongs to the editor, which reveals the source.
    return false
  }
}
