/**
 * Eukolia — VS Code compatibility layer: host registration.
 *
 * Ported extension code calls `vscode.workspace`, `vscode.window` and
 * `vscode.commands`. Instead of faking those, Eukolia registers a real `host`
 * whose members are backed by Eukolia's own services (settings manager, document
 * store, command registry, output panel, dialogs).
 *
 * Anything the host has not been connected to yet fails loudly rather than
 * silently returning empty results, so unimplemented integration is visible
 * instead of masquerading as working functionality.
 */

import { EventEmitter, type Event } from './events';
import type { Range } from './position';
import type { ShimTextDocument } from './position';
import { Uri } from './uri';

export interface TextEditorLike {
  readonly document: ShimTextDocument;
  selection: { anchor: unknown; active: unknown; start: unknown; end: unknown; isEmpty: boolean };
  selections: Array<{ anchor: unknown; active: unknown; start: unknown; end: unknown; isEmpty: boolean }>;
  readonly visibleRanges: Range[];
  options: { tabSize: number; insertSpaces: boolean };
  edit(callback: (builder: TextEditorEdit) => void): Promise<boolean>;
  revealRange(range: Range, revealType?: number): void;
  setDecorations(type: unknown, decorations: readonly unknown[]): void;
}

export interface TextEditorEdit {
  replace(location: Range | { start: unknown; end: unknown }, value: string): void;
  insert(position: unknown, value: string): void;
  delete(location: Range | { start: unknown; end: unknown }): void;
  setEndOfLine(eol: number): void;
}

export interface OutputChannel {
  readonly name: string;
  append(value: string): void;
  appendLine(value: string): void;
  replace(value: string): void;
  clear(): void;
  show(preserveFocus?: boolean): void;
  hide(): void;
  dispose(): void;
}

export interface StatusBarItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  color: string | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  alwaysShow?: boolean;
}

export interface QuickPickOptions {
  title?: string;
  placeHolder?: string;
  canPickMany?: boolean;
  ignoreFocusOut?: boolean;
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
}

export interface InputBoxOptions {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  valueSelection?: [number, number];
  password?: boolean;
  ignoreFocusOut?: boolean;
  validateInput?: (value: string) => string | undefined | null | Promise<string | undefined | null>;
}

export interface WorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

export interface FileStatLike {
  type: number;
  ctime: number;
  mtime: number;
  size: number;
}

export interface FileSystemLike {
  stat(uri: Uri): Promise<FileStatLike>;
  readFile(uri: Uri): Promise<Uint8Array>;
  writeFile(uri: Uri, content: Uint8Array): Promise<void>;
  delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void>;
  createDirectory(uri: Uri): Promise<void>;
  readDirectory(uri: Uri): Promise<Array<[string, number]>>;
  rename(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void>;
  copy(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void>;
  isWritableFileSystem(scheme: string): boolean | undefined;
}

/** FileType values from the VS Code API. */
export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

/** ProgressLocation values from the VS Code API. */
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 } as const;

export const EndOfLine = { LF: 1, CRLF: 2 } as const;

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

export const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const;
export const ExtensionKind = { UI: 1, Workspace: 2 } as const;

/**
 * The bridge between the compatibility layer and Eukolia. The renderer installs
 * a real implementation during startup (`installVscodeHost`).
 */
export interface VscodeHost {
  getConfigurationValue(section: string, key: string): unknown;
  setConfigurationValue(section: string, key: string, value: unknown, target?: number): Promise<void>;
  readonly onDidChangeConfiguration: Event<{ affectsConfiguration(section: string): boolean }>;

  readonly documents: ShimTextDocument[];
  readonly onDidOpenTextDocument: Event<ShimTextDocument>;
  readonly onDidCloseTextDocument: Event<ShimTextDocument>;
  readonly onDidChangeTextDocument: Event<{ document: ShimTextDocument; contentChanges: readonly TextDocumentContentChangeEvent[] }>;
  readonly onDidSaveTextDocument: Event<ShimTextDocument>;

  get activeTextEditor(): TextEditorLike | undefined;
  get visibleTextEditors(): TextEditorLike[];
  readonly onDidChangeActiveTextEditor: Event<TextEditorLike | undefined>;
  readonly onDidChangeTextEditorSelection: Event<{ textEditor: TextEditorLike; kind: number; selections: readonly unknown[] }>;

  showTextDocument(uri: Uri, options?: { viewColumn?: number; preserveFocus?: boolean; selection?: Range; preview?: boolean }): Promise<TextEditorLike>;

  showInformationMessage(message: string, ...actions: string[]): Promise<string | undefined>;
  showWarningMessage(message: string, ...actions: string[]): Promise<string | undefined>;
  showErrorMessage(message: string, ...actions: string[]): Promise<string | undefined>;
  showQuickPick<T extends QuickPickItem>(items: readonly T[], options?: QuickPickOptions): Promise<T | T[] | undefined>;
  showInputBox(options?: InputBoxOptions): Promise<string | undefined>;
  showOpenDialog(options: unknown): Promise<Uri[] | undefined>;
  showSaveDialog(options: unknown): Promise<Uri | undefined>;

  createOutputChannel(name: string): OutputChannel;
  createStatusBarItem(alignment?: number, priority?: number): StatusBarItem;
  setStatusBarMessage(text: string, timeoutOrThenable?: number | PromiseLike<unknown>): { dispose(): void };
  withProgress<T>(
    options: unknown,
    task: (
      progress: unknown,
      token: { isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => { dispose(): void } }
    ) => PromiseLike<T>
  ): Promise<T>;

  readonly workspaceFolders: readonly WorkspaceFolder[] | undefined;
  findFiles(include: string, exclude?: string | null, maxResults?: number): Promise<Uri[]>;
  asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string;
  readonly fs: FileSystemLike;

  registerCommand(id: string, handler: (...args: unknown[]) => unknown): { dispose(): void };
  registerTextDocumentContentProvider(scheme: string, provider: { provideTextDocumentContent(uri: Uri): string | Promise<string> }): { dispose(): void };

  readonly onDidChangeWorkspaceFolders: Event<{ added: readonly WorkspaceFolder[]; removed: readonly WorkspaceFolder[] }>;

  /** Messages emitted by ported code that should reach the Eukolia log. */
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface TextDocumentContentChangeEvent {
  readonly range: Range;
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

let host: VscodeHost | null = null;

export function installVscodeHost(implementation: VscodeHost): void {
  host = implementation;
}

export function isHostInstalled(): boolean {
  return host !== null;
}

export function getHost(): VscodeHost {
  if (!host) {
    throw new Error(
      'Eukolia VS Code compatibility host is not installed. ' +
        'Call installVscodeHost() during renderer startup before using ported extension code.'
    );
  }
  return host;
}

/** Convenience emitters used by hosts that want lazy events. */
export function makeEmitter<T>(): EventEmitter<T> {
  return new EventEmitter<T>();
}
