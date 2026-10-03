/**
 * Engine projection tests.
 *
 * Everything the managed library can express has to reach the ported HyperSnips
 * engine intact: this is where each feature the schema names is followed all the
 * way to a real completion or a real expansion, so "the format supports it" and
 * "the engine does it" cannot drift apart.
 */

import { describe, expect, it } from 'vitest';
import {
  EUSNIPS_VERSION,
  globalsSource,
  loadEusnipsIntoEngine,
  normalizeSnippetFile,
  renderSnippetDocument,
  type EusnipsFile,
  type EusnipsSnippet
} from '../../src/renderer/snippets/eusnips';
import { SnippetEngine } from '../../src/renderer/snippets/engine';
import { SnippetEditorAdapter } from '../../src/renderer/snippets/editorAdapter';
import type { HSnippet } from '../../src/renderer/vendor/hypersnips';
import { createHarness, TestEditor } from './helpers';
import { BACKSLASH, DOUBLE_BACKSLASH } from '../hypersnips/helpers';

/**
 * The pattern a loaded snippet matches, as the engine holds it.
 *
 * A trigger is a regular expression now, so the engine hands back a compiled one
 * with the anchor the header parser appends — `ff` arrives as `ff$` — and the
 * literal `trigger` field is empty. Reading it through one helper keeps that
 * detail out of every expectation.
 */
function patternOf(snippet: HSnippet): string {
  return snippet.regexp?.source ?? snippet.trigger;
}

function fileOf(snippets: EusnipsSnippet[], extra: Partial<EusnipsFile> = {}): EusnipsFile {
  return { version: EUSNIPS_VERSION, language: 'latex', snippets, ...extra };
}

/** A fresh engine with one managed file loaded, plus the adapter to drive it. */
function load(snippets: EusnipsSnippet[], extra: Partial<EusnipsFile> = {}) {
  const engine = new SnippetEngine();
  const normalized = normalizeSnippetFile(fileOf(snippets, extra));
  const loaded = loadEusnipsIntoEngine(engine, [normalized]);
  const adapter = new SnippetEditorAdapter({ engine });
  return { engine, loaded, normalized, adapter };
}

describe('projecting a snippet onto the engine', () => {
  it('carries the trigger, description and body across', () => {
    const { engine } = load([
      { id: 'ff', trigger: { pattern: 'ff' }, description: 'fraction', body: `${BACKSLASH}frac{$1}{$2}$0` }
    ]);
    const [snippet] = engine.getSnippets('latex');
    expect(patternOf(snippet)).toBe('ff$');
    expect(snippet.description).toBe('fraction');
    expect(snippet.sourceName).toBe('snippets.json#latex');
  });

  it('applies priority that the .hsnips header cannot express', () => {
    const { engine } = load([
      { trigger: { pattern: 'low' }, body: 'LOW' },
      { trigger: { pattern: 'high' }, body: 'HIGH', priority: 500 }
    ]);
    expect(engine.getSnippets('latex').map(patternOf)).toEqual(['high$', 'low$']);
  });

  it('applies the hidden flag', () => {
    const { engine } = load([{ trigger: { pattern: 'secret' }, body: 'S', hidden: true }]);
    expect(engine.getSnippets('latex')[0].hidden).toBe(true);
  });

  it('reads the language from the file, not from a file name', () => {
    const { engine } = load([{ trigger: { pattern: 'aa' }, body: 'AA' }], { language: 'bibtex' });
    expect(engine.getSnippets('bibtex').map(patternOf)).toEqual(['aa$']);
    expect(engine.getSnippets('latex')).toEqual([]);
  });

  it('treats `all` as global', () => {
    const { engine } = load([{ trigger: { pattern: 'aa' }, body: 'AA' }], { language: 'all' });
    expect(engine.getSnippets('latex').map(patternOf)).toEqual(['aa$']);
    expect(engine.getSnippets('markdown').map(patternOf)).toEqual(['aa$']);
  });

  it('leaves a disabled snippet out entirely', () => {
    const { engine } = load([
      { trigger: { pattern: 'on' }, body: 'ON' },
      { trigger: { pattern: 'off' }, body: 'OFF', enabled: false }
    ]);
    expect(engine.getSnippets('latex').map(patternOf)).toEqual(['on$']);
  });

  it('reports the snippets it actually loaded', () => {
    const { loaded } = load([
      { trigger: { pattern: 'ff' }, body: 'FF' },
      { trigger: { pattern: '' }, body: 'BROKEN' }
    ]);
    // An entry with no trigger has nothing to match and is not renderable, so it
    // is reported as not loaded rather than as a snippet with an empty trigger.
    expect(loaded.map((entry) => patternOf(entry.snippet))).toEqual(['ff$']);
  });
});

