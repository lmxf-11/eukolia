/**
 * Eukolia — LaTeX Workshop port: project file cache & inclusion graph.
 *
 * Ported from
 *  - `out/src/core/cache/store.js`      (`CacheStore.normalizePath`)
 *  - `out/src/core/cache/dependencies.js` (`discoverDependencies`,
 *    `discoverInputDependencies`, `discoverExternalDependencies`,
 *    `getIncludedTeX`)
 *
 * The reference `Cache` class is an event-driven subsystem wired to the VS Code
 * watcher, file cache and completion index. Eukolia keeps the parts that are
 * pure logic — path identity, `\input`/`\include`/`\import` discovery and the
 * depth-first inclusion walk — and drives them from an injectable
 * `FileProvider` instead of `vscode.workspace.fs` and `lw.watcher`.
 */

import path from 'path'

import { type LwSettings } from '../settings'
import type { FileProvider } from '../types'
import { resolveFile } from '../utils/files'
import { stripCommentsAndVerbatim } from '../utils/text'
import { InputFileRegExp, type InputMatch } from '../utils/inputFileRegexp'

/**
 * Produces the cache subsystem's identity key without rewriting the path
 * retained in `LatexFileCache` for diagnostics. Windows drive paths are
 * normalized with win32 rules on every host so tests and remote workflows agree.
 */
export function normalizePath(filePath: string): string {
  const normalized = /^[A-Za-z]:[\\/]/.test(filePath) ? path.win32.normalize(filePath) : path.normalize(filePath)
  return normalized.replace(/^([A-Z]):/, (drive) => drive.toLowerCase())
}

export interface LatexFileChild {
  filePath: string
  index: number
}

export interface LatexFileCache {
  filePath: string
  content: string
  /** Content with comments and verbatim environments removed, as in the reference. */
  contentTrimmed: string
  /** `\input`-like children, in scan order. */
  children: LatexFileChild[]
  /** `.bib` / `.gls` resources referenced by the file. */
  bibfiles: Set<string>
  /** `\externaldocument` targets (xr package). */
  externals: Array<{ filePath: string; prefix: string }>
}

export interface DependencyContext {
  fs: FileProvider
  settings: LwSettings
  rootFile?: string
  tmpDir?: string
  workspaceDir?: string
}

export interface InputDependency {
  kind: 'input'
  index: number
  filePath: string
  rootPath: string
}

export interface ExternalDependency {
  kind: 'external'
  filePath: string
  prefix: string
  ownerPath: string
  rootPath: string
}

export type Dependency = InputDependency | ExternalDependency

/**
 * Discovers the dependency forms owned by the cache: TeX input/include-like
 * references and noweb child references, plus XR references declared with
 * `\externaldocument`. Results are yielded in scan order.
 */
export async function* discoverDependencies(
  source: { filePath: string; contentTrimmed: string; childPaths: string[] },
  rootPath: string,
  ctx: DependencyContext
): AsyncGenerator<Dependency> {
  // Input and XR scans intentionally run in sequence. InputFileRegExp and the
  // global XR expression both carry per-scan lastIndex state and must not be
  // shared between concurrent refreshes.
  yield* discoverInputDependencies(source, rootPath, ctx)
  yield* discoverExternalDependencies(source, rootPath, ctx)
}

async function* discoverInputDependencies(
  source: { filePath: string; contentTrimmed: string; childPaths: string[] },
  rootPath: string,
  ctx: DependencyContext
): AsyncGenerator<InputDependency> {
  const inputFileRegExp = new InputFileRegExp()
  const childPaths = new Set(source.childPaths.map((childPath) => normalizePath(childPath)))
  const rootKey = normalizePath(rootPath)
  for (;;) {
    const result = await inputFileRegExp.exec(source.contentTrimmed, source.filePath, rootPath, ctx)
    if (!result) {
      break
    }
    const resultKey = normalizePath(result.path)
    if (!(await ctx.fs.exists(result.path)) || resultKey === rootKey) {
      continue
    }
    if (childPaths.has(resultKey)) {
      continue
    }
    childPaths.add(resultKey)
    yield {
      kind: 'input',
      index: result.match.index,
      filePath: result.path,
      rootPath
    }
  }
}

async function* discoverExternalDependencies(
  source: { filePath: string; contentTrimmed: string },
  rootPath: string,
  ctx: DependencyContext
): AsyncGenerator<ExternalDependency> {
  const externalDocRegExp = /\\externaldocument(?:\[(.*?)\])?\{(.*?)\}/g
  const rootKey = normalizePath(rootPath)
  for (;;) {
    const result = externalDocRegExp.exec(source.contentTrimmed)
    if (!result) {
      break
    }
    const texDirs = InputFileRegExp.texDirs(ctx.settings, ctx.rootFile ?? rootPath, ctx.tmpDir, ctx.workspaceDir)
    const externalPath = await resolveFile(
      ctx.fs,
      [path.dirname(source.filePath), path.dirname(rootPath), ...texDirs],
      result[2]
    )
    if (!externalPath || !(await ctx.fs.exists(externalPath)) || normalizePath(externalPath) === rootKey) {
      continue
    }
    yield {
      kind: 'external',
      filePath: externalPath,
      prefix: result[1] || '',
      ownerPath: rootPath,
      // External documents are separate roots, unlike input children.
      rootPath: externalPath
    }
  }
}

