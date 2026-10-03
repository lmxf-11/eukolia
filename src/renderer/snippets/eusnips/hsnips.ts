/**
 * Eukolia — projecting EUSnips onto the ported HyperSnips engine.
 *
 * The engine's own entry point is `.hsnips` source text: `parse()` compiles a
 * document into `HSnippet` objects and, in doing so, builds the restricted-scope
 * evaluator that every code block runs inside. Rather than duplicate that
 * (and risk the two drifting), the manager compiles each snippet back to a
 * header and a body and lets the engine do what it already does.
 *
 * Two properties the engine knows but the `.hsnips` header cannot carry —
 * per-snippet priority and the `h` (hidden) flag — are applied to the parsed
 * `HSnippet` objects afterwards, in {@link loadEusnipsIntoEngine}. Priority is
 * Eukolia's own ordering anyway: the reference's `priority` directive is reset
 * after every snippet header, so a multi-snippet document can only ever have one.
 *
 * One engine limitation is *not* papered over here. `SnippetExpansion` recognises
 * tab stops written `$1` or `${1}` and treats everything else in a body —
 * `${1:default}`, `${1|a,b|}`, `${1/re/f/}`, `${VISUAL}` — as literal text. The
 * schema and the editor therefore express those forms, the file keeps them, and
 * `stripPlaceholders` renders them correctly in a preview, but the engine does
 * not turn them into live tab stops yet. See the report accompanying this work.
 */

import type { SnippetEngine } from '../engine';
import type { HSnippet } from '../../vendor/hypersnips';import { renderBody, type SnippetBody } from './body';
import type { EffectiveSnippet, NormalizedSnippetFile } from './model';

/** Marks a source as coming from the managed file rather than a `.hsnips` file. */
export const EUSNIPS_SOURCE_PREFIX = 'snippets.json';

/** The source name a language's snippets are loaded under. */
export function sourceNameFor(language: string): string {
  return `${EUSNIPS_SOURCE_PREFIX}#${language}`;
}

export interface RenderedSnippet {
  /** The header line and body, ready to be parsed by the ported parser. */
  document: string;
  /** Why the snippet could not be rendered faithfully, when it could not. */
  problem?: string;
}

/**
 * Whether a pattern already ends with the header's anchor.
 *
 * A bare `endsWith('$')` cannot tell the anchor from a *literal* dollar: the
 * pattern for "inline mathematics" is `\$[^$]*\$`, whose last character is an
 * escaped `$`. Reading that as anchored left the pattern unanchored, and since a
 * match's range always ends at the caret, typing after such a match deleted the
 * text that followed it. The backslash run before the `$` decides: an odd number
 * escapes it (`\$`, `\\\$`), an even number leaves it as the anchor (`$`, `\\$`).
 */
export function isAnchored(pattern: string): boolean {
  if (!pattern.endsWith('$')) return false;
  let backslashes = 0;
  for (let i = pattern.length - 2; i >= 0 && pattern[i] === '\\'; i--) backslashes += 1;
  return backslashes % 2 === 0;
}

/**
 * A regular expression as a header's backticked trigger.
 *
 * The header parser takes everything between two backticks and appends `$` unless
 * the pattern already ends with one, because a header has no way to say otherwise.
 * That is reported to the user by the editor rather than hidden here.
 */
export function anchorPattern(pattern: string): string {
  return isAnchored(pattern) ? pattern : `${pattern}$`;
}

/**
 * The text behind a header's bare trigger token.
 *
 * A `.hsnips` file written by hand may hold a plain token — `ff` — which the
 * engine matches as text. The format has no plain text trigger any more, so the
 * token has to become a pattern that matches it, and this is the inverse of the
 * escaping the old projection wrote: a token of `\.` was a full stop, and comes
 * back as one. It is only ever applied to tokens, never to a backticked pattern,
 * which is already a regular expression.
 */
export function unescapeHeaderTrigger(token: string): string {
  return token.replace(/\\([.*+?^${}()|[\]\\])/g, '$1');
}

