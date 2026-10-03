/**
 * Rich placeholder forms: `${1:default}`, `${1|a,b|}`, `${1/re/f/}`, `${VISUAL}`.
 *
 * The ported engine used to recognise only `$1` and `${1}` while its own
 * `stripPlaceholders` — the function that decides what text is actually
 * inserted — understood the richer forms too. The two disagreed, so a snippet
 * like the shipped `beg` inserted the literal characters `${1:equation}` into
 * the document and left no tab stop to type over. Every test here pins the
 * agreement: whatever `stripPlaceholders` renders is what lands in the buffer,
 * and every placeholder it renders is also a tab stop covering that text.
 */

import { describe, expect, it } from 'vitest';
import { getSnippetBody, readPlaceholder, stripPlaceholders } from '../../src/renderer/vendor/hypersnips';
import { SnippetEngine, getSnippetEngine } from '../../src/renderer/snippets/engine';
import { defaultSnippetSources } from '../../src/renderer/snippets/defaultSnippets';
import { createHarness, TestEditor } from './helpers';
import { BACKSLASH } from '../hypersnips/helpers';

/** A body for every form the reader has to understand. */
const RICH_SOURCE = [
  'snippet beg "begin/end" A',
  `${BACKSLASH}begin{\${1:equation}}`,
  '\t$0',
  `${BACKSLASH}end{\${1:equation}}`,
  'endsnippet',
  '',
  'snippet pick "choice" A',
  `${BACKSLASH}mathbb{\${1|R,N,Z,Q,C|}}$0`,
  'endsnippet',
  '',
  'snippet tr "transform" A',
  `${BACKSLASH}hat{\${1:x}} = \${1/./[&]/}$0`,
  'endsnippet',
  '',
  'snippet bare "bare forms" A',
  '$1-${2}-$3',
  'endsnippet',
  ''
].join('\n');

describe('readPlaceholder', () => {
  it('reads every form stripPlaceholders renders', () => {
    expect(readPlaceholder('$1', 0)).toEqual({ token: '$1', id: 1, content: '' });
    expect(readPlaceholder('${2}', 0)).toEqual({ token: '${2}', id: 2, content: '' });
    expect(readPlaceholder('${3:def}', 0)).toEqual({ token: '${3:def}', id: 3, content: 'def' });
    expect(readPlaceholder('${4|x,y|}', 0)).toEqual({ token: '${4|x,y|}', id: 4, content: 'x' });
    expect(readPlaceholder('${5/[0-9]+/X/}', 0)).toEqual({
      token: '${5/[0-9]+/X/}',
      id: 5,
      content: ''
    });
    // A variable is not a tab stop: rendering it is the host's business.
    expect(readPlaceholder('${VISUAL}', 0)).toEqual({ token: '${VISUAL}', content: '' });
    expect(readPlaceholder('${TM_FILENAME:untitled}', 0)).toEqual({
      token: '${TM_FILENAME:untitled}',
      content: 'untitled'
    });
    // Not a placeholder at all.
    expect(readPlaceholder('$', 0)).toBeNull();
    expect(readPlaceholder('text', 0)).toBeNull();
  });

  it('reads from any offset, and only at a dollar sign', () => {
    expect(readPlaceholder('a ${1:x} b', 2)).toEqual({ token: '${1:x}', id: 1, content: 'x' });
    expect(readPlaceholder('a ${1:x} b', 3)).toBeNull();
  });
});

