/**
 * Eukolia — LaTeX Workshop port: LaTeX AST parsing.
 *
 * Ported from `out/src/parse/parser/unified.js` of LaTeX Workshop 10.19.0. The
 * reference loads its own bundled unified-latex parser from
 * `resources/unified.js`; Eukolia vendors that exact artefact at
 * `vendor/latex-workshop/vendor/unified-latex/index.js`, so the AST this module
 * returns is the same one the reference's outline, `find`, and `newcommand`
 * modules consume.
 *
 * The one structural change: the reference parses inside a `workerpool` thread
 * and exposes an async proxy. Parsing is synchronous here and the worker pool is
 * left out, because Eukolia already runs analysis off the UI thread.
 */

import { attachMacroArgs as bundleAttachMacroArgs, getParser, toString as bundleToString } from '../vendor/unified-latex/index'
import type { AstNode, AstRoot } from '../types'
import { getEnvDefs, getMacroDefs, type MacroDef } from './unifiedDefs'
import type { LwSettings } from '../settings'

interface ParserState {
  parser: ReturnType<typeof getParser>
  macroDefs: Record<string, MacroDef>
  /** Identity of the settings the parser was built from. */
  signature: string
}

let state: ParserState | undefined

/**
 * The macro definitions that change the shape of the AST (`view.outline.*`,
 * `intellisense.label.command`) are baked into the parser at construction time,
 * exactly as the reference does in `lw.parser.parse.reset()`.
 */
function settingsSignature(settings: LwSettings): string {
  return JSON.stringify([
    settings['view.outline.sections'],
    settings['view.outline.commands'],
    settings['intellisense.label.command']
  ])
}

function buildParser(settings: LwSettings): ParserState {
  const macroDefs = getMacroDefs(settings)
  return {
    parser: getParser({
      macros: macroDefs,
      environments: getEnvDefs(),
      flags: { autodetectExpl3AndAtLetter: true }
    }),
    macroDefs,
    signature: settingsSignature(settings)
  }
}

/**
 * `lw.parser.parse.reset()` of the reference: rebuild the parser with the
 * current macro/environment definitions.
 */
export function resetParser(settings: LwSettings): void {
  state = buildParser(settings)
}

function ensureParser(settings?: LwSettings): ParserState {
  if (state === undefined) {
    state = settings ? buildParser(settings) : { parser: getParser({ flags: { autodetectExpl3AndAtLetter: true } }), macroDefs: {}, signature: '' }
    return state
  }
  if (settings !== undefined && settingsSignature(settings) !== state.signature) {
    state = buildParser(settings)
  }
  return state
}

/** `lw.parser.parse.tex(content)` of the reference. */
export function parseLaTeX(content: string, settings?: LwSettings): AstRoot {
  return ensureParser(settings).parser.parse(content)
}

/** `lw.parser.parse.args(ast)` of the reference. */
export function parseArguments(ast: AstRoot, settings: LwSettings): void {
  bundleAttachMacroArgs(ast, getMacroDefs(settings))
}

/** `lw.parser.parse.stringify(ast)` of the reference. */
export function stringifyAst(ast: unknown): string {
  return bundleToString(ast)
}

/**
 * Parse and attach arguments in one step — what every Eukolia consumer wants.
 *
 * The parser is constructed with the configured macro definitions, which is what
 * gives `\section{Title}` the reference's three-slot `s o m` shape
 * (`[starred, shortTitle, title]`) instead of the bundled default four-slot one.
 * `attachMacroArgs` cannot replace arguments that are already attached, so this
 * distinction matters for the outline.
 */
export function parseLatexWithArguments(content: string, settings: LwSettings): AstRoot {
  const ast = parseLaTeX(content, settings)
  parseArguments(ast, settings)
  return ast
}

export function isMacro(node: AstNode | undefined): boolean {
  return node?.type === 'macro'
}

export function nodeText(node: AstNode): string {
  if (typeof node.content === 'string') {
    return node.content
  }
  return ''
}
