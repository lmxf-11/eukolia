/**
 * The generated catalog, checked against the manifest that accounts for it.
 *
 * `catalogIndex()` is the data every other part of the Mathematical Symbols
 * feature reads — the grid, the resolver, the availability badge — and nothing
 * validates it at runtime: the generator is the only guard, and it runs at build
 * time, not here. These tests are the standing check that the JSON actually in
 * the tree still says what the feature assumes, which is what a stale build or a
 * hand edit would break.
 *
 * The upstream `unimathsymbols.json` is imported through `?raw` rather than read
 * from disk. It is bundled application data, so the accounting can be re-derived
 * without a machine path and without depending on the working directory — and
 * re-deriving from the source is the only way the "every record accounted for"
 * claim is worth anything.
 */

import { describe, expect, it } from 'vitest'

import rawUpstream from '@/data/latex-workshop/unimathsymbols.json?raw'
import { catalogIndex, catalogManifest, type CatalogCommandRef } from '@/mathSymbols/catalog'
import {
  MATH_SYMBOL_CATEGORIES,
  type MathSymbolEntry,
  type SymbolVariant
} from '@/mathSymbols/types'

const index = catalogIndex()
const manifest = catalogManifest()

/** Every variant paired with the entry that owns it: requirements live on variants. */
const allVariants: Array<{ entry: MathSymbolEntry; variant: SymbolVariant }> = index.entries.flatMap(
  (entry) => entry.variants.map((variant) => ({ entry, variant }))
)

/** The upstream records, keyed by the command spelling `unimathsymbols.json` uses. */
const upstreamRecords = JSON.parse(rawUpstream) as Record<
  string,
  { detail?: string; documentation?: string }
>

/** The entry for a command, or a failure naming the command that is missing. */
const commandRef = (command: string): CatalogCommandRef => {
  const ref = index.byCommand.get(command)
  if (!ref) throw new Error(`the catalog has no command ${command}`)
  return ref
}

/**
 * The id the generator would give a command.
 *
 * Deliberately copied rather than imported: `scripts/generate-math-symbol-catalog.mjs`
 * is a build script, not application code, and re-deriving the id here is what
 * makes this check independent of the file it is checking.
 */
const idSafe = (command: string): string =>
  command.replace(/^\\/, '').replace(/[^A-Za-z0-9@]+/g, '-')

describe('catalog loading', () => {
  it('exposes entries and exactly the documented categories', () => {
    expect(index.entries.length).toBeGreaterThan(0)
    // The selector's order is this array's order; a category the panel does not
    // know about would be dropped from the selector without a word.
    expect(index.categories).toEqual([...MATH_SYMBOL_CATEGORIES])
  })

  it('indexes every entry by id and every command it can insert', () => {
    expect(index.byId.size).toBe(index.entries.length)
    // `byCommand` is how a typed command becomes a variant; an unindexed one is
    // a symbol that cannot be inserted. A template whose body starts with no
    // control sequence has no command to index, which is why `null` is allowed.
    const unindexed = allVariants
      .filter(({ variant }) => variant.command !== null && !index.byCommand.has(variant.command))
      .map(({ variant }) => variant.id)
    expect(unindexed).toEqual([])
  })

  it('tags every entry with known, non-empty categories', () => {
    const known = new Set<string>(MATH_SYMBOL_CATEGORIES)
    const problems = index.entries.flatMap((entry) => {
      if (entry.categories.length === 0) return [`${entry.id} has no category`]
      return entry.categories
        .filter((category) => !known.has(category))
        .map((category) => `${entry.id} has unknown category "${category}"`)
    })
    expect(problems).toEqual([])
  })
})

