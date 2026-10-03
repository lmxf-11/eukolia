/**
 * Eukolia — the EUSnips body: tokenising `.hsnips` body text and rendering the
 * structured body form back into it.
 *
 * A snippet body can be written two ways, and both are kept exactly that way on
 * disk:
 *
 *  * a **string**, which is HyperSnips body text — `$1`, `${1:default}`,
 *    `${1|a,b|}`, `` `code` `` blocks and so on. This is the form that can
 *    express everything the ported parser understands, so it is what new
 *    snippets are written as.
 *  * a **list of body nodes**, the structured form the schema also allows,
 *    which is what the editor shows when it wants to offer per-node controls.
 *
 * Both are projected onto the same `.hsnips` body before the engine sees them,
 * so there is exactly one expansion code path. {@link tokenizeBody} is the
 * inverse for the string form, and it is deliberately conservative: anything it
 * cannot represent as a node is kept verbatim as text, so a round trip through
 * the tokeniser never loses a character.
 *
 * A backtick in the string form is a code-block delimiter and nothing else — the
 * parser has no escape for it — so the two forms are kept interchangeable by
 * *forbidding* a backtick in a structured text node rather than inventing an
 * encoding the parser would not understand. The editor reports that as a
 * validation error, which is honest, instead of writing a file that expands
 * differently from what the node list showed.
 */

export interface TextBodyNode {
  type: 'text';
  value: string;
}

export interface TabstopBodyNode {
  type: 'tabstop';
  index: number;
  /**
   * A default is either literal text or a nested body, because the schema says
   * `${1:default}` may hold further nodes — a tab stop inside a tab stop's
   * default is ordinary VS Code snippet syntax, and a nested default that could
   * only be a string would make the structured form unable to say what the
   * string form can.
   */
  default?: SnippetBody;
  choices?: string[];
  /** A substitution, written as it appears in the body: `/find/replace/flags`. */
  transform?: string;
}

export interface SelectionBodyNode {
  type: 'selection';
  default?: string;
}

export interface ExpressionBodyNode {
  type: 'expression';
  expression: { language: 'javascript-expression'; code: string };
  /**
   * Tab stop the substitution is written against. The ported reader only
   * recognises a substitution as `` `${N/…/…/}` ``, so the node carries the
   * number that spelling needs; the tokeniser reads the number back, so the
   * text form round-trips.
   */
  index?: number;
  /**
   * A substitution over the expression's own result.
   *
   * The engine does not evaluate substitutions yet — a plain-text buffer has no
   * live tab stop to substitute — so the node keeps what the body says and the
   * projection writes it faithfully rather than dropping it.
   */
  transform?: string;
}

export interface JavascriptBodyNode {
  type: 'javascript';
  code: string;
}

export type BodyNode =
  | TextBodyNode
  | TabstopBodyNode
  | SelectionBodyNode
  | ExpressionBodyNode
  | JavascriptBodyNode;

export type SnippetBody = string | BodyNode[];

/** The code-block delimiter the ported parser looks for. */
const DELIMITER = '``';

// ---------------------------------------------------------------------------
// Writing `.hsnips` body text
// ---------------------------------------------------------------------------

/**
 * A JavaScript code block.
 *
 * The parser trims each line of a code block and joins them with `\n`, so the
 * rendering trims them too; anything else would make the string form and the
 * structured form expand differently.
 */
export function codeBlock(code: string): string {
  const body = code
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
  return `${DELIMITER}${body}${DELIMITER}`;
}

/**
 * A tab stop, choice list, nested default or substitution, written the way the
 * engine reads it.
 *
 * A nested default is rendered into the same vocabulary rather than being
 * stringified: a `default` that is a list of nodes is the structured spelling of
 * `${1:…}`, so rendering it as `[object Object]` — which is what string
 * interpolation did — would write a body that means something else entirely.
 */
