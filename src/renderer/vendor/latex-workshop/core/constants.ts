/**
 * Eukolia — LaTeX Workshop port: constants.
 *
 * Ported from `lw.constant` of `out/src/lw.js` and the extension constants of
 * `out/src/compile/constants.js`.
 */

export const TEX_EXT = ['.tex', '.bib', '.ltx']
export const TEX_NOCACHE_EXT = ['.cls', '.sty', '.bst', '.bbx', '.cbx', '.def', '.cfg']
/** Files that are roots simply because they are the active document. */
export const ACTIVE_ROOTFILE_EXT = ['.dtx', '.ltx']
export const FILE_URI_SCHEMES = ['file', 'vsls']
export const PWEAVE_EXT = ['.pnw']
export const JLWEAVE_EXT = ['.jnw']
export const RSWEAVE_EXT = ['.rnw', '.Rnw', '.Rtex', '.rnw.tex']

/** `out/src/compile/constants.js` */
export const TEX_MAGIC_PROGRAM_NAME = 'TEX_MAGIC_PROGRAM_NAME'
export const BIB_MAGIC_PROGRAM_NAME = 'BIB_MAGIC_PROGRAM_NAME'
export const MAGIC_PROGRAM_ARGS_SUFFIX = '_WITH_ARGS'
export const MAX_PRINT_LINE = '10000'

/** `hasLaTeXLangId` of `out/src/core/file.js`. */
export function hasLaTeXLangId(langId: string): boolean {
  return ['latex', 'context', 'latex-expl3', 'pweave', 'jlweave', 'rsweave', 'doctex'].includes(langId)
}

/** `hasLaTeXClassPackageLangId` of `out/src/core/file.js`. */
export function hasLaTeXClassPackageLangId(langId: string): boolean {
  return ['latex-class', 'latex-package'].includes(langId)
}

/** `hasAlwaysRootExt` of `out/src/core/file.js`. */
export function hasAlwaysRootExt(extname: string): boolean {
  return ACTIVE_ROOTFILE_EXT.includes(extname)
}

/** `getLangId` of `out/src/core/file.js` (extension based, no VS Code needed). */
export function getLangId(filename: string): string | undefined {
  const ext = filename.slice(filename.lastIndexOf('.')).toLocaleLowerCase()
  if (TEX_EXT.includes(ext)) return 'latex'
  if (PWEAVE_EXT.includes(ext)) return 'pweave'
  if (JLWEAVE_EXT.includes(ext)) return 'jlweave'
  if (RSWEAVE_EXT.includes(ext)) return 'rsweave'
  if (ext === '.dtx') return 'doctex'
  return undefined
}
