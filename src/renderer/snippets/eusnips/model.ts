/**
 * Eukolia — the EUSnips snippet model.
 *
 * This module owns the *shape* of a snippet file and the two directions between
 * it and the snippet engine:
 *
 *   EUSnips JSON  --normalize-->  effective snippet  --hsnips.ts-->  HSnippet
 *
 * The format is the one described by `./schema.json`, which is validated at
 * runtime by `./validate.ts`. Where the format and the ported HyperSnips syntax
 * disagree about how to *say* something, the format says it and the projection
 * in `./hsnips.ts` translates; where the engine simply cannot do something the
 * format names, {@link normalizeSnippetFile} reports it as a warning rather than
 * pretending, so the editor can tell the user which entries will not behave as
 * written.
 *
 * Serialising is deliberately boring: a fixed key order, two-space indentation
 * and a trailing newline, because `snippets.json` is a file people are expected
 * to read and to hand-edit.
 */

import {
  bodyLines,
  bodySubstitutions,
  renderBody,
  tabstopIndices,
  tokenizeBody,
  type BodyNode,
  type SnippetBody
} from './body';
import { validateSnippetFile, type ValidationIssue } from './validate';

// ---------------------------------------------------------------------------
// The file, as it is stored
// ---------------------------------------------------------------------------

/**
 * What has to be typed for a snippet to be offered.
 *
 * One property, holding a regular expression — there is no second kind of
 * trigger. The text a person types *is* a pattern (an `f` matches an `f`), and
 * the only thing the old plain-text kind asked for beyond that was how much of
 * the text before the cursor the match had to be, which `boundary` says for every
 * snippet now. Text that was written as text is escaped on the way in, so a `.`
 * in a trigger means a full stop.
 */
export interface EusnipsTrigger {
  /** The regular expression source, matched against the text before the cursor. */
  pattern: string;
  /** Regular-expression flags, added to the `m` the engine compiles with. */
  flags?: string;
}

export type EusnipsContextExpression =
  | 'any'
  | 'math'
  | 'text'
  | 'preamble'
  | 'comment'
  | { type: 'environment' | 'command' | 'document-class' | 'package'; name: string }
  | { not: EusnipsContextExpression }
  | { all: EusnipsContextExpression[] }
  | { any: EusnipsContextExpression[] };

export interface EusnipsSnippet {
  id?: string;
  trigger: EusnipsTrigger;
  description?: string;
  priority?: number;
  expand?: 'manual' | 'auto';
  boundary?: 'whitespace' | 'word' | 'anywhere' | 'line-start';
  hidden?: boolean;
  multiline?: boolean | number;
  context?: EusnipsContextExpression;
  body: SnippetBody;
  tags?: string[];
  enabled?: boolean;
  script?: { language: 'javascript'; code: string; run?: 'expand' | 'tabstop-change' | 'both' };
  metadata?: Record<string, unknown>;
}

export interface EusnipsDefaults {
  priority?: number;
  expand?: 'manual' | 'auto';
  boundary?: EusnipsSnippet['boundary'];
  hidden?: boolean;
  multiline?: boolean | number;
  context?: EusnipsContextExpression;
  enabled?: boolean;
  tags?: string[];
}

export interface EusnipsFile {
  version: 1;
  name?: string;
  description?: string;
  namespace?: string;
  language?: string;
  includes?: string[];
  defaults?: EusnipsDefaults;
  globals?: { javascript?: string | string[]; variables?: Record<string, string | number | boolean | null> };
  metadata?: Record<string, unknown>;
  snippets: EusnipsSnippet[];
}

// ---------------------------------------------------------------------------
// A snippet once the file's defaults have been applied
// ---------------------------------------------------------------------------

export interface EffectiveSnippet {
  id: string;
  /** The trigger: a regular expression source. */
  trigger: string;
  /** Flags the source is compiled with, on top of the engine's `m`. */
  regexFlags: string;
  description: string;
  priority: number;
  expand: 'manual' | 'auto';
  boundary: 'whitespace' | 'word' | 'anywhere' | 'line-start';
  hidden: boolean;
  multiline: boolean | number;
  context: EusnipsContextExpression;
  body: SnippetBody;
  tags: string[];
  enabled: boolean;
  /** The entry as it was read, so the editor can show what is really on disk. */
  source: EusnipsSnippet;
}

