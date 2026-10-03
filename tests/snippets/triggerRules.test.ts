/**
 * Three rules about a trigger's *pattern* that the format documents, and that the
 * engine got wrong.
 *
 *  * `\$` at the end of a pattern is a literal dollar, not the header's anchor —
 *    reading it as anchored left an inline-mathematics pattern matching with no
 *    anchor, and the match's range ends at the caret, so it deleted what followed.
 *  * `g` and `y` keep a `lastIndex`, and the engine asks one compiled pattern about
 *    a new caret on every keystroke, so such a snippet fired on every other one.
 *  * the `word` boundary has to be satisfiable for a pattern that begins with
 *    punctuation, which every LaTeX trigger does (`\alpha` starts one character
 *    before the word `alpha`).
 */

import { describe, expect, it } from 'vitest';
import { anchorPattern, isAnchored } from '../../src/renderer/snippets/eusnips/hsnips';
import { loadEusnipsIntoEngine, normalizeSnippetFile } from '../../src/renderer/snippets/eusnips';
import { applyRegexFlags } from '../../src/renderer/snippets/eusnips';
import { parse } from '../../src/renderer/vendor/hypersnips';
import { SnippetEngine } from '../../src/renderer/snippets/engine';

function engineWith(snippets: Array<Record<string, unknown>>) {
  const engine = new SnippetEngine();
  loadEusnipsIntoEngine(engine, [
    normalizeSnippetFile({ version: 1, language: 'latex', snippets: snippets as never })
  ]);
  return engine;
}

const matches = (engine: SnippetEngine, text: string): number =>
  engine.getCompletions({ text, offset: text.length, languageId: 'latex' }).length;

describe('an escaped dollar is not the anchor', () => {
  it('tells an anchor from a literal `$`', () => {
    expect(isAnchored('ff$')).toBe(true);
    expect(isAnchored('ff')).toBe(false);
    expect(isAnchored('\\$')).toBe(false);
    expect(isAnchored('\\$[^$]*\\$')).toBe(false);
    // An escaped backslash followed by the anchor is anchored.
    expect(isAnchored('\\\\$')).toBe(true);
    expect(anchorPattern('\\$[^$]*\\$')).toBe('\\$[^$]*\\$$');
    expect(anchorPattern('ff$')).toBe('ff$');
  });

  it('does not swallow the text after an inline-mathematics match', () => {
    const engine = engineWith([
      { id: 'math', trigger: { pattern: '\\$[^$]*\\$' }, body: 'MATH($0)', expand: 'auto', boundary: 'anywhere' }
    ]);
    // `$x$y` ends in `y`: the anchored pattern `\$[^$]*\$$` cannot match it, so
    // nothing fires and — the point — nothing is deleted.
    expect(matches(engine, '$x$y')).toBe(0);
    // The pattern itself still matches when the text really ends with it.
    expect(matches(engine, 'a $x$')).toBe(1);
  });
});

describe('stateful flags', () => {
  it('drops `g` and `y` when the pattern is compiled, and says so', () => {
    const normalized = normalizeSnippetFile({
      version: 1,
      language: 'latex',
      snippets: [{ id: 'x', trigger: { pattern: 're', flags: 'gm' }, body: 'X' }]
    });
    expect(normalized.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining('"g" and "y" flags are stateful')
    ]);

    const [snippet] = parse('snippet `re$`\nX\nendsnippet\n', 'probe.hsnips');
    applyRegexFlags(snippet, 'gm');
    expect(snippet.regexp?.flags).not.toContain('g');
    expect(snippet.regexp?.flags).toContain('m');
  });

  it('fires on every keystroke rather than every other one', () => {
    const engine = engineWith([
      { id: 're', trigger: { pattern: '\\alpha', flags: 'g' }, body: 'A', expand: 'auto', boundary: 'anywhere' }
    ]);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(matches(engine, '\\alpha'), `attempt ${attempt}`).toBe(1);
    }
  });
});

describe('the word boundary with a LaTeX trigger', () => {
  it('accepts the punctuation glued to the word, and refuses a tail of one', () => {
    const engine = engineWith([
      { id: 'alpha', trigger: { pattern: '\\alpha' }, body: 'A', expand: 'auto', boundary: 'word' }
    ]);
    // `\alpha` is the word `alpha` with its backslash.
    expect(matches(engine, '\\alpha')).toBe(1);
    expect(matches(engine, 'x \\alpha')).toBe(1);
    // A pattern that is only the *tail* of a word is still not a whole word.
    const tail = engineWith([
      { id: 'ff', trigger: { pattern: 'ff' }, body: 'F', expand: 'auto', boundary: 'word' }
    ]);
    expect(matches(tail, 'ff')).toBe(1);
    expect(matches(tail, 'staff')).toBe(0);
  });
});