/**
 * A description as a quoted header string.
 *
 * The header parser reads `"…"` up to the next quote and does *not* resolve
 * escapes inside it, so a description holding a backslash — LaTeX's own `\dots`,
 * `\item` — has to be written unescaped or it comes back with the backslash
 * doubled: one round trip through the file turned `\item on a newline` into
 * `\\item on a newline`. The one character the form cannot hold is a quote
 * itself, and that is escaped as the parser's own convention, for the sake of a
 * description a person can still read rather than a header that swallows the
 * flags after it.
 */
export function descriptionText(description: string): string {
  return description.includes('"') ? description.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : description;
}

/**
 * The source of a file's `globals.javascript`, as one string.
 *
 * The field is either one string or an array of lines (an imported `global` block
 * is kept as it was read), and the engine wants the code itself.
 */
export function globalsSource(globals: string | string[] | undefined): string {
  if (!globals) return '';
  const text = Array.isArray(globals) ? globals.join('\n') : globals;
  return text.trim().length > 0 ? text : '';
}

/**
 * A file's globals as the `global … endglobal` block the parser reads, or `''`.
 *
 * This is what puts a library's helper functions in scope for its code blocks.
 * The managed format keeps them in a `globals` object rather than in the source
 * text, and nothing used to write them back out — so a body calling
 * `openInlineMath(m, …)`, as the imported unified library's entries do, threw
 * `openInlineMath is not defined` on every expansion, and a generator that throws
 * inserts *nothing*: the matched text was deleted and the replacement never
 * arrived.
 */
export function globalsBlock(source: string): string {
  return source.length > 0 ? `global\n${source}\nendglobal\n` : '';
}

/**
 * Renders one snippet as a `.hsnips` document.
 *
 * Every trigger is a pattern now, so the trigger is always the backticked form.
 * The caller is expected to have run {@link regexTriggerProblem} and
 * {@link anchorPattern} already; this function assumes a renderable snippet.
 *
 * `globals` is the file's {@link globalsSource}, written ahead of the snippet so
 * that parsing this document defines the helpers the body calls.
 */
export function renderSnippetDocument(
  snippet: EffectiveSnippet,
  globals = ''
): RenderedSnippet {
  const parts: string[] = ['snippet'];

  if (snippet.trigger.length > 0) {
    parts.push(`\`${anchorPattern(snippet.trigger)}\``);
  }

  if (snippet.description) {
    parts.push(`"${descriptionText(snippet.description)}"`);
  }

  const problem = triggerProblemFor(snippet);
  const document = `${globalsBlock(globals)}${parts.join(' ')}\n${renderBody(snippet.body)}\nendsnippet\n`;
  return problem ? { document, problem } : { document };
}

function triggerProblemFor(snippet: EffectiveSnippet): string | undefined {
  return regexTriggerProblem(snippet);
}

/** What a regular expression cannot be written as, if anything. */
function regexTriggerProblem(snippet: EffectiveSnippet): string | undefined {
  if (snippet.trigger.length === 0) return 'the pattern is empty';
  if (snippet.trigger.includes('`')) return 'the pattern contains a backtick';
  if (/[\r\n]/.test(snippet.trigger)) return 'the pattern contains a line break';
  return undefined;
}

/**
 * The `.hsnips` documents the engine's parser sees, one per language.
 *
 * The `language` is the source's *own* language rather than the snippet's, so
 * the engine's `all` handling (which copies a global source into every other
 * language) is what decides which snippets a document sees.
 *
 * `globals` is the library's `global … endglobal` code, written once at the top of
 * the document: a `global` block's declarations are shared with every snippet
 * that is compiled in the same file, which is the scope its code blocks expect.
 */
export function renderSnippetSources(
  snippets: readonly EffectiveSnippet[],
  language: string,
  globals = ''
): Array<{ name: string; content: string; language: string }> {
  const documents: string[] = [];
  for (const snippet of snippets) {
    if (triggerProblemFor(snippet)) continue;
    documents.push(renderSnippetDocument(snippet).document);
  }
  if (documents.length === 0) return [];
  return [
    {
      name: sourceNameFor(language),
      content: `${globalsBlock(globals)}${documents.join('\n')}`,
      language
    }
  ];
}

