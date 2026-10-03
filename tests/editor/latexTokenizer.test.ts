/**
 * The LaTeX scanner that does not need an editor.
 *
 * `latexLanguage.ts` keeps a plain, state-free scanner (`tokenizeLatex`) for
 * surfaces that do not run the Lezer parser — a diff view, an outline preview, a
 * test. It used to be tested through Monaco's Monarch tokenizer, which was the
 * editor's colouring; that went with Monaco, and this is the scanner that
 * remains, so the same representative LaTeX is run through it.
 *
 * Two properties matter and are asserted for every sample: the scan consumes the
 * input exactly once, in order (so nothing is dropped or duplicated), and the
 * classifications it does make are the ones the tables in `latexLanguage.ts`
 * describe. It is deliberately *not* a parser — it has no math or verbatim state,
 * so a token inside `$...$` is classified by the same rules as one outside it.
 */

import { describe, expect, it } from 'vitest';
import { tokenizeLatex, type LatexToken } from '../../src/renderer/editor/latexLanguage';

const SAMPLES = [
  '\\documentclass[11pt,a4paper]{article}',
  '\\usepackage{amsmath,amssymb}',
  '\\newcommand{\\R}{\\mathbb{R}}',
  '\\renewcommand\\baselinestretch{1.2}',
  '\\DeclareMathOperator{\\Hom}{Hom}',
  '\\def\\foo#1{#1}',
  '\\begin{align}',
  '\\end{align}',
  '\\label{eq:one} See \\ref{eq:one} and \\eqref{eq:two}.',
  '\\cite[see][p. 3]{knuth1984} and \\citep{a,b}',
  '\\input{chapters/intro}',
  '\\include{chapter1}',
  '\\includegraphics[width=0.5\\textwidth]{figures/plot.pdf}',
  'Inline $x^2 + y^2 = z^2$ and display \\[\\int_0^1 f\\] math.',
  '$$\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$$',
  'A comment % with \\commands and $math$',
  'Escaped \\% percent and \\& ampersand and \\_ underscore.',
  '\\verb|\\raw{stuff}| and 2.5pt and 100',
  '\\begin{tabular}{cc}a & b \\\\ c & d\\end{tabular}',
  '\\alpha_1^{2} \\leq \\frac{a}{b}',
  'no commands at all, just prose',
  '\\begin{equation}\\label{eq:x}a=b\\end{equation}',
  '%\\input{commented-out}',
  '\\textbf{bold} \\emph{italic} \\texttt{mono}',
  '',
  'unicode: αβγ — em dash, non-breaking\u00a0space'
];

/** The token values, in order. */
const values = (text: string): string[] => tokenizeLatex(text).map((token) => token.value);

/** The token types, in order. */
const types = (text: string): string[] => tokenizeLatex(text).map((token) => token.type);

/** The type of the first token whose value is `value`. */
const typeOf = (text: string, value: string): string | undefined =>
  tokenizeLatex(text).find((token: LatexToken) => token.value === value)?.type;

describe('tokenizeLatex', () => {
  it('consumes every sample exactly once, in order', () => {
    for (const sample of SAMPLES) {
      const tokens = tokenizeLatex(sample);
      expect(tokens.map((token) => token.value).join(''), `rejoined: ${JSON.stringify(sample)}`).toBe(sample);
      // Offsets are the token's own position, and they only move forward.
      let expected = 0;
      for (const token of tokens) {
        expect(token.offset).toBe(expected);
        expected += token.value.length;
      }
    }
  });

  it('classifies commands, comments, delimiters and numbers', () => {
    expect(typeOf('\\section{Hello}', '\\section')).toBe('latex-command');
    expect(typeOf('% a comment', '% a comment')).toBe('latex-comment');
    expect(typeOf('costs $5', '$')).toBe('latex-math-delimiter');
    expect(typeOf('\\label{eq:x}', '{')).toBe('latex-brace');
    expect(typeOf('see [1]', '[')).toBe('latex-optional');
    expect(typeOf('a & b', '&')).toBe('latex-operator');
    expect(typeOf('2.5pt and 100', '2.5')).toBe('latex-number');
  });

  it('does not treat an escaped percent as a comment', () => {
    const escaped = 'Escaped \\% is not a comment';
    expect(types(escaped)).not.toContain('latex-comment');
    // `\%` is one token: the backslash and the character it escapes.
    expect(typeOf(escaped, '\\%')).toBe('latex-command');
  });

  it('treats a real comment as a comment, to the end of the line', () => {
    expect(typeOf('%\\input{commented-out}', '%\\input{commented-out}')).toBe('latex-comment');
  });

  it('reads a command as one token, and leaves its star to the text rules', () => {
    // The scanner is deliberately flat: `\section*` is the command `\section`
    // followed by `*`, which is what a surface that does not parse the grammar
    // can honestly say about it.
    expect(values('\\section*{Intro}')).toEqual([
      '\\section',
      '*',
      '{',
      'Intro',
      '}'
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(tokenizeLatex('')).toEqual([]);
  });
});
