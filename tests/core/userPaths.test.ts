/**
 * Where the user's own settings and snippets live.
 *
 * They belong to the user, not the project, so they sit in the application's
 * user-data directory: `%APPDATA%\Eukolia\User` on Windows. The snippet engine is
 * configured from the same place, because a snippet library is a setting like any
 * other — it just happens to be a `.hsnips` file rather than a key.
 *
 * The path helpers take the user-data directory as an argument rather than
 * reading it from Electron, so the layout can be tested without a running app.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  USER_DIRECTORY,
  USER_SETTINGS_FILENAME,
  USER_SNIPPETS_DIRECTORY,
  userSettingsPathFor,
  userSnippetsDirectoryFor,
  legacyUserSettingsPathFor,
  languageFromSnippetFilename
} from '@/core/userPaths';

/** A stand-in for `app.getPath('userData')` on Windows. */
const USER_DATA = path.join('C:', 'Users', 'Ada', 'AppData', 'Roaming', 'Eukolia');

describe('the user settings directory', () => {
  it('is the `User` folder inside the application data directory', () => {
    expect(USER_DIRECTORY).toBe('User');
    expect(userSettingsPathFor(USER_DATA)).toBe(
      path.join(USER_DATA, 'User', 'settings.json')
    );
    expect(path.basename(userSettingsPathFor(USER_DATA))).toBe(USER_SETTINGS_FILENAME);
  });

  it('keeps the user snippets beside the settings file', () => {
    // One directory for everything the user owns, which is what makes "open the
    // user folder" a complete answer to "where do I put my snippets?".
    expect(userSnippetsDirectoryFor(USER_DATA)).toBe(
      path.join(USER_DATA, 'User', USER_SNIPPETS_DIRECTORY)
    );
    expect(path.dirname(userSnippetsDirectoryFor(USER_DATA))).toBe(
      path.dirname(userSettingsPathFor(USER_DATA))
    );
  });

  it('remembers where the settings file used to be', () => {
    // Before the `User` folder the file sat directly in the data directory; it is
    // still read so an upgrade does not discard the user's configuration.
    expect(legacyUserSettingsPathFor(USER_DATA)).toBe(
      path.join(USER_DATA, 'advanced-settings.json')
    );
    expect(legacyUserSettingsPathFor(USER_DATA)).not.toBe(
      userSettingsPathFor(USER_DATA)
    );
  });

  it('produces distinct paths for distinct user-data directories', () => {
    const other = path.join('C:', 'Users', 'Grace', 'AppData', 'Roaming', 'Eukolia');
    expect(userSettingsPathFor(other)).not.toBe(userSettingsPathFor(USER_DATA));
  });
});

describe('the language a user snippet file applies to', () => {
  it('comes from the file name, as it does in HyperSnips', () => {
    expect(languageFromSnippetFilename('latex.hsnips')).toBe('latex');
    expect(languageFromSnippetFilename('bibtex.hsnips')).toBe('bibtex');
  });

  it('is case-insensitive about the extension', () => {
    expect(languageFromSnippetFilename('LaTeX.HSNIPS')).toBe('latex');
  });

  it('treats a file with no language in its name as global', () => {
    // `all.hsnips` is HyperSnips' way of marking a source global; a name that
    // carries no language at all is read the same way rather than being dropped.
    expect(languageFromSnippetFilename('all.hsnips')).toBe('all');
    expect(languageFromSnippetFilename('.hsnips')).toBe('all');
  });
});
