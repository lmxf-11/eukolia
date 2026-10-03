/**
 * CodeMirror 6 LaTeX completion and hover tests.
 *
 * `cmCompletion.ts` is the adapter between Eukolia's completion registry and
 * CodeMirror: it turns registry entries into CodeMirror completions, applies the
 * `latex.completion.*` settings per kind, and carries Monaco's hover rules over.
 *
 * The conversion is exercised through the real source and the real registry —
 * the ported LaTeX Workshop providers included — so the assertions are about what
 * an editor would actually offer. Completion contexts and the `apply` functions
 * are driven without an `EditorView`: `CompletionContext` is documented as
 * constructible by test code, and the snippet helper only needs `state` and
 * `dispatch`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CompletionContext, type Completion, type CompletionResult } from '@codemirror/autocomplete';
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { latexCompletionSource, latexHover, latexHoverInfo } from '../../src/renderer/editor/cmCompletion';
import {
  completionRegistry,
  type CompletionEntry,
  type CompletionKind,
  type CompletionSource
} from '../../src/renderer/editor/completion';
import { settingsManager } from '../../src/renderer/core/settings';
import { DocumentModel } from '../../src/renderer/document/documentModel';
import { projectIndex, type BibEntry } from '../../src/renderer/document/projectIndex';
import { latexDocumentAnalyzer } from '../../src/renderer/parser/latexAnalyzer';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_URI = 'C:/eukolia-cm-fixture/main.tex';
const BIB_SOURCE = 'C:/eukolia-cm-fixture/refs.bib';

/**
 * A document that defines a macro (no arguments), a macro with two arguments, a
 * label, a second label that is also cited, and a reference written with spaces.
 */
const FIXTURE = [
  '\\documentclass{article}',
  '\\newcommand{\\R}{\\mathbb{R}}',
  '\\newcommand{\\pair}[2]{(#1, #2)}',
  '\\begin{document}',
  '\\section{Intro}\\label{intro}\\label{shared}',
  'See \\ref{ intro } and \\cite{knuth1984, shared}.',
  '\\begin{figure}',
  '\\caption{A figure}',
  '\\end{figure}',
  '\\end{document}',
  ''
].join('\n');

const BIB_ENTRIES: BibEntry[] = [
  {
    key: 'knuth1984',
    type: 'article',
    fields: {},
    title: 'Literate Programming',
    authors: ['Donald E. Knuth'],
    year: '1984',
    journal: 'The Computer Journal',
    doi: '10.1093/comjnl/27.2.97',
    source: BIB_SOURCE,
    line: 3
  },
  {
    key: 'webonly',
    type: 'misc',
    fields: {},
    title: 'Only Online',
    url: 'https://example.org/webonly',
    source: BIB_SOURCE,
    line: 12
  }
];

function registerFixture(): void {
  const document = new DocumentModel(FIXTURE_URI, 'main.tex', FIXTURE);
  document.setAnalyzer(latexDocumentAnalyzer);
  projectIndex.registerDocument(document);
}

beforeAll(() => {
  registerFixture();
});

afterEach(() => {
  // Settings are global; a test that changes one must not leak into the next.
  settingsManager.reset('latex', 'user');
});

