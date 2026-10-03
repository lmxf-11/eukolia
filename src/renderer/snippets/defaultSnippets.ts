/**
 * Eukolia — built-in LaTeX snippet library.
 *
 * This file deliberately contains **no engine code**: it is a `.hsnips` document
 * written in the real HyperSnips syntax (`snippet`, `priority`, flags, context
 * conditions, `` `…` `` JavaScript blocks) which is handed to the ported parser
 * at `src/renderer/vendor/hypersnips/parser.ts`.
 *
 * The previous contents of this file were hand-written `Snippet` objects from
 * the abandoned approximation in `snippetParser.ts`; they are replaced here by
 * parser-verified source so there is exactly one snippet representation.
 *
 * Ported examples (`box`, `dategreeting`, `filename`) come from
 * References/hypersnips/README.md (MIT, (c) 2019 Ian Ornelas).
 */

import { HSnippet, getSnippetBody, parse } from '../vendor/hypersnips';

/**
 * The built-in `latex.hsnips` document.
 *
 * Backticks are written as `\x60` so the whole document can live in a template
 * literal without escaping every code block.
 */
export const defaultSnippetsSource = `snippet ff "fraction" Aim
\\frac{$1}{$2}$0
endsnippet

snippet // "fraction (//)" Aim
\\frac{$1}{$2}$0
endsnippet

snippet sq "square root" Aim
\\sqrt{$1}$0
endsnippet

snippet RR "real numbers" iAm
\\mathbb{R}
endsnippet

snippet NN "natural numbers" iAm
\\mathbb{N}
endsnippet

snippet ZZ "integers" iAm
\\mathbb{Z}
endsnippet

snippet QQ "rationals" iAm
\\mathbb{Q}
endsnippet

snippet CC "complex numbers" iAm
\\mathbb{C}
endsnippet

snippet sr "superscript 2" Aim
^2
endsnippet

snippet cb "superscript 3" Aim
^3
endsnippet

snippet rd "superscript" Aim
^{$1}$0
endsnippet

snippet __ "subscript" Aim
_{$1}$0
endsnippet

snippet -> "arrow" Aim
\\to
endsnippet

snippet => "implies" Aim
\\implies
endsnippet

snippet <=> "iff" Aim
\\iff
endsnippet

snippet != "not equal" Aim
\\neq
endsnippet

snippet <= "less or equal" Aim
\\leq
endsnippet

snippet >= "greater or equal" Aim
\\geq
endsnippet

snippet ... "dots" Aim
\\dots
endsnippet

snippet xx "times" Aim
\\times
endsnippet

snippet ** "cdot" Aim
\\cdot
endsnippet

snippet bra "bra" Aim
\\bra{$1}$0
endsnippet

snippet ket "ket" Aim
\\ket{$1}$0
endsnippet

snippet brk "braket" Aim
\\braket{$1}{$2}$0
endsnippet

snippet @a "alpha" Aim
\\alpha
endsnippet

snippet @b "beta" Aim
\\beta
endsnippet

snippet @g "gamma" Aim
\\gamma
endsnippet

snippet @d "delta" Aim
\\delta
endsnippet

snippet @e "epsilon" Aim
\\epsilon
endsnippet

snippet @t "theta" Aim
\\theta
endsnippet

snippet @l "lambda" Aim
\\lambda
endsnippet

snippet @s "sigma" Aim
\\sigma
endsnippet

snippet @w "omega" Aim
\\omega
endsnippet

snippet @p "pi" Aim
\\pi
endsnippet

snippet @f "phi" Aim
\\phi
endsnippet

snippet @i "infty" Aim
\\infty
endsnippet

priority 100
snippet \x60(\\\\?[a-zA-Z]\\w*)cal\x60 "mathcal" iAm
\\mathcal{$1}$0
endsnippet

priority 100
snippet \x60(\\\\?[a-zA-Z]\\w*)bf\x60 "mathbf" iAm
\\mathbf{$1}$0
endsnippet

priority 100
snippet \x60(\\\\?[a-zA-Z]\\w*)rm\x60 "mathrm" iAm
\\mathrm{$1}$0
endsnippet

priority 100
snippet \x60(\\\\?[a-zA-Z]\\w*)tt\x60 "texttt" iAm
\\texttt{$1}$0
endsnippet

priority 100
snippet \x60(\\\\?[a-zA-Z]\\w*)op\x60 "operatorname" iAm
\\operatorname{$1}$0
endsnippet

priority 200
snippet \x60([A-Za-z])\\.\x60 "dot product" Aim
\\dot{$1}$0
endsnippet

priority 200
snippet \x60([A-Za-z])vec\x60 "vector" Aim
\\vec{$1}$0
endsnippet

priority 200
snippet \x60([A-Za-z])bar\x60 "overline" Aim
\\bar{$1}$0
endsnippet

priority 200
snippet \x60([A-Za-z])hat\x60 "hat" Aim
\\hat{$1}$0
endsnippet

priority 200
snippet \x60([A-Za-z])tilde\x60 "tilde" Aim
\\tilde{$1}$0
endsnippet

snippet mk "inline math" Ai
$$1$ $0
endsnippet

snippet dm "display math" Ai
\\[
	$1
\\] $0
endsnippet

snippet beg "begin/end environment" Aib
\\begin{\${1:equation}}
	$0
\\end{\${1:equation}}
endsnippet

snippet ali "align environment" ib
\\begin{align}
	$1 &= $2 \\\\
	$3 &= $4
\\end{align}
endsnippet

snippet cas "cases environment" Aib
\\begin{cases}
	$1, & \\text{if } $2 \\\\
	$3, & \\text{otherwise}
\\end{cases}
endsnippet

snippet pmat "pmatrix" Aib
\\begin{pmatrix}
	$1
\\end{pmatrix}
endsnippet

snippet bmat "bmatrix" Aib
\\begin{bmatrix}
	$1
\\end{bmatrix}
endsnippet

snippet vmat "vmatrix" Aib
\\begin{vmatrix}
	$1
\\end{vmatrix}
endsnippet

snippet tabular "table environment" Ai
\\begin{table}[\${1:h!}]
	\\centering
	\\begin{tabular}{\${2:cc}}
		$0
	\\end{tabular}
	\\caption{$3}
	\\label{tab:$4}
\\end{table}
endsnippet

snippet box "Box" A
\x60\x60rv = '┌' + '─'.repeat(t[0].length + 2) + '┐'\x60\x60
│ $1 │
\x60\x60rv = '└' + '─'.repeat(t[0].length + 2) + '┘'\x60\x60
endsnippet

snippet dategreeting "Gives you the current date!"
Hello from your hsnip at \x60\x60rv = new Date().toDateString()\x60\x60!
endsnippet

snippet filename "Current Filename"
\x60\x60rv = path\x60\x60
endsnippet
`;

