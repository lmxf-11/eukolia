// @vitest-environment jsdom

/**
 * The Explorer view itself: what it shows, and what it marks.
 *
 * Two things are pinned here that the filter tests cannot reach, because both
 * are about the rendered row rather than the data behind it:
 *
 *  * the **full path of the open project**, which is the only thing that says
 *    *which* folder the names below it are relative to;
 *  * the **active PDF**, marked distinctly from the document open in the editor.
 *    A PDF is never an open document — clicking one hands it to the viewer — so
 *    the editor's `activeDocument` comparison can never be true for it, and the
 *    file being read was the one row that never lit up.
 *
 * The component is mounted against a fake app state, following
 * `status-bar.render.test.ts`: the project has no DOM testing dependency and the
 * component reads everything through `useAppState`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileNode } from '../../src/shared/ipc';

const fake = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  /** Settings the component reads through the settings manager. */
  settings: {} as Record<string, unknown>
}));

vi.mock('../../src/renderer/ui/state', () => ({ useAppState: () => fake.state }));

vi.mock('../../src/renderer/core/settings', () => ({
  settingsManager: {
    getValue: (key: string) => fake.settings[key],
    on: () => () => undefined
  },
  setting: {
    list: (key: string) => {
      const value = fake.settings[key];
      return Array.isArray(value) ? (value as string[]) : [];
    }
  }
}));

// The component imports the workspace service and the project index indirectly
// through `createExplorerActions`; neither is exercised by rendering.
vi.mock('../../src/renderer/services/instance', () => ({
  workspaceService: new Proxy({}, { get: () => () => Promise.resolve(undefined) })
}));
vi.mock('../../src/renderer/document/projectIndex', () => ({
  projectIndex: {
    on: () => () => undefined,
    getProjectRoot: () => null,
    getMacroTable: () => ({}),
    getSymbols: () => [],
    getLabels: () => [],
    getCitations: () => [],
    getBibEntries: () => []
  }
}));

const { Sidebar } = await import('../../src/renderer/ui/components/Sidebar');

const PROJECT_ROOT = 'D:/Projects/Paper';

const file = (name: string): FileNode => ({
  name,
  path: `${PROJECT_ROOT}/${name}`,
  isDirectory: false,
  size: 0,
  mtimeMs: 0
});

/** A small stand-in for the real default list: no build artefacts in it. */
const DEFAULT_TYPES = ['tex', 'ltx', 'pdf', 'md', 'bib', 'png'];

let container: HTMLDivElement;
let root: Root;

/** Mounts the Explorer with the given overrides and returns the container. */
async function mount(
  overrides: Record<string, unknown> & { explorerInclude?: string[] } = {}
): Promise<void> {
  const { explorerInclude, ...rest } = overrides;
  fake.settings = { 'files.explorerInclude': explorerInclude ?? DEFAULT_TYPES };
  fake.state = {
    sidebarView: 'explorer',
    setSidebarView: () => undefined,
    fileTree: [file('main.tex'), file('main.pdf'), file('refs.bib'), file('main.aux')],
    workspace: { workspacePath: PROJECT_ROOT, workspaceName: 'Paper', documents: [], activeUri: null, recentWorkspaces: [], building: false },
    activeDocument: null,
    pdf: { path: null, visible: true, page: 1, pageCount: 0, zoom: 1, zoomMode: 'page-width', scrollTop: 0, loading: false, error: null, searchQuery: '', searchMatches: 0, outline: [] },
    openFile: () => Promise.resolve(),
    openFolder: () => Promise.resolve(),
    setStatusMessage: () => undefined,
    setPdfPath: () => undefined,
    setPdfVisible: () => undefined,
    ...rest
  };
  await act(async () => {
    root.render(React.createElement(Sidebar));
  });
  await act(async () => {});
}

const rows = (): HTMLElement[] => [...container.querySelectorAll('[role="treeitem"]')] as HTMLElement[];
const rowNamed = (name: string): HTMLElement | undefined =>
  rows().find((row) => rowLabel(row) === name);

/**
 * The file-name label of a row, without the decoration beside it.
 *
 * `textContent` would concatenate the active-PDF badge into the name, so the
 * label is read from the span that holds it.
 */
const rowLabel = (row: HTMLElement): string =>
  (row.querySelector('[data-testid="explorer-row-name"]')?.textContent ?? '').trim();
