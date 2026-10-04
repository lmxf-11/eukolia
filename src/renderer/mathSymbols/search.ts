/**
 * Eukolia — Mathematical Symbols search.
 *
 * Pure, synchronous and deterministic: the same catalog and the same query give
 * the same list, in the same order, every time. Nothing here reads the project,
 * the editor or the clock, which is what lets the panel rank a few thousand
 * entries on every keystroke without a debounce and lets the ranking be tested
 * exactly.
 *
 * The index is built once per process and holds a *normalised* copy of every
 * field a query can match — name, the command with and without its backslash,
 * the spellings, the glyph, the keywords and the description — because folding
 * case and Unicode on every keystroke is the whole cost of a warm search and
 * there is no reason to pay it more than once (the performance contract in
 * `MathematicalSymbols.md` §10 asks for p95 under 50 ms on the full catalog).
 *
 * Ranking is tiered rather than weighted-and-summed, so the order is explainable:
 * an exact command beats a prefix, a prefix beats a word inside a keyword, and a
 * keyword beats the description. Within a tier, the shorter field wins — typing
 * `al` should reach `\alpha` before `\aleph`-like longer names only when the
 * longer one is not also a prefix — and the final tie-break is the entry id, so
 * the order never depends on the order the catalog happened to be generated in.
 */

import { catalogIndex, type CatalogIndex } from './catalog'
import { MATH_SYMBOL_CATEGORIES, type MathSymbolCategory, type MathSymbolEntry, type SymbolVariant } from './types'

/** Which field a hit was found in, for the details pane and for tests. */
export type SearchMatchField =
  | 'command'
  | 'glyph'
  | 'alias'
  | 'keyword'
  | 'description'
  | 'fuzzy'
  | 'none'

export interface SearchHit {
  readonly entry: MathSymbolEntry
  /** The spelling the panel should insert from this hit. */
  readonly variant: SymbolVariant
  readonly score: number
  readonly field: SearchMatchField
}

export interface SymbolSearchOptions {
  readonly query: string
  /** Restrict to entries carrying every one of these categories. */
  readonly categories?: readonly MathSymbolCategory[]
  /** Maximum hits; `0` or undefined means no limit. */
  readonly limit?: number
}

interface SearchRecord {
  readonly entry: MathSymbolEntry
  readonly id: string
  /** The canonical command without its backslash, lower-cased. */
  readonly command: string
  /**
   * The same command with its case preserved.
   *
   * TeX command names are case-sensitive: `\wedge` and `\Wedge` are two
   * different symbols, and so are `\rightarrow` and `\Rightarrow`. Folding case
   * for the *fuzzy* comparison is what makes a search tolerant; folding it for
   * the *exact* comparison is what makes the typed spelling lose to a longer
   * one that happens to fold onto it, which is the bug this field exists to
   * prevent.
   */
  readonly commandExact: string
  readonly glyph: string | null
  readonly aliases: readonly string[]
  readonly aliasesExact: readonly string[]
  readonly keywords: readonly string[]
  readonly description: string
  readonly categoryRank: number
  /** Everything above, joined, for the subsequence fallback. */
  readonly haystack: string
}

const normalize = (value: string): string => value.normalize('NFC').toLowerCase()

/** Strips one leading backslash, so `\alpha` and `alpha` are one query. */
const bare = (value: string): string => (value.startsWith('\\') ? value.slice(1) : value)

/** Splits a description or keyword list into words, for word-boundary matching. */
const words = (value: string): string[] => value.split(/[^a-z0-9]+/i).filter(Boolean)

function buildRecords(index: CatalogIndex): SearchRecord[] {
  return index.entries.map((entry) => {
    const commandExact = bare(entry.variants[0]?.command ?? entry.name)
    const command = normalize(commandExact)
    const aliasesExact = entry.aliases.map(bare)
    const aliases = aliasesExact.map(normalize)
    const keywords = entry.keywords.map(normalize)
    const description = normalize(entry.description ?? '')
    const categoryRank = entry.categories.length
      ? Math.min(...entry.categories.map((category) => MATH_SYMBOL_CATEGORIES.indexOf(category)))
      : MATH_SYMBOL_CATEGORIES.length
    return {
      entry,
      id: entry.id,
      command,
      commandExact,
      glyph: entry.glyph ? entry.glyph.normalize('NFC') : null,
      aliases,
      aliasesExact,
      keywords,
      description,
      categoryRank,
      haystack: [command, ...aliases, ...keywords, description, entry.glyph ?? ''].join(' ')
    }
  })
}

let recordCache = new WeakMap<CatalogIndex, SearchRecord[]>()

/**
 * The search records for a catalog, built once per catalog instance.
 *
 * Keyed by the index rather than held in a module variable, so a test that
 * builds a small catalog and the application that uses the generated one never
 * see each other's records — and so nothing has to be invalidated by hand.
 */
