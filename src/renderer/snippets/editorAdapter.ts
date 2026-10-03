/**
 * Eukolia Snippet Engine — editor adapter.
 *
 * This is the counterpart of the reference's `extension.ts` VS Code wiring: the
 * `editor.action.insertSnippet` round-trip, the `onDidChangeTextDocument`
 * automatic-expansion path, the `insertingSnippet` re-entrancy guard, the
 * `hsnips.*` command set and the snippet stack lifecycle.
 *
 * The reference drove all of that through the `vscode` namespace. Eukolia owns
 * its editor, so this adapter takes an explicit, small editor port instead and
 * returns the resulting text/cursor for the editor host to apply.
 *
 * Ported from References/hypersnips/src/extension.ts (MIT, (c) 2019 Ian Ornelas).
 * Modified for Eukolia.
 */

import * as vscode from 'vscode';
import { COMPLETIONS_TRIGGERS, type SnippetExpansion } from '../vendor/hypersnips';
import {
  SnippetEngine,
  getSnippetEngine,
  offsetFromPosition,
  positionFromOffset,
  type AutomaticExpansionResult,
  type PlaceholderLocation,
  type SnippetDocumentChange,
  type SnippetExpansionCandidate
} from './engine';
import type { DocumentLike } from './documentAdapter';
/**
 * The editor port. Deliberately tiny: a snippet adapter only needs the text, a
 * way to read the current selection, and a way to write text back.
 */
export interface SnippetEditorPort {
  /** Current full text of the buffer. */
  getText(): string;
  /** Document identity used for language filtering and `path` in code blocks. */
  languageId: string;
  uri?: { toString(): string; fsPath?: string; path?: string };
  /** Selection as offsets, used for `${VISUAL}` and stack trimming. */
  getSelection?(): { from: number; to: number } | undefined;
  /**
   * Replace `[from, to)` with `text` and place the cursor at `cursor`.
   * Implementations must apply synchronously so the adapter's offsets stay exact.
   */
  replace(from: number, to: number, text: string, cursor: number): void;
  /** Put the cursor / selection at `[from, to)`. */
  select?(from: number, to: number): void;
}

export interface SnippetAdapterOptions {
  engine?: SnippetEngine;
  /** Called when the adapter rejects or cannot complete an operation. */
  onWarning?(message: string): void;
  /** Extra completion trigger characters; defaults to the reference's list. */
  triggerCharacters?: readonly string[];
}

  /** What the editor has to do after `acceptCompletion` / `handleDocumentChange`. */
export interface AppliedExpansion {
  /** Text produced by the expansion (placeholder markup removed). */
  text: string;
  /** Span of `text` in the document *after* the edit. */
  from: number;
  to: number;
  /** Tab stop the expansion starts on, in post-edit offsets. */
  selected: PlaceholderLocation[];
  /** The live instance, for tab-stop navigation. */
  expansion: SnippetExpansion;
}

export interface TabStopMove {
  expansion: SnippetExpansion;
  from: number;
  to: number;
  id: number | undefined;
}

export class SnippetEditorAdapter {
  readonly engine: SnippetEngine;
  private readonly options: SnippetAdapterOptions;
  /** Reference `insertingSnippet`: suppresses auto-expansion for our own edits. */
  private insertingSnippet = false;
  private lastSelection: { text: string; timestamp: number } | undefined;
  /**
   * How far an expansion's origin moved when it was placed into the buffer.
   * The ported instance lays its parts out at the reference's insertion point
   * (the start of the replaced trigger), so deleting the trigger shifts every
   * part by the net edit delta.
   */
  private readonly anchorDeltas = new WeakMap<SnippetExpansion, number>();

  constructor(options: SnippetAdapterOptions = {}) {
    this.options = options;
    this.engine = options.engine ?? getSnippetEngine();
    this.engine.setWarningSink((message) => this.warn(message));
    this.engine.setSelectionProvider(() => this.lastSelection);
  }

  /** Reference `COMPLETIONS_TRIGGERS`, for registering the provider. */
  static get completionTriggerCharacters(): readonly string[] {
    return COMPLETIONS_TRIGGERS;
  }

  get triggerCharacters(): readonly string[] {
    return this.options.triggerCharacters ?? COMPLETIONS_TRIGGERS;
  }

