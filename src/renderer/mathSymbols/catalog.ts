/**
 * Eukolia — the Mathematical Symbols catalog, loaded and indexed.
 *
 * The data itself is generated: `scripts/generate-math-symbol-catalog.mjs`
 * normalises MathJax's TeX symbol maps, LaTeX Workshop's `unimathsymbols.json`
 * and the reviewed files under `mathSymbols/curated/` into
 * `catalog.generated.json`, and writes the accounting manifest beside it. This
 * module never edits that data; it parses it once, indexes it, and answers
 * questions about it.
 *
 * Two deliberate choices are worth stating.
 *
 * **The JSON is imported as text and parsed on first use.** The catalog is a few
 * thousand entries, and handing TypeScript a JSON module of that size makes
 * `tsc` infer a structural type for every one of them — a cost paid on every
 * typecheck for no benefit, since the shape is already written down in
 * `types.ts`. `?raw` plus one `JSON.parse` keeps the typecheck flat, and the
 * parse happens when the panel is first opened rather than when the module is
 * imported.
 *
 * **The index is built once and frozen.** `search.ts` mutates nothing, and the
 * panel rebuilds a *result* list rather than the index, so the catalog can be
 * shared by the panel, the resolver and the tests without anyone owning it.
 * The precomputed search strings live in `search.ts` because they are a search
 * concern; this module is the data layer.
 */

import rawCatalog from './catalog.generated.json?raw'
import rawManifest from './catalog.manifest.json?raw'

import {
  MATH_SYMBOL_CATEGORIES,
  type CatalogManifest,
  type GeneratedCatalog,
  type MathSymbolCategory,
  type MathSymbolEntry,
  type SymbolVariant
} from './types'

/** A command, and the one variant that provides it. */
export interface CatalogCommandRef {
  readonly entry: MathSymbolEntry
  readonly variant: SymbolVariant
}

/** The catalog plus its lookup tables. */
export interface CatalogIndex {
  readonly entries: readonly MathSymbolEntry[]
  readonly byId: ReadonlyMap<string, MathSymbolEntry>
  /** Keyed by the command *with* its leading backslash. */
  readonly byCommand: ReadonlyMap<string, CatalogCommandRef>
  readonly categories: readonly MathSymbolCategory[]
  readonly manifest: CatalogManifest
}

/** Raised when the generated file is missing, empty or the wrong shape. */
export class CatalogLoadError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'CatalogLoadError'
  }
}

const parseManifest = (): CatalogManifest => {
  try {
    return JSON.parse(rawManifest) as CatalogManifest
  } catch (error) {
    throw new CatalogLoadError(
      `the catalog manifest is not valid JSON: ${(error as Error).message}. ` +
        'Run `npm run build:math-symbols`.'
    )
  }
}

/**
 * A cheap structural check.
 *
 * The generator already refuses to emit a broken catalog, so this is not a
 * second implementation of that validation — it is what turns "the generated
 * file is missing, empty, or from an older shape" into one clear message
 * instead of a `undefined is not iterable` deep inside the panel.
 */
function assertUsable(catalog: GeneratedCatalog): void {
  if (!catalog || typeof catalog !== 'object') {
    throw new CatalogLoadError('the catalog is empty. Run `npm run build:math-symbols`.')
  }
  if (catalog.version !== 1) {
    throw new CatalogLoadError(
      `the catalog was generated at version ${String(catalog.version)}, and this build reads version 1. ` +
        'Run `npm run build:math-symbols`.'
    )
  }
  if (!Array.isArray(catalog.entries) || catalog.entries.length === 0) {
    throw new CatalogLoadError('the catalog has no entries. Run `npm run build:math-symbols`.')
  }
  for (const category of MATH_SYMBOL_CATEGORIES) {
    if (!catalog.categories.includes(category)) {
      throw new CatalogLoadError(`the catalog is missing the "${category}" category.`)
    }
  }
}

function buildIndex(): CatalogIndex {
  let parsed: GeneratedCatalog
  try {
    parsed = JSON.parse(rawCatalog) as GeneratedCatalog
  } catch (error) {
    throw new CatalogLoadError(
      `the catalog is not valid JSON: ${(error as Error).message}. ` +
        'Run `npm run build:math-symbols`.'
    )
  }
  assertUsable(parsed)

  const byId = new Map<string, MathSymbolEntry>()
  const byCommand = new Map<string, CatalogCommandRef>()
  for (const entry of parsed.entries) {
    byId.set(entry.id, entry)
    for (const variant of entry.variants) {
      // A variant with no command is a complete expression — the curated
      // `\mathbb{R}`, a multi-part template — and there is no spelling to look
      // it up by.
      if (variant.command === null) continue
      // First writer wins. The generator guarantees one owner per command, so
      // this only decides anything if a hand-edited catalog slipped through.
      if (!byCommand.has(variant.command)) byCommand.set(variant.command, { entry, variant })
    }
  }

  const categories = MATH_SYMBOL_CATEGORIES.filter((category) =>
    parsed.categories.includes(category)
  )

  return Object.freeze({
    entries: Object.freeze(parsed.entries.slice()),
    byId,
    byCommand,
    categories: Object.freeze(categories.slice()),
    manifest: parseManifest()
  })
}

let cached: CatalogIndex | null = null

/**
 * The catalog, parsed and indexed on first call.
 *
 * A thrown `CatalogLoadError` is not cached, so a failure caused by a stale
 * build is not remembered after the rebuild.
 */
export function catalogIndex(): CatalogIndex {
  if (cached) return cached
  const index = buildIndex()
  cached = index
  return index
}

/** One catalog entry by id. */
export function catalogEntry(id: string): MathSymbolEntry | undefined {
  return catalogIndex().byId.get(id)
}

/**
 * The variant that provides a command.
 *
 * Accepts the command with or without its leading backslash, because the search
 * box accepts both and the two must resolve to the same symbol.
 */
export function catalogVariantForCommand(command: string): CatalogCommandRef | undefined {
  const normalised = command.startsWith('\\') ? command : `\\${command}`
  return catalogIndex().byCommand.get(normalised)
}

/** The manifest, for the panel's provenance line and for the catalog tests. */
export function catalogManifest(): CatalogManifest {
  return catalogIndex().manifest
}

/**
 * The catalog's coverage, in one line, for the panel's header tooltip.
 *
 * Stated from the manifest rather than counted at runtime, so the number the
 * user sees is the number the generator accounted for.
 */
export function catalogCoverageSummary(): string {
  const { emitted, sources, excluded } = catalogIndex().manifest
  return (
    `${emitted.entries} symbols in ${emitted.variants} spellings; ` +
    `${sources.unimathsymbols.records} upstream records accounted for, ${excluded.length} excluded`
  )
}
