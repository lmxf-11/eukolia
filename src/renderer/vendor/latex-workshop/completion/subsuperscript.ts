/**
 * Eukolia — LaTeX Workshop port: `^{...}` / `_{...}` completion.
 *
 * Ported from `out/src/completion/completer/subsuperscript.js` of LaTeX Workshop
 * 10.19.0: `provider.from` (the setting gate, `result[0].startsWith('_')`, the
 * per-label de-duplication of the cache's `elements.subscripts` /
 * `elements.superscripts`) and the collection semantics of `parseAst` (a `^`/`_`
 * macro's first argument, the "one row before, four rows after" documentation,
 * `CompletionItemKind.Constant`).
 *
 * Adaptations required by the port:
 *  - the reference reads the AST of every included file
 *    (`lw.cache.get(...).elements.subscripts`). `CompletionProjectState` has no
 *    script index, so the occurrences are collected from `documentText(uri)`
 *    with the equivalent pattern (`^{...}` / `_{...}`) instead of from the AST;
 *  - positions are therefore line-based rather than node-based, which only
 *    affects the documentation excerpt of a multi-line script.
 */

import { settingOr } from '../settings'
import { CompletionItemKind, type CompletionContext, type LatexCompletionItem } from './types'

function from(result: RegExpMatchArray, context: CompletionContext): LatexCompletionItem[] {
  if (false === settingOr<boolean>(context.args.settings, 'intellisense.subsuperscript.enabled', false)) {
    return []
  }
  const isSub = result[0].startsWith('_')
  return collectScripts(context, isSub)
}

export const provider = { from }

/**
 * The reference concatenates the cached script list of every included file, each
 * of which is de-duplicated. A single document text is scanned here, with the
 * same per-label de-duplication.
 */
function collectScripts(context: CompletionContext, isSub: boolean): LatexCompletionItem[] {
  const content = context.project.documentText(context.args.uri)
  if (content === undefined) {
    return []
  }
  const lines = content.split('\n')
  const scriptReg = isSub ? /_\{([^{}]*)\}/g : /\^\{([^{}]*)\}/g
  const seen = new Set<string>()
  const items: LatexCompletionItem[] = []
  while (true) {
    const result = scriptReg.exec(content)
    if (result === null) {
      break
    }
    const label = result[1]
    if (label === '' || seen.has(label)) {
      continue
    }
    seen.add(label)
    const line = content.substring(0, result.index).split('\n').length
    items.push({
      label,
      kind: CompletionItemKind.Constant,
      // One row before, four rows after
      documentation: lines.slice(line - 2, line + 4).join('\n')
    })
  }
  return items
}
