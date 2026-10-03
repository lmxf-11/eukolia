/**
 * Legacy app-data paths, retained for migration and installations before setup.
 * Active library paths are resolved by main/library/projectLibrary.ts.
 *
 * Everything the *user* owns — as opposed to a project, or a reference we ported
 * — sits in one directory inside the application's data directory:
 *
 *   C:\Users\<name>\AppData\Roaming\eukolia\User\
 *       settings.json             the user-scope settings, including `snippets.*`
 *       snippets\snippets.json    the managed EUSnips library
 *       snippets\*.hsnips         legacy HyperSnips files, read but never written
 *
 * (The application-data directory is spelled `eukolia` in lower case because
 * that is what Electron's `app.getPath('userData')` derives from the package
 * name; it is the directory the application has always created, and this module
 * takes it as an argument rather than guessing.)
 *
 * The layout is written down once, here, and takes the application data
 * directory as an argument rather than reading it from Electron. That keeps the
 * definition usable from the main process (which knows the directory), from the
 * renderer (which only needs to display it) and from tests (which have neither).
 */

import path from 'node:path';

/** The directory holding everything the user owns, inside the app data folder. */
export const USER_DIRECTORY = 'User';

/** The user-scope settings file. */
export const USER_SETTINGS_FILENAME = 'settings.json';

/** The sub-directory of `User` holding the user's snippet library. */
export const USER_SNIPPETS_DIRECTORY = 'snippets';

/** The managed snippet library's file name inside {@link USER_SNIPPETS_DIRECTORY}. */
export const USER_SNIPPETS_FILENAME = 'snippets.json';

/** The global scripts file name inside the user's snippets directory. */
export const USER_GLOBALS_FILENAME = 'globals.js';

/** Legacy HyperSnips files, read for migration and never written. */
export const LEGACY_SNIPPETS_EXTENSION = '.hsnips';

/** The name the user-scope file had before the `User` directory existed. */
export const LEGACY_USER_SETTINGS_FILENAME = 'advanced-settings.json';

/** The `User` directory for an application data directory. */
export function userDirectoryFor(appDataDirectory: string): string {
  return path.join(appDataDirectory, USER_DIRECTORY);
}

/** The user-scope settings file for an application data directory. */
export function userSettingsPathFor(appDataDirectory: string): string {
  return path.join(userDirectoryFor(appDataDirectory), USER_SETTINGS_FILENAME);
}

/** The user's own snippet folder for an application data directory. */
export function userSnippetsDirectoryFor(appDataDirectory: string): string {
  return path.join(userDirectoryFor(appDataDirectory), USER_SNIPPETS_DIRECTORY);
}

/** The managed snippet library for an application data directory. */
export function userSnippetsPathFor(appDataDirectory: string): string {
  return path.join(userSnippetsDirectoryFor(appDataDirectory), USER_SNIPPETS_FILENAME);
}

/** The global scripts file for an application data directory. */
export function userGlobalsPathFor(appDataDirectory: string): string {
  return path.join(userSnippetsDirectoryFor(appDataDirectory), USER_GLOBALS_FILENAME);
}

/** Where the user-scope file lived before the `User` directory, read for migration. */
export function legacyUserSettingsPathFor(appDataDirectory: string): string {
  return path.join(appDataDirectory, LEGACY_USER_SETTINGS_FILENAME);
}

/**
 * The language a legacy `.hsnips` file applies to.
 *
 * HyperSnips keys a source's language off its file name — `latex.hsnips`,
 * `bibtex.hsnips`, `all.hsnips` for a global one — so the name is the whole
 * configuration and no per-file setting is needed. A name that carries no
 * language is read as global rather than dropped, which is the only reading that
 * cannot silently lose a user's snippets.
 *
 * The managed `snippets.json` carries its language as a property instead; this
 * is what the importer uses to record where an imported snippet came from.
 */
export function languageFromSnippetFilename(fileName: string): string {
  const base = fileName.replace(new RegExp(`${LEGACY_SNIPPETS_EXTENSION}$`, 'i'), '').trim().toLowerCase();
  return base.length > 0 ? base : 'all';
}
