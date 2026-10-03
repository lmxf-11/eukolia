/**
 * Eukolia — LaTeX Workshop port: environment completion.
 *
 * Ported from `out/src/completion/completer/environment.js` of LaTeX Workshop
 * 10.19.0: `provider.from`, `provide`, `provideEnvsAsMacroInPkg`, `setPackageEnvs`,
 * `getEnvFromPkg`, `envRawToInfo` and `entryEnvToCompletion`, including the
 * `AsName` / `AsMacro` / `ForBegin` snippet variants.
 *
 * Adaptations required by the port:
 *  - `environments.json` is a static import (`dataStore`) instead of a
 *    `fs.readFileSync` in `initialize()`, and the `intellisense.package.exclude`
 *    check re-runs when that setting changes;
 *  - `lw.cache.getIncludedTeX()` (environments defined in the document) is
 *    `CompletionProjectState.documentEnvironments(uri)`;
 *  - package environments are those preloaded through `package.setPackageData`;
 *  - the reference gates the `ForBegin` snippet on
 *    `vscode.window.activeTextEditor.selections.length === 1`; the editor
 *    adapter may pass `selectionCount` on `CompletionArgs` and a normal
 *    single-cursor request is assumed otherwise;
 *  - the package map (`usepackage.getAll`) is passed in by the dispatcher, which
 *    is also what breaks the reference's `package` <-> `environment` cycle.
 */

import { environments as defaultEnvironmentData } from './dataStore'
import {
  CmdEnvSuggestion,
  filterArgumentHint,
  filterNonLetterSuggestions,
  textPosition
} from './completerUtils'
import { CompletionItemKind, type CompletionArgs, type CompletionContext, type LatexCompletionItem } from './types'
import { settingOr, type LwSettings } from '../settings'

/** `EnvSnippetType` of the reference (`out/src/types.js`). */
export enum EnvSnippetType {
  AsName = 'AsName',
  AsMacro = 'AsMacro',
  ForBegin = 'ForBegin'
}

/** `EnvRaw` of the reference (`out/src/types.d.ts`), the shape of `environments.json` and a package's `envs`. */
export interface EnvRaw {
  name: string
  arg?: { format: string; snippet?: string; keys?: string[]; keyPos?: number }
  detail?: string
  documentation?: string
  package?: string
  if?: string
  unusual?: boolean
}

const data = {
  defaultEnvsAsName: [] as CmdEnvSuggestion[],
  defaultEnvsAsMacro: [] as CmdEnvSuggestion[],
  defaultEnvsForBegin: [] as CmdEnvSuggestion[],
  packageEnvs: new Map<string, EnvRaw[]>(),
  packageEnvsAsName: new Map<string, CmdEnvSuggestion[]>(),
  packageEnvsAsMacro: new Map<string, CmdEnvSuggestion[]>(),
  packageEnvsForBegin: new Map<string, CmdEnvSuggestion[]>(),
  initializedWith: undefined as string | undefined
}

/**
 * This function is called by `Macro.initialize` with type=`EnvSnippetType.AsMacro`
 * to build a `\envname` macro for every default environment.
 */
export function getDefaultEnvs(type: EnvSnippetType): CmdEnvSuggestion[] {
  switch (type) {
    case EnvSnippetType.AsName:
      return data.defaultEnvsAsName
    case EnvSnippetType.AsMacro:
      return data.defaultEnvsAsMacro
    case EnvSnippetType.ForBegin:
      return data.defaultEnvsForBegin
    default:
      return []
  }
}

function getPackageEnvs(type: EnvSnippetType): Map<string, CmdEnvSuggestion[]> {
  switch (type) {
    case EnvSnippetType.AsName:
      return data.packageEnvsAsName
    case EnvSnippetType.AsMacro:
      return data.packageEnvsAsMacro
    case EnvSnippetType.ForBegin:
      return data.packageEnvsForBegin
    default:
      return new Map()
  }
}

/**
 * The reference's `initialize()` runs at activation and on configuration change;
 * Eukolia resolves the settings per request, so it re-runs when
 * `intellisense.package.exclude` changes. `macro.initialize` calls it first,
 * mirroring the reference's module-load order.
 */
