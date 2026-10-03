import { Prec } from '@codemirror/state'
import { keymap, type Command } from '@codemirror/view'
import { toggleRanges } from '../../commands/ranges'

/**
 * Eukolia divergence from the reference: the formatting shortcuts need a
 * selection.
 *
 * `Ctrl+B` and `Ctrl+I` are bound three times over in this application — by the
 * shell's command registry to Toggle Sidebar and Build Project, and here, with
 * `Prec.high`, to `\textbf` and `\textit`. High precedence means the editor wins
 * wherever it is focused, so the shell's bindings were unreachable with the caret
 * in the document, which is where a reader's caret almost always is.
 *
 * The reference has no need to care: in Overleaf `Ctrl+B` means bold and nothing
 * else. Here it is also the sidebar, and the two can be told apart by what the
 * user has done rather than by which key they pressed — with text highlighted,
 * `\textbf{}` is unambiguous and is what a reader means; with only a caret, the
 * command has nothing to act on, and the reference's own `toggleRanges` would wrap
 * the *empty* selection in `\textbf{}`, leaving the caret inside empty braces. So
 * the formatting commands decline when there is nothing selected, and the
 * keybinding falls through to whatever the shell bound to the same key.
 *
 * `return false` is how a CodeMirror keymap handler declines: the next binding for
 * the key is tried, and if none accepts it the event is not prevented, so the
 * shell's own capture-phase listener still sees it.
 */
const needsSelection =
  (command: Command): Command =>
  view =>
    view.state.selection.ranges.some(range => !range.empty) && command(view)

export const shortcuts = () => {
  return Prec.high(
    keymap.of([
      {
        key: 'Ctrl-b',
        mac: 'Mod-b',
        preventDefault: true,
        run: needsSelection(toggleRanges('\\textbf')),
      },
      {
        key: 'Ctrl-i',
        mac: 'Mod-i',
        preventDefault: true,
        run: needsSelection(toggleRanges('\\textit')),
      },
    ])
  )
}
