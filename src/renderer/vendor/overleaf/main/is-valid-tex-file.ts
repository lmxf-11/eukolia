/**
 * Eukolia substitution for Overleaf's `main/is-valid-tex-file`.
 *
 * Overleaf reads the valid root-document extensions from server settings;
 * Eukolia's are fixed, and `utils/visual-editor.ts` is the only consumer.
 */
export const EUKOLIA_TEX_EXTENSIONS = ['tex', 'ltx'] as const

export const isValidTeXFile = (filename: string): boolean =>
  new RegExp(`\\.(${EUKOLIA_TEX_EXTENSIONS.join('|')})$`, 'i').test(filename)
