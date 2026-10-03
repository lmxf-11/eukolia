/**
 * Eukolia — the build recipe catalogue.
 *
 * A *recipe* names an ordered list of *tools*; a tool is one command line with
 * placeholders (`%DOC%`, `%OUTDIR%`, …) that the ported LaTeX Workshop plan
 * builder expands. This module is where Eukolia's default recipes and tools are
 * written down, once.
 *
 * **Why a catalogue rather than a list beside the resolver.** The recipe picker
 * used to hold its own list of names — `'pdflatex'`, `'xelatex'`,
 * `'pdflatex ➞ bibtex ➞ pdflatex ×2'` — while the resolver read
 * `latex.recipes` from the ported settings. Six of those seven names matched no
 * recipe, so choosing one failed with `[Builder] Failed to resolve build recipe:
 * pdflatex.` and nothing on screen said which name was wrong. The picker and the
 * resolver must not be able to disagree, so both are now derived from this file:
 *
 *   - `recipeCatalog()` is what the settings bridge hands the ported resolver as
 *     `latex.recipes` / `latex.tools`;
 *   - `recipeOptions()` is what the picker lists, read back out of the same
 *     bridge, so a recipe a user adds through the advanced settings file is
 *     listed too, and a name the resolver would reject can never appear.
 *
 * **Names are LaTeX Workshop's.** `% !LW recipe = pdflatex -> bibtex ->
 * pdflatex * 2` and a `.vscode/settings.json` written for the reference extension
 * keep working here, which is worth more than nicer punctuation would be. The
 * engine recipes (`pdflatex`, `xelatex`, `lualatex`, `tectonic`) are named after
 * their engines and are what `compilation.engine` selects.
 *
 * **Tools are the reference's own command lines.** `-synctex=1
 * -interaction=nonstopmode -file-line-error` and latexmk's
 * `-outdir=%OUTDIR% -auxdir=%AUXDIR%` are copied from LaTeX Workshop 10.19.0's
 * `contributes.configuration` defaults, because those flags are what the ported
 * log parser, the SyncTeX bridge and the diagnostics expect to read.
 *
 * The three weave recipes of the reference (`Compile Rnw files`, `Compile Jnw
 * files`, `Compile Pnw files`) are deliberately absent: they run `Rscript`,
 * `julia` or `pweave`, none of which Eukolia detects, understands or can offer
 * completion for — a recipe that can only fail is not a recipe. A user who wants
 * one can add it through the advanced settings file; `recipeOptions()` will list
 * it, because it reads the effective list rather than this one.
 */

import type { RecipeConfig, Tool } from '../vendor/latex-workshop/types'

/** One recipe: a name and the tool names it runs, in order. */
export interface RecipeDefinition {
  name: string
  tools: string[]
}

/**
 * The engines `compilation.engine` may name, and the recipe each one means.
 *
 * The mapping is deliberately an identity: every engine is also a recipe name, so
 * `compilation.recipe = "default"` resolves to a recipe that is in the catalogue
 * and therefore in the picker. `latexmk` is the default because it is the only
 * one of the five that resolves bibliography and cross-reference passes itself.
 */
export const ENGINE_RECIPES: Readonly<Record<string, string>> = {
  pdflatex: 'pdflatex',
  xelatex: 'xelatex',
  lualatex: 'lualatex',
  latexmk: 'latexmk',
  tectonic: 'tectonic'
}

/**
 * The default recipes, in the order the picker shows them.
 *
 * The first entry is what an unset `compilation.recipe` falls back to
 * (`latex.recipe.default` is `'first'`), so `latexmk` leads.
 */
export const RECIPE_CATALOG: readonly RecipeDefinition[] = [
  { name: 'latexmk', tools: ['latexmk'] },
  { name: 'latexmk (xelatex)', tools: ['xelatexmk'] },
  { name: 'latexmk (lualatex)', tools: ['lualatexmk'] },
  { name: 'latexmk (latexmkrc)', tools: ['latexmk_rconly'] },
  { name: 'pdflatex', tools: ['pdflatex'] },
  { name: 'pdflatex -> bibtex -> pdflatex * 2', tools: ['pdflatex', 'bibtex', 'pdflatex', 'pdflatex'] },
  { name: 'xelatex', tools: ['xelatex'] },
  { name: 'xelatex -> bibtex -> xelatex * 2', tools: ['xelatex', 'bibtex', 'xelatex', 'xelatex'] },
  { name: 'lualatex', tools: ['lualatex'] },
  { name: 'lualatex -> biber -> lualatex * 2', tools: ['lualatex', 'biber', 'lualatex', 'lualatex'] },
  { name: 'tectonic', tools: ['tectonic'] }
]

/**
 * The tools the recipes above name.
 *
 * `-synctex=1` is written here and **removed** again when
 * `compilation.synctex` is off (`toolsWithOptions`), rather than being left out
 * here and added back: the reference's own command lines are the baseline, and
 * a user reading this file sees what the reference runs.
 */
