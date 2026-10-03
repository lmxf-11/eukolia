/**
 * Workspace actions, reopening, file moving, and importing tests.
 *
 * Covers:
 * - Recently closed document history stack and restore (Instructions.md §44)
 * - Auto-save setting validation (§45)
 * - Moving files in the workspace, preserving open buffer state (§67)
 * - Importing external files with collision resolution (§67)
 * - Explorer actions delegation to workspace service (§40, §67)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '../../src/shared/ipc';
import { WorkspaceService } from '../../src/renderer/services/workspace';
import { createExplorerActions } from '../../src/renderer/ui/components/explorerActions';
import { validateSettingValue } from '../../src/renderer/core/settings';

// ---------------------------------------------------------------------------
// Mock Virtual Filesystem & IPC Bridge
// ---------------------------------------------------------------------------

interface MockFsEntry {
  isDirectory: boolean;
  content: string;
  mtimeMs: number;
  size: number;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function createMockFs() {
  const store = new Map<string, MockFsEntry>();

  // Add initial mock directories and files
  const addDir = (path: string) => {
    store.set(normalize(path), { isDirectory: true, content: '', mtimeMs: Date.now(), size: 0 });
  };
  const addFile = (path: string, content = '') => {
    store.set(normalize(path), { isDirectory: false, content, mtimeMs: Date.now(), size: content.length });
  };

  const api = {
    stat: vi.fn(async (path: string) => {
      const entry = store.get(normalize(path));
      if (!entry) return { exists: false, isDirectory: false, mtimeMs: 0, size: 0 };
      return { exists: true, isDirectory: entry.isDirectory, mtimeMs: entry.mtimeMs, size: entry.size };
    }),

    readFile: vi.fn(async (path: string) => {
      const entry = store.get(normalize(path));
      if (!entry || entry.isDirectory) throw new Error(`File not found: ${path}`);
      return entry.content;
    }),

    writeFile: vi.fn(async (path: string, content: string) => {
      addFile(path, content);
    }),

    renamePath: vi.fn(async (source: string, target: string) => {
      const entry = store.get(normalize(source));
      if (!entry) throw new Error(`Source not found: ${source}`);
      store.delete(normalize(source));
      store.set(normalize(target), entry);
    }),

    copyPath: vi.fn(async (source: string, target: string) => {
      const entry = store.get(normalize(source));
      if (!entry) throw new Error(`Source not found: ${source}`);
      store.set(normalize(target), { ...entry });
    }),

    createFile: vi.fn(async (path: string, content = '') => {
      addFile(path, content);
    }),

    createDirectory: vi.fn(async (path: string) => {
      addDir(path);
    }),

    deletePath: vi.fn(async (path: string) => {
      store.delete(normalize(path));
    }),

    listTree: vi.fn(async (dir: string): Promise<FileNode[]> => {
      const nodes: FileNode[] = [];
      const normDir = normalize(dir);
      for (const [p, entry] of store.entries()) {
        const normP = normalize(p);
        if (normP === normDir) continue;
        if (!normDir || normP.startsWith(normDir + '/')) {
          nodes.push({
            path: p,
            name: p.split('/').pop() ?? '',
            isDirectory: entry.isDirectory,
            size: entry.size,
            mtimeMs: entry.mtimeMs
          });
        }
      }
      return nodes;
    }),

    unwatch: vi.fn(async () => undefined),
    setState: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ recentWorkspaces: [] })),
    revealInExplorer: vi.fn(async () => undefined),
    saveFileDialog: vi.fn(async () => null),
    openFileDialog: vi.fn(async () => null),
    getPathForFile: vi.fn((file: { path?: string }) => file.path ?? '')
  };

  return { store, addDir, addFile, api };
}

let mockFs: ReturnType<typeof createMockFs>;
let service: WorkspaceService;

beforeEach(() => {
  mockFs = createMockFs();
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = {
    eukoliaApi: mockFs.api,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };

  mockFs.addDir('/workspace');
  mockFs.addDir('/workspace/sections');
  mockFs.addFile('/workspace/main.tex', '\\documentclass{article}\\begin{document}Hello\\end{document}');
  mockFs.addFile('/workspace/sections/intro.tex', '\\section{Introduction}');
  mockFs.addFile('/workspace/references.bib', '@article{knuth1984, title={Literate Programming}}');

  service = new WorkspaceService({
    createAnalyzer: async () => null,
    parseBibtex: () => [],
    detectRootDocument: (files) => {
      const main = files.find((f) => !f.isDirectory && f.name.startsWith('main') && f.name.endsWith('.tex'));
      return main ? main.path : (files.find((f) => !f.isDirectory && f.name.endsWith('.tex'))?.path ?? '/workspace/main.tex');
    }
  });
});

// ---------------------------------------------------------------------------
// Coalescing the project tree listing
// ---------------------------------------------------------------------------

/**
 * Re-reading the tree is a full recursive walk of the workspace plus a rebuild of the
 * project index's file map and a React state update, and it had a caller for every
 * explicit save, every file operation, every external change and the refresh button.
 * These are the two promises the coalescing has to keep: callers share the work, and
 * no caller is handed an answer that predates its own change.
 */
