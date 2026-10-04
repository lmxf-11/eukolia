/**
 * Eukolia — the `editor:insert-symbol` compatibility adapter.
 *
 * The ported Overleaf extension this replaces
 * (`vendor/overleaf/extensions/symbol-palette.ts`, now deleted) listened for
 * `editor:insert-symbol` on the *window* and inserted the event's raw code into
 * whatever selection its own view happened to hold. Three things were wrong with
 * that, and each is a defect `MathematicalSymbols.md` names:
 *
 *  * **It inserted raw code.** `\alpha` went in unwrapped wherever the caret
 *    was, so a symbol clicked in prose produced `\alpha` rather than
 *    `$\alpha$`. §8 requires the wrapper to depend on the context the caret is
 *    actually in.
 *  * **It was a broadcast.** The listener is on `window`, so every mounted
 *    editor would insert — invisible with one editor, and a doubled edit with
 *    two. §2 asks for one typed operation on the active editor handle instead.
 *  * **It had no context and no undo discipline.** No user-event annotation, no
 *    isolation from the previous edit's history group.
 *
 * Eukolia's own panel never used it — there is no dispatcher in `src` — so its
 * only callers would be ported Overleaf code that still dispatches the event.
 * The adapter therefore stays, mounted in the same place, and does the same job
 * *through* the new operation: resolve the command in the catalog, plan the
 * insertion against the view's real state, and apply it once.
 *
 * "Once" is enforced rather than hoped for: the event is marked handled with
 * `preventDefault()`, and a second listener that sees a handled event returns
 * without inserting.
 *
 * ## Why every import here is dynamic
 *
 * The adapter is mounted by `editorExtensions.ts`, which is part of the editor's
 * chunk — the chunk a window parses before it can show any document. Resolving a
 * command needs the generated catalog, which is a few thousand entries of JSON,
 * and importing it statically put 2.7 MB into that chunk for a code path nothing
 * in the application actually calls. The imports are therefore resolved on the
 * first event, which costs one `await` on a path that has no other caller and
 * keeps the catalog in the panel's own chunk.
 */

import { ViewPlugin } from '@codemirror/view'
import type { EditorView } from '@codemirror/view'

/** The event name the ported code dispatches. */
export const INSERT_SYMBOL_EVENT = 'editor:insert-symbol'

/** What the legacy event carries. */
interface InsertSymbolDetail {
  command?: string
}

/**
 * The extension.
 *
 * It reads the project snapshot at the moment of the event rather than holding
 * one, so a stale snapshot cannot decide what a later insertion does.
 */
export const mathSymbolInsertAdapter = () =>
  ViewPlugin.define((view: EditorView) => {
    const listener = (event: Event) => {
      // Already handled by another adapter: exactly one insert per event.
      if (event.defaultPrevented) return
      const detail = (event as CustomEvent<InsertSymbolDetail>).detail
      const command = detail?.command
      if (typeof command !== 'string' || command.length === 0) return
      event.preventDefault()
      void insertCommand(view, command)
    }
    window.addEventListener(INSERT_SYMBOL_EVENT, listener)
    return {
      destroy() {
        window.removeEventListener(INSERT_SYMBOL_EVENT, listener)
      }
    }
  })

/**
 * Inserts a command through the same path the panel uses.
 *
 * A catalog command is resolved against the project — so a legacy dispatch gets
 * the project's own spelling and its availability, not a guess. A command the
 * catalog does not know is inserted as raw code *with the context's wrapper*,
 * which is a strict improvement on the old behaviour and still refuses the
 * contexts §8 forbids.
 */
async function insertCommand(view: EditorView, command: string): Promise<void> {
  const [{ catalogVariantForCommand }, insert, { projectSymbolService }, resolve, aliases] =
    await Promise.all([
      import('../mathSymbols/catalog'),
      import('../mathSymbols/insertMathSymbol'),
      import('../mathSymbols/projectSymbolService'),
      import('../mathSymbols/resolveSymbol'),
      import('../mathSymbols/macroDefinition')
    ])

  const known = catalogVariantForCommand(command)
  let variant = known?.variant ?? null

  if (known) {
    const snapshot = projectSymbolService.getSnapshot()
    const entry = known.entry
    if (snapshot) {
      const aliasIndex = aliases.buildProjectAliasIndex(snapshot.macros)
      const candidate = resolve.bestCandidate(
        resolve.resolveCandidates({ entry, snapshot, aliases: aliasIndex, context: 'unknown' })
      )
      if (candidate) {
        const resolved = entry.variants.find((item) => item.id === candidate.variantId)
        if (resolved) variant = resolved
      }
    }
  } else {
    variant = insert.rawCommandVariant(command)
  }

  if (!variant) return
  const result = insert.planInsertion({
    entryId: known?.entry.id ?? command,
    variant,
    state: view.state,
    explanation: known ? 'inserted from the legacy symbol event' : 'this command is not in the catalog; inserted as written'
  })
  if (!result.ok) {
    // The legacy path has no surface to explain itself on, so it says so once
    // in the console rather than silently doing nothing.
    console.warn(`[eukolia] ${command} was not inserted: ${result.message}`)
    return
  }
  insert.applyInsertionPlan(result, view)
  view.focus()
}
