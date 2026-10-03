/**
 * Eukolia — locating a value inside a JSON document's own text.
 *
 * `JSON.parse` throws positions away, so a validation issue can name the entry
 * that is wrong but not the line the user has to look at. The snippets file is a
 * file people are *meant* to hand-edit, so "line 42" is the difference between a
 * useful message and a puzzle.
 *
 * This is a small scanner, not a parser: it walks the text once, recording where
 * every value starts, and never builds anything. It is written by hand rather
 * than by re-using a tokeniser because the only contract it has to keep is
 * "the offsets `JSON.parse` would have produced", and it is pinned by
 * `tests/snippets/eusnips.test.ts` against `JSON.parse` itself.
 */

export interface JsonPosition {
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** 0-based offset into the text. */
  offset: number;
}

interface ScannerFrame {
  path: string;
  offsets: Map<string, number>;
}

/** The offset a JSON pointer's value starts at, or `null` when it is not found. */
export function offsetOfJsonPointer(text: string, pointer: string): number | null {
  const scanner = new JsonScanner(text);
  const table = scanner.scan();
  if (!table) return null;
  return table.get(pointer) ?? null;
}

/**
 * The offsets of many pointers, from one walk of the text.
 *
 * A scan costs about 20 ms on a 300 KB library, and a file with a problem in
 * every entry produces over a thousand pointers — resolving them one at a time
 * was twenty-eight seconds of work per keystroke, which is what made the editor
 * unusable on a large library. The walk is the same walk for all of them, so it
 * is done once and every pointer is read out of the table it produced.
 *
 * A pointer that is not in the document comes back missing rather than throwing:
 * a validator can report an issue about a value the text does not contain — a
 * required property that is absent, for instance — and the caller's job is to
 * carry on without a position for it.
 */
export function offsetsOfJsonPointers(text: string, pointers: readonly string[]): Map<string, number> {
  const offsets = new Map<string, number>();
  if (pointers.length === 0) return offsets;
  const table = new JsonScanner(text).scan();
  if (!table) return offsets;
  for (const pointer of pointers) {
    const offset = table.get(pointer);
    if (offset !== undefined) offsets.set(pointer, offset);
  }
  return offsets;
}

/** Line/column of an offset, counting from 1 as every editor does. */
export function positionOfOffset(text: string, offset: number): JsonPosition {
  const bounded = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < bounded; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: bounded - lineStart + 1, offset: bounded };
}

/** Offset table for every value in a JSON document, keyed by pointer. */
class JsonScanner {
  private index = 0;
  private readonly offsets = new Map<string, number>();

  constructor(private readonly text: string) {}

  scan(): Map<string, number> | null {
    this.skipWhitespace();
    if (!this.parseValue('')) return null;
    this.skipWhitespace();
    return this.index === this.text.length ? this.offsets : null;
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && /\s/.test(this.text[this.index])) this.index += 1;
  }

  private parseValue(path: string): boolean {
    this.skipWhitespace();
    if (this.index >= this.text.length) return false;
    this.offsets.set(path, this.index);
    const character = this.text[this.index];
    if (character === '{') return this.parseObject(path);
    if (character === '[') return this.parseArray(path);
    if (character === '"') return this.parseString();
    return this.parseLiteral();
  }

  private parseObject(path: string): boolean {
    this.index += 1; // `{`
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return true;
    }
    for (;;) {
      this.skipWhitespace();
      const keyStart = this.index;
      if (!this.parseString()) return false;
      const key = JSON.parse(this.text.slice(keyStart, this.index)) as string;
      this.skipWhitespace();
      if (this.text[this.index] !== ':') return false;
      this.index += 1;
      const childPath = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!this.parseValue(childPath)) return false;
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === ',') {
        this.index += 1;
        continue;
      }
      if (separator === '}') {
        this.index += 1;
        return true;
      }
      return false;
    }
  }

  private parseArray(path: string): boolean {
    this.index += 1; // `[`
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return true;
    }
    let element = 0;
    for (;;) {
      if (!this.parseValue(`${path}/${element}`)) return false;
      element += 1;
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === ',') {
        this.index += 1;
        continue;
      }
      if (separator === ']') {
        this.index += 1;
        return true;
      }
      return false;
    }
  }

  private parseString(): boolean {
    if (this.text[this.index] !== '"') return false;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === '\\') {
        this.index += 2;
        continue;
      }
      this.index += 1;
      if (character === '"') return true;
    }
    return false;
  }

  private parseLiteral(): boolean {
    const start = this.index;
    while (this.index < this.text.length && !/[\s,}\]]/.test(this.text[this.index])) this.index += 1;
    const literal = this.text.slice(start, this.index);
    return literal === 'true' || literal === 'false' || literal === 'null' || /^-?\d/.test(literal);
  }
}
