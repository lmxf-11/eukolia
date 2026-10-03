/**
 * End-to-end tests for the Eukolia `SnippetEngine` facade: real expansions,
 * tab stops, the `A` flag path, variable resolution and the context seam.
 */

import { describe, expect, it } from 'vitest';
import { Range } from 'vscode';
import { getSnippetBody } from '../../src/renderer/vendor/hypersnips';
import {
  SnippetEngine,
  getSnippetEngine,
  offsetFromPosition,
  positionFromOffset,
  stripPlaceholders
} from '../../src/renderer/snippets/engine';
import {
  TextContextDetector,
  TextContextProvider,
  getContextProvider,
  setContextProvider,
  type ContextDetector,
  type ContextDetectorInput,
  type ContextProvider
} from '../../src/renderer/snippets/context';
import { defaultSnippetSources, defaultSnippetsSource } from '../../src/renderer/snippets/defaultSnippets';
import { createHarness, TestEditor, positionOf } from './helpers';
import { readRepoFile } from '../hypersnips/helpers';

describe('SnippetEngine loading', () => {
  it('parses .hsnips sources and exposes them per language', () => {
    const { engine } = createHarness([
      { name: 'latex.hsnips', content: 'snippet aa "a" A\nAA\nendsnippet\n', language: 'latex' },
      { name: 'all.hsnips', content: 'snippet bb "b" A\nBB\nendsnippet\n', language: 'all' }
    ]);

    expect(engine.getSnippets('latex').map((s) => s.trigger).sort()).toEqual(['aa', 'bb']);
    expect(engine.getSnippets('markdown').map((s) => s.trigger)).toEqual(['bb']);
    expect(engine.getSnippets('all').map((s) => s.trigger)).toEqual(['bb']);
    expect(engine.loadedSourceNames).toEqual(['latex.hsnips', 'all.hsnips']);
  });

  it('derives the language from the file name', () => {
    const engine = new SnippetEngine();
    engine.loadSnippetSources([{ name: 'tex.hsnips', content: 'snippet zz "z" A\nZZ\nendsnippet\n', language: '' }]);
    expect(engine.getSnippets('tex').map((s) => s.trigger)).toEqual(['zz']);
  });

  it('sorts by descending priority and keeps file order on ties', () => {
    const source = [
      'snippet a "a" n',
      'A',
      'endsnippet',
      'priority 5',
      'snippet b "b" n',
      'B',
      'endsnippet',
      'snippet c "c" n',
      'C',
      'endsnippet',
      ''
    ].join('\n');
    const { engine } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    expect(engine.getSnippets('latex').map((s) => s.trigger)).toEqual(['b', 'a', 'c']);
  });

  it('exposes a process-wide default engine', () => {
    expect(getSnippetEngine()).toBe(getSnippetEngine());
    expect(getSnippetEngine()).toBeInstanceOf(SnippetEngine);
  });
});

