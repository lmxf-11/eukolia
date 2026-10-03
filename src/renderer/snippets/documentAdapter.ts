/**
 * Eukolia Snippet Engine — document adapters.
 *
 * `vendor/hypersnips` talks to a deliberately small structural seam
 * (`TextDocumentLike` / `SnippetEditorLike`) so the engine never needs the VS
 * Code compatibility host at runtime. These adapters connect that seam to
 * Eukolia buffers (an `@codemirror`-style `{ getText, offsetAt, positionAt,
 * lineAt, languageId, uri }` or the shim's `ShimTextDocument`).
 */

import * as vscode from 'vscode';
import { offsetAt, positionAt } from '../vendor/vscode-shim/position';
import type { SnippetEditBuilder, SnippetEditorLike, TextDocumentLike } from '../vendor/hypersnips/hsnippetInstance';

/** Anything that can act as the text source for snippet decisions. */
export interface DocumentLike {
  getText(range?: vscode.Range): string;
  offsetAt?(position: vscode.Position): number;
  positionAt?(offset: number): vscode.Position;
  /** Monaco model shapes, accepted so a model-like buffer still adapts. */
  getOffsetAt?(position: vscode.Position): number;
  getPositionAt?(offset: number): vscode.Position;
  lineAt?(line: number | vscode.Position): { text: string; firstNonWhitespaceCharacterIndex?: number };
  getLineContent?(line: number): string;
  lineCount?: number;
  languageId?: string;
  uri?: { toString(): string; fsPath?: string; path?: string };
  fileName?: string;
  /** Whether the given offset sits in mathematics (supplied by AST/editor when available). */
  isMathAt?(offset: number): boolean;
}

/** Anything that can apply a textual replacement, e.g. a Monaco model edit. */
export interface EditTargetLike {
  /** Preferred: apply a plain-text replacement. */
  pushEditOperations?(
    selections: unknown,
    edits: Array<{ range: unknown; text: string }>,
    cursorStateComputer: unknown
  ): unknown;
  /** Alternative: an editor-style `edit(callback)` surface. */
  edit?(callback: (builder: SnippetEditBuilder) => void): Promise<boolean> | boolean;
}

/**
 * Adapts a `DocumentLike` to the ported engine's `TextDocumentLike`.
 */
export function createTextDocumentAdapter(doc: DocumentLike): TextDocumentLike & {
  offsetAt(position: vscode.Position): number;
  positionAt(offset: number): vscode.Position;
  getWordRangeAtPosition(position: vscode.Position): vscode.Range | undefined;
} {
  return {
    get lineCount(): number | undefined {
      return doc.lineCount;
    },
    get uri(): { toString(): string } | undefined {
      return doc.uri;
    },
    getText(range?: vscode.Range): string {
      return doc.getText(range);
    },
    lineAt(line: number | vscode.Position) {
      const lineNumber = typeof line === 'number' ? line : line.line;
      const explicit = typeof doc.lineAt === 'function' ? safeLineAt(doc, lineNumber) : undefined;
      const text = explicit?.text ?? lineText(doc, lineNumber);
      return {
        text,
        firstNonWhitespaceCharacterIndex:
          explicit?.firstNonWhitespaceCharacterIndex ?? (text.length - text.replace(/^\s+/, '').length)
      };
    },
    offsetAt(position: vscode.Position): number {
      if (typeof doc.offsetAt === 'function') return doc.offsetAt(position);
      if (typeof doc.getOffsetAt === 'function') return doc.getOffsetAt(position);
      return offsetAt(doc.getText(), position);
    },
    positionAt(offset: number): vscode.Position {
      if (typeof doc.positionAt === 'function') return doc.positionAt(offset);
      if (typeof doc.getPositionAt === 'function') return doc.getPositionAt(offset);
      return positionAt(doc.getText(), offset);
    },
    getWordRangeAtPosition(position: vscode.Position): vscode.Range | undefined {
      const text = lineText(doc, position.line);
      const regex = /[A-Za-z0-9_]+/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        if (match.index <= position.character && match.index + match[0].length >= position.character) {
          return new vscode.Range(position.line, match.index, position.line, match.index + match[0].length);
        }
        if (match.index > position.character) break;
      }
      return undefined;
    }
  };
}

function lineText(doc: DocumentLike, line: number): string {
  if (typeof doc.getLineContent === 'function') return doc.getLineContent(line);
  try {
    return doc.getText(new vscode.Range(line, 0, line + 1, 0)).replace(/\r?\n$/, '');
  } catch {
    return '';
  }
}

function safeLineAt(
  doc: DocumentLike,
  line: number
): { text: string; firstNonWhitespaceCharacterIndex?: number } | undefined {
  try {
    return doc.lineAt!(line);
  } catch {
    return undefined;
  }
}

/**
 * Adapts an editor-ish object to the ported engine's `SnippetEditorLike`.
 * Returns `undefined` when the target cannot apply edits, in which case the
 * engine still computes the expansion (useful for previews and tests).
 */
