/**
 * Eukolia — advanced settings, stored as JSON on disk.
 *
 * The settings UI edits the values the application understands, which is the
 * right surface for everyday use but a poor one for anything the schema does not
 * name: a per-command keybinding, an experimental flag, a value an extension
 * adds later. Those live in a plain JSON file the user can open in any editor.
 *
 * Two scopes, matching `SettingsManager`:
 *
 *  * **user** — `<library>/.eukolia/settings.json`. Applies to every project.
 *    The old app-data layout remains a migration source before setup.
 *  * **workspace** — `.eukolia/settings.json` inside the open project, committed
 *    with the project if the author wants that. It wins over the user file.
 *
 * The files are watched: editing one in an external editor takes effect without
 * restarting, which is the whole point of exposing them as files.
 */

import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
// The user-scope layout is defined once, in the renderer's `core/userPaths`, and
// shared here so the main process, the renderer and the tests cannot disagree
// about where a user's files live.
import { userSettingsPathFor } from '../../renderer/core/userPaths';
import { userSnippetsPath } from '../snippets/store';
import { libraryUserDirectory, resolveUserSettingsFile } from '../library/projectLibrary';
import type {
  SettingsFileDescription,
  SettingsScope,
  SettingsWriteRequest
} from '../../shared/ipc';

/**
 * Directory (relative to a project root) holding the workspace-scope file.
 *
 * It is the same directory name the user scope uses, which is deliberate: a
 * project carries `.eukolia/settings.json` and the user's own copy of the same
 * layout lives in `<library>/.eukolia`, so "the settings file" means the same
 * thing in both scopes and the file the user opens in each is found the same
 * way. The user scope's layout is defined once in `core/userPaths` and
 * imported, so the main process, the renderer and the tests cannot disagree
 * about where a user's files live.
 */
export const WORKSPACE_SETTINGS_DIRECTORY = '.eukolia';

/** Name of both scopes' settings file. */
export const WORKSPACE_SETTINGS_FILENAME = 'settings.json';

const watchers = new Map<string, fs.FSWatcher>();
const watcherScopes = new Map<string, SettingsScope>();
let changeListener: ((description: SettingsFileDescription) => void) | null = null;

/**
 * The application data directory, which is what the shared layout is expressed
 * against: `%APPDATA%\Eukolia` on Windows.
 */
function appDataDirectory(): string {
  return app.getPath('userData');
}

/**
 * The directory the user's settings and snippets live in.
 *
 * `<library>/.eukolia` once a library is set up — the same folder as the
 * snippets and the global scripts, so one directory holds everything the user
 * owns — and the legacy `User` directory in application data before that.
 * `userSettingsPathFor` is the shared spelling of the legacy path rather than a
 * hand-built `User/settings.json`, so this file and `core/userPaths` cannot
 * drift apart.
 */
export function userDirectory(): string {
  const appData = appDataDirectory();
  return libraryUserDirectory(appData) ?? path.dirname(userSettingsPathFor(appData));
}

/** The user-scope settings path. */
export function userSettingsPath(): string {
  return path.join(userDirectory(), 'settings.json');
}

/** The directory the user's own `*.hsnips` files are read from. */
export function userSnippetsDirectory(): string {
  return userSnippetsPath();
}

/**
 * Reads every `*.hsnips` file the user has put in their own snippets directory.
 *
 * HyperSnips itself loads user snippets from a folder, and the language a file
 * applies to is taken from its name (`latex.hsnips`, `all.hsnips`), so the files
 * are returned with their names and the engine decides. A missing directory is
 * normal — it is created the first time the user opens it.
 */
export function readUserSnippetSources(): Array<{ name: string; content: string }> {
  const directory = userSnippetsDirectory();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const sources: Array<{ name: string; content: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.hsnips')) continue;
    try {
      sources.push({
        name: entry.name,
        content: fs.readFileSync(path.join(directory, entry.name), 'utf8')
      });
    } catch {
      // An unreadable snippet file is skipped rather than failing the load: the
      // rest of the library is still usable.
    }
  }
  return sources;
}

