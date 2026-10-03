/**
 * Pure-logic tests for the Snippets settings editor.
 *
 * The component itself needs a DOM and the app state; the logic that decides
 * what the list shows, what a row says and which field an error belongs to is
 * exported as plain functions and is covered here, the same way the other UI
 * helpers in `tests/ui/` are.
 *
 * The module is imported for its helpers only, but it does import the store and
 * the settings manager, which touch the preload bridge at module scope — so the
 * bridge is stubbed before the import, as `tests/ui/pure.test.ts` does.
 */

import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const ipc = new Proxy(
    {},
    {
      get: (_target, property) => (..._args: unknown[]) => {
        if (typeof property === 'string' && property.startsWith('on')) return () => undefined;
        return Promise.resolve(undefined);
      }
    }
  );
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = { eukoliaApi: ipc, addEventListener: () => undefined, removeEventListener: () => undefined };
});

const {
  SnippetManager,
  appendSnippet,
  bodyFromSource,
  bodyIsEmpty,
  bodyNodes,
  bodySource,
  contextKind,
  contextName,
  createManagedSnippet,
  describeContextValue,
  duplicateManagedSnippet,
  fieldIssuesFor,
  filterSnippets,
  getRememberedSnippetManagerState,
  inspectDocument,
  jsonFieldText,
  moveSnippet,
  parseJsonField,
  problemsFor,
  removeSnippet,
  reorderSnippet,
  replaceSnippet,
  resetRememberedSnippetManagerState,
  saveRememberedSnippetManagerState,
  snippetBodyPreview,
  snippetHaystack,
  snippetSummary,
  testSnippet,
  unsavedSnippets,
  withDefault,
  withFileProperty,
  withGlobal
} = await import('../../src/renderer/ui/components/SnippetManager');
const { validateSnippetFile, normalizeSnippetFile, EUSNIPS_VERSION, indexProblemCounts, snippetProblems, problemLines, problemTooltip } =
  await import('../../src/renderer/snippets/eusnips');
const { SettingsView, SHORTCUTS_SECTION } = await import(
  '../../src/renderer/ui/components/SettingsView'
);
// The window is no longer a settings section, so the export is gone rather than
// renamed: nothing should still be able to reach it as one.
const SNIPPETS_SECTION = (await import('../../src/renderer/ui/components/SettingsView') as Record<string, unknown>)
  .SNIPPETS_SECTION;

type EusnipsFile = import('../../src/renderer/snippets/eusnips').EusnipsFile;

function fileOf(snippets: EusnipsFile['snippets']): EusnipsFile {
  return { version: EUSNIPS_VERSION, language: 'latex', snippets };
}

const SAMPLE = fileOf([
  { id: 'ff', trigger: { pattern: 'ff' }, description: 'fraction', body: '\\frac{$1}{$2}$0', expand: 'auto', context: 'math' },
  { id: 'sq', trigger: { pattern: 'sq' }, description: 'square root', body: '\\sqrt{$1}$0', context: 'math' },
  { id: 'off', trigger: { pattern: 'zzz' }, description: 'turned off', body: 'QQQ', enabled: false },
  { id: 'bad', trigger: { pattern: '' }, description: 'broken', body: 'X' }
]);

