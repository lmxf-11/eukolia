/**
 * Eukolia — LaTeX language data.
 *
 * What is left of the language definition Monaco needed, kept because it is
 * engine-independent: the command/argument role tables, the macro-defining
 * commands, the mathematics and verbatim environment sets, and a small scanner
 * that classifies LaTeX without a parser. Monaco's own halves — the Monarch
 * grammar, `Monaco.languages.LanguageConfiguration` and the `latex` language id
 * — went with Monaco; the editor's colouring now comes from the Lezer grammar
 * through `visual/syntaxHighlighting.ts`, and folding, symbols, links and
 * navigation from `cmNavigation.ts` and the ported LaTeX Workshop code.
 *
 * The token names the tables use (`latex-command`, `latex-environment`, …) are
 * the names the Overleaf tokenizer emits, and they are what the syntax
 * highlighter and the theme's `--eu-syntax-*` variables colour.
 */

/** Commands whose `{...}` argument is a label / reference / citation / file. */
export const ARGUMENT_ROLES: Record<string, 'label' | 'reference' | 'citation' | 'file' | 'package' | 'class' | 'environment'> = {
  label: 'label',
  ref: 'reference',
  eqref: 'reference',
  pageref: 'reference',
  autoref: 'reference',
  nameref: 'reference',
  cref: 'reference',
  Cref: 'reference',
  vref: 'reference',
  cite: 'citation',
  Cite: 'citation',
  citep: 'citation',
  citet: 'citation',
  autocite: 'citation',
  parencite: 'citation',
  textcite: 'citation',
  footcite: 'citation',
  nocite: 'citation',
  input: 'file',
  include: 'file',
  includeonly: 'file',
  subfile: 'file',
  subfileinclude: 'file',
  import: 'file',
  subimport: 'file',
  includefrom: 'file',
  inputfrom: 'file',
  bibliographies: 'file',
  addbibresource: 'file',
  bibliography: 'file',
  graphicspath: 'file',
  includegraphics: 'file',
  usepackage: 'package',
  RequirePackage: 'package',
  documentclass: 'class',
  LoadClass: 'class',
  newenvironment: 'environment',
  renewenvironment: 'environment'
};

/** Commands that introduce a macro definition. */
export const MACRO_DEFINITION_COMMANDS = new Set([
  'newcommand',
  'renewcommand',
  'providecommand',
  'DeclareRobustCommand',
  'DeclareMathOperator',
  'DeclarePairedDelimiter',
  'newrobustcmd',
  'renewrobustcmd',
  'def',
  'gdef',
  'edef',
  'xdef',
  'let'
]);

/** Environments that render their contents as mathematics. */
export const MATH_ENVIRONMENTS = new Set([
  'math',
  'displaymath',
  'equation',
  'equation*',
  'align',
  'align*',
  'aligned',
  'alignedat',
  'gather',
  'gather*',
  'gathered',
  'multline',
  'multline*',
  'flalign',
  'flalign*',
  'alignat',
  'alignat*',
  'split',
  'cases',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'smallmatrix',
  'subequations',
  'dmath',
  'dmath*'
]);

/** Environments whose body is verbatim — no commands, math or comments inside. */
export const VERBATIM_ENVIRONMENTS = new Set([
  'verbatim',
  'verbatim*',
  'Verbatim',
  'BVerbatim',
  'LVerbatim',
  'lstlisting',
  'minted',
  'comment',
  'filecontents',
  'filecontents*',
  'alltt'
]);

/**
 * Eukolia's LaTeX word pattern: an optional backslash, then letters (or `@`), or
 * digits.
 *
 * This is the pattern Monaco's `LanguageConfiguration.wordPattern` gave the
 * model, and it is what completion replaces unless a suggestion carries an
 * explicit range — `cmCompletion.ts` builds its matcher from this constant, so
 * the two cannot drift apart.
 */
export const LATEX_WORD_PATTERN: RegExp = /\\?[a-zA-Z@]+|\d+/;

/**
 * A language configuration, in Monaco's `LanguageConfiguration` shape but
 * declared here so the data survives the engine.
 *
 * Nothing consumes it today — the CodeMirror editor gets auto-closing from
 * `auto-pair.ts`, indentation from the Lezer grammar's `indentOnInput` data and
 * Enter handling from the ported visual keymap — but it is the description of how
 * Eukolia expects LaTeX to be edited, and `wordPattern` above is read by
 * completion.
 */
