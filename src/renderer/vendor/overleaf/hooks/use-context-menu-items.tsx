/**
 * Eukolia substitution for Overleaf's `use-context-menu-items` hook.
 *
 * Overleaf builds the editor context menu from its collaborative-editing
 * contexts (track changes, comments, review panel). Eukolia's editor is a local
 * single-user surface, so this builds the same menu shape from the CodeMirror
 * view plus the Eukolia clipboard and selection commands.
 *
 * The returned shape (`menuItems`, `closeMenu`, `onToggle`) matches what
 * `components/editor-context-menu.tsx` renders.
 */
import { useCallback } from 'react'
import {
  redo,
  undo,
  selectAll,
  copyLineDown,
  deleteLine,
  cursorCharLeft,
} from '@codemirror/commands'
import { EditorSelection, type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { copySelection, cutSelection } from '../commands/clipboard'
import { closeAllContextMenusEffect } from '../utils/close-all-context-menus-effect'
import {
  useCodeMirrorStateContext,
  useCodeMirrorViewContext,
} from '../components/codemirror-context'

export interface ContextMenuItem {
  label: string
  handler: () => void
  shortcut?: string
  disabled?: boolean
  separatorAbove?: boolean
}

export interface UseContextMenuItemsResult {
  menuItems: ContextMenuItem[]
  closeMenu: () => void
  onToggle: (open: boolean) => void
}

const isMac =
  typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? '')

const mod = (key: string) => (isMac ? `\u2318${key}` : `Ctrl-${key}`)

/** The word under the cursor, or null when there is no word. */
const wordAtCursor = (state: EditorState): { from: number; to: number } | null => {
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

export function useContextMenuItems(): UseContextMenuItemsResult {
  const state = useCodeMirrorStateContext()
  const view: EditorView = useCodeMirrorViewContext()

  const closeMenu = useCallback(() => {
    view.dispatch({ effects: closeAllContextMenusEffect.of(null) })
  }, [view])

  const onToggle = useCallback(
    (open: boolean) => {
      if (!open) closeMenu()
    },
    [closeMenu]
  )

  const hasSelection = state.selection.ranges.some(range => !range.empty)
  const word = wordAtCursor(state)

  const menuItems: ContextMenuItem[] = [
    {
      label: 'Cut',
      shortcut: mod('X'),
      disabled: !hasSelection,
      handler: () => cutSelection(view),
    },
    {
      label: 'Copy',
      shortcut: mod('C'),
      disabled: !hasSelection,
      handler: () => copySelection(view),
    },
    {
      label: 'Paste',
      shortcut: mod('V'),
      // The clipboard read is asynchronous and permission-gated; the command is
      // dispatched when the browser grants access.
      handler: () => {
        void (async () => {
          const text = await navigator.clipboard?.readText?.()
          if (typeof text === 'string') {
            view.dispatch(view.state.replaceSelection(text))
          }
        })()
      },
    },
    {
      label: 'Select all',
      shortcut: mod('A'),
      separatorAbove: true,
      handler: () => {
        selectAll(view)
      },
    },
    {
      label: 'Select word',
      disabled: !word,
      handler: () => {
        if (word) {
          view.dispatch({
            selection: EditorSelection.single(word.from, word.to),
          })
        }
      },
    },
    {
      label: 'Duplicate line',
      shortcut: mod('D'),
      separatorAbove: true,
      handler: () => {
        copyLineDown(view)
      },
    },
    {
      label: 'Delete line',
      handler: () => {
        deleteLine(view)
      },
    },
    {
      label: 'Move cursor left',
      handler: () => {
        cursorCharLeft(view)
      },
    },
    {
      label: 'Undo',
      shortcut: mod('Z'),
      separatorAbove: true,
      handler: () => {
        undo(view)
      },
    },
    {
      label: 'Redo',
      shortcut: isMac ? '\u21E7\u2318Z' : 'Ctrl-Y',
      handler: () => {
        redo(view)
      },
    },
  ]

  return { menuItems, closeMenu, onToggle }
}