describe('snippet list filtering', () => {
  const issues = normalizeSnippetFile(SAMPLE).issues;

  it('shows everything by default, in file order', () => {
    expect(filterSnippets(SAMPLE, issues, { query: '', status: 'all' })).toEqual([0, 1, 2, 3]);
  });

  it('filters by trigger, description, id, tag and body', () => {
    expect(filterSnippets(SAMPLE, issues, { query: 'ff', status: 'all' })).toEqual([0, 2]);
    expect(filterSnippets(SAMPLE, issues, { query: 'fraction', status: 'all' })).toEqual([0]);
    expect(filterSnippets(SAMPLE, issues, { query: 'square', status: 'all' })).toEqual([1]);
    expect(filterSnippets(SAMPLE, issues, { query: 'zzz', status: 'all' })).toEqual([2]);
    expect(filterSnippets(SAMPLE, issues, { query: 'sqrt', status: 'all' })).toEqual([1]);
    expect(filterSnippets(SAMPLE, issues, { query: 'nothing', status: 'all' })).toEqual([]);
    // The search is a case-insensitive substring match over the whole entry, so a
    // phrase in a description or an id finds it just as a trigger does — 'ff' is
    // in `off`, which is exactly the behaviour a user expects from a filter box.
    expect(filterSnippets(SAMPLE, issues, { query: 'turn', status: 'all' })).toEqual([2]);
    expect(filterSnippets(SAMPLE, issues, { query: 'qqq', status: 'all' })).toEqual([2]);
    expect(filterSnippets(SAMPLE, issues, { query: 'OFF', status: 'all' })).toEqual([2]);
  });

  it('matches a regular expression trigger by its pattern and filters by state', () => {
    const regexFile = fileOf([{ id: 'r', trigger: { pattern: '(\\w+)bf', flags: 'i' }, body: 'x' }]);
    expect(filterSnippets(regexFile, [], { query: 'bf', status: 'all' })).toEqual([0]);
    expect(filterSnippets(SAMPLE, issues, { query: '', status: 'enabled' })).toEqual([0, 1, 3]);
    expect(filterSnippets(SAMPLE, issues, { query: '', status: 'disabled' })).toEqual([2]);
    expect(filterSnippets(SAMPLE, issues, { query: '', status: 'problems' })).toEqual([3]);
  });

  it('searches tags and the raw body', () => {
    const tagged = fileOf([{ id: 't', trigger: { pattern: 'a' }, body: 'A', tags: ['greek', 'letter'] }]);
    expect(snippetHaystack(tagged.snippets[0])).toContain('greek');
    expect(filterSnippets(tagged, [], { query: 'letter', status: 'all' })).toEqual([0]);
  });

  it('filters comprehensively by context, expansion, boundary, tag and script presence', () => {
    const mixed = fileOf([
      { id: '1', trigger: { pattern: 'a' }, body: 'math-auto', context: 'math', expand: 'auto', boundary: 'whitespace', tags: ['math'] },
      { id: '2', trigger: { pattern: 'b' }, body: 'text-manual', context: 'text', expand: 'manual', boundary: 'word', tags: ['prose'] },
      { id: '3', trigger: { pattern: 'c' }, body: 'scripted: ``rv = "hi"``', context: 'math', expand: 'auto', boundary: 'line-start' },
      { id: '4', trigger: { pattern: 'd' }, body: 'plain', script: { language: 'javascript', code: 'rv = 1' } }
    ]);

    // Context filter
    expect(filterSnippets(mixed, [], { query: '', status: 'all', context: 'math' })).toEqual([0, 2]);
    expect(filterSnippets(mixed, [], { query: '', status: 'all', context: 'text' })).toEqual([1]);
    expect(filterSnippets(mixed, [], { query: '', status: 'all', context: 'preamble' })).toEqual([]);

    // Expand filter
    expect(filterSnippets(mixed, [], { query: '', status: 'all', expand: 'auto' })).toEqual([0, 2]);
    expect(filterSnippets(mixed, [], { query: '', status: 'all', expand: 'manual' })).toEqual([1, 3]);

    // Boundary filter
    expect(filterSnippets(mixed, [], { query: '', status: 'all', boundary: 'whitespace' })).toEqual([0]);
    expect(filterSnippets(mixed, [], { query: '', status: 'all', boundary: 'word' })).toEqual([1]);
    expect(filterSnippets(mixed, [], { query: '', status: 'all', boundary: 'line-start' })).toEqual([2]);
    expect(filterSnippets(mixed, [], { query: '', status: 'all', boundary: 'anywhere' })).toEqual([3]);

    // Tag filter
    expect(filterSnippets(mixed, [], { query: '', status: 'all', tag: 'math' })).toEqual([0]);
    expect(filterSnippets(mixed, [], { query: '', status: 'all', tag: 'prose' })).toEqual([1]);
    expect(filterSnippets(mixed, [], { query: '', status: 'all', tag: 'nonexistent' })).toEqual([]);

    // Script filter
    expect(filterSnippets(mixed, [], { query: '', status: 'all', hasScript: 'with-script' })).toEqual([2, 3]);
    expect(filterSnippets(mixed, [], { query: '', status: 'all', hasScript: 'without-script' })).toEqual([0, 1]);

    // Combined filters
    expect(
      filterSnippets(mixed, [], {
        query: '',
        status: 'all',
        context: 'math',
        expand: 'auto',
        boundary: 'whitespace',
        tag: 'math'
      })
    ).toEqual([0]);
  });
});

