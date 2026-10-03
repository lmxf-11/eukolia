/**
 * Eukolia document model.
 *
 * One `.tex` buffer shared by Code Mode and Visual Mode (Instructions.md §17,
 * §28). Edits are expressed as minimal offset deltas so a visual edit never
 * regenerates surrounding source (§27), and the buffer keeps a version number
 * that asynchronous work (parsing, rendering, diagnostics) uses to discard stale
 * results (§61).
 *
 * The model deliberately knows nothing about any particular LaTeX parser: an
 * `DocumentAnalyzer` is injected, so the ported LaTeX Workshop parser can be
 * swapped in or out without touching the buffer.
 */

import { EventEmitter } from '../core/events';
import { setting } from '../core/settings';
import { largeDocumentProfile, lineCount } from '../visual/largeDocument';
import type { OutlineItem } from './analysisTypes';

export type EditSource = 'code' | 'visual' | 'disk' | 'format' | 'snippet' | 'external' | 'undo' | 'redo';

/** A minimal, source-preserving edit: replace `[from, to)` with `insert`. */
export interface TextDelta {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface DocumentChangeEvent {
  readonly content: string;
  readonly source: EditSource;
  readonly version: number;
  /** The deltas applied, in ascending offset order. Empty for whole-text replacement. */
  readonly deltas: readonly TextDelta[];
  /** True when the buffer content is identical to what is on disk. */
  readonly clean: boolean;
}

export interface DocumentAnalysis {
  readonly outline: OutlineItem[];
  readonly labels: ReadonlyArray<{ name: string; offset: number; line: number }>;
  readonly citations: ReadonlyArray<{ keys: string[]; offset: number; line: number; command: string }>;
  readonly macroDefinitions: ReadonlyArray<{ name: string; args: number; offset: number; line: number; definition: string }>;
  readonly environments: ReadonlyArray<{ name: string; beginOffset: number; endOffset: number | null; line: number }>;
  readonly includedFiles: ReadonlyArray<{ path: string; offset: number; line: number; command: string }>;
  readonly sectioning: ReadonlyArray<{ level: number; title: string; offset: number; line: number }>;
}

export const EMPTY_ANALYSIS: DocumentAnalysis = {
  outline: [],
  labels: [],
  citations: [],
  macroDefinitions: [],
  environments: [],
  includedFiles: [],
  sectioning: []
};

export interface DocumentAnalyzer {
  readonly id: string;
  analyze(text: string, uri: string): DocumentAnalysis;
}

export interface DocumentSnapshot {
  readonly content: string;
  readonly source: EditSource;
  readonly timestamp: number;
}

const MAX_HISTORY = 500;

/**
 * The most document history a buffer keeps, in characters of undo snapshots.
 *
 * `MAX_HISTORY` bounds the number of *steps*, and a step is a whole document: a
 * snapshot is an immutable string, so every entry keeps the entire text it was
 * taken from alive. Five hundred is the right depth for a page of LaTeX and the
 * wrong one for a large chapter — five hundred edits in a one-megabyte document
 * pins up to half a gigabyte of live text, which every later allocation pays for
 * out of a heap that size, and it is the difference between a large file that
 * scrolls and one that stutters. A character budget makes the depth proportional
 * to the document instead: a small file still gets its five hundred steps, a large
 * one gets as many as fit. One step is always retained, so undo never disappears
 * entirely — the cap can only make the history shallower, never unavailable.
 */
const MAX_HISTORY_CHARS = 32 * 1024 * 1024;

/**
 * How long the buffer waits after the last change before re-analyzing.
 *
 * The analysis is a whole-document unified-latex parse — `parseLatexWithArguments`
 * measured at 94.8 ms for a 746-line document, 29.2 ms for a 220-line one — so
 * running it inside `commit()` put that parse on the keystroke's own task. That
 * blocks the paint (Instructions.md §60/§62: parsing and indexing must not block
 * typing) *and* everything the keystroke schedules after itself: a snippet
 * expansion is dispatched from a microtask, a microtask cannot run until the
 * task that queued it has finished, so the expansion could only appear after the
 * parse. Measured on a 746-line document with the real analyzer: the trigger
 * keystroke reached the expansion at 155.6 ms and left the main thread free at
 * 339 ms (the parse ran twice, once for the keystroke and once for the
 * expansion); deferred, both are 9.6 ms.
 *
 * The delay is a settle window rather than a queue: a burst of typing re-arms
 * it and costs one parse, and by the time it fires the change is long painted.
 * `flushAnalysis()` runs the pass immediately for a caller that cannot wait.
 */
export const ANALYSIS_SETTLE_MS = 120;

export function languageIdFor(fileName: string): string {
  if (/\.bib$/i.test(fileName)) return 'bibtex';
  if (/\.sty$|\.cls$/i.test(fileName)) return 'latex';
  if (/\.log$/i.test(fileName)) return 'log';
  if (/\.(md|markdown|mdown|mkdn)$/i.test(fileName)) return 'markdown';
  if (/\.json$/i.test(fileName)) return 'json';
  if (/\.(js|mjs|cjs|jsx)$/i.test(fileName)) return 'javascript';
  if (/\.(ts|tsx)$/i.test(fileName)) return 'typescript';
  return 'latex';
}

export class DocumentModel extends EventEmitter {
  public readonly uri: string;
  public filename: string;
  public readonly languageId: string;