export function tabstopText(node: TabstopBodyNode): string {
  const suffix = node.transform ?? '';
  if (node.choices && node.choices.length > 0) {
    // `${1|a,b|}` and `${1|a,b}` mean the same thing to a reader and to
    // `stripPlaceholders`, and the second has no trailing pipe to confuse the
    // closing brace. The tokeniser accepts both; this is the one it writes.
    return `\${${node.index}|${node.choices.join(',')}}${suffix}`;
  }
  const inner = node.default === undefined ? '' : renderBody(node.default);
  if (inner !== '') {
    return `\${${node.index}:${inner}}${suffix}`;
  }
  // A bare tab stop is written `$1` rather than `${1}`: the two mean the same
  // thing to the engine, and the short form is what every HyperSnips document —
  // including the built-in library — already looks like. A substitution has no
  // short form to attach to, though: `$1/re/f/` is not a token the reader knows,
  // so the braced spelling is used and the substitution goes inside it.
  if (suffix === '') return `$${node.index}`;
  return `\${${node.index}${suffix}}`;
}

/** `${VISUAL}`, or `${VISUAL:default}` when the node carries a fallback. */
export function selectionText(node: SelectionBodyNode): string {
  // The engine resolves this as a variable: its default is what the expansion
  // inserts when there is no fresh selection, which is exactly what the node's
  // `default` means. Dropping it — as rendering `${VISUAL}` regardless did —
  // would silently lose a declared default.
  return node.default === undefined || node.default === '' ? '${VISUAL}' : `\${VISUAL:${node.default}}`;
}

/**
 * A code block that carries a substitution.
 *
 * The ported placeholder reader resolves a substitution written around a block
 * as the block's own text, so `` `${1:1/re/f/}` `` ``rv = "x"`` is the spelling
 * that reaches the engine as an expression whose result is substituted. The
 * literal before the substitution is not the expression's own result — the
 * reader emits no text for it at all — so the index is written there, which is
 * both true and what keeps the text form round-tripping through
 * {@link substitutionOverBlock}.
 *
 * With no substitution the bare code block is kept, because that is what the
 * built-in library and every hand-written `.hsnips` file already look like.
 */
export function expressionText(node: ExpressionBodyNode): string {
  const block = codeBlock(node.expression.code);
  if (node.transform === undefined) return block;
  const index = node.index ?? 1;
  return `\${${index}:${index}${node.transform}}${block}`;
}

function bodyNodeText(node: BodyNode): string {
  switch (node.type) {
    case 'text':
      return node.value;
    case 'tabstop':
      return tabstopText(node);
    case 'selection':
      return selectionText(node);
    case 'expression':
      return expressionText(node);
    case 'javascript':
      return codeBlock(node.code);
  }
}

/**
 * Renders a body to `.hsnips` body text — the form the ported parser reads.
 *
 * A string body *is* that text, so it is passed through verbatim. That is what
 * makes an entry round-trip: the parser's `getSnippetBody` hands back exactly
 * this text, and handing it straight back to the parser reproduces the snippet.
 * A structured body is rendered node by node into the same vocabulary, defaults
 * and nested bodies included.
 */
export function renderBody(body: SnippetBody): string {
  if (typeof body === 'string') return body;
  return body.map(bodyNodeText).join('');
}

/**
 * The body as the lines a `.hsnips` document carries between its header and its
 * `endsnippet`. The parser joins them with `\n` and drops the final one, so this
 * is the inverse of reading a body back.
 */