export function searchRecords(index: CatalogIndex = catalogIndex()): readonly SearchRecord[] {
  const cached = recordCache.get(index)
  if (cached) return cached
  const built = buildRecords(index)
  recordCache.set(index, built)
  return built
}

/** Drops every memoised record set. Used by tests between catalogs. */
export function resetSearchIndex(): void {
  recordCache = new WeakMap()
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

/*
 * The tiers, highest first. The gaps are wide enough that no in-tier bonus can
 * cross a tier boundary, which is what makes the order explainable.
 *
 * The *exact* tiers are case-sensitive and the *folded* ones are not, and the
 * split is load-bearing rather than tidy. TeX command names are case-sensitive —
 * `\wedge` (∧) and `\Wedge` (⩓) are different symbols, so are `\rightarrow`
 * (→) and `\Rightarrow` (⇒), and so are `\vert` (|) and the `\Vert` (‖)
 * spelling of the norm template. Folding both sides of one exact tier lets a
 * command that merely *folds* onto the query take the top tier alongside the one
 * the user typed, and the tie-break then decides by alphabet — which is how
 * typing `\wedge` came to offer `\Wedge`, and `\Vert` came to offer `\vert`.
 * A case-folded command match therefore ranks below both exact tiers.
 */
const TIER = {
  commandExact: 10_000,
  glyphExact: 9_500,
  aliasExact: 9_000,
  commandFolded: 8_000,
  aliasFolded: 7_500,
  commandPrefix: 7_000,
  glyphPrefix: 6_500,
  aliasPrefix: 6_000,
  keywordExact: 5_000,
  keywordPrefix: 4_500,
  keywordWord: 4_000,
  commandInside: 3_000,
  descriptionWord: 2_500,
  aliasInside: 2_000,
  descriptionInside: 1_500,
  fuzzy: 1_000
} as const

/**
 * The score for one record, or `null` when it does not match.
 *
 * The in-tier bonus is `-length`, so the shorter field wins among equals — and
 * it is bounded (`Math.min(length, 999)`) so it can never reach the next tier.
 *
 * `exact` is the query with its case preserved, and it is checked *before* the
 * folded one. Without that order the exact tier is shared by every spelling that
 * folds onto the query, and the tie-break then decides by alphabet — which is
 * how `\wedge` came to rank `\Wedge`, `\vee` to rank `\Vee`, and `\leftarrow` to
 * rank `\Leftarrow` first. TeX command names are case-sensitive, so the spelling
 * the user typed has to win over one that merely folds to it.
 */
function scoreRecord(
  record: SearchRecord,
  query: string,
  exact: string,
  raw: boolean
): {
  score: number
  field: SearchMatchField
} | null {
  const bonus = (length: number): number => -Math.min(length, 999)

  if (record.commandExact === exact) {
    return { score: TIER.commandExact + bonus(record.command.length), field: 'command' }
  }
  // A pasted glyph is exactly as strong as typing the command: both name the
  // symbol unambiguously, and a user who pasted `≤` means `\leq`.
  if (raw && record.glyph === query) {
    return { score: TIER.glyphExact, field: 'glyph' }
  }
  for (let index = 0; index < record.aliasesExact.length; index += 1) {
    if (record.aliasesExact[index] === exact) {
      return { score: TIER.aliasExact + bonus(record.aliases[index].length), field: 'alias' }
    }
  }
  if (record.command === query) {
    return { score: TIER.commandFolded + bonus(record.command.length), field: 'command' }
  }
  for (let index = 0; index < record.aliases.length; index += 1) {
    if (record.aliases[index] === query) {
      return { score: TIER.aliasFolded + bonus(record.aliases[index].length), field: 'alias' }
    }
  }
  if (record.command.startsWith(query)) {
    return { score: TIER.commandPrefix + bonus(record.command.length), field: 'command' }
  }
  if (raw && record.glyph && record.glyph.startsWith(query)) {
    return { score: TIER.glyphPrefix, field: 'glyph' }
  }
  for (const alias of record.aliases) {
    if (alias.startsWith(query)) {
      return { score: TIER.aliasPrefix + bonus(alias.length), field: 'alias' }
    }
  }
  for (const keyword of record.keywords) {
    if (keyword === query) return { score: TIER.keywordExact + bonus(keyword.length), field: 'keyword' }
  }
  for (const keyword of record.keywords) {
    if (keyword.startsWith(query)) {
      return { score: TIER.keywordPrefix + bonus(keyword.length), field: 'keyword' }
    }
  }
  for (const keyword of record.keywords) {
    if (words(keyword).includes(query)) return { score: TIER.keywordWord, field: 'keyword' }
  }
  if (record.command.includes(query)) {
    return { score: TIER.commandInside + bonus(record.command.length), field: 'command' }
  }
  if (record.description && words(record.description).includes(query)) {
    return { score: TIER.descriptionWord, field: 'description' }
  }
  for (const alias of record.aliases) {
    if (alias.includes(query)) return { score: TIER.aliasInside + bonus(alias.length), field: 'alias' }
  }
  if (record.description && record.description.includes(query)) {
    return { score: TIER.descriptionInside, field: 'description' }
  }
  const fuzzy = subsequenceScore(query, record.haystack)
  if (fuzzy > 0) return { score: TIER.fuzzy + fuzzy, field: 'fuzzy' }
  return null
}

/**
 * A positive score when `query` is a subsequence of `haystack`.
 *
 * Deliberately the *last* resort: it is the only rule that can match a record
 * for a reason the user cannot see, so it runs only after every literal rule has
 * failed, and it prefers hits that start a word.
 */
function subsequenceScore(query: string, haystack: string): number {
  let score = 0
  let from = 0
  let streak = 0
  for (const character of query) {
    const at = haystack.indexOf(character, from)
    if (at === -1) return 0
    const boundary = at === 0 || /[\s\\.\-_&]/.test(haystack[at - 1])
    if (boundary) score += 8
    streak = at === from ? streak + 1 : 0
    score += 2 + streak
    if (score > 900) return 900
    from = at + 1
  }
  return score
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

/**
 * The canonical order used when there is no query.
 *
 * Category first, then the command, then the id. The panel groups by category
 * when it shows everything, so an order that already agrees with the grouping
 * keeps the grid and the grouped view reading the same way.
 */
function canonicalOrder(a: SearchRecord, b: SearchRecord): number {
  return (
    a.categoryRank - b.categoryRank ||
    a.command.localeCompare(b.command) ||
    a.id.localeCompare(b.id)
  )
}

/**
 * Ranks the catalog against a query.
 *
 * An empty (or whitespace-only) query is not a special case that returns
 * nothing: it returns the whole catalog in canonical order, because that is what
 * the grid shows before the user has typed anything and the panel should not
 * have to ask a different function for it.
 */
export function searchSymbols(
  index: CatalogIndex,
  options: SymbolSearchOptions
): SearchHit[] {
  const trimmed = options.query.trim()
  const categories = options.categories ?? []
  const wanted = categories.length
    ? new Set<MathSymbolCategory>(categories)
    : null

  const owned = searchRecords(index)
  const candidates = wanted
    ? owned.filter((record) => record.entry.categories.some((category) => wanted.has(category)))
    : owned

  let hits: SearchHit[]
  if (trimmed.length === 0) {
    hits = candidates
      .slice()
      .sort(canonicalOrder)
      .map((record) => ({
        entry: record.entry,
        variant: record.entry.variants[0],
        score: 0,
        field: 'none' as const
      }))
  } else {
    const query = normalize(bare(trimmed))
    const exact = bare(trimmed).normalize('NFC')
    const rawQuery = trimmed.normalize('NFC')
    const scored: Array<{ record: SearchRecord; score: number; field: SearchMatchField }> = []
    for (const record of candidates) {
      const match = scoreRecord(record, query, exact, /[^\x00-\x7f]/.test(rawQuery))
      if (match) scored.push({ record, ...match })
    }
    hits = scored
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.record.command.length - b.record.command.length ||
          canonicalOrder(a.record, b.record)
      )
      .map(({ record, score, field }) => ({
        entry: record.entry,
        variant: record.entry.variants[0],
        score,
        field
      }))
  }

  return options.limit && options.limit > 0 ? hits.slice(0, options.limit) : hits
}

/**
 * How many entries carry each category.
 *
 * Counted from the catalog rather than from a search result, so the selector's
 * numbers do not move as the query changes.
 */
export function categoryCounts(index: CatalogIndex): Readonly<Record<MathSymbolCategory, number>> {
  const counts = Object.fromEntries(
    MATH_SYMBOL_CATEGORIES.map((category) => [category, 0])
  ) as Record<MathSymbolCategory, number>
  for (const entry of index.entries) {
    for (const category of entry.categories) counts[category] += 1
  }
  return counts
}

/** Groups hits by the entry's first category, in category order. */
export function groupByCategory(
  hits: readonly SearchHit[]
): Array<{ category: MathSymbolCategory; hits: SearchHit[] }> {
  const groups = new Map<MathSymbolCategory, SearchHit[]>()
  for (const hit of hits) {
    const category = hit.entry.categories[0] ?? 'miscellaneous'
    const list = groups.get(category)
    if (list) list.push(hit)
    else groups.set(category, [hit])
  }
  return [...MATH_SYMBOL_CATEGORIES]
    .filter((category) => groups.has(category))
    .map((category) => ({ category, hits: groups.get(category)! }))
}