  private content: string;
  private savedContent: string;
  private version = 1;
  private analysis: DocumentAnalysis = EMPTY_ANALYSIS;
  private analyzer: DocumentAnalyzer | null = null;
  /**
   * The text `analysis` was computed from, so a pending pass can tell whether it
   * is still needed and a reader can tell whether it is looking at old data.
   */
  private analyzedContent: string | null = null;
  /** The coalesced re-analysis, while one is armed. */
  private analysisTimer: ReturnType<typeof setTimeout> | null = null;

  private undoStack: DocumentSnapshot[] = [];
  private redoStack: DocumentSnapshot[] = [];
  /**
   * The characters `undoStack` retains, kept in step with every push and pop.
   *
   * Only the undo stack is counted, and that is enough: the redo stack can never
   * hold more snapshots than were undone out of the undo stack, and every new edit
   * clears it, so the pair stays within twice the budget rather than growing.
   */
  private historyChars = 0;
  private lastEditSource: EditSource | null = null;
  /** Set while applying an external change that must not enter undo history. */
  private suppressUndo = false;

  constructor(uri: string, filename: string, initialContent = '', languageId?: string) {
    super();
    this.uri = uri;
    this.filename = filename;
    const normalized = initialContent.replace(/\r\n/g, '\n');
    this.content = normalized;
    this.savedContent = normalized;
    this.languageId = languageId ?? languageIdFor(filename);
  }

  // ------------------------------------------------------------------ access

  public getText(): string {
    return this.content;
  }

  public getLength(): number {
    return this.content.length;
  }

  public getVersion(): number {
    return this.version;
  }

  public getDirty(): boolean {
    return this.content !== this.savedContent;
  }

  /**
   * The most recent completed analysis.
   *
   * Reading never starts a parse: the shell re-reads the outline, the labels and
   * the environments from its `change` listener, which runs *inside* the edit,
   * so a forcing read here would put the whole-document parse straight back onto
   * the keystroke path this class exists to keep clear. The value is at most one
   * settle window old, and `analysis-change` announces the newer one — a reader
   * that must have the current text analysed can call `flushAnalysis()`.
   */
  public getAnalysis(): DocumentAnalysis {
    return this.analysis;
  }

  public getOutline(): OutlineItem[] {
    return this.analysis.outline;
  }

  /** True while the analysis on hand does not describe the current text. */
  public isAnalysisStale(): boolean {
    return this.analyzedContent !== this.content;
  }

  /**
   * Analyses the current text now and returns it, cancelling a pending pass.
   *
   * Deliberately not called from any reader: it is the escape hatch for callers
   * that need a current answer on their own schedule (a save, a project-wide
   * build, a test), not for the per-keystroke path. Nothing is re-parsed when the
   * analysis on hand already describes the text.
   */
  public flushAnalysis(): DocumentAnalysis {
    this.cancelPendingAnalysis();
    if (this.isAnalysisStale()) this.runAnalysis();
    return this.analysis;
  }