export function bodyLines(body: SnippetBody): string[] {
  return renderBody(body).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

// ---------------------------------------------------------------------------
// Reading `.hsnips` body text
// ---------------------------------------------------------------------------

/**
 * The end of the `${…}` group that opened at `open`, honouring nesting.
 *
 * Two things a naive brace count gets wrong, and both are ordinary snippet
 * syntax:
 *
 *  * a nested group — `${1:${2:x}}` — which is why braces are counted at all;
 *  * a brace inside a substitution's patterns — `${1/a{2}/X/}` — which is a
 *    regex quantifier, not a brace of the group. A substitution's patterns are
 *    skipped in the same way the engine's own reader skips them: an escaped
 *    character is passed over, a `[...]` class may hold a slash, and a slash
 *    outside a class ends a segment.
 *
 * `find` and `replace` are read, and at the end of the group the count is at
 * zero, so the closing brace is the one the caller closes on.
 */
function groupEnd(text: string, open: number): number {
  // The group that opened before `open` is one level, and the substitution test
  // below only applies at that level: a slash nested any deeper belongs to a
  // default's own text, not to this group's substitution.
  let depth = 1;
  let cursor = open;
  let inSubstitution = false;

  while (cursor < text.length) {
    const character = text[cursor];

    if (character === '\\') {
      if (cursor + 1 < text.length && text[cursor + 1] === '}' && depth > 1) {
        depth -= 1;
        cursor += 2;
        continue;
      }
      cursor += 2;
      continue;
    }

    if (inSubstitution) {
      // The substitution is scanned with the same rules the reader uses, but it
      // is *not* read through `parseSubstitution`: that function's flags run to
      // the group's closing brace, which is the very character this scan is
      // looking for. Scanning the two slash-delimited segments leaves the brace
      // in place, and the loop below closes the group on it.
      const find = scanSegments(text, cursor, '/', true);
      if (!find.found) return -1;
      const replace = scanSegments(text, find.end, '/', true);
      cursor = replace.found ? replace.end : find.end;
      inSubstitution = false;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return cursor;
    } else if (character === '/' && depth === 1 && /^\d+$/.test(text.slice(open, cursor))) {
      // A substitution opens right after the group's own index, so `/` there is
      // a substitution and a `/` anywhere else is default text.
      inSubstitution = true;
    }
    cursor += 1;
  }
  return -1;
}

/**
 * A substitution, split into its parts.
 *
 * The shape is `/find/replace/flags` with the leading slash, and every part
 * after the first is optional: `/find/` is a legal substitution that deletes
 * what it matches. `flags` is only read when there is a replacement for it to
 * follow, because `replace` is not recognisable in `/a/b` and `/ab/` has the
 * same shape.
 */
export interface BodySubstitution {
  find: string;
  replace?: string;
  flags?: string;
}

/** Back into body text, which is how a node carries it. */
export function substitutionText(parts: BodySubstitution): string {
  const replace = parts.replace === undefined ? '' : parts.replace;
  const flags = parts.flags ?? '';
  if (replace === '' && flags === '') return `/${parts.find}/`;
  return `/${parts.find}/${replace}/${flags}`;
}

/**
 * Reads the first substitution at `index`, or `null` when there is not one.
 *
 * The reader is segment-aware rather than delimiter-split because a find pattern
 * is a regular expression and may contain both a slash and a brace: splitting
 * `/a{2}\/b/X/` on every slash, or cutting at the first `}`, mangles a
 * substitution that a hand-written `.hsnips` file is perfectly entitled to hold.
 * A backslash escapes the next character anywhere except inside a `[...]` class,
 * which is what makes `\/` a literal slash and `[\]]` a literal bracket.
 *
 * No validation is done here: whether the find pattern actually compiles is a
 * question for the engine, and `tokenizeBody`'s contract is that it never
 * rejects text.
 */
export function parseSubstitution(text: string, index: number): { substitution: BodySubstitution; end: number } | null {
  if (text[index] !== '/') return null;

  const find = scanSegments(text, index + 1, '/', true);
  // A substitution must have at least two slashes: `/find/`
  if (!find.found) return null;

  const replace = scanSegments(text, find.end, '/', true);
  if (!replace.found) {
    return { substitution: { find: find.text, replace: replace.text }, end: replace.end };
  }

  // The flags run up to the end of the group. A `}` cannot appear in a
  // JavaScript flags string, and every other substitution in a body is itself
  // written inside a `${…}` group, so the group's own brace is the boundary.
  const flags = scanSegments(text, replace.end, '}', false);

  return {
    substitution: { find: find.text, replace: replace.text, flags: flags.text },
    end: flags.end
  };
}

/**
 * Text up to the next unescaped `delimiter`.
 *
 * `found` says whether the delimiter was there at all, which is what tells a
 * closed segment from one that ran off the end of the text: `/a/` has a find and
 * an empty replacement, while `/a` has only a find, and the two look identical
 * if the end offset is the only thing returned.
 *
 * `classes` is what makes the scan safe for a pattern and its replacement: a
 * `[...]` class may hold a delimiter, so `/a[./]b/X/` has two segments and not
 * three, and `[\]]` holds an escaped bracket. A backslash always escapes the
 * next character outside a class, which is what lets `\/` be a literal slash.
 *
 * `end` is one past the delimiter, or the end of the text when it was not found.
 */
function scanSegments(
  text: string,
  start: number,
  delimiter: string,
  classes: boolean
): { text: string; end: number; found: boolean } {
  let cursor = start;
  let inClass = false;
  let scanned = '';

  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '\\' && cursor + 1 < text.length) {
      scanned += character + text[cursor + 1];
      cursor += 2;
      continue;
    }
    if (classes && character === '[') inClass = true;
    else if (classes && character === ']') inClass = false;
    else if (character === delimiter && !inClass) return { text: scanned, end: cursor + 1, found: true };
    scanned += character;
    cursor += 1;
  }

  return { text: scanned, end: cursor, found: false };
}

