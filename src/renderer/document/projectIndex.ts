/**
 * Eukolia project index.
 *
 * A single workspace-level store of everything the editor needs to be
 * project-aware (Instructions.md §29, §30, §49, §50, §51):
 *
 * - the file tree and its derived lists (TeX files, BibTeX files, images);
 * - the open documents and their parsed symbols (labels, citations, macros,
 *   environments, sectioning, `\input`ed files);
 * - the bibliography entries gathered from `.bib` files.
 *
 * It is deliberately a plain in-memory index that components subscribe to,
 * rather than a service that owns any UI.
 */

import { DocumentModel } from './documentModel';
import { EventEmitter } from '../core/events';
import type { OutlineItem } from './analysisTypes';

export interface ProjectFile {
  path: string;
  name: string;
  relativePath: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export interface BibEntry {
  key: string;
  type: string;
  /** Field name -> raw value, with braces/quoting preserved as written. */
  fields: Record<string, string>;
  /** Human-readable title, when present. */
  title?: string;
  authors?: string[];
  year?: string;
  journal?: string;
  booktitle?: string;
  doi?: string;
  url?: string;
  /** File the entry came from. */
  source: string;
  /** Line number of the entry in that file. */
  line: number;
}

export interface ProjectSymbol {
  name: string;
  kind: 'macro' | 'label' | 'citation' | 'environment' | 'section' | 'file';
  file: string;
  line: number;
  offset: number;
  detail?: string;
}

/**
 * One file, with the spellings the reference search compares against.
 *
 * See `ProjectIndex.searchableFiles` for why they are derived once per revision
 * rather than per query.
 */
interface ProjectSearchEntry {
  file: ProjectFile;
  /** `file.name`, lower-cased. */
  nameLower: string;
  /** `file.relativePath` with backslashes folded and lower-cased. */
  relativeLower: string;
}

/**
 * How many remembered reference answers a project keeps.
 *
 * The key carries the reference text, and a reference being typed produces a new
 * text per keystroke, so this is what keeps a session's worth of half-written
 * paths from accumulating. Entries are small; the bound is belt-and-braces.
 */
const MAX_REFERENCE_CACHE = 512;

export interface LabelOccurrence {
  name: string;
  file: string;
  line: number;
  offset: number;
  section?: string;
}

export interface CitationOccurrence {
  key: string;
  file: string;
  line: number;
  offset: number;
  command: string;
}

export interface MacroOccurrence {
  name: string;
  args: number;
  file: string;
  line: number;
  definition: string;
}

function relativeTo(root: string | null, filePath: string): string {
  if (!root) return filePath;
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.startsWith(`${normalizedRoot}/`) ? normalized.slice(normalizedRoot.length + 1) : normalized;
}

function isSubPath(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const normalized = candidate.replace(/\\/g, '/').toLowerCase();
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
}

export class ProjectIndex extends EventEmitter {
  private rootPath: string | null = null;
  private rootDocumentPath: string | null = null;
  /** True while a coalesced re-index is waiting for the current task to end. */
  private reindexQueued = false;

  private readonly files = new Map<string, ProjectFile>();
  private readonly documents = new Map<string, DocumentModel>();
  private readonly bibEntries = new Map<string, BibEntry>();
  private readonly bibSources = new Map<string, BibEntry[]>();

  /**
   * Bumped whenever the file list — or the root its `relativePath` is derived
   * from — changes. Everything derived from the list is keyed on it.
   */
  private filesRevision = 0;
  /** `searchableFiles()`'s memo, valid while its revision matches. */
  private searchEntries: { revision: number; entries: ProjectSearchEntry[] } | null = null;
  /** `resolveReference()`'s memo, emptied whenever the file list changes. */
  private readonly referenceCache = new Map<string, ProjectFile | null>();
  /** Theorem environments per open document, keyed on the edit version they were read at. */
  private readonly documentTheoremNames = new Map<string, { version: number; names: string[] }>();
  /** Theorem environments per registered file, keyed on the text they were read from. */
  private readonly externalTheoremNames = new Map<string, { source: string; names: string[] }>();
  /** When a document was last edited, for work that should wait for a quiet moment. */
  private lastEditAt = 0;

  /**
   * Milliseconds since the last edit to any open document.
   *
   * The background index parses files whose analysis costs hundreds of milliseconds
   * each, and nothing is waiting behind it — so it asks this before taking the main
   * thread, and gives it back the moment the user starts typing again.
   */
  public getIdleMs(): number {
    return this.lastEditAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.lastEditAt;
  }

