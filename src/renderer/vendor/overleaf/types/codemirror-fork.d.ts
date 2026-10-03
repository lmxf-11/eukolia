/**
 * Module augmentation for the two Overleaf forks of `@codemirror` packages.
 *
 * The ported source-editor code sets `extend` on completions and `buildInsert`
 * on the close-bracket configuration. Both are features of Overleaf's patched
 * packages rather than of the published ones. The declarations live here so the
 * ported call sites are type-checked as written; the runtime behaviour is
 * supplied by `eukolia/codemirror-compat.ts` (for `extend`) and recorded as
 * inert for `buildInsert`.
 *
 * `extend` and `buildInsert` are declared with *method* syntax on purpose:
 * TypeScript checks method parameters bivariantly, which is what lets the
 * narrower `{ from, to }` hooks (`extendOverUnpairedClosingBrace`) and the wider
 * `{ from, to, insert }` hooks (`extendRequiredParameter`) both satisfy a single
 * declaration — the same latitude Overleaf's own typings have.
 */
import type { EditorState, SelectionRange } from '@codemirror/state'

declare module '@codemirror/autocomplete' {
  interface Completion {
    /**
     * Adjusts the replaced range before `apply` runs. Provided by Overleaf's
     * `@codemirror/autocomplete` fork; `withCompletionExtend` applies it here.
     */
    extend?(
      state: EditorState,
      change: { from: number; to: number }
    ): { from: number; to: number }

    /**
     * Marks a completion as a duplicate of an earlier completion with the same
     * label, so the completion source can drop it. Overleaf's fork accepts
     * either a boolean or a descriptor used for analytics. Also from the fork.
     */
    deduplicate?:
      | boolean
      | { key: string; priority: number }
  }

  interface CloseBracketConfig {
    /**
     * Per-bracket insertion builder. Only Overleaf's fork's `closeBrackets`
     * command consults it; see `close-bracket-config.ts`.
     */
    buildInsert?(
      state: EditorState,
      range: SelectionRange,
      open: string,
      close: string
    ): string
  }
}
