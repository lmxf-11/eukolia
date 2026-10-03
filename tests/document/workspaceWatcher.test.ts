// @vitest-environment node
/**
 * The workspace watcher, as the service wires it.
 *
 * `tests/main/treeWatcher.test.ts` covers the watching itself. What is left is the
 * *lifecycle*: one recursive watch per open folder, started before the tree is read
 * so nothing that happens during the read is missed, stopped when another folder
 * replaces it or the window goes away, and never duplicated by the per-file watch
 * that exists for files outside the project.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceService } from '@/services/workspace'
import { projectIndex } from '@/document/projectIndex'
import { parseBibtex } from '@/parser/bibParser'
import { settingsManager } from '@core/settings'
import type { FileNode } from '../../src/shared/ipc'

const FIRST = 'C:/one'
const SECOND = 'C:/two'

function createMockFs() {
  const api = {
    // The two workspace roots are directories; everything else is a file.
    stat: vi.fn(async (path: string) => ({
      path,
      exists: true,
      isDirectory: path === FIRST || path === SECOND,
      size: 10,
      mtimeMs: 1
    })),
    readFile: vi.fn(async () => '\\documentclass{article}\\begin{document}\\end{document}'),
    listTree: vi.fn(async (dir: string): Promise<FileNode[]> => [
      { path: `${dir}/main.tex`, name: 'main.tex', isDirectory: false, size: 10, mtimeMs: 1 }
    ]),
    watchTree: vi.fn(async (_root: string, _excludes: string[]) => true),
    unwatchTree: vi.fn(async (_root: string, _excludes: string[]) => true),
    watch: vi.fn(async (_paths: string[]) => true),
    unwatch: vi.fn(async (_paths: string[]) => true),
    writeFile: vi.fn(async () => true),
    createFile: vi.fn(async () => true),
    setState: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ recentWorkspaces: [] })),
    revealInExplorer: vi.fn(async () => undefined),
    saveFileDialog: vi.fn(async () => null),
    openFileDialog: vi.fn(async () => null),
    getPathForFile: vi.fn((file: { path?: string }) => file.path ?? '')
  }
  return { api }
}

let mockFs: ReturnType<typeof createMockFs>
let service: WorkspaceService

beforeEach(() => {
  projectIndex.clearExternalMacros()
  projectIndex.setProjectRoot(null)
  settingsManager.reset('files.watcherExclude')

  mockFs = createMockFs()
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = {
    eukoliaApi: mockFs.api,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }

  service = new WorkspaceService({
    createAnalyzer: async () => null,
    parseBibtex,
    detectRootDocument: () => `${FIRST}/main.tex`
  })
})

describe('opening a folder starts exactly one recursive watch', () => {
  it('watches the folder, with the watcher excludes from the settings', async () => {
    settingsManager.setValue('files.watcherExclude', ['node_modules', '.git', 'build'], 'user')

    await service.openFolder(FIRST)

    expect(mockFs.api.watchTree).toHaveBeenCalledTimes(1)
    expect(mockFs.api.watchTree.mock.calls[0]).toEqual([FIRST, ['node_modules', '.git', 'build']])
  })

  it('stops watching the previous folder when another one is opened', async () => {
    await service.openFolder(FIRST)
    await service.openFolder(SECOND)

    expect(mockFs.api.unwatchTree.mock.calls.map((call) => call[0])).toContain(FIRST)
    expect(mockFs.api.watchTree.mock.calls.map((call) => call[0])).toEqual([FIRST, SECOND])
  })

  it('does not start a second watch for the folder already open', async () => {
    await service.openFolder(FIRST)
    await service.openFolder(FIRST)

    // The second open is the same project: re-watching it would leave the first
    // watcher orphaned, and two watchers means two of every event.
    expect(mockFs.api.watchTree).toHaveBeenCalledTimes(1)
    expect(mockFs.api.unwatchTree).not.toHaveBeenCalled()
  })

  it('leaves a file inside the project to the tree watch, and watches one outside it', async () => {
    await service.openFolder(FIRST)

    await service.openFile(`${FIRST}/main.tex`)
    await service.openFile('C:/elsewhere/other.tex')

    const watched = mockFs.api.watch.mock.calls.map((call) => (call[0] as string[])[0])
    expect(watched).not.toContain(`${FIRST}/main.tex`)
    expect(watched).toContain('C:/elsewhere/other.tex')
  })

  it('does not watch at all when the window has no channel for it', async () => {
    // What a window whose preload predates the channel looks like: opening a
    // project must still work, it simply stops noticing outside changes.
    const api = { ...mockFs.api, watchTree: undefined, unwatchTree: undefined }
    const globals = globalThis as unknown as Record<string, unknown>
    globals.window = { eukoliaApi: api, addEventListener: () => undefined, removeEventListener: () => undefined }

    await expect(service.openFolder(FIRST)).resolves.toBeUndefined()
  })
})

describe('a watcher that fails is reported, not swallowed', () => {
  it('emits the failure for whatever surface shows it, and logs it', () => {
    const seen: unknown[] = []
    service.on('watch-error', (event: unknown) => seen.push(event))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    service.handleWatchError({
      path: FIRST,
      code: 'EMFILE',
      message: 'too many open files'
    })

    expect(seen).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toContain('EMFILE')
    warn.mockRestore()
  })
})

describe('construction', () => {
  it('does not throw where there is no window to subscribe to', () => {
    /*
     * `instance.ts` constructs the service at *import* time, and a module that is
     * imported without a window — a Node-environment test, a probe — must not fail
     * on the way in. This is what twelve test files did when the watcher-error
     * subscription first landed in the constructor.
     */
    const globals = globalThis as unknown as Record<string, unknown>
    const saved = globals.window
    delete globals.window
    try {
      expect(
        () =>
          new WorkspaceService({
            createAnalyzer: async () => null,
            parseBibtex,
            detectRootDocument: () => null
          })
      ).not.toThrow()
    } finally {
      globals.window = saved
    }
  })
})