describe('placeholder defaults reach the document', () => {
  it('inserts a default as text and selects it, rather than the markup', () => {
    const { engine, adapter } = createHarness([{ name: 'latex.hsnips', content: RICH_SOURCE, language: 'latex' }]);
    const editor = new TestEditor('');
    editor.type('be');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('g'));

    expect(applied).not.toBeNull();
    expect(applied!.text).not.toContain('${1');
    expect(applied!.text).toBe(stripPlaceholders(`${BACKSLASH}begin{\${1:equation}}\n\t$0\n${BACKSLASH}end{\${1:equation}}`));
    expect(editor.getText()).toContain(`${BACKSLASH}begin{equation}`);
    expect(editor.getText()).toContain(`${BACKSLASH}end{equation}`);

    // Both `${1:equation}` occurrences are tab stop 1, and both cover the word
    // the expansion inserted, so typing replaces the default in either place.
    const geometry = engine.getGeometry(applied!.expansion);
    const firsts = geometry.placeholders.filter((placeholder) => placeholder.id === 1);
    expect(firsts).toHaveLength(2);
    const text = geometry.text;
    for (const placeholder of firsts) {
      expect(text.slice(placeholder.from, placeholder.to)).toBe('equation');
    }
    expect(applied!.selected.map((placeholder) => placeholder.id)).toEqual([1, 1]);
  });

  it('inserts the first option of a choice and selects it', () => {
    const { engine, adapter } = createHarness([{ name: 'latex.hsnips', content: RICH_SOURCE, language: 'latex' }]);
    const editor = new TestEditor('');
    editor.type('pic');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('k'));

    expect(applied).not.toBeNull();
    expect(applied!.text).toBe(`${BACKSLASH}mathbb{R}`);
    const selected = engine.getGeometry(applied!.expansion).selected[0];
    expect(engine.getGeometry(applied!.expansion).text.slice(selected.from, selected.to)).toBe('R');
  });

  it('consumes a transform mirror instead of inserting its markup', () => {
    const { engine, adapter } = createHarness([{ name: 'latex.hsnips', content: RICH_SOURCE, language: 'latex' }]);
    const editor = new TestEditor('');
    editor.type('t');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('r'));

    expect(applied).not.toBeNull();
    expect(applied!.text).not.toContain('${1/');
    expect(applied!.text).toBe(`${BACKSLASH}hat{x} = `);
    // The tab stop is still the `x` the default put there; the mirror after the
    // `=` carries no text of its own.
    const geometry = engine.getGeometry(applied!.expansion);
    const firsts = geometry.placeholders.filter((placeholder) => placeholder.id === 1);
    expect(firsts).toHaveLength(2);
    expect(geometry.text.slice(firsts[0].from, firsts[0].to)).toBe('x');
    expect(firsts[1].from).toBe(firsts[1].to);
  });

  it('leaves the bare forms exactly as they were', () => {
    const { engine, adapter } = createHarness([{ name: 'latex.hsnips', content: RICH_SOURCE, language: 'latex' }]);
    const editor = new TestEditor('');
    editor.type('bar');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('e'));

    expect(applied).not.toBeNull();
    expect(applied!.text).toBe('--');
    const geometry = engine.getGeometry(applied!.expansion);
    // Three bare placeholders, all empty — the `$0` in the other bodies is the
    // final cursor and never a part of its own.
    expect(geometry.placeholders.map((placeholder) => placeholder.id)).toEqual([1, 2, 3]);
    for (const placeholder of geometry.placeholders) {
      expect(placeholder.from).toBe(placeholder.to);
    }
  });
});

describe('tokens nested inside a default', () => {
  it('renders the inner text instead of leaving its markup behind', () => {
    // These three used to reach the buffer as literal markup: a default's content
    // was handed back verbatim, so `${1:${2:inner}}` inserted `${2:inner}` and
    // `${1:${TM_FILENAME}}` inserted `${TM_FILENAME}`.
    expect(stripPlaceholders('A${1:${2:inner}}B')).toBe('AinnerB');
    expect(stripPlaceholders('A${1:${VISUAL}}B')).toBe('AB');
    expect(stripPlaceholders('A${1:${TM_FILENAME:dflt}}B')).toBe('AdfltB');
    // A nested token is not a tab stop of its own: the outer one carries the text.
    expect(stripPlaceholders('${1:${2:inner}}${2}')).toBe('inner');
  });

  it('selects the tab stop over the inner text, not over the markup', () => {
    const { engine, adapter } = createHarness([
      { name: 'nested.hsnips', content: 'snippet nest "nested" A\nA${1:${2:inner}}B$0\nendsnippet\n', language: 'latex' }
    ]);
    const editor = new TestEditor('');
    editor.type('nes');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('t'));

    expect(applied).not.toBeNull();
    expect(applied!.text).toBe('AinnerB');
    const geometry = engine.getGeometry(applied!.expansion);
    const stop = geometry.placeholders.find((placeholder) => placeholder.id === 1);
    expect(stop).toBeDefined();
    expect(geometry.text.slice(stop!.from, stop!.to)).toBe('inner');
  });
});

