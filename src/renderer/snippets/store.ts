/**
 * Eukolia — the snippet library service.
 *
 * One place owns the user's snippets: `snippets.json` in the `.eukolia` folder of
 * the project library the user chose, beside the user settings and the global
 * scripts. Everything else — the Snippets settings editor, the sidebar's snippet
 * view, the engine — reads from this store and subscribes to it, so an edit made
 * in the settings UI reaches the editor without a restart and a hand-edit made in
 * another editor reaches the settings UI.
 *
 * The store is deliberately thin about *what* it stores. It keeps the parsed
 * file plus the last text it saw, and it treats those two as the identity of the
 * library:
 *
 *  * a write it started itself comes back as a filesystem event, so the echo is
 *    recognised by comparing text and ignored;
 *  * a file that does not exist yet is seeded from the built-in library, so the
 *    first thing the user sees in the editor is a working library;
 *  * a file that exists but does not parse is *never* overwritten. It is
 *    reported, and the editor refuses to save over it, because silently
 *    replacing a library the user hand-edited is the one failure that cannot be
 *    undone;
 *  * an existing `*.hsnips` file is offered for import rather than imported
 *    silently. It is left exactly where it is.
 */

import { projectIndex } from '../document/projectIndex';
import { setting } from '../core/settings';
import { getSnippetEngine, type SnippetEngine } from './engine';
import {
  EUSNIPS_VERSION,
  assignMissingSnippetIds,
  changedImports,
  checkWritableDocument,
  formatValidationIssues,
  initialSnippetFile,
  loadEusnipsIntoEngine,
  migrateInto,
  normalizeSnippetFile,
  parseSnippetFileText,
  pendingImports,
  removeImported,
  serializeSnippetFile,
  upgradeSnippetFile,
  validateSnippetFile,
  withoutInlineGlobals,
  type EusnipsFile,
  type EusnipsIssue,
  type MigrationSource,
  type NormalizedSnippetFile,
  type ValidationIssue
} from './eusnips';

export interface SnippetStoreState {
  /** Where the library lives, for the editor to show and for "open folder". */
  path: string;
  directory: string;
  /** True once the file exists on disk. */
  exists: boolean;
  /** The file could not be read at all; `file` is whatever was last known. */
  readError?: string;
  /** The file's text is not JSON, or is not a valid EUSnips document. */
  parseError?: string;
  /** Schema violations, with the line each one is on. */
  validationIssues: ValidationIssue[];
  /** Everything the format can say but the engine cannot do. */
  issues: EusnipsIssue[];
  file: EusnipsFile | null;
  normalized: NormalizedSnippetFile | null;
  /**
   * The document as it stands on disk.
   *
   * `file` is what the editor is working on, which `apply` changes without
   * writing anything; this is the last version that was read or written. The
   * difference between the two is what "unsaved" means, entry by entry — which is
   * what the editor's grey dots are drawn from.
   */
  savedFile: EusnipsFile | null;
  /** The text the current in-memory document serialises to. */
  adoptedText: string;
  /** Legacy `.hsnips` files sitting in the same directory. */
  legacyFiles: string[];
  /** Legacy files that have not been imported yet. */
  pendingImports: string[];
  /** Legacy files that were imported and have changed on disk since. */
  changedImports: string[];
  /** Bumped on every change, so React sees a new value from `getSnapshot`. */
  revision: number;
  /** Whether the in-memory document differs from what is on disk. */
  dirty: boolean;
  /** True while a load or a save is in flight. */
  busy: boolean;
  /** The last save failure, so the editor can show it instead of a silent no-op. */
  saveError?: string;
  /** Content of globals.js if loaded. */
  globalsJs?: string | null;
  /** Absolute path of globals.js. */
  globalsPath?: string;
}

/** What a read of the library produced. */
export interface SnippetFileReading {
  path: string;
  directory: string;
  exists: boolean;
  text: string | null;
  error?: string;
  legacyFiles?: string[];
  globalsJs?: string | null;
  globalsPath?: string;
}

type Listener = () => void;

