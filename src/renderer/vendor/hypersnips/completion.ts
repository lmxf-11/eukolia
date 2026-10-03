// Ported from References/hypersnips/src/completion.ts (MIT, (c) 2019 Ian Ornelas). Modified for Eukolia.

import * as vscode from 'vscode';
import { lineRange } from './utils';
import { HSnippet, type PatternShape } from './hsnippet';
import type { TextDocumentLike } from './hsnippetInstance';

/**
 * Eukolia modification: the reference read `hsnips.multiLineContext` from the
 * VS Code configuration on every multiline match, which needs an installed
 * compatibility host. The value is now overridable and cached; the default
 * matches the reference extension's `package.json` (`default: 20`).
 */
let multiLineContextLines = 20;

export function setMultiLineContext(lines: number): void {
  if (Number.isFinite(lines) && lines > 0) multiLineContextLines = lines;
}

export function getMultiLineContext(): number {
  try {
    const configured = vscode.workspace.getConfiguration('hsnips').get('multiLineContext') as number;
    if (typeof configured === 'number' && configured > 0) return configured;
  } catch {
    /* no compatibility host installed — fall back to the Eukolia default */
  }
  return multiLineContextLines;
}

export class CompletionInfo {
  range: vscode.Range;
  completionRange: vscode.Range;
  snippet: HSnippet;
  label: string;
  groups: string[];

  constructor(snippet: HSnippet, label: string, range: vscode.Range, groups: string[]) {
    this.snippet = snippet;
    this.label = label;
    this.range = range;
    this.completionRange = new vscode.Range(range.start, range.start.translate(0, label.length));
    this.groups = groups;
  }

  toCompletionItem() {
    let completionItem = new vscode.CompletionItem(this.label);
    completionItem.kind = vscode.CompletionItemKind.Snippet;
    completionItem.range = this.range;
    completionItem.detail = this.snippet.description;
    completionItem.insertText = this.label;
    completionItem.command = {
      command: 'hsnips.expand',
      title: 'expand',
      arguments: [this],
    };

    return completionItem;
  }
}

function matchSuffixPrefix(context: string, trigger: string) {
  while (trigger.length) {
    if (context.endsWith(trigger)) return trigger;
    trigger = trigger.substring(0, trigger.length - 1);
  }

  return null;
}

/**
 * Eukolia modification: `i` / `w` / `b` constrain a regular expression too.
 *
 * The reference asked the boundary questions — how much of the text before the
 * cursor does this match have to be? — only on the literal path, so a pattern
 * could not say "the whole word" or "the start of the line" even though the very
 * same letters were sitting in the header. Eukolia has one kind of trigger (a
 * pattern), which makes the question part of every snippet rather than part of
 * one kind of snippet, so it is answered here for both paths.
 *
 * The three facts are the literal path's own: where the match begins on the
 * caret's line, where the token before the caret begins, and where the word at
 * the caret begins. A match that started on an earlier line covers the whole of
 * the caret's line by construction — that is what a multi-line pattern does — and
 * is therefore accepted as it stands.
 */
function boundaryAccepts(
  snippet: HSnippet,
  matchStartColumn: number,
  contextColumn: number,
  wordColumn: number,
  isPrecedingContextWhitespace: boolean,
  line: string
): boolean {
  if (snippet.inword) return true;
  if (snippet.wordboundary) {
    if (matchStartColumn === wordColumn) return true;
    // Eukolia modification: a pattern may begin with punctuation that is glued to
    // the word the caret is in — every LaTeX trigger does, `\alpha` starting one
    // character before the word `alpha`. Requiring the match to begin exactly at
    // the word made the whole `w` boundary unsatisfiable for those patterns, so
    // they never fired at all. The match may therefore start a little earlier,
    // provided everything between is punctuation rather than word characters or
    // whitespace: `\alpha` is the word with its backslash, while `staff` is still
    // not `ff`.
    if (matchStartColumn > wordColumn) return false;
    for (let at = matchStartColumn; at < wordColumn; at++) {
      if (/[\w\s]/.test(line[at] ?? '')) return false;
    }
    return true;
  }
  if (snippet.beginningofline) {
    return matchStartColumn === contextColumn && isPrecedingContextWhitespace;
  }
  return matchStartColumn === contextColumn;
}

