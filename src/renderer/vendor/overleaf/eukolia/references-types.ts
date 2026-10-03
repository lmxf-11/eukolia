/**
 * Eukolia substitution for
 * `@/vendor/overleaf/eukolia/references-types`.
 */
export interface AdvancedReferenceSearchResult {
  keys: string[]
  /** Total number of matches, when the backend reported one. */
  total?: number
}
