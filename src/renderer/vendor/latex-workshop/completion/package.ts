/**
 * Eukolia — LaTeX Workshop port: package awareness.
 *
 * Ported from `out/src/completion/completer/package.js` of LaTeX Workshop
 * 10.19.0 (`provider.from`, `usepackage.getAll`, `getArgs`, `getKeys`,
 * `getDeps`, the `parse`/`parseAst`/`parseContent` dependency extraction and
 * `initialize`).
 *
 * Two things cannot survive the move out of VS Code unchanged:
 *  - the reference reads `data/packages/<name>.json` with `fs.readFileSync`
 *    inside `load()`, so its providers are synchronous. Eukolia's package files
 *    are Vite modules (`dataStore.loadPackageData`), so they are loaded ahead of
 *    a completion request by `preloadPackagesFor` and the providers read the
 *    registry this module owns;
 *  - `intellisense.package.dirs` (extra directories on disk) and the
 *    `kpsewhich.class.enabled` `.cls` lookup have no counterpart without a TeX
 *    installation; the bundled `data/packages/*.json` set is what is available.
 */

import { loadPackageDataWithDeps, packagenames, type PackageNameEntry } from './dataStore'
import { environment, type EnvRaw } from './environment'
import { macro, type MacroRaw } from './macro'
import { CmdEnvSuggestion } from './completerUtils'
import { CompletionItemKind, type CompletionContext, type LatexCompletionItem } from './types'
import { settingOr } from '../settings'

/** One `deps` entry of a package file. */
export interface PackageDep {
  name: string
  /** Only pull the dependency in when the depending package has this option. */
  if?: string
}

/** `PackageRaw` of the reference (`out/src/types.d.ts`). */
export interface PackageRaw {
  deps?: PackageDep[]
  macros?: MacroRaw[]
  envs?: EnvRaw[]
  args?: string[]
  keys?: Record<string, string[]>
  /** The obsolete pre-10.x package file format. */
  includes?: unknown
}

interface RegistryEntry {
  deps: PackageDep[]
  args: string[]
  keys: Record<string, string[]>
}

const data = {
  loaded: [] as string[],
  suggestions: [] as CmdEnvSuggestion[],
  registry: new Map<string, RegistryEntry>()
}

let _obsoletePackageFileWarned = false

/**
 * The reference's `load()`: bookkeeping only. The file itself was read
 * asynchronously by `preloadPackagesFor`, which calls `setPackageData`; reading
 * an unloaded package yields empty suggestions, exactly as an unknown package
 * name does in the reference.
 */
export function load(packageName: string): void {
  if (!data.loaded.includes(packageName)) {
    data.loaded.push(packageName)
  }
}

/** Register one package file's contents — the body of the reference's `load()`. */
export function setPackageData(packageName: string, packageData: PackageRaw): void {
  if ('includes' in packageData && packageData.includes !== undefined) {
    if (!_obsoletePackageFileWarned) {
      console.warn(
        `The intellisense file of package ${packageName} is obsolete. Please update it to the new format: https://github.com/James-Yu/LaTeX-Workshop/wiki/Intellisense#commands-starting-with-`
      )
      _obsoletePackageFileWarned = true
    }
    return
  }
  data.registry.set(packageName, {
    deps: packageData.deps ?? [],
    args: packageData.args ?? [],
    keys: packageData.keys ?? {}
  })
  environment.setPackageEnvs(packageName, packageData.envs ?? [])
  macro.setPackageCmds(packageName, packageData.macros ?? [])
  if (!data.loaded.includes(packageName)) {
    data.loaded.push(packageName)
  }
  // `macro.initialize` builds its default commands from `data/packages/tex.json`
  // in addition to `macros.json`; this hands the file's macros over as defaults
  // as soon as it is available.
  if (packageName === 'tex') {
    macro.setDefaultMathMacros(packageData.macros ?? [])
  }
}

/** True when a package's definitions have been registered. */
export function hasPackageData(packageName: string): boolean {
  return data.registry.has(packageName)
}

export function getArgs(packageName: string): string[] {
  return (data.registry.get(packageName)?.args ?? [])
    .map((key) => data.registry.get(packageName)?.keys[key] ?? [])
    .flat()
}

export function getDeps(packageName: string): PackageDep[] {
  return data.registry.get(packageName)?.deps ?? []
}

export function getKeys(packageName: string, key: string): string[] {
  return data.registry.get(packageName)?.keys[key] ?? []
}

function initialize(defaultPackages: Record<string, PackageNameEntry>): void {
  Object.values(defaultPackages).forEach((item) => {
    const pack = new CmdEnvSuggestion(item.command, '', [], -1, { name: item.command, args: '' }, CompletionItemKind.Module)
    pack.detail = item.detail
    pack.documentation = `[${item.documentation}](${item.documentation})`
    data.suggestions.push(pack)
  })
}

function from(): LatexCompletionItem[] {
  if (data.suggestions.length === 0) {
    initialize(packagenames)
  }
  return data.suggestions
}

export const provider = { from }

/**
 * Packages a document uses, mapped to their options — port of the reference's
 * `lw.cache.get(...).elements.package`. `CompletionProjectState.packages()` only
 * carries the names, so the options (which `dep.if` consults) are recovered from
 * the document text with the reference's own regex.
 */
