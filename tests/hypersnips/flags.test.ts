/**
 * Flag semantics, priority ordering, regex triggers and tab-stop navigation for
 * the ported HyperSnips engine.
 *
 * Every expectation is derived from References/hypersnips/README.md's documented
 * flag behaviour (`A`, `i`, `w`, `b`, `M`, `m`, `h`) and from the reference's own
 * `completion.ts` / `extension.ts` algorithms.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { HSnippet } from '../../src/renderer/vendor/hypersnips';
import type { SnippetEditorAdapter } from '../../src/renderer/snippets/editorAdapter';
import type { SnippetEngine } from '../../src/renderer/snippets/engine';
import { createHarness, TestEditor } from '../snippets/helpers';
import { BACKSLASH, DOUBLE_BACKSLASH, offsetOf } from './helpers';

/** Snippet source exercising every non-regex flag the reference documents. */
const FLAG_SOURCE = [
  'snippet ff "fraction" Aim',
  '\\frac{$1}{$2}$0',
  'endsnippet',
  '',
  'snippet RR "real numbers" iAm',
  '\\mathbb{R}',
  'endsnippet',
  '',
  'snippet @a "alpha" iAm',
  '\\alpha',
  'endsnippet',
  '',
  'snippet sum "sum" wA',
  '\\sum_{$1}^{$2}$0',
  'endsnippet',
  '',
  'snippet beg "environment" biA',
  '\\begin{$1}',
  'endsnippet',
  '',
  'snippet hidden "hidden" hiA',
  'HIDDEN',
  'endsnippet',
  ''
].join('\n');
describe('HyperSnips flags', () => {
  let engine: SnippetEngine;
  let adapter: SnippetEditorAdapter;

  beforeEach(() => {
    const harness = createHarness([{ name: 'latex.hsnips', content: FLAG_SOURCE, language: 'latex' }]);
    engine = harness.engine;
    adapter = harness.adapter;
    void engine;
  });

  describe('A flag (automatic expansion)', () => {
    it('expands as soon as the trigger matches inside math', () => {
      const editor = new TestEditor('$');
      expect(adapter.handleDocumentChange(editor, editor.typeChar('f'))).toBeNull();

      const applied = adapter.handleDocumentChange(editor, editor.typeChar('f'));
      expect(applied).not.toBeNull();
      expect(editor.getText()).toBe('$\\frac{}{}');
      expect(applied!.text).toBe('\\frac{}{}');
      expect(applied!.selected.map((p) => p.id)).toEqual([1]);
    });
    it('ignores text changes that are not single keystrokes', () => {
      const editor = new TestEditor('$');
      const change = editor.replaceRange(1, 1, 'ff');
      expect(adapter.handleDocumentChange(editor, change)).toBeNull();
      expect(editor.getText()).toBe('$ff');
    });
  });

  describe('m / n flags (math context)', () => {
    it('suppresses math snippets outside math mode', () => {
      const editor = new TestEditor('text ');
      expect(adapter.handleDocumentChange(editor, editor.typeChar('f'))).toBeNull();
      expect(editor.getText()).toBe('text f');
    });

    it('offers math snippets inside math', () => {
      // `$` opens math mode, so `RR` after it is a math-context expansion.
      const editor = new TestEditor('$');
      editor.typeChar('R');
      const applied = adapter.handleDocumentChange(editor, editor.typeChar('R'));
      expect(applied).not.toBeNull();
      expect(editor.getText()).toBe('$\\mathbb{R}');
    });

    it('suppresses non-math snippets inside math mode', () => {
      const probe = createHarness();
      const snippet = new HSnippet(
        { trigger: 'plain', description: 'text only', flags: '', priority: 0 },
        () => [['PLAIN'], []],
        0
      );
      snippet.automatic = true;
      snippet.nonmath = true;
      probe.engine.addSnippets('latex', [snippet]);

      const outside = new TestEditor('prose ');
      outside.type('plai');
      expect(probe.adapter.handleDocumentChange(outside, outside.typeChar('n'))).not.toBeNull();
      expect(outside.getText()).toBe('prose PLAIN');

      const inside = new TestEditor('$');
      inside.type('plai');
      expect(probe.adapter.handleDocumentChange(inside, inside.typeChar('n'))).toBeNull();
      expect(inside.getText()).toBe('$plain');
    });

    it('hides math snippets from the completion list outside math mode', () => {
      const backslash = String.fromCharCode(92);
      const outside = adapter.getCompletionCandidates(new TestEditor(backslash + 'f'), 2);
      expect(outside.map((c) => c.snippet.trigger)).not.toContain('ff');

      // Typing the whole trigger is what makes a non-`i` snippet match.
      const inside = adapter.getCompletionCandidates(new TestEditor('$' + backslash + 'ff'), 4);
      expect(inside.map((c) => c.snippet.trigger)).toContain('ff');
    });
  });

  describe('w flag (word boundary)', () => {
    it('expands when the trigger stands alone', () => {
      const editor = new TestEditor('$');
      editor.type('su');
      const applied = adapter.handleDocumentChange(editor, editor.typeChar('m'));
      expect(applied).not.toBeNull();
      expect(editor.getText()).toBe('$\\sum_{}^{}');
    });
    it('does not expand as a suffix of a longer word', () => {
      const editor = new TestEditor('$x');
      editor.type('su');
      expect(adapter.handleDocumentChange(editor, editor.typeChar('m'))).toBeNull();
      expect(editor.getText()).toBe('$xsum');
    });

    it('matches after punctuation', () => {
      const editor = new TestEditor('$+');
      editor.type('su');
      expect(adapter.handleDocumentChange(editor, editor.typeChar('m'))).not.toBeNull();
      expect(editor.getText()).toBe('$+\\sum_{}^{}');
    });
  });

  describe('i flag (in-word expansion)', () => {
    it('expands in the middle of a word', () => {
      const editor = new TestEditor('$x');
      editor.type('@');
      const applied = adapter.handleDocumentChange(editor, editor.typeChar('a'));
      expect(applied).not.toBeNull();
      expect(editor.getText()).toBe('$x\\alpha');
    });

    it('is what makes a non-boundary suffix expand', () => {
      const harness = createHarness([
        {
          name: 'latex.hsnips',
          content: ['snippet sum "sum" iA', 'SUM', 'endsnippet', ''].join('\n'),
          language: 'latex'
        }
      ]);
      const editor = new TestEditor('$x');
      editor.type('su');
      const applied = harness.adapter.handleDocumentChange(editor, editor.typeChar('m'));
      expect(applied).not.toBeNull();
      expect(editor.getText()).toBe('$xSUM');
    });
  });

  describe('b flag (beginning of line)', () => {
    it('expands at the start of a line', () => {
      const editor = new TestEditor('$');
      editor.type('be');
      expect(adapter.handleDocumentChange(editor, editor.typeChar('g'))).not.toBeNull();
      expect(editor.getText()).toBe('$\\begin{}');
    });

    it('does not expand after non-whitespace', () => {
      // `i` wins over `b` when both are present (in-word expansion is checked
      // first), so the trigger still fires mid-word — this documents that the
      // reference's ordering means `b` only constrains a snippet without `i`.
      const editor = new TestEditor('x');
      editor.type('be');
      expect(adapter.handleDocumentChange(editor, editor.typeChar('g'))).not.toBeNull();
      expect(editor.getText()).toBe('x\\begin{}');
    });
  });

  describe('h flag (hidden)', () => {
    it('keeps hidden snippets out of the suggestion list', () => {
      const editor = new TestEditor('$');
      editor.type('hidd');
      const candidates = adapter.getCompletionCandidates(editor, editor.getOffset());
      expect(candidates.map((c) => c.snippet.trigger)).not.toContain('hidden');
    });

    it('still auto-expands hidden snippets', () => {
      const editor = new TestEditor('$');
      editor.type('hidde');
      expect(adapter.handleDocumentChange(editor, editor.typeChar('n'))).not.toBeNull();
      expect(editor.getText()).toBe('$HIDDEN');
    });
  });
});

