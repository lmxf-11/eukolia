/**
 * Eukolia — LaTeX Workshop port: `\input`-like file reference detection.
 *
 * Ported from `out/src/utils/inputfilepath.js` of LaTeX Workshop 10.19.0.
 *
 * Adaptation (documented, not a rewrite): the reference resolves relative
 * `\import`-style directories against `process.cwd()`, which is the extension
 * host's working directory in VS Code. In an Electron renderer `process.cwd()`
 * is meaningless, so an explicit `cwd` — normally the root document's directory
 * — is threaded through `InputFileRegExp`. The regular expressions, the match
 * bookkeeping and the resolution order are unchanged.
 */

import path from 'path'

import { settingOr, type LwSettings } from '../settings'
import type { FileProvider } from '../types'
import { replaceArgumentPlaceholders, resolveFile, sanitizeInputFilePath } from './files'
import { resolveFileSync } from './files'

export enum MatchType {
  Input = 0,
  Child = 1
}

export interface InputMatch {
  type: MatchType
  path: string
  directory: string
  matchedString: string
  index: number
}

export interface InputFileResult {
  path: string
  match: InputMatch
}

export interface InputResolveContext {
  fs: FileProvider
  settings: LwSettings
  /** Directory relative `\import{sections/}{...}` directories are resolved from. */
  cwd?: string
  /** Placeholder expansion base (used to expand `latex.texDirs` entries). */
  rootFile?: string
  tmpDir?: string
  workspaceDir?: string
}