/** Creates the user directory (and the snippets folder) if they are missing. */
export function ensureUserDirectory(): string {
  fs.mkdirSync(userSnippetsDirectory(), { recursive: true });
  return userDirectory();
}

/** The workspace-scope settings path for a project root, or `null`. */
export function workspaceSettingsPath(projectRoot: string | null): string | null {
  if (!projectRoot) return null;
  return path.join(projectRoot, WORKSPACE_SETTINGS_DIRECTORY, WORKSPACE_SETTINGS_FILENAME);
}

/**
 * Resolves a scope to a concrete path.
 *
 * The user scope resolves to the file the settings are currently *read* from,
 * not merely to where they would be written: the user's settings live in
 * `<library>/.eukolia` once a library exists and in application data before
 * that, so a write has to land in the same file the reader just read. Writing to
 * a fixed location while reading from another is how the settings UI showed a
 * value it then failed to save.
 */
function pathForScope(scope: SettingsScope, projectRoot: string | null): string | null {
  return scope === 'workspace' ? workspaceSettingsPath(projectRoot) : userSettingsPath();
}

/**
 * Reads one settings file.
 *
 * A missing file is normal — it is created the first time something is saved —
 * and is reported as `exists: false` with no values rather than as an error. A
 * file that exists but does not parse *is* reported as an error, because
 * silently ignoring a typo in a hand-edited file is worse than saying so.
 */
export function readSettingsFile(
  scope: SettingsScope,
  projectRoot: string | null
): SettingsFileDescription {
  const declared = pathForScope(scope, projectRoot);
  if (!declared) {
    return { scope, path: '', exists: false, values: null, error: 'no project is open' };
  }

  // The user scope is read from the first file it exists in — the library's
  // `.eukolia` first, then the application-data layouts that came before it — so
  // an installation that has not been through setup, or whose library was moved,
  // still reads the settings it has. The workspace scope has exactly one
  // location, which is inside the project.
  const filePath = scope === 'user' ? resolveUserSettingsFile(appDataDirectory()) ?? declared : declared;

  if (!fs.existsSync(filePath)) {
    // Not yet written — which is not a reason to stop watching for it. The
    // watcher is armed on whatever exists (below), so the file appearing is an
    // event like any other.
    watchSettingsFile(scope, projectRoot);
    return {
      scope,
      path: filePath,
      exists: false,
      values: null,
      ...(scope === 'user'
        ? { directory: userDirectory(), userSnippetCount: readUserSnippetSources().length }
        : {})
    };
  }

  const read = readValues(filePath);
  // Watched even when the file does not exist: a project that gains its
  // `.eukolia/settings.json` while it is open — written by another editor, pulled
  // from a repository, or created by the settings UI in another window — has to
  // be noticed, and the watcher below is what notices it.
  watchSettingsFile(scope, projectRoot);
  return {
    scope,
    path: filePath,
    exists: true,
    values: read.values,
    ...(read.error ? { error: read.error } : {}),
    ...(scope === 'user'
      ? { directory: userDirectory(), userSnippetCount: readUserSnippetSources().length }
      : {})
  };
}