  /** Reference `registerCompletionItemProvider`: completion candidates. */
  getCompletions(
    editor: SnippetEditorPort,
    offset: number,
    triggerCharacter?: string
  ): vscode.CompletionItem[] {
    return this.getCompletionCandidates(editor, offset, triggerCharacter).map((candidate) =>
      this.engine.toCompletionItem(candidate)
    );
  }

  /** The raw candidates, for hosts that render their own completion UI. */
  getCompletionCandidates(
    editor: SnippetEditorPort,
    offset: number,
    triggerCharacter?: string
  ): SnippetExpansionCandidate[] {
    const text = editor.getText();
    return this.engine.getCompletions({
      text,
      offset,
      languageId: editor.languageId,
      triggerCharacter,
      doc: this.documentFor(editor, text)
    });
  }

  /**
   * Reference `expandSnippet`: delete the matched range and insert the snippet,
   * then report the tab stops so the host can select the first one.
   */
  acceptCompletion(
    candidate: SnippetExpansionCandidate,
    editor: SnippetEditorPort,
    snippetExpansion = true
  ): AppliedExpansion {
    const textBefore = editor.getText();
    const doc = this.documentFor(editor, textBefore);
    const from = offsetFromPosition(textBefore, candidate.range.start);
    const to = snippetExpansion
      ? offsetFromPosition(textBefore, candidate.range.end)
      : Math.min(textBefore.length, from + candidate.label.length);

    const expansion = this.engine.expand(candidate, { doc, text: textBefore });
    return this.apply(expansion, editor, textBefore, from, to);
  }

  /**
   * Reference `onDidChangeTextDocument`: automatic (`A` flag) expansion.
   *
   * Returns the applied expansion when a snippet fired, otherwise `null`.
   */
  handleDocumentChange(
    editor: SnippetEditorPort,
    change: SnippetDocumentChange
  ): AppliedExpansion | null {
    if (this.insertingSnippet) return null;

    const textBefore = editor.getText();
    // The candidate ranges are computed against the post-change text, but the
    // expansion has to be laid out against the buffer as it is *now* (before the
    // snippet replaces the trigger). Passing the live text keeps the ported
    // `applyOffset` arithmetic anchored to the right buffer.
    //
    // `documentFor` reads through to the editor, so the post-change text is only
    // named here to keep the two in step for a host that supplies it separately.
    const result: AutomaticExpansionResult | null = this.engine.tryAutomaticExpansion(
      change,
      editor.languageId,
      this.documentFor(editor, change.textAfter ?? textBefore),
      textBefore
    );
    if (!result) return null;

    const from = result.insertOffset;
    const to = offsetFromPosition(textBefore, result.range.end);
    return this.apply(result.expansion, editor, textBefore, from, to);
  }

  /** Reference `hsnips.nextPlaceholder` / `jumpToNextSnippetPlaceholder`. */
  nextTabStop(editor: SnippetEditorPort): TabStopMove | null {
    const current = this.engine.activeExpansion;
    const move = this.moveTo(this.engine.nextTabStop(), editor);
    if (move) return move;
    // The instance was popped (the reference's `nextPlaceholder()` returned
    // `false` for `$0`); the cursor still has to land on the final tab stop.
    return current ? this.finalCursor(current, editor) : null;
  }

  /** Reference `hsnips.prevPlaceholder` / `jumpToPrevSnippetPlaceholder`. */
  previousTabStop(editor: SnippetEditorPort): TabStopMove | null {
    return this.moveTo(this.engine.previousTabStop(), editor);
  }

  /** Cursor position for an expansion's final `$0` tab stop. */
  private finalCursor(expansion: SnippetExpansion, editor: SnippetEditorPort): TabStopMove | null {
    const geometry = this.geometry(expansion);
    // The instance's `selectedPlaceholder` is already `0` at this point (that is
    // why the expansion was popped), so the final tab stop is looked up directly.
    const target = geometry.placeholders.find((p) => p.id === 0);
    if (target) {
      if (editor.select) editor.select(target.documentFrom, target.documentTo);
      return { expansion, from: target.documentFrom, to: target.documentTo, id: target.id };
    }
    // Standard snippet semantics: when no explicit $0 is written, the final
    // cursor position is at the end of the expansion.
    if (editor.select) editor.select(geometry.to, geometry.to);
    return { expansion, from: geometry.to, to: geometry.to, id: 0 };
  }

