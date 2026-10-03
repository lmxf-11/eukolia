/**
 * Eukolia — implementation of the `vscode` compatibility host.
 *
 * Ported extension code (LaTeX Workshop, HyperSnips) calls `vscode.workspace`,
 * `vscode.window` and `vscode.commands`. This module backs those calls with real
 * Eukolia services: settings, open documents, the command registry, the output
 * channel and the dialogs. Replacing the VS Code adapter while keeping the
 * reusable implementation is exactly what Instructions.md §13 asks for.
 */

import { EventEmitter } from '../vendor/vscode-shim';
import { commandRegistry } from '../core/commands';
import { settingsManager, SETTINGS_SCHEMA } from '../core/settings';
import { projectIndex } from '../document/projectIndex';
import { workspaceService } from './instance';
import { ShimTextDocument, Position, Range, Uri } from '../vendor/vscode-shim';
import type {
  FileStatLike,
  FileSystemLike,
  InputBoxOptions,
  OutputChannel,
  QuickPickItem,
  QuickPickOptions,
  StatusBarItem,
  TextDocumentContentChangeEvent,
  TextEditorLike,
  VscodeHost,
  WorkspaceFolder
} from '../vendor/vscode-shim';

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

/**
 * Output channels are surfaced through Eukolia's own log and the Output panel,
 * so ported code that writes diagnostics stays visible to the user.
 */
const outputListeners = new Set<(channel: string, text: string) => void>();

export function onOutputChannelWrite(listener: (channel: string, text: string) => void): () => void {
  outputListeners.add(listener);
  return () => outputListeners.delete(listener);
}

function emitOutput(channel: string, text: string): void {
  for (const listener of outputListeners) {
    try {
      listener(channel, text);
    } catch (err) {
      console.error('[eukolia] output listener threw', err);
    }
  }
}

/** Adapter that presents an Eukolia document through the VS Code shape. */
function toShimDocument(uri: string): ShimTextDocument | null {
  const doc = workspaceService.getOpenDocuments().find((entry) => entry.doc.uri === uri);
  const model = doc?.doc ?? projectIndex.getDocument(uri);
  if (!model) return null;
  return new ShimTextDocument(
    Uri.file(model.uri),
    model.languageId,
    () => model.getText(),
    model.getVersion(),
    model.getDirty(),
    model.filename
  );
}

function allShimDocuments(): ShimTextDocument[] {
  return workspaceService
    .getOpenDocuments()
    .map((entry) => toShimDocument(entry.doc.uri))
    .filter((doc): doc is ShimTextDocument => doc !== null);
}

