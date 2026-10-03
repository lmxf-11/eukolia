import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerTypeScript } from '../helpers/register-typescript.mjs';
registerTypeScript({
  electron:
    'data:text/javascript,export const app={getPath:()=>globalThis.libraryTestAppData};export const shell={openPath:async()=>""};',
});
const library = await import('../../src/main/library/projectLibrary.ts');
const { initializeLibrary } = library;
const settings = await import('../../src/main/settings/advancedSettings.ts');
const snippets = await import('../../src/main/snippets/store.ts');
const { SettingsManager } = await import('../../src/renderer/core/settings.ts');

test('settings and snippets use the selected library, with user settings still watched after switching projects', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'eukolia-library-services-'),
  );
  globalThis.libraryTestAppData = path.join(directory, 'app');
  t.after(() => {
    settings.closeSettingsWatchers();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('eukolia-library-services-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const root = path.join(directory, 'library');
  initializeLibrary(globalThis.libraryTestAppData, root);
  const shared = path.join(root, '.eukolia');
  const first = settings.writeSettingsFile(
    { scope: 'user', values: { 'editor.fontSize': 18 } },
    null,
  );
  assert.equal(first.path, path.join(shared, 'settings.json'));
  assert.equal(snippets.userSnippetsPath(), shared);
  const saved = snippets.writeUserSnippetsFile(
    '{"version":1,"snippets":[]}',
    'const example = 7;',
  );
  assert.equal(saved.path, path.join(shared, 'snippets.json'));
  assert.equal(saved.globalsJs, 'const example = 7;');
  assert.equal(
    settings.readSettingsFile('user', null).values['editor.fontSize'],
    18,
  );
  const project = path.join(root, 'Paper');
  fs.mkdirSync(project);
  settings.writeSettingsFile(
    { scope: 'workspace', values: { 'editor.fontSize': 22 } },
    project,
  );
  settings.stopWatchingWorkspace();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const event = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            'Library settings watcher stopped with the workspace watcher',
          ),
        ),
      2000,
    );
    settings.onSettingsFileChanged((description) => {
      if (
        description.scope === 'user' &&
        description.values?.['editor.fontSize'] === 19
      ) {
        clearTimeout(timeout);
        resolve(description);
      }
    });
  });
  fs.writeFileSync(
    path.join(shared, 'settings.json'),
    '{"editor.fontSize":19}',
  );
  await event;
  assert.equal(
    settings.readSettingsFile('workspace', project).values['editor.fontSize'],
    22,
  );
});

test('disk settings replace removed preferences instead of leaking browser-cached values', () => {
  const manager = new SettingsManager();
  manager.applyAdvancedSettings(
    { 'editor.fontSize': 19, 'custom.old': 'old' },
    'user',
  );
  manager.applyAdvancedSettings({ 'editor.fontSize': 21 }, 'user');
  assert.equal(manager.getValue('editor.fontSize'), 21);
  assert.equal(manager.getValue('custom.old'), undefined);

  // The same question for a project file, over a setting a project owns: a key
  // the new reading does not carry must not survive from the old one.
  manager.applyAdvancedSettings(
    { 'compilation.recipe': 'xelatex', 'editor.fontSize': 24 },
    'workspace',
  );
  assert.equal(
    manager.getValue('compilation.recipe'),
    'xelatex',
    'a project could not set its own recipe',
  );
  assert.equal(
    manager.getValue('editor.fontSize'),
    21,
    'a project settings file changed a user setting',
  );
  manager.applyAdvancedSettings({}, 'workspace');
  assert.equal(manager.getValue('compilation.recipe'), 'latexmk');
  assert.equal(manager.getValue('editor.fontSize'), 21);
});

