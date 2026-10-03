/**
 * Eukolia — application-level services (Electron main process).
 *
 * Owns persisted UI/session state, crash-recovery buffers, recent workspaces and
 * a rotating log file. State lives in `app.getPath('userData')`, never inside the
 * project, so Eukolia does not litter a user's repository.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { IPC } from '../../shared/ipc';
import type {
  PersistedState,
  RecentWorkspace,
  SettingsFileDescription,
  SettingsScope,
  SettingsWriteRequest,
  SnippetFileDescription,
  TerminalCreateRequest,
  TerminalCreateResult,
  UserSnippetSource
} from '../../shared/ipc';
import {
  ensureUserDirectory,
  onSettingsFileChanged,
  openSettingsFile,
  readSettingsFile,
  readUserSnippetSources,
  stopWatchingWorkspace,
  watchSettingsFile,
  writeSettingsFile
} from '../settings/advancedSettings';
import {
  ensureUserSnippetsDirectory,
  onUserSnippetsChanged,
  readUserSnippetsFile,
  userSnippetsPath,
  watchUserSnippetsFile,
  writeUserSnippetsFile
} from '../snippets/store';
import { openSettingsWindow, openSnippetsWindow } from '../windows';
import {
  createTerminal,
  killTerminal,
  resizeTerminal,
  writeTerminal
} from '../terminal/terminalSession';

const MAX_RECENT_WORKSPACES = 20;
const MAX_LOG_BYTES = 4 * 1024 * 1024;

/** Rejects a malformed renderer argument instead of writing it to the user's file. */
function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
}

function userDataFile(name: string): string {
  return path.join(app.getPath('userData'), name);
}

function defaultState(): PersistedState {
  return {
    workspacePath: null,
    openFiles: [],
    activeFile: null,
    rootFile: null,
    layout: 'split',
    editorMode: 'visual',
    sidebarVisible: true,
    sidebarWidth: 260,
    pdfVisible: true,
    pdfPath: null,
    pdfPage: 1,
    pdfZoom: 1,
    theme: 'system',
    recentWorkspaces: [],
    unsavedBuffers: {}
  };
}

let cachedState: PersistedState | null = null;
let writeTimer: NodeJS.Timeout | null = null;

function stateFilePath(): string {
  return userDataFile('state.json');
}

export function loadPersistedState(): PersistedState {
  if (cachedState) return cachedState;
  const defaults = defaultState();
  try {
    const raw = fs.readFileSync(stateFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    cachedState = {
      ...defaults,
      ...parsed,
      recentWorkspaces: Array.isArray(parsed.recentWorkspaces) ? parsed.recentWorkspaces : [],
      unsavedBuffers: parsed.unsavedBuffers && typeof parsed.unsavedBuffers === 'object' ? parsed.unsavedBuffers : {},
      openFiles: Array.isArray(parsed.openFiles) ? parsed.openFiles : []
    };
  } catch {
    cachedState = defaults;
  }
  return cachedState;
}

function scheduleStateWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  // Debounced: the renderer saves state frequently (pane drags, scroll, cursor).
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flushState();
  }, 400);
}

export async function flushState(): Promise<void> {
  if (!cachedState) return;
  const target = stateFilePath();
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(temp, JSON.stringify(cachedState, null, 2), 'utf8');
    await fs.promises.rename(temp, target);
  } catch (err) {
    console.error('[eukolia] failed to persist state', err);
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
  }
}

export function setState(patch: Partial<PersistedState>): PersistedState {
  const current = loadPersistedState();
  cachedState = { ...current, ...patch };
  scheduleStateWrite();
  return cachedState;
}

export function rememberWorkspace(workspacePath: string): RecentWorkspace[] {
  const current = loadPersistedState();
  const resolved = path.resolve(workspacePath);
  const entry: RecentWorkspace = {
    path: resolved,
    name: path.basename(resolved) || resolved,
    openedAt: Date.now()
  };
  const next = [entry, ...current.recentWorkspaces.filter((w) => path.resolve(w.path) !== resolved)].slice(
    0,
    MAX_RECENT_WORKSPACES
  );
  setState({ recentWorkspaces: next });
  return next;
}

