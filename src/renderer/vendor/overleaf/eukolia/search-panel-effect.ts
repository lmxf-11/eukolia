/**
 * The `togglePanel` state effect that Overleaf's patched `@codemirror/search`
 * exports and that `extensions/search.ts` watches to clear its stored
 * selection when the search panel closes.
 *
 * Eukolia declares the effect here and dispatches it from the search panel's
 * own key bindings, so the ported stored-selection field keeps its behaviour.
 */
import { StateEffect } from '@codemirror/state'

export const togglePanel = StateEffect.define<boolean>()