  public setAnalyzer(analyzer: DocumentAnalyzer | null): void {
    if (this.languageId !== 'latex') return;
    this.analyzer = analyzer;
    this.cancelPendingAnalysis();
    // Registering an analyzer is not a keystroke: the first answer is produced
    // synchronously so a document is never registered with an empty analysis.
    this.runAnalysis();
  }

  public getAnalyzerId(): string | null {
    return this.analyzer?.id ?? null;
  }

  /**
   * Releases the buffer: drops listeners and cancels an armed analysis pass, so
   * a document closed mid-settle is not parsed one more time after its editors
   * and panels have gone.
   */
  public dispose(): void {
    this.cancelPendingAnalysis();
    this.clear();
  }

  // ------------------------------------------------------------------ edits

  /**
   * Applies a batch of non-overlapping deltas. Deltas are sorted and applied
   * back-to-front so the offsets in the caller's coordinate space stay valid.
   */
  public applyDeltas(deltas: readonly TextDelta[], source: EditSource = 'code'): void {
    if (deltas.length === 0) return;

    const ordered = [...deltas].sort((a, b) => a.from - b.from);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].from < ordered[i - 1].to) {
        throw new Error(
          `DocumentModel.applyDeltas: overlapping deltas at ${ordered[i - 1].from}-${ordered[i - 1].to} and ${ordered[i].from}-${ordered[i].to}`
        );
      }
    }

    let next = this.content;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const delta = ordered[i];
      if (delta.from < 0 || delta.to > next.length || delta.from > delta.to) {
        throw new Error(
          `DocumentModel.applyDeltas: delta out of range [${delta.from}, ${delta.to}) for length ${next.length}`
        );
      }
      const insert = delta.insert.replace(/\r\n/g, '\n');
      next = next.slice(0, delta.from) + insert + next.slice(delta.to);
    }

    this.commit(next, source, ordered);
  }

  /** Convenience wrapper for a single delta. */
  public replaceRange(from: number, to: number, insert: string, source: EditSource = 'code'): void {
    this.applyDeltas([{ from, to, insert }], source);
  }

  /** Whole-text replacement. Used for disk reloads and formatting. */
  public setText(newContent: string, source: EditSource = 'code'): void {
    const normalized = newContent.replace(/\r\n/g, '\n');
    if (normalized === this.content) return;
    this.commit(normalized, source, []);
  }

  /** Marks the buffer as matching what is on disk without changing the content. */
  public markClean(): void {
    if (this.content === this.savedContent) return;
    this.savedContent = this.content;
    this.emit('dirty-change', false);
    this.emit('saved', this.content);
  }

  /** Records that the buffer was written, optionally with the bytes actually written. */
  public markSaved(writtenContent = this.content): void {
    const normalized = writtenContent.replace(/\r\n/g, '\n');
    this.savedContent = normalized;
    this.emit('dirty-change', false);
    this.emit('saved', normalized);
  }

  /**
   * Reloads from disk. Unsaved work is never silently discarded: the caller is
   * expected to check `getDirty()` first, so this method assumes the buffer is
   * clean and therefore does not add an undo entry (there is no user edit to
   * undo, and undoing into a pre-reload state would write stale text back).
   */
  public reloadFromDisk(diskContent: string): void {
    const normalized = diskContent.replace(/\r\n/g, '\n');
    this.suppressUndo = true;
    try {
      this.applyDeltas([{ from: 0, to: this.content.length, insert: normalized }], 'disk');
    } finally {
      this.suppressUndo = false;
    }
    this.undoStack = [];
    this.redoStack = [];
    this.historyChars = 0;
    this.savedContent = normalized;
    this.emit('dirty-change', false);
    this.emit('reloaded', normalized);
  }

  // ------------------------------------------------------------ undo / redo

  public undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.historyChars -= previous.content.length;
    this.redoStack.push({ content: this.content, source: previous.source, timestamp: Date.now() });
    this.lastEditSource = 'undo';
    this.commit(previous.content, 'undo', []);
    this.lastEditSource = null;
    return true;
  }

  public redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push({ content: this.content, source: next.source, timestamp: Date.now() });
    this.historyChars += this.content.length;
    this.trimHistory();
    this.lastEditSource = 'redo';
    this.commit(next.content, 'redo', []);
    this.lastEditSource = null;
    return true;
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.historyChars = 0;
  }

  // --------------------------------------------------------------- internals

  /**
   * Drops the oldest snapshots until the history fits both budgets.
   *
   * Called wherever the undo stack grows rather than only on an edit: a redo
   * pushes one too, and a step that is too large to keep is dropped by the same
   * rule as the five-hundredth. The loop stops at one entry, so the most recent
   * step — the one undo is actually for — is never the one discarded.
   */
  private trimHistory(): void {
    while (
      this.undoStack.length > 1 &&
      (this.undoStack.length > MAX_HISTORY || this.historyChars > MAX_HISTORY_CHARS)
    ) {
      const dropped = this.undoStack.shift();
      if (dropped) this.historyChars -= dropped.content.length;
    }
  }

  private commit(nextContent: string, source: EditSource, deltas: readonly TextDelta[]): void {
    if (nextContent === this.content) return;

    if (!this.suppressUndo && this.lastEditSource === null && source !== 'undo' && source !== 'redo') {
      this.undoStack.push({ content: this.content, source, timestamp: Date.now() });
      this.historyChars += this.content.length;
      this.trimHistory();
      this.redoStack = [];
    }

    const wasDirty = this.getDirty();
    this.content = nextContent;
    this.version++;
    this.reanalyze();

    this.emit('change', {
      content: this.content,
      source,
      version: this.version,
      deltas,
      clean: !this.getDirty()
    } satisfies DocumentChangeEvent);

    const isDirty = this.getDirty();
    if (isDirty !== wasDirty) this.emit('dirty-change', isDirty);
  }

  private reanalyze(): void {
    if (!this.analyzer) {
      this.analysis = EMPTY_ANALYSIS;
      this.analyzedContent = this.content;
      return;
    }
    this.scheduleAnalysis();
  }

  /**
   * Arms one coalesced pass: every change inside the settle window shares it.
   *
   * The pass reads `this.content` when it *runs*, never a snapshot taken when it
   * was armed, so a pass can only ever describe the latest text — a stale result
   * cannot overwrite a newer buffer (Instructions.md §61). If the text moves on
   * again while the pass is running (a listener reacting to `analysis-change`,
   * say), the pass re-arms instead of leaving the analysis behind.
   */
  private scheduleAnalysis(): void {
    if (this.analysisTimer !== null) {
      clearTimeout(this.analysisTimer);
    }
    /*
     * A large document waits for a pause instead of 120 ms of quiet.
     *
     * The pass is a full `parseLatexWithArguments` of the whole buffer, and on a
     * large document it costs more than the gap between two keystrokes: measured at
     * ~274 ms for a 13 KB / 425-line `macros.tex`, of which only 50 ms is the parse
     * itself. VS Code keeps language features on a large file — it moves them to
     * another process rather than dropping them — so the analysis is not disabled
     * here, only moved to the moment the reader stops. Indexing a large chapter's
     * labels late is a smaller price than making every keystroke wait for them.
     */
    const settleMs = largeDocumentProfile(
      { length: this.content.length, lines: lineCount(this.content) },
      {
        enabled: setting.bool('editor.largeFileOptimizations'),
        analysisSettleMs: ANALYSIS_SETTLE_MS
      }
    ).analysisSettleMs;
    this.analysisTimer = setTimeout(() => {
      this.analysisTimer = null;
      this.runAnalysis();
      if (this.isAnalysisStale()) this.scheduleAnalysis();
    }, settleMs);
  }

  private cancelPendingAnalysis(): void {
    if (this.analysisTimer === null) return;
    clearTimeout(this.analysisTimer);
    this.analysisTimer = null;
  }

  /** One pass over the current text. Synchronous; the analyzer contract is. */
  private runAnalysis(): void {
    if (!this.analyzer) {
      this.analysis = EMPTY_ANALYSIS;
      this.analyzedContent = this.content;
      return;
    }
    const analyzer = this.analyzer;
    const content = this.content;
    try {
      this.analysis = analyzer.analyze(content, this.uri);
      this.analyzedContent = content;
    } catch (err) {
      console.error(`[eukolia] analyzer "${analyzer.id}" failed`, err);
      this.analysis = EMPTY_ANALYSIS;
      this.analyzedContent = content;
    }
    this.emit('analysis-change', this.analysis);
  }
}