export interface SnippetStoreServices {
  /** Reads the file's text. */
  read(): Promise<SnippetFileReading>;
  /** Writes the file's text and optional globals.js. */
  write(text: string, globalsJs?: string): Promise<{ exists: boolean; error?: string }>;
  /** Starts watching the file and returns its current state in one round trip. */
  watch(): Promise<SnippetFileReading>;
  /** Subscribes to changes made outside the application. */
  onChange(listener: (description: SnippetFileReading) => void): () => void;
  /** Reads the legacy `.hsnips` sources, for the import action. */
  readLegacy(): Promise<MigrationSource[]>;
}

const EMPTY_STATE: SnippetStoreState = {
  path: '',
  directory: '',
  exists: false,
  validationIssues: [],
  issues: [],
  file: null,
  normalized: null,
  savedFile: null,
  adoptedText: '',
  legacyFiles: [],
  pendingImports: [],
  changedImports: [],
  revision: 0,
  dirty: false,
  busy: false
};

interface AdoptContext {
  path: string;
  directory: string;
  exists: boolean;
  legacyFiles: string[];
  legacySources: MigrationSource[];
  globalsJs?: string | null;
  globalsPath?: string;
}

export class SnippetStore {
  private state: SnippetStoreState = EMPTY_STATE;
  private readonly listeners = new Set<Listener>();
  private unsubscribe: (() => void) | null = null;
  private lastText: string | null = null;
  /** Guards against the filesystem event our own write produces. */
  private lastWrittenText: string | null = null;
  private lastWrittenGlobalsJs: string | null = null;
  /** Legacy sources, cached so adopting a keystroke needs no I/O. */
  private legacySources: MigrationSource[] = [];
  private started = false;
  /** Invalidates an in-flight engine reload when a newer one starts. */
  private syncToken = 0;
  /**
   * The project's own `snips/` sources, cached so adopting a keystroke needs no
   * I/O.
   *
   * `null` means "not read yet"; {@link refreshEngine} clears it back to that
   * when the workspace changes, which is the one thing that can move the folder.
   */
  private projectSources: Array<{ name: string; content: string; language: string }> | null = null;
  /** Invalidates an in-flight {@link load} when a newer one starts. */
  private loadToken = 0;
  /**
   * Counts readings of the file that did not come from this store's own write.
   *
   * {@link persist} captures it before writing and compares it after: a hand-edit
   * that lands while the write is in flight has already been adopted, and the
   * write's continuation must not put the version it wrote back over it.
   */
  private externalReads = 0;
  /** Serializes file persist writes so concurrent calls do not race or collide. */
  private writeQueue: Promise<boolean> = Promise.resolve(true);

