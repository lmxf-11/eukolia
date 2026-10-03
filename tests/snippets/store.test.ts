/**
 * Snippet store tests.
 *
 * The store is the one place the library is read, written and fed to the engine,
 * so these cover the four things that can go wrong: seeding when the file is
 * absent, an echo of our own write being mistaken for a hand-edit, a hand-edit
 * being ignored, and a file the user broke being overwritten.
 *
 * The filesystem is faked: the store talks to a `SnippetStoreServices` seam, so
 * these run without Electron and without a real user directory.
 */

import { describe, expect, it } from 'vitest';
import {
  SnippetStore,
  type SnippetFileReading,
  type SnippetStoreServices
} from '../../src/renderer/snippets/store';
import { SnippetEngine } from '../../src/renderer/snippets/engine';
import {
  EUSNIPS_VERSION,
  builtInSnippets,
  hashContent,
  parseSnippetFileText,
  serializeSnippetFile,
  type EusnipsFile
} from '../../src/renderer/snippets/eusnips';

/** An in-memory `snippets.json` plus its directory listing. */
class FakeDisk implements SnippetStoreServices {
  text: string | null = null;
  globalsJs: string | null = null;
  legacy: Array<{ name: string; content: string }> = [];
  writes: string[] = [];
  globalsWrites: Array<string | undefined> = [];
  failWrite: string | null = null;
  private listeners = new Set<(description: SnippetFileReading) => void>();
  /** Set to false to make `watch` report the file as absent. */
  exists = true;

  read(): Promise<SnippetFileReading> {
    return Promise.resolve(this.describe());
  }

  watch(): Promise<SnippetFileReading> {
    return Promise.resolve(this.describe());
  }

  write(text: string, globalsJs?: string): Promise<{ exists: boolean; error?: string }> {
    if (this.failWrite) return Promise.resolve({ exists: false, error: this.failWrite });
    this.writes.push(text);
    this.globalsWrites.push(globalsJs);
    this.text = text;
    if (globalsJs !== undefined) this.globalsJs = globalsJs;
    this.exists = true;
    return Promise.resolve({ exists: true });
  }

  onChange(listener: (description: SnippetFileReading) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  readLegacy(): Promise<Array<{ name: string; content: string }>> {
    return Promise.resolve(this.legacy);
  }

  /** What the filesystem reports, without the echo the watcher would deliver. */
  describe(): SnippetFileReading {
    return {
      path: 'C:\\Users\\test\\AppData\\Roaming\\eukolia\\User\\snippets\\snippets.json',
      directory: 'C:\\Users\\test\\AppData\\Roaming\\eukolia\\User\\snippets',
      globalsPath: 'C:\\Users\\test\\AppData\\Roaming\\eukolia\\User\\snippets\\globals.js',
      globalsJs: this.globalsJs,
      exists: this.exists && this.text !== null,
      text: this.text,
      legacyFiles: this.legacy.map((entry) => entry.name)
    };
  }

  /** Simulate a file changed in another editor. */
  handEdit(text: string | null): void {
    this.text = text;
    if (text !== null) this.exists = true;
    for (const listener of this.listeners) listener(this.describe());
  }

  /** Simulate a globals.js file changed in another editor. */
  handEditGlobals(globalsJs: string | null): void {
    this.globalsJs = globalsJs;
    for (const listener of this.listeners) listener(this.describe());
  }
}

function createStore(disk: FakeDisk) {
  const engine = new SnippetEngine();
  const store = new SnippetStore(disk, () => engine);
  return { store, engine, disk };
}

const SMALL_FILE: EusnipsFile = {
  version: EUSNIPS_VERSION,
  language: 'latex',
  snippets: [
    { id: 'ff', trigger: { pattern: 'ff' }, description: 'fraction', body: '\\frac{$1}{$2}$0' },
    { id: 'sq', trigger: { pattern: 'sq' }, description: 'root', body: '\\sqrt{$1}$0' }
  ]
};

describe('the store seeds on first run', () => {
  it('writes the built-in library when there is no file', async () => {
    const disk = new FakeDisk();
    const { store, engine } = createStore(disk);
    await store.start();

    expect(disk.writes).toHaveLength(1);
    const seeded = parseSnippetFileText(disk.text as string).file as EusnipsFile;
    expect(seeded.snippets.length).toBe(builtInSnippets().length);
    expect(store.getSnapshot().exists).toBe(true);
    // And the engine has them, so a fresh install has working snippets.
    expect(engine.getSnippets('latex').length).toBeGreaterThan(50);
  });

  it('does not seed a second time when the file is there', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store } = createStore(disk);
    await store.start();
    expect(disk.writes).toEqual([]);
    expect(store.snippets.map((snippet) => snippet.id)).toEqual(['ff', 'sq']);
  });

