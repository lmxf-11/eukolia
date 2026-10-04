/**
 * Eukolia — shared IPC contract between the Electron main process, the preload
 * bridge and the renderer.
 *
 * Both sides import these types, so the boundary stays narrow and typed
 * (Instructions.md §63, §64, §65). Nothing here may import `electron`, `node:*`
 * or renderer modules.
 */

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  children?: FileNode[];
  /** True when the entry was excluded by settings but is still listed. */
  excluded?: boolean;
}

export interface FileStat {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export interface DirectoryListing {
  /** Directory names only — used for fast project scanning. */
  directories: string[];
  /** File names only. */
  files: string[];
}

export interface FileWatchEvent {
  path: string;
  kind: 'create' | 'change' | 'delete';
}

/**
 * A watcher that could not do its job.
 *
 * `EMFILE` and `ENOSPC` are the two that matter, and neither is transient: the
 * first is the process out of file handles, the second the platform's change
 * buffer full. VS Code surfaces both to the user rather than silently watching
 * nothing, and so does Eukolia — a project whose changes are not being noticed
 * otherwise looks exactly like a project where nothing is happening.
 */
export interface FileWatchErrorEvent {
  /** The directory whose watcher failed. */
  path: string;
  /** `EMFILE`, `ENOSPC`, or whatever the platform reported. */
  code: string;
  /** The platform's own message, for the log. */
  message: string;
  /**
   * What to tell the user, when there is something to tell them.
   *
   * Set for `ENOSPC` only, in the wording VS Code uses for the same condition
   * (`workspaceWatcher.ts`). Upstream surfaces that one and not `EMFILE`, and this
   * follows it; every code is logged either way.
   */
  userMessage?: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  /** The matched line's text, trimmed for display. */
  text: string;
  matchLength: number;
}

export interface SearchOptions {
  root: string;
  query: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  include?: string;
  exclude?: string;
  maxResults?: number;
  /** Search only these paths (absolute). Used by "replace in open files". */
  onlyPaths?: string[];
  /**
   * Directory names to skip while walking the project, matching the Explorer's
   * `files.exclude`. The renderer owns the settings, so it sends the list rather
   * than the main process reading a settings file it does not hold.
   */
  excludeDirectories?: string[];
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  filesScanned: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Document analysis
// ---------------------------------------------------------------------------

/**
 * One analysis, as the main process answers it.
 *
 * The analyzer is a Node bundle (it reaches `path` through the vendored LaTeX
 * Workshop parser), and the renderer is an ES module with no CommonJS loader, so
 * the work happens in the main process and the answer crosses the bridge. This is
 * the same arrangement VS Code uses and for the same reason: language work lives
 * outside the renderer, in a process that has Node.
 *
 * Two outcomes, both *values* rather than rejections, so the caller can tell a
 * document that cannot be parsed (one file, logged and skipped) from the channel
 * itself failing (the whole transport, which the renderer answers by falling back
 * to its own analyzer):
 *
 *  * `{ analysis }` — the analysis;
 *  * `{ error }` — this document could not be analysed. The caller skips it.
 *
 * A *rejected* `analysis:analyze` means neither happened: the channel is gone.
 */
export interface AnalyzeDocumentResponse {
  /**
   * The `DocumentAnalysis` of `documentModel.ts`.
   *
   * Typed as `unknown` because its definition belongs to the renderer, and this
   * module is the one file both processes import — it may not reach into either
   * side. The renderer's transport checks the shape before handing it on.
   */
  analysis?: unknown;
  /** Why this document could not be analysed. Set with `analysis` absent. */
  error?: string;
}

/** The text to analyse, and the uri it came from (the parser needs a file name). */
export interface AnalyzeDocumentRequest {
  text: string;
  uri: string;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/** One executable invocation in a build recipe, already fully resolved. */
export interface BuildStep {
  /** Absolute path or bare command name resolved through PATH. */
  command: string;
  args: string[];
  /** Extra environment variables layered over `process.env`. */
  env?: Record<string, string>;
  /** Human-readable label, e.g. `pdflatex (main.tex)`. */
  label?: string;
  /**
   * Run through the platform shell. Only set for recipes derived from a
   * `% !TeX options` magic comment, where the option string is a shell command
   * by definition. Every other step runs with `shell: false` so a recipe cannot
   * smuggle in shell metacharacters.
   */
  shell?: boolean;
}

export interface BuildRequest {
  /** Correlates streaming output with this build. */
  jobId: string;
  steps: BuildStep[];
  /** Directory the recipe runs in. */
  cwd: string;
  /** Job name (root file basename without extension) — determines output names. */
  jobName: string;
  /** Absolute directory holding build output; defaults to `cwd`. */
  outputDir?: string;
  /**
   * A directory to search for the TeX executables before the inherited `PATH`.
   *
   * `advanced.texPath`: a distribution that is installed but not on the path the
   * application was launched with. Prepended rather than substituted, because
   * `latexmk` is a Perl script on some installations and MiKTeX's helpers live
   * outside its bin directory.
   */
  toolPath?: string;
  /** Kill the build after this long. */
  timeoutMs?: number;
  /** Run steps in parallel groups? Values are indices into `steps`. */
  parallelGroups?: number[][];
}

export interface BuildStepResult {
  label: string;
  command: string;
  args: string[];
  code: number | null;
  signal: string | null;
  durationMs: number;
  /** True when the step failed to even start (ENOENT and friends). */
  spawnFailed: boolean;
  errorMessage?: string;
}

export interface BuildResult {
  jobId: string;
  success: boolean;
  /** Exit code of the last step. */
  code: number | null;
  /** Combined stdout+stderr of every step, in order. */
  log: string;
  steps: BuildStepResult[];
  pdfPath: string | null;
  synctexPath: string | null;
  durationMs: number;
  cancelled: boolean;
}

export interface CompilerOutputStreamEvent {
  jobId: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface CompilerProgressEvent {
  jobId: string;
  stepIndex: number;
  totalSteps: number;
  label: string;
}

export interface ToolInfo {
  /** The name recipes refer to, e.g. `pdflatex`. */
  name: string;
  /** Resolved absolute path, or null when not found. */
  path: string | null;
  /** First line of `<tool> --version`, when obtainable. */
  version: string | null;
  available: boolean;
}

// ---------------------------------------------------------------------------
// PDF (native engine)
// ---------------------------------------------------------------------------

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfOutlineItem {
  title: string;
  /** 1-based page number, or null for non-page targets. */
  page: number | null;
  uri: string | null;
  children: PdfOutlineItem[];
}

export interface PdfOpenResult {
  docId?: string;
  /** The committed native document was reused byte-for-byte. */
  unchanged?: boolean;
  path: string;
  pageCount: number;
  /** Page sizes in PDF points, in page order. */
  pages: Array<{ width: number; height: number }>;
  outline: PdfOutlineItem[];
  metadata: Record<string, string>;
  needsPassword: boolean;
  /** Identity of the underlying engine, for diagnostics. */
  engine: string;
}

export interface PdfRenderRequest {
  requestId: number;
  path: string;
  /** 0-based page index. */
  page: number;
  /** Device scale: 1 renders one pixel per PDF point. */
  scale: number;
  rotate?: 0 | 90 | 180 | 270;
  /** Sub-rectangle of the page to render, in PDF points. */
  clip?: PdfRect;
  /**
   * The tile address this `clip` was derived from, when it came from a grid.
   *
   * Optional and advisory: `PDFVIEWER.md` §7 has the renderer address regions while
   * the worker's cache keys on the rectangle, and `render_cache.cpp` resolves an
   * address into exactly the rectangle the viewer computed from the same formula. A
   * caller that cannot state an address (the whole-page compatibility path) simply
   * omits it, and the worker derives the region from `clip` alone.
   */
  tile?: { res: number; row: number; col: number };
  /**
   * Device pixels per tile side this request's grid was composed against.
   *
   * Passing it pins the worker's adaptive tile geometry to the grid the viewer laid
   * out (`RenderJob::targetTileSize`), so a memory-pressure tile-size reduction at
   * the native end cannot silently change what the viewer's addresses mean.
   */
  targetTileSize?: number;
  invert?: boolean;
  /** When true the engine may serve this from cache without re-rasterising. */
  allowCache?: boolean;
}

export interface PdfRenderResult {
  requestId: number;
  page: number;
  /** Pixel dimensions of `pixels`. */
  width: number;
  height: number;
  stride: number;
  /** Bytes per pixel: 3 for RGB/BGR, 4 for BGRA. */
  channels: number;
  /** Channel order so the renderer can build the right `ImageData`. */
  order: 'rgb' | 'bgr' | 'bgra' | 'rgba';
  /** The page-space rectangle these pixels cover, in PDF points. */
  pageRect: PdfRect;
  /** Raw pixel payload. */
  pixels: Uint8Array;
  /**
   * True when the engine answered from its own cache without rasterising.
   *
   * Additive and optional, so the frozen `pdfRender` contract is unchanged for every
   * caller that ignores it. It matters to the tiled route because `PDFVIEWER.md`
   * §10's warm-motion gate is "no unnecessary page rasterization": a tile that keeps
   * coming back from the engine's own cache is a viewer bug rather than a cache win,
   * and this is the field that tells the two apart.
   */
  fromEngineCache?: boolean;
}

export interface PdfTextSpan {
  text: string;
  bbox: PdfRect;
  font: string;
  size: number;
}

export interface PdfTextLine {
  bbox: PdfRect;
  spans: PdfTextSpan[];
}

export interface PdfTextBlock {
  bbox: PdfRect;
  lines: PdfTextLine[];
}

/**
 * A text selection, as the native `TextSelection` reports it.
 *
 * `rects` are the highlight rectangles in PDF coordinates, already merged across
 * lines — the same data `Selection.cpp`'s `PaintSelection` draws, so the renderer
 * paints rather than re-derives them.
 */
export interface PdfSelectionResult {
  /** 1-based page the selection ends on. */
  page: number;
  /** The selected text, with line breaks where the selection spans lines. */
  text: string;
  rects: PdfRect[];
  /** Inclusive page range; `-1` when there is no selection. */
  startPage?: number;
  endPage?: number;
}

/** `TextSelection::StartAt` / `SelectUpTo` / `SelectWordAt` / `SelectLineAt`. */
export interface PdfSelectRequest {
  /** 1-based page the selection starts on. */
  page: number;
  mode: 'range' | 'word' | 'line';
  /** Anchor point, in PDF coordinates. */
  startX?: number;
  startY?: number;
  /** Moving end of a `range` selection, in PDF coordinates. */
  endX?: number;
  endY?: number;
  /** Single point for `word` and `line`. */
  x?: number;
  y?: number;
}

export interface PdfSearchMatch {  page: number;
  rects: PdfRect[];
}

export interface PdfLink {
  rect: PdfRect;
  uri: string | null;
  /** Target page (1-based) for internal links. */
  page: number | null;
}

export interface PdfDocumentRef {
  path: string;
  /** Opaque handle used by the engine to identify an open document. */
  docId: string;
}

/**
 * What the installed native worker can do, so the viewer can decide whether to take
 * the tiled route.
 *
 * `PDFVIEWER.md` §7: "Add capability negotiation for tiled presentation and
 * viewport updates, forwarding existing native functionality through main/preload
 * with runtime validation." The renderer must not assume tiles exist: an older
 * packaged `eukolia-pdf.exe` beside a newer renderer bundle would otherwise ask for
 * a route the worker has never heard of and get a protocol error on every page.
 */
export interface PdfTileCapabilities {
  /** False when no native worker is available at all. */
  available: boolean;
  /**
   * True when `pdfRender` honours `tile`/`clip` plus `targetTileSize` and reports the
   * rectangle it actually drew. Older workers ignore both and render the whole page,
   * which would place a full-page bitmap where a tile belongs.
   */
  tiledRender: boolean;
  /** True when the worker accepts a bulk `viewport` publication. */
  viewport: boolean;
  /**
   * The largest tile resolution the worker's 16-bit row/column address fields can
   * carry. `PDFVIEWER.md` §7: "Existing native tile index handling uses 16-bit
   * row/column fields while resolutions accept larger values; audit representable
   * ranges before public exposure."
   */
  maxTileRes: number;
  /** The worker's own adaptive target tile size, as a starting point for the grid. */
  targetTileSize: number;
  /** Protocol version the worker reported, for diagnostics. */
  protocolVersion: number | null;
  /** Engine identity string, e.g. `eukolia-mupdf`. */
  engine: string | null;
  /** MuPDF version, for the record. */
  mupdfVersion: string | null;
}

/**
 * One bulk viewport publication.
 *
 * `PDFVIEWER.md` §7: "Do not hide native prefetch behind a route that also makes the
 * renderer issue identical jobs. Choose one scheduler as authoritative; the native
 * cache executes its plan." So `prefetch: false` is the normal setting for a viewer
 * that schedules its own tiles; `prefetch: true` exists for the compatibility path
 * and for the benchmark harness, which wants the reference's own prediction policy.
 */
export interface PdfViewportRequest {
  path: string;
  /** 0-based visible page indices, in reading order. */
  visiblePages: number[];
  adjacentPages?: number[];
  nearbyPages?: number[];
  scale: number;
  rotate?: 0 | 90 | 180 | 270;
  invert?: boolean;
  /** Let the native cache queue its own prefetches for the adjacent/nearby pages. */
  prefetch?: boolean;
}

export interface PdfViewportResult {
  /** Jobs the native cache queued for this publication (0 when `prefetch` is false). */
  queued: number;
  cacheEntries: number;
  cacheBytes: number;
  queuedTotal: number;
}

// ---------------------------------------------------------------------------
// SyncTeX
// ---------------------------------------------------------------------------

export interface SynctexForwardRequest {
  /** The `.synctex.gz` file (or the PDF, from which it is derived). */
  synctexPath: string;
  /** Source file as recorded by TeX, usually relative to the build directory. */
  file: string;
  line: number;
  column?: number;
  /** Build directory, used to resolve the recorded source path. */
  buildDir?: string;
}

export interface SynctexForwardResult {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Raw `synctex view` output for diagnostics. */
  raw: string;
}

export interface SynctexInverseRequest {
  synctexPath: string;
  page: number;
  x: number;
  y: number;
}

export interface SynctexInverseResult {
  /** Absolute path of the source file. */
  file: string;
  line: number;
  column: number;
  raw: string;
}

// ---------------------------------------------------------------------------
// Application / workspace
// ---------------------------------------------------------------------------

export interface RecentWorkspace {
  path: string;
  name: string;
  openedAt: number;
}

export interface PersistedState {
  workspacePath: string | null;
  openFiles: string[];
  activeFile: string | null;
  /**
   * The project's root document, as the last session resolved it.
   *
   * Remembered so restoring a project does not have to derive it again. Deriving
   * it means reading the head of every `.tex` file in the folder — bounded, but a
   * read per candidate — and the answer only changes when the user edits a magic
   * comment or adds a `\documentclass`. The value is checked against the folder's
   * file list before it is used, so a stale one costs nothing and is ignored.
   */
  rootFile: string | null;
  layout: string;
  editorMode: 'code' | 'visual';
  sidebarVisible: boolean;
  sidebarWidth: number;
  pdfVisible: boolean;
  pdfPath: string | null;
  pdfPage: number;
  pdfZoom: number;
  theme: 'light' | 'dark' | 'system';
  recentWorkspaces: RecentWorkspace[];
  /** Crash-recovery payload: unsaved buffers keyed by uri. */
  unsavedBuffers: Record<string, { content: string; timestamp: number; languageId: string }>;
}

/**
 * One command, as the Settings window needs to know it.
 *
 * This is the catalogue's unit and it is deliberately not `Command`: the
 * registry's own type carries a `handler`, and a handler is a closure over the
 * app shell's state — it cannot cross a process boundary and must not be able
 * to. What the shortcut editor actually needs is the four facts it draws a row
 * from: what the command is called, where it belongs, what it answers to, and
 * whether it is offered at all.
 *
 * `binding` is the command's *declared* default. The effective binding is read
 * from settings in whichever window is showing it, because a rebind is a
 * setting and both windows already read the same settings.
 */
export interface CommandCatalogEntry {
  id: string;
  title: string;
  category: string;
  binding?: string;
  hidden?: boolean;
}


export const IPC = {
  library: {
    describe: 'library:describe',
    choose: 'library:choose',
    create: 'library:create',
    openShared: 'library:openShared'
  },
  fs: {
    readFile: 'fs:readFile',
    /**
     * Reads at most `maxBytes` from the start of a file.
     *
     * A separate channel from `readFile` because the bound has to be enforced on
     * the main-process side of the bridge: root-document detection asks a
     * question whose answer is at the top of the file, and sending the whole file
     * to ask it is what made opening a large project slow.
     */
    readFileHead: 'fs:readFileHead',
    readFileBinary: 'fs:readFileBinary',
    writeFile: 'fs:writeFile',
    createFile: 'fs:createFile',
    createDirectory: 'fs:createDirectory',
    delete: 'fs:delete',
    rename: 'fs:rename',
    copy: 'fs:copy',
    stat: 'fs:stat',
    listDirectory: 'fs:listDirectory',
    listDirectoryNames: 'fs:listDirectoryNames',
    listTree: 'fs:listTree',
    listFlat: 'fs:listFlat',
    revealInExplorer: 'fs:revealInExplorer',
    watch: 'fs:watch',
    unwatch: 'fs:unwatch',
    /**
     * Watches a whole directory tree, recursively.
     *
     * A separate channel from `watch` because the two answer different questions.
     * `watch` keeps an eye on one *file* — the user has it open, and an outside
     * change to it has to be noticed — while this is the workspace watcher: one
     * recursive watch per open folder, delivering debounced batches, which is what
     * makes a file another program creates appear in the tree at all. VS Code has
     * both, for the same two reasons.
     */
    watchTree: 'fs:watchTree',
    unwatchTree: 'fs:unwatchTree',
    /** Fired when a watcher fails — `EMFILE`, `ENOSPC` — so the UI can say so. */
    watchError: 'fs:watchError',
    search: 'fs:search',
    replaceInFiles: 'fs:replaceInFiles',
    watchEvent: 'fs:watchEvent'
  },
  /**
   * Document analysis.
   *
   * A channel rather than a renderer worker because of what the analyzer's
   * dependency chain is: the vendored LaTeX Workshop parser is handed `path` as a
   * CommonJS `require("path")` by the browser build, and an ES module worker has no
   * `require` at all — every request failed with `require is not defined` during
   * module *evaluation*, which is what took application startup down with it. The
   * main process is Node, where Vite externalises builtins and `path` is a real
   * import, so the same source file runs there unchanged
   * (`src/main/analysis/analyzer.ts`); the renderer's own copy of the analyzer,
   * for open buffers, is supplied `path` by `public/eukolia-require-shim.js`. See
   * `src/renderer/parser/latexAnalysis.ts`.
   */
  analysis: {
    /**
     * Analyses one document's text and returns `AnalyzeDocumentResponse`.
     *
     * `invoke` correlates request and answer, so there is no id: the worker this
     * replaced needed one because a single `postMessage` channel carried every
     * request and every answer.
     */
    analyze: 'analysis:analyze'
  },
  dialog: {
    openFolder: 'dialog:openFolder',
    openFile: 'dialog:openFile',
    saveFile: 'dialog:saveFile',
    confirm: 'dialog:confirm'
  },
  compiler: {
    build: 'compiler:build',
    cancel: 'compiler:cancel',
    clean: 'compiler:clean',
    detectTools: 'compiler:detectTools',
    output: 'compiler:output',
    progress: 'compiler:progress',
    stepFinished: 'compiler:stepFinished'
  },
  synctex: {
    forward: 'synctex:forward',
    inverse: 'synctex:inverse',
    available: 'synctex:available'
  },
  pdf: {
    available: 'pdf:available',
    open: 'pdf:open',
    close: 'pdf:close',
    render: 'pdf:render',
    cancelRender: 'pdf:cancelRender',
    /**
     * Tiled-presentation capability negotiation and bulk viewport publication.
     *
     * Added rather than changed: `pdfRender` keeps its whole-page/clip behaviour
     * exactly (`PDFVIEWER.md` §7, "Preserve `pdfRender` as the whole-page/clip
     * compatibility path"), so a viewer that does not understand tiles is unaffected.
     */
    tileCapabilities: 'pdf:tileCapabilities',
    viewport: 'pdf:viewport',
    text: 'pdf:text',
    search: 'pdf:search',
    /** `TextSelection.cpp` — glyph hit-testing, word and line selection. */
    select: 'pdf:select',
    links: 'pdf:links',
    outline: 'pdf:outline',
    info: 'pdf:info',
    onProgress: 'pdf:progress',
    onError: 'pdf:error'
  },
  app: {
    getState: 'app:getState',
    setState: 'app:setState',
    getVersions: 'app:getVersions',
    openExternal: 'app:openExternal',
    showItemInFolder: 'app:showItemInFolder',
    writeTempFile: 'app:writeTempFile',
    cleanupTempFiles: 'app:cleanupTempFiles',
    log: 'app:log'
  },
  /**
   * The advanced-settings JSON files.
   *
   * Two scopes, mirroring the settings manager: `user` is one file in the
   * application's user-data directory that applies everywhere, and `workspace`
   * is `.eukolia/settings.json` inside the open project so a project can carry
   * its own configuration. The workspace scope wins, as it does in the settings
   * UI.
   */
  settings: {
    read: 'settings:read',
    write: 'settings:write',
    describe: 'settings:describe',
    /** The user's own `*.hsnips` files, from their settings directory. */
    userSnippets: 'settings:userSnippets',
    /** Opens the directory holding the user's settings and snippets. */
    openUserDirectory: 'settings:openUserDirectory',
    /** Fired by the main process when a watched file changes on disk. */
    changed: 'settings:changed'
  },
  /**
   * The managed snippet library — `snippets.json` in the `.eukolia` folder of
   * the project library, or in the older application-data layout before one is
   * set up.
   *
   * One file in the EUSnips format is the library now, rather than a folder of
   * `*.hsnips` files, so it is read, written and watched as a file. The main
   * process owns the path and the bytes; the renderer owns what the bytes mean,
   * which is why these channels carry text rather than parsed snippets.
   */
  snippets: {
    read: 'snippets:read',
    write: 'snippets:write',
    watch: 'snippets:watch',
    /** Fired when the file changes on disk, including from our own writes. */
    changed: 'snippets:changed'
  },
  /**
   * The window's own controls.
   *
   * The window is frameless (`titleBarStyle: 'hidden'`) and the application draws
   * its own caption — minimise, maximise/restore and close are buttons in the
   * renderer's tab bar. These channels are all that is privileged about them: the
   * presses, and the window's answer to "are you maximised?", which is what the
   * middle button's glyph follows.
   *
   * There is deliberately no channel for a window-control *overlay*: that was
   * `titleBarOverlay` plus a `setTitleBarTheme` call, and both went when the
   * renderer started drawing the buttons — a caption that is ordinary DOM reads
   * the theme's own CSS variables and needs no round trip.
   */
  window: {
    minimize: 'window:minimize',
    maximize: 'window:maximize',
    close: 'window:close',
    /**
     * Closes the window with no chance to object, for a renderer that has
     * already offered to keep what it holds.
     *
     * The Snippet Library needs it because its own close path is asynchronous:
     * it writes the library *as it closes* and leaves the window open with the
     * reason when the write fails, so the close the main process performs the
     * moment `window:close` arrives would take the unsaved entries with it.
     * This channel is the answer to the question that leaves — "close anyway,
     * discarding this" — and it destroys the window outright.
     */
    discard: 'window:discard',
    isMaximized: 'window:isMaximized',
    /** Fired when the window is maximised or restored, so the icon can change. */
    maximizedChanged: 'window:maximizedChanged',
    /** Opens or focuses the separate Settings window. */
    openSettings: 'window:openSettings',
    /** Opens or focuses the separate Snippet Library window. */
    openSnippets: 'window:openSnippets'
  },
  /**
   * The command catalogue, published by the window that owns the registry.
   *
   * Commands are registered by the **app shell**, which is the window that has
   * the editor, the build service and the PDF viewer to drive. The Settings
   * window is a renderer of its own — it shares no memory with the shell — so its
   * registry is empty, and the keyboard-shortcut editor reads its rows from that
   * registry. Without this channel the editor had nothing to list, which is what
   * made it render "No shortcuts match" for a list that was never filtered.
   *
   * The shell stays the single source of truth. What crosses the bridge is a
   * *derived* catalogue — id, title, category, declared binding, visibility —
   * and never a handler, so the Settings window can name every command and edit
   * its binding without being able to run one.
   */
  commands: {
    /** Shell → main: the current catalogue, sent whenever it changes. */
    publish: 'commands:publish',
    /** Settings → main: the catalogue as last published, or `null` when none has been. */
    catalog: 'commands:catalog',
    /** Main → settings windows: the catalogue, pushed as soon as the shell publishes one. */
    changed: 'commands:changed'
  },
  /** The integrated terminal: one real shell process per session. */
  terminal: {    create: 'terminal:create',
    write: 'terminal:write',
    resize: 'terminal:resize',
    kill: 'terminal:kill',
    /** Fired by the main process as the shell produces output. */
    data: 'terminal:data',
    exit: 'terminal:exit'
  },
  protocol: {
    openFile: 'protocol:openFile',
    openProject: 'protocol:openProject',
    pending: 'protocol:pending',
    ready: 'protocol:ready'
  }
} as const;

/* ------------------------------------------------------------------ *
 * Advanced settings
 * ------------------------------------------------------------------ */

export type SettingsScope = 'user' | 'workspace';

/** Where a settings file lives, and whether it exists yet. */
export interface SettingsFileDescription {
  scope: SettingsScope;
  path: string;
  exists: boolean;
  /** The parsed contents, or `null` when the file is absent or unreadable. */
  values: Record<string, unknown> | null;
  /** Set when the file exists but could not be parsed, so the UI can say so. */
  error?: string;
  /**
   * The directory holding the user's settings and snippets, shown by the Settings
   * UI so the location is discoverable. Only meaningful for the `user` scope.
   */
  directory?: string;
  /** How many `*.hsnips` files sit in the user's own snippets folder. */
  userSnippetCount?: number;
}

/**
 * A snippet file the user owns, read from their settings directory.
 *
 * The language a source applies to comes from its file name (`latex.hsnips`,
 * `all.hsnips`), as it does in HyperSnips, so the name is carried rather than a
 * language the main process would have to guess.
 */
export interface UserSnippetSource {
  name: string;
  content: string;
}

/**
 * The managed snippet library on disk.
 *
 * `exists: false` with no `error` is the normal first-run state and means "seed
 * me". A file that exists but cannot be read is reported through `error`, so a
 * permissions problem is never mistaken for a missing file and quietly
 * overwritten.
 */
export interface SnippetFileDescription {
  /** Absolute path of `snippets.json` inside the user's snippets directory. */
  path: string;
  /** Absolute path of the user's snippets directory, for "open folder". */
  directory: string;
  exists: boolean;
  /** File text, verbatim. The renderer parses and validates it. */
  text: string | null;
  /** Set when the file exists but could not be read. */
  error?: string;
  /** File name of the legacy `.hsnips` sources also sitting in the directory. */
  legacyFiles?: string[];
  /** Content of `globals.js` if it exists in the directory. */
  globalsJs?: string | null;
  /** Absolute path of `globals.js` in the directory. */
  globalsPath?: string;
}

export interface SettingsWriteRequest {
  scope: SettingsScope;
  values: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Terminal
 * ------------------------------------------------------------------ */

export interface TerminalCreateRequest {
  /** Working directory for the shell; the project root when one is open. */
  cwd?: string;
  /** Shell to run. Defaults to the platform shell. */
  shell?: string;
  /** Initial PTY width in columns. The renderer sends its measured size next. */
  cols?: number;
  /** Initial PTY height in rows. */
  rows?: number;
}

export interface TerminalCreateResult {
  id: number;
  /** The executable actually started, shown in the panel header. */
  command: string;
  /**
   * The full command line, including arguments, for the header's hover title.
   * Optional so a session from before this field existed still type-checks.
   */
  commandLine?: string;
  cwd: string;
  /**
   * The user's home directory, so the panel can abbreviate a long path the way a
   * prompt does. Optional for the same reason as `commandLine`.
   */
  home?: string;
  /**
   * Output the session produced before this view attached.
   *
   * A PTY starts printing as soon as it is spawned (the prompt, at minimum), and
   * the renderer only learns its session id from this result — so without the
   * replay the first prompt would be lost in a race. It is a snapshot: anything
   * emitted after it is delivered through `IPC.terminal.data` as usual.
   */
  history?: string;
}

export interface TerminalDataEvent {
  id: number;
  /**
   * Raw PTY output — a VT stream, escapes and all.
   *
   * It is deliberately *not* decoded here: cursor moves, colours, OSC title
   * sequences and in-place redraws are only meaningful to a terminal emulator,
   * and the renderer runs one. Stripping or interpreting this in the main
   * process is what turns a terminal back into a log view.
   */
  data: string;
}

export interface TerminalExitEvent {
  id: number;
  exitCode: number | null;
}