export interface EusnipsIssue {
  level: 'error' | 'warning';
  /** Index into `snippets`, or `null` for a file-level problem. */
  index: number | null;
  /** Snippet id when it has one, so a warning survives a reorder. */
  id?: string;
  message: string;
}

export interface NormalizedSnippetFile {
  file: EusnipsFile;
  snippets: EffectiveSnippet[];
  issues: EusnipsIssue[];
  /** Language the snippets apply to; `all` means every language. */
  language: string;
}

export const EUSNIPS_VERSION = 1;
export const DEFAULT_PRIORITY = 100;
export const DEFAULT_LANGUAGE = 'latex';
export const DEFAULT_BOUNDARY: EffectiveSnippet['boundary'] = 'anywhere';

/** Every context value the *engine* can actually act on. */
const ENGINE_CONTEXT_VALUES = new Set(['any', 'math', 'text']);

// ---------------------------------------------------------------------------
// Building and normalising
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A trigger's parts, as the rest of the code works with them.
 *
 * `pattern` is a regular expression source, always: there is one kind of trigger,
 * and everything that used to be plain text is escaped into this form on the way
 * in. `flags` is empty when the source carries none.
 */
export interface TriggerParts {
  pattern: string;
  flags: string;
}

/**
 * The characters a regular expression reads as syntax, escaped so they mean
 * themselves.
 *
 * This is what turns the text a person typed into a pattern that matches it.
 * `ff` needs nothing; `**`, `a.b` and `$` do — and without this a trigger written
 * as `...` would match any three characters rather than three full stops.
 */
export function escapeRegexText(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads a trigger, including every shape the format used before.
 *
 * `snippet.trigger` may be a bare string, `{type: 'literal', value, caseSensitive}`,
 * `{type: 'regex', pattern, flags}` or the merged-but-still-two-kinded
 * `{pattern, regex, flags, caseSensitive}` in a file that predates this one — the
 * user's own library among them. Reading them here, once, is what lets the rest
 * of the code have a single shape to deal with: no other function has to know
 * that a trigger was ever anything else. Text that was *matched as text* is
 * escaped on the way, which is the one conversion that makes the old shape mean
 * the same thing in the new one.
 */
export function splitTrigger(trigger: EusnipsTrigger | string | Record<string, unknown> | undefined): TriggerParts {
  if (typeof trigger === 'string') {
    return { pattern: escapeRegexText(trigger), flags: '' };
  }
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) {
    return { pattern: '', flags: '' };
  }

  const record = trigger as Record<string, unknown>;
  const flags = typeof record.flags === 'string' ? record.flags : '';
  // The superseded shapes carry a `type` discriminant and their text under a
  // different name; both are read back into `pattern`.
  const legacyType = record.type;
  if (legacyType === 'regex') {
    return { pattern: typeof record.pattern === 'string' ? record.pattern : '', flags };
  }
  if (legacyType === 'literal') {
    // `caseSensitive: false` was the plain text spelling of "either case", and
    // the `i` flag is what a regular expression says it with.
    const insensitive = record.caseSensitive === false && !flags.includes('i');
    return {
      pattern: escapeRegexText(typeof record.value === 'string' ? record.value : ''),
      flags: insensitive ? `${flags}i` : flags
    };
  }

  const pattern = typeof record.pattern === 'string' ? record.pattern : '';
  // `regex: false` said the pattern was text to match. It is text, and it is now
  // read as a pattern, so it is escaped — unless it was already the current
  // shape, which is recognised by the absence of the flag rather than by `false`:
  // a trigger written by this version never carries the property at all.
  const wasText = record.regex === false;
  const insensitive = record.caseSensitive === false && !flags.includes('i');
  return {
    pattern: wasText ? escapeRegexText(pattern) : pattern,
    flags: insensitive ? `${flags}i` : flags
  };
}

/**
 * Builds the stored trigger from the parts the editor works with.
 *
 * An empty `flags` is left out: it is not a setting, it is the absence of one, and
 * a file that states its defaults is a file with more to read and nothing more to
 * say.
 */
export function buildTrigger(pattern: string, flags?: string): EusnipsTrigger {
  return flags ? { pattern, flags } : { pattern };
}

function contextFromFlags(math: boolean, nonmath: boolean): EusnipsContextExpression {
  if (math && !nonmath) return 'math';
  if (nonmath && !math) return 'text';
  return 'any';
}