/**
 * Where a match begins on the line the caret is on.
 *
 * `-1` when the match started on an earlier line, which is the multi-line case
 * {@link boundaryAccepts} accepts as it stands.
 */
function matchStartOnLine(match: RegExpExecArray, contextText: string): number {
  const newline = match[0].lastIndexOf('\n');
  if (newline !== -1) return -1;
  return contextText.length - match[0].length;
}

/**
 * A pattern's source without the header's anchor, when it has one.
 *
 * A bare `endsWith('$')` cannot tell the anchor from a *literal* dollar —
 * `\$[^$]*\$` ends with an escaped one — and reading that as anchored is how an
 * inline-mathematics pattern came to be matched with no anchor at all, which then
 * swallowed the text after the match. The backslash run before the `$` decides:
 * odd escapes it, even leaves it as the anchor. (`eusnips/hsnips.ts` applies the
 * same rule when it writes the header.)
 */
export function stripAnchor(source: string): string {
  if (!source.endsWith('$')) return source;
  let backslashes = 0;
  for (let i = source.length - 2; i >= 0 && source[i] === '\\'; i--) backslashes += 1;
  return backslashes % 2 === 0 ? source.slice(0, -1) : source;
}

/**
 * Eukolia modification: the literal text a pattern starts with.
 *
 * A pattern trigger has no prefix in the sense a literal one has — `\w+bf` has
 * nothing to match until it matches — so a snippet that is *not* automatic could
 * never appear in the completion list, which is the only place it can be reached
 * from. The leading literal text is what the reader is actually typing, and it is
 * what the list can match on: while `b` of `bf` is being typed the pattern below
 * has not matched yet, but the list can still say "this one starts with `bf`".
 *
 * Only a leading run of literal characters is read: the scan stops at the first
 * metacharacter, at a character class, at an escape that means something other
 * than itself (`\w`, `\d`), and at an alternation or a group. `\*` contributes a
 * literal `*`, and `\\` a literal backslash.
 */
export function leadingLiteral(source: string): string {
  const stripped = stripAnchor(source);
  let literal = '';
  for (let i = 0; i < stripped.length; i++) {
    const char = stripped[i];
    if (char === '\\') {
      const next = stripped[i + 1];
      if (next === undefined) break;
      if (/[.*+?^${}()|[\]\\]/.test(next)) {
        literal += next;
        i++;
        continue;
      }
      break;
    }
    if (/[.*+?^${}()|[\]\\]/.test(char)) break;
    literal += char;
  }
  return literal;
}

/**
 * Eukolia modification: how a pattern can be recognised without running it.
 *
 * Every snippet in the library is tried on every keystroke, and a pattern is the
 * expensive way to ask "does this text end with `ff`?" — 856 `RegExp.exec` calls
 * per keystroke for the library Eukolia ships with, measured at 0.25–0.5 ms and
 * growing with every snippet the user adds. Most patterns are *text*: the editor
 * escapes what the author typed, so `\alpha`, `%` and `bf` arrive as literal
 * regexes with an anchor on the end.
 *
 * Such a pattern has an exact string equivalent — "the line ends with this text" —
 * and one that cannot be wrong, because a literal pattern with nothing but the
 * anchor has exactly one way to match. The shape is computed once per parsed
 * snippet and cached, so the per-keystroke cost is a `endsWith` call.
 *
 * A pattern that is not literal still has to be run, but its *leading* literal
 * text is a necessary condition — a match starts with it, so the text it matched
 * contains it — and `String#includes` rejects the overwhelming majority of
 * non-matching text without invoking the regex engine.
 */

/**
 * The literal character that must sit at the end of the match when the pattern
 * is anchored with `$` and ends with literal text or an escaped character.
 * `null` when the pattern ends with a quantifier, class or group (`\d$`, `.*$`).
 */