  it('reports a file it cannot read rather than treating it as empty', async () => {
    const disk = new FakeDisk();
    const { store } = createStore(disk);
    await store.start();
    const before = disk.writes.length;

    disk.text = null;
    (disk as unknown as { describe: () => SnippetFileReading }).describe = () => ({
      path: 'x',
      directory: 'y',
      exists: true,
      text: null,
      error: 'EACCES: permission denied'
    });
    await store.reload();

    expect(store.getSnapshot().readError).toContain('permission denied');
    expect(disk.writes).toHaveLength(before);
  });
});

describe('the store writes what the editor gives it', () => {
  it('writes, adopts and loads an edit', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store, engine } = createStore(disk);
    await store.start();

    const changed = await store.update((file) => ({
      ...file,
      snippets: [...file.snippets, { id: 'new', trigger: { pattern: 'NEW' }, body: 'NEW BODY' }]
    }));

    expect(changed).toBe(true);
    expect(disk.writes).toHaveLength(1);
    expect(engine.getSnippets('latex').map((snippet) => snippet.regexp?.source)).toContain('NEW$');
    expect(store.dirty).toBe(false);
  });

  it('flushes a document the editor applied without writing', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store, engine } = createStore(disk);
    await store.start();

    store.apply({
      ...SMALL_FILE,
      snippets: [{ id: 'only', trigger: { pattern: 'ONLY' }, body: 'ONLY BODY' }]
    });

    expect(disk.writes).toHaveLength(0);
    expect(store.dirty).toBe(true);
    // The engine is current before the file is: that is what makes an edit take
    // effect immediately.
    expect(engine.getSnippets('latex').map((snippet) => snippet.regexp?.source)).toEqual(['ONLY$']);

    expect(await store.flush()).toBe(true);
    expect(disk.writes).toHaveLength(1);
    expect(store.dirty).toBe(false);
  });

  it('refuses to write a document that does not validate', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store } = createStore(disk);
    await store.start();

    const wrote = await store.save({
      version: EUSNIPS_VERSION,
      language: 'latex',
      // `priority` has to be an integer; a fractional one is a schema failure.
      snippets: [{ trigger: { pattern: 'x' }, body: 'X', priority: 1.5 }]
    });

    expect(wrote).toBe(false);
    expect(disk.writes).toEqual([]);
    expect(store.getSnapshot().saveError).toContain('refusing to write an invalid file');
  });

  it('writes an entry whose trigger is still empty, because that is a snippet being written', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store } = createStore(disk);
    await store.start();

    expect(await store.save({ version: EUSNIPS_VERSION, language: 'latex', snippets: [{ trigger: { pattern: '' }, body: '' }] })).toBe(
      true
    );
    // Nothing is loaded from it: an entry with no trigger cannot match.
    expect(store.snippets).toHaveLength(1);
    expect(store.snippets[0].enabled).toBe(true);
  });

  it('surfaces a write failure instead of pretending it saved', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store } = createStore(disk);
    await store.start();

    disk.failWrite = 'EBUSY: resource busy';
    expect(await store.update((file) => ({ ...file, name: 'renamed' }))).toBe(false);
    expect(store.getSnapshot().saveError).toContain('EBUSY');
  });
});

