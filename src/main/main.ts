/**
 * Eukolia — Electron main process.
 *
 * Responsibilities are deliberately limited to what a renderer cannot do
 * (Instructions.md §65): window lifecycle, OS integration, privileged filesystem
 * access, subprocess launching and native modules. Application logic lives in the
 * renderer behind `window.eukoliaApi`.
 */

import { app, BrowserWindow, Menu, shell, type WebContents } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { registerFsHandlers, disposeWatchers } from './ipc/fsHandler';
import { registerAnalysisHandlers } from './ipc/analysisHandler';
import { registerLibraryHandlers } from './library/handlers';
import { disposeTerminals } from './terminal/terminalSession';
import { registerCompilerHandlers, disposeCompiler } from './ipc/compilerHandler';
import { registerPdfHandlers, disposePdfHandlers } from './ipc/pdfHandler';
import { registerCommandCatalogHandlers } from './ipc/commandCatalogHandler';
import { closeAuxiliaryWindows, openSettingsWindow, openSnippetsWindow, prewarmAuxiliaryWindows } from './windows';
import {
  registerAppHandlers,
  registerSettingsHandlers,
  registerTerminalHandlers,
  registerWindowHandlers,
  watchWindowState,
  setSettingsProjectRoot,
  logToFile,
  logToFileSync,
  disposeLogging,
  loadPersistedState,
  rememberWorkspace,
  flushState,
  setState,
  cleanupStaleTempFiles
} from './ipc/appHandler';
import {
  registerEukoliaProtocol,
  registerProtocolHandlers,
  handleProtocolUrl,
  deliverProtocolRequest,
  resetProtocolDelivery,
  findProtocolUrlInCommandLine
} from './protocol';
import { isSmokeProbeEnabled, runSmokeProbe, seedSmokeLibrary } from './smoke';
import { isVisualProbeEnabled, runVisualProbe, seedVisualProbeLibrary } from './visualProbe';
import {
  STARTUP_PROBE_QUERY,
  attachStartupProbeToRun,
  isStartupProbeEnabled,
  probeMark,
  probeNoteWindowShown
} from './startupProbe';

/**
 * The first mark on the launch timeline: everything before this is Node and
 * Electron starting the process, which no application change can move. Measured
 * here rather than at the top of the module so the module's own evaluation (the
 * whole import graph above) is attributed to the "main:module-evaluated" mark
 * instead of being hidden inside the baseline.
 */
probeMark('main:module-evaluated');

/**
 * The application's own name, set before anything reads it.
 *
 * Electron derives the window title, the menu bar, the crash reporter's labels
 * and `app.getPath('userData')` from this. Without it, a development run reports
 * "Electron" everywhere the name is shown — including the browser's
 * "A website wants to open this application" prompt, which names the executable
 * that handles `eukolia://`.
 *
 * On Windows `%APPDATA%\eukolia` and `%APPDATA%\Eukolia` are the same directory,
 * so existing settings and logs are picked up unchanged.
 */
app.setName('Eukolia');

const moduleFilename = fileURLToPath(import.meta.url);
const moduleDirname = path.dirname(moduleFilename);

/**
 * `vite-plugin-electron` emits the main bundle next to the preload script; the
 * preload may be `.cjs` (bundled by esbuild) or `.js` depending on how the app
 * was built, so both are probed.
 */