export function trailingLiteralChar(source: string): string | null {
  if (!source.endsWith('$')) return null;
  let backslashesBeforeDollar = 0;
  for (let i = source.length - 2; i >= 0 && source[i] === '\\'; i--) {
    backslashesBeforeDollar++;
  }
  if (backslashesBeforeDollar % 2 === 1) {
    return '$';
  }

  const body = source.slice(0, -1);
  if (!body.length) return null;

  const lastIdx = body.length - 1;
  const lastChar = body[lastIdx];

  let backslashes = 0;
  for (let i = lastIdx - 1; i >= 0 && body[i] === '\\'; i--) {
    backslashes++;
  }

  if (backslashes % 2 === 1) {
    if (/[dswbDSWB]/.test(lastChar)) return null;
    if (lastChar === 'n') return '\n';
    if (lastChar === 't') return '\t';
    if (lastChar === 'r') return '\r';
    return lastChar;
  }

  if (/[.*+?^${}()|[\]\\]/.test(lastChar)) {
    return null;
  }

  return lastChar;
}

function shapeOf(snippet: HSnippet): PatternShape {
  const source = snippet.regexp?.source ?? '';
  const flags = snippet.regexp?.flags ?? '';
  const cached = snippet.patternShape;
  if (cached && cached.forSource === source && cached.forFlags === flags) return cached;

  let shape: PatternShape = {
    literal: null,
    prefix: '',
    plain: false,
    trailingChar: null,
    forSource: source,
    forFlags: flags,
  };
  if (snippet.regexp) {
    // `g` and `y` carry `lastIndex` between calls, and `i` makes a literal
    // comparison mean something different from the regex.
    const plain = !/[giy]/.test(flags);
    const literal = plain ? literalSource(source) : null;
    const trailingChar = literal !== null
      ? (literal.length > 0 ? literal[literal.length - 1] : null)
      : trailingLiteralChar(source);
    shape = {
      literal,
      prefix: literal ?? leadingLiteral(source),
      plain,
      trailingChar,
      forSource: source,
      forFlags: flags,
    };
  } else if (snippet.trigger) {
    shape = {
      literal: snippet.trigger,
      prefix: snippet.trigger,
      plain: true,
      trailingChar: snippet.trigger.length > 0 ? snippet.trigger[snippet.trigger.length - 1] : null,
      forSource: '',
      forFlags: '',
    };
  }

  snippet.patternShape = shape;
  return shape;
}

/**
 * The pattern as literal text, when the whole of it is literal.
 *
 * `null` as soon as anything in it means more than itself. A trailing `$` is the
 * anchor the header parser appends and is not part of the text; a `\$` before it
 * would be a literal dollar, which is why the check is on the escape before it.
 */
function literalSource(source: string): string | null {
  const body = stripAnchor(source);
  let literal = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '\\') {
      const next = body[i + 1];
      if (next === undefined) return null;
      if (!/[.*+?^${}()|[\]\\]/.test(next)) return null;
      literal += next;
      i++;
      continue;
    }
    if (/[.*+?^${}()|[\]\\]/.test(char)) return null;
    literal += char;
  }
  return literal;
}

/**
 * A literal match, shaped like the `RegExp.exec` result the caller expects.
 *
 * The rest of the loop reads `match[0]`, `match.index`, `match.length` and the
 * capture groups; a literal pattern has one group — the whole match — so an array
 * carrying the matched text and where it began is the same thing the engine would
 * have produced, without compiling or running anything.
 */
function literalMatch(text: string, index: number): RegExpExecArray {
  const match = [text] as unknown as RegExpExecArray;
  match.index = index;
  match.input = text;
  return match;
}

export interface GetCompletionsOptions {
  /** If true, only matches snippets with `snippet.automatic === true`. Suggestions are not collected. */
  automaticOnly?: boolean;
  /**
   * The single character just typed at `position`, if known.
   * Enables fast-path rejection of snippets whose trigger cannot match.
   */
  typedChar?: string;
}