describe('hand-edits', () => {
  it('adopts a change made in another editor', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store, engine } = createStore(disk);
    await store.start();

    disk.handEdit(
      serializeSnippetFile({
        version: EUSNIPS_VERSION,
        language: 'latex',
        snippets: [{ id: 'hand', trigger: { pattern: 'HAND' }, body: 'HAND' }]
      })
    );

    expect(store.snippets.map((snippet) => snippet.id)).toEqual(['hand']);
    expect(engine.getSnippets('latex').map((snippet) => snippet.regexp?.source)).toEqual(['HAND$']);
    expect(store.dirty).toBe(false);
  });

  it('ignores the filesystem event its own write causes', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store } = createStore(disk);
    await store.start();

    await store.update((file) => ({ ...file, name: 'Mine' }));
    const revision = store.getSnapshot().revision;

    // The watcher reports what our own write just produced.
    disk.handEdit(disk.text);
    expect(store.getSnapshot().revision).toBe(revision);
  });

  it('reports a file the user broke without overwriting it', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store, engine } = createStore(disk);
    await store.start();

    disk.handEdit('{ this is not json');
    expect(store.getSnapshot().parseError).toBeTruthy();
    expect(store.getSnapshot().file).toBeNull();
    // Nothing was written over it, and nothing stale is left loaded.
    expect(disk.writes).toEqual([]);
    expect(disk.text).toBe('{ this is not json');
    expect(engine.getSnippets('latex')).toEqual([]);
  });

  it('reports a file that is JSON but not the format, and still loads what it can', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store, engine } = createStore(disk);
    await store.start();

    disk.handEdit(
      JSON.stringify(
        {
          version: 1,
          snippets: [
            { id: 'good', trigger: { pattern: 'GOOD' }, body: 'GOOD' },
            { id: 'bad', trigger: { pattern: 'BAD' }, body: 'BAD', nonsense: true }
          ]
        },
        null,
        2
      )
    );

    expect(store.getSnapshot().parseError).toContain('does not match the EUSnips format');
    expect(store.getSnapshot().validationIssues[0].path).toBe('/snippets/1/nonsense');
    // A typo in one entry must not kill the library.
    expect(engine.getSnippets('latex').map((snippet) => snippet.regexp?.source)).toContain('GOOD$');
  });

  it('keeps the file when the watcher reports it deleted, and re-seeds on the next load', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store } = createStore(disk);
    await store.start();

    disk.exists = false;
    disk.handEdit(null);
    expect(store.getSnapshot().exists).toBe(false);
    expect(disk.writes).toEqual([]);

    await store.reload();
    expect(disk.writes).toHaveLength(1);
    expect(store.getSnapshot().exists).toBe(true);
  });
});