test('the user scope reads and writes the library settings file, not a fixed app-data path', (t) => {
  // The user's settings live beside their snippets in the project library. A
  // fixed app-data path meant a library user's settings UI showed one file's
  // values and saved into another's.
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'eukolia-library-services-'),
  );
  globalThis.libraryTestAppData = path.join(directory, 'app');
  t.after(() => {
    settings.closeSettingsWatchers();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('eukolia-library-services-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  const root = path.join(directory, 'library');
  const shared = path.join(root, '.eukolia');
  const legacy = path.join(globalThis.libraryTestAppData, 'User', 'settings.json');

  // Before setup the legacy layout is what is read.
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '{"editor.fontSize":11}');
  assert.equal(settings.readSettingsFile('user', null).path, legacy);
  assert.equal(settings.readSettingsFile('user', null).values['editor.fontSize'], 11);

  initializeLibrary(globalThis.libraryTestAppData, root);
  assert.equal(
    settings.readSettingsFile('user', null).path,
    legacy,
    'setup leaves the settings where the user put them until the library file exists',
  );

  // The library's own file takes precedence the moment it exists, and it is also
  // where a write lands — one file for the reader and the writer.
  fs.writeFileSync(path.join(shared, 'settings.json'), '{"editor.fontSize":19}');
  const read = settings.readSettingsFile('user', null);
  assert.equal(read.path, path.join(shared, 'settings.json'));
  assert.equal(read.values['editor.fontSize'], 19);

  const written = settings.writeSettingsFile(
    { scope: 'user', values: { 'editor.fontSize': 21 } },
    null,
  );
  assert.equal(written.path, path.join(shared, 'settings.json'));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(shared, 'settings.json'), 'utf8'))[
      'editor.fontSize'
    ],
    21,
    'the settings were written to a different file than the one they were read from',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(legacy, 'utf8'))['editor.fontSize'],
    11,
    'the legacy file was overwritten',
  );
});

test('a project settings file applies the settings a project owns and nothing else', () => {
  // This is the path the watcher and the startup bootstrap use — the bot
  // `readSettingsFile` + `applyAdvancedSettings(…, 'workspace')` pair — so the
  // scope rule is checked where the application actually reads a project's file
  // rather than only through `loadWorkspaceSettings`, which no production caller
  // reaches.
  const manager = new SettingsManager();
  manager.setValue('editor.tabSize', 6, 'user');

  manager.applyAdvancedSettings(
    {
      'editor.tabSize': 8,
      'general.theme': 'nord',
      'keybindings.saveFile': 'Ctrl+Shift+S',
      'compilation.recipe': 'xelatex',
      'compilation.outputDirectory': 'build',
    },
    'workspace',
  );

  assert.equal(
    manager.getValue('editor.tabSize'),
    6,
    'a project settings file changed the editor',
  );
  assert.equal(manager.getScope('editor.tabSize'), 'user');
  assert.equal(
    manager.getValue('general.theme'),
    'dark',
    'a project settings file changed the theme',
  );
  assert.equal(manager.getValue('keybindings.saveFile'), 'Ctrl+S');
  assert.equal(
    manager.getValue('compilation.recipe'),
    'xelatex',
    'a project could not set its own recipe',
  );
  assert.equal(manager.getValue('compilation.outputDirectory'), 'build');
  assert.equal(manager.getScope('compilation.outputDirectory'), 'workspace');

  // Removing the project's file gives the user's values straight back: the
  // ignored keys never entered the store, so there is nothing to unwind.
  manager.applyAdvancedSettings({}, 'workspace');
  assert.equal(manager.getValue('compilation.outputDirectory'), '');
  assert.equal(manager.getValue('editor.tabSize'), 6);
});

test('the custom snippets folder is read from the library settings file', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'eukolia-library-services-'),
  );
  globalThis.libraryTestAppData = path.join(directory, 'app');
  t.after(() => {
    snippets.setUserSnippetsDirectoryOverride(null);
    fs.rmSync(path.resolve(directory), { recursive: true, force: true });
  });

  const root = path.join(directory, 'library');
  initializeLibrary(globalThis.libraryTestAppData, root);
  const custom = path.join(directory, 'my-snippets');
  fs.writeFileSync(
    path.join(root, '.eukolia', 'settings.json'),
    JSON.stringify({ 'snippets.userSnippetsDirectory': custom }),
  );

  assert.equal(
    snippets.getConfiguredUserSnippetsDirectory(),
    path.resolve(custom),
    'the snippet folder named in the library settings file was not read',
  );

  // The library's own folder still wins: the setting exists for installations
  // that have not been through setup.
  assert.equal(snippets.userSnippetsPath(), path.join(root, '.eukolia'));
});

