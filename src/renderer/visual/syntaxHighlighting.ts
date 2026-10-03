/**
 * Eukolia Visual Mode Syntax Highlighting.
 *
 * Maps CodeMirror 6 / Lezer LaTeX syntax tags to the exact color tokens
 * used in Code Mode (Monaco editor), driven by CSS variables set on
 * document.documentElement by ThemeManager (--eu-syntax-*).
 *
 * This ensures identical syntax appearance in both Code Mode and Visual Mode
 * across both dark and light themes, reacting instantly to theme switches.
 *
 * Scoped and dedicated styles ensure that LaTeX mathematics retains its
 * distinct mathematical coloring (var(--eu-syntax-math)) while programming
 * and markup languages (JSON, JavaScript, TypeScript, Markdown) receive
 * vivid, purpose-built code syntax colorization.
 */

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import type { Extension } from '@codemirror/state'

/**
 * Canonical LaTeX highlight style matching the 14 syntax tokens defined in
 * Instructions.md §53 and Code Mode.
 *
 * In Lezer LaTeX, math content and characters are tagged as t.string.
 * In this style, t.string is mapped to var(--eu-syntax-math) so mathematical
 * notation retains its signature pink/purple coloring.
 */
export const eukoliaHighlightStyle = HighlightStyle.define([
  // Commands / Tag names (\documentclass, \usepackage, \begin, \end, \section, \alpha, etc.)
  { tag: [t.keyword, t.tagName], color: 'var(--eu-syntax-command)' },

  // Environments: {document}, {equation}, {align}, {figure}, etc.
  { tag: t.attributeValue, color: 'var(--eu-syntax-environment)' },

  // Braces & delimiters: {...}, [...], (...), commas, semicolons
  {
    tag: [
      t.brace,
      t.squareBracket,
      t.paren,
      t.bracket,
      t.punctuation,
      t.separator,
    ],
    color: 'var(--eu-syntax-brace)',
  },

  // Comments: % ..., // ..., /* ... */
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--eu-syntax-comment)',
    fontStyle: 'italic',
  },

  // Math delimiters: $, $$, \[ ... \]
  { tag: t.modifier, color: 'var(--eu-syntax-math-delimiter)', fontWeight: 'bold' },

  // Math content & Characters (Lezer LaTeX tags all math characters as t.string)
  {
    tag: [t.string, t.character, t.special(t.character)],
    color: 'var(--eu-syntax-math)',
  },

  // Control symbols & operators: &, \\, _, ^, #, %, +, -, =, *, /, =>, etc.
  {
    tag: [
      t.operator,
      t.arithmeticOperator,
      t.logicOperator,
      t.compareOperator,
      t.updateOperator,
      t.definitionOperator,
      t.typeOperator,
      t.controlOperator,
      t.derefOperator,
    ],
    color: 'var(--eu-syntax-operator)',
  },

  // Numbers and dimensions
  { tag: [t.number, t.integer, t.float], color: 'var(--eu-syntax-number)' },

  // Regex and escape sequences
  { tag: [t.regexp, t.escape], color: 'var(--eu-syntax-citation)' },

  // Labels: \label{sec:intro}
  { tag: t.labelName, color: 'var(--eu-syntax-label)' },

  // References: \ref{sec:intro}, \eqref{...}
  { tag: t.special(t.variableName), color: 'var(--eu-syntax-reference)' },

  // Citations: \cite{lamport94}
  { tag: t.special(t.string), color: 'var(--eu-syntax-citation)' },

  // File paths and URLs: \input{...}, \includegraphics{...}, \url{...}
  { tag: [t.url, t.link], color: 'var(--eu-syntax-file-path)' },

  // Macro definitions / types / classes
  {
    tag: [t.typeName, t.className, t.namespace, t.macroName],
    color: 'var(--eu-syntax-macro-definition)',
    fontWeight: 'bold',
  },

  // Optional arguments: [...]
  { tag: t.meta, color: 'var(--eu-syntax-optional)' },
])

/**
 * Vivid code highlight style for non-LaTeX documents (JSON, JavaScript, TypeScript, Markdown).
 *
 * Maps string literals to emerald green (var(--eu-syntax-string)), properties to cyan/blue
 * (var(--eu-syntax-property)), keywords to violet (var(--eu-syntax-keyword)), etc.
 */