describe('SnippetEngine end-to-end expansion', () => {
  it('expands ff in math mode through the A-flag path', () => {
    const { engine, adapter } = createHarness(defaultSnippetSources());
    const editor = new TestEditor('$');

    // Typing `f` matches nothing yet; the second `f` fires the snippet.
    expect(adapter.handleDocumentChange(editor, editor.typeChar('f'))).toBeNull();
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('f'));

    expect(applied).not.toBeNull();
    expect(editor.getText()).toBe('$\\frac{}{}');
    expect(applied!.text).toBe('\\frac{}{}');
    expect(applied!.from).toBe(1);
    expect(applied!.to).toBe(10);

    // Tab stops: $1 for the numerator, $2 for the denominator, $0 last.
    expect(engine.activeExpansion!.selectedPlaceholder).toBe(1);
    expect(applied!.selected).toHaveLength(1);
    expect(applied!.selected[0].documentFrom).toBe(applied!.from + '\\frac{'.length);
    expect(applied!.selected[0].documentTo).toBe(applied!.selected[0].documentFrom);

    const second = adapter.nextTabStop(editor);
    expect(second!.from).toBe(applied!.from + '\\frac{}{'.length);

    const final = adapter.nextTabStop(editor);
    expect(final!.id).toBe(0);
    expect(final!.from).toBe(applied!.to);
  });
  it('expands a manual snippet by accepting a completion', () => {
    const { engine, adapter } = createHarness(defaultSnippetSources());
    const editor = new TestEditor('$');
    editor.type('s');

    const candidates = adapter.getCompletionCandidates(editor, editor.getOffset());
    expect(candidates.map((c) => c.snippet.trigger)).toContain('sq');

    const applied = adapter.acceptCompletion(candidates.find((c) => c.snippet.trigger === 'sq')!, editor);
    expect(editor.getText()).toBe('$\\sqrt{}');
    expect(applied.text).toBe('\\sqrt{}');
    expect(engine.activeExpansion).toBe(applied.expansion);
  });

  it('keeps math-flagged snippets out of non-math documents', () => {
    const { adapter } = createHarness(defaultSnippetSources());
    const editor = new TestEditor('prose ');
    editor.type('R');
    expect(adapter.handleDocumentChange(editor, editor.typeChar('R'))).toBeNull();
    expect(editor.getText()).toBe('prose RR');
  });

  it('keeps previews off the tab-stop stack until they are accepted', () => {
    const { engine, adapter } = createHarness(defaultSnippetSources());
    const editor = new TestEditor('$');
    editor.type('f');
    editor.type('f');

    const candidate = adapter
      .getCompletionCandidates(editor, editor.getOffset())
      .find((c) => c.snippet.trigger === 'ff')!;

    // What a completion list does while rendering a preview.
    const preview = engine.expand(candidate, { text: editor.getText(), pushToStack: false });
    expect(engine.stackDepth).toBe(0);
    expect(engine.getGeometry(preview).text).toBe('\\frac{}{}');

    // What the editor does once the user accepts it.
    engine.pushExpansion(preview);
    expect(engine.stackDepth).toBe(1);
    expect(engine.activeExpansion).toBe(preview);
    expect(adapter.nextTabStop(editor)!.id).toBe(2);
  });

  it('expands a non-math-only snippet outside math', () => {
    const source = ['snippet QQ "q" A', 'QQ-OK', 'endsnippet', ''].join('\n');
    const { adapter } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    const editor = new TestEditor('prose ');
    editor.type('Q');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('Q'));
    expect(applied).not.toBeNull();
    expect(editor.getText()).toBe('prose QQ-OK');
  });

  it('documents the reference parser quirk for the n flag', () => {
    // The reference header regexp is `[AMiwbmhn]*`, so `n` *is* parsed when a
    // quoted description precedes it. The quirk is that a flag never follows the
    // trigger directly: `snippet foo n` parses `foo` as the trigger and `n` as the
    // description, because the description group matches before the flags group.
    const quoted = createHarness([
      { name: 'latex.hsnips', content: 'snippet foo "f" nA\nFOO\nendsnippet\n', language: 'latex' }
    ]);
    const snippet = quoted.engine.getSnippets('latex')[0];
    expect(snippet.trigger).toBe('foo');
    expect(snippet.automatic).toBe(true);
    expect(snippet.description).toBe('f');
    expect(snippet.nonmath).toBe(true);

    const noDescription = createHarness([
      { name: 'latex.hsnips', content: 'snippet foo n\nFOO\nendsnippet\n', language: 'latex' }
    ]);
    const bare = noDescription.engine.getSnippets('latex')[0];
    expect(bare.trigger).toBe('foo');
    // The flags group accepts `n`, so it is consumed as a flag and no description
    // is recorded — `HSnippet.nonmath` really is set even without quotes.
    expect(bare.nonmath).toBe(true);
    expect(bare.description).toBe('');
  });
});

describe('SnippetEngine geometry helpers', () => {
  it('round-trips offsets and positions', () => {
    const text = 'ab\ncde\n\nf';
    expect(offsetFromPosition(text, positionFromOffset(text, 0))).toBe(0);
    expect(offsetFromPosition(text, positionFromOffset(text, 5))).toBe(5);
    expect(offsetFromPosition(text, positionFromOffset(text, 8))).toBe(8);
    expect(offsetFromPosition(text, positionFromOffset(text, 999))).toBe(text.length);
    // Offset 3 is the start of the second line.
    expect(positionFromOffset(text, 3).line).toBe(1);
    expect(positionFromOffset(text, 3).character).toBe(0);
    // Offset 5 is the third character of the second line.
    expect(positionFromOffset(text, 5).line).toBe(1);
    expect(positionFromOffset(text, 5).character).toBe(2);
    // Offset 8 is the document's last character (`f` on line 3).
    expect(positionFromOffset(text, 8).line).toBe(3);
    expect(positionFromOffset(text, 8).character).toBe(0);
  });

  it('strips placeholder markup to plain text', () => {
    expect(stripPlaceholders('\\frac{$1}{$2}$0')).toBe('\\frac{}{}');
    expect(stripPlaceholders('\\sum_{${1:i=1}}^{${2:n}} $0')).toBe('\\sum_{i=1}^{n} ');
    // `$$1$ $0` is the inline-math snippet: `$` + `$1` + `$` + ` ` + `$0` -> `$$ `.
    expect(stripPlaceholders('$$1$ $0')).toBe('$$ ');
    expect(stripPlaceholders('${1|a,b,c|}')).toBe('a');
    expect(stripPlaceholders('a \\$ b')).toBe('a $ b');
  });
});

