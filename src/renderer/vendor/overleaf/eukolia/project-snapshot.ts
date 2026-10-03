/**
 * Eukolia substitution for Overleaf's `@/vendor/overleaf/eukolia/project-snapshot`.
 *
 * Overleaf's command-definition indexer receives a server-generated snapshot of
 * every file in the project. Eukolia builds the equivalent view from the
 * project file list plus the editor's own text accessor, through
 * `EukoliaEditorScope` and `projectIndex`.
 */

export interface ProjectSnapshotFile {
  path: string
  content: string
}

export interface ProjectSnapshot {
  files: ProjectSnapshotFile[]
  /** Path of the root document, when known. */
  rootDocPath?: string | null
}
