/**
 * tex-aligner port tests.
 *
 * Expectations were derived by running the reference implementation
 * (`References/tex-aligner/src/extension.ts`, `formatTex`) directly, not by
 * guessing: the reference joins cells with `' & '`, so `a &= b` becomes
 * `a   & = b \\` — the space after `&` is part of its output and is preserved
 * here deliberately.
 */

import { describe, expect, it } from 'vitest';
import { TexAligner, DEFAULT_TARGET_ENVIRONMENTS, applyAlignEdits } from '../../src/renderer/vendor/tex-aligner/aligner';

const aligner = new TexAligner();

const block = (...lines: string[]): string => lines.join('\n');

describe('TexAligner.formatEnvironment', () => {
  it('pads cells so the ampersands line up', () => {
    const input = block('\\begin{align}', 'a &= b \\\\', 'abc &= d', '\\end{align}');
    expect(aligner.formatEnvironment(input)).toBe(
      block('\\begin{align}', 'a   & = b \\\\', 'abc & = d', '\\end{align}')
    );
  });

  it('preserves comments and delimiter lines verbatim', () => {
    const input = block('\\begin{align}', '% a comment', 'x &= 1 \\\\', 'y &= 2', '\\end{align}');
    const output = aligner.formatEnvironment(input);

    expect(output).toContain('% a comment');
    expect(output.split('\n')[1]).toBe('% a comment');
    // The comment is raw, so the two data rows keep their own line terminator
    // rules: the first gets `\\`, the last does not.
    expect(output).toContain('x & = 1 \\\\');
    expect(output.split('\n')[3]).toBe('y & = 2');
  });

  it('drops a trailing row terminator on the last data row, as the reference does', () => {
    // Reference quirk kept deliberately: a `\\` on the final data row is removed
    // because the row terminator is regenerated only when another row follows.
    const input = block('\\begin{align}', '% only a comment then one row', 'x &= 1 \\\\', '\\end{align}');
    expect(aligner.formatEnvironment(input).split('\n')[2]).toBe('x & = 1');
  });

  it('re-attaches \\hline after the row terminator', () => {
    const input = block('\\begin{tabular}{cc}', 'a & b \\\\ \\hline', 'cc & d \\\\', '\\end{tabular}');
    const output = aligner.formatEnvironment(input);

    expect(output).toContain('a  & b \\\\ \\hline');
  });

  it('normalises indentation to the shallowest data row', () => {
    const input = block('\\begin{align}', '    a &= 1 \\\\', '  bb &= 2', '\\end{align}');
    const output = aligner.formatEnvironment(input).split('\n');

    expect(output[1]).toBe('  a  & = 1 \\\\');
    expect(output[2]).toBe('  bb & = 2');
  });

  it('keeps an escaped ampersand inside one cell', () => {
    const input = block('\\begin{align}', 'a \\& b &= c', '\\end{align}');
    expect(aligner.formatEnvironment(input)).toBe(block('\\begin{align}', 'a \\& b & = c', '\\end{align}'));
  });

  it('does not append a row terminator to the final row', () => {
    const input = block('\\begin{align}', 'a &= 1 \\\\', 'b &= 2', '\\end{align}');
    const output = aligner.formatEnvironment(input).split('\n');

    expect(output[2]).toBe('b & = 2');
  });

  it('is idempotent: aligning an aligned block changes nothing', () => {
    const input = block('\\begin{align}', 'a &= b \\\\', 'abc &= d', '\\end{align}');
    const once = aligner.formatEnvironment(input);
    const twice = aligner.formatEnvironment(once);

    expect(twice).toBe(once);
  });
});

describe('TexAligner.computeEdits', () => {
  it('returns one edit per outermost target environment', () => {
    const text = block(
      '\\begin{align}',
      'a &= 1 \\\\',
      'bb &= 2',
      '\\end{align}',
      '',
      'text',
      '',
      '\\begin{align}',
      'c &= 3',
      '\\end{align}'
    );

    const edits = aligner.computeEdits(text);
    expect(edits).toHaveLength(2);

    const applied = applyAlignEdits(text, edits);
    expect(applied).toContain('a  & = 1 \\\\');
    expect(applied).toContain('bb & = 2');
    expect(applied).toContain('c & = 3');
  });

  it('skips a target environment nested inside another target environment', () => {
    const text = block('\\begin{align}', '\\begin{aligned}', 'a &= 1', '\\end{aligned}', '\\end{align}');

    const edits = aligner.computeEdits(text);
    // Only the outer `align` block is aligned; the inner `aligned` is left to it.
    expect(edits).toHaveLength(1);
    expect(text.slice(edits[0].start, edits[0].end)).toContain('\\begin{aligned}');
  });

  it('ignores environments that are not in the target list', () => {
    const text = block('\\begin{figure}', 'a &= 1', '\\end{figure}');
    expect(aligner.computeEdits(text)).toHaveLength(0);
  });

  it('reports absolute offsets when a base offset is supplied', () => {
    const inner = block('\\begin{align}', 'a &= 1', '\\end{align}');
    const document = `% header\n${inner}`;
    const edits = aligner.computeEdits(inner, '% header\n'.length);

    expect(edits).toHaveLength(1);
    expect(edits[0].start).toBe('% header\n'.length);
    expect(document.slice(edits[0].start, edits[0].end)).toBe(inner);
  });

  it('produces no edit when the block is already aligned', () => {
    const aligned = aligner.formatEnvironment(block('\\begin{align}', 'a &= 1 \\\\', 'bb &= 2', '\\end{align}'));
    expect(aligner.computeEdits(aligned)).toHaveLength(0);
  });

  it('honours a narrowed environment list', () => {
    const narrow = new TexAligner({ environments: ['align'] });
    const text = block('\\begin{tabular}{cc}', 'a & b', '\\end{tabular}');
    expect(narrow.computeEdits(text)).toHaveLength(0);
  });

  it('pads around the ampersand when asked', () => {
    const wide = new TexAligner({ ampersandPadding: 3 });
    const input = block('\\begin{align}', 'a &= 1 \\\\', 'bb &= 2', '\\end{align}');

    expect(wide.formatEnvironment(input).split('\n')[1]).toBe('a    &   = 1 \\\\');
  });

  it('does not throw on a stray \\end with no matching \\begin', () => {
    const text = block('\\end{align}', 'a &= 1');
    expect(() => aligner.computeEdits(text)).not.toThrow();
    expect(aligner.computeEdits(text)).toHaveLength(0);
  });
});

describe('applyAlignEdits', () => {
  it('applies edits back-to-front so offsets stay valid', () => {
    const text = 'aaaa bbbb cccc';
    const result = applyAlignEdits(text, [
      { start: 0, end: 4, newText: 'XX' },
      { start: 10, end: 14, newText: 'Y' }
    ]);
    expect(result).toBe('XX bbbb Y');
  });

  it('returns the input unchanged for an empty edit list', () => {
    expect(applyAlignEdits('unchanged', [])).toBe('unchanged');
  });
});

describe('DEFAULT_TARGET_ENVIRONMENTS', () => {
  it('matches the reference default list exactly', () => {
    expect([...DEFAULT_TARGET_ENVIRONMENTS]).toEqual([
      'align',
      'align*',
      'aligned',
      'matrix',
      'pmatrix',
      'pmatrix*',
      'bmatrix',
      'bmatrix*',
      'vmatrix',
      'vmatrix*',
      'Vmatrix',
      'Vmatrix*',
      'Bmatrix',
      'Bmatrix*',
      'array',
      'array*',
      'tabular',
      'tikzcd',
      'case',
      'alignedat'
    ]);
  });
});
