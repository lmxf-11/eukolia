/**
 * Eukolia — the managed snippet library on disk.
 *
 * The user's snippets used to be a folder of `*.hsnips` files; they are now one
 * `snippets.json` in the EUSnips format, in the `.eukolia` folder of the
 * project library the user chose — beside `settings.json`, `globals.js` and
 * `macros.tex`, so everything the user owns is in one portable place. Before a
 * library exists (or on an installation that has never run setup) the older
 * application-data layouts are still used, which is what {@link
 * userSnippetsPath} resolves.
 *
 * That makes this module deliberately thin: it owns *where* the file is, the
 * bytes in it, and telling the renderer when those bytes change. It does not
 * parse, validate or interpret them — the format's meaning lives in
 * `src/renderer/snippets/eusnips/`, which the tests can exercise without
 * Electron.
 *
 * The file is watched on its *directory* rather than on the file itself, for the
 * same reason the settings files are: an editor that saves by renaming a
 * temporary file over the original would otherwise leave the watch pointed at a
 * deleted inode, and the "hand-edit is picked up without a restart" promise
 * would quietly stop holding.
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  USER_GLOBALS_FILENAME,
  USER_SETTINGS_FILENAME,
  USER_SNIPPETS_FILENAME,
  userDirectoryFor,
  userSettingsPathFor,
  userSnippetsDirectoryFor
} from '../../renderer/core/userPaths';
import type { SnippetFileDescription } from '../../shared/ipc';
import { libraryUserDirectory } from '../library/projectLibrary';

export { USER_GLOBALS_FILENAME, USER_SNIPPETS_FILENAME };

/** Legacy `*.hsnips` files are still listed and still readable, never written. */
export const LEGACY_SNIPPETS_EXTENSION = '.hsnips';

let watcher: fs.FSWatcher | null = null;
let watchedDirectory: string | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let changeListener: ((description: SnippetFileDescription) => void) | null = null;
let snippetsDirectoryOverride: string | null = null;

const userDataDirectory = (): string => {
  try {
    return app.getPath('userData');
  } catch {
    return path.join(process.cwd(), '.test-user-data');
  }
};

/** Resolves environment variables and relative tokens in path strings. */
export function resolveDirectoryPath(rawPath: string): string {
  let resolved = rawPath.trim();
  if (process.platform === 'win32') {
    resolved = resolved.replace(/%(\w+)%/g, (_, v) => process.env[v] || '');
  } else {
    resolved = resolved.replace(/\$(\w+)/g, (_, v) => process.env[v] || '');
  }
  if (resolved.startsWith('~')) {
    resolved = path.join(process.env.HOME || process.env.USERPROFILE || '', resolved.slice(1));
  }
  return path.resolve(resolved);
}

/**
 * The settings files that carry the user's own preferences, most authoritative
 * first.
 *
 * The user's settings live in `<library>/.eukolia/settings.json` — alongside
 * `snippets.json`, `globals.js` and `macros.tex`, which is what makes that
 * folder the portable record of who the user is rather than only of their
 * snippets. The two application-data locations are the layouts that came
 * before it and are still read, so an installation that has not been through
 * setup keeps working: `User/settings.json`, and the pre-`User` name it had.
 *
 * A damaged library pointer is skipped rather than thrown from: a settings file
 * that cannot be *located* must not be the thing that stops a snippet library
 * from loading. The damage is reported where the library is described.
 */
function userSettingsCandidatePaths(appData: string): string[] {
  const paths: string[] = [];
  try {
    const library = libraryUserDirectory(appData);
    if (library) paths.push(path.join(library, USER_SETTINGS_FILENAME));
  } catch {
    /* an unreadable pointer is a missing location, not a fatal one */
  }
  paths.push(userSettingsPathFor(appData));
  paths.push(path.join(appData, 'settings.json'));
  return paths;
}

/** The first of those files that exists, or `null` when none does. */
function existingUserSettingsFile(): string | null {
  for (const candidate of userSettingsCandidatePaths(userDataDirectory())) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* a path that cannot be tested is treated as absent */
    }
  }
  return null;
}

/** Reads the custom snippets folder out of the user's first settings file. */
export function getConfiguredUserSnippetsDirectory(): string | null {
  const settingsPath = existingUserSettingsFile();
  if (!settingsPath) return null;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const configured = parsed?.['snippets.userSnippetsDirectory'];
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return resolveDirectoryPath(configured);
    }
  } catch {
    // If settings cannot be read, fall back to default
  }
  return null;
}

