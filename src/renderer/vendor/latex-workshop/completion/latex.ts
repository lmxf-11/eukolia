/**
 * Eukolia — LaTeX Workshop port: the completion dispatcher.
 *
 * Ported from `out/src/completion/latex.js` of LaTeX Workshop 10.19.0 — the
 * `Provider.provide` dispatch table with its per-type regular expressions, the
 * "first non-empty type wins" order (`macro` last because it matches anything),
 * the `\\` guard of `provideCompletionItems` and `AtProvider.provide`.
 *
 * Adaptations required by the port:
 *  - `vscode.workspace.getConfiguration('latex-workshop')` is
 *    `CompletionArgs.settings`;
 *  - `resolveCompletionItem` (the MathJax equation preview of `\ref` and the
 *    `\includegraphics` graph preview) needs the extension's preview services and
 *    is not part of the port;
 *  - `intellisense.citation.type === 'browser'` returns no inline suggestions,
 *    exactly as the reference, which instead opens a QuickPick. That list is
 *    available as `citation.browserItems`;
 *  - the fuzzy citation list is returned as plain items carrying `sortText` and
 *    `filterText`; the reference's incomplete `CompletionList` (which makes VS
 *    Code re-query on every keystroke) is an adapter concern;
 *  - `preloadCompletionData` is Eukolia's replacement for the reference's
 *    synchronous `usepackage.load()`: package data is loaded through Vite
 *    modules, so it must be awaited before the synchronous providers run.
 */

import * as argumentProvider from './argument'
import * as atsuggestion from './atsuggestion'
import * as citation from './citation'
import * as classProvider from './class'
import * as closeenv from './closeenv'
import * as environmentProvider from './environment'
import * as glossary from './glossary'
import * as input from './input'
import * as macroProvider from './macro'
import * as packageProvider from './package'
import * as reference from './reference'
import * as subsuper from './subsuperscript'
import { escapeRegExp } from '../utils/text'
import { settingOr } from '../settings'
import type { CompletionContext, LatexCompletionItem } from './types'

/** The completion types of the reference's dispatch table, in order. */
export type CompletionType =
  | 'citation'
  | 'reference'
  | 'environment'
  | 'package'
  | 'documentclass'
  | 'input'
  | 'subimport'
  | 'import'
  | 'includeonly'
  | 'glossary'
  | 'argument'
  | 'macro'
  | 'subsuper'
  | 'closeenv'

/**
 * Note that the order of the following array affects the result.
 * 'macro' must be at the last because it matches any macros.
 */
export const dispatchOrder: CompletionType[] = [
  'citation',
  'reference',
  'environment',
  'package',
  'documentclass',
  'input',
  'subimport',
  'import',
  'includeonly',
  'glossary',
  'argument',
  'macro',
  'subsuper',
  'closeenv'
]

type ProviderFrom = (result: RegExpMatchArray, context: CompletionContext) => LatexCompletionItem[]

/** Port of `Provider.provideCompletionItems` + `Provider.provide`. */
export function provideLatexCompletions(context: CompletionContext): LatexCompletionItem[] {
  const currentLine = context.args.line
  const character = context.args.character
  if (character > 1 && currentLine[character - 1] === '\\' && currentLine[character - 2] === '\\') {
    return []
  }
  for (const type of dispatchOrder) {
    const suggestions = completion(type, context)
    if (suggestions.length > 0) {
      if (type === 'citation') {
        const settings = context.args.settings
        if (settingOr<string>(settings, 'intellisense.citation.type', 'inline') === 'browser') {
          // The reference opens the citation QuickPick (`citation.browser`) and
          // returns no inline suggestions at all.
          return []
        }
        if (settingOr<boolean>(settings, 'intellisense.citation.fuzzy', true)) {
          // The reference wraps the ranked list in an incomplete
          // `vscode.CompletionList` so VS Code re-queries on each keystroke; the
          // plain items already carry the ranking in `sortText`/`filterText`.
          return suggestions
        }
      }
      return suggestions
    }
  }
  return []
}

/** Exposed for tests: one type at a time. */
export function provideCompletionOfType(type: CompletionType, context: CompletionContext): LatexCompletionItem[] {
  return completion(type, context)
}

/** Port of `AtProvider.provide` (with `AtProvider.updateTrigger` applied). */
export function provideAtSuggestions(context: CompletionContext): LatexCompletionItem[] {
  const triggerCharacter = settingOr<string>(context.args.settings, 'intellisense.atSuggestion.trigger.latex', '@')
  atsuggestion.initialize(triggerCharacter, context.args.settings)
  const reg = new RegExp(escapeRegExp(triggerCharacter) + '[^\\s]*$')
  const result = context.args.line.substring(0, context.args.character).match(reg)
  if (result) {
    return atsuggestion.provider.from(result, context)
  }
  return []
}

/**
 * Load the package definitions a completion request can need — the document's
 * packages, `latex-document`/`expl3`, `intellisense.package.extra`, the document
 * class, `tex` and their dependency closure. The providers themselves are
 * synchronous; this is the async half of the reference's `usepackage.load()`.
 */
export async function preloadCompletionData(context: CompletionContext): Promise<void> {
  await packageProvider.preloadPackagesFor(context.args.langId, context)
}

