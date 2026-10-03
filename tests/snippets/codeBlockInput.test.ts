/**
 * What a code block is handed in `t`.
 *
 * `t[i]` is the text of the i-th tab stop, in document order, with the defaults
 * the body wrote. It used to disagree with itself: the first expansion passed an
 * array sized by a counter that only recognised `$1` and `${1}` — so a body using
 * `${1:default}` or `${1|a,b|}`, which is what the editor produces for every
 * snippet, reported *no* placeholders — while a later regeneration passed one
 * entry per tab stop. A code block written against `t[0]` therefore read
 * `undefined` on the first expansion and a real value afterwards.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '../../src/renderer/vendor/hypersnips';
import { SnippetEngine } from '../../src/renderer/snippets/engine';
import { loadEusnipsIntoEngine, normalizeSnippetFile } from '../../src/renderer/snippets/eusnips';
import { createStringDocument } from '../../src/renderer/snippets/documentAdapter';
import { getCompletions } from '../../src/renderer/vendor/hypersnips/completion';
import { positionFromOffset } from '../../src/renderer/snippets/engine';

/** Expands one entry against `typed` and returns the inserted text. */
function expand(body: string, typed: string): string {
  const engine = new SnippetEngine();
  loadEusnipsIntoEngine(engine, [
    normalizeSnippetFile({
      version: 1,
      language: 'latex',
      snippets: [{ id: 'probe', trigger: { pattern: 'X' }, body, expand: 'auto' }]
    })
  ]);
  const doc = createStringDocument(typed, 'latex');
  const position = positionFromOffset(typed, typed.length);
  const { auto } = getCompletions(createTextDocumentAdapter(doc), position, engine.getSnippets('latex'));
  if (auto.length === 0) return '';
  const candidate = {
    snippet: auto[0].snippet,
    range: auto[0].range,
    matchGroups: auto[0].groups,
    label: auto[0].label,
    automatic: true,
    source: auto[0]
  };
  return engine.expand(candidate as never, { text: typed, pushToStack: false }).plainText;
}

// The helper is imported separately to keep the imports above readable.
import { createTextDocumentAdapter } from '../../src/renderer/snippets/documentAdapter';

describe('the tab stops a code block sees', () => {
  it('counts every form of placeholder, with its default', () => {
    const source = [
      'snippet `zz$` "probe" A',
      'A ${1:one} B ${2|two,three|} C $3',
      '``rv = "len=" + t.length + " t0=" + t[0] + " t1=" + t[1] + " t2=" + t[2]``',
      'endsnippet',
      ''
    ].join('\n');
    const [snippet] = parse(source, 'probe.hsnips');
    const [, blocks] = snippet.generator(undefined, ['one', 'two', ''], [], '', '');
    expect(blocks.join('')).toBe('len=3 t0=one t1=two t2=');
  });

  it('hands the first expansion the same placeholders a later one gets', () => {
    const body = 'A ${1:one} B ${2|two,three|} C $3\n``rv = "len=" + t.length + " t0=" + t[0]``';
    expect(expand(body, 'X')).toContain('len=3 t0=one');
  });

  it('leaves `t` empty for a body with no tab stops', () => {
    const source = ['snippet `zz$` "probe" A', 'plain $0', '``rv = "len=" + t.length``', 'endsnippet', ''].join('\n');
    const [snippet] = parse(source, 'probe.hsnips');
    // `$0` is the final cursor, not a tab stop the author fills in: the parser
    // counts it (it is a placeholder) but the value is empty, as it is later.
    const [, blocks] = snippet.generator(undefined, [''], [], '', '');
    expect(blocks.join('')).toBe('len=1');
  });
});
