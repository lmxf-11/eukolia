/**
 * Eukolia — secondary window management.
 *
 * Settings and Snippet Library open in separated new windows rather than
 * in-place panels or modals, giving each its own viewport, independent
 * taskbar entry, and multi-monitor flexibility.
 *
 * Performance optimizations:
 *  - Idle prewarming: auxiliary windows can be warmed up in the background so
 *    opening them is instantaneous.
 *  - Window reuse (keep-alive): closing an auxiliary window hides it instead
 *    of destroying it, eliminating process creation, Chromium initialization,
 *    and bundle evaluation on reopen.
 *  - Responsive fallback: if opened before prewarming finishes, windows show
 *    promptly with immediate visual feedback.
 */

import { app, BrowserWindow, shell, nativeTheme } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { watchWindowState } from './ipc/appHandler';
import { userSettingsSearchPaths } from './library/projectLibrary';

const moduleFilename = fileURLToPath(import.meta.url);
const moduleDirname = path.dirname(moduleFilename);

export const TITLE_BAR_HEIGHT = 35;

/* ------------------------------------------------------------------ */
/*  Theme-aware initial window colours                                 */
/* ------------------------------------------------------------------ */

/**
 * Maps each theme name to the colours the BrowserWindow needs *before* the
 * renderer's ThemeManager runs — the window background it is painted with before
 * the first frame, and the two the auxiliary windows' own title bars use. Only
 * the tokens that exist before JS loads are listed; the renderer takes over as
 * soon as it applies the full palette.
 */
const THEME_WINDOW_COLOURS: Record<string, { bg: string; toolbar: string; fg: string }> = {
  dark:               { bg: '#0e1017', toolbar: '#161923', fg: '#e8ecf4' },
  light:              { bg: '#f6f7f9', toolbar: '#eceef2', fg: '#161a22' },
  'solarized-dark':   { bg: '#002b36', toolbar: '#073642', fg: '#eee8d5' },
  'solarized-light':  { bg: '#fdf6e3', toolbar: '#eee8d5', fg: '#073642' },
  nord:               { bg: '#2e3440', toolbar: '#3b4252', fg: '#eceff4' },
  'gruvbox-dark':     { bg: '#282828', toolbar: '#3c3836', fg: '#ebdbb2' },
  'one-dark':         { bg: '#282c34', toolbar: '#21252b', fg: '#abb2bf' },
  'catppuccin-latte': { bg: '#eff1f5', toolbar: '#e6e9ef', fg: '#4c4f69' },
};

const DEFAULT_COLOURS = THEME_WINDOW_COLOURS.dark;

/**
 * Reads the user's saved theme and returns the matching initial window colours.
 *
 * The window is coloured *before* the renderer exists, so this is the one place
 * the theme has to be read from the file directly rather than through the
 * settings bridge. That makes the search order the whole of the correctness: the
 * user's settings live in `<library>/.eukolia/settings.json` beside their
 * snippets, and the application-data locations are the layouts that came before
 * it. Reading only those meant a library user launched in the built-in dark
 * theme and saw the window painted one colour and the application another.
 *
 * A library pointer that cannot be read is skipped rather than fatal: an
 * unreadable location is a missing location, and the theme it falls back to is
 * the same one an installation with no settings at all gets. Exported because
 * the colours it chooses are what the window is constructed with, and the test
 * that pins them has no other way to ask.
 */
export function savedThemeColours(): { bg: string; toolbar: string; fg: string } {
  try {
    const appData: string = app.getPath('userData');
    for (const settingsPath of userSettingsSearchPaths(appData)) {
      if (!fs.existsSync(settingsPath)) continue;
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const theme: string | undefined = raw?.['general.theme'];
      if (theme === 'system') {
        return nativeTheme.shouldUseDarkColors ? DEFAULT_COLOURS : THEME_WINDOW_COLOURS.light;
      }
      if (theme && THEME_WINDOW_COLOURS[theme]) return THEME_WINDOW_COLOURS[theme];
    }
  } catch {
    // Settings file missing or malformed — fall through to default.
  }
  return DEFAULT_COLOURS;
}

