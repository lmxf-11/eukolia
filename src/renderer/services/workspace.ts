/**
 * Eukolia workspace service.
 *
 * Owns the set of open documents, the active document, the project tree and all
 * file lifecycle operations (open, save, save-as, autosave, external-change
 * detection, crash recovery). Everything the UI needs is exposed through
 * observable state plus events, so React components stay thin
 * (Instructions.md §29, §40, §44, §45, §58, §59).
 */

import { EventEmitter } from '../core/events';
import { DocumentModel, languageIdFor, type DocumentAnalyzer, type TextDelta } from '../document/documentModel';
import { projectIndex, type BibEntry } from '../document/projectIndex';
import { setting, settingsManager } from '../core/settings';
import {
  autoSaveRunsFor,
  autoSaveScopeFor,
  normalizeAutoSaveMode,
  type AutoSaveMode,
  type AutoSaveTrigger
} from '../core/autoSave';
import { formattingEngine } from '../aligner/texAligner';
import { mapWithConcurrency } from '../core/concurrency';
import { resolveRelative } from './resolveRelative';
import { LatexAnalysisService } from '../parser/latexAnalysis';
import { startupMark } from '../core/startupProbe';
import type {
  AnalyzeDocumentResponse,
  FileNode,
  FileWatchErrorEvent,
  FileWatchEvent,
  RecentWorkspace
} from '../../shared/ipc';

export { languageIdFor };

export interface OpenDocument {
  doc: DocumentModel;
  /** True when the buffer was recovered from a crash rather than read from disk. */
  recovered: boolean;
  /** True when the file changed on disk while the buffer had unsaved edits. */
  externalChange: boolean;
  pinned: boolean;
}

export interface WorkspaceSnapshot {
  workspacePath: string | null;
  workspaceName: string | null;
  documents: OpenDocument[];
  activeUri: string | null;
  recentWorkspaces: RecentWorkspace[];
  building: boolean;
}

export interface WorkspaceDependencies {
  /**
   * Creates the analyzer used by every opened document.
   *
   * Asynchronous because the ported LaTeX Workshop parser behind it is a 1.5 MB
   * dynamic import: resolving it must not be on the path that puts the shell on
   * screen. Every buffer opened before it resolves is re-analysed when it does
   * (`installAnalyzer`), which is the same mechanism `setAnalyzer` always used.
   */
  createAnalyzer(): Promise<DocumentAnalyzer | null>;
  /**
   * Analyses a file the project index read but the user never opened.
   *
   * The analyzer is a Node bundle and cannot be evaluated on the renderer's thread
   * (nor in an ES module worker), so this asks the main process — the same
   * arrangement VS Code uses for language work. Optional because a window without
   * the bridge still has to work: the walk falls back to the renderer's own
   * analyzer, which is slower but says so once in the console
   * (`parser/latexAnalysis.ts`).
   */
  analyzeDocument?(text: string, uri: string): Promise<AnalyzeDocumentResponse>;
  /** Called with the analyzer once it exists, for modules that need it eagerly. */
  onAnalyzerLoaded?(analyzer: DocumentAnalyzer): void;
  /** Parses a `.bib` file into project-index entries. */
  parseBibtex(content: string, sourcePath: string): BibEntry[];
  /** Picks the root document of a project. */
  detectRootDocument(files: Array<{ path: string; name: string; isDirectory: boolean }>, contents: Map<string, string>): string | null;
}

const TEXT_EXTENSIONS = /\.(tex|ltx|bib|sty|cls|txt|md|markdown|log|json|yaml|yml|cfg|toml|tikz|def|dtx|ins|js|mjs|cjs|jsx|ts|tsx)$/i;

/**
 * How many files `indexIncludedSourceFiles` will read for one project open.
 *
 * A bound rather than a promise: a root document that includes a hundred
 * chapters should not turn opening a project into a hundred parses, and the
 * shared macro file is always read first — the queue starts at the root and the
 * `\input` that carries the macros is one of the first things in it.
 */
const INCLUDED_SOURCE_FILE_LIMIT = 200;

/**
 * How many whole files the open path may have in flight at once.
 *
 * Every `.bib` in the project is read when a folder opens, and the reads used to be
 * one `Promise.all`: a project with forty bibliographies put forty whole files on
 * the bridge at once, in front of the work the main process is doing for the window
 * the user is looking at. Four is enough to keep the disk busy without queueing a
 * backlog nothing can interrupt (`core/concurrency.ts`).
 *
 * Exported so the bound is a claim a test can hold the code to, rather than a
 * number written twice.
 */
export const BIB_READ_CONCURRENCY = 4;
/**
 * How many file *heads* root detection may have in flight at once.
 *
 * Higher than the `.bib` bound because each read is bounded to 8 KB and the whole
 * point of the pass is to answer one question about every `.tex` file in the
 * project — 200 of them on the project this was measured on. Thirty-two keeps at
 * most 256 KB of structured clones in flight instead of 1.6 MB, and still answers
 * the question in a handful of rounds (`SESSION-NOTES.md` §2 names the 200
 * simultaneous reads as a candidate for the 3–5 s the editor takes to mount).
 */
export const HEAD_READ_CONCURRENCY = 32;

