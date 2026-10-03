/**
 * Eukolia substitution for Overleaf's project `Folder` tree type.
 *
 * Overleaf's version carries Mongo ids and separate `docs` / `fileRefs`
 * collections. Eukolia's project is a plain directory tree, which is what the
 * editor's completion and file pickers actually consume.
 */
export interface Doc {
  _id: string
  name: string
}

export interface FileRef {
  _id: string
  name: string
}

export interface Folder {
  _id: string
  name: string
  docs: Doc[]
  folders: Folder[]
  fileRefs: FileRef[]
}
