/**
 * Eukolia Visual Mode scope.
 *
 * The visual editor reaches out to its surrounding application for everything
 * that is not the document text itself: the project file tree (for `\input`,
 * `\includegraphics` and graphics resolution), the file's folder, image
 * preview URLs, the macro/symbol tables, editor phrases, and the compiler.
 *
 * Eukolia provides a single explicit interface — `EukoliaEditorScope` — so that
 * the editor code never touches a global and never touches the filesystem.
 * Everything the editor needs is either in the scope or is not available at all.
 *
 * Instructions.md §17, §18, §27, §29, §30, §69.
 */

/**
 * A minimal, source-preserving edit (Instructions.md §27).
 *
 * Deliberately narrower than CodeMirror's own `ChangeSpec`: Eukolia's scopes
 * accept exactly one range replacement, so a scope can never be asked to
 * regenerate unrelated source.
 */
export interface ChangeSpec {
  from: number
  to: number
  insert: string
}

export interface ProjectFileEntry {
  /** Path relative to the project root, using `/` separators. */
  path: string
  name: string
  isDirectory: boolean
}

export interface ProjectFolder {
  name: string
  /** Path relative to the project root, `''` for the root itself. */
  path: string
  folders: ProjectFolder[]
  files: ProjectFileEntry[]
}

export interface ImageMetadata {
  /** A URL the editor can load: `data:`, `blob:`, `file:` or `http(s):`. */
  url: string
  /** Lower-case extension without the dot, e.g. `png`, `pdf`, `svg`. */
  extension: string
  width?: number
  height?: number
}

export interface PdfFigureRenderRequest {
  url: string
  canvas: HTMLCanvasElement
  /** Target width in CSS pixels. */
  width: number
}

export interface ScopeSymbols {
  /** Label names defined in the project. */
  labels: string[]
  /** Citation keys available from the project's bibliographies. */
  citationKeys: string[]
  /** Environment names in use, plus the built-in set. */
  environments: string[]
  /** `\input`/`\include` targets. */
  includedFiles: string[]
}

export interface EukoliaEditorScope {
  /** Stable id, used as a compartment/storage key. */
  readonly id: string

  // ------------------------------------------------------------- the document
  /** Absolute path of the file being edited, or null for an untitled buffer. */
  getFilePath(): string | null
  /** Display name of the file being edited, or null. */
  getFileName(): string | null
  /** Current full source text. */
  getText(): string
  /** Monotonic version of the text, used to detect stale reads. */
  getVersion(): number
  /**
   * Apply a minimal change. Implementations must apply exactly the requested
   * range replacement and nothing else: no reformatting, no normalisation.
   */
  applyChange(change: ChangeSpec): void

  // -------------------------------------------------------------- the project
  /** Absolute project root, or null when no project is open. */
  getProjectRoot(): string | null
  /** Folder of the current file relative to the root (`''` at the root). */
  getDocFolder(): string | null
  getProjectFiles(): ProjectFileEntry[]
  /** Nested view of the project, for the figure file picker. */
  getProjectFolders(): ProjectFolder[]
  /** Notified when the project file list changes. Returns an unsubscribe fn. */
  onProjectFilesChange(listener: () => void): () => void

  // -------------------------------------------------------------- resolution
  /**
   * Metadata for an image referenced by `\includegraphics`, resolved relative
   * to the document folder and then to the project root. Returns null when the
   * file does not exist, which is what makes the graphics widget fall back to
   * showing the source path (Instructions.md §24).
   */
  getImageMetadata(path: string): ImageMetadata | null
  /**
   * Optional: render page 1 of a PDF figure into a canvas. Eukolia's PDF
   * engine lives in the main process, so a scope without this capability shows
   * the "cannot preview" state instead of a blank canvas.
   */
  renderPdfFigurePage?(request: PdfFigureRenderRequest): Promise<void>