describe('SnippetEngine variables', () => {
  it('resolves TM_* / date / file variables through the resolver', () => {
    const { engine } = createHarness();
    const calls: string[][] = [];
    engine.setVariableResolver((names, defaults) => {
      calls.push(names);
      return { ...defaults, fileName: 'chapter1.tex', date: '2024-01-01' };
    });

    const resolved = engine.resolveVariables(
      { workspaceUri: '', fileUri: '', fileName: '', dirName: '', date: '' },
      ['TM_FILENAME', 'CURRENT_YEAR']
    );
    expect(resolved.fileName).toBe('chapter1.tex');
    expect(resolved.date).toBe('2024-01-01');
    expect(calls).toEqual([['TM_FILENAME', 'CURRENT_YEAR']]);
  });

  it('falls back to the defaults when no resolver is installed', () => {
    const { engine } = createHarness();
    const defaults = { workspaceUri: 'w', fileUri: 'f', fileName: 'n', dirName: 'd', date: 'now' };
    expect(engine.resolveVariables(defaults)).toEqual(defaults);
  });

  it('passes the workspace URI into JavaScript code blocks as w', () => {
    const source = ['snippet ws "workspace" A', '``rv = w``', 'endsnippet', ''].join('\n');
    const { engine, adapter } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    engine.setWorkspaceUriProvider(() => 'file:///workspace');

    const editor = new TestEditor('');
    editor.type('w');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('s'));
    expect(applied).not.toBeNull();
    expect(editor.getText()).toBe('file:///workspace');
  });

  it('surfaces generator errors through the warning sink instead of throwing', () => {
    const source = ['snippet boom "boom" A', '``rv = notDefinedAnywhere()``', 'endsnippet', ''].join('\n');
    const { adapter, warnings } = createHarness([
      { name: 'latex.hsnips', content: source, language: 'latex' }
    ]);

    const editor = new TestEditor('');
    editor.type('boo');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('m'));
    expect(applied).not.toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('boom');
    // The block resolves to an empty string, exactly like the reference.
    expect(editor.getText()).toBe('');
  });
});

