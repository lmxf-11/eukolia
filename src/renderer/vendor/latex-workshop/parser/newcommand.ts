/**
 * Eukolia — LaTeX Workshop port: macro-definition discovery.
 *
 * Ported from `out/src/parse/newcommandfinder.js` of LaTeX Workshop 10.19.0
 * (`parseAst`): it recognises `\newcommand`, `\renewcommand`, `\newrobustcmd`,
 * `\renewrobustcmd`, `\providecommand`, `\providerobustcmd`,
 * `\DeclareRobustCommand`, `\DeclareMathOperator` and the
 * `\DeclarePairedDelimiter*` family by looking at the *type of the first
 * argument*, which is what makes `\newcommand\WARNING{...}` (no braces) work.
 *
 * The normalization the reference applies to the produced definition is kept:
 * `\DeclareRobustCommand` and `\providecommand` become `\newcommand` and the
 * star of a starred macro is dropped, because MathJax cannot parse them.
 *
 * Extension beyond the reference: `\def`, `\edef`, `\gdef`, `\xdef`, `\let` and
 * the `\newenvironment` family, which `DocumentAnalysis` asks for explicitly
 * (`primitive` marks the TeX primitives).
 *
 * Extension beyond that: `\LetLtxMacro`, the `letltxmacro` package's two-argument
 * form of `\let`. It is collected because it is the only way a saved original
 * comes into existence — `\LetLtxMacro{\origforall}{\forall}` followed later by
 * `\renewcommand{\forall}{\origforall\,}` is an idiom real preambles are built
 * from — and because the definition it stores is rewritten into a `\def` (see
 * `LETLTXMACRO_ALIASES`). See `editor/projectMacros.ts` for what the omission cost.
 */

import { stringifyAst } from './unified'
import { argContentToStr } from './astUtils'
import { normalizeDefinitionText, readArgumentsAt } from '../../../parser/sourceText'
import type { AstNode } from '../types'
import type { MacroDefinitionInfo } from '../../../document/analysisTypes'

/*
 * The command vocabulary, exported because the linear source scan
 * (`parser/latexScan.ts`) collects the same definitions without an AST and must not
 * keep a second copy of the list: a macro the parser recognises and the scan does not
 * would go missing from the outline and from completion for large documents only.
 */
export const NEW_COMMAND_MACROS = new Set(['newcommand', 'renewcommand', 'newrobustcmd', 'renewrobustcmd'])
export const PROVIDE_COMMAND_MACROS = new Set([
  'providecommand',
  'providerobustcmd',
  'DeclareRobustCommand',
  'DeclareMathOperator'
])
export const MATH_OPERATOR_MACROS = new Set([
  'DeclarePairedDelimiter',
  'DeclarePairedDelimiterX',
  'DeclarePairedDelimiterXPP'
])
export const ENVIRONMENT_DEF_MACROS = new Set([
  'newenvironment',
  'renewenvironment',
  'NewDocumentEnvironment',
  'RenewDocumentEnvironment'
])
export const PRIMITIVE_DEF_MACROS = new Set(['def', 'edef', 'gdef', 'xdef', 'let'])

/**
 * `\LetLtxMacro{\saved}{\original}`, the `letltxmacro` package's two-argument
 * `\let`.
 *
 * Unlike the primitives above, this one is **rewritten** rather than stored
 * verbatim. `\let` has no braces, so the collector can slice its statement
 * straight out of the source; `\LetLtxMacro` is an ordinary two-argument macro,
 * the statement it occupies is knowable from the AST, and the text of it is not
 * what anybody downstream wants: MathJax has no `\LetLtxMacro`, cannot execute it
 * and will not ignore it. The equivalent `\def` is what it can use.
 */
const LETLTXMACRO_ALIASES = new Set(['LetLtxMacro'])
export { LETLTXMACRO_ALIASES }

