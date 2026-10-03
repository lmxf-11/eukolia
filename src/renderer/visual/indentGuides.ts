/**
 * Eukolia — indentation guides for the CodeMirror editor.
 *
 * Monaco drew a thin vertical line at every indentation level
 * (`editor.guides.indentation`, and `editor.renderIndentGuides` before it), and
 * the editor that replaced it should look as good. CodeMirror has no
 * equivalent, so this module turns the indentation of the visible lines into a
 * decoration set:
 *
 *  * one mark per indentation level, covering the single whitespace character
 *    that *starts* at that level's column — which is exactly where Monaco draws
 *    the line, and which works for space- and tab-indented files alike;
 *  * the mark carries a 1px background at its left edge rather than a border, so
 *    the guides cost nothing in layout: a border would add a pixel per level and
 *    push the text out of alignment with the character grid;
 *  * the caret's own line uses the *active* guide colour, Monaco's
 *    `editorIndentGuide.activeBackground`.
 *
 * A line indented by `columns` columns draws a guide at `tabSize`, `2*tabSize`,
 * … while that column is strictly less than the line's indentation — Monaco's
 * rule, and the reason the innermost line of a block carries no guide of its
 * own: the guides show what a line is nested *inside*.
 *
 * A line with no whitespace at all draws nothing. Monaco draws the enclosing
 * block's guides on an empty line, but there is no character to hang a mark on;
 * doing it without moving the text would need the character width measured into
 * a CSS variable, and the guides that matter — the ones beside real, indented
 * source — are unaffected.
 *
 * Only the viewport is scanned, so the cost does not grow with the document.
 * The tab size is read from the same `EditorState.tabSize` facet the editor is
 * configured with, so a tab-indented file draws its guides where its tabs are.
 */

import { RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view'

/** The deepest level that is drawn; a decoration value per level, created once. */
export const MAX_INDENT_GUIDE_LEVELS = 24

/**
 * One decoration value per level.
 *
 * A distinct value per level matters: CodeMirror merges *adjacent* marks that
 * share a value into a single element, and a merged run would draw one line at
 * its left edge instead of one per level.
 */
const inactiveMarks: Decoration[] = []
const activeMarks: Decoration[] = []
for (let level = 0; level < MAX_INDENT_GUIDE_LEVELS; level += 1) {
  const levelNumber = String(level + 1)
  inactiveMarks.push(
    Decoration.mark({
      class: 'cm-indent-guide',
      attributes: { 'data-indent-level': levelNumber },
    })
  )
  activeMarks.push(
    Decoration.mark({
      class: 'cm-indent-guide cm-indent-guide-active',
      attributes: { 'data-indent-level': levelNumber },
    })
  )
}

/**
 * The columns a guide is drawn at for a line indented by `columns` columns:
 * every tab stop that the line's own indentation passes. Monaco draws a guide
 * for each level a line is nested inside, so the innermost line of a block
 * carries none.
 */
export function guideColumns(columns: number, tabSize: number): number[] {
  if (!Number.isFinite(tabSize) || tabSize < 1) return []
  const result: number[] = []
  for (
    let column = tabSize;
    column < columns && result.length < MAX_INDENT_GUIDE_LEVELS;
    column += tabSize
  ) {
    result.push(column)
  }
  return result
}

/**
 * The visual width of a line's leading whitespace, in columns. A tab advances
 * to the next multiple of `tabSize`, as it does in the editor.
 */
export function indentationColumns(text: string, tabSize: number): number {
  const width = Math.max(1, Math.floor(tabSize) || 1)
  let columns = 0
  for (const character of text) {
    if (character === ' ') columns += 1
    else if (character === '\t') columns += width - (columns % width)
    else break
  }
  return columns
}

/**
 * The offset of each character that starts at a guide column, paired with the
 * level it draws — the whole of the extension's geometry, as a pure function so
 * it can be tested without a layout.
 */
export function guideOffsets(
  text: string,
  tabSize: number
): Array<{ offset: number; level: number }> {
  const width = Math.max(1, Math.floor(tabSize) || 1)
  const wanted = new Set(guideColumns(indentationColumns(text, width), width))
  const result: Array<{ offset: number; level: number }> = []
  let columns = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character !== ' ' && character !== '\t') break
    if (wanted.has(columns)) {
      result.push({ offset: index, level: columns / width - 1 })
    }
    columns += character === '\t' ? width - (columns % width) : 1
  }
  return result
}

const buildDecorations = (view: EditorView, tabSize: number): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>()
  const { doc } = view.state
  const caretLine = doc.lineAt(view.state.selection.main.head).number

  for (const { from, to } of view.visibleRanges) {
    const firstLine = doc.lineAt(from).number
    const lastLine = doc.lineAt(to).number

    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
      const line = doc.line(lineNumber)
      const marks = lineNumber === caretLine ? activeMarks : inactiveMarks
      for (const { offset, level } of guideOffsets(line.text, tabSize)) {
        const mark = marks[level]
        if (!mark) continue
        builder.add(line.from + offset, line.from + offset + 1, mark)
      }
    }
  }

  return builder.finish()
}

/**
 * The indentation-guide extension.
 *
 * The tab size is read from the state on every rebuild rather than closed over,
 * so the guides stay correct when a state is replaced under a live view.
 */
export const indentGuides = (): Extension =>
  ViewPlugin.fromClass(
    class {
      public decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, view.state.tabSize)
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.startState.tabSize !== update.state.tabSize
        ) {
          this.decorations = buildDecorations(update.view, update.state.tabSize)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
