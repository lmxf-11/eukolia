/**
 * Eukolia — alignment while typing (Instructions.md §14).
 *
 * The third of the three alignment entry points §14 asks for: on demand (the
 * editor command and the `alignAmpersands` handle), on save, and *while typing*.
 * The Monaco host owned this before the editors were unified onto CodeMirror;
 * this is the same behaviour over the one editor:
 *
 *  * every content change re-arms a timer of `formatting.alignWhileTypingDelayMs`,
 *    so a burst of typing produces one pass rather than one per keystroke;
 *  * the pass aligns the environment the caret is inside
 *    (`formattingEngine.alignAt`), which is what makes it "while typing" rather
 *    than "the whole document on every keypress";
 *  * both settings are read when the timer fires, not when the editor is built,
 *    so switching the feature on or off takes effect on the next keystroke.
 *
 * A pass that changes nothing dispatches nothing, and the dispatch itself does
 * not re-arm the timer, so the plugin cannot feed itself.
 */

import type { Extension } from '@codemirror/state'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'

import { formattingEngine } from '../aligner/texAligner'
import { setting } from '../core/settings'

/**
 * The align-while-typing plugin.
 *
 * Mounted for both modes: there is one editor, and the setting is a formatting
 * behaviour of it rather than of a mode. In Visual Mode the environments this
 * touches are the ones rendered as source, which is exactly where alignment is
 * visible.
 */
export const alignWhileTyping = (): Extension =>
  ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null
      /** True while this plugin's own dispatch is being applied. */
      private applying = false
      private destroyed = false

      constructor(private readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        if (!update.docChanged || this.applying) return
        this.schedule()
      }

      destroy(): void {
        this.destroyed = true
        this.cancel()
      }

      private cancel(): void {
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
      }

      /** Re-arms the delay; a newer keystroke always wins, so nothing queues up. */
      private schedule(): void {
        this.cancel()
        if (!setting.bool('formatting.alignWhileTyping')) return

        this.timer = setTimeout(() => {
          this.timer = null
          this.run()
        }, Math.max(0, setting.num('formatting.alignWhileTypingDelayMs')))
      }

      private run(): void {
        if (this.destroyed) return
        // Read again: the setting may have been switched off while the timer ran.
        if (!setting.bool('formatting.alignWhileTyping')) return

        const { state } = this.view
        const offset = state.selection.main.head
        const edits = formattingEngine.alignAt(state.doc.toString(), offset)
        if (edits.length === 0) return

        this.applying = true
        try {
          this.view.dispatch({
            // CodeMirror requires changes in ascending order. The aligner emits
            // them in closing order, which for disjoint environments is
            // ascending; sorted here so the contract does not depend on that.
            changes: edits
              .map((edit) => ({
                from: edit.start,
                to: edit.end,
                insert: edit.newText,
              }))
              .sort((a, b) => a.from - b.from),
          })
        } finally {
          this.applying = false
        }
      }
    }
  )