describe('migration through the store', () => {
  const LEGACY = 'snippet hand "written by hand" A\nHAND WRITTEN\nendsnippet\n';

  it('offers a .hsnips file, imports it on request and never touches the file', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    disk.legacy = [{ name: 'latex.hsnips', content: LEGACY }];
    const { store, engine } = createStore(disk);
    await store.start();

    expect(store.getSnapshot().pendingImports).toEqual(['latex.hsnips']);
    expect(store.getSnapshot().changedImports).toEqual([]);

    const result = await store.importLegacy();
    expect(result).toEqual({ imported: 1, files: ['latex.hsnips'] });
    expect(engine.getSnippets('latex').map((snippet) => snippet.regexp?.source)).toContain('hand$');
    // The `.hsnips` file is still exactly where it was.
    expect(disk.legacy[0].content).toBe(LEGACY);
    expect(store.getSnapshot().pendingImports).toEqual([]);
  });

  it('does not import the same file twice', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    disk.legacy = [{ name: 'latex.hsnips', content: LEGACY }];
    const { store } = createStore(disk);
    await store.start();

    await store.importLegacy();
    const writes = disk.writes.length;
    expect(await store.importLegacy()).toEqual({ imported: 0, files: [] });
    expect(disk.writes).toHaveLength(writes);
  });

  it('notices a file that changed after it was imported', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    disk.legacy = [{ name: 'latex.hsnips', content: LEGACY }];
    const { store } = createStore(disk);
    await store.start();
    await store.importLegacy();

    disk.legacy = [{ name: 'latex.hsnips', content: `${LEGACY}snippet two "second" A\nTWO\nendsnippet\n` }];
    await store.reload();
    expect(store.getSnapshot().changedImports).toEqual(['latex.hsnips']);

    const reimported = await store.reimportLegacy('latex.hsnips');
    expect(reimported.imported).toBe(2);
    // Replacing rather than appending: still exactly the two snippets the file has.
    const triggers = store.snippets.map((snippet) => snippet.trigger).filter((pattern) => pattern === 'hand');
    expect(triggers).toHaveLength(1);
  });

  it('leaves the receipts alone when the library is restored to the built-ins', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    disk.legacy = [{ name: 'latex.hsnips', content: LEGACY }];
    const { store } = createStore(disk);
    await store.start();
    await store.importLegacy();
    expect(store.getSnapshot().pendingImports).toEqual([]);

    expect(await store.restoreBuiltIns()).toBe(true);
    // The built-in set is back...
    expect(store.snippets.length).toBe(builtInSnippets().length);
    // ...and the `.hsnips` file is still not going to be imported a second time.
    expect(store.getSnapshot().pendingImports).toEqual([]);
  });

  it('survives an unreadable legacy file', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    disk.legacy = [{ name: 'latex.hsnips', content: LEGACY }];
    const { store } = createStore(disk);
    await store.start();

    disk.readLegacy = () => Promise.reject(new Error('EACCES'));
    expect(await store.importLegacy()).toEqual({ imported: 0, files: [] });
    expect(store.snippets.length).toBe(SMALL_FILE.snippets.length);
  });
});

describe('store bookkeeping', () => {
  it('notifies subscribers on every change', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store } = createStore(disk);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    await store.start();
    expect(notifications).toBeGreaterThan(0);

    const seen = notifications;
    unsubscribe();
    await store.update((file) => ({ ...file, name: 'quiet' }));
    expect(notifications).toBe(seen);
  });

  it('hands React a snapshot that only changes when the data does', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store } = createStore(disk);
    await store.start();
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    await store.update((file) => ({ ...file, name: 'changed' }));
    expect(store.getSnapshot()).not.toBe(first);
  });

  it('carries the file path and language through', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile({ ...SMALL_FILE, language: 'bibtex' });
    const { store } = createStore(disk);
    await store.start();
    expect(store.language).toBe('bibtex');
    expect(store.getSnapshot().path).toContain('snippets.json');
    expect(store.getSnapshot().directory).toContain('User');
  });

  it('round-trips a file already in the current shape without changing it', async () => {
    const text = serializeSnippetFile({
      version: EUSNIPS_VERSION,
      name: 'Mine',
      description: 'kept',
      language: 'latex',
      defaults: { priority: 120 },
      metadata: { imports: [{ file: 'latex.hsnips', hash: hashContent('x'), count: 1, at: 'now' }] },
      snippets: [
        { id: 'ff', trigger: { pattern: 'ff' }, description: 'fraction', body: '\\frac{$1}{$2}$0', expand: 'auto', context: 'math' },
        { id: 're', trigger: { pattern: '(\\w+)bf', flags: 'i' }, body: '\\mathbf{$1}$0', boundary: 'anywhere' }
      ]
    });
    const disk = new FakeDisk();
    disk.text = text;
    const { store } = createStore(disk);
    await store.start();

    expect(serializeSnippetFile(store.getSnapshot().file as EusnipsFile)).toBe(text);
    expect(store.dirty).toBe(false);
    expect(disk.writes).toEqual([]);
  });

  it('reads a file written before a trigger was a pattern, and leaves it alone on disk', async () => {
    // The superseded spellings are read once, at load, so everything downstream —
    // the engine, the validator, the editor — sees the current shape and the cold
    // start does not re-report the whole library on every keystroke. Text that was
    // matched as text is escaped into the pattern that matches it. What the
    // upgrade must *not* do is touch the disk: opening a file is not editing it,
    // and a hand-written library has to survive being looked at.
    const text = serializeSnippetFile({
      version: EUSNIPS_VERSION,
      name: 'Mine',
      language: 'latex',
      snippets: [
        { id: 'lit', trigger: { type: 'literal', value: 'a.b' }, body: 'x' },
        { id: 're', trigger: { type: 'regex', pattern: '(\\w+)bf', flags: 'i' }, body: 'y', boundary: 'anywhere' }
      ] as unknown as EusnipsFile['snippets']
    });
    const disk = new FakeDisk();
    disk.text = text;
    const { store } = createStore(disk);
    await store.start();

    const file = store.getSnapshot().file as EusnipsFile;
    expect(file.snippets[0].trigger).toEqual({ pattern: 'a\\.b' });
    expect(file.snippets[1].trigger).toEqual({ pattern: '(\\w+)bf', flags: 'i' });
    expect(store.getSnapshot().validationIssues).toEqual([]);
    expect(store.dirty).toBe(false);
    expect(disk.writes).toEqual([]);
  });
});

