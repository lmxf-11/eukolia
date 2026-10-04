/**
 * Eukolia preload bridge.
 *
 * The renderer runs with `contextIsolation` and no Node integration. Everything
 * privileged is exposed here as a narrow, typed, promise-based surface
 * (Instructions.md §63, §64, §65, §68). This file validates its arguments rather
 * than trusting the renderer, and never forwards arbitrary channel names.
 */

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type { ProjectLibraryStatus, CreateLibraryProject, CreatedLibraryProject } from '../shared/projectLibrary';
import type {
  AnalyzeDocumentResponse,
  BuildRequest,
  BuildResult,
  BuildStepResult,
  CommandCatalogEntry,
  CompilerOutputStreamEvent,
  CompilerProgressEvent,
  DirectoryListing,
  FileNode,
  FileStat,
  FileWatchErrorEvent,
  FileWatchEvent,
  PdfLink,
  PdfOpenResult,
  PdfOutlineItem,
  PdfRenderRequest,
  PdfRenderResult,
  PdfSelectRequest,
  PdfSelectionResult,
  PdfSearchMatch,
  PdfTextBlock,
  PdfTileCapabilities,
  PdfViewportRequest,
  PdfViewportResult,
  SearchOptions,
  SearchResult,
  SettingsFileDescription,
  SettingsScope,
  SnippetFileDescription,
  SynctexForwardRequest,
  SynctexForwardResult,
  SynctexInverseRequest,
  SynctexInverseResult,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  UserSnippetSource,
  ToolInfo
} from '../shared/ipc';

type Unsubscribe = () => void;

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
}

