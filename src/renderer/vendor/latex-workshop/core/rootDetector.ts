/**
 * Eukolia — LaTeX Workshop port: root-document detection.
 *
 * Ported from `out/src/core/root.js` of LaTeX Workshop 10.19.0. The four
 * strategies, their order, their regular expressions and their quirks are kept
 * exactly:
 *
 *   1. `findFromMagic`      — `% !TeX root = ...`, followed transitively
 *   2. `findFromActive`     — the active document itself is a root
 *                             (indicator match, or the root declared by a
 *                             `\documentclass[...]{subfiles}` document)
 *   3. `findFromRoot`       — the current root still includes the active file
 *   4. `findInWorkspace`    — scan the workspace for candidates and pick one
 *                             that includes the active file
 *
 * Adaptations (documented, not rewrites):
 *  - `vscode.workspace` / `vscode.window` are replaced by the injected
 *    `RootDetectorHost`, so the logic runs in plain Node.
 *  - the strategies take the file they are resolving as an argument instead of
 *    reading `vscode.window.activeTextEditor`, which makes the same code usable
 *    for "which root does this file belong to?" queries (`findRootFrom`) as well
 *    as for the active editor (`findRoot`).
 *  - `latex.search.rootFiles.*` globs are evaluated through
 *    `FileProvider.findFiles`.
 */

import path from 'path'

import { settingOr, type LwSettings } from '../settings'
import type { FileProvider } from '../types'
import { resolveFile } from '../utils/files'
import { stripCommentsAndVerbatim } from '../utils/text'
import { FILE_URI_SCHEMES, getLangId, hasAlwaysRootExt, hasLaTeXClassPackageLangId, hasLaTeXLangId } from './constants'

export interface RootDocumentState {
  file: { path: string | undefined; langId: string | undefined }
  dir: { path: string | undefined }
  subfiles: { path: string | undefined; langId: string | undefined }
}

export interface RootDetectorHost {
  fs: FileProvider
  /** `vscode.workspace.getConfiguration('latex-workshop', scope)` equivalent. */
  settings(scope?: string): LwSettings
  /** Path of the active document, or undefined when no editor is active. */
  activeFile?: string
  /** Current (possibly unsaved) text of the active document. */
  activeContent?: string
  workspaceFolders: readonly string[]
  getWorkspaceFolder?: (filePath: string) => string | undefined
  /** Port of `lw.cache.getIncludedTeX(rootPath)`; may be backed by the project cache. */
  getIncludedTeX: (rootPath: string) => Set<string>
  /** Port of `lw.cache.getFlsChildren(filePath)` (used to read `.fls` files). */
  getFlsChildren?: (filePath: string) => Promise<string[]>
  /** URI scheme of a path, for the `FILE_URI_SCHEMES` guard. */
  schemeFor?: (filePath: string) => string
  langIdFor?: (filePath: string) => string
  /** Notified when a *different* root file has been selected. */
  onRootFileChanged?: (rootPath: string) => void
  /** Port of `lw.outline.refresh()`, called whenever a search concludes. */
  onRootSearched?: (rootPath: string | undefined) => void
}

export function createRootDocumentState(): RootDocumentState {
  return {
    file: { path: undefined, langId: undefined },
    dir: { path: undefined },
    subfiles: { path: undefined, langId: undefined }
  }
}

/** `% !TeX root = …` as recognised by `findFromMagic`. */
export const MAGIC_ROOT_REGEX = /^(?:%\s*!\s*T[Ee]X\sroot\s*=\s*(.*\.(?:tex|[jrsRS]nw|[rR]tex|jtexw))$)/m

/** `\documentclass[…]{subfiles}` as recognised by `findSubfiles`. */
export const SUBFILES_ROOT_REGEX = /(?:\\documentclass\[(.*)\]{subfiles})/s

/**
 * The indicator regexps of `getIndicator`, keyed by the
 * `latex.rootFile.indicator` setting value.
 */
export const ROOT_INDICATORS: Record<string, RegExp> = {
  '\\documentclass[]{}': /\\documentclass(?:\s*\[.*\])?\s*\{.*\}/ms,
  '\\begin{document}': /\\begin\s*{document}/m,
  '\\starttext': /\\starttext/m,
  '\\startTEXpage': /\\startTEXpage/m
}

/** `getIndicator` of the reference. */
export function rootIndicator(settings: LwSettings): RegExp {
  const indicator = settingOr<string>(settings, 'latex.rootFile.indicator', '\\documentclass[]{}')
  return ROOT_INDICATORS[indicator] ?? ROOT_INDICATORS['\\documentclass[]{}']
}

export class RootDetector {
  readonly state: RootDocumentState = createRootDocumentState()

  constructor(private readonly host: RootDetectorHost) {}

