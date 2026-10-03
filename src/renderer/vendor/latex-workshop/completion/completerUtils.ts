/**
 * Eukolia — LaTeX Workshop port: completion helpers.
 *
 * Ported from `out/src/completion/completer/completerutils.js` of LaTeX Workshop
 * 10.19.0: `splitSignatureString`, the `CmdEnvSuggestion` item class,
 * `filterNonLetterSuggestions`, `computeFilteringRange` and
 * `filterArgumentHint`.
 *
 * The only adaptations are the two the no-`vscode` rule forces:
 *  - `CmdEnvSuggestion` implements the plain `LatexCompletionItem` instead of
 *    extending `vscode.CompletionItem`;
 *  - `filterArgumentHint` receives the resolved `LwSettings` instead of reading
 *    `vscode.workspace.getConfiguration('latex-workshop')`;
 *  - a `vscode.Range` assigned to a completion item is expressed as the item's
 *    `textEdit` (see `withTextEdit`).
 */

import { settingOr, type LwSettings } from '../settings'
import {
  type CompletionArgs,
  type CompletionItemKindValue,
  type CompletionTextEdit,
  type CompletionTextRange,
  type LatexCompletionItem
} from './types'

/** A cursor position, ie the `{ line, character }` pair of `CompletionTextRange`. */
export interface TextPosition {
  line: number
  character: number
}

/**
 * The reference's `vscode.Position`: `CompletionArgs` carries the cursor's line
 * *text* and column, while every range a provider computes lies on the cursor's
 * own line. The line number is therefore optional metadata (`lineNumber`) the
 * editor adapter may pass, and defaults to `0`, which is the line every
 * `CompletionTextRange` produced here refers to.
 */
export function textPosition(args: CompletionArgs): TextPosition {
  return {
    line: (args as CompletionArgs & { lineNumber?: number }).lineNumber ?? 0,
    character: args.character
  }
}

/** Return {name, args} from a signature string `name` + `args` */
export function splitSignatureString(signature: string): { name: string; args: string } {
  const i = signature.search(/[[{]/)
  if (i > -1) {
    return {
      name: signature.substring(0, i),
      args: signature.substring(i)
    }
  }
  return {
    name: signature,
    args: ''
  }
}

/**
 * `CmdEnvSuggestion` of the reference: a completion item that also carries the
 * macro/environment signature it was built from.
 */
export class CmdEnvSuggestion implements LatexCompletionItem {
  label: string
  kind?: CompletionItemKindValue
  detail?: string
  documentation?: string
  insertText?: string
  filterText?: string
  sortText?: string
  preselect?: boolean
  textEdit?: CompletionTextEdit
  command?: { command: string; title: string; arguments?: unknown[] }
  data?: Record<string, unknown>

  readonly packageName: string
  readonly keys: string[]
  readonly keyPos: number
  readonly signature: { name: string; args: string }
  readonly ifCond?: string
  readonly unusual?: boolean

  constructor(
    label: string,
    packageName: string,
    keys: string[],
    keyPos: number,
    signature: { name: string; args: string },
    kind: CompletionItemKindValue,
    ifCond?: string,
    unusual?: boolean
  ) {
    this.label = label
    this.packageName = packageName
    this.keys = keys
    this.keyPos = keyPos
    this.signature = signature
    this.kind = kind
    this.ifCond = ifCond
    this.unusual = unusual
  }

  /**
   * Return the signature, ie the name + {} for mandatory arguments + [] for optional arguments.
   * The leading backward slash is not part of the signature
   */
  signatureAsString(): string {
    return this.signature.name + this.signature.args
  }

  /**
   * Return the name without the arguments
   * The leading backward slash is not part of the signature
   */
  name(): string {
    return this.signature.name
  }

  hasOptionalArgs(): boolean {
    return this.signature.args.includes('[')
  }
}

/**
 * Express the `vscode.Range` the reference assigns to a completion item as the
 * plain item's `textEdit`, whose `newText` is the insertion the range applies
 * to (`insertText` when present, the label otherwise).
 */
export function withTextEdit(item: LatexCompletionItem, range: CompletionTextRange | undefined): LatexCompletionItem {
  if (range) {
    item.textEdit = { range, newText: item.insertText ?? item.label }
  }
  return item
}

export function filterNonLetterSuggestions(
  suggestions: CmdEnvSuggestion[],
  typedText: string,
  pos: TextPosition
): LatexCompletionItem[] {
  if (typedText.match(/[^a-zA-Z]/)) {
    const exactSuggestion = suggestions.filter((entry) => entry.label.startsWith(typedText))
    if (exactSuggestion.length > 0) {
      return exactSuggestion.map((item) =>
        withTextEdit(item, {
          start: { line: pos.line, character: pos.character - typedText.length },
          end: { line: pos.line, character: pos.character }
        })
      )
    }
  }
  return suggestions
}

export function computeFilteringRange(line: string, position: TextPosition): CompletionTextRange | undefined {
  const curlyStart = line.lastIndexOf('{', position.character)
  const commaStart = line.lastIndexOf(',', position.character)
  const startPos = Math.max(curlyStart, commaStart)
  if (startPos >= 0) {
    return {
      start: { line: position.line, character: startPos + 1 },
      end: { line: position.line, character: position.character }
    }
  }
  return undefined
}

/**
 * When `intellisense.argumentHint.enabled` is off, placeholder hints
 * (`${1:foo}`) are turned into bare tab stops (`${1}`).
 */
export function filterArgumentHint(suggestions: LatexCompletionItem[], settings: LwSettings): void {
  if (!settingOr<boolean>(settings, 'intellisense.argumentHint.enabled', true)) {
    suggestions.forEach((item) => {
      if (!item.insertText) {
        return
      }
      item.insertText = item.insertText.replace(/\$\{(\d+):[^$}]*\}/g, '$${$1}')
    })
  }
}

/**
 * The renderer adapter passes document URIs; every path operation in the ported
 * providers needs a filesystem path. Plain paths are returned unchanged.
 */
export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) {
    return uri
  }
  let rest = uri.slice('file://'.length)
  // file:///D:/foo -> D:/foo, file:///home/x -> /home/x
  if (/^\/[A-Za-z]:/.test(rest)) {
    rest = rest.slice(1)
  }
  return decodeURIComponent(rest)
}
