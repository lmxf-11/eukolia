/**
 * Eukolia — LaTeX Workshop port: `\ref` / `\eqref` completion.
 *
 * Ported from `out/src/completion/completer/reference.js` of LaTeX Workshop
 * 10.19.0: `provider.from`, `provide` and `updateAll`.
 *
 * Adaptations required by the port:
 *  - the reference walks the cache for every included file, resolves the `xr`
 *    external-document prefixes and stores `vscode.CompletionItem`s in a map
 *    keyed by label. Eukolia receives the finished list from
 *    `CompletionProjectState.labels()`, which already carries the file and the
 *    definition line, so `provide` maps it (and keeps the map-clearing semantics
 *    by simply rebuilding from the current project state);
 *  - the label documentation ("one row before, four rows after") is the
 *    `text` field of the entry; the `math` field that drives the async
 *    MathJax preview of `resolveCompletionItem` has no counterpart here.
 */

import { computeFilteringRange, textPosition, withTextEdit } from './completerUtils'
import { CompletionItemKind, type CompletionContext, type LatexCompletionItem } from './types'

function from(_result: RegExpMatchArray, context: CompletionContext): LatexCompletionItem[] {
  return provide(context.args.line, context)
}

export const provider = { from }

function provide(line: string, context: CompletionContext): LatexCompletionItem[] {
  const range = line ? computeFilteringRange(line, textPosition(context.args)) : undefined
  return context.project.labels().map((entry) => {
    const item: LatexCompletionItem = {
      label: entry.name,
      kind: CompletionItemKind.Reference,
      documentation: entry.text,
      detail: entry.section,
      // Provider-private payload replacing the reference's `file`/`position`
      // fields, which `resolveCompletionItem` and the label hover use.
      data: { file: entry.file, line: entry.line }
    }
    return withTextEdit(item, range)
  })
}

/** The reference's `reference` namespace object (the cache-parsing entry points are not part of the port). */
export const reference = { provide }
