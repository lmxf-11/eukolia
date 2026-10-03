import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerTypeScript } from '../helpers/register-typescript.mjs';
// The library module resolves the user's settings locations through the shared
// `core/userPaths`, so the loader that lets Node read `.ts` has to be installed
// before this file's imports are linked — an import graph is linked before any
// module body runs, which is why this call cannot live below them. `electron` is
// stubbed because none of these tests touch application data: they pass every
// path in themselves.
registerTypeScript({
  electron:
    'data:text/javascript,export const app={getPath:()=>globalThis.libraryTestAppData};export const shell={openPath:async()=>""};',
});
const {
  initializeLibrary,
  describeLibrary,
  createLibraryProject,
  insertProjectInputs,
  validateProjectName,
  libraryUserDirectory,
  userSettingsSearchPaths,
  resolveUserSettingsFile,
} = await import('../../src/main/library/projectLibrary.ts');

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'eukolia-library-test-'),
  );
  const appData = path.join(directory, 'app');
  const root = path.join(directory, 'library');
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(
      path.dirname(resolved) === path.resolve(os.tmpdir()) &&
        path.basename(resolved).startsWith('eukolia-library-test-'),
    );
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { directory, appData, root };
}

test('first setup creates a library and adopts it on restart', (t) => {
  const { appData, root } = fixture(t);
  assert.equal(describeLibrary(appData).root, null);
  const status = initializeLibrary(appData, root);
  assert.equal(status.root, fs.realpathSync(root));
  assert.deepEqual(status.templates, ['Article.tex']);
  assert.ok(status.hasMacros);
  assert.ok(fs.statSync(path.join(root, '.eukolia', 'inputs')).isDirectory());
  assert.equal(describeLibrary(appData).root, status.root);
  assert.equal(
    libraryUserDirectory(appData),
    path.join(status.root, '.eukolia'),
  );
});

test('copies legacy files without overwriting an existing library or deleting originals', (t) => {
  const { appData, root } = fixture(t);
  const legacy = path.join(appData, 'User', 'snippets');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(
    path.join(appData, 'User', 'settings.json'),
    '{"editor.fontSize":18}',
  );
  fs.writeFileSync(
    path.join(legacy, 'snippets.json'),
    '{"version":1,"snippets":[]}',
  );
  fs.writeFileSync(path.join(legacy, 'globals.js'), 'const answer = 42;');
  fs.writeFileSync(
    path.join(legacy, 'latex.hsnips'),
    'snippet test\nx\nendsnippet',
  );
  initializeLibrary(appData, root, legacy);
  const shared = path.join(root, '.eukolia');
  assert.equal(
    fs.readFileSync(path.join(shared, 'globals.js'), 'utf8'),
    'const answer = 42;',
  );
  assert.ok(fs.existsSync(path.join(shared, 'latex.hsnips')));
  fs.writeFileSync(
    path.join(shared, 'settings.json'),
    '{"editor.fontSize":20}',
  );
  initializeLibrary(appData, root, legacy);
  assert.equal(
    fs.readFileSync(path.join(shared, 'settings.json'), 'utf8'),
    '{"editor.fontSize":20}',
  );
  assert.ok(fs.existsSync(path.join(legacy, 'snippets.json')));
});

test('creates a named document with selected macros and nested inputs in its preamble', (t) => {
  const { appData, root } = fixture(t);
  initializeLibrary(appData, root);
  const shared = path.join(root, '.eukolia');
  fs.mkdirSync(path.join(shared, 'inputs', 'math'));
  fs.writeFileSync(
    path.join(shared, 'inputs', 'math', 'theorems.tex'),
    '\\newtheorem{theorem}{Theorem}\n',
  );
  const result = createLibraryProject(appData, {
    name: 'Topology_notes',
    template: 'Article.tex',
    copyMacros: true,
    inputs: ['math/theorems.tex'],
  });
  assert.equal(
    result.mainFile,
    path.join(root, 'Topology_notes', 'Topology_notes.tex'),
  );
  const tex = fs.readFileSync(result.mainFile, 'utf8');
  assert.ok(tex.includes('Topology\\_notes'));
  assert.ok(tex.includes('\\input{macros.tex}'));
  assert.ok(tex.includes('\\input{math/theorems.tex}'));
  assert.ok(
    tex.indexOf('\\input{math/theorems.tex}') <
      tex.indexOf('\\begin{document}'),
  );
  assert.equal(
    fs.readFileSync(
      path.join(result.directory, 'math', 'theorems.tex'),
      'utf8',
    ),
    '\\newtheorem{theorem}{Theorem}\n',
  );
  assert.equal(describeLibrary(appData).projects[0].name, 'Topology_notes');
});