describe('variables the host answers', () => {
  it('uses the host value, then the body default, then nothing', () => {
    expect(stripPlaceholders('A${TM_FILENAME}B', () => 'homework.tex')).toBe('Ahomework.texB');
    // The host knows the name but has no value — an unsaved buffer — and the
    // default is what a variable with no value renders as.
    expect(stripPlaceholders('A${TM_FILENAME:dflt}B', () => undefined)).toBe('AdfltB');
    expect(stripPlaceholders('A${TM_FILENAME:dflt}B', () => '')).toBe('AB');
    expect(stripPlaceholders('A${NOPE}B', () => undefined)).toBe('AB');
  });

  it('resolves a body variable through the engine resolver', () => {
    const { engine, adapter } = createHarness([
      { name: 'vars.hsnips', content: `snippet vars "variable" A\n% \${TM_FILENAME}$0\nendsnippet\n`, language: 'latex' }
    ]);
    // Nothing installs a resolver in the harness, so this is the seam the shell
    // fills from the active document.
    engine.setVariableResolver((_names, defaults) => ({ ...defaults, TM_FILENAME: 'homework.tex' }));

    const editor = new TestEditor('');
    editor.type('var');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('s'));

    expect(applied).not.toBeNull();
    expect(applied!.text).toBe('% homework.tex');
  });
});

describe('the shipped library uses the same reader', () => {
  it('expands `beg` with its default environment, not with its markup', () => {
    const { engine, adapter } = createHarness(defaultSnippetSources());
    // `beg` is `Aib`: automatic, in-word, and at the beginning of a line, in
    // mathematics — so an unclosed `$` on the previous line is what qualifies.
    const editor = new TestEditor(`$\n`);
    editor.type('be');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('g'));

    expect(applied).not.toBeNull();
    expect(editor.getText()).not.toContain('${1');
    const lines = editor.getText().split('\n');
    expect(lines[1]).toBe(`${BACKSLASH}begin{equation}`);
    expect(lines[3]).toBe(`${BACKSLASH}end{equation}`);

    const geometry = engine.getGeometry(applied!.expansion);
    const selected = geometry.selected[0];
    expect(selected).toBeDefined();
    expect(geometry.text.slice(selected.from, selected.to)).toBe('equation');
  });

  it('leaves no placeholder markup in any snippet of the built-in library', () => {
    // A body may contain `$`-markup only where the engine turns it into a tab
    // stop or text; nothing may survive into the buffer as literal characters.
    const engine = new SnippetEngine();
    engine.loadSnippetSources(defaultSnippetSources());

    for (const snippet of engine.getSnippets('latex')) {
      const body = getSnippetBody(snippet);
      if (!/\$(?:\d|\{)/.test(body)) continue;
      const rendered = stripPlaceholders(body);
      expect(rendered, `${snippet.trigger} still renders markup`).not.toMatch(/\$(?:\d|\{)/);
    }
  });
});

describe('${VISUAL} stays the host\'s', () => {
  it('substitutes the selection the host supplies', () => {
    const source = ['snippet wrap "wrap" A', `${BACKSLASH}text{$\{VISUAL\}}$0`, 'endsnippet', ''].join('\n');
    const { engine, adapter } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    engine.setSelectionProvider(() => ({ text: 'picked', timestamp: Date.now() }));

    const editor = new TestEditor('');
    editor.type('wra');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('p'));

    expect(applied).not.toBeNull();
    expect(applied!.text).toBe(`${BACKSLASH}text{picked}`);
    expect(editor.getText()).not.toContain('VISUAL');
  });

  it('uses a default when the selection is empty, and the selection when it is not', () => {
    // `${VISUAL:default}` is the form LaTeX Workshop's own snippets use
    // (`${1:${VISUAL:text}}`), and it used to reach the document as literal
    // markup: the reader hands a placeholder's default back verbatim, so the
    // replacement for the bare variable never saw it.
    const source = ['snippet fno "font" A', `${BACKSLASH}textnormal{\${1:$\{VISUAL:text\}}}$0`, 'endsnippet', ''].join(
      '\n'
    );
    const withoutSelection = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    withoutSelection.engine.setSelectionProvider(() => undefined);
    const first = new TestEditor('');
    first.type('fn');
    const applied = withoutSelection.adapter.handleDocumentChange(first, first.typeChar('o'));

    expect(applied).not.toBeNull();
    expect(applied!.text).toBe(`${BACKSLASH}textnormal{text}`);
    expect(first.getText()).not.toContain('VISUAL');

    const withSelection = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    withSelection.engine.setSelectionProvider(() => ({ text: 'picked', timestamp: Date.now() }));
    const second = new TestEditor('');
    second.type('fn');
    const wrapped = withSelection.adapter.handleDocumentChange(second, second.typeChar('o'));

    expect(wrapped).not.toBeNull();
    expect(wrapped!.text).toBe(`${BACKSLASH}textnormal{picked}`);
  });

  it('leaves a variable whose default holds braces intact', () => {
    // `${VISUAL:\textbf{x}}` — the default contains braces, so the closing brace
    // is the one that balances the opening one rather than the first that appears.
    const body = `${BACKSLASH}emph{` + '${VISUAL:' + `${BACKSLASH}textbf{x}}` + '}$0';
    const source = ['snippet ww "wrap" A', body, 'endsnippet', ''].join('\n');
    const { engine, adapter } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    engine.setSelectionProvider(() => undefined);
    const editor = new TestEditor('');
    editor.type('w');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('w'));

    expect(applied!.text).toBe(`${BACKSLASH}emph{${BACKSLASH}textbf{x}}`);
  });

  it('renders a variable default when the host has no answer', () => {
    expect(stripPlaceholders('${VISUAL}')).toBe('');
    expect(stripPlaceholders('${TM_FILENAME:untitled}')).toBe('untitled');
    // The same reader the constructor uses, so a body with a variable in it does
    // not become a tab stop.
    expect(readPlaceholder('${VISUAL}', 0)?.id).toBeUndefined();
    expect(getSnippetEngine()).toBeInstanceOf(SnippetEngine);
  });
});

