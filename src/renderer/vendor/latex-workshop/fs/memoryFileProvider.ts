/**
 * Eukolia — in-memory `FileProvider`.
 *
 * Used by the Vitest suites and by anything that needs to reason about a LaTeX
 * project without touching the disk (e.g. a project whose files are held open in
 * the renderer).
 */

import path from 'path'

import type { FileProvider } from '../types'
import { globMatches } from './glob'

export interface MemoryFile {
  path: string
  content: string
}

export class MemoryFileProvider implements FileProvider {
  /** Normalized key -> the path spelling the caller used, plus its content. */
  private readonly files = new Map<string, { path: string; content: string }>()

  constructor(files: Iterable<MemoryFile> = []) {
    for (const file of files) {
      this.add(file.path, file.content)
    }
  }

  add(filePath: string, content: string): void {
    this.files.set(normalize(filePath), { path: filePath, content })
  }

  remove(filePath: string): void {
    this.files.delete(normalize(filePath))
  }

  paths(): string[] {
    return [...this.files.values()].map((file) => file.path)
  }

  async exists(filePath: string): Promise<boolean> {
    return this.files.has(normalize(filePath))
  }

  async readFile(filePath: string): Promise<string | undefined> {
    return this.files.get(normalize(filePath))?.content
  }

  async readDirectory(dirPath: string): Promise<string[]> {
    const prefix = normalize(dirPath).replace(/[\\/]+$/, '') + path.sep
    const names = new Set<string>()
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const segment = rest.split(/[\\/]/)[0]
      if (segment) names.add(segment)
    }
    return [...names]
  }

  async findFiles(includeGlob: string, excludeGlob?: string): Promise<string[]> {
    const result: string[] = []
    for (const [key, file] of this.files) {
      if (!globMatches(includeGlob, key)) continue
      if (excludeGlob && globMatches(excludeGlob, key)) continue
      result.push(file.path)
    }
    return result
  }
}

/** Case-insensitive on Windows, exact elsewhere — the same rule as `normalizePath`. */
function normalize(filePath: string): string {
  const normalized = path.normalize(filePath)
  return /^[A-Za-z]:/.test(normalized) ? normalized.replace(/^([A-Z]):/, (drive) => drive.toLowerCase()) : normalized
}
