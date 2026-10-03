/**
 * Eukolia — LaTeX Workshop port: build plans.
 *
 * Ported from `out/src/compile/plan.js` of LaTeX Workshop 10.19.0. `Plan.create`
 * (resolve recipe tool names against `latex.tools`, clone, populate placeholders)
 * and `Plan.populateTools` (cwd resolution, TeX directory recording,
 * environment placeholders, MiKTeX `--max-print-line`) are reproduced; the
 * `run`/`retry`/`terminate` half of the class is deliberately left to the main
 * process, so `buildPlan` simply returns the ordered list of executable steps.
 */

import path from 'path'

import { MAX_PRINT_LINE, TEX_MAGIC_PROGRAM_NAME } from './constants'
import { setting, settingOr, type LwSettings } from '../settings'
import type { BuildPlan, BuildStepPlan, Tool } from '../types'
import { replaceArgumentPlaceholders } from '../utils/files'
import { Step } from './step'
import type { Recipe } from './recipe'

export interface PlanContext {
  settings: LwSettings
  tmpDir: string
  workspaceDir?: string
  /**
   * `Plan.isMikTeX()` of the reference shells out to `pdflatex --version`. The
   * probe belongs to the main process, so the answer is injected; when omitted
   * the option is left untouched, exactly as when MiKTeX is not detected.
   */
  isMikTeX?: () => boolean
  /**
   * Extension root used by `Plan.configureDocker`. Docker builds are not part of
   * Eukolia yet, so the command swap only happens when a root is supplied.
   */
  extensionRoot?: string
  platform?: NodeJS.Platform
}

function isDockerEnabled(settings: LwSettings): boolean {
  return settingOr<boolean>(settings, 'docker.enabled', false)
}

/** `Plan.configureMaxPrintLine` of the reference. */
export function configureMaxPrintLine(tool: Tool, settings: LwSettings, mikTeX: boolean): void {
  if (!settingOr<boolean>(settings, 'latex.option.maxPrintLine.enabled', true)) {
    return
  }
  tool.args = tool.args ?? []
  // Explicit magic options are a shell command fragment, not an argv array.
  // Keep quoted words together so option-like text inside a value is ignored.
  const args =
    tool.name === TEX_MAGIC_PROGRAM_NAME
      ? (tool.args[0]?.match(/(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+/g) ?? []).map((arg) => arg.replace(/["']/g, ''))
      : tool.args
  const isPdfLaTeXmk =
    tool.command === 'latexmk' &&
    !['-lualatex', '-pdflua', '-pdflualatex', '--lualatex', '--pdflua', '--pdflualatex'].some((arg) => args.includes(arg))
  if (!(isPdfLaTeXmk || tool.command === 'pdflatex') || !mikTeX) {
    return
  }
  if (tool.name === TEX_MAGIC_PROGRAM_NAME) {
    // The shell parses the original options, including quoted paths.
    // Quoting the whole fragment would collapse it into a single argument.
    tool.args = [`--max-print-line=${MAX_PRINT_LINE} ${tool.args[0] ?? ''}`]
  } else {
    tool.args.unshift(`--max-print-line=${MAX_PRINT_LINE}`)
  }
}

/** `Plan.configureDocker` of the reference (command swap needs the extension root). */
function configureDocker(tool: Tool, isExternal: boolean, settings: LwSettings, ctx: PlanContext): void {
  if (isExternal || !isDockerEnabled(settings)) {
    return
  }
  if (tool.command !== 'latexmk') {
    return
  }
  if (ctx.extensionRoot === undefined) {
    return
  }
  const platform = ctx.platform ?? process.platform
  tool.command = path.resolve(ctx.extensionRoot, platform === 'win32' ? './scripts/latexmk.bat' : './scripts/latexmk')
}

/** `Plan.populateTools` of the reference. */
export function populateTools(tools: Tool[], recipe: Recipe, ctx: PlanContext): void {
  if (recipe.rootFile === undefined) {
    return
  }
  const replace = replaceArgumentPlaceholders({
    rootFile: recipe.rootFile,
    tmpDir: ctx.tmpDir,
    settings: ctx.settings,
    workspaceDir: ctx.workspaceDir
  })
  for (const tool of tools) {
    configureDocker(tool, recipe.isExternal, ctx.settings, ctx)
    tool.args = tool.args?.map(replace)
    if (recipe.isExternal) {
      continue
    }
    tool.cwd = tool.cwd && replace(tool.cwd)
    if (tool.cwd && !path.isAbsolute(tool.cwd)) {
      tool.cwd = path.resolve(recipe.cwd, tool.cwd)
    }
    for (const [key, value] of Object.entries(tool.env ?? {})) {
      tool.env![key] = value && replace(value)
    }
    configureMaxPrintLine(tool, ctx.settings, ctx.isMikTeX?.() ?? false)
  }
}

export interface PlanResolution {
  steps: BuildStepPlan[]
  tools: Tool[]
  /** Non-fatal problems such as an undefined tool name in a recipe. */
  messages: string[]
}

/**
 * `Plan.create` of the reference: resolve recipe tool names, then populate and
 * freeze the tool list.
 */
export function resolveTools(recipe: Recipe, ctx: PlanContext): PlanResolution {
  const configuredTools = setting<Tool[]>(ctx.settings, 'latex.tools')
  const tools: Tool[] = []
  const messages: string[] = []
  for (const tool of recipe.tools) {
    if (typeof tool !== 'string') {
      tools.push(tool)
      continue
    }
    const configuredTool = configuredTools.find((candidate) => candidate.name === tool)
    if (configuredTool) {
      tools.push(configuredTool)
    } else {
      messages.push(`Skipping undefined tool "${tool}" in recipe "${recipe.name}".`)
    }
  }
  if (tools.length === 0) {
    return { steps: [], tools: [], messages }
  }
  const copiedTools: Tool[] = structuredClone(tools)
  populateTools(copiedTools, recipe, ctx)
  return { steps: [], tools: copiedTools, messages }
}

/**
 * The public entry point of deliverable 3: turn a recipe into an executable
 * command plan. `baseEnv` is the environment the main process will spawn with.
 */
export function buildSteps(recipe: Recipe, ctx: PlanContext, baseEnv: Record<string, string | undefined> = {}): BuildPlan {
  const { tools, messages } = resolveTools(recipe, ctx)
  const steps = tools.map((tool, index) =>
    Step.create(tool, {
      rootFile: recipe.rootFile,
      cwd: recipe.isExternal ? recipe.cwd : (tool.cwd ?? recipe.cwd),
      recipeName: recipe.name,
      index,
      total: tools.length,
      isExternal: recipe.isExternal
    }).toPlan(baseEnv)
  )
  return {
    name: recipe.name,
    rootFile: recipe.rootFile,
    cwd: recipe.cwd,
    isExternal: recipe.isExternal,
    steps,
    // Eukolia modification: the reference logs these; a plan handed to another
    // process has to carry them (see `BuildPlan.messages`).
    messages
  }
}

/**
 * Convenience facade matching the reference `Plan` lifecycle for callers that
 * only need the plan (`resolveRecipe` + `buildSteps` in the task brief).
 */
export function planFromRecipe(recipe: Recipe, ctx: PlanContext, baseEnv?: Record<string, string | undefined>): BuildPlan {
  return buildSteps(recipe, ctx, baseEnv)
}
