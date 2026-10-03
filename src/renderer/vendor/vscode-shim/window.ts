/**
 * Eukolia — VS Code compatibility layer: `window` and `commands` namespaces.
 * Delegates to the installed `VscodeHost`.
 */

import { getHost, ProgressLocation, StatusBarAlignment, type InputBoxOptions, type OutputChannel, type QuickPickItem, type QuickPickOptions, type StatusBarItem } from './host';
import type { Range } from './position';
import { Uri } from './uri';

export { ProgressLocation, StatusBarAlignment, ViewColumn, EndOfLine, ExtensionMode, ExtensionKind } from './host';

export const window = {
  get activeTextEditor() {
    return getHost().activeTextEditor;
  },

  get visibleTextEditors() {
    return getHost().visibleTextEditors;
  },

  get onDidChangeActiveTextEditor() {
    return getHost().onDidChangeActiveTextEditor;
  },

  get onDidChangeTextEditorSelection() {
    return getHost().onDidChangeTextEditorSelection;
  },

  showTextDocument(uri: Uri | string, options?: { viewColumn?: number; preserveFocus?: boolean; selection?: Range; preview?: boolean }) {
    const target = typeof uri === 'string' ? Uri.file(uri) : uri;
    return getHost().showTextDocument(target, options);
  },

  showInformationMessage(message: string, ...actions: string[]) {
    return getHost().showInformationMessage(message, ...actions);
  },

  showWarningMessage(message: string, ...actions: string[]) {
    return getHost().showWarningMessage(message, ...actions);
  },

  showErrorMessage(message: string, ...actions: string[]) {
    return getHost().showErrorMessage(message, ...actions);
  },

  showQuickPick<T extends QuickPickItem>(items: readonly T[] | Promise<readonly T[]>, options?: QuickPickOptions): Promise<T | T[] | undefined> {
    return Promise.resolve(items).then((resolved) => getHost().showQuickPick(resolved, options));
  },

  showInputBox(options?: InputBoxOptions): Promise<string | undefined> {
    return getHost().showInputBox(options);
  },

  showOpenDialog(options: unknown) {
    return getHost().showOpenDialog(options);
  },

  showSaveDialog(options: unknown) {
    return getHost().showSaveDialog(options);
  },

  createOutputChannel(name: string): OutputChannel {
    return getHost().createOutputChannel(name);
  },

  createStatusBarItem(alignment: number = StatusBarAlignment.Left, priority?: number): StatusBarItem {
    return getHost().createStatusBarItem(alignment, priority);
  },

  setStatusBarMessage(text: string, timeoutOrThenable?: number | PromiseLike<unknown>) {
    return getHost().setStatusBarMessage(text, timeoutOrThenable);
  },

  withProgress<T>(
    options: unknown,
    task: (progress: unknown, token: { isCancellationRequested: boolean; onCancellationRequested: (l: () => void) => { dispose(): void } }) => PromiseLike<T>
  ): Promise<T> {
    return getHost().withProgress(options, task);
  },

  createTextEditorDecorationType(options: unknown) {
    return { key: JSON.stringify(options), dispose() {} };
  },

  get activeColorTheme() {
    return { kind: 1 };
  }
};

const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    const previous = commandRegistry.get(id);
    if (previous) {
      getHost().log('warn', `Command "${id}" was already registered; the previous handler stays registered with the host.`);
    }
    commandRegistry.set(id, handler);
    return getHost().registerCommand(id, handler);
  },

  executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
    const local = commandRegistry.get(id);
    if (local) return Promise.resolve(local(...args) as T);
    const hostExecute = (getHost() as unknown as { executeCommand?<R>(command: string, ...rest: unknown[]): Promise<R> }).executeCommand;
    if (hostExecute) return hostExecute.call(getHost(), id, ...args) as Promise<T>;
    return Promise.reject(new Error(`Command "${id}" is not registered`));
  },

  getCommands(): Promise<string[]> {
    return Promise.resolve([...commandRegistry.keys()]);
  }
};

export const env = {
  appName: 'Eukolia',
  language: 'en',
  machineId: 'eukolia-local',
  sessionId: 'eukolia-local',
  clipboard: {
    async readText(): Promise<string> {
      return navigator.clipboard.readText();
    },
    async writeText(value: string): Promise<void> {
      return navigator.clipboard.writeText(value);
    }
  },
  openExternal(uri: Uri): Promise<boolean> {
    window.showInformationMessage(`Refusing to open external link from ported code: ${uri.toString()}`);
    return Promise.resolve(false);
  },
  asExternalUri(uri: Uri): Promise<Uri> {
    return Promise.resolve(uri);
  }
};

export const languages = {
  match(selector: unknown, document: unknown): number {
    return selectorLanguageId(selector) === (document as { languageId?: string })?.languageId ? 10 : 0;
  },
  setLanguageConfiguration() {
    return { dispose() {} };
  },
  createDiagnosticCollection(name: string) {
    return (getHost() as unknown as { createDiagnosticCollection(name: string): unknown }).createDiagnosticCollection(name);
  }
};

function selectorLanguageId(selector: unknown): string | undefined {
  if (typeof selector === 'string') return selector;
  if (Array.isArray(selector)) return selectorLanguageId(selector[0]);
  if (selector && typeof selector === 'object' && 'language' in selector) {
    return (selector as { language?: string }).language;
  }
  return undefined;
}

export { ProgressLocation as _ProgressLocation };