describe('flags that the typed properties imply', () => {
  it('maps boundary onto i, w and b', () => {
    const { engine } = load([
      { trigger: { pattern: 'inword' }, body: 'A', boundary: 'anywhere' },
      { trigger: { pattern: 'word' }, body: 'B', boundary: 'word' },
      { trigger: { pattern: 'line' }, body: 'C', boundary: 'line-start' },
      { trigger: { pattern: 'plain' }, body: 'D', boundary: 'whitespace' }
    ]);
    const byPattern = new Map(engine.getSnippets('latex').map((snippet) => [patternOf(snippet), snippet]));
    expect(byPattern.get('inword$')?.inword).toBe(true);
    expect(byPattern.get('word$')?.wordboundary).toBe(true);
    expect(byPattern.get('line$')?.beginningofline).toBe(true);
    expect(byPattern.get('plain$')).toMatchObject({ inword: false, wordboundary: false, beginningofline: false });
  });

  it('maps expand and hidden onto A and h', () => {
    const { engine } = load([{ trigger: { pattern: 'aa' }, body: 'AA', expand: 'auto', hidden: true }]);
    expect(engine.getSnippets('latex')[0]).toMatchObject({ automatic: true, hidden: true });
  });

  it('does not let a quote in the description forge a flag', () => {
    const { engine } = load([{ id: 'q', trigger: { pattern: 'q' }, description: 'x" A', body: 'Q' }]);
    // The projection escapes the quote, so the header is `snippet `q$` "x\" A"`.
    // Read with a plain `"([^"]+)"` that ended the description at the escaped
    // quote and took the ` A` behind it as the header's flags — which turned this
    // entry into one that expands while typing.
    expect(engine.getSnippets('latex')[0]).toMatchObject({ description: 'x" A', automatic: false });
  });

  it('keeps a backslash in a description', () => {
    const { engine } = load([{ id: 'd', trigger: { pattern: 'd' }, description: 'the \\dots command', body: 'D' }]);
    expect(engine.getSnippets('latex')[0].description).toBe('the \\dots command');
  });

  it('maps context onto m and n', () => {
    const { engine } = load([
      { trigger: { pattern: 'm' }, body: 'M', context: 'math' },
      { trigger: { pattern: 't' }, body: 'T', context: 'text' },
      { trigger: { pattern: 'a' }, body: 'A', context: 'any' }
    ]);
    const byPattern = new Map(engine.getSnippets('latex').map((snippet) => [patternOf(snippet), snippet]));
    expect(byPattern.get('m$')).toMatchObject({ math: true, nonmath: false });
    expect(byPattern.get('t$')).toMatchObject({ math: false, nonmath: true });
    expect(byPattern.get('a$')).toMatchObject({ math: false, nonmath: false });
  });

  it('reaches the engine as properties, not as header letters', () => {
    // Every switch the entry has a property for arrives on the compiled snippet,
    // which is what the matcher reads: `expand` is automatic, `boundary` is one of
    // the three boundary tests, `context` is the math/text filter, `multiline` and
    // `hidden` speak for themselves. The header used to be the transport — `Aim`
    // and friends — and the letters are gone from the format.
    const { engine, loaded } = load([
      {
        trigger: { pattern: 'ali' },
        body: 'A',
        expand: 'auto',
        boundary: 'line-start',
        context: 'math',
        multiline: true,
        hidden: true
      }
    ]);
    expect(engine.getSnippets('latex')[0]).toMatchObject({
      automatic: true,
      beginningofline: true,
      inword: false,
      wordboundary: false,
      math: true,
      nonmath: false,
      multiline: true,
      hidden: true
    });
    // The header itself carries the pattern and the description and nothing else.
    expect(loaded[0].sourceName).toBe('snippets.json#latex');
  });

  it('renders a header without the letters the engine does not need', () => {
    const rendered = renderSnippetDocument({
      id: 'ali',
      trigger: 'ali',
      regexFlags: '',
      description: 'align',
      priority: 100,
      expand: 'auto',
      boundary: 'anywhere',
      hidden: false,
      multiline: true,
      context: 'math',
      body: '\\begin{align}',
      tags: [],
      enabled: true,
      source: { trigger: { pattern: 'ali' }, body: 'x' }
    });
    // The trigger is backticked because it is a pattern, and the parser appends
    // the anchor, so the header says `ali$`.
    expect(rendered.document.split('\n')[0]).toBe('snippet `ali$` "align"');
    expect(rendered.problem).toBeUndefined();
  });
});