test('supports omitting macros and all input files', (t) => {
  const { appData, root } = fixture(t);
  initializeLibrary(appData, root);
  const result = createLibraryProject(appData, {
    name: 'Paper',
    template: 'Article.tex',
    copyMacros: false,
    inputs: [],
  });
  assert.deepEqual(fs.readdirSync(result.directory), ['Paper.tex']);
  assert.ok(!fs.readFileSync(result.mainFile, 'utf8').includes('\\input'));
});

test('rejects duplicate project names and colliding output files before writing', (t) => {
  const { appData, root } = fixture(t);
  initializeLibrary(appData, root);
  const request = {
    name: 'Paper',
    template: 'Article.tex',
    copyMacros: false,
    inputs: [],
  };
  createLibraryProject(appData, request);
  assert.throws(
    () => createLibraryProject(appData, { ...request, name: 'paper' }),
    /already exists/,
  );
  fs.writeFileSync(
    path.join(root, '.eukolia', 'inputs', 'macros.tex'),
    'other',
  );
  assert.throws(
    () =>
      createLibraryProject(appData, {
        ...request,
        name: 'Second',
        copyMacros: true,
        inputs: ['macros.tex'],
      }),
    /Duplicate/,
  );
  assert.ok(!fs.existsSync(path.join(root, 'Second')));
});

test('rejects path traversal, reserved names and unlisted inputs', (t) => {
  const { appData, root } = fixture(t);
  initializeLibrary(appData, root);
  for (const name of [
    '../elsewhere',
    'C:\\outside',
    '.eukolia',
    'CON',
    'aux.tex',
    'Paper.',
    'bad%name',
    'bad{input}',
  ])
    assert.throws(() => validateProjectName(name));
  assert.throws(
    () =>
      createLibraryProject(appData, {
        name: 'Paper',
        template: '../../outside.tex',
        copyMacros: false,
        inputs: [],
      }),
    /no longer exists/,
  );
  assert.throws(
    () =>
      createLibraryProject(appData, {
        name: 'Paper',
        template: 'Article.tex',
        copyMacros: false,
        inputs: ['../macros.tex'],
      }),
    /no longer exists/,
  );
  assert.ok(!fs.existsSync(path.join(root, 'Paper')));
});

test('preamble insertion ignores commented document markers and existing input comments', () => {
  const template =
    '% \\begin{document}\r\n\\documentclass{article}\r\n% \\input{extra.tex}\r\n\\input{macros}\r\n\\begin{document}\r\nBody\r\n\\end{document}';
  const result = insertProjectInputs(template, ['macros.tex', 'extra.tex']);
  assert.equal((result.match(/\\input\{macros/g) || []).length, 1);
  assert.ok(result.includes('\\input{extra.tex}\n\n\\begin{document}'));
  assert.throws(
    () => insertProjectInputs('% \\begin{document}', []),
    /must contain/,
  );
});

test('invalid templates and missing libraries fail without creating projects', (t) => {
  const { appData, root } = fixture(t);
  initializeLibrary(appData, root);
  fs.writeFileSync(
    path.join(root, '.eukolia', 'templates', 'Broken.tex'),
    '% No body',
  );
  assert.throws(
    () =>
      createLibraryProject(appData, {
        name: 'Paper',
        template: 'Broken.tex',
        copyMacros: false,
        inputs: [],
      }),
    /must contain/,
  );
  assert.ok(!fs.existsSync(path.join(root, 'Paper')));
  fs.renameSync(root, root + '-moved');
  assert.equal(describeLibrary(appData).root, null);
  assert.equal(describeLibrary(appData).configuredRoot, root);
  assert.ok(describeLibrary(appData).error);
});

test('failed document writes remove only files owned by the creation request', (t) => {
  const { appData, root } = fixture(t);
  initializeLibrary(appData, root);
  const existing = path.join(root, 'Existing');
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, 'keep.tex'), 'keep');
  const original = fs.writeFileSync;
  fs.writeFileSync = function (target, content, ...options) {
    if (
      typeof target === 'number' &&
      typeof content === 'string' &&
      content.includes('\\documentclass')
    ) {
      original.call(fs, target, 'partial');
      throw new Error('Simulated disk-full write');
    }
    return original.call(fs, target, content, ...options);
  };
  try {
    assert.throws(
      () =>
        createLibraryProject(appData, {
          name: 'Interrupted',
          template: 'Article.tex',
          copyMacros: true,
          inputs: [],
        }),
      /disk-full/,
    );
  } finally {
    fs.writeFileSync = original;
  }
  assert.ok(!fs.existsSync(path.join(root, 'Interrupted')));
  assert.equal(
    fs.readFileSync(path.join(existing, 'keep.tex'), 'utf8'),
    'keep',
  );
});