/** Testing helper to override the snippets directory in memory. */
export function setUserSnippetsDirectoryOverride(dir: string | null): void {
  snippetsDirectoryOverride = dir ? path.resolve(dir) : null;
}

/**
 * The active user's snippets directory.
 *
 * The project library's `.eukolia` folder comes first, because that is where
 * the application tells the user their snippets and user settings live — the
 * manager's "Open folder", the location under the library, and the Settings UI
 * all name it — so the file read here is the file they are looking at. Without
 * a library (before setup, or an installation that has never run it) the older
 * layouts still apply, in the order they were introduced: a folder named in
 * settings, then `User/snippets` in application data.
 */
export function userSnippetsPath(): string {
  if (snippetsDirectoryOverride) return snippetsDirectoryOverride;
  // A pointer that cannot be read is treated as no library at all rather than
  // thrown from: this is on the path that resolves every snippet read and write,
  // and a snippet library that refuses to load because the *location* file is
  // damaged is a worse failure than falling back to the layout that still works.
  // The damage is reported where the library itself is described.
  let library: string | null = null;
  try {
    library = libraryUserDirectory(userDataDirectory());
  } catch {
    library = null;
  }
  if (library) return library;
  const configured = getConfiguredUserSnippetsDirectory();
  if (configured) return configured;
  return userSnippetsDirectoryFor(userDataDirectory());
}

/** The managed library's absolute path. */
export function userSnippetsFilePath(): string {
  return path.join(userSnippetsPath(), USER_SNIPPETS_FILENAME);
}

/** The global scripts file's absolute path. */
export function userGlobalsFilePath(): string {
  return path.join(userSnippetsPath(), USER_GLOBALS_FILENAME);
}

/** Default script content placed into a newly generated globals.js. */
export const DEFAULT_GLOBALS_JAVASCRIPT = `/**
 * Eukolia — Global Snippet Scripts
 * Functions, constants, and lookup tables declared here are shared across all snippets.
 */

// Helper to open inline math in text mode
function openInlineMath(match, content = "") {
  return match[1] ? content : match[2] + "\\\\$" + content;
}

// Delimiter splitter for auto-inline math
function splitInlineDelimiter(raw = "") {
  const comma = raw.endsWith(",");
  return {
    whitespace: comma ? raw.slice(0, -1) : raw,
    comma: comma ? "," : ""
  };
}

// Inline math opener with delimiter support
function openInlineMathDelimited(match, delimiterIndex = 2, dollarIndex = 1) {
  const delimiter = splitInlineDelimiter(match[delimiterIndex] || "");
  const opening = match[dollarIndex] ? "" : delimiter.whitespace + "\\\\$";
  return opening + delimiter.comma;
}

// Display math prefix helper
function displayMathPrefix(match) {
  if (match && typeof match[2] !== "undefined" && match[2] !== "") {
    const math = match[2].replace(/\\$/g, "\\\\$");
    return match[1] + math + "\\n" + match[1];
  }
  return (match && match[1]) || "";
}
`;

/** Creates the snippets directory and ensures globals.js exists by default. */
export function ensureUserSnippetsDirectory(): string {
  const directory = userSnippetsPath();
  fs.mkdirSync(directory, { recursive: true });

  const globalsPath = path.join(directory, USER_GLOBALS_FILENAME);
  if (!fs.existsSync(globalsPath)) {
    let initialJs = DEFAULT_GLOBALS_JAVASCRIPT;
    const snippetsPath = path.join(directory, USER_SNIPPETS_FILENAME);
    if (fs.existsSync(snippetsPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(snippetsPath, 'utf8'));
        const existing = parsed?.globals?.javascript;
        if (existing) {
          const js = Array.isArray(existing) ? existing.join('\n') : String(existing);
          if (js.trim().length > 0) {
            initialJs = js;
          }
        }
      } catch {
        // Fall back to default
      }
    }
    try {
      fs.writeFileSync(globalsPath, initialJs, 'utf8');
    } catch (err) {
      console.warn('[eukolia] could not write default globals.js', err);
    }
  }

  return directory;
}

function legacyFilesIn(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(LEGACY_SNIPPETS_EXTENSION))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Reads the library.
 *
 * A missing file is a normal state — it is the first-run seed signal — and is
 * reported as `exists: false` rather than as an error. A file that exists but
 * cannot be read *is* an error, because the caller must not treat "unreadable"
 * as "empty" and overwrite a library it could not see.
 */