describe('regular expressions', () => {
  it('anchors the pattern the way the ported header parser does', () => {
    const { engine } = load([
      { trigger: { pattern: `(${BACKSLASH}${BACKSLASH}?[a-zA-Z]${BACKSLASH}w*)cal`, flags: 'm' }, body: `${BACKSLASH}mathcal{$1}$0` }
    ]);
    expect(engine.getSnippets('latex')[0].regexp?.source).toBe(
      `(${BACKSLASH}${BACKSLASH}?[a-zA-Z]${BACKSLASH}w*)cal$`
    );
  });

  it('leaves a pattern that is anchored already alone', () => {
    const { engine } = load([{ trigger: { pattern: 'a+b$' }, body: 'X' }]);
    expect(engine.getSnippets('latex')[0].regexp?.source).toBe('a+b$');
  });

  it('compiles the pattern with the flags the file stored', () => {
    // A header letter cannot mean a regex flag (`i` is in-word matching there),
    // so the flags travel beside the header and are put back when the pattern is
    // loaded. Without that they would be decoration.
    const { engine } = load([{ trigger: { pattern: 're' }, body: 'X' }]);
    const insensitive = load([{ trigger: { pattern: 're', flags: 'i' }, body: 'X' }]);
    expect(engine.getSnippets('latex')[0].regexp?.flags).not.toContain('i');
    expect(insensitive.engine.getSnippets('latex')[0].regexp?.flags).toContain('i');

    const text = 'RE';
    expect(engine.getCompletions({ text, offset: text.length, languageId: 'latex' })).toHaveLength(0);
    expect(insensitive.engine.getCompletions({ text, offset: text.length, languageId: 'latex' })).toHaveLength(1);
  });

  it('expands a pattern with capture groups accessed via m in code block', () => {
    // An in-word pattern, so a match may start anywhere in the token before the
    // cursor, plus `A` so the match is offered the moment it is complete.
    const { engine } = load([
      {
        id: 'mathcal',
        trigger: { pattern: `(${BACKSLASH}${BACKSLASH}?[a-zA-Z]${BACKSLASH}w*)cal`, flags: 'm' },
        description: 'mathcal',
        body: `${BACKSLASH}mathcal{\`\`rv = m[1]\`\`}$0`,
        boundary: 'anywhere',
        expand: 'auto'
      }
    ]);
    const editor = new TestEditor(`${BACKSLASH}alphacal`);
    const candidates = engine.getCompletions({
      text: editor.getText(),
      offset: editor.getOffset(),
      languageId: 'latex'
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].matchGroups[1]).toBe(`${BACKSLASH}alpha`);

    const expansion = engine.expand(candidates[0], { text: editor.getText(), pushToStack: false });
    expect(expansion.plainText).toBe(`${BACKSLASH}mathcal{${BACKSLASH}alpha}`);
  });

  it('matches a multi-line pattern only when the multiline flag is set', () => {
    // A multi-line trigger matches the previous lines *plus the current prefix*,
    // which is what lets a snippet reach an environment opened above the cursor.
    // The pattern ends where the cursor is, because that is where the prefix ends;
    // here the last word of the previous line and the prefix form the match.
    const text = 'body end\nprefixEND';
    const multi = load([
      {
        id: 'multi',
        trigger: { pattern: 'end\\nprefixEND' },
        body: 'MATCHED',
        multiline: true,
        expand: 'auto'
      }
    ]);
    const candidates = multi.engine.getCompletions({ text, offset: text.length, languageId: 'latex' });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].automatic).toBe(true);
    expect(multi.engine.expand(candidates[0], { text, pushToStack: false }).plainText).toBe('MATCHED');

    // Without the flag only the current line is searched, so the same document
    // does not match — which is the difference the flag is for.
    const single = load([
      {
        id: 'single',
        trigger: { pattern: 'end\\nprefixEND' },
        body: 'MATCHED',
        expand: 'auto'
      }
    ]);
    expect(single.engine.getCompletions({ text, offset: text.length, languageId: 'latex' })).toEqual([]);
  });

  it('holds a pattern to the boundary the snippet asked for', () => {
    // The boundary is what the old plain text trigger kind was really about, and
    // a pattern is held to it too: the same pattern and the same text get four
    // different answers, which is the whole point of the letters being in the
    // header.
    const matches = (boundary: EusnipsSnippet['boundary'], text: string): number =>
      load([{ id: 'ff', trigger: { pattern: 'ff' }, body: 'FRAC', boundary, expand: 'auto' }]).engine.getCompletions(
        { text, offset: text.length, languageId: 'latex' }
      ).length;

    // The whole token before the cursor: `ff` alone, not the tail of `staff`.
    expect(matches('whitespace', 'ff')).toBe(1);
    expect(matches('whitespace', 'staff')).toBe(0);
    expect(matches('whitespace', 'x ff')).toBe(1);
    // Anywhere: the tail of a word counts.
    expect(matches('anywhere', 'staff')).toBe(1);
    expect(matches('anywhere', 'ff')).toBe(1);
    // The whole word at the cursor.
    expect(matches('word', 'ff')).toBe(1);
    expect(matches('word', 'staff')).toBe(0);
    // ...and only whitespace may precede it on the line.
    expect(matches('line-start', 'ff')).toBe(1);
    expect(matches('line-start', '  ff')).toBe(1);
    expect(matches('line-start', 'x ff')).toBe(0);
  });

  it('defaults to anywhere boundary so triggers match inside or after words', () => {
    const { engine } = load([
      { id: 'ff', trigger: { pattern: 'ff' }, body: 'FRAC', expand: 'auto' },
      { id: 'haveh6', trigger: { pattern: '[^aeiou]lm ' }, body: 'LEMMA', expand: 'auto' }
    ]);
    expect(engine.getCompletions({ text: 'staff', offset: 5, languageId: 'latex' })).toHaveLength(1);
    expect(engine.getCompletions({ text: 'blm ', offset: 4, languageId: 'latex' })).toHaveLength(1);
    expect(engine.getCompletions({ text: 'alm ', offset: 4, languageId: 'latex' })).toHaveLength(0);
  });
});

