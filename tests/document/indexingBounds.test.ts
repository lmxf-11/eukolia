// @vitest-environment node
/**
 * The bounds on what the open path reads.
 *
 * Two VS Code rules are behind these tests, and `SESSION-NOTES.md` §3 records both
 * as open: a whole-buffer pass is not run over a file past the large-file threshold,
 * and the work does not go unbounded onto the bridge. Here that means
 * `advanced.maxProjectFileSize` — declared in the schema and read by nothing until
 * now — bounds every file the index reads, and the `.bib` pass and root detection
 * issue a bounded number of reads at a time.
 *
 * The concurrency is measured, not asserted from the constant: the mock records how
 * many reads are outstanding together, so a change that removes the bound fails here
 * rather than only in the profiler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BIB_READ_CONCURRENCY, HEAD_READ_CONCURRENCY, WorkspaceService } from '@/services/workspace'
import { projectIndex } from '@/document/projectIndex'
import { latexDocumentAnalyzer } from '@/parser/latexAnalyzer'
import { parseBibtex } from '@/parser/bibParser'
import { settingsManager } from '@core/settings'
import type { FileNode } from '../../src/shared/ipc'

const ROOT = 'C:/project'
const MAIN = `${ROOT}/main.tex`
const MACROS = `${ROOT}/macros.tex`
const HUGE = `${ROOT}/huge.tex`

/** The smallest `advanced.maxProjectFileSize` the schema allows, in KB. */
const MIN_LIMIT_KB = 64
const OVER_LIMIT = `\\newcommand{\\Big}{X}\n${'% padding to push this file past the limit\n'.repeat(1600)}`

const MAIN_SOURCE = ['\\documentclass{article}', '\\input{macros}', '\\input{huge}', '\\begin{document}', '\\end{document}'].join('\n')
const MACROS_SOURCE = '\\newcommand{\\R}{\\mathbb{R}}'

interface Entry {
  isDirectory: boolean
  content: string
}

/** A mock bridge that records how many reads are outstanding at once. */
function createMockFs() {
  const store = new Map<string, Entry>()
  const addFile = (path: string, content = '') => store.set(path.replace(/\/+$/, ''), { isDirectory: false, content })
  const addDir = (path: string) => store.set(path.replace(/\/+$/, ''), { isDirectory: true, content: '' })

  const read = { inFlight: 0, peak: 0 }
  const head = { inFlight: 0, peak: 0 }

  /** Every read takes a turn of the event loop, so overlapping calls are visible. */
  const track = async <T>(counter: { inFlight: number; peak: number }, value: () => T): Promise<T> => {
    counter.inFlight += 1
    counter.peak = Math.max(counter.peak, counter.inFlight)
    await new Promise((resolve) => setTimeout(resolve, 0))
    counter.inFlight -= 1
    return value()
  }

  const api = {
    stat: vi.fn(async (path: string) => {
      const entry = store.get(path.replace(/\/+$/, ''))
      return entry
        ? { path, exists: true, isDirectory: entry.isDirectory, size: entry.content.length, mtimeMs: 1 }
        : { path, exists: false, isDirectory: false, size: 0, mtimeMs: 0 }
    }),
    readFile: vi.fn(async (path: string) => {
      const entry = store.get(path.replace(/\/+$/, ''))
      if (!entry || entry.isDirectory) throw new Error(`File not found: ${path}`)
      return track(read, () => entry.content)
    }),
    readFileHead: vi.fn(async (path: string) => {
      const entry = store.get(path.replace(/\/+$/, ''))
      if (!entry || entry.isDirectory) throw new Error(`File not found: ${path}`)
      return track(head, () => entry.content.slice(0, 8192))
    }),
    listTree: vi.fn(async (dir: string): Promise<FileNode[]> => {
      const root = dir.replace(/\/+$/, '')
      return [...store.entries()]
        .filter(([path]) => path !== root)
        .map(([path, entry]) => ({
          path,
          name: path.split('/').pop() ?? '',
          isDirectory: entry.isDirectory,
          size: entry.content.length,
          mtimeMs: 1
        }))
    }),
    writeFile: vi.fn(async (path: string, content: string) => addFile(path, content)),
    unwatch: vi.fn(async () => undefined),
    setState: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ recentWorkspaces: [] })),
    revealInExplorer: vi.fn(async () => undefined),
    saveFileDialog: vi.fn(async () => null),
    openFileDialog: vi.fn(async () => null),
    getPathForFile: vi.fn((file: { path?: string }) => file.path ?? '')
  }

  return { store, api, read, head, addDir, addFile }
}

let mockFs: ReturnType<typeof createMockFs>
let service: WorkspaceService

/** The service, over the mock bridge, with the project root already declared. */
function installService(): WorkspaceService {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = { eukoliaApi: mockFs.api, addEventListener: () => undefined, removeEventListener: () => undefined }

  const created = new WorkspaceService({
    createAnalyzer: async () => latexDocumentAnalyzer,
    parseBibtex,
    detectRootDocument: () => MAIN
  })

  projectIndex.setProjectRoot(ROOT)
  projectIndex.setFiles(
    [...mockFs.store.entries()]
      .filter(([, entry]) => !entry.isDirectory)
      .map(([path]) => ({ path, name: path.split('/').pop() ?? '', isDirectory: false }))
  )
  return created
}