export interface LoadedSnippet {
  snippet: HSnippet;
  sourceName: string;
}

/**
 * Compiles a normalised file into the engine.
 *
 * Returns the `HSnippet` objects in the order they were loaded so a caller can
 * check what actually arrived, and so tests can assert on the projection without
 * going through an editor.
 */
export function loadEusnipsIntoEngine(
  engine: SnippetEngine,
  files: readonly NormalizedSnippetFile[]
): LoadedSnippet[] {
  const byLanguage = new Map<string, { snippets: EffectiveSnippet[]; globals: string[] }>();

  for (const normalized of files) {
    const language = normalized.language;
    const bucket = byLanguage.get(language) ?? { snippets: [], globals: [] };
    // Every file loaded for a language ends up in the one document, so its
    // globals do too — in load order, which is the order the files were given.
    const globals = globalsSource(normalized.file.globals?.javascript);
    if (globals) bucket.globals.push(globals);
    for (const snippet of normalized.snippets) {
      // Disabled snippets are simply not handed to the engine: the engine has no
      // notion of a switch, and dropping them here is what makes the toggle in
      // the editor take effect without a restart.
      if (!snippet.enabled) continue;
      bucket.snippets.push(snippet);
    }
    byLanguage.set(language, bucket);
  }

  const sources: Array<{ name: string; content: string; language: string }> = [];
  for (const [language, bucket] of byLanguage) {
    sources.push(...renderSnippetSources(bucket.snippets, language, bucket.globals.join('\n\n')));
  }
  if (sources.length === 0) {
    engine.loadSnippetSources([]);
    return [];
  }

  engine.loadSnippetSources(sources);

  // Reconcile identity: the engine keys snippets by language and re-sorts by
  // priority, and a hand-written file may hold two entries with the same trigger
  // that differ only by their bookkeeping. Matching on the anchored pattern in
  // file order is what keeps the adjustment pointed at the right object.
  //
  // The pool is indexed by that pattern rather than searched for each entry. The
  // search was `findIndex` over what was left, which is quadratic: a library of a
  // thousand entries spent three hundred thousand string comparisons here, on
  // every keystroke in the snippet manager and every trigger edited (measured at
  // 11.6 ms per load for 856 entries). A queue per pattern gives the same pairing
  // — first entry in the file with that pattern gets the first compiled snippet
  // with it — for one lookup each.
  const loaded: LoadedSnippet[] = [];
  const touched = new Set<string>();
  for (const [language, bucket] of byLanguage) {
    const sourceName = sourceNameFor(language);
    const pool = engine.getSnippets(language).filter((snippet) => snippet.sourceName === sourceName);
    const byPattern = new Map<string, HSnippet[]>();
    for (const snippet of pool) {
      const key = snippet.regexp?.source ?? snippet.trigger;
      const queue = byPattern.get(key);
      if (queue) queue.push(snippet);
      else byPattern.set(key, [snippet]);
    }
    for (const effective of bucket.snippets) {
      if (triggerProblemFor(effective)) continue;
      // The engine hands back the compiled pattern, and appends `$` to it, so the
      // comparison is made against the same anchored source the projection wrote.
      // Note: JavaScript RegExp.source escapes forward slashes ('/' -> '\/'), so
      // patterns containing slashes need fallback lookup against new RegExp(key).source.
      const key = anchorPattern(effective.trigger);
      let snippet = byPattern.get(key)?.shift();
      if (!snippet && key.includes('/')) {
        try {
          snippet = byPattern.get(new RegExp(key).source)?.shift();
        } catch {
          // invalid regex, ignore
        }
      }
      if (!snippet) continue;

      // Regex flags are the one property a header cannot carry: its letters are
      // all spoken for (`i` is in-word matching, not case-insensitivity), so the
      // pattern is parsed and then recompiled with the flags the file asked for.
      // Without this the stored flags would be decoration.
      applyRegexFlags(snippet, effective.regexFlags);
      // Everything else the entry says is applied here rather than carried in the
      // header as a flag letter. The header's letters were the engine's own
      // vocabulary — `A` for automatic, `i`/`w`/`b` for the boundary, `m`/`n` for
      // the context, `h`, `M` — and none of it belongs in the format the user
      // writes: the entry has a property for each of them, and this is where the
      // property reaches the compiled snippet the matcher reads.
      applyBehaviour(snippet, effective);
      if (snippet.priority !== effective.priority) {
        snippet.priority = effective.priority;
        touched.add(language);
      }
      // The library entry this compiled snippet came from. A parsed header cannot
      // carry an id, so the link is made here, where both sides are in hand — and
      // it is what the trigger history uses to open the right entry for editing.
      // Left as-is (an earlier load's id) when the file gave none, so a snippet
      // that never had an id is not given a misleading one.
      if (effective.id) snippet.id = effective.id;
      loaded.push({ snippet, sourceName });
    }
  }

  // The engine sorted by priority before the adjustment above, so a snippet whose
  // priority only the *file* could express would sit in the wrong place. Re-sort
  // the languages the adjustment touched; `getSnippets` hands back copies, so the
  // ordering is applied through `addSnippets`, which is the engine's own path.
  for (const language of touched) {
    engine.resortLanguage(language);
  }

  return loaded;
}

