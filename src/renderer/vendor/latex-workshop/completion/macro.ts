/**
 * Eukolia — LaTeX Workshop port: macro/command completion.
 *
 * Ported from `out/src/completion/completer/macro.js` of LaTeX Workshop 10.19.0:
 * `provider.from`, `provide`, `isTriggerSuggestNeeded`, `entryCmdToCompletion`,
 * `setPackageCmds`, `getPackageCmds`, `provideCmdInPkg` and `initialize`.
 *
 * Adaptations required by the port:
 *  - `macros.json`, `commands.json` and `unimathsymbols.json` are static imports
 *    (`dataStore`) instead of `fs.readFileSync` in `initialize()`;
 *  - `packages/tex.json`'s macros, which the reference folds into the default
 *    commands, are handed over by `package.setPackageData` once that file is
 *    preloaded (`setDefaultMathMacros`);
 *  - macros defined in the document (`lw.cache.get(...).elements.macro`) come
 *    from `CompletionProjectState.macros()`; the entries carry the definition's
 *    argument *count*, which is what the reference's own regex path
 *    (`newCommandReg`) uses to build the tab stops;
 *  - `initialize()` re-runs when `intellisense.command.user` or
 *    `intellisense.package.exclude` changes membership, which is the Eukolia
 *    equivalent of the reference's `lw.onConfigChange` hook;
 *  - the package map (`usepackage.getAll`) is passed in by the dispatcher, which
 *    is also what breaks the reference's `package` <-> `macro` cycle.
 */

import {
  commands as commandData,
  macros as macroData,
  unimathsymbols,
  type CommandData,
  type IntelliSenseEntry
} from './dataStore'
import {
  CmdEnvSuggestion,
  filterArgumentHint,
  filterNonLetterSuggestions,
  splitSignatureString,
  textPosition,
  withTextEdit
} from './completerUtils'
import { ensureInitialized as ensureEnvironmentsInitialized, provideEnvsAsMacroInPkg, getDefaultEnvs, EnvSnippetType } from './environment'
import {
  CompletionItemKind,
  type CompletionContext,
  type CompletionTextRange,
  type LatexCompletionItem
} from './types'
import { settingOr, type LwSettings } from '../settings'

/** `MacroRaw` of the reference (`out/src/types.d.ts`), the shape of `macros.json` and a package's `macros`. */
export interface MacroRaw extends Omit<IntelliSenseEntry, 'arg'> {
  arg?: { format: string; snippet?: string; keys?: string[]; keyPos?: number }
  doc?: string
  if?: string
  package?: string
}

const data = {
  defaultCmds: [] as CmdEnvSuggestion[],
  defaultSymbols: [] as CmdEnvSuggestion[],
  packageCmds: new Map<string, CmdEnvSuggestion[]>(),
  initializedWith: undefined as string | undefined
}

for (const symbol of Object.values(unimathsymbols)) {
  data.defaultSymbols.push(entryCmdToCompletion({ name: symbol.command, doc: symbol.documentation, detail: symbol.detail }, 'latex'))
}

/**
 * `commands.json` is keyed by the command name with its brace format appended
 * (`section{}`, `documentclass[]{}`), the shape the reference documents for
 * `intellisense.command.user`. The values use the `macros.json` entry fields.
 */
function commandsJsonToEntries(commands: CommandData): MacroRaw[] {
  return Object.entries(commands).map(([key, value]) => {
    const { name, args } = splitSignatureString(key)
    return {
      name,
      arg: { format: args, snippet: value.arg?.snippet ?? value.snippet ?? `${name}${args}` },
      detail: value.detail,
      documentation: value.documentation,
      action: value.action ?? value.postAction,
      unusual: value.unusual
    }
  })
}

/**
 * The reference's `initialize()` sources: `macros.json` plus, in Eukolia's data
 * set, the `commands.json` dictionary. `commands.json` agrees with `macros.json`
 * on every one of the 294 signatures they share (one snippet differs only in
 * `${1}` vs `$1`, which `entryCmdToCompletion` normalises identically), so the
 * union adds commands without changing a single reference suggestion.
 */
const rawDefaults: MacroRaw[] = [
  ...commandsJsonToEntries(commandData),
  ...macroData.map((entry) => cloneRaw(entry as MacroRaw))
]

/** `packages/tex.json`'s macros, handed over by `package.setPackageData`. */
let mathMacros: MacroRaw[] = []

function cloneRaw(entry: MacroRaw): MacroRaw {
  return { ...entry, arg: entry.arg ? { ...entry.arg } : undefined }
}

/**
 * `initialize()` of the reference: the default commands, the default environment
 * pairs and the user overrides of `intellisense.command.user`.
 */
