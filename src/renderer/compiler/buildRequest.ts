/**
 * Eukolia — from a ported build recipe to the IPC `BuildRequest`.
 *
 * The recipe/plan/step computation is the ported LaTeX Workshop code under
 * `src/renderer/vendor/latex-workshop/compile/`. This module is the Eukolia
 * adapter: it resolves the recipe for a root document, turns the resulting
 * `BuildPlan` into the `BuildRequest` contract of `src/shared/ipc.ts`, and
 * leaves the actual spawning to `src/main/ipc/compilerHandler.ts`.
 *
 * **The adapter is where the plan meets the project.** Three things the
 * reference either leaves to VS Code or gets from its own configuration are
 * decided here, because they are properties of *this* document in *this*
 * workspace rather than of the recipe:
 *
 *   - the output directory, resolved to an absolute path before any placeholder
 *     is expanded (`%OUTDIR%` must never mean "wherever the renderer happens to
 *     be running");
 *   - `compilation.extraArgs`, appended to the TeX command lines;
 *   - the auxiliary-file argument of `bibtex`/`biber`, which must point at the
 *     output directory when the build writes its `.aux` somewhere else.
 *
 * Everything else is the ported code's, unchanged.
 */

import path from 'path'

import type { BuildRequest, BuildStep } from '../../shared/ipc'
import { settingOr, type LwSettings, type SettingsProvider } from '../vendor/latex-workshop/settings'
import type { FileProvider } from '../vendor/latex-workshop/types'
import { buildSteps, type PlanContext } from '../vendor/latex-workshop/compile/plan'
import {
  createRecipe,
  type MagicComments,
  type Recipe,
  type RecipeResolverOptions
} from '../vendor/latex-workshop/compile/recipe'
import { getWorkingFolder, replaceArgumentPlaceholders } from '../vendor/latex-workshop/utils/files'

/** Tools that accept an output-directory flag. */
const OUTPUT_DIR_COMMANDS = /^(?:pdf|xe|lua)?latex$|^latexmk$/

/**
 * Tools that read an auxiliary file by job name. Their whole input is what the
 * previous step wrote, so they are the ones that break when the output directory
 * is not the source directory.
 */
const AUX_READING_COMMANDS = /^bibtex$|^biber$/

export interface ResolveBuildRequestOptions {
  rootFile: string
  languageId: string
  /** Explicit recipe name; `undefined` uses the configured default. */
  recipeName?: string
  /** Correlates the streaming output events of this build. */
  jobId: string
  settings: SettingsProvider
  fs: FileProvider
  /** Temporary directory exposed to recipes as `%TMPDIR%`. */
  tmpDir: string
  workspaceDir?: string
  /**
   * Absolute directory the build writes into. When given it replaces
   * `latex.outDir`, so a relative `compilation.outputDirectory` has been
   * resolved against the workspace before it reaches a placeholder.
   */
  outputDir?: string
  /** Overrides `getWorkingFolder(rootFile, settings, workspaceDir)`. */
  getWorkingFolder?: (rootFile: string) => string
  isMikTeX?: () => boolean
  extensionRoot?: string
  /** The process environment the main process will spawn with. */
  baseEnv?: Record<string, string | undefined>
  timeoutMs?: number
}

export interface ResolvedBuildRequest {
  request: BuildRequest
  recipe: Recipe
  magic: MagicComments
  /** Present when recipe resolution failed; `request.steps` is then empty. */
  error?: string
  /** Tools named by the recipe that do not exist; the plan runs without them. */
  warnings: string[]
}

function buildResolverOptions(options: ResolveBuildRequestOptions): RecipeResolverOptions {
  return {
    settings: options.settings,
    readFile: (filePath) => options.fs.readFile(filePath),
    getWorkingFolder: (rootFile) =>
      options.getWorkingFolder?.(rootFile) ??
      getWorkingFolder(rootFile, options.settings(rootFile), options.workspaceDir),
    workspaceDir: options.workspaceDir
  }
}

/**
 * The settings the plan is built from.
 *
 * `compilation.extraArgs`, SyncTeX and the per-build force flag reach the ported
 * plan through the tool list — the settings bridge builds that list
 * (`recipeCatalog.toolsWithOptions`) — because a tool's command line is one
 * value and `latex.tools` is where the reference keeps it. What is left here is
 * the one value that depends on the *document*: the output directory has to be
 * absolute before a placeholder expands it.
 */
function planSettings(options: ResolveBuildRequestOptions): LwSettings {
  const settings = options.settings(options.rootFile)
  if (!options.outputDir) {
    return settings
  }
  return { ...settings, 'latex.outDir': options.outputDir }
}

function stepLabel(step: { command: string; name: string }, jobName: string): string {
  const command = path.basename(step.command)
  return `${command} (${jobName})`
}

