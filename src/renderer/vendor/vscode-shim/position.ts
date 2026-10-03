/**
 * Eukolia — VS Code compatibility layer: text primitives.
 *
 * `Position`, `Range` and `Selection` are re-implemented here with the same
 * semantics as the VS Code API so that code ported from LaTeX Workshop and
 * HyperSnips keeps working unchanged.
 *
 * Part of the "replace the VS Code adapter, keep the reusable implementation"
 * rule of Instructions.md §13.
 */

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}

  static Min(...positions: Position[]): Position {
    if (!positions.length) throw new TypeError('Cannot get the minimum of zero positions');
    let result = positions[0];
    for (const p of positions) {
      if (p.isBefore(result)) result = p;
    }
    return result;
  }

  static Max(...positions: Position[]): Position {
    if (!positions.length) throw new TypeError('Cannot get the maximum of zero positions');
    let result = positions[0];
    for (const p of positions) {
      if (p.isAfter(result)) result = p;
    }
    return result;
  }

  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }

  isBeforeOrEqual(other: Position): boolean {
    return !other.isBefore(this);
  }

  isAfter(other: Position): boolean {
    return other.isBefore(this);
  }

  isAfterOrEqual(other: Position): boolean {
    return !this.isBefore(other);
  }

  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }

  compareTo(other: Position): number {
    if (this.line < other.line) return -1;
    if (this.line > other.line) return 1;
    if (this.character < other.character) return -1;
    if (this.character > other.character) return 1;
    return 0;
  }

  /**
   * VS Code accepts either `(lineDelta, characterDelta)` or a change object.
   * Ported code uses both forms, so both are supported.
   */
  translate(lineDelta?: number, characterDelta?: number): Position;
  translate(change: { lineDelta?: number; characterDelta?: number }): Position;
  translate(lineDeltaOrChange?: number | { lineDelta?: number; characterDelta?: number }, characterDelta = 0): Position {
    let lineDelta = 0;
    let charDelta = 0;
    if (typeof lineDeltaOrChange === 'number') {
      lineDelta = lineDeltaOrChange;
      charDelta = characterDelta ?? 0;
    } else if (lineDeltaOrChange) {
      lineDelta = lineDeltaOrChange.lineDelta ?? 0;
      charDelta = lineDeltaOrChange.characterDelta ?? 0;
    }
    if (lineDelta === 0 && charDelta === 0) return this;
    return new Position(this.line + lineDelta, this.character + charDelta);
  }

  with(line?: number, character?: number): Position {
    return new Position(line ?? this.line, character ?? this.character);
  }
}

export interface RangeLike {
  start: Position;
  end: Position;
}

/**
 * Half-open text range, exactly like the VS Code API: `start` is included,
 * `end` is excluded.
 */
export class Range {
  public readonly start: Position;
  public readonly end: Position;

  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(
    a: Position | number,
    b: Position | number,
    c?: number,
    d?: number
  ) {
    let start: Position;
    let end: Position;
    if (typeof a === 'number') {
      start = new Position(a, b as number);
      end = new Position(c as number, d as number);
    } else {
      start = a;
      end = b as Position;
    }
    // VS Code normalises: `start` is never after `end`.
    if (end.isBefore(start)) {
      this.start = end;
      this.end = start;
    } else {
      this.start = start;
      this.end = end;
    }
  }

  static from(locations: Range[]): Range;
  static from(location: Position, positions: Position[]): Range;
  static from(...args: [Range[]] | [Position, Position[]]): Range {
    if (args.length === 1) {
      const ranges = args[0] as Range[];
      if (!ranges.length) throw new TypeError('Cannot get the range of zero ranges');
      return new Range(
        Position.Min(...ranges.map((r) => r.start)),
        Position.Max(...ranges.map((r) => r.end))
      );
    }
    const [location, positions] = args as [Position, Position[]];
    if (!positions.length) throw new TypeError('Cannot get the range of zero positions');
    return new Range(Position.Min(location, ...positions), Position.Max(location, ...positions));
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }

  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }

  contains(positionOrRange: Position | Range): boolean {
    if (positionOrRange instanceof Range) {
      return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
    }
    return !positionOrRange.isBefore(this.start) && !positionOrRange.isAfter(this.end);
  }

  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  intersection(other: Range): Range | undefined {
    const start = Position.Max(this.start, other.start);
    const end = Position.Min(this.end, other.end);
    if (start.isAfter(end)) return undefined;
    return new Range(start, end);
  }

  union(other: Range): Range {
    return new Range(Position.Min(this.start, other.start), Position.Max(this.end, other.end));
  }

  with(start?: Position, end?: Position): Range {
    return new Range(start ?? this.start, end ?? this.end);
  }
}

export class Selection extends Range {
  public readonly anchor: Position;
  public readonly active: Position;