export class InputFileRegExp {
  private readonly inputReg =
    /\\(?:input|InputIfFileExists|include|SweaveInput|subfile|subfileinclude|loadglsentries|markdownInput|(?:(?:sub)?(?:import|inputfrom|includefrom)\*?{([^}]*)}))(?:\[[^[\]{}]*\])?{([^}]*)}/g
  private readonly childReg = /<<(?:[^,]*,)*\s*child='([^']*)'\s*(?:,[^,]*)*>>=/g

  /**
   * Return the matched input path. If there is no match, return undefined.
   */
  async execInput(content: string, currentFile: string, rootFile: string, ctx: InputResolveContext): Promise<InputFileResult | undefined> {
    const result = this.inputReg.exec(content)
    if (result) {
      const match: InputMatch = {
        type: MatchType.Input,
        path: result[2],
        directory: result[1],
        matchedString: result[0],
        index: result.index
      }
      const filePath = await InputFileRegExp.parseInputFilePath(match, currentFile, rootFile, ctx)
      return filePath ? { path: filePath, match } : undefined
    }
    return undefined
  }

  /**
   * Return the matched noweb child path. If there is no match, return undefined.
   */
  async execChild(content: string, currentFile: string, rootFile: string, ctx: InputResolveContext): Promise<InputFileResult | undefined> {
    const result = this.childReg.exec(content)
    if (result) {
      const match: InputMatch = {
        type: MatchType.Child,
        path: result[1],
        directory: '',
        matchedString: result[0],
        index: result.index
      }
      const filePath = await InputFileRegExp.parseInputFilePath(match, currentFile, rootFile, ctx)
      return filePath ? { path: filePath, match } : undefined
    }
    return undefined
  }

  /** Return the matched input or child path. */
  async exec(content: string, currentFile: string, rootFile: string, ctx: InputResolveContext): Promise<InputFileResult | undefined> {
    return (
      (await this.execInput(content, currentFile, rootFile, ctx)) ??
      (await this.execChild(content, currentFile, rootFile, ctx))
    )
  }

  static texDirs(settings: LwSettings, rootFile?: string, tmpDir?: string, workspaceDir?: string): string[] {
    const rawTexDirs = settingOr<string[]>(settings, 'latex.texDirs', [])
    const replace = replaceArgumentPlaceholders({
      rootFile: rootFile ?? '',
      tmpDir: tmpDir ?? '',
      settings,
      workspaceDir
    })
    return rawTexDirs.map((texDir) => replace(texDir))
  }

  /**
   * Compute the resolved file path from matches of `this.inputReg` or
   * `this.childReg`.
   */
  static async parseInputFilePath(
    match: InputMatch,
    currentFile: string,
    rootFile: string,
    ctx: InputResolveContext
  ): Promise<string | undefined> {
    const texDirs = InputFileRegExp.texDirs(ctx.settings, ctx.rootFile ?? rootFile, ctx.tmpDir, ctx.workspaceDir)
    const matchedDir = sanitizeInputFilePath(match.directory ?? '')
    const matchedPath = sanitizeInputFilePath(match.path ?? '')
    const resolveBase = ctx.cwd ?? path.dirname(rootFile)
    /* match of this.childReg */
    if (match.type === MatchType.Child) {
      return resolveFile(ctx.fs, [path.dirname(currentFile), path.dirname(rootFile), ...texDirs], matchedPath)
    }
    /* match of this.inputReg */
    if (match.matchedString.startsWith('\\subimport') || match.matchedString.startsWith('\\subinputfrom') || match.matchedString.startsWith('\\subincludefrom')) {
      return resolveFile(ctx.fs, [path.dirname(currentFile)], path.join(matchedDir, matchedPath))
    } else if (match.matchedString.startsWith('\\import') || match.matchedString.startsWith('\\inputfrom') || match.matchedString.startsWith('\\includefrom')) {
      const absoluteDir = path.isAbsolute(matchedDir) ? matchedDir : path.resolve(resolveBase, matchedDir)
      return resolveFile(ctx.fs, [absoluteDir, path.join(path.dirname(rootFile), matchedDir)], matchedPath)
    } else {
      return resolveFile(ctx.fs, [path.dirname(currentFile), path.dirname(rootFile), ...texDirs], matchedPath)
    }
  }

  /**
   * Synchronous resolution used while walking an already-known file set — the
   * Eukolia project index is built from in-memory documents, so no `await` is
   * available there. Same order of candidates as `parseInputFilePath`.
   */
  static resolveInputFilePathSync(
    match: InputMatch,
    currentFile: string,
    rootFile: string,
    ctx: { exists: (candidate: string) => boolean; settings: LwSettings; cwd?: string }
  ): string | undefined {
    const matchedDir = sanitizeInputFilePath(match.directory ?? '')
    const matchedPath = sanitizeInputFilePath(match.path ?? '')
    const resolveBase = ctx.cwd ?? path.dirname(rootFile)
    if (match.type === MatchType.Child) {
      return resolveFileSync(ctx.exists, [path.dirname(currentFile), path.dirname(rootFile)], matchedPath)
    }
    if (match.matchedString.startsWith('\\subimport') || match.matchedString.startsWith('\\subinputfrom') || match.matchedString.startsWith('\\subincludefrom')) {
      return resolveFileSync(ctx.exists, [path.dirname(currentFile)], path.join(matchedDir, matchedPath))
    } else if (match.matchedString.startsWith('\\import') || match.matchedString.startsWith('\\inputfrom') || match.matchedString.startsWith('\\includefrom')) {
      const absoluteDir = path.isAbsolute(matchedDir) ? matchedDir : path.resolve(resolveBase, matchedDir)
      return resolveFileSync(ctx.exists, [absoluteDir, path.join(path.dirname(rootFile), matchedDir)], matchedPath)
    }
    return resolveFileSync(ctx.exists, [path.dirname(currentFile), path.dirname(rootFile)], matchedPath)
  }

  /**
   * Collect every `\input`-like reference of a document without touching the
   * filesystem. `InputFileRegExp` instances carry `lastIndex` state, so a fresh
   * instance is created per scan exactly like `discoverDependencies` does.
   */
  static scanMatches(content: string): InputMatch[] {
    const inputReg =
      /\\(?:input|InputIfFileExists|include|SweaveInput|subfile|subfileinclude|loadglsentries|markdownInput|(?:(?:sub)?(?:import|inputfrom|includefrom)\*?{([^}]*)}))(?:\[[^[\]{}]*\])?{([^}]*)}/g
    const childReg = /<<(?:[^,]*,)*\s*child='([^']*)'\s*(?:,[^,]*)*>>=/g
    const matches: InputMatch[] = []
    let result: RegExpExecArray | null
    while ((result = inputReg.exec(content)) !== null) {
      matches.push({
        type: MatchType.Input,
        path: result[2],
        directory: result[1],
        matchedString: result[0],
        index: result.index
      })
    }
    while ((result = childReg.exec(content)) !== null) {
      matches.push({
        type: MatchType.Child,
        path: result[1],
        directory: '',
        matchedString: result[0],
        index: result.index
      })
    }
    return matches.sort((a, b) => a.index - b.index)
  }
}