const names = (): string[] => rows().map(rowLabel);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('the project path', () => {
  it('shows the full path of the open project', async () => {
    await mount();
    const pathRow = container.querySelector('[data-testid="explorer-project-path"]');
    expect(pathRow, 'the Explorer must state which folder the tree is rooted at').toBeTruthy();
    expect(pathRow?.textContent).toBe(PROJECT_ROOT);
    expect(pathRow?.getAttribute('title')).toBe(PROJECT_ROOT);
  });

  it('is absent when no folder is open', async () => {
    await mount({
      workspace: { workspacePath: null, workspaceName: null, documents: [], activeUri: null, recentWorkspaces: [], building: false }
    });
    expect(container.querySelector('[data-testid="explorer-project-path"]')).toBeNull();
    expect(container.textContent).toContain('No folder is open.');
  });
});

describe('marking the active PDF', () => {
  const pdfState = (path: string | null, visible = true) => ({
    path,
    visible,
    page: 1,
    pageCount: 3,
    zoom: 1,
    zoomMode: 'page-width',
    scrollTop: 0,
    loading: false,
    error: null,
    searchQuery: '',
    searchMatches: 0,
    outline: []
  });

  it('marks the PDF the viewer is showing', async () => {
    await mount({ pdf: pdfState(`${PROJECT_ROOT}/main.pdf`) });

    const row = rowNamed('main.pdf');
    expect(row?.getAttribute('data-active')).toBe('true');
    expect(row?.getAttribute('data-active-kind')).toBe('pdf');
    expect(row?.getAttribute('aria-current')).toBe('true');
  });

  it('marks only the PDF name, and leaves its row plain', async () => {
    // A PDF is never an open document, so filling its row the way the editor's
    // file is filled would claim it was one.
    await mount({ pdf: pdfState(`${PROJECT_ROOT}/main.pdf`) });

    const row = rowNamed('main.pdf');
    const name = row?.querySelector<HTMLElement>('[data-testid="explorer-row-name"]');
    expect(name?.style.color, 'the name carries the active colour').toBe('var(--eu-accent)');
    expect(Number(name?.style.fontWeight)).toBeGreaterThanOrEqual(600);
    expect(row?.style.background, 'the row itself stays unhighlighted').toBe('transparent');
  });

  it('adds no badge to the PDF name', async () => {
    // The mark is the name's own colour; a trailing label crowded the tree and
    // said what the file extension already says.
    await mount({ pdf: pdfState(`${PROJECT_ROOT}/main.pdf`) });

    expect(container.querySelector('[data-testid="explorer-active-pdf"]')).toBeNull();
    expect(rowLabel(rowNamed('main.pdf')!)).toBe('main.pdf');
    expect(rowNamed('main.pdf')?.textContent?.trim()).toBe('main.pdf');
  });

  it('fills the row of the document open in the editor', async () => {
    // The text file keeps the familiar selected-row background — including for
    // the plain-text types, which are documents like any other.
    await mount({
      activeDocument: { doc: { uri: `${PROJECT_ROOT}/main.tex`, filename: 'main.tex', languageId: 'latex' }, recovered: false, externalChange: false, pinned: false }
    });

    const row = rowNamed('main.tex');
    const name = row?.querySelector<HTMLElement>('[data-testid="explorer-row-name"]');
    expect(row?.style.background, 'the row is filled').toBe('var(--eu-bg-selection-list)');
    expect(name?.style.color, 'and the name is left alone').toBe('');
  });

  it('fills the row for a non-LaTeX document too', async () => {
    // `.md`, `.py` and the rest are documents the editor opens, so they are
    // marked the same way as a `.tex` — the fill is not LaTeX-specific.
    await mount({
      explorerInclude: ['md', 'py', 'pdf'],
      fileTree: [file('notes.md'), file('script.py'), file('main.pdf')],
      activeDocument: { doc: { uri: `${PROJECT_ROOT}/notes.md`, filename: 'notes.md', languageId: 'markdown' }, recovered: false, externalChange: false, pinned: false }
    });

    expect(rowNamed('notes.md')?.style.background).toBe('var(--eu-bg-selection-list)');
    expect(rowNamed('script.py')?.style.background).toBe('transparent');
  });

  it('distinguishes the active PDF from the document open in the editor', async () => {
    await mount({
      pdf: pdfState(`${PROJECT_ROOT}/main.pdf`),
      activeDocument: { doc: { uri: `${PROJECT_ROOT}/main.tex`, filename: 'main.tex', languageId: 'latex' }, recovered: false, externalChange: false, pinned: false }
    });

    const tex = rowNamed('main.tex');
    const pdf = rowNamed('main.pdf');

    // Both are marked, and marked as different things — the whole point, since
    // one is in the editor and the other is in the viewer.
    expect(tex?.getAttribute('data-active-kind')).toBe('document');
    expect(pdf?.getAttribute('data-active-kind')).toBe('pdf');
    expect(tex?.getAttribute('aria-current')).toBeNull();
    expect(pdf?.getAttribute('aria-current')).toBe('true');

    // Different shapes, not two shades of one: the editor's file fills its row,
    // the viewer's colours only its name.
    expect(tex?.style.background).toBe('var(--eu-bg-selection-list)');
    expect(pdf?.style.background).toBe('transparent');
    expect(pdf?.querySelector<HTMLElement>('[data-testid="explorer-row-name"]')?.style.color).toBe('var(--eu-accent)');
    expect(tex?.querySelector<HTMLElement>('[data-testid="explorer-row-name"]')?.style.color).toBe('');
  });

  it('leaves an unmarked row entirely plain', async () => {
    await mount({ pdf: pdfState(`${PROJECT_ROOT}/main.pdf`) });
    const other = rowNamed('main.tex');
    const name = other?.querySelector<HTMLElement>('[data-testid="explorer-row-name"]');
    expect(other?.style.background).toBe('transparent');
    expect(name?.style.color).toBe('');
    expect(name?.style.fontWeight).toBe('');
  });

  it('marks nothing when the viewer holds no document', async () => {
    await mount({ pdf: pdfState(null) });
    expect(rows().every((row) => row.getAttribute('data-active') !== 'true')).toBe(true);
  });

  it('stops marking a PDF once the viewer is hidden', async () => {
    // `pdf.visible` is what makes the viewer the thing being read; with the pane
    // closed the file is not "the active PDF" any more.
    await mount({ pdf: pdfState(`${PROJECT_ROOT}/main.pdf`, false) });
    const row = rowNamed('main.pdf');
    expect(row?.getAttribute('data-active')).toBeNull();
    // And its name goes back to plain, so no accent colour is left behind.
    expect(row?.querySelector<HTMLElement>('[data-testid="explorer-row-name"]')?.style.color).toBe('');
  });

  it('does not mark a different PDF in the same folder', async () => {
    await mount({ pdf: pdfState(`${PROJECT_ROOT}/other.pdf`) });
    expect(rowNamed('main.pdf')?.getAttribute('data-active')).toBeNull();
  });
});