/** Port of `Provider.completion`: the regex per type and its provider. */
function completion(type: CompletionType, context: CompletionContext): LatexCompletionItem[] {
  const args = context.args
  let reg: RegExp
  let provider: ProviderFrom
  switch (type) {
    case 'citation':
      reg =
        /(?:\\[a-zA-Z]*[Cc]ite[a-zA-Z]*\*?(?:\([^[)]*\)){0,2}(?:<[^<>]*>|\[[^[\]]*\]|{[^{}]*})*{([^}]*)$)|(?:\\[a-zA-Z]*cquote*\*?(?:\[[^[\]]*\]){0,2}{([^}]*)$)|(?:\\bibentry{([^}]*)$)/
      provider = citation.provider.from
      break
    case 'reference':
      reg =
        /(?:\\hyperref\[([^\]]*)(?!\])$)|(?:(?:\\(?!hyper)[a-zA-Z]*ref[a-zA-Z]*\*?(?:\[[^[\]]*\])?){([^}]*)$)|(?:\\[Cc][a-z]*refrange\*?{[^{}]*}{([^}]*)$)/
      provider = reference.provider.from
      break
    case 'environment': {
      reg = /(?:\\begin|\\end){([^}]*)$/
      const packages = packageProvider.getAll(args.langId, context)
      provider = (result, ctx) => environmentProvider.provider.from(result, ctx, packages)
      break
    }
    case 'macro': {
      reg = args.langId === 'latex-expl3' ? /\\([a-zA-Z_@]*(?::[a-zA-Z]*)?)$/ : /\\(\+?[a-zA-Z]*|(?:left|[Bb]ig{1,2}l)?[({[]?)$/
      const packages = packageProvider.getAll(args.langId, context)
      provider = (result, ctx) => macroProvider.provider.from(result, ctx, packages)
      break
    }
    case 'argument': {
      reg =
        args.langId === 'latex-expl3'
          ? /\\([a-zA-Z_@]*(?::[a-zA-Z]*)?)((?:\[[^[\]{}]*?\]|{[^[\]{}]*?})*)[[{][^[\]{}]*$/
          : /\\(\+?[a-zA-Z]*)((?:\[[^[\]{}]*?\]|{[^[\]{}]*?})*)[[{][^[\]{}]*$/
      const packages = packageProvider.getAll(args.langId, context)
      provider = (result, ctx) => argumentProvider.provider.from(result, ctx, packages)
      break
    }
    case 'package':
      reg = /(?:\\usepackage|\\RequirePackage|\\RequirePackageWithOptions)(?:\[[^[\]]*\])*{([^}]*)$/
      provider = packageProvider.provider.from
      break
    case 'documentclass':
      reg = /(?:\\documentclass(?:\[[^[\]]*\])*){([^}]*)$/
      provider = classProvider.provider.from
      break
    case 'input':
      reg =
        /\\(input|include|subfile|subfileinclude|(?:adj)?includegraphics|includesvg|lstinputlisting|adjustimage|(?:fg|bg)?imagebox|verbatiminput|loadglsentries|markdownInput)\*?(?:\[[^[\]]*\])*(?:<[^<>]*>)*{([^}]*)$/
      provider = (result, ctx) => input.inputProvider.from(result, ctx)
      break
    case 'includeonly':
      reg = /\\(includeonly|excludeonly){(?:{[^}]*},)*(?:[^,]*,)*{?([^},]*)$/
      provider = (result, ctx) => input.inputProvider.from(result, ctx)
      break
    case 'import':
      reg = /\\(import|includefrom|inputfrom)\*?(?:{([^}]*)})?{([^}]*)$/
      provider = (result, ctx) => input.importProvider.from(result, ctx)
      break
    case 'subimport':
      reg = /\\(sub(?:import|includefrom|inputfrom))\*?(?:{([^}]*)})?{([^}]*)$/
      provider = (result, ctx) => input.subimportProvider.from(result, ctx)
      break
    case 'glossary':
      reg =
        /\\(gls(?:str)?(?:pl|text|first|fmt(?:text|short|long)|plural|firstplural|name|symbol|desc|disp|user(?:i|ii|iii|iv|v|vi))?|Acr(?:long|full|short)?(?:pl)?|ac[slf]?p?)(?:\[[^[\]]*\])?{([^}]*)$/i
      provider = glossary.provider.from
      break
    case 'subsuper':
      reg = /(?:\^|_){([^}]*)$/
      provider = subsuper.provider.from
      break
    case 'closeenv':
      reg = /(?:\\begin){([^}]*)}/
      provider = closeenv.provider.from
      break
    default:
      // This shouldn't be possible, so mark as error case in log.
      console.warn(`Error - trying to complete unknown type ${type as string}`)
      return []
  }
  let lineToPos = args.line.substring(0, args.character)
  if (type === 'argument' && (lineToPos.includes('\\documentclass') || lineToPos.includes('\\usepackage'))) {
    // Remove braced values from documentclass and usepackage
    // This is to allow argument regexp to match the following type of lines:
    // \documentclass[aspectratio=169,t,fontset=none,xcolor={x11names},|]{ctexbeamer}
    lineToPos = lineToPos.replace(/{[^[\]{}]*}/g, '').replace(/\[[^[\]{}]*\]/g, '')
  }
  const result = lineToPos.match(reg)
  if (result) {
    return provider(result, context)
  }
  return []
}
