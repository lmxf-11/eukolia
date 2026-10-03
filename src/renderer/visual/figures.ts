/**
 * Figure option editing for the Visual Editor.
 * Applies figure options — width, caption, and label — through minimal source
 * edits without regenerating unchanged text.
 *
 * Every function in this module is pure: it turns a `FigureData` plus the
 * requested options into the **minimal** source changes needed
 * (Instructions.md §18, §27). Nothing is regenerated; an unchanged figure is
 * left byte-identical.
 */

import type { EditorState } from '@codemirror/state'
import type { ChangeSpec } from './scope'
import type { FigureData } from '@/vendor/overleaf/extensions/figure-modal'

export interface FigureEditOptions {
  /** Figure width as a fraction of `\textwidth` (0…1). */
  width?: number
  /** Caption text, without braces. */
  caption?: string
  /** Label text, without braces. */
  label?: string
}

export interface FigureCapabilities {
  /** The graphics command can carry a `width=` option. */
  width: boolean
  /** A caption can be edited or added. */
  caption: boolean
  /** A label can be edited or added. */
  label: boolean
}

/** Formats a width fraction as the LaTeX `\textwidth` multiple. */
export const formatWidth = (fraction: number): string => {
  const clamped = Math.max(0.05, Math.min(1, fraction))
  const percent = Math.round(clamped * 100)
  if (percent === 100) return '\\textwidth'
  return `${(percent / 100).toFixed(2).replace(/0$/, '')}\\textwidth`
}

/** Finds the end of the control word starting at `from`. */
const controlWordEnd = (state: EditorState, from: number): number => {
  const text = state.doc.sliceString(from, Math.min(from + 64, state.doc.length))
  const match = /^\\([a-zA-Z]+|.)/.exec(text)
  return from + (match ? match[0].length : 1)
}

/**
 * Finds the body range of the `{...}` argument whose opening brace is the first
 * `{` at or after `from` and before `limit`.
 */
const braceBodyAt = (
  state: EditorState,
  from: number,
  limit: number
): { from: number; to: number } | null => {
  const open = state.doc.sliceString(from, limit).indexOf('{')
  if (open < 0) return null
  const bodyFrom = from + open + 1
  let depth = 1
  let index = bodyFrom
  while (index < limit && depth > 0) {
    const char = state.doc.sliceString(index, index + 1)
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    if (depth === 0) return { from: bodyFrom, to: index }
    index += 1
  }
  return null
}

/** The start of the `\end{...}` line that closes the figure environment. */
const environmentEndStart = (state: EditorState, figure: FigureData): number => {
  const text = state.doc.sliceString(figure.from, figure.to)
  const index = text.lastIndexOf('\\end{')
  if (index < 0) return figure.to
  return state.doc.lineAt(figure.from + index).from
}

/** Indentation of the line that closes the figure environment. */
const environmentIndent = (state: EditorState, figure: FigureData): string => {
  const line = state.doc.lineAt(environmentEndStart(state, figure))
  const match = /^\s*/.exec(line.text)
  return match ? match[0] : ''
}

export const readFigureCapabilities = (
  figure: FigureData
): FigureCapabilities => ({
  width: true,
  caption: figure.caption !== null || figure.to > figure.from,
  label: figure.label !== null || figure.to > figure.from,
})

const widthEdit = (
  state: EditorState,
  figure: FigureData,
  width: number
): ChangeSpec[] => {
  const replacement = `width=${formatWidth(width)}`

  if (figure.graphicsCommandArguments) {
    const { from, to } = figure.graphicsCommandArguments
    // `ShortOptionalArg` is the option list; some grammar revisions include the
    // surrounding brackets in the node and some do not, so normalise here.
    const raw = state.doc.sliceString(from, to)
    const hasBrackets = raw.startsWith('[') && raw.endsWith(']')
    const bodyFrom = hasBrackets ? from + 1 : from
    const body = hasBrackets ? raw.slice(1, -1) : raw

    // `(^|,)` plus the captured whitespace keeps the range correct whether or
    // not the option is preceded by a space, so the replacement is byte-exact
    // apart from the value.
    const match = /(^|,)(\s*)width\s*=\s*[^,\]]*/.exec(body)
    if (match) {
      const start = bodyFrom + match.index + match[1].length
      const end = bodyFrom + match.index + match[0].length
      return [{ from: start, to: end, insert: `${match[2]}${replacement}` }]
    }
    return [{ from: bodyFrom, to: bodyFrom, insert: `${replacement},` }]
  }

  // No optional argument yet: add one after the command name.
  const insertAt = controlWordEnd(state, figure.graphicsCommand.from)
  return [{ from: insertAt, to: insertAt, insert: `[${replacement}]` }]
}

const captionOrLabelEdit = (
  state: EditorState,
  figure: FigureData,
  existing: { from: number; to: number } | null,
  command: 'caption' | 'label',
  value: string
): ChangeSpec[] => {
  if (existing) {
    const body = braceBodyAt(state, existing.from, existing.to)
    if (body) {
      return [{ from: body.from, to: body.to, insert: value }]
    }
    return []
  }

  const indent = environmentIndent(state, figure)
  const insertAt = environmentEndStart(state, figure)
  const line = `\\${command}{${value}}`
  return [{ from: insertAt, to: insertAt, insert: `${indent}  ${line}\n` }]
}

/**
 * The minimal edits that apply `options` to `figure`.
 *
 * Returns an empty array when nothing needs to change, which is what keeps a
 * "re-apply the same options" round trip free of source churn.
 */
export function computeFigureEdits(
  state: EditorState,
  figure: FigureData,
  options: FigureEditOptions
): ChangeSpec[] {
  const edits: ChangeSpec[] = []

  if (options.width !== undefined && options.width > 0) {
    if (figure.width !== options.width) {
      edits.push(...widthEdit(state, figure, options.width))
    }
  }

  if (options.caption !== undefined) {
    const current = figure.caption
      ? readArgumentText(state, figure.caption)
      : null
    if (current !== options.caption) {
      edits.push(
        ...captionOrLabelEdit(
          state,
          figure,
          figure.caption,
          'caption',
          options.caption
        )
      )
    }
  }

  if (options.label !== undefined) {
    const current = figure.label ? readArgumentText(state, figure.label) : null
    if (current !== options.label) {
      edits.push(
        ...captionOrLabelEdit(state, figure, figure.label, 'label', options.label)
      )
    }
  }

  return edits
}

/** Reads the `{...}` body of a caption/label command range. */
export function readArgumentText(
  state: EditorState,
  range: { from: number; to: number }
): string {
  const body = braceBodyAt(state, range.from, range.to)
  return body ? state.doc.sliceString(body.from, body.to) : ''
}