describe('features the format expresses', () => {
  it('expands a code-block body', () => {
    const { engine } = load([
      { id: 'box', trigger: { pattern: 'box' }, body: '``rv = "top"``\n│ $1 │\n``rv = "bottom"``', expand: 'auto' }
    ]);
    const editor = new TestEditor('');
    const candidate = engine
      .getCompletions({ text: editor.getText(), offset: 0, languageId: 'latex' })
      .find((entry) => patternOf(entry.snippet) === 'box$');
    expect(candidate).toBeUndefined();
    // A trigger only matches a prefix, so type it and then expand.
    editor.type('box');
    const typed = engine
      .getCompletions({ text: editor.getText(), offset: editor.getOffset(), languageId: 'latex' })
      .find((entry) => patternOf(entry.snippet) === 'box$');
    expect(typed).toBeDefined();
    const expansion = engine.expand(typed!, { text: editor.getText(), pushToStack: false });
    expect(expansion.plainText).toBe('top\n│  │\nbottom');
  });

  it('does not run a code block when scripting is switched off', () => {
    const code = '``rv = "top"``\n│ $1 │\n``rv = "bottom"``';
    const { engine } = load([{ id: 'box', trigger: { pattern: 'box' }, body: code, expand: 'auto' }]);

    const expandOnce = () => {
      const editor = new TestEditor('box');
      const candidate = engine
        .getCompletions({ text: editor.getText(), offset: editor.getOffset(), languageId: 'latex' })
        .find((entry) => patternOf(entry.snippet) === 'box$');
      return engine.expand(candidate!, { text: editor.getText(), pushToStack: false }).plainText;
    };

    expect(expandOnce()).toBe('top\n│  │\nbottom');

    // The setting promises the code does not run. The expansion produces nothing
    // at all — a body's sections are built *by* its generator, so a generator that
    // refuses leaves no text to insert — and the reason reaches the author the
    // same way an uncompilable body's does.
    const warnings: string[] = [];
    engine.setWarningSink((message) => warnings.push(message));
    engine.setScriptingAllowedProvider(() => false);
    expect(expandOnce()).toBe('');
    expect(warnings.join('\n')).toContain('JavaScript in snippets is switched off');

    engine.setScriptingAllowedProvider(null);
    engine.setWarningSink(null);
    expect(expandOnce()).toBe('top\n│  │\nbottom');
  });

  it('gives the final cursor position to $0 and the first tab stop to $1', () => {
    const { engine } = load([
      { id: 'frac', trigger: { pattern: 'ff' }, body: `${BACKSLASH}frac{$1}{$2}$0` }
    ]);
    // The default boundary requires the pattern to have matched the whole run of
    // non-whitespace text before the cursor — so the document is the trigger and
    // nothing else.
    const editor = new TestEditor('ff');
    const all = engine.getCompletions({ text: editor.getText(), offset: editor.getOffset(), languageId: 'latex' });
    const candidate = all.find((entry) => patternOf(entry.snippet) === 'ff$');
    expect(candidate).toBeDefined();
    const expansion = engine.expand(candidate!, { text: editor.getText(), pushToStack: true });
    expect(expansion.plainText).toBe(`${BACKSLASH}frac{}{}`);
    expect(expansion.selectedPlaceholder).toBe(1);
    // `nextTabStop` reports the expansion that now owns the caret. It reaches the
    // last real tab stop first, and then `$0` — the move that *finishes* the
    // snippet. That move still has to say where the caret goes, and the expansion
    // leaves the stack as it does so, which is the reference's "finished" signal.
    expect(engine.nextTabStop()?.selectedPlaceholder).toBe(2);
    const finishing = engine.nextTabStop();
    expect(finishing?.selectedPlaceholder).toBe(0);
    expect(engine.stackDepth).toBe(0);
  });

  it('honours an explicit $0 as the last stop', () => {
    const { engine } = load([{ id: 'x', trigger: { pattern: 'xx' }, body: 'A$0B' }]);
    const editor = new TestEditor('xx');
    const candidate = engine
      .getCompletions({ text: editor.getText(), offset: editor.getOffset(), languageId: 'latex' })
      .find((entry) => patternOf(entry.snippet) === 'xx$');
    const expansion = engine.expand(candidate!, { text: editor.getText(), pushToStack: false });
    expect(expansion.plainText).toBe('AB');
    expect(expansion.parts.some((part) => part.id === 0)).toBe(true);
  });

  it('keeps a LaTeX line break intact through the projection', () => {
    const { engine } = load([
      {
        id: 'ali',
        trigger: { pattern: 'ali' },
        body: `${BACKSLASH}begin{align}\n\t$1 &= $2 ${DOUBLE_BACKSLASH}\n${BACKSLASH}end{align}$0`,
        boundary: 'anywhere'
      }
    ]);
    const editor = new TestEditor('ali');
    const candidate = engine
      .getCompletions({ text: editor.getText(), offset: editor.getOffset(), languageId: 'latex' })
      .find((entry) => patternOf(entry.snippet) === 'ali$');
    const expansion = engine.expand(candidate!, { text: editor.getText(), pushToStack: false });
    expect(expansion.plainText).toBe(
      `${BACKSLASH}begin{align}\n\t &=  ${DOUBLE_BACKSLASH}\n${BACKSLASH}end{align}`
    );
  });

  it('keeps an escaped dollar sign literal', () => {
    const { engine } = load([{ id: 'money', trigger: { pattern: 'money' }, body: `${BACKSLASH}$5 and $1` }]);
    const editor = new TestEditor('money');
    const candidate = engine
      .getCompletions({ text: editor.getText(), offset: editor.getOffset(), languageId: 'latex' })
      .find((entry) => patternOf(entry.snippet) === 'money$');
    const expansion = engine.expand(candidate!, { text: editor.getText(), pushToStack: false });
    expect(expansion.plainText).toBe('$5 and ');
  });

  it('auto-expands a snippet with the A flag on the keystroke that completes it', () => {
    // The full automatic path through the editor adapter, which is what an
    // editor actually calls.
    const { engine, adapter } = createHarness();
    loadEusnipsIntoEngine(engine, [
      normalizeSnippetFile(
        fileOf([
          {
            id: 'rr',
            trigger: { pattern: 'RR' },
            description: 'real numbers',
            body: `${BACKSLASH}mathbb{R}`,
            expand: 'auto',
            boundary: 'word'
          }
        ])
      )
    ]);
    const editor = new TestEditor(`${BACKSLASH}alpha `);
    editor.type('R');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('R'));
    expect(applied).not.toBeNull();
    expect(editor.getText()).toBe(`${BACKSLASH}alpha ${BACKSLASH}mathbb{R}`);
  });

  it('auto-expands a pattern that reaches back over a LaTeX command', () => {
    // The realistic case: `\alpha` then `bf` becomes `\mathbf{\alpha}`. The
    // pattern captures the command and the letters, and the boundary is
    // `anywhere` because the match is a suffix of the token rather than the whole
    // of it.
    const { engine, adapter } = createHarness();
    loadEusnipsIntoEngine(engine, [
      normalizeSnippetFile(
        fileOf([
          {
            id: 'bf',
            trigger: { pattern: `(${BACKSLASH}${BACKSLASH}?[a-zA-Z]${BACKSLASH}w*)bf` },
            body: `${BACKSLASH}mathbf{\`\`rv = m[1]\`\`}`,
            expand: 'auto',
            boundary: 'anywhere'
          }
        ])
      )
    ]);
    const editor = new TestEditor(`${BACKSLASH}alpha`);
    expect(adapter.handleDocumentChange(editor, editor.typeChar('b'))).toBeNull();
    expect(adapter.handleDocumentChange(editor, editor.typeChar('f'))).not.toBeNull();
    expect(editor.getText()).toBe(`${BACKSLASH}mathbf{${BACKSLASH}alpha}`);
  });

  it('does not auto-expand a math-only snippet outside mathematics', () => {
    const { engine, adapter } = createHarness();
    loadEusnipsIntoEngine(engine, [
      normalizeSnippetFile(
        fileOf([{ id: 'rr', trigger: { pattern: 'RR' }, body: 'MATH', expand: 'auto', context: 'math' }])
      )
    ]);
    const editor = new TestEditor('prose ');
    editor.type('R');
    expect(adapter.handleDocumentChange(editor, editor.typeChar('R'))).toBeNull();
    expect(editor.getText()).toBe('prose RR');
  });

  it('does not auto-expand a text-only snippet inside mathematics', () => {
    const { engine, adapter } = createHarness();
    loadEusnipsIntoEngine(engine, [
      normalizeSnippetFile(
        fileOf([{ id: 'txt', trigger: { pattern: 'TT' }, body: 'TEXT', expand: 'auto', context: 'text' }])
      )
    ]);
    const editor = new TestEditor('$');
    editor.type('T');
    expect(adapter.handleDocumentChange(editor, editor.typeChar('T'))).toBeNull();
    expect(editor.getText()).toBe('$TT');
  });

  it('keeps a hidden snippet out of the completion list but still offers it as a match', () => {
    const { engine } = load([
      { id: 'h', trigger: { pattern: 'hh' }, body: 'HIDDEN', hidden: true, expand: 'auto' }
    ]);
    const editor = new TestEditor('hh');
    const candidates = engine.getCompletions({
      text: editor.getText(),
      offset: editor.getOffset(),
      languageId: 'latex'
    });
    // An automatic snippet is reported through the `auto` channel even when it is
    // hidden; what hidden suppresses is the suggestion entry, which only exists
    // for a partial prefix anyway.
    expect(candidates).toHaveLength(1);
    expect(candidates[0].automatic).toBe(true);

    const manual = load([{ id: 'h2', trigger: { pattern: 'hh' }, body: 'HIDDEN', hidden: true }]);
    const manualEditor = new TestEditor('hh');
    expect(
      manual.engine.getCompletions({
        text: manualEditor.getText(),
        offset: manualEditor.getOffset(),
        languageId: 'latex'
      })
    ).toEqual([]);
  });
});

