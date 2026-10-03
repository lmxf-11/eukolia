/**
 * Macros that live in an `\input`ed file.
 *
 * A LaTeX project keeps its macros in one file the root document includes, and
 * the mathematics in every chapter uses them. Only an open buffer is a
 * `DocumentModel`, so before `indexIncludedSourceFiles` existed the macro file
 * contributed nothing at all — and the failure was silent, because MathJax
 * renders an undefined control sequence as its own name rather than as an error.
 * These tests assert the project table gains those macros without the file ever
 * being opened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceService } from '@/services/workspace'
import { projectIndex } from '@/document/projectIndex'
import { latexDocumentAnalyzer } from '@/parser/latexAnalyzer'
import { parseBibtex } from '@/parser/bibParser'
// `@` resolves to `src/renderer`, and this is the one shared module the renderer
// imports from outside itself, so it is reached by path.
import type { FileNode } from '../../src/shared/ipc'

const ROOT = 'C:/project'
const MAIN = `${ROOT}/main.tex`
const MACROS = `${ROOT}/macros.tex`
const CHAPTER = `${ROOT}/chapter.tex`
const DEEP_MACROS = `${ROOT}/sections/deep-macros.tex`

const MAIN_SOURCE = [
  '\\documentclass{article}',
  '\\input{macros}',
  '\\begin{document}',
  '\\input{chapter}',
  'The reals $\\R$ and $\\half{1}{2}$.',
  '\\end{document}',
].join('\n')

const MACROS_SOURCE = [
  '\\newcommand{\\R}{\\mathbb{R}}',
  '\\newcommand{\\half}[2]{\\frac{#1}{#2}}',
].join('\n')

const CHAPTER_SOURCE = [
  '\\input{sections/deep-macros}',
  'Chapter using $\\deep{3}$.',
].join('\n')

const DEEP_MACROS_SOURCE = '\\newcommand{\\deep}[1]{\\mathcal{D}_{#1}}'

interface MockEntry {
  isDirectory: boolean
  content: string
}

function createMockFs(files: Array<[string, string]>) {
  const store = new Map<string, MockEntry>()
  const add = (path: string, content = '') =>
    store.set(path.replace(/\/+$/, ''), { isDirectory: false, content })

  for (const [path, content] of files) add(path, content)

  const nodes = (): FileNode[] =>
    [...store.entries()].map(([path, entry]) => ({
      path,
      name: path.split('/').pop() ?? '',
      isDirectory: entry.isDirectory,
      size: entry.content.length,
      mtimeMs: 1,
    }))

  const api = {
    stat: vi.fn(async (path: string) => {
      const entry = store.get(path);
      return entry
        ? { exists: true, isDirectory: entry.isDirectory, mtimeMs: 1, size: entry.content.length }
        : { exists: false, isDirectory: false, mtimeMs: 0, size: 0 }
    }),
    readFile: vi.fn(async (path: string) => {
      const entry = store.get(path)
      if (!entry || entry.isDirectory) throw new Error(`File not found: ${path}`)
      return entry.content
    }),
    writeFile: vi.fn(async (path: string, content: string) => add(path, content)),
    listTree: vi.fn(async (): Promise<FileNode[]> => nodes()),
    unwatch: vi.fn(async () => undefined),
    setState: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({})),
    revealInExplorer: vi.fn(async () => undefined),
    saveFileDialog: vi.fn(async () => null),
    openFileDialog: vi.fn(async () => null),
    getPathForFile: vi.fn((file: { path?: string }) => file.path ?? ''),
  }

  return { store, api }
}

let mockFs: ReturnType<typeof createMockFs>
let service: WorkspaceService

beforeEach(() => {
  projectIndex.clearExternalMacros()
  projectIndex.setProjectRoot(null)

  mockFs = createMockFs([
    [MAIN, MAIN_SOURCE],
    [MACROS, MACROS_SOURCE],
    [CHAPTER, CHAPTER_SOURCE],
    [DEEP_MACROS, DEEP_MACROS_SOURCE],
    [`${ROOT}/notes.txt`, 'not a LaTeX file'],
  ])

  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = {
    eukoliaApi: mockFs.api,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }

  service = new WorkspaceService({
    createAnalyzer: async () => latexDocumentAnalyzer,
    parseBibtex,
    detectRootDocument: () => MAIN,
  })

  // The file list is what tells the index which `\input` targets are real files
  // in the project; `openProject` sets it, and these tests call the reader
  // directly so they set it the same way.
  projectIndex.setProjectRoot(ROOT)
  projectIndex.setFiles(
    [...mockFs.store.keys()].map(path => ({
      path,
      name: path.split('/').pop() ?? '',
      isDirectory: false,
    }))
  )
})

describe('reading the files a document includes', () => {
  it('registers the macros of an `\\input`ed file, and of what that file includes', async () => {
    const read = await service.indexIncludedSourceFiles(MAIN)

    // The root, the file it inputs, the chapter, and the file the chapter inputs.
    expect(read).toBe(4)
    // Names are keyed without the backslash, which is the shape the rest of the
    // project already speaks: `latexWorkshopCompletion` strips it from the same
    // field, and `buildScopeMetadata` lists these as completion commands.
    expect(Object.keys(projectIndex.getMacroTable()).sort()).toEqual([
      'R',
      'deep',
      'half',
    ])
    expect(projectIndex.getMacroTable()['R']).toBe('\\newcommand{\\R}{\\mathbb{R}}')
  })

  it('reads what the document includes, not what its files happen to be called', async () => {
    /*
     * The walk used to be seeded with every project file whose *name* matched
     * `/macro|preamble|theorem|def/i` — 362 files on a 2 846-file project, of which
     * the 200-file limit let 200 through, at a measured ~133 ms of analysis each.
     * That is a guess at where a project keeps its macros, and a macro file the
     * document does not `\input` cannot affect it: LaTeX cannot see it either.
     *
     * These three are named exactly like the guess, and none of them is reachable.
     */
    for (const [name, content] of [
      ['unrelated-macros.tex', '\\newcommand{\\unrelated}{x}'],
      ['preamble.tex', '\\newcommand{\\frompreamble}{y}'],
      ['theorem-notes.tex', '\\newcommand{\\fromnotes}{z}'],
    ] as const) {
      mockFs.store.set(`${ROOT}/${name}`, { isDirectory: false, content })
    }
    projectIndex.setFiles(
      [...mockFs.store.keys()].map(path => ({
        path,
        name: path.split('/').pop() ?? '',
        isDirectory: false,
      }))
    )

    const read = await service.indexIncludedSourceFiles(MAIN)

    // The same four files as the reachable walk has always read, and nothing else.
    expect(read).toBe(4)
    const table = projectIndex.getMacroTable()
    expect(Object.keys(table)).not.toContain('unrelated')
    expect(Object.keys(table)).not.toContain('frompreamble')
    expect(Object.keys(table)).not.toContain('fromnotes')
  })

  it('notifies the index subscribers, which is what reaches the editor', async () => {
    const seen = vi.fn()
    const stop = projectIndex.on('index-change', seen)

    await service.indexIncludedSourceFiles(MAIN)

    expect(seen).toHaveBeenCalled()
    stop()
  })

  it('records where a macro came from, so completion can point at the file', async () => {
    await service.indexIncludedSourceFiles(MAIN)

    const macro = projectIndex.getMacro('R')
    expect(macro?.file).toBe(MACROS)
    expect(macro?.definition).toContain('\\mathbb{R}')
  })

  it('reads each file once per pass, however many times it is included', async () => {
    await service.indexIncludedSourceFiles(MAIN)

    // Every file is read exactly once: the chapter includes a file the root also
    // reaches, and the visited set is what keeps that from being read twice.
    const paths = mockFs.api.readFile.mock.calls.map(call => call[0])
    expect(paths).toHaveLength(4)
    expect(new Set(paths).size).toBe(4)
  })

  it('contributes nothing for a file that cannot be read', async () => {
    mockFs.api.readFile.mockImplementation(async (path: string) => {
      if (path === MACROS) throw new Error('deleted')
      const entry = mockFs.store.get(path)
      if (!entry) throw new Error(`File not found: ${path}`)
      return entry.content
    })

    const read = await service.indexIncludedSourceFiles(MAIN)

    // The chapter and its own include are still read; the missing file is skipped
    // rather than failing the pass.
    expect(read).toBe(3)
    expect(projectIndex.getMacroTable()['deep']).toBeTruthy()
    expect(projectIndex.getMacroTable()['R']).toBeUndefined()
  })

  it('reads nothing when there is no analyzer to parse with', async () => {
    const bare = new WorkspaceService({
      createAnalyzer: async () => null,
      parseBibtex,
      detectRootDocument: () => MAIN,
    })

    expect(await bare.indexIncludedSourceFiles(MAIN)).toBe(0)
  })
})

