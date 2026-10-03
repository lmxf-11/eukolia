/**
 * Eukolia — `editor.renderWhitespace` for the CodeMirror editor.
 *
 * Monaco rendered whitespace itself, from the `editor.renderWhitespace`
 * setting; CodeMirror has no equivalent switch, so this module turns the same
 * three values into a decoration set:
 *
 *   `none`      nothing is marked — the extension is not mounted at all. This is
 *               the default; see `DEFAULT_WHITESPACE_RENDERING` below.
 *   `boundary`  Monaco's rule: every whitespace character *except* a single
 *               space between two words. A run of two or more spaces is marked,
 *               as is a tab, and as is a lone space at the start or the end of a
 *               line; only a lone space with text on both sides is left alone.
 *   `all`       every space and every tab is marked.
 *
 * The marks reuse CodeMirror's own `cm-highlightSpace` / `cm-highlightTab`
 * classes, which the base theme (always present) already draws as a faint dot
 * per space and an arrow per tab — the same glyphs `highlightWhitespace()`
 * produces, which is why the two are interchangeable for `all`.
 *
 * Only the viewport is scanned, so the cost does not grow with the document.
 */

import { RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view'

/** Monaco's `editor.renderWhitespace`, restricted to the values Eukolia offers. */
export type WhitespaceRendering = 'none' | 'boundary' | 'all'

/**
 * The setting's own default, and what an unrecognised value falls back to.
 *
 * Nothing is marked unless the reader asks for it. `boundary` was the default
 * and it is a poor one for prose: a run of two spaces is *marked*, so every
 * trailing space — the ones a `\begin{theorem}` line picks up from an editor
 * that once padded it, from a paste, or from filling an environment — became a
 * row of dots across the source. VS Code, whose setting this is, does not mark
 * whitespace while you read either: its default is `selection`, which shows the
 * marks only inside a selection, and it marks nothing at all the rest of the
 * time. Eukolia offers no selection mode, so the honest default here is `none`;
 * the value is one click away in Settings for anyone who wants the marks.
 */
export const DEFAULT_WHITESPACE_RENDERING: WhitespaceRendering = 'none'

/**
 * The value as the extension understands it.
 *
 * Written out in full rather than as "everything but `none` and `all`", which is
 * how it read while `boundary` was the default: with the default now `none`, that
 * short form would have quietly turned an explicitly chosen `boundary` into
 * "show nothing". An unknown value — a hand-edited settings file naming Monaco's
 * `selection`, say — falls back to the default.
 */
export const normalizeWhitespaceRendering = (
  value: string
): WhitespaceRendering =>
  value === 'none' || value === 'boundary' || value === 'all'
    ? value
    : DEFAULT_WHITESPACE_RENDERING

/**
 * One mark per character, so the base theme's per-character background (a dot
 * per space, an arrow per tab) repeats the way `highlightWhitespace()` makes it
 * repeat. Marking a whole run with one decoration would stretch a single dot
 * across the run instead.
 */
const spaceMark = Decoration.mark({ class: 'cm-highlightSpace' })
const tabMark = Decoration.mark({ class: 'cm-highlightTab' })

/** A run of spaces and tabs: the unit the `boundary` rule is applied to. */
const whitespaceRun = /[ \t]+/g

/**
 * Whether a run survives Monaco's `boundary` rule.
 *
 * `index` is the run's offset within its line and `lineLength` that line's
 * length in characters, which is what makes "at the start or end of a line"
 * answerable without looking outside the line.
 */
export function markedAtBoundary(
  run: string,
  index: number,
  lineLength: number
): boolean {
  // A run, or a tab, is never "a single space between two words".
  if (run.length > 1 || run !== ' ') return true
  return index === 0 || index + run.length === lineLength
}

const buildDecorations = (
  view: EditorView,
  mode: WhitespaceRendering
): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>()

  for (const { from, to } of view.visibleRanges) {
    let position = from
    while (position <= to) {
      const line = view.state.doc.lineAt(position)
      whitespaceRun.lastIndex = 0

      let match: RegExpExecArray | null
      while ((match = whitespaceRun.exec(line.text)) !== null) {
        const run = match[0]
        if (mode === 'boundary' && !markedAtBoundary(run, match.index, line.length)) {
          continue
        }
        // One mark per character, in ascending order, which is what
        // `RangeSetBuilder` requires.
        for (let index = 0; index < run.length; index += 1) {
          const start = line.from + match.index + index
          builder.add(
            start,
            start + 1,
            run[index] === '\t' ? tabMark : spaceMark
          )
        }
      }

      if (line.to >= to) break
      position = line.to + 1
    }
  }

  return builder.finish()
}

/**
 * The whitespace-rendering extension for a mode, or nothing for `none`.
 *
 * The mode is closed over rather than held in a facet: the host rebuilds the
 * editor when the setting changes, which is how every other editor setting
 * reaches CodeMirror here.
 */
export const whitespaceRendering = (mode: WhitespaceRendering): Extension => {
  if (mode === 'none') return []

  return ViewPlugin.fromClass(
    class {
      public decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, mode)
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, mode)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}