describe('the last tab stop of an expansion', () => {
  /**
   * `\part{${1:${VISUAL}}}` with no selection reduces to `\part{${1:}}`: an empty
   * *ordinary* stop at the end of the body. It used to be mistaken for the final
   * cursor — which is empty in exactly the same way — and moved to the end of the
   * expansion, putting the caret after the closing brace.
   */
  const cases: Array<{ name: string; body: string; expected: string; caret: number }> = [
    { name: 'a stop inside braces', body: `${BACKSLASH}part{\${1:$\{VISUAL\}}}`, expected: `${BACKSLASH}part{}`, caret: 6 },
    {
      name: 'a stop on its own line',
      body: `${BACKSLASH}begin{align}\n\t$1\n${BACKSLASH}end{align}`,
      expected: `${BACKSLASH}begin{align}\n\t\n${BACKSLASH}end{align}`,
      caret: 15
    },
    { name: 'a stop before trailing text', body: `A $1 B`, expected: 'A  B', caret: 2 }
  ];

  for (const testCase of cases) {
    it(`keeps the caret at ${testCase.name}`, () => {
      const source = ['snippet zz "z" A', testCase.body, 'endsnippet', ''].join('\n');
      const { engine, adapter } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
      engine.setSelectionProvider(() => undefined);
      const editor = new TestEditor('');
      editor.type('z');
      const applied = adapter.handleDocumentChange(editor, editor.typeChar('z'));

      expect(applied).not.toBeNull();
      expect(applied!.text).toBe(testCase.expected);
      const selected = engine.getGeometry(applied!.expansion).selected[0];
      expect(selected.id).toBe(1);
      expect(selected.from).toBe(testCase.caret);
      expect(selected.to).toBe(testCase.caret);
      // What the editor is told to select is the same place.
      expect(applied!.selected[0].documentFrom).toBe(testCase.caret);
    });
  }

  it('still puts the final cursor at the very end', () => {
    const source = ['snippet zz "z" A', `${BACKSLASH}frac{$1}{$2}$0`, 'endsnippet', ''].join('\n');
    const { engine, adapter } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    const editor = new TestEditor('');
    editor.type('z');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('z'));

    const geometry = engine.getGeometry(applied!.expansion);
    const final = geometry.placeholders.find((placeholder) => placeholder.id === 0);
    expect(final).toBeDefined();
    expect(final!.from).toBe(`${BACKSLASH}frac{}{}`.length);
  });
});
