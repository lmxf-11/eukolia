import { EditorView } from '@codemirror/view'
import { EditorSelection, EditorState, StateCommand } from '@codemirror/state'
import { SearchQuery, SearchCursor } from '@codemirror/search'

export { selectNextOccurrence } from '@codemirror/search'

// Overleaf's @codemirror/search fork exposes StringQuery#prevMatch and a
// selectWord command. Eukolia uses the published package, so the equivalent
// is expressed with SearchCursor, which is the API the fork's helpers wrap.
const findPrevOccurence = (state: EditorState, search: string) => {
  const searchQuery = new SearchQuery({ search, literal: true })
  const { from } = state.selection.main

  const matches: { from: number; to: number }[] = []
  const cursor = searchQuery.getCursor(state, 0, from)
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    matches.push({ from: next.value.from, to: next.value.to })
  }
  return matches.length ? matches[matches.length - 1] : undefined
}

/** Selects the word under the cursor, standing in for Overleaf's selectWord. */
const selectWordAtCursor = (state: EditorState) => {
  const range = state.selection.main
  const line = state.doc.lineAt(range.head)
  const text = line.text
  const offset = range.head - line.from
  const isWord = (char: string) => /[\p{L}\p{N}_]/u.test(char)
  let from = offset
  let to = offset
  while (from > 0 && isWord(text[from - 1])) from -= 1
  while (to < text.length && isWord(text[to])) to += 1
  if (from === to) return null
  return { from: line.from + from, to: line.from + to }
}

export const selectPrevOccurrence: StateCommand = ({ state, dispatch }) => {
  const { ranges } = state.selection

  if (ranges.some(range => range.from === range.to)) {
    const word = selectWordAtCursor(state)
    if (!word) return false
    dispatch(
      state.update({ selection: EditorSelection.single(word.from, word.to) })
    )
    return true
  }

  const searchedText = state.sliceDoc(ranges[0].from, ranges[0].to)

  if (
    state.selection.ranges.some(
      range => state.sliceDoc(range.from, range.to) !== searchedText
    )
  ) {
    return false
  }

  const range = findPrevOccurence(state, searchedText)
  if (!range) {
    return false
  }

  dispatch(
    state.update({
      selection: state.selection.addRange(
        EditorSelection.range(range.from, range.to)
      ),
      effects: EditorView.scrollIntoView(range.to),
    })
  )

  return true
}
