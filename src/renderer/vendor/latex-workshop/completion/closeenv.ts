/**
 * Eukolia — LaTeX Workshop port: `\end{...}` completion.
 *
 * Ported from `out/src/completion/completer/closeenv.js` of LaTeX Workshop
 * 10.19.0 — the whole file: `provider.from` returns a single item that closes
 * the environment the cursor sits in.
 */

import { CompletionItemKind, type LatexCompletionItem } from './types'

function from(result: RegExpMatchArray): LatexCompletionItem[] {
  if (result[1] === '') {
    return []
  }
  return [
    {
      label: `\\end{${result[1]}}`,
      kind: CompletionItemKind.Module,
      insertText: '\n${0}' + `\n\\end{${result[1]}}`
    }
  ]
}

export const provider = { from }