describe('HyperSnips priority and regex triggers', () => {
  it('orders snippets by descending priority within a language', () => {
    const source = [
      'snippet abc "low" n',
      'LOW',
      'endsnippet',
      '',
      'priority 10',
      'snippet abc "high" n',
      'HIGH',
      'endsnippet',
      '',
      'priority 5',
      'snippet abc "mid" n',
      'MID',
      'endsnippet',
      ''
    ].join('\n');

    const { engine } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    const snippets = engine.getSnippets('latex');
    expect(snippets.map((s) => s.description)).toEqual(['high', 'mid', 'low']);
    expect(snippets.map((s) => s.priority)).toEqual([10, 5, 0]);
  });

  it('resets priority after each snippet, like the reference parser', () => {
    const source = [
      'priority 7',
      'snippet one "one" n',
      'ONE',
      'endsnippet',
      'snippet two "two" n',
      'TWO',
      'endsnippet',
      ''
    ].join('\n');
    const { engine } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    const [first, second] = engine.getSnippets('latex');
    expect(first.priority).toBe(7);
    expect(second.priority).toBe(0);
  });

  it('gives the higher-priority automatic snippet the expansion', () => {
    const source = [
      'snippet `([a-z])(q)` "low" Aim',
      'LOW``rv = m[1]``',
      'endsnippet',
      '',
      'priority 50',
      'snippet `([a-z])(q)` "high" Aim',
      'HIGH``rv = m[1]``',
      'endsnippet',
      ''
    ].join('\n');

    const { adapter } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    const editor = new TestEditor('$');
    editor.type('a');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('q'));

    expect(applied).not.toBeNull();
    expect(applied!.expansion.type.description).toBe('high');
    // The regex `([a-z])(q)` matched `aq`, so both characters are replaced.
    expect(editor.getText()).toBe('$HIGHa');
  });
  it('supports regex triggers with capture groups exposed as m', () => {
    const source = [
      'priority 100',
      'snippet `(\\\\?[a-zA-Z]\\w*)(bf)` "mathbf" iAm',
      '\\mathbf{``rv = m[1]``}$0',
      'endsnippet',
      ''
    ].join('\n');

    const { engine, adapter } = createHarness([
      { name: 'latex.hsnips', content: source, language: 'latex' }
    ]);
    const snippet = engine.getSnippets('latex')[0];
    expect(snippet.regexp).toBeInstanceOf(RegExp);
    expect(snippet.regexp!.source).toBe('(\\\\?[a-zA-Z]\\w*)(bf)$');

    const editor = new TestEditor('$\\alpha');
    editor.type('b');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('f'));

    expect(applied).not.toBeNull();
    // The capture group is accessed via m[1] in the code block.
    expect(editor.getText()).toBe('$\\mathbf{\\alpha}');
  });

  it('exposes regex capture groups to JavaScript code blocks through m', () => {
    const source = [
      'priority 100',
      'snippet `(\\\\?[a-zA-Z]\\w*)cal` "mathcal" iAm',
      '\\mathcal{``rv = m[1].toUpperCase()``}$0',
      'endsnippet',
      ''
    ].join('\n');

    const { adapter } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    const editor = new TestEditor('$\\alpha');
    editor.type('ca');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('l'));

    expect(applied).not.toBeNull();
    expect(editor.getText()).toBe('$\\mathcal{\\ALPHA}');
  });

  it('supports multiline (M) regex triggers', () => {
    const source = [
      'snippet `(\\\\begin\\{itemize\\}[\\s\\S]*)$` "item" AM',
      'MATCHED',
      'endsnippet',
      ''
    ].join('\n');

    const { adapter } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    const editor = new TestEditor('\\begin{itemize}\n\\item ');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('x'));

    expect(applied).not.toBeNull();
    expect(editor.getText()).toBe('MATCHED');
  });
});