/**
 * The reference's definition normalization.
 *
 * `stringifyAst` walks the definition's subtree and rebuilds its text, which is the
 * **dominant cost of analysing a project's `macros.tex`**: measured over four real
 * files (12.6–13.1 KB, 311 definitions each) an analysis costs 133 ms, of which
 * `parseLatexWithArguments` is ~50 ms. Slicing the statement out of the source
 * instead was tried and reverted: unified-latex positions a `\newcommand` node over
 * its control sequence alone, with the name, the `[n]` and the body as *arguments
 * that carry no position of their own*, so the slice came back as a bare
 * `\newcommand` for 1 116 of 1 244 definitions. Getting the statement's end would
 * mean walking the arguments' content nodes and guessing where the closing brace
 * sits, and a macro table with the wrong bodies is a far worse failure than 90 ms
 * per file — especially now that the analysis runs in the main process, where it no
 * longer blocks typing. See `HANDOFF.md`.
 */
export function normalizeDefinition(node: AstNode): string {
  return normalizeDefinitionText(stringifyAst(node))
}

/** The `[n]` argument count of a definition, if present. */
export function argumentCount(node: AstNode): number {
  for (const arg of node.args ?? []) {
    if (arg.openMark !== '[') continue
    const text = argContentToStr(arg.content).trim()
    if (/^\d+$/.test(text)) {
      return parseInt(text, 10)
    }
  }
  return 0
}

function startOffset(node: AstNode): number {
  return node.position?.start.offset ?? 0
}

function startLine(node: AstNode): number {
  return node.position?.start.line ?? 1
}

function nextSignificant(nodes: AstNode[], from: number): AstNode | undefined {
  for (let i = from; i < nodes.length; i++) {
    if (!['whitespace', 'parbreak', 'comment'].includes(nodes[i].type)) {
      return nodes[i]
    }
  }
  return undefined
}

/** Count `#1`-style parameters in a TeX parameter text. */
export function countParameters(text: string): number {
  let max = 0
  for (const match of text.matchAll(/#([1-9])/g)) {
    max = Math.max(max, parseInt(match[1], 10))
  }
  return max
}

/**
 * `parseAst` of `parse/newcommandfinder.js`, extended to the primitives and
 * environment definitions, returning plain `MacroDefinitionInfo` records.
 */
export function collectMacroDefinitions(nodes: AstNode[], source: string): MacroDefinitionInfo[] {
  const macros: MacroDefinitionInfo[] = []
  visit(nodes, source, macros)
  return macros
}

function visit(nodes: AstNode[], source: string, macros: MacroDefinitionInfo[]): void {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]
    if (node.type === 'macro') {
      const name = node.content as string
      if (NEW_COMMAND_MACROS.has(name)) {
        // \newcommand{\fix}[3][]{...} and \newcommand\WARNING{...}
        const target = extractTargetMacro(node, 2)
        if (target) {
          macros.push({
            name: target,
            args: argumentCount(node),
            offset: startOffset(node),
            line: startLine(node),
            definition: normalizeDefinition(node),
            primitive: false
          })
        }
      } else if (PROVIDE_COMMAND_MACROS.has(name)) {
        // \providecommand, \providerobustcmd, \DeclareRobustCommand, \DeclareMathOperator
        const target = extractTargetMacro(node, 1)
        if (target) {
          macros.push({
            name: target,
            args: argumentCount(node),
            offset: startOffset(node),
            line: startLine(node),
            definition: normalizeDefinition(node),
            primitive: false
          })
        }
      } else if (MATH_OPERATOR_MACROS.has(name)) {
        // \DeclarePairedDelimiterX\braketzw[2]{...}{...}{...}
        const target = extractTargetMacro(node, 0)
        if (target) {
          macros.push({
            name: target,
            args: argumentCount(node),
            offset: startOffset(node),
            line: startLine(node),
            definition: normalizeDefinition(node),
            primitive: false
          })
        }
      } else if (ENVIRONMENT_DEF_MACROS.has(name)) {
        /*
         * The environment's name, from the AST when it is there and from the source
         * when it is not.
         *
         * `\newenvironment` has no signature in the parser's macro table, so its
         * arguments never arrive and the definition was silently lost:
         * `\newenvironment{claim}{…}{…}` produced no `claim` at all, for documents of
         * every size, so nothing downstream could complete it. `readArgumentAt` is the
         * reader the linear scan uses, which is what keeps the two paths' answers the
         * same for the documents each of them handles.
         */
        const attached = argContentToStr((node.args ?? [])[0]?.content ?? []).trim()
        const gobbled = attached ? null : readArgumentsAt(source, node.position?.end.offset ?? startOffset(node))
        const envName = attached || (gobbled?.first ?? '')
        if (envName) {
          macros.push({
            name: envName,
            args: argumentCount(node),
            offset: startOffset(node),
            line: startLine(node),
            /*
             * The statement's own text when the AST could not supply it: with no
             * signature there are no argument nodes, and `stringifyAst` would produce a
             * bare `\newenvironment` — a definition nothing can use.
             */
            definition: gobbled ? source.slice(startOffset(node), gobbled.end) : normalizeDefinition(node),
            primitive: false
          })
        }
      } else if (LETLTXMACRO_ALIASES.has(name)) {
        // \LetLtxMacro{\saved}{\original} — the two names arrive as *siblings*,
        // each either a group holding one macro or a bare macro, because the
        // parser does not know this command takes arguments. `\def` is the
        // equivalent MathJax can execute; see `LETLTXMACRO_ALIASES`.
        const target = nameOfMacroNode(nextSignificant(nodes, index + 1))
        const original = nameOfMacroNode(nextSignificant(nodes, index + 2))
        if (target && original) {
          macros.push({
            name: target,
            args: 0,
            offset: startOffset(node),
            line: startLine(node),
            definition: `\\def\\${target}{\\${original}}`,
            primitive: true
          })
        }
      } else if (PRIMITIVE_DEF_MACROS.has(name)) {
        const target = nextSignificant(nodes, index + 1)
        if (target && target.type === 'macro') {
          const targetEnd = target.position?.end.offset ?? startOffset(node)
          const statementEnd = statementEndOffset(source, startOffset(node))
          const paramText = name === 'let' ? '' : source.slice(targetEnd, source.indexOf('{', targetEnd) === -1 ? targetEnd : source.indexOf('{', targetEnd))
          macros.push({
            name: target.content as string,
            args: countParameters(paramText),
            offset: startOffset(node),
            line: startLine(node),
            definition: source.slice(startOffset(node), statementEnd),
            primitive: true
          })
        }
      }
    }
    if (Array.isArray(node.content)) {
      visit(node.content, source, macros)
    }
  }
}

