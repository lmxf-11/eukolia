/**
 * Eukolia — the imperative editor contract.
 *
 * Eukolia drives its editing surface imperatively from outside React. The
 * handle published on `AppState.editorHandleRef` is what the application shell,
 * the breadcrumbs, SyncTeX, the command registry and the VS Code host bridge
 * reach the editor through, so the application never renders it directly.
 *
 * The contract is deliberately **engine-neutral**: it is written in the terms
 * every editor can answer — character offsets into the document, 1-based lines
 * and columns, a pixel scroll offset — so the application never has to know which
 * engine is behind it. One host implements it, the CodeMirror editor in
 * `src/renderer/visual/VisualEditor.tsx`, in both of its modes; `TEditor` is the
 * engine's own editor type and the only member that names one.
 *
 * Conventions, relied on by every caller:
 *
 *  * **Offsets** are raw character offsets into the document (`state.doc`),
 *    never line/column pairs. They are clamped into the document, never
 *    rejected: a stale offset after an edit must land somewhere sensible
 *    instead of throwing.
 *  * **Lines and columns** are 1-based, the way the status bar shows them.
 *  * **`anchor`/`head`** are the two ends of the selection, named the way
 *    CodeMirror names them: `head` is the end the caret is at (the moving end),
 *    `anchor` is the end that stayed put. `from`/`to` are those two ends in
 *    document order, so `from <= to` always holds.
 */

import type { InsertionPlan, PlannedCaret } from '../mathSymbols/types';

/**
 * The imperative editor surface.
 *
 * @typeParam TEditor the engine's own editor instance type — CodeMirror's
 *   `EditorView`, Monaco's `IStandaloneCodeEditor`. It defaults to `unknown` so
 *   a consumer that only needs the behaviour below can hold an `EditorHandle`
 *   without naming an engine at all.
 */
export interface EditorHandle<TEditor = unknown> {
  /**
   * The live editor instance behind the handle.
   *
   * Nothing in Eukolia consumes this: every behaviour the application needs is
   * a method below, which is what keeps this type engine-neutral. It exists so
   * a probe, an end-to-end test or the debug console can reach the real editor
   * without the handle having to grow a method per question.
   */
  getEditor(): TEditor | null;
  /** Jumps to a 1-based line/column, scrolls it into view and focuses the editor. */
  revealPosition(line: number, column?: number): void;
  /** Jumps to a character offset, scrolls it into view and focuses the editor. */
  revealOffset(offset: number): void;
  /** Returns the current selection as character offsets, or null when unmounted. */
  getSelectionOffsets(): {
    from: number;
    to: number;
    anchor: number;
    head: number;
  } | null;
  /** Restores a selection expressed in character offsets. */
  setSelectionOffsets(from: number, to: number): void;
  /** Current scroll offset, in pixels. */
  getScrollTop(): number;
  setScrollTop(value: number): void;
  /**
   * Applies Eukolia's ampersand aligner to the whole document, or to the
   * selection when `scope` is `'selection'` and the selection is not empty.
   */
  alignAmpersands(scope?: 'document' | 'selection'): void;
  /** Inserts text at the caret, replacing the selection. */
  insertText(text: string): void;
  /** Wraps the selection (or inserts a template when empty). */
  wrapSelection(prefix: string, suffix?: string, placeholder?: string): void;
  /**
   * Applies a planned Mathematical Symbols insertion as one transaction.
   *
   * This is the single typed insertion operation the Mathematical Symbols panel
   * uses, and it exists on the *handle* rather than as an event because of what
   * the alternative costs: an event is a broadcast with no target, so every
   * mounted editor would answer it and none of them would know whether it was
   * the active one. The plan carries the whole decision — the exact text, the
   * wrapper, the slot placements, the caret — so this method does nothing but
   * write it, in one transaction, with the insertion user-event annotation and
   * its own undo boundary.
   *
   * Returns the caret and slot placements that resulted, or `null` when the
   * editor is not mounted. A plan is built against a pre-transaction snapshot and
   * is refused as a whole when any part of it does not apply, so a non-null
   * return means the document was changed exactly as planned.
   */
  applyMathInsertion(plan: InsertionPlan): {
    carets: readonly PlannedCaret[];
  } | null;
  /** Current caret offset, or null when the editor is not mounted. */
  getCursorOffset(): number | null;
  focus(): void;
}