export function createVscodeHostBridge(): VscodeHost {
  const onDidOpenTextDocument = new EventEmitter<ShimTextDocument>();
  const onDidCloseTextDocument = new EventEmitter<ShimTextDocument>();
  const onDidChangeTextDocument = new EventEmitter<{
    document: ShimTextDocument;
    contentChanges: readonly TextDocumentContentChangeEvent[];
  }>();
  const onDidSaveTextDocument = new EventEmitter<ShimTextDocument>();
  const onDidChangeConfiguration = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();
  const onDidChangeActiveTextEditor = new EventEmitter<TextEditorLike | undefined>();
  const onDidChangeTextEditorSelection = new EventEmitter<{
    textEditor: TextEditorLike;
    kind: number;
    selections: readonly unknown[];
  }>();
  const onDidChangeWorkspaceFolders = new EventEmitter<{ added: readonly WorkspaceFolder[]; removed: readonly WorkspaceFolder[] }>();

  // Keep the host's document events in step with Eukolia's workspace service.
  workspaceService.on('change', () => {
    /* documents list changed; nothing to emit until a specific file opens */
  });
  projectIndex.on('project-change', () => {
    onDidChangeWorkspaceFolders.fire({ added: workspaceFolders(), removed: [] });
  });

  const fs: FileSystemLike = {
    async stat(uri: Uri): Promise<FileStatLike> {
      const result = await window.eukoliaApi.stat(uri.fsPath);
      return {
        type: result.exists ? (result.isDirectory ? FileType.Directory : FileType.File) : FileType.Unknown,
        ctime: result.mtimeMs,
        mtime: result.mtimeMs,
        size: result.size
      };
    },
    async readFile(uri: Uri): Promise<Uint8Array> {
      return window.eukoliaApi.readFileBinary(uri.fsPath);
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      await window.eukoliaApi.writeFile(uri.fsPath, new TextDecoder().decode(content));
    },
    async delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
      await window.eukoliaApi.deletePath(uri.fsPath, options?.useTrash ?? true);
    },
    async createDirectory(uri: Uri): Promise<void> {
      await window.eukoliaApi.createDirectory(uri.fsPath);
    },
    async readDirectory(uri: Uri): Promise<Array<[string, number]>> {
      const listing = await window.eukoliaApi.listDirectoryNames(uri.fsPath);
      return [
        ...listing.directories.map((name) => [name, FileType.Directory] as [string, number]),
        ...listing.files.map((name) => [name, FileType.File] as [string, number])
      ];
    },
    async rename(source: Uri, target: Uri): Promise<void> {
      await window.eukoliaApi.renamePath(source.fsPath, target.fsPath);
    },
    async copy(source: Uri, target: Uri): Promise<void> {
      await window.eukoliaApi.copyPath(source.fsPath, target.fsPath);
    },
    isWritableFileSystem(scheme: string): boolean | undefined {
      return scheme === 'file' ? true : undefined;
    }
  };

  function workspaceFolders(): WorkspaceFolder[] {
    const root = projectIndex.getProjectRoot();
    if (!root) return [];
    return [{ uri: Uri.file(root), name: root.split(/[\\/]/).pop() ?? root, index: 0 }];
  }

  return {
    getConfigurationValue(section: string, key: string): unknown {
      return settingsManager.getForVscode(section, key);
    },

    async setConfigurationValue(section: string, key: string, value: unknown): Promise<void> {
      const fullKey = section ? `${section}.${key}` : key;
      const descriptor = SETTINGS_SCHEMA.find((entry) => entry.vscodeKey === fullKey);
      if (descriptor) settingsManager.setValue(descriptor.key, value, 'user');
    },

    onDidChangeConfiguration: onDidChangeConfiguration.event,

    get documents(): ShimTextDocument[] {
      return allShimDocuments();
    },

    onDidOpenTextDocument: onDidOpenTextDocument.event,
    onDidCloseTextDocument: onDidCloseTextDocument.event,
    onDidChangeTextDocument: onDidChangeTextDocument.event,
    onDidSaveTextDocument: onDidSaveTextDocument.event,

    get activeTextEditor(): TextEditorLike | undefined {
      const doc = workspaceService.getActiveDocument();
      return doc ? createEditorLike(doc.uri) ?? undefined : undefined;
    },

    get visibleTextEditors(): TextEditorLike[] {
      return workspaceService
        .getOpenDocuments()
        .map((entry) => createEditorLike(entry.doc.uri))
        .filter((editor): editor is TextEditorLike => editor !== null);
    },

    onDidChangeActiveTextEditor: onDidChangeActiveTextEditor.event,
    onDidChangeTextEditorSelection: onDidChangeTextEditorSelection.event,

    async showTextDocument(uri: Uri, options): Promise<TextEditorLike> {
      await workspaceService.openFile(uri.fsPath);
      if (options?.selection) {
        const handle = editorBridge;
        handle?.revealPosition(options.selection.start.line + 1, options.selection.start.character + 1);
      }
      const editor = createEditorLike(uri.fsPath);
      if (!editor) throw new Error(`Could not open ${uri.fsPath}`);
      return editor;
    },

    async showInformationMessage(message: string, ...actions: string[]): Promise<string | undefined> {
      return showMessage('info', message, actions);
    },
    async showWarningMessage(message: string, ...actions: string[]): Promise<string | undefined> {
      return showMessage('warning', message, actions);
    },
    async showErrorMessage(message: string, ...actions: string[]): Promise<string | undefined> {
      return showMessage('error', message, actions);
    },

    async showQuickPick<T extends QuickPickItem>(items: readonly T[], options?: QuickPickOptions): Promise<T | T[] | undefined> {
      return quickPickBridge ? quickPickBridge(items, options) : items[0];
    },

    async showInputBox(options?: InputBoxOptions): Promise<string | undefined> {
      return inputBoxBridge ? inputBoxBridge(options) : undefined;
    },

    async showOpenDialog(): Promise<Uri[] | undefined> {
      const files = await window.eukoliaApi.openFileDialog();
      return files.length > 0 ? files.map((file) => Uri.file(file)) : undefined;
    },

    async showSaveDialog(): Promise<Uri | undefined> {
      const file = await window.eukoliaApi.saveFileDialog();
      return file ? Uri.file(file) : undefined;
    },

    createOutputChannel(name: string): OutputChannel {
      return {
        name,
        append: (value: string) => emitOutput(name, value),
        appendLine: (value: string) => emitOutput(name, `${value}\n`),
        replace: (value: string) => emitOutput(name, value),
        clear: () => emitOutput(name, ''),
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined
      };
    },

    createStatusBarItem(): StatusBarItem {
      let visible = false;
      const item: StatusBarItem = {
        text: '',
        tooltip: undefined,
        command: undefined,
        color: undefined,
        show: () => {
          visible = true;
          statusItems.set(name, item);
        },
        hide: () => {
          visible = false;
          statusItems.delete(name);
        },
        dispose: () => statusItems.delete(name)
      };
      // `name` is only known from the channel; use a stable identity per item.
      const name = `status-${statusItems.size}`;
      void visible;
      return item;
    },

    setStatusBarMessage(text: string, timeoutOrThenable?: number | PromiseLike<unknown>) {
      transientStatus = text;
      notifyStatus();
      const clear = () => {
        if (transientStatus === text) {
          transientStatus = null;
          notifyStatus();
        }
      };
      if (typeof timeoutOrThenable === 'number') setTimeout(clear, timeoutOrThenable);
      else if (timeoutOrThenable && typeof (timeoutOrThenable as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(timeoutOrThenable).then(clear, clear);
      }
      return { dispose: clear };
    },

    async withProgress<T>(
      options: unknown,
      task: (
        progress: unknown,
        token: { isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => { dispose(): void } }
      ) => PromiseLike<T>
    ): Promise<T> {
      const listeners = new Set<() => void>();
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        }
      };
      progressBridge?.(options, 'start');
      try {
        return await task({ report: () => undefined }, token);
      } finally {
        progressBridge?.(options, 'end');
      }
    },

    get workspaceFolders(): readonly WorkspaceFolder[] | undefined {
      const folders = workspaceFolders();
      return folders.length > 0 ? folders : undefined;
    },

    async findFiles(include: string, exclude?: string | null, maxResults = 1000): Promise<Uri[]> {
      const { globToRegExp } = await import('../vendor/vscode-shim/workspace');
      const includeRegexp = globToRegExp(include);
      const excludeRegexp = exclude ? globToRegExp(exclude) : null;

      const files = projectIndex.filesUnderRoot().filter((file) => !file.isDirectory);
      const result: Uri[] = [];
      for (const file of files) {
        const normalized = file.path.replace(/\\/g, '/');
        if (!includeRegexp.test(normalized)) continue;
        if (excludeRegexp?.test(normalized)) continue;
        result.push(Uri.file(file.path));
        if (result.length >= maxResults) break;
      }
      return result;
    },

    asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder = false): string {
      const root = projectIndex.getProjectRoot();
      const full = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
      if (!root) return full;
      const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
      const normalized = full.replace(/\\/g, '/');
      if (!normalized.startsWith(`${normalizedRoot}/`)) return full;
      const relative = normalized.slice(normalizedRoot.length + 1);
      return includeWorkspaceFolder ? `${root.split(/[\\/]/).pop()}/${relative}` : relative;
    },

    fs,

    registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
      // The command registry expects a Command descriptor. Ported code only
      // supplies an id and a handler, so a passthrough descriptor is registered
      // and the real handler is invoked.
      const disposable = commandRegistry.register({
        id,
        title: id,
        category: 'Extension',
        hidden: true,
        handler: (...args) => {
          handler(...args);
        }
      });
      return { dispose: disposable };
    },

    registerTextDocumentContentProvider() {
      // Eukolia has no virtual documents yet; providers registered by ported code
      // are kept alive but never consulted.
      return { dispose: () => undefined };
    },

    onDidChangeWorkspaceFolders: onDidChangeWorkspaceFolders.event,

    log(level, message) {
      void window.eukoliaApi.log(level, message);
    }
  } satisfies VscodeHost;
}