  private labels: LabelOccurrence[] = [];
  private citations: CitationOccurrence[] = [];
  private macros: MacroOccurrence[] = [];
  /**
   * Macros read out of files that are not open buffers, keyed by their path.
   *
   * A LaTeX project keeps its macros in a file the root `\input`s, and the
   * macros are in scope in every chapter that includes it — but only an open
   * buffer is a `DocumentModel`, so a macro file nobody has opened would
   * otherwise contribute nothing and mathematics using it could not be typeset.
   * See `WorkspaceService.indexIncludedSourceFiles`.
   */
  private readonly externalMacros = new Map<string, MacroOccurrence[]>();
  private readonly externalSources = new Map<string, string>();
  private environments: string[] = [];
  private symbols: ProjectSymbol[] = [];
  private outline: OutlineItem[] = [];

  // ------------------------------------------------------------------ project

  public setProjectRoot(root: string | null): void {
    this.rootPath = root;
    if (root === null) {
      this.files.clear();
      this.externalMacros.clear();
      this.externalSources.clear();
    }
    // `relativePath` is derived from the root, so every spelling the candidate
    // search holds is stale the moment the root moves.
    this.invalidateFileCaches();
    this.emit('project-change', root);
  }

  public getProjectRoot(): string | null {
    return this.rootPath;
  }

  public getRootDocumentPath(): string | null {
    return this.rootDocumentPath;
  }

  public setRootDocumentPath(path: string | null): void {
    if (this.rootDocumentPath === path) return;
    this.rootDocumentPath = path;
    this.emit('root-document-change', path);
  }

  // -------------------------------------------------------------------- files

  /** Replaces the file list, e.g. after a directory scan. */
  public setFiles(paths: ReadonlyArray<{ path: string; name: string; isDirectory: boolean; size?: number; mtimeMs?: number }>): void {
    this.files.clear();
    for (const entry of paths) {
      this.addFile(entry);
    }
    this.emit('files-change', this.getFiles());
  }

  public addFile(entry: { path: string; name: string; isDirectory: boolean; size?: number; mtimeMs?: number }): void {
    this.files.set(entry.path, {
      path: entry.path,
      name: entry.name,
      relativePath: relativeTo(this.rootPath, entry.path),
      isDirectory: entry.isDirectory,
      size: entry.size ?? 0,
      mtimeMs: entry.mtimeMs ?? 0
    });
    this.invalidateFileCaches();
  }

  public removeFile(path: string): void {
    if (this.files.delete(path)) {
      this.invalidateFileCaches();
      this.emit('files-change', this.getFiles());
    }
  }

  public getFiles(): ProjectFile[] {
    return [...this.files.values()];
  }

  public getFile(path: string): ProjectFile | undefined {
    return this.files.get(path);
  }

  public findTexFiles(): ProjectFile[] {
    return this.getFiles().filter((f) => !f.isDirectory && /\.(tex|ltx|sty|cls)$/i.test(f.name));
  }

  public findBibFiles(): ProjectFile[] {
    return this.getFiles().filter((f) => !f.isDirectory && /\.bib$/i.test(f.name));
  }

  public findImageFiles(): ProjectFile[] {
    return this.getFiles().filter((f) => !f.isDirectory && /\.(pdf|png|jpe?g|eps|svg|gif|bmp|tiff?)$/i.test(f.name));
  }

  /**
   * The file list in the spellings the candidate search compares against.
   *
   * `findFileCandidates` runs once per `\input`-shaped reference — and
   * `cmNavigation` resolves **every reference in the document** on every edit, to
   * decide which of them can be clicked. The comparison it makes needs a
   * lower-cased, slash-normalised spelling of each file's path and name, and built
   * per call that was three string allocations for every file in the project for
   * every reference: a 7 000-file project with a hundred references spent two
   * million allocations inside one keystroke. The spellings are a property of the
   * file rather than of the query, so they are derived once per revision of the
   * file list and reused, which is the difference between typing that gets slower
   * as the project grows and typing that does not.
   *
   * Keyed on a revision counter rather than on the map's size: a rename changes no
   * count, and `relativePath` is derived from the project root, so a change of root
   * has to invalidate it too.
   */
  private searchableFiles(): ProjectSearchEntry[] {
    if (this.searchEntries && this.searchEntries.revision === this.filesRevision) {
      return this.searchEntries.entries;
    }
    const entries: ProjectSearchEntry[] = [];
    for (const file of this.files.values()) {
      entries.push({
        file,
        nameLower: file.name.toLowerCase(),
        relativeLower: file.relativePath.replace(/\\/g, '/').toLowerCase()
      });
    }
    this.searchEntries = { revision: this.filesRevision, entries };
    return entries;
  }

