/**
 * The build recipe catalogue.
 *
 * The defect this file exists for: Eukolia's recipe picker used to hold its own
 * list of names — `pdflatex`, `xelatex`, `pdflatex ➞ bibtex ➞ pdflatex ×2` —
 * while the resolver read `latex.recipes` from the ported settings. Six of the
 * seven names matched no recipe, so choosing one produced
 * `[Builder] Failed to resolve build recipe: pdflatex.` and a build that never
 * started.
 *
 * The cure is structural, so the tests are structural: a recipe may only name
 * tools that exist, every tool a recipe names must be probed on `PATH` (or the
 * picker would call a runnable recipe unavailable), and every engine the
 * settings offer must name a recipe that is in the catalogue. A name that
 * appears in one table and not another is exactly the drift that caused it.
 */

import { describe, expect, it } from 'vitest'

import {
  CATALOG_COMMANDS,
  ENGINE_RECIPES,
  OPTIONAL_COMMANDS,
  RECIPE_CATALOG,
  TOOL_CATALOG,
  recipeConfigs,
  recipeForEngine,
  toolsOfRecipe,
  toolsWithOptions
} from '../../src/renderer/compiler/recipeCatalog'

const toolNames = new Set(TOOL_CATALOG.map((tool) => tool.name))
const commands = CATALOG_COMMANDS.map((command) => command.toLowerCase())