/** A cache lookup like `lw.cache.get(filePath)`. */
export type CacheLookup = (filePath: string) => LatexFileCache | undefined

/**
 * Traverses cached TeX dependencies depth first. The private result Set also
 * guards cycles by normalized identity while preserving first-seen source paths
 * and depth-first insertion order for callers.
 */
export function getIncludedTeX(filePath: string | undefined, getCache: CacheLookup): Set<string> {
  const includedTeX = new Set<string>()
  if (filePath === undefined) {
    return includedTeX
  }
  const checked = new Set<string>()
  function visit(currentPath: string): void {
    const fileCache = getCache(currentPath)
    if (fileCache === undefined) {
      return
    }
    const cacheKey = normalizePath(currentPath)
    if (checked.has(cacheKey)) {
      return
    }
    checked.add(cacheKey)
    includedTeX.add(currentPath)
    for (const child of fileCache.children) {
      visit(child.filePath)
    }
  }
  visit(filePath)
  return includedTeX
}

/**
 * The pure, in-memory project cache Eukolia drives: it reads through the
 * injected `FileProvider`, records the inclusion graph and exposes the same
 * `getIncludedTeX`/children queries the reference exposes on `lw.cache`.
 */
export class LatexProjectCache {
  private readonly caches = new Map<string, LatexFileCache>()

  constructor(private readonly ctx: DependencyContext) {}

  get(filePath: string): LatexFileCache | undefined {
    return this.caches.get(normalizePath(filePath))
  }

  set(filePath: string, fileCache: LatexFileCache): void {
    this.caches.set(normalizePath(filePath), fileCache)
  }

  delete(filePath: string): boolean {
    return this.caches.delete(normalizePath(filePath))
  }

  clear(): void {
    this.caches.clear()
  }

  paths(): string[] {
    return Array.from(this.caches.values(), (fileCache) => fileCache.filePath)
  }

  /** Read a file, strip comments/verbatim and discover its `\input` children. */
  async refresh(filePath: string, rootPath = filePath): Promise<LatexFileCache | undefined> {
    const content = await this.ctx.fs.readFile(filePath)
    if (content === undefined) {
      this.caches.delete(filePath)
      return undefined
    }
    const contentTrimmed = stripCommentsAndVerbatim(content, this.ctx.settings)
    const fileCache: LatexFileCache = {
      filePath,
      content,
      contentTrimmed,
      children: [],
      bibfiles: new Set<string>(),
      externals: []
    }
    this.set(filePath, fileCache)
    const source = { filePath, contentTrimmed, childPaths: [] as string[] }
    for await (const discovery of discoverDependencies(source, rootPath, this.ctx)) {
      if (discovery.kind === 'input') {
        fileCache.children.push({ filePath: discovery.filePath, index: discovery.index })
      } else {
        fileCache.externals.push({ filePath: discovery.filePath, prefix: discovery.prefix })
      }
    }
    fileCache.children.sort((a, b) => a.index - b.index)
    return fileCache
  }

  /**
   * Recursively cache the whole project starting at `rootPath` — the Eukolia
   * equivalent of the reference's `refreshCache` + `cache.add` cascade.
   */
  async refreshProject(rootPath: string): Promise<string[]> {
    const visited = new Set<string>()
    const order: string[] = []
    const walk = async (filePath: string): Promise<void> => {
      const key = normalizePath(filePath)
      if (visited.has(key)) {
        return
      }
      visited.add(key)
      const fileCache = await this.refresh(filePath, rootPath)
      if (!fileCache) {
        return
      }
      order.push(filePath)
      for (const child of fileCache.children) {
        await walk(child.filePath)
      }
    }
    await walk(rootPath)
    return order
  }

  /** `lw.cache.getIncludedTeX()` of the reference, rooted at the known root. */
  getIncludedTeX(rootPath?: string): Set<string> {
    return getIncludedTeX(rootPath ?? this.ctx.rootFile, (p) => this.get(p))
  }

  /** Direct children of a cached file. */
  getTeXChildren(filePath: string): LatexFileChild[] {
    return this.get(filePath)?.children ?? []
  }

  /** Every cached `\input`-like match of a file, without filesystem checks. */
  static scanInputs(content: string): InputMatch[] {
    return InputFileRegExp.scanMatches(stripCommentsAndVerbatim(content, {}))
  }
}
