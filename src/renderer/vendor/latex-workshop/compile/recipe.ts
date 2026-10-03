/**
 * Eukolia — LaTeX Workshop port: build recipes.
 *
 * Ported from `out/src/compile/recipe.js` of LaTeX Workshop 10.19.0. The magic
 * comment parsing (`% !TeX program = xelatex`, `% !TeX options = ...`,
 * `% !BIB program = biber`, `% !LW recipe = ...`), the TeX/Bib tool synthesis,
 * the recipe lookup order (`explicit name` → `lastUsed` → language fallback)
 * and the language filters are unchanged.
 *
 * Adaptations: settings come from an injected provider, and the reference's
 * `vscode.workspace.getConfiguration`-scoped reads are parameterised by the root
 * file path so per-folder overrides can be layered by the caller.
 */

import { TEX_MAGIC_PROGRAM_NAME, BIB_MAGIC_PROGRAM_NAME, MAGIC_PROGRAM_ARGS_SUFFIX } from './constants'
import { setting, settingOr, type LwSettings, type SettingsProvider } from '../settings'
import type { RecipeConfig, Tool } from '../types'

export interface MagicComments {
  tex?: Tool
  bib?: Tool
  recipe?: string
}

export interface Recipe {
  name: string
  tools: Array<string | Tool>
  rootFile: string
  cwd: string
  isExternal: boolean
}

export interface RecipeResolverOptions {
  settings: SettingsProvider
  readFile: (filePath: string) => Promise<string | undefined>
  /** `getWorkingFolder(rootFile)` of the reference. */
  getWorkingFolder: (rootFile: string) => string
  /** `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` */
  workspaceDir?: string
}

/** `Recipe.createMagicTool` of the reference. */
export function createMagicTool(name: string, command: string, options?: string): Tool {
  return options === undefined ? { name, command } : { name, command, args: [options] }
}

/**
 * `Recipe.findMagicComments` of the reference. Only the leading comment block
 * is scanned, exactly as in the reference.
 */
export async function findMagicComments(
  rootFile: string,
  readFile: (filePath: string) => Promise<string | undefined>
): Promise<MagicComments> {
  const regexTex = /^(?:%\s*!\s*T[Ee]X\s(?:TS-)?program\s*=\s*([^\s]*)$)/m
  const regexBib = /^(?:%\s*!\s*BIB\s(?:TS-)?program\s*=\s*([^\s]*)$)/m
  const regexTexOptions = /^(?:%\s*!\s*T[Ee]X\s(?:TS-)?options\s*=\s*(.*)$)/m
  const regexBibOptions = /^(?:%\s*!\s*BIB\s(?:TS-)?options\s*=\s*(.*)$)/m
  const regexRecipe = /^(?:%\s*!\s*LW\srecipe\s*=\s*(.*)$)/m
  let content = ''
  for (const line of (await readFile(rootFile))?.split('\n') ?? []) {
    if (!line.startsWith('%') && line.trim().length > 0) {
      break
    }
    content += line + '\n'
  }
  const texMatch = content.match(regexTex)
  const texOptions = content.match(regexTexOptions)
  const tex = texMatch ? createMagicTool(TEX_MAGIC_PROGRAM_NAME, texMatch[1], texOptions?.[1]) : undefined
  const bibMatch = content.match(regexBib)
  const bibOptions = content.match(regexBibOptions)
  const bib = bibMatch ? createMagicTool(BIB_MAGIC_PROGRAM_NAME, bibMatch[1], bibOptions?.[1]) : undefined
  const recipeMatch = content.match(regexRecipe)
  return { tex, bib, recipe: recipeMatch?.[1] }
}

/**
 * `Recipe.createMagicTools` of the reference: `[tex]` or
 * `[tex, bib, tex, tex]`, with the default magic argument lists filled in when
 * the magic comment carried no explicit `options`.
 */
export function createMagicTools(tex: Tool, bib: Tool | undefined, settings: LwSettings): Tool[] {
  const texTool: Tool = tex.args
    ? tex
    : {
        ...tex,
        name: TEX_MAGIC_PROGRAM_NAME + MAGIC_PROGRAM_ARGS_SUFFIX,
        args: setting<string[]>(settings, 'latex.magic.args')
      }
  if (bib === undefined) {
    return [texTool]
  }
  const bibTool: Tool = bib.args
    ? bib
    : {
        ...bib,
        name: BIB_MAGIC_PROGRAM_NAME + MAGIC_PROGRAM_ARGS_SUFFIX,
        args: setting<string[]>(settings, 'latex.magic.bib.args')
      }
  return [texTool, bibTool, texTool, texTool]
}