describe('SnippetEngine context seam', () => {
  it('uses the default text provider when none is installed', () => {
    expect(getContextProvider()).toBeInstanceOf(TextContextProvider);
    const detector = getContextProvider().createDetector({
      doc: { getText: () => '$x$' },
      offset: 2,
      languageId: 'latex'
    });
    expect(detector.isMath()).toBe(true);
  });

  it('accepts a pluggable detector, e.g. one backed by a LaTeX parser', () => {
    const calls: ContextDetectorInput[] = [];
    const provider: ContextProvider = {
      createDetector(input) {
        calls.push(input);
        return {
          isMath: () => true,
          getEnvironment: () => 'align',
          getTriggerContext: () => '',
          getLineContext: () => '',
          getMultiLineContext: () => ''
        } satisfies ContextDetector;
      }
    };

    const { engine, adapter } = createHarness(defaultSnippetSources());
    engine.setContextProvider(provider);
    try {
      const editor = new TestEditor('not math at all ');
      editor.type('f');
      const applied = adapter.handleDocumentChange(editor, editor.typeChar('f'));
      // The provider claimed math mode, so the `m`-flagged snippet fires.
      expect(applied).not.toBeNull();
      expect(editor.getText()).toBe('not math at all \\frac{}{}');
      expect(calls.every((call) => call.languageId === 'latex')).toBe(true);
    } finally {
      setContextProvider(null);
    }
  });

  it('reports trigger, line and multi-line context for the detector', () => {
    const text = '\\begin{equation}\n a + b';
    const detector = new TextContextDetector(text, text.length, 20);
    expect(detector.isMath()).toBe(true);
    // The reference's `isMathEnvironment` heuristic does not expose an
    // environment name; the default provider reports `undefined` for it.
    expect(detector.getEnvironment()).toBeUndefined();
    expect(detector.getTriggerContext()).toBe('b');
    expect(detector.getLineContext()).toBe(' a + b');
    expect(detector.getMultiLineContext()).toBe(text);
  });

  it('flags unclosed display math as math and balanced math as not math', () => {
    expect(new TextContextDetector('text \\[ a', 8, 10).isMath()).toBe(true);
    expect(new TextContextDetector('$a$ then ', 9, 10).isMath()).toBe(false);
    expect(new TextContextDetector('$$a$$ then ', 11, 10).isMath()).toBe(false);
    expect(new TextContextDetector('\\begin{align}\nx', 15, 10).isMath()).toBe(true);
    expect(new TextContextDetector('`code ` then ', 13, 10).isMath()).toBe(false);
  });

  it('does not read a line break with space as display math', () => {
    // The report: a `context: "math"` snippet fired in prose. `\\[1ex]` — a line
    // break with vertical space, which `\maketitle`, tables and lists are full of —
    // contains `\[`, and the reference's heuristic saw an opener that never closed,
    // so everything after it was mathematics.
    const document = 'Title\\\\[1ex]\nSome prose here ';
    expect(new TextContextDetector(document, document.length, 10).isMath()).toBe(false);
    // A table row's spacing is the same shape, and so is `\\[0.5cm]`.
    const table = '\\begin{tabular}{c}\na \\\\[2pt]\nb\n\\end{tabular}\nprose ';
    expect(new TextContextDetector(table, table.length, 10).isMath()).toBe(false);
    // Three backslashes are a line break followed by *real* display math.
    expect(new TextContextDetector('a \\\\\\[ b ', 8, 10).isMath()).toBe(true);
  });

  it('ignores what LaTeX ignores: comments and literal arguments', () => {
    const cases = [
      '% costs $5\nplain prose ',
      '% \\[ not math\nplain prose ',
      'Use \\verb|$| for dollars, then prose ',
      '\\begin{verbatim}\n$5\n\\end{verbatim}\nprose ',
      '\\url{https://example.test/a$b}\nprose ',
      '\\lstinline|$| then prose ',
      '% a comment with \\begin{align}\nprose '
    ];
    for (const text of cases) {
      expect(
        new TextContextDetector(text, text.length, 10).isMath(),
        `read as math: ${JSON.stringify(text)}`
      ).toBe(false);
    }
  });

  it('reads the mathematics environments the reference did not know', () => {
    const inside = [
      '\\begin{multline}\na ',
      '\\begin{alignat}{2}\na ',
      '\\begin{flalign*}\na ',
      '\\begin{eqnarray}\na ',
      '\\begin{math}\na ',
      '\\begin{cases}\na ',
      '\\begin{matrix}\na ',
      '\\begin{split}\na '
    ];
    for (const text of inside) {
      expect(
        new TextContextDetector(text, text.length, 10).isMath(),
        `not read as math: ${JSON.stringify(text)}`
      ).toBe(true);
    }
    // ...and closing one leaves mathematics, whatever the environment.
    const closed = '\\begin{multline}\na\n\\end{multline}\nprose ';
    expect(new TextContextDetector(closed, closed.length, 10).isMath()).toBe(false);
  });

  it('treats a text island inside mathematics as text', () => {
    // `$\text{a b}$` is prose written inside math, which is where a word trigger
    // must stay quiet — the reference knew this, and it has to keep holding.
    const island = '$\\text{some prose ';
    expect(new TextContextDetector(island, island.length, 10).isMath()).toBe(false);
    const afterIsland = '$\\text{some prose} + x';
    expect(new TextContextDetector(afterIsland, afterIsland.length, 10).isMath()).toBe(true);
    const mbox = '$\\mbox{prose ';
    expect(new TextContextDetector(mbox, mbox.length, 10).isMath()).toBe(false);
  });
});