/**
 * The substitution that follows a tab stop, when one does.
 *
 * `${1/re/f/}` is the form that wraps a tab stop's substitution in braces, and
 * `$1/re/f/` is the form that writes it bare. Both reach the engine as the same
 * body text; the first is what {@link tabstopText} writes, because a braced tab
 * stop has a `}` to stop the flags at and the bare form has nothing.
 */
function transformSuffix(text: string, cursor: number): { suffix: string; end: number } {
  if (text[cursor] !== '/') return { suffix: '', end: cursor };
  const parsed = parseSubstitution(text, cursor);
  if (!parsed) return { suffix: '', end: cursor };
  return { suffix: substitutionText(parsed.substitution), end: parsed.end };
}

/**
 * A substitution at the very end of a group's content: `/find/replace/flags`.
 *
 * This is the reader for the *structured* half of the format, where the
 * substitution arrives whole; the body text half goes through
 * {@link parseSubstitution}, which scans segment by segment. The two agree on
 * what a pattern may contain: a backslash escapes the next character, and a
 * `[...]` class — which may hold a slash or an escaped bracket — is not a
 * boundary. A plain `[^/]*` would split `${1/[a/b]+/X/g}` inside its own class.
 *
 * The replacement is greedy, so the *last* `/…/…/` wins: in `:a/b/c/d/` the
 * default is `a` and the substitution is `/b/c/d/`, which is the reading that
 * leaves the flags on the end where they belong.
 */
const TRAILING_SUBSTITUTION = /^(.*?)(\/(?:\\[\s\S]|\[(?:\\[\s\S]|[^\]\\])*\]|[^/\\])*\/(?:\\[\s\S]|[^/\\])*\/[^}]*)$/s;

/**
 * The node a `${…}` group describes, when it is not a plain tab stop.
 *
 * The three forms are told apart by what follows the index, in VS Code's own
 * resolution order: a choice list is tested before a substitution because
 * `${1|a/b,c|}` is a choice, and a default before a substitution because
 * `${1:a/b}` is a default.
 */
function bracedTabstopNode(index: number, tail: string): TabstopBodyNode {
  if (tail === '') return { type: 'tabstop', index };

  if (tail.startsWith('|')) {
    // Both spellings close with either `|}` or `}`.
    const choices = (tail.endsWith('|') ? tail.slice(1, -1) : tail.slice(1)).split(',');
    return { type: 'tabstop', index, choices };
  }

  // A substitution is written `${1/f/g/}` — the slash is the substitution's own
  // leading delimiter, not the start of a default that happens to look like one.
  const source = tail.startsWith(':') ? tail.slice(1) : tail;
  const transform = TRAILING_SUBSTITUTION.exec(source);
  if (transform && (tail.startsWith('/') || tail.startsWith(':'))) {
    const node: TabstopBodyNode = { type: 'tabstop', index, transform: transform[2] };
    if (transform[1] !== '') node.default = transform[1];
    return node;
  }

  if (tail.startsWith(':')) return { type: 'tabstop', index, default: source };

  // Not a shape the tokeniser claims to understand: keep the whole thing as a
  // default so nothing is lost and nothing is invented.
  return { type: 'tabstop', index, default: tail };
}

