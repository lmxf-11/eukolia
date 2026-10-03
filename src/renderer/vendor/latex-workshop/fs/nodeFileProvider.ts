/**
 * Eukolia — Node `FileProvider`.
 *
 * Backs the ported LaTeX Workshop core with `node:fs`. Used by the Vitest
 * suites and by any main-process side that needs to walk a project from disk.
 * The renderer receives project state over IPC instead of importing this module.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import type { FileProvider } from '../types'
import { globMatches } from './glob'

export class NodeFileProvider implements FileProvider {
  /** Directory relative globs are resolved from — the workspace folder. */
  constructor(private readonly baseDir?: string) {}

  /** Directory names skipped while scanning for workspace globs. */
  private readonly ignoredDirectories = new Set(['.git', 'node_modules', '.svn', '.hg', 'out', 'dist', 'dist-electron'])

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  async readFile(filePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(filePath, { encoding: 'utf8' })
    } catch {
      return undefined
    }
  }

  async readDirectory(dirPath: string): Promise<string[]> {
    try {
      return await fs.readdir(dirPath)
    } catch {
      return []
    }
  }

  async findFiles(includeGlob: string, excludeGlob?: string): Promise<string[]> {
    const roots = workspaceRoots(includeGlob, this.baseDir)
    const results: string[] = []
    for (const root of roots) {
      await this.walk(root, results, includeGlob, excludeGlob)
    }
    return results
  }

  private async walk(dir: string, results: string[], includeGlob: string, excludeGlob?: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (this.ignoredDirectories.has(entry.name)) continue
        await this.walk(full, results, includeGlob, excludeGlob)
        continue
      }
      if (!globMatches(includeGlob, full)) continue
      if (excludeGlob && globMatches(excludeGlob, full)) continue
      results.push(full)
    }
  }
}

/**
 * The absolute prefix a glob can be resolved from. A glob that is already
 * absolute keeps its literal prefix (`C:/proj` for `C:/proj/**\/*.tex`); a
 * relative glob is scanned from `baseDir`, or the current working directory.
 */
function workspaceRoots(includeGlob: string, baseDir?: string): string[] {
  const normalized = includeGlob.replace(/\\/g, '/')
  const driveMatch = /^([A-Za-z]:\/[^*/?{]*)/.exec(normalized)
  if (driveMatch) {
    const literal = literalPrefix(driveMatch[1])
    if (literal) {
      return [path.win32.normalize(literal)]
    }
  }
  if (normalized.startsWith('/')) {
    const literal = literalPrefix(normalized)
    return [literal || '/']
  }
  return [baseDir ?? process.cwd()]
}

/** The literal directory part of a glob prefix (everything before the last `/`). */
function literalPrefix(prefix: string): string {
  const cleaned = prefix.split(/[*?{[]/)[0]
  return cleaned.replace(/\/[^/]*$/, '')
}