/** The context entry the ported engine can act on for a snippet, if there is one. */
export function engineContext(
  context: EusnipsContextExpression
): 'any' | 'math' | 'text' | undefined {
  if (typeof context === 'string') {
    return ENGINE_CONTEXT_VALUES.has(context) ? (context as 'any' | 'math' | 'text') : undefined;
  }
  if (isObject(context) && 'not' in context) {
    const inner = engineContext((context as { not: EusnipsContextExpression }).not);
    if (inner === 'math') return 'text';
    if (inner === 'text') return 'math';
    return undefined;
  }
  if (isObject(context) && 'any' in context) {
    const members = (context as { any: EusnipsContextExpression[] }).any.map(engineContext);
    // A single member the engine cannot evaluate makes the whole disjunction
    // unavailable: answering "any" would silently widen it.
    if (members.some((member) => member === undefined)) return undefined;
    if (members.includes('any')) return 'any';
    if (members.every((member) => member === 'math')) return 'math';
    if (members.every((member) => member === 'text')) return 'text';
    return 'any';
  }
  return undefined;
}

function describeContext(context: EusnipsContextExpression): string {
  if (typeof context === 'string') return `"${context}"`;
  if ('not' in context) return `not ${describeContext(context.not)}`;
  if ('all' in context) return `all of ${context.all.map(describeContext).join(', ')}`;
  if ('any' in context) return `any of ${context.any.map(describeContext).join(', ')}`;
  return `${context.type} "${context.name}"`;
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug.slice(0, 48) : fallback;
}

