/**
 * Eukolia — LaTeX Workshop port: macro/environment argument key completion.
 *
 * Ported from `out/src/completion/completer/argument.js` of LaTeX Workshop
 * 10.19.0: `provider.from`, `providePackageOptions`, `provideClassOptions` and
 * `getArgumentIndex`. It completes the documented key values of a macro argument
 * (`\usepackage[<here>]{amsmath}`, `\begin{otherlanguage*}[<here>]`, ...).
 *
 * Adaptations required by the port:
 *  - `lw.completion.usepackage.load(name)` is synchronous in the reference;
 *    here the packages of the document are preloaded (`package.preloadPackagesFor`),
 *    so `getArgs`/`getKeys` only see what that preload brought in;
 *  - the package map (`usepackage.getAll`) is passed in by the dispatcher, which
 *    is also what breaks the reference's `package` <-> `argument` cycle.
 */

import { CmdEnvSuggestion, filterArgumentHint } from './completerUtils'
import { EnvSnippetType, getEnvFromPkg } from './environment'
import { getKeys, getArgs } from './package'
import { getPackageCmds } from './macro'
import { CompletionItemKind, type CompletionContext, type LatexCompletionItem } from './types'

function from(
  result: RegExpMatchArray,
  context: CompletionContext,
  packages: Record<string, string[]>
): LatexCompletionItem[] {
  if (result[1] === 'usepackage') {
    return providePackageOptions(context.args.line, context)
  }
  if (result[1] === 'documentclass') {
    return provideClassOptions(context.args.line, context)
  }
  const index = getArgumentIndex(result[2])
  let candidate: CmdEnvSuggestion | undefined
  let environment: string | undefined
  if (result[1] === 'begin') {
    environment = result[2].match(/{(.*?)}/)?.[1]
  }
  for (const packageName of Object.keys(packages)) {
    if (environment) {
      const environments = getEnvFromPkg(packageName, EnvSnippetType.AsMacro, context.args.settings) || []
      for (const env of environments) {
        if (environment !== env.signature.name) {
          continue
        }
        if (index !== env.keyPos + 1) {
          // Start from one.
          continue
        }
        candidate = env
      }
    } else {
      const macros = getPackageCmds(packageName)
      for (const macro of macros) {
        if (result[1] !== macro.signature.name) {
          continue
        }
        if (index !== macro.keyPos) {
          continue
        }
        candidate = macro
        break
      }
    }
    if (candidate !== undefined) {
      break
    }
  }
  if (candidate === undefined) {
    return []
  }
  const keys = (candidate.keys || []).map((key) => getKeys(candidate!.packageName, key)).flat()
  const suggestions: LatexCompletionItem[] = keys.map((key) => {
    return {
      label: key,
      kind: CompletionItemKind.Constant,
      insertText: key
    }
  })
  filterArgumentHint(suggestions, context.args.settings)
  return suggestions
}

export const provider = { from }

function providePackageOptions(line: string, context: CompletionContext): LatexCompletionItem[] {
  const regex = /\\usepackage.*{(.*?)}/
  const match = line.match(regex)
  if (!match) {
    return []
  }
  const suggestions: LatexCompletionItem[] = getArgs(match[1]).map((option) => {
    return {
      label: option,
      kind: CompletionItemKind.Constant,
      insertText: option
    }
  })
  filterArgumentHint(suggestions, context.args.settings)
  return suggestions
}

function provideClassOptions(line: string, context: CompletionContext): LatexCompletionItem[] {
  const regex = /\\documentclass.*{(.*?)}/s
  const match = line.match(regex)
  if (!match) {
    return []
  }
  const isDefaultClass = ['article', 'report', 'book'].includes(match[1])
  const packageName = isDefaultClass ? 'latex-document' : `class-${match[1]}`
  const suggestions: LatexCompletionItem[] = getArgs(packageName).map((option) => {
    return {
      label: option,
      kind: CompletionItemKind.Constant,
      insertText: option
    }
  })
  filterArgumentHint(suggestions, context.args.settings)
  return suggestions
}

function getArgumentIndex(argstr: string): number {
  let argumentIndex = 0
  let curlyLevel = argstr[0] === '{' ? 1 : 0
  let squareLevel = argstr[0] === '[' ? 1 : 0
  for (let index = 1; index < argstr.length; index++) {
    if (argstr[index - 1] === '\\') {
      continue
    }
    switch (argstr[index]) {
      case '{':
        curlyLevel++
        break
      case '[':
        squareLevel++
        break
      case '}':
        curlyLevel--
        if (curlyLevel === 0 && squareLevel === 0) {
          argumentIndex++
        }
        break
      case ']':
        squareLevel--
        if (curlyLevel === 0 && squareLevel === 0) {
          argumentIndex++
        }
        break
      default:
        break
    }
  }
  return argumentIndex
}

/** Exposed for tests, mirroring the reference's module-private helper. */
export { getArgumentIndex }