  get rootFile(): string | undefined {
    return this.state.file.path
  }

  get rootDir(): string | undefined {
    return this.state.dir.path
  }

  get subFiles(): string | undefined {
    return this.state.subfiles.path
  }

  /** Forget the current root — used when the root file is deleted. */
  invalidate(): void {
    this.state.file = { path: undefined, langId: undefined }
    this.state.dir = { path: undefined }
    this.state.subfiles = { path: undefined, langId: undefined }
  }

  /** The indicator regexp, ported verbatim from `getIndicator`. */
  getIndicator(): RegExp {
    return rootIndicator(this.host.settings())
  }

  /**
   * Port of `getWorkspace`: the workspace folder containing `filePath`, the
   * folder of the active document, or the first folder.
   */
  getWorkspace(filePath?: string, activeFile = this.host.activeFile): string | undefined {
    const firstWorkspace = this.host.workspaceFolders[0]
    if (!firstWorkspace) {
      return undefined
    }
    if (filePath !== undefined) {
      return this.host.getWorkspaceFolder?.(filePath) ?? firstWorkspace
    }
    if (!activeFile) {
      return firstWorkspace
    }
    return this.host.getWorkspaceFolder?.(activeFile) ?? firstWorkspace
  }

  /**
   * Finds the root file for the active document — the Eukolia entry point for
   * `lw.root.find()`. The active document is passed in rather than read from
   * `vscode.window` (documented adaptation).
   */
  async findRoot(activeFile = this.host.activeFile, activeContent = this.host.activeContent): Promise<string | undefined> {
    this.state.subfiles = { path: undefined, langId: undefined }
    if (activeFile === undefined) {
      this.onSearched(undefined)
      return undefined
    }
    const rootFilePath = await this.findRootFrom(activeFile, activeContent)
    if (rootFilePath === undefined) {
      this.onSearched(undefined)
      return undefined
    }
    if (rootFilePath === this.state.file.path) {
      this.onSearched(rootFilePath)
      return rootFilePath
    }
    this.state.file.path = rootFilePath
    this.state.file.langId = this.langIdFor(rootFilePath)
    this.state.dir.path = path.dirname(rootFilePath)
    this.host.onRootFileChanged?.(rootFilePath)
    this.onSearched(rootFilePath)
    return rootFilePath
  }

  private onSearched(rootFilePath: string | undefined): void {
    this.host.onRootSearched?.(rootFilePath)
  }

  private langIdFor(filePath: string): string | undefined {
    return this.host.langIdFor?.(filePath) ?? getLangId(filePath)
  }

  private schemeFor(filePath: string): string {
    return this.host.schemeFor?.(filePath) ?? 'file'
  }

  /**
   * Resolves the root document *of a given file*, running the reference's four
   * strategies in the same order with that file standing in for the active
   * editor.
   */
  async findRootFrom(filePath: string, content?: string): Promise<string | undefined> {
    const self = { filePath, content }
    const findMethods: Array<() => Promise<string | undefined> | string | undefined> = [
      () => this.findFromMagic(self),
      () => this.findFromActive(self),
      () => this.findFromRoot(self),
      () => this.findInWorkspace(self)
    ]
    for (const method of findMethods) {
      const rootFilePath = await method()
      if (rootFilePath === undefined) {
        continue
      }
      return rootFilePath
    }
    return undefined
  }

  /**
   * The Eukolia helper named in the task brief: the root to use when the active
   * document is dirty (its unsaved buffer still describes the project) or when
   * only the root is known. It never re-reads the dirty buffer from disk.
   */
  getDirtyOrRoot(filePath?: string, isDirty = false): string | undefined {
    if (filePath !== undefined && isDirty && this.isRootFileContent(this.host.activeContent)) {
      return filePath
    }
    return this.state.file.path
  }

  /** True when `content` matches the configured root indicator. */
  isRootFileContent(content: string | undefined): boolean {
    if (content === undefined) {
      return false
    }
    return this.getIndicator().test(stripCommentsAndVerbatim(content, this.host.settings()))
  }

  /**
   * Port of `findFromMagic`: follows `% !TeX root = ...` transitively, stopping
   * on a loop or a non-existent target.
   */
  async findFromMagic(self: { filePath: string; content?: string }): Promise<string | undefined> {
    const configuration = this.host.settings(self.filePath)
    if (!settingOr<boolean>(configuration, 'latex.build.enableMagicComments', true)) {
      return undefined
    }
    const regex = MAGIC_ROOT_REGEX
    const fileStack: string[] = []
    let content = self.content ?? (await this.host.fs.readFile(self.filePath))
    if (content === undefined) {
      return undefined
    }
    let filePath = self.filePath
    let result = content.match(regex)
    while (result) {
      filePath = path.resolve(path.dirname(filePath), result[1])
      if (fileStack.includes(filePath)) {
        // Looped magic root: return the file that closes the loop.
        return filePath
      }
      fileStack.push(filePath)
      content = await this.host.fs.readFile(filePath)
      if (content === undefined) {
        return undefined
      }
      result = content.match(regex)
    }
    if (fileStack.length > 0) {
      return fileStack[fileStack.length - 1]
    }
    return undefined
  }