/** A fresh, unique snippet id for a file. */
export function nextSnippetId(file: Pick<EusnipsFile, 'snippets'>, seed = 'snippet'): string {
  const taken = new Set((file.snippets ?? []).map((snippet) => snippet.id).filter(Boolean) as string[]);
  const base = slugify(seed, 'snippet');
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * The alphabet a generated id is drawn from.
 *
 * Ambiguous characters are deliberately absent: an id is something a person
 * copies out of the editor or reads back over the phone when reporting a broken
 * snippet, and `0`/`O` and `1`/`l`/`I` are the pairs that make that go wrong.
 */
export const SNIPPET_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** How many characters a generated id has. */
export const SNIPPET_ID_LENGTH = 6;

/** A random id, with no regard for what a file already uses. */
export function randomSnippetId(
  length = SNIPPET_ID_LENGTH,
  random: () => number = Math.random
): string {
  let id = '';
  for (let index = 0; index < length; index += 1) {
    id += SNIPPET_ID_ALPHABET[Math.floor(random() * SNIPPET_ID_ALPHABET.length)];
  }
  return id;
}

/**
 * A fresh random id that is not already in `ids`.
 *
 * The uniqueness test is the caller's list rather than a global counter, because
 * an id only has to be unique inside the file it belongs to — that is what the
 * format requires, and it is what keeps an id stable when a snippet is exported
 * from one library and pasted into another.
 *
 * The attempts are bounded so a caller-supplied generator that always answers the
 * same value cannot hang the editor; the last candidate is made unique by hand
 * instead of being returned as a duplicate.
 */
export function uniqueSnippetId(
  ids: Iterable<string>,
  random: () => number = Math.random
): string {
  const taken = new Set(ids);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const id = randomSnippetId(SNIPPET_ID_LENGTH, random);
    if (!taken.has(id)) return id;
  }
  // 32^6 is about a billion, so a collision a thousand times over is a broken
  // generator rather than bad luck; fall back to a suffix that cannot collide.
  let suffix = 2;
  for (;;) {
    const candidate = `${randomSnippetId(SNIPPET_ID_LENGTH - 1, random)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
    suffix += 1;
  }
}

/** Every id a file already uses. */
export function snippetIds(file: Pick<EusnipsFile, 'snippets'>): Set<string> {
  return new Set((file.snippets ?? []).map((snippet) => snippet.id).filter(Boolean) as string[]);
}

/**
 * Gives every entry an id, keeping the ones that have one.
 *
 * An id is how the editor points at an entry across a reorder, and the schema
 * refuses a blank one — so an entry that was added and left alone would make the
 * whole file unwritable. Filling the gaps here, in one pass over the file, is
 * what makes "Add snippet" always produce something that can be saved.
 *
 * The ids are generated in order and each one is checked against the ids already
 * present *and* the ones handed out so far, so two entries added in the same pass
 * cannot collide.
 */
export function assignMissingSnippetIds(
  file: EusnipsFile,
  random: () => number = Math.random
): EusnipsFile {
  const used = snippetIds(file);
  let changed = false;
  const snippets = (file.snippets ?? []).map((snippet) => {
    if (snippet.id !== undefined && snippet.id !== '') return snippet;
    const id = uniqueSnippetId(used, random);
    used.add(id);
    changed = true;
    return { ...snippet, id };
  });
  return changed ? { ...file, snippets } : file;
}

/**
 * A file with every trigger in the current shape.
 *
 * The format used to spell a trigger as a bare string, as an object with a `type`
 * discriminant and its text under `value` or `pattern`, and — until every trigger
 * became a regular expression — as `{pattern, regex, flags, caseSensitive}`. All
 * of that is still *read*: a library written before the change has to keep
 * working. This is what stops it being the format. The file is converted once,
 * when it is loaded, so everything downstream sees one shape and the next write
 * puts the current one on disk.
 *
 * The one conversion that is not a rename is the escaping: text that was matched
 * as text becomes a pattern that matches that text, so `**` becomes `\*\*` and a
 * trigger of `...` still means three full stops.
 *
 * It is deliberately conservative: an entry that already has a trigger in the
 * current shape is copied rather than rebuilt, so this cannot be the thing that
 * changes a snippet. Only the superseded spellings are rewritten.
 */
export function upgradeSnippetFile(file: EusnipsFile): EusnipsFile {
  let changed = false;
  const snippets = (file.snippets ?? []).map((snippet) => {
    const trigger = snippet.trigger as unknown;
    const record =
      trigger !== null && typeof trigger === 'object' ? (trigger as Record<string, unknown>) : undefined;
    const legacy =
      typeof trigger === 'string' ||
      record?.type === 'literal' ||
      record?.type === 'regex' ||
      // The merged shape: `regex` is gone from the format, and its absence is
      // what says an entry is current. `false` also means the text was matched as
      // text, so it needs escaping on the way in.
      (record !== undefined && 'regex' in record) ||
      (record !== undefined && 'caseSensitive' in record);

    let upgraded: EusnipsSnippet = snippet;
    if (legacy) {
      const parts = splitTrigger(trigger as EusnipsTrigger | string | Record<string, unknown>);
      // Rebuilt through `buildTrigger` rather than assigned part for part, so the
      // converted entry is the same size as one written by the editor: empty flags
      // are the absence of a setting, and the upgrade is not the place to start
      // stating them.
      upgraded = { ...snippet, trigger: buildTrigger(parts.pattern, parts.flags) };
      changed = true;
    }

    // `options` is retired. It held the engine's flag letters — `A`, `M`, `i`,
    // `w`, `b`, `m`, `n`, `h` — which the format now has a property for each of,
    // so the letters are dropped rather than reported by the validator as a
    // property the format does not define. Without this a file written before the
    // change reports a problem against every entry it has.
    const retired = stripRetiredOptions(upgraded);
    if (retired !== upgraded) {
      upgraded = retired;
      changed = true;
    }
    return upgraded;
  });

  // The `defaults` a file may carry hold no triggers, so nothing else needs
  // converting; the version is the format's own, not a per-entry tag. They can
  // carry retired properties of their own, though.
  const defaults = file.defaults
    ? (stripRetiredOptions(file.defaults as Record<string, unknown>) as EusnipsDefaults)
    : undefined;
  if (defaults !== undefined && defaults !== file.defaults) changed = true;

  return changed ? { ...file, snippets, ...(defaults ? { defaults } : {}) } : file;
}

/** The same object without a retired `options` property, or the object itself. */
function stripRetiredOptions<T extends object>(entry: T): T {
  if (!('options' in entry)) return entry;
  const { options: _retired, ...rest } = entry as T & { options?: unknown };
  return rest as T;
}

/** An empty snippet, ready to be edited. */
export function createSnippet(trigger = '', body = ''): EusnipsSnippet {
  return { trigger: escapeRegexTrigger(trigger), boundary: 'anywhere', body };
}

/**
 * A trigger built from text a person typed, escaped so it matches that text.
 *
 * The editor's "new snippet" and any other place that starts from words rather
 * than from a pattern goes through this: a trigger of `a.b` has to reach the file
 * as `a\.b`, or the entry would quietly match `axb` as well.
 */
export function escapeRegexTrigger(text: string): EusnipsTrigger {
  return { pattern: escapeRegexText(text) };
}

/**
 * Generates the next sequential ID when duplicating a snippet.
 * Preserves the source snippet's ID and appends a numeric suffix (1, 2, 3, ...),
 * continuing from existing numbering if already present.
 */
export function nextDuplicateSnippetId(file: Pick<EusnipsFile, 'snippets'>, sourceId: string): string {
  const taken = new Set((file.snippets ?? []).map((snippet) => snippet.id).filter(Boolean) as string[]);

  // Check if sourceId already ends with a separator and number (e.g., "my-snippet-1" or "my_snippet_1")
  const match = sourceId.match(/^(.*?)([-_])(\d+)$/);
  const base = match ? match[1] : sourceId;
  const sep = match ? match[2] : '-';

  for (let suffix = 1; suffix < 100_000; suffix += 1) {
    const candidate = `${base}${sep}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}${sep}${Date.now()}`;
}

/** A copy of a snippet under a new id, for "Duplicate". */
export function duplicateSnippet(file: EusnipsFile, snippet: EusnipsSnippet): EusnipsSnippet {
  // The copy is a fresh object all the way down, so editing it cannot reach back
  // into the original: `body` may be a list of nodes, and a shared array would be
  // a shared snippet.
  const copy = JSON.parse(JSON.stringify(snippet)) as EusnipsSnippet;
  const sourceId = snippet.id?.trim() || slugify(splitTrigger(snippet.trigger).pattern || 'snippet', 'snippet');
  copy.id = nextDuplicateSnippetId(file, sourceId);
  copy.description = snippet.description ? `${snippet.description} (copy)` : copy.description;
  return copy;
}

/**
 * Applies the file's `defaults` to one snippet and reports anything the format
 * can say but the engine cannot do.
 */
export function effectiveSnippet(
  snippet: EusnipsSnippet,
  defaults: EusnipsDefaults,
  index: number,
  issues: EusnipsIssue[]
): EffectiveSnippet {
  const report = (message: string, level: EusnipsIssue['level'] = 'warning') => {
    issues.push({ level, index, id: snippet.id, message });
  };

  const trigger = splitTrigger(snippet.trigger);
  const id = snippet.id ?? nextSnippetId({ snippets: [] }, trigger.pattern || 'snippet');

  const boundary = snippet.boundary ?? defaults.boundary ?? DEFAULT_BOUNDARY;
  const multiline = snippet.multiline ?? defaults.multiline ?? false;
  const context = snippet.context ?? defaults.context ?? 'any';

  try {
    // The projection in `hsnips.ts` wraps the pattern; compiling it here is what
    // turns a broken hand-edit into a warning instead of a dead snippet.
    // eslint-disable-next-line no-new
    new RegExp(trigger.pattern, trigger.flags);
  } catch (error) {
    report(`the regular expression does not compile: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }

  if (/[gy]/.test(trigger.flags)) {
    // `g` and `y` are stateful: the compiled pattern keeps a `lastIndex` between
    // `exec` calls, and a scan asks the same pattern about a new caret on every
    // keystroke — with a live `lastIndex` the entry fired on every other
    // keystroke. They are dropped when the pattern is compiled, and said so here
    // rather than ignored in silence.
    report('the "g" and "y" flags are stateful and are ignored: each keystroke matches from the start');
  }

  if (trigger.pattern.length === 0) {
    report('the trigger is empty, so the snippet can never match', 'error');
  }
  if (trigger.pattern.includes('`')) {
    report(
      'the trigger contains a backtick, which the pattern form has no way to escape',
      'error'
    );
  }
  if (/[\r\n]/.test(trigger.pattern)) {
    report('the trigger contains a line break, which would end the header');
  }

  const resolved = engineContext(context);
  if (resolved === undefined) {
    report(
      `the context ${describeContext(context)} is not one the engine can evaluate yet ` +
        '(environment, command, document-class and package detection are not implemented), ' +
        'so this snippet is treated as applying everywhere'
    );
  }

  if (typeof multiline === 'number') {
    // The format can say *how many* previous lines a regex trigger sees; the
    // ported engine's `M` flag is a boolean and reads one configured count. The
    // count is therefore reported rather than honoured, so a file asking for
    // five lines does not silently expand as though it had asked for twenty.
    report(
      `"multiline": ${multiline} asks for that many previous lines, but the engine's multiline ` +
        'flag is on or off and always reads the configured number of lines, so the count is ignored'
    );
  }

  if (snippet.script) {
    report('"script" is stored and preserved, but the engine does not run a snippet-level script');
  }

  if (typeof snippet.body !== 'string') {
    for (const node of snippet.body) {
      if (node.type === 'text' && node.value.includes('`')) {
        report('a text body node may not contain a backtick, which would open a code block', 'error');
      }
    }
  }

  const substitutions = bodySubstitutions(snippet.body ?? '');
  if (substitutions.length > 0) {
    // The substitution is written into the generated header and read back by the
    // engine, which treats it as a mirror of a tab stop and contributes no text:
    // `String#replace` has nothing to run against in a plain-text buffer. The
    // file keeps what the author wrote, and this says what will happen to it.
    report(
      `the body carries ${substitutions.length === 1 ? 'a substitution' : `${substitutions.length} substitutions`} ` +
        `(${substitutions.join(', ')}); the engine preserves them but does not apply them yet, ` +
        'so they contribute no text'
    );
  }

  return {
    id,
    trigger: trigger.pattern,
    regexFlags: trigger.flags,
    description: snippet.description ?? '',
    priority: snippet.priority ?? defaults.priority ?? DEFAULT_PRIORITY,
    expand: snippet.expand ?? defaults.expand ?? 'manual',
    boundary,
    hidden: snippet.hidden ?? defaults.hidden ?? false,
    multiline,
    context,
    body: snippet.body,
    tags: snippet.tags ?? defaults.tags ?? [],
    enabled: snippet.enabled ?? defaults.enabled ?? true,
    source: snippet
  };
}

