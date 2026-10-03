import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerTypeScript } from '../helpers/register-typescript.mjs';

/**
 * The window is painted before the renderer exists, so the main process reads
 * the user's saved theme straight out of their settings file. That read has to
 * find the same file everything else does: `<library>/.eukolia/settings.json`
 * first, then the application-data layouts that came before it. Reading only the
 * legacy paths meant a user whose settings live in their project library got the
 * built-in dark window however they had configured the application.
 *
 * The colours are the same tokens `THEME_WINDOW_COLOURS` names in `windows.ts`;
 * they are asserted by value because that is what the browser window is actually
 * constructed with, and a token renamed without the map following it would
 * otherwise ship as an unthemed strip above a themed window.
 */

registerTypeScript({
  electron: `data:text/javascript,
    export const app = { getPath: () => globalThis.windowTestAppData };
    export const shell = { openPath: async () => '' };
    export const nativeTheme = { shouldUseDarkColors: true };
    export class BrowserWindow {}`,
  [new URL('../../src/main/ipc/appHandler', import.meta.url).href]:
    'data:text/javascript,export function watchWindowState(){};export function logToFile(){};export function rememberWorkspace(){};',
  // The search order itself is `projectLibrary`'s business and is covered by
  // `libraryServices.node.test.mjs`; this stub is the same order, so the two
  // files cannot drift into testing different things.
  [new URL('../../src/main/library/projectLibrary', import.meta.url).href]:
    'data:text/javascript,export const userSettingsSearchPaths = (appData) => [globalThis.windowTestLibraryFile(appData), ...globalThis.windowTestLegacyFiles(appData)];',
});

const { savedThemeColours } = await import('../../src/main/windows.ts');

const DARK = '#0e1017';
const LIGHT = '#f6f7f9';
const NORD = '#2e3440';

/** A fresh application-data directory, removed when the test ends. */
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eukolia-window-theme-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('eukolia-window-theme-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const appData = path.join(directory, 'app');
  globalThis.windowTestLibraryFile = (root) =>
    path.join(root, 'library', '.eukolia', 'settings.json');
  globalThis.windowTestLegacyFiles = (root) => [
    path.join(root, 'User', 'settings.json'),
    path.join(root, 'advanced-settings.json'),
  ];
  return appData;
}

/** Writes one of the layout's settings files and returns the app-data path. */
function withSettings(appData, relative, values) {
  const file = path.join(appData, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(values));
  return file;
}

test('the window is painted in the theme the user chose in their project library', (t) => {
  const appData = fixture(t);
  withSettings(appData, path.join('library', '.eukolia', 'settings.json'), {
    'general.theme': 'nord',
  });
  // The older layout is present and must not decide: the library file is the
  // user's current settings, not a copy of them.
  withSettings(appData, path.join('User', 'settings.json'), {
    'general.theme': 'light',
  });

  globalThis.windowTestAppData = appData;
  assert.equal(savedThemeColours().bg, NORD);
});

test('the legacy layouts are still read when the library has no settings file', (t) => {
  const appData = fixture(t);
  withSettings(appData, path.join('User', 'settings.json'), {
    'general.theme': 'nord',
  });
  globalThis.windowTestAppData = appData;
  assert.equal(savedThemeColours().bg, NORD);
});

test('a settings file that cannot be parsed falls back to the dark window', (t) => {
  const appData = fixture(t);
  const file = path.join(appData, 'library', '.eukolia', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  globalThis.windowTestAppData = appData;
  assert.equal(savedThemeColours().bg, DARK);
});

test('an unknown theme name falls back to the dark window rather than an uncoloured one', (t) => {
  const appData = fixture(t);
  withSettings(appData, path.join('library', '.eukolia', 'settings.json'), {
    'general.theme': 'a-theme-from-a-future-build',
  });
  globalThis.windowTestAppData = appData;
  assert.equal(savedThemeColours().bg, DARK);
});

test('no settings file anywhere is the dark window, which is what a first run shows', (t) => {
  const appData = fixture(t);
  globalThis.windowTestAppData = appData;
  assert.equal(savedThemeColours().bg, DARK);
});

test('"system" follows the operating system, which the stub reports as dark', (t) => {
  const appData = fixture(t);
  withSettings(appData, path.join('library', '.eukolia', 'settings.json'), {
    'general.theme': 'system',
  });
  globalThis.windowTestAppData = appData;
  assert.equal(savedThemeColours().bg, DARK);
});

test('a light theme is reported as light, so the window is not always dark', (t) => {
  const appData = fixture(t);
  withSettings(appData, path.join('library', '.eukolia', 'settings.json'), {
    'general.theme': 'light',
  });
  globalThis.windowTestAppData = appData;
  assert.equal(savedThemeColours().bg, LIGHT);
});
