/**
 * Eukolia — LaTeX Workshop port: completion data.
 *
 * Loads the reference's `data/*.json` files, which were copied into
 * `src/renderer/data/latex-workshop/` (Instructions.md §8 — nothing is read from
 * `References/` at runtime).
 *
 * The main lists are static imports. The ~250 per-package definition files are
 * loaded lazily through Vite's `import.meta.glob`, so a build only pays for the
 * packages the document actually uses.
 */

import atSuggestionsJson from '../../../data/latex-workshop/at-suggestions.json'
import bibtexEntriesJson from '../../../data/latex-workshop/bibtex-entries.json'
import biblatexEntriesJson from '../../../data/latex-workshop/biblatex-entries.json'
import classnamesJson from '../../../data/latex-workshop/classnames.json'
import commandsJson from '../../../data/latex-workshop/commands.json'
import environmentsJson from '../../../data/latex-workshop/environments.json'
import latexSnippetJson from '../../../data/latex-workshop/latex-snippet.json'
import macrosJson from '../../../data/latex-workshop/macros.json'
import packagenamesJson from '../../../data/latex-workshop/packagenames.json'
import unimathsymbolsJson from '../../../data/latex-workshop/unimathsymbols.json'

/** One entry of `commands.json` / `macros.json` / a package file's `macros`. */
export interface IntelliSenseEntry {
  name: string
  arg?: { format: string; snippet?: string }
  snippet?: string
  detail?: string
  documentation?: string
  action?: string
  unusual?: boolean
  postAction?: string
}

/** One entry of `environments.json` / a package file's `environments`. */
export interface EnvironmentEntry {
  name: string
  arg?: { format: string; snippet?: string }
  detail?: string
  documentation?: string
}

export interface UnimathSymbol {
  command: string
  detail: string
  documentation: string
}

/** `classnames.json` / `packagenames.json` entry. */
export interface PackageNameEntry {
  command: string
  detail: string
  documentation: string
}

/** A per-package definition file (`data/packages/*.json`). */
export interface PackageData {
  deps?: Array<{ name: string }>
  macros?: IntelliSenseEntry[]
  environments?: EnvironmentEntry[]
}

/** `commands.json` is keyed by command name. */
export type CommandData = Record<string, IntelliSenseEntry>

export const commands: CommandData = commandsJson as unknown as CommandData
export const macros: IntelliSenseEntry[] = macrosJson as unknown as IntelliSenseEntry[]
export const environments: EnvironmentEntry[] = environmentsJson as unknown as EnvironmentEntry[]
export const classnames: Record<string, PackageNameEntry> = classnamesJson as unknown as Record<string, PackageNameEntry>
export const packagenames: Record<string, PackageNameEntry> = packagenamesJson as unknown as Record<string, PackageNameEntry>
export const unimathsymbols: Record<string, UnimathSymbol> = unimathsymbolsJson as unknown as Record<string, UnimathSymbol>
export const latexSnippets: Record<string, { prefix: string; body: string; description?: string }> =
  latexSnippetJson as unknown as Record<string, { prefix: string; body: string; description?: string }>
export const atSuggestions: Record<string, { prefix: string; body: string; description?: string }> =
  atSuggestionsJson as unknown as Record<string, { prefix: string; body: string; description?: string }>
export const bibtexEntries: Record<string, string[]> = bibtexEntriesJson as unknown as Record<string, string[]>
export const biblatexEntries: Record<string, string[]> = biblatexEntriesJson as unknown as Record<string, string[]>

/**
 * Lazily-loadable per-package definitions. Keys are the package names as used by
 * the reference (`amsmath`, `class-beamer`, …).
 */
const packageModules: Record<string, () => Promise<PackageData>> = import.meta.glob<PackageData>(
  '../../../data/latex-workshop/packages/*.json',
  { import: 'default' }
)

const packageLoaders = new Map<string, () => Promise<PackageData>>()
for (const [modulePath, loader] of Object.entries(packageModules)) {
  const fileName = modulePath.slice(modulePath.lastIndexOf('/') + 1)
  packageLoaders.set(fileName.replace(/\.json$/, ''), loader)
}

const packageDataCache = new Map<string, PackageData>()

/** Names of every per-package definition file available. */
export function packageDataNames(): string[] {
  return [...packageLoaders.keys()].sort()
}

/** Load one package's macro/environment definitions. */
export async function loadPackageData(name: string): Promise<PackageData | undefined> {
  const cached = packageDataCache.get(name)
  if (cached) {
    return cached
  }
  const loader = packageLoaders.get(name)
  if (!loader) {
    return undefined
  }
  const data = await loader()
  packageDataCache.set(name, data)
  return data
}

/**
 * Load a package and its `deps` transitively — the reference resolves the import
 * graph through `intellisense.package.deps`.
 */
export async function loadPackageDataWithDeps(
  names: readonly string[],
  options: { includeDeps?: boolean } = {}
): Promise<Map<string, PackageData>> {
  const result = new Map<string, PackageData>()
  const pending = [...names]
  while (pending.length > 0) {
    const name = pending.shift()!
    if (result.has(name)) {
      continue
    }
    const data = await loadPackageData(name)
    if (!data) {
      continue
    }
    result.set(name, data)
    if (options.includeDeps !== false) {
      for (const dep of data.deps ?? []) {
        if (!result.has(dep.name)) {
          pending.push(dep.name)
        }
      }
    }
  }
  return result
}