/**
 * The language a file's snippets apply to.
 *
 * `language` and `namespace` are two spellings of the same thing, so when both
 * are present they have to agree — the format says so, and a file that says
 * `"namespace": "latex", "language": "bibtex"` has no answer that is not a guess
 * about which one the author meant. {@link languageDisagreement} reports it, and
 * `language` wins because it is the spelling the editor writes.
 */
export function fileLanguage(file: EusnipsFile): string {
  const named = file.language ?? file.namespace;
  if (typeof named === 'string' && named.trim().length > 0) return named.trim().toLowerCase();
  return DEFAULT_LANGUAGE;
}

/** Where a file's `namespace` and `language` name different languages. */
export function languageDisagreement(file: EusnipsFile): { namespace: string; language: string } | undefined {
  const namespace = typeof file.namespace === 'string' ? file.namespace.trim().toLowerCase() : '';
  const language = typeof file.language === 'string' ? file.language.trim().toLowerCase() : '';
  if (namespace === '' || language === '' || namespace === language) return undefined;
  return { namespace, language };
}

/**
 * Applies the file's defaults, fills in the derived properties and collects
 * everything that needs saying about the entries.
 */
export function normalizeSnippetFile(file: EusnipsFile): NormalizedSnippetFile {
  const issues: EusnipsIssue[] = [];
  const defaults = isObject(file.defaults) ? file.defaults : {};
  const snippets = (Array.isArray(file.snippets) ? file.snippets : []).map((snippet, index) =>
    effectiveSnippet(snippet, defaults, index, issues)
  );

  const seen = new Map<string, number>();
  snippets.forEach((snippet, index) => {
    const previous = seen.get(snippet.id);
    if (previous !== undefined) {
      issues.push({
        level: 'error',
        index,
        id: snippet.id,
        message: `the id "${snippet.id}" is already used by snippet ${previous + 1}; ids must be unique`
      });
    } else {
      seen.set(snippet.id, index);
    }
  });

  if (file.includes && file.includes.length > 0) {
    issues.push({
      level: 'warning',
      index: null,
      message: `"includes" lists ${file.includes.join(', ')}, which Eukolia stores but does not follow yet`
    });
  }

  const disagreement = languageDisagreement(file);
  if (disagreement) {
    issues.push({
      level: 'warning',
      index: null,
      message:
        `"namespace" and "language" name different languages (${disagreement.namespace} and ` +
        `${disagreement.language}); they are aliases, and "language" is the one the snippets load as`
    });
  }

  if (file.globals && file.globals.variables && Object.keys(file.globals.variables).length > 0) {
    issues.push({
      level: 'warning',
      index: null,
      message: '`globals.variables` is stored but the engine does not read snippet variables yet'
    });
  }

  // `globals.javascript` is not reported: it is emitted ahead of the snippets as a
  // `global … endglobal` block (`renderSnippetSources`), which is exactly what a
  // body calling one of its helpers needs. It used to be stored and never written
  // out, and the entries that call a helper — the whole imported unified library —
  // therefore threw `… is not defined` on every expansion and inserted nothing,
  // deleting the text they had matched.

  return { file, snippets, issues, language: fileLanguage(file) };
}