describe('manifest accounting', () => {
  it('pins the upstream source it claims to have accounted for', () => {
    // 2 415 extended Unicode commands in the pinned upstream file. A different
    // number means the source changed, not that the catalog was regenerated.
    expect(Object.keys(upstreamRecords)).toHaveLength(2415)
    expect(manifest.sources.unimathsymbols.records).toBe(Object.keys(upstreamRecords).length)
  })

  it('accounts for every upstream record as emitted, merged or excluded', () => {
    const merged = new Set(Object.keys(manifest.mergedIds))
    const excluded = new Set(
      manifest.excluded.filter((item) => item.source === 'unimathsymbols').map((item) => item.id)
    )

    const unaccounted: string[] = []
    for (const name of Object.keys(upstreamRecords)) {
      // The generator names the entry `<source>:<idSafe(command)>`, with the case
      // preserved because TeX command names are case-sensitive. A record that is
      // neither present, nor merged away, nor excluded fell through the
      // accounting — the "silently dropping familiar symbols" failure §5 forbids.
      const candidates = [`mjs:${idSafe(name)}`, `ums:${idSafe(name)}`]
      if (candidates.some((id) => index.byId.has(id))) continue
      if (candidates.some((id) => merged.has(id))) continue
      if (excluded.has(name)) continue
      unaccounted.push(name)
    }

    expect(unaccounted).toEqual([])
  })

  it('records no generation problems and counts exactly what it emitted', () => {
    expect(manifest.problems).toEqual([])
    expect(manifest.emitted.entries).toBe(index.entries.length)
    expect(manifest.emitted.variants).toBe(allVariants.length)
    expect(manifest.emitted.slots).toBe(
      allVariants.reduce((total, { variant }) => total + variant.slots.length, 0)
    )
    // The selector's per-category numbers come from the manifest, so a count that
    // disagrees with the catalog is a badge the grid will contradict.
    for (const category of MATH_SYMBOL_CATEGORIES) {
      const counted = index.entries.filter((entry) => entry.categories.includes(category)).length
      expect(manifest.emitted.byCategory[category], `${category} count disagrees`).toBe(counted)
    }
  })

  it('merges ids into entries that exist, and drops the ids that were merged', () => {
    for (const [loser, winner] of Object.entries(manifest.mergedIds)) {
      expect(index.byId.has(winner), `${loser} was merged into the missing id ${winner}`).toBe(true)
      // A merged id must not also be an entry: the panel keys favourites and
      // recents by id, and two answers for one id would be a stale favourite.
      expect(index.byId.has(loser), `${loser} is both merged and emitted`).toBe(false)
    }
  })

  it('gives every exclusion a source and a reason', () => {
    for (const exclusion of manifest.excluded) {
      expect(['mathjax', 'unimathsymbols'], `${exclusion.id} has an unknown source`).toContain(
        exclusion.source
      )
      // An exclusion with no reason is an unexplained omission wearing a hat.
      expect(exclusion.reason.length, `${exclusion.id} was excluded without a reason`).toBeGreaterThan(0)
    }
  })
})

describe('ids', () => {
  it('uses unique, well-formed entry and variant ids', () => {
    const ids = index.entries.map((entry) => entry.id)
    const variantIds = allVariants.map(({ variant }) => variant.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(variantIds).size).toBe(variantIds.length)
    // The panel stores favourites and recents by id and a merged variant is
    // renamed `<entryId>@<spelling>`, so the shape is a persistence contract
    // rather than a cosmetic one.
    expect(ids.filter((id) => !/^[a-z]+:[A-Za-z0-9@-]+$/.test(id))).toEqual([])
    const strayVariants = allVariants
      .filter(({ entry, variant }) => !variant.id.startsWith(`${entry.id}@`))
      .map(({ variant }) => variant.id)
    expect(strayVariants).toEqual([])
  })
})