  /**
   * Candidate files for completing a path written as `\input{...}`.
   * Matches by suffix so both `chapters/intro` and `intro` resolve.
   */
  public findFileCandidates(prefix: string, extensions: readonly string[]): ProjectFile[] {
    const normalized = prefix.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    // Normalised once for the call rather than once per file: the caller derives
    // the list per reference, and the per-file form allocated a fresh suffix string
    // for every file in the project.
    const suffixes = extensions.map((ext) => `.${ext.replace(/^\./, '')}`);
    const matches: ProjectFile[] = [];
    for (const entry of this.searchableFiles()) {
      const { file, nameLower, relativeLower } = entry;
      if (file.isDirectory) continue;
      if (!suffixes.some((suffix) => nameLower.endsWith(suffix))) continue;
      if (!normalized || relativeLower.includes(normalized) || nameLower.startsWith(normalized)) {
        matches.push(file);
      }
    }
    return matches;
  }

  /**
   * The single file a reference resolves to, remembered across edits.
   *
   * The answer depends on the reference's text, on which commands' extensions the
   * caller asked for, and on the file list — and on nothing else. An edit changes
   * none of those: it moves the reference, and every reference in the document is
   * resolved again on every keystroke. Remembering the answer turns that from a
   * search of the whole project per reference into a map lookup, with the file
   * list's revision as the invalidation, so a rescan or a rename cannot serve a
   * path that no longer exists.
   *
   * Only the *first* candidate is remembered, which is the one every caller takes;
   * `findFileCandidates` remains the full search for the completion sources.
   */
  public resolveReference(prefix: string, extensions: readonly string[]): ProjectFile | undefined {
    const key = `${extensions.join(',')}\u0000${prefix}`;
    const remembered = this.referenceCache.get(key);
    if (remembered !== undefined) return remembered ?? undefined;
    const found = this.findFileCandidates(prefix, extensions)[0] ?? null;
    // Bounded: a document being typed into produces a new reference text per
    // keystroke while the path is being written.
    if (this.referenceCache.size >= MAX_REFERENCE_CACHE) {
      const oldest = this.referenceCache.keys().next().value;
      if (oldest !== undefined) this.referenceCache.delete(oldest);
    }
    this.referenceCache.set(key, found);
    return found ?? undefined;
  }

  /** Drops what the file list has answered, because the file list has changed. */
  private invalidateFileCaches(): void {
    this.filesRevision += 1;
    this.referenceCache.clear();
  }

  // ---------------------------------------------------------------- documents

  public registerDocument(doc: DocumentModel): void {
    if (this.documents.has(doc.uri)) return;
    this.documents.set(doc.uri, doc);
    doc.on('change', () => {
      this.lastEditAt = Date.now();
      this.scheduleReindex();
    });
    // The analysis is produced off the change path, so the index has to be told
    // when the pass actually lands; `change` alone would re-index the *previous*
    // analysis and the labels, citations and environments of the edit the user
    // just made would never reach the completion sources (see `DocumentModel`).
    doc.on('analysis-change', () => this.scheduleReindex());
    doc.on('saved', () => this.scheduleReindex());
    this.reindex();
  }

  public unregisterDocument(uri: string): void {
    if (this.documents.delete(uri)) {
      // Its cached theorem names are keyed on the buffer that is gone.
      this.documentTheoremNames.delete(uri);
      this.reindex();
    }
  }