afterAll(() => {
  projectIndex.unregisterDocument(FIXTURE_URI);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Splits `text` at the `|` marker into the document and the caret offset. */
function at(text: string, marker = '|'): { text: string; offset: number } {
  const offset = text.indexOf(marker);
  if (offset === -1) throw new Error('marker not found');
  return { text: text.replace(marker, ''), offset };
}

/** Runs the completion source at the marker. */
async function complete(text: string): Promise<CompletionResult | null> {
  const { text: doc, offset } = at(text);
  const state = EditorState.create({ doc });
  return latexCompletionSource(new CompletionContext(state, offset, true));
}

/** Every option a result offers. */
function options(result: CompletionResult | null): readonly Completion[] {
  return result?.options ?? [];
}

/** The options whose label starts with `test-`, i.e. the kind probe below. */
function probeOptions(result: CompletionResult | null): readonly Completion[] {
  return options(result).filter((option) => option.label.startsWith('test-'));
}

function optionFor(result: CompletionResult | null, label: string): Completion {
  const option = options(result).find((candidate) => candidate.label === label);
  if (!option) throw new Error(`no completion labelled ${label}; got ${options(result).map((o) => o.label).join(', ')}`);
  return option;
}

/**
 * Runs a completion's `apply` the way CodeMirror does. The snippet helper and
 * `insertCompletionText` only touch `state` and `dispatch`, so a plain object
 * stands in for the view — no DOM, no editor mount. A string `apply` is a
 * replacement CodeMirror performs itself, which the editor does here too.
 */
function applyCompletion(
  option: Completion,
  doc: string,
  from: number,
  to: number
): { doc: string; selection: EditorSelection } {
  let state = EditorState.create({ doc });
  const captured: { doc: string | null; selection: EditorSelection | null } = { doc: null, selection: null };
  const editor = {
    get state() {
      return state;
    },
    dispatch: (input: Transaction | TransactionSpec) => {
      const transaction = input instanceof Transaction ? input : state.update(input);
      state = transaction.state;
      captured.doc = state.doc.toString();
      captured.selection = state.selection;
    }
  };

  const apply = option.apply;
  if (typeof apply === 'string') {
    editor.dispatch({ changes: { from, to, insert: apply } });
  } else {
    if (typeof apply !== 'function') throw new Error(`completion ${option.label} has no apply value`);
    apply(editor as unknown as EditorView, option, from, to);
  }

  if (captured.doc === null || captured.selection === null) {
    throw new Error(`completion ${option.label} dispatched no transaction`);
  }
  return { doc: captured.doc, selection: captured.selection };
}

// ---------------------------------------------------------------------------
// Kind probe: one entry of every kind, so the settings gates can be checked one
// kind at a time. `completionRegistry` is the same registry the editor drives.
// ---------------------------------------------------------------------------

const PROBE_ID = 'cm-completion-test-probe';
const KINDS: readonly CompletionKind[] = [
  'command',
  'environment',
  'package',
  'class',
  'citation',
  'reference',
  'label',
  'file',
  'macro',
  'snippet',
  'symbol',
  'word'
];

const probeSource: CompletionSource = {
  id: PROBE_ID,
  provide: () =>
    KINDS.map<CompletionEntry>((kind) => ({
      label: `test-${kind}`,
      kind,
      insertText: `test-${kind}`,
      detail: `${kind} detail`,
      source: PROBE_ID
    }))
};

describe('latexCompletionSource kinds and settings', () => {
  beforeAll(() => {
    completionRegistry.register(probeSource);
  });

  afterAll(() => {
    completionRegistry.unregister(PROBE_ID);
  });

  it('gives every kind its own icon and a ranking that leads with what a LaTeX author wants', async () => {
    const result = await complete('plain |');
    const optionOf = (kind: CompletionKind) => optionFor(result, `test-${kind}`);
    const boostOf = (kind: CompletionKind) => optionOf(kind).boost ?? 0;

    expect(optionOf('command').type).toBe('keyword');
    expect(optionOf('macro').type).toBe('function');
    expect(optionOf('snippet').type).toBe('snippet');
    expect(optionOf('environment').type).toBe('enum');
    expect(optionOf('package').type).toBe('interface');
    expect(optionOf('class').type).toBe('class');
    expect(optionOf('citation').type).toBe('namespace');
    expect(optionOf('reference').type).toBe('variable');
    expect(optionOf('label').type).toBe('type');
    expect(optionOf('file').type).toBe('property');
    expect(optionOf('symbol').type).toBe('constant');
    expect(optionOf('word').type).toBe('text');

    expect(new Set(KINDS.map((kind) => optionOf(kind).type)).size).toBe(KINDS.length);
    expect(boostOf('label')).toBeGreaterThan(boostOf('command'));
    expect(boostOf('command')).toBeGreaterThan(boostOf('symbol'));
    expect(boostOf('symbol')).toBeGreaterThan(boostOf('word'));
  });

  it('offers every kind when every category is enabled', async () => {
    const result = await complete('plain |');
    expect(probeOptions(result).map((option) => option.label)).toEqual(KINDS.map((kind) => `test-${kind}`));
  });

  it('returns null when completion is switched off', async () => {
    settingsManager.setValue('latex.completion.enabled', false, 'user');
    expect(await complete('plain |')).toBeNull();
  });

  it('drops commands, macros and snippets when commands are switched off', async () => {
    settingsManager.setValue('latex.completion.commands', false, 'user');
    const labels = probeOptions(await complete('plain |')).map((option) => option.label);

    expect(labels).not.toContain('test-command');
    expect(labels).not.toContain('test-macro');
    expect(labels).not.toContain('test-snippet');
    expect(labels).toContain('test-environment');
  });

  it('drops environments when environments are switched off', async () => {
    settingsManager.setValue('latex.completion.environments', false, 'user');
    const labels = probeOptions(await complete('plain |')).map((option) => option.label);

    expect(labels).not.toContain('test-environment');
    expect(labels).toContain('test-command');
  });

  it('drops packages and classes when packages are switched off', async () => {
    settingsManager.setValue('latex.completion.packages', false, 'user');
    const labels = probeOptions(await complete('plain |')).map((option) => option.label);

    expect(labels).not.toContain('test-package');
    expect(labels).not.toContain('test-class');
  });

  it('drops citations when citations are switched off', async () => {
    settingsManager.setValue('latex.completion.citations', false, 'user');
    const labels = probeOptions(await complete('plain |')).map((option) => option.label);

    expect(labels).not.toContain('test-citation');
    expect(labels).toContain('test-reference');
  });

  it('drops references and labels when references are switched off', async () => {
    settingsManager.setValue('latex.completion.references', false, 'user');
    const labels = probeOptions(await complete('plain |')).map((option) => option.label);

    expect(labels).not.toContain('test-reference');
    expect(labels).not.toContain('test-label');
  });

  it('drops files when files are switched off', async () => {
    settingsManager.setValue('latex.completion.files', false, 'user');
    const labels = probeOptions(await complete('plain |')).map((option) => option.label);

    expect(labels).not.toContain('test-file');
  });

  it('drops Unicode mathematics symbols when they are switched off', async () => {
    settingsManager.setValue('latex.completion.unicodeMath', false, 'user');
    const labels = probeOptions(await complete('plain |')).map((option) => option.label);

    expect(labels).not.toContain('test-symbol');
  });

  it('keeps the document-word fallback: no category setting names it', async () => {
    for (const key of [
      'latex.completion.commands',
      'latex.completion.environments',
      'latex.completion.packages',
      'latex.completion.citations',
      'latex.completion.references',
      'latex.completion.files',
      'latex.completion.unicodeMath'
    ]) {
      settingsManager.setValue(key, false, 'user');
    }

    expect(probeOptions(await complete('plain |')).map((option) => option.label)).toEqual(['test-word']);
  });
});

// ---------------------------------------------------------------------------
// Entry conversion
// ---------------------------------------------------------------------------

describe('latexCompletionSource conversion', () => {
  it('offers the project labels inside a reference argument', async () => {
    const result = await complete('\\ref{|}');
    // Two sources know this label: the ported LaTeX Workshop reference provider
    // and Eukolia's own project-index source. Both now type it as a *reference*,
    // so the registry's `(kind, label)` de-duplication keeps one of them — the
    // provider's, which carries documentation and its own replacement range. It
    // used to keep both only because the provider's item was mis-typed as a macro.
    const offered = options(result).filter((option) => option.label === 'shared');

    expect(offered).toHaveLength(1);
    expect(offered[0].type).toBe('variable');
  });

  it('includes the backslash in the word it replaces', async () => {
    const result = await complete('\\secti|');

    expect(result?.from).toBe(0);
    expect(result?.to).toBe(6);
  });

  it('replaces only the partial word after a brace', async () => {
    const { text, offset } = at('\\ref{sh|ared}');
    const state = EditorState.create({ doc: text });
    const result = await latexCompletionSource(new CompletionContext(state, offset, true));

    expect(result?.from).toBe(text.indexOf('sh'));
    expect(result?.to).toBe(offset);
  });

  it('ranks project labels above document words', async () => {
    const label = optionFor(await complete('\\ref{|}'), 'shared');
    const word = (await complete('shared sha|'))?.options.find((option) => option.label === 'shared' && option.type === 'text');

    expect(word).toBeDefined();
    expect(label.boost ?? 0).toBeGreaterThan(word?.boost ?? 0);
  });

  it('turns a snippet entry into a CodeMirror snippet completion', async () => {
    const result = await complete('\\pai|');
    const pair = optionFor(result, '\\pair');

    expect(pair.type).toBe('snippet');
    expect(typeof pair.apply).toBe('function');

    // Eukolia's macro source writes `${1}` placeholders; the applied document
    // must contain the expansion, not the placeholder, and the caret must land
    // in the first tab stop.
    const applied = applyCompletion(pair, '\\pai', 0, 4);
    expect(applied.doc).toBe('\\pair{{2}}');
    expect(applied.selection.main.from).toBe(applied.selection.main.to);
    expect(applied.selection.main.from).toBe(6);
  });

  it('translates the VS Code placeholders the ported providers still write', async () => {
    const text = '\\begin{fig';
    const state = EditorState.create({ doc: text });
    const result = await latexCompletionSource(new CompletionContext(state, text.length, true));
    const figure = optionFor(result, 'figure');

    expect(figure.type).toBe('snippet');
    const applied = applyCompletion(figure, text, 0, text.length);

    // `$0` and `${0:${TM_SELECTED_TEXT}}` are VS Code syntax; CodeMirror would
    // insert them literally.
    expect(applied.doc).toContain('\\end{figure}');
    expect(applied.doc).not.toContain('$');
  });

  it('keeps the backslash a ported provider replaced up to', async () => {
    // The ported macro provider replaces the text after the last backslash, so
    // its range is what keeps the `\` in front of the command it inserts.
    const text = '\\fra';
    const state = EditorState.create({ doc: text });
    const result = await latexCompletionSource(new CompletionContext(state, text.length, true));
    const frac = optionFor(result, '\\frac{}{}');

    expect(frac.type).toBe('snippet');
    const applied = applyCompletion(frac, text, 0, text.length);

    expect(applied.doc).toBe('\\frac{}{}');
    expect(applied.selection.main.from).toBe(applied.selection.main.to);
  });

  it('replaces the range a ported provider asked for, not just the word', async () => {
    const text = '\\input{intro.t}';
    const caret = text.indexOf('}');
    const from = text.indexOf('{') + 1;

    const rangeSource: CompletionSource = {
      id: 'cm-completion-test-range',
      provide: () => [
        {
          label: 'intro.tex',
          kind: 'file',
          insertText: 'intro.tex',
          source: 'cm-completion-test-range',
          range: { from, to: caret }
        }
      ]
    };
    const unregister = completionRegistry.register(rangeSource);
    try {
      const state = EditorState.create({ doc: text });
      const result = await latexCompletionSource(new CompletionContext(state, caret, true));
      const file = optionFor(result, 'intro.tex');

      // The result's own range is still the word, which is what CodeMirror
      // filters against; the replacement range lives in the apply function.
      expect(result?.from).toBe(caret - 1);
      expect(result?.to).toBe(caret);
      expect(applyCompletion(file, text, result?.from ?? 0, result?.to ?? 0).doc).toBe('\\input{intro.tex}');
    } finally {
      unregister();
    }
  });

  it('returns null when nothing can complete the caret', async () => {
    expect(await complete('plain text|')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

/** Resolves hover information at the marker. */
function hover(text: string) {
  const { text: doc, offset } = at(text);
  return latexHoverInfo(doc, offset);
}

describe('latexHoverInfo', () => {
  beforeAll(() => {
    projectIndex.registerBibEntries(BIB_SOURCE, BIB_ENTRIES);
  });

  afterAll(() => {
    projectIndex.removeBibSource(BIB_SOURCE);
  });

  it('describes a macro, including its argument count and body', () => {
    const info = hover('\\|R and more');

    expect(info?.from).toBe(0);
    expect(info?.to).toBe(2);
    expect(info?.lines[0]).toEqual({ kind: 'title', text: '\\R — no arguments' });
    expect(info?.lines[1].kind).toBe('code');
    expect(info?.lines[1].text).toContain('\\mathbb{R}');
  });

  it('pluralises a macro with arguments', () => {
    const info = hover('\\pair|');
    expect(info?.lines[0]).toEqual({ kind: 'title', text: '\\pair — 2 arguments' });
  });

  it('lists where a label is defined', () => {
    const info = hover('\\ref{intro|}');

    expect(info?.lines[0]).toEqual({ kind: 'title', text: 'Label intro defined at:' });
    expect(info?.lines[1].kind).toBe('item');
    expect(info?.lines[1].text).toMatch(/^main\.tex:\d+$/);
  });

  it('falls back to the enclosing argument when the pointer is not on a word', () => {
    // The pointer sits on the space before the label, so no word covers it.
    const info = hover('\\ref{| intro }');

    expect(info?.lines[0]).toEqual({ kind: 'title', text: 'Label intro defined at:' });
    // The annotated range is the argument, its spaces included.
    expect(info?.from).toBe(5);
    expect(info?.to).toBe(12);
  });

  it('annotates a word with the word range', () => {
    const info = hover('\\ref{ intro| }');
    expect(info?.from).toBe(6);
    expect(info?.to).toBe(11);
  });

  it('reads a citation key the word pattern would split', () => {
    // `knuth1984` is two words to the LaTeX word pattern; the enclosing argument
    // is what makes the key reachable.
    const info = hover('\\cite{knuth1984|}');

    expect(info?.lines[0]).toEqual({ kind: 'title', text: 'Literate Programming' });
    expect(info?.from).toBe(6);
    expect(info?.to).toBe(15);
  });

  it('describes a bibliography entry', () => {
    const info = hover('\\cite{knuth1984|}');

    expect(info?.lines[0]).toEqual({ kind: 'title', text: 'Literate Programming' });
    expect(info?.lines[1]).toEqual({ kind: 'text', text: 'Donald E. Knuth' });
    expect(info?.lines[2]).toEqual({ kind: 'text', text: 'The Computer Journal (1984)' });
    expect(info?.lines[3]).toEqual({
      kind: 'link',
      text: 'doi: 10.1093/comjnl/27.2.97',
      href: 'https://doi.org/10.1093/comjnl/27.2.97'
    });
  });

  it('links a bibliography entry that has no DOI by its URL', () => {
    const info = hover('\\cite{webonly|}');

    expect(info?.lines[0]).toEqual({ kind: 'title', text: 'Only Online' });
    expect(info?.lines[1]).toEqual({ kind: 'link', text: 'https://example.org/webonly', href: 'https://example.org/webonly' });
  });

  it('looks for a label before a bibliography entry of the same name', () => {
    const info = hover('\\cite{shared|}');

    expect(info?.lines[0]).toEqual({ kind: 'title', text: 'Label shared defined at:' });
  });

  it('says nothing about a token it knows nothing about, even inside an environment', () => {
    // The tooltip used to name the enclosing environment here — "Inside
    // \begin{figure}" — which meant every ordinary word of prose inside any
    // environment raised a popup that covered the line being read and told the
    // reader what the breadcrumbs already say. A hover has to earn the
    // interruption; a word the index cannot describe gets no tooltip.
    expect(hover('\\begin{figure}\n\\caption{A| figure}\n\\end{figure}')).toBeNull();
    expect(hover('\\begin{theorem}\nHausdorff và $Y$ là m|ột không gian\n\\end{theorem}')).toBeNull();
  });

  it('says nothing about a word outside any environment', () => {
    expect(hover('plain |text')).toBeNull();
    expect(hover('   |  ')).toBeNull();
  });

  it('clamps an out-of-range offset instead of throwing', () => {
    expect(latexHoverInfo('\\R', 999)?.lines[0]).toEqual({ kind: 'title', text: '\\R — no arguments' });
  });

  it('says nothing when hover is switched off', () => {
    settingsManager.setValue('latex.hover.enabled', false, 'user');
    expect(hover('\\R|')).toBeNull();
  });
});

describe('latexHover', () => {
  it('mounts as a CodeMirror extension', () => {
    expect(() => EditorState.create({ doc: '\\R', extensions: [latexHover()] })).not.toThrow();
  });

  it('mounts even when hover is switched off, so the setting can come back', () => {
    settingsManager.setValue('latex.hover.enabled', false, 'user');
    expect(() => EditorState.create({ doc: '\\R', extensions: [latexHover()] })).not.toThrow();
    expect(latexHoverInfo('\\R', 1)).toBeNull();
  });
});