describe('projecting the structured body form', () => {
  it('expands structured nodes exactly like the text form', () => {
    const structured = load([
      {
        id: 's',
        trigger: { pattern: 'ff' },
        body: [
          { type: 'text', value: `${BACKSLASH}frac{` },
          { type: 'tabstop', index: 1 },
          { type: 'text', value: '}{' },
          { type: 'tabstop', index: 2 },
          { type: 'text', value: '}' },
          { type: 'tabstop', index: 0 }
        ]
      }
    ]);
    const asText = load([{ id: 's', trigger: { pattern: 'ff' }, body: `${BACKSLASH}frac{$1}{$2}$0` }]);

    const expanded = (engine: SnippetEngine) => {
      const editor = new TestEditor('ff');
      const all = engine.getCompletions({ text: editor.getText(), offset: editor.getOffset(), languageId: 'latex' });
      const candidate = all.find((entry) => patternOf(entry.snippet) === 'ff$');
      expect(candidate).toBeDefined();
      return engine.expand(candidate!, { text: editor.getText(), pushToStack: false });
    };

    const a = expanded(structured.engine);
    const b = expanded(asText.engine);
    expect(a.plainText).toBe(b.plainText);
    expect(a.plainText).toBe(`${BACKSLASH}frac{}{}`);
    expect(a.parts.filter((part) => part.id !== undefined).map((part) => part.id)).toEqual(
      b.parts.filter((part) => part.id !== undefined).map((part) => part.id)
    );
  });

  it('expands a structured javascript node', () => {
    const { engine } = load([
      {
        id: 'k',
        trigger: { pattern: 'kk' },
        body: [
          { type: 'text', value: 'result: ' },
          { type: 'javascript', code: 'rv = String(6 * 7)' }
        ]
      }
    ]);
    const editor = new TestEditor('kk');
    const candidate = engine
      .getCompletions({ text: editor.getText(), offset: editor.getOffset(), languageId: 'latex' })
      .find((entry) => patternOf(entry.snippet) === 'kk$');
    const expansion = engine.expand(candidate!, { text: editor.getText(), pushToStack: false });
    expect(expansion.plainText).toBe('result: 42');
  });

  it('expands a structured tab stop default and a selection default', () => {
    // Both are properties the schema names and the engine has a spelling for:
    // `${1:D}` gives the tab stop its initial text, and `${VISUAL:S}` is the
    // variable's own default, which is what is inserted with no selection. A
    // reader that dropped either would expand to something the file did not ask
    // for, which is what the projection used to do.
    const { engine } = load([
      {
        id: 'z',
        trigger: { pattern: 'zz' },
        body: [
          { type: 'text', value: 'val=' },
          { type: 'tabstop', index: 1, default: 'D' },
          { type: 'text', value: ' sel=' },
          { type: 'selection', default: 'S' },
          { type: 'tabstop', index: 0 }
        ]
      }
    ]);
    const editor = new TestEditor('zz');
    const candidate = engine
      .getCompletions({ text: editor.getText(), offset: editor.getOffset(), languageId: 'latex' })
      .find((entry) => patternOf(entry.snippet) === 'zz$');
    const expansion = engine.expand(candidate!, { text: editor.getText(), pushToStack: false });
    expect(expansion.plainText).toBe('val=D sel=S');
    expect(expansion.placeholderIds).toContain(1);
  });

  it('reports a substitution the engine preserves but does not apply', () => {
    // The substitution is written into the header and read back by the engine as
    // a mirror, which contributes no text: there is no live tab stop to
    // substitute in a plain-text buffer. It is reported rather than dropped,
    // because the file keeps it and the author should know what happens to it.
    const normalized = normalizeSnippetFile(
      fileOf([{ id: 's', trigger: { pattern: 'ss' }, body: 'x=${1/[0-9]+/N/}' }])
    );
    expect(normalized.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining('the engine preserves them but does not apply them')
    ]);

    const engine = new SnippetEngine();
    loadEusnipsIntoEngine(engine, [normalized]);
    const editor = new TestEditor('ss');
    const candidate = engine
      .getCompletions({ text: editor.getText(), offset: editor.getOffset(), languageId: 'latex' })
      .find((entry) => patternOf(entry.snippet) === 'ss$');
    expect(candidate).toBeDefined();
    // No text, and no leftover markup either — the expansion is not literal.
    expect(engine.expand(candidate!, { text: editor.getText(), pushToStack: false }).plainText).toBe('x=');
  });

  it('preserves $1 and $2 as tab stops when trigger has capture groups', () => {
    // Captured groups are accessed via m[1], m[2] in code blocks.
    // In body text, $1, $2, ... are always tab stops and are not replaced by regex match groups.
    const { engine } = load([
      {
        id: 'sp',
        trigger: { pattern: '(\\s*)\\$(\\s*);;' },
        body: ' $1\\$ $0',
        expand: 'auto',
        boundary: 'anywhere'
      }
    ]);

    const text = '$   $ ;;';
    const candidates = engine.getCompletions({ text, offset: text.length, languageId: 'latex' });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].matchGroups[1]).toBe('   ');

    const expansion = engine.expand(candidates[0], { text, pushToStack: false });
    // $1 is a tab stop (empty placeholder), not replaced by '   '.
    expect(expansion.plainText).toBe(' $ ');
    expect(expansion.placeholderIds).toEqual([1, 0]);
    expect(expansion.parts.map((part) => part.id)).toEqual([1, 0]);

    const geometry = engine.getGeometry(expansion);
    expect(geometry.selected.map((p) => p.id)).toEqual([1]);
  });

  it('accesses trigger capture groups via m in code blocks', () => {
    const { engine } = load([
      {
        id: 'bf',
        trigger: { pattern: '(\\\\?[a-zA-Z]\\w*)(bf)' },
        body: '\\mathbf{``rv = m[1]``}$0',
        expand: 'auto',
        boundary: 'anywhere'
      }
    ]);

    const text = '\\alphabf';
    const candidates = engine.getCompletions({ text, offset: text.length, languageId: 'latex' });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].matchGroups[1]).toBe('\\alpha');

    const expansion = engine.expand(candidates[0], { text, pushToStack: false });
    expect(expansion.plainText).toBe('\\mathbf{\\alpha}');
    expect(expansion.placeholderIds).toEqual([0]);
  });

  it('navigates to end of expansion on final tab when no explicit $0 is written', () => {
    const { engine } = load([
      {
        id: 'nozero',
        trigger: { pattern: '(\\s*)(sin) ' },
        body: '``\nrv = "\\\\" + m[2];\n``($1)\\$ ',
        expand: 'auto',
        boundary: 'anywhere'
      }
    ]);
    const adapter = new SnippetEditorAdapter({ engine });
    const editor = new TestEditor(' sin');
    adapter.handleDocumentChange(editor, editor.typeChar(' '));

    expect(editor.getText()).toBe('\\sin()$ ');
    expect(engine.activeExpansion!.selectedPlaceholder).toBe(1);

    const finalMove = adapter.nextTabStop(editor);
    expect(finalMove).not.toBeNull();
    expect(finalMove!.id).toBe(0);
    expect(finalMove!.from).toBe(editor.getText().length);
    expect(engine.stackDepth).toBe(0);
  });
});

