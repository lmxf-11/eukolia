/**
 * Eukolia — reading commands' arguments out of LaTeX source.
 *
 * The scanning primitives both analysis paths share. They live apart from either of
 * them because both need them and neither owns them: the linear scan
 * (`latexScan.ts`) is built on them, and the AST path calls into them whenever the
 * parser attached no arguments — which happens for every command the parser has no
 * signature for, and that is a longer list than it looks
 * (`\addbibresource`, `\newenvironment`, `\citep` with optional notes …).
 *
 * Nothing here knows what any command means. It reads the text the way TeX does for
 * the cases that matter: comments run to the end of the line, `\{` is not a brace,
 * braces nest, and `[….]` groups are separate from `{…}` ones.
 */

export interface Cursor {
  readonly text: string
  index: number
  line: number
}

export function makeCursor(text: string): Cursor {
  return { text, index: 0, line: 1 }
}

/** The next character, without consuming it. */
export function peek(cursor: Cursor, offset = 0): string {
  return cursor.text[cursor.index + offset] ?? ''
}

/** Consumes one character, keeping the line number true. */
export function take(cursor: Cursor): string {
  const char = cursor.text[cursor.index++] ?? ''
  if (char === '\n') cursor.line += 1
  return char
}

/** Consumes everything up to (not including) `target`. */
export function advanceTo(cursor: Cursor, target: number): void {
  while (cursor.index < target && cursor.index < cursor.text.length) take(cursor)
}

export function isEof(cursor: Cursor): boolean {
  return cursor.index >= cursor.text.length
}

/** Whitespace, including whole-line comments, between a command and its argument. */
export function skipBlanks(cursor: Cursor): void {
  for (;;) {
    const char = peek(cursor)
    if (char === '') return
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      take(cursor)
      continue
    }
    if (char === '%') {
      while (!isEof(cursor) && peek(cursor) !== '\n') take(cursor)
      continue
    }
    return
  }
}

/**
 * Reads a balanced `{…}` argument, or `[…]` when `open` is `[`.
 *
 * Escaped delimiters (`\{`, `\}`) do not count, and braces inside the argument nest
 * — which is what makes `\section{A \emph{b} c}` come back whole.
 */
export function readDelimited(
  cursor: Cursor,
  open: '{' | '[',
  close: '}' | ']'
): { text: string; start: number; end: number } | null {
  if (peek(cursor) !== open) return null
  const start = cursor.index
  take(cursor)
  let depth = 1
  const contentStart = cursor.index
  let contentEnd = cursor.index
  while (!isEof(cursor)) {
    const char = peek(cursor)
    if (char === '\\') {
      take(cursor)
      take(cursor)
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) {
        contentEnd = cursor.index
        take(cursor)
        return { text: cursor.text.slice(contentStart, contentEnd), start, end: cursor.index }
      }
    }
    take(cursor)
  }
  return null
}

/**
 * Reads the argument a command's source text carries, starting at `from`.
 *
 * `first` is the first *braced* argument — the one an include command names a file
 * in, or a definition names its macro in — and `end` is where the last argument
 * finishes, which is where a definition's statement ends. Optional `[…]` groups are
 * skipped on the way, so `\includegraphics[width=1cm]{plot}` reports `plot`.
 */
export function readArgumentsAt(text: string, from: number): { first: string | null; end: number } {
  const cursor: Cursor = { text, index: Math.max(0, Math.min(from, text.length)), line: 0 }
  let first: string | null = null
  let end = cursor.index
  for (;;) {
    skipBlanks(cursor)
    const char = peek(cursor)
    if (char !== '{' && char !== '[') break
    const argument = char === '{' ? readDelimited(cursor, '{', '}') : readDelimited(cursor, '[', ']')
    if (!argument) break
    end = argument.end
    if (char === '{' && first === null) first = argument.text.trim()
  }
  return { first, end }
}

/** The first braced argument a command carries, or `null`. */
export function readArgumentAt(text: string, from: number): string | null {
  return readArgumentsAt(text, from).first
}

/**
 * The reference's definition normalization, as a pure text transformation.
 *
 * `normalizeDefinition` in `newcommand.ts` applies this to a re-serialised AST; the
 * linear scan applies it to the source slice of the same statement. Both have to
 * agree on the rule — `\providecommand` and `\DeclareRobustCommand` become
 * `\newcommand`, and a starred macro loses its star, because MathJax cannot parse
 * either — so the rule is written once, here.
 */
export function normalizeDefinitionText(text: string): string {
  return text
    .replace(/^\\DeclareRobustCommand([^a-zA-Z])/g, '\\newcommand$1')
    .replace(/^\\providecommand([^a-zA-Z])/g, '\\newcommand$1')
    .replace(/^\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|newrobustcmd|renewrobustcmd)\*/g, '\\$1')
}