function initialize(userCmds: Record<string, string>, excludeDefault: boolean, settings: LwSettings): void {
  let all: MacroRaw[] = excludeDefault
    ? []
    : [...rawDefaults, ...mathMacros].map((m) => ({ ...cloneRaw(m), package: 'latex' }))
  Object.entries(userCmds).forEach(([key, snippet]) => {
    const candidate = all.find((m) => m.name + (m.arg?.format ?? '') === key)
    if (candidate && snippet !== '') {
      candidate.name = ''
      candidate.arg = { format: snippet, snippet }
      candidate.package = 'user'
    } else if (candidate && snippet === '') {
      all = all.filter((m) => m !== candidate)
    } else {
      all.push({ name: key, package: 'user', arg: { format: '', snippet } })
    }
  })
  data.defaultCmds = []
  // Initialize default macros and the ones in `tex.json`
  all.forEach((m) => data.defaultCmds.push(entryCmdToCompletion(m, m.package, m.action)))
  // Initialize default env begin-end pairs
  ensureEnvironmentsInitialized(settings)
  getDefaultEnvs(EnvSnippetType.AsMacro).forEach((cmd) => {
    data.defaultCmds.push(cmd)
  })
}

function ensureInitialized(settings: LwSettings): void {
  const userCmds = settingOr<Record<string, string>>(settings, 'intellisense.command.user', {})
  const exclude = settingOr<string[]>(settings, 'intellisense.package.exclude', [])
  const key = JSON.stringify([userCmds, exclude, mathMacros.length])
  if (key === data.initializedWith) {
    return
  }
  data.initializedWith = key
  initialize(userCmds, exclude.includes('lw-default'), settings)
}

export function isTriggerSuggestNeeded(name: string): boolean {
  const reg =
    /^(?:[a-z]*(cite|ref|input)[a-z]*|begin|bibitem|(sub)?(import|includefrom|inputfrom)|gls(?:pl|text|first|plural|firstplural|name|symbol|desc|user(?:i|ii|iii|iv|v|vi))?|Acr(?:long|full|short)?(?:pl)?|ac[slf]?p?)/i
  return reg.test(name)
}