export function getCompletions(
  document: TextDocumentLike,
  position: vscode.Position,
  snippets: HSnippet[],
  options?: GetCompletionsOptions
): { auto: CompletionInfo[]; suggestions: CompletionInfo[] } {
  let line = document.getText(lineRange(0, position));

  // Grab everything until previous whitespace as our matching context.
  let match = line.match(/\S*$/);
  let contextRange = lineRange((match as RegExpMatchArray).index || 0, position);
  let context = document.getText(contextRange);
  let precedingContextRange = new vscode.Range(
    position.line,
    0,
    position.line,
    (match as RegExpMatchArray).index || 0
  );
  let precedingContext = document.getText(precedingContextRange);
  let isPrecedingContextWhitespace = precedingContext.match(/^\s*$/) != null;

  let longContext: string | null = null;

  const wordRange = getWordRange(document, position) ?? contextRange;
  const wordContext = document.getText(trimRange(wordRange, position));

  let auto: CompletionInfo[] = [];
  let suggestions: CompletionInfo[] = [];

  for (let snippet of snippets) {
    if (options?.automaticOnly && !snippet.automatic) continue;

    const shape = shapeOf(snippet);
    if (options?.typedChar && shape.trailingChar !== null) {
      if (shape.trailingChar !== options.typedChar) {
        continue;
      }
    }

    let snippetMatches = false;
    let snippetRange = contextRange;
    let prefixMatches = false;

    // Eukolia modification: the label and the match groups are only built when a
    // snippet has something to report. They used to be set up for every snippet
    // in the library before the match was even attempted, and the `CompletionInfo`
    // below was constructed unconditionally — three objects and two `Range`s per
    // snippet per keystroke, all but a handful thrown away. With a thousand-entry
    // library that was the *whole* cost of the scan: the matcher measured the same
    // 0.15 ms whether the patterns were text or regular expressions, because the
    // running of them was never what took the time.
    let matchGroups: string[] = [];
    let label = snippet.trigger;

    if (snippet.trigger) {
      let matchingPrefix = null;

      if (snippet.inword) {
        snippetMatches = context.endsWith(snippet.trigger);
        matchingPrefix = snippetMatches
          ? snippet.trigger
          : matchSuffixPrefix(context, snippet.trigger);
      } else if (snippet.wordboundary) {
        snippetMatches = wordContext == snippet.trigger;
        matchingPrefix = snippet.trigger.startsWith(wordContext) ? wordContext : null;
      } else if (snippet.beginningofline) {
        snippetMatches = context.endsWith(snippet.trigger) && isPrecedingContextWhitespace;
        matchingPrefix =
          snippet.trigger.startsWith(context) && isPrecedingContextWhitespace ? context : null;
      } else {
        snippetMatches = context == snippet.trigger;
        matchingPrefix = snippet.trigger.startsWith(context) ? context : null;
      }

      if (matchingPrefix) {
        snippetRange = new vscode.Range(position.translate(0, -matchingPrefix.length), position);
        prefixMatches = true;
      }
    } else if (snippet.regexp) {
      let regexContext = line;

      if (snippet.multiline) {
        if (longContext == null) {
          const numberPrevLines = getMultiLineContext();

          longContext = document
            .getText(
              new vscode.Range(
                new vscode.Position(Math.max(position.line - numberPrevLines, 0), 0),
                position
              )
            )
            .replace(/\r/g, '');
        }

        regexContext = longContext;
      }

      // The shape is read before the pattern is run, because it is what decides
      // whether running it is necessary at all (see `shapeOf`).
      const shape = shapeOf(snippet);
      let match: RegExpExecArray | null = null;
      if (shape.literal !== null && !snippet.multiline) {
        // The pattern is text with the header's anchor on it, so the answer is
        // whether the line up to the caret ends with that text. `\r` is stripped
        // for the same reason the regex path sees it stripped.
        const literal = shape.literal;
        const haystack = regexContext.endsWith('\r') ? regexContext.slice(0, -1) : regexContext;
        if (literal.length > 0 && haystack.endsWith(literal)) {
          match = literalMatch(literal, haystack.length - literal.length);
        }
      } else if (shape.plain && shape.prefix.length > 0 && !regexContext.includes(shape.prefix)) {
        // A match must begin with the leading literal text, so a line that does
        // not contain it anywhere cannot match. Necessary, not sufficient — the
        // pattern still decides — but it rejects most of a large library for the
        // price of a substring search.
        match = null;
      } else {
        match = snippet.regexp.exec(regexContext);
      }

      if (match) {
        let charOffset = match.index - regexContext.lastIndexOf('\n', match.index) - 1;
        let lineOffset = match[0].split('\n').length - 1;

        // Eukolia modification: the boundary letters constrain a pattern the same
        // way they constrain a literal trigger. `contextColumn` is where the token
        // before the caret begins, `wordColumn` where the word does, and a match
        // that began on an earlier line (-1) is judged on the multi-line context it
        // matched rather than on this line.
        const matchColumn = matchStartOnLine(match, line);
        if (
          matchColumn !== -1 &&
          !boundaryAccepts(
            snippet,
            matchColumn,
            line.length - context.length,
            line.length - wordContext.length,
            isPrecedingContextWhitespace,
            line
          )
        ) {
          continue;
        }

        snippetRange = new vscode.Range(
          new vscode.Position(position.line - lineOffset, charOffset),
          position
        );
        snippetMatches = true;
        matchGroups = match;
        label = match[0];
        // Eukolia modification: a manual trigger is reached from the completion
        // list, and a complete match is exactly what the list should be offering
        // then. The reference offered a pattern only through the automatic path,
        // which left every non-`A` pattern unreachable — invisible rather than
        // manual.
        if (!snippet.automatic) prefixMatches = true;
      } else {
        // No match yet. A snippet that is not automatic is reached from the
        // completion list, so the list has to be able to offer it *before* the
        // pattern matches — otherwise turning `A` off would make an entry
        // unreachable rather than manual. The leading literal text is what the
        // reader is typing, and it is matched the way a literal trigger is.
        const literal = shape.prefix;
        if (literal.length > 0) {
          const prefix = snippet.wordboundary
            ? literal.startsWith(wordContext)
              ? wordContext
              : null
            : literal.startsWith(context)
              ? context
              : null;
          if (prefix != null && prefix.length > 0) {
            snippetRange = new vscode.Range(position.translate(0, -prefix.length), position);
            prefixMatches = true;
          }
        }
      }
    }

    if (snippet.automatic && snippetMatches) {
      auto.push(new CompletionInfo(snippet, label, snippetRange, matchGroups));
    } else if (!options?.automaticOnly && prefixMatches && !snippet.hidden) {
      suggestions.push(new CompletionInfo(snippet, label, snippetRange, matchGroups));
    }
  }

  return { auto, suggestions };
}

