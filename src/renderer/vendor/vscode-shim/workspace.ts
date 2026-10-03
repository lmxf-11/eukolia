/**
 * Eukolia — VS Code compatibility layer: `workspace` namespace.
 * Delegates to the installed `VscodeHost`.
 */

import { EventEmitter, toDisposable, type Disposable } from './events';
import { getHost, type WorkspaceFolder } from './host';
import { Uri } from './uri';

export { FileType, ConfigurationTarget } from './host';

export interface WorkspaceConfiguration {
  get<T>(section: string): T | undefined;
  get<T>(section: string, defaultValue: T): T;
  has(section: string): boolean;
  update(section: string, value: unknown, target?: number): Promise<void>;
  readonly [key: string]: unknown;
}

class Configuration implements WorkspaceConfiguration {
  constructor(private readonly section: string) {}

  get<T>(key: string, defaultValue?: T): T | undefined {
    const value = getHost().getConfigurationValue(this.section, key);
    return (value === undefined ? defaultValue : (value as T));
  }

  has(key: string): boolean {
    return getHost().getConfigurationValue(this.section, key) !== undefined;
  }

  update(key: string, value: unknown, target?: number): Promise<void> {
    return getHost().setConfigurationValue(this.section, key, value, target);
  }

  [key: string]: unknown;
}

export const workspace = {
  get workspaceFolders(): readonly WorkspaceFolder[] | undefined {
    return getHost().workspaceFolders;
  },

  get rootPath(): string | undefined {
    const folders = getHost().workspaceFolders;
    return folders && folders.length ? folders[0].uri.fsPath : undefined;
  },

  get name(): string | undefined {
    const folders = getHost().workspaceFolders;
    return folders && folders.length ? folders[0].name : undefined;
  },

  get textDocuments(): readonly unknown[] {
    return getHost().documents;
  },

  get fs() {
    return getHost().fs;
  },

  get isTrusted(): boolean {
    return true;
  },

  getConfiguration(section = ''): WorkspaceConfiguration {
    return new Configuration(section);
  },

  findFiles(include: string, exclude?: string | null, maxResults?: number): Promise<Uri[]> {
    return getHost().findFiles(include, exclude, maxResults);
  },

  asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string {
    return getHost().asRelativePath(pathOrUri, includeWorkspaceFolder);
  },

  openTextDocument(uriOrPath: Uri | string | { language?: string; content?: string }) {
    return (getHost() as unknown as {
      openTextDocument(u: unknown): Promise<unknown>;
    }).openTextDocument(uriOrPath);
  },

  applyEdit() {
    return (getHost() as unknown as { applyEdit(edit: unknown): Promise<boolean> }).applyEdit(undefined);
  },

  get onDidOpenTextDocument() {
    return getHost().onDidOpenTextDocument;
  },
  get onDidCloseTextDocument() {
    return getHost().onDidCloseTextDocument;
  },
  get onDidChangeTextDocument() {
    return getHost().onDidChangeTextDocument;
  },
  get onDidSaveTextDocument() {
    return getHost().onDidSaveTextDocument;
  },
  get onDidChangeConfiguration() {
    return getHost().onDidChangeConfiguration;
  },
  get onDidChangeWorkspaceFolders() {
    return getHost().onDidChangeWorkspaceFolders;
  },

  createFileSystemWatcher(globPattern: string) {
    return createFileSystemWatcher(globPattern);
  }
};

const watchers = new Map<string, FileSystemWatcher[]>();

export function notifyFileSystemWatchers(uri: Uri, kind: 'create' | 'change' | 'delete'): void {
  for (const list of watchers.values()) {
    for (const watcher of list) watcher.notify(uri, kind);
  }
}

export class FileSystemWatcher {
  private readonly onDidCreateEmitter = new EventEmitter<Uri>();
  private readonly onDidChangeEmitter = new EventEmitter<Uri>();
  private readonly onDidDeleteEmitter = new EventEmitter<Uri>();

  readonly onDidCreate = this.onDidCreateEmitter.event;
  readonly onDidChange = this.onDidChangeEmitter.event;
  readonly onDidDelete = this.onDidDeleteEmitter.event;

  constructor(public readonly globPattern: string) {
    const list = watchers.get(globPattern) ?? [];
    list.push(this);
    watchers.set(globPattern, list);
  }

  notify(uri: Uri, kind: 'create' | 'change' | 'delete'): void {
    if (!globMatches(this.globPattern, uri.fsPath)) return;
    if (kind === 'create') this.onDidCreateEmitter.fire(uri);
    else if (kind === 'change') this.onDidChangeEmitter.fire(uri);
    else this.onDidDeleteEmitter.fire(uri);
  }

  dispose(): void {
    const list = watchers.get(this.globPattern);
    if (list) {
      const index = list.indexOf(this);
      if (index >= 0) list.splice(index, 1);
    }
    this.onDidCreateEmitter.dispose();
    this.onDidChangeEmitter.dispose();
    this.onDidDeleteEmitter.dispose();
  }
}

export function createFileSystemWatcher(globPattern: string): FileSystemWatcher {
  return new FileSystemWatcher(globPattern);
}

/**
 * Glob matching supporting the subset used by the ported LaTeX Workshop code:
 * `**`, `*`, `?`, `{a,b}` alternation and `[abc]` classes.
 */
export function globMatches(pattern: string, candidate: string): boolean {
  const alternatives = expandBraces(pattern);
  return alternatives.some((p) => globToRegExp(p).test(candidate));
}

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [pattern];
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const options = splitTopLevel(pattern.slice(open + 1, close));
  return options.flatMap((option) => expandBraces(prefix + option + suffix));
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

const regexpCache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = regexpCache.get(pattern);
  if (cached) return cached;

  const normalized = pattern.replace(/\\/g, '/');
  let source = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      const isDouble = normalized[i + 1] === '*';
      if (isDouble) {
        const isSlashAfter = normalized[i + 2] === '/';
        if (isSlashAfter) {
          source += '(?:[^/]*(?:/|$))*';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else if (ch === '[') {
      const end = normalized.indexOf(']', i);
      if (end === -1) {
        source += '\\[';
      } else {
        source += normalized.slice(i, end + 1);
        i = end;
      }
    } else {
      source += ch.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }

  const regexp = new RegExp(`^${source}$`, 'i');
  regexpCache.set(pattern, regexp);
  return regexp;
}

export { toDisposable, type Disposable };