/**
 * The group `${…}` that opens at `cursor`, and where it ends.
 *
 * The group's *content* is classified by {@link bracedTabstopNode}, and a
 * substitution it carries is the whole reason this returns `end` rather than
 * letting the caller step past the brace: `${1/a/b/}` is one token, and reading
 * only up to the brace would leave `/a/b/` behind as text.
 *
 * A group whose content is neither an index nor a substitution is `null`, and
 * the tokeniser keeps it as text — the reader here only claims the shapes it
 * understands.
 */
function readBracedGroup(text: string, cursor: number): { node: TabstopBodyNode; end: number } | null {
  const open = cursor + 2;
  const brace = groupEnd(text, open);
  if (brace < 0) return null;

  const content = text.slice(open, brace);
  // A substitution is written after the group, `${1}/re/f/`, so it is read from
  // the closing brace rather than from the content.
  const trailing = transformSuffix(text, brace + 1);
  const end = trailing.suffix === '' ? brace + 1 : trailing.end;

  const index = /^(\d+)/.exec(content);
  if (!index) {
    // `${/a/b/}` names no tab stop, so the only reading that is not a guess is
    // the one where the substitution belongs to the group anyway: tab stop 1.
    if (trailing.suffix === '') return null;
    return { node: { type: 'tabstop', index: 1, transform: trailing.suffix }, end };
  }

  const node = bracedTabstopNode(Number(index[1]), content.slice(index[0].length));
  if (node.transform === undefined && trailing.suffix !== '') node.transform = trailing.suffix;
  return { node, end };
}

/**
 * The expression node a group that carries a substitution describes, when a code
 * block follows it.
 *
 * `` `${1:1/a/b/}` `` and `` `${1/a/b/}` `` ``rv = "x"`` `` are the same token to
 * the ported reader — it appends the block's own text and then finds the
 * placeholder over an empty range — so a group with a substitution and a block
 * after it is an expression node rather than a tab stop.
 *
 * Returns `null` when the group carries no substitution or no block follows,
 * which is the caller's cue to use the group as the tab stop it is.
 */
function substitutionOverBlock(
  text: string,
  group: { node: TabstopBodyNode; end: number }
): { node: ExpressionBodyNode; end: number } | null {
  if (group.node.transform === undefined) return null;
  const code = readCodeBlockAt(text, group.end);
  if (!code) return null;

  return {
    node: {
      type: 'expression',
      expression: { language: 'javascript-expression', code: code.code },
      index: group.node.index,
      transform: group.node.transform
    },
    end: code.end
  };
}

/**
 * Turns `.hsnips` body text into body nodes.
 *
 * Text that is not a tab stop is preserved exactly, including a `\x60` escape a
 * hand-written file used: that escape is part of how the body *text* spells a
 * literal backtick, so resolving it here would quietly move a code block.
 *
 * A substitution is folded into the tab stop it belongs to, because that is what
 * it means: `/re/f/` after `$1` says "mirror tab stop 1, substituted", and a
 * text node holding it would render back as text the engine reads as a mirror.
 */
