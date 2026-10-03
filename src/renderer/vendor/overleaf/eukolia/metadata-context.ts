/**
 * Eukolia substitution for Overleaf's editor metadata types
 * (`@/vendor/overleaf/eukolia/metadata-context`).
 *
 * Overleaf obtains labels, packages, commands and citation keys from a
 * server-side project-metadata endpoint. Eukolia derives the same shapes from
 * `projectIndex` and the editor scope (Instructions.md §29, §30).
 */

/**
 * A command discovered in one of the project's packages, as reported by
 * Overleaf's document-metadata service. Eukolia derives the same shape from
 * `projectIndex`.
 */
export interface Command {
  /** Human-readable name shown in the completion list. */
  caption: string
  /** Snippet inserted when the completion is accepted. */
  snippet: string
  /** Completion "type" shown next to the label. */
  meta: string
  score: number
}

export interface Metadata {
  labels: Set<string>
  packageNames: Set<string>
  commands: Command[]
  referenceKeys: Set<string>
  /** Local reference search; resolves to the matching bibliography entries. */
  searchLocalReferences: (query: string) => Promise<AdvancedReferenceSearchResult>
  fileTreeData: FolderData
}

export interface AdvancedReferenceSearchResult {
  keys: string[]
}

/** Minimal recursive folder shape used for `\input` completion. */
export interface FolderData {
  _id: string
  name: string
  docs: Array<{ _id: string; name: string }>
  folders: FolderData[]
  fileRefs: Array<{ _id: string; name: string }>
}