describe('row summaries', () => {
  it('reads the trigger and previews the body', () => {
    expect(snippetSummary(SAMPLE.snippets[0])).toBe('ff');
    expect(snippetSummary({ trigger: { pattern: 'a+' }, body: 'x' })).toBe('a+');
    // The bare string shorthand reads the same way, which is what lets a
    // hand-written file and an edited one sit in the same list.
    expect(snippetSummary({ trigger: { pattern: 'a+' }, body: 'x' })).toBe('a+');
    expect(snippetBodyPreview('line one\nline two')).toBe('line one line two');
    expect(snippetBodyPreview('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('keeps a body of either shape editable as source', () => {
    expect(bodySource('a $1 b')).toBe('a $1 b');
    expect(bodySource([{ type: 'text', value: 'a' }, { type: 'tabstop', index: 1 }])).toBe('a$1');
    // Whatever the textarea holds is stored as body text, which is the faithful
    // form, so an edit never loses a construct.
    expect(bodyFromSource('a $1 b')).toBe('a $1 b');
    expect(bodyNodes('a $1 ``rv = 1``').map((node) => node.type)).toEqual(['text', 'tabstop', 'text', 'javascript']);
    expect(bodyIsEmpty('')).toBe(true);
    expect(bodyIsEmpty('${1:x}')).toBe(false);
  });
});

describe('editing operations', () => {
  it('adds, replaces, moves and removes without mutating the original', () => {
    const created = createManagedSnippet(SAMPLE, 'new thing');
    // The id is random, not derived from the trigger: the trigger is what the
    // author renames first, and a derived id would either go stale immediately or
    // have to chase every keystroke.
    expect(created.id).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]{6}$/);
    expect(SAMPLE.snippets.some((entry) => entry.id === created.id)).toBe(false);
    // The trigger is still the readable slug it always was, as plain text: a new
    // snippet matches what its author types rather than a pattern made of it.
    expect(created.trigger).toEqual({ pattern: 'new-thing' });
    expect(created.boundary).toBe('anywhere');

    const added = appendSnippet(SAMPLE, created);
    expect(added.snippets).toHaveLength(5);
    expect(SAMPLE.snippets).toHaveLength(4);

    const replaced = replaceSnippet(added, 0, { ...added.snippets[0], description: 'changed' });
    expect(replaced.snippets[0].description).toBe('changed');
    expect(added.snippets[0].description).toBe('fraction');

    const moved = moveSnippet(SAMPLE, 0, 1);
    expect(moved.snippets.map((entry) => entry.id)).toEqual(['sq', 'ff', 'off', 'bad']);
    // Out-of-range moves are no-ops rather than wrapping around.
    expect(moveSnippet(SAMPLE, 0, -1)).toBe(SAMPLE);
    expect(moveSnippet(SAMPLE, 3, 1)).toBe(SAMPLE);

    const reorderedForward = reorderSnippet(SAMPLE, 0, 2);
    expect(reorderedForward.snippets.map((entry) => entry.id)).toEqual(['sq', 'off', 'ff', 'bad']);

    const reorderedBackward = reorderSnippet(SAMPLE, 3, 1);
    expect(reorderedBackward.snippets.map((entry) => entry.id)).toEqual(['ff', 'bad', 'sq', 'off']);

    // Out-of-range or same index reorders are no-ops
    expect(reorderSnippet(SAMPLE, 0, 0)).toBe(SAMPLE);
    expect(reorderSnippet(SAMPLE, -1, 2)).toBe(SAMPLE);
    expect(reorderSnippet(SAMPLE, 0, 99)).toBe(SAMPLE);

    expect(removeSnippet(SAMPLE, 1).snippets.map((entry) => entry.id)).toEqual(['ff', 'off', 'bad']);
    expect(removeSnippet(SAMPLE, 99)).toBe(SAMPLE);
  });

  it('duplicates under a fresh id', () => {
    const copy = duplicateManagedSnippet(SAMPLE, 0);
    expect(copy.id).toBe('ff-1');
    expect(copy.description).toBe('fraction (copy)');
    const appended = appendSnippet(SAMPLE, copy);
    expect(appended.snippets.map((entry) => entry.id)).toEqual(['ff', 'sq', 'off', 'bad', 'ff-1']);

    const copy2 = duplicateManagedSnippet(appended, 4);
    expect(copy2.id).toBe('ff-2');
  });
});