export function readUserSnippetsFile(): SnippetFileDescription {
  const directory = ensureUserSnippetsDirectory();
  const filePath = path.join(directory, USER_SNIPPETS_FILENAME);
  const globalsPath = path.join(directory, USER_GLOBALS_FILENAME);
  const legacyFiles = legacyFilesIn(directory);

  let globalsJs: string | null = null;
  try {
    if (fs.existsSync(globalsPath)) {
      globalsJs = fs.readFileSync(globalsPath, 'utf8');
    }
  } catch (err) {
    console.warn('[eukolia] could not read globals.js', err);
  }

  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return {
      path: filePath,
      directory,
      exists: true,
      text,
      legacyFiles,
      globalsJs,
      globalsPath
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return {
        path: filePath,
        directory,
        exists: false,
        text: null,
        legacyFiles,
        globalsJs,
        globalsPath
      };
    }
    return {
      path: filePath,
      directory,
      exists: true,
      text: null,
      error: error instanceof Error ? error.message : String(error),
      legacyFiles,
      globalsJs,
      globalsPath
    };
  }
}

/** Reads the legacy `.hsnips` sources, so the renderer can offer to import them. */
export function readLegacySnippetSources(): Array<{ name: string; content: string }> {
  const directory = userSnippetsPath();
  const sources: Array<{ name: string; content: string }> = [];
  for (const name of legacyFilesIn(directory)) {
    try {
      sources.push({ name, content: fs.readFileSync(path.join(directory, name), 'utf8') });
    } catch {
      // An unreadable legacy file is skipped: the point of listing them is to
      // offer an import, and the rest of the list is still useful.
    }
  }
  return sources;
}

/**
 * Writes the library atomically: a temporary file in the same directory, then a
 * rename over the original, so a crash mid-write cannot leave a truncated file
 * that then fails to parse on the next start.
 */
export function writeUserSnippetsFile(text: string, globalsJs?: string): SnippetFileDescription {
  const directory = ensureUserSnippetsDirectory();
  const filePath = path.join(directory, USER_SNIPPETS_FILENAME);
  const globalsPath = path.join(directory, USER_GLOBALS_FILENAME);

  // Write snippets.json atomically
  const nonce = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const temporary = `${filePath}.${process.pid}.${nonce}.tmp`;
  fs.writeFileSync(temporary, text, 'utf8');
  try {
    fs.renameSync(temporary, filePath);
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* temporary file swept up */
    }
    fs.writeFileSync(filePath, text, 'utf8');
  }

  // Write globals.js if provided
  if (typeof globalsJs === 'string') {
    const tempGlobals = `${globalsPath}.${process.pid}.${nonce}.tmp`;
    fs.writeFileSync(tempGlobals, globalsJs, 'utf8');
    try {
      fs.renameSync(tempGlobals, globalsPath);
    } catch {
      try {
        fs.rmSync(tempGlobals, { force: true });
      } catch {
        /* temporary file swept up */
      }
      fs.writeFileSync(globalsPath, globalsJs, 'utf8');
    }
  }

  return readUserSnippetsFile();
}

/**
 * Watches the snippets directory so a hand-edit of `snippets.json` or `globals.js`
 * takes effect without a restart.
 */
export function watchUserSnippetsFile(): void {
  const directory = userSnippetsPath();
  if (watcher && watchedDirectory === directory) return;

  stopWatchingUserSnippets();
  try {
    fs.mkdirSync(directory, { recursive: true });
    watcher = fs.watch(directory, (_event, filename) => {
      const name = filename ? path.basename(String(filename)) : null;
      if (
        name &&
        name !== USER_SNIPPETS_FILENAME &&
        name !== USER_GLOBALS_FILENAME &&
        !name.endsWith('.tmp')
      ) {
        return;
      }
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        changeListener?.(readUserSnippetsFile());
      }, 120);
    });
    watchedDirectory = directory;
  } catch {
    // Watching is best-effort: a directory that cannot be watched must not stop
    // snippets from working, it only costs the live reload.
  }
}

/** Stops watching; used on shutdown so the process can exit. */
export function stopWatchingUserSnippets(): void {
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  watcher?.close();
  watcher = null;
  watchedDirectory = null;
}

/** Installs the callback that tells the renderer the file changed. */
export function onUserSnippetsChanged(
  listener: ((description: SnippetFileDescription) => void) | null
): void {
  changeListener = listener;
}
