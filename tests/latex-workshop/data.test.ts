/**
 * Vendored LaTeX Workshop data: the Unicode math symbol map and the per-package
 * definition files.
 *
 * The data files were copied from
 * `References/james-yu.latex-workshop-10.19.0/data/` into
 * `src/renderer/data/latex-workshop/` so nothing is read from `References/` at
 * runtime (Instructions.md §8).
 */

import { describe, expect, it } from 'vitest'

import {
  findUnimathCommands,
  getUnicodeMathSymbol,
  getUnicodeMathSymbols,
  getUnimathSymbols,
  searchUnimathSymbols
} from '../../src/renderer/vendor/latex-workshop/unimath'
import {
  bibtexEntries,
  classnames,
  commands,
  environments,
  latexSnippets,
  loadPackageData,
  loadPackageDataWithDeps,
  packageDataNames,
  packagenames
} from '../../src/renderer/vendor/latex-workshop/completion/dataStore'

describe('unimathsymbols.json map (ported utils/parser.js)', () => {
  it('maps math commands to their glyph', () => {
    const symbols = getUnicodeMathSymbols()
    expect(symbols.size).toBeGreaterThan(1000)
    expect(getUnicodeMathSymbol('int')).toBe('∫')
    expect(getUnicodeMathSymbol('infty')).toBe('∞')
  })

  it('falls back to the up-prefixed command, as the reference does', () => {
    // `alpha` itself is not in the map; `upalpha` is, and `getUnicodeMathSymbol`
    // tries the `up`-prefixed name exactly like the reference.
    expect(getUnicodeMathSymbols().has('alpha')).toBe(false)
    expect(getUnicodeMathSymbol('upalpha')).toBe('α')
    expect(getUnicodeMathSymbol('alpha')).toBe('α')
  })

  it('supports the visual editor symbol lookup', () => {
    const commandsForGlyph = findUnimathCommands('α')
    expect(commandsForGlyph.map((symbol) => symbol.command)).toContain('upalpha')
    const results = searchUnimathSymbols('integral', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((symbol) => symbol.documentation.toLowerCase().includes('integral'))).toBe(true)
    expect(getUnimathSymbols().length).toBe(2415)
  })
})

describe('vendored completion data', () => {
  it('loads the command, environment, package and class lists', () => {
    expect(Object.keys(commands).length).toBeGreaterThan(50)
    expect(environments.length).toBeGreaterThan(20)
    expect(Object.keys(packagenames).length).toBeGreaterThan(1000)
    expect(Object.keys(classnames).length).toBeGreaterThan(50)
    expect(Object.keys(latexSnippets).length).toBeGreaterThan(10)
    expect(Object.keys(bibtexEntries)).toContain('article')
  })

  it('lazily loads per-package macro definitions', async () => {
    const names = packageDataNames()
    expect(names.length).toBeGreaterThan(200)
    expect(names).toContain('amsmath')
    const amsmath = await loadPackageData('amsmath')
    expect(amsmath).toBeDefined()
    expect(amsmath!.macros!.some((macro) => macro.name === 'allowdisplaybreaks')).toBe(true)
    expect(await loadPackageData('definitely-not-a-package')).toBeUndefined()
  })

  it('resolves the dependency graph of a package and tolerates missing ones', async () => {
    // amsmath declares amstext, amsbsy and amsopn; only the latter two ship a
    // definition file, so a missing dependency must simply be skipped.
    const data = await loadPackageDataWithDeps(['amsmath'])
    expect(data.has('amsmath')).toBe(true)
    expect(data.has('amsbsy')).toBe(true)
    expect(data.has('amsopn')).toBe(true)
    expect(data.has('amstext')).toBe(false)
  })
})