describe('attributing issues to fields', () => {
  it('points a schema issue at the entry and field it belongs to, saying what to do', () => {
    const file = fileOf([{ id: 'ok', trigger: { pattern: 'a' }, body: 'b' }, { id: 'x', trigger: { pattern: '' }, body: 'b' }]);
    const text = JSON.stringify({ version: 1, language: 'latex', snippets: file.snippets });
    const validation = validateSnippetFile(JSON.parse(text) as unknown, { text });

    // The sentence under the field is the format's own wording rewritten for the
    // person who has to fix it: "must not be empty" becomes what it means and
    // what to do about it, and the branches of the trigger's `oneOf` that repeat
    // the same complaint collapse to one line.
    expect(fieldIssuesFor(1, validation.issues, [])).toEqual([
      {
        field: 'trigger',
        message: 'The trigger is empty, so this snippet can never match anything. Type the text that should expand it.',
        level: 'error'
      }
    ]);
    expect(fieldIssuesFor(0, validation.issues, [])).toEqual([]);
  });

  it('points a semantic warning at the field it concerns', () => {
    const issues = normalizeSnippetFile(
      fileOf([
        // A count of lines is stored and reported rather than honoured, and the
        // complaint is about that setting, not about the trigger.
        { trigger: { pattern: 'a' }, body: 'b', multiline: 5 },
        { trigger: { pattern: 'c' }, body: 'd', script: { language: 'javascript', code: '' } }
      ])
    ).issues;
    expect(fieldIssuesFor(0, [], issues).map((issue) => issue.field)).toEqual(['multiline']);
    expect(fieldIssuesFor(1, [], issues).map((issue) => issue.field)).toEqual(['script']);
    expect(fieldIssuesFor(1, [], issues)[0].level).toBe('warning');
  });

  it('reports a problem per field, never the same sentence twice', () => {
    const issues = normalizeSnippetFile(
      fileOf([
        { trigger: { pattern: 'a' }, body: 'b', context: { type: 'package', name: 'amsmath' }, script: { language: 'javascript', code: 'rv = 1' } }
      ])
    ).issues;
    const fields = fieldIssuesFor(0, [], issues).map((issue) => issue.field);
    expect(fields).toEqual([...new Set(fields)]);
    expect(fields).toContain('context');
    expect(fields).toContain('script');
  });

  it('rewrites the schema vocabulary a person cannot act on', () => {
    const file = { snippets: [{ id: 'x', trigger: { pattern: 'a' }, body: 'b', expand: 'sometimes' }] };
    const text = JSON.stringify({ version: 1, language: 'latex', snippets: file.snippets });
    const validation = validateSnippetFile(JSON.parse(text) as unknown, { text });
    const [problem] = fieldIssuesFor(0, validation.issues, []);
    // "must be one of: \"manual\", \"auto\"" is a correct description and a poor
    // sentence to read while fixing it.
    expect(problem.message).toBe('This has to be one of: manual, auto.');
    expect(problem.field).toBe('expand');
  });

  it('counts the problems per entry for the list marker', () => {
    const issues = normalizeSnippetFile(fileOf([{ trigger: { pattern: '' }, body: '' }, { trigger: { pattern: 'a' }, body: 'b' }])).issues;
    expect(indexProblemCounts([], issues).get(0)).toBe(1);
    expect(indexProblemCounts([], issues).get(1)).toBeUndefined();
  });

  it('reports the schema problems of an entry, not only the semantic ones', () => {
    const file = fileOf([{ id: 'ok', trigger: { pattern: 'a' }, body: 'b' }, { id: 'bad', trigger: { pattern: 'a' }, body: 'b', priority: 1.5 }]);
    const text = JSON.stringify({ version: 1, language: 'latex', snippets: file.snippets });
    const validation = validateSnippetFile(JSON.parse(text) as unknown, { text });

    // The list's triangle and the form's field messages come from the same call,
    // which is what stops them disagreeing about whether an entry is broken.
    expect(problemsFor(file, 1, validation.issues, [])).toHaveLength(1);
    expect(problemsFor(file, 1, validation.issues, [])[0].field).toBe('priority');
    expect(problemsFor(file, 0, validation.issues, [])).toEqual([]);
    expect(problemsFor(file, 99, validation.issues, [])).toEqual([]);
  });

  it('files a complaint about the trigger text under the trigger, whatever it is called in the file', () => {
    // The file holds the trigger's text as `pattern`; the editor draws one
    // Trigger box. A problem is named by the field the reader has to change, so
    // it has to arrive under that box's name.
    const file = fileOf([{ id: 'x', trigger: { pattern: '' }, body: 'b' }]);
    const text = JSON.stringify({ version: 1, language: 'latex', snippets: file.snippets });
    const validation = validateSnippetFile(JSON.parse(text) as unknown, { text });
    const problems = problemsFor(file, 0, validation.issues, []);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.field === 'trigger')).toBe(true);
    expect(problemLines(problems)[0]).toMatch(/^Trigger: /);
  });

  it('reports the problems of one entry in the list', () => {
    const issues = normalizeSnippetFile(SAMPLE).issues;
    expect(snippetProblems(SAMPLE, 3, [], issues)).toHaveLength(1);
    expect(snippetProblems(SAMPLE, 0, [], issues)).toEqual([]);
  });

  it('lists the problems of a broken entry for its tooltip', () => {
    // The triangle's tooltip is the list of problems, one line each, named by the
    // field they belong to — not a count and not "this snippet is invalid".
    const file = fileOf([
      // A fractional priority is a schema failure, and a trigger with a backtick
      // in it is one the header cannot carry: two problems, two fields.
      { id: 'x', trigger: { pattern: 'a`b' }, body: 'b', priority: 1.5 }
    ]);
    const text = JSON.stringify({ version: 1, language: 'latex', snippets: file.snippets });
    const validation = validateSnippetFile(JSON.parse(text) as unknown, { text });
    const problems = problemsFor(file, 0, validation.issues, normalizeSnippetFile(file).issues);

    const lines = problemLines(problems);
    expect(lines.some((line) => line.startsWith('Priority: '))).toBe(true);
    expect(lines.some((line) => line.startsWith('Trigger: '))).toBe(true);
    // Each line names its field and explains the problem.
    expect(lines.every((line) => /^[A-Z][^:]*: .{10,}/.test(line))).toBe(true);

    const tooltip = problemTooltip(file.snippets[0], problems);
    expect(tooltip).toContain('2 problems');
    expect(tooltip).toContain('• Priority:');
    expect(problemTooltip(file.snippets[0], [])).toBe('');
  });
});