/** A path in the one spelling the project's file list uses, for comparisons. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Whether `target` is `root` itself or sits inside it, by normalized prefix. */
function isInside(root: string, target: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

/**
 * How often the crash-recovery mirror may be written while typing.
 *
 * The mirror carries the *whole* unsaved set, so writing it per keystroke meant
 * structured-cloning and sending every open dirty buffer — measured at 390 KB
 * and 0.73 ms of the keystroke's own task for a four-buffer session — and the
 * renderer's IPC bridge charges that clone synchronously, inside the keystroke.
 *
 * This is a ceiling rather than a plain debounce: a pass is written at most once
 * per window, and always within one window of the last change, so the exposure
 * does not grow with how long the user keeps typing. Before, the mirror reached
 * the main process on every keystroke but the *disk* write behind it is debounced
 * by 400 ms and re-armed by each of those messages, so a continuous burst never
 * reached disk at all; the bound here is 250 ms of renderer-side work plus that
 * same 400 ms write, and the worst case is stated in `flushRecovery`.
 */
const RECOVERY_WINDOW_MS = 250;

/** The recovery record for one buffer, as the main process stores it. */
export interface UnsavedBufferRecord {
  content: string;
  timestamp: number;
  languageId: string;
}

export class WorkspaceService extends EventEmitter {
  private readonly dependencies: WorkspaceDependencies;
  private readonly documents: OpenDocument[] = [];
  private activeUri: string | null = null;
  private workspacePath: string | null = null;
  private recentWorkspaces: RecentWorkspace[] = [];
  private building = false;
  private autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private watchedFiles = new Set<string>();
  private readonly diskMtimes = new Map<string, number>();
  private readonly recentlyClosedUris: string[] = [];
  private analyzer: DocumentAnalyzer | null = null;
  /** Analyses the files the project index reads, in the main process; see `backgroundAnalysis`. */
  private analysisService: LatexAnalysisService | null = null;
  /** The analyzer load, once started; `undefined` until someone asks for it. */
  private analyzerPromise: Promise<DocumentAnalyzer | null> | undefined;
  /**
   * The root document the session remembered, for the folder it is restoring.
   *
   * Consumed once by `openFolder({ restoreOnly: true })`: the session says which
   * file was the root last time, so re-deriving it by reading the head of every
   * `.tex` file in the project is work the launch does not have to repeat. It is
   * a hint and is checked against the scan before it is used.
   */
  private pendingRootFile: string | null = null;
  /** The workspace path the session already holds, so it is not re-written. */
  private sessionWorkspacePath: string | null = null;
  private openCounter = 0;
  /** The armed recovery pass, while one is waiting out the window. */
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the mirror was last handed to the main process. */
  private recoveryWrittenAt = 0;
  private readonly projectTabsStorageKey = 'eukolia.project_tabs';
  private memoryProjectTabs: Record<string, { openFiles: string[]; activeFile: string | null }> = {};
  private isOpeningFolder = false;

  constructor(dependencies: WorkspaceDependencies) {
    super();
    this.dependencies = dependencies;
    this.installRecoveryFlushHooks();
    /*
     * Watcher failures are subscribed here rather than by the app shell, unlike
     * every other filesystem event: they are not about a file, they are about the
     * service's own ability to notice files, and the service outlives any one
     * surface that might want to say so.
     *
     * Read through `globalThis` rather than `this.api`, because this runs in the
     * constructor and a module evaluated without a window — the service is
     * constructed at import time by `instance.ts` — must not throw on the way in.
     */
    const api = typeof window !== 'undefined' ? window.eukoliaApi : undefined;
    if (typeof api?.onFileWatchError === 'function') {
      api.onFileWatchError((event) => this.handleWatchError(event));
    }
  }

  private get api() {
    return window.eukoliaApi;
  }

  /**
   * Starts loading the analyzer and installs it when it arrives.
   *
   * Deliberately fire-and-forget and deliberately *after* the first paint: the
   * parser is the single largest thing the renderer loads, and nothing the shell
   * draws before a document is open depends on it. `ensureAnalyzer` is the
   * awaiting counterpart for callers that cannot proceed without it.
   */
  public beginAnalyzerLoad(): Promise<DocumentAnalyzer | null> {
    this.analyzerPromise ??= this.dependencies.createAnalyzer().then(
      (analyzer) => {
        if (analyzer) this.installAnalyzer(analyzer);
        return analyzer;
      },
      (error) => {
        console.warn('[eukolia] the LaTeX analyzer could not be loaded', error);
        return null;
      }
    );
    return this.analyzerPromise;
  }

  /** Resolves once the analyzer exists and has been installed. */
  public ensureAnalyzer(): Promise<DocumentAnalyzer | null> {
    return this.beginAnalyzerLoad();
  }

  /**
   * Installs the analyzer on every buffer, re-analysing each one.
   *
   * This is the whole hand-off: a document opened before the parser arrived has
   * an empty analysis, and re-analysis is what fills in the outline, the labels
   * and the macro table the visual editor typesets with.
   */
  private installAnalyzer(analyzer: DocumentAnalyzer): void {
    this.analyzer = analyzer;
    for (const entry of this.documents) entry.doc.setAnalyzer(analyzer);
    projectIndex.reindex();
    this.dependencies.onAnalyzerLoaded?.(analyzer);
    this.notify();
  }

  /**
   * The analyzer every document uses. Set at startup with the ported LaTeX
   * Workshop analyzer; existing buffers are re-analyzed immediately.
   */
  public setAnalyzer(analyzer: DocumentAnalyzer | null): void {
    this.analyzer = analyzer;
    for (const entry of this.documents) entry.doc.setAnalyzer(analyzer);
    projectIndex.reindex();
    this.notify();
  }

  /** True once an analyzer has been installed. */
  public hasAnalyzer(): boolean {
    return this.analyzer !== null;
  }

  // -------------------------------------------------------------- snapshots

  public getSnapshot(): WorkspaceSnapshot {    return {
      workspacePath: this.workspacePath,
      workspaceName: this.workspacePath ? (this.workspacePath.split(/[\\/]/).pop() ?? null) : null,
      documents: [...this.documents],
      activeUri: this.activeUri,
      recentWorkspaces: [...this.recentWorkspaces],
      building: this.building
    };
  }

  public getActive(): OpenDocument | null {
    if (!this.activeUri) return null;
    return this.documents.find((entry) => entry.doc.uri === this.activeUri) ?? null;
  }

  public getActiveDocument(): DocumentModel | null {
    return this.getActive()?.doc ?? null;
  }

  public getOpenDocuments(): OpenDocument[] {
    return [...this.documents];
  }

  public getWorkspacePath(): string | null {
    return this.workspacePath;
  }

  private changeNotificationTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleChangeNotification(): void {
    if (this.changeNotificationTimer !== null) return;
    this.changeNotificationTimer = setTimeout(() => {
      this.changeNotificationTimer = null;
      this.notify();
    }, 60);
  }

  private loadAllProjectTabs(): Record<string, { openFiles: string[]; activeFile: string | null }> {
    try {
      const storage = typeof localStorage !== 'undefined' ? localStorage : (typeof window !== 'undefined' ? window.localStorage : undefined);
      if (storage) {
        const raw = storage.getItem(this.projectTabsStorageKey);
        if (raw) return JSON.parse(raw);
      }
    } catch {}
    return this.memoryProjectTabs;
  }

  private saveAllProjectTabs(all: Record<string, { openFiles: string[]; activeFile: string | null }>): void {
    this.memoryProjectTabs = all;
    try {
      const storage = typeof localStorage !== 'undefined' ? localStorage : (typeof window !== 'undefined' ? window.localStorage : undefined);
      if (storage) {
        storage.setItem(this.projectTabsStorageKey, JSON.stringify(all));
      }
    } catch {}
  }

  public saveProjectSession(folderPath: string): void {
    const key = normalizePath(folderPath);
    const openFiles = this.documents
      .map((entry) => entry.doc.uri)
      .filter((uri) => !uri.startsWith('untitled:'));
    const activeFile = this.activeUri;
    const all = this.loadAllProjectTabs();
    all[key] = { openFiles, activeFile };
    this.saveAllProjectTabs(all);
  }

  public getProjectSession(folderPath: string): { openFiles: string[]; activeFile: string | null } | null {
    const key = normalizePath(folderPath);
    const all = this.loadAllProjectTabs();
    return all[key] ?? null;
  }

  private notify(): void {
    if (this.changeNotificationTimer !== null) {
      clearTimeout(this.changeNotificationTimer);
      this.changeNotificationTimer = null;
    }
    if (this.workspacePath && !this.isOpeningFolder) {
      this.saveProjectSession(this.workspacePath);
    }
    this.emit('change', this.getSnapshot());
  }

  private wireDocumentEvents(doc: DocumentModel): void {
    doc.on('change', () => {
      this.scheduleAutoSave(doc);
      this.scheduleRecovery();
      this.scheduleChangeNotification();
    });
    // The analysis lands after the change it belongs to (the parse is kept off
    // the keystroke path), so the shell is told again when it does — that is
    // what refreshes the outline, the breadcrumbs and the symbol index.
    doc.on('analysis-change', () => this.notify());
    doc.on('dirty-change', () => this.notify());
  }

  // ----------------------------------------------------------------- opening

  /** Restores session state loaded from the main process. */
  public async restoreSession(state: {
    workspacePath: string | null;
    openFiles: string[];
    activeFile: string | null;
    rootFile?: string | null;
    recentWorkspaces?: RecentWorkspace[];
    unsavedBuffers?: Record<string, { content: string; timestamp: number; languageId: string }>;
  }): Promise<void> {
    this.recentWorkspaces = state.recentWorkspaces ?? [];
    // The remembered root is handed to `openFolder`, which checks it against the
    // scan before believing it — it is a hint that saves re-deriving it, not a
    // claim that is trusted.
    this.pendingRootFile = state.rootFile ?? null;
    this.sessionWorkspacePath = state.workspacePath;

    if (state.workspacePath) {
      try {
        await this.openFolder(state.workspacePath, { restoreOnly: true });
      } catch (err) {
        console.warn('[eukolia] could not restore workspace', err);
      }
    }
    startupMark('session:workspace-restored');

    /*
     * Open buffers are read together.
     *
     * Each one is a file read plus a `DocumentModel` construction, and they are
     * independent of one another, so opening six files used to be six sequential
     * round trips across the bridge before the first tab appeared. The order of
     * `state.openFiles` is preserved because it is the order of the tab strip.
     */
    const restored = await Promise.all(
      state.openFiles.map(async (filePath) => {
        try {
          return await this.openFile(filePath, { activate: false });
        } catch {
          /* a file may have been deleted since the session was saved */
          return null;
        }
      })
    );
    startupMark(`session:files-restored:${restored.filter(Boolean).length}`);

    // Crash recovery: offer unsaved buffers that are newer than the file on disk.
    const unsaved = state.unsavedBuffers ?? {};
    for (const [uri, buffer] of Object.entries(unsaved)) {
      const existing = this.documents.find((entry) => entry.doc.uri === uri);
      try {
        const stat = await this.api.stat(uri);
        const diskIsNewer = stat.exists && stat.mtimeMs > buffer.timestamp;
        if (existing) {
          if (!diskIsNewer && existing.doc.getText() !== buffer.content) {
            existing.doc.setText(buffer.content, 'disk');
            existing.doc.markClean();
            existing.recovered = true;
          }
        } else if (!diskIsNewer) {
          const doc = new DocumentModel(uri, uri.split(/[\\/]/).pop() ?? 'recovered.tex', buffer.content, buffer.languageId);
          this.attachDocument(doc, true);
        }
      } catch {
        /* ignore recovery failures; the file may be gone */
      }
    }

    if (state.activeFile && this.documents.some((entry) => entry.doc.uri === state.activeFile)) {
      this.activeUri = state.activeFile;
    } else if (this.documents.length > 0) {
      this.activeUri = this.documents[0].doc.uri;
    }

    this.notify();
  }

  private attachDocument(doc: DocumentModel, recovered = false): OpenDocument {
    doc.setAnalyzer(this.analyzer);
    const entry: OpenDocument = { doc, recovered, externalChange: false, pinned: false };
    this.documents.push(entry);

    this.wireDocumentEvents(doc);

    projectIndex.registerDocument(doc);
    this.watchFile(doc.uri).catch(() => undefined);
    void this.refreshMtime(doc.uri);
    this.notify();
    return entry;
  }

  /**
   * Opens a file. When it is already open the existing buffer is activated
   * rather than reloaded, so unsaved work is never lost.
   */
  public async openFile(filePath: string, options: { activate?: boolean; line?: number; column?: number } = {}): Promise<DocumentModel> {
    const existing = this.documents.find((entry) => entry.doc.uri === filePath);
    if (existing) {
      if (options.activate !== false) this.setActive(filePath, options.line, options.column);
      return existing.doc;
    }

    /*
     * The file's contents and the analyzer are fetched together.
     *
     * These are the two things a buffer needs and neither depends on the other,
     * so a document is not read and then *waited for*: the parser load — which is
     * the slowest thing on this path and may have been started before the shell
     * existed — overlaps the read. A buffer opened before the analyzer resolves
     * would start with an empty outline and empty macro table, which the visual
     * editor would then have to re-typeset.
     */
    const [content, analyzer] = await Promise.all([
      this.api.readFile(filePath),
      this.beginAnalyzerLoad()
    ]);
    const name = filePath.split(/[\\/]/).pop() ?? 'untitled.tex';
    const doc = new DocumentModel(filePath, name, content, this.languageIdFor(name));
    if (analyzer) doc.setAnalyzer(analyzer);
    const entry = this.attachDocument(doc);

    if (/\.bib$/i.test(filePath)) {
      this.registerBib(filePath, content);
    }
    if (/\.(tex|ltx)$/i.test(filePath)) {
      void this.indexIncludedSourceFiles(filePath).catch(() => undefined);
    }

    if (options.activate !== false) this.setActive(filePath, options.line, options.column);
    this.openCounter++;
    return entry.doc;
  }

  /** Creates an empty, unsaved buffer. */
  public createUntitled(content = '', name?: string): DocumentModel {
    const index = ++this.openCounter;
    const fileName = name ?? `untitled-${index}.tex`;
    const doc = new DocumentModel(`untitled:${fileName}`, fileName, content, this.languageIdFor(fileName));
    this.attachDocument(doc);
    this.setActive(doc.uri);
    return doc;
  }

  public setActive(uri: string, line?: number, column?: number): void {
    if (!this.documents.some((entry) => entry.doc.uri === uri)) return;
    const previous = this.activeUri;
    this.activeUri = uri;
    this.emit('active-change', { uri, line, column });
    this.notify();
    // Leaving one editor for another is a focus change for the editor that was
    // left behind, which is exactly what VS Code's `onDidActiveEditorChange`
    // reports (`files.autoSave: "onFocusChange"` therefore saves a chapter as
    // soon as you switch to the next one). The buffer is named rather than
    // looked up as "the active one", which by now is the new document.
    if (previous && previous !== uri) {
      void this.runAutoSave('activeEditorChange', previous).catch(() => undefined);
    }
  }

  public closeDocument(uri: string, options: { force?: boolean } = {}): boolean {
    const index = this.documents.findIndex((entry) => entry.doc.uri === uri);
    if (index === -1) return false;
    const entry = this.documents[index];
    if (entry.doc.getDirty() && !options.force) {
      this.emit('close-blocked', { uri, document: entry.doc });
      return false;
    }

    this.documents.splice(index, 1);
    projectIndex.unregisterDocument(uri);
    // Cancels an armed analysis pass and drops this buffer's listeners.
    entry.doc.dispose();
    this.autoSaveTimers.delete(uri);
    this.watchedFiles.delete(uri);
    void this.api.unwatch([uri]).catch(() => undefined);
    // The closed buffer's record goes now, not at the next window: there will
    // not be another change in a buffer that no longer exists.
    omitKey(uri);
    void this.flushRecovery();

    if (!uri.startsWith('untitled:')) {
      const existing = this.recentlyClosedUris.indexOf(uri);
      if (existing !== -1) this.recentlyClosedUris.splice(existing, 1);
      this.recentlyClosedUris.push(uri);
      if (this.recentlyClosedUris.length > 30) this.recentlyClosedUris.shift();
    }

    if (this.activeUri === uri) {
      const next = this.documents[Math.min(index, this.documents.length - 1)];
      this.activeUri = next ? next.doc.uri : null;
    }
    this.emit('closed', uri);
    this.notify();
    return true;
  }

  /** Returns recently closed file URIs (most recent at the end). */
  public getRecentlyClosed(): readonly string[] {
    return this.recentlyClosedUris;
  }

  /** Reopens the most recently closed document. */
  public async reopenLastClosed(): Promise<string | null> {
    const uri = this.recentlyClosedUris.pop();
    if (!uri) return null;
    await this.openFile(uri);
    return uri;
  }

  public closeAll(options: { force?: boolean } = {}): boolean {
    for (const entry of [...this.documents]) {
      if (!this.closeDocument(entry.doc.uri, options)) return false;
    }
    return true;
  }

  public togglePin(uri: string): void {
    const entry = this.documents.find((e) => e.doc.uri === uri);
    if (!entry) return;
    entry.pinned = !entry.pinned;
    // Pinned tabs sort before unpinned ones, preserving relative order otherwise.
    this.documents.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    this.notify();
  }

  /** Drag-and-drop tab reordering (Instructions.md §67). */
  public reorderDocument(fromUri: string, toIndex: number): void {
    const from = this.documents.findIndex((entry) => entry.doc.uri === fromUri);
    if (from === -1) return;
    const [entry] = this.documents.splice(from, 1);
    const clamped = Math.max(0, Math.min(toIndex, this.documents.length));
    this.documents.splice(clamped, 0, entry);
    this.notify();
  }

  // ---------------------------------------------------------------- folders

  /**
   * Opens a project folder.
   *
   * Four things happen, and they are ordered by what the person waiting on them
   * can see. The directory is confirmed, the project root is set and the *tree* is
   * read and published — that is the Explorer filling in, and it is the only part
   * that has to finish before the call returns. Everything after it is work that
   * makes later questions cheaper rather than making this one answerable:
   *
   *   - the recent-workspace list is written to the session;
   *   - every `.bib` in the project is parsed, so citation completion is ready by
   *     the time anyone completes a citation;
   *   - the root document is detected, and the files it `\input`s are indexed.
   *
   * Those three are background work on purpose. They are all *derived* state: the
   * Explorer is complete without them, nothing on screen is wrong until they land,
   * and a project of any size turns them into seconds of waiting if they are
   * awaited. Their results arrive as events (`root-document`, `index-change`) that
   * the shell already listens for.
   *
   * This is the second of §62's two measurements: opening stays cheap not by
   * doing less, but by not making the visible part wait for the invisible part.
   */
  public async openFolder(folderPath: string, options: { restoreOnly?: boolean } = {}): Promise<void> {
    const stat = await this.api.stat(folderPath);
    if (!stat.exists || !stat.isDirectory) {
      throw new Error(`Not a directory: ${folderPath}`);
    }

    this.isOpeningFolder = true;
    try {
      if (this.workspacePath && normalizePath(this.workspacePath) !== normalizePath(folderPath)) {
        this.saveProjectSession(this.workspacePath);
        void this.unwatchWorkspaceTree(this.workspacePath);
        const prevDocs = [...this.documents];
        this.documents.length = 0;
        this.activeUri = null;
        for (const entry of prevDocs) {
          projectIndex.unregisterDocument(entry.doc.uri);
          entry.doc.dispose();
          this.autoSaveTimers.delete(entry.doc.uri);
          this.watchedFiles.delete(entry.doc.uri);
          void this.api.unwatch([entry.doc.uri]).catch(() => undefined);
          omitKey(entry.doc.uri);
        }
      }

      this.workspacePath = folderPath;
      projectIndex.setProjectRoot(folderPath);
      // Before the listing, so a file created while the tree is being read is
      // noticed rather than missed between the two.
      await this.watchWorkspaceTree(folderPath);

      const excludes = setting.list('files.exclude');
      const tree = await this.api.listTree(folderPath, excludes, 20000);
      startupMark('session:tree-read');

      const flat = flatten(tree);
      projectIndex.setFiles(flat.map((node) => ({ path: node.path, name: node.name, isDirectory: node.isDirectory, size: node.size, mtimeMs: node.mtimeMs })));
      this.emit('tree-change', tree);
      this.notify();

      await this.finishOpeningFolder(folderPath, flat, options);
    } finally {
      this.isOpeningFolder = false;
      if (this.workspacePath) {
        this.saveProjectSession(this.workspacePath);
      }
    }
  }

  /**
   * The derived half of opening a folder. Never awaited by `openFolder`.
   *
   * `restoreOnly` skips root detection because the session already remembers
   * which file was the root, and re-deriving it is the expensive part: it reads
   * the head of every `.tex` file in the project (bounded, but still a read per
   * candidate). The remembered root is trusted exactly as far as it can be — it
   * must still be one of the files the scan just found.
   */
  private async finishOpeningFolder(
    folderPath: string,
    flat: readonly FileNode[],
    options: { restoreOnly?: boolean }
  ): Promise<void> {
    const bibFiles = flat.filter((node) => !node.isDirectory && /\.bib$/i.test(node.name));
    const detectedRoot = options.restoreOnly ? this.rememberedRootFile(flat) : null;

    await Promise.all([
      this.rememberWorkspaceInSession(folderPath),
      /*
       * Every bibliography the project has, bounded two ways.
       *
       * They are dependency-free parses, so they run together rather than one after
       * the other — but "together" was a single `Promise.all` over the whole list,
       * which for a project with forty `.bib` files meant forty whole files crossing
       * the bridge at once. `BIB_READ_CONCURRENCY` keeps the disk busy without
       * queueing a backlog, and `readForIndexing` drops a file too large to be worth
       * indexing at all.
       */
      mapWithConcurrency(bibFiles, BIB_READ_CONCURRENCY, async (bib) => {
        try {
          const content = await this.readForIndexing(bib.path);
          if (content !== null) this.registerBib(bib.path, content);
        } catch (err) {
          console.warn('[eukolia] could not read bibliography', bib.path, err);
        }
      })
    ]);
    startupMark('session:bibs-and-recents');

    if (detectedRoot) {
      projectIndex.setRootDocumentPath(detectedRoot);
      this.emit('root-document', detectedRoot);
      await this.indexIncludedSourceFiles(detectedRoot);
      return;
    }

    if (options.restoreOnly) return;

    const saved = this.getProjectSession(folderPath);
    if (saved && saved.openFiles.length > 0) {
      await Promise.all(
        saved.openFiles.map(async (filePath) => {
          try {
            return await this.openFile(filePath, { activate: false });
          } catch {
            return null;
          }
        })
      );
      if (saved.activeFile && this.documents.some((e) => e.doc.uri === saved.activeFile)) {
        this.setActive(saved.activeFile);
      } else if (this.documents.length > 0) {
        this.setActive(this.documents[0].doc.uri);
      }
    }

    const root = await this.detectRoot([...flat]);
    startupMark('session:root-detected');
    if (!root) return;
    projectIndex.setRootDocumentPath(root);
    this.emit('root-document', root);
    // Read what the root document pulls in, so a project whose macros live in an
    // `\input`ed file is fully known without opening that file.
    await this.indexIncludedSourceFiles(root);
    startupMark('session:includes-indexed');
    if (this.documents.length === 0) {
      await this.openFile(root);
    }
  }

  /**
   * The root document this session remembered, if it is still in the project.
   *
   * A remembered path is a claim about the *last* session, so it is checked
   * against the file list the scan just produced rather than trusted: a renamed
   * or deleted root is simply absent, and detection runs as it always did.
   */
  private rememberedRootFile(flat: readonly FileNode[]): string | null {
    const remembered = this.pendingRootFile;
    this.pendingRootFile = null;
    if (!remembered) return null;
    const normalized = normalizePath(remembered);
    return flat.find((node) => !node.isDirectory && normalizePath(node.path) === normalized)?.path ?? null;
  }

  /**
   * Adds the folder to the recent list and writes the session.
   *
   * `rememberWorkspace` reads the current state to build the new list, so the
   * write cannot be folded into the read; both are off the critical path and are
   * skipped when the folder is already the remembered one, which is the startup
   * case and the one that happens on every launch.
   */
  private async rememberWorkspaceInSession(folderPath: string): Promise<void> {
    if (this.sessionWorkspacePath === folderPath) {
      this.recentWorkspaces = await this.rememberWorkspace(folderPath);
      return;
    }
    this.recentWorkspaces = await this.rememberWorkspace(folderPath);
    this.sessionWorkspacePath = folderPath;
    await this.api.setState({ workspacePath: folderPath, recentWorkspaces: this.recentWorkspaces });
  }

  /**
   * Reads the LaTeX files reachable from `rootPath` through `\input`, `\include`
   * and friends, and registers their macros in the project index.
   *
   * A macro file is normally `\input`ed and never edited on its own, so it is
   * never an open buffer — and everything the project knows about macros used to
   * come from open buffers only. Mathematics that uses such a macro could then
   * not be typeset in Visual Mode, and it failed *silently*: MathJax renders an
   * undefined control sequence as its own name, so `\R` came out as a plain
   * italic R rather than blackboard bold (Instructions.md §26, §29, §30).
   *
   * Deliberately not a project-wide scan. Only the files the root document
   * actually includes are read — the ones whose macros are in scope — with a
   * bounded queue and a bounded file count, so opening a large project stays
   * cheap (Instructions.md §62).
   */
  /**
   * The analyzer for the files this walk reads, in the main process where there is
   * a bridge to it.
   *
   * Constructed on first use rather than at startup: a window that opens with no
   * project never asks the main process for an analysis, and the fallback (the
   * renderer's own analyzer) is only loaded if the channel turns out to be
   * unusable.
   */
  private get backgroundAnalysis(): LatexAnalysisService {
    this.analysisService ??= new LatexAnalysisService({
      fallback: () => this.ensureAnalyzer(),
      invoke: this.dependencies.analyzeDocument
    });
    return this.analysisService;
  }

  /**
   * The largest file the index will read whole, in bytes.
   *
   * `advanced.maxProjectFileSize` — the setting that was declared and read by
   * nothing. 2 MB by default, and the fallback repeats that default rather than
   * trusting the settings manager to have produced a number: a bound of `NaN` or
   * zero would refuse every file in the project, which is a worse failure than the
   * unbounded read this replaces.
   */
  private indexingLimitBytes(): number {
    const kilobytes = setting.num('advanced.maxProjectFileSize');
    const sane = Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes : 2048;
    return sane * 1024;
  }

  /**
   * Reads a file *for the index*, or reports that it is not worth indexing.
   *
   * Two callers: the `\input` walk and the `.bib` pass — the two places that read
   * whole files the user did not open. Both are indexing work, and VS Code's rule
   * for a file past its large-file threshold is that the *language features* are
   * switched off rather than that the file cannot be opened: a 40 MB `.bib` is a
   * file the user can still open and edit, it is simply not something the project
   * index parses before they have typed anything.
   *
   * The size comes from a `stat` rather than from the tree, because the tree
   * deliberately carries no sizes (`fsHandler.readTree`): asking for one file's
   * size is cheaper than making every project open pay a `stat` per entry.
   */
  private async readForIndexing(filePath: string): Promise<string | null> {
    const stat = await this.api.stat(filePath);
    if (!stat.exists || stat.isDirectory) return null;
    const limit = this.indexingLimitBytes();
    if (stat.size > limit) {
      console.info(
        `[eukolia] not indexing ${filePath}: ${Math.round(stat.size / 1024)} KB is over advanced.maxProjectFileSize (${Math.round(limit / 1024)} KB)`
      );
      return null;
    }
    return this.api.readFile(filePath);
  }

  public async indexIncludedSourceFiles(rootPath: string): Promise<number> {
    /*
     * The renderer's analyzer is *not* loaded here unless it is the only way.
     *
     * The work happens in the main process, which loads its own copy of the parser,
     * so asking for the renderer's copy first would evaluate 1.5 MB of parser on the
     * very thread this path exists to keep free — the cost this channel was
     * introduced to remove, paid before the first file is even read. Only when no
     * channel can be used does the fallback load, and then it is loaded
     * deliberately.
     */
    if (!this.backgroundAnalysis.start()) {
      const analyzer = await this.ensureAnalyzer();
      if (!analyzer) return 0;
    }

    const texFiles = projectIndex.findTexFiles();
    if (texFiles.length === 0) return 0;

    const byPath = new Map<string, string>();
    for (const file of texFiles) byPath.set(normalizePath(file.path), file.path);
    const readable = (path: string): boolean => {
      const found = byPath.get(normalizePath(path));
      return found !== undefined && !projectIndex.getFile(found)?.isDirectory;
    };

    /*
     * The walk follows `\input`, and nothing else.
     *
     * It used to be seeded with every file in the project whose *name* matched
     * `/macro|preamble|theorem|def/i` — 362 files on a 2 846-file project, of which
     * the limit let 200 through. That was a guess at where a project keeps its
     * macros, and the document states the answer outright: a chapter's root reads
     * `\input{macros}` before its sections. Following the graph the author wrote is
     * both correct and cheaper by an order of magnitude — ten to twenty files for a
     * chapter rather than two hundred for the project — and it is the only set that
     * can matter, because a macro file the document does not `\input` is one LaTeX
     * cannot see either.
     *
     * The limit stays as the bound on a pathological graph (a root that inputs its
     * way through the whole project).
     */
    const queue: string[] = [rootPath];
    const visited = new Set<string>();
    let read = 0;

    while (queue.length > 0 && read < INCLUDED_SOURCE_FILE_LIMIT) {
      const current = queue.shift() as string;
      if (visited.has(normalizePath(current))) continue;
      visited.add(normalizePath(current));

      let content: string | null;
      try {
        content = await this.readForIndexing(current);
      } catch {
        // Unreadable (deleted since the scan, or a permissions problem): the
        // file simply contributes no macros rather than failing the open.
        continue;
      }
      // Too large to be worth indexing: see `readForIndexing`.
      if (content === null) continue;
      read += 1;

      projectIndex.registerExternalSource(current, content);

      /*
       * In the main process, not on this thread.
       *
       * A single file costs real time to analyse — measured on this project at
       * 483 ms on average and 914 ms worst, because a chapter's `macros.tex` is four
       * hundred lines of definitions — and two hundred of them is 24.8 s of parsing.
       *
       * This used to run here, and an earlier attempt to make it polite waited for
       * 400 ms of quiet between files. That was the wrong shape: it did not remove
       * the freeze, it rescheduled it, so the editor stalled in half-second blocks
       * every time the reader paused to think. The work is unbounded, nobody is
       * waiting on it and nothing on screen depends on the frame it lands in, which
       * is precisely the work that belongs on the other side of a process boundary
       * (`parser/latexAnalysis.ts`). The fallback path still runs it here, and says
       * so in the console, because a missing channel must not cost the project its
       * macro index.
       */
      let analysis;
      try {
        analysis = await this.backgroundAnalysis.analyze(content, current);
      } catch (err) {
        console.warn('[eukolia] could not analyse included file', current, err);
        continue;
      }

      projectIndex.registerExternalMacros(
        current,
        analysis.macroDefinitions.map((macro) => ({
          name: macro.name,
          args: macro.args,
          file: current,
          line: macro.line,
          definition: macro.definition
        }))
      );

      for (const included of analysis.includedFiles) {
        const target = resolveRelative(current, included.path);
        if (readable(target)) queue.push(target);
      }
    }

    return read;
  }

  /** Detects the root document using the ported LaTeX Workshop logic. */
  public async detectRoot(files: Array<{ path: string; name: string; isDirectory: boolean }>): Promise<string | null> {
    const texFiles = files.filter((file) => !file.isDirectory && /\.(tex|ltx)$/i.test(file.name));
    if (texFiles.length === 0) return null;

    /*
     * Only what root detection reads: the magic comment and `\documentclass` are
     * both at the top of a file.
     *
     * `readFileHead` bounds the read in the main process, so a project of large
     * chapters costs the head of each file rather than the whole of each file
     * across the IPC bridge — and the reads are issued together instead of one
     * after the other, which is what made this the slowest step of opening a
     * project (Instructions.md §62).
     */
    const HEAD_BYTES = 8192;
    const candidates = texFiles.slice(0, 200);
    /*
     * Together, but bounded.
     *
     * These were issued as one `Promise.all` over all 200 candidates: 200
     * simultaneous IPC calls, each carrying 8 KB, all landing in the main process
     * while the window is waiting for the editor to appear. `HEAD_READ_CONCURRENCY`
     * keeps the answers coming in rounds rather than in one wave, which is the same
     * trade VS Code's file service makes with its throttled read queue.
     */
    const heads = await mapWithConcurrency(candidates, HEAD_READ_CONCURRENCY, async (file) => {
      try {
        return [file.path, await this.api.readFileHead(file.path, HEAD_BYTES)] as const;
      } catch {
        /* unreadable file: skip it as a root candidate */
        return null;
      }
    });

    const contents = new Map<string, string>();
    for (const head of heads) {
      if (head) contents.set(head[0], head[1].slice(0, 40000));
    }

    return this.dependencies.detectRootDocument(files, contents);
  }

  public getFileTree(): Promise<FileNode[]> {
    if (!this.workspacePath) return Promise.resolve([]);
    return this.api.listTree(this.workspacePath, setting.list('files.exclude'), 20000);
  }

  /**
   * Re-reads the project tree and hands it to the index.
   *
   * The listing is a full recursive walk of the workspace — up to
   * `MAX_TREE_ENTRIES` of them, 2 846 files on the project this was reported from —
   * followed by a flatten and a rebuild of the index's file map and a React state
   * update, and it used to run once per *caller*: every explicit save of a `.tex`
   * file, every file operation, every external change, and the refresh button. A save
   * burst (autosave plus Ctrl+S plus a rename) produced that walk several times over
   * for one resulting tree.
   *
   * VS Code's Explorer coalesces file changes for the same reason, with a 500 ms
   * delay "to give our internal events a chance to react first". This coalesces
   * without the delay: callers that arrive while a listing is running wait for the
   * listing that includes their change, and however many arrive, only one more runs.
   * Every caller still gets an answer that postdates its own change, which is what
   * the `await`s at the call sites are for.
   */
  public async refreshTree(): Promise<FileNode[]> {
    if (!this.workspacePath) return [];

    if (this.refreshInFlight) {
      // The run in flight began before this call, so its answer may predate the
      // change this caller just made. Ask for one more, and share it.
      this.refreshAgain = true;
      while (this.refreshInFlight) await this.refreshInFlight;
      return this.lastTree;
    }

    do {
      this.refreshAgain = false;
      this.refreshInFlight = this.readTreeIntoIndex();
      try {
        this.lastTree = await this.refreshInFlight;
      } finally {
        this.refreshInFlight = null;
      }
    } while (this.refreshAgain);

    return this.lastTree;
  }

  /** The listing in flight, so concurrent callers share it; see `refreshTree`. */
  private refreshInFlight: Promise<FileNode[]> | null = null;
  /** Set while a listing is running to ask for one more after it. */
  private refreshAgain = false;
  /** The tree the last listing produced, returned to callers that shared it. */
  private lastTree: FileNode[] = [];

  /** The listing itself, split out so `refreshTree` can coalesce calls around it. */
  private async readTreeIntoIndex(): Promise<FileNode[]> {
    const tree = await this.getFileTree();
    projectIndex.setFiles(
      flatten(tree).map((node) => ({ path: node.path, name: node.name, isDirectory: node.isDirectory, size: node.size, mtimeMs: node.mtimeMs }))
    );
    this.emit('tree-change', tree);
    return tree;
  }

  // -------------------------------------------------------------- file ops

  /**
   * Creates a new .tex file in the folder of the current active project,
   * or falls back to an untitled in-memory buffer if no project is open.
   */
  public async createProjectNewFile(content = '', requestedName?: string): Promise<string> {
    if (!this.workspacePath) {
      const doc = this.createUntitled(content, requestedName);
      return doc.uri;
    }

    let fileName = requestedName ? requestedName.trim() : '';
    if (!fileName) {
      let index = 1;
      let candidate = 'untitled.tex';
      try {
        const stat = await this.api.stat(joinPath(this.workspacePath, candidate));
        if (stat.exists) {
          candidate = `untitled-${index}.tex`;
          let candidateStat = await this.api.stat(joinPath(this.workspacePath, candidate));
          while (candidateStat.exists) {
            index++;
            candidate = `untitled-${index}.tex`;
            candidateStat = await this.api.stat(joinPath(this.workspacePath, candidate));
          }
        }
      } catch {
        candidate = 'untitled.tex';
      }
      fileName = candidate;
    } else if (!/\.tex$/i.test(fileName)) {
      fileName = `${fileName}.tex`;
    }

    return this.createFile(fileName, content);
  }

  public async createFile(relativePath: string, content = ''): Promise<string> {
    if (!this.workspacePath) throw new Error('No workspace is open');
    const target = joinPath(this.workspacePath, relativePath);
    await this.api.createFile(target, content);
    await this.refreshTree();
    await this.openFile(target);
    return target;
  }

  public async createFolder(relativePath: string): Promise<string> {
    if (!this.workspacePath) throw new Error('No workspace is open');
    const target = joinPath(this.workspacePath, relativePath);
    await this.api.createDirectory(target);
    await this.refreshTree();
    return target;
  }

  public async rename(source: string, newName: string): Promise<string> {
    const directory = source.replace(/[\\/][^\\/]*$/, '');
    const target = joinPath(directory, newName);
    await this.api.renamePath(source, target);

    const entry = this.documents.find((e) => e.doc.uri === source);
    if (entry) {
      projectIndex.unregisterDocument(source);
      const wasActive = this.activeUri === source;
      const replacement = new DocumentModel(target, newName, entry.doc.getText(), entry.doc.languageId);
      const index = this.documents.indexOf(entry);
      this.documents.splice(index, 1, { doc: replacement, recovered: entry.recovered, externalChange: false, pinned: entry.pinned });
      replacement.setAnalyzer(this.analyzer);
      this.wireDocumentEvents(replacement);
      projectIndex.registerDocument(replacement);
      if (wasActive) this.activeUri = target;
    }

    const renameRecentIndex = this.recentlyClosedUris.indexOf(source);
    if (renameRecentIndex !== -1) {
      this.recentlyClosedUris[renameRecentIndex] = target;
    }

    await this.refreshTree();
    this.notify();
    return target;
  }

  public async delete(target: string, useTrash = true): Promise<void> {
    const entry = this.documents.find((e) => e.doc.uri === target);
    if (entry) this.closeDocument(target, { force: true });
    await this.api.deletePath(target, useTrash);
    await this.refreshTree();
  }

  public async duplicate(source: string): Promise<string> {
    const directory = source.replace(/[\\/][^\\/]*$/, '');
    const name = source.replace(/^.*[\\/]/, '');
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let candidate = `${stem}-copy${extension}`;
    let counter = 1;
    while ((await this.api.stat(joinPath(directory, candidate))).exists) {
      candidate = `${stem}-copy-${++counter}${extension}`;
    }
    const target = joinPath(directory, candidate);
    await this.api.copyPath(source, target);
    await this.refreshTree();
    return target;
  }

  public async move(source: string, targetDirectory: string): Promise<string> {
    const fileName = source.replace(/^.*[\\/]/, '');
    const target = joinPath(targetDirectory, fileName);
    if (source === target) return target;

    await this.api.renamePath(source, target);

    const wasActive = this.activeUri === source;
    const entry = this.documents.find((e) => e.doc.uri === source);
    if (entry) {
      projectIndex.unregisterDocument(source);
      const replacement = new DocumentModel(target, fileName, entry.doc.getText(), this.languageIdFor(fileName));
      const index = this.documents.indexOf(entry);
      this.documents.splice(index, 1, { doc: replacement, recovered: entry.recovered, externalChange: false, pinned: entry.pinned });
      replacement.setAnalyzer(this.analyzer);
      this.wireDocumentEvents(replacement);
      projectIndex.registerDocument(replacement);
      if (wasActive) this.activeUri = target;
    }

    const moveRecentIndex = this.recentlyClosedUris.indexOf(source);
    if (moveRecentIndex !== -1) {
      this.recentlyClosedUris[moveRecentIndex] = target;
    }

    await this.refreshTree();
    this.notify();
    return target;
  }

  /** Copies an external file into the target directory inside the workspace. */
  public async importFile(sourcePath: string, targetDirectory: string): Promise<string> {
    const fileName = sourcePath.replace(/^.*[\\/]/, '');
    let target = joinPath(targetDirectory, fileName);
    let counter = 1;
    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : '';
    while ((await this.api.stat(target)).exists) {
      target = joinPath(targetDirectory, `${stem}-${++counter}${ext}`);
    }
    await this.api.copyPath(sourcePath, target);
    await this.refreshTree();
    this.notify();
    return target;
  }

  // ----------------------------------------------------------------- saving

  public async save(document?: DocumentModel): Promise<boolean> {
    let doc = document ?? this.getActiveDocument();
    if (!doc) return false;

    let target = doc.uri;
    if (target.startsWith('untitled:')) {
      const chosen = await this.api.saveFileDialog(doc.filename, [
        { name: 'LaTeX Documents', extensions: ['tex'] },
        { name: 'All Files', extensions: ['*'] }
      ]);
      if (!chosen) return false;
      target = chosen;
    }

    const text = this.prepareForSave(doc);
    await this.api.writeFile(target, text);

    if (target !== doc.uri) {
      // The buffer became a real file: re-key it in the index and tab list.
      const previousUri = doc.uri;
      const previousFilename = doc.filename;
      const entry = this.documents.find((e) => e.doc.uri === previousUri);
      projectIndex.unregisterDocument(previousUri);
      if (entry) {
        const replacement = new DocumentModel(target, target.split(/[\\/]/).pop() ?? previousFilename, text, doc.languageId);
        replacement.setAnalyzer(this.analyzer);
        this.wireDocumentEvents(replacement);
        const index = this.documents.indexOf(entry);
        this.documents.splice(index, 1, { doc: replacement, recovered: false, externalChange: false, pinned: entry.pinned });
        projectIndex.registerDocument(replacement);
        this.activeUri = target;
        this.watchFile(target).catch(() => undefined);
        await this.refreshMtime(target);
        doc = replacement;
      }
    }

    doc.markSaved(text);
    // An explicit save is exactly when the record has to be current: the saved
    // buffer leaves it and nothing else may roll it back, so any armed pass is
    // cancelled and the mirror written from the buffers as they are now.
    omitKey(doc.uri);
    await this.flushRecovery();
    await this.refreshMtime(doc.uri);
    if (this.workspacePath && /\.(tex|ltx|bib)$/i.test(doc.filename) && this.isNewToTree(doc.uri)) {
      /*
       * Only when the save is what puts the file in the tree.
       *
       * This re-lists the whole workspace — 2 846 files on the project this was
       * reported from — and it ran on *every* save of a `.tex` file, which is to say
       * every Ctrl+S and every autosave, for a tree whose shape a save cannot change.
       * The one case that does need it is the first save of a file the tree has never
       * seen (a new untitled buffer, or an import), and that is what this asks.
       *
       * VS Code does not re-list on save at all: its Explorer is fed by the workspace
       * watcher, and a write to a file it already lists produces no tree change.
       * Until this application watches its workspace, the narrow question keeps the
       * common case free of the walk without leaving a new file missing.
       */
      await this.refreshTree();
    }
    this.notify();
    return true;
  }

  /** True when the project tree has never listed this path. */
  private isNewToTree(uri: string): boolean {
    return projectIndex.getFile(uri) === undefined;
  }
  public async saveAs(document?: DocumentModel): Promise<boolean> {
    const doc = document ?? this.getActiveDocument();
    if (!doc) return false;
    const chosen = await this.api.saveFileDialog(doc.filename, [
      { name: 'LaTeX Documents', extensions: ['tex'] },
      { name: 'All Files', extensions: ['*'] }
    ]);
    if (!chosen) return false;

    await this.api.writeFile(chosen, doc.getText());
    const name = chosen.split(/[\\/]/).pop() ?? doc.filename;
    const replacement = new DocumentModel(chosen, name, doc.getText(), this.languageIdFor(name));
    this.attachDocument(replacement);
    replacement.markSaved();
    this.setActive(chosen);
    if (this.workspacePath) await this.refreshTree();
    return true;
  }

  public async saveAll(): Promise<number> {    let saved = 0;
    for (const entry of this.documents) {
      if (!entry.doc.getDirty()) continue;
      try {
        if (await this.save(entry.doc)) saved++;
      } catch (err) {
        console.error('[eukolia] save failed', entry.doc.uri, err);
      }
    }
    return saved;
  }

  public async promptSaveIfDirty(uri?: string): Promise<'saved' | 'discarded' | 'cancelled'> {
    const targets = uri
      ? this.documents.filter((entry) => entry.doc.uri === uri)
      : this.documents.filter((entry) => entry.doc.getDirty());
    if (targets.length === 0) return 'saved';

    const names = targets.map((entry) => entry.doc.filename).join(', ');
    const response = await this.api.confirmDialog({
      type: 'warning',
      message: targets.length === 1 ? `Save changes to ${names}?` : `Save changes to ${targets.length} files?`,
      detail:
        targets.length === 1
          ? 'Your changes will be lost if you do not save them.'
          : `Unsaved files: ${names}`,
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2
    });

    if (response === 2) return 'cancelled';
    if (response === 1) return 'discarded';
    for (const entry of targets) await this.save(entry.doc);
    return 'saved';
  }

  // ------------------------------------------------------ save-time transforms

  /**
   * Applies the configured save-time transforms and returns the text to write.
   *
   * Runs as one edit so the buffer keeps a single undo step, and so the saved
   * bytes always match the buffer afterwards (Instructions.md §45: never destroy
   * unsaved work — the transforms are visible in the editor before the write).
   */
  private prepareForSave(doc: DocumentModel): string {
    let text = doc.getText();
    let changed = false;

    if (setting.bool('formatting.alignOnSave') && doc.languageId === 'latex') {
      const aligned = formattingEngine.alignDocument(text);
      if (aligned !== text) {
        text = aligned;
        changed = true;
      }
    }

    if (setting.bool('formatting.trimTrailingWhitespaceOnSave')) {
      const trimmed = text.replace(/[ \t]+$/gm, '');
      if (trimmed !== text) {
        text = trimmed;
        changed = true;
      }
    }

    if (setting.bool('files.trimFinalNewline') && !text.endsWith('\n')) {
      text += '\n';
      changed = true;
    }

    if (changed) doc.setText(text, 'format');
    return text;
  }

  // ------------------------------------------------------- external changes

  private async watchWorkspaceTree(folderPath: string): Promise<void> {
    if (this.watchedTree === folderPath) return;
    if (typeof this.api.watchTree !== 'function') return;
    try {
      await this.api.watchTree(folderPath, setting.list('files.watcherExclude'));
      this.watchedTree = folderPath;
    } catch (error) {
      // A watch that cannot be started is not a failure to open the project: the
      // tree is correct at this moment, and it is only *later* external changes
      // that go unnoticed until a refresh.
      console.warn('[eukolia] could not watch the project for external changes', error);
    }
  }

  private async unwatchWorkspaceTree(folderPath: string): Promise<void> {
    if (this.watchedTree !== folderPath) return;
    this.watchedTree = null;
    if (typeof this.api.unwatchTree !== 'function') return;
    try {
      await this.api.unwatchTree(folderPath);
    } catch {
      /* the window or the folder is going away */
    }
  }

  /** The recursive watch of the open folder, while one is running. */
  private watchedTree: string | null = null;

  /**
   * Called by the app shell when the main process reports a watcher failure.
   *
   * `EMFILE` and `ENOSPC` mean the project is no longer being watched, which is
   * invisible otherwise: the tree simply stops updating. The event is emitted for
   * whichever surface shows it; the log line is what makes it findable after the
   * fact.
   */
  public handleWatchError(event: FileWatchErrorEvent): void {
    console.warn(`[eukolia] the file watcher failed for ${event.path}: ${event.code} ${event.message}`);
    this.emit('watch-error', event);
  }

  private async watchFile(filePath: string): Promise<void> {
    if (filePath.startsWith('untitled:')) return;
    if (this.watchedFiles.has(filePath)) return;
    /*
     * A file inside the open folder is already covered by the recursive workspace
     * watcher, and watching it a second time would deliver the same change twice —
     * once per watcher — for every save the user makes. Files *outside* the folder
     * (opened from another project, or from the dialog) still need their own watch,
     * because nothing else is looking at them.
     */
    if (this.watchedTree && isInside(this.watchedTree, filePath)) return;
    this.watchedFiles.add(filePath);
    await this.api.watch([filePath]);
  }

  private async refreshMtime(filePath: string): Promise<void> {
    if (filePath.startsWith('untitled:')) return;
    try {
      const stat = await this.api.stat(filePath);
      if (stat.exists) this.diskMtimes.set(filePath, stat.mtimeMs);
    } catch {
      /* ignore */
    }
  }

  /** Called by the app shell when the main process reports a filesystem change. */
  public async handleExternalChange(event: FileWatchEvent): Promise<void> {
    if (event.kind === 'delete') {
      const entry = this.documents.find((e) => e.doc.uri === event.path);
      if (entry) {
        entry.externalChange = true;
        this.notify();
        this.emit('external-delete', event.path);
      } else if (this.workspacePath) {
        await this.refreshTree();
      }
      return;
    }

    const entry = this.documents.find((e) => e.doc.uri === event.path);
    if (!entry) {
      if (this.workspacePath) await this.refreshTree();
      return;
    }

    const stat = await this.api.stat(event.path);
    const previous = this.diskMtimes.get(event.path);
    if (previous !== undefined && stat.exists && Math.abs(stat.mtimeMs - previous) < 1) return;
    this.diskMtimes.set(event.path, stat.mtimeMs);

    if (entry.doc.getDirty()) {
      // Never silently overwrite unsaved work (Instructions.md §45).
      entry.externalChange = true;
      this.notify();
      this.emit('external-change', event.path);
      return;
    }

    const content = await this.api.readFile(event.path);
    if (content !== entry.doc.getText()) {
      entry.doc.reloadFromDisk(content);
      this.emit('reloaded', event.path);
    }
  }

  public async resolveExternalChange(uri: string, action: 'reload' | 'keep'): Promise<void> {
    const entry = this.documents.find((e) => e.doc.uri === uri);
    if (!entry) return;
    if (action === 'reload') {
      const content = await this.api.readFile(uri);
      entry.doc.reloadFromDisk(content);
    }
    entry.externalChange = false;
    await this.refreshMtime(uri);
    this.notify();
  }

  // ------------------------------------------------------------ autosave / recovery

  /**
   * The autosave mode as it stands.
   *
   * Read per event rather than remembered, so changing `files.autoSave` in the
   * settings pane applies to the very next change, focus loss or window blur —
   * including to a timer that was armed under the previous mode (which checks
   * again when it fires).
   */
  public autoSaveMode(): AutoSaveMode {
    return normalizeAutoSaveMode(setting.str('files.autoSave'));
  }

  /**
   * Runs the autosave `files.autoSave` asks for at `trigger`, if it asks for one.
   *
   * This is where all three trigger modes meet, and the reason they can share
   * one entry point: the *policy* is a pure table (`core/autoSave.ts`), so the
   * callers only have to say what happened — a document changed, the editor lost
   * focus, the window lost focus, another document became active — and the mode
   * decides whether that means a write, and of which buffers. Returns the number
   * of buffers written.
   *
   * `uri` names the buffer that was left, for the two focus triggers. It is what
   * makes `editorFocusLost` and `activeEditorChange` save the buffer the user was
   * actually editing rather than whichever document the workspace happens to
   * consider active by the time the write runs; when it is omitted the active
   * buffer is used.
   */
  public async runAutoSave(trigger: AutoSaveTrigger, uri?: string): Promise<number> {
    if (!autoSaveRunsFor(this.autoSaveMode(), trigger)) return 0;
    const focused = uri ?? this.activeUri;
    const targets =
      autoSaveScopeFor(trigger) === 'all'
        ? this.documents.map((entry) => entry.doc)
        : this.documents.filter((entry) => entry.doc.uri === focused).map((entry) => entry.doc);
    return this.saveDirtyDocuments(targets);
  }

  /**
   * Writes the dirty buffers among `docs` that have a file behind them.
   *
   * A buffer that has never been saved is skipped rather than saved: there is no
   * path to write it to, and `save()` answers that by opening a Save dialog. A
   * timer — or a focus change the user did not ask for — must never raise one, so
   * the buffer keeps its dirty marker and the recovery mirror (§59) is what
   * stands between it and a crash. VS Code's autosave refuses untitled working
   * copies for the same reason ("we never auto save untitled working copies").
   *
   * Failures are logged and counted as not saved: this runs from a timer and from
   * event handlers, where there is no one to report to, and one unwritable file
   * must not stop the others from being written.
   */
  private async saveDirtyDocuments(docs: readonly DocumentModel[]): Promise<number> {
    let saved = 0;
    for (const doc of docs) {
      if (!doc.getDirty() || doc.uri.startsWith('untitled:')) continue;
      try {
        if (await this.save(doc)) saved++;
      } catch (err) {
        console.error('[eukolia] autosave failed', doc.uri, err);
      }
    }
    return saved;
  }

  /**
   * Arms (or re-arms) the delayed write for a buffer that just changed.
   *
   * One timer per buffer, and every change pushes it out: `afterDelay` promises a
   * pause, not a heartbeat, so a burst of typing costs a single write 1.5 seconds
   * after the last keystroke rather than one per interval.
   */
  private scheduleAutoSave(doc: DocumentModel): void {
    if (!autoSaveRunsFor(this.autoSaveMode(), 'afterDelay')) return;
    // Nothing to write to, and `save()` would ask where to put it: see
    // `saveDirtyDocuments`.
    if (doc.uri.startsWith('untitled:')) return;
    const delay = setting.num('files.autoSaveDelayMs');

    const existing = this.autoSaveTimers.get(doc.uri);
    if (existing) clearTimeout(existing);

    this.autoSaveTimers.set(
      doc.uri,
      setTimeout(() => {
        this.autoSaveTimers.delete(doc.uri);
        // Asking again rather than trusting the mode the timer was armed under:
        // the setting can have been changed, or the buffer saved, while it ran.
        if (doc.getDirty() && autoSaveRunsFor(this.autoSaveMode(), 'afterDelay')) {
          void this.saveDirtyDocuments([doc]);
        }
      }, delay)
    );
  }

  /**
   * Flushes pending autosaves and reports dirty buffers.
   *
   * This is the shutdown hook, so it also writes the recovery mirror: a pass
   * that is still waiting out its window would otherwise be lost when the
   * application quits.
   */
  public async flushAutoSave(): Promise<void> {
    for (const [uri, timer] of this.autoSaveTimers) {
      clearTimeout(timer);
      const entry = this.documents.find((e) => e.doc.uri === uri);
      // The same two refusals as everywhere else on this path: `off` means the
      // user has asked for no automatic writes at all, and a buffer with no file
      // cannot be written without asking — which is not something a shutdown may
      // do. Both keep the recovery mirror below as the safety net.
      if (entry?.doc.getDirty() && this.autoSaveMode() !== 'off' && !uri.startsWith('untitled:')) {
        await this.save(entry.doc).catch(() => undefined);
      }
    }
    this.autoSaveTimers.clear();
    await this.flushRecovery();
  }

  /**
   * Writes the recovery mirror when the window is going away.
   *
   * The renderer is never told that the application is quitting, so the events
   * the browser does raise are used instead. They are best effort — an `invoke`
   * started here cannot be awaited across unload — which is why the window
   * above is a ceiling on the exposure rather than the only line of defence.
   */
  private installRecoveryFlushHooks(): void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const flush = () => void this.flushRecovery();
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    window.addEventListener('blur', flush);
  }

  /**
   * Mirrors unsaved buffers to the main process so a crash cannot lose them
   * (Instructions.md §59). Written at most once per `RECOVERY_WINDOW_MS`, from
   * the buffers as they are when the pass runs — never from a snapshot taken
   * when it was armed (§61), so a stale write cannot overwrite newer text.
   *
   * The exposure this introduces is bounded and worth stating plainly: a
   * renderer that dies between the last keystroke and the pass loses up to
   * `RECOVERY_WINDOW_MS` of typing that used to be mirrored immediately. A crash
   * of the whole application loses at most that plus the main process's own
   * 400 ms state-write debounce — and it lost more before, because those
   * per-keystroke messages re-armed that debounce and a continuous burst
   * therefore never reached disk at all. `flushRecovery` is the immediate path:
   * saving, closing a buffer and shutting the window all take it.
   */
  private scheduleRecovery(): void {
    if (!setting.bool('general.crashRecovery')) return;

    const wait = Math.max(0, this.recoveryWrittenAt + RECOVERY_WINDOW_MS - Date.now());
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.flushRecovery();
    }, wait);
  }

  /**
   * Writes the recovery mirror now, cancelling an armed pass, and reports the
   * one failure a caller can act on.
   *
   * A pass is also armed at the first change after the window has elapsed, so a
   * single keystroke after a pause is still mirrored within one task of it.
   */
  public flushRecovery(): Promise<void> {
    this.cancelPendingRecovery();
    if (!setting.bool('general.crashRecovery')) return Promise.resolve();

    this.recoveryWrittenAt = Date.now();
    return this.api.setState({ unsavedBuffers: this.recoveryBuffers() }).then(
      () => undefined,
      (err) => console.error('[eukolia] could not mirror unsaved buffers', err)
    );
  }

  private cancelPendingRecovery(): void {
    if (this.recoveryTimer === null) return;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  /**
   * The mirror: every open buffer that holds unsaved work, plus any record from
   * an earlier session that no open buffer accounts for (work the user has not
   * recovered yet, which must survive this session's writes).
   *
   * Reading the live buffers is also what makes the record *correct*: the old
   * write merged the changed buffer into the set loaded at startup, so typing in
   * one buffer re-sent every other buffer as it was at startup and could roll a
   * crash record back to text the user had already replaced.
   */
  private recoveryBuffers(): Record<string, UnsavedBufferRecord> {
    const next: Record<string, UnsavedBufferRecord> = { ...(currentUnsavedBuffers() as Record<string, UnsavedBufferRecord>) };
    for (const entry of this.documents) {
      const doc = entry.doc;
      // A clean buffer is not unsaved work — including an untouched untitled
      // draft, which is not worth offering back after a restart.
      if (!doc.getDirty()) {
        delete next[doc.uri];
        continue;
      }
      next[doc.uri] = { content: doc.getText(), timestamp: Date.now(), languageId: doc.languageId };
    }
    return next;
  }

  // ------------------------------------------------------------------ helpers

  public registerBib(path: string, content: string): void {
    try {
      const entries = this.dependencies.parseBibtex(content, path);
      projectIndex.registerBibEntries(path, entries);
    } catch (err) {
      console.error('[eukolia] failed to parse bibliography', path, err);
    }
  }

  /** Applies minimal deltas to a document from any editor surface. */
  public applyDeltas(uri: string, deltas: readonly TextDelta[], source: 'code' | 'visual' | 'format' | 'snippet'): void {
    const entry = this.documents.find((e) => e.doc.uri === uri);
    if (!entry) return;
    entry.doc.applyDeltas(deltas, source);
  }

  private languageIdFor(fileName: string): string {
    return languageIdFor(fileName);
  }

  private async rememberWorkspace(folderPath: string): Promise<RecentWorkspace[]> {
    const list = await this.api.getState();
    const entry: RecentWorkspace = {
      path: folderPath,
      name: folderPath.split(/[\\/]/).pop() ?? folderPath,
      openedAt: Date.now()
    };
    return [entry, ...(list?.recentWorkspaces ?? []).filter((w: RecentWorkspace) => w.path.toLowerCase() !== folderPath.toLowerCase())].slice(0, 20);
  }

  public setBuilding(building: boolean): void {
    this.building = building;
    this.notify();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flatten(nodes: readonly FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  const walk = (list: readonly FileNode[]) => {
    for (const node of list) {
      result.push(node);
      if (node.children && node.children.length > 0) walk(node.children);
    }
  };
  walk(nodes);
  return result;
}

function joinPath(directory: string, relative: string): string {
  const separator = directory.includes('\\') ? '\\' : '/';
  const cleaned = relative.replace(/^[\\/]+/, '').replace(/[\\/]+/g, separator);
  return `${directory.replace(/[\\/]+$/, '')}${separator}${cleaned}`;
}

let cachedUnsaved: Record<string, unknown> = {};

/** Last known crash-recovery payload, so writes merge rather than replace. */
async function loadUnsavedBuffers(): Promise<void> {
  try {
    const state = await window.eukoliaApi.getState();
    cachedUnsaved = { ...(state.unsavedBuffers ?? {}) };
  } catch {
    cachedUnsaved = {};
  }
}

function currentUnsavedBuffers(): Record<string, unknown> {
  return cachedUnsaved;
}

function omitKey(key: string): Record<string, unknown> {
  const next = { ...cachedUnsaved };
  delete next[key];
  cachedUnsaved = next;
  return next;
}

/** Must be awaited once during startup before recovery writes are trusted. */
export async function primeWorkspaceRecovery(): Promise<void> {
  await loadUnsavedBuffers();
}

export { flatten as flattenFileTree, joinPath };
export { TEXT_EXTENSIONS };