describe('built-in snippet library', () => {
  it('parses into real HSnippet objects', () => {
    const { engine } = createHarness(defaultSnippetSources());
    const snippets = engine.getSnippets('latex');
    expect(snippets.length).toBeGreaterThan(40);
    for (const snippet of snippets) {
      expect(snippet.generator).toBeTypeOf('function');
    }
  });

  it('includes the reference README examples', () => {
    const { engine } = createHarness(defaultSnippetSources());
    const byTrigger = new Map(engine.getSnippets('latex').map((s) => [s.trigger, s]));
    expect(byTrigger.has('box')).toBe(true);
    expect(byTrigger.has('dategreeting')).toBe(true);
    expect(byTrigger.has('filename')).toBe(true);
    expect(byTrigger.get('box')!.automatic).toBe(true);
  });

  it('keeps each snippet body available for editors that insert raw markup', () => {
    const { engine } = createHarness(defaultSnippetSources());
    const byTrigger = new Map(engine.getSnippets('latex').map((s) => [s.trigger, s]));
    // A snippet body keeps its `$1`-style tab stops, which is what an editor's
    // own snippet controller needs to place them.
    expect(getSnippetBody(byTrigger.get('ff')!)).toBe('\\frac{$1}{$2}$0');
    expect(byTrigger.get('ff')!.sourceName).toBe('latex.hsnips');
    expect(byTrigger.get('ff')!.headerLine).toBe('snippet ff "fraction" Aim');
  });

  it('includes the reference example-body snippets verbatim', () => {
    const { engine, adapter } = createHarness(defaultSnippetSources());
    const editor = new TestEditor('box');
    const candidate = adapter
      .getCompletionCandidates(editor, editor.getOffset())
      .find((c) => c.snippet.trigger === 'box');
    expect(candidate).toBeDefined();

    // The README's `box` snippet builds the borders from `t[0].length`, and `$1`
    // is empty at expansion time, so the rule is 2 dashes wide.
    const applied = adapter.acceptCompletion(candidate!, editor);
    const lines = applied.text.split('\n');
    expect(lines[0]).toBe('┌──┐');
    expect(lines[1]).toBe('│  │');
    expect(lines[2]).toBe('└──┘');
    expect(editor.getText()).toBe(applied.text);

    // Typing into the placeholder re-runs the code blocks and grows the rule.
    const placeholder = applied.selected[0];
    expect(placeholder.id).toBe(1);
    const typed = editor.replaceRange(placeholder.documentFrom, placeholder.documentTo, 'test');
    adapter.handleEdit(editor, typed);
    // `test` is 4 characters, so the rule becomes `'─'.repeat(4 + 2)`.
    expect(editor.getText().split('\n')[0]).toBe('┌──────┐');
  });

  it('ships a resources/snips sample identical to the built-in source', () => {
    // The shipped file and the embedded document must not drift apart; compare
    // the *parsed* result so trailing-newline differences stay irrelevant.
    const ref = readRepoFile('resources/snips/latex.hsnips');
    const a = new SnippetEngine();
    a.loadSnippetSources([{ name: 'latex.hsnips', content: defaultSnippetsSource, language: 'latex' }]);
    const b = new SnippetEngine();
    b.loadSnippetSources([{ name: 'latex.hsnips', content: ref, language: 'latex' }]);

    const summarise = (engine: SnippetEngine) =>
      engine.getSnippets('latex').map((s) => `${s.headerLine}|${s.trigger}|${s.placeholders}|${s.priority}`);

    expect(summarise(b)).toEqual(summarise(a));
  });

  it('ships a resources/snips/all.hsnips sample with the reference README snippets', () => {
    const all = readRepoFile('resources/snips/all.hsnips');
    const { engine, adapter } = createHarness([{ name: 'all.hsnips', content: all, language: 'all' }]);
    const triggers = engine.getSnippets('any-language').map((s) => s.trigger);
    expect(triggers).toContain('box');
    expect(triggers).toContain('dategreeting');
    expect(triggers).toContain('filename');

    // The `global` block declares `repeat`, and the box body calls it — proof that
    // global scope is shared with the snippet bodies.
    const editor = new TestEditor('');
    editor.type('bo');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('x'));
    expect(applied).not.toBeNull();
    // `$1` is empty at expansion time: `'─'.repeat(0 + 2)`.
    expect(editor.getText().split('\n')[0]).toBe('┌──┐');
    expect(editor.getText().split('\n')[1]).toBe('│  │');
  });

  it('evaluates the dategreeting and filename example bodies', () => {
    const all = readRepoFile('resources/snips/all.hsnips');
    const engine = new SnippetEngine();
    engine.loadSnippetSources([{ name: 'all.hsnips', content: all, language: 'all' }]);
    const byTrigger = new Map(engine.getSnippets('any').map((s) => [s.trigger, s]));

    const greeting = byTrigger.get('dategreeting')!.generator(undefined, [], [], '', '');
    const [sections, blocks] = greeting;
    const rendered = sections
      .map((section) => (typeof section === 'string' ? section : (blocks[section.block] ?? '')))
      .join('');
    expect(rendered).toContain('Hello from your hsnip at ');
    // The sample pins the date so the test is not clock-dependent.
    expect(rendered).toContain('2024');

    // `filename` uses `require`, which Eukolia deliberately does not provide.
    const filename = byTrigger.get('filename')!;
    let message = '';
    try {
      filename.generator(undefined, [], [], '', '');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/require|not available|not defined/i);
  });
});
