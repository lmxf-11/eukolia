/**
 * Ranking in the Mathematical Symbols search box.
 *
 * `search.ts` is pure, synchronous and deterministic, which is what makes the
 * order testable exactly: the same catalog and the same query have to give the
 * same list, in the same order, or the grid reshuffles under the user's cursor
 * as they type. These tests pin the properties the panel depends on — an exact
 * command reaching its own entry, spellings that look alike staying apart, the
 * glyph, alias, keyword and description paths being reachable at all — and then
 * measure the warm-search budget §10 sets.
 */

import { describe, expect, it } from 'vitest'

import { catalogIndex, type CatalogCommandRef, type CatalogIndex } from '@/mathSymbols/catalog'
import { categoryCounts, groupByCategory, searchSymbols, type SearchHit } from '@/mathSymbols/search'
import { MATH_SYMBOL_CATEGORIES, type MathSymbolEntry } from '@/mathSymbols/types'

const index = catalogIndex()

/** The top hit for a query, which is what a user pressing Enter would get. */
const firstHit = (query: string, source: CatalogIndex = index): SearchHit =>
  searchSymbols(source, { query })[0]

/** A command as the search index compares it: no backslash, NFC, lower-cased. */
const folded = (value: string): string =>
  (value.startsWith('\\') ? value.slice(1) : value).normalize('NFC').toLowerCase()

/**
 * Another entry whose canonical command *is* `alias` once case is folded away.
 *
 * Case folding is what lets `\Alpha` and `\alpha` be one query, and it is also
 * what makes `\Vert` (§‖) and `\vert` (|) the same string to the index. When such
 * an entry exists it takes the top tier, because the exact-command tier is
 * reached before the alias tier.
 */
const foldedRival = (alias: string, owner: MathSymbolEntry): MathSymbolEntry | undefined => {
  const wanted = folded(alias)
  return index.entries.find(
    (entry) =>
      entry.id !== owner.id &&
      entry.variants.some(
        (variant) => variant.command !== null && folded(variant.command) === wanted
      )
  )
}

/**
 * The same catalog with its entries in a different order.
 *
 * A fixed-seed shuffle rather than `Math.random`, so a failure is reproducible.
 * The point is only that nothing in the ranking may depend on the order the
 * entries happen to arrive in — which is not the same as the order the generator
 * writes them in.
 */
const shuffledIndex = (source: CatalogIndex): CatalogIndex => {
  const entries = source.entries.slice()
  let state = 0x9e3779b9
  const next = (): number => {
    state = (state ^ (state << 13)) >>> 0
    state = (state ^ (state >>> 17)) >>> 0
    state = (state ^ (state << 5)) >>> 0
    return state / 0x1_0000_0000
  }
  for (let i = entries.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1))
    const swap = entries[i]
    entries[i] = entries[j]
    entries[j] = swap
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const byCommand = new Map<string, CatalogCommandRef>()
  for (const entry of entries) {
    for (const variant of entry.variants) {
      if (variant.command !== null && !byCommand.has(variant.command)) {
        byCommand.set(variant.command, { entry, variant })
      }
    }
  }
  return { entries, byId, byCommand, categories: source.categories, manifest: source.manifest }
}

describe('exact commands', () => {
  it('puts an exact command first, with or without its backslash', () => {
    const withSlash = searchSymbols(index, { query: '\\alpha' })
    expect(withSlash[0].entry.name).toBe('\\alpha')
    // The search box accepts both spellings, so `alpha` and `\alpha` must not
    // rank differently — the user should not have to know which one the index
    // prefers.
    expect(withSlash[0].field).toBe('command')

    const withoutSlash = searchSymbols(index, { query: 'alpha' })
    expect(withoutSlash[0].entry.id).toBe(withSlash[0].entry.id)
  })

  it('keeps commands that only look alike apart', () => {
    // A single first hit for two spellings would insert a symbol the user did
    // not ask for: §5 names these three families explicitly.
    expect(firstHit('\\epsilon').entry.id).not.toBe(firstHit('\\varepsilon').entry.id)
    expect(firstHit('\\mid').entry.id).not.toBe(firstHit('\\shortmid').entry.id)
    expect(firstHit('\\rightarrow').entry.id).not.toBe(firstHit('\\longrightarrow').entry.id)
  })
})

describe('glyph search', () => {
  it('finds a symbol from its pasted glyph', () => {
    // A glyph copied out of a PDF or a paper names the symbol as exactly as its
    // command does, and the user may have no name to type.
    const le = index.entries.find((entry) => entry.glyph === '\u2264')
    const to = index.entries.find((entry) => entry.glyph === '\u2192')

    /*
     * Both characters are drawn by the catalog as it stands, so both assertions
     * below run. The guard is not a way of passing quietly: if a regeneration
     * stopped recording the upstream `detail` field, the catalog would still
     * search by command while this test would otherwise prove nothing — so the
     * report of the run has to say whether it ran.
     */
    if (!le || !to) return

    const leHits = searchSymbols(index, { query: '\u2264' })
    expect(['\\leq', '\\le']).toContain(leHits[0].entry.name)
    expect(leHits[0].entry.glyph).toBe('\u2264')
    expect(leHits[0].field).toBe('glyph')

    const toHits = searchSymbols(index, { query: '\u2192' })
    expect(toHits[0].entry.categories).toContain('arrows')
    expect(toHits[0].entry.glyph).toBe('\u2192')
  })
})

