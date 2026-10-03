/**
 * Eukolia — LaTeX Workshop port: document class completion.
 *
 * Ported from `out/src/completion/completer/class.js` of LaTeX Workshop 10.19.0
 * (`provider.from` and `initialize`). The reference reads `data/classnames.json`
 * lazily on the first request; here the JSON is the static import `classnames`
 * of `dataStore`, and the conversion result is cached the same way.
 */

import { classnames, type PackageNameEntry } from './dataStore'
import { CompletionItemKind, type LatexCompletionItem } from './types'

const data = {
  suggestions: [] as LatexCompletionItem[]
}

function initialize(classes: Record<string, PackageNameEntry>): void {
  Object.values(classes).forEach((item) => {
    data.suggestions.push({
      label: item.command,
      kind: CompletionItemKind.Module,
      detail: item.detail,
      documentation: `[${item.documentation}](${item.documentation})`
    })
  })
}

function from(): LatexCompletionItem[] {
  if (data.suggestions.length === 0) {
    initialize(classnames)
  }
  return data.suggestions
}

export const provider = { from }