function from(
  result: RegExpMatchArray,
  context: CompletionContext,
  packages: Record<string, string[]>
): LatexCompletionItem[] {
  const suggestions = provide(context.args.line, context.args.character, context, packages)
  // Macros ending with (, { or [ are not filtered properly by vscode intellisense. So we do it by hand.
  if (result[0].match(/[({[]$/)) {
    const exactSuggestion = suggestions.filter((entry) => entry.label === result[0])
    if (exactSuggestion.length > 0) {
      return exactSuggestion
    }
  }
  // Macros starting with a non letter character are not filtered properly because of wordPattern definition.
  return filterNonLetterSuggestions(suggestions, result[1], textPosition(context.args))
}

export const provider = { from }

function provide(
  line: string,
  character: number,
  context: CompletionContext,
  packages: Record<string, string[]>
): CmdEnvSuggestion[] {
  const settings = context.args.settings
  ensureInitialized(settings)
  const useOptionalArgsEntries = settingOr<boolean>(settings, 'intellisense.optionalArgsEntries.enabled', true)
  const position = textPosition(context.args)
  let range: CompletionTextRange | undefined
  if (line) {
    const startPos = line.lastIndexOf('\\', character - 1)
    if (startPos >= 0) {
      range = {
        start: { line: position.line, character: startPos + 1 },
        end: { line: position.line, character }
      }
    }
  }
  const suggestions: CmdEnvSuggestion[] = []
  let defined = new Set<string>()
  // Insert default macros
  data.defaultCmds.forEach((cmd) => {
    if (!useOptionalArgsEntries && cmd.hasOptionalArgs()) {
      return
    }
    withTextEdit(cmd, range)
    suggestions.push(cmd)
    defined.add(cmd.signatureAsString())
  })
  // Insert unimathsymbols
  if (settingOr<boolean>(settings, 'intellisense.unimathsymbols.enabled', false)) {
    data.defaultSymbols.forEach((symbol) => {
      suggestions.push(symbol)
      defined.add(symbol.signatureAsString())
    })
  }
  // Insert macros from packages
  if (settingOr<boolean>(settings, 'intellisense.package.enabled', true)) {
    Object.entries(packages).forEach(([packageName, options]) => {
      provideCmdInPkg(packageName, options, suggestions, settings)
      provideEnvsAsMacroInPkg(packageName, options, suggestions, defined, settings)
    })
  }
  // Start working on macros in tex. To avoid over populating suggestions, we do not include
  // user defined macros, whose name matches a default macro or one provided by a package
  defined = new Set(suggestions.map((s) => s.signatureAsString()))
  context.project.macros().forEach((entry) => {
    const args = '{}'.repeat(entry.args)
    const cmd = new CmdEnvSuggestion(
      `\\${entry.name}${args}`,
      'user-defined',
      [],
      -1,
      { name: entry.name, args },
      CompletionItemKind.Function
    )
    cmd.documentation = '`' + entry.name + '`'
    let tabStops = ''
    for (let i = 1; i <= entry.args; ++i) {
      tabStops += '{${' + i + '}}'
    }
    cmd.insertText = entry.name + tabStops
    cmd.filterText = entry.name
    if (isTriggerSuggestNeeded(entry.name)) {
      cmd.command = { title: 'Post-Action', command: 'editor.action.triggerSuggest' }
    }
    if (!defined.has(cmd.signatureAsString())) {
      withTextEdit(cmd, range)
      suggestions.push(cmd)
      defined.add(cmd.signatureAsString())
    }
  })
  filterArgumentHint(suggestions, settings)
  return suggestions
}

export function entryCmdToCompletion(item: MacroRaw, packageName?: string, postAction?: string): CmdEnvSuggestion {
  const suggestion = new CmdEnvSuggestion(
    `\\${item.name}${item.arg?.format ?? ''}`,
    packageName || 'latex',
    item.arg?.keys ?? [],
    item.arg?.keyPos ?? -1,
    { name: item.name, args: item.arg?.format ?? '' },
    CompletionItemKind.Function,
    item.if,
    item.unusual
  )
  if (item.arg?.snippet) {
    // Wrap the selected text when there is a single placeholder
    if (!(item.arg.snippet.match(/\$\{?2/) || (item.arg.snippet.match(/\$\{?0/) && item.arg.snippet.match(/\$\{?1/)))) {
      item.arg.snippet = item.arg.snippet
        .replace(/\$1|\$\{1\}/, '$${1:$${TM_SELECTED_TEXT}}')
        .replace(/\$\{1:([^$}]+)\}/, '$${1:$${TM_SELECTED_TEXT:$1}}')
    }
    item.arg.snippet = item.arg.snippet
      // Remove the %:translatable component
      .replace(/%:translatable/g, '')
      // Remove the %randomword component
      .replace(/%\w+/g, '')
    suggestion.insertText = item.arg.snippet
  } else {
    suggestion.insertText = item.name
  }
  suggestion.filterText = item.name + (item.arg?.format ?? '') + (item.detail ?? '')
  suggestion.detail =
    item.detail ?? (item.arg?.snippet ? `\\${item.arg.snippet.replace(/\$\{\d+:([^$}]*)\}/g, '$1')}` : `\\${item.name}`)
  suggestion.documentation = item.doc ?? item.documentation ?? `Macro \\${item.name}${item.arg?.format ?? ''}.`
  if (packageName) {
    suggestion.documentation += ` From package: ${packageName}.`
  }
  suggestion.sortText = (item.name + (item.arg?.format ?? ''))
    .replace(/([a-z])/g, '$10')
    .toLowerCase()
    .replaceAll('{', '0')
    .replaceAll('[', '1')
    .replace(/^(.+?)\(/g, '$12') // Skip \(
    .replaceAll('|', '3')
    .replaceAll('*', '9')
  if (postAction) {
    suggestion.command = { title: 'Post-Action', command: postAction }
  } else if (isTriggerSuggestNeeded(item.name)) {
    // Automatically trigger completion if the macro is for citation, filename, reference or glossary
    suggestion.command = { title: 'Post-Action', command: 'editor.action.triggerSuggest' }
  }
  return suggestion
}

export function setPackageCmds(packageName: string, macros: MacroRaw[]): void {
  data.packageCmds.set(
    packageName,
    macros.map((m) => entryCmdToCompletion(m, packageName))
  )
}

export function getPackageCmds(packageName: string): CmdEnvSuggestion[] {
  return data.packageCmds.get(packageName) || []
}

/** The default commands of `packages/tex.json` — see `initialize`. */
export function setDefaultMathMacros(macros: MacroRaw[]): void {
  mathMacros = macros.map((m) => cloneRaw(m))
}

function provideCmdInPkg(
  packageName: string,
  options: string[],
  suggestions: CmdEnvSuggestion[],
  settings: LwSettings
): void {
  const defined = new Set<string>()
  const useOptionalArgsEntries = settingOr<boolean>(settings, 'intellisense.optionalArgsEntries.enabled', true)
  // No package macro defined
  const macros = data.packageCmds.get(packageName)
  if (!macros || macros.length === 0) {
    return
  }
  const unusual = settingOr<boolean>(settings, 'intellisense.package.unusual', false)
  // Insert macros
  macros.forEach((mac) => {
    if (!useOptionalArgsEntries && mac.hasOptionalArgs()) {
      return
    }
    if (!defined.has(mac.signatureAsString())) {
      if (mac.ifCond && !options.includes(mac.ifCond)) {
        return
      }
      if (mac.unusual && !unusual) {
        return
      }
      suggestions.push(mac)
      defined.add(mac.signatureAsString())
    }
  })
}

/** The reference's `macro` namespace object (the cache-parsing entry points are not part of the port). */
export const macro = {
  getPackageCmds,
  setPackageCmds,
  setDefaultMathMacros,
  provideCmdInPkg,
  isTriggerSuggestNeeded
}
