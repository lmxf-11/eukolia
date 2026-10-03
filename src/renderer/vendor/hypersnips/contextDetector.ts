// Ported from References/hypersnips/src/extension.ts (MIT, (c) 2019 Ian Ornelas). Modified for Eukolia.
//
// Eukolia modification: the reference kept its context detection inline in the
// VS Code `activate()` function. Three things lived there:
//
//   1. `isMathEnvironment(editor, position)` — the math-mode heuristic,
//   2. the `snippet.math` / `snippet.nonmath` filter applied to completions,
//   3. the `getContext` / multi-line context helpers used by regex triggers
//      (`hsnips.multiLineContext`, mirrored in `completion.ts`).
//
// They are extracted here so the engine can use them without a VS Code host.
// The heuristic itself is preserved verbatim, only re-expressed in terms of a
// text snapshot instead of `vscode.TextEditor`.

/** A snapshot of the document text plus the offset the check applies to. */
export interface ContextSnapshot {
  text: string;
  offset: number;
}

/**
 * Environments whose contents are *math*: inside one, the caret is in math.
 *
 * The reference knew `equation`, `align` and `gather` (with and without `*`),
 * which is a list a real document outgrows: `multline`, `alignat`, `flalign`,
 * `eqnarray` and `math` are all mathematics, and inside them the reference's
 * heuristic answered "not math" — so a math-only snippet stayed quiet where it
 * was wanted.
 */
const MATH_ENVIRONMENTS = new Set([
  'math',
  'displaymath',
  'equation',
  'align',
  'alignat',
  'gather',
  'multline',
  'flalign',
  'eqnarray',
  'split',
  'aligned',
  'alignedat',
  'gathered',
  'cases',
  'dcases',
  'array',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'smallmatrix',
  'IEEEeqnarray'
]);

/** Environments whose contents are literal text, whatever they contain. */
const VERBATIM_ENVIRONMENTS = new Set([
  'verbatim',
  'Verbatim',
  'BVerbatim',
  'LVerbatim',
  'lstlisting',
  'minted',
  'comment',
  'filecontents',
  'alltt'
]);

/**
 * Commands whose braced argument is *text* rather than mathematics.
 *
 * `$\text{a b}$` is text inside math, and the reference's heuristic knew this
 * too (it is why `\text{`, `\mathrm{` and `\operatorname{` appear in it): a
 * snippet whose trigger is a word must not fire in prose that happens to be
 * written inside mathematics.
 */
const TEXT_COMMANDS = new Set([
  'text',
  'textnormal',
  'textrm',
  'textsf',
  'texttt',
  'textup',
  'textit',
  'textsl',
  'textsc',
  'textbf',
  'textmd',
  'mbox',
  'hbox',
  'operatorname',
  'mathrm'
]);

/**
 * Commands whose braced argument is read *literally*, dollar signs and all.
 *
 * `\url{https://example.test/a$b}` is one such: LaTeX changes the category codes
 * of a `\url` argument, so a `$` in a URL is a character and never opens
 * mathematics — while the reference's heuristic read it as an unclosed opener and
 * called the rest of the document mathematics.
 */
const LITERAL_ARGUMENT_COMMANDS = new Set(['url', 'path', 'nolinkurl', 'href']);

/**
 * Inline-code commands, written `\name<delim>…<delim>`.
 *
 * `\verb|$|` and `\lstinline|$|` are literal by construction: the delimiter can be
 * anything, and what is between the delimiters is characters, not LaTeX.
 * `\mintinline` adds an optional `{language}` argument first, and may use braces
 * instead of a delimiter.
 */
const INLINE_CODE_COMMANDS = new Set(['verb', 'lstinline', 'mintinline']);