  // ---------------------------------------------------------------- language
  /** Macro name (with `\`) -> definition body, for MathJax preambles. */
  getMacroTable(): Record<string, string>
  /** Symbols used by completion and by the outline. */
  getSymbols(): ScopeSymbols
  /** Editor phrases for `EditorState.phrases` (Overleaf i18n keys). */
  getPhrases(): Record<string, string>

  // ------------------------------------------------------------------- host
  /** Request a compile. */
  requestCompile?(trigger: 'keypress' | 'save' | 'manual'): void
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

let currentScope: EukoliaEditorScope | null = null

/** Installed by the host before the editor is created. */
export function setEditorScope(scope: EukoliaEditorScope | null): void {
  currentScope = scope
}

/** The active scope, or null when no editor is mounted. */
export function getEditorScope(): EukoliaEditorScope | null {
  return currentScope
}

/** The active scope, throwing when the host forgot to install one. */
export function requireEditorScope(): EukoliaEditorScope {
  if (!currentScope) {
    throw new Error('No Eukolia editor scope is installed')
  }
  return currentScope
}

/* ------------------------------------------------------------------ *
 * In-memory implementation
 * ------------------------------------------------------------------ */

export interface InMemoryScopeOptions {
  id?: string
  filePath?: string | null
  text?: string
  projectRoot?: string | null
  files?: Array<{ path: string; isDirectory?: boolean }>
  images?: Record<string, ImageMetadata>
  macroTable?: Record<string, string>
  symbols?: Partial<ScopeSymbols>
  phrases?: Record<string, string>
  onCompile?: (trigger: 'keypress' | 'save' | 'manual') => void
  /** Observes edits, in addition to updating the stored text. */
  onChange?: (text: string) => void
  /**
   * Rasterises page 1 of a PDF figure. The host supplies this from Eukolia's
   * native engine; without it the ported graphics widget shows its
   * "cannot preview this file" state rather than an empty canvas.
   */
  renderPdfFigurePage?: (request: PdfFigureRenderRequest) => Promise<void>
}

const joinPath = (a: string, b: string): string =>
  `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`

const dirnameOf = (path: string): string => {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '' : path.slice(0, index)
}

const basenameOf = (path: string): string => {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

/**
 * A working `EukoliaEditorScope` held entirely in memory.
 *
 * It is the implementation used by the Visual Editor tests, and the reference
 * behaviour for the Electron-backed scope the application shell installs.
 */
export function createEditorScope(
  options: InMemoryScopeOptions = {}
): EukoliaEditorScope {
  let text = options.text ?? ''
  let version = 1
  const listeners = new Set<() => void>()

  const files: ProjectFileEntry[] = (options.files ?? []).map(entry => ({
    path: entry.path.replace(/\\/g, '/'),
    name: basenameOf(entry.path.replace(/\\/g, '/')),
    isDirectory: entry.isDirectory ?? false,
  }))

  const filePath = options.filePath ?? null
  const projectRoot = options.projectRoot ?? null

  const scope: EukoliaEditorScope = {
    id: options.id ?? 'in-memory',

    getFilePath: () => filePath,
    getFileName: () => (filePath ? basenameOf(filePath) : null),
    getText: () => text,
    getVersion: () => version,

    applyChange(change) {
      const { from, to, insert } = change
      if (from < 0 || to > text.length || from > to) {
        throw new RangeError(
          `Invalid change range ${from}..${to} for a document of length ${text.length}`
        )
      }
      text = text.slice(0, from) + insert + text.slice(to)
      version += 1
      options.onChange?.(text)
    },

    getProjectRoot: () => projectRoot,
    getDocFolder: () =>
      filePath === null ? null : dirnameOf(filePath.replace(/\\/g, '/')),
    getProjectFiles: () => files.slice(),
    getProjectFolders() {
      const root: ProjectFolder = {
        name: '',
        path: '',
        folders: [],
        files: [],
      }
      const normalizedRoot = projectRoot
        ? projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
        : null
      for (const file of files) {
        // Paths are stored absolute; the file picker and the completion sources
        // work in project-relative paths.
        const relativePath =
          normalizedRoot && file.path.startsWith(`${normalizedRoot}/`)
            ? file.path.slice(normalizedRoot.length + 1)
            : file.path
        const segments = relativePath.split('/').filter(Boolean)
        let folder = root
        for (let i = 0; i < segments.length - 1; i += 1) {
          const segment = segments[i]
          const path = folder.path ? `${folder.path}/${segment}` : segment
          let child = folder.folders.find(candidate => candidate.path === path)
          if (!child) {
            child = { name: segment, path, folders: [], files: [] }
            folder.folders.push(child)
          }
          folder = child
        }
        if (!file.isDirectory) {
          folder.files.push({ ...file, path: relativePath })
        }
      }
      return root.folders
    },
    onProjectFilesChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    getImageMetadata(path) {
      if (!path) return null
      const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
      const direct = options.images?.[normalized]
      if (direct) return direct

      const candidates = new Set<string>()
      if (projectRoot) candidates.add(joinPath(projectRoot, normalized))
      if (filePath) {
        const folder = dirnameOf(filePath.replace(/\\/g, '/'))
        if (folder) candidates.add(joinPath(folder, normalized))
      }
      for (const candidate of candidates) {
        const found = options.images?.[candidate]
        if (found) return found
      }

      // Fall back to resolving against the project file list: the file exists
      // but has no explicit metadata registered.
      const match = files.find(
        file => !file.isDirectory && file.path.endsWith(normalized)
      )
      if (match) {
        return { url: match.path, extension: extensionOf(match.name) }
      }
      return null
    },

    getMacroTable: () => ({ ...(options.macroTable ?? {}) }),
    getSymbols: () => ({
      labels: options.symbols?.labels ?? [],
      citationKeys: options.symbols?.citationKeys ?? [],
      environments: options.symbols?.environments ?? [],
      includedFiles: options.symbols?.includedFiles ?? [],
    }),
    getPhrases: () => ({ ...(options.phrases ?? {}) }),

    requestCompile: options.onCompile
      ? trigger => options.onCompile?.(trigger)
      : undefined,

    renderPdfFigurePage: options.renderPdfFigurePage,
  }

  return scope
}

const extensionOf = (name: string): string => {
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index + 1).toLowerCase()
}

/**
 * The phrases the ported widgets look up through `view.state.phrase(...)`.
 *
 * Overleaf ships these as i18next strings; Eukolia keeps the same keys with
 * English text so the widget code is unchanged and no message is ever shown as
 * a raw key. A key that is missing here *is* shown as the key — `state.phrase`
 * answers with its argument when it finds nothing — so this table is what stands
 * between a ported widget and a developer's string on a user's screen.
 */
export const EUKOLIA_EDITOR_PHRASES: Record<string, string> = {
  sorry_your_table_cant_be_displayed_at_the_moment:
    "Sorry, your table can't be displayed at the moment",
  this_could_be_because_we_cant_support_some_elements_of_the_table:
    "This could be because we can't support some elements of the table",
  the_visual_editor_cant_preview_this_type_of_image_file:
    "The visual editor can't preview this type of image file",
  click_recompile_and_check_your_pdf_to_see_how_its_looking:
    'Compile and check your PDF to see how it looks',
  edit_figure: 'Edit figure',
  table_generator: 'Table generator',
  close_dialog: 'Close dialog',
  close: 'Close',
  loading: 'Loading',
  cancel: 'Cancel',
  ok: 'OK',
  /*
   * The preamble toggle, and the help link beside it.
   *
   * Both were missing, so the button read `hide_document_preamble` or
   * `show_document_preamble` — and, because the label is also what a screen
   * reader announces, that was the control's accessible name too.
   */
  hide_document_preamble: 'Hide preamble',
  show_document_preamble: 'Show preamble',
  learn_more: 'Learn more',
  expand: 'Expand',
  collapse: 'Collapse',
}
