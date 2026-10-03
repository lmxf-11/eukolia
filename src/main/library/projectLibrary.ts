/** Project-library persistence and creation, independent of Electron for filesystem tests. */
import fs from 'node:fs';
import path from 'node:path';
// The user-scope layout is defined once, in the renderer's `core/userPaths`, and
// shared here so the main process, the renderer and the tests cannot disagree
// about where a user's files live.
import {
  USER_SETTINGS_FILENAME,
  legacyUserSettingsPathFor,
  userSettingsPathFor,
} from '../../renderer/core/userPaths';
import type {
  CreateLibraryProject,
  CreatedLibraryProject,
  ProjectLibraryStatus,
} from '../../shared/projectLibrary';

const bootstrapFile = (appData: string) =>
  path.join(appData, 'project-library.json');

export function configuredLibraryRoot(appData: string): string | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(bootstrapFile(appData), 'utf8'),
    ).root;
    return typeof value === 'string' && path.isAbsolute(value)
      ? path.resolve(value)
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Cannot read the project library location: ${String(error)}`,
    );
  }
}

export function libraryUserDirectory(appData: string): string | null {
  const root = configuredLibraryRoot(appData);
  return root ? path.join(root, '.eukolia') : null;
}

/**
 * The files that carry the user's own settings, most authoritative first.
 *
 * The user's settings live beside their snippets in `<library>/.eukolia` — one
 * folder holding everything that follows the user rather than the projects —
 * and the two application-data layouts that came before it are still read, so
 * an installation that has not been through setup, or one whose pointer has
 * been damaged since, keeps reading the settings it has: `User/settings.json`,
 * then the `advanced-settings.json` that predates the `User` directory.
 *
 * The first entry is absent when no library is set up, which is what makes the
 * returned list the whole search order rather than a guess at one location.
 * A pointer that cannot be parsed contributes nothing: a damaged library
 * location must not stop the process reading the settings that do exist — the
 * damage is reported where the library itself is described.
 */
export function userSettingsSearchPaths(appData: string): string[] {
  const paths: string[] = [];
  try {
    const library = libraryUserDirectory(appData);
    if (library) paths.push(path.join(library, USER_SETTINGS_FILENAME));
  } catch {
    /* an unreadable pointer is a missing location, not a fatal one */
  }
  paths.push(userSettingsPathFor(appData));
  paths.push(legacyUserSettingsPathFor(appData));
  return paths;
}

/**
 * The file the user's settings are currently read from, or `null` when none of
 * them exists yet.
 */
export function resolveUserSettingsFile(appData: string): string | null {
  for (const candidate of userSettingsSearchPaths(appData)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* a path that cannot be tested is treated as absent */
    }
  }
  return null;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function checkedDirectory(directory: string): string {
  if (!fs.statSync(directory).isDirectory())
    throw new Error(`Not a folder: ${directory}`);
  return fs.realpathSync(directory);
}

function texFiles(directory: string, prefix = ''): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) return [];
      const relative = prefix + entry.name;
      if (entry.isDirectory())
        return texFiles(path.join(directory, entry.name), relative + '/');
      return entry.isFile() && /\.tex$/i.test(entry.name) ? [relative] : [];
    })
    .sort((a, b) => a.localeCompare(b));
}

export function describeLibrary(appData: string): ProjectLibraryStatus {
  const empty: ProjectLibraryStatus = {
    root: null,
    configuredRoot: null,
    templates: [],
    inputs: [],
    hasMacros: false,
    projects: [],
  };
  try {
    const root = configuredLibraryRoot(appData);
    empty.configuredRoot = root;
    if (!root) return empty;
    checkedDirectory(root);
    const shared = checkedDirectory(path.join(root, '.eukolia'));
    if (!inside(fs.realpathSync(root), shared))
      throw new Error('The shared folder must be inside the project library.');
    for (const folder of ['templates', 'inputs']) {
      const target = path.join(shared, folder);
      if (fs.existsSync(target) && !inside(shared, checkedDirectory(target)))
        throw new Error(`${folder} must be inside .eukolia.`);
    }
    return {
      root,
      configuredRoot: root,
      templates: texFiles(path.join(shared, 'templates')),
      inputs: texFiles(path.join(shared, 'inputs')),
      hasMacros: fs.existsSync(path.join(shared, 'macros.tex')),
      projects: fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({
          name: entry.name,
          path: path.join(root, entry.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  } catch (error) {
    return {
      ...empty,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function writeMissing(file: string, contents: string | Buffer): void {
  try {
    fs.writeFileSync(file, contents, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Set only after setup succeeds; never replace an existing library file. */
export function initializeLibrary(
  appData: string,
  chosenRoot: string,
  legacySnippets?: string,
): ProjectLibraryStatus {
  if (typeof chosenRoot !== 'string' || !path.isAbsolute(chosenRoot))
    throw new Error('Choose an absolute folder path.');
  fs.mkdirSync(chosenRoot, { recursive: true });
  const root = checkedDirectory(chosenRoot);
  const shared = path.join(root, '.eukolia');
  fs.mkdirSync(shared, { recursive: true });
  if (!inside(root, checkedDirectory(shared)))
    throw new Error('The shared folder must be inside the project library.');
  for (const folder of ['templates', 'inputs']) {
    const target = path.join(shared, folder);
    fs.mkdirSync(target, { recursive: true });
    if (!inside(shared, checkedDirectory(target)))
      throw new Error(`${folder} must be inside .eukolia.`);
  }
  // Copy legacy settings once, from the first file the user's settings could be
  // read from — the same order {@link userSettingsSearchPaths} describes, minus
  // the library's own file, which is the destination. The originals remain
  // available to older installations.
  for (const old of userSettingsSearchPaths(appData).slice(1)) {
    if (fs.existsSync(old)) {
      writeMissing(path.join(shared, 'settings.json'), fs.readFileSync(old));
      break;
    }
  }
  if (legacySnippets && fs.existsSync(legacySnippets)) {
    for (const entry of fs.readdirSync(legacySnippets, {
      withFileTypes: true,
    })) {
      if (
        entry.isFile() &&
        (['snippets.json', 'globals.js'].includes(entry.name) ||
          /\.hsnips$/i.test(entry.name))
      ) {
        writeMissing(
          path.join(shared, entry.name),
          fs.readFileSync(path.join(legacySnippets, entry.name)),
        );
      }
    }
  }
  writeMissing(
    path.join(shared, 'macros.tex'),
    '% Shared mathematical macros. Copied into new projects when selected.\n',
  );
  writeMissing(
    path.join(shared, 'templates', 'Article.tex'),
    '\\documentclass[11pt]{article}\n\\usepackage{amsmath,amssymb,amsthm}\n\\usepackage{tikz-cd}\n\n\\title{ {{project_name}} }\n\\author{}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\n\\section{Introduction}\n\n\\end{document}\n',
  );
  fs.mkdirSync(appData, { recursive: true });
  const target = bootstrapFile(appData);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, root }, null, 2), 'utf8');
  fs.renameSync(temp, target);
  return describeLibrary(appData);
}

export function validateProjectName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    name.length > 100 ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name) ||
    /[ .]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw new Error(
      'Use a project name with letters, numbers, spaces, hyphens or underscores; avoid reserved file names.',
    );
  }
}

function sourceFile(shared: string, relative: string): string {
  if (
    typeof relative !== 'string' ||
    !/\.tex$/i.test(relative) ||
    !/^[\p{L}\p{N} ._\-/]+$/u.test(relative) ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid template or input file.');
  const target = fs.realpathSync(path.join(shared, relative));
  if (!inside(fs.realpathSync(shared), target) || !fs.statSync(target).isFile())
    throw new Error('Input files must stay inside .eukolia.');
  return target;
}

/** Insert selected copies before the document body, without duplicating existing inputs. */
export function insertProjectInputs(template: string, files: string[]): string {
  // Mask comments without changing positions. An escaped percent is part of TeX text.
  const visible = template.replace(/(^|[^\\])(?:\\\\)*%[^\r\n]*/gm, (match) =>
    match.replace(/[^\r\n]/g, ' '),
  );
  const body = /\\begin\s*\{document\}/.exec(visible);
  if (!body) throw new Error('The template must contain \\begin{document}.');
  const preamble = visible.slice(0, body.index);
  const existing = new Set(
    [...preamble.matchAll(/\\input\s*\{([^}]+)\}/g)].map((match) =>
      match[1].replace(/^\.\//, '').replace(/\.tex$/i, ''),
    ),
  );
  const additions = files
    .filter((file) => !existing.has(file.replace(/\.tex$/i, '')))
    .map((file) => `\\input{${file}}`)
    .join('\n');
  return additions
    ? template.slice(0, body.index) +
        additions +
        '\n\n' +
        template.slice(body.index)
    : template;
}

export function createLibraryProject(
  appData: string,
  request: CreateLibraryProject,
): CreatedLibraryProject {
  validateProjectName(request?.name);
  if (
    !Array.isArray(request.inputs) ||
    !request.inputs.every((input) => typeof input === 'string') ||
    typeof request.copyMacros !== 'boolean'
  )
    throw new Error('Invalid project options.');
  const status = describeLibrary(appData);
  if (!status.root)
    throw new Error(status.error || 'Choose a project library first.');
  if (
    !status.templates.includes(request.template) ||
    request.inputs.some((input) => !status.inputs.includes(input))
  )
    throw new Error('The selected template or input no longer exists.');
  const shared = path.join(status.root, '.eukolia');
  const copies = [
    ...(request.copyMacros ? [{ from: 'macros.tex', to: 'macros.tex' }] : []),
    ...request.inputs.map((input) => ({ from: 'inputs/' + input, to: input })),
  ];
  const names = new Set([`${request.name}.tex`.toLowerCase()]);
  const contents = copies.map((copy) => {
    if (names.has(copy.to.toLowerCase()))
      throw new Error(`Duplicate output file: ${copy.to}`);
    names.add(copy.to.toLowerCase());
    return { ...copy, content: fs.readFileSync(sourceFile(shared, copy.from)) };
  });
  let template = fs.readFileSync(
    sourceFile(shared, 'templates/' + request.template),
    'utf8',
  );
  const title = request.name.replace(/_/g, '\\_');
  template = template.replaceAll('{{project_name}}', title);
  template = insertProjectInputs(
    template,
    copies.map((copy) => copy.to),
  );
  const directory = path.join(status.root, request.name);
  if (
    fs
      .readdirSync(status.root)
      .some((name) => name.toLowerCase() === request.name.toLowerCase())
  )
    throw new Error('A project with that name already exists.');
  fs.mkdirSync(directory); // Exclusive: never overwrite an existing project.
  const written: string[] = [];
  const madeDirectories: string[] = [];
  try {
    for (const file of [
      ...contents,
      { to: `${request.name}.tex`, content: template },
    ]) {
      const target = path.join(directory, file.to);
      let parent = directory;
      for (const segment of file.to.split('/').slice(0, -1)) {
        parent = path.join(parent, segment);
        if (!fs.existsSync(parent)) {
          fs.mkdirSync(parent);
          madeDirectories.push(parent);
        }
      }
      // Record ownership immediately after exclusive creation: a disk-full write
      // can leave a partial file even though writeFileSync throws.
      const descriptor = fs.openSync(target, 'wx');
      written.push(target);
      try {
        fs.writeFileSync(descriptor, file.content);
      } finally {
        fs.closeSync(descriptor);
      }
    }
  } catch (error) {
    for (const file of written.reverse()) fs.unlinkSync(file);
    for (const folder of madeDirectories.reverse()) fs.rmdirSync(folder);
    try {
      fs.rmdirSync(directory);
    } catch {
      /* Never remove other files. */
    }
    throw error;
  }
  return { directory, mainFile: path.join(directory, `${request.name}.tex`) };
}