function resolvePreloadPath(): string {
  const candidates = [
    path.join(moduleDirname, 'preload.cjs'),
    path.join(moduleDirname, 'preload.js'),
    path.join(moduleDirname, 'preload.mjs')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

/**
 * Resolves the application icon in both development and packaged builds.
 *
 * During development, the main process is emitted into `dist-electron`, so the
 * source asset lives one directory above it. In a packaged build, electron-builder
 * copies `assets/icon.ico` into the app's resources directory via `extraResources`.
 */
function resolveAppIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(moduleDirname, '../assets/icon.ico');
}

let mainWindow: BrowserWindow | null = null;
let pendingOpenPath: string | null = null;

/**
 * Height of the application's top strip, in CSS pixels.
 *
 * The renderer's tab bar *is* that strip (`ui/components/TabBar.tsx`), and it
 * draws the window controls itself; the number is stated here as well so the two
 * processes agree about how much of the window's top edge the bar owns.
 */
export const TITLE_BAR_HEIGHT = 35;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#0e1017',
    title: 'Eukolia',
    icon: resolveAppIconPath(),
    show: false,
    autoHideMenuBar: true,
    /**
     * A frameless window with the application's own chrome.
     *
     * `titleBarStyle: 'hidden'` removes the native caption. There is deliberately
     * no `titleBarOverlay`: that option is what asks the platform to paint
     * minimise/maximise/close *over* the top of the window, and the top of this
     * window is the renderer's tab bar — a strip with tabs on the left and the
     * toolbar on the right, not a reserved 140px caption region. The overlay
     * buttons were drawn on top of the toolbar's own controls, which is why the
     * layout used to reserve that space and why the two have now swapped: the
     * application draws the three buttons itself, in the bar it already has.
     *
     * The window keeps its native frame — resize borders, the system menu, the
     * taskbar entry and the snap behaviour a drag region gets — because only the
     * *caption* is hidden.
     */
    titleBarStyle: 'hidden',
    /**
     * The renderer paints while the window is hidden, so the first frame is
     * already there when the window is shown.
     *
     * The default, stated because the loading screen depends on it: the window is
     * shown before the load has finished, and with this off the renderer would be
     * considered hidden and could be throttled — the screen the user is looking at
     * would be the one thing in the window that was not being drawn. It is a
     * top-level window option, not a `webPreference`.
     */
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: resolvePreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
      // Rendering a large PDF benefits from a compositor that does not throttle.
      backgroundThrottling: false
    }
  });

  // The renderer draws the title bar itself, so it has to be told when the window
  // is maximised in order to swap the restore icon for the maximise one.
  watchWindowState(window);
  window.webContents.on('did-start-loading', () => resetProtocolDelivery(window));

  /**
   * Attaches the startup profiler when `EUKOLIA_STARTUP_PROBE=1`. It is a no-op
   * otherwise, so the hook costs one boolean test in a normal launch.
   *
   * `EUKOLIA_STARTUP_OPEN_WORKSPACE` exists because a configured library shows its
   * project list and opens nothing until someone clicks: without it a profile run
   * reaches the welcome screen and stops, and a restoration timeline is never
   * measured. It sends the same request the library's own list sends.
   */
  attachStartupProbeToRun(window, {
    openWorkspace: process.env.EUKOLIA_STARTUP_OPEN_WORKSPACE ?? null
  });

  /**
   * Shows the window once, and only once.
   *
   * The window is shown as soon as the document has been *asked for*, not when it
   * has finished producing a frame — see the load below. `ready-to-show` is kept
   * as a backstop rather than as the trigger, because it is the wrong trade: it
   * fires only after the renderer has fetched, parsed and evaluated the entry
   * bundle and painted its first frame, so a window that is waiting for it is a
   * window the user cannot see while the application starts. What they see
   * instead is `index.html`'s own loading screen, which the browser paints from
   * the parsed document and stylesheet alone — no module, no script, nothing that
   * can fail.
   *
   * `ready-to-show` still matters for the case it was written for: a renderer
   * that never paints would otherwise leave a window that never appears, which
   * looks exactly like a hang. It cannot fire first now, and the guard makes the
   * redundant call free.
   */
  let shown = false;
  const showWindow = (reason: string): void => {
    if (shown || window.isDestroyed()) return;
    shown = true;
    logToFile('info', `[boot] showing the window (${reason})`);
    window.show();
    probeNoteWindowShown();
    if (pendingOpenPath) {
      deliverProtocolRequest({ kind: 'open', path: pendingOpenPath }, window);
      pendingOpenPath = null;
    }
    // Enabled only by the smoke harness (`npm run smoke`); a no-op otherwise.
    if (isSmokeProbeEnabled()) {
      void runSmokeProbe(window);
    }
    // Enabled by `EUKOLIA_CARET_PROBE=1` (see `scripts/probe-visual.mjs`): a
    // measurement-only probe for the visual editor's appearance, which cannot be
    // answered outside a real layout engine.
    if (isVisualProbeEnabled()) {
      void runVisualProbe(window);
    }
  };

  window.once('ready-to-show', () => {
    showWindow('ready-to-show');
    prewarmAuxiliaryWindows();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    // Nothing in Eukolia opens a second browser window; external links go to the OS.
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env.VITE_DEV_SERVER_URL;
    if (devServer && url.startsWith(devServer)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    logToFile('error', `renderer process gone: ${JSON.stringify(details)}`);
  });

  window.webContents.on('unresponsive', () => {
    logToFile('warn', 'renderer became unresponsive');
  });

  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) logToFile(level === 3 ? 'error' : 'warn', `renderer: ${message} (${sourceId}:${line})`);
  });

  window.on('close', () => {
    // Ask the renderer to persist its session before the window goes away.
    if (!window.webContents.isDestroyed()) {
      window.webContents.send('app:beforeClose');
    }
  });

  window.on('closed', () => {
    disposeWatchers();
    // The renderer's own cleanup never runs when a window is destroyed, so the
    // window's terminals are ended here rather than left to `will-quit`: on
    // macOS the app outlives its window, and an orphaned shell would stay
    // attached to nothing.
    disposeTerminals();
    if (mainWindow === window) {
      mainWindow = null;
      closeAuxiliaryWindows();
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    const devUrl = new URL(process.env.VITE_DEV_SERVER_URL);
    if (isStartupProbeEnabled()) devUrl.searchParams.set(STARTUP_PROBE_QUERY, '1');
    void window.loadURL(devUrl.toString());
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    void window.loadFile(path.join(moduleDirname, '../dist/index.html'), {
      // The renderer reads this to switch its own half of the profiler on. A
      // query parameter rather than an IPC call, because the renderer has to know
      // before its first statement runs.
      query: isStartupProbeEnabled() ? { [STARTUP_PROBE_QUERY]: '1' } : undefined
    });
  }

  /*
   * The window is shown now, with the load still in flight.
   *
   * This is the whole point of the loading screen. Waiting for `ready-to-show`
   * means waiting for the entry bundle to be fetched, parsed, evaluated and
   * painted, and until that moment the application has no window at all — which
   * is the difference between "starting" and "not there". What the user sees here
   * instead is the loading screen in `index.html`, painted by the browser from
   * the document and stylesheet it has already parsed, and then the application
   * itself when it is ready.
   *
   * The window is not blank in the meantime: `backgroundColor` above is the
   * active theme's editor background, so the frame arrives already wearing the
   * application's colours rather than flashing white.
   *
   * Both routes are timed by `npm run profile:startup`, which reports the one
   * number that spans the two processes — process start to the shell being on
   * screen — because "when did the window appear" and "when was the application
   * usable" are different questions and only the first one is answered by
   * showing earlier. Measured over five runs each, showing here reaches the
   * shell at **622–702 ms** after process start against **681–746 ms** for
   * waiting for `ready-to-show` — so the window arrives about half a second
   * sooner and the shell does not arrive later, which was the honest risk in
   * showing early.
   */
  // Only for the profiler's A/B comparison; a normal launch always shows here.
  if (process.env.EUKOLIA_WINDOW_ON_READY_TO_SHOW !== '1') showWindow('load started');

  return window;
}

/**
 * A minimal menu keeps standard accelerators (copy/paste, reload, devtools)
 * working. Every application action lives in the command palette instead of a
 * permanent toolbar (Instructions.md §55).
 */
function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', click: () => mainWindow?.webContents.send('menu:command', 'file.newProject') },
        { label: 'Project Library…', click: () => mainWindow?.webContents.send('menu:command', 'file.projectLibrary') },
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:command', 'file.openFile')
        },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+K CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:command', 'file.openFolder')
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettingsWindow()
        },
        {
          label: 'Snippet Library…',
          accelerator: 'CmdOrCtrl+Alt+L',
          click: () => openSnippetsWindow()
        },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => mainWindow?.webContents.send('menu:command', 'file.save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow?.webContents.send('menu:command', 'file.saveAs') },
        { label: 'Save All', accelerator: 'CmdOrCtrl+Alt+S', click: () => mainWindow?.webContents.send('menu:command', 'file.saveAll') },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Code Mode', accelerator: 'CmdOrCtrl+1', click: () => mainWindow?.webContents.send('menu:command', 'editor.codeMode') },
        { label: 'Visual Mode', accelerator: 'CmdOrCtrl+2', click: () => mainWindow?.webContents.send('menu:command', 'editor.visualMode') },
        { type: 'separator' },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: () => mainWindow?.webContents.send('menu:command', 'workbench.commandPalette') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Build',
      submenu: [
        /*
         * Eukolia: Build carries no accelerator here on purpose.
         *
         * An Electron menu accelerator is taken by the menu before the renderer
         * sees the key at all — no `keydown` reaches the page — so `CmdOrCtrl+B`
         * here silently shadowed *three* renderer bindings at once: Toggle
         * Sidebar, Build Project, and the editor's `\textbf`. Measured with the
         * caret in the document and nothing selected, `Ctrl+B` left the document
         * alone and left the sidebar where it was, because the menu had already
         * consumed it.
         *
         * The renderer's command registry owns shortcuts: it is rebindable from
         * Settings, it respects a command's `when` clause, and it is where the
         * editor's own keymap lives. `keybindings.build` already defaults to
         * `Ctrl+B`, so the shortcut still works — it is resolved on the other side
         * of the boundary, where the other bindings for the same key can be seen
         * and decline.
         */
        { label: 'Build', click: () => mainWindow?.webContents.send('menu:command', 'latex.build') },
        { label: 'Build and View', click: () => mainWindow?.webContents.send('menu:command', 'latex.buildAndView') },
        { label: 'Stop Compilation', click: () => mainWindow?.webContents.send('menu:command', 'latex.stopBuild') },
        { type: 'separator' },
        { label: 'Clean Auxiliary Files', click: () => mainWindow?.webContents.send('menu:command', 'latex.clean') },
        { label: 'Clean and Build', click: () => mainWindow?.webContents.send('menu:command', 'latex.cleanAndBuild') }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Eukolia Documentation',
          click: () => mainWindow?.webContents.send('menu:command', 'help.documentation')
        },
        {
          label: 'Open Log File',
          click: () => {
            const logPath = path.join(app.getPath('userData'), 'eukolia.log');
            shell.showItemInFolder(logPath);
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const initialProtocolUrl = findProtocolUrlInCommandLine(process.argv);
const initialFileArgument = process.argv
  .slice(1)
  .find((arg) => !arg.startsWith('-') && /\.(tex|ltx|bib|sty|cls|log|pdf)$/i.test(arg));

/**
 * `Eukolia.exe --register-protocol` claims the `eukolia://` scheme and exits.
 *
 * The installer does this too, but a portable or `dir` build has no installer,
 * and `scripts/register-protocol.mjs` needs a way to make the *packaged*
 * executable — not `electron.exe` — the handler without opening a window.
 */
if (process.argv.includes('--register-protocol')) {
  void app.whenReady().then(() => {
    registerEukoliaProtocol();
    app.exit(0);
  });
} else if (isSmokeProbeEnabled() || isVisualProbeEnabled()) {
  // Either probe gets its own user-data directory, so a run cannot read or write
  // the developer's real settings — and so a probe that changes a setting cannot
  // leave it changed. The directory that was in use is read *before* the
  // override, because the probe seeds its own project library from the snippet
  // library this machine already has.
  const realUserData = app.getPath('userData');
  const probeUserData = path.join(app.getPath('temp'), `eukolia-smoke-userdata-${process.pid}`);
  app.setPath('userData', probeUserData);
  if (isSmokeProbeEnabled()) {
    // `userData` alone means first-run setup: the shell the probe drives does not
    // exist until a project library does, so the probe seeds one in the scratch
    // directory beside it.
    seedSmokeLibrary(probeUserData, realUserData);
  } else {
    seedVisualProbeLibrary(probeUserData);
  }
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const url = findProtocolUrlInCommandLine(commandLine);
    if (url) {
      handleProtocolUrl(url, mainWindow);
    } else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url, mainWindow);
  });

  void app.whenReady().then(() => {
    probeMark('app:ready');
    registerEukoliaProtocol();
    registerAppHandlers();
    registerLibraryHandlers();
    registerSettingsHandlers();
    registerProtocolHandlers();
    registerFsHandlers();
    // The LaTeX analyzer, which is a Node bundle and so cannot run in the
    // renderer or in an ES module worker; see `ipc/analysisHandler.ts`.
    registerAnalysisHandlers();
    registerCompilerHandlers();
    registerPdfHandlers();
    registerTerminalHandlers();
    registerWindowHandlers();
    // The shell's command catalogue, relayed to the Settings window: its
    // keyboard-shortcut editor lists every command and the commands live in the
    // shell's registry, which is a different process. See the handler.
    registerCommandCatalogHandlers();
    installApplicationMenu();
    probeMark('main:handlers-registered');

    const state = loadPersistedState();
    if (state.workspacePath && fs.existsSync(state.workspacePath)) {
      rememberWorkspace(state.workspacePath);
      // The workspace settings file belongs to the project, so it is resolved
      // once the project is known.
      setSettingsProjectRoot(state.workspacePath);
    }
    setState({ unsavedBuffers: state.unsavedBuffers ?? {} });
    probeMark('main:state-loaded');

    // Reclaim anything a previous run left in the temporary directory.
    void cleanupStaleTempFiles();

    mainWindow = createWindow();
    probeMark('main:window-created');

    if (initialProtocolUrl) {
      handleProtocolUrl(initialProtocolUrl, null);
    } else if (initialFileArgument) {
      const resolved = path.resolve(initialFileArgument);
      if (fs.existsSync(resolved)) pendingOpenPath = resolved;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    disposeCompiler();
    void flushState();
  });

  app.on('will-quit', () => {
    // A shell must not outlive the window: an orphaned `latexmk` would keep the
    // project's auxiliary files locked for the next run.
    disposeTerminals();
    disposePdfHandlers();
    disposeLogging();
  });

  /*
   * Why the process went away.
   *
   * A window-scoped `render-process-gone` handler already exists (it belongs to
   * the window it describes); these are the ones that cover everything else —
   * a renderer for an auxiliary window, a GPU process, the native PDF worker —
   * and the exit line, which is the only record of a launch that ended without
   * an error at all. The end-to-end probe runs for minutes and drives five
   * surfaces at once, so "it stopped halfway through" has to be answerable from
   * the log rather than by guessing which step killed it.
   */
  app.on('render-process-gone', (_event, contents, details) => {
    logToFile('error', `renderer gone (${contents.getType()}): ${JSON.stringify(details)}`);
  });

  app.on('child-process-gone', (_event, details) => {
    logToFile('error', `child process gone (${details.type}): ${JSON.stringify(details)}`);
  });

  process.on('exit', (code) => {
    logToFileSync('info', `main process exiting with code ${code}`);
  });

  process.on('uncaughtException', (error) => {
    logToFile('error', `uncaught exception: ${error.stack ?? error.message}`);
  });

  process.on('unhandledRejection', (reason) => {
    logToFile('error', `unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  });
}

export type { WebContents };
