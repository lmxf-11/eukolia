/**
 * Types for the vendored `unified.js` bundle (unified-latex + latex-utensils +
 * prettier) from LaTeX Workshop's `resources/unified.js`.
 *
 * The bundle itself is unmodified JavaScript; only the shape of the three
 * exported functions is declared here.
 */

import type { AstRoot } from '../../types'

export interface UnifiedParserOptions {
  macros?: Record<string, { signature: string }>
  environments?: Record<string, { signature: string }>
  flags?: { autodetectExpl3AndAtLetter?: boolean }
}

export interface UnifiedParser {
  parse(source: string): AstRoot
}

export declare function getParser(options?: UnifiedParserOptions): UnifiedParser
export declare function attachMacroArgs(ast: AstRoot, macros: Record<string, { signature: string }>): void
export declare function toString(ast: unknown): string

declare const bundle: {
  getParser: typeof getParser
  attachMacroArgs: typeof attachMacroArgs
  toString: typeof toString
}
export default bundle