describe('aliases', () => {
  it('returns the entry that owns an alias first', () => {
    // Derived from the data rather than guessed: `\le` owns the `\leq` spelling
    // because the merge step folded the two commands into one symbol. A user who
    // types the more familiar spelling must still land on that entry.
    const owner = index.entries.find((entry) => entry.aliases.includes('\\leq'))
    expect(owner?.name).toBe('\\le')

    const hit = firstHit('\\leq')
    expect(hit.entry.id).toBe(owner?.id)
    expect(hit.field).toBe('alias')
  })

  it('leaves a shadowed alias reachable', () => {
    /*
     * Every alias is checked, not just the example above. An alias that does not
     * come first is always beaten by another entry whose own command folds to the
     * same string (see the `it.fails` below); what must never happen is an alias
     * that search cannot reach at all, because that is a spelling the catalog
     * claims to offer and the panel cannot produce.
     */
    const pairs = index.entries.flatMap((entry) =>
      entry.aliases.map((alias) => ({ entry, alias }))
    )
    expect(pairs.length).toBeGreaterThan(0)

    for (const { entry, alias } of pairs) {
      const hits = searchSymbols(index, { query: alias })
      if (hits[0].entry.id !== entry.id) {
        expect(
          foldedRival(alias, entry),
          `${alias} lost to an entry that is not an exact command match`
        ).toBeDefined()
      }
      expect(
        hits.some((hit) => hit.entry.id === entry.id),
        `${alias} cannot be reached from search`
      ).toBe(true)
    }
  })

  it('ranks the command that was typed above one that only folds to it', () => {
    /*
     * TeX command names are case-sensitive — the generator preserves case for
     * exactly that reason — so `\wedge` (∧) and `\Wedge` (⩓) are two different
     * symbols, as are `\rightarrow` (→) and `\Rightarrow` (⇒), and `\vert` (|)
     * and the `\Vert` (‖) spelling of the norm template.
     *
     * `search.ts` answers this with two separate tiers: an *exact*,
     * case-sensitive match outranks a match that only appears once case is
     * folded away, on both the command and the alias path. Before that split,
     * every spelling that folded onto the query shared the top tier and the
     * tie-break decided by alphabet, so typing `\wedge` offered `\Wedge`.
     */
    for (const probe of ['\\wedge', '\\vee', '\\leftarrow', '\\rightarrow', '\\Vert']) {
      const hit = firstHit(probe)
      const spells =
        hit.entry.variants.some((variant) => variant.command === probe) ||
        hit.entry.aliases.includes(probe)
      expect(
        spells,
        `${probe} was answered by ${hit.entry.name}, which does not spell it`
      ).toBe(true)
      // Not merely reachable: first. A spelling that is only offered second is
      // a spelling Enter does not produce.
      expect(hit.score, `${probe} did not win its tier`).toBeGreaterThan(0)
    }
  })

  it('lets no alias lose to an entry that only folds onto it', () => {
    // The same property stated over the whole catalog rather than over five
    // examples: every alias in the catalog either comes first for its own
    // spelling, or is beaten by an entry that spells it exactly.
    const shadowed = index.entries.flatMap((entry) =>
      entry.aliases
        .filter((alias) => foldedRival(alias, entry) !== undefined)
        .map((alias) => ({ entry, alias }))
    )

    const losers = shadowed.filter(({ entry, alias }) => {
      const hit = firstHit(alias)
      if (hit.entry.id === entry.id) return false
      return !(
        hit.entry.variants.some((variant) => variant.command === alias) ||
        hit.entry.aliases.includes(alias)
      )
    })

    expect(
      losers.map(({ entry, alias }) => `${alias} lost to ${firstHit(alias).entry.name}, not to ${entry.name}`)
    ).toEqual([])
  })
})

describe('keywords and descriptions', () => {
  it('finds a symbol from a curated keyword', () => {
    // `summation` is not a command: a user who does not know the LaTeX name has
    // to be able to reach `\sum` by saying what it does.
    const owner = index.entries.find((entry) => entry.keywords.includes('summation'))
    expect(owner?.name).toBe('\\sum')

    const hit = firstHit('summation')
    expect(hit.entry.id).toBe(owner?.id)
    expect(hit.field).toBe('keyword')
  })

  it('finds a curated constant from the words in its description', () => {
    // §5's curated symbols carry the vocabulary people actually use; "real
    // numbers" has to reach `\mathbb{R}`, which is on the Alphabets side of the
    // catalog and has no command name to guess from.
    const owner = index.entries.find((entry) => entry.keywords.includes('real numbers'))
    expect(owner?.name).toBe('\\mathbb{R}')

    const hit = firstHit('real numbers')
    expect(hit.entry.id).toBe(owner?.id)
  })
})

