/**
 * SnippetManager — the snippet library, in a window of its own.
 *
 * This is where the user's snippet library is *managed*: the entries are listed,
 * filtered, added, edited, duplicated, deleted and switched on and off, and every
 * field is edited directly rather than by hand-writing JSON. The file is still
 * JSON, and still meant to be readable, but it is no longer the only way in.
 *
 * Four properties shape the design:
 *
 *  * **It is a pop-up, not a settings page.** Managing snippets is a task with a
 *    beginning and an end — you open it, change something, close it — so it takes
 *    the window rather than a pane of the settings body, and the close button (or
 *    `Ctrl+Alt+L` again) is the end of the task.
 *  * **Nothing is written until the task is done.** Every edit is applied to the
 *    document in memory and reaches the editor immediately — a trigger works as
 *    soon as it is typed — but the file is written once, when the window closes.
 *    A row whose entry differs from what is on disk carries a grey dot, which is
 *    the same "unsaved changes" marker the tab bar uses.
 *  * **Nothing is written that does not validate.** The document is validated
 *    against the EUSnips schema as it is edited, and a closing window that cannot
 *    save says so and stays open rather than dropping the edit.
 *  * **What you see is what the engine does.** The quick test under the body runs
 *    the real projection and the real matcher, so "does this trigger fire, and
 *    what does it insert?" is answered by the same code the editor uses.
 *
 * The pure logic lives in the exported functions at the top (filtering, id
 * allocation, body conversion, summaries, the quick test) so it can be tested
 * without a DOM; `tests/ui/snippets-manager.test.ts` does exactly that.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyBehaviour,
  buildTrigger,
  checkWritableDocument,
  describeSemanticIssues,
  describeValidationIssues,
  duplicateSnippet as duplicateSnippetEntry,
  effectiveSnippet,
  escapeRegexText,
  FIELD_LABELS,
  globalsSource,
  isEmptyBody,
  renderBody,
  renderSnippetDocument,
  serializeSnippetFile,
  snippetAsStored,
  snippetIds,
  snippetProblems,
  splitTrigger,
  tabstopIndices,
  tokenizeStructured,
  uniqueSnippetId,
  type BodyNode,
  type EusnipsFile,
  type EusnipsIssue,
  type EusnipsSnippet,
  type SnippetField,
  type SnippetProblem,
  type ValidationIssue
} from '../../snippets/eusnips';
import {
  getCompletions as getSnippetCompletions,
  getSnippetBody,
  parse,
  stripPlaceholders
} from '../../vendor/hypersnips';
import { createStringDocument, createTextDocumentAdapter } from '../../snippets/documentAdapter';
import { SnippetEngine, positionFromOffset } from '../../snippets/engine';
import { getSnippetStore, type SnippetStoreState } from '../../snippets/store';
import { settingsManager } from '../../core/settings';
import { Modal } from './Modal';
import { StandaloneTitleBar } from './StandaloneTitleBar';
import { ScrollArea, type ScrollAreaHandle } from './ScrollArea';
import { ArrowDownToLine, ArrowUpToLine, Braces, Copy, Filter, Folder, GripVertical, Plus, RotateCcw, RotateCw, Save, Search, Trash2, TriangleAlert, Wand2, X, Zap } from './icons';
// The snippet library's own sheet — the two panes, the list rows, the form
// rhythm and the code surfaces. Imported here as well as from `SettingsView`
// because both are lazily-loaded surfaces and a shared chunk's stylesheet is
// attached to the chunks that import it: the standalone snippet window never
// mounts the settings pane, so it has to bring the sheet with it.
import '../SettingsSurfaces.css';

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

export type EditorMode = 'simple' | 'advanced';

export const CONTEXT_KINDS = [
  'any',
  'math',
  'text',
  'preamble',
  'comment',
  'environment',
  'command',
  'document-class',
  'package'
] as const;

export type ContextKind = (typeof CONTEXT_KINDS)[number];

/** What each kind is called in the editor, and in the file. */
export const CONTEXT_LABELS: Record<ContextKind, string> = {
  any: 'Everywhere',
  math: 'Mathematics only',
  text: 'Text only',
  preamble: 'Preamble only',
  comment: 'Comments only',
  environment: 'Inside an environment',
  command: 'Inside a command',
  'document-class': 'In a document class',
  package: 'With a package'
};

export const SIMPLE_CONTEXT_KINDS: readonly ContextKind[] = ['any', 'math', 'text'];

/** How a context reads in the list. */
export function describeContextValue(context: EusnipsSnippet['context']): string {
  if (context === undefined) return 'everywhere';
  if (typeof context === 'string') return context;
  if ('not' in context) return `not ${describeContextValue(context.not)}`;
  if ('all' in context) return `all of ${context.all.map(describeContextValue).join(', ')}`;
  if ('any' in context) return `any of ${context.any.map(describeContextValue).join(', ')}`;
  return `${context.type} ${context.name}`;
}

/** The kind a context is built from, or `custom` when it is not one of them. */
export function contextKind(context: EusnipsSnippet['context']): ContextKind | 'custom' {
  if (context === undefined) return 'any';
  if (typeof context === 'string') {
    return (CONTEXT_KINDS as readonly string[]).includes(context) ? (context as ContextKind) : 'custom';
  }
  if ('type' in context) return context.type as ContextKind;
  return 'custom';
}

/** The name a named context carries, for the editor's text box. */
export function contextName(context: EusnipsSnippet['context']): string {
  return typeof context === 'object' && context !== null && 'name' in context ? context.name : '';
}

export interface SnippetFilter {
  /** Free text, matched against trigger, description, body, tags and id. */
  query: string;
  /** `all`, or one of the states a row can be in. */
  status: 'all' | 'enabled' | 'disabled' | 'problems';
  /** Filter by context kind, or 'all'. */
  context?: 'all' | ContextKind | 'custom';
  /** Filter by expansion mode, or 'all'. */
  expand?: 'all' | 'auto' | 'manual';
  /** Filter by boundary, or 'all'. */
  boundary?: 'all' | 'whitespace' | 'word' | 'anywhere' | 'line-start';
  /** Filter by tag, or 'all'. */
  tag?: string;
  /** Filter by whether the snippet has scripts, or 'all'. */
  hasScript?: 'all' | 'with-script' | 'without-script';
}

export interface SnippetManagerRememberedState {
  query: string;
  status: SnippetFilter['status'];
  context: 'all' | ContextKind | 'custom';
  expand: 'all' | 'auto' | 'manual';
  boundary: 'all' | 'whitespace' | 'word' | 'anywhere' | 'line-start';
  tag: string;
  hasScript: 'all' | 'with-script' | 'without-script';
  selectedId: string | null;
  selectedIndex: number | null;
  scrollTop: number;
  section: 'snippet' | 'file';
  mode: EditorMode;
  filtersOpen?: boolean;
}

export const DEFAULT_SNIPPET_MANAGER_STATE: SnippetManagerRememberedState = {
  query: '',
  status: 'all',
  context: 'all',
  expand: 'all',
  boundary: 'all',
  tag: 'all',
  hasScript: 'all',
  selectedId: null,
  selectedIndex: 0,
  scrollTop: 0,
  section: 'snippet',
  mode: 'simple',
  filtersOpen: false
};

const STORAGE_KEY = 'eukolia:snippets-manager-state';

let inMemoryState: SnippetManagerRememberedState = { ...DEFAULT_SNIPPET_MANAGER_STATE };

// Reset remembered state when the application/window is reloaded
if (typeof window !== 'undefined') {
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
    if (nav?.type === 'reload') {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(STORAGE_KEY);
      inMemoryState = { ...DEFAULT_SNIPPET_MANAGER_STATE };
    }
  } catch {
    // ignore
  }
}

export function getRememberedSnippetManagerState(): SnippetManagerRememberedState {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        return { ...inMemoryState, ...JSON.parse(raw) };
      }
    }
  } catch {
    // localStorage not accessible
  }
  return inMemoryState;
}

export function saveRememberedSnippetManagerState(next: Partial<SnippetManagerRememberedState>): void {
  inMemoryState = { ...inMemoryState, ...next };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(inMemoryState));
    }
  } catch {
    // ignore
  }
}

