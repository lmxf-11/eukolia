/**
 * Eukolia substitution for Overleaf's outline context
 * (`@/vendor/overleaf/eukolia/outline-context`).
 *
 * `utils/tree-operations/outline.ts` only consumes the `PartialFlatOutline`
 * shape, which is reproduced here; the React side lives in the Eukolia host.
 */
import type { FlatOutlineItem } from '../utils/tree-operations/outline'

export type PartialFlatOutline = FlatOutlineItem[]

/** Minimal outline item shape used by `nestOutline`. */
export interface OutlineItemLike {
  title: string
  line: number
  level: number
}