// ---------------------------------------------------------------------------
// Serialising back to JSON
// ---------------------------------------------------------------------------

/** True when a snippet carries no data beyond the two required properties. */
export function isEmptySnippet(snippet: EusnipsSnippet): boolean {
  return (
    Object.keys(snippet).filter((key) => key !== 'trigger' && key !== 'body').length === 0 &&
    renderBody(snippet.body).length === 0
  );
}

/**
 * Drops properties that are present but say nothing.
 *
 * A `snippets.json` written by the editor must not accumulate `"description": ""`
 * on every entry, or it stops being a file a person wants to read.
 */
function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneEmpty);
  if (!isObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (entry === '' && key !== 'body') continue;
    const pruned = pruneEmpty(entry);
    if (isObject(pruned) && Object.keys(pruned).length === 0 && key !== 'metadata' && key !== 'globals') continue;
    if (Array.isArray(pruned) && pruned.length === 0 && key !== 'snippets') continue;
    result[key] = pruned;
  }
  return result;
}

/**
 * The same file with its inline `globals.javascript` removed.
 *
 * A library's shared script belongs in `globals.js`, beside `snippets.json`, and
 * that is where it is written. It used to be written to both, so the JSON carried a
 * second complete copy of a 186 KB script — 43 % of the file — with nothing keeping
 * the two equal, and because `globals.js` always won at load, an edit made only to
 * the copy inside the JSON was ignored at runtime and reverted on the next save.
 * Serialising through this is what leaves the bytes on disk with one owner.
 *
 * Everything else about the file is untouched: the editor still holds and shows the
 * globals (the store puts them back into the in-memory document after reading), so
 * the Library panel, the validator and the snippet engine all see what they did.
 */