/**
 * Crash recovery (Instructions.md §59).
 *
 * Unsaved buffers are mirrored to disk as the user types. Recovery never
 * overwrites a file: the renderer is given the recovered text and decides,
 * comparing timestamps against the on-disk mtime.
 */
export function recordUnsavedBuffer(uri: string, content: string, languageId: string): void {
  const state = loadPersistedState();
  setState({
    unsavedBuffers: {
      ...state.unsavedBuffers,
      [uri]: { content, timestamp: Date.now(), languageId }
    }
  });
}

export function clearUnsavedBuffer(uri: string): void {
  const state = loadPersistedState();
  if (!(uri in state.unsavedBuffers)) return;
  const next = { ...state.unsavedBuffers };
  delete next[uri];
  setState({ unsavedBuffers: next });
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

let logStream: fs.WriteStream | null = null;

function logFile(): string {
  return userDataFile('eukolia.log');
}

function rotateLogIfNeeded(): void {
  try {
    const stat = fs.statSync(logFile());
    if (stat.size > MAX_LOG_BYTES) {
      fs.renameSync(logFile(), `${logFile()}.1`);
    }
  } catch {
    /* no log yet */
  }
}

export function logToFile(level: string, message: string): void {
  try {
    if (!logStream) {
      rotateLogIfNeeded();
      logStream = fs.createWriteStream(logFile(), { flags: 'a' });
    }
    logStream.write(`[${new Date().toISOString()}] [${level}] ${message}\n`);
  } catch {
    /* logging must never break the app */
  }
}

/**
 * The same line, written synchronously.
 *
 * `logToFile` writes through a stream, which is buffered: a message written from
 * `process.on('exit')` — the last thing a process does — would be lost, and that
 * is exactly the message worth having when the process is going away without
 * having said why.
 */
export function logToFileSync(level: string, message: string): void {
  try {
    fs.appendFileSync(logFile(), `[${new Date().toISOString()}] [${level}] ${message}\n`);
  } catch {
    /* logging must never break the app */
  }
}

export function disposeLogging(): void {
  logStream?.end();
  logStream = null;
}

export function registerAppHandlers(): void {
  ipcMain.handle(IPC.app.getState, async (): Promise<PersistedState> => loadPersistedState());

  ipcMain.handle(IPC.app.setState, async (_event, patch: Partial<PersistedState>): Promise<PersistedState> => setState(patch));

  ipcMain.handle(IPC.app.getVersions, async () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch
  }));

  ipcMain.handle(IPC.app.openExternal, async (_event, url: string): Promise<boolean> => {
    // Only well-formed http(s) and mailto links are handed to the OS.
    if (!/^(https?|mailto):/i.test(url)) {
      logToFile('warn', `refused to open external url: ${url}`);
      return false;
    }
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle(IPC.app.showItemInFolder, async (_event, targetPath: string): Promise<boolean> => {
    shell.showItemInFolder(path.resolve(targetPath));
    return true;
  });

  /**
   * Writes a byte buffer to a file in the application's temporary directory and
   * returns its path.
   *
   * The native PDF engine opens documents by path, so a figure that exists in
   * the renderer only as a `blob:`/`data:` URL has to be materialised before it
   * can be rendered. Everything lands in one directory so it can be reclaimed
   * wholesale, and a startup sweep removes anything left by a previous run.
   */
  ipcMain.handle(
    IPC.app.writeTempFile,
    async (_event, data: Uint8Array, desiredName: string): Promise<string> => {
      const directory = tempDirectory();
      await fs.promises.mkdir(directory, { recursive: true });

      // The name is only a hint; the extension is preserved because the engine
      // uses it, and everything else is replaced so a caller cannot escape the
      // directory.
      const extension = path.extname(desiredName).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12) || '.bin';
      const target = path.join(directory, `${Date.now()}-${++tempFileCounter}${extension}`);

      await fs.promises.writeFile(target, data);
      return target;
    }
  );

  ipcMain.handle(IPC.app.cleanupTempFiles, async (): Promise<number> => {
    return sweepTempDirectory();
  });

  ipcMain.handle(IPC.app.log, async (_event, level: string, message: string): Promise<void> => {
    logToFile(level, message);
  });
}