  constructor(
    private readonly services: SnippetStoreServices,
    private readonly engine: () => SnippetEngine = () => getSnippetEngine()
  ) {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onUnload = () => {
        if (this.dirty) {
          void this.flush();
        }
      };
      window.addEventListener('beforeunload', onUnload);
      window.addEventListener('pagehide', onUnload);
    }
  }

  // ------------------------------------------------------------------ reads

  getSnapshot = (): SnippetStoreState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<SnippetStoreState>): void {
    const next = { ...this.state, ...patch };
    next.revision = this.state.revision + 1;
    next.dirty = next.adoptedText !== (this.lastText ?? '');
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** The effective snippets, ready for a list. Empty until the first load. */
  get snippets() {
    return this.state.normalized?.snippets ?? [];
  }

  get language(): string {
    return this.state.normalized?.language ?? 'latex';
  }

  /** The file's text as it would be written right now. */
  serialized(): string {
    return this.state.file ? serializeSnippetFile(this.state.file) : '';
  }

  /** Whether the in-memory document differs from what is on disk. */
  get dirty(): boolean {
    return this.state.adoptedText !== (this.lastText ?? '');
  }

  // ------------------------------------------------------------------- load

  /**
   * Reads the library, seeds it if it does not exist, and loads the engine.
   *
   * Safe to call repeatedly: a second call re-reads the file rather than
   * re-seeding, which is what makes it also the "reload from disk" action.
   */
  async start(): Promise<void> {
    if (!this.unsubscribe) {
      this.unsubscribe = this.services.onChange((description) => this.onExternalChange(description));
    }
    this.started = true;
    await this.load();
  }

  /** Re-reads the file from disk; used by the reload control. */
  async reload(): Promise<void> {
    if (!this.started) return this.start();
    await this.load();
  }

  /**
   * Re-runs the engine load without re-reading the file.
   *
   * The project's own `snips/` folder is read by the engine load, so this is what
   * a workspace change needs: the user's library has not moved, the folder it is
   * combined with has. The cached folder is dropped, which is what makes this the
   * one path that re-reads it — every other engine load reuses the cache, so a
   * keystroke in the snippet manager costs no directory listing.
   */
  refreshEngine(): void {
    this.projectSources = null;
    this.syncEngine();
  }

  private async load(): Promise<void> {
    const token = (this.loadToken += 1);
    this.setState({ busy: true });
    try {
      const description = await this.services.watch();
      // Counted before the token check: even a load that loses the race has read
      // the file, which is what {@link persist} has to know about.
      this.externalReads += 1;
      const legacySources = await this.readLegacySources(description.legacyFiles ?? []);
      // Two loads can be in flight — `reload()` is a control the user can press
      // twice — and the one that finishes last is not necessarily the one that
      // started last. The newer load owns the store, so this one drops its
      // reading rather than writing an older file over a newer state.
      if (token !== this.loadToken) return;
      this.legacySources = legacySources;
      await this.applyDescription(description);
    } catch (error) {
      if (token !== this.loadToken) return;
      this.setState({
        busy: false,
        readError: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async readLegacySources(names: readonly string[]): Promise<MigrationSource[]> {
    if (names.length === 0) return [];
    try {
      return await this.services.readLegacy();
    } catch {
      return [];
    }
  }

  private async applyDescription(description: SnippetFileReading): Promise<void> {
    const legacyFiles = description.legacyFiles ?? [];
    const context: AdoptContext = {
      path: description.path,
      directory: description.directory,
      exists: description.exists,
      legacyFiles,
      legacySources: this.legacySources,
      globalsJs: description.globalsJs,
      globalsPath: description.globalsPath
    };

    if (description.error) {
      // Unreadable is not empty: keep what we had and say so.
      this.setState({ ...context, busy: false, readError: description.error });
      return;
    }

    if (!description.exists || description.text === null) {
      // First run. Seed rather than start empty, so the library the user opens
      // is the library they already had.
      const seeded = initialSnippetFile();
      this.lastText = null;
      this.setState({
        ...context,
        exists: false,
        readError: undefined,
        parseError: undefined,
        saveError: undefined
      });
      await this.persist(seeded, { reason: 'seed' });
      return;
    }

    this.lastText = description.text;
    this.lastWrittenText = description.text;
    this.lastWrittenGlobalsJs = description.globalsJs ?? null;
    this.adoptText(description.text, context);
  }

  /**
   * Parses, validates and adopts a file's text without writing anything.
   *
   * `saved` says whether the text is what is on disk: a load, a write and an
   * external change are; the editor's in-memory edits are not. It is what the
   * per-entry "unsaved" markers are computed from, so it has to be exact rather
   * than merely usually right.
   */
  private adoptText(text: string, context: AdoptContext, saved = true): void {
    const common = {
      path: context.path,
      directory: context.directory,
      exists: context.exists,
      legacyFiles: context.legacyFiles,
      globalsJs: context.globalsJs,
      globalsPath: context.globalsPath,
      busy: false,
      saveError: undefined
    };

    const parsed = parseSnippetFileText(text);
    if (!parsed.file) {
      this.setState({
        ...common,
        parseError: parsed.error ?? 'the file could not be read as JSON',
        validationIssues: [],
        issues: [],
        file: null,
        normalized: null,
        savedFile: null,
        pendingImports: [],
        changedImports: []
      });
      this.syncEngine();
      return;
    }

    // Superseded spellings are converted once, here, so that everything below —
    // the validator, the engine, the editor — sees one shape. Without this a
    // library written before a format change reports a problem against every
    // entry it has, and the editor is unusable because of a difference that has
    // already been read correctly.
    const file = upgradeSnippetFile(parsed.file);
    // A blank `globals.js` is an *absent* one, not an instruction to clear the
    // globals: taking `''` here replaced the library's shared functions with nothing
    // in the in-memory document, and the next save then wrote `"globals": {}` over
    // the copy inside `snippets.json`. A file that has been emptied by accident —
    // or truncated by a crash mid-write — must not be able to delete them.
    if (typeof context.globalsJs === 'string' && context.globalsJs.trim().length > 0) {
      file.globals = {
        ...file.globals,
        javascript: context.globalsJs
      };
    }
    const validation = validateSnippetFile(file, { text });
    const normalized = normalizeSnippetFile({ ...file, version: EUSNIPS_VERSION });
    const pending = pendingImports(file, context.legacySources).map((source) => source.name);
    const changed = changedImports(file, context.legacySources);
    // A hand-edit and the editor's own writes disagree about one thing only: the
    // editor is allowed to write an entry it is still filling in, and a file that
    // arrives with such an entry is read rather than rejected. `checkWritableDocument`
    // is the one place that decides, so the two never diverge — and it is handed
    // the validation and normalization just done above, because this runs on every
    // keystroke and neither is cheap on a library of a thousand entries.
    const writable = checkWritableDocument(
      { ...file, version: EUSNIPS_VERSION },
      { allIssues: validation.issues, semantic: normalized.issues }
    );
    const parseError = validation.valid || writable.pending
      ? undefined
      : `the file does not match the EUSnips format:\n${formatValidationIssues(validation.issues)}`;

    this.setState({
      ...common,
      adoptedText: text,
      parseError,
      // Every issue is reported, including the ones a write tolerates. An entry
      // whose trigger is still empty is not a *failure* — see
      // `checkWritableDocument` — but it is still something the editor has to be
      // able to show, and a marker that appears and disappears depending on
      // whether the file could be written would be a marker nobody trusts.
      validationIssues: validation.issues,
      issues: normalized.issues,
      // The upgraded file, not the one that was read: the editor edits the
      // current format, and a save writes what it edited.
      file,
      savedFile: saved ? file : this.state.savedFile,
      normalized,
      pendingImports: pending,
      changedImports: changed
    });

    // A file that does not validate is still *shown*, and the entries that do
    // make sense still work: refusing to load anything would turn one typo into
    // a dead snippet library.
    this.syncEngine();
  }

  /** Reacts to a change the filesystem reports. */
  private onExternalChange(description: SnippetFileReading): void {
    const expectedGlobals = this.lastWrittenGlobalsJs ?? this.state.globalsJs ?? null;
    const sameGlobals =
      description.globalsJs === undefined ||
      (description.globalsJs ?? null) === expectedGlobals;

    if (
      description.text !== null &&
      description.text === this.lastWrittenText &&
      sameGlobals
    ) {
      // Our own write coming back around. Nothing changed.
      return;
    }

    this.externalReads += 1;

    if (description.text === null) {
      /*
       * The file could not be read — deleted, locked by another program, or
       * unreadable half-way through a save. That is *not* the same as an empty
       * library, and treating it as one is how a transient read failure becomes
       * data loss: adopting `null` as the baseline makes `dirty` true for a library
       * nobody edited, and the next save, manager close or window unload then writes
       * the in-memory copy over a file the read could not see. `applyDescription`
       * has always refused to do this for the initial read; the watcher path did
       * not, and the watcher is the one that runs while the file is being replaced.
       *
       * So the baseline is left exactly where it was and the failure is reported.
       */
      this.setState({
        exists: description.exists,
        busy: false,
        readError: description.error ?? 'the snippet library could not be read'
      });
      return;
    }

    // A hand-edit is authoritative: adopt it and make it the baseline, so the
    // dirty marker reflects the file rather than our last write.
    this.lastText = description.text;
    this.lastWrittenText = description.text;
    this.lastWrittenGlobalsJs = description.globalsJs ?? null;

    void this.readLegacySources(description.legacyFiles ?? this.state.legacyFiles).then((sources) => {
      if (sources.length > 0) this.legacySources = sources;
    });

    this.adoptText(description.text, {
      path: description.path || this.state.path,
      directory: description.directory || this.state.directory,
      exists: true,
      legacyFiles: description.legacyFiles ?? this.state.legacyFiles,
      legacySources: this.legacySources,
      globalsJs: description.globalsJs !== undefined ? description.globalsJs : this.state.globalsJs,
      globalsPath: description.globalsPath || this.state.globalsPath
    });
  }

  // ------------------------------------------------------------------ writes

  /**
   * Adopts an edited document **without** writing it.
   *
   * This is what the settings editor uses while the user types: the library, the
   * engine and the list stay in step immediately, and nothing reaches the disk
   * until the editor is done — the snippet manager writes once, when it closes.
   * A document that does not validate is still adopted — so the entry the user is
   * fixing stays on screen — but {@link persist} refuses to write it.
   */
  apply(file: EusnipsFile): void {
    const globalsJs = file.globals?.javascript
      ? (Array.isArray(file.globals.javascript) ? file.globals.javascript.join('\n') : String(file.globals.javascript))
      : this.state.globalsJs;
    this.adoptText(
      serializeSnippetFile(file),
      {
        path: this.state.path,
        directory: this.state.directory,
        exists: this.state.exists,
        legacyFiles: this.state.legacyFiles,
        legacySources: this.legacySources,
        globalsJs,
        globalsPath: this.state.globalsPath
      },
      false
    );
  }

  /** Replaces the in-memory document and writes it. */
  async save(file: EusnipsFile): Promise<boolean> {
    return this.persist(file, { reason: 'save' });
  }

  /**
   * Applies a change to the document and writes it.
   *
   * This is the path for a change that is complete in one step *and* is meant to
   * be durable on its own — a migration, a repair, a test's own bookkeeping.
   * Editor actions that the user is expected to finish and review (the snippet
   * manager's add, duplicate, delete and switches) use {@link edit} instead and
   * are written by a single {@link flush} when the editor closes.
   */
  async update(mutate: (file: EusnipsFile) => EusnipsFile): Promise<boolean> {
    if (!this.state.file) return false;
    return this.persist(mutate(this.state.file), { reason: 'save' });
  }

  /**
   * Applies a change to the document in memory, without writing it.
   *
   * The document is re-adopted, so the list, the validation and the engine all
   * see the change at once; the file is left alone until {@link flush}.
   */
  edit(mutate: (file: EusnipsFile) => EusnipsFile): void {
    if (!this.state.file) return;
    this.apply(mutate(this.state.file));
  }

  /** Writes the document currently in memory, if it validates. */
  async flush(): Promise<boolean> {
    if (!this.state.file) return false;
    return this.persist(this.state.file, { reason: 'save' });
  }

  private async persist(file: EusnipsFile, options: { reason: 'seed' | 'save' | 'import' }): Promise<boolean> {
    const run = () => this.doPersist(file, options);
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next;
    return next;
  }

  private async doPersist(file: EusnipsFile, options: { reason: 'seed' | 'save' | 'import' }): Promise<boolean> {
    // An entry without an id is not writable — the format requires one — and an
    // entry the user has not named yet is exactly that. Naming it here, next to
    // the write, means the editor and the store cannot disagree about whether
    // "Add snippet" produced something saveable.
    const named = assignMissingSnippetIds(file);
    /*
     * The globals are written to `globals.js` and never into the library file.
     *
     * They used to be written to both, which made `snippets.json` carry a second,
     * complete copy of a script that lives beside it — 186 KB of a 431 KB file — and
     * left two copies of one program on disk with nothing keeping them equal.
     * `globals.js` always won at load (`adoptText` injects it over whatever the JSON
     * said), so the copy inside the JSON was read by nothing except the code that
     * creates a missing `globals.js` from it, and it silently reverted any hand-edit
     * made only to the JSON. The editor still *sees* the globals — they are put back
     * into the in-memory file below, which is what the Library panel shows and
     * edits — but the bytes on disk have one owner.
     */
    const text = serializeSnippetFile(withoutInlineGlobals(named));
    const check = checkWritableDocument(named);
    if (!check.valid) {
      // Belt and braces: the editor validates before it calls, and this makes it
      // impossible for a bug in the editor to be the thing that writes a broken
      // file into the user's directory. An entry the user is still filling in is
      // not "broken" — see `checkWritableDocument` for what counts as writable.
      this.setState({
        busy: false,
        saveError: `refusing to write an invalid file:\n${formatValidationIssues(check.issues)}`
      });
      return false;
    }

    this.setState({ busy: true, saveError: undefined });
    const seenExternalReads = this.externalReads;
    const globalsJs = named.globals?.javascript
      ? (Array.isArray(named.globals.javascript) ? named.globals.javascript.join('\n') : String(named.globals.javascript))
      : undefined;

    // Anticipate our own write so the filesystem watcher echo is recognized as ours
    this.lastWrittenText = text;
    this.lastWrittenGlobalsJs = globalsJs ?? this.state.globalsJs ?? null;

    try {
      const result = await this.services.write(text, globalsJs);
      if (result.error) throw new Error(result.error);

      if (this.externalReads !== seenExternalReads) {
        // The file was read again while the write was in flight, so something
        // landed inside that window — a hand-edit from another editor, or a
        // reload. The store has already adopted it, and this continuation holds
        // the text the write was *sent* with. Adopting that here is what silently
        // reverted the newer reading on screen and left the dirty marker claiming
        // the file differed from a version it no longer held. Re-read instead: the
        // file is the only thing that can say which of the two is current.
        void this.reload();
        return true;
      }

      this.lastText = text;
      this.adoptText(text, {
        path: this.state.path,
        directory: this.state.directory,
        exists: true,
        legacyFiles: this.state.legacyFiles,
        legacySources: this.legacySources,
        globalsJs: globalsJs ?? this.state.globalsJs,
        globalsPath: this.state.globalsPath
      });
      if (options.reason === 'seed') this.setState({ exists: true });
      return true;
    } catch (error) {
      this.setState({ busy: false, saveError: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  // --------------------------------------------------------------- migration

  /** Legacy `.hsnips` sources still on disk, read fresh. */
  async legacySourcesFromDisk(): Promise<MigrationSource[]> {
    try {
      const sources = await this.services.readLegacy();
      this.legacySources = sources;
      return sources;
    } catch {
      return [];
    }
  }

  /**
   * Imports the legacy sources that have no receipt yet.
   *
   * Idempotent by construction: the receipts in `metadata.imports` are what make
   * a second call a no-op, and the `.hsnips` files are never touched.
   */
  async importLegacy(): Promise<{ imported: number; files: string[] }> {
    if (!this.state.file) return { imported: 0, files: [] };
    const sources = await this.legacySourcesFromDisk();
    const result = migrateInto(this.state.file, sources);
    if (result.imported.length === 0) return { imported: 0, files: [] };
    const saved = await this.persist(result.file, { reason: 'import' });
    if (!saved) return { imported: 0, files: [] };
    return {
      imported: result.imported.reduce((total, receipt) => total + receipt.count, 0),
      files: result.imported.map((receipt) => receipt.file)
    };
  }

  /** Re-imports one legacy source, replacing whatever it contributed before. */
  async reimportLegacy(fileName: string): Promise<{ imported: number }> {
    if (!this.state.file) return { imported: 0 };
    const sources = await this.legacySourcesFromDisk();
    const source = sources.find((entry) => entry.name === fileName);
    if (!source) return { imported: 0 };
    const result = migrateInto(removeImported(this.state.file, fileName), [source]);
    if (result.imported.length === 0) return { imported: 0 };
    const saved = await this.persist(result.file, { reason: 'import' });
    return saved ? { imported: result.imported[0].count } : { imported: 0 };
  }

  /** Replaces the library with the built-in library Eukolia ships. */
  async restoreBuiltIns(): Promise<boolean> {
    const file = initialSnippetFile(this.language);
    // Keep the migration receipts: the `.hsnips` files are still on disk, and
    // re-importing them on the next start would duplicate their entries.
    const receipts = this.state.file?.metadata?.imports;
    if (receipts) file.metadata = { imports: receipts };
    return this.persist(file, { reason: 'save' });
  }

  // ------------------------------------------------------------------ engine

  /**
   * Copies the current library into the snippet engine, alongside the project's
   * own `snips/` folder.
   *
   * This is the only place the engine is fed, so what the editor shows and what
   * expands in the editor cannot diverge.
   */
  private syncEngine(): void {
    const token = (this.syncToken += 1);
    const files = this.state.normalized ? [this.state.normalized] : [];

    // The library itself is compiled synchronously, so an edit is live the moment
    // the field changes — there is no await between "the user typed" and "the
    // engine knows".
    const engine = this.engine();
    loadEusnipsIntoEngine(engine, files);

    // The project's own `snips/` folder is appended afterwards, which keeps the
    // precedence the engine had before — a project can override the user's
    // library — without putting a disk read in front of the library load.
    //
    // Once read, the folder is cached: this runs on *every* keystroke in the
    // snippet manager, and re-reading it there meant a directory listing and a
    // file read per character, all of it behind an `await` that let two loads
    // interleave. The cache is invalidated by `refreshEngine`, which is what a
    // workspace change calls.
    if (this.projectSources) {
      if (this.projectSources.length > 0) engine.addSnippetSources(this.projectSources);
      return;
    }
    void this.appendProjectSources(engine, token);
  }

  private async appendProjectSources(engine: SnippetEngine, token: number): Promise<void> {
    // A failure here must not stop the library from loading: a project folder
    // that cannot be read is a missing folder as far as snippets are concerned.
    let project: Array<{ name: string; content: string; language: string }> = [];
    try {
      project = await readProjectSnippetSources();
    } catch (error) {
      console.warn('[eukolia] could not read the project snippet folder', error);
    }
    // A newer load has started; that one owns the engine now.
    if (token !== this.syncToken) return;
    this.projectSources = project;
    if (project.length > 0) engine.addSnippetSources(project);
  }

  /** For tests and for shutdown. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
    this.syncToken += 1;
  }
}

/**
 * Reads `snips/` (configurable) from the open workspace.
 *
 * Project snippets stay `.hsnips` files on purpose: they are part of a
 * repository, shareable with collaborators who do not use Eukolia, and the
 * managed single-file library is a *user*-scope idea.
 */
export async function readProjectSnippetSources(): Promise<
  Array<{ name: string; content: string; language: string }>
> {
  const workspacePath = projectIndex.getProjectRoot();
  if (!workspacePath) return [];
  if (typeof window === 'undefined' || !window.eukoliaApi) return [];

  const sources: Array<{ name: string; content: string; language: string }> = [];
  for (const directory of setting.list('snippets.snippetDirectories')) {
    const target = `${workspacePath.replace(/[\\/]+$/, '')}/${directory.replace(/^[\\/]+/, '')}`;
    try {
      const stat = await window.eukoliaApi.stat(target);
      if (!stat.exists || !stat.isDirectory) continue;
      const listing = await window.eukoliaApi.listDirectoryNames(target);
      for (const file of listing.files) {
        if (!/\.(hsnips|snips|tex)$/i.test(file)) continue;
        const path = `${target.replace(/[\\/]+$/, '')}/${file}`;
        try {
          sources.push({ name: path, content: await window.eukoliaApi.readFile(path), language: 'latex' });
        } catch (error) {
          console.warn('[eukolia] could not read snippet file', path, error);
        }
      }
    } catch {
      // An unreadable project snippet folder is skipped; the user's own library
      // is unaffected.
    }
  }
  return sources;
}

/** The services the store needs, backed by the preload bridge. */
export function createSnippetStoreServices(): SnippetStoreServices {
  return {
    read: () => window.eukoliaApi.readSnippetFile(),
    write: (text, globalsJs) => window.eukoliaApi.writeSnippetFile(text, globalsJs),
    watch: () => window.eukoliaApi.watchSnippetFile(),
    onChange: (listener) => window.eukoliaApi.onSnippetFileChanged(listener),
    readLegacy: async () => {
      const all = await window.eukoliaApi.readUserSnippets();
      return all.map((source) => ({ name: source.name, content: source.content }));
    }
  };
}

let activeStore: SnippetStore | null = null;

/** The process-wide store. */
export function getSnippetStore(): SnippetStore {
  if (!activeStore) activeStore = new SnippetStore(createSnippetStoreServices());
  return activeStore;
}

export function setSnippetStore(store: SnippetStore | null): void {
  activeStore = store;
}