export const codeHighlightStyle = HighlightStyle.define([
  // Programming Keywords & Controls (const, let, function, if, return, import, class)
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.definitionKeyword,
      t.moduleKeyword,
      t.operatorKeyword,
    ],
    color: 'var(--eu-syntax-keyword)',
    fontWeight: '600',
  },

  // Functions & Methods
  {
    tag: [
      t.function(t.variableName),
      t.function(t.definition(t.variableName)),
      t.function(t.propertyName),
    ],
    color: 'var(--eu-syntax-function)',
    fontWeight: '600',
  },

  // String literals (JSON, JS, Markdown, etc.)
  {
    tag: [t.string, t.docString],
    color: 'var(--eu-syntax-string)',
  },

  // Properties / JSON Object Keys
  {
    tag: [t.propertyName, t.definition(t.propertyName)],
    color: 'var(--eu-syntax-property)',
    fontWeight: '500',
  },

  // Constants & Booleans & Null
  {
    tag: [t.bool, t.null, t.atom],
    color: 'var(--eu-syntax-constant)',
    fontWeight: '600',
  },

  // Numbers
  { tag: [t.number, t.integer, t.float], color: 'var(--eu-syntax-number)' },

  // Operators
  {
    tag: [
      t.operator,
      t.arithmeticOperator,
      t.logicOperator,
      t.compareOperator,
      t.updateOperator,
      t.definitionOperator,
      t.typeOperator,
      t.controlOperator,
      t.derefOperator,
    ],
    color: 'var(--eu-syntax-operator)',
  },

  // Braces & Delimiters
  {
    tag: [
      t.brace,
      t.squareBracket,
      t.paren,
      t.bracket,
      t.punctuation,
      t.separator,
    ],
    color: 'var(--eu-syntax-brace)',
  },

  // Comments
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--eu-syntax-comment)',
    fontStyle: 'italic',
  },

  // Variable definitions (declarations)
  {
    tag: t.definition(t.variableName),
    color: 'var(--eu-syntax-variable-def)',
    fontWeight: '500',
  },

  // Variable usage & self
  { tag: t.self, color: 'var(--eu-syntax-keyword)', fontStyle: 'italic' },
  { tag: t.variableName, color: 'var(--eu-syntax-variable)' },

  // Types & Classes
  {
    tag: [t.typeName, t.className, t.namespace],
    color: 'var(--eu-syntax-macro-definition)',
    fontWeight: 'bold',
  },

  // Regex and escape sequences
  { tag: [t.regexp, t.escape], color: 'var(--eu-syntax-citation)' },

  // URLs & Links
  { tag: [t.url, t.link], color: 'var(--eu-syntax-file-path)' },

  // Markdown-specific formatting
  { tag: t.heading1, color: 'var(--eu-syntax-heading)', fontWeight: 'bold' },
  { tag: t.heading2, color: 'var(--eu-syntax-function)', fontWeight: 'bold' },
  { tag: t.heading3, color: 'var(--eu-syntax-string)', fontWeight: 'bold' },
  {
    tag: [t.heading4, t.heading5, t.heading6],
    color: 'var(--eu-syntax-constant)',
    fontWeight: 'bold',
  },
  { tag: t.heading, color: 'var(--eu-syntax-heading)', fontWeight: 'bold' },
  { tag: t.strong, fontWeight: 'bold', color: 'var(--eu-syntax-command)' },
  { tag: t.emphasis, fontStyle: 'italic', color: 'var(--eu-syntax-environment)' },
  { tag: t.quote, color: 'var(--eu-syntax-comment)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--eu-syntax-brace)', fontWeight: 'bold' },
  { tag: t.contentSeparator, color: 'var(--eu-syntax-operator)' },
  {
    tag: [t.processingInstruction, t.documentMeta, t.meta],
    color: 'var(--eu-syntax-optional)',
  },
])

/** Monospace inline code highlighting scoped to Markdown */
export const markdownHighlightStyle = HighlightStyle.define(
  [
    { tag: t.monospace, color: 'var(--eu-syntax-monospace)' },
  ],
  { scope: markdownLanguage }
)

/** Scoped LaTeX highlight style for embedded LaTeX in Markdown or mixed documents */
export const latexHighlightStyle = HighlightStyle.define(
  [
    { tag: [t.string, t.character, t.special(t.character)], color: 'var(--eu-syntax-math)' },
    { tag: t.modifier, color: 'var(--eu-syntax-math-delimiter)', fontWeight: 'bold' },
  ],
  { scope: LaTeXLanguage }
)

/** Syntax highlighting extension for LaTeX documents */
export const eukoliaSyntaxHighlighting: Extension = [
  syntaxHighlighting(eukoliaHighlightStyle),
]

/** Syntax highlighting extension for code documents (JSON, JS, TS, Markdown) */
export const codeSyntaxHighlighting: Extension = [
  syntaxHighlighting(codeHighlightStyle),
  syntaxHighlighting(markdownHighlightStyle),
  syntaxHighlighting(latexHighlightStyle),
]

const LATEX_EXTENSIONS = new Set(['tex', 'ltx', 'sty', 'cls'])

export const isLaTeXFile = (fileName: string | null): boolean => {
  if (!fileName) return true // untitled buffers are LaTeX in Eukolia
  const index = fileName.lastIndexOf('.')
  if (index < 0) return true
  return LATEX_EXTENSIONS.has(fileName.slice(index + 1).toLowerCase())
}

/** Returns the appropriate syntax highlighting extension for the given file */
export const syntaxHighlightingFor = (fileName: string | null): Extension =>
  isLaTeXFile(fileName) ? eukoliaSyntaxHighlighting : codeSyntaxHighlighting