let tempFileCounter = 0;

function tempDirectory(): string {
  return path.join(app.getPath('temp'), 'eukolia');
}

/** Removes temporary files, returning how many were deleted. */
async function sweepTempDirectory(): Promise<number> {
  const directory = tempDirectory();
  let removed = 0;
  try {
    for (const entry of await fs.promises.readdir(directory)) {
      try {
        await fs.promises.rm(path.join(directory, entry), { force: true });
        removed++;
      } catch {
        /* a file still held open by the engine is skipped and retried later */
      }
    }
  } catch {
    /* the directory does not exist yet, which is not an error */
  }
  return removed;
}

/** Called once at startup so a crashed run cannot leave files behind forever. */
export async function cleanupStaleTempFiles(): Promise<void> {
  await sweepTempDirectory();
}

/* ------------------------------------------------------------------ *
 * Integrated terminal
 * ------------------------------------------------------------------ */

export function registerTerminalHandlers(): void {
  ipcMain.handle(
    IPC.terminal.create,
    async (event, request: TerminalCreateRequest): Promise<TerminalCreateResult> =>
      // The requesting renderer owns the session: a terminal's output is a VT
      // stream for one emulator, not a broadcast for every window.
      createTerminal(request ?? {}, event.sender)
  );

  ipcMain.handle(IPC.terminal.write, async (_event, id: number, data: string): Promise<void> => {
    writeTerminal(id, String(data));
  });

  ipcMain.handle(
    IPC.terminal.resize,
    async (_event, id: number, cols: number, rows: number): Promise<void> => {
      resizeTerminal(id, Number(cols), Number(rows));
    }
  );

  ipcMain.handle(IPC.terminal.kill, async (_event, id: number): Promise<void> => {
    killTerminal(id);
  });
}

/* ------------------------------------------------------------------ *
 * The window's own controls
 * ------------------------------------------------------------------ */

/**
 * Minimise, maximise/restore, close, and "is it maximised?".
 *
 * There is no handler for a window-control *overlay* any more. The renderer used
 * to push the active theme's two colours to `setTitleBarOverlay`, so the buttons
 * Windows painted over the top of the window would match the bar. The application
 * draws those buttons itself now (`ui/components/TabBar.tsx`), which is what makes
 * them part of the theme without a round trip: they are ordinary DOM, and they
 * read the same `--eu-*` variables as everything else.
 */
export function registerWindowHandlers(): void {
  const windowFor = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window && !window.isDestroyed() ? window : null;
  };

  ipcMain.handle(IPC.window.minimize, async (event): Promise<void> => {
    windowFor(event)?.minimize();
  });

  ipcMain.handle(IPC.window.maximize, async (event): Promise<boolean> => {
    const window = windowFor(event);
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });

  ipcMain.handle(IPC.window.isMaximized, async (event): Promise<boolean> =>
    Boolean(windowFor(event)?.isMaximized())
  );

  ipcMain.handle(IPC.window.close, async (event): Promise<void> => {
    // `close`, not `destroy`: the renderer's unsaved-changes flow runs from the
    // window's own close handler, so the custom button has to take the same path
    // as the native one.
    windowFor(event)?.close();
  });

  ipcMain.handle(IPC.window.openSettings, async (_event, section?: string): Promise<void> => {
    openSettingsWindow(section);
  });

  ipcMain.handle(IPC.window.openSnippets, async (_event, snippetId?: string): Promise<void> => {
    openSnippetsWindow(snippetId);
  });
}

/**
 * Tells the renderer when the window is maximised or restored.
 *
 * It used to do a second job: resize the native window-control overlay, which is a
 * pixel shorter on a maximised window, through `setTitleBarOverlay`. There is no
 * overlay any more — the renderer's tab bar is the caption and its buttons fill
 * whatever height the bar is (`TAB_BAR_MAXIMIZED_HEIGHT`) — so the message is the
 * whole of it: the middle button's glyph follows this, and nothing else does.
 */