/** Parses one settings file, reporting a malformed one rather than ignoring it. */
function readValues(filePath: string): { values: Record<string, unknown> | null; error?: string } {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { values: null, error: 'the file must contain a JSON object' };
    }
    return { values: parsed as Record<string, unknown> };
  } catch (error) {
    return { values: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Writes one settings file.
 *
 * The write is atomic — a temporary file in the same directory, then a rename —
 * so a crash cannot leave a half-written file that then fails to parse on the
 * next start.
 */
export function writeSettingsFile(
  request: SettingsWriteRequest,
  projectRoot: string | null
): SettingsFileDescription {
  const filePath = pathForScope(request.scope, projectRoot);
  if (!filePath) {
    return {
      scope: request.scope,
      path: '',
      exists: false,
      values: null,
      error: 'no project is open'
    };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (request.scope === 'user') ensureUserDirectory();
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(request.values, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);

  watchSettingsFile(request.scope, projectRoot);
  return {
    scope: request.scope,
    path: filePath,
    exists: true,
    values: request.values,
    ...(request.scope === 'user'
      ? { directory: userDirectory(), userSnippetCount: readUserSnippetSources().length }
      : {})
  };
}

/** Creates the file if it is missing, so "open settings file" always opens something. */
export function ensureSettingsFile(
  scope: SettingsScope,
  projectRoot: string | null
): SettingsFileDescription {
  const current = readSettingsFile(scope, projectRoot);
  if (current.exists || !current.path) return current;
  return writeSettingsFile({ scope, values: {} }, projectRoot);
}

/** Opens a settings file in the user's editor. */
export async function openSettingsFile(
  scope: SettingsScope,
  projectRoot: string | null
): Promise<string> {
  const description = ensureSettingsFile(scope, projectRoot);
  if (description.path) await shell.openPath(description.path);
  return description.path;
}

/**
 * Watches a settings file so an external edit is picked up without a restart.
 *
 * `fs.watch` on the containing directory rather than the file: an editor that
 * writes atomically (rename over the original) would otherwise leave the watch
 * pointing at a deleted inode and stop reporting changes.
 *
 * The directory is deliberately **not** created here. This runs when a project
 * is opened, so creating it meant that merely opening a folder left an empty
 * `.eukolia/` behind in every project — a directory the project did not ask for
 * and that no code reads until the user actually saves a workspace setting. A
 * scope with no file on disk has nothing to watch: the watch is established by
 * `writeSettingsFile` at the moment the file is first written, which is also
 * when the directory is created.
 */
export function watchSettingsFile(scope: SettingsScope, projectRoot: string | null): void {
  const filePath = pathForScope(scope, projectRoot);
  if (!filePath || watchers.has(filePath)) return;

  const directory = path.dirname(filePath);
  const directoryName = path.basename(directory);
  /**
   * Watch the settings directory when it exists, and the directory that will
   * contain it when it does not.
   *
   * A project need not have a `.eukolia` folder at all — a project written by
   * hand, or one created before the folder existed — and `fs.watch` cannot watch
   * a path that is not there. Watching the project root instead is what makes
   * *creating* the folder an event: `fs.watch` is not recursive, so the root
   * reports the new `.eukolia` entry and nothing inside it, which is exactly the
   * signal needed to re-arm the watcher on the directory itself.
   */
  const watchRoot = fs.existsSync(directory) ? directory : path.dirname(directory);
  if (!fs.existsSync(watchRoot)) return;
  const watchingParent = watchRoot !== directory;

  try {
    const watcher = fs.watch(watchRoot, (_event, filename) => {
      const name = filename ? path.basename(String(filename)) : '';
      if (watchingParent) {
        // Anything but the settings directory appearing is someone else's file.
        if (name && name !== directoryName) return;
        watcher.close();
        watchers.delete(filePath);
        watcherScopes.delete(filePath);
        // The directory is there now: watch it, and read whatever it already
        // holds — the file may have been written in the same breath.
        watchSettingsFile(scope, projectRoot);
        if (changeListener) changeListener(readSettingsFile(scope, projectRoot));
        return;
      }
      if (name && name !== path.basename(filePath)) return;
      if (!changeListener) return;
      changeListener(readSettingsFile(scope, projectRoot));
    });
    watchers.set(filePath, watcher);
    watcherScopes.set(filePath, scope);
  } catch {
    // Watching is best-effort: an unwatchable directory must not break startup.
  }
}

/**
 * Stops watching files whose project is no longer open.
 *
 * Both scopes now use a `.eukolia` directory. Track the registered scope
 * explicitly so switching projects closes only project watchers, even if the
 * library is unavailable or its location file is damaged.
 */
export function stopWatchingWorkspace(): void {
  for (const [filePath, watcher] of watchers) {
    if (watcherScopes.get(filePath) === 'workspace') {
      watcher.close();
      watchers.delete(filePath);
      watcherScopes.delete(filePath);
    }
  }
}

/** Installs the callback used to tell the renderer a file changed. */
export function onSettingsFileChanged(
  listener: ((description: SettingsFileDescription) => void) | null
): void {
  changeListener = listener;
}

/** Closes every watcher; used on shutdown so the process can exit. */
export function closeSettingsWatchers(): void {
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
  watcherScopes.clear();
}