export function resetRememberedSnippetManagerState(): void {
  inMemoryState = { ...DEFAULT_SNIPPET_MANAGER_STATE };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

/** Whether a snippet has anything wrong with it, for the list's marker. */
export function problemsFor(
  file: EusnipsFile,
  index: number,
  validationIssues: readonly ValidationIssue[],
  issues: readonly EusnipsIssue[]
): SnippetProblem[] {
  return snippetProblems(file, index, validationIssues, issues);
}

/**
 * The text a row is searched by: trigger, description, id, tags and the body.
 *
 * The body is searched in its *stored* form, so an entry whose body is only the
 * backtick escape is still found by what the user typed.
 */
export function snippetHaystack(snippet: EusnipsSnippet): string {
  const trigger = splitTrigger(snippet.trigger);
  return [
    trigger.pattern,
    snippet.description ?? '',
    snippet.id ?? '',
    (snippet.tags ?? []).join(' '),
    renderBody(snippet.body)
  ]
    .join(' ')
    .toLowerCase();
}

export function filterSnippets(
  file: EusnipsFile,
  issues: readonly EusnipsIssue[],
  filter: SnippetFilter,
  validationIssues: readonly ValidationIssue[] = []
): number[] {
  const needle = filter.query.trim().toLowerCase();
  const result: number[] = [];
  file.snippets.forEach((snippet, index) => {
    if (filter.status === 'enabled' && snippet.enabled === false) return;
    if (filter.status === 'disabled' && snippet.enabled !== false) return;
    if (filter.status === 'problems' && problemsFor(file, index, validationIssues, issues).length === 0) return;

    if (filter.context && filter.context !== 'all') {
      const kind = contextKind(snippet.context ?? file.defaults?.context);
      if (kind !== filter.context) return;
    }

    if (filter.expand && filter.expand !== 'all') {
      const exp = snippet.expand ?? file.defaults?.expand ?? 'manual';
      if (exp !== filter.expand) return;
    }

    if (filter.boundary && filter.boundary !== 'all') {
      const b = snippet.boundary ?? file.defaults?.boundary ?? 'anywhere';
      if (b !== filter.boundary) return;
    }

    if (filter.tag && filter.tag !== 'all') {
      const tags = snippet.tags ?? file.defaults?.tags ?? [];
      if (!tags.includes(filter.tag)) return;
    }

    if (filter.hasScript && filter.hasScript !== 'all') {
      const hasJs = Boolean(
        snippet.script ||
        (typeof snippet.body === 'string' && snippet.body.includes('``')) ||
        (Array.isArray(snippet.body) && snippet.body.some((node) => typeof node === 'object' && node !== null && 'code' in node))
      );
      if (filter.hasScript === 'with-script' && !hasJs) return;
      if (filter.hasScript === 'without-script' && hasJs) return;
    }

    if (needle && !snippetHaystack(snippet).includes(needle)) return;
    result.push(index);
  });
  return result;
}

/** How a snippet's trigger reads in a list. */
export function snippetSummary(snippet: EusnipsSnippet): string {
  return splitTrigger(snippet.trigger).pattern;
}

/** The one-line description under a row: what it expands to, roughly. */
export function snippetBodyPreview(body: EusnipsSnippet['body'], limit = 60): string {
  const rendered = renderBody(body).replace(/\s+/g, ' ').trim();
  return rendered.length > limit ? `${rendered.slice(0, limit - 1)}…` : rendered;
}

/**
 * A new snippet, with a fresh random id that no entry in the file is using.
 *
 * The id is random rather than derived from the trigger because the trigger is
 * what the author edits first: a derived id would either go stale the moment
 * they rename it, or have to be rewritten (and every reference to it with it) as
 * they type. A random id is settled before they touch anything.
 */
export function createManagedSnippet(file: EusnipsFile, trigger = 'new'): EusnipsSnippet {
  const seed = trigger.trim().replace(/\s+/g, '-') || 'snippet';
  return {
    id: uniqueSnippetId(snippetIds(file)),
    // The text is escaped into a pattern, because a trigger is a pattern: a new
    // snippet called `a.b` matches `a.b` and not `axb`.
    trigger: { pattern: escapeRegexText(seed) },
    description: '',
    boundary: 'anywhere',
    body: ''
  };
}

/** The key an entry is compared by when two documents are lined up. */
function entryKey(snippet: EusnipsSnippet, index: number): string {
  return snippet.id ? `id:${snippet.id}` : `at:${index}`;
}

/**
 * Which entries differ from the file on disk.
 *
 * The manager edits in memory and writes once, when it is closed, so "which of
 * these have I changed?" is a question about two documents rather than about a
 * list of touched controls. Comparing what each entry stores answers it exactly —
 * including the case where an edit is undone back to what is on disk, which
 * *should* take the dot away — and matching by id means a reorder does not move
 * the dots with the entries. An entry with no id (only a hand-written file has
 * those) falls back to its position, which is the best that can be said of it.
 */
export function unsavedSnippets(file: EusnipsFile, saved: EusnipsFile | null): Set<number> {
  const result = new Set<number>();
  if (!saved) return result;
  const stored = new Map<string, string>();
  saved.snippets.forEach((snippet, index) => stored.set(entryKey(snippet, index), JSON.stringify(snippet)));
  file.snippets.forEach((snippet, index) => {
    if (stored.get(entryKey(snippet, index)) !== JSON.stringify(snippet)) result.add(index);
  });
  return result;
}

// ---------------------------------------------------------------------------
// The quick test
// ---------------------------------------------------------------------------

export interface SnippetTestResult {
  /** `match` when the trigger fires, `no-match` when it does not, `problem` when it cannot. */
  kind: 'match' | 'no-match' | 'problem';
  /** What the snippet would insert, with the tab stops filled in. */
  insert?: string;
  /** The text the trigger matched, and would replace. */
  matched?: string;
  /** True when the match came from the automatic path rather than the completion list. */
  automatic?: boolean;
  /** Why the entry cannot be tested at all. */
  problem?: string;
}

/**
 * Runs one snippet against a piece of sample text, through the real engine.
 *
 * This is a *test*, not a preview: the entry is projected into the snippet source
 * document exactly as the loader projects it, parsed by the same parser the
 * editor uses, and matched against the sample text by the same matcher — so what
 * it reports is what would happen if that text were typed. Anything the
 * projection refuses to render (an empty pattern, a backtick in it, a line break)
 * is reported as the reason the entry cannot be tested, which is also the reason
 * it will never fire.
 *
 * The sample text is matched as a single line with the caret at its end, which is
 * the case every trigger is written for.
 */
export function testSnippet(
  snippet: EusnipsSnippet,
  sample: string,
  language = 'latex',
  globals?: string | string[]
): SnippetTestResult {
  const effective = effectiveSnippet(snippet, {}, 0, []);
  // The library's globals go into the document too, so an entry whose body calls a
  // shared helper can be tested at all: without them the block throws and the
  // answer would be "nothing", which is what the editor would do as well.
  const rendered = renderSnippetDocument(effective, globalsSource(globals));
  if (rendered.problem) return { kind: 'problem', problem: rendered.problem };

  const parsed = parse(rendered.document, 'quick-test.snips');
  if (parsed.length === 0) {
    return { kind: 'problem', problem: 'the entry did not parse back out of its header' };
  }

  const text = sample.replace(/\r\n|\r|\n/g, '\n');
  const offset = text.length;

  // The candidate comes from the engine, not from the matcher underneath it: the
  // engine is what applies the `context` filter, and asking the matcher directly
  // made a `context: "math"` entry look like it fires in prose when the editor
  // would refuse it. The engine also runs the entry, below.
  const engine = new SnippetEngine();
  const warnings: string[] = [];
  engine.setWarningSink((message) => warnings.push(message));
  engine.addSnippets(language, parsed);
  // The entry's behaviour is applied the way the loader applies it when the
  // library loads — the same call, so the two cannot drift. Without it the box
  // would test a snippet that is automatic, bounded and contextualised only by
  // whatever the source text happened to say, which is nothing.
  for (const parsedSnippet of parsed) applyBehaviour(parsedSnippet, effective);

  const candidates = engine.getCompletions({ text, offset, languageId: language });
  const candidate = candidates[0];
  if (!candidate) return { kind: 'no-match' };

  // The text shown is what the engine would insert, asked of the engine: the entry
  // is expanded for real, so a code block's *output* is the answer rather than its
  // source. Anything the expansion reported on the way — a block that threw, a body
  // that could not run — is reported instead of an empty insert, which is the one
  // answer that looks like success and is not.
  const insert = engine.expand(candidate, { text, pushToStack: false }).plainText;

  if (insert.length === 0 && warnings.length > 0) {
    return { kind: 'problem', problem: warnings.join('\n') };
  }

  return { kind: 'match', insert, matched: candidate.label, automatic: candidate.automatic };
}

/** Duplicating keeps every property and takes a fresh id and description. */
export function duplicateManagedSnippet(file: EusnipsFile, index: number): EusnipsSnippet {
  return duplicateSnippetEntry(file, file.snippets[index]);
}

/** Moves an entry, returning a new file. Out-of-range moves are no-ops. */
export function moveSnippet(file: EusnipsFile, index: number, delta: number): EusnipsFile {
  const target = index + delta;
  if (index < 0 || index >= file.snippets.length || target < 0 || target >= file.snippets.length) return file;
  const snippets = [...file.snippets];
  const [entry] = snippets.splice(index, 1);
  snippets.splice(target, 0, entry);
  return { ...file, snippets };
}

/**
 * Moves an entry from fromIndex to toIndex, returning a new file.
 *
 * Index out of range, or fromIndex === toIndex, returns the file untouched.
 */
export function reorderSnippet(file: EusnipsFile, fromIndex: number, toIndex: number): EusnipsFile {
  if (
    fromIndex < 0 ||
    fromIndex >= file.snippets.length ||
    toIndex < 0 ||
    toIndex >= file.snippets.length ||
    fromIndex === toIndex
  ) {
    return file;
  }
  const snippets = [...file.snippets];
  const [entry] = snippets.splice(fromIndex, 1);
  snippets.splice(toIndex, 0, entry);
  return { ...file, snippets };
}

/** Removes an entry, returning a new file. */
export function removeSnippet(file: EusnipsFile, index: number): EusnipsFile {
  if (index < 0 || index >= file.snippets.length) return file;
  return { ...file, snippets: file.snippets.filter((_, at) => at !== index) };
}

/** Replaces one entry, returning a new file. */
export function replaceSnippet(file: EusnipsFile, index: number, snippet: EusnipsSnippet): EusnipsFile {
  if (index < 0 || index >= file.snippets.length) return file;
  return { ...file, snippets: file.snippets.map((entry, at) => (at === index ? snippet : entry)) };
}

/** Adds an entry, returning a new file. */
export function appendSnippet(file: EusnipsFile, snippet: EusnipsSnippet): EusnipsFile {
  return { ...file, snippets: [...file.snippets, snippet] };
}

/**
 * A problem as the form shows it: the field it belongs to and what to do.
 *
 * `FieldIssue` and its pointer table now live in the format module
 * (`eusnips/problems.ts`), so the sentence shown under a field and the sentence
 * in the list's tooltip are produced by the same code. What is re-exported here
 * is the shape the form works in.
 */
export type FieldIssue = SnippetProblem;

/** The issues one entry has, in the order the form reads them. */
export function fieldIssuesFor(
  index: number,
  validationIssues: readonly ValidationIssue[],
  issues: readonly EusnipsIssue[]
): FieldIssue[] {
  return [
    ...describeValidationIssues(validationIssues, index),
    ...describeSemanticIssues(issues, index)
  ];
}

/** The body source the textarea holds, for a body of either shape. */
export function bodySource(body: EusnipsSnippet['body']): string {
  return renderBody(body);
}

/** Parses the textarea back into a body — a plain string, the faithful form. */
export function bodyFromSource(source: string): EusnipsSnippet['body'] {
  return source;
}

/**
 * The structured view of a body, for the node list.
 *
 * A structured body is read back through the same tokeniser a string body goes
 * through, so the list shows the nodes the engine will actually run rather than
 * the ones the file literally holds: a text node that spells `${1|x,y}` is a
 * choice tab stop, and one the reader would stop short of is shown as
 * the text it is instead of as something the expansion will not do.
 */
export function bodyNodes(body: EusnipsSnippet['body']): BodyNode[] {
  return tokenizeStructured(body);
}

/** Whether a body is empty, which is legal but almost never intended. */
export function bodyIsEmpty(body: EusnipsSnippet['body']): boolean {
  return isEmptyBody(body);
}

/** What the trigger field should say a regex pattern will be anchored to. */
export function anchoredPattern(pattern: string): string {
  return pattern.endsWith('$') ? pattern : `${pattern}$`;
}

/**
 * A whole-document check, used before a write and by the tests.
 *
 * Returns the serialized text plus the issues it would be written with, so the
 * editor can say "this is what would go on disk, and here is what is wrong with
 * it" without writing anything. "Writable" itself is decided in one place, by
 * `checkWritableDocument` in the format module, so the editor and the store
 * cannot disagree about it.
 */
export function inspectDocument(file: EusnipsFile): {
  text: string;
  issues: ValidationIssue[];
  semantic: EusnipsIssue[];
  valid: boolean;
  pending: boolean;
} {
  const check = checkWritableDocument(file);
  return {
    text: serializeSnippetFile(file),
    issues: check.issues,
    semantic: check.semantic,
    valid: check.valid,
    pending: check.pending
  };
}

/** True when the document is safe to write. */
export function documentIsWritable(file: EusnipsFile): boolean {
  return checkWritableDocument(file).valid;
}

/**
 * File-level edits, one property at a time.
 *
 * The `defaults` and `globals` objects are the case that makes this worth having:
 * a control sets one key inside them, and the object has to disappear again when
 * its last key does — an empty `defaults: {}` is a property the file does not
 * need and a reader has to skip past.
 */
export function withFileProperty<K extends keyof EusnipsFile>(
  file: EusnipsFile,
  key: K,
  value: EusnipsFile[K]
): EusnipsFile {
  const next = { ...file };
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete next[key];
  else next[key] = value;
  return next;
}

function withNested<K extends 'defaults' | 'globals'>(
  file: EusnipsFile,
  key: K,
  property: string,
  value: unknown
): EusnipsFile {
  const current = { ...((file[key] ?? {}) as Record<string, unknown>) };
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete current[property];
  else current[property] = value;
  const next = { ...file };
  if (Object.keys(current).length === 0) delete next[key];
  else next[key] = current as EusnipsFile[K];
  return next;
}

/** Sets one property of the file's `defaults`, dropping the object when it empties. */
export function withDefault(file: EusnipsFile, property: string, value: unknown): EusnipsFile {
  return withNested(file, 'defaults', property, value);
}

/** Sets one property of the file's `globals`, dropping the object when it empties. */
export function withGlobal(file: EusnipsFile, property: string, value: unknown): EusnipsFile {
  return withNested(file, 'globals', property, value);
}

/**
 * Whether a string is JSON, and what was wrong with it when it is not.
 *
 * Whole objects are edited as JSON in Advanced mode — `metadata`, a nested
 * context — and a half-typed object is a normal thing to have on screen. This is
 * what lets the field say "that is not JSON yet" instead of the editor either
 * accepting a broken value or refusing the keystroke.
 */
export function parseJsonField(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The text a JSON field shows for a value that may not exist. */
export function jsonFieldText(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}


// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * There is no `fieldStyle` / `buttonStyle` / `toolbarStyle` here any more.
 *
 * Every control in this window used to be a spread of one of those four objects,
 * which is precisely how a window with sixty controls ends up with sixty
 * slightly different ones: the third copy of "a text field" is where the padding
 * changes by a pixel and nobody notices for a month. The surfaces now come from
 * `../SettingsSurfaces.css`, composed out of the design system's own primitives —
 * `.eu-input`, `.eu-btn`, `.eu-btn-quiet`, `.eu-icon-btn`, `.eu-chip`, `.eu-kbd` —
 * so a form field here is the same object as a form field in Settings, the
 * command centre and the rename box.
 *
 * What is still inline below is only what a test reads back (the trailing
 * whitespace marker's `borderRight`) or what is genuinely computed per render:
 * the fitted height of a growing text area, which way a drag is dropping, and
 * which mode the editor is in.
 */

const Field: React.FC<{
  label: string;
  hint?: string;
  /** Whether to show the hint. Advanced mode does; Simple mode stays quiet. */
  hints?: boolean;
  issues?: FieldIssue[];
  children: React.ReactNode;
}> = ({ label, hint, hints = true, issues = [], children }) => (
  <div className="eu-snippets__field">
    <span className="eu-snippets__field-label">{label}</span>
    {children}
    {hints && hint && <span className="eu-snippets__hint">{hint}</span>}
    {issues.map((issue, index) => (
      <span
        key={`${issue.field}-${index}`}
        className={`eu-snippets__issue eu-snippets__issue--${issue.level === 'error' ? 'error' : 'warning'}`}
      >
        {issue.message}
      </span>
    ))}
  </div>
);

/**
 * A text area that is as tall as what is in it.
 *
 * A trigger is short and a body is long, and neither has a length the editor can
 * guess: a fixed number of rows means a one-word trigger sits in a box with room
 * for three, and a five-line body scrolls inside a box with room for ten. So the
 * box follows the text — up to a limit, past which it stays put and scrolls,
 * because a body of two hundred lines must not push the fields below it off the
 * screen.
 *
 * The height is set from `scrollHeight` rather than from a count of newlines,
 * which is what makes a long single line wrap and grow instead of scrolling
 * sideways.
 */
const GrowingTextArea: React.FC<{
  value: string;
  onChange(next: string): void;
  'aria-label': string;
  /** Rows the box starts at, so an empty one is still a usable target. */
  minRows?: number;
  /** Rows it stops growing at; past this it scrolls. */
  maxRows?: number;
  single?: boolean;
  spellCheck?: boolean;
  showTrailingWhitespace?: boolean;
  showNewlineStartGuide?: boolean;
  style?: React.CSSProperties;
  onKeyDown?(event: React.KeyboardEvent<HTMLTextAreaElement>): void;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}> = ({
  value,
  onChange,
  minRows = 1,
  maxRows = 12,
  single = false,
  showTrailingWhitespace = false,
  showNewlineStartGuide = false,
  style,
  textareaRef,
  ...rest
}) => {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const area = textareaRef ?? own;
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // Measured from the text, not from the DOM's current height: shrinking back
  // when a line is deleted is half of "grows with the text".
  const fit = useCallback(
    (element: HTMLTextAreaElement | null) => {
      if (!element) return;
      const lineHeight = 16;
      const vertical = element.offsetHeight - element.clientHeight;
      element.style.height = 'auto';
      const wanted = element.scrollHeight + vertical;
      element.style.height = `${Math.min(Math.max(wanted, minRows * lineHeight), maxRows * lineHeight)}px`;
      element.style.overflowY = wanted > maxRows * lineHeight ? 'auto' : 'hidden';
    },
    [minRows, maxRows]
  );

  const syncScroll = useCallback(() => {
    if (!area.current || !overlayRef.current) return;
    overlayRef.current.scrollTop = area.current.scrollTop;
    overlayRef.current.scrollLeft = area.current.scrollLeft;
  }, [area]);

  useEffect(() => {
    fit(area.current);
    if (showTrailingWhitespace || showNewlineStartGuide) {
      syncScroll();
    }
  }, [fit, area, value, showTrailingWhitespace, showNewlineStartGuide, syncScroll]);

  const textareaElement = (
    <textarea
      {...rest}
      ref={area}
      value={value}
      rows={minRows}
      spellCheck={rest.spellCheck ?? false}
      wrap={single ? 'soft' : 'off'}
      onChange={(event) => onChange(event.target.value)}
      onScroll={() => {
        if (showTrailingWhitespace || showNewlineStartGuide) {
          syncScroll();
        }
      }}
      className={`eu-input eu-snippets__code-input eu-snippets__fitting${showNewlineStartGuide ? ' eu-snippets__edge' : ''}`}
      style={{
        // Fitted per render by `fit()` below: the box is as tall as its text
        // between two caps, and both caps are computed from `minRows`/`maxRows`.
        minHeight: minRows * 16 + 8,
        maxHeight: maxRows * 16 + 8,
        // `fit()` measures in 16px lines, so the line height is stated where that
        // code can be read next to it rather than only in the stylesheet.
        lineHeight: '16px',
        whiteSpace: single ? 'pre-wrap' : 'pre',
        ...style
      }}
    />
  );

  if (!showTrailingWhitespace && !showNewlineStartGuide) {
    return textareaElement;
  }

  const lines = value.split('\n');

  return (
    <div className="eu-snippets__grow" style={{ width: style?.width ?? '100%' }}>
      {textareaElement}
      {showNewlineStartGuide && (
        <div
          data-testid="newline-start-indicator"
          aria-hidden
          title="Where a newline would start"
          className="eu-snippets__newline-indicator"
        />
      )}
      <div
        ref={overlayRef}
        aria-hidden
        className={`eu-snippets__overlay${showNewlineStartGuide ? ' eu-snippets__overlay--edged' : ''}`}
      >
        {showNewlineStartGuide && (
          <div data-testid="newline-start-guide" aria-hidden className="eu-snippets__newline-guide" />
        )}
        {showTrailingWhitespace &&
          lines.map((line, idx) => {
            const cleanLine = line.replace(/\r$/, '');
            const match = cleanLine.match(/^(.*?)([ \t]+)$/);
            return (
              <div
                key={idx}
                className="eu-snippets__overlay-line"
                style={{ whiteSpace: single ? 'pre-wrap' : 'pre' }}
              >
                {match ? (
                  <>
                    <span className="eu-snippets__overlay-hidden">{match[1]}</span>
                    <span data-testid="trailing-whitespace-bg" className="eu-snippets__trailing-bg">
                      {match[2]}
                    </span>
                    <span
                      data-testid="trailing-whitespace-indicator"
                      title="Trailing whitespace"
                      // Inline because a test reads it back: `snippets-manager.render.test.ts`
                      // asserts this element's `style.borderRight` contains `solid`.
                      // Everything else about the marker is `.eu-snippets__trailing-indicator`.
                      style={{ borderRight: '2px solid var(--eu-success, #22c55e)' }}
                      className="eu-snippets__trailing-indicator"
                    />
                  </>
                ) : (
                  <span className="eu-snippets__overlay-hidden">{cleanLine || '\u00A0'}</span>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
};

/** A checkbox row that reads as a sentence rather than as a form control. */
const Toggle: React.FC<{
  checked: boolean;
  label: string;
  hint?: string;
  /** Whether to show the hint. Advanced mode does; Simple mode stays quiet. */
  hints?: boolean;
  onChange(next: boolean): void;
}> = ({ checked, label, hint, hints = true, onChange }) => (
  <label className="eu-snippets__toggle">
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span>
      {label}
      {hints && hint && <span className="eu-snippets__hint eu-snippets__hint--block">{hint}</span>}
    </span>
  </label>
);

/**
 * The marker a row carries while its entry differs from the file on disk.
 *
 * The same grey dot the tab bar uses for an unsaved document, because it means
 * the same thing: this has changed and is not written yet.
 */
const UnsavedDot: React.FC<{ title?: string }> = ({ title = 'Unsaved changes' }) => (
  <span title={title} aria-label={title} className="eu-dot eu-snippets__unsaved" />
);

/**
 * How much of the format the editor is showing.
 *
 * Two views of one snippet, not two snippets. Simple is what almost every
 * snippet needs — what it is called, what it matches, what it inserts — and
 * Advanced is the rest of the schema, including the parts that are stored and
 * reported but that the engine does not act on yet. Both are given the *same*
 * object and both report a change the same way, so switching between them cannot
 * lose a field: the one that is not on screen is still in the object being
 * edited, and nothing is ever rebuilt from the controls.
 *
 * The mode is view state, not file state. It is deliberately not written to the
 * snippet or to the settings — a library opened on another machine should not
 * arrive in a mode someone else chose.
 */

const ModeToggle: React.FC<{
  mode: EditorMode;
  onChange(next: EditorMode): void;
  /** What is being edited, for the label of the control. */
  subject?: string;
}> = ({ mode, onChange, subject = 'editor' }) => (
  <div role="group" aria-label={`${subject} mode`} className="eu-snippets__mode">
    {(['simple', 'advanced'] as const).map((value) => (
      <button
        key={value}
        type="button"
        aria-pressed={mode === value}
        title={
          value === 'simple'
            ? 'The fields a snippet usually needs: what it matches and what it inserts.'
            : 'Every property the format defines for this snippet.'
        }
        onClick={() => onChange(value)}
        className="eu-snippets__mode-button"
      >
        {value === 'simple' ? 'Simple' : 'Advanced'}
      </button>
    ))}
  </div>
);

/**
 * The yellow triangle, and the list behind it.
 *
 * The marker has to answer "what is wrong with this one?" without the reader
 * having to select the entry, scroll the form and read four fields — so hovering
 * it opens the problems themselves, one line each, labelled with the field they
 * belong to.
 *
 * It opens on focus as well as on hover: a tooltip that only a mouse can reach
 * is a tooltip half the readers do not have. No portal and no positioning
 * library — the panel is anchored under its own triangle, which is where the
 * reader is already looking, and a popover that has to measure the window is one
 * that gets stuck on the edge of it.
 */
const ProblemTriangle: React.FC<{
  problems: readonly SnippetProblem[];
  /** Rendered before the list; usually the snippet's name. */
  subject?: string;
  size?: number;
}> = ({ problems, subject, size = 12 }) => {
  const [open, setOpen] = React.useState(false);
  if (problems.length === 0) return null;

  const errors = problems.filter((problem) => problem.level === 'error').length;
  const warnings = problems.length - errors;
  const summary =
    `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;

  return (
    <span
      className="eu-snippets__problem"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        // Focusable and labelled, so the same list is reachable from the
        // keyboard and by a screen reader, which cannot hover.
        tabIndex={0}
        role="button"
        aria-label={`${subject ? `${subject}: ` : ''}${summary}. Show the problems.`}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen((was) => !was);
          }
        }}
        className="eu-snippets__problem-marker"
      >
        <TriangleAlert size={size} strokeWidth={1.8} />
      </span>

      {open && (
        <span role="tooltip" className="eu-snippets__tooltip">
          <span className="eu-snippets__tooltip-head">
            {subject ? `${subject} — ` : ''}
            {summary}
          </span>
          {problems.map((problem, at) => (
            <span key={`${problem.field}-${at}`} className="eu-snippets__tooltip-line">
              <strong className={`eu-snippets__tooltip-field--${problem.level === 'error' ? 'error' : 'warning'}`}>
                {FIELD_LABELS[problem.field]}
              </strong>
              {' — '}
              {problem.message}
            </span>
          ))}
        </span>
      )}
    </span>
  );
};

/**
 * One row of the library list.
 *
 * Everything the row draws is handed to it as a value rather than looked up
 * inside it, so that the memo below can decide whether this row has anything new
 * to say. That matters because the list is re-rendered on *every* keystroke: the
 * document changes, so the component that draws it has to be asked again, and a
 * library of a thousand entries must not rebuild a thousand rows because one of
 * them is being typed into. Comparing a handful of strings is what makes typing
 * cost the form rather than the whole library.
 */
interface SnippetRowProps {
  index: number;
  snippet: EusnipsSnippet;
  /** What the trigger reads as, for the row's first column. */
  summary: string;
  /** The description, or a preview of the body when there is none. */
  preview: string;
  problems: readonly SnippetProblem[];
  isSelected: boolean;
  disabled: boolean;
  /** True when the entry differs from the file on disk. */
  unsaved: boolean;
  isDragging?: boolean;
  dropPosition?: 'before' | 'after' | null;
  onSelect(index: number): void;
  onToggle(index: number, enabled: boolean): void;
  onDragStart?(event: React.DragEvent, index: number): void;
  onDragOver?(event: React.DragEvent, index: number): void;
  onDragLeave?(event: React.DragEvent, index: number): void;
  onDrop?(event: React.DragEvent, index: number): void;
  onDragEnd?(): void;
}

const sameProblems = (before: readonly SnippetProblem[], after: readonly SnippetProblem[]): boolean =>
  before === after ||
  (before.length === after.length &&
    before.every(
      (problem, at) =>
        problem.message === after[at].message &&
        problem.level === after[at].level &&
        problem.field === after[at].field
    ));

const SnippetRow: React.FC<SnippetRowProps> = ({
  index,
  snippet,
  summary,
  preview,
  problems,
  isSelected,
  disabled,
  unsaved,
  isDragging = false,
  dropPosition = null,
  onSelect,
  onToggle,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd
}) => (
  <div
    role="button"
    tabIndex={0}
    aria-pressed={isSelected}
    title={snippet.description || summary}
    draggable
    onClick={() => onSelect(index)}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect(index);
      }
    }}
    onDragStart={(event) => onDragStart?.(event, index)}
    onDragOver={(event) => onDragOver?.(event, index)}
    onDragLeave={(event) => onDragLeave?.(event, index)}
    onDrop={(event) => onDrop?.(event, index)}
    onDragEnd={onDragEnd}
    // The row's state is a set of classes rather than a style object: every one
    // of these is a property of *this* row that the stylesheet already knows how
    // to draw, and a row that styles itself is a row that can disagree with the
    // one above it. Selection is read off `aria-pressed`, which is the same
    // attribute assistive technology reads.
    className={[
      'eu-snippets__row',
      disabled ? 'eu-snippets__row--disabled' : '',
      isDragging ? 'eu-snippets__row--dragging' : '',
      dropPosition === 'before' ? 'eu-snippets__row--drop-before' : '',
      dropPosition === 'after' ? 'eu-snippets__row--drop-after' : ''
    ]
      .filter(Boolean)
      .join(' ')}
  >
    <span title="Drag to rearrange" className="eu-snippets__grip">
      <GripVertical size={12} strokeWidth={1.8} />
    </span>
    <code className="eu-mono eu-snippets__row-trigger">{summary || '(none)'}</code>
    <span className="eu-snippets__row-preview">{preview}</span>
    {/* The dot says "this one is not written yet", which is only interesting
        once the whole window saves at the end — hence next to the row rather than
        in a toolbar. */}
    {unsaved && <UnsavedDot />}
    {/* The triangle answers "what is wrong with this one?" where the question is
        asked — in the list — rather than only in the form. */}
    <ProblemTriangle problems={problems} subject={summary || snippet.id} />
    <input
      type="checkbox"
      checked={!disabled}
      aria-label={`Enable ${summary || snippet.id || 'snippet'}`}
      title={disabled ? 'Disabled — click to enable' : 'Enabled — click to disable'}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => onToggle(index, event.target.checked)}
      className="eu-snippets__row-check"
    />
  </div>
);

const MemoRow = React.memo(SnippetRow, (before, after) =>
  before.index === after.index &&
  before.isSelected === after.isSelected &&
  before.disabled === after.disabled &&
  before.unsaved === after.unsaved &&
  before.isDragging === after.isDragging &&
  before.dropPosition === after.dropPosition &&
  before.snippet === after.snippet &&
  before.summary === after.summary &&
  before.preview === after.preview &&
  sameProblems(before.problems, after.problems) &&
  // The handlers are read as well as the values: they are stable, so this costs
  // nothing, and if one ever stops being stable the row re-renders — which is the
  // safe way round for a callback that could otherwise be a stale one.
  before.onSelect === after.onSelect &&
  before.onToggle === after.onToggle &&
  before.onDragStart === after.onDragStart &&
  before.onDragOver === after.onDragOver &&
  before.onDragLeave === after.onDragLeave &&
  before.onDrop === after.onDrop &&
  before.onDragEnd === after.onDragEnd
);

export interface SnippetManagerProps {
  /** Overridden by tests; the application uses the process-wide store. */
  store?: ReturnType<typeof getSnippetStore>;
  /** Whether the window is showing. Defaults to open, for a host that mounts it directly. */
  open?: boolean;
  /**
   * The entry to select when the window opens.
   *
   * The sidebar's history knows which snippet fired, which is the one a reader
   * usually wants to look at; naming it here is what turns "that was a snippet"
   * into the entry itself rather than a search through several hundred rows.
   */
  focusSnippetId?: string | null;
  /**
   * Dismisses the window.
   *
   * The manager saves first and only calls this when the file has been written:
   * a window that closed on an unsaveable document would take the edits with it.
   * The shell is what actually owns whether the window is showing.
   */
  onClose?(): void;
  /**
   * Registers this manager's requestClose callback with the host.
   */
  registerCloseHandler?(handler: () => Promise<boolean>): () => void;
  /** Whether to render as a full-viewport standalone window rather than inside a modal. */
  standalone?: boolean;
}

export const SnippetManager: React.FC<SnippetManagerProps> = ({
  store: provided,
  open = true,
  focusSnippetId = null,
  onClose,
  registerCloseHandler,
  standalone = false
}) => {
  const store = provided ?? getSnippetStore();
  const state = useSyncedSnapshot(store);

  const initial = useMemo(() => getRememberedSnippetManagerState(), []);

  const [query, setQuery] = useState(initial.query);
  const [status, setStatus] = useState<SnippetFilter['status']>(initial.status);
  const [contextFilter, setContextFilter] = useState<'all' | ContextKind | 'custom'>(initial.context);
  const [expandFilter, setExpandFilter] = useState<'all' | 'auto' | 'manual'>(initial.expand);
  const [boundaryFilter, setBoundaryFilter] = useState<'all' | 'whitespace' | 'word' | 'anywhere' | 'line-start'>(initial.boundary);
  const [tagFilter, setTagFilter] = useState<string>(initial.tag);
  const [hasScriptFilter, setHasScriptFilter] = useState<'all' | 'with-script' | 'without-script'>(initial.hasScript);
  const [filtersOpen, setFiltersOpen] = useState<boolean>(initial.filtersOpen ?? false);

  const file = state.file;

  const [selected, setSelected] = useState<number | null>(() => {
    if (initial.selectedId && file) {
      const at = file.snippets.findIndex((s) => s.id === initial.selectedId);
      if (at >= 0) return at;
    }
    if (initial.selectedIndex !== null && file && initial.selectedIndex >= 0 && initial.selectedIndex < file.snippets.length) {
      return initial.selectedIndex;
    }
    return file && file.snippets.length > 0 ? 0 : null;
  });
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [section, setSection] = useState<'snippet' | 'file'>(initial.section);
  const [mode, setMode] = useState<EditorMode>(initial.mode);
  /** Why the last close attempt did not happen, if it did not. */
  const [closeError, setCloseError] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; position: 'before' | 'after' } | null>(null);

  const listHandleRef = useRef<ScrollAreaHandle | null>(null);
  const initialScrollRestoredRef = useRef(false);

  const allTags = useMemo(() => {
    if (!file) return [];
    const set = new Set<string>();
    if (file.defaults?.tags) {
      file.defaults.tags.forEach((t) => set.add(t));
    }
    file.snippets.forEach((s) => {
      s.tags?.forEach((t) => set.add(t));
    });
    return Array.from(set).sort();
  }, [file]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (contextFilter !== 'all') count++;
    if (expandFilter !== 'all') count++;
    if (boundaryFilter !== 'all') count++;
    if (tagFilter !== 'all') count++;
    if (hasScriptFilter !== 'all') count++;
    return count;
  }, [contextFilter, expandFilter, boundaryFilter, tagFilter, hasScriptFilter]);

  const clearAllFilters = useCallback(() => {
    setQuery('');
    setStatus('all');
    setContextFilter('all');
    setExpandFilter('all');
    setBoundaryFilter('all');
    setTagFilter('all');
    setHasScriptFilter('all');
  }, []);

  const visible = useMemo(
    () =>
      file
        ? filterSnippets(
            file,
            state.issues,
            {
              query,
              status,
              context: contextFilter,
              expand: expandFilter,
              boundary: boundaryFilter,
              tag: tagFilter,
              hasScript: hasScriptFilter
            },
            state.validationIssues
          )
        : [],
    [file, state.issues, state.validationIssues, query, status, contextFilter, expandFilter, boundaryFilter, tagFilter, hasScriptFilter]
  );

  // Restore scroll position when elements are ready
  useEffect(() => {
    if (initialScrollRestoredRef.current || !listHandleRef.current) return;
    if (initial.scrollTop && initial.scrollTop > 0) {
      initialScrollRestoredRef.current = true;
      const timer = setTimeout(() => {
        listHandleRef.current?.scrollTo(initial.scrollTop, false);
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [initial.scrollTop, visible]);

  const scrollToTop = useCallback(() => {
    listHandleRef.current?.scrollTo(0, true);
    saveRememberedSnippetManagerState({ scrollTop: 0 });
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = listHandleRef.current?.getElement();
    if (el) {
      const target = el.scrollHeight;
      listHandleRef.current?.scrollTo(target, true);
      saveRememberedSnippetManagerState({ scrollTop: target });
    }
  }, []);

  // Which entries differ from the file on disk. Recomputed when either document
  // changes, which is once per edit — the comparison is a stringify per entry, and
  // it is what makes the dots honest rather than a list of controls that were
  // touched (undo an edit and the dot goes away, which is the point).
  const unsaved = useMemo(
    () => (file ? unsavedSnippets(file, state.savedFile) : new Set<number>()),
    [file, state.savedFile]
  );

  const initialSelectionResolved = useRef(false);

  // Keep the selection on something that exists: deleting the last row, or a
  // filter that hides the selected one, must not leave the editor pointing at a
  // snippet that is no longer in the file.
  useEffect(() => {
    if (file === null) return;
    if (!initialSelectionResolved.current) {
      initialSelectionResolved.current = true;
      if (selected !== null && selected >= 0 && selected < file.snippets.length) {
        return;
      }
      if (initial.selectedId) {
        const at = file.snippets.findIndex((s) => s.id === initial.selectedId);
        if (at >= 0) {
          setSelected(at);
          return;
        }
      }
      if (initial.selectedIndex !== null && initial.selectedIndex >= 0 && initial.selectedIndex < file.snippets.length) {
        setSelected(initial.selectedIndex);
        return;
      }
      setSelected(file.snippets.length > 0 ? 0 : null);
      return;
    }

    if (selected !== null && selected < file.snippets.length) return;
    setSelected(file.snippets.length > 0 ? Math.max(0, file.snippets.length - 1) : null);
  }, [file, selected, initial]);

  const lastHandledFocusIdRef = useRef<string | null>(null);

  // An entry the shell pointed at is selected when the window opens on it.
  useEffect(() => {
    if (!open || !file || !focusSnippetId) return;
    if (lastHandledFocusIdRef.current === focusSnippetId) return;
    lastHandledFocusIdRef.current = focusSnippetId;
    const at = file.snippets.findIndex((snippet) => snippet.id === focusSnippetId);
    if (at < 0) return;
    setSelected(at);
    setSection('snippet');
    setPendingDelete(null);
  }, [open, file, focusSnippetId]);

  // Persist current state whenever view state changes
  useEffect(() => {
    if (!file) return;
    const selectedSnippet = selected !== null && selected >= 0 && selected < file.snippets.length ? file.snippets[selected] : null;
    saveRememberedSnippetManagerState({
      query,
      status,
      context: contextFilter,
      expand: expandFilter,
      boundary: boundaryFilter,
      tag: tagFilter,
      hasScript: hasScriptFilter,
      selectedId: selectedSnippet ? selectedSnippet.id : (selected === null ? inMemoryState.selectedId : null),
      selectedIndex: selected !== null ? selected : inMemoryState.selectedIndex,
      section,
      mode,
      filtersOpen
    });
  }, [file, query, status, contextFilter, expandFilter, boundaryFilter, tagFilter, hasScriptFilter, selected, section, mode, filtersOpen]);

  /**
   * Applies an edit to the document in memory, and nothing else.
   *
   * The window writes once, when it closes, so every edit here is a change to
   * what is on screen — the list, the validation and the engine all see it at
   * once, which is what makes a trigger work as soon as it is typed — and no
   * change to the file. That is the whole of "it does not save as you type": the
   * only write is {@link requestClose}'s.
   */
  const commit = useCallback(
    (next: EusnipsFile) => {
      setCloseError(null);
      store.apply(next);
    },
    [store]
  );

  const editSelected = useCallback(
    (patch: Partial<EusnipsSnippet>) => {
      if (!file || selected === null) return;
      const current = file.snippets[selected];
      commit(replaceSnippet(file, selected, { ...current, ...patch }));
    },
    [commit, file, selected]
  );

  const isClosingRef = useRef(false);

  /**
   * Saves and dismisses the window.
   *
   * A document that cannot be written leaves the window open with the reason on
   * screen: closing it anyway would be exactly the moment the user's edits are
   * lost, and they are edits the file has never seen.
   */
  const requestClose = useCallback(async (): Promise<boolean> => {
    if (isClosingRef.current) return false;
    isClosingRef.current = true;

    const selectedSnippet = file && selected !== null && selected < file.snippets.length ? file.snippets[selected] : null;
    const currentScrollTop = listHandleRef.current?.getElement()?.scrollTop ?? inMemoryState.scrollTop ?? 0;
    saveRememberedSnippetManagerState({
      query,
      status,
      context: contextFilter,
      expand: expandFilter,
      boundary: boundaryFilter,
      tag: tagFilter,
      hasScript: hasScriptFilter,
      selectedId: selectedSnippet ? selectedSnippet.id : (selected === null ? inMemoryState.selectedId : null),
      selectedIndex: selected !== null ? selected : inMemoryState.selectedIndex,
      scrollTop: currentScrollTop,
      section,
      mode,
      filtersOpen
    });

    if (store.getSnapshot().dirty) {
      const saved = await store.flush();
      if (!saved) {
        isClosingRef.current = false;
        setCloseError(
          store.getSnapshot().saveError ??
            store.getSnapshot().parseError ??
            'the library could not be written, so it has been left open'
        );
        return false;
      }
    }
    setCloseError(null);
    onClose?.();
    return true;
  }, [store, onClose, file, selected, query, status, contextFilter, expandFilter, boundaryFilter, tagFilter, hasScriptFilter, section, mode, filtersOpen]);

  useEffect(() => {
    if (registerCloseHandler) {
      return registerCloseHandler(requestClose);
    }
  }, [registerCloseHandler, requestClose]);

  const latestViewSnapshotRef = useRef({
    file,
    selected,
    query,
    status,
    contextFilter,
    expandFilter,
    boundaryFilter,
    tagFilter,
    hasScriptFilter,
    section,
    mode,
    filtersOpen,
    listHandleRef
  });
  latestViewSnapshotRef.current = {
    file,
    selected,
    query,
    status,
    contextFilter,
    expandFilter,
    boundaryFilter,
    tagFilter,
    hasScriptFilter,
    section,
    mode,
    filtersOpen,
    listHandleRef
  };

  useEffect(() => {
    return () => {
      const s = latestViewSnapshotRef.current;
      const selectedSnippet = s.file && s.selected !== null && s.selected < s.file.snippets.length ? s.file.snippets[s.selected] : null;
      const currentScrollTop = s.listHandleRef.current?.getElement()?.scrollTop ?? inMemoryState.scrollTop ?? 0;
      saveRememberedSnippetManagerState({
        query: s.query,
        status: s.status,
        context: s.contextFilter,
        expand: s.expandFilter,
        boundary: s.boundaryFilter,
        tag: s.tagFilter,
        hasScript: s.hasScriptFilter,
        selectedId: selectedSnippet ? selectedSnippet.id : (s.selected === null ? inMemoryState.selectedId : null),
        selectedIndex: s.selected !== null ? s.selected : inMemoryState.selectedIndex,
        scrollTop: currentScrollTop,
        section: s.section,
        mode: s.mode,
        filtersOpen: s.filtersOpen
      });

      if (store.getSnapshot().dirty) {
        void store.flush();
      }
    };
  }, [store]);

  const handleEditorKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        void requestClose();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        void store.flush();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        event.stopPropagation();
        void requestClose();
        return;
      }
      event.stopPropagation();
    },
    [requestClose, store]
  );

  const handleDialogKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        void store.flush();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        event.stopPropagation();
        void requestClose();
        return;
      }
    },
    [requestClose, store]
  );

  // Stable, because the list's rows are memoized on them: a handler that was
  // rebuilt on every render would rebuild every row with it.
  const selectRow = useCallback((index: number) => {
    setSelected(index);
    setSection('snippet');
    setPendingDelete(null);
  }, []);

  const toggleRow = useCallback(
    (index: number, enabled: boolean) => {
      store.edit((current) => replaceSnippet(current, index, { ...current.snippets[index], enabled }));
    },
    [store]
  );

  const handleDragStart = useCallback((event: React.DragEvent, index: number) => {
    event.dataTransfer.setData('text/plain', String(index));
    event.dataTransfer.effectAllowed = 'move';
    setDraggedIndex(index);
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent, index: number) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const position: 'before' | 'after' = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setDropTarget((prev) => (prev?.index === index && prev?.position === position ? prev : { index, position }));
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent, index: number) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropTarget((prev) => (prev?.index === index ? null : prev));
    }
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent, targetIndex: number) => {
      event.preventDefault();
      const rawFrom = event.dataTransfer.getData('text/plain');
      const fromIndex = draggedIndex ?? (rawFrom ? Number(rawFrom) : null);
      if (!file || fromIndex === null || isNaN(fromIndex) || fromIndex === targetIndex) {
        setDraggedIndex(null);
        setDropTarget(null);
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const position: 'before' | 'after' = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      let toIndex = targetIndex;
      if (position === 'before') {
        toIndex = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
      } else {
        toIndex = fromIndex < targetIndex ? targetIndex : targetIndex + 1;
      }

      if (toIndex !== fromIndex && toIndex >= 0 && toIndex < file.snippets.length) {
        commit(reorderSnippet(file, fromIndex, toIndex));
        setSelected(toIndex);
      }
      setDraggedIndex(null);
      setDropTarget(null);
    },
    [file, draggedIndex, commit]
  );

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
    setDropTarget(null);
  }, []);

  const busy = state.busy;

  // ---------------------------------------------------------------- render

  if (!file) {
    if (standalone) {
      return (
        <div className="eu-snippets eu-snippets--standalone" onKeyDown={handleDialogKeyDown}>
          <StandaloneTitleBar
            title="Snippet Library"
            icon={Zap}
            onClose={() => void requestClose()}
          />
          <div className="eu-snippets__unloaded">
            <div className="eu-snippets__actions-row">
              <button
                type="button"
                className="eu-btn eu-btn-secondary"
                title="Read the snippet file again"
                onClick={() => void store.reload()}
              >
                <RotateCcw size={12} strokeWidth={1.8} /> Reload
              </button>
            </div>
            <div className="eu-snippets__hint">
              {state.readError ?? state.parseError ?? 'The snippet library has not been loaded yet.'}
            </div>
          </div>
        </div>
      );
    }

    return (
      <Modal
        open={open}
        onClose={() => void requestClose()}
        title="Snippet Library"
        width="min(1500px, calc(100vw - 40px))"
        height="calc(100vh - 48px)"
        fill
      >
        <div className="eu-snippets eu-snippets__unloaded" onKeyDown={handleDialogKeyDown}>
          <div className="eu-snippets__actions-row">
            <button
              type="button"
              className="eu-btn eu-btn-secondary"
              title="Read the snippet file again"
              onClick={() => void store.reload()}
            >
              <RotateCcw size={12} strokeWidth={1.8} /> Reload
            </button>
          </div>
          <div className="eu-snippets__hint">
            {state.readError ?? state.parseError ?? 'The snippet library has not been loaded yet.'}
          </div>
        </div>
      </Modal>
    );
  }

  const selectedSnippet = selected !== null ? file.snippets[selected] : null;
  const selectedIssues = selected !== null ? fieldIssuesFor(selected, state.validationIssues, state.issues) : [];
  const issuesFor = (field: FieldIssue['field']) => selectedIssues.filter((issue) => issue.field === field);
  const fileIssues = state.issues.filter((issue) => issue.index === null);

  const footerContent = (
    <>
      {/* One line of state, and it is *coloured* state: a close that failed is
          the one thing in this window the reader has to act on, and an unsaved
          document is the one thing they should not walk away from. */}
      <span
        className={`eu-snippets__status${
          closeError ? ' eu-snippets__status--error' : unsaved.size > 0 || state.dirty ? ' eu-snippets__status--dirty' : ''
        }`}
      >
        {closeError ??
          (unsaved.size > 0
            ? `${unsaved.size} unsaved snippet${unsaved.size === 1 ? '' : 's'} — closing writes them`
            : // No entry differs, but the document still does: a reorder or a
              // file-level setting has no row to mark, and saying "Saved" then
              // would be a lie the Save button contradicts.
              state.dirty
              ? 'Unsaved changes — closing writes them'
              : 'Saved')}
      </span>
      <span className="eu-snippets__footer-spacer" />
      <button
        type="button"
        className="eu-btn eu-snippets__footer-button"
        title="Write the library to disk now, without closing"
        disabled={!state.dirty || Boolean(state.parseError)}
        onClick={() => void store.flush()}
      >
        <Save size={12} strokeWidth={1.8} /> Save
      </button>
      <button
        type="button"
        className="eu-btn eu-snippets__footer-button"
        title="Save and close (Esc)"
        onClick={() => void requestClose()}
      >
        Close
      </button>
    </>
  );

  const mainView = (
    <div className="eu-snippets__body" onKeyDown={handleDialogKeyDown}>
        {/* ------------------------------------------------------------ list */}
        <div className="eu-snippets__list-pane">
        {/* The library's own name, where the window's title bar would be if the
            modal had not already said it. */}
        <div className="eu-snippets__pane-header">
          <span className="eu-snippets__pane-header-name">{file.name || 'Snippets'}</span>
          <span className="eu-snippets__pane-header-count">
            {file.snippets.length} snippet{file.snippets.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="eu-snippets__search-row eu-search">
          <Search size={13} strokeWidth={1.8} />
          <div className="eu-snippets__search-field">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleEditorKeyDown}
              placeholder="Filter snippets"
              aria-label="Filter snippets"
              title="Filter by trigger, description, id, tag or body"
              spellCheck={false}
              className="eu-input eu-snippets__search"
            />
            {query.length > 0 && (
              <button
                type="button"
                aria-label="Clear search"
                title="Clear search"
                onClick={() => setQuery('')}
                className="eu-icon-btn eu-snippets__clear"
              >
                <X size={12} strokeWidth={2} />
              </button>
            )}
          </div>
          <select
            value={status}
            aria-label="Filter by state"
            title="Show every snippet, only the enabled ones, only the disabled ones, or only the ones with a problem"
            onChange={(event) => setStatus(event.target.value as SnippetFilter['status'])}
            className="eu-input eu-snippets__select eu-snippets__select--state"
          >
            <option value="all">All</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
            <option value="problems">Problems</option>
          </select>
          <button
            type="button"
            aria-label="Toggle comprehensive filters"
            aria-pressed={filtersOpen}
            title={filtersOpen ? 'Hide advanced filters' : 'Show advanced filters (context, expansion, tags, etc.)'}
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={`eu-btn eu-snippets__filter-toggle${
              filtersOpen || activeFilterCount > 0 ? ' eu-snippets__filter-toggle--on' : ''
            }`}
          >
            <Filter size={12} strokeWidth={1.8} />
            {activeFilterCount > 0 && <span className="eu-snippets__filter-count">{activeFilterCount}</span>}
          </button>
        </div>

        {filtersOpen && (
          <div data-testid="comprehensive-filters" className="eu-snippets__filters">
            <div className="eu-snippets__filters-head">
              <span className="eu-eyebrow">Filters</span>
              {(activeFilterCount > 0 || status !== 'all' || query.trim() !== '') && (
                <button
                  type="button"
                  className="eu-btn eu-snippets__link"
                  onClick={clearAllFilters}
                  title="Reset all filters and search"
                >
                  Clear all
                </button>
              )}
            </div>

            {/* Context */}
            <div className="eu-snippets__filter-row">
              <span className="eu-snippets__filter-label">Context</span>
              <select
                aria-label="Filter by context"
                value={contextFilter}
                onChange={(e) => setContextFilter(e.target.value as 'all' | ContextKind | 'custom')}
                className="eu-input eu-snippets__filter-select"
              >
                <option value="all">All contexts</option>
                {CONTEXT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {CONTEXT_LABELS[kind]}
                  </option>
                ))}
                <option value="custom">Custom expression</option>
              </select>
            </div>

            {/* Expansion */}
            <div className="eu-snippets__filter-row">
              <span className="eu-snippets__filter-label">Expand</span>
              <select
                aria-label="Filter by expansion"
                value={expandFilter}
                onChange={(e) => setExpandFilter(e.target.value as 'all' | 'auto' | 'manual')}
                className="eu-input eu-snippets__filter-select"
              >
                <option value="all">All expansions</option>
                <option value="auto">Auto-expand</option>
                <option value="manual">Manual (Tab)</option>
              </select>
            </div>

            {/* Boundary */}
            <div className="eu-snippets__filter-row">
              <span className="eu-snippets__filter-label">Boundary</span>
              <select
                aria-label="Filter by boundary"
                value={boundaryFilter}
                onChange={(e) => setBoundaryFilter(e.target.value as 'all' | 'whitespace' | 'word' | 'anywhere' | 'line-start')}
                className="eu-input eu-snippets__filter-select"
              >
                <option value="all">All boundaries</option>
                <option value="anywhere">Anywhere</option>
                <option value="word">Word boundary</option>
                <option value="whitespace">Whitespace</option>
                <option value="line-start">Line start</option>
              </select>
            </div>

            {/* Tag */}
            <div className="eu-snippets__filter-row">
              <span className="eu-snippets__filter-label">Tag</span>
              <select
                aria-label="Filter by tag"
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                className="eu-input eu-snippets__filter-select"
              >
                <option value="all">All tags</option>
                {allTags.map((tag) => (
                  <option key={tag} value={tag}>
                    #{tag}
                  </option>
                ))}
              </select>
            </div>

            {/* Script */}
            <div className="eu-snippets__filter-row">
              <span className="eu-snippets__filter-label">Script</span>
              <select
                aria-label="Filter by script"
                value={hasScriptFilter}
                onChange={(e) => setHasScriptFilter(e.target.value as 'all' | 'with-script' | 'without-script')}
                className="eu-input eu-snippets__filter-select"
              >
                <option value="all">All</option>
                <option value="with-script">With JavaScript</option>
                <option value="without-script">Without JavaScript</option>
              </select>
            </div>
          </div>
        )}

        <div className="eu-snippets__actions">
          <button
            type="button"
            className="eu-btn eu-snippets__action"
            title="Add a snippet and start editing it"
            onClick={() => {
              const snippet = createManagedSnippet(file);
              commit(appendSnippet(file, snippet));
              setSelected(file.snippets.length);
              setSection('snippet');
            }}
          >
            <Plus size={12} strokeWidth={2} /> Add
          </button>
          <button
            type="button"
            className="eu-btn eu-snippets__action"
            disabled={selected === null}
            title="Copy the selected snippet"
            onClick={() => {
              if (selected === null) return;
              commit(appendSnippet(file, duplicateManagedSnippet(file, selected)));
              setSelected(file.snippets.length);
            }}
          >
            <Copy size={12} strokeWidth={1.8} /> Duplicate
          </button>
          <button
            type="button"
            className={`eu-btn eu-snippets__action${
              pendingDelete === null ? '' : ' eu-snippets__action--danger'
            }`}
            disabled={selected === null}
            title={pendingDelete === null ? 'Delete the selected snippet' : 'Click again to confirm'}
            onClick={() => {
              if (selected === null) return;
              if (pendingDelete !== selected) {
                setPendingDelete(selected);
                return;
              }
              commit(removeSnippet(file, selected));
              setPendingDelete(null);
            }}
          >
            <Trash2 size={12} strokeWidth={1.8} /> {pendingDelete === null ? 'Delete' : 'Confirm'}
          </button>
          {/* A rule between the entry actions and the file action, drawn as a
              border on the button rather than as a separator element: the row's
              children are the controls it acts on and nothing else. */}
          <button
            type="button"
            className="eu-btn eu-snippets__action eu-snippets__action--split"
            title="Read the snippet file again, picking up hand-edits"
            onClick={async () => {
              resetRememberedSnippetManagerState();
              clearAllFilters();
              setSelected(0);
              setSection('snippet');
              setMode('simple');
              setFiltersOpen(false);
              listHandleRef.current?.scrollTo(0, false);
              await store.reload();
            }}
          >
            <RotateCcw size={12} strokeWidth={1.8} /> Reload
          </button>
        </div>

        <div className="eu-snippets__stats">
          <button
            type="button"
            aria-pressed={section === 'file'}
            onClick={() => setSection('file')}
            className="eu-btn eu-snippets__stats-button"
          >
            Library
          </button>
          <span>·</span>
          <span className="eu-snippets__count">
            {visible.length} of {file.snippets.length}
          </span>
          {activeFilterCount > 0 && (
            <button
              type="button"
              className="eu-btn eu-snippets__link"
              title="Reset comprehensive filters to All"
              onClick={clearAllFilters}
            >
              Reset filters
            </button>
          )}
          <span className="eu-snippets__stats-spacer" />
          <div className="eu-snippets__stats-arrows">
            <button
              type="button"
              data-testid="scroll-to-top-button"
              className="eu-icon-btn eu-snippets__scroll-button"
              title="Scroll to top of list"
              aria-label="Scroll to top"
              onClick={scrollToTop}
            >
              <ArrowUpToLine size={13} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              data-testid="scroll-to-bottom-button"
              className="eu-icon-btn eu-snippets__scroll-button"
              title="Scroll to bottom of list"
              aria-label="Scroll to bottom"
              onClick={scrollToBottom}
            >
              <ArrowDownToLine size={13} strokeWidth={1.8} />
            </button>
          </div>
          {unsaved.size > 0 && <UnsavedDot title={`${unsaved.size} snippet${unsaved.size === 1 ? '' : 's'} not written yet`} />}
          {busy && <span title="Saving">…</span>}
        </div>

        <ScrollArea
          handleRef={listHandleRef}
          className="eu-snippets__list"
          onScroll={(top) => {
            saveRememberedSnippetManagerState({ scrollTop: top });
          }}
        >
          {visible.map((index) => {
            const snippet = file.snippets[index];
            return (
              <MemoRow
                key={`${snippet.id ?? 'snippet'}-${index}`}
                index={index}
                snippet={snippet}
                summary={snippetSummary(snippet)}
                preview={snippet.description || snippetBodyPreview(snippet.body, 40)}
                problems={problemsFor(file, index, state.validationIssues, state.issues)}
                isSelected={selected === index && section === 'snippet'}
                disabled={snippet.enabled === false}
                unsaved={unsaved.has(index)}
                isDragging={draggedIndex === index}
                dropPosition={dropTarget?.index === index ? dropTarget.position : null}
                onSelect={selectRow}
                onToggle={toggleRow}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
              />
            );
          })}
          {visible.length === 0 && (
            <div className="eu-empty eu-snippets__empty">
              {file.snippets.length === 0
                ? 'The library is empty. Use Add to create the first snippet.'
                : 'No snippet matches that filter.'}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* ---------------------------------------------------------- editor */}
      <div className="eu-snippets__editor-pane">
        <div className="eu-snippets__pane-toolbar">
          <span className="eu-snippets__path" title={state.path}>
            {state.path || 'snippets.json'}
          </span>
          <span className="eu-snippets__footer-spacer" />
          {state.saveError && (
            <span className="eu-snippets__save-error" title={state.saveError}>
              not saved
            </span>
          )}
        </div>

        <ScrollArea className="eu-snippets__editor-scroll">
          {(state.parseError || state.saveError || state.readError) && (
            <pre className="eu-snippets__error">
              {state.readError ?? state.parseError ?? state.saveError}
            </pre>
          )}

          {section === 'file' ? (
            <FileSection
              file={file}
              state={state}
              mode={mode}
              onMode={setMode}
              onChange={(next) => commit(next)}
              onEditorKeyDown={handleEditorKeyDown}
            />
          ) : selectedSnippet ? (
            <>
              <div className="eu-snippets__snippet-header">
                <div className="eu-snippets__id-group">
                  <label htmlFor="snippet-header-id-input" className="eu-snippets__id-label">
                    ID
                  </label>
                  <input
                    id="snippet-header-id-input"
                    value={selectedSnippet.id ?? ''}
                    aria-label="Snippet ID"
                    placeholder="snippet-id"
                    spellCheck={false}
                    onKeyDown={handleEditorKeyDown}
                    onChange={(event) => editSelected({ id: event.target.value || undefined })}
                    onBlur={() => {
                      if (selectedSnippet.id !== undefined && selectedSnippet.id !== '') return;
                      editSelected({ id: uniqueSnippetId(snippetIds(file)) });
                    }}
                    className="eu-input eu-snippets__id-input"
                  />
                  <button
                    type="button"
                    className="eu-btn eu-btn-quiet"
                    title="Give this snippet a new random id that nothing else in the file uses"
                    onClick={() => editSelected({ id: uniqueSnippetId(snippetIds(file)) })}
                  >
                    <RotateCw size={12} strokeWidth={1.8} /> Generate
                  </button>
                  <ProblemTriangle
                    problems={selectedIssues}
                    subject={selectedSnippet.id || 'Snippet'}
                    size={13}
                  />
                </div>
                <div className="eu-snippets__header-actions">
                  <ModeToggle mode={mode} onChange={setMode} subject="Snippet editor" />
                  <button
                    type="button"
                    className="eu-icon-btn eu-snippets__move-button"
                    title="Move this snippet earlier in the file"
                    disabled={selected === null || selected === 0}
                    onClick={() => {
                      if (selected === null || selected === 0) return;
                      commit(moveSnippet(file, selected, -1));
                      setSelected(selected - 1);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="eu-icon-btn eu-snippets__move-button"
                    title="Move this snippet later in the file"
                    disabled={selected === null || selected >= file.snippets.length - 1}
                    onClick={() => {
                      if (selected === null || selected >= file.snippets.length - 1) return;
                      commit(moveSnippet(file, selected, 1));
                      setSelected(selected + 1);
                    }}
                  >
                    ↓
                  </button>
                </div>
              </div>

              {mode === 'advanced' && (
                <details className="eu-snippets__details">
                  <summary className="eu-snippets__summary">
                    <Braces size={11} strokeWidth={1.8} /> Entry as stored
                  </summary>
                  <pre className="eu-snippets__code">{snippetAsStored(selectedSnippet)}</pre>
                </details>
              )}

              <SnippetForm
                snippet={selectedSnippet}
                file={file}
                index={selected ?? 0}
                mode={mode}
                issues={issuesFor}
                onChange={editSelected}
                onEditorKeyDown={handleEditorKeyDown}
              />
            </>
          ) : (
            <div className="eu-empty eu-snippets__empty">Select a snippet, or use Add to create one.</div>
          )}

          {fileIssues.length > 0 && section === 'snippet' && (
            <div className="eu-snippets__issue-list-plain">
              {fileIssues.map((issue, index) => (
                <div key={index} className="eu-snippets__result-warning">
                  {issue.message}
                </div>
              ))}
            </div>
          )}

          <div className="eu-snippets__footnote">
            Snippets are stored in <code className="eu-snippets__code-inline">{state.path || 'snippets.json'}</code>.
            Every change is applied to the editor as you make it and written when this window closes, and a
            hand-edit of that file is picked up without a restart.
            {state.legacyFiles.length > 0 && (
              <LegacyNotice state={state} store={store} />
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );

  if (standalone) {
    return (
      <div className="eu-snippets eu-snippets--standalone" onKeyDown={handleDialogKeyDown}>
        <StandaloneTitleBar
          title="Snippet Library"
          subtitle={`${file.snippets.length} snippet${file.snippets.length === 1 ? '' : 's'}`}
          icon={Zap}
          onClose={() => void requestClose()}
        />
        <div className="eu-snippets__stage">
          {mainView}
        </div>
        <div className="eu-snippets__footer">
          {footerContent}
        </div>
      </div>
    );
  }

  return (
    <Modal
      open={open}
      onClose={() => void requestClose()}
      title="Snippet Library"
      width="min(1500px, calc(100vw - 40px))"
      height="calc(100vh - 48px)"
      fill
      footer={footerContent}
    >
      {mainView}
    </Modal>
  );
};

/**
 * Subscribes to the store the way React 19 wants a mutable external source
 * subscribed to: `getSnapshot` must return a value that only changes when the
 * data does, which the store guarantees by bumping `revision` on every change.
 */
function useSyncedSnapshot(store: ReturnType<typeof getSnippetStore>): SnippetStoreState {
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

// ---------------------------------------------------------------------------
// The snippet form
// ---------------------------------------------------------------------------

/**
 * The two editing interfaces, over one snippet.
 *
 * `SnippetForm` is handed the entry itself and reports a patch; it never copies
 * the entry into field state and never rebuilds one from the controls. That is
 * the whole of requirement (2): a property Simple mode does not show is still in
 * the object it is editing, so switching to Advanced shows it unchanged, and
 * switching back does not remove it. Nothing here can discard a field, because
 * nothing here holds one.
 */

interface FormProps {
  snippet: EusnipsSnippet;
  file: EusnipsFile;
  index: number;
  mode: EditorMode;
  issues(field: SnippetField): FieldIssue[];
  onChange(patch: Partial<EusnipsSnippet>): void;
  onEditorKeyDown?(event: React.KeyboardEvent<HTMLElement>): void;
}

/**
 * The whole form, and the one place the two modes differ.
 *
 * **Simple** is what a snippet needs to be useful: what it matches, whether it
 * fires by itself, whether it is offered at all, how it ranks, where it applies,
 * what it is called, and what it inserts. It is also deliberately *quiet* — no
 * explanatory text, no fields whose meaning has to be read before they can be
 * filled in — because the reader who wants that is the reader who will switch to
 * Advanced. Two things are deliberately narrow rather than absent: the contexts
 * it offers are the three the engine evaluates, and a value it has no option for
 * is still shown, so that looking at an entry in Simple can never be what
 * changes it. Problems are still shown: they are not guidance, they are the
 * reason a snippet will not do what its author meant.
 *
 * **Advanced** adds the rest of the schema: the boundary, the remaining
 * contexts, multi-line matching, tags, the script and the stored data — each with
 * the explanation it needs.
 *
 * Both modes are handed the *same* entry and report a patch, and neither keeps a
 * copy of it. A property Simple does not show is therefore still in the object
 * Advanced edits, and switching between them cannot lose anything.
 */
const SnippetForm: React.FC<FormProps> = (props) => (
  <>
    <SnippetMatching {...props} />
    <SnippetBehaviour {...props} />
    <SnippetContextField {...props} />
    <SnippetDescription {...props} />
    {props.mode === 'advanced' && <SnippetTags {...props} />}
    <SnippetBody {...props} />
    {props.mode === 'advanced' && <SnippetScriptAndData {...props} />}
  </>
);

/**
 * How the snippet behaves: the switches, the rank, where the match has to land,
 * and how much context it is read in.
 *
 * Every boolean here is a tick box in both modes, which is what a boolean is:
 * the alternatives — a two-option list, a "default or not" tri-state — make the
 * reader translate "off" into "no" before they can answer.
 */
const SnippetBehaviour: React.FC<FormProps> = ({ snippet, mode, issues, onChange, onEditorKeyDown }) => {
  const hints = mode === 'advanced';

  return (
    <>
      <div className="eu-snippets__toggle-row">
        <Toggle
          checked={snippet.expand === 'auto'}
          label="Automatic"
          hints={hints}
          hint="Expands the moment the trigger matches, without a completion list."
          onChange={(next) => onChange({ expand: next ? 'auto' : undefined })}
        />
        <Toggle
          checked={snippet.hidden === true}
          label="Hidden"
          hints={hints}
          hint="Still matches, but is not offered in the completion list."
          onChange={(next) => onChange({ hidden: next ? true : undefined })}
        />
        {mode === 'advanced' && (
          <>
            <Toggle
              checked={snippet.enabled !== false}
              label="Enabled"
              hints={hints}
              hint="A disabled snippet stays in the file and is not offered."
              onChange={(next) => onChange({ enabled: next ? undefined : false })}
            />
            <Toggle
              checked={snippet.multiline !== undefined && snippet.multiline !== false}
              label="Multi-line"
              hints={hints}
              hint="Matches against the previous lines as well as the current one."
              onChange={(next) => onChange({ multiline: next ? true : undefined })}
            />
          </>
        )}
      </div>

      <div className="eu-snippets__grid">
        <Field
          label="Priority"
          hints={hints}
          hint="Higher wins when more than one snippet matches."
          issues={issues('priority')}
        >
          <input
            type="number"
            value={snippet.priority ?? ''}
            placeholder="100"
            aria-label="Snippet priority"
            onKeyDown={onEditorKeyDown}
            onChange={(event) => {
              const raw = event.target.value;
              onChange({ priority: raw === '' ? undefined : Number(raw) });
            }}
            className="eu-input eu-tnum"
          />
        </Field>

        {mode === 'advanced' && (
          <Field
            label="Boundary"
            hints={hints}
            hint="How much of the text before the cursor the match has to be: anywhere (default), the whole token (after whitespace), the whole word, or one that starts the line."
            issues={issues('boundary')}
          >
            <select
              value={snippet.boundary ?? 'anywhere'}
              aria-label="Trigger boundary"
              onChange={(event) => onChange({ boundary: event.target.value as EusnipsSnippet['boundary'] })}
              className="eu-input"
            >
              <option value="anywhere">Anywhere</option>
              <option value="whitespace">After whitespace</option>
              <option value="word">Whole word</option>
              <option value="line-start">Start of line</option>
            </select>
          </Field>
        )}

        {mode === 'advanced' && typeof snippet.multiline === 'number' && (
          <Field label="Lines" hints={hints} hint="The count is kept and not honoured: the engine reads on or off, and always the configured number of lines.">
            <input
              type="number"
              min={1}
              value={snippet.multiline}
              aria-label="Multi-line line count"
              onKeyDown={onEditorKeyDown}
              onChange={(event) => onChange({ multiline: Math.max(1, Number(event.target.value) || 1) })}
              className="eu-input eu-tnum"
            />
          </Field>
        )}
      </div>
    </>
  );
};



/**
 * What the snippet matches.
 *
 * One box, because a trigger is one thing: a regular expression. There is no
 * "plain text or pattern?" switch to get wrong — the text a person types is a
 * pattern already, and the box grows with it, so a trigger of forty characters is
 * read rather than scrolled through. The regular-expression flags are Advanced's
 * business: `i` is the only one anybody wants on a snippet, and it is a decision
 * about matching rather than about what to type.
 */
const SnippetMatching: React.FC<FormProps> = ({ snippet, mode, issues, onChange, onEditorKeyDown }) => {
  const trigger = splitTrigger(snippet.trigger);
  const hints = mode === 'advanced';
  const readAs = `/${anchoredPattern(trigger.pattern)}/${trigger.flags}`;

  return (
    <div className="eu-snippets__group">
      <Field
        label="Trigger"
        hints={hints}
        hint={`Matched against the text before the cursor, anchored at the caret: this is read as ${readAs}. Write the grouping to capture as (…), and use it in the body as $1, $2 … Everything else is literal, so a full stop has to be written \\.`}
        issues={issues('trigger')}
      >
        <GrowingTextArea
          value={trigger.pattern}
          aria-label="Trigger"
          minRows={1}
          maxRows={6}
          single
          showTrailingWhitespace
          showNewlineStartGuide
          onKeyDown={onEditorKeyDown}
          onChange={(next) => onChange({ trigger: buildTrigger(next, trigger.flags) })}
          style={{ width: '100%' }}
        />
      </Field>

      {mode === 'advanced' && (
        <Field
          label="Flags"
          hint="Regular-expression flags. `i` matches either case, `s` lets `.` match a line break."
          issues={issues('flags')}
        >
          <input
            value={trigger.flags}
            aria-label="Regular expression flags"
            spellCheck={false}
            onKeyDown={onEditorKeyDown}
            onChange={(event) => onChange({ trigger: buildTrigger(trigger.pattern, event.target.value) })}
            className="eu-input eu-snippets__compact"
          />
        </Field>
      )}
    </div>
  );
};

/** What the snippet is called. */
const SnippetDescription: React.FC<FormProps> = ({ snippet, mode, issues, onChange, onEditorKeyDown }) => (
  <Field
    label="Description"
    hints={mode === 'advanced'}
    hint="Shown in the completion list and in the snippet list."
    issues={issues('description')}
  >
    <input
      value={snippet.description ?? ''}
      aria-label="Snippet description"
      spellCheck={false}
      onKeyDown={onEditorKeyDown}
      onChange={(event) => onChange({ description: event.target.value })}
      className="eu-input"
    />
  </Field>
);

/**
 * The context, as far as controls can express it.
 *
 * Simple mode offers the three kinds the engine evaluates — everywhere, maths,
 * text — and nothing else: a reader who wants "inside this environment" is a
 * reader who wants Advanced. What it never does is lie about what is stored: a
 * value it has no option for is still shown, selected and named, so an entry
 * cannot be silently rewritten by the act of looking at it in Simple.
 *
 * `all`, `any` and a nested `not` are legal contexts and not editable here at
 * all: a tree needs a tree editor. Advanced mode shows one as the JSON it is and
 * edits it as JSON — which keeps the promise that no mode silently rewrites a
 * value it does not have a control for.
 */
const SnippetContextField: React.FC<FormProps> = ({ snippet, mode, issues, onChange, onEditorKeyDown }) => {
  const kind = contextKind(snippet.context);
  const [json, setJson] = useState(() => jsonFieldText(snippet.context));
  const [error, setError] = useState<string | null>(null);

  // The stored value is the source of truth: when it changes from anywhere else
  // — the other mode, a hand-edit of the file — the text box follows it.
  useEffect(() => {
    setJson(jsonFieldText(snippet.context));
    setError(null);
  }, [snippet.context]);

  const named = namedKind(kind);

  if (mode === 'simple') {
    const offered = kind !== 'custom' && SIMPLE_CONTEXT_KINDS.includes(kind);
    return (
      <Field label="Context" hints={false} issues={issues('context')}>
        <select
          value={kind}
          aria-label="Snippet context"
          onChange={(event) => onChange({ context: event.target.value as EusnipsSnippet['context'] })}
          className="eu-input eu-snippets__compact-wide"
        >
          {SIMPLE_CONTEXT_KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {CONTEXT_LABELS[entry]}
            </option>
          ))}
          {/* The value is outside what Simple offers. It keeps its place in the
              list so the reader can see it and leave it alone; changing it means
              going to Advanced, which is where its controls are. */}
          {!offered && (
            <option value={kind}>
              {kind === 'custom' ? 'A combination — edit in Advanced' : `${CONTEXT_LABELS[kind]} — edit in Advanced`}
            </option>
          )}
        </select>
      </Field>
    );
  }

  return (
    <Field
      label="Context"
      hint="Where in a LaTeX document this snippet is offered. Only `any`, `math` and `text` are evaluated by the engine today; the others are stored and reported."
      issues={issues('context')}
    >
      <div className="eu-snippets__inline">
        <select
          value={kind}
          aria-label="Snippet context"
          onChange={(event) => {
            const next = event.target.value;
            if (next === 'custom') return;
            onChange({ context: namedKind(next) ? { type: next as NamedContext, name: contextName(snippet.context) || 'align' } : (next as EusnipsSnippet['context']) });
          }}
          className="eu-input eu-snippets__compact-wide"
        >
          {CONTEXT_KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {CONTEXT_LABELS[entry]}
            </option>
          ))}
          {kind === 'custom' && <option value="custom">Custom — edited as JSON below</option>}
        </select>
        {named && (
          <input
            value={contextName(snippet.context)}
            aria-label="Context name"
            spellCheck={false}
            placeholder="align"
            onKeyDown={onEditorKeyDown}
            onChange={(event) => onChange({ context: { type: kind as NamedContext, name: event.target.value } })}
            className="eu-input eu-snippets__compact"
          />
        )}
      </div>

      {(kind === 'custom' || named) && (
        <div className="eu-snippets__stack">
          <span className="eu-snippets__hint eu-snippets__hint--block">
            {kind === 'custom'
              ? 'This context is a combination the controls cannot express. Edit it as JSON.'
              : 'The same value, as the file stores it.'}
          </span>
          <textarea
            value={json}
            aria-label="Snippet context as JSON"
            spellCheck={false}
            rows={3}
            aria-invalid={error ? true : undefined}
            onKeyDown={onEditorKeyDown ?? ((event) => event.stopPropagation())}
            onChange={(event) => {
              setJson(event.target.value);
              const parsed = parseJsonField(event.target.value);
              if (!parsed.ok) {
                setError(parsed.error);
                return;
              }
              setError(null);
              onChange({ context: parsed.value as EusnipsSnippet['context'] });
            }}
            className="eu-input eu-snippets__code-input eu-snippets__json"
          />
          {error && <span className="eu-snippets__hint eu-snippets__hint--error">Not valid JSON yet: {error}</span>}
        </div>
      )}
    </Field>
  );
};

/** The context kinds that carry a name. */
type NamedContext = 'environment' | 'command' | 'document-class' | 'package';

function namedKind(kind: string): kind is NamedContext {
  return kind === 'environment' || kind === 'command' || kind === 'document-class' || kind === 'package';
}

const SnippetTags: React.FC<FormProps> = ({ snippet, issues, onChange, onEditorKeyDown }) => {
  return (
    <>
      <Field label="Tags" hint="Comma separated; used for searching here." issues={issues('tags')}>
        <input
          value={(snippet.tags ?? []).join(', ')}
          aria-label="Snippet tags"
          spellCheck={false}
          onKeyDown={onEditorKeyDown}
          onChange={(event) => {
            const tags = event.target.value
              .split(',')
              .map((tag) => tag.trim())
              .filter((tag) => tag.length > 0);
            onChange({ tags: tags.length > 0 ? tags : undefined });
          }}
          className="eu-input"
        />
      </Field>
    </>
  );
};

/**
 * The body, and what the format will make of it.
 *
 * The same control in both modes: a body is snippet body text, and the useful
 * thing an editor can add to a text box is an account of how it will be read —
 * which is what the summary and the parsed-node list below it are for. Advanced
 * mode adds the insert buttons, because they are the ones that need the caret.
 */
const SnippetBody: React.FC<FormProps> = ({ snippet, file, mode, issues, onChange, onEditorKeyDown }) => {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const nodes = bodyNodes(snippet.body);
  const stops = tabstopIndices(snippet.body);

  /** Puts text where the caret is, and leaves it after what was inserted. */
  const insertAtCaret = (text: string) => {
    const element = area.current;
    const source = bodySource(snippet.body);
    if (!element) {
      onChange({ body: bodyFromSource(`${source}${text}`) });
      return;
    }
    const start = element.selectionStart ?? source.length;
    const end = element.selectionEnd ?? start;
    const next = `${source.slice(0, start)}${text}${source.slice(end)}`;
    onChange({ body: bodyFromSource(next) });
    // The caret has to land after the insertion, and React restores the element's
    // value on the next render, so this is done after that render.
    requestAnimationFrame(() => {
      const node = area.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const nextIndex = stops.length === 0 ? 1 : Math.max(...stops.filter((value) => value > 0)) + 1;

  return (
    <>
      <Field
        label="Body"
        hints={mode === 'advanced'}
        hint={
          'What the snippet inserts. $1 $2 … are tab stops, ${1:default} gives one a starting text, ' +
          '${1|a,b} is a choice, ${VISUAL} is the current selection, and a `` `…` `` block runs JavaScript with the result in `rv`.'
        }
        issues={issues('body')}
      >
        {mode === 'advanced' && (
          <div className="eu-snippets__insert-row">
            <button type="button" className="eu-btn eu-btn-quiet" title={`Insert a tab stop ($${nextIndex})`} onClick={() => insertAtCaret(`$${nextIndex}`)}>
              <Plus size={12} strokeWidth={2} /> Tab stop ${nextIndex}
            </button>
            <button type="button" className="eu-btn eu-btn-quiet" title="Insert the final cursor position" onClick={() => insertAtCaret('$0')}>
              <Plus size={12} strokeWidth={2} /> Final cursor
            </button>
            <button type="button" className="eu-btn eu-btn-quiet" title="Insert the current selection" onClick={() => insertAtCaret('${VISUAL}')}>
              <Plus size={12} strokeWidth={2} /> Selection
            </button>
            <button type="button" className="eu-btn eu-btn-quiet" title="Insert a JavaScript block" onClick={() => insertAtCaret('``rv = ""``')}>
              <Zap size={12} strokeWidth={1.8} /> JavaScript
            </button>
          </div>
        )}
        <GrowingTextArea
          textareaRef={area}
          value={bodySource(snippet.body)}
          aria-label="Snippet body"
          minRows={6}
          maxRows={24}
          showTrailingWhitespace
          showNewlineStartGuide
          onKeyDown={onEditorKeyDown}
          onChange={(next) => onChange({ body: bodyFromSource(next) })}
          style={{ width: '100%' }}
        />
      </Field>

      <div className="eu-snippets__hint eu-snippets__body-summary">
        {bodyIsEmpty(snippet.body) ? (
          <span className="eu-snippets__result-warning">The body is empty, so this snippet inserts nothing.</span>
        ) : (
          <>
            {stops.length > 0
              ? `Tab stops: ${stops.map((value) => `$${value}`).join(', ')}`
              : 'No tab stops; the expansion leaves the cursor at the end.'}
            {' · '}
            {nodes.length} body node{nodes.length === 1 ? '' : 's'}
          </>
        )}
      </div>

      <QuickTest snippet={snippet} globals={file.globals?.javascript} onEditorKeyDown={onEditorKeyDown} />

      {/* The inspector is a tool for reading the format, not for writing a
          snippet: Simple says what the body will do, Advanced shows what it is
          made of. */}
      {mode === 'advanced' && (
        <details className="eu-snippets__details">
          <summary className="eu-snippets__summary">
            <Wand2 size={11} strokeWidth={1.8} /> Parsed body
          </summary>
          <div className="eu-snippets__stack">
            {nodes.map((node, at) => (
              <div key={at} className="eu-snippets__node">
                <span className="eu-snippets__node-type">{node.type}</span>
                <span className="eu-snippets__node-value">
                  {describeNode(node)}
                </span>
              </div>
            ))}
            {nodes.length === 0 && <div className="eu-snippets__hint">Nothing to parse.</div>}
          </div>
        </details>
      )}
    </>
  );
};

/**
 * Try the snippet, right under the body it inserts.
 *
 * The question a snippet author asks is always the same one — "if I type this,
 * does that come out?" — and it is a question only the engine can answer: a
 * preview built from the body alone would miss the trigger's anchors, the
 * boundary and the context. So the sample text is run through the real
 * projection, the real parser and the real matcher, and the answer is shown
 * exactly as the editor would produce it.
 *
 * It is a text box rather than a code editor on purpose: what is typed there is
 * *document text*, not code, and the interesting result is what the snippet makes
 * of it.
 */
const QuickTest: React.FC<{
  snippet: EusnipsSnippet;
  globals?: string | string[];
  onEditorKeyDown?(event: React.KeyboardEvent<HTMLElement>): void;
}> = ({
  snippet,
  globals,
  onEditorKeyDown
}) => {
  const [sample, setSample] = useState('');
  const result = useMemo(
    () => (sample.length === 0 ? null : testSnippet(snippet, sample, 'latex', globals)),
    [snippet, sample, globals]
  );
  // What the trigger is actually read as, which is the first thing to look at
  // when a test does not do what the author expected: the anchor is the engine's,
  // not theirs, and the boundary decides how much of the token it has to be.
  const trigger = splitTrigger(snippet.trigger);
  const compiled = `/${anchoredPattern(trigger.pattern)}/${trigger.flags}`;

  return (
    <div className="eu-snippets__test">
      <div className="eu-snippets__test-head">
        <Zap size={11} strokeWidth={1.8} className="eu-snippets__test-icon" />
        <span className="eu-snippets__field-label">Try it</span>
        <span className="eu-snippets__footer-spacer" />
        {sample.length > 0 && (
          <button type="button" className="eu-btn eu-btn-quiet" title="Clear the sample text" onClick={() => setSample('')}>
            Clear
          </button>
        )}
      </div>

      <GrowingTextArea
        value={sample}
        aria-label="Sample text"
        minRows={1}
        maxRows={6}
        single
        onKeyDown={onEditorKeyDown}
        onChange={setSample}
        style={{ width: '100%' }}
      />

      <div className="eu-snippets__test-result">
        <div className="eu-snippets__hint eu-snippets__read-as">
          Read as <code className="eu-snippets__code-inline">{compiled}</code>, matched{' '}
          {snippet.boundary === 'word'
            ? 'as the whole word at the cursor'
            : snippet.boundary === 'whitespace'
              ? 'as the whole token before the cursor'
              : snippet.boundary === 'line-start'
                ? 'from the start of the line'
                : 'anywhere in the line'}
          .
        </div>
        {result === null ? (
          <span className="eu-snippets__hint">Type what you would type in a document, and this says what would come out.</span>
        ) : result.kind === 'problem' ? (
          <span className="eu-snippets__result-error">This entry cannot run: {result.problem}.</span>
        ) : result.kind === 'no-match' ? (
          <span className="eu-snippets__hint">No match in that text.</span>
        ) : (
          <>
            <div className="eu-snippets__hint">
              {result.automatic ? 'Expands' : 'Offered by the completion list'}, replacing{' '}
              <code className="eu-snippets__code-inline">{result.matched}</code>:
            </div>
            <pre className="eu-snippets__preview">{result.insert}</pre>
          </>
        )}
      </div>
    </div>
  );
};

/**
 * The properties the engine stores but does not act on yet.
 *
 * They are here rather than hidden because the format has them and a file may
 * carry them: an author who has written a `script` should be able to see it, and
 * an author who wonders why it does nothing should be able to read why. The
 * warning the format raises for each one is shown next to it, from the same
 * problem list as everything else.
 */
const SnippetScriptAndData: React.FC<FormProps> = ({ snippet, issues, onChange, onEditorKeyDown }) => {
  const [data, setData] = useState(() => jsonFieldText(snippet.metadata));
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    setData(jsonFieldText(snippet.metadata));
    setDataError(null);
  }, [snippet.metadata]);

  return (
    <>
      <Field
        label="Script"
        hint="A JavaScript routine attached to the whole snippet. It is stored and preserved, and reported below, but the engine does not run it yet — it runs the code blocks in the body."
        issues={issues('script')}
      >
        {snippet.script ? (
          <>
            <div className="eu-snippets__inline eu-snippets__script-head">
              <select
                value={snippet.script.run ?? 'expand'}
                aria-label="Script run point"
                onChange={(event) =>
                  onChange({ script: { ...snippet.script!, run: event.target.value as 'expand' | 'tabstop-change' | 'both' } })
                }
                className="eu-input eu-snippets__compact-wide"
              >
                <option value="expand">On expand</option>
                <option value="tabstop-change">On tabstop change</option>
                <option value="both">Both</option>
              </select>
              <button type="button" className="eu-btn eu-btn-quiet" title="Remove the script from this snippet" onClick={() => onChange({ script: undefined })}>
                <Trash2 size={12} strokeWidth={1.8} /> Remove
              </button>
            </div>
            <textarea
              value={snippet.script.code}
              aria-label="Snippet script"
              spellCheck={false}
              rows={4}
              onKeyDown={onEditorKeyDown ?? ((event) => event.stopPropagation())}
              onChange={(event) => onChange({ script: { ...snippet.script!, code: event.target.value } })}
              className="eu-input eu-snippets__code-input eu-snippets__script"
            />
          </>
        ) : (
          <button
            type="button"
            className="eu-btn eu-btn-quiet"
            title="Add a script to this snippet"
            onClick={() => onChange({ script: { language: 'javascript', code: '', run: 'expand' } })}
          >
            <Plus size={12} strokeWidth={2} /> Add a script
          </button>
        )}
      </Field>

      <Field
        label="Stored data"
        hint="Free-form bookkeeping the format keeps for the host — an import records where an entry came from here. Edited as JSON."
        issues={issues('metadata')}
      >
        <textarea
          value={data}
          aria-label="Snippet metadata"
          spellCheck={false}
          rows={3}
          aria-invalid={dataError ? true : undefined}
          onKeyDown={onEditorKeyDown ?? ((event) => event.stopPropagation())}
          onChange={(event) => {
            setData(event.target.value);
            const parsed = parseJsonField(event.target.value);
            if (!parsed.ok) {
              setDataError(parsed.error);
              return;
            }
            if (parsed.value !== undefined && (typeof parsed.value !== 'object' || Array.isArray(parsed.value))) {
              setDataError('this has to be a JSON object');
              return;
            }
            setDataError(null);
            onChange({ metadata: parsed.value as Record<string, unknown> | undefined });
          }}
          className="eu-input eu-snippets__code-input eu-snippets__json"
        />
        {dataError && <span className="eu-snippets__hint eu-snippets__hint--error">Not valid JSON yet: {dataError}</span>}
      </Field>
    </>
  );
};

function describeNode(node: BodyNode): string {
  switch (node.type) {
    case 'text':
      return JSON.stringify(node.value);
    case 'tabstop': {
      const parts = [`$${node.index}`];
      if (node.choices) parts.push(`choices: ${node.choices.join(' | ')}`);
      // A default may be a nested body, so it is shown as the text it renders
      // to; `JSON.stringify` on a list of nodes would print object soup.
      if (node.default !== undefined) parts.push(`default: ${JSON.stringify(renderBody(node.default))}`);
      if (node.transform) parts.push(`transform: ${node.transform}`);
      return parts.join('  ');
    }
    case 'selection':
      return node.default === undefined ? '${VISUAL}' : `\${VISUAL:${node.default}}`;
    case 'expression':
      return node.transform === undefined
        ? node.expression.code
        : `${node.expression.code}  transform: ${node.transform}`;
    case 'javascript':
      return node.code;
  }
}

/**
 * The library itself, in the same two modes as a snippet.
 *
 * Simple is what the file is *for* — its name, its language, and the priority its
 * entries start from. Advanced is the rest of the file-level format: the defaults
 * every entry inherits, the `includes` list, the `globals` block and the stored
 * `metadata`. As with a snippet, the two are views of one document and neither
 * rebuilds it, so a value Simple does not show is still there when Advanced looks
 * for it.
 */
const FileSection: React.FC<{
  file: EusnipsFile;
  state: SnippetStoreState;
  mode: EditorMode;
  onMode(next: EditorMode): void;
  onChange(next: EusnipsFile): void;
  onEditorKeyDown?(event: React.KeyboardEvent<HTMLElement>): void;
}> = ({ file, state, mode, onMode, onChange, onEditorKeyDown }) => {
  const [metadata, setMetadata] = useState(() => jsonFieldText(file.metadata));
  const [metadataError, setMetadataError] = useState<string | null>(null);

  useEffect(() => {
    setMetadata(jsonFieldText(file.metadata));
    setMetadataError(null);
  }, [file.metadata]);

  const globals = file.globals ?? {};
  const javascript = Array.isArray(globals.javascript)
    ? globals.javascript.join('\n')
    : globals.javascript ?? '';

  return (
    <div>
      <div className="eu-snippets__section-head">
        <span className="eu-snippets__section-title">Library</span>
        <span className="eu-snippets__section-head-spacer" />
        <ModeToggle mode={mode} onChange={onMode} subject="Library editor" />
      </div>

      <Field label="Library name" hint="Shown in the sidebar's snippet view.">
        <input
          value={file.name ?? ''}
          aria-label="Library name"
          onKeyDown={onEditorKeyDown}
          onChange={(event) => onChange(withFileProperty(file, 'name', event.target.value))}
          className="eu-input eu-snippets__compact-wide"
        />
      </Field>
      <Field label="Description" hint="Free text; stored in the file and shown nowhere else.">
        <input
          value={file.description ?? ''}
          aria-label="Library description"
          onKeyDown={onEditorKeyDown}
          onChange={(event) => onChange(withFileProperty(file, 'description', event.target.value))}
          className="eu-input"
        />
      </Field>
      <div className="eu-snippets__grid">
        <Field
          label="Language"
          hint="Which documents these snippets apply to. `latex` is the default; `all` makes them global."
        >
          <input
            value={file.language ?? 'latex'}
            aria-label="Snippet language"
            spellCheck={false}
            onKeyDown={onEditorKeyDown}
            onChange={(event) => onChange(withFileProperty(file, 'language', event.target.value))}
            className="eu-input eu-snippets__code-input"
          />
        </Field>
        {mode === 'advanced' && (
          <Field
            label="Namespace"
            hint="An alias of the language: when both are present they have to name the same language, and the file is reported if they do not."
          >
            <input
              value={file.namespace ?? ''}
              aria-label="Snippet namespace"
              spellCheck={false}
              onKeyDown={onEditorKeyDown}
              onChange={(event) => onChange(withFileProperty(file, 'namespace', event.target.value))}
              className="eu-input eu-snippets__code-input"
            />
          </Field>
        )}
        <Field label="Default priority" hint="Used by entries that do not set their own.">
          <input
            type="number"
            value={file.defaults?.priority ?? ''}
            placeholder="100"
            aria-label="Default priority"
            onKeyDown={onEditorKeyDown}
            onChange={(event) => {
              const raw = event.target.value;
              onChange(withDefault(file, 'priority', raw === '' ? undefined : Number(raw)));
            }}
            className="eu-input eu-tnum"
          />
        </Field>
      </div>

      {mode === 'advanced' && (
        <>
          <div className="eu-snippets__grid">
            <Field label="Default expansion" hint="What an entry gets when it does not choose.">
              <select
                value={file.defaults?.expand ?? ''}
                aria-label="Default expansion"
                onChange={(event) => onChange(withDefault(file, 'expand', event.target.value || undefined))}
                className="eu-input"
              >
                <option value="">Each snippet chooses</option>
                <option value="manual">Manual</option>
                <option value="auto">Automatic</option>
              </select>
            </Field>
            <Field label="Default boundary" hint="What an entry gets when it does not choose.">
              <select
                value={file.defaults?.boundary ?? ''}
                aria-label="Default boundary"
                onChange={(event) => onChange(withDefault(file, 'boundary', event.target.value || undefined))}
                className="eu-input"
              >
                <option value="">Each snippet chooses (anywhere by default)</option>
                <option value="anywhere">Anywhere</option>
                <option value="whitespace">After whitespace</option>
                <option value="word">Whole word</option>
                <option value="line-start">Start of line</option>
              </select>
            </Field>
            <Field label="Default context" hint="What an entry gets when it does not choose.">
              <select
                value={typeof file.defaults?.context === 'string' ? file.defaults.context : ''}
                aria-label="Default context"
                onChange={(event) => onChange(withDefault(file, 'context', event.target.value || undefined))}
                className="eu-input"
              >
                <option value="">Each snippet chooses</option>
                <option value="any">Everywhere</option>
                <option value="math">Mathematics only</option>
                <option value="text">Text only</option>
              </select>
            </Field>
          </div>

          <div className="eu-snippets__toggle-row">
            <Toggle
              checked={file.defaults?.hidden === true}
              label="Entries start hidden"
              hint="Hidden snippets match but are not offered."
              onChange={(next) => onChange(withDefault(file, 'hidden', next ? true : undefined))}
            />
            <Toggle
              checked={file.defaults?.enabled === false}
              label="Entries start disabled"
              hint="A library of snippets that are off until they are switched on one by one."
              onChange={(next) => onChange(withDefault(file, 'enabled', next ? false : undefined))}
            />
          </div>

          <Field
            label="Included files"
            hint="Other snippet files this library lists. One per line. Eukolia stores the list and does not read those files yet, so it is reported in the list below."
          >
            <textarea
              value={(file.includes ?? []).join('\n')}
              aria-label="Included snippet files"
              spellCheck={false}
              rows={2}
              onKeyDown={onEditorKeyDown ?? ((event) => event.stopPropagation())}
              onChange={(event) => {
                const includes = event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0);
                onChange(withFileProperty(file, 'includes', includes.length > 0 ? includes : undefined));
              }}
              className="eu-input eu-snippets__code-input"
            />
          </Field>

          <Field
            label="Global JavaScript"
            hint="Stored in globals.js in your snippets folder, and shared by every snippet: functions and variables declared here are in scope for snippet code blocks."
          >
            <textarea
              value={javascript}
              aria-label="Global javascript"
              spellCheck={false}
              rows={4}
              onKeyDown={onEditorKeyDown ?? ((event) => event.stopPropagation())}
              onChange={(event) => onChange(withGlobal(file, 'javascript', event.target.value || undefined))}
              className="eu-input eu-snippets__code-input eu-snippets__script"
            />
          </Field>

          <Field
            label="Global variables"
            hint="Named values a body could read. Stored and preserved; the engine does not read them yet. Edited as JSON."
          >
            <textarea
              value={jsonFieldText(globals.variables)}
              aria-label="Global variables"
              spellCheck={false}
              rows={3}
              onKeyDown={onEditorKeyDown ?? ((event) => event.stopPropagation())}
              onChange={(event) => {
                const parsed = parseJsonField(event.target.value);
                if (!parsed.ok) {
                  setMetadataError(parsed.error);
                  return;
                }
                setMetadataError(null);
                onChange(withGlobal(file, 'variables', parsed.value));
              }}
              className="eu-input eu-snippets__code-input eu-snippets__json"
            />
          </Field>

          <Field
            label="Stored data"
            hint="Bookkeeping the host keeps for the file — the one-shot import receipts live here. Edited as JSON."
          >
            <textarea
              value={metadata}
              aria-label="Library metadata"
              spellCheck={false}
              rows={3}
              onKeyDown={onEditorKeyDown ?? ((event) => event.stopPropagation())}
              onChange={(event) => {
                setMetadata(event.target.value);
                const parsed = parseJsonField(event.target.value);
                if (!parsed.ok) {
                  setMetadataError(parsed.error);
                  return;
                }
                if (parsed.value !== undefined && (typeof parsed.value !== 'object' || Array.isArray(parsed.value))) {
                  setMetadataError('this has to be a JSON object');
                  return;
                }
                setMetadataError(null);
                onChange(withFileProperty(file, 'metadata', parsed.value as Record<string, unknown> | undefined));
              }}
              className="eu-input eu-snippets__code-input eu-snippets__json"
            />
          </Field>
          {metadataError && (
            <div className="eu-snippets__hint eu-snippets__hint--error eu-snippets__error-note">
              Not valid JSON yet: {metadataError}
            </div>
          )}
        </>
      )}

      <div className="eu-snippets__actions-row">
        <button
          type="button"
          className="eu-btn eu-btn-quiet"
          title="Replace the library with the built-in snippet set. Your own entries are lost."
          onClick={() => {
            if (window.confirm('Replace the whole snippet library with the built-in set?')) {
              void getSnippetStore().restoreBuiltIns();
            }
          }}
        >
          <RotateCcw size={12} strokeWidth={1.8} /> Restore built-in snippets
        </button>
        <button
          type="button"
          className="eu-btn eu-btn-quiet"
          title="Reveal the active snippets folder in your file manager"
          onClick={() => {
            void window.eukoliaApi.openUserDirectory();
          }}
        >
          <Folder size={12} strokeWidth={1.8} /> Open folder
        </button>
        <button
          type="button"
          className="eu-btn eu-btn-quiet"
          title="Assign a custom folder on your system for storing snippets.json and globals.js"
          onClick={async () => {
            if (typeof window !== 'undefined' && window.eukoliaApi?.openFolderDialog) {
              const selected = await window.eukoliaApi.openFolderDialog();
              if (selected) {
                settingsManager.setValue('snippets.userSnippetsDirectory', selected, 'user');
                void getSnippetStore().reload();
              }
            }
          }}
        >
          <Folder size={12} strokeWidth={1.8} /> Change folder…
        </button>
        {Boolean(settingsManager.getValue('snippets.userSnippetsDirectory')) && (
          <button
            type="button"
            className="eu-btn eu-btn-quiet"
            title="Reset snippets folder back to the default (.eukolia in your project library, or User/snippets in application data before setup)"
            onClick={() => {
              settingsManager.setValue('snippets.userSnippetsDirectory', '', 'user');
              void getSnippetStore().reload();
            }}
          >
            <RotateCcw size={12} strokeWidth={1.8} /> Reset to default folder
          </button>
        )}
      </div>

      <div className="eu-snippets__hint eu-snippets__folder">
        <strong>Snippets folder:</strong> {state.directory || 'the .eukolia folder of your project library'}
      </div>

    <div className="eu-snippets__hint eu-snippets__tally">
      {file.snippets.length} snippet{file.snippets.length === 1 ? '' : 's'} ·{' '}
      {file.snippets.filter((snippet) => snippet.enabled === false).length} disabled
      {state.issues.filter((issue) => issue.index === null).length > 0 && (
        <ul className="eu-snippets__issue-list">
          {state.issues
            .filter((issue) => issue.index === null)
            .map((issue, index) => (
              <li key={index}>
                {issue.message}
              </li>
            ))}
        </ul>
      )}
    </div>
    </div>
  );
};

/**
 * What to say about snippet files sitting in the same folder.
 *
 * The import is offered rather than performed, because it is the one operation
 * that adds snippets the user did not create in this file. Those files
 * themselves are never touched.
 */
const LegacyNotice: React.FC<{ state: SnippetStoreState; store: ReturnType<typeof getSnippetStore> }> = ({
  state,
  store
}) => {
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="eu-snippets__legacy">
      <div>
        {state.legacyFiles.length} older snippet file{state.legacyFiles.length === 1 ? '' : 's'} in the same folder
        {' '}({state.legacyFiles.join(', ')}). They are left untouched.
      </div>
      {state.pendingImports.length > 0 && (
        <button
          type="button"
          className="eu-btn eu-btn-quiet"
          title="Copy the snippets from those files into this library. The files themselves are not changed."
          onClick={() => {
            void store.importLegacy().then((result) => {
              setMessage(
                result.imported > 0
                  ? `Imported ${result.imported} snippet${result.imported === 1 ? '' : 's'} from ${result.files.join(', ')}.`
                  : 'Nothing was imported.'
              );
            });
          }}
        >
          Import {state.pendingImports.length} file{state.pendingImports.length === 1 ? '' : 's'}
        </button>
      )}
      {state.changedImports.map((name) => (
        <div key={name} className="eu-snippets__legacy-row">
          <span>{name} changed since it was imported.</span>
          <button
            type="button"
            className="eu-btn eu-btn-quiet"
            title="Replace this library's copy of that file's snippets with what is on disk now."
            onClick={() => {
              void store.reimportLegacy(name).then((result) => {
                setMessage(`Re-imported ${result.imported} snippet${result.imported === 1 ? '' : 's'} from ${name}.`);
              });
            }}
          >
            Re-import
          </button>
        </div>
      ))}
      {message && <div className="eu-snippets__legacy-message">{message}</div>}
      {state.pendingImports.length === 0 && state.changedImports.length === 0 && (
        <div>They have already been imported; their snippets are managed here now.</div>
      )}
    </div>
  );
};

export default SnippetManager;
