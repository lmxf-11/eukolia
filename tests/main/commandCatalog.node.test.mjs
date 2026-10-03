import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTypeScript } from '../helpers/register-typescript.mjs';

/**
 * The command-catalogue relay.
 *
 * The Settings window is a renderer of its own, so the commands the shell
 * registers are not in its registry — and the keyboard-shortcut editor reads its
 * rows from that registry. The editor therefore rendered "No shortcuts match"
 * for a list nobody had filtered, which is the defect this relay exists to fix.
 *
 * What is asserted here is the relay's own contract, because it is the part that
 * can be wrong in ways the UI cannot show: that the shell's catalogue is kept,
 * that a window asking for it gets the last one published, that every window is
 * told when a new one arrives (the Settings window can open *before* the shell
 * has finished registering), and that a settings window cannot overwrite the
 * catalogue it is displaying.
 */

const sent = [];

/** Stands in for Electron's `ipcMain`/`BrowserWindow`, recording every send. */
registerTypeScript({
  electron: `data:text/javascript,
    export const handlers = new Map();
    export const ipcMain = {
      handle(channel, fn) { globalThis.__handlers.set(channel, fn); }
    };
    export class BrowserWindow {
      constructor(label) { this.label = label; this.destroyed = false; }
      isDestroyed() { return this.destroyed; }
      get webContents() {
        const label = this.label;
        return { send: (channel, payload) => globalThis.__sent.push({ to: label, channel, payload }) };
      }
      static getAllWindows() { return globalThis.__windows; }
    }`,
  'node:electron': `data:text/javascript,
    export const handlers = new Map();
    export const ipcMain = {
      handle(channel, fn) { globalThis.__handlers.set(channel, fn); }
    };
    export class BrowserWindow {
      constructor(label) { this.label = label; this.destroyed = false; }
      isDestroyed() { return this.destroyed; }
      get webContents() {
        const label = this.label;
        return { send: (channel, payload) => globalThis.__sent.push({ to: label, channel, payload }); };
      }
      static getAllWindows() { return globalThis.__windows; }
    }`
});

globalThis.__handlers = new Map();
globalThis.__sent = sent;
globalThis.__windows = [];

const {
  registerCommandCatalogHandlers,
  publishCommandCatalog,
  currentCommandCatalog,
  resetCommandCatalog
} = await import('../../src/main/ipc/commandCatalogHandler.ts');

const { IPC } = await import('../../src/shared/ipc.ts');

/** A fake window, with the URL its sender stands for. */
function window(label, url) {
  return {
    label,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: {
      send: (channel, payload) => sent.push({ to: label, channel, payload }),
      getURL: () => url,
      sendTo: null
    }
  };
}

/** A sender event, as `ipcMain.handle` receives one. */
function event(url) {
  return { senderFrame: { url }, sender: { getURL: () => url } };
}

const SHELL_URL = 'file:///D:/app/dist/index.html';
const SETTINGS_URL = 'file:///D:/app/dist/index.html?window=settings';

registerCommandCatalogHandlers();

const catalog = [
  { id: 'file.save', title: 'Save', category: 'File', binding: 'Ctrl+S' },
  { id: 'latex.build', title: 'Build Project', category: 'LaTeX', binding: 'Ctrl+B' }
];

test('the settings window cannot overwrite the catalogue it is showing', () => {
  resetCommandCatalog();
  const publish = globalThis.__handlers.get(IPC.commands.publish);

  publish(event(SETTINGS_URL), [{ id: 'forged', title: 'Forged', category: 'File' }]);

  assert.equal(
    currentCommandCatalog(),
    null,
    'a settings window published a catalogue and it was kept'
  );
});

test('the shell publishes, and the catalogue is kept for a window that opens later', () => {
  resetCommandCatalog();
  const publish = globalThis.__handlers.get(IPC.commands.publish);

  publish(event(SHELL_URL), catalog);

  assert.deepEqual(currentCommandCatalog(), catalog);

  // A Settings window opened *after* the publish reads it rather than waiting
  // for the next one, which may never come.
  const read = globalThis.__handlers.get(IPC.commands.catalog);
  assert.deepEqual(read(event(SETTINGS_URL)), catalog);
});

test('every window is told when a new catalogue arrives', () => {
  resetCommandCatalog();
  sent.length = 0;
  globalThis.__windows = [window('shell', SHELL_URL), window('settings', SETTINGS_URL)];

  publishCommandCatalog(catalog);

  const deliveries = sent.filter((message) => message.channel === IPC.commands.changed);
  assert.equal(deliveries.length, 2, 'the catalogue did not reach every window');
  assert.deepEqual(deliveries.map((delivery) => delivery.to).sort(), ['settings', 'shell']);
  assert.deepEqual(deliveries[0].payload, catalog);
});

test('a destroyed window is skipped rather than sent to', () => {
  resetCommandCatalog();
  sent.length = 0;
  const dead = window('dead', SETTINGS_URL);
  dead.destroyed = true;
  globalThis.__windows = [dead, window('settings', SETTINGS_URL)];

  publishCommandCatalog(catalog);

  const deliveries = sent.filter((message) => message.channel === IPC.commands.changed);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].to, 'settings');
});

test('an empty catalogue is an answer, and is not confused with no answer', () => {
  resetCommandCatalog();
  const publish = globalThis.__handlers.get(IPC.commands.publish);
  const read = globalThis.__handlers.get(IPC.commands.catalog);

  // Before the shell starts there is nothing to show, and the editor has to be
  // able to tell that apart from "this application has no commands".
  assert.equal(read(event(SETTINGS_URL)), null);

  publish(event(SHELL_URL), []);
  assert.deepEqual(read(event(SETTINGS_URL)), []);
});