const eukoliaApi = {
  getProjectLibrary: (): Promise<ProjectLibraryStatus> => ipcRenderer.invoke(IPC.library.describe),
  chooseProjectLibrary: (): Promise<ProjectLibraryStatus | null> => ipcRenderer.invoke(IPC.library.choose),
  createLibraryProject: (request: CreateLibraryProject): Promise<CreatedLibraryProject> => ipcRenderer.invoke(IPC.library.create, request),
  openLibrarySettings: (): Promise<void> => ipcRenderer.invoke(IPC.library.openShared),
  // ------------------------------------------------------------------ files
  readFile: (filePath: string): Promise<string> => ipcRenderer.invoke(IPC.fs.readFile, assertString(filePath, 'filePath')),

  /**
   * Reads at most `maxBytes` from the start of a file.
   *
   * Used by root-document detection, which only ever inspects a file's header —
   * the magic comment and the `\documentclass` line — and must not pull a whole
   * chapter across the bridge to do it.
   */
  readFileHead: (filePath: string, maxBytes?: number): Promise<string> =>
    ipcRenderer.invoke(IPC.fs.readFileHead, assertString(filePath, 'filePath'), maxBytes),

  readFileBinary: (filePath: string): Promise<Uint8Array> =>
    ipcRenderer.invoke(IPC.fs.readFileBinary, assertString(filePath, 'filePath')),

  writeFile: (filePath: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.fs.writeFile, assertString(filePath, 'filePath'), String(content)),

  createFile: (filePath: string, content = ''): Promise<boolean> =>
    ipcRenderer.invoke(IPC.fs.createFile, assertString(filePath, 'filePath'), content),

  createDirectory: (dirPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.fs.createDirectory, assertString(dirPath, 'dirPath')),

  deletePath: (targetPath: string, useTrash = true): Promise<boolean> =>
    ipcRenderer.invoke(IPC.fs.delete, assertString(targetPath, 'targetPath'), useTrash),

  renamePath: (oldPath: string, newPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.fs.rename, assertString(oldPath, 'oldPath'), assertString(newPath, 'newPath')),

  copyPath: (source: string, destination: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.fs.copy, assertString(source, 'source'), assertString(destination, 'destination')),

  stat: (targetPath: string): Promise<FileStat> => ipcRenderer.invoke(IPC.fs.stat, assertString(targetPath, 'targetPath')),

  listDirectory: (dirPath: string, excludes: string[] = []): Promise<FileNode[]> =>
    ipcRenderer.invoke(IPC.fs.listDirectory, assertString(dirPath, 'dirPath'), excludes),

  listTree: (dirPath: string, excludes: string[] = [], maxEntries?: number): Promise<FileNode[]> =>
    ipcRenderer.invoke(IPC.fs.listTree, assertString(dirPath, 'dirPath'), excludes, maxEntries),

  listFlat: (dirPath: string, excludes: string[] = []): Promise<string[]> =>
    ipcRenderer.invoke(IPC.fs.listFlat, assertString(dirPath, 'dirPath'), excludes),

  listDirectoryNames: (dirPath: string): Promise<DirectoryListing> =>
    ipcRenderer.invoke(IPC.fs.listDirectoryNames, assertString(dirPath, 'dirPath')),

  revealInExplorer: (targetPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.fs.revealInExplorer, assertString(targetPath, 'targetPath')),

  watch: (targets: string[]): Promise<boolean> => ipcRenderer.invoke(IPC.fs.watch, targets),
  unwatch: (targets: string[]): Promise<boolean> => ipcRenderer.invoke(IPC.fs.unwatch, targets),
  onFileWatchEvent: (callback: (event: FileWatchEvent) => void): Unsubscribe =>
    subscribe<FileWatchEvent>(IPC.fs.watchEvent, callback),

  /**
   * Starts the recursive watch of an open folder.
   *
   * `excludes` are directory names — `files.watcherExclude` — that must never be
   * watched, so an install into `node_modules` cannot produce an event per file.
   * Failures arrive through `onFileWatchError` rather than as a rejection here:
   * whether the watch could be *started* says nothing about whether it later runs
   * out of handles, and both are the same thing to the user.
   */
  watchTree: (root: string, excludes: string[] = []): Promise<boolean> =>
    ipcRenderer.invoke(IPC.fs.watchTree, assertString(root, 'root'), excludes),
  unwatchTree: (root: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.fs.unwatchTree, assertString(root, 'root')),
  onFileWatchError: (callback: (event: FileWatchErrorEvent) => void): Unsubscribe =>
    subscribe<FileWatchErrorEvent>(IPC.fs.watchError, callback),

  search: (options: SearchOptions): Promise<SearchResult> => ipcRenderer.invoke(IPC.fs.search, options),

  replaceInFiles: (
    options: SearchOptions & { replacement: string }
  ): Promise<{ filesChanged: number; replacements: number }> => ipcRenderer.invoke(IPC.fs.replaceInFiles, options),

  getPathForFile: (file: File): string => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch {
      /* fall back to legacy property */
    }
    return (file as unknown as { path?: string }).path ?? '';
  },

  // --------------------------------------------------------------- analysis
  /**
   * Analyses one document in the main process.
   *
   * The parser is a Node bundle, so this is the only way the renderer can have an
   * answer for a file it did not open: `src/main/analysis/analyzer.ts` holds the
   * whole explanation. Resolves with `{ analysis }` or `{ error }`; a rejection
   * means the channel itself failed, which the renderer's analysis service treats
   * as "use the analyzer on this thread instead".
   */
  analyzeDocument: (text: string, uri: string): Promise<AnalyzeDocumentResponse> =>
    ipcRenderer.invoke(IPC.analysis.analyze, assertString(text, 'text'), assertString(uri, 'uri')),

  // ---------------------------------------------------------------- dialogs
  openFolderDialog: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialog.openFolder),
  openFileDialog: (filters?: { name: string; extensions: string[] }[]): Promise<string[]> =>
    ipcRenderer.invoke(IPC.dialog.openFile, filters),
  saveFileDialog: (defaultPath?: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> =>
    ipcRenderer.invoke(IPC.dialog.saveFile, defaultPath, filters),
  confirmDialog: (options: {
    message: string;
    detail?: string;
    buttons: string[];
    defaultId?: number;
    cancelId?: number;
    type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  }): Promise<number> => ipcRenderer.invoke(IPC.dialog.confirm, options),

  // -------------------------------------------------------------- compiler
  build: (request: BuildRequest): Promise<BuildResult> => ipcRenderer.invoke(IPC.compiler.build, request),
  cancelBuild: (jobId: string): Promise<boolean> => ipcRenderer.invoke(IPC.compiler.cancel, jobId),
  cleanAuxiliaryFiles: (rootFile: string, extensions?: string[], outputDir?: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.compiler.clean, rootFile, extensions, outputDir),
  detectTools: (names: string[], toolPath?: string): Promise<ToolInfo[]> =>
    ipcRenderer.invoke(IPC.compiler.detectTools, names, toolPath),
  onCompilerOutput: (callback: (event: CompilerOutputStreamEvent) => void): Unsubscribe =>
    subscribe<CompilerOutputStreamEvent>(IPC.compiler.output, callback),
  onCompilerProgress: (callback: (event: CompilerProgressEvent) => void): Unsubscribe =>
    subscribe<CompilerProgressEvent>(IPC.compiler.progress, callback),
  onCompilerStepFinished: (callback: (event: { jobId: string; step: BuildStepResult }) => void): Unsubscribe =>
    subscribe<{ jobId: string; step: BuildStepResult }>(IPC.compiler.stepFinished, callback),

  // ---------------------------------------------------------------- synctex
  synctexAvailable: (): Promise<boolean> => ipcRenderer.invoke(IPC.synctex.available),
  synctexForward: (request: SynctexForwardRequest): Promise<SynctexForwardResult | null> =>
    ipcRenderer.invoke(IPC.synctex.forward, request),
  synctexInverse: (request: SynctexInverseRequest): Promise<SynctexInverseResult | null> =>
    ipcRenderer.invoke(IPC.synctex.inverse, request),

  // ------------------------------------------------------------------- PDF
  pdfAvailable: (): Promise<boolean> => ipcRenderer.invoke(IPC.pdf.available),
  pdfOpen: (path: string): Promise<PdfOpenResult> => ipcRenderer.invoke(IPC.pdf.open, assertString(path, 'path')),
  pdfClose: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.pdf.close, path),
  pdfRender: (request: PdfRenderRequest): Promise<PdfRenderResult> => ipcRenderer.invoke(IPC.pdf.render, request),
  pdfCancelRender: (requestId: number): Promise<boolean> => ipcRenderer.invoke(IPC.pdf.cancelRender, requestId),
  /**
   * What the installed native worker can do.
   *
   * `PDFVIEWER.md` §7 asks for capability negotiation rather than an assumption, so a
   * renderer that knows how to draw tiles can still fall back to whole pages when the
   * packaged worker beside it predates the tile route. Answered from the worker's
   * startup handshake, so it needs no document and cannot fail.
   */
  pdfTileCapabilities: (): Promise<PdfTileCapabilities> => ipcRenderer.invoke(IPC.pdf.tileCapabilities),
  /**
   * Publishes the viewport to the native cache in one call.
   *
   * This is the renderer telling the engine which pages it wants; it is not a second
   * client of the engine's tile route. See `pdfHandler.ts` for why `prefetch` default
   * is false.
   */
  pdfViewport: (request: PdfViewportRequest): Promise<PdfViewportResult> =>
    ipcRenderer.invoke(IPC.pdf.viewport, { ...request, path: assertString(request?.path, 'path') }),
  pdfText: (path: string, page: number): Promise<PdfTextBlock[]> => ipcRenderer.invoke(IPC.pdf.text, path, page),
  pdfSearch: (
    path: string,
    query: string,
    options?: { caseSensitive?: boolean; regex?: boolean; wholeWord?: boolean; maxResults?: number }
  ): Promise<PdfSearchMatch[]> => ipcRenderer.invoke(IPC.pdf.search, path, query, options),
  pdfLinks: (path: string, page: number): Promise<PdfLink[]> => ipcRenderer.invoke(IPC.pdf.links, path, page),
  pdfOutline: (path: string): Promise<PdfOutlineItem[]> => ipcRenderer.invoke(IPC.pdf.outline, path),
  /**
   * Selects text on a page.
   *
   * The glyph model lives in the native engine (`TextSelection.cpp`), so the
   * renderer sends the gesture — a drag, a double click, a triple click — and
   * receives the text plus the rectangles to paint.
   */
  pdfSelect: (path: string, request: PdfSelectRequest): Promise<PdfSelectionResult> =>
    ipcRenderer.invoke(IPC.pdf.select, path, request),
  pdfInfo: (path: string): Promise<PdfOpenResult | null> => ipcRenderer.invoke(IPC.pdf.info, path),
  onPdfProgress: (callback: (event: { path: string; page: number; done: number; total: number }) => void): Unsubscribe =>
    subscribe(IPC.pdf.onProgress, callback),
  onPdfError: (callback: (event: { path: string; message: string }) => void): Unsubscribe =>
    subscribe(IPC.pdf.onError, callback),

  // --------------------------------------------------------------- app state
  getState: () => ipcRenderer.invoke(IPC.app.getState),
  setState: (patch: unknown) => ipcRenderer.invoke(IPC.app.setState, patch),
  getVersions: (): Promise<Record<string, string>> => ipcRenderer.invoke(IPC.app.getVersions),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.app.openExternal, url),
  showItemInFolder: (targetPath: string): Promise<boolean> => ipcRenderer.invoke(IPC.app.showItemInFolder, targetPath),
  /**
   * Writes bytes to a private temporary file and returns its path.
   *
   * The native PDF engine opens documents by path, so this is how a figure that
   * exists in the renderer only as a `blob:`/`data:` URL becomes renderable.
   */
  writeTemporaryFile: (data: Uint8Array, desiredName: string): Promise<string> =>
    ipcRenderer.invoke(IPC.app.writeTempFile, data, desiredName),
  cleanupTemporaryFiles: (): Promise<number> => ipcRenderer.invoke(IPC.app.cleanupTempFiles),
  log: (level: 'error' | 'warn' | 'info' | 'debug', message: string): Promise<void> =>
    ipcRenderer.invoke(IPC.app.log, level, String(message)),

  // ------------------------------------------------------- advanced settings
  //
  // The JSON files the advanced settings live in. `read` and `write` are the
  // whole surface: the renderer owns which keys exist, the main process owns
  // where they are stored and reports when they change on disk.
  readAdvancedSettings: (scope: SettingsScope, projectRoot?: string | null): Promise<SettingsFileDescription> =>
    ipcRenderer.invoke(IPC.settings.read, scope, projectRoot ?? null),
  writeAdvancedSettings: (
      scope: SettingsScope,
      values: Record<string, unknown>,
      projectRoot?: string | null
    ): Promise<SettingsFileDescription> =>
      ipcRenderer.invoke(IPC.settings.write, { scope, values }, projectRoot ?? null),
  /** Creates the file when missing and opens it in the user's editor. */
  openAdvancedSettings: (scope: SettingsScope, projectRoot?: string | null): Promise<string> =>
    ipcRenderer.invoke(IPC.settings.describe, scope, projectRoot ?? null),
  /**
   * The user's own `*.hsnips` files, read from their settings directory.
   *
   * They sit beside the settings so everything the user owns is in one place;
   * the language comes from each file's name, as it does in HyperSnips.
   */
  readUserSnippets: (): Promise<UserSnippetSource[]> =>
    ipcRenderer.invoke(IPC.settings.userSnippets),
  /** Opens the directory holding the user's settings and snippets. */
  openUserDirectory: (): Promise<string> => ipcRenderer.invoke(IPC.settings.openUserDirectory),
  onAdvancedSettingsChanged: (callback: (description: SettingsFileDescription) => void): Unsubscribe =>
    subscribe<SettingsFileDescription>(IPC.settings.changed, callback),

  // ------------------------------------------------------- snippet library
  //
  // `User/snippets/snippets.json`, in the EUSnips format. Only the file's text
  // crosses the bridge: the format belongs to the renderer, the path and the
  // bytes belong to the main process.
  readSnippetFile: (): Promise<SnippetFileDescription> => ipcRenderer.invoke(IPC.snippets.read),
  writeSnippetFile: (text: string, globalsJs?: string): Promise<SnippetFileDescription> => {
    if (typeof text !== 'string') throw new TypeError('snippet file text must be a string');
    if (globalsJs !== undefined && globalsJs !== null && typeof globalsJs !== 'string') {
      throw new TypeError('globalsJs must be a string');
    }
    return ipcRenderer.invoke(IPC.snippets.write, text, globalsJs ?? undefined);
  },
  /** Starts watching the file and returns its current state in one round trip. */
  watchSnippetFile: (): Promise<SnippetFileDescription> => ipcRenderer.invoke(IPC.snippets.watch),
  onSnippetFileChanged: (callback: (description: SnippetFileDescription) => void): Unsubscribe =>
    subscribe<SnippetFileDescription>(IPC.snippets.changed, callback),

  // ------------------------------------------------------- the window controls
  //
  // The window is frameless (`titleBarStyle: 'hidden'`) and the application draws
  // its own caption: these three presses, and the window's answer to whether it is
  // maximised, are the whole surface. There is no `setTitleBarTheme` any more —
  // nothing is drawn by the platform over the top of the window, so there is no
  // overlay to recolour.
  /**
   * Whether the platform draws the window controls itself.
   *
   * True on macOS, whose traffic lights are the system's and which the application
   * must not duplicate: there the renderer draws no caption buttons at all. On
   * Windows and Linux the caption is the application's own — `titleBarOverlay` is
   * not configured for any window, so nothing is painted over the top of it, and
   * the renderer's tab bar draws minimise, maximise and close itself.
   */
  hasNativeWindowControls: process.platform === 'darwin',
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.window.minimize),
  /** Toggles maximise/restore; resolves to whether the window is now maximised. */
  toggleMaximizeWindow: (): Promise<boolean> => ipcRenderer.invoke(IPC.window.maximize),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.window.isMaximized),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.window.close),
  /**
   * Closes this window at once, discarding anything the renderer holds.
   *
   * Only the Snippet Library needs the distinction: its close writes the library
   * first and keeps the window open when the write fails, so the plain close —
   * which takes effect immediately — would discard the very entries it is
   * trying to save.
   */
  discardWindow: (): Promise<void> => ipcRenderer.invoke(IPC.window.discard),
  onWindowMaximizedChanged: (callback: (maximized: boolean) => void): Unsubscribe =>
    subscribe<boolean>(IPC.window.maximizedChanged, callback),
  openSettingsWindow: (section?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.window.openSettings, section),
  openSnippetsWindow: (snippetId?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.window.openSnippets, snippetId),
  onNavigateSettings: (callback: (section: string) => void): Unsubscribe =>
    subscribe<string>('window:settings:navigate', callback),
  onFocusSnippet: (callback: (snippetId: string) => void): Unsubscribe =>
    subscribe<string>('window:snippets:focus', callback),

  // ------------------------------------------------------- command catalogue
  //
  // The Settings window's keyboard-shortcut editor lists every command, and the
  // commands are registered by the app shell rather than by this window — see
  // `IPC.commands`. The shell publishes, the settings windows read, and neither
  // ever sends a handler across the bridge.
  /** Announces this window's command catalogue. A no-op from any other window. */
  publishCommandCatalog: (entries: readonly CommandCatalogEntry[]): Promise<void> =>
    ipcRenderer.invoke(IPC.commands.publish, entries),
  /** The catalogue as last published, or `null` while the shell has not started. */
  getCommandCatalog: (): Promise<CommandCatalogEntry[] | null> =>
    ipcRenderer.invoke(IPC.commands.catalog),
  onCommandCatalog: (callback: (entries: CommandCatalogEntry[]) => void): Unsubscribe =>
    subscribe<CommandCatalogEntry[]>(IPC.commands.changed, callback),
  // ---------------------------------------------------------------- terminal
  createTerminal: (request: TerminalCreateRequest): Promise<TerminalCreateResult> =>
    ipcRenderer.invoke(IPC.terminal.create, request),
  writeTerminal: (id: number, data: string): Promise<void> =>
    ipcRenderer.invoke(IPC.terminal.write, id, assertString(data, 'data')),
  /**
   * Reports the emulator's measured size, in character cells.
   *
   * This is what makes a wrapped line re-wrap and a full-width prompt redraw when
   * the panel is resized, so it is sent whenever the size actually changes rather
   * than on every pointer move.
   */
  resizeTerminal: (id: number, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke(
      IPC.terminal.resize,
      id,
      Math.max(1, Math.round(Number(cols) || 1)),
      Math.max(1, Math.round(Number(rows) || 1))
    ),
  killTerminal: (id: number): Promise<void> => ipcRenderer.invoke(IPC.terminal.kill, id),
  onTerminalData: (callback: (event: TerminalDataEvent) => void): Unsubscribe =>
    subscribe<TerminalDataEvent>(IPC.terminal.data, callback),
  onTerminalExit: (callback: (event: TerminalExitEvent) => void): Unsubscribe =>
    subscribe<TerminalExitEvent>(IPC.terminal.exit, callback),

  // -------------------------------------------------------------- protocol
  onProtocolOpenFile: (callback: (filePath: string) => void): Unsubscribe =>
    subscribe<string>(IPC.protocol.openFile, callback),
  onProtocolOpenProject: (callback: (projectPath: string) => void): Unsubscribe =>
    subscribe<string>(IPC.protocol.openProject, callback),
  takePendingProtocolRequests: (): Promise<Array<{ kind: 'open' | 'project'; path: string; line?: number; column?: number }>> =>
    ipcRenderer.invoke(IPC.protocol.pending),

  // ------------------------------------------------------------ menu / window
  onMenuCommand: (callback: (commandId: string) => void): Unsubscribe => subscribe<string>('menu:command', callback),
  onBeforeClose: (callback: () => void): Unsubscribe => subscribe<unknown>('app:beforeClose', () => callback())
};

export type EukoliaApi = typeof eukoliaApi;

contextBridge.exposeInMainWorld('eukoliaApi', eukoliaApi);
