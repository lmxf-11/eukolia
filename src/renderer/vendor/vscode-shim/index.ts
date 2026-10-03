/**
 * Eukolia — VS Code compatibility layer.
 *
 * Ported extension code (`vendor/latex-workshop`, `vendor/hypersnips`, …) imports
 * this module through the `vscode` path alias configured in `tsconfig.json`,
 * `vite.config.ts` and `vitest.config.ts`.
 *
 * The layer is intentionally *real*: positions, ranges, URIs, events and the
 * configuration/command/provider plumbing are fully implemented and backed by
 * Eukolia services through `installVscodeHost`. Replacing the VS Code adapter
 * while keeping the reusable implementation is required by Instructions.md §13.
 */

export { Position, Range, Selection, Location as ShimLocation, offsetAt, positionAt, splitLines, ShimTextDocument } from './position';
export { Uri } from './uri';
export { DisposableStore, EventEmitter, createDeferred, toDisposable, type Disposable, type Event, type Listener } from './events';
export * from './language';
export {
  ConfigurationTarget,
  EndOfLine,
  ExtensionKind,
  ExtensionMode,
  FileType,
  ProgressLocation,
  StatusBarAlignment,
  ViewColumn,
  getHost,
  installVscodeHost,
  isHostInstalled,
  type FileStatLike,
  type FileSystemLike,
  type InputBoxOptions,
  type OutputChannel,
  type QuickPickItem,
  type QuickPickOptions,
  type StatusBarItem,
  type TextDocumentContentChangeEvent,
  type TextEditorEdit,
  type TextEditorLike,
  type VscodeHost,
  type WorkspaceFolder
} from './host';
export { commands, env, languages, window } from './window';
export { FileSystemWatcher, createFileSystemWatcher, globMatches, globToRegExp, notifyFileSystemWatchers, workspace, type WorkspaceConfiguration } from './workspace';
export {
  collect,
  completionProviders,
  definitionProviders,
  documentFormattingProviders,
  documentLinkProviders,
  documentRangeFormattingProviders,
  documentSymbolProviders,
  foldingRangeProviders,
  hoverProviders,
  referenceProviders,
  semanticTokensProviders,
  type CompletionContext,
  type CompletionItemProvider,
  type DefinitionProvider,
  type DocumentFormattingEditProvider,
  type DocumentLinkProvider,
  type DocumentRangeFormattingEditProvider,
  type DocumentSemanticTokensProvider,
  type DocumentSymbolProvider,
  type FoldingRangeProvider,
  type HoverProvider,
  type ReferenceProvider
} from './providers';

// ---------------------------------------------------------------------------
// Value types that ported code constructs but Eukolia has no use for beyond
// carrying data. They are real classes, not stubs.
// ---------------------------------------------------------------------------

import { Uri } from './uri';

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');
  constructor(
    public readonly id: string,
    public readonly color?: ThemeColor
  ) {}
}

export class RelativePattern {
  constructor(
    public readonly base: unknown,
    public readonly pattern: string
  ) {}
}

export class CancellationTokenSource {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();

  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    }
  };

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.token.isCancellationRequested = true;
    for (const listener of [...this.listeners]) listener();
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export const CancellationToken = {
  None: {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} })
  }
};

export class TreeItem {
  description?: string | boolean;
  resourceUri?: unknown;
  contextValue?: string;
  tooltip?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  iconPath?: unknown;
  collapsibleState?: number;

  constructor(
    public label: string,
    collapsibleState?: number
  ) {
    this.collapsibleState = collapsibleState;
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export class EventEmitterNamespace {
  constructor(public readonly name: string) {}
}

/** `vscode.ExtensionContext`, realised against Eukolia's own services. */
export interface ExtensionContext {
  readonly subscriptions: Disposable[];
  readonly extensionPath: string;
  readonly extensionUri: Uri;
  readonly globalState: Memento;
  readonly workspaceState: Memento;
  readonly storageUri: Uri | undefined;
  readonly globalStorageUri: Uri;
  readonly logUri: Uri;
  asAbsolutePath(relativePath: string): string;
}

export interface Memento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
}

export class MemoryMemento implements Memento {
  private readonly store = new Map<string, unknown>();

  constructor(initial?: Record<string, unknown>) {
    if (initial) for (const [k, v] of Object.entries(initial)) this.store.set(k, v);
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.store.delete(key);
    else this.store.set(key, value);
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}
