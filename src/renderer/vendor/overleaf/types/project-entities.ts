/**
 * Eukolia substitution for Overleaf's `@/vendor/overleaf/types/project-entities`
 * and `use-project-output-files` types, which `utils/file.ts` narrows against.
 *
 * Eukolia's project is a plain directory tree, so an entity is a file or a
 * folder with a path.
 */
export interface Entity {
  path: string
  name: string
  type: 'file' | 'doc' | 'folder'
}

export interface OutputEntity {
  path: string
  name: string
}