  /**
   * Asks for a re-index, coalesced to one per task.
   *
   * `reindex` is a synchronous walk of every open buffer's analysis, and opening a
   * session is a burst of events that each ask for it: a restore of four buffers
   * produces four `change` events, four `analysis-change` events, the recovery
   * mirror and the tab strip — a dozen full walks in one task, each one
   * recomputing the same answer the last one did because nothing between them
   * changed the text.
   *
   * Measured on a 7,000-file project, opening one document produced a **1,052 ms**
   * main-thread task; the parse itself is a few tens of milliseconds of that and
   * the rest is this walk repeated. Coalescing to a microtask makes the burst one
   * walk, and a microtask rather than a timer because the index is read by
   * completion sources and the outline: it has to be current *within* the turn
   * that changed it, not a frame later.
   */
  private scheduleReindex(): void {
    if (this.reindexQueued) return;
    this.reindexQueued = true;
    queueMicrotask(() => {
      this.reindexQueued = false;
      this.reindex();
    });
  }

  public getDocument(uri: string): DocumentModel | undefined {
    return this.documents.get(uri);
  }

  public getAllDocuments(): DocumentModel[] {
    return [...this.documents.values()];
  }

  public getDirtyDocuments(): DocumentModel[] {
    return this.getAllDocuments().filter((doc) => doc.getDirty());
  }

  // ------------------------------------------------------------- bibliography

  /** Registers the parsed entries of one `.bib` file, replacing any previous parse. */
  public registerBibEntries(sourcePath: string, entries: BibEntry[]): void {
    const previous = this.bibSources.get(sourcePath);
    if (previous) {
      for (const entry of previous) {
        // Only remove when no other file defines the same key.
        const stillDefined = entries.some((e) => e.key === entry.key);
        if (!stillDefined && this.bibEntries.get(entry.key) === entry) this.bibEntries.delete(entry.key);
      }
    }
    this.bibSources.set(sourcePath, entries);
    for (const entry of entries) this.bibEntries.set(entry.key, entry);
    this.emit('bibliography-change', this.getBibEntries());
  }

  public removeBibSource(sourcePath: string): void {
    const entries = this.bibSources.get(sourcePath);
    if (!entries) return;
    this.bibSources.delete(sourcePath);
    for (const entry of entries) {
      if (this.bibEntries.get(entry.key) === entry) this.bibEntries.delete(entry.key);
    }
    this.emit('bibliography-change', this.getBibEntries());
  }

  public getBibEntries(): BibEntry[] {
    return [...this.bibEntries.values()];
  }

  public getBibEntry(key: string): BibEntry | undefined {
    return this.bibEntries.get(key);
  }

  // ------------------------------------------------------------------ symbols

  /**
   * The theorem environments a source text declares.
   *
   * The declaration syntax is narrow, and the same expressions are asked about the
   * same files on every keystroke: this project registers 200 `\input`ed sources, so
   * the walk that collects environment names was scanning **two megabytes of text
   * that had not changed** once per character typed — measured at 4.3 ms per
   * keystroke on the project this was reported from. The names are a function of the
   * text, so they are computed when the text is registered and only revisited when
   * it changes.
   */
  private static theoremNamesIn(source: string): string[] {
    const names: string[] = [];
    const regex = /\\newtheorem\*?\s*\{([a-zA-Z0-9*_-]+)\}|\\declaretheorem\s*(?:\[[^\]]*\])?\s*\{([a-zA-Z0-9*_-]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const name = match[1] || match[2];
      if (name) names.push(name);
    }
    return names;
  }