  constructor(anchor: Position, active: Position);
  constructor(anchorLine: number, anchorCharacter: number, activeLine: number, activeCharacter: number);
  constructor(
    a: Position | number,
    b: Position | number,
    c?: number,
    d?: number
  ) {
    if (typeof a === 'number') {
      const anchor = new Position(a, b as number);
      const active = new Position(c as number, d as number);
      super(anchor, active);
      this.anchor = anchor;
      this.active = active;
    } else {
      super(a, b as Position);
      this.anchor = a;
      this.active = b as Position;
    }
  }

  get isReversed(): boolean {
    return this.anchor.isAfter(this.active);
  }
}

/**
 * Minimal, correct `Location`: a `Uri` plus a `Range`.
 */
export class Location {
  constructor(
    public readonly uri: { toString(): string; fsPath: string; scheme: string },
    public readonly range: Range
  ) {}
}

type TextDocumentLike = {
  lineAt(line: number): { text: string; range: Range; rangeIncludingLineBreak: Range; firstNonWhitespaceCharacterIndex: number; isEmptyOrWhitespace: boolean };
  offsetAt(position: Position): number;
  positionAt(offset: number): Position;
  getText(range?: Range): string;
  validatePosition(position: Position): Position;
  validateRange(range: Range): Range;
  lineCount: number;
};

/**
 * Compute the offset (in UTF-16 code units) of a `Position` inside `text`.
 * Matches VS Code behaviour: out-of-range characters clamp to the line end.
 */
export function offsetAt(text: string, position: Position): number {
  const lines = splitLines(text);
  const line = Math.max(0, Math.min(position.line, lines.length - 1));
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i].length + 1;
  return offset + Math.max(0, Math.min(position.character, lines[line].length));
}

/** Compute the `Position` for a UTF-16 offset inside `text`. */
export function positionAt(text: string, offset: number): Position {
  const lines = splitLines(text);
  let remaining = Math.max(0, offset);
  for (let line = 0; line < lines.length; line++) {
    const length = lines[line].length;
    if (remaining <= length) return new Position(line, remaining);
    remaining -= length + 1;
  }
  const last = lines.length - 1;
  return new Position(last, lines[last].length);
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * A real `TextDocument` adapter. Backed by a plain text provider so it can wrap
 * an Eukolia buffer without introducing a dependency on the document module.
 */
export class ShimTextDocument implements TextDocumentLike {
  private cachedLines: string[] | null = null;
  private cachedVersion = -1;

  constructor(
    public readonly uri: { toString(): string; fsPath: string; scheme: string; path: string },
    public readonly languageId: string,
    private readonly textProvider: () => string,
    public readonly version: number,
    public readonly isDirty: boolean,
    public readonly fileName: string
  ) {}

  get lineCount(): number {
    return this.lines.length;
  }

  private get lines(): string[] {
    if (this.cachedVersion !== this.version || this.cachedLines === null) {
      this.cachedLines = splitLines(this.textProvider());
      this.cachedVersion = this.version;
    }
    return this.cachedLines;
  }

  get eol(): string {
    return '\n';
  }

  get isUntitled(): boolean {
    return this.uri.scheme === 'untitled';
  }

  get isClosed(): boolean {
    return false;
  }

  getText(range?: Range): string {
    const text = this.textProvider();
    if (!range) return text;
    const start = offsetAt(text, range.start);
    const end = offsetAt(text, range.end);
    return text.slice(start, end);
  }

  lineAt(lineOrPosition: number | Position) {
    const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
    if (line < 0 || line >= this.lines.length) {
      throw new Error(`Illegal value for line: ${line}`);
    }
    const text = this.lines[line];
    const firstNonWhitespaceCharacterIndex = text.length - text.replace(/^\s+/, '').length;
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak: new Range(line, 0, line + 1, 0),
      firstNonWhitespaceCharacterIndex,
      isEmptyOrWhitespace: firstNonWhitespaceCharacterIndex === text.length
    };
  }

  offsetAt(position: Position): number {
    return offsetAt(this.textProvider(), position);
  }

  positionAt(offset: number): Position {
    return positionAt(this.textProvider(), offset);
  }

  validatePosition(position: Position): Position {
    const text = this.textProvider();
    const lines = splitLines(text);
    const line = Math.max(0, Math.min(position.line, lines.length - 1));
    return new Position(line, Math.max(0, Math.min(position.character, lines[line].length)));
  }

  validateRange(range: Range): Range {
    return new Range(this.validatePosition(range.start), this.validatePosition(range.end));
  }

  getWordRangeAtPosition(position: Position, regex = /[A-Za-z0-9_]+/): Range | undefined {
    const line = this.lineAt(position.line).text;
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (match.index <= position.character && match.index + match[0].length >= position.character) {
        return new Range(position.line, match.index, position.line, match.index + match[0].length);
      }
      if (match.index > position.character) break;
    }
    return undefined;
  }

  save(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
