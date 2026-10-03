/**
 * Eukolia — first-run seeding and `.hsnips` migration.
 *
 * The managed file has to be usable the moment it appears, so it is never
 * created empty: on first run it is seeded from the built-in library, which is
 * the same `.hsnips` document the parser has always shipped with. Seeding is
 * done by *inverting* that document through the real parser rather than by
 * hand-writing a second copy of the library, so the built-ins cannot drift from
 * the file they seed.
 *
 * Migrating the user's own `*.hsnips` files is deliberately conservative:
 *
 *  * the `.hsnips` file is **never** modified or deleted — it stays exactly where
 *    the user put it, and stays loadable by HyperSnips in another editor;
 *  * an import is recorded in the file's `metadata.imports` before anything is
 *    written, so running it twice cannot duplicate a snippet;
 *  * the body is carried across verbatim as body text, so every feature the
 *    parser accepted — `` `code` `` blocks, regex triggers, flags, multi-line
 *    bodies — survives the move;
 *  * re-importing a source that has changed on disk is offered as an explicit
 *    action in the editor instead of happening behind the user's back, because
 *    that is the one case where snippets could be created twice.
 *
 * `priority` is the one thing a round trip cannot preserve: the reference's
 * `priority` directive is reset after every snippet header, so a `.hsnips`
 * document that sets `priority 100` sets it for exactly one snippet. Imported
 * snippets therefore carry no explicit priority and take the file default.
 */

import { parse } from '../../vendor/hypersnips';
import type { HSnippet } from '../../vendor/hypersnips/hsnippet';
import { defaultSnippetsSource, DEFAULT_LATEX_SNIPPETS_FILE } from '../defaultSnippets';
import { unescapeHeaderTrigger } from './hsnips';
import DEFAULT_SNIPPETS from '../snippets.json';
import {
  EUSNIPS_VERSION,
  escapeRegexText,
  splitTrigger,
  type EusnipsFile,
  type EusnipsSnippet
} from './model';

/**
 * The built-in library as the format's own shape.
 *
 * A JSON import widens every string to `string`, so the union-typed properties —
 * `expand`, `boundary`, `context` — do not survive the import as types. The claim
 * is made here, once, and it is checked rather than trusted:
 * `tests/snippets/defaultLibrary.test.ts` validates this exact file against the
 * schema, which is what actually decides whether the entries are well formed.
 */
const BUILT_IN = DEFAULT_SNIPPETS as unknown as EusnipsFile;

/**
 * The priorities a `.hsnips` document states, in the order it states them. *
 * The reference's `priority` directive applies to the *next* snippet header and
 * is then reset, so the nth directive in the document belongs to the nth snippet
 * that follows one. Pairing them positionally is what recovers a priority the
 * per-snippet format can hold; matching on the trigger would mean a table that
 * has to be kept in step with the document by hand.
 *
 * The value is what the parser records for that snippet — a priority with no
 * directive before it is `0`, which is the reference's own "unset".
 */