  public reindex(): void {
    const labels: LabelOccurrence[] = [];
    const citations: CitationOccurrence[] = [];
    const macros: MacroOccurrence[] = [];
    const environments = new Set<string>();

    for (const doc of this.documents.values()) {
      const analysis = doc.getAnalysis();
      for (const label of analysis.labels) {
        if (typeof label.name !== 'string' || !label.name) continue;
        labels.push({ name: label.name, file: doc.uri, line: label.line, offset: label.offset });
      }
      for (const citation of analysis.citations) {
        for (const key of citation.keys) {
          if (typeof key !== 'string' || !key) continue;
          citations.push({ key, file: doc.uri, line: citation.line, offset: citation.offset, command: citation.command });
        }
      }
      for (const macro of analysis.macroDefinitions) {
        if (typeof macro.name !== 'string' || !macro.name) continue;
        macros.push({ name: macro.name, args: macro.args, file: doc.uri, line: macro.line, definition: macro.definition });
      }
      for (const env of analysis.environments) {
        // An analyzer bug must not corrupt the index; anything that is not a
        // usable name is skipped rather than propagated.
        if (typeof env.name !== 'string') continue;
        const name = env.name.trim();
        if (name) environments.add(name);
      }
    }

    this.labels = labels;
    this.citations = citations;
    // Macros of open buffers first, then those of the files on disk that they
    // `\input`: an open buffer is the live document and wins, and a project-wide
    // table is assembled from both so a macro defined anywhere in the project is
    // known everywhere (Instructions.md §29, §30).
    this.macros = [...macros, ...this.externalMacroList()];
    // `document`, `equation` and friends are always worth offering.
    for (const builtin of ['document', 'equation', 'equation*', 'align', 'align*', 'figure', 'table', 'itemize', 'enumerate', 'abstract', 'verbatim', 'center', 'quote', 'theorem', 'lemma', 'proof', 'cases', 'matrix', 'pmatrix', 'bmatrix']) {
      environments.add(builtin);
    }
    // Cached per source: an open buffer is keyed on its edit version, a file on disk
    // on the text that was registered for it. Nothing here reads a source's text
    // again unless that source has actually changed.
    for (const doc of this.documents.values()) {
      const version = doc.getVersion();
      const cached = this.documentTheoremNames.get(doc.uri);
      if (cached && cached.version === version) {
        for (const name of cached.names) environments.add(name);
        continue;
      }
      const names = ProjectIndex.theoremNamesIn(doc.getText());
      this.documentTheoremNames.set(doc.uri, { version, names });
      for (const name of names) environments.add(name);
    }
    for (const [path, source] of this.externalSources.entries()) {
      if (this.documents.has(path)) continue;
      const cached = this.externalTheoremNames.get(path);
      if (cached && cached.source === source) {
        for (const name of cached.names) environments.add(name);
        continue;
      }
      const names = ProjectIndex.theoremNamesIn(source);
      this.externalTheoremNames.set(path, { source, names });
      for (const name of names) environments.add(name);
    }
    this.environments = [...environments].sort((a, b) => a.localeCompare(b));

    // The outline follows the root document when one is known, otherwise the
    // active/first document — matching what a LaTeX user expects to see.
    const rootDoc = this.rootDocumentPath ? this.documents.get(this.rootDocumentPath) : undefined;
    this.outline = rootDoc ? rootDoc.getOutline() : this.documents.values().next().value?.getOutline() ?? [];

    // A citation key's first occurrence, in one pass: the symbols list used to call
    // `citations.find` once per distinct key, which is a scan of every citation for
    // every key.
    const firstCitation = new Map<string, CitationOccurrence>();
    for (const citation of citations) {
      if (!firstCitation.has(citation.key)) firstCitation.set(citation.key, citation);
    }
    this.symbols = [
      ...macros.map<ProjectSymbol>((m) => ({ name: m.name, kind: 'macro', file: m.file, line: m.line, offset: 0, detail: m.definition })),
      ...labels.map<ProjectSymbol>((l) => ({ name: l.name, kind: 'label', file: l.file, line: l.line, offset: l.offset })),
      ...[...firstCitation].map<ProjectSymbol>(([key, first]) => ({ name: key, kind: 'citation', file: first.file, line: first.line, offset: first.offset })),
      ...this.environments.map<ProjectSymbol>((name) => ({ name, kind: 'environment', file: '', line: 0, offset: 0 }))
    ];

    this.emit('index-change');
  }

  public getLabels(): LabelOccurrence[] {
    return this.labels;
  }

  public getLabelOccurrences(name: string): LabelOccurrence[] {
    return this.labels.filter((l) => l.name === name);
  }

  public getCitations(): CitationOccurrence[] {
    return this.citations;
  }

  public getMacros(): MacroOccurrence[] {
    return this.macros;
  }

  /**
   * Registers the macros of a file that is not an open buffer, replacing
   * whatever was registered for that path before.
   *
   * The workspace reads the files a document `\input`s and hands their parsed
   * macros here, so macros defined in a shared `macros.tex` reach the project
   * table — and from there the editor — without the user having to open the file
   * (Instructions.md §29, §30).
   */
  public registerExternalMacros(sourcePath: string, macros: ReadonlyArray<MacroOccurrence>): void {
    this.externalMacros.set(sourcePath, [...macros]);
    this.reindex();
  }

  /** Drops the macros registered for a path, e.g. when a project is reopened. */
  public clearExternalMacros(sourcePath?: string): void {
    if (sourcePath === undefined) this.externalMacros.clear();
    else this.externalMacros.delete(sourcePath);
    this.reindex();
  }

