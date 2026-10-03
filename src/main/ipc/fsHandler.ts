/**
 * Eukolia — filesystem services (Electron main process).
 *
 * All privileged file access lives here (Instructions.md §65). The renderer gets
 * a narrow, typed surface through `window.eukoliaApi`.
 *
 * Notable behaviours:
 * - writes are atomic (`write` to a sibling temp file, then `rename`) so a crash
 *   during save cannot truncate a document (Instructions.md §45);
 * - directory scans are bounded and skip configured excludes, so opening a large
 *   project cannot hang the UI;
 * - project-wide search streams over files and stops at a result cap rather than
 *   reading everything into memory (Instructions.md §60, §62).
 */

import { ipcMain, dialog, shell, BrowserWindow, type WebContents } from 'electron';
import fs from 'fs';
import path from 'path';
import { IPC } from '../../shared/ipc';
import { logToFile } from './appHandler';
import { matchesSearchFilter } from './searchFilter';
import { MAX_FALLBACK_DIRECTORIES, TreeWatcher, nodeWatchPorts } from './treeWatcher';
import type {
  DirectoryListing,
  FileNode,
  FileStat,
  FileWatchErrorEvent,
  FileWatchEvent,
  SearchMatch,
  SearchOptions,
  SearchResult
} from '../../shared/ipc';

const MAX_TREE_DEPTH = 24;
const MAX_TREE_ENTRIES = 20000;
const MAX_SEARCH_FILE_BYTES = 4 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 4096;

/** Directories never worth scanning for a LaTeX project. */
const ALWAYS_EXCLUDED = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.DS_Store',
  '.vs',
  '.idea',
  '.claude'
]);

function normalize(p: string): string {
  return path.resolve(p);
}

function isExcludedName(name: string, excludes: ReadonlySet<string>): boolean {
  return ALWAYS_EXCLUDED.has(name) || excludes.has(name);
}

/**
 * Atomic write: content goes to `<file>.<pid>.<n>.tmp` in the same directory and
 * is then renamed over the target. `rename` is atomic on the same volume, so
 * readers either see the old file or the complete new one.
 */
async function safeWriteFile(filePath: string, content: string | Uint8Array): Promise<boolean> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);

  try {
    await fs.promises.writeFile(tempPath, content);
    try {
      await fs.promises.rename(tempPath, filePath);
    } catch (err) {
      // Windows can refuse to rename over a file another process holds open.
      // Retry once after removing the target; if that also fails, surface it.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'EEXIST') {
        await fs.promises.rm(filePath, { force: true });
        await fs.promises.rename(tempPath, filePath);
      } else {
        throw err;
      }
    }
    return true;
  } catch (err) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function readTree(dir: string, depth: number, excludes: ReadonlySet<string>, budget: { remaining: number }): Promise<FileNode[]> {
  if (depth > MAX_TREE_DEPTH || budget.remaining <= 0) return [];

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (budget.remaining <= 0) break;
    const fullPath = path.join(dir, entry.name);
    const excluded = isExcludedName(entry.name, excludes);

    if (entry.isDirectory()) {
      budget.remaining--;
      const children = excluded ? [] : await readTree(fullPath, depth + 1, excludes, budget);
      nodes.push({
        name: entry.name,
        path: fullPath,
        isDirectory: true,
        size: 0,
        mtimeMs: 0,
        children,
        excluded
      });
    } else if (entry.isFile()) {
      budget.remaining--;
      /*
       * The tree carries names and paths, and nothing reads a file's size or
       * modification time out of it.
       *
       * They used to be filled in from a `stat` per file, awaited one at a time —
       * a whole directory scan's worth of sequential round trips to the
       * filesystem, on the critical path of opening a project, for two fields no
       * caller consults (`ProjectIndex` defaults both; the Explorer draws names).
       * A `Dirent` already says whether an entry is a file or a directory, which
       * is the only question the tree asks. `stat` is still available for the
       * callers that genuinely need it (`fs.stat`, `vscodeHost`'s Stat).
       */
      nodes.push({ name: entry.name, path: fullPath, isDirectory: false, size: 0, mtimeMs: 0 });
    }
  }

  return nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

