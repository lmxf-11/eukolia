// Ported from References/hypersnips/src/hsnippet.ts (MIT, (c) 2019 Ian Ornelas). Modified for Eukolia.

export type GeneratorResult = [(string | { block: number })[], string[]];
/**
 * A compiled snippet body.
 *
 * `context` is the generated file's unused first slot — the reference bound
 * Node's `require` there and Eukolia deliberately passes `undefined`, so live
 * calls supply `(undefined, texts, matchGroups, workspaceUri, fileUri)`.
 * `SnippetExpansion` is the only caller.
 */
export type GeneratorFunction = (
  context: undefined,
  texts: string[],
  matchGroups: string[],
  workspaceUri: string,
  fileUri: string
) => GeneratorResult;

// Represents a snippet template from which new instances can be created.
export class HSnippet {
  trigger: string;
  description: string;
  generator: GeneratorFunction;
  regexp?: RegExp;
  placeholders: number;
  /**
   * Eukolia addition: the text each tab stop starts with, in document order.
   *
   * A code block is handed `t` — the tab stops' text — and the *first* expansion
   * has no parts yet to read it from, so the body's own defaults are carried here
   * by the parser. Without them the first expansion passed empty strings, and a
   * block written against `t[0]` printed `undefined` until the author typed
   * something.
   */
  placeholderDefaults: string[] = [];
  priority: number;

  // UltiSnips-like options.
  automatic = false;
  multiline = false;
  inword = false;
  wordboundary = false;
  beginningofline = false;
  math = false;
  nonmath = false;
  hidden = false;

  /** Raw header text (`snippet ... "..." flags`), retained for Eukolia tooling. */
  headerLine = '';
  /** Source file / source name this snippet was parsed from. */
  sourceName = '';
  /**
   * Eukolia addition: the managed snippet's `id`, when the library gave it one.
   *
   * A `.hsnips` header has no room for an id, so this cannot survive a parse —
   * it is set by `loadEusnipsIntoEngine` after the engine has compiled a source,
   * matching each `HSnippet` back to the entry it came from. It is what lets
   * something that only holds an expanded `HSnippet` (the trigger history, the
   * completion list) name the library entry to open for editing. `null` for a
   * snippet from a hand-written `.hsnips` file, which has no entry to open.
   */
  id: string | null = null;

  /**
   * Eukolia addition: what the matcher can tell about `regexp` without running it.
   *
   * Every snippet in the library is examined on every keystroke, so the analysis
   * of a pattern (is the whole of it literal text? what does it start with?) is
   * done once and kept here rather than recomputed — and kept *on the snippet*
   * rather than in a side table, because a property read is a fraction of the cost
   * of a map lookup and this is on the typing path. `forSource`/`forFlags` record
   * what it was computed from, so a replaced or recompiled `regexp` (see
   * `applyRegexFlags`) invalidates it without anyone having to remember to.
   */
  patternShape?: PatternShape;

  constructor(header: IHSnippetHeader, generator: GeneratorFunction, placeholders: number) {
    this.description = header.description;
    this.generator = generator;
    this.placeholders = placeholders;
    this.priority = header.priority || 0;

    if (header.trigger instanceof RegExp) {
      this.regexp = header.trigger;
      this.trigger = '';
    } else {
      this.trigger = header.trigger;
    }

    if (header.flags.includes('A')) this.automatic = true;
    if (header.flags.includes('M')) this.multiline = true;
    if (header.flags.includes('i')) this.inword = true;
    if (header.flags.includes('w')) this.wordboundary = true;
    if (header.flags.includes('b')) this.beginningofline = true;
    if (header.flags.includes('m')) this.math = true;
    if (header.flags.includes('h')) this.hidden = true;
    if (header.flags.includes('n')) this.nonmath = true;
  }
}

export interface IHSnippetHeader {
  trigger: string | RegExp;
  description: string;
  flags: string;
  priority?: number;
}

/**
 * What a snippet's pattern can be recognised by, without running it.
 *
 * `literal` is the whole pattern as text when it is nothing but text (`null`
 * otherwise), `prefix` the leading run of literal characters, and `plain` whether
 * the flags allow a literal comparison to stand in for the regex at all. See
 * `shapeOf` in `completion.ts` for how the matcher uses them.
 */
export interface PatternShape {
  literal: string | null;
  prefix: string;
  plain: boolean;
  /**
   * The literal character that must sit immediately before the caret for this
   * pattern to match, when the pattern's end is known to be literal. `null` when
   * the pattern ends in a quantifier, group or character class (`\d$`, `.*$`).
   */
  trailingChar: string | null;
  /** The pattern source and flags this was computed from. */
  forSource: string;
  forFlags: string;
}

/** Stores the original `.hsnips` body of a snippet, keyed by `HSnippet` identity. */
const snippetBodies = new WeakMap<HSnippet, string>();

export function setSnippetBody(snippet: HSnippet, body: string): void {
  snippetBodies.set(snippet, body);
}

export function getSnippetBody(snippet: HSnippet): string {
  return snippetBodies.get(snippet) ?? '';
}
