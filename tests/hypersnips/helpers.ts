/**
 * Test helpers for the HyperSnips port.
 *
 * The reference fixtures are **vendored** into `tests/hypersnips/fixtures/expansions`
 * and copied from `References/hypersnips/src/test/expansions` byte-for-byte; they
 * are never retyped. They used to be read straight out of the reference checkout,
 * which meant the suite could not run without `References/` present — the one
 * remaining way the project still depended on a directory it is meant to be built
 * from rather than to require (`Instructions.md` §8). The reference ships these
 * three files and an empty `src/test/index.ts`, so there is nothing else to take.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Position, Range } from 'vscode';
import type { SnippetEditorPort } from '../../src/renderer/snippets/editorAdapter';
import type { DocumentLike } from '../../src/renderer/snippets/documentAdapter';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The vendored fixtures. Keeping the directory named `expansions` mirrors upstream. */
export const FIXTURE_DIR = path.join(REPO_ROOT, 'tests', 'hypersnips', 'fixtures', 'expansions');

/**
 * A single backslash.
 *
 * Snippet sources are LaTeX-heavy, so fixtures are written with this constant
 * instead of `'\\'` chains — a `'\\t'` slip inside a single-quoted string is a
 * TAB, which silently mangles a snippet body.
 */
export const BACKSLASH = String.fromCharCode(92);
/** A literal double backslash, i.e. a LaTeX newline in a snippet body. */
export const DOUBLE_BACKSLASH = BACKSLASH + BACKSLASH;

/** Read a fixture from the vendored HyperSnips expansions directory. */
export function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/** Read a file relative to the repository root. */
export function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/**
 * A minimal, honest editor: a real mutable buffer with a cursor and a
 * replacement primitive. No snippets or expansion logic lives here.
 */
export class TestEditor implements SnippetEditorPort {
  text: string;
  cursor: number;
  anchor: number;
  readonly languageId: string;
  readonly uri = {
    toString: () => 'file:///test/document.tex',
    fsPath: '/test/document.tex',
    path: '/test/document.tex'
  };

  constructor(text = '', languageId = 'latex') {
    this.text = text;
    this.cursor = text.length;
    this.anchor = this.cursor;
    this.languageId = languageId;
  }

  getText(): string {
    return this.text;
  }

  getOffset(): number {
    return this.cursor;
  }

  getSelection(): { from: number; to: number } {
    return { from: Math.min(this.anchor, this.cursor), to: Math.max(this.anchor, this.cursor) };
  }

  setSelection(anchor: number, active = anchor): void {
    this.anchor = anchor;
    this.cursor = active;
  }

  select(from: number, to: number): void {
    this.anchor = from;
    this.cursor = to;
  }

  replace(from: number, to: number, text: string, cursor: number): void {
    this.text = this.text.slice(0, from) + text + this.text.slice(to);
    this.cursor = cursor;
    this.anchor = cursor;
  }

  /** Type text at the cursor, one character at a time like a real keyboard. */
  type(text: string): void {
    for (const char of text) this.typeChar(char);
  }

  /** Type one character and report the resulting pre-edit change, like VS Code does. */
  typeChar(char: string): { range: Range; text: string; textAfter: string } {
    const start = this.cursor;
    const before = this.text;
    const startPosition = positionOf(before, start);
    this.text = this.text.slice(0, start) + char + this.text.slice(start);
    this.cursor = start + char.length;
    this.anchor = this.cursor;
    return {
      range: new Range(startPosition, startPosition),
      text: char,
      textAfter: this.text
    };
  }

  /** Replace the `[from, to)` range, reporting the change like VS Code does. */
  replaceRange(
    from: number,
    to: number,
    text: string
  ): { range: Range; text: string; textAfter: string } {
    const start = positionOf(this.text, from);
    const end = positionOf(this.text, to);
    this.text = this.text.slice(0, from) + text + this.text.slice(to);
    this.cursor = from + text.length;
    this.anchor = this.cursor;
    return { range: new Range(start, end), text, textAfter: this.text };
  }

  /** The text currently selected. */
  selected(): string {
    const { from, to } = this.getSelection();
    return this.text.slice(from, to);
  }

  /** Position of the cursor as `line:character`, for readable assertions. */
  cursorPosition(): string {
    return positionLabel(this.text, this.cursor);
  }
}

/** UTF-16 offset -> `Position` (same arithmetic as the shim's `positionAt`). */
export function positionOf(text: string, offset: number): Position {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const line = before.split('\n').length - 1;
  const character = before.length - (before.lastIndexOf('\n') + 1);
  return new Position(line, character);
}

export function positionLabel(text: string, offset: number): string {
  const position = positionOf(text, offset);
  return `${position.line}:${position.character}`;
}

/** Offset of the first occurrence of `needle`, failing loudly when absent. */
export function offsetOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`"${needle}" not found in test document`);
  return index;
}