test('a legacy custom snippets folder is still honoured before a library exists', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'eukolia-library-services-'),
  );
  globalThis.libraryTestAppData = path.join(directory, 'app');
  t.after(() => {
    fs.rmSync(path.resolve(directory), { recursive: true, force: true });
  });

  const custom = path.join(directory, 'legacy-snippets');
  fs.mkdirSync(path.join(globalThis.libraryTestAppData, 'User'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(globalThis.libraryTestAppData, 'User', 'settings.json'),
    JSON.stringify({ 'snippets.userSnippetsDirectory': custom }),
  );

  assert.equal(snippets.getConfiguredUserSnippetsDirectory(), path.resolve(custom));
  assert.equal(snippets.userSnippetsPath(), path.resolve(custom));
});

test('the user settings search order puts the library first and legacy layouts after it', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'eukolia-library-services-'),
  );
  const appData = path.join(directory, 'app');
  t.after(() => {
    fs.rmSync(path.resolve(directory), { recursive: true, force: true });
  });

  const root = path.join(directory, 'library');
  const shared = path.join(root, '.eukolia');
  initializeLibrary(appData, root);

  const candidates = library.userSettingsSearchPaths(appData);
  assert.equal(candidates[0], path.join(shared, 'settings.json'));
  assert.deepEqual(candidates.slice(1), [
    path.join(appData, 'User', 'settings.json'),
    path.join(appData, 'advanced-settings.json'),
  ]);
  assert.equal(
    library.resolveUserSettingsFile(appData),
    null,
    'a search order is not a claim that the files exist',
  );

  fs.writeFileSync(path.join(appData, 'advanced-settings.json'), '{"a":1}');
  assert.equal(
    library.resolveUserSettingsFile(appData),
    path.join(appData, 'advanced-settings.json'),
  );
  fs.mkdirSync(path.join(appData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'User', 'settings.json'), '{"a":2}');
  assert.equal(
    library.resolveUserSettingsFile(appData),
    path.join(appData, 'User', 'settings.json'),
    'the newer legacy layout outranks the one before it',
  );
  fs.writeFileSync(path.join(shared, 'settings.json'), '{"a":3}');
  assert.equal(
    library.resolveUserSettingsFile(appData),
    path.join(shared, 'settings.json'),
    'the library outranks both legacy layouts',
  );
});

test('a damaged library pointer does not hide the settings that are still readable', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'eukolia-library-services-'),
  );
  const appData = path.join(directory, 'app');
  t.after(() => {
    fs.rmSync(path.resolve(directory), { recursive: true, force: true });
  });

  const legacy = path.join(appData, 'User', 'settings.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '{"editor.fontSize":17}');
  fs.writeFileSync(path.join(appData, 'project-library.json'), '{broken');

  // `userSnippetsPath` reads `globalThis.libraryTestAppData` each time, and the
  // tests in this file share that global, so it is pointed at this test's own
  // directory for the duration and put back afterwards — a `setUserSnippetsDirectoryOverride`
  // from another test would otherwise decide the answer, and the directory this
  // test deletes on the way out must not be the one the next test reads.
  const previousAppData = globalThis.libraryTestAppData;
  snippets.setUserSnippetsDirectoryOverride(null);
  globalThis.libraryTestAppData = appData;
  try {
    const candidates = library.userSettingsSearchPaths(appData);
    assert.deepEqual(candidates, [
      legacy,
      path.join(appData, 'advanced-settings.json'),
    ]);
    assert.equal(
      library.resolveUserSettingsFile(appData),
      legacy,
      'a damaged pointer hid a settings file that is still readable',
    );
    assert.equal(
      snippets.userSnippetsPath(),
      path.join(appData, 'User', 'snippets'),
      'a damaged pointer did not fall back to the application-data layout',
    );
  } finally {
    globalThis.libraryTestAppData = previousAppData;
  }
});

test('a damaged library pointer reports recovery instead of blocking workspace watcher cleanup', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'eukolia-library-services-'),
  );
  globalThis.libraryTestAppData = directory;
  t.after(() => {
    settings.closeSettingsWatchers();
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(directory, 'project-library.json'), '{broken');
  assert.doesNotThrow(() => settings.stopWatchingWorkspace());
  const { describeLibrary } =
    await import('../../src/main/library/projectLibrary.ts');
  assert.match(describeLibrary(directory).error, /Cannot read/);
});