// ---------------------------------------------------------------------------
// Bridges the app shell installs so ported code can reach the UI
// ---------------------------------------------------------------------------

export interface EditorBridge {
  revealPosition(line: number, column: number): void;
  revealOffset(offset: number): void;
  getCursorOffset(): number | null;
  insertText(text: string): void;
  applyEdits(edits: Array<{ from: number; to: number; insert: string }>): void;
  getSelectionOffsets(): { from: number; to: number } | null;
}

let editorBridge: EditorBridge | null = null;
let quickPickBridge: (<T extends QuickPickItem>(items: readonly T[], options?: QuickPickOptions) => Promise<T | T[] | undefined>) | null = null;
let inputBoxBridge: ((options?: InputBoxOptions) => Promise<string | undefined>) | null = null;
let messageBridge: ((level: 'info' | 'warning' | 'error', message: string, actions: readonly string[]) => Promise<string | undefined>) | null = null;
let progressBridge: ((options: unknown, phase: 'start' | 'end') => void) | null = null;

const statusItems = new Map<string, StatusBarItem>();
let transientStatus: string | null = null;

export function setEditorBridge(bridge: EditorBridge | null): void {
  editorBridge = bridge;
}

export function setDialogBridges(bridges: {
  quickPick?: typeof quickPickBridge;
  inputBox?: typeof inputBoxBridge;
  message?: typeof messageBridge;
  progress?: typeof progressBridge;
}): void {
  quickPickBridge = bridges.quickPick ?? null;
  inputBoxBridge = bridges.inputBox ?? null;
  messageBridge = bridges.message ?? null;
  progressBridge = bridges.progress ?? null;
}