/** `Recipe.filterByLanguage` of the reference. */
export function filterByLanguage(recipes: RecipeConfig[], languageId: string): RecipeConfig[] {
  if (languageId === 'rsweave') {
    return recipes.filter((candidate) => candidate.name.toLowerCase().match('rnw|rsweave'))
  }
  if (languageId === 'jlweave') {
    return recipes.filter((candidate) => candidate.name.toLowerCase().match('jnw|jlweave|weave.jl'))
  }
  if (languageId === 'pweave') {
    return recipes.filter((candidate) => candidate.name.toLowerCase().match('pnw|pweave'))
  }
  return recipes
}

let lastRecipeName: string | undefined = undefined
let lastLanguageId = ''

/** `Recipe.initialize` of the reference; needed between tests. */
export function initializeRecipeState(): void {
  lastRecipeName = undefined
  lastLanguageId = ''
}

export function getLastRecipeName(): string | undefined {
  return lastRecipeName
}

/**
 * `Recipe.findConfig` of the reference. Returns the recipe plus a diagnostic
 * message when resolution failed, so the caller can surface it without the
 * ported code reaching for `vscode.window`.
 */
export function findConfig(
  settings: LwSettings,
  languageId: string,
  recipeName: string | undefined
): { recipe?: RecipeConfig; error?: string } {
  const recipes = setting<RecipeConfig[]>(settings, 'latex.recipes')
  const defaultRecipeName = settingOr<string>(settings, 'latex.recipe.default', 'first')
  if (recipes.length === 0) {
    return { error: '[Builder] No recipes defined.' }
  }
  if (lastLanguageId !== languageId) {
    lastRecipeName = undefined
  }
  let name = recipeName
  if (name === undefined && !['first', 'lastUsed'].includes(defaultRecipeName)) {
    name = defaultRecipeName
  }
  let recipe: RecipeConfig | undefined
  let error: string | undefined
  if (name) {
    recipe = recipes.find((candidate) => candidate.name === name)
    if (recipe === undefined) {
      error = `[Builder] Failed to resolve build recipe: ${name}.`
    }
  }
  if (recipe === undefined && defaultRecipeName === 'lastUsed') {
    recipe = recipes.find((candidate) => candidate.name === lastRecipeName)
  }
  if (recipe !== undefined) {
    return { recipe }
  }
  const candidates = filterByLanguage(recipes, languageId)
  if (candidates.length === 0) {
    error = `[Builder] Cannot find any recipe for langID \`${languageId}\`: ${name}.`
    return { error }
  }
  return { recipe: candidates[0], error }
}

/**
 * `Recipe.create` of the reference. TeX magic builds take priority over
 * configured recipes; an `% !LW recipe` comment selects a configured recipe.
 */
export async function createRecipe(
  rootFile: string,
  languageId: string,
  recipeName: string | undefined,
  options: RecipeResolverOptions
): Promise<{ recipe?: Recipe; magic: MagicComments; error?: string }> {
  const configuration = options.settings(rootFile)
  const magic = await findMagicComments(rootFile, options.readFile)
  if (settingOr<boolean>(configuration, 'latex.build.enableMagicComments', true) && recipeName === undefined && magic.tex) {
    return {
      magic,
      recipe: {
        name: 'Build',
        tools: createMagicTools(magic.tex, magic.bib, configuration),
        rootFile,
        cwd: options.getWorkingFolder(rootFile),
        isExternal: false
      }
    }
  }
  let name = recipeName
  if (settingOr<boolean>(configuration, 'latex.build.enableMagicComments', true) && recipeName === undefined && magic.recipe) {
    name = magic.recipe
  }
  const config = findConfig(configuration, languageId, name)
  if (config.recipe === undefined) {
    return { magic, error: config.error }
  }
  lastRecipeName = config.recipe.name
  lastLanguageId = languageId
  return {
    magic,
    error: config.error,
    recipe: {
      name: config.recipe.name,
      tools: config.recipe.tools,
      rootFile,
      cwd: options.getWorkingFolder(rootFile),
      isExternal: false
    }
  }
}

/** `Recipe.createExternal` of the reference. */
export function createExternalRecipe(
  scope: string | undefined,
  fallbackCwd: string,
  rootFile: string,
  options: RecipeResolverOptions
): Recipe | undefined {
  const configuration = options.settings(scope)
  const command = settingOr<string>(configuration, 'latex.external.build.command', '')
  if (command === '') {
    return undefined
  }
  const args = settingOr<string[]>(configuration, 'latex.external.build.args', [])
  const cwd = options.workspaceDir ?? fallbackCwd
  return { name: 'External', tools: [{ name: command, command, args }], rootFile, cwd, isExternal: true }
}

/**
 * Alias of `createRecipe` under the name the Eukolia brief uses: resolve the
 * recipe (magic comment, explicit name, or configured default) for a root file.
 */
export function resolveRecipe(
  rootFile: string,
  languageId: string,
  recipeName: string | undefined,
  options: RecipeResolverOptions
): Promise<{ recipe?: Recipe; magic: MagicComments; error?: string }> {
  return createRecipe(rootFile, languageId, recipeName, options)
}