/** The index after the balanced brace group starting at `index`, or the end. */
function afterBraceGroup(text: string, index: number): number {
  let depth = 0;
  for (let i = index; i < text.length; i += 1) {
    const character = text[i];
    if (character === '\\') {
      i += 1;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** The index after an inline-code command's argument, whatever form it takes. */
function afterInlineCode(text: string, nameEnd: number): number {
  let cursor = nameEnd;
  if (text[cursor] === '*') cursor += 1;
  if (text[cursor] === '{') cursor = afterBraceGroup(text, cursor);
  if (text[cursor] === '{') return afterBraceGroup(text, cursor);
  const delimiter = text[cursor];
  if (delimiter === undefined || /\s/.test(delimiter)) return cursor;
  const close = text.indexOf(delimiter, cursor + 1);
  return close === -1 ? text.length : close + 1;
}

/**
 * The first letters of every command this scan has an opinion about.
 *
 * A command that cannot matter is skipped by its first letter alone, which leaves
 * the rest of its name to the next `interesting` search: no name is built and no
 * set is consulted for `\section`, `\cite`, `\frac` and the hundreds of others a
 * mathematics-dense document is made of.
 */
const INTERESTING_COMMAND_STARTS = new Set([
  'b', // begin
  'e', // end
  'v', // verb
  'l', // lstinline
  'm', // mintinline, mbox, mathrm
  'u', // url
  'p', // path
  'n', // nolinkurl
  'h', // href, hbox
  't', // text, textnormal, …
  'o' // operatorname
]);

/**
 * Whether the caret sits inside mathematics, judged from the text before it.
 *
 * Eukolia modification: this is a scanner rather than the reference's chain of
 * global regexes. The reference asked whether *any* math opener was left over
 * after stripping the *balanced* pairs it recognised, which made every one of
 * these — all of them ordinary, valid LaTeX — read as "inside math", for the rest
 * of the document:
 *
 *   * `\\[1ex]` — a line break with vertical space. It contains `\[`, so a table
 *     row or a title's spacing opened display math that never closed;
 *   * a `$` in a comment (`% costs $5`), which LaTeX ignores entirely;
 *   * a `$` in a verbatim environment, or in `\verb|$|`, or in a `\url{…}`;
 *   * any other stray dollar, e.g. prose that talks about money.
 *
 * A snippet with `context: "math"` then fired in prose, which is the report this
 * was written for. The scanner walks the text once and keeps the state a reader
 * would: comments, verbatim spans, escapes, the backslash run before a bracket
 * (`\\[` is a break, `\\\[` is display math), `$…$`, `$$…$$`, `\(…\)`, `\[…\]`,
 * mathematics environments, and text islands (`\text{…}`) inside them.
 */
export function isMathEnvironmentText(text: string): boolean {
  // Nothing in the text can open mathematics at all, which is the answer for most
  // of most documents — four native scans rather than a walk over every character.
  if (
    text.indexOf('$') === -1 &&
    text.indexOf('\\(') === -1 &&
    text.indexOf('\\[') === -1 &&
    text.indexOf('\\begin{') === -1
  ) {
    return false;
  }

  let inMath = false;
  let environment = '';
  let verbatimEnd: string | null = null;
  let i = 0;

  // The scan only stops on four characters; `exec` finds the next one in the
  // engine rather than in a JavaScript loop, which is what keeps a long document
  // from costing a comparison per character.
  const interesting = /[\\$%`]/g;
  // Command names are read in place, for the same reason: no slice of the rest of
  // the document is built to find out what a backslash starts.
  const commandName = /[A-Za-z]+/y;

  while (i < text.length) {
    interesting.lastIndex = i;
    const found = interesting.exec(text);
    if (!found) break;
    i = found.index;
    const character = text[i];

    if (verbatimEnd !== null) {
      // Inside a verbatim-like environment nothing is LaTeX until it ends — and a
      // caret inside one is in text, whatever surrounded it.
      const close = text.indexOf(verbatimEnd, i);
      if (close === -1) return false;
      i = close + verbatimEnd.length;
      verbatimEnd = null;
      continue;
    }

    if (character === '%') {
      // The rest of the line is a comment, and LaTeX reads none of it.
      const newline = text.indexOf('\n', i);
      if (newline === -1) return false;
      i = newline + 1;
      continue;
    }

    // A backtick span is literal in Eukolia's editor (Markdown-ish code), and the
    // reference stripped it too: `$` inside it is not a delimiter.
    if (character === '`') {
      const close = text.indexOf('`', i + 1);
      if (close === -1) return false;
      i = close + 1;
      continue;
    }

    if (character === '$') {
      // `$$` is display math; both forms simply toggle, so an unclosed one leaves
      // the caret in math exactly as LaTeX's own reader would.
      inMath = !inMath;
      i += text[i + 1] === '$' ? 2 : 1;
      continue;
    }

    // A run of backslashes: an even run is line breaks, and the character after it
    // is read normally — which is what keeps `\\[1ex]` out of display math. An odd
    // run ends in a command.
    let run = 0;
    while (text[i + run] === '\\') run += 1;
    if (run % 2 === 0) {
      i += run;
      continue;
    }

    const nameStart = i + run;
    // A *command* this scan cannot care about is skipped by its first letter,
    // which leaves the rest of its name to the next `interesting` search. A
    // non-letter is never skipped: `\[` and `\(` are the delimiters themselves.
    const firstCode = text.charCodeAt(nameStart);
    if (isLetter(firstCode) && !INTERESTING_COMMAND_STARTS.has(text[nameStart])) {
      i = nameStart + 1;
      continue;
    }

    commandName.lastIndex = nameStart;
    const command = commandName.exec(text);

    if (!command) {
      const escaped = text[nameStart];
      if (escaped === '[' || escaped === '(') inMath = true;
      else if (escaped === ']' || escaped === ')') inMath = false;
      // `\$`, `\%`, `\{`, `\}` and everything else stand for themselves.
      i = nameStart + 1;
      continue;
    }

    const name = command[0];
    const nameEnd = nameStart + name.length;
    const argument = afterSpaces(text, nameEnd);

    if (name === 'begin' || name === 'end') {
      const group = braceGroupAt(text, argument);
      if (group) {
        const target = group.name.replace(/\*$/, '');
        if (name === 'begin') {
          if (VERBATIM_ENVIRONMENTS.has(group.name) || VERBATIM_ENVIRONMENTS.has(target)) {
            verbatimEnd = `\\end{${group.name}}`;
          } else if (MATH_ENVIRONMENTS.has(target)) {
            inMath = true;
            environment = target;
          }
        } else if (inMath && target === environment) {
          inMath = false;
          environment = '';
        }
        i = group.after;
        continue;
      }
      i = nameEnd;
      continue;
    }

    if (INLINE_CODE_COMMANDS.has(name)) {
      i = afterInlineCode(text, argument);
      continue;
    }

    if (LITERAL_ARGUMENT_COMMANDS.has(name)) {
      const group = braceGroupAt(text, argument);
      if (group) {
        i = group.after;
        continue;
      }
      i = nameEnd;
      continue;
    }

    if (TEXT_COMMANDS.has(name)) {
      const group = braceGroupAt(text, argument);
      if (group) {
        // A text island: the caret inside `$\text{…}$` is in text mode, and if the
        // group never closes then the caret is inside it.
        i = group.after;
        continue;
      }
      return false;
    }

    i = nameEnd;
  }

  return inMath;
}

/** A Latin letter, which is what a command name is made of. */
function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** The index of the first character that is not a space or tab. */
function afterSpaces(text: string, index: number): number {
  let cursor = index;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
  return cursor;
}

/** A `{…}` group starting at `index`, with what it holds and where it ends. */
function braceGroupAt(
  text: string,
  index: number
): { name: string; after: number } | null {
  if (text[index] !== '{') return null;
  const close = text.indexOf('}', index + 1);
  if (close === -1) return null;
  return { name: text.slice(index + 1, close), after: close + 1 };
}

/**
 * Reference `getContext`: returns the maximal whitespace-free run of text
 * ending at `offset`, i.e. the token a non-regex trigger is matched against.
 */
export function getTriggerContext(snapshot: ContextSnapshot): string {
  const before = snapshot.text.slice(0, snapshot.offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);
  const match = line.match(/\S*$/);
  return match ? match[0] : '';
}

/** Reference `getLineContext`: the whole current line up to `offset`. */
export function getLineContext(snapshot: ContextSnapshot): string {
  const before = snapshot.text.slice(0, snapshot.offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  return before.slice(lineStart);
}

/** Reference multi-line context: the previous `lines` lines plus the current prefix. */
export function getMultiLineContextText(snapshot: ContextSnapshot, lines: number): string {
  const before = snapshot.text.slice(0, snapshot.offset);
  const allLines = before.split('\n');
  const from = Math.max(allLines.length - 1 - lines, 0);
  return allLines.slice(from).join('\n').replace(/\r/g, '');
}