/**
 * Eukolia modification: `document.getWordRangeAtPosition` is a VS Code API the
 * ported `TextDocumentLike` seam does not require, so it is optional here and
 * the reference's default word pattern is used as the fallback.
 */
function getWordRange(
  document: TextDocumentLike,
  position: vscode.Position
): vscode.Range | undefined {
  const candidate = (document as { getWordRangeAtPosition?: (p: vscode.Position) => vscode.Range | undefined })
    .getWordRangeAtPosition;
  if (typeof candidate === 'function') {
    try {
      const range = candidate.call(document, position);
      if (range) return range;
    } catch {
      /* fall through to the default word pattern */
    }
  }

  const lineText = lineTextAt(document, position.line);
  const wordRegex = /[A-Za-z0-9_]+/g;
  let match: RegExpExecArray | null;
  while ((match = wordRegex.exec(lineText)) !== null) {
    if (match.index <= position.character && match.index + match[0].length >= position.character) {
      return new vscode.Range(position.line, match.index, position.line, match.index + match[0].length);
    }
    if (match.index > position.character) break;
  }
  return undefined;
}

function lineTextAt(document: TextDocumentLike, line: number): string {
  try {
    const info = document.lineAt(line);
    if (typeof info?.text === 'string') return info.text;
  } catch {
    /* document seam without lineAt — fall back to a full-text read */
  }
  return document.getText(new vscode.Range(line, 0, line + 1, 0)).replace(/\r?\n$/, '');
}

function trimRange(range: vscode.Range, position: vscode.Position): vscode.Range {
  if (range.end.isEqual(position)) return range;
  return new vscode.Range(range.start, position);
}