export function priorityHints(source: string): number[] {
  const hints: number[] = [];
  let pending = 0;
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith('priority ')) {
      pending = Number(line.substring('priority '.length).trim()) || 0;
      continue;
    }
    if (line.startsWith('snippet ') || /^snippet ?`/.test(line)) {
      hints.push(pending);
      pending = 0;
    }
  }
  return hints;
}

/**
 * The `.hsnips` source lines a `parse()`d body was compiled from.
 *
 * This is deliberately *not* the vendored `getSnippetBody`. That records the line
 * as it was read, but `parseSnippet` re-inserts a line's tail after the code block
 * it found, so an inline block is duplicated: `Hi ``rv = 1``!` comes back as
 * `Hi ``rv = 1``\nrv = 1``!`, with the opening delimiter missing and its code
 * repeated. Replaying that is not a faithful import — the parser reads the stray
 * backticks as a new code block and the snippet fails to compile.
 *
 * The lines are read here the way `parseSnippet` read them, which is the inverse
 * of how it compiles them: text outside backticks is emitted verbatim, and a code
 * block is re-emitted with the `\x60` escapes the document format spells a
 * backtick with. The result parses back to the same snippet, which is what makes
 * an import lossless.
 */
export function hsnipsBodySource(sourceLines: readonly string[]): string {
  const parts: string[] = [];
  let isCode = false;

  for (const rawLine of sourceLines) {
    let line = rawLine;
    for (;;) {
      const delimiter = line.indexOf('``');
      if (delimiter < 0) {
        if (line.length > 0) parts.push(isCode ? line.trim() : line);
        break;
      }
      const head = line.slice(0, delimiter);
      if (head.length > 0) parts.push(isCode ? head.trim() : head);
      parts.push('\\x60\\x60');
      line = line.slice(delimiter + 2);
      isCode = !isCode;
    }
    if (!isCode) parts.push('\n');
  }

  const joined = parts.join('');
  return joined.endsWith('\n') ? joined.slice(0, -1) : joined;
}

/**
 * The body lines of every snippet in a `.hsnips` document, in order.
 *
 * A second, deliberately minimal pass over the document, for the one thing `parse`
 * does not hand back: the raw lines each body was compiled from. It follows the
 * same header test the parser does, so the two cannot disagree about where a
 * snippet starts.
 */
export function parseSnippetBodies(source: string): { bodies: string[][] } {
  const lines = source.split(/\r?\n/);
  const bodies: string[][] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (!line.startsWith('snippet') || !HEADER_HINT.test(line)) continue;

    const body: string[] = [];
    while (index < lines.length && !lines[index].startsWith('endsnippet')) {
      body.push(lines[index]);
      index += 1;
    }
    if (index < lines.length) index += 1; // skip `endsnippet`
    bodies.push(body);
  }

  return { bodies };
}

/**
 * Whether a line is a snippet header.
 *
 * The same shape the ported parser matches, written out here so this pass and the
 * parser cannot disagree about it: `snippet`, an optional trigger (a bare word or
 * a backticked regex), an optional quoted description, optional flags.
 */
const HEADER_HINT = /^snippet ?(?:`[^`]+`|(\S+))?(?: "[^"]+")?(?: [AMiwbmhn]*)?/;

/**
 * Turns one parsed `HSnippet` back into an EUSnips entry.
 *
 * The body is the raw `.hsnips` body text the parser retained, which is what
 * makes this lossless for everything except priority.
 */
export function snippetFromParsed(parsed: {
  trigger: string;
  description: string;
  regexp?: RegExp;
  automatic: boolean;
  multiline: boolean;
  inword: boolean;
  wordboundary: boolean;
  beginningofline: boolean;
  math: boolean;
  nonmath: boolean;
  hidden: boolean;
  source: string;
  sourceName?: string;
  /**
   * Priority the document stated for this snippet.
   *
   * The ported parser resets its `priority` directive after every header, so the
   * `.hsnips` text cannot carry a per-snippet priority and the caller supplies
   * what the directive meant. Omitted means "no priority of its own".
   */
  priority?: number;
}): EusnipsSnippet {
  const snippet: EusnipsSnippet = {
    // A header's backticked trigger is already a pattern and is carried across as
    // it stands. A bare token is text to match, and the format has one kind of
    // trigger, so the text becomes the pattern that matches it: `**` arrives as
    // `\*\*`. `unescapeHeaderTrigger` first undoes the escaping an older Eukolia
    // wrote into the token, so a file this application produced earlier round
    // trips to the same characters it was written from.
    trigger:
      parsed.regexp !== undefined
        ? { pattern: parsed.regexp.source, ...(parsed.regexp.flags ? { flags: parsed.regexp.flags } : {}) }
        : { pattern: escapeRegexText(unescapeHeaderTrigger(parsed.trigger)) },
    body: parsed.source
  };

  if (parsed.description) snippet.description = parsed.description;
  if (parsed.automatic) snippet.expand = 'auto';
  if (parsed.multiline) snippet.multiline = true;
  if (parsed.inword) snippet.boundary = 'anywhere';
  else if (parsed.wordboundary) snippet.boundary = 'word';
  else if (parsed.beginningofline) snippet.boundary = 'line-start';
  if (parsed.math && !parsed.nonmath) snippet.context = 'math';
  else if (parsed.nonmath && !parsed.math) snippet.context = 'text';
  if (parsed.hidden) snippet.hidden = true;

  // A header may set several boundary letters at once (`ali` is `ib`), and the
  // engine consults `i` first, so the typed `boundary` property above names the one
  // that decides. Without the flag letters there is nowhere for the others to go,
  // and an import says exactly what the entry *does* rather than everything its
  // header once said.

  if (parsed.priority !== undefined && parsed.priority !== 0) snippet.priority = parsed.priority;

  const canonicalId = idForSnippet(snippet);
  if (canonicalId) snippet.id = canonicalId;
  return snippet;
}

/** A stable, human-readable id for a snippet, or `undefined` when there is none. */
export function idForSnippet(snippet: EusnipsSnippet): string | undefined {
  const { pattern } = splitTrigger(snippet.trigger);
  const slug = pattern
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug.slice(0, 48) : undefined;
}

/**
 * The built-in library, as EUSnips entries ready to be written out.
 *
 * The entries are read from `snippets.json` rather than compiled from a `.hsnips`
 * document, because a first-run library is something a person reads and edits:
 * keeping it in the format the application actually stores means the file the
 * seed writes and the file it was made from are the same kind of thing, and the
 * ids it carries are the ones the user's own copy will have.
 *
 * The entries are copied, so a caller that edits one cannot change the built-in
 * library for the rest of the session.
 */
export function builtInSnippets(): EusnipsSnippet[] {
  return structuredClone(BUILT_IN.snippets);
}

/** The same conversion, reading the raw `.hsnips` body off a parsed snippet. */
function fromParsed(snippet: HSnippet, bodyLines: readonly string[], priority?: number): EusnipsSnippet {
  return snippetFromParsed({
    trigger: snippet.trigger,
    description: snippet.description,
    regexp: snippet.regexp,
    automatic: snippet.automatic,
    multiline: snippet.multiline,
    inword: snippet.inword,
    wordboundary: snippet.wordboundary,
    beginningofline: snippet.beginningofline,
    math: snippet.math,
    nonmath: snippet.nonmath,
    hidden: snippet.hidden,
    source: hsnipsBodySource(bodyLines),
    sourceName: snippet.sourceName,
    priority
  });
}

/** The first-run `snippets.json`. */
export function initialSnippetFile(language = 'latex'): EusnipsFile {
  return {
    version: EUSNIPS_VERSION,
    name: BUILT_IN.name ?? 'My snippets',
    description: BUILT_IN.description ?? 'Eukolia managed snippet library.',
    // The library is a LaTeX library; a caller asking for another language is
    // asking to seed that language's empty file, not to relabel this one. The
    // entries would not apply there, and writing them anyway would put a
    // hundred-odd snippets in a file that claims to be someone else's.
    language,
    snippets: language === BUILT_IN.language ? builtInSnippets() : []
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/** One record of a `.hsnips` file that has been imported. */
export interface ImportReceipt {
  /** File name inside the user's snippets directory. */
  file: string;
  /** Content hash at the time of the import, so a later change can be spotted. */
  hash: string;
  /** How many snippets the import contributed. */
  count: number;
  /** When the import happened (ISO 8601). */
  at: string;
}

export interface MigrationSource {
  name: string;
  content: string;
}

export interface MigrationResult {
  file: EusnipsFile;
  /** Sources that were newly imported, in the order they were read. */
  imported: ImportReceipt[];
  /** Sources already recorded, so nothing was done for them. */
  skipped: string[];
}

function hashContent(content: string): string {
  // A small, dependency-free 32-bit FNV-1a. It only has to notice that a file
  // changed, not resist a collision attack, and it stays synchronous and
  // available in both the renderer and the tests.
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The import receipts recorded in a file's metadata. */
export function importReceipts(file: EusnipsFile): ImportReceipt[] {
  const raw = file.metadata?.imports;
  if (!Array.isArray(raw)) return [];
  const receipts: ImportReceipt[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.file !== 'string') continue;
    receipts.push({
      file: record.file,
      hash: typeof record.hash === 'string' ? record.hash : '',
      count: typeof record.count === 'number' ? record.count : 0,
      at: typeof record.at === 'string' ? record.at : ''
    });
  }
  return receipts;
}

/** Sources present on disk that have not been imported into this file. */
export function pendingImports(file: EusnipsFile, sources: readonly MigrationSource[]): MigrationSource[] {
  const known = new Set(importReceipts(file).map((receipt) => receipt.file));
  return sources.filter((source) => !known.has(source.name));
}

/** Sources whose on-disk content no longer matches the recorded import. */
export function changedImports(file: EusnipsFile, sources: readonly MigrationSource[]): string[] {
  const byName = new Map(sources.map((source) => [source.name, source.content]));
  const changed: string[] = [];
  for (const receipt of importReceipts(file)) {
    const content = byName.get(receipt.file);
    if (content !== undefined && hashContent(content) !== receipt.hash) changed.push(receipt.file);
  }
  return changed;
}

/**
 * Imports `.hsnips` sources into a file.
 *
 * Only sources with no receipt are read, which is what makes a second call a
 * no-op: the receipts are what "already imported" means, not a flag on the
 * snippets themselves.
 */
export function migrateInto(
  file: EusnipsFile,
  sources: readonly MigrationSource[],
  now: () => Date = () => new Date()
): MigrationResult {
  const receipts = importReceipts(file);
  const known = new Set(receipts.map((receipt) => receipt.file));
  const imported: ImportReceipt[] = [];
  const skipped: string[] = [];
  const snippets = [...(file.snippets ?? [])];
  const takenIds = new Set(snippets.map((snippet) => snippet.id).filter(Boolean) as string[]);

  for (const source of sources) {
    if (known.has(source.name)) {
      skipped.push(source.name);
      continue;
    }

    const language = source.name.replace(/\.hsnips$/i, '').trim().toLowerCase() || 'all';
    const parsed = parse(source.content, source.name);
    const { bodies } = parseSnippetBodies(source.content);
    const hints = priorityHints(source.content);
    let count = 0;
    for (const [position, snippet] of parsed.entries()) {
      const entry = fromParsed(snippet, bodies[position] ?? [], hints[position]);
      entry.id = entry.id ?? `${language}-snippet-${position + 1}`;
      let candidate = entry.id;
      let suffix = 2;
      while (takenIds.has(candidate)) {
        candidate = `${entry.id}-${suffix}`;
        suffix += 1;
      }
      entry.id = candidate;
      takenIds.add(candidate);
      entry.metadata = { importedFrom: source.name, importedLanguage: language };
      snippets.push(entry);
      count += 1;
    }

    imported.push({ file: source.name, hash: hashContent(source.content), count, at: now().toISOString() });
  }

  if (imported.length === 0) {
    return { file, imported, skipped };
  }

  const existing = file.metadata && typeof file.metadata === 'object' ? file.metadata : {};
  return {
    file: {
      ...file,
      metadata: { ...existing, imports: [...receipts, ...imported] },
      snippets
    },
    imported,
    skipped
  };
}

/**
 * Removes the snippets an import contributed, so a re-import replaces rather
 * than appends. Used by the explicit "re-import" action.
 */
export function removeImported(file: EusnipsFile, sourceName: string): EusnipsFile {
  return {
    ...file,
    snippets: (file.snippets ?? []).filter(
      (snippet) => (snippet.metadata as { importedFrom?: string } | undefined)?.importedFrom !== sourceName
    ),
    metadata: removeReceipt(file.metadata, sourceName)
  };
}

function removeReceipt(metadata: Record<string, unknown> | undefined, sourceName: string): Record<string, unknown> {
  const base = metadata && typeof metadata === 'object' ? metadata : {};
  const kept = importReceipts({ version: EUSNIPS_VERSION, snippets: [], metadata: base }).filter(
    (receipt) => receipt.file !== sourceName
  );
  return kept.length > 0 ? { ...base, imports: kept } : stripImports(base);
}

function stripImports(metadata: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...metadata };
  delete copy.imports;
  return copy;
}

export { hashContent };