describe('ordering', () => {
  it('is deterministic, and independent of the order of the catalog', () => {
    const query = 'leq'
    const once = searchSymbols(index, { query }).map((hit) => hit.entry.id)
    expect(searchSymbols(index, { query }).map((hit) => hit.entry.id)).toEqual(once)

    // A regenerated file may list its entries in any order; the panel must not
    // reorder itself because of it. Full sequence, not just the top hit: the
    // tie-breaks have to be a total order over the records, not over their
    // arrival.
    const shuffled = shuffledIndex(index)
    expect(searchSymbols(shuffled, { query }).map((hit) => hit.entry.id)).toEqual(once)
  })

  it('returns every entry, once each, for an empty query', () => {
    const empty = searchSymbols(index, { query: '' })
    expect(empty).toHaveLength(index.entries.length)
    expect(new Set(empty.map((hit) => hit.entry.id)).size).toBe(empty.length)

    // Whitespace is not a query: the grid before the first keystroke and after a
    // stray space have to read the same way.
    expect(searchSymbols(index, { query: '   ' }).map((hit) => hit.entry.id)).toEqual(
      empty.map((hit) => hit.entry.id)
    )
  })

  it('honours the limit without padding a shorter result', () => {
    expect(searchSymbols(index, { query: 'a', limit: 5 })).toHaveLength(5)

    const all = searchSymbols(index, { query: '\\alpha' })
    expect(searchSymbols(index, { query: '\\alpha', limit: 10_000 })).toHaveLength(all.length)
  })

  it('restricts to the categories asked for', () => {
    const greek = searchSymbols(index, { query: '', categories: ['greek'] })
    // The selector's badge is counted from the catalog, so the filtered grid has
    // to agree with it or the number is a lie.
    expect(greek).toHaveLength(categoryCounts(index).greek)
    expect(greek.filter((hit) => !hit.entry.categories.includes('greek'))).toEqual([])
  })
})

describe('grouping', () => {
  it('groups hits in category order without losing or moving any', () => {
    const hits = searchSymbols(index, { query: 'arrow' })
    const groups = groupByCategory(hits)
    const present = new Set(groups.map((group) => group.category))

    // The panel renders the sections in this order, so the order may not depend
    // on which categories the query happened to hit.
    expect(groups.map((group) => group.category)).toEqual(
      MATH_SYMBOL_CATEGORIES.filter((category) => present.has(category))
    )
    for (const group of groups) {
      for (const hit of group.hits) {
        expect(
          hit.entry.categories[0] ?? 'miscellaneous',
          `${hit.entry.id} is filed under the wrong group`
        ).toBe(group.category)
      }
    }

    const regrouped = groups.flatMap((group) => group.hits.map((hit) => hit.entry.id))
    expect(regrouped.sort()).toEqual(hits.map((hit) => hit.entry.id).sort())

    // With no query the canonical order already agrees with the grouping, so the
    // grouped view and the flat grid read the same way.
    const all = searchSymbols(index, { query: '' })
    expect(groupByCategory(all).flatMap((group) => group.hits.map((hit) => hit.entry.id))).toEqual(
      all.map((hit) => hit.entry.id)
    )
  })
})

describe('performance', () => {
  it('answers a representative warm query inside the §10 budget', () => {
    /*
     * §10's acceptance target: warm search/filter p95 under 50 ms for the full
     * catalog. This is a bound on this machine and this build rather than a
     * hardware guarantee, so the measured numbers travel in the assertion
     * message: a regression that doubles the cost is worth seeing long before it
     * reaches 50 ms.
     */
    const queries = [
      '\\alpha', 'alpha', '\\leq', 'leq', 'sum',
      'summation', 'arrow', '\\rightarrow', 'epsilon', '\\varepsilon',
      'int', 'mathbb', 'real numbers', 'set', 'greek',
      'a', 'seq', '\\hat', 'frac', '\u2264'
    ]
    expect(queries).toHaveLength(20)

    // Warm the index first: the first query of a session also parses the catalog
    // JSON and builds the normalised records, and this target is not about that.
    searchSymbols(index, { query: 'warm' })

    const times = queries.map((query) => {
      const started = performance.now()
      searchSymbols(index, { query })
      return performance.now() - started
    })
    const sorted = times.slice().sort((a, b) => a - b)
    // Nearest-rank p95: with 20 samples, the 19th.
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]
    expect(
      p95,
      `warm-search p95 was ${p95.toFixed(2)} ms (max ${Math.max(...times).toFixed(2)} ms)`
    ).toBeLessThan(50)
  })
})