export function ensureInitialized(settings: LwSettings): void {
  const exclude = settingOr<string[]>(settings, 'intellisense.package.exclude', [])
  const key = JSON.stringify(exclude)
  if (key === data.initializedWith) {
    return
  }
  data.initializedWith = key
  const excludeDefault = exclude.includes('lw-default')
  const envs = excludeDefault
    ? []
    : defaultEnvironmentData.map((env) => envRawToInfo('latex', env as EnvRaw))
  data.defaultEnvsAsMacro = []
  data.defaultEnvsForBegin = []
  data.defaultEnvsAsName = []
  envs.forEach((env) => {
    data.defaultEnvsAsMacro.push(entryEnvToCompletion(env, EnvSnippetType.AsMacro, settings))
    data.defaultEnvsForBegin.push(entryEnvToCompletion(env, EnvSnippetType.ForBegin, settings))
    data.defaultEnvsAsName.push(entryEnvToCompletion(env, EnvSnippetType.AsName, settings))
  })
}

function hasSingleSelection(args: CompletionArgs): boolean {
  return ((args as CompletionArgs & { selectionCount?: number }).selectionCount ?? 1) === 1
}

function from(
  result: RegExpMatchArray,
  context: CompletionContext,
  packages: Record<string, string[]>
): LatexCompletionItem[] {
  const suggestions = provide(context.args.langId, context.args.line, context.args.character, context, packages)
  // Macros starting with a non letter character are not filtered properly because of wordPattern definition.
  return filterNonLetterSuggestions(suggestions, result[1], textPosition(context.args))
}

export const provider = { from }

function provide(
  _langId: string,
  line: string,
  character: number,
  context: CompletionContext,
  packages: Record<string, string[]>
): CmdEnvSuggestion[] {
  const settings = context.args.settings
  ensureInitialized(settings)
  let snippetType = EnvSnippetType.AsName
  if (
    hasSingleSelection(context.args) &&
    line.indexOf('\\begin') > line.indexOf('\\end') &&
    line.slice(character).match(/[a-zA-Z*]*}/) === null
  ) {
    snippetType = EnvSnippetType.ForBegin
  }
  // Extract cached envs and add to default ones
  const suggestions = Array.from(getDefaultEnvs(snippetType))
  const envList = getDefaultEnvs(snippetType).map((env) => env.label)
  // Insert package environments
  if (settingOr<boolean>(settings, 'intellisense.package.enabled', true)) {
    const unusual = settingOr<boolean>(settings, 'intellisense.package.unusual', false)
    Object.entries(packages).forEach(([packageName, options]) => {
      getEnvFromPkg(packageName, snippetType, settings).forEach((env) => {
        if (env.ifCond && !options.includes(env.ifCond)) {
          return
        }
        if (env.unusual && !unusual) {
          return
        }
        if (!envList.includes(env.label)) {
          suggestions.push(env)
          envList.push(env.label)
        }
      })
    })
  }
  // Insert environments defined in tex
  context.project.documentEnvironments(context.args.uri).forEach((name) => {
    if (envList.includes(name)) {
      return
    }
    const env = new CmdEnvSuggestion(name, '', [], -1, { name, args: '' }, CompletionItemKind.Module)
    env.documentation = '`' + name + '`'
    env.filterText = name
    if (snippetType === EnvSnippetType.ForBegin) {
      env.insertText = `${env.label}}\n\t$0\n\\end{${env.label}}`
    } else {
      env.insertText = env.label
    }
    suggestions.push(env)
    envList.push(env.label)
  })
  filterArgumentHint(suggestions, settings)
  return suggestions
}

/**
 * Environments can be inserted using `\envname`.
 * This function is called by `Macro.provide` to compute these macros for every package in use.
 */