/** Whether a body would expand to nothing, which the editor warns about. */
export function isEmptyBody(body: SnippetBody): boolean {
  return renderBody(body).length === 0;
}

/**
 * Applies an entry's typed properties to the snippet the matcher reads.
 *
 * The ported snippet carries switches — `automatic`, `inword`, `wordboundary`,
 * `beginningofline`, `math`, `nonmath`, `multiline`, `hidden` — which its own
 * parser sets from the header's flag letters. The managed format has a property
 * for each of them (`expand`, `boundary`, `context`, `multiline`, `hidden`), and
 * this is where the property reaches the switch, so the letters are not part of
 * anything the user writes, reads or sees.
 */
export function applyBehaviour(snippet: HSnippet, effective: EffectiveSnippet): void {
  snippet.automatic = effective.expand === 'auto';
  snippet.multiline = effective.multiline !== false && effective.multiline !== undefined;
  snippet.hidden = effective.hidden;

  snippet.inword = effective.boundary === 'anywhere';
  snippet.wordboundary = effective.boundary === 'word';
  snippet.beginningofline = effective.boundary === 'line-start';

  // `math` / `nonmath` come from the *effective* context, which is what the
  // engine's own math-mode detection answers.
  snippet.math = effective.context === 'math';
  snippet.nonmath = effective.context === 'text';
}

/**
 * Recompiles a parsed snippet's pattern with the flags the file stored.
 *
 * The ported parser compiles a backticked trigger with `m` and nothing else,
 * because it has no other way to be told about regex flags. Those therefore
 * travel beside the pattern rather than inside it, and this is where they are put
 * back. The `m` the parser chose stays: multi-line matching depends on it.
 */
export function applyRegexFlags(snippet: HSnippet, flags: string): void {
  if (!snippet.regexp || flags.length === 0) return;
  // `g` and `y` are stateful: they keep a `lastIndex` between `exec` calls, and a
  // scan asks the same pattern about a new caret on every keystroke. Sharing one
  // compiled pattern with a live `lastIndex` made the snippet expand on every
  // *other* keystroke (`normalizeSnippetFile` reports the two letters rather than
  // letting them through silently).
  const wanted = new Set(`${snippet.regexp.flags}${flags.replace(/[gy]/g, '')}`.split(''));
  const compiled = [...wanted].join('');
  if (compiled === snippet.regexp.flags) return;
  try {
    snippet.regexp = new RegExp(snippet.regexp.source, compiled);
  } catch {
    // An unusable flag is reported by `normalizeSnippetFile` before it gets here;
    // keeping the pattern working matters more than honouring a flag that cannot
    // be compiled.
  }
}