/** Same document, shipped as a sample file at `resources/snips/latex.hsnips`. */
export const DEFAULT_LATEX_SNIPPETS_FILE = 'latex.hsnips';

/**
 * A parsed snippet from the built-in library, with the extra views the Eukolia
 * UI needs (trigger text, raw body, flag string).
 *
 * These are real `HSnippet` objects produced by the ported parser — the added
 * fields are read-only projections, not a second implementation.
 */
export interface SnippetLibraryEntry extends HSnippet {
  /** Trigger text; regex triggers expose their `source`. */
  readonly triggerText: string;
  /** Raw `.hsnips` body, with code blocks intact. */
  readonly body: string;
    readonly isAutomatic: boolean;
  readonly isMathOnly: boolean;
  readonly isNonMathOnly: boolean;
  readonly isWordBoundary: boolean;
  readonly isInWord: boolean;
  readonly isBeginningOfLine: boolean;
  readonly isMultiLine: boolean;
}

function toLibraryEntry(snippet: HSnippet): SnippetLibraryEntry {
  const triggerText = snippet.trigger || snippet.regexp?.source || '';
  const body = getSnippetBody(snippet);

  return Object.assign(snippet, {
    get triggerText() {
      return triggerText;
    },
    get body() {
      return body;
    },
    get isAutomatic() {
      return snippet.automatic;
    },
    get isMathOnly() {
      return snippet.math;
    },
    get isNonMathOnly() {
      return snippet.nonmath;
    },
    get isWordBoundary() {
      return snippet.wordboundary;
    },
    get isInWord() {
      return snippet.inword;
    },
    get isBeginningOfLine() {
      return snippet.beginningofline;
    },
    get isMultiLine() {
      return snippet.multiline;
    }
  }) as SnippetLibraryEntry;
}

/**
 * The parsed built-in library.
 *
 * Parsing happens at module load through the real ported parser, so an invalid
 * built-in snippet fails immediately instead of silently degrading.
 */
export const defaultSnippets: SnippetLibraryEntry[] = parse(
  defaultSnippetsSource,
  DEFAULT_LATEX_SNIPPETS_FILE
).map(toLibraryEntry);

/** The snippet sources Eukolia loads at startup. */
export function defaultSnippetSources(): Array<{ name: string; content: string; language: string }> {
  return [{ name: DEFAULT_LATEX_SNIPPETS_FILE, content: defaultSnippetsSource, language: 'latex' }];
}