describe('the file-type filter in the rendered tree', () => {
  it('lists only the configured types', async () => {
    await mount();
    expect(names()).toEqual(['main.tex', 'main.pdf', 'refs.bib']);
    expect(rowNamed('main.aux'), 'aux is not in the default list').toBeUndefined();
  });

  it('keeps the active PDF listed even when its type is filtered out', async () => {
    // The viewer's file stays visible whatever the filter says, because the row
    // that marks it has to exist for the mark to mean anything.
    await mount({
      explorerInclude: ['tex', 'md'],
      pdf: { path: `${PROJECT_ROOT}/main.pdf`, visible: true, page: 1, pageCount: 3, zoom: 1, zoomMode: 'page-width', scrollTop: 0, loading: false, error: null, searchQuery: '', searchMatches: 0, outline: [] }
    });
    expect(names()).toEqual(['main.tex', 'main.pdf']);
    expect(rowNamed('main.pdf')?.getAttribute('data-active-kind')).toBe('pdf');
  });

  it('keeps the open document listed even when its type is filtered out', async () => {
    await mount({
      explorerInclude: ['md'],
      activeDocument: { doc: { uri: `${PROJECT_ROOT}/main.tex`, filename: 'main.tex', languageId: 'latex' }, recovered: false, externalChange: false, pinned: false }
    });
    expect(names()).toEqual(['main.tex']);
  });

  it('explains an empty tree that the filter caused', async () => {
    // An empty project and a fully-filtered one look identical otherwise, and the
    // second reads as a bug.
    await mount({ explorerInclude: ['rst'] });
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain('files.explorerInclude');
  });

  it('still says the folder is empty when it really is', async () => {
    await mount({ fileTree: [] });
    expect(container.textContent).toContain('This folder is empty.');
  });
});
