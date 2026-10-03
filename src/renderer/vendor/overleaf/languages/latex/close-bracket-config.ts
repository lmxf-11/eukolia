import {
  CharCategory,
  EditorState,
  SelectionRange,
  Text,
} from '@codemirror/state'
import { CloseBracketConfig } from '@codemirror/autocomplete'
import { nextChar, prevChar } from '@/vendor/overleaf/eukolia/codemirror-compat'
import { setting } from '@core/settings'

/**
 * Resolves the currently active brackets for auto-closing based on user settings.
 * Returns an array of bracket tokens that should automatically insert their closing counterpart.
 */
export function getActiveCloseBrackets(): string[] {
  try {
    if (!setting.bool('editor.smartDelimiters')) {
      return []
    }
    const brackets: string[] = []
    if (setting.bool('editor.autoCloseDollarSigns')) {
      brackets.push('$', '$$')
    }
    if (setting.bool('editor.autoCloseSquareBrackets')) {
      brackets.push('[')
    }
    if (setting.bool('editor.autoCloseCurlyBraces')) {
      brackets.push('{')
    }
    if (setting.bool('editor.autoCloseParentheses')) {
      brackets.push('(')
    }
    if (setting.bool('editor.autoCloseQuotes')) {
      brackets.push('"', "'")
    }
    return brackets
  } catch {
    return ['$', '$$', '[', '{', '(']
  }
}

/**
 * NOTE: Overleaf's patched @codemirror/autocomplete consults `buildInsert`,
 * which lets the editor decide the closing text per bracket (for example never
 * auto-closing before a TeX command). The published package's
 * `closeBrackets` command only reads `brackets` and `before`, so the
 * `buildInsert` implementation below is preserved but is not invoked; plain
 * bracket pairing still works.
 */
export const closeBracketConfig: CloseBracketConfig & {
  buildInsert?: (
    state: EditorState,
    range: SelectionRange,
    open: string,
    close: string
  ) => string
} = {
  get brackets() {
    return getActiveCloseBrackets()
  },
  buildInsert(
    state: EditorState,
    range: SelectionRange,
    open: string,
    close: string
  ): string {
    switch (open) {
      // close for $ or $$
      case '$': {
        const prev = prevChar(state.doc, range.head)
        if (prev === '\\') {
          const preprev = prevChar(state.doc, range.head - prev.length)
          // add an unprefixed closing dollar to \\$
          if (preprev === '\\') {
            return open + '$'
          }
          // don't auto-close \$
          return open
        }

        const next = nextChar(state.doc, range.head)
        if (next === '\\') {
          // avoid auto-closing $ before a TeX command
          const pos = range.head + prev.length
          const postnext = nextChar(state.doc, pos)

          if (state.charCategorizer(pos)(postnext) !== CharCategory.Word) {
            return open + '$'
          }

          // don't auto-close $\command
          return open
        }

        // avoid creating an odd number of dollar signs
        const count = countSurroundingCharacters(state.doc, range.from, open)
        if (count % 2 !== 0) {
          return open
        }
        return open + close
      }

      // close for [ or \[
      case '[': {
        const prev = prevChar(state.doc, range.head)
        if (prev === '\\') {
          const preprev = prevChar(state.doc, range.head - prev.length)
          // add an unprefixed closing bracket to \\[
          if (preprev === '\\') {
            return open + ']'
          }
          return open + '\\' + close
        }
        return open + close
      }

      // only close for \(
      case '(': {
        const prev = prevChar(state.doc, range.head)
        if (prev === '\\') {
          const preprev = prevChar(state.doc, range.head - prev.length)
          // don't auto-close \\(
          if (preprev === '\\') {
            return open
          }
          return open + '\\' + close
        }
        return open
      }

      // only close for {
      case '{': {
        const prev = prevChar(state.doc, range.head)
        if (prev === '\\') {
          const preprev = prevChar(state.doc, range.head - prev.length)
          // add an unprefixed closing bracket to \\{
          if (preprev === '\\') {
            return open + '}'
          }
          // don't auto-close \{
          return open
        }
        return open + close
      }

      default:
        return open + close
    }
  },
}

function countSurroundingCharacters(doc: Text, pos: number, insert: string) {
  let count = 0
  // count backwards
  let to = pos
  do {
    const char = doc.sliceString(to - insert.length, to)
    if (char !== insert) {
      break
    }
    count++
    to--
  } while (to > 1)
  // count forwards
  let from = pos
  do {
    const char = doc.sliceString(from, from + insert.length)
    if (char !== insert) {
      break
    }
    count++
    from++
  } while (from < doc.length)
  return count
}
