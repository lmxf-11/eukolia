/**
 * Root-document detection for Eukolia.
 *
 * The detection logic itself is the **ported LaTeX Workshop implementation** in
 * `src/renderer/vendor/latex-workshop/core/rootDetector.ts` (a faithful port of
 * `References/james-yu.latex-workshop-10.19.0/out/src/core/root.js`), and the
 * inclusion graph it consults is
 * `src/renderer/vendor/latex-workshop/core/projectCache.ts` (a port of
 * `out/src/core/cache/dependencies.js`).
 *
 * This module is the Eukolia integration point: it wires the ported detector to
 * an injectable `FileProvider`, keeps the project's file cache in step, and
 * exposes the small surface the application shell and
 * `projectIndex.setRootDocumentPath()` need.
 */

import {
  MAGIC_ROOT_REGEX,
  RootDetector,
  SUBFILES_ROOT_REGEX,
  createRootDocumentState,
  rootIndicator,
  type RootDocumentState
} from '../vendor/latex-workshop/core/rootDetector'
import { LatexProjectCache, type LatexFileCache } from '../vendor/latex-workshop/core/projectCache'
import { MemoryFileProvider } from '../vendor/latex-workshop/fs/memoryFileProvider'
import { InputFileRegExp } from '../vendor/latex-workshop/utils/inputFileRegexp'
import { resolveFileSync } from '../vendor/latex-workshop/utils/files'
import { stripCommentsAndVerbatim } from '../vendor/latex-workshop/utils/text'
import { defaultSettingsProvider, mergeSettings, type LwSettings, type SettingsProvider } from '../vendor/latex-workshop/settings'
import type { FileProvider } from '../vendor/latex-workshop/types'

/** A LaTeX file known to the caller (open buffer or directory scan). */
export interface FileEntry {
  path: string
  name?: string
  content?: string
}

export interface RootDocumentServiceOptions {
  fs: FileProvider
  /** Either a plain snapshot or a scope-aware provider. */
  settings?: LwSettings | SettingsProvider
  workspaceFolders?: readonly string[]
  getWorkspaceFolder?: (filePath: string) => string | undefined
  /** Current text of an open buffer — preferred over reading the file. */
  getOpenDocumentText?: (filePath: string) => string | undefined
  /** URI scheme of a path; everything is `file` in Eukolia. */
  schemeFor?: (filePath: string) => string
  langIdFor?: (filePath: string) => string
  onRootFileChanged?: (rootPath: string) => void
  /** Called after a root change with the refreshed project cache. */
  onProjectIndexChanged?: (rootPath: string, files: string[]) => void
}

function asProvider(settings: LwSettings | SettingsProvider | undefined): SettingsProvider {
  if (settings === undefined) {
    return defaultSettingsProvider()
  }
  return typeof settings === 'function' ? settings : () => mergeSettings(settings)
}

/**
 * Eukolia's root-document service: the ported detector plus the project file
 * cache it consults, resolved against an injectable filesystem.
 */
export class RootDocumentService {
  readonly detector: RootDetector
  readonly cache: LatexProjectCache
  private readonly options: RootDocumentServiceOptions
  private readonly settingsProvider: SettingsProvider

  constructor(options: RootDocumentServiceOptions) {
    this.options = options
    this.settingsProvider = asProvider(options.settings)
    this.cache = new LatexProjectCache({
      fs: options.fs,
      settings: this.settingsProvider(),
      tmpDir: ''
    })
    this.detector = new RootDetector({
      fs: options.fs,
      settings: (scope) => this.settingsProvider(scope),
      workspaceFolders: options.workspaceFolders ?? [],
      getWorkspaceFolder: options.getWorkspaceFolder,
      getIncludedTeX: (rootPath) => this.cache.getIncludedTeX(rootPath),
      schemeFor: options.schemeFor,
      langIdFor: options.langIdFor,
      onRootFileChanged: (rootPath) => {
        options.onRootFileChanged?.(rootPath)
      }
    })
  }

  get state(): RootDocumentState {
    return this.detector.state
  }

  get rootFile(): string | undefined {
    return this.detector.rootFile
  }

  get rootDir(): string | undefined {
    return this.detector.rootDir
  }

  /** Forget the current root, e.g. after the root file was deleted. */
  invalidate(): void {
    this.detector.invalidate()
  }

  /** Read the current text of a file, preferring an open buffer. */
  private read(filePath: string): Promise<string | undefined> {
    const open = this.options.getOpenDocumentText?.(filePath)
    return open !== undefined ? Promise.resolve(open) : this.options.fs.readFile(filePath)
  }