export interface LatexLanguageConfiguration {
  comments: { lineComment: string };
  brackets: ReadonlyArray<readonly [string, string]>;
  autoClosingPairs: ReadonlyArray<{ open: string; close: string }>;
  surroundingPairs: ReadonlyArray<{ open: string; close: string }>;
  wordPattern: RegExp;
  indentationRules: {
    increaseIndentPattern: RegExp;
    decreaseIndentPattern: RegExp;
    indentNextLinePattern: RegExp;
  };
  onEnterRules: ReadonlyArray<{
    beforeText: RegExp;
    afterText: RegExp;
    action: { indentAction: number; appendText: string; removeText: number };
  }>;
}

export const LATEX_LANGUAGE_CONFIGURATION: LatexLanguageConfiguration = {
  comments: {
    lineComment: '%'
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '$', close: '$' },
    { open: '`', close: "'" }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '$', close: '$' },
    { open: '\\left(', close: '\\right)' },
    { open: '\\left[', close: '\\right]' },
    { open: '\\left\\{', close: '\\right\\}' },
    { open: '\\langle', close: '\\rangle' },
    { open: '\\lvert', close: '\\rvert' },
    { open: '\\lVert', close: '\\rVert' },
    { open: '\\begin{', close: '}\\end{}' }
  ],
  wordPattern: LATEX_WORD_PATTERN,
  indentationRules: {
    // Environments and brace groups increase indentation; matching `\end` and
    // closing braces decrease it. `\item` sits at the level of its list.
    increaseIndentPattern: /^\s*\\begin\{(?!document\})[^}]+\}(\[[^\]]*\])?\s*(%.*)?$|\\\[[^]*$|\{\s*(%.*)?$/,
    decreaseIndentPattern: /^\s*\\end\{[^}]+\}|^\s*\\\]|^\s*\}/,
    indentNextLinePattern: /^\s*\\item(\[[^\]]*\])?\s*$/
  },
  onEnterRules: [
    {
      // `\begin{env}` opens a block: the matching `\end{env}` is inserted on a
      // new line when the user presses Enter immediately after it.
      beforeText: /^\s*\\begin\{([^}]+)\}(\s*\[[^\]]*\])?\s*$/,
      afterText: /^\s*$/,
      action: { indentAction: 0 /* None */, appendText: '\t', removeText: 0 }
    }
  ]
};

/**
 * Tokenizes LaTeX to `{ type, value, offset }` triples.
 *
 * A plain scanner, for surfaces that do not run a parser — a diff view, an
 * outline preview, a test — and the single place where a token is classified
 * without one. The editor itself does not use it: CodeMirror colours from the
 * Lezer tree (`visual/syntaxHighlighting.ts`), which is stateful and handles
 * mathematics and verbatim correctly, where this scanner is deliberately flat.
 */
export interface LatexToken {
  type: string;
  value: string;
  offset: number;
}

export function tokenizeLatex(text: string): LatexToken[] {
  const rules: Array<{ pattern: RegExp; type: string }> = [
    { pattern: /%.*$/y, type: 'latex-comment' },
    { pattern: /\\verb\*?/y, type: 'latex-command' },
    { pattern: /\\(\w+|.)/y, type: 'latex-command' },
    { pattern: /\$+/y, type: 'latex-math-delimiter' },
    { pattern: /[{}]/y, type: 'latex-brace' },
    { pattern: /[\[\]]/y, type: 'latex-optional' },
    { pattern: /[&_^~]/y, type: 'latex-operator' },
    { pattern: /\d+(?:\.\d+)?/y, type: 'latex-number' },
    { pattern: /[a-zA-Z]+/y, type: 'latex-text' },
    { pattern: /\s+/y, type: 'latex-text' },
    { pattern: /./y, type: 'latex-text' }
  ];

  const tokens: LatexToken[] = [];
  let index = 0;
  // A plain scan is enough for the secondary uses; the editor's own colouring
  // comes from the Lezer tree, which is stateful and handles math and verbatim.
  while (index < text.length) {
    let matched = false;
    for (const rule of rules) {
      rule.pattern.lastIndex = index;
      const match = rule.pattern.exec(text);
      if (match && match.index === index && match[0].length > 0) {
        tokens.push({ type: rule.type, value: match[0], offset: index });
        index += match[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      tokens.push({ type: 'latex-text', value: text[index], offset: index });
      index++;
    }
  }
  return tokens;
}

export { LATEX_LANGUAGE_CONFIGURATION as languageConfiguration };