/**
 * Resolves the macro name being defined by looking at the expected argument
 * index first, falling back to any argument whose first node is a macro.
 */
function extractTargetMacro(node: AstNode, preferredIndex: number): string | null {
  const preferred = (node.args ?? [])[preferredIndex]?.content?.[0]
  if (preferred && preferred.type === 'macro') {
    return preferred.content as string
  }
  for (const arg of node.args ?? []) {
    const first = arg.content?.[0]
    if (first && first.type === 'macro') {
      return first.content as string
    }
  }
  return null
}

/**
 * The macro name a node contributes, without its backslash, or `null` when the
 * node is not a macro name at all.
 *
 * A macro name written as an argument can be either shape: braced
 * (`\LetLtxMacro{\origforall}{\forall}`) gives a `group` holding one `macro`,
 * and bare (`\LetLtxMacro\origforall\forall`) gives the `macro` itself.
 */
function nameOfMacroNode(node: AstNode | undefined): string | null {
  if (!node) return null
  const macro =
    node.type === 'macro'
      ? node
      : ((node.content as AstNode[] | string | undefined) instanceof Array
          ? (node.content as AstNode[]).find(child => child.type === 'macro')
          : undefined)
  if (!macro) return null
  const name = String(macro.content ?? '').trim()
  return /^[a-zA-Z]+$/.test(name) ? name : null
}

/**
 * TeX primitives have no brace-delimited node the AST can delimit, so the
 * definition runs to the end of the last line the statement occupies. Walking
 * balanced braces from the first `{` after the macro name gives the right end
 * for the common (and multi-line) cases.
 */
function statementEndOffset(source: string, start: number): number {
  const braceStart = source.indexOf('{', start)
  const newline = source.indexOf('\n', start)
  if (braceStart === -1 || (newline !== -1 && newline < braceStart)) {
    return newline === -1 ? source.length : newline
  }
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    const char = source[i]
    if (char === '\\') {
      i += 1
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return i + 1
      }
    }
  }
  return newline === -1 ? source.length : newline
}