export function createEditorAdapter(target: EditTargetLike | undefined): SnippetEditorLike | undefined {
  if (!target) return undefined;
  if (typeof target.edit === 'function') {
    return {
      document: { getText: () => '', lineAt: () => ({ text: '', firstNonWhitespaceCharacterIndex: 0 }) },
      edit: (callback) => target.edit!(callback)
    };
  }
  if (typeof target.pushEditOperations === 'function') {
    return {
      document: { getText: () => '', lineAt: () => ({ text: '', firstNonWhitespaceCharacterIndex: 0 }) },
      edit: (callback) => {
        const edits: Array<{ range: vscode.Range; text: string }> = [];
        callback({
          replace: (range, value) => edits.push({ range, text: value }),
          insert: (position, value) => edits.push({ range: new vscode.Range(position, position), text: value }),
          delete: (range) => edits.push({ range, text: '' })
        });
        if (!edits.length) return false;
        target.pushEditOperations!(
          [],
          edits.map((e) => ({ range: e.range, text: e.text })),
          () => null
        );
        return true;
      }
    };
  }
  return undefined;
}

/**
 * Small helper: a `DocumentLike` backed by a plain string (tests, previews).
 *
 * The line layout is computed once, on first use. A snippet decision reads a
 * dozen ranges from this document — the completion scan reads the line, the
 * context, the preceding context and the word, and the expansion reads a line
 * again — and every one of those used to re-split the entire buffer. That split
 * was the single most repeated cost on the keystroke path (measured at 0.23 ms
 * per read on a 141 KB document, ~2 ms per keystroke at the sizes a chapter
 * reaches).
 */
export function createStringDocument(text: string, languageId = 'latex'): DocumentLike {
  let layout: StringLayout | null = null;
  const lines = () => (layout ??= layoutOf(text)).lines;

  const offsetAt = (position: vscode.Position): number => {
    const current = (layout ??= layoutOf(text));
    const line = Math.max(0, Math.min(position.line, current.lines.length - 1));
    return current.starts[line] + Math.max(0, Math.min(position.character, current.lines[line].length));
  };

  return {
    languageId,
    getText: (range?: vscode.Range) => {
      if (!range) return text;
      return text.slice(offsetAt(range.start), offsetAt(range.end));
    },
    offsetAt,
    positionAt: (offset: number) => positionAtOffset(offset, (layout ??= layoutOf(text))),
    lineAt: (line: number | vscode.Position) => {
      const lineNumber = typeof line === 'number' ? line : line.line;
      const content = lines()[lineNumber] ?? '';
      return {
        text: content,
        firstNonWhitespaceCharacterIndex: content.length - content.replace(/^\s+/, '').length
      };
    },
    get lineCount() {
      return lines().length;
    }
  };
}

/** One buffer's line split, plus the offset each line starts at. */
interface StringLayout {
  lines: string[];
  starts: number[];
}

/**
 * A string document whose text can be replaced.
 *
 * An expansion outlives the buffer it was laid out in: the snippet is inserted,
 * the author types into its tab stops, and every one of those edits changes the
 * text the expansion's positions are expressed in. `createStringDocument`
 * captures its text once, which is right for the decisions taken *about* a
 * buffer and wrong for a document that has to keep answering while the buffer
 * moves — an `offsetAt` against a stale text silently clamps, and the tab stop
 * that comes back is the end of a line that no longer exists.
 *
 * The layout is rebuilt on the edit and reused for every read after it, so the
 * cost is still one split per change rather than one per read.
 */
export function createEditableDocument(
  text: string,
  languageId = 'latex'
): { document: DocumentLike; setText: (next: string) => void } {
  let current = text;
  let layout: StringLayout | null = null;
  const lines = () => (layout ??= layoutOf(current)).lines;

  const offsetAt = (position: vscode.Position): number => {
    const state = (layout ??= layoutOf(current));
    const line = Math.max(0, Math.min(position.line, state.lines.length - 1));
    return state.starts[line] + Math.max(0, Math.min(position.character, state.lines[line].length));
  };

  return {
    document: {
      languageId,
      getText: (range?: vscode.Range) => {
        if (!range) return current;
        return current.slice(offsetAt(range.start), offsetAt(range.end));
      },
      offsetAt,
      positionAt: (offset: number) => positionAtOffset(offset, (layout ??= layoutOf(current))),
      lineAt: (line: number | vscode.Position) => {
        const lineNumber = typeof line === 'number' ? line : line.line;
        const content = lines()[lineNumber] ?? '';
        return {
          text: content,
          firstNonWhitespaceCharacterIndex: content.length - content.replace(/^\s+/, '').length
        };
      },
      get lineCount() {
        return lines().length;
      }
    },
    setText: (next: string) => {
      current = next;
      layout = null;
    }
  };
}

function layoutOf(text: string): StringLayout {
  const lines = text.split(/\r\n|\r|\n/);
  const starts = new Array<number>(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = offset;
    offset += lines[i].length + 1;
  }
  return { lines, starts };
}

function positionAtOffset(offset: number, layout: StringLayout): vscode.Position {
  const { lines, starts } = layout;
  const target = Math.max(0, offset);
  // The first line whose end is at or past the offset: the same answer the
  // line-by-line subtraction produced, found without walking every line.
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (starts[mid] + lines[mid].length >= target) high = mid;
    else low = mid + 1;
  }
  if (target > starts[low] + lines[low].length) {
    const last = lines.length - 1;
    return new vscode.Position(last, lines[last].length);
  }
  return new vscode.Position(low, target - starts[low]);
}