describe('globals.js integration in snippet store', () => {
  it('loads globalsJs into file.globals.javascript and store snapshot', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    disk.globalsJs = 'function hello() { return "world"; }';
    const { store } = createStore(disk);
    await store.start();

    const snapshot = store.getSnapshot();
    expect(snapshot.globalsJs).toBe('function hello() { return "world"; }');
    expect(snapshot.globalsPath).toBe('C:\\Users\\test\\AppData\\Roaming\\eukolia\\User\\snippets\\globals.js');
    expect(snapshot.file?.globals?.javascript).toBe('function hello() { return "world"; }');
  });

  it('updates globalsJs when modified via store.update and persists it', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store } = createStore(disk);
    await store.start();

    await store.update((file) => ({
      ...file,
      globals: { ...file.globals, javascript: 'const MY_VAL = 42;' }
    }));

    expect(disk.writes.length).toBe(1);
    expect(disk.globalsWrites).toEqual(['const MY_VAL = 42;']);
    expect(disk.globalsJs).toBe('const MY_VAL = 42;');
    expect(store.getSnapshot().globalsJs).toBe('const MY_VAL = 42;');
  });

  it('adopts external hand-edits to globals.js', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store } = createStore(disk);
    await store.start();

    disk.handEditGlobals('function externalGlobal() { return 1; }');

    const snapshot = store.getSnapshot();
    expect(snapshot.globalsJs).toBe('function externalGlobal() { return 1; }');
    expect(snapshot.file?.globals?.javascript).toBe('function externalGlobal() { return 1; }');
  });

  it('preserves globalsJs and globalsPath when apply is called', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    disk.globalsJs = 'const X = 1;';
    const { store } = createStore(disk);
    await store.start();

    // Call store.apply with a modified snippet
    const current = store.getSnapshot().file!;
    store.apply({
      ...current,
      snippets: [...current.snippets, { id: 'new_one', trigger: { pattern: 'n' }, body: 'new' }]
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.globalsJs).toBe('const X = 1;');
    expect(snapshot.globalsPath).toBe('C:\\Users\\test\\AppData\\Roaming\\eukolia\\User\\snippets\\globals.js');
    expect(store.dirty).toBe(true);

    const saved = await store.flush();
    expect(saved).toBe(true);
    expect(disk.writes).toHaveLength(1);
    expect(store.dirty).toBe(false);
  });

  it('serializes concurrent flush calls cleanly', async () => {
    const disk = new FakeDisk();
    disk.text = serializeSnippetFile(SMALL_FILE);
    const { store } = createStore(disk);
    await store.start();

    const current = store.getSnapshot().file!;
    store.apply({
      ...current,
      name: 'modified library'
    });

    // Fire two flushes concurrently
    const [res1, res2] = await Promise.all([store.flush(), store.flush()]);
    expect(res1).toBe(true);
    expect(res2).toBe(true);
    expect(store.dirty).toBe(false);
    expect(disk.writes.length).toBeGreaterThanOrEqual(1);
  });
});