export const TOOL_CATALOG: readonly Tool[] = [
  {
    name: 'latexmk',
    command: 'latexmk',
    args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-pdf', '-outdir=%OUTDIR%', '-auxdir=%AUXDIR%', '%DOC%']
  },
  {
    name: 'lualatexmk',
    command: 'latexmk',
    args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-lualatex', '-outdir=%OUTDIR%', '-auxdir=%AUXDIR%', '%DOC%']
  },
  {
    name: 'xelatexmk',
    command: 'latexmk',
    args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-xelatex', '-outdir=%OUTDIR%', '-auxdir=%AUXDIR%', '%DOC%']
  },
  // A project with its own `.latexmkrc` decides the engine itself; latexmk then
  // takes the document and nothing else.
  { name: 'latexmk_rconly', command: 'latexmk', args: ['%DOC%'] },
  { name: 'pdflatex', command: 'pdflatex', args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '%DOC%'] },
  { name: 'xelatex', command: 'xelatex', args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '%DOC%'] },
  { name: 'lualatex', command: 'lualatex', args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '%DOC%'] },
  { name: 'bibtex', command: 'bibtex', args: ['%DOCFILE%'] },
  { name: 'biber', command: 'biber', args: ['%DOCFILE%'] },
  { name: 'tectonic', command: 'tectonic', args: ['--synctex', '--keep-logs', '--print', '%DOC%.tex'] }
]

/**
 * The commands the TeX tools are looked for on `PATH`.
 *
 * One probing pass answers both questions the shell asks about the machine: which
 * TeX distribution is installed (the status bar's `TeX` indicator) and whether a
 * given recipe can run at all (the recipe picker).
 */
export const CATALOG_COMMANDS: readonly string[] = [
  'pdflatex',
  'xelatex',
  'lualatex',
  'latexmk',
  'bibtex',
  'biber',
  'tectonic',
  'makeindex',
  'synctex'
]

/** Commands a TeX distribution is complete without. */
export const OPTIONAL_COMMANDS: readonly string[] = ['biber', 'tectonic', 'makeindex', 'synctex']

/** The flag each engine takes to write SyncTeX data, when it differs from `-synctex=1`. */
const SYNCTEX_FLAGS: Record<string, string> = { tectonic: '--synctex' }

/** The engines whose command line accepts `compilation.extraArgs` as arguments. */
const TEX_COMMANDS = /^(?:pdf|xe|lua)?latex$|^latexmk$|^tectonic$/

export interface ToolOptions {
  /** `compilation.synctex`: keep `-synctex=1` on the engines. */
  synctex: boolean
  /** `compilation.latexmk.minimumRule`: add `-g`, so latexmk redoes every rule. */
  forceLatexmk: boolean
  /** `compilation.extraArgs`: appended to every TeX step. */
  extraArgs?: readonly string[]
}

/**
 * The tool list the plan builder resolves recipes against, adjusted for the
 * settings that change a command line.
 *
 * `latexmk -g` is forced processing: every rule runs whether or not latexmk
 * thinks it is up to date, which is what a rebuild is. It is applied to the
 * latexmk tools only — the engine tools always run, so there is nothing to
 * force.
 */
export function toolsWithOptions(options: ToolOptions): Tool[] {
  return TOOL_CATALOG.map((tool) => {
    let args = (tool.args ?? []).filter((arg) => {
      if (arg === '-synctex=1' || arg === '--synctex') {
        return options.synctex
      }
      if (arg === '-g') {
        return false
      }
      return true
    })
    if (options.synctex) {
      const flag = SYNCTEX_FLAGS[tool.command]
      if (flag && !args.includes(flag)) args = [flag, ...args]
    }
    if (options.forceLatexmk && tool.command === 'latexmk') {
      // Before the document argument, so latexmk never sees `%DOC%` as an option
      // value; every other flag it takes is option-shaped.
      args = [...args.slice(0, -1), '-g', ...args.slice(-1)]
    }
    const extra = (options.extraArgs ?? []).filter((arg) => arg.length > 0)
    if (extra.length > 0 && TEX_COMMANDS.test(tool.command)) {
      args = [...args.slice(0, -1), ...extra, ...args.slice(-1)]
    }
    return { ...tool, args }
  })
}

/**
 * Resolves a recipe name to its tool names.
 *
 * `undefined` means "no such recipe", which the caller reports rather than
 * silently building something else — the failure that started all of this.
 */
export function toolsOfRecipe(recipes: readonly RecipeDefinition[], name: string): string[] | undefined {
  return recipes.find((recipe) => recipe.name === name)?.tools
}

/** The recipe an engine name means, or `undefined` for an unknown engine. */
export function recipeForEngine(engine: string): string | undefined {
  return ENGINE_RECIPES[engine]
}

/** Deep-copies the catalogue into the shape the ported settings layer expects. */
export function recipeConfigs(recipes: readonly RecipeDefinition[] = RECIPE_CATALOG): RecipeConfig[] {
  return recipes.map((recipe) => ({ name: recipe.name, tools: [...recipe.tools] }))
}
