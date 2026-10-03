/**
 * What snippet code can reach.
 *
 * A snippet body is code the user did not write — a library entry, an imported
 * `.hsnips` file, a file in the project's `snips/` folder — and it runs inside the
 * renderer process. The evaluator is therefore built so the page's globals and the
 * Node-ish ones are *lexical bindings that throw* rather than reachable values
 * (`Instructions.md` §68).
 *
 * That property is easy to lose without noticing, and it was lost: the evaluator
 * reached `eval` through a parameter, which the language specification makes an
 * **indirect** eval, so it ran in the global scope where none of the shadowing
 * bindings exist. `typeof process` answered `object` and `process.version`
 * answered a version string. These tests pin the property from the outside, which
 * is the only place it can be seen.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '../../src/renderer/vendor/hypersnips';

/** The text a one-snippet file's code block produces. */
function run(code: string): string {
  const source = ['snippet `zz$` "probe" A', '``' + code + '``', 'endsnippet', ''].join('\n');
  const [snippet] = parse(source, 'probe.hsnips');
  const [texts, blocks] = snippet.generator(undefined, [], [], '', '');
  // A code block contributes a `{block}` place in the text and its value in the
  // parallel array, which is what the expansion substitutes.
  return blocks.map(String).join('') || texts.map((entry) => (typeof entry === 'string' ? entry : '')).join('');
}

describe('snippet code runs in a restricted scope', () => {
  const blocked = [
    'window',
    'document',
    'globalThis',
    'process',
    'require',
    'Function',
    'fetch',
    'localStorage',
    'setTimeout',
    'navigator',
    'location'
  ];

  for (const name of blocked) {
    it(`cannot use \`${name}\``, () => {
      // The name is *bound* — the shadow is what keeps the real global out of
      // reach — but nothing can be read out of it: a property read, a call or a
      // construction all throw.
      const result = run(
        `try { rv = String(${name}.anything); } catch (error) { rv = 'blocked:' + error.constructor.name; }`
      );
      expect(result).toBe('blocked:ReferenceError');
    });
  }

  it('cannot reach the realm through `this` or an indirect eval', () => {
    // A plain function call in sloppy mode gets the global object as `this`; the
    // shadowing parameters do not change that, so this documents what the scope
    // restriction does and does not cover.
    expect(run(`rv = (function () { return this === undefined ? 'undefined' : typeof this; })();`)).toBe('object');
    // `Function` is a blocked binding, so the classic escape is dead too.
    expect(run(`try { rv = Function('return typeof process')(); } catch (e) { rv = 'blocked'; }`)).toBe('blocked');
    expect(run(`try { rv = String(process.version); } catch (e) { rv = 'blocked'; }`)).toBe('blocked');
  });

  it('still computes, and still sees the file\'s global block', () => {
    const source = [
      'global',
      'function twice(value) { return value * 2; }',
      'endglobal',
      '',
      'snippet `zz$` "probe" A',
      '``rv = String(twice(21))``',
      'endsnippet',
      ''
    ].join('\n');
    const [snippet] = parse(source, 'probe.hsnips');
    const [, blocks] = snippet.generator(undefined, [], [], '', '');
    expect(blocks.join('')).toBe('42');
  });
});

describe('a snippet body that cannot be compiled', () => {
  it('costs that snippet and nothing else', () => {
    // LaTeX's `` `` `` quote reads as a code fence, so this body is not valid
    // JavaScript — and because a fence that is never closed runs to the end of the
    // file, the unparseable entry has to be the last one for the file's other
    // entries to exist at all.
    const source = [
      'snippet `bb$` "fine" A',
      '``rv = "ok"``',
      'endsnippet',
      '',
      'snippet `aa$` "quoted" A',
      '\\text{``quoted\'\'}',
      'endsnippet',
      ''
    ].join('\n');

    const parsed = parse(source, 'probe.hsnips');
    expect(parsed).toHaveLength(2);

    // The good one is unaffected…
    const [, good] = parsed[0].generator(undefined, [], [], '', '');
    expect(good.join('')).toBe('ok');

    // …and the bad one reports why when it is asked to expand, rather than
    // throwing out of `parse` — which used to take the whole library, and the
    // editor's keystroke, with it.
    expect(() => parsed[1].generator(undefined, [], [], '', '')).toThrow(/could not be compiled/);
  });
});