describe('editing the whole schema', () => {
  it('keeps a property the simple fields do not show', () => {
    // The mode promise, as a property of the data rather than of the UI: a
    // snippet is one object, so a property that only Advanced can edit is in it
    // whether or not Advanced is on screen. Nothing here rebuilds a snippet from
    // the controls, which is what makes that true by construction.
    const snippet: import('../../src/renderer/snippets/eusnips').EusnipsSnippet = {
      id: 'x',
      trigger: { pattern: 'a' },
      body: 'b',
      multiline: true,
      metadata: { importedFrom: 'old.hsnips' },
      script: { language: 'javascript', code: 'rv = 1' },
      tags: ['maths']
    };
    const edited = { ...snippet, description: 'a name' };
    expect(edited).toMatchObject({
      multiline: true,
      metadata: { importedFrom: 'old.hsnips' },
      script: { language: 'javascript', code: 'rv = 1' },
      tags: ['maths']
    });
  });

  it('sets a nested property and drops the object when it empties', () => {
    const base = fileOf([{ trigger: { pattern: 'a' }, body: 'b' }]);
    const withPriority = withDefault(base, 'priority', 200);
    expect(withPriority.defaults).toEqual({ priority: 200 });
    // A second default joins the first rather than replacing it.
    expect(withDefault(withPriority, 'expand', 'auto').defaults).toEqual({ priority: 200, expand: 'auto' });
    // Clearing the last one removes `defaults` itself: an empty object is a
    // property the file does not need and a reader has to skip past.
    expect(withDefault(withPriority, 'priority', undefined).defaults).toBeUndefined();
    expect(withGlobal(base, 'javascript', '').globals).toBeUndefined();
    expect(withGlobal(base, 'variables', { who: 'world' }).globals).toEqual({ variables: { who: 'world' } });
  });

  it('drops a file property that says nothing', () => {
    const base = fileOf([{ trigger: { pattern: 'a' }, body: 'b' }]);
    expect(withFileProperty(base, 'includes', ['other.json']).includes).toEqual(['other.json']);
    expect(withFileProperty(base, 'includes', [])).not.toHaveProperty('includes');
    expect(withFileProperty(base, 'name', '')).not.toHaveProperty('name');
    expect(withFileProperty(base, 'metadata', { a: 1 }).metadata).toEqual({ a: 1 });
  });

  it('reads the JSON fields without refusing a half-typed value', () => {
    // A field being typed into is JSON-in-progress for most of its life, so the
    // editor has to be able to say "not yet" without rejecting the keystroke.
    expect(parseJsonField('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonField('')).toEqual({ ok: true, value: undefined });
    const broken = parseJsonField('{"a": ');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.length).toBeGreaterThan(0);
    expect(jsonFieldText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(jsonFieldText(undefined)).toBe('');
  });

  it('names every context shape the controls can read back', () => {
    expect(contextKind(undefined)).toBe('any');
    expect(contextKind('math')).toBe('math');
    expect(contextKind({ type: 'environment', name: 'align' })).toBe('environment');
    // A combination is not one of the kinds, so the editor falls back to JSON
    // rather than rewriting it as something simpler.
    expect(contextKind({ all: ['math', 'text'] })).toBe('custom');
    expect(contextKind({ not: 'math' })).toBe('custom');
    expect(contextName({ type: 'package', name: 'amsmath' })).toBe('amsmath');
    expect(contextName('math')).toBe('');
    expect(describeContextValue({ any: ['math', 'text'] })).toBe('any of math, text');
    expect(describeContextValue({ not: 'math' })).toBe('not math');
    expect(describeContextValue(undefined)).toBe('everywhere');
  });
});

describe('document inspection', () => {
  it('says whether the document would write, and what is wrong when it would not', () => {
    const good = inspectDocument(SAMPLE);
    expect(good.valid).toBe(true);
    // The empty trigger is the one thing a document may be written with: it is
    // what a snippet looks like between "Add" and the first keystroke.
    expect(good.pending).toBe(true);
    expect(good.issues).toEqual([]);
    expect(JSON.parse(good.text)).toMatchObject({ version: 1, snippets: expect.any(Array) });

    const complete = inspectDocument(fileOf([{ id: 'x', trigger: { pattern: 'a' }, body: 'b' }]));
    expect(complete.valid).toBe(true);
    expect(complete.pending).toBe(false);
    expect(complete.semantic).toEqual([]);
  });

  it('refuses a document with a real schema failure', () => {
    const broken = inspectDocument(fileOf([{ id: 'x', trigger: { pattern: 'a' }, body: 'b', priority: 1.5 }]));
    expect(broken.valid).toBe(false);
    expect(broken.pending).toBe(false);
    expect(broken.issues[0].message).toContain('must be integer');
  });

  it('reports a duplicate id as a semantic problem even though the file is schema-legal', () => {
    const duplicate = inspectDocument(
      fileOf([{ id: 'x', trigger: { pattern: 'a' }, body: 'b' }, { id: 'x', trigger: { pattern: 'c' }, body: 'd' }])
    );
    expect(duplicate.valid).toBe(true);
    expect(duplicate.semantic.map((issue) => issue.message)).toEqual([expect.stringContaining('already used')]);
  });
});

describe('unsaved snippets', () => {
  it('marks the entries that differ from the file on disk', () => {
    const saved = fileOf([
      { id: 'a', trigger: { pattern: 'aa' }, body: 'A' },
      { id: 'b', trigger: { pattern: 'bb' }, body: 'B' }
    ]);
    const edited = fileOf([
      { id: 'a', trigger: { pattern: 'aa' }, body: 'A' },
      { id: 'b', trigger: { pattern: 'bb' }, body: 'B changed' }
    ]);
    expect([...unsavedSnippets(edited, saved)]).toEqual([1]);
    // Undoing the edit takes the mark away: "unsaved" is a difference from the
    // file, not a list of controls that were touched.
    expect([...unsavedSnippets(saved, saved)]).toEqual([]);
    // A file that has never been saved marks everything... except that there is
    // nothing to compare against, so nothing is marked.
    expect([...unsavedSnippets(edited, null)]).toEqual([]);
  });

  it('follows an entry through a reorder and notices one that is new', () => {
    const saved = fileOf([
      { id: 'a', trigger: { pattern: 'aa' }, body: 'A' },
      { id: 'b', trigger: { pattern: 'bb' }, body: 'B' }
    ]);
    const moved = fileOf([
      { id: 'b', trigger: { pattern: 'bb' }, body: 'B' },
      { id: 'a', trigger: { pattern: 'aa' }, body: 'A changed' }
    ]);
    expect([...unsavedSnippets(moved, saved)]).toEqual([1]);

    const added = fileOf([
      ...saved.snippets,
      { id: 'c', trigger: { pattern: 'cc' }, body: 'C' }
    ]);
    expect([...unsavedSnippets(added, saved)]).toEqual([2]);
  });
});

describe('the quick test', () => {
  it('runs the entry through the real engine and says what would come out', () => {
    const result = testSnippet(
      { id: 'ff', trigger: { pattern: 'ff' }, body: '\\frac{$1}{$2}$0', expand: 'auto' },
      'ff'
    );
    expect(result.kind).toBe('match');
    expect(result.automatic).toBe(true);
    expect(result.matched).toBe('ff');
    expect(result.insert).toBe('\\frac{}{}');
  });

  it('says so when the trigger does not fire, rather than showing nothing', () => {
    const snippet = { id: 'ff', trigger: { pattern: 'ff' }, body: 'X', expand: 'auto' as const, boundary: 'word' as const };
    expect(testSnippet(snippet, 'staff').kind).toBe('no-match');
    expect(testSnippet(snippet, 'ff').kind).toBe('match');
    // The boundary is part of the answer: `anywhere` fires inside a word.
    expect(testSnippet({ ...snippet, boundary: 'anywhere' }, 'staff').kind).toBe('match');
  });

  it('reports an entry the projection cannot render at all', () => {
    const result = testSnippet({ id: 'x', trigger: { pattern: 'a`b' }, body: 'X', expand: 'auto' }, 'a`b');
    expect(result.kind).toBe('problem');
    expect(result.problem).toContain('backtick');
  });

  it('shows the capture groups a pattern matched', () => {
    const result = testSnippet(
      {
        id: 'cal',
        trigger: { pattern: '(\\w+)cal' },
        body: '\\mathcal{``rv = m[1]``}$0',
        expand: 'auto',
        boundary: 'anywhere'
      },
      'alphacal'
    );
    expect(result.kind).toBe('match');
    expect(result.matched).toBe('alphacal');
    expect(result.insert).toBe('\\mathcal{alpha}');
  });

  it('shows what a code block computes, using the library\'s globals', () => {
    const snippet = {
      id: 'atom',
      trigger: { pattern: '(\\$)?(?<!\\.|\\:)(\\s+)([A-Zb-z](\'*))([\\s\\-.,;])' },
      body: '``rv = openInlineMath(m, m[3]);``$0',
      expand: 'auto',
      boundary: 'anywhere'
    } as const;

    // Without the library's globals the block cannot run, and the honest answer is
    // the reason — not an empty insert that reads like a snippet with no body.
    const withoutGlobals = testSnippet(snippet, ' A;');
    expect(withoutGlobals.kind).toBe('problem');
    expect(withoutGlobals.problem).toContain('openInlineMath is not defined');

    const withGlobals = testSnippet(
      snippet,
      ' A;',
      'latex',
      'function openInlineMath(match, content = "") { return match[1] ? content : match[2] + "\\\\$" + content; }'
    );
    expect(withGlobals.kind).toBe('match');
    // The text is the block's *output*, not the body it was computed from.
    expect(withGlobals.insert).toBe(' $A');
  });

  it('applies the context, so a math-only entry does not look like it fires in prose', () => {
    // The reported confusion: `context: "math"` is part of whether a trigger fires,
    // and the box used to ask the matcher underneath the engine — which does not
    // apply it — so prose was answered with "Expands".
    const mathOnly = {
      id: 'sp',
      trigger: { pattern: '  ' },
      body: ' ',
      expand: 'auto',
      boundary: 'anywhere',
      context: 'math'
    } as const;
    expect(testSnippet(mathOnly, 'plain prose  ').kind).toBe('no-match');

    const inside = testSnippet(mathOnly, 'Text $a  ');
    expect(inside.kind).toBe('match');
    expect(inside.insert).toBe(' ');

    const textOnly = { ...mathOnly, context: 'text' } as const;
    expect(testSnippet(textOnly, 'plain prose  ').kind).toBe('match');
    expect(testSnippet(textOnly, 'Text $a  ').kind).toBe('no-match');
  });
});

describe('window wiring', () => {
  it('is a window of its own rather than a settings section', () => {
    // The library used to be a synthetic section of the settings pane; it is a
    // window now, so the constant is gone and the settings screen offers a button
    // that opens it.
    expect(SNIPPETS_SECTION).toBeUndefined();
    expect(SHORTCUTS_SECTION).toBe('Keyboard Shortcuts');
    expect(typeof SettingsView).toBe('function');
    expect(typeof SnippetManager).toBe('function');
  });
});

describe('remembered state', () => {
  it('saves, retrieves, and resets state', () => {
    resetRememberedSnippetManagerState();
    const initial = getRememberedSnippetManagerState();
    expect(initial.query).toBe('');
    expect(initial.status).toBe('all');
    expect(initial.context).toBe('all');
    expect(initial.expand).toBe('all');
    expect(initial.boundary).toBe('all');
    expect(initial.tag).toBe('all');
    expect(initial.hasScript).toBe('all');

    saveRememberedSnippetManagerState({
      query: 'matrix',
      status: 'enabled',
      context: 'math',
      expand: 'auto',
      boundary: 'whitespace',
      tag: 'math',
      hasScript: 'with-script',
      selectedId: 'matrix_snippet',
      selectedIndex: 2,
      section: 'snippet',
      mode: 'advanced',
      filtersOpen: true
    });

    const updated = getRememberedSnippetManagerState();
    expect(updated.query).toBe('matrix');
    expect(updated.status).toBe('enabled');
    expect(updated.context).toBe('math');
    expect(updated.expand).toBe('auto');
    expect(updated.boundary).toBe('whitespace');
    expect(updated.tag).toBe('math');
    expect(updated.hasScript).toBe('with-script');
    expect(updated.selectedId).toBe('matrix_snippet');
    expect(updated.selectedIndex).toBe(2);
    expect(updated.mode).toBe('advanced');
    expect(updated.filtersOpen).toBe(true);

    resetRememberedSnippetManagerState();
    const reset = getRememberedSnippetManagerState();
    expect(reset.query).toBe('');
    expect(reset.status).toBe('all');
    expect(reset.context).toBe('all');
  });
});