  /**
   * `lw.root.find()` of the reference, for the active document. Also refreshes
   * the project cache when the root changed.
   */
  async findRoot(activeFile?: string, activeContent?: string): Promise<string | undefined> {
    const previous = this.detector.rootFile
    const content = activeContent ?? (activeFile !== undefined ? await this.read(activeFile) : undefined)
    const root = await this.detector.findRoot(activeFile, content)
    if (root !== undefined && root !== previous) {
      await this.refreshProject(root)
    }
    return root
  }

  /**
   * Resolve the root **of a given file** — the "which document does this
   * `\input`ed file belong to?" query, e.g. `% !TeX root = ../main.tex`.
   */
  async findRootFrom(filePath: string, content?: string): Promise<string | undefined> {
    const text = content ?? (await this.read(filePath))
    const root = await this.detector.findRootFrom(filePath, text)
    if (root !== undefined) {
      this.detector.state.file = { path: root, langId: this.options.langIdFor?.(root) }
      this.detector.state.dir = { path: root.slice(0, Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'))) || undefined }
    }
    return root
  }

  /** The reference's `getDirtyOrRoot` behaviour: an unsaved root buffer wins. */
  getDirtyOrRoot(filePath?: string, isDirty = false): string | undefined {
    return this.detector.getDirtyOrRoot(filePath, isDirty)
  }

  /** Refresh the ported inclusion-graph cache for a whole project. */
  async refreshProject(rootPath: string): Promise<string[]> {
    const files = await this.cache.refreshProject(rootPath)
    this.options.onProjectIndexChanged?.(rootPath, files)
    return files
  }

  /** Cached record of one file (content, trimmed content, children). */
  getFileCache(filePath: string): LatexFileCache | undefined {
    return this.cache.get(filePath)
  }

  /** The reference's `lw.cache.getIncludedTeX()`. */
  getIncludedTeX(rootPath?: string): Set<string> {
    return this.cache.getIncludedTeX(rootPath ?? this.detector.rootFile)
  }

  /** Direct `\input`-like children of a file, in source order. */
  getTeXChildren(filePath: string): string[] {
    return this.cache.getTeXChildren(filePath).map((child) => child.filePath)
  }
}

export function createRootDocumentService(options: RootDocumentServiceOptions): RootDocumentService {
  return new RootDocumentService(options)
}

export { createRootDocumentState }

/**
 * Convenience for callers that only hold a list of files (directory scans, the
 * historical `detectRootDocument` API). Runs the ported strategies synchronously
 * over the supplied contents and returns the caller's own path string for the
 * detected root.
 */
export function detectRootDocument(files: FileEntry[]): string | null {
  if (files.length === 0) {
    return null
  }
  const contents = new Map<string, string>()
  for (const file of files) {
    if (file.content !== undefined) {
      contents.set(file.path, file.content)
    }
  }
  return detectRootDocumentSync(
    files.map((file) => ({ path: file.path, name: file.name ?? basename(file.path), isDirectory: false })),
    contents
  )
}

/** The asynchronous variant, which may read files through a `FileProvider`. */
export async function detectRootDocumentAsync(
  files: FileEntry[],
  options: { workspaceFolder?: string } = {}
): Promise<string | null> {
  if (files.length === 0) {
    return null
  }
  const provider = new MemoryFileProvider(files.map((file) => ({ path: file.path, content: file.content ?? '' })))
  const workspaceFolder = options.workspaceFolder ?? commonDirectory(files.map((file) => file.path))
  const service = createRootDocumentService({
    fs: provider,
    workspaceFolders: workspaceFolder ? [workspaceFolder] : [],
    getWorkspaceFolder: () => workspaceFolder
  })
  for (const file of files) {
    const root = await service.findRootFrom(file.path, file.content)
    if (root) {
      return expandResult(root, files)
    }
  }
  return null
}

function basename(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return index === -1 ? filePath : filePath.slice(index + 1)
}

/** Prefer the caller's own spelling of a path (and its separators). */
function expandResult(resolved: string, files: ReadonlyArray<{ path: string }>): string {
  const key = normalizeKey(resolved)
  return files.find((file) => normalizeKey(file.path) === key)?.path ?? resolved
}

/**
 * Synchronous root detection over an already-known file set — the shape
 * `WorkspaceDependencies.detectRootDocument` asks for. It runs the *ported*
 * strategies (`findFromMagic`, then `findFromActive` with the subfiles rule,
 * then the workspace-candidate ranking) using the supplied contents instead of
 * asynchronous reads, and the ported `InputFileRegExp` for inclusion checks.
 */
export function detectRootDocumentSync(
  files: ReadonlyArray<{ path: string; name: string; isDirectory: boolean }>,
  contents: ReadonlyMap<string, string>,
  settings?: LwSettings
): string | null {
  const resolvedSettings = mergeSettings(settings)
  const texFiles = files
    .filter((file) => !file.isDirectory && /\.(tex|ltx|rnw|Rnw|Rtex|jtexw)$/.test(file.name))
    .map((file) => file.path)
  if (texFiles.length === 0) {
    return null
  }
  const originalByKey = new Map<string, string>()
  for (const file of files) {
    originalByKey.set(normalizeKey(file.path), file.path)
  }
  const known = new Set(texFiles.map((p) => normalizeKey(p)))
  /** The caller's own spelling of a resolved path, when it is a known file. */
  const original = (candidate: string): string => originalByKey.get(normalizeKey(candidate)) ?? candidate
  const read = (p: string): string | undefined => contents.get(p) ?? contents.get(original(p))
  const existsSync = (candidate: string): boolean => known.has(normalizeKey(candidate))

  // Strategy 1 (`findFromMagic`): follow `% !TeX root = …` transitively.
  for (const filePath of texFiles) {
    const magic = followMagicComment(filePath, read, existsSync, original)
    if (magic) {
      return magic
    }
  }

  // Strategy 2 (`findFromActive`): the indicator match, with the subfiles rule.
  const indicator = rootIndicator(resolvedSettings)
  const candidates: string[] = []
  for (const filePath of texFiles) {
    const content = read(filePath)
    if (content === undefined) continue
    const stripped = stripCommentsAndVerbatim(content, resolvedSettings)
    if (!indicator.test(stripped)) continue
    const subfiles = stripped.match(SUBFILES_ROOT_REGEX)
    if (subfiles) {
      const resolved = resolveInputTarget(subfiles[1], filePath, existsSync, original)
      if (resolved) {
        return resolved
      }
    }
    candidates.push(filePath)
  }
  if (candidates.length === 0) {
    return null
  }
  if (candidates.length === 1) {
    return candidates[0]
  }

  // Strategy 3 (`findInWorkspace`): prefer the candidate that includes the
  // others, which is the document a LaTeX user would call the root.
  const inclusionOf = (candidate: string): Set<string> => {
    const included = new Set<string>()
    const visit = (filePath: string): void => {
      const key = normalizeKey(filePath)
      if (included.has(key)) return
      included.add(key)
      const content = read(filePath)
      if (content === undefined) return
      for (const match of InputFileRegExp.scanMatches(stripCommentsAndVerbatim(content, resolvedSettings))) {
        const target = resolveInputTarget(match.path, filePath, existsSync, original, match)
        if (target) visit(target)
      }
    }
    visit(candidate)
    return included
  }
  let best = candidates[0]
  let bestCount = -1
  for (const candidate of candidates) {
    const count = inclusionOf(candidate).size
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

function normalizeKey(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

function followMagicComment(
  startFile: string,
  read: (p: string) => string | undefined,
  existsSync: (p: string) => boolean,
  original: (p: string) => string
): string | undefined {
  const stack: string[] = []
  let filePath = startFile
  let content = read(filePath)
  if (content === undefined) {
    return undefined
  }
  let result = content.match(MAGIC_ROOT_REGEX)
  while (result) {
    const target = resolveInputTarget(result[1], filePath, existsSync, original)
    if (!target) {
      return undefined
    }
    const key = normalizeKey(target)
    if (stack.includes(key)) {
      return target
    }
    stack.push(key)
    filePath = target
    content = read(filePath)
    if (content === undefined) {
      return undefined
    }
    result = content.match(MAGIC_ROOT_REGEX)
  }
  return stack.length > 0 ? filePath : undefined
}

function resolveInputTarget(
  target: string,
  currentFile: string,
  existsSync: (p: string) => boolean,
  original: (p: string) => string,
  match?: { matchedString: string }
): string | undefined {
  const trimmed = target.trim().replace(/^"|"$/g, '')
  if (!trimmed) {
    return undefined
  }
  const dirs = match?.matchedString.startsWith('\\subimport') ? [dirnameOf(currentFile)] : [dirnameOf(currentFile)]
  const resolved = resolveFileSync(existsSync, dirs, trimmed)
  return resolved ? original(resolved) : undefined
}

/** Separator-preserving `path.dirname`, so `D:/proj/a.tex` stays forward-slashed. */
function dirnameOf(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return index === -1 ? '.' : filePath.slice(0, index)
}

function commonDirectory(paths: string[]): string | undefined {
  if (paths.length === 0) {
    return undefined
  }
  const parts = paths.map((p) => p.replace(/\\/g, '/').split('/'))
  const first = parts[0]
  let shared = first.length - 1
  for (const segments of parts) {
    let index = 0
    while (index < shared && index < segments.length - 1 && segments[index] === first[index]) {
      index += 1
    }
    shared = Math.min(shared, index)
  }
  return first.slice(0, shared).join('/') || undefined
}