describe('the file\'s own globals', () => {
  /**
   * The shape the imported unified library uses: a body that computes its text by
   * calling a helper the file declares once.
   */
  const GLOBALS = [
    'function openInlineMath(match, content = "") {',
    '  return match[1] ? content : match[2] + "\\\\$" + content;',
    '}'
  ].join('\n');

  it('puts the file\'s helpers in scope for a body\'s code block', () => {
    const { engine, loaded } = load(
      [
        {
          id: 'atom',
          // The pattern the reported entry uses: an optional `$`, whitespace, an
          // atom, and the delimiter that was typed to fire it.
          trigger: { pattern: '(\\$)?(?<!\\.|\\:)(\\s+)([A-Zb-z](\'*))([\\s\\-.,;])' },
          description: 'auto',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'text',
          // `rv` is the block's text; `openInlineMath` decides whether the math is
          // already open, and the second block re-emits the typed `;`.
          body: '``\nrv = openInlineMath(m, m[3]);\n``\\$``rv = m[5]``$0'
        }
      ],
      { globals: { javascript: GLOBALS } }
    );

    // The projection carries the globals into the document the engine parses; a
    // `global … endglobal` block is the only place the parser takes them from.
    expect(loaded[0].sourceName).toBe('snippets.json#latex');
    const document = renderSnippetDocument(
      normalizeSnippetFile(fileOf([{ trigger: { pattern: 'a' }, body: 'A' }])).snippets[0],
      globalsSource(GLOBALS)
    ).document;
    expect(document.startsWith('global\n')).toBe(true);
    expect(document).toContain('endglobal\nsnippet');

    const text = ' A;';
    const candidates = engine.getCompletions({ text, offset: text.length, languageId: 'latex' });
    expect(candidates).toHaveLength(1);
    const expansion = engine.expand(candidates[0], { text, pushToStack: false });
    // Before the globals were emitted this threw `openInlineMath is not defined`,
    // and a generator that throws inserts *nothing* — so the matched ` A;` was
    // deleted and the replacement never arrived.
    expect(expansion.plainText).toBe(' $A$;');
  });

  it('reports a body whose helper is still missing instead of inserting nothing', () => {
    const { engine } = load([
      {
        id: 'atom',
        trigger: { pattern: '(\\s+)([A-Zb-z])([\\s\\-.,;])' },
        description: 'auto',
        expand: 'auto',
        boundary: 'anywhere',
        body: '``rv = missingHelper(m);``$0'
      }
    ]);

    const warnings: string[] = [];
    engine.setWarningSink((message) => warnings.push(message));
    const text = ' A;';
    const candidates = engine.getCompletions({ text, offset: text.length, languageId: 'latex' });
    const expansion = engine.expand(candidates[0], { text, pushToStack: false });

    expect(expansion.plainText).toBe('');
    expect(warnings.join('\n')).toContain('missingHelper is not defined');
  });
});

