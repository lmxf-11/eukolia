/**
 * Eukolia — LaTeX Workshop port: `@`-suggestion completion.
 *
 * Ported from `out/src/completion/completer/atsuggestion.js` of LaTeX Workshop
 * 10.19.0: `provider.from`, `provide` and `initialize` (user snippets of
 * `intellisense.atSuggestion.user` first, then the entries of
 * `data/at-suggestions.json` that the user did not override, and the manual
 * filtering used when several trigger characters are typed in a row).
 *
 * Adaptations required by the port:
 *  - `at-suggestions.json` is the static import `atSuggestions` of `dataStore`
 *    instead of a `fs.readFileSync`;
 *  - `initialize` takes the resolved settings (the reference reads
 *    `vscode.workspace.getConfiguration`) and re-runs when the trigger character
 *    or the user snippet dictionary changes, which is the Eukolia equivalent of
 *    the reference's `lw.onConfigChange` hook.
 */

import { atSuggestions } from './dataStore'
import { textPosition, withTextEdit } from './completerUtils'
import { escapeRegExp } from '../utils/text'
import { settingOr, type LwSettings } from '../settings'
import { CompletionItemKind, type CompletionContext, type LatexCompletionItem } from './types'

const data = {
  triggerCharacter: '',
  escapedTriggerCharacter: '',
  suggestions: [] as LatexCompletionItem[],
  initializedWith: undefined as string | undefined
}

/**
 * `atSuggestion.initialize`: the trigger character and the user's `@` snippets.
 * The reference calls it from `AtProvider.updateTrigger` on activation and on
 * configuration change.
 */
export function initialize(triggerCharacter: string, settings: LwSettings): void {
  const userSnippets = settingOr<Record<string, string>>(settings, 'intellisense.atSuggestion.user', {})
  const key = JSON.stringify([triggerCharacter, userSnippets])
  if (key === data.initializedWith) {
    return
  }
  data.initializedWith = key
  if (triggerCharacter) {
    data.triggerCharacter = triggerCharacter
    data.escapedTriggerCharacter = escapeRegExp(data.triggerCharacter)
  }
  data.suggestions = []
  Object.entries(userSnippets).forEach(([prefix, body]) => {
    if (body === '') {
      return
    }
    data.suggestions.push({
      label: prefix.replace('@', data.triggerCharacter),
      kind: CompletionItemKind.Function,
      insertText: body,
      documentation: 'User defined @suggestion',
      detail: 'User defined @suggestion'
    })
  })
  Object.values(atSuggestions).forEach((item) => {
    if (item.prefix in userSnippets) {
      return
    }
    data.suggestions.push({
      label: item.prefix.replace('@', data.triggerCharacter),
      kind: CompletionItemKind.Function,
      insertText: item.body,
      documentation: item.description,
      detail: item.description
    })
  })
}

function from(result: RegExpMatchArray, context: CompletionContext): LatexCompletionItem[] {
  const suggestions = provide(context.args.line, context.args.character, context)
  // Manually filter suggestions when there are several consecutive trigger characters
  const reg = new RegExp(data.escapedTriggerCharacter + '{2,}$')
  if (result[0].match(reg)) {
    const filteredSuggestions = suggestions.filter((item) => item.label === result[0])
    if (filteredSuggestions.length > 0) {
      return filteredSuggestions.map((item) => {
        const position = textPosition(context.args)
        return withTextEdit(item, {
          start: { line: position.line, character: position.character - item.label.length },
          end: { line: position.line, character: position.character }
        })
      })
    }
  }
  return suggestions
}

export const provider = { from }

function provide(line: string, character: number, context: CompletionContext): LatexCompletionItem[] {
  initialize(settingOr<string>(context.args.settings, 'intellisense.atSuggestion.trigger.latex', '@'), context.args.settings)
  const position = textPosition(context.args)
  let range: { start: { line: number; character: number }; end: { line: number; character: number } } | undefined
  const startPos = line.lastIndexOf(data.triggerCharacter, character - 1)
  if (startPos >= 0) {
    range = {
      start: { line: position.line, character: startPos },
      end: { line: position.line, character }
    }
  }
  data.suggestions.forEach((suggestion) => {
    withTextEdit(suggestion, range)
  })
  return data.suggestions
}

/** The reference's `atSuggestion` namespace object. */
export const atSuggestion = { initialize }
