import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTypeScript } from '../helpers/register-typescript.mjs';

class FakeBrowserWindow {
  constructor(options) {
    this.options = options;
    this._destroyed = false;
    this._minimized = false;
    this._focused = false;
    this._shown = false;
    this._closed = false;
    this.webContents = {
      isDestroyed: () => this._destroyed,
      getURL: () => this.loadedUrl ?? this.loadedFile ?? 'about:blank',
      setWindowOpenHandler: () => {},
      on: () => {},
      send: (channel, ...args) => {
        this.sent.push({ channel, args });
      }
    };
    this.sent = [];
    this.events = new Map();
  }

  isDestroyed() {
    return this._destroyed;
  }

  isMinimized() {
    return this._minimized;
  }

  restore() {
    this._minimized = false;
  }

  show() {
    this._shown = true;
  }

  hide() {
    this._shown = false;
  }

  focus() {
    this._focused = true;
  }

  close() {
    const closeHandler = this.events.get('close');
    let prevented = false;
    if (closeHandler) {
      closeHandler({
        preventDefault: () => {
          prevented = true;
        }
      });
    }
    if (!prevented) {
      this._closed = true;
      this._destroyed = true;
      const closedHandler = this.events.get('closed');
      if (closedHandler) closedHandler();
    }
  }

  destroy() {
    this._closed = true;
    this._destroyed = true;
    const closedHandler = this.events.get('closed');
    if (closedHandler) closedHandler();
  }

  on(event, handler) {
    this.events.set(event, handler);
  }

  once(event, handler) {
    this.events.set(event, handler);
  }

  loadURL(url) {
    this.loadedUrl = url;
    return Promise.resolve();
  }

  loadFile(file, options) {
    this.loadedFile = file;
    this.loadedOptions = options;
    return Promise.resolve();
  }
}

globalThis.FakeBrowserWindow = FakeBrowserWindow;

registerTypeScript({
  electron:
    'data:text/javascript,export const app={};export const BrowserWindow=globalThis.FakeBrowserWindow;export const shell={};export const nativeTheme={shouldUseDarkColors:true};',
  [new URL('../../src/main/ipc/appHandler', import.meta.url).href]:
    'data:text/javascript,export function watchWindowState(){};export function logToFile(){};',
});

const {
  openSettingsWindow,
  openSnippetsWindow,
  getSettingsWindow,
  getSnippetsWindow,
  prewarmSettingsWindow,
  prewarmSnippetsWindow,
  closeAuxiliaryWindow,
  closeAuxiliaryWindows
} = await import('../../src/main/windows.ts');

test('openSettingsWindow creates a separate window with proper configuration and query params', () => {
  const window = openSettingsWindow('Editor');
  assert.equal(getSettingsWindow(), window);
  assert.equal(window.options.title, 'Settings — Eukolia');
  assert.equal(window.options.titleBarStyle, 'hidden');
  assert.ok(window.loadedOptions?.query?.window === 'settings');
  assert.equal(window.loadedOptions?.query?.section, 'Editor');
});

test('openSettingsWindow focuses existing window and sends navigate event', () => {
  const window = openSettingsWindow('LaTeX');
  assert.equal(window.sent.length, 1);
  assert.equal(window.sent[0].channel, 'window:settings:navigate');
  assert.equal(window.sent[0].args[0], 'LaTeX');
});

test('openSnippetsWindow creates a separate window with proper configuration and query params', () => {
  const window = openSnippetsWindow('my-snippet');
  assert.equal(getSnippetsWindow(), window);
  assert.equal(window.options.title, 'Snippet Library — Eukolia');
  assert.equal(window.options.titleBarStyle, 'hidden');
  assert.ok(window.loadedOptions?.query?.window === 'snippets');
  assert.equal(window.loadedOptions?.query?.snippetId, 'my-snippet');
});

test('openSnippetsWindow focuses existing window and sends focus event', () => {
  const window = openSnippetsWindow('another-snippet');
  assert.equal(window.sent.length, 1);
  assert.equal(window.sent[0].channel, 'window:snippets:focus');
  assert.equal(window.sent[0].args[0], 'another-snippet');
});

/*
 * A close nobody asked for still hides — that is the keep-alive the windows are
 * built around, and it is what makes reopening Settings instant.
 */
test('an unrequested close hides the window instead of destroying it (keep-alive)', () => {
  const settingsWin = getSettingsWindow();
  assert.ok(settingsWin);
  settingsWin.close();
  // It shouldn't be destroyed, only hidden
  assert.equal(settingsWin.isDestroyed(), false);
  assert.equal(settingsWin._shown, false);
  assert.equal(getSettingsWindow(), settingsWin);

  // Calling openSettingsWindow un-hides and focuses instantly
  openSettingsWindow('Formatting');
  assert.equal(settingsWin._shown, true);
  assert.equal(settingsWin._focused, true);
});

/*
 * A close the *user* asked for is honoured.
 *
 * The window's own Close control calls `closeAuxiliaryWindow`, and a close that
 * only hides is what made that control read as doing nothing: the window stayed
 * on screen, and every press ran the same handler again.
 */
test('closeAuxiliaryWindow really closes, so the Close control cannot be a no-op', () => {
  const settingsWin = getSettingsWindow();
  assert.ok(settingsWin);

  closeAuxiliaryWindow(settingsWin);

  assert.equal(settingsWin.isDestroyed(), true);
  assert.equal(getSettingsWindow(), null);

  // And it can be opened again afterwards, as a fresh window.
  const reopened = openSettingsWindow('Editor');
  assert.notEqual(reopened, settingsWin);
  assert.equal(getSettingsWindow(), reopened);
});

test('closeAuxiliaryWindow leaves an already-destroyed window alone', () => {
  assert.doesNotThrow(() => closeAuxiliaryWindow(null));
  const win = openSnippetsWindow();
  closeAuxiliaryWindow(win);
  assert.equal(getSnippetsWindow(), null);
  assert.doesNotThrow(() => closeAuxiliaryWindow(win));
});

test('closeAuxiliaryWindows closes both settings and snippets windows', () => {
  openSettingsWindow();
  openSnippetsWindow();
  assert.ok(getSettingsWindow());
  assert.ok(getSnippetsWindow());
  closeAuxiliaryWindows();
  assert.equal(getSettingsWindow(), null);
  assert.equal(getSnippetsWindow(), null);
});

test('prewarmSettingsWindow and prewarmSnippetsWindow create windows in background without showing', () => {
  closeAuxiliaryWindows();
  assert.equal(getSettingsWindow(), null);
  assert.equal(getSnippetsWindow(), null);

  const warmSettings = prewarmSettingsWindow();
  assert.ok(warmSettings);
  assert.equal(warmSettings._shown, false);
  assert.equal(getSettingsWindow(), warmSettings);

  const warmSnippets = prewarmSnippetsWindow();
  assert.ok(warmSnippets);
  assert.equal(warmSnippets._shown, false);
  assert.equal(getSnippetsWindow(), warmSnippets);

  closeAuxiliaryWindows();
  assert.equal(getSettingsWindow(), null);
  assert.equal(getSnippetsWindow(), null);
});