export function documentPackages(context: CompletionContext): Record<string, string[]> {
  const packages: Record<string, string[]> = {}
  const text = context.project.documentText(context.args.uri)
  if (text !== undefined) {
    Object.assign(packages, parseContent(text))
  }
  // The project state may also know of packages of included files; those carry
  // no options, so a package already seen in the document keeps its own.
  for (const name of context.project.packages(context.args.uri)) {
    if (packages[name] === undefined) {
      packages[name] = []
    }
  }
  const documentClass = context.project.documentClass(context.args.uri)
  if (documentClass && packages[`class-${documentClass}`] === undefined) {
    packages[`class-${documentClass}`] = []
  }
  return packages
}

/**
 * Port of `package.parseContent` (the reference's regex fallback) together with
 * the `\documentclass` branch of `toPackageObj`: a class always enters the
 * dependency graph as `class-<name>`.
 */
export function parseContent(content: string): Record<string, string[]> {
  const packages: Record<string, string[]> = {}
  const pkgReg = /\\(?:usepackage|RequirePackage|documentclass)(\[[^[\]{}]*\])?{(.*?)}/gs
  while (true) {
    const result = pkgReg.exec(content)
    if (result === null) {
      break
    }
    const isClass = result[0].startsWith('\\documentclass')
    const packageNames = result[2].split(',').map((packageName) => packageName.trim())
    const options = (result[1] || '[]')
      .slice(1, -1)
      .replace(/\s*=\s*/g, '=')
      .split(',')
      .map((option) => option.trim())
    const optionsNoTrue = options.filter((option) => option.includes('=true')).map((option) => option.replace('=true', ''))
    packageNames
      .map((packageName) => toPackageObj(isClass ? `class-${packageName}` : packageName, [...options, ...optionsNoTrue]))
      .forEach((packageObj) => Object.assign(packages, packageObj))
  }
  return packages
}

function toPackageObj(packageName: string, options: string[]): Record<string, string[]> {
  packageName = packageName.trim()
  if (packageName === '') {
    return {}
  }
  return { [packageName]: options }
}

/** The packages a request should see, including the dependency closure. */
export function getAll(languageId: string, context: CompletionContext): Record<string, string[]> {
  const settings = context.args.settings
  const excluded = settingOr<string[]>(settings, 'intellisense.package.exclude', [])
  const packages: Record<string, string[]> = {}
  if (!excluded.includes('lw-default')) {
    if (['latex', 'latex-expl3'].includes(languageId)) {
      packages['latex-document'] = []
    }
    if (languageId === 'latex-expl3') {
      packages['expl3'] = []
    }
  }
  settingOr<string[]>(settings, 'intellisense.package.extra', [])
    .filter((packageName) => !excluded.includes(packageName))
    .forEach((packageName) => (packages[packageName] = []))
  Object.entries(documentPackages(context))
    .filter(([packageName]) => !excluded.includes(packageName))
    .forEach(([packageName, options]) => (packages[packageName] = options))
  while (true) {
    let newPackageInserted = false
    Object.entries(packages).forEach(([packageName, options]) =>
      getDeps(packageName)
        .filter((dep) => !excluded.includes(dep.name))
        .forEach((dep) => {
          const hasOption = dep.if === undefined || options.includes(dep.if)
          if (packages[dep.name] === undefined && hasOption) {
            packages[dep.name] = []
            newPackageInserted = true
          }
        })
    )
    if (!newPackageInserted) {
      break
    }
  }
  return packages
}

/**
 * Eukolia's replacement for the reference's synchronous, on-demand
 * `usepackage.load()`: every package a request can mention — the document's own
 * packages, `latex-document`/`expl3`, `intellisense.package.extra`,
 * `class-<documentclass>`, `tex` (the default math macros) and their dependency
 * closure — is loaded before the (synchronous) providers run.
 */
export async function preloadPackagesFor(languageId: string, context: CompletionContext): Promise<void> {
  const settings = context.args.settings
  const excluded = settingOr<string[]>(settings, 'intellisense.package.exclude', [])
  const packages = getAll(languageId, context)
  // `macro.initialize` reads `data/packages/tex.json` for its default commands.
  if (!excluded.includes('tex')) {
    packages['tex'] = []
  }
  const attempted = new Set<string>()
  let pending = Object.keys(packages).filter((name) => !hasPackageData(name))
  while (pending.length > 0) {
    pending.forEach((name) => attempted.add(name))
    const loaded = await loadPackageDataWithDeps(pending, { includeDeps: false })
    for (const [name, packageData] of loaded) {
      setPackageData(name, packageData as unknown as PackageRaw)
    }
    pending = []
    for (const [packageName, options] of Object.entries(packages)) {
      for (const dep of getDeps(packageName)) {
        if (excluded.includes(dep.name) || packages[dep.name] !== undefined || attempted.has(dep.name)) {
          continue
        }
        const hasOption = dep.if === undefined || options.includes(dep.if)
        if (!hasOption) {
          continue
        }
        packages[dep.name] = []
        pending.push(dep.name)
      }
    }
  }
}