describe('templates', () => {
  const templates = index.entries.filter((entry) => entry.id.startsWith('tpl:'))

  it('carries the curated template set', () => {
    // §9's structured insertion needs a template for every construct the panel
    // offers; the curated file is the only source of them.
    expect(templates.length).toBeGreaterThanOrEqual(70)
    expect(manifest.sources.curated.templates).toBe(templates.length)
  })

  it('wires every slot reference to a declared slot with the same index', () => {
    const problems: string[] = []
    for (const { variant } of allVariants) {
      const declared = new Set(variant.slots.map((slot) => slot.index))
      for (const part of variant.parts) {
        // A body is a list of literals and slot references, not a string with
        // `#1` markers in it, so a reference that no slot declares is a template
        // the inserter cannot place a caret in.
        if ('slot' in part && !declared.has(part.slot)) {
          problems.push(`${variant.id} references undeclared slot ${part.slot}`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('keeps placeholder markers out of literal template text', () => {
    // The markers `#1`, `$1` and `${…}` are the bug this shape exists to avoid: a
    // literal `#` inside a macro body must reach the document unchanged.
    const problems: string[] = []
    for (const { variant } of allVariants) {
      for (const part of variant.parts) {
        if (!('text' in part)) continue
        if (/#\d/.test(part.text) || /\$\d/.test(part.text) || part.text.includes('${')) {
          problems.push(`${variant.id} writes a placeholder marker: ${JSON.stringify(part.text)}`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('marks the slot a selection fills, and the slots that may be skipped', () => {
    // §9: a compatible editor selection goes into the slot marked
    // `selected-text`, so a template without one cannot absorb a selection. An
    // optional slot is the reviewed statement that the template works without it.
    const selectedText = templates.filter((entry) =>
      entry.variants.some((variant) => variant.slots.some((slot) => slot.select === 'selected-text'))
    )
    expect(selectedText.length).toBeGreaterThan(0)
    const optional = templates.filter((entry) =>
      entry.variants.some((variant) => variant.slots.some((slot) => !slot.required))
    )
    expect(optional.length).toBeGreaterThan(0)
  })
})

describe('availability metadata', () => {
  it('gives every requirement a package, a boolean and a reviewed source', () => {
    const problems: string[] = []
    for (const { variant } of allVariants) {
      if (!Array.isArray(variant.requires)) {
        problems.push(`${variant.id} has no requirement list`)
        continue
      }
      for (const requirement of variant.requires) {
        if (typeof requirement.package !== 'string' || requirement.package.length === 0) {
          problems.push(`${variant.id} has a requirement with no package`)
        }
        // `verified: false` is the catalog's word for "unknown", so it has to be
        // a boolean: `undefined` would read as unverified without saying so.
        if (typeof requirement.verified !== 'boolean') {
          problems.push(`${variant.id} has a requirement whose "verified" is not a boolean`)
        }
        if (!['core', 'package', 'engine'].includes(requirement.kind)) {
          problems.push(`${variant.id} has a requirement of unknown kind "${requirement.kind}"`)
        }
        // `core` is the kernel's own name for itself, so the two fields cannot
        // disagree about whether a requirement is the kernel.
        if ((requirement.package === 'core') !== (requirement.kind === 'core')) {
          problems.push(`${variant.id} calls "${requirement.package}" ${requirement.kind}`)
        }
        if (!['mathjax-configuration', 'unimathsymbols-detail', 'curated'].includes(requirement.source)) {
          problems.push(`${variant.id} cites an unreviewed source "${requirement.source}"`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('states no requirement exactly when availability is unknown', () => {
    /*
     * The data does *not* satisfy "every variant has at least one requirement":
     * 1 321 `ums:` variants list none, because the upstream `detail` field names
     * no package. That is the catalog saying "unknown", which §5 requires to be
     * distinguishable from core — and it is, as `core: null`. What must not
     * happen is an entry that claims a verified availability while stating no
     * requirement at all, or an entry that says "unknown" while every variant
     * carries a requirement.
     */
    const mismatched = allVariants
      .filter(({ entry, variant }) => (variant.requires.length === 0) !== (entry.core === null))
      .map(({ variant }) => variant.id)
    expect(mismatched).toEqual([])
  })

  it('gives every curated variant a stated requirement', () => {
    // The curated files always carry a reviewed requirement — an empty list there
    // would be a reviewer saying nothing, which is not a statement they make.
    const unstated = allVariants
      .filter(({ entry, variant }) => /^(tpl|cur):/.test(entry.id) && variant.requires.length === 0)
      .map(({ variant }) => variant.id)
    expect(unstated).toEqual([])
  })
})

describe('specific symbols', () => {
  it('marks base mathematics as core', () => {
    for (const command of ['\\alpha', '\\models']) {
      const ref = commandRef(command)
      expect(ref.entry.core, `${command} should be core`).toBe(true)
      expect(ref.variant.requires.map((requirement) => requirement.package)).toEqual(['core'])
    }
  })

  it('attributes a shared glyph by requirement rather than by shape', () => {
    // `\times` shares its glyph with the `physics` package's `\cp`. The merge key
    // includes the requirement set precisely so the two stay apart; folding them
    // would tell a document that loads neither package to load `physics`.
    const times = commandRef('\\times')
    const cp = commandRef('\\cp')
    expect(times.entry.core).toBe(true)
    expect(times.variant.requires.map((requirement) => requirement.package)).toEqual(['core'])
    expect(cp.entry.id).not.toBe(times.entry.id)
    expect(cp.variant.requires.map((requirement) => requirement.package)).toEqual(['physics'])
  })

  it('keeps visually similar but different symbols as separate entries', () => {
    // §5 names this family explicitly: the two spellings insert different code,
    // so one id for both would be a button that inserts the wrong symbol.
    const pairs: Array<[string, string]> = [
      ['\\epsilon', '\\varepsilon'],
      ['\\mid', '\\shortmid'],
      ['\\rightarrow', '\\longrightarrow']
    ]
    for (const [first, second] of pairs) {
      expect(commandRef(first).entry.id, `${first} and ${second} were merged`).not.toBe(
        commandRef(second).entry.id
      )
    }
  })

  it('separates a package glyph from the core glyph it resembles', () => {
    // `\hslash` and `\hbar` draw the same character and live in different
    // packages, so merging them would report a core command as needing `amssymb`.
    const hbar = commandRef('\\hbar')
    const hslash = commandRef('\\hslash')
    expect(hbar.entry.core).toBe(true)
    expect(hbar.variant.requires.map((requirement) => requirement.package)).toEqual(['core'])
    expect(hslash.entry.id).not.toBe(hbar.entry.id)
    expect(hslash.entry.core).toBe(false)
    expect(hslash.variant.requires.map((requirement) => requirement.package)).toEqual(['amssymb'])
  })

  it('offers argument-taking package commands as templates', () => {
    // `\cancel` and `\bm` only mean anything with an argument, so the catalog's
    // honest form for them is a template with a slot rather than a bare glyph.
    for (const command of ['\\cancel', '\\bm']) {
      const ref = commandRef(command)
      expect(ref.entry.id, `${command} is not a template entry`).toMatch(/^tpl:/)
      expect(ref.entry.preview).toBe('math')
      expect(ref.variant.slots.length, `${command} declares no slot`).toBeGreaterThan(0)
    }
  })
})

describe('glyphs', () => {
  it('gives most entries something the grid can draw', () => {
    // §10 previews ordinary static symbols with Unicode; a catalog where most
    // entries had no glyph would push the whole grid through MathJax.
    const withGlyph = index.entries.filter((entry) => entry.glyph !== null)
    expect(withGlyph.length).toBeGreaterThanOrEqual(1500)
  })

  it('stores a glyph, never a replacement recipe', () => {
    // One code point, or a base character plus a combining mark. Anything longer
    // is a typesetting recipe that upstream wrote into the same field, and
    // drawing it as one cell would show the recipe rather than the symbol.
    const unusable = index.entries
      .filter((entry) => entry.glyph !== null)
      .map((entry) => ({ id: entry.id, glyph: entry.glyph as string }))
      .filter(({ glyph }) => {
        const characters = [...glyph]
        return characters.length !== 1 && !(characters.length === 2 && /\p{Mark}/u.test(characters[1]))
      })
    expect(unusable).toEqual([])
  })
})

describe('coverage', () => {
  it('has an entry for every function, operator and delimiter', () => {
    // The panel's palette is built from commands, so a missing one is a button
    // that inserts nothing. `\sqrt`, `\frac`, `\hat`, `\vec`, `\overline`,
    // `\mathbb` and `\operatorname` are templates, which is why this looks each
    // command up in the command index rather than among the entry names.
    const required = [
      '\\sin', '\\lim', '\\sum', '\\int', '\\prod', '\\oint',
      '\\langle', '\\lfloor', '\\lceil',
      '\\forall', '\\exists', '\\neg', '\\leq', '\\geq', '\\in', '\\emptyset',
      '\\sqrt', '\\frac', '\\hat', '\\vec', '\\overline', '\\mathbb', '\\operatorname'
    ]
    const missing = required.filter((command) => !index.byCommand.has(command))
    expect(missing).toEqual([])
  })
})