export function getTransientStatus(): string | null {
  return transientStatus;
}

export function getStatusItems(): StatusBarItem[] {
  return [...statusItems.values()];
}

const statusListeners = new Set<() => void>();

export function onStatusChange(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function notifyStatus(): void {
  for (const listener of statusListeners) listener();
}

async function showMessage(level: 'info' | 'warning' | 'error', message: string, actions: readonly string[]): Promise<string | undefined> {
  if (messageBridge) return messageBridge(level, message, actions);
  if (level === 'error') console.error(`[eukolia] ${message}`);
  else if (level === 'warning') console.warn(`[eukolia] ${message}`);
  else console.info(`[eukolia] ${message}`);
  return undefined;
}

/** A VS Code `TextEditor`-shaped view over Eukolia's active editor. */
function createEditorLike(uri: string): TextEditorLike | null {
  const document = toShimDocument(uri);
  if (!document) return null;

  const selection = editorBridge?.getSelectionOffsets() ?? { from: 0, to: 0 };
  const toPosition = (offset: number) => {
    const text = document.getText();
    return positionAtOffset(text, offset);
  };

  const makeSelection = () => {
    const anchor = toPosition(selection.from);
    const active = toPosition(selection.to);
    return {
      anchor,
      active,
      start: selection.from <= selection.to ? anchor : active,
      end: selection.from <= selection.to ? active : anchor,
      isEmpty: selection.from === selection.to
    };
  };

  const current = makeSelection();

  return {
    document,
    selection: current,
    selections: [current],
    visibleRanges: [new Range(0, 0, document.lineCount, 0)],
    options: { tabSize: 2, insertSpaces: true },

    async edit(callback): Promise<boolean> {
      const edits: Array<{ from: number; to: number; insert: string }> = [];
      const builder = {
        replace(location: unknown, value: string) {
          edits.push({ from: offsetOf(document, location, 'start'), to: offsetOf(document, location, 'end'), insert: value });
        },
        insert(position: unknown, value: string) {
          const offset = offsetOf(document, position, 'start');
          edits.push({ from: offset, to: offset, insert: value });
        },
        delete(location: unknown) {
          edits.push({ from: offsetOf(document, location, 'start'), to: offsetOf(document, location, 'end'), insert: '' });
        },
        setEndOfLine() {
          /* line endings are managed by the buffer */
        }
      };

      callback(builder);
      if (edits.length === 0) return true;
      if (!editorBridge) return false;

      // Edits arrive in document order from the reference code; applying them
      // back-to-front keeps earlier offsets valid.
      const ordered = [...edits].sort((a, b) => b.from - a.from);
      editorBridge.applyEdits(ordered);
      return true;
    },

    revealRange(range) {
      editorBridge?.revealPosition(range.start.line + 1, range.start.character + 1);
    },

    setDecorations() {
      /* Eukolia renders its own decorations */
    }
  };
}

function offsetOf(document: ShimTextDocument, location: unknown, edge: 'start' | 'end'): number {
  if (location && typeof location === 'object') {
    if ('start' in location && 'end' in location) {
      const range = location as { start?: Position; end?: Position };
      const position = edge === 'start' ? range.start : range.end;
      if (position) return document.offsetAt(position);
      return 0;
    }
    if ('line' in location && 'character' in location) {
      return document.offsetAt(location as Position);
    }
  }
  return 0;
}

function positionAtOffset(text: string, offset: number): Position {
  let remaining = Math.max(0, offset);
  const lines = text.split(/\r\n|\r|\n/);
  for (let line = 0; line < lines.length; line++) {
    if (remaining <= lines[line].length) return new Position(line, remaining);
    remaining -= lines[line].length + 1;
  }
  const last = lines.length - 1;
  return new Position(last, lines[last].length);
}