function resolvePreloadPath(): string {
  const candidates = [
    path.join(moduleDirname, 'preload.cjs'),
    path.join(moduleDirname, 'preload.js'),
    path.join(moduleDirname, 'preload.mjs')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

let settingsWindow: BrowserWindow | null = null;
let snippetsWindow: BrowserWindow | null = null;
let isClosingAuxiliary = false;

function loadWindow(window: BrowserWindow, queryParams: Record<string, string>): void {
  if (process.env.VITE_DEV_SERVER_URL) {
    const devUrl = new URL(process.env.VITE_DEV_SERVER_URL);
    for (const [key, value] of Object.entries(queryParams)) {
      devUrl.searchParams.set(key, value);
    }
    void window.loadURL(devUrl.toString());
  } else {
    void window.loadFile(path.join(moduleDirname, '../dist/index.html'), {
      query: queryParams
    });
  }
}

function destroyWindow(win: BrowserWindow): void {
  if (typeof win.destroy === 'function') {
    win.destroy();
  } else if (typeof win.close === 'function') {
    win.close();
  }
}

function hideWindow(win: BrowserWindow): void {
  if (typeof win.hide === 'function') {
    win.hide();
  }
}

function createSettingsBrowserWindow(initialSection?: string): BrowserWindow {
  const colours = savedThemeColours();
  const window = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: colours.bg,
    title: 'Settings — Eukolia',
    show: false,
    autoHideMenuBar: true,
    /**
     * Frameless, with the window's own bar (`StandaloneTitleBar`).
     *
     * No `titleBarOverlay`, for the reason the main window has none: the overlay
     * is a reserved caption region at the top of the window, and these windows
     * draw that region themselves — their own wordmark on the left and their own
     * three buttons on the right. Asking the platform to paint its buttons there
     * as well put the system's controls on top of the renderer's.
     */
    titleBarStyle: 'hidden',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: resolvePreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  watchWindowState(window);

  window.webContents.setWindowOpenHandler(({ url }) => {
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

  window.on('close', (event: any) => {
    if (!isClosingAuxiliary) {
      if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      if (!window.webContents.isDestroyed()) {
        window.webContents.send('app:beforeClose');
      }
      hideWindow(window);
    }
  });

  window.on('closed', () => {
    if (settingsWindow === window) {
      settingsWindow = null;
    }
  });

  const queryParams: Record<string, string> = { window: 'settings' };
  if (initialSection) queryParams.section = initialSection;

  loadWindow(window, queryParams);

  return window;
}

function createSnippetsBrowserWindow(initialSnippetId?: string): BrowserWindow {
  const colours = savedThemeColours();
  const window = new BrowserWindow({
    width: 1140,
    height: 820,
    minWidth: 800,
    minHeight: 520,
    backgroundColor: colours.bg,
    title: 'Snippet Library — Eukolia',
    show: false,
    autoHideMenuBar: true,
    // Frameless with its own bar, like the Settings window above.
    titleBarStyle: 'hidden',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: resolvePreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  watchWindowState(window);

  window.webContents.setWindowOpenHandler(({ url }) => {
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

  window.on('close', (event: any) => {
    if (!isClosingAuxiliary) {
      if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      if (!window.webContents.isDestroyed()) {
        window.webContents.send('app:beforeClose');
      }
      hideWindow(window);
    }
  });

  window.on('closed', () => {
    if (snippetsWindow === window) {
      snippetsWindow = null;
    }
  });

  const queryParams: Record<string, string> = { window: 'snippets' };
  if (initialSnippetId) queryParams.snippetId = initialSnippetId;

  loadWindow(window, queryParams);

  return window;
}

/**
 * Prewarms the separated Settings window in the background so it can open instantly.
 */
export function prewarmSettingsWindow(): BrowserWindow | null {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    return settingsWindow;
  }
  settingsWindow = createSettingsBrowserWindow();
  return settingsWindow;
}

/**
 * Prewarms the separated Snippet Library window in the background so it can open instantly.
 */
export function prewarmSnippetsWindow(): BrowserWindow | null {
  if (snippetsWindow && !snippetsWindow.isDestroyed()) {
    return snippetsWindow;
  }
  snippetsWindow = createSnippetsBrowserWindow();
  return snippetsWindow;
}

/**
 * Staggers auxiliary window prewarming during app idle time.
 */
export function prewarmAuxiliaryWindows(): void {
  setTimeout(() => {
    try {
      prewarmSettingsWindow();
    } catch {
      // Ignored if shutting down
    }
  }, 1000);

  setTimeout(() => {
    try {
      prewarmSnippetsWindow();
    } catch {
      // Ignored if shutting down
    }
  }, 2200);
}

/**
 * Opens or focuses the separated Settings window.
 */
export function openSettingsWindow(section?: string): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    if (section) {
      settingsWindow.webContents.send('window:settings:navigate', section);
    }
    return settingsWindow;
  }

  const window = createSettingsBrowserWindow(section);
  settingsWindow = window;

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show();
      window.focus();
    }
  });

  return window;
}

/**
 * Opens or focuses the separated Snippet Library window.
 */
export function openSnippetsWindow(snippetId?: string): BrowserWindow {
  if (snippetsWindow && !snippetsWindow.isDestroyed()) {
    if (snippetsWindow.isMinimized()) snippetsWindow.restore();
    snippetsWindow.show();
    snippetsWindow.focus();
    if (snippetId) {
      snippetsWindow.webContents.send('window:snippets:focus', snippetId);
    }
    return snippetsWindow;
  }

  const window = createSnippetsBrowserWindow(snippetId);
  snippetsWindow = window;

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show();
      window.focus();
    }
  });

  return window;
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
}

export function getSnippetsWindow(): BrowserWindow | null {
  return snippetsWindow && !snippetsWindow.isDestroyed() ? snippetsWindow : null;
}

/**
 * Closes auxiliary windows when the main application window is closed.
 */
export function closeAuxiliaryWindows(): void {
  isClosingAuxiliary = true;
  try {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      destroyWindow(settingsWindow);
      settingsWindow = null;
    }
    if (snippetsWindow && !snippetsWindow.isDestroyed()) {
      destroyWindow(snippetsWindow);
      snippetsWindow = null;
    }
  } finally {
    isClosingAuxiliary = false;
  }
}
