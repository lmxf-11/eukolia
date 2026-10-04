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
  }).then(MathJax => {
    /*
     * The instance, published once for the scroll probe.
     *
     * `scripts/probe-scroll.mjs` has to answer "how much of a stuttering frame is
     * MathJax?", and a count of cache misses cannot: a miss may be a 2 ms render or a
     * 40 ms one, and the difference is the whole question on a document where a warm
     * scroll still misses. Timing `tex2svgPromise` is the only way to find out, and this
     * is where every rendering in the application passes — the same reason the render
     * cache publishes its counters.
     *
     * One assignment per load, and the loader is idempotent, so this runs once.
     */
    ;(globalThis as unknown as { __eukoliaMathJax?: unknown }).__eukoliaMathJax = MathJax
    return MathJax
  })
