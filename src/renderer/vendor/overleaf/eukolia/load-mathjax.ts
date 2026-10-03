/**
 * Eukolia substitution for Overleaf's `@/vendor/overleaf/eukolia/load-mathjax`.
 *
 * Overleaf's version injects a MathJax bundle served by the Overleaf web
 * application and resolves to `window.MathJax`. Eukolia typesets locally with
 * MathJax 4.1.3 through the project's single maths service, so this module is a
 * thin adapter that presents that service through the surface the ported visual
 * widgets call. Keeping the same exported name (`loadMathJax`) and the same
 * resolved shape means the ported widget code needs no changes.
 */

import {
  createMathJaxTypesetter,
  type MathJaxLike,
  type MathJaxTypesetterOptions,
} from '@/visual/mathjax-typesetter'

export type { MathJaxLike }

export interface LoadMathJaxOptions extends MathJaxTypesetterOptions {
  /** Accepted for parity with Overleaf's loader; the menu is always disabled. */
  enableMenu?: boolean
  /** Accepted for parity with Overleaf's loader. */
  useLabelIds?: boolean
}

/**
 * Returns a promise of the local MathJax instance. Idempotent: repeated calls
 * share one load, exactly like the reference implementation.
 */
export const loadMathJax = (
  options: LoadMathJaxOptions = {}
): Promise<MathJaxLike> =>
  createMathJaxTypesetter({
    singleDollar: options.singleDollar,
    numbering: options.numbering,
  })