describe('the recipe catalogue', () => {
  it('names only tools that exist', () => {
    const missing: string[] = []
    for (const recipe of RECIPE_CATALOG) {
      for (const tool of recipe.tools) {
        if (!toolNames.has(tool)) missing.push(`${recipe.name} → ${tool}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('probes every command a tool launches', () => {
    // A command nobody probes is a command that is never in the detection
    // result, which the picker reads as "missing" — a working recipe reported as
    // unrunnable, which is the same class of lie as the old name mismatch.
    const unprobed = TOOL_CATALOG.map((tool) => tool.command).filter(
      (command) => !commands.includes(command.toLowerCase())
    )
    expect(unprobed).toEqual([])
  })

  it('has unique recipe names and leads with latexmk', () => {
    const names = RECIPE_CATALOG.map((recipe) => recipe.name)
    expect(new Set(names).size).toBe(names.length)
    // The first entry is what an unset recipe resolves to (`recipe.default` is
    // `first`), and latexmk is the only engine that runs the bibliography passes
    // itself.
    expect(names[0]).toBe('latexmk')
  })

  it('maps every engine setting to a recipe that exists', () => {
    for (const [engine, recipe] of Object.entries(ENGINE_RECIPES)) {
      expect(toolsOfRecipe(RECIPE_CATALOG, recipe), `${engine} → ${recipe}`).toBeDefined()
    }
  })

  it('offers an engine for every value the settings allow', () => {
    // `compilation.engine` is an enum; a value it can hold and this table cannot
    // answer would silently build latexmk instead.
    expect(Object.keys(ENGINE_RECIPES).sort()).toEqual(
      ['latexmk', 'lualatex', 'pdflatex', 'tectonic', 'xelatex'].sort()
    )
  })

  it('keeps the reference spelling of a tool\'s command line', () => {
    const latexmk = TOOL_CATALOG.find((tool) => tool.name === 'latexmk')
    expect(latexmk?.command).toBe('latexmk')
    expect(latexmk?.args).toEqual([
      '-synctex=1',
      '-interaction=nonstopmode',
      '-file-line-error',
      '-pdf',
      '-outdir=%OUTDIR%',
      '-auxdir=%AUXDIR%',
      '%DOC%'
    ])
  })

  it('resolves recipe names to tool names, and reports an unknown one', () => {
    expect(toolsOfRecipe(RECIPE_CATALOG, 'pdflatex -> bibtex -> pdflatex * 2')).toEqual([
      'pdflatex',
      'bibtex',
      'pdflatex',
      'pdflatex'
    ])
    expect(toolsOfRecipe(RECIPE_CATALOG, 'nope')).toBeUndefined()
  })

  it('resolves engines, and refuses an engine it does not know', () => {
    expect(recipeForEngine('xelatex')).toBe('xelatex')
    expect(recipeForEngine('latexmk')).toBe('latexmk')
    expect(recipeForEngine('pdftex')).toBeUndefined()
  })

  it('exports ordinary recipe configurations for the ported settings layer', () => {
    const configs = recipeConfigs()
    expect(configs).toHaveLength(RECIPE_CATALOG.length)
    expect(configs[0]).toEqual({ name: 'latexmk', tools: ['latexmk'] })
    // A copy, not the catalogue itself: the plan builder clones tools and the
    // settings layer must not be able to mutate the table.
    configs[0].tools.push('pdflatex')
    expect(RECIPE_CATALOG[0].tools).toEqual(['latexmk'])
  })
})

describe('tool command lines under the compilation settings', () => {
  const latexmk = (options: Parameters<typeof toolsWithOptions>[0]) =>
    toolsWithOptions(options).find((tool) => tool.name === 'latexmk')!.args!

  it('keeps -synctex=1 while SyncTeX is on', () => {
    expect(latexmk({ synctex: true, forceLatexmk: false })).toContain('-synctex=1')
  })

  it('drops -synctex=1 when SyncTeX is off', () => {
    // `compilation.synctex` was bridged to a key nothing read, so the switch did
    // nothing at all.
    expect(latexmk({ synctex: false, forceLatexmk: false })).not.toContain('-synctex=1')
  })

  it('takes tectonic\'s own spelling of the SyncTeX flag', () => {
    const tectonic = (synctex: boolean) =>
      toolsWithOptions({ synctex, forceLatexmk: false }).find((tool) => tool.name === 'tectonic')!.args!
    expect(tectonic(true)).toContain('--synctex')
    expect(tectonic(false)).not.toContain('--synctex')
  })

  it('forces every latexmk rule in front of the document argument', () => {
    const args = latexmk({ synctex: true, forceLatexmk: true })
    expect(args).toContain('-g')
    // The document is `%DOC%` and stays last: latexmk takes no argument after it.
    expect(args[args.length - 1]).toBe('%DOC%')
    expect(args[args.length - 2]).toBe('-g')
  })

  it('does not force a rule on the engines that always run', () => {
    const pdflatex = toolsWithOptions({ synctex: true, forceLatexmk: true }).find((tool) => tool.name === 'pdflatex')!
    expect(pdflatex.args).not.toContain('-g')
  })

  it('appends extra arguments to the TeX commands only', () => {
    const tools = toolsWithOptions({ synctex: true, forceLatexmk: false, extraArgs: ['-shell-escape'] })
    const pdflatex = tools.find((tool) => tool.name === 'pdflatex')!.args!
    const bibtex = tools.find((tool) => tool.name === 'bibtex')!.args!
    expect(pdflatex).toContain('-shell-escape')
    expect(pdflatex[pdflatex.length - 1]).toBe('%DOC%')
    // bibtex would be handed a flag it does not accept.
    expect(bibtex).toEqual(['%DOCFILE%'])
  })

  it('leaves the catalogue itself untouched', () => {
    toolsWithOptions({ synctex: false, forceLatexmk: true, extraArgs: ['-draftmode'] })
    expect(TOOL_CATALOG.find((tool) => tool.name === 'latexmk')!.args).toContain('-synctex=1')
  })
})

describe('the probed command list', () => {
  it('treats the tools a distribution is complete without as optional', () => {
    expect(OPTIONAL_COMMANDS).toContain('tectonic')
    expect(OPTIONAL_COMMANDS).not.toContain('pdflatex')
  })

  it('probes the four engines the specification names', () => {
    for (const engine of ['pdflatex', 'xelatex', 'lualatex', 'latexmk']) {
      expect(commands).toContain(engine)
    }
  })
})