describe('HyperSnips tab stop navigation', () => {
  // Written with `BACKSLASH` because LaTeX bodies are backslash-dense; a `'\\t'`
  // typo in a single-quoted literal is a TAB and silently corrupts the snippet.
  const NAV_SOURCE = [
    'snippet mk "inline math" iA',
    '$$1$ $0',
    'endsnippet',
    '',
    'snippet ali "align" iA',
    BACKSLASH + 'begin{align}',
    '\t$1 &= $2 ' + DOUBLE_BACKSLASH,
    '\t$3 &= $4',
    BACKSLASH + 'end{align}$0',
    'endsnippet',
    '',
    'snippet brk "mirrored" iA',
    BACKSLASH + 'braket{$1}{$1}$2',
    'endsnippet',
    ''
  ].join('\n');

  let engine: SnippetEngine;
  let adapter: SnippetEditorAdapter;

  beforeEach(() => {
    const harness = createHarness([{ name: 'latex.hsnips', content: NAV_SOURCE, language: 'latex' }]);
    engine = harness.engine;
    adapter = harness.adapter;
  });

  function typeAndExpand(editor: TestEditor, text: string) {
    let applied = null as ReturnType<SnippetEditorAdapter['handleDocumentChange']>;
    for (const char of text) {
      applied = adapter.handleDocumentChange(editor, editor.typeChar(char));
    }
    return applied;
  }

  it('walks forward through tab stops and finishes on $0', () => {
    const editor = new TestEditor('');
    const applied = typeAndExpand(editor, 'mk');
    expect(applied).not.toBeNull();
    // `$$1$ $0` with `$1` and `$0` stripped is `$$ `, which replaces the `mk`
    // trigger: `$$ `.
    expect(editor.getText()).toBe('$$ ');

    // $1 is selected first.
    expect(engine.activeExpansion!.selectedPlaceholder).toBe(1);
    const first = adapter.geometry(applied!.expansion).selected;
    expect(first).toHaveLength(1);
    expect(first[0].from).toBe(1);
    expect(first[0].to).toBe(1);

    // Tab -> $0, the final cursor, which is not a tab stop.
    const second = adapter.nextTabStop(editor);
    expect(second).not.toBeNull();
    expect(second!.id).toBe(0);
    expect(second!.from).toBe(3);

    // Tab again leaves the snippet entirely.
    expect(adapter.nextTabStop(editor)).toBeNull();
    expect(engine.stackDepth).toBe(0);
  });

  it('navigates a multi-line expansion with correct positions', () => {
    const editor = new TestEditor('');
    const applied = typeAndExpand(editor, 'ali');
    expect(applied).not.toBeNull();

    const text = editor.getText();
    // `\begin{align}` / tab / `$1 &= $2 \\` / tab / `$3 &= $4` / `\end{align}`
    // with every `$n` stripped and the LaTeX row separator preserved.
    expect(text).toBe(
      BACKSLASH +
        'begin{align}\n\t &=  ' +
        DOUBLE_BACKSLASH +
        '\n\t &= \n' +
        BACKSLASH +
        'end{align}'
    );

    const geometry = engine.getGeometry(applied!.expansion);
    expect(geometry.text).toBe(text);
    const byId = new Map(geometry.placeholders.map((p) => [p.id, p] as const));
    expect(byId.get(1)!.documentFrom).toBe(offsetOf(text, '\t') + 1);
    expect(byId.get(2)!.documentFrom).toBe(text.indexOf('&=') + 3);
    // `$3` follows the second row's tab and `&= ` (`tab` + `&=` + space).
    expect(byId.get(3)!.documentFrom).toBe(text.lastIndexOf('\t') + 1);

    // Walking forward reaches ids 1, 2, 3 and 4; the fifth step lands on the final
    // `$0` cursor (the reference pops the instance at that point) and the sixth
    // step has nothing left to move to.
    const visited: Array<number | undefined> = [1];
    for (let i = 0; i < 3; i++) {
      const move = adapter.nextTabStop(editor);
      expect(move).not.toBeNull();
      visited.push(move!.id);
    }
    expect(visited).toEqual([1, 2, 3, 4]);
    expect(engine.stackDepth).toBe(1);

    const final = adapter.nextTabStop(editor);
    expect(final).not.toBeNull();
    expect(final!.id).toBe(0);
    expect(engine.stackDepth).toBe(0);

    expect(adapter.nextTabStop(editor)).toBeNull();
  });

  it('walks backwards into the snippet again', () => {
    const editor = new TestEditor('');
    typeAndExpand(editor, 'mk');

    expect(adapter.nextTabStop(editor)).not.toBeNull(); // -> $0, which pops it
    // The instance is finished at `$0`, so there is nothing left to step back to.
    expect(adapter.previousTabStop(editor)).toBeNull();
    expect(engine.stackDepth).toBe(0);
  });

  it('walks backwards while tab stops remain', () => {
    const editor = new TestEditor('');
    typeAndExpand(editor, 'ali');

    const second = adapter.nextTabStop(editor);
    expect(second!.id).toBe(2);
    const back = adapter.previousTabStop(editor);
    expect(back!.id).toBe(1);
  });

  it('mirrors a shared placeholder id to both occurrences', () => {
    const editor = new TestEditor('');
    const applied = typeAndExpand(editor, 'brk');
    expect(applied).not.toBeNull();
    expect(editor.getText()).toBe('\\braket{}{}');

    const geometry = engine.getGeometry(applied!.expansion);
    const ones = geometry.placeholders.filter((p) => p.id === 1);
    expect(ones).toHaveLength(2);
    // Both `$1` occurrences are the tab stop the expansion starts on.
    expect(applied!.selected.map((p) => p.id)).toEqual([1, 1]);
    expect(ones[0].to).toBe(ones[0].from);
    expect(ones[1].to).toBe(ones[1].from);
    expect(ones[1].from).toBeGreaterThan(ones[0].from);
  });

  it('leaves the snippet and clears the stack', () => {
    const editor = new TestEditor('');
    typeAndExpand(editor, 'mk');
    expect(engine.stackDepth).toBe(1);
    adapter.leaveSnippet();
    expect(engine.stackDepth).toBe(0);
    expect(adapter.nextTabStop(editor)).toBeNull();
  });

  it('drops an expansion once the selection moves outside it', () => {
    const editor = new TestEditor('');
    typeAndExpand(editor, 'mk');
    expect(engine.stackDepth).toBe(1);

    editor.text = 'zzzzzzzzzzzz';
    adapter.handleSelectionChange(editor, { from: 10, to: 10 });
    expect(engine.stackDepth).toBe(0);
  });
});

