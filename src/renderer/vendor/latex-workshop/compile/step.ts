/**
 * Eukolia — LaTeX Workshop port: build steps.
 *
 * Ported from `out/src/compile/step.js` of LaTeX Workshop 10.19.0. Only the
 * pure part is kept: the process invocation (magic-comment shell flattening,
 * BibTeX argument normalisation, environment assembly) is computed here and
 * returned as a plain `BuildStepPlan`. Spawning the process stays in
 * `src/main/` — this module never touches `child_process`.
 */

import path from 'path'

import {
  BIB_MAGIC_PROGRAM_NAME,
  MAGIC_PROGRAM_ARGS_SUFFIX,
  MAX_PRINT_LINE,
  TEX_MAGIC_PROGRAM_NAME
} from './constants'
import type { BuildStepPlan, StepContext, Tool } from '../types'

export interface ResolvedInvocation {
  command: string
  args: string[]
  env: Record<string, string | undefined>
  cwd: string
  shell: boolean
}

/** `Step.normalizeBibtexArgument` of the reference. */
export function normalizeBibtexArgument(argument: string, cwd: string): string {
  if (!argument) {
    return argument
  }
  let absolutePath: string
  try {
    absolutePath = path.isAbsolute(argument) ? path.normalize(argument) : path.resolve(cwd, argument)
  } catch {
    return argument
  }
  // #4714 Use a relative path inside cwd to satisfy TeX distribution
  // output-path restrictions.
  const relativePath = path.relative(cwd, absolutePath)
  const isInsideCwd = relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  if (!isInsideCwd) {
    return argument
  }
  return relativePath.split(path.sep).join('/')
}

export class Step {
  readonly name: string
  readonly command: string
  readonly args: string[]
  readonly env: Record<string, string | undefined>
  readonly cwd: string
  readonly rootFile: string
  readonly recipeName: string
  readonly index: number
  readonly total: number
  readonly isExternal: boolean
  isRetry = false
  isSkipped = false

  constructor(tool: Tool, context: StepContext) {
    this.name = tool.name
    this.command = tool.command
    this.args = tool.args ? tool.args.slice() : []
    this.env = tool.env ? { ...tool.env } : {}
    this.cwd = context.cwd
    this.rootFile = context.rootFile
    this.recipeName = context.recipeName
    this.index = context.index
    this.total = context.total
    this.isExternal = context.isExternal
  }

  static create(tool: Tool, context: StepContext): Step {
    return new Step(tool, context)
  }

  /** `Step.createProcessEnvironment` of the reference. */
  createProcessEnvironment(baseEnv: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    if (this.isExternal) {
      return { ...baseEnv }
    }
    return { ...baseEnv, ...this.env, max_print_line: MAX_PRINT_LINE }
  }

  /**
   * `Step.resolveProcessInvocation` of the reference.
   *
   * Magic-comment options use a flattened shell command; otherwise BibTeX
   * arguments are normalized, and only internal Steps receive the built env.
   */
  resolveProcessInvocation(env: Record<string, string | undefined>): ResolvedInvocation {
    const args = this.args.slice()
    const isMagic =
      !this.isExternal && (this.name.startsWith(TEX_MAGIC_PROGRAM_NAME) || this.name.startsWith(BIB_MAGIC_PROGRAM_NAME))
    // All optional arguments are given as a unique string (% !TeX options)
    // if any, so we use {shell: true}
    const hasMagicOptions = isMagic && this.args !== undefined && !this.name.endsWith(MAGIC_PROGRAM_ARGS_SUFFIX)
    if (this.command === 'bibtex' && args.length > 0 && !hasMagicOptions) {
      args[args.length - 1] = normalizeBibtexArgument(args[args.length - 1], this.cwd)
    }
    const resolvedEnv: Record<string, string | undefined> = this.isExternal ? {} : env
    if (hasMagicOptions) {
      return {
        command: `${this.command} ${args[0]}`,
        args: [],
        env: resolvedEnv,
        cwd: this.cwd,
        shell: true
      }
    }
    return { command: this.command, args, env: resolvedEnv, cwd: this.cwd, shell: false }
  }

  /**
   * Produce the executable plan for this step. `baseEnv` is the process
   * environment the main process will hand to the spawn call.
   */
  toPlan(baseEnv: Record<string, string | undefined> = {}): BuildStepPlan {
    const env = this.createProcessEnvironment(baseEnv)
    const invocation = this.resolveProcessInvocation(env)
    return {
      name: this.name,
      command: invocation.command,
      args: invocation.args,
      env: invocation.env,
      cwd: invocation.cwd,
      rootFile: this.rootFile,
      recipeName: this.recipeName,
      index: this.index,
      total: this.total,
      isExternal: this.isExternal,
      shell: invocation.shell
    }
  }
}