  /**
   * Registers the raw source text of a file that is not an open buffer.
   * Enables theorem declarations, preambles, and macros to be resolved project-wide.
   */
  public registerExternalSource(sourcePath: string, content: string): void {
    this.externalSources.set(sourcePath, content);
    this.scheduleReindex();
  }

  /** Drops external sources, e.g. when a project is closed or reopened. */
  public clearExternalSources(sourcePath?: string): void {
    if (sourcePath === undefined) this.externalSources.clear();
    else this.externalSources.delete(sourcePath);
    // The cached names belong to the text that was registered, so they go with it
    // rather than being re-derived from a source that is no longer there.
    if (sourcePath === undefined) this.externalTheoremNames.clear();
    else this.externalTheoremNames.delete(sourcePath);
    this.scheduleReindex();
  }

  public getExternalSources(): string[] {
    return [...this.externalSources.values()];
  }

  /**
   * The paths of the included source files the walk registered.
   *
   * Separate from `getExternalSources`, which returns their *texts* — the name
   * says otherwise there, and it is kept as it is because it has callers. This
   * is the accessor the Mathematical Symbols panel needs: deciding whether a
   * macro declaration is in scope means knowing *which files* the compilation
   * reaches, and until now nothing exposed that list.
   */
  public getIncludedSourcePaths(): string[] {
    return [...this.externalSources.keys()];
  }

  public getExternalSource(sourcePath: string): string | undefined {
    return this.externalSources.get(sourcePath);
  }

  /**
   * Returns all source texts across open documents and registered external files.
   */
  public getAllSources(): string[] {
    const sources: string[] = [];
    for (const doc of this.documents.values()) {
      sources.push(doc.getText());
    }
    for (const [path, src] of this.externalSources.entries()) {
      if (!this.documents.has(path)) {
        sources.push(src);
      }
    }
    return sources;
  }

  /**
   * The macros of files that are not open, in registration order.
   *
   * A macro whose name an open buffer also defines is skipped: the buffer is
   * what the user is looking at and editing, so its definition is the one in
   * force.
   */
  private externalMacroList(): MacroOccurrence[] {
    if (this.externalMacros.size === 0) return [];

    const open = new Set<string>();
    for (const doc of this.documents.values()) {
      for (const macro of doc.getAnalysis().macroDefinitions) {
        if (typeof macro.name === 'string' && macro.name) open.add(macro.name);
      }
    }

    const byName = new Map<string, MacroOccurrence>();
    for (const macros of this.externalMacros.values()) {
      for (const macro of macros) {
        if (!macro.name || open.has(macro.name)) continue;
        byName.set(macro.name, macro);
      }
    }
    return [...byName.values()];
  }

  public getMacro(name: string): MacroOccurrence | undefined {
    for (let i = this.macros.length - 1; i >= 0; i--) {
      if (this.macros[i].name === name) return this.macros[i];
    }
    return undefined;
  }

  /**
   * Macro definitions as MathJax/TeX `\def` bodies, for the visual editor's
   * mathematical rendering (Instructions.md §26, §30).
   */
  public getMacroTable(): Record<string, string> {
    const table: Record<string, string> = {};
    for (const macro of this.macros) {
      table[macro.name] = macro.definition;
    }
    return table;
  }

  public getEnvironmentNames(): string[] {
    return this.environments;
  }

  public getSymbols(): ProjectSymbol[] {
    return this.symbols;
  }

  public getOutline(): OutlineItem[] {
    return this.outline;
  }

  /** Citation keys that appear in the project's documents. */
  public getCitedKeys(): string[] {
    return [...new Set(this.citations.map((c) => c.key))];
  }

  /** Citation keys defined in a `.bib` file but never cited. */
  public getUncitedKeys(): string[] {
    const cited = new Set(this.getCitedKeys());
    return this.getBibEntries()
      .map((e) => e.key)
      .filter((key) => !cited.has(key));
  }

  /** Citation keys cited but missing from every bibliography. */
  public getMissingKeys(): string[] {
    return this.getCitedKeys().filter((key) => !this.bibEntries.has(key));
  }

  /** All files under the current project root, for path completion. */
  public filesUnderRoot(): ProjectFile[] {
    if (!this.rootPath) return this.getFiles();
    return this.getFiles().filter((file) => isSubPath(this.rootPath!, file.path));
  }
}

export const projectIndex = new ProjectIndex();