describe('project sources alongside a project folder', () => {
  it('appends a project source without discarding the managed library', () => {
    const { engine } = createHarness();
    loadEusnipsIntoEngine(engine, [
      normalizeSnippetFile(fileOf([{ id: 'mine', trigger: { pattern: 'mine' }, body: 'MINE' }]))
    ]);
    engine.addSnippetSources([
      { name: '/project/snips/project.hsnips', content: 'snippet theirs "theirs" A\nTHEIRS\nendsnippet\n', language: 'latex' }
    ]);
    const patterns = new Set(engine.getSnippets('latex').map(patternOf));
    expect(patterns.has('mine$')).toBe(true);
    expect(patterns.has('theirs')).toBe(true);
  });

  it('lets a project source outrank the library on priority', () => {
    const { engine } = createHarness();
    loadEusnipsIntoEngine(engine, [
      normalizeSnippetFile(fileOf([{ id: 'mine', trigger: { pattern: 'ff' }, body: 'MINE', priority: 10 }]))
    ]);
    engine.addSnippetSources([
      { name: '/project/snips/p.hsnips', content: 'priority 900\nsnippet ff "theirs" A\nTHEIRS\nendsnippet\n', language: 'latex' }
    ]);
    expect(engine.getSnippets('latex').map((snippet) => snippet.sourceName)).toEqual([
      '/project/snips/p.hsnips',
      'snippets.json#latex'
    ]);
  });

  it('resets everything when the library is loaded again', () => {
    const { engine } = load([{ id: 'a', trigger: { pattern: 'aa' }, body: 'AA' }]);
    engine.addSnippetSources([{ name: 'x.hsnips', content: 'snippet bb "b" A\nBB\nendsnippet\n', language: 'latex' }]);
    expect(engine.getSnippets('latex')).toHaveLength(2);

    loadEusnipsIntoEngine(engine, [
      normalizeSnippetFile(fileOf([{ id: 'c', trigger: { pattern: 'cc' }, body: 'CC' }]))
    ]);
    expect(engine.getSnippets('latex').map(patternOf)).toEqual(['cc$']);
  });

  it('clears the engine when the library has nothing to load', () => {
    const { engine } = load([{ id: 'a', trigger: { pattern: 'aa' }, body: 'AA' }]);
    loadEusnipsIntoEngine(engine, []);
    expect(engine.getSnippets('latex')).toEqual([]);
  });
});

describe('the rendered .hsnips header', () => {
  it('writes a code node as a code block, exactly like the text form', () => {
    expect(
      renderSnippetDocument(effectiveOf({ trigger: { pattern: 'x' }, body: [{ type: 'javascript', code: 'rv = 1' }] }))
        .document
    ).toBe('snippet `x$`\n``rv = 1``\nendsnippet\n');
  });

  it('reports a trigger a HyperSnips header cannot hold', () => {
    const rendered = renderSnippetDocument(effectiveOf({ trigger: { pattern: 'a`b' }, body: 'X' }));
    expect(rendered.problem).toContain('backtick');
  });
});

/** The effective form of one snippet, for the renderer's own tests. */
function effectiveOf(snippet: EusnipsSnippet) {
  return normalizeSnippetFile(fileOf([snippet])).snippets[0];
}

