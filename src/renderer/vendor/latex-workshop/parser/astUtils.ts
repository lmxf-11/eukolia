/**
 * Eukolia — LaTeX Workshop port: AST-to-text helpers.
 *
 * Ported from `out/src/utils/parser.js` of LaTeX Workshop 10.19.0:
 * `argContentToStr`, `macroContentToLabel`, `labelContentToStr` and
 * `sanitizeLabel`. These are what turn an AST argument into the plain title an
 * outline entry shows, including the Unicode substitution of math macros.
 */

import { getUnicodeMathSymbol } from '../unimath'
import type { AstArgument, AstNode } from '../types'

function macroToStr(macro: AstNode): string {
  if (macro.content === 'texorpdfstring') {
    const arg = macro.args?.[1]
    const first = arg?.content?.[0]
    return (typeof first?.content === 'string' ? first.content : '') ?? ''
  }
  return (
    `\\${macro.content}` +
    (macro.args?.map((arg) => `${arg.openMark}${argContentToStr(arg.content)}${arg.closeMark}`).join('') ?? '')
  )
}

function envToStr(env: AstNode): string {
  return `\\environment{${env.env}}`
}

export function argContentToStr(argContent: AstNode[], preserveCurlyBrace = false): string {
  return argContent
    .map((node) => {
      switch (node.type) {
        case 'string':
          return (node.content as string) ?? ''
        case 'whitespace':
        case 'parbreak':
        case 'comment':
          return ' '
        case 'macro':
          return macroToStr(node)
        case 'environment':
        case 'verbatim':
        case 'mathenv':
          return envToStr(node)
        case 'inlinemath':
          return `$${argContentToStr((node.content as AstNode[]) ?? [])}$`
        case 'displaymath':
          return `\\[${argContentToStr((node.content as AstNode[]) ?? [])}\\]`
        case 'group':
          return preserveCurlyBrace
            ? `{${argContentToStr((node.content as AstNode[]) ?? [])}}`
            : argContentToStr((node.content as AstNode[]) ?? [])
        case 'verb':
          return (node.content as string) ?? ''
        default:
          return ''
      }
    })
    .join('')
}

const formattingMacros = [
  'textbf',
  'textit',
  'text',
  'emph',
  'textrm',
  'textsf',
  'texttt',
  'textsl',
  'textsc',
  'textup',
  'textnormal'
]

function macroContentToLabel(macro: AstNode, inMath: boolean): string {
  if (macro.content === 'texorpdfstring') {
    return labelContentToStr(macro.args?.[1]?.content ?? [], inMath)
  }
  if (formattingMacros.includes(macro.content as string)) {
    return labelContentToStr(macro.args?.[0]?.content ?? [], inMath)
  }
  if ((macro.content as string).startsWith('cite')) {
    return ''
  }
  if (inMath && ['left', 'right', 'middle'].includes(macro.content as string)) {
    return ''
  }
  if (inMath) {
    const symbol = getUnicodeMathSymbol(macro.content as string)
    if (symbol !== undefined) {
      return symbol
    }
  }
  return (
    `\\${macro.content}` +
    (macro.args?.map((arg) => `${arg.openMark}${labelContentToStr(arg.content, inMath)}${arg.closeMark}`).join('') ?? '')
  )
}

export function labelContentToStr(content: AstNode[], inMath = false): string {
  return content
    .map((node) => {
      switch (node.type) {
        case 'string':
          return (node.content as string) ?? ''
        case 'whitespace':
        case 'parbreak':
        case 'comment':
          return ' '
        case 'macro':
          return macroContentToLabel(node, inMath)
        case 'inlinemath':
        case 'displaymath':
          return labelContentToStr((node.content as AstNode[]) ?? [], true)
        case 'group':
          return labelContentToStr((node.content as AstNode[]) ?? [], inMath)
        case 'verb':
          return (node.content as string) ?? ''
        default:
          return argContentToStr([node])
      }
    })
    .join('')
}

/** `sanitizeLabel` of the reference. */
export function sanitizeLabel(content: AstNode[]): string {
  return labelContentToStr(content).replace(/\s+/g, ' ').trim()
}

/** `chooseCaption` of `outline/structure/latex.js`. */
export function chooseCaption(...args: Array<AstArgument | undefined>): string {
  for (const arg of args) {
    if ((arg?.content?.length ?? 0) > 0) {
      return sanitizeLabel(arg?.content ?? [])
    }
  }
  return ''
}