export function withoutInlineGlobals(file: EusnipsFile): EusnipsFile {
  if (!file.globals || file.globals.javascript === undefined) return file;
  const { javascript: _javascript, ...rest } = file.globals;
  if (Object.keys(rest).length === 0) {
    const { globals: _globals, ...withoutGlobals } = file;
    return withoutGlobals;
  }
  return { ...file, globals: rest };
}

/**
 * Serialises a snippet file to the text that is written to disk.
 *
 * `JSON.stringify` with an explicit key order rather than a replacer because the
 * order is part of the format's readability: `id`, `trigger`, `description`,
 * `priority`, … then `body` last, so the long multi-line value never pushes the
 * bookkeeping off the screen.
 */
export function serializeSnippetFile(file: EusnipsFile): string {
  const ordered: Record<string, unknown> = {};
  ordered.version = EUSNIPS_VERSION;

  for (const key of ['name', 'description', 'namespace', 'language'] as const) {
    const value = file[key];
    if (value !== undefined && value !== '') ordered[key] = value;
  }
  if (file.includes && file.includes.length > 0) ordered.includes = file.includes;
  if (file.defaults && Object.keys(file.defaults).length > 0) ordered.defaults = pruneEmpty(file.defaults);
  if (file.globals && Object.keys(file.globals).length > 0) ordered.globals = pruneEmpty(file.globals);
  if (file.metadata && Object.keys(file.metadata).length > 0) ordered.metadata = pruneEmpty(file.metadata);

  ordered.snippets = (file.snippets ?? []).map((snippet) => {
    const entry: Record<string, unknown> = {};
    if (snippet.id) entry.id = snippet.id;
    entry.trigger = snippet.trigger;
    if (snippet.description) entry.description = snippet.description;
    if (snippet.priority !== undefined) entry.priority = snippet.priority;
    if (snippet.expand !== undefined) entry.expand = snippet.expand;
    if (snippet.boundary !== undefined) entry.boundary = snippet.boundary;
    if (snippet.hidden !== undefined) entry.hidden = snippet.hidden;
    if (snippet.multiline !== undefined && snippet.multiline !== false) entry.multiline = snippet.multiline;
    if (snippet.context !== undefined && snippet.context !== 'any') entry.context = snippet.context;
    if (snippet.tags && snippet.tags.length > 0) entry.tags = snippet.tags;
    if (snippet.enabled === false) entry.enabled = false;
    if (snippet.script) entry.script = pruneEmpty(snippet.script);
    if (snippet.metadata && Object.keys(snippet.metadata).length > 0) entry.metadata = pruneEmpty(snippet.metadata);
    entry.body = snippet.body;
    return entry;
  });

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Reading text back
// ---------------------------------------------------------------------------

export interface ParsedSnippetFile {
  file: EusnipsFile | null;
  /** Parse failure, when the text is not JSON at all. */
  error?: string;
}

/** Parses a file's text. Shape validation is the validator's job, not this one's. */
export function parseSnippetFileText(text: string): ParsedSnippetFile {
  if (text.trim().length === 0) return { file: null, error: 'the file is empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { file: null, error: error instanceof Error ? error.message : String(error) };
  }
  if (!isObject(parsed)) return { file: null, error: 'the file must contain a JSON object' };
  const file = parsed as unknown as EusnipsFile;
  if (!Array.isArray(file.snippets)) {
    return { file: { ...file, snippets: [] }, error: undefined };
  }
  return { file };
}

/** A file holding nothing but the format's required properties. */
export function emptySnippetFile(language = DEFAULT_LANGUAGE): EusnipsFile {
  return { version: EUSNIPS_VERSION, language, snippets: [] };
}

/**
 * Whether an issue is the one an empty, *just added* trigger produces.
 *
 * `trigger` is a `oneOf` of a non-empty string and two objects, so the pointer
 * is the trigger itself or one of its branches, and the message is what says
 * which of the two failures it is.
 */
export function isEmptyTriggerIssue(issue: { path: string; message: string }): boolean {
  if (!/\/trigger(\/(?:value|pattern))?$/.test(issue.path)) return false;
  return issue.message.includes('must not be empty');
}

export interface WritableDocumentCheck {
  valid: boolean;
  /** The schema issues that would stop a write; empty when `pending` is true. */
  issues: ValidationIssue[];
  /** Every schema issue, including the ones a pending entry is allowed. */
  allIssues: ValidationIssue[];
  semantic: EusnipsIssue[];
  /** True when the only complaint is a trigger the user has not typed yet. */
  pending: boolean;
}

/**
 * Work a caller has already done for the same document.
 *
 * Both halves are optional and independent — a caller that has validated but not
 * normalized passes one and the other is computed here.
 */
export interface KnownDocumentCheck {
  /** The schema issues of the document as it would be written. */
  allIssues?: readonly ValidationIssue[];
  /** The semantic issues `normalizeSnippetFile` reported for the same document. */
  semantic?: readonly EusnipsIssue[];
}

/**
 * The one check that decides whether a document may be written.
 *
 * It lives here, next to the schema, rather than in either caller, so the
 * settings editor and the store cannot disagree about what "writable" means.
 *
 * One deliberate leniency: an entry whose trigger is still empty is not a
 * failure. That is what a snippet looks like in the second between "Add" and the
 * first keystroke, and treating it as fatal would mean either a newly added
 * snippet blocks every subsequent save or the editor has to hold the document in
 * memory and hope. Everything such an entry says is loaded, listed and reported;
 * it simply cannot match anything until it has a trigger.
 *
 * `known` is how a caller that has just validated and normalized the same
 * document hands its work over rather than paying for it twice. The store does
 * this on every keystroke, and validating a large library is the most expensive
 * step in that path: doing it twice was the difference between an editor that
 * keeps up and one that does not.
 */
export function checkWritableDocument(file: EusnipsFile, known: KnownDocumentCheck = {}): WritableDocumentCheck {
  // The text is only needed to give the issues a position, which is why it is
  // not built at all when the issues are already in hand.
  const text = known.allIssues === undefined ? serializeSnippetFile(file) : '';
  const allIssues = [...(known.allIssues ?? validateSnippetFile(JSON.parse(text) as unknown, { text }).issues)];
  const pending = allIssues.length > 0 && allIssues.every(isEmptyTriggerIssue);
  const issues = pending ? [] : allIssues;
  const semantic = [...(known.semantic ?? normalizeSnippetFile(file).issues)].filter(
    (issue) => !(pending && issue.message.includes('the trigger is empty'))
  );
  return { valid: issues.length === 0, issues, allIssues, semantic, pending };
}

/** The body a snippet contributes to the engine, as `.hsnips` lines. */
export function snippetBodyLines(body: SnippetBody): string[] {
  return bodyLines(body);
}

export { tokenizeBody, renderBody, tabstopIndices };
export type { BodyNode, SnippetBody };
