/**
 * Eukolia substitution for Overleaf's `@/vendor/overleaf/eukolia/grammarly`.
 *
 * Overleaf disables its own spelling UI when the Grammarly browser extension is
 * present. Eukolia is an Electron application and never runs browser
 * extensions, so the answer is always "not present" — which is a fact about the
 * host, not a stub.
 */
export function isGrammarlyInstalled(): boolean {
  return false
}