describe('nested tab stops and placeholders', () => {
  it('advances from parent placeholder to nested placeholder', () => {
    const { adapter, engine } = load([
      { id: 'nest', trigger: { pattern: 'nest' }, body: 'foo ${1:($2)} bar', expand: 'auto' }
    ]);
    const editor = new TestEditor('');
    editor.type('nes');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('t'));

    expect(applied).not.toBeNull();
    expect(editor.getText()).toBe('foo () bar');
    expect(applied!.selected.map((p) => p.id)).toEqual([1]);
    expect(applied!.selected[0].to - applied!.selected[0].from).toBe(2);

    // Tab -> advances to $2 between '(' and ')'
    const move1 = adapter.nextTabStop(editor);
    expect(move1).not.toBeNull();
    expect(move1!.id).toBe(2);
    expect(editor.cursor).toBe(5);
    expect(editor.getText()).toBe('foo () bar');

    // Type 'x' into $2
    const edit = editor.replaceRange(5, 5, 'x');
    adapter.handleEdit(editor, edit);
    expect(editor.getText()).toBe('foo (x) bar');

    // Tab -> finishes at $0 (end of expansion)
    const move2 = adapter.nextTabStop(editor);
    expect(move2).not.toBeNull();
    expect(move2!.id).toBe(0);
    expect(engine.stackDepth).toBe(0);
    expect(editor.cursor).toBe('foo (x) bar'.length);
  });

  it('drops nested placeholders when parent placeholder is directly overwritten', () => {
    const { adapter, engine } = load([
      { id: 'nest', trigger: { pattern: 'nest' }, body: 'foo ${1:($2)} bar', expand: 'auto' }
    ]);
    const editor = new TestEditor('');
    editor.type('nes');
    adapter.handleDocumentChange(editor, editor.typeChar('t'));
    expect(editor.getText()).toBe('foo () bar');

    // Overwrite parent $1 (offset 4 to 6)
    const edit = editor.replaceRange(4, 6, 'baz');
    adapter.handleEdit(editor, edit);
    expect(editor.getText()).toBe('foo baz bar');

    // Tab jumps directly to $0, bypassing dropped child $2
    const move = adapter.nextTabStop(editor);
    expect(move).not.toBeNull();
    expect(move!.id).toBe(0);
    expect(engine.stackDepth).toBe(0);
  });

  it('handles multiple nested placeholders like ${1:f($2, $3)}', () => {
    const { adapter, engine } = load([
      { id: 'fn', trigger: { pattern: 'fn' }, body: '${1:f($2, $3)}$0', expand: 'auto' }
    ]);
    const editor = new TestEditor('');
    editor.type('f');
    adapter.handleDocumentChange(editor, editor.typeChar('n'));
    expect(editor.getText()).toBe('f(, )');

    // Tab -> $2 (inside parentheses before comma)
    const move1 = adapter.nextTabStop(editor);
    expect(move1!.id).toBe(2);
    expect(editor.cursor).toBe(2);

    // Type 'a' into $2
    const edit1 = editor.replaceRange(editor.cursor, editor.cursor, 'a');
    adapter.handleEdit(editor, edit1);
    expect(editor.getText()).toBe('f(a, )');

    // Tab -> $3 (after comma and space)
    const move2 = adapter.nextTabStop(editor);
    expect(move2!.id).toBe(3);
    expect(editor.cursor).toBe(5);

    // Type 'b' into $3
    const edit2 = editor.replaceRange(editor.cursor, editor.cursor, 'b');
    adapter.handleEdit(editor, edit2);
    expect(editor.getText()).toBe('f(a, b)');

    // Tab -> $0
    const move3 = adapter.nextTabStop(editor);
    expect(move3!.id).toBe(0);
    expect(engine.stackDepth).toBe(0);
    expect(editor.cursor).toBe('f(a, b)'.length);
  });

  it('handles nested placeholders with escaped braces like ${1:_{$2\\}^{$3\\}}', () => {
    const { adapter, engine } = load([
      { id: 'subsup', trigger: { pattern: 'ss' }, body: '${1:_{$2\\}^{$3\\}}$0', expand: 'auto' }
    ]);
    const editor = new TestEditor('');
    editor.type('s');
    adapter.handleDocumentChange(editor, editor.typeChar('s'));
    expect(editor.getText()).toBe('_{}^{}');

    // Tab -> $2
    const move1 = adapter.nextTabStop(editor);
    expect(move1!.id).toBe(2);
    expect(editor.cursor).toBe(2);

    // Type 'i' into $2
    const edit1 = editor.replaceRange(editor.cursor, editor.cursor, 'i');
    adapter.handleEdit(editor, edit1);
    expect(editor.getText()).toBe('_{i}^{}');

    // Tab -> $3
    const move2 = adapter.nextTabStop(editor);
    expect(move2!.id).toBe(3);
    expect(editor.cursor).toBe(6);

    // Type '2' into $3
    const edit2 = editor.replaceRange(editor.cursor, editor.cursor, '2');
    adapter.handleEdit(editor, edit2);
    expect(editor.getText()).toBe('_{i}^{2}');

    // Tab -> $0
    const move3 = adapter.nextTabStop(editor);
    expect(move3!.id).toBe(0);
    expect(engine.stackDepth).toBe(0);
    expect(editor.cursor).toBe('_{i}^{2}'.length);
  });

  it('replicates snippet ws6qtr with code blocks and nested tabstop', () => {
    const { adapter, engine } = load([
      {
        id: 'ws6qtr',
        trigger: {
          pattern: '(\\$)?(?<!\\.)(\\s*(?:,|\\s))(?<!\\\\)(sin|cos) '
        },
        body: '``\nrv = m[1] ? "" : "$";\n``\\``rv = m[3]`` ${1:($2)}\\$ ',
        expand: 'auto',
        boundary: 'anywhere',
        context: 'text'
      }
    ]);
    const editor = new TestEditor('prefix');
    for (const char of ' sin ') {
      adapter.handleDocumentChange(editor, editor.typeChar(char));
    }
    // Prefix + expansion:
    // prefix$\sin ()$ 
    expect(editor.getText()).toBe('prefix$\\sin ()$ ');

    // Tab -> $2
    const move1 = adapter.nextTabStop(editor);
    expect(move1!.id).toBe(2);
    expect(editor.cursor).toBe('prefix$\\sin ('.length);

    // Type 'x' into $2
    const edit = editor.replaceRange(editor.cursor, editor.cursor, 'x');
    adapter.handleEdit(editor, edit);
    expect(editor.getText()).toBe('prefix$\\sin (x)$ ');

    // Tab -> $0 (after '$ ')
    const move2 = adapter.nextTabStop(editor);
    expect(move2!.id).toBe(0);
    expect(engine.stackDepth).toBe(0);
    expect(editor.cursor).toBe('prefix$\\sin (x)$ '.length);
  });
});