export function provideEnvsAsMacroInPkg(
  packageName: string,
  options: string[],
  suggestions: CmdEnvSuggestion[],
  defined: Set<string>,
  settings: LwSettings
): void {
  const useOptionalArgsEntries = settingOr<boolean>(settings, 'intellisense.optionalArgsEntries.enabled', true)
  if (!settingOr<boolean>(settings, 'intellisense.package.env.enabled', true)) {
    return
  }
  // Load environments from the package if not already done
  const envs = getEnvFromPkg(packageName, EnvSnippetType.AsMacro, settings)
  // No environment defined in package
  if (!envs || envs.length === 0) {
    return
  }
  const unusual = settingOr<boolean>(settings, 'intellisense.package.unusual', false)
  // Insert env snippets
  envs.forEach((env) => {
    if (!useOptionalArgsEntries && env.hasOptionalArgs()) {
      return
    }
    if (!defined.has(env.signatureAsString())) {
      if (env.ifCond && !options.includes(env.ifCond)) {
        return
      }
      if (env.unusual && !unusual) {
        return
      }
      suggestions.push(env)
      defined.add(env.signatureAsString())
    }
  })
}

export function getEnvFromPkg(
  packageName: string,
  type: EnvSnippetType,
  settings: LwSettings
): CmdEnvSuggestion[] {
  const packageEnvs = getPackageEnvs(type)
  const entry = packageEnvs.get(packageName)
  if (entry !== undefined) {
    return entry
  }
  // No package macro defined
  const pkgEnvs = data.packageEnvs.get(packageName)
  if (!pkgEnvs || pkgEnvs.length === 0) {
    return []
  }
  const newEntry: CmdEnvSuggestion[] = []
  pkgEnvs.forEach((env) => {
    // \array{} : detail=array{}, name=array.
    newEntry.push(entryEnvToCompletion(env, type, settings))
  })
  packageEnvs.set(packageName, newEntry)
  return newEntry
}

function envRawToInfo(packageName: string, env: EnvRaw): EnvRaw {
  return {
    ...env,
    package: packageName,
    detail: env.name
  }
}

export function setPackageEnvs(packageName: string, envs: EnvRaw[]): void {
  data.packageEnvs.set(packageName, envs.map((env) => envRawToInfo(packageName, env)))
}

function entryEnvToCompletion(item: EnvRaw, type: EnvSnippetType, settings: LwSettings): CmdEnvSuggestion {
  const label = item.detail ? item.detail : item.name
  const suggestion = new CmdEnvSuggestion(
    item.name + (item.arg?.format ?? ''),
    item.package || 'latex',
    item.arg?.keys ?? [],
    item.arg?.keyPos ?? -1,
    { name: item.name, args: item.arg?.format ?? '' },
    CompletionItemKind.Module,
    item.if,
    item.unusual
  )
  suggestion.detail = `\\begin{${item.name}}${item.arg?.snippet?.replace(/\$\{\d+:([^$}]*)\}/g, '$1') ?? ''}\n...\n\\end{${item.name}}`
  suggestion.documentation = `Environment ${item.name} .`
  if (item.package) {
    suggestion.documentation += ` From package: ${item.package}.`
  }
  suggestion.sortText = label.replace(/([a-z])/g, '$10').toLowerCase()
  if (type === EnvSnippetType.AsName) {
    return suggestion
  }
  if (type === EnvSnippetType.AsMacro) {
    suggestion.kind = CompletionItemKind.Snippet
  }
  const useTabStops = settingOr<boolean>(settings, 'intellisense.useTabStops.enabled', false)
  const prefix = type === EnvSnippetType.ForBegin ? '' : 'begin{'
  let snippet = item.arg?.snippet ?? ''
  if (item.arg?.snippet && useTabStops) {
    snippet = item.arg.snippet.replace(/\$\{(\d+):[^}]*\}/g, '$${$1}')
  }
  if (snippet.match(/\$\{?0\}?/)) {
    snippet = snippet.replace(/\$\{?0\}?/, '$${0:$${TM_SELECTED_TEXT}}')
    snippet += '\n'
  } else {
    snippet += '\n\t${0:${TM_SELECTED_TEXT}}\n'
  }
  if (item.detail) {
    suggestion.label = item.detail
  }
  suggestion.filterText = item.detail
  suggestion.insertText = `${prefix}${item.name}}${snippet}\\end{${item.name}}`
  return suggestion
}

/** The reference's `environment` namespace object (the cache-parsing entry points are not part of the port). */

export const environment = {
  getDefaultEnvs,
  setPackageEnvs,
  getEnvFromPkg,
  provideEnvsAsMacroInPkg
}