/** The paths `api.readFile` was actually asked for. */
const readPaths = (): string[] =>
  (mockFs.api.readFile as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0])

beforeEach(() => {
  projectIndex.clearExternalMacros()
  projectIndex.setProjectRoot(null)
  settingsManager.reset('advanced.maxProjectFileSize')
})

afterEach(() => {
  settingsManager.reset('advanced.maxProjectFileSize')
  projectIndex.setProjectRoot(null)
})

describe('advanced.maxProjectFileSize bounds what the index reads', () => {
  it('skips a file the setting says is too large, and indexes the rest', async () => {
    mockFs = createMockFs()
    mockFs.addDir(ROOT)
    mockFs.addFile(MAIN, MAIN_SOURCE)
    mockFs.addFile(MACROS, MACROS_SOURCE)
    mockFs.addFile(HUGE, OVER_LIMIT)
    service = installService()

    settingsManager.setValue('advanced.maxProjectFileSize', MIN_LIMIT_KB, 'user')

    const read = await service.indexIncludedSourceFiles(MAIN)

    // The root and the macro file are indexed; the padded one is not read at all.
    expect(read).toBe(2)
    expect(Object.keys(projectIndex.getMacroTable()).sort()).toEqual(['R'])
    expect(projectIndex.getMacroTable().Big).toBeUndefined()
    expect(readPaths()).not.toContain(HUGE)
  })

  it('reads a file that is exactly the limit', async () => {
    // The bound is "larger than", not "at least": a file the user's setting admits
    // must not be excluded by an off-by-one.
    const definition = '\\newcommand{\\Edge}{Y}\n'
    const body = `${definition}${'%'.repeat(MIN_LIMIT_KB * 1024 - definition.length)}`
    expect(body.length).toBe(MIN_LIMIT_KB * 1024)

    mockFs = createMockFs()
    mockFs.addDir(ROOT)
    mockFs.addFile(MAIN, '\\documentclass{article}\\input{edge}\\begin{document}\\end{document}')
    mockFs.addFile(`${ROOT}/edge.tex`, body)
    service = installService()
    settingsManager.setValue('advanced.maxProjectFileSize', MIN_LIMIT_KB, 'user')

    await service.indexIncludedSourceFiles(MAIN)

    expect(readPaths()).toContain(`${ROOT}/edge.tex`)
    expect(projectIndex.getMacroTable().Edge).toBeTruthy()
  })
})

describe('the open path issues a bounded number of reads', () => {
  const bib = (index: number) => `${ROOT}/refs${index}.bib`

  it(`never has more than ${BIB_READ_CONCURRENCY} bibliographies in flight`, async () => {
    mockFs = createMockFs()
    mockFs.addDir(ROOT)
    mockFs.addFile(MAIN, '\\documentclass{article}\\input{macros}\\begin{document}\\end{document}')
    mockFs.addFile(MACROS, MACROS_SOURCE)
    for (let index = 0; index < 12; index++) {
      mockFs.addFile(bib(index), `@article{key${index}, title={Title ${index}}}`)
    }
    service = installService()

    await service.openFolder(ROOT)

    expect(mockFs.read.peak).toBeGreaterThan(1)
    expect(mockFs.read.peak).toBeLessThanOrEqual(BIB_READ_CONCURRENCY)
    // And the bound is not achieved by reading nothing: all twelve were read.
    for (let index = 0; index < 12; index++) expect(readPaths()).toContain(bib(index))
  })

  it('does not index a bibliography larger than the setting', async () => {
    mockFs = createMockFs()
    mockFs.addDir(ROOT)
    mockFs.addFile(MAIN, '\\documentclass{article}\\input{macros}\\begin{document}\\end{document}')
    mockFs.addFile(MACROS, MACROS_SOURCE)
    mockFs.addFile(`${ROOT}/small.bib`, '@article{small, title={Small}}')
    mockFs.addFile(`${ROOT}/huge.bib`, `@article{huge, title={Huge}}\n${'% padding\n'.repeat(20000)}`)
    service = installService()
    settingsManager.setValue('advanced.maxProjectFileSize', MIN_LIMIT_KB, 'user')

    await service.openFolder(ROOT)

    expect(readPaths()).toContain(`${ROOT}/small.bib`)
    expect(readPaths()).not.toContain(`${ROOT}/huge.bib`)
  })

  it(`never has more than ${HEAD_READ_CONCURRENCY} head reads in flight for root detection`, async () => {
    mockFs = createMockFs()
    mockFs.addDir(ROOT)
    mockFs.addFile(MAIN, '\\documentclass{article}')
    for (let index = 0; index < 100; index++) mockFs.addFile(`${ROOT}/chapter${index}.tex`, '\\section{Chapter}')
    service = installService()

    const root = await service.detectRoot(
      [...mockFs.store.keys()].map((path) => ({ path, name: path.split('/').pop() ?? '', isDirectory: false }))
    )

    expect(root).toBe(MAIN)
    expect(mockFs.head.peak).toBeGreaterThan(0)
    expect(mockFs.head.peak).toBeLessThanOrEqual(HEAD_READ_CONCURRENCY)
    expect((mockFs.api.readFileHead as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(50)
  })
})