async function listFlat(dir: string, excludes: ReadonlySet<string>, budget: { remaining: number }): Promise<string[]> {
  const result: string[] = [];
  const stack = [dir];
  while (stack.length > 0 && budget.remaining > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (budget.remaining <= 0) break;
      if (isExcludedName(entry.name, excludes)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        budget.remaining--;
        result.push(fullPath);
      }
    }
  }
  return result;
}

function buildSearchRegExp(options: SearchOptions): RegExp {
  let source = options.isRegex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (options.wholeWord) source = `\\b(?:${source})\\b`;
  return new RegExp(source, options.caseSensitive ? 'g' : 'gi');
}

async function searchFiles(options: SearchOptions): Promise<SearchResult> {
  const started = Date.now();
  const maxResults = options.maxResults ?? 2000;
  // The Explorer's `files.exclude` names directories that are not part of the
  // project. Search walked straight past it, so a project with a `node_modules`
  // or a build output directory had every one of those files read on every
  // search — slow, and a source of hits the user cannot see in the tree and so
  // cannot account for.
  const excludes = new Set(options.excludeDirectories ?? []);
  const regexp = buildSearchRegExp(options);
  const matches: SearchMatch[] = [];
  let truncated = false;
  let filesScanned = 0;

  const candidates = options.onlyPaths
    ? [...options.onlyPaths]
    : await listFlat(options.root, excludes, { remaining: MAX_TREE_ENTRIES });

  for (const filePath of candidates) {
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }
    if (!matchesSearchFilter(filePath, options.include, options.exclude)) continue;

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) continue;

    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(filePath);
    } catch {
      continue;
    }

    // Skip binary files: a NUL byte in the first block is a reliable signal.
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;

    filesScanned++;
    const text = buffer.toString('utf8');
    const lines = text.split(/\r\n|\r|\n/);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      regexp.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regexp.exec(line)) !== null) {
        matches.push({
          path: filePath,
          line: lineIndex + 1,
          column: match.index + 1,
          text: line.length > 400 ? line.slice(0, 400) : line,
          matchLength: match[0].length
        });
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
        if (match[0].length === 0) regexp.lastIndex++;
      }
      if (truncated) break;
    }
  }

  return { matches, truncated, filesScanned, durationMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// File watching
// ---------------------------------------------------------------------------

interface WatchEntry {
  watcher: fs.FSWatcher;
  owner: number;
}

const watchers = new Map<string, WatchEntry>();

/**
 * The recursive workspace watchers, one per open folder.
 *
 * Keyed by the watched root, and owned by the window that asked for it, so closing
 * a window stops its watchers and never another window's. The policy — recursion,
 * the debounce window, the excludes, what counts as a failure — lives in
 * `treeWatcher.ts`, which is free of Electron and therefore testable; this is the
 * wiring: `fs.watch` in, `webContents.send` out.
 */
interface TreeWatchEntry {
  watcher: TreeWatcher;
  owner: number;
}

const treeWatchers = new Map<string, TreeWatchEntry>();

function sendWatchError(webContents: WebContents, error: FileWatchErrorEvent): void {
  // Logged as well as sent, and logged even when there is nothing to show the user:
  // the notice is for the one code VS Code surfaces, the log is for every code.
  logToFile('warn', `file watcher failed for ${error.path}: ${error.code} ${error.message}`);
  if (!webContents.isDestroyed()) webContents.send(IPC.fs.watchError, error);
}

/**
 * Starts (or restarts) the recursive watch of `root`.
 *
 * `excludes` are directory names from the renderer's `files.watcherExclude`; the
 * application's own `ALWAYS_EXCLUDED` set is added here, so dependency and VCS
 * internals are never watched however the user's settings are spelled.
 */
function watchTreeTarget(root: string, excludes: string[], webContents: WebContents): void {
  unwatchTreeTarget(root);

  const excluded = new Set<string>([...ALWAYS_EXCLUDED, ...excludes].map((name) => name.toLowerCase()));
  const watcher = new TreeWatcher({
    root,
    excludes: excluded,
    ports: nodeWatchPorts(),
    deliver: (events) => {
      if (webContents.isDestroyed()) return;
      for (const event of events) webContents.send(IPC.fs.watchEvent, event satisfies FileWatchEvent);
    },
    report: (error) => sendWatchError(webContents, error),
    // An overflow is not a failure — the watcher is still watching — so it is
    // logged rather than sent to the renderer as something to apologise for.
    diagnose: (message) => logToFile('warn', `file watcher: ${message}`)
  });

  watcher.start();
  treeWatchers.set(root, { watcher, owner: webContents.id });
}

function unwatchTreeTarget(root: string): void {
  const entry = treeWatchers.get(root);
  if (!entry) return;
  entry.watcher.stop();
  treeWatchers.delete(root);
}

function watchTargets(targets: string[], webContents: WebContents): void {
  unwatchTargets(targets);

  for (const target of targets) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      continue;
    }

    try {
      // Watching a directory keeps working across atomic renames, which is
      // exactly what our safe-write strategy produces.
      const watchPath = stat.isDirectory() ? target : path.dirname(target);
      const watcher = fs.watch(watchPath, { persistent: false }, (eventType, filename) => {
        if (!filename) return;
        const changed = path.join(watchPath, filename.toString());
        if (!stat.isDirectory() && path.resolve(changed) !== path.resolve(target)) return;

        let kind: FileWatchEvent['kind'];
        if (eventType === 'rename') {
          kind = fs.existsSync(changed) ? 'create' : 'delete';
        } else {
          kind = 'change';
        }
        if (!webContents.isDestroyed()) {
          webContents.send(IPC.fs.watchEvent, { path: changed, kind } satisfies FileWatchEvent);
        }
      });
      watchers.set(target, { watcher, owner: webContents.id });
    } catch {
      /* watching is best-effort */
    }
  }
}