describe('the project macro table', () => {
  it('prefers the open buffer when it defines the same macro', async () => {
    await service.indexIncludedSourceFiles(MAIN)
    expect(projectIndex.getMacroTable()['R']).toBe('\\newcommand{\\R}{\\mathbb{R}}')

    // Open the macro file and change the definition: the buffer is what the user
    // is looking at, so it is the definition in force.
    const doc = await service.openFile(MACROS)
    doc.setText('\\newcommand{\\R}{\\mathbf{R}}', 'code')

    // The analysis is produced off the change path.
    await vi.waitFor(() => {
      expect(projectIndex.getMacroTable()['R']).toContain('\\mathbf')
    })
  })

  it('drops the external macros when the project is closed', async () => {
    await service.indexIncludedSourceFiles(MAIN)
    // `\half` is defined only in the `\input`ed file, so it is a macro the
    // project table holds on the index's behalf alone.
    expect(projectIndex.getMacroTable().half).toBeTruthy()

    projectIndex.clearExternalMacros()

    expect(projectIndex.getMacroTable().half).toBeUndefined()
    // Macros of *open buffers* are the documents' own and are not dropped with
    // them: closing a project does not make an open file's macros unknown.
    projectIndex.setFiles([])
    projectIndex.setProjectRoot(null)
  })
})