export function watchWindowState(window: BrowserWindow): void {
  const send = () => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.window.maximizedChanged, window.isMaximized());
    }
  };
  window.on('maximize', send);
  window.on('unmaximize', send);
}

/* ------------------------------------------------------------------ *
 * Advanced settings files
 * ------------------------------------------------------------------ */

/**
 * The project root the workspace-scope settings file is resolved against.
 *
 * Set when a project is opened (see the protocol handlers) so the settings
 * channels do not have to re-derive it from a path the renderer sends.
 */
let currentProjectRoot: string | null = null;

export function setSettingsProjectRoot(root: string | null): void {
  if (root === currentProjectRoot) return;
  stopWatchingWorkspace();
  currentProjectRoot = root;
  if (root) watchSettingsFile('workspace', root);
}

export function registerSettingsHandlers(): void {
  // The renderer sends the project root when it has one, because it is the side
  // that knows which folder is open; `currentProjectRoot` is the fallback.
  const rootFor = (projectRoot?: string | null): string | null =>
    projectRoot ?? currentProjectRoot;

  ipcMain.handle(
    IPC.settings.read,
    async (_event, scope: SettingsScope, projectRoot?: string | null): Promise<SettingsFileDescription> =>
      readSettingsFile(scope, rootFor(projectRoot))
  );

  ipcMain.handle(
    IPC.settings.write,
    async (_event, request: SettingsWriteRequest, projectRoot?: string | null): Promise<SettingsFileDescription> =>
      writeSettingsFile(request, rootFor(projectRoot))
  );

  ipcMain.handle(
    IPC.settings.describe,
    async (_event, scope: SettingsScope, projectRoot?: string | null): Promise<string> =>
      openSettingsFile(scope, rootFor(projectRoot))
  );

  /**
   * The user's own `*.hsnips` files.
   *
   * They live beside the user's settings so everything the user owns is in one
   * directory; HyperSnips takes the language from the file name, so only the name
   * and contents travel. These are *legacy* now — the managed library is
   * `snippets.json` — and are still served so the settings UI can offer to import
   * them without the user having to find the folder.
   */
  ipcMain.handle(
    IPC.settings.userSnippets,
    async (): Promise<UserSnippetSource[]> => readUserSnippetSources()
  );

  /** Opens the user snippets directory itself (e.g. for "Open the snippets folder"). */
  ipcMain.handle(IPC.settings.openUserDirectory, async (): Promise<string> => {
    const directory = userSnippetsPath();
    ensureUserSnippetsDirectory();
    await shell.openPath(directory);
    return directory;
  });

  // ------------------------------------------------------- snippet library
  //
  // One file, `snippets.json`, in the EUSnips format — in the `.eukolia` folder
  // of the project library, or in the older application-data layout before one
  // is set up. The bytes travel as text because the format is the renderer's
  // business; the main process owns the path, the write and the watch.
  ipcMain.handle(IPC.snippets.read, async (): Promise<SnippetFileDescription> => readUserSnippetsFile());

  ipcMain.handle(
    IPC.snippets.write,
    async (_event, text: string, globalsJs?: string): Promise<SnippetFileDescription> => {
      assertString(text, 'snippet file text');
      if (globalsJs !== undefined && globalsJs !== null) {
        assertString(globalsJs, 'globals.js text');
      }
      return writeUserSnippetsFile(text, globalsJs ?? undefined);
    }
  );

  ipcMain.handle(IPC.snippets.watch, async (): Promise<SnippetFileDescription> => {
    watchUserSnippetsFile();
    return readUserSnippetsFile();
  });

  onUserSnippetsChanged((description) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.snippets.changed, description);
    }
  });

  // A file edited outside the application is pushed to the renderer, so the
  // point of exposing JSON — editing it in the user's own editor — actually
  // takes effect without a restart.
  onSettingsFileChanged((description) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.settings.changed, description);
    }
  });
}

export { recordUnsavedBuffer as __recordUnsavedBuffer };