export function tokenizeBody(text: string): BodyNode[] {
  const nodes: BodyNode[] = [];
  let pending = '';

  const flush = () => {
    if (pending.length > 0) {
      nodes.push({ type: 'text', value: pending });
      pending = '';
    }
  };

  let cursor = 0;
  while (cursor < text.length) {
    const character = text[cursor];

    if (character === '`') {
      const block = readCodeBlockAt(text, cursor);
      if (block) {
        flush();
        nodes.push({ type: 'javascript', code: block.code });
        cursor = block.end;
        continue;
      }
    }

    if (character === '$') {
      // `\$` is how a snippet body writes a literal dollar sign, and it is *two*
      // characters of body text — the engine renders it as one `$` when it
      // compiles the body. Both are kept verbatim so the body round-trips.
      if (text[cursor - 1] === '\\') {
        pending += character;
        cursor += 1;
        continue;
      }

      const visual = /^\$\{VISUAL(?::([^{}]*))?\}/.exec(text.slice(cursor));
      if (visual) {
        flush();
        const selection: SelectionBodyNode = { type: 'selection' };
        if (visual[1] !== undefined && visual[1] !== '') selection.default = visual[1];
        nodes.push(selection);
        cursor += visual[0].length;
        continue;
      }

      const plain = /^\$(\d+)/.exec(text.slice(cursor));
      if (plain) {
        flush();
        const node: TabstopBodyNode = { type: 'tabstop', index: Number(plain[1]) };
        const suffix = transformSuffix(text, cursor + plain[0].length);
        if (suffix.suffix !== '') node.transform = suffix.suffix;
        nodes.push(node);
        cursor = suffix.suffix === '' ? cursor + plain[0].length : suffix.end;
        continue;
      }

      const braced = /^\$\{(\d+)/.exec(text.slice(cursor));
      if (braced) {
        const group = readBracedGroup(text, cursor);
        if (group) {
          flush();
          // A group that carries a substitution and is followed by a block is an
          // expression node; otherwise it is the tab stop it reads as.
          const overBlock = substitutionOverBlock(text, group);
          if (overBlock) {
            nodes.push(overBlock.node);
            cursor = overBlock.end;
            continue;
          }
          nodes.push(group.node);
          cursor = group.end;
          continue;
        }
      }
    }

    pending += character;
    cursor += 1;
  }

  flush();
  return nodes;
}

/**
 * The code block that begins at `cursor`.
 *
 * A backtick run opens a block and a run at least as long closes it, which is
 * what the ported parser looks for. An unterminated block runs to the end of the
 * body, and one that is unterminated does not contribute the final characters to
 * its code: trimming a closing delimiter that is not there would silently drop
 * the tail of the code.
 */
function readCodeBlockAt(text: string, cursor: number): { code: string; end: number } | null {
  if (!text.startsWith(DELIMITER, cursor)) return null;
  const start = cursor + DELIMITER.length;
  const close = text.indexOf(DELIMITER, start);
  const end = close < 0 ? text.length : close + DELIMITER.length;
  return { code: text.slice(start, close < 0 ? end : close), end };
}

/** Whether the body is `.hsnips` source text rather than structured nodes. */
export function isSourceBody(body: SnippetBody): body is string {
  return typeof body === 'string';
}

/**
 * A body as nodes, whichever form it is written in.
 *
 * A structured body is *not* taken at its word. It is rendered and read back
 * through {@link tokenizeBody}, the same reader a string body goes through, so
 * the nodes the editor shows are the ones the engine will actually run: a text
 * node that spells `${1|x,y}` becomes a choice tab stop, and a nested default —
 * which the `.hsnips` reader stops at the first brace, because the ported parser
 * does — is reported as the text it really is rather than being displayed as
 * something the expansion will not do.
 */
export function tokenizeStructured(body: SnippetBody): BodyNode[] {
  return tokenizeBody(renderBody(body));
}

/**
 * Every substitution a body carries, in the order it carries them.
 *
 * A substitution is preserved through both body forms and reaches the engine,
 * which reads it as a mirror and emits no text for it — there is no live tab stop
 * to substitute in a plain-text buffer. Walking the body is how the editor can
 * say that, rather than leaving the author to wonder why `/[0-9]+/N/` produced
 * nothing.
 */
export function bodySubstitutions(body: SnippetBody): string[] {
  const found: string[] = [];
  const visit = (nodes: readonly BodyNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'tabstop') {
        if (node.transform !== undefined) found.push(node.transform);
        if (Array.isArray(node.default)) visit(node.default);
      } else if (node.type === 'expression') {
        if (node.transform !== undefined) found.push(node.transform);
      }
    }
  };
  visit(tokenizeStructured(body));
  return found;
}

/** Every tab stop index a body uses, sorted, for the editor's summary line. */
export function tabstopIndices(body: SnippetBody): number[] {
  const indices = new Set<number>();
  for (const node of typeof body === 'string' ? tokenizeBody(body) : body) {
    if (node.type === 'tabstop') indices.add(node.index);
  }
  return [...indices].sort((a, b) => a - b);
}