function stripUndefined(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  if (!env) {
    return undefined
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * The absolute directory a build writes into, or `undefined` to write beside the
 * source.
 *
 * `compilation.outputDirectory` is written by a person — `build`, or `../out` —
 * and every consumer of `latex.outDir` resolves it with `path.resolve`, which
 * answers against the *renderer process's* working directory: a relative
 * `build/` became the directory the application happened to be launched from.
 * Resolving it against the workspace here is what makes it mean what it says.
 */
export function absoluteOutputDirectory(
  value: string,
  workspaceDir: string | null,
  rootFile?: string
): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed)
  const base = workspaceDir ?? (rootFile ? path.dirname(rootFile) : null)
  return base ? path.resolve(base, trimmed) : path.resolve(trimmed)
}

/**
 * Where the recipe writes its output. `latex.outDir` defaults to `%DIR%`, the
 * root file's own directory, which is also what the tools do unaided — the
 * explicit `-output-directory=` is only added when they differ.
 */
export function resolveOutputDir(rootFile: string, settings: LwSettings, workspaceDir?: string, tmpDir = ''): string {
  const replace = replaceArgumentPlaceholders({ rootFile, tmpDir, settings, workspaceDir })
  const outDir = replace(settingOr<string>(settings, 'latex.outDir', '%DIR%'))
  return path.resolve(outDir)
}

/**
 * Resolve the recipe for `rootFile` and produce the IPC build request.
 * Returns `undefined` when no recipe could be resolved at all.
 */
export async function resolveBuildRequest(
  options: ResolveBuildRequestOptions
): Promise<ResolvedBuildRequest | undefined> {
  const resolved = await createRecipe(options.rootFile, options.languageId, options.recipeName, buildResolverOptions(options))
  if (resolved.recipe === undefined) {
    return undefined
  }
  const recipe = resolved.recipe
  const settings = planSettings(options)
  const planContext: PlanContext = {
    settings,
    tmpDir: options.tmpDir,
    workspaceDir: options.workspaceDir,
    isMikTeX: options.isMikTeX,
    extensionRoot: options.extensionRoot
  }
  const plan = buildSteps(recipe, planContext, options.baseEnv ?? {})
  const jobName = path.basename(recipe.rootFile, path.extname(recipe.rootFile))
  const rootDir = path.dirname(recipe.rootFile)
  const outputDir = resolveOutputDir(recipe.rootFile, settings, options.workspaceDir, options.tmpDir)

  const steps: BuildStep[] = plan.steps.map((step) => {
    let args = withOutputDirectory(step.args, step.command, outputDir, rootDir)
    args = withAuxiliaryPath(args, step.command, outputDir, rootDir, jobName)
    const buildStep: BuildStep = {
      command: step.command,
      args,
      label: stepLabel(step, jobName)
    }
    const env = stripUndefined(step.env)
    if (env) {
      buildStep.env = env
    }
    if (step.shell) {
      buildStep.shell = true
    }
    return buildStep
  })

  const request: BuildRequest = {
    jobId: options.jobId,
    steps,
    cwd: recipe.cwd,
    jobName
  }
  if (outputDir !== path.resolve(rootDir)) {
    request.outputDir = outputDir
  }
  if (options.timeoutMs !== undefined) {
    request.timeoutMs = options.timeoutMs
  }

  return { request, recipe, magic: resolved.magic, error: resolved.error, warnings: plan.messages }
}

/**
 * Adds `-output-directory=` for LaTeX-family tools when the configured output
 * directory differs from the source directory and the tool does not already
 * carry an output/aux directory flag (latexmk recipes pass `-outdir=%OUTDIR%`
 * themselves, which has already been substituted by the plan builder).
 */
export function withOutputDirectory(args: string[], command: string, outputDir: string, rootDir: string): string[] {
  if (path.resolve(outputDir) === path.resolve(rootDir)) {
    return args
  }
  if (!OUTPUT_DIR_COMMANDS.test(path.basename(command))) {
    return args
  }
  if (args.some((arg) => /^(?:--?out(?:put)?-?directory|--?outdir|--?aux(?:iliary)?-?directory|--?auxdir)=/.test(arg))) {
    return args
  }
  if (args.some((arg) => arg === '-output-directory')) {
    return args
  }
  return [...args, `-output-directory=${outputDir}`]
}

/**
 * Points `bibtex`/`biber` at the `.aux` file in the output directory.
 *
 * `-output-directory` moves the auxiliary files, not the process: TeX must keep
 * running in the source directory or `\input{chapters/one}` would stop
 * resolving. The bibliography tool, whose entire input is the `.aux` the
 * previous step wrote, is the one step that has to be told where that went — it
 * takes a path, so `out/main` is enough and no `.aux` suffix is wanted.
 *
 * Only a build that writes its output elsewhere is touched; the common case is
 * a no-op, and `%DOCFILE%` keeps its meaning in the tool catalogue.
 */
export function withAuxiliaryPath(
  args: string[],
  command: string,
  outputDir: string,
  rootDir: string,
  jobName: string
): string[] {
  if (path.resolve(outputDir) === path.resolve(rootDir)) {
    return args
  }
  if (!AUX_READING_COMMANDS.test(path.basename(command)) || args.length === 0) {
    return args
  }
  return [...args.slice(0, -1), path.join(outputDir, jobName)]
}