  /** Reference `hsnips.leaveSnippet`. */
  leaveSnippet(): void {
    this.engine.clearStack();
  }

  /** Reference `onDidChangeTextEditorSelection`: record `${VISUAL}` + trim stack. */
  handleSelectionChange(editor: SnippetEditorPort, selection?: { from: number; to: number }): void {
    const range = selection ?? editor.getSelection?.();
    if (!range) return;

    if (range.to > range.from) {
      const selected = editor.getText().slice(range.from, range.to);
      if (selected) {
        // Verbatim: the instance no longer escapes the selection on its way in,
        // and an escape applied only here would reach the document unchanged —
        // see the note in `hsnippetInstance`.
        this.lastSelection = { text: selected, timestamp: Date.now() };
      }
    }

    const text = editor.getText();
    this.engine.trimStackForSelection(
      new vscode.Range(positionFromOffset(text, range.from), positionFromOffset(text, range.to))
    );
  }

  /** Reference `onDidChangeTextDocument` forwarding to the top instance. */
  notifyContentChange(changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
    this.engine.updateActiveExpansion(changes);
  }

  /**
   * Reference `onDidChangeTextDocument` for edits the host made itself (typing
   * into a tab stop, paste, delete). Translates the active expansion's ranges by
   * the edit and lets the ported instance re-run its code blocks.
   *
   * This is the counterpart of {@link handleDocumentChange}, which exists for the
   * `A`-flag path; it deliberately does not attempt automatic expansion.
   */
  handleEdit(
    editor: SnippetEditorPort,
    change: { range: { start: vscode.Position; end: vscode.Position }; text: string; textAfter: string }
  ): void {
    const top = this.engine.activeExpansion;
    if (!top) return;

    const textBefore = editor.getText();
    const from = offsetFromPosition(textBefore, change.range.start);
    // Both range endpoints are pre-edit coordinates, so the replaced length has to
    // be derived from the range itself rather than measured in the new text.
    const to = from + (change.range.end.character - change.range.start.character);

    // Intercept the ported instance's block writes so they land in the real
    // buffer. `SnippetExpansion.update()` re-runs the generator and pushes the
    // new code-block text through `editor.edit(...)`.
    const writes: Array<{ offset: number; length: number; text: string }> = [];
    top.editor = {
      document: top.document,
      edit: (callback) => {
        callback({
          replace: (range, value) =>
            writes.push({
              offset: offsetFromPosition(change.textAfter, range.start),
              length: range.end.character - range.start.character,
              text: value
            }),
          insert: (position, value) =>
            writes.push({ offset: offsetFromPosition(change.textAfter, position), length: 0, text: value }),
          delete: () => undefined
        });
        return true;
      }
    };

    this.insertingSnippet = true;
    try {
      // The instance must do its own translating, because `getRangeDelta` uses
      // the enclosing `update()` call to pick up the placeholder's new text:
      // `applyDocumentMovement` runs the change with `GrowthType.Grow` first.
      //
      // The expansion's own start is handed over with it: the ported ranges do
      // not reliably track a placeholder that was filled, so the tab stops are
      // maintained in the expansion's own coordinates, and that needs to know
      // where the expansion begins in the document the change is expressed in.
      movement(top, textBefore, from, to, change.text, offsetFromPosition(textBefore, top.range.range.start));
      this.engine.setExpansionDocumentText(top, change.textAfter);
    } finally {
      this.insertingSnippet = false;
      top.editor = undefined;
    }

    // Apply code-block updates from the end backwards so earlier offsets stay valid.
    writes
      .slice()
      .sort((a, b) => b.offset - a.offset)
      .forEach((write) =>
        editor.replace(write.offset, write.offset + write.length, write.text, write.offset + write.text.length)
      );
  }

