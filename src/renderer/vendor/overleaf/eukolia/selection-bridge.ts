/**
 * A one-way bridge from the ported editor back to the Eukolia host.
 *
 * Overleaf's `hooks/use-included-file.ts` and command tooltips open *other*
 * files, which is the host application's job. The ported code announces the
 * request on this bridge and the Visual Editor host forwards it to the
 * application shell; nothing here reaches the filesystem itself.
 */
export interface EditorNavigationRequest {
  /** Absolute path of the file to open. */
  filePath: string
  /** Character offset to reveal, relative to the start of the file. */
  offset?: number
}

export type EditorNavigationListener = (request: EditorNavigationRequest) => void

const listeners = new Set<EditorNavigationListener>()

/** Called by the ported editor. */
export function setEditorSelection(request: EditorNavigationRequest): void {
  for (const listener of listeners) listener(request)
}

/** Installed by the Visual Editor host. Returns an unsubscribe function. */
export function onEditorNavigation(
  listener: EditorNavigationListener
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
