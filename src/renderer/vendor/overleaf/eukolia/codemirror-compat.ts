/**
 * Eukolia compatibility layer for the two `@codemirror` features Overleaf's
 * fork of the packages provides on top of the published ones.
 *
 * Overleaf maintains small patches to `@codemirror/autocomplete` and
 * `@codemirror/search` that the ported source-editor code relies on:
 *
 *  * `nextChar(doc, pos)` / `prevChar(doc, pos)` helpers;
 *  * `CloseBracketConfig.buildInsert`, a per-bracket insertion builder;
 *  * `Completion.extend`, a hook that adjusts the replaced range before
 *    `apply` runs.
 *
 * Eukolia installs the published packages, so this module supplies the helpers
 * and applies `Completion.extend` itself. The one part that cannot be
 * reproduced is `buildInsert`, which only the fork's `closeBrackets` command
 * consults; it stays declared so the ported configuration is unchanged, and the
 * fact that it is inert is recorded with `close-bracket-config.ts`.
 */

import type { EditorState, Text } from '@codemirror/state'
import type { Completion, CompletionSource } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff

/**
 * The character immediately after `pos`, `'\n'` when `pos` is at the end of a
 * line and `''` at the end of the document. Astral characters are returned
 * whole.
 */
export function nextChar(doc: Text, pos: number): string {
  const line = doc.lineAt(pos)
  if (pos >= line.to) {
    return pos >= doc.length ? '' : '\n'
  }
  const first = doc.sliceString(pos, pos + 1)
  if (isHighSurrogate(first.charCodeAt(0)) && pos + 1 < line.to) {
    return first + doc.sliceString(pos + 1, pos + 2)
  }
  return first
}

/**
 * The character immediately before `pos`, `'\n'` when `pos` is at the start of
 * a line and `''` at the start of the document. Astral characters are returned
 * whole.
 */
export function prevChar(doc: Text, pos: number): string {
  const line = doc.lineAt(pos)
  if (pos <= line.from) {
    return pos <= 0 ? '' : '\n'
  }
  const last = doc.sliceString(pos - 1, pos)
  const code = last.charCodeAt(0)
  if (code >= 0xdc00 && code <= 0xdfff && pos - 2 >= line.from) {
    return doc.sliceString(pos - 2, pos)
  }
  return last
}

/** The shape Overleaf's fork attaches to `Completion`. */
export type CompletionExtend = (
  state: EditorState,
  change: { from: number; to: number }
) => { from: number; to: number }

export interface ExtendedCompletion extends Completion {
  extend?: CompletionExtend
}

/**
 * Applies a completion's `extend` hook, mirroring what Overleaf's patched
 * `@codemirror/autocomplete` does before it calls `apply`.
 */
const withExtendHook = (completion: ExtendedCompletion): Completion => {
  const extend = completion.extend
  if (!extend) return completion

  return {
    ...completion,
    apply(view: EditorView, accepted: Completion, from: number, to: number) {
      const apply = completion.apply
      const requested = typeof apply === 'string' ? apply : completion.label
      // Overleaf's fork hands the hook the change that is about to be applied,
      // so hooks such as `extendRequiredParameter` can add a closing brace.
      const change: { from: number; to: number; insert: string } = {
        from,
        to,
        insert: requested,
      }
      extend(view.state, change)

      if (typeof apply === 'function') {
        return apply(view, accepted, change.from, change.to)
      }

      view.dispatch({
        changes: { from: change.from, to: change.to, insert: change.insert },
        selection: { anchor: change.from + change.insert.length },
        userEvent: 'input.complete',
      })
      return null
    },
  }
}

/**
 * Wraps a completion source so every completion it returns honours the two
 * hooks Overleaf's `@codemirror/autocomplete` fork adds:
 *
 *  * `extend` — adjust the replaced range before `apply` runs;
 *  * `deduplicate` — drop this entry when an earlier entry has the same label.
 *
 * The LaTeX language registers its sources through this wrapper, so no
 * individual completion definition had to be changed.
 */
export const withCompletionExtend =
  (source: CompletionSource): CompletionSource =>
  async context => {
    const result = await source(context)
    if (!result) return result

    const seen = new Set<string>()
    const options: Completion[] = []
    for (const completion of result.options) {
      const extended = completion as ExtendedCompletion
      if (extended.deduplicate) {
        const key = `${extended.label}\u0000${extended.detail ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
      }
      options.push(withExtendHook(extended))
    }

    return { ...result, options }
  }