  /** Geometry of an applied expansion, in current document offsets. */
  geometry(expansion: SnippetExpansion): {
    text: string;
    from: number;
    to: number;
    selected: PlaceholderLocation[];
    placeholders: PlaceholderLocation[];
  } {
    return this.engine.getGeometry(expansion, this.anchorDeltas.get(expansion) ?? 0);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Apply an expansion: write the text, record how far the expansion origin
   * moved, then hand the edit to the ported `DynamicRange.update` machinery
   * (exactly what the reference did in `onDidChangeTextDocument`).
   */
  private apply(
    expansion: SnippetExpansion,
    editor: SnippetEditorPort,
    textBefore: string,
    from: number,
    to: number
  ): AppliedExpansion {
    const inserted = expansion.plainText;
    const toAfter = from + inserted.length;

    this.insertingSnippet = true;
    try {
      const after = textBefore.slice(0, from) + inserted + textBefore.slice(to);
      // The instance anchored its parts at `from`, which is exactly where the
      // snippet text lands, so no origin shift is needed here. `update()` is for
      // edits made *inside* an already-placed expansion (see geometry()).
      this.anchorDeltas.set(expansion, 0);
      this.engine.setExpansionDocumentText(expansion, after);
      editor.replace(from, to, inserted, toAfter);
      this.rememberSelection(editor, after);
      return {
        text: inserted,
        from,
        to: toAfter,
        selected: this.geometry(expansion).selected,
        expansion
      };
    } finally {
      this.insertingSnippet = false;
    }
  }


  private moveTo(expansion: SnippetExpansion | null, editor: SnippetEditorPort): TabStopMove | null {
    if (!expansion) return null;
    const geometry = this.geometry(expansion);
    const target = geometry.selected[0];
    if (!target) return null;
    if (editor.select) editor.select(target.documentFrom, target.documentTo);
    return { expansion, from: target.documentFrom, to: target.documentTo, id: target.id };
  }

  /**
   * A live view of the edited document for the ported engine.
   *
   * It must read *through* to `editor.getText()` rather than snapshotting, because
   * `SnippetExpansion` re-reads placeholder text from the document whenever it
   * regenerates a code block (that is how a `box`-style snippet's borders follow
   * what you type into `$1`).
   */
  private documentFor(editor: SnippetEditorPort, _text: string): DocumentLike {
    const read = () => editor.getText();
    const doc: DocumentLike = {
      languageId: editor.languageId,
      uri: editor.uri,
      getText: (range?: vscode.Range) => {
        const current = read();
        if (!range) return current;
        return current.slice(offsetFromPosition(current, range.start), offsetFromPosition(current, range.end));
      },
      offsetAt: (position: vscode.Position) => offsetFromPosition(read(), position),
      positionAt: (offset: number) => positionFromOffset(read(), offset),
      lineAt: (line: number | vscode.Position) => {
        const lineNumber = typeof line === 'number' ? line : line.line;
        const content = read().split(/\r\n|\r|\n/)[lineNumber] ?? '';
        return {
          text: content,
          firstNonWhitespaceCharacterIndex: content.length - content.replace(/^\s+/, '').length
        };
      }
    };
    return doc;
  }

  private rememberSelection(editor: SnippetEditorPort, textAfter: string): void {
    this.lastSelection = undefined;
    const range = editor.getSelection?.();
    if (!range) return;
    if (range.to > range.from) {
      const selected = textAfter.slice(range.from, range.to);
      if (selected) {
        // Verbatim, as in `handleSelectionChange`.
        this.lastSelection = { text: selected, timestamp: Date.now() };
      }
    }
  }

  private warn(message: string): void {
    if (this.options.onWarning) this.options.onWarning(message);
    else console.warn(message);
  }
}

/**
 * Reference `update(changes)`: translate the instance's ranges by the net effect
 * of an edit. `SnippetExpansion.update` consumes
 * `TextDocumentContentChangeEvent`-shaped objects, so an edit is expressed in
 * exactly that form. Used for edits that happen *after* an expansion is placed.
 */
function movement(
  expansion: SnippetExpansion,
  textBefore: string,
  from: number,
  to: number,
  inserted: string,
  origin?: number
): void {
  const change: vscode.TextDocumentContentChangeEvent = {
    range: new vscode.Range(positionFromOffset(textBefore, from), positionFromOffset(textBefore, to)),
    rangeOffset: from,
    rangeLength: to - from,
    text: inserted
  };
  expansion.update([change], origin);
}

export { movement as applyDocumentMovement };