describe('WorkspaceService: the tree listing is shared between callers', () => {
  it('runs one listing for callers that arrive together', async () => {
    await service.openFolder('/workspace');
    const listTree = mockFs.api.listTree as unknown as { mock: { calls: unknown[] } };
    const before = listTree.mock.calls.length;

    await Promise.all([service.refreshTree(), service.refreshTree(), service.refreshTree()]);

    // One listing for the caller that got there first, and one more for the two that
    // arrived while it was running — not three, and not one that ignores them.
    expect(listTree.mock.calls.length - before).toBe(2);
  });

  it('gives every caller the tree that includes its own change', async () => {
    await service.openFolder('/workspace');

    // A file appears while a listing is in flight: the caller that saw it happen must
    // not be handed the tree from before it.
    const first = service.refreshTree();
    mockFs.addFile('/workspace/late.tex', '\\section{Late}');
    await first;

    const tree = await service.refreshTree();
    const paths = JSON.stringify(tree);
    expect(paths).toContain('late.tex');
  });

  it('does exactly one listing when nothing overlaps', async () => {
    await service.openFolder('/workspace');
    const listTree = mockFs.api.listTree as unknown as { mock: { calls: unknown[] } };
    const before = listTree.mock.calls.length;
    await service.refreshTree();
    expect(listTree.mock.calls.length - before).toBe(1);
  });

  it('does not walk the tree for a save of a file the tree already lists', async () => {
    // A save cannot change the shape of the tree, and this walk is the whole
    // workspace: on a 2 846-file project it ran on every Ctrl+S and every autosave.
    await service.openFolder('/workspace');
    const doc = await service.openFile('/workspace/main.tex');
    const listTree = mockFs.api.listTree as unknown as { mock: { calls: unknown[] } };
    const before = listTree.mock.calls.length;

    await service.save(doc);

    expect(listTree.mock.calls.length - before).toBe(0);
  });

  it('does walk it when the save is what puts the file in the tree', async () => {
    await service.openFolder('/workspace');
    // A file the tree has never seen: this is the case the walk is still for.
    mockFs.addFile('/workspace/fresh.tex', '\\section{Fresh}');
    const doc = await service.openFile('/workspace/fresh.tex');
    const listTree = mockFs.api.listTree as unknown as { mock: { calls: unknown[] } };
    const before = listTree.mock.calls.length;

    await service.save(doc);

    expect(listTree.mock.calls.length - before).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Recently closed document stack & reopenLastClosed
// ---------------------------------------------------------------------------

describe('WorkspaceService: Recently Closed Stack', () => {
  it('starts with an empty recently closed list', () => {
    expect(service.getRecentlyClosed()).toEqual([]);
  });

  it('records closed documents in LIFO order', async () => {
    await service.openFile('/workspace/main.tex');
    await service.openFile('/workspace/sections/intro.tex');

    expect(service.closeDocument('/workspace/main.tex')).toBe(true);
    expect(service.getRecentlyClosed()).toEqual(['/workspace/main.tex']);

    expect(service.closeDocument('/workspace/sections/intro.tex')).toBe(true);
    expect(service.getRecentlyClosed()).toEqual(['/workspace/main.tex', '/workspace/sections/intro.tex']);
  });

  it('does not record untitled documents in recently closed list', () => {
    const untitled = service.createUntitled('some draft');
    expect(untitled.uri.startsWith('untitled:')).toBe(true);

    expect(service.closeDocument(untitled.uri, { force: true })).toBe(true);
    expect(service.getRecentlyClosed()).toEqual([]);
  });

  it('moves duplicate closures to the top of the stack without duplicates', async () => {
    await service.openFile('/workspace/main.tex');
    await service.openFile('/workspace/sections/intro.tex');

    service.closeDocument('/workspace/main.tex');
    service.closeDocument('/workspace/sections/intro.tex');

    // Reopen main.tex and close it again
    await service.openFile('/workspace/main.tex');
    service.closeDocument('/workspace/main.tex');

    expect(service.getRecentlyClosed()).toEqual(['/workspace/sections/intro.tex', '/workspace/main.tex']);
  });

  it('caps the recently closed list at 30 items', async () => {
    for (let i = 1; i <= 35; i++) {
      const path = `/workspace/doc-${i}.tex`;
      mockFs.addFile(path, `Doc ${i}`);
      await service.openFile(path);
      service.closeDocument(path);
    }

    const recent = service.getRecentlyClosed();
    expect(recent.length).toBe(30);
    expect(recent[0]).toBe('/workspace/doc-6.tex');
    expect(recent[recent.length - 1]).toBe('/workspace/doc-35.tex');
  });

  it('reopenLastClosed pops and reopens the most recently closed document', async () => {
    await service.openFile('/workspace/main.tex');
    await service.openFile('/workspace/sections/intro.tex');

    service.closeDocument('/workspace/main.tex');
    service.closeDocument('/workspace/sections/intro.tex');

    // First reopen should restore intro.tex
    const reopened1 = await service.reopenLastClosed();
    expect(reopened1).toBe('/workspace/sections/intro.tex');
    expect(service.getActive()?.doc.uri).toBe('/workspace/sections/intro.tex');
    expect(service.getRecentlyClosed()).toEqual(['/workspace/main.tex']);

    // Second reopen should restore main.tex
    const reopened2 = await service.reopenLastClosed();
    expect(reopened2).toBe('/workspace/main.tex');
    expect(service.getActive()?.doc.uri).toBe('/workspace/main.tex');
    expect(service.getRecentlyClosed()).toEqual([]);

    // Third reopen on empty stack returns null
    const reopened3 = await service.reopenLastClosed();
    expect(reopened3).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WorkspaceService: File Moving
// ---------------------------------------------------------------------------

describe('WorkspaceService: move', () => {
  it('calls renamePath for an unopened file and returns target path', async () => {
    const target = await service.move('/workspace/references.bib', '/workspace/sections');
    expect(target).toBe('/workspace/sections/references.bib');
    expect(mockFs.api.renamePath).toHaveBeenCalledWith('/workspace/references.bib', '/workspace/sections/references.bib');
  });

  it('returns target without renaming if source equals target', async () => {
    const target = await service.move('/workspace/main.tex', '/workspace');
    expect(target).toBe('/workspace/main.tex');
    expect(mockFs.api.renamePath).not.toHaveBeenCalled();
  });

  it('updates the open DocumentModel and preserves content and active state when moved', async () => {
    const doc = await service.openFile('/workspace/main.tex');
    expect(service.getActiveDocument()?.uri).toBe('/workspace/main.tex');

    const target = await service.move('/workspace/main.tex', '/workspace/sections');
    expect(target).toBe('/workspace/sections/main.tex');

    // Active buffer updated to the new path
    const active = service.getActiveDocument();
    expect(active?.uri).toBe('/workspace/sections/main.tex');
    expect(active?.getText()).toBe(doc.getText());

    // Old path is no longer in open documents
    expect(service.getOpenDocuments().some((e) => e.doc.uri === '/workspace/main.tex')).toBe(false);
  });

  it('updates recent closed stack if a previously closed file is moved', async () => {
    await service.openFile('/workspace/main.tex');
    service.closeDocument('/workspace/main.tex');
    expect(service.getRecentlyClosed()).toEqual(['/workspace/main.tex']);

    await service.move('/workspace/main.tex', '/workspace/sections');
    expect(service.getRecentlyClosed()).toEqual(['/workspace/sections/main.tex']);
  });
});

// ---------------------------------------------------------------------------
// WorkspaceService: File Importing
// ---------------------------------------------------------------------------

describe('WorkspaceService: importFile', () => {
  it('copies external file into destination directory', async () => {
    mockFs.addFile('/external/figure.png', 'PNGDATA');

    const target = await service.importFile('/external/figure.png', '/workspace/sections');
    expect(target).toBe('/workspace/sections/figure.png');
    expect(mockFs.api.copyPath).toHaveBeenCalledWith('/external/figure.png', '/workspace/sections/figure.png');
  });

  it('resolves naming collisions by appending numeric suffix', async () => {
    mockFs.addFile('/external/plot.pdf', 'PDFDATA');
    mockFs.addFile('/workspace/sections/plot.pdf', 'EXISTING1');
    mockFs.addFile('/workspace/sections/plot-2.pdf', 'EXISTING2');

    const target = await service.importFile('/external/plot.pdf', '/workspace/sections');
    expect(target).toBe('/workspace/sections/plot-3.pdf');
    expect(mockFs.api.copyPath).toHaveBeenCalledWith('/external/plot.pdf', '/workspace/sections/plot-3.pdf');
  });
});

// ---------------------------------------------------------------------------
// ExplorerActions: Delegation
// ---------------------------------------------------------------------------

describe('ExplorerActions: move and importFile', () => {
  it('delegates move and importFile to workspaceService', async () => {
    const actions = createExplorerActions();

    // Verify move delegation
    expect(typeof actions.move).toBe('function');
    const moveSpy = vi.spyOn(service, 'move').mockResolvedValue('/workspace/sections/test.tex');
    const importSpy = vi.spyOn(service, 'importFile').mockResolvedValue('/workspace/sections/pic.png');

    // Overwrite the singleton method for the test scope
    const { workspaceService } = await import('../../src/renderer/services/instance');
    const origMove = workspaceService.move;
    const origImport = workspaceService.importFile;
    try {
      workspaceService.move = vi.fn().mockResolvedValue('/workspace/moved.tex');
      workspaceService.importFile = vi.fn().mockResolvedValue('/workspace/imported.png');

      const moved = await actions.move('/workspace/old.tex', '/workspace');
      expect(moved).toBe('/workspace/moved.tex');
      expect(workspaceService.move).toHaveBeenCalledWith('/workspace/old.tex', '/workspace');

      const imported = await actions.importFile('/outside/image.png', '/workspace');
      expect(imported).toBe('/workspace/imported.png');
      expect(workspaceService.importFile).toHaveBeenCalledWith('/outside/image.png', '/workspace');
    } finally {
      workspaceService.move = origMove;
      workspaceService.importFile = origImport;
      moveSpy.mockRestore();
      importSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Settings: files.autoSave validation
// ---------------------------------------------------------------------------

describe('files.autoSave setting validation', () => {
  it('accepts onFocusChange and onWindowChange', () => {
    expect(validateSettingValue('files.autoSave', 'off')).toBeUndefined();
    expect(validateSettingValue('files.autoSave', 'afterDelay')).toBeUndefined();
    expect(validateSettingValue('files.autoSave', 'onFocusChange')).toBeUndefined();
    expect(validateSettingValue('files.autoSave', 'onWindowChange')).toBeUndefined();
  });

  it('rejects invalid autoSave options', () => {
    expect(validateSettingValue('files.autoSave', 'invalidOption')).toBeDefined();
    expect(validateSettingValue('files.autoSave', true)).toBeDefined();
  });
});

describe('per-project tabs and new file creation', () => {
  it('creates a new .tex file in the active project folder', async () => {
    await service.openFolder('/workspace');

    const created = await service.createProjectNewFile('test content');
    expect(created).toBe('/workspace/untitled.tex');
    expect(service.getOpenDocuments().some((e) => e.doc.uri === '/workspace/untitled.tex')).toBe(true);

    const second = await service.createProjectNewFile('second content');
    expect(second).toBe('/workspace/untitled-1.tex');
  });

  it('switches open tabs per project when opening a different folder', async () => {
    mockFs.addDir('/projectA');
    mockFs.addFile('/projectA/mainA.tex', 'Project A');
    mockFs.addFile('/projectA/subA.tex', 'Sub A');
    mockFs.addDir('/projectB');
    mockFs.addFile('/projectB/mainB.tex', 'Project B');

    await service.openFolder('/projectA');
    await service.openFile('/projectA/subA.tex');
    expect(service.getOpenDocuments()).toHaveLength(2);

    // Switch to Project B
    await service.openFolder('/projectB');
    const openInB = service.getOpenDocuments();
    expect(openInB.every((e) => e.doc.uri.startsWith('/projectB'))).toBe(true);

    // Switch back to Project A: should restore Project A's saved tabs
    await service.openFolder('/projectA');
    const openInA = service.getOpenDocuments();
    expect(openInA.map((e) => e.doc.uri)).toContain('/projectA/mainA.tex');
    expect(openInA.map((e) => e.doc.uri)).toContain('/projectA/subA.tex');
    expect(openInA.every((e) => e.doc.uri.startsWith('/projectA'))).toBe(true);
  });
});