function unwatchTargets(targets: string[]): void {
  for (const target of targets) {
    const entry = watchers.get(target);
    if (entry) {
      entry.watcher.close();
      watchers.delete(target);
    }
  }
}

export function disposeWatchers(webContentsId?: number): void {
  for (const [target, entry] of watchers) {
    if (webContentsId === undefined || entry.owner === webContentsId) {
      entry.watcher.close();
      watchers.delete(target);
    }
  }
  for (const [root, entry] of treeWatchers) {
    if (webContentsId === undefined || entry.owner === webContentsId) {
      entry.watcher.stop();
      treeWatchers.delete(root);
    }
  }
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerFsHandlers(): void {
  ipcMain.handle(IPC.fs.readFile, async (_event, filePath: string): Promise<string> => {
    return fs.promises.readFile(normalize(filePath), 'utf8');
  });

  /**
   * Reads at most `maxBytes` from the start of a file.
   *
   * Root-document detection asks one question of every `.tex` file in a project
   * — "does this begin with `\documentclass`, or name its root in a magic
   * comment?" — and both answers are in the first few hundred bytes. Reading the
   * whole file to answer it sent every byte of a large project across the IPC
   * bridge, one file at a time, and structured-cloned each one on the way. The
   * bound is enforced here rather than by the caller so the bytes never cross.
   *
   * A multi-byte character split by the cut is left intact by decoding a buffer
   * whose length was reduced, which is why the truncation happens on the slice
   * and not on the string.
   */
  ipcMain.handle(IPC.fs.readFileHead, async (_event, filePath: string, maxBytes = 8192): Promise<string> => {
    const limit = Math.max(1, Math.min(1 << 20, Math.floor(maxBytes) || 8192));
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(normalize(filePath), 'r');
      const buffer = Buffer.allocUnsafe(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  });

  ipcMain.handle(IPC.fs.readFileBinary, async (_event, filePath: string): Promise<Uint8Array> => {
    const buffer = await fs.promises.readFile(normalize(filePath));
    return new Uint8Array(buffer);
  });

  ipcMain.handle(IPC.fs.writeFile, async (_event, filePath: string, content: string): Promise<boolean> => {
    return safeWriteFile(normalize(filePath), content);
  });

  ipcMain.handle(IPC.fs.createFile, async (_event, filePath: string, content = ''): Promise<boolean> => {
    const target = normalize(filePath);
    if (fs.existsSync(target)) throw new Error(`File already exists: ${target}`);
    await safeWriteFile(target, content);
    return true;
  });

  ipcMain.handle(IPC.fs.createDirectory, async (_event, dirPath: string): Promise<boolean> => {
    await fs.promises.mkdir(normalize(dirPath), { recursive: true });
    return true;
  });

  ipcMain.handle(IPC.fs.delete, async (_event, targetPath: string, useTrash = true): Promise<boolean> => {
    const target = normalize(targetPath);
    if (useTrash) {
      try {
        await shell.trashItem(target);
        return true;
      } catch {
        /* fall through to a permanent delete when trash is unavailable */
      }
    }
    await fs.promises.rm(target, { recursive: true, force: true });
    return true;
  });

  ipcMain.handle(IPC.fs.rename, async (_event, oldPath: string, newPath: string): Promise<boolean> => {
    await fs.promises.rename(normalize(oldPath), normalize(newPath));
    return true;
  });

  ipcMain.handle(IPC.fs.copy, async (_event, source: string, destination: string): Promise<boolean> => {
    await fs.promises.cp(normalize(source), normalize(destination), { recursive: true, errorOnExist: true });
    return true;
  });

  ipcMain.handle(IPC.fs.stat, async (_event, targetPath: string): Promise<FileStat> => {
    const target = normalize(targetPath);
    try {
      const stat = await fs.promises.stat(target);
      return { path: target, exists: true, isDirectory: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return { path: target, exists: false, isDirectory: false, size: 0, mtimeMs: 0 };
    }
  });

  ipcMain.handle(IPC.fs.listDirectory, async (_event, dirPath: string, excludes: string[] = []): Promise<FileNode[]> => {
    const excludeSet = new Set(excludes);
    return readTree(normalize(dirPath), 0, excludeSet, { remaining: 4000 });
  });

  ipcMain.handle(
    IPC.fs.listTree,
    async (_event, dirPath: string, excludes: string[] = [], maxEntries = MAX_TREE_ENTRIES): Promise<FileNode[]> => {
      const excludeSet = new Set(excludes);
      return readTree(normalize(dirPath), 0, excludeSet, { remaining: maxEntries });
    }
  );

  ipcMain.handle(IPC.fs.listFlat, async (_event, dirPath: string, excludes: string[] = []): Promise<string[]> => {
    const excludeSet = new Set(excludes);
    return listFlat(normalize(dirPath), excludeSet, { remaining: MAX_TREE_ENTRIES });
  });

  ipcMain.handle(IPC.fs.listDirectoryNames, async (_event, dirPath: string): Promise<DirectoryListing> => {
    const entries = await fs.promises.readdir(normalize(dirPath), { withFileTypes: true });
    return {
      directories: entries.filter((e) => e.isDirectory()).map((e) => e.name),
      files: entries.filter((e) => e.isFile()).map((e) => e.name)
    };
  });

  ipcMain.handle(IPC.fs.revealInExplorer, async (_event, targetPath: string): Promise<boolean> => {
    shell.showItemInFolder(normalize(targetPath));
    return true;
  });

  ipcMain.handle(IPC.fs.watch, async (event, targets: string[]): Promise<boolean> => {
    watchTargets(targets.map(normalize), event.sender);
    return true;
  });

  ipcMain.handle(IPC.fs.unwatch, async (_event, targets: string[]): Promise<boolean> => {
    unwatchTargets(targets.map(normalize));
    return true;
  });

  /**
   * Watches the whole tree under `root`, delivering debounced batches.
   *
   * The folder is normalized here and used as the key, so the renderer's
   * `unwatchTree` for the same folder always finds the watcher it started —
   * whichever spelling of the path it used.
   */
  ipcMain.handle(IPC.fs.watchTree, async (event, root: string, excludes: string[] = []): Promise<boolean> => {
    watchTreeTarget(normalize(root), excludes, event.sender);
    return true;
  });

  ipcMain.handle(IPC.fs.unwatchTree, async (_event, root: string): Promise<boolean> => {
    unwatchTreeTarget(normalize(root));
    return true;
  });

  ipcMain.handle(IPC.fs.search, async (_event, options: SearchOptions): Promise<SearchResult> => {
    return searchFiles({ ...options, root: normalize(options.root) });
  });

  ipcMain.handle(
    IPC.fs.replaceInFiles,
    async (_event, options: SearchOptions & { replacement: string }): Promise<{ filesChanged: number; replacements: number }> => {
      const maxResults = options.maxResults ?? 5000;
      const regexp = buildSearchRegExp(options);
      let filesChanged = 0;
      let replacements = 0;

      // Same walk as `searchFiles`, and it must be the same decision: a replace
      // that edited a directory the search never showed would change files the
      // user could not see in the results they approved.
      const candidates =
        options.onlyPaths ??
        (await listFlat(
          normalize(options.root),
          new Set(options.excludeDirectories ?? []),
          { remaining: MAX_TREE_ENTRIES }
        ));

      for (const filePath of candidates) {
        if (!matchesSearchFilter(filePath, options.include, options.exclude)) continue;
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(filePath);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) continue;

        let text: string;
        try {
          text = await fs.promises.readFile(filePath, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('\u0000')) continue;

        let changed = 0;
        const next = text.replace(regexp, (match) => {
          changed++;
          return options.replacement;
        });
        if (changed > 0) {
          await safeWriteFile(filePath, next);
          filesChanged++;
          replacements += changed;
        }
        if (replacements >= maxResults) break;
      }

      return { filesChanged, replacements };
    }
  );

  // ------------------------------------------------------------------ dialogs

  ipcMain.handle(IPC.dialog.openFolder, async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await (window
      ? dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : dialog.showOpenDialog({ properties: ['openDirectory'] }));
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC.dialog.openFile, async (event, filters?: { name: string; extensions: string[] }[]): Promise<string[]> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: filters ?? [
        { name: 'LaTeX Documents', extensions: ['tex', 'sty', 'cls', 'bib', 'ltx'] },
        { name: 'JavaScript & JSON', extensions: ['js', 'mjs', 'cjs', 'jsx', 'json'] },
        { name: 'Markdown Documents', extensions: ['md', 'markdown'] },
        { name: 'TeX Logs', extensions: ['log'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    };
    const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(
    IPC.dialog.saveFile,
    async (event, defaultPath?: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.SaveDialogOptions = {
        defaultPath,
        filters: filters ?? [
          { name: 'LaTeX Documents', extensions: ['tex'] },
          { name: 'JavaScript', extensions: ['js', 'mjs', 'cjs'] },
          { name: 'JSON', extensions: ['json'] },
          { name: 'Markdown', extensions: ['md', 'markdown'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      };
      const result = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
      return result.canceled || !result.filePath ? null : result.filePath;
    }
  );

  ipcMain.handle(
    IPC.dialog.confirm,
    async (
      event,
      options: { message: string; detail?: string; buttons: string[]; defaultId?: number; cancelId?: number; type?: 'none' | 'info' | 'error' | 'question' | 'warning' }
    ): Promise<number> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const messageBoxOptions: Electron.MessageBoxOptions = {
        type: options.type ?? 'question',
        message: options.message,
        detail: options.detail,
        buttons: options.buttons,
        defaultId: options.defaultId ?? 0,
        cancelId: options.cancelId ?? options.buttons.length - 1,
        noLink: true
      };
      const result = await (window ? dialog.showMessageBox(window, messageBoxOptions) : dialog.showMessageBox(messageBoxOptions));
      return result.response;
    }
  );
}