  /**
   * Port of `findFromActive`: the indicator match makes the file its own root,
   * unless the file declares a `subfiles` root, which wins and is recorded in
   * `state.subfiles`.
   */
  async findFromActive(self: { filePath: string; content?: string }): Promise<string | undefined> {
    if (!FILE_URI_SCHEMES.includes(this.schemeFor(self.filePath))) {
      return undefined
    }
    if (hasAlwaysRootExt(path.extname(self.filePath))) {
      return self.filePath
    }
    const raw = self.content ?? (await this.host.fs.readFile(self.filePath))
    if (raw === undefined) {
      return undefined
    }
    const content = stripCommentsAndVerbatim(raw, this.host.settings(self.filePath))
    const result = content.match(this.getIndicator())
    if (result) {
      const rootFilePath = await this.findSubfiles(content, self.filePath)
      if (rootFilePath) {
        this.state.subfiles.path = self.filePath
        this.state.subfiles.langId = this.langIdFor(self.filePath)
        return rootFilePath
      }
      return self.filePath
    }
    return undefined
  }

  /** Port of `findSubfiles`. */
  async findSubfiles(content: string, currentFile: string): Promise<string | undefined> {
    const result = content.match(SUBFILES_ROOT_REGEX)
    if (!result) {
      return undefined
    }
    return resolveFile(this.host.fs, [path.dirname(currentFile)], result[1])
  }

  /**
   * Port of `findFromRoot`: keeps the current root when it still includes the
   * file being resolved.
   */
  findFromRoot(self: { filePath: string }): string | undefined {
    if (this.state.file.path === undefined) {
      return undefined
    }
    if (!FILE_URI_SCHEMES.includes(this.schemeFor(self.filePath))) {
      return undefined
    }
    const langId = this.host.langIdFor?.(self.filePath) ?? getLangId(self.filePath)
    if (
      langId &&
      (hasLaTeXLangId(langId) || hasLaTeXClassPackageLangId(langId)) &&
      this.host.getIncludedTeX(this.state.file.path).has(self.filePath)
    ) {
      return this.state.file.path
    }
    return undefined
  }

  /**
   * Port of `findInWorkspace`: scans the workspace include globs, prefers roots
   * whose cached inclusion set contains the file, keeps the current root when it
   * is still a candidate, otherwise takes the first candidate.
   */
  async findInWorkspace(self: { filePath: string }): Promise<string | undefined> {
    const workspace = this.getWorkspace(self.filePath)
    if (!workspace) {
      return undefined
    }
    const configuration = this.host.settings(workspace)
    const rootFilesIncludePatterns = settingOr<string[]>(configuration, 'latex.search.rootFiles.include', [
      '**/*.tex',
      '**/*.rnw',
      '**/*.Rnw'
    ])
    const rootFilesIncludeGlob = '{' + rootFilesIncludePatterns.join(',') + '}'
    const rootFilesExcludePatterns = settingOr<string[]>(configuration, 'latex.search.rootFiles.exclude', [])
    const rootFilesExcludeGlob =
      rootFilesExcludePatterns.length > 0 ? '{' + rootFilesExcludePatterns.join(',') + '}' : undefined
    try {
      const filePaths = await this.host.fs.findFiles(rootFilesIncludeGlob, rootFilesExcludeGlob)
      const candidates: string[] = []
      for (const filePath of filePaths) {
        if (!FILE_URI_SCHEMES.includes(this.schemeFor(filePath))) {
          continue
        }
        if (this.host.getFlsChildren) {
          const flsChildren = await this.host.getFlsChildren(filePath)
          if (flsChildren.includes(self.filePath)) {
            return filePath
          }
        }
        const content = await this.host.fs.readFile(filePath)
        if (content === undefined) {
          continue
        }
        const result = stripCommentsAndVerbatim(content, configuration).match(this.getIndicator())
        if (result) {
          // Can be a root
          if (filePath !== self.filePath && this.host.getIncludedTeX(filePath).has(self.filePath)) {
            candidates.unshift(filePath)
          }
          // Not including the file, yet can still be a root candidate
          candidates.push(filePath)
        }
      }
      if (this.state.file.path && candidates.includes(this.state.file.path)) {
        return this.state.file.path
      } else if (candidates.length > 0) {
        return candidates[0]
      }
    } catch {
      return undefined
    }
    return undefined
  }
}
