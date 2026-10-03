// @vitest-environment jsdom
/**
 * Status bar rendering.
 *
 * The formatting functions are pinned down in `status-bar.test.ts`; this file
 * mounts the real component against app state and settings it controls, because
 * the defects this bar had were *composition* defects rather than arithmetic:
 * the build outcome was rendered twice, `latexmk` was named twice, and eight
 * tool names crowded out the state that actually changes. None of that is
 * visible in a unit test of a formatter.
 *
 * The first tests read `textContent`, which is a *superset* of what the bar
 * shows — hover text is in there, and `innerText` (what the end-to-end harness
 * uses) excludes it. Where the distinction matters they use `visibleLines()`,
 * which mirrors `innerText`'s one-line-per-element reading.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { ToolInfo } from '../../src/shared/ipc';

/** The state the bar is mounted against; each test sets what it cares about. */
const fake = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  executed: [] as string[],
  settings: {} as Record<string, unknown>,
  rootDocument: null as string | null,
  statCalls: [] as string[],
  readCalls: [] as string[],
  syncTexExists: true,
  fileText: '\\documentclass{article}\n\\begin{document}\n\\end{document}\n'
}));

vi.mock('../../src/renderer/ui/state', () => ({
  useAppState: () => fake.state
}));

vi.mock('../../src/renderer/core/commands', () => ({
  commandRegistry: {
    execute: (id: string) => {
      fake.executed.push(id);
      return Promise.resolve();
    }
  }
}));

vi.mock('../../src/renderer/core/settings', () => ({
  settingsManager: {
    getValue: (key: string) => fake.settings[key],
    on: () => () => undefined
  }
}));

vi.mock('../../src/renderer/document/projectIndex', () => ({
  projectIndex: {
    getRootDocumentPath: () => fake.rootDocument,
    on: () => () => undefined
  }
}));

const { StatusBar, clearFileProbeCaches } = await import('../../src/renderer/ui/components/StatusBar');

const TOOLS: ToolInfo[] = [
  { name: 'pdflatex', available: true, version: 'MiKTeX-pdfTeX 4.11', path: 'C:\\tex\\pdflatex.exe' },
  { name: 'xelatex', available: true, version: 'XeTeX 3.141592653', path: 'C:\\tex\\xelatex.exe' },
  { name: 'lualatex', available: true, version: 'LuaHBTeX 1.17', path: 'C:\\tex\\lualatex.exe' },
  { name: 'latexmk', available: true, version: 'Latexmk 4.80', path: 'C:\\tex\\latexmk.exe' },
  { name: 'bibtex', available: true, version: 'BibTeX 0.99d', path: 'C:\\tex\\bibtex.exe' },
  { name: 'biber', available: true, version: 'biber 2.19', path: 'C:\\tex\\biber.exe' },
  { name: 'makeindex', available: true, version: 'makeindex 2.15', path: 'C:\\tex\\makeindex.exe' },
  { name: 'synctex', available: true, version: 'SyncTeX 1.21', path: 'C:\\tex\\synctex.exe' }
];

const DEFAULT_BUILD = {
  status: 'succeeded',
  durationMs: 1070,
  errorCount: 0,
  warningCount: 0,
  currentLabel: '',
  stepIndex: 0,
  totalSteps: 0,
  jobId: null,
  startedAt: null,
  output: '',
  diagnostics: [],
  pdfPath: null,
  skipped: false
};

const DEFAULT_PDF = {
  path: 'D:/paper/main.pdf',
  page: 2,
  pageCount: 7,
  zoom: 1,
  zoomMode: 'page-width',
  scrollTop: 0,
  visible: true,
  loading: false,
  error: null,
  searchQuery: '',
  searchMatches: 0,
  outline: []
};

let container: HTMLDivElement;
let root: Root;

/** The document the bar is told is active; `on` is what it subscribes to. */
const activeDocument = {
  uri: 'D:/paper/main.tex',
  filename: 'main.tex',
  languageId: 'latex',
  on: () => () => undefined
};

/** The fields of app state the status bar reads, with sensible defaults. */
function stateWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    build: { ...DEFAULT_BUILD },
    tools: TOOLS,
    cursor: { line: 251, column: 2, offset: 0, selectedChars: 0 },
    theme: 'dark',
    themeSetting: 'dark',
    statusMessage: null,
    activeDoc: activeDocument,
    pdf: { ...DEFAULT_PDF },
    sidebarVisible: true,
    bottomPanelVisible: false,
    bottomPanelView: 'problems',
    toggleBottomPanel: () => undefined,
    cycleTheme: () => undefined,
    openFile: () => Promise.resolve(),
    detectRecipes: () => Promise.resolve(),
    setSetting: () => undefined,
    ...overrides
  };
}

/** Mounts the bar and lets its two asynchronous file probes settle. */
async function mount(state: Record<string, unknown>): Promise<string> {
  fake.state = state;
  await act(async () => {
    root.render(React.createElement(StatusBar));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container.textContent ?? '';
}

/**
 * What the bar's `innerText` reads: one line per direct child, hover text
 * excluded. `src/main/smoke.ts` matches against exactly this.
 */
function visibleLines(): string[] {
  return [...container.querySelectorAll('[data-testid="status-bar"] > *')].map(
    (child) => child.textContent ?? ''
  );
}

/** The text the end-to-end harness selects from the whole page. */
function harnessText(): string {
  const match = container.textContent?.match(/latexmk|utf8|UTF-8/g) ?? [];
  return match.join(' | ');
}

beforeEach(() => {
  fake.executed = [];
  fake.settings = {
    'files.encoding': 'utf8',
    'compilation.recipe': '',
    'compilation.engine': 'latexmk',
    'editor.tabSize': 2,
    'editor.insertSpaces': true
  };
  fake.rootDocument = 'D:/paper/main.tex';
  fake.statCalls = [];
  fake.readCalls = [];
  fake.syncTexExists = true;
  fake.fileText = '\\documentclass{article}\n\\begin{document}\n\\end{document}\n';
  // The probes cache a fact read from disk; each mount must start from nothing.
  clearFileProbeCaches();

  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { eukoliaApi: unknown }).eukoliaApi = {
    stat: (target: string) => {
      fake.statCalls.push(target);
      return Promise.resolve({
        path: target,
        exists: fake.syncTexExists,
        isDirectory: false,
        size: 1024,
        mtimeMs: 1
      });
    },
    readFile: (target: string) => {
      fake.readCalls.push(target);
      return Promise.resolve(fake.fileText);
    }
  };

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearFileProbeCaches();
});

describe('status bar text', () => {
  it('displays the cursor position, so the bar says where the caret is', async () => {
    // Line and column are live state and the end-to-end probe reads the bar with
    // /Ln \d+/; a bar that shows them only while text is selected is one the
    // reader — and the probe — cannot find the position in.
    const text = await mount(stateWith());
    expect(text).toContain('Ln 251, Col 2');
  });

  it('keeps a recipe name, so the harness finds latexmk', async () => {
    const text = await mount(stateWith());
    expect(text).toContain('latexmk');
    expect(harnessText()).toContain('latexmk');
  });

  it('keeps an encoding label', async () => {
    // The harness also matches /utf8/; the label now reads UTF-8, which the
    // coordinating agent updates that probe for. It must still be rendered.
    const text = await mount(stateWith());
    expect(visibleLines()).toContain('UTF-8');
    expect(text).toMatch(/UTF-8/);
  });

  it('does not render status text or build duration directly in the bar', async () => {
    const text = await mount(
      stateWith({
        build: { ...DEFAULT_BUILD, status: 'failed', errorCount: 1, warningCount: 2 },
        // The message the application sets when a build fails is exactly the
        // text the bar used to render a second time. It is null here so the
        // assertion is about the indicator, not about the message.
        statusMessage: null
      })
    );
    expect(text).not.toContain('Build failed');
    expect(text).not.toContain('1.07 s');
    const buildButton = container.querySelector('[data-testid="status-build"]');
    expect(buildButton?.getAttribute('title')).toContain('Build failed in 1.07 s');
  });

  it('does not name the recipe twice', async () => {
    // The eight-tool list is gone; the only tool names on the bar are the recipe
    // and the single collapsed indicator.
    const text = await mount(stateWith());
    expect(text.match(/latexmk/g) ?? []).toHaveLength(1);
    expect(text).not.toContain('pdflatex');
    expect(text).not.toContain('biber');
  });

  it('collapses eight tools into one indicator', async () => {
    const text = await mount(stateWith());
    expect(text).toContain('TeX ✓');
    expect(visibleLines()).toContain('TeX ✓');
  });

  it('counts the tools that are missing', async () => {
    const text = await mount(
      stateWith({
        tools: TOOLS.map((entry) =>
          entry.name === 'xelatex' ? { ...entry, available: false, version: null, path: null } : entry
        )
      })
    );
    expect(text).toContain('TeX 1 missing');
  });

  it('draws no problems indicator for a clean build', async () => {
    // When there are no problems, no problems icon or counter is shown.
    await mount(stateWith());
    const problems = container.querySelector('[data-testid="status-problems"]');
    expect(problems).toBeNull();
  });

  it('shows both counts as soon as there are problems', async () => {
    await mount(stateWith({ build: { ...DEFAULT_BUILD, errorCount: 1, warningCount: 2 } }));
    const problems = container.querySelector('[data-testid="status-problems"]') as HTMLButtonElement;
    expect(problems.textContent).toBe('12');
    expect(problems.querySelectorAll('svg')).toHaveLength(2);
  });

  it('shows the selection only while there is one', async () => {
    const withSelection = await mount(
      stateWith({ cursor: { line: 4, column: 9, offset: 0, selectedChars: 37 } })
    );
    expect(withSelection).toContain('37 selected');

    const without = await mount(stateWith());
    expect(without).not.toContain('selected');
  });

  it('names the theme rather than its id', async () => {
    const text = await mount(stateWith({ themeSetting: 'catppuccin-latte', theme: 'catppuccin-latte' }));
    expect(text).toContain('Catppuccin Latte');
    expect(text).not.toContain('catppuccin-latte');
  });

  it('shows the resolved theme when the setting follows the system', async () => {
    const text = await mount(stateWith({ themeSetting: 'system', theme: 'nord' }));
    expect(text).toContain('System: Nord');
  });

  it('shows the PDF page and the SyncTeX state', async () => {
    const text = await mount(stateWith());
    expect(text).toContain('Page 2 / 7');
    expect(text).toContain('SyncTeX');
    // The SyncTeX probe looks beside the PDF, where every engine writes it.
    expect(fake.statCalls).toContain('D:/paper/main.synctex.gz');
  });

  it('dims the SyncTeX item when there is no data for the PDF', async () => {
    fake.syncTexExists = false;
    await mount(stateWith());
    const item = container.querySelector('[data-testid="status-synctex"]') as HTMLSpanElement;
    expect(item.textContent).toBe('SyncTeX');
    expect(item.getAttribute('title')).toContain('No .synctex.gz');
    expect(item.style.opacity).toBe('0.7');
  });

  it('reads the line ending from the file, because the buffer is normalised', async () => {
    const text = await mount(stateWith());
    expect(fake.readCalls).toContain('D:/paper/main.tex');
    expect(visibleLines()).toContain('LF');
  });

  it('shows CRLF for a file that uses it', async () => {
    fake.fileText = '\\documentclass{article}\r\n\\begin{document}\r\n';
    await mount(stateWith());
    // The adjacent encoding item follows it directly in `textContent`, which has
    // no separators; `visibleLines` is where the two are distinguishable.
    expect(visibleLines()).toContain('CRLF');
    expect(visibleLines()).toContain('UTF-8');
  });

  it('shows the language mode without indentation clutter', async () => {
    const text = await mount(stateWith());
    expect(text).not.toContain('Spaces: 2');
    expect(text).toContain('LaTeX');
  });

  it('does not clutter the bar with tab indentation info', async () => {
    fake.settings['editor.insertSpaces'] = false;
    fake.settings['editor.tabSize'] = 4;
    const text = await mount(stateWith());
    expect(text).not.toContain('Tab Size: 4');
  });

  it('keeps the root document, by name, with the full path in the tooltip', async () => {
    const text = await mount(stateWith());
    expect(text).toContain('main.tex');
    const button = container.querySelector('[data-testid="status-root-document"]');
    expect(button?.getAttribute('title')).toContain('D:/paper/main.tex');
  });

  it('does not invent a root document when the project has none', async () => {
    fake.rootDocument = null;
    const text = await mount(stateWith());
    expect(text).toContain('no root document');
  });

  it('shows a transient message and then lets it go', async () => {
    vi.useFakeTimers();
    try {
      const text = await mount(stateWith({ statusMessage: 'Cleaned 4 file(s)' }));
      expect(text).toContain('Cleaned 4 file(s)');

      // A message that stays up for the rest of the session is a label, not a
      // notification; this one fades on its own.
      await act(async () => {
        vi.advanceTimersByTime(30000);
      });
      expect(container.textContent).not.toContain('Cleaned 4 file(s)');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('status bar controls', () => {
  it('dispatches the layout toggles through the command registry', async () => {
    await mount(stateWith());
    const ids = ['view.toggleSidebar', 'view.togglePanel', 'pdf.toggleViewer', 'view.toggleTabBar'];
    for (const id of ids) {
      const button = container.querySelector(`[data-testid="status-toggle-${id}"]`) as HTMLButtonElement | null;
      expect(button, `${id} has no button`).not.toBeNull();
      act(() => button?.click());
    }
    expect(fake.executed).toEqual(ids);
  });

  it('marks each toggle with its current visibility', async () => {
    await mount(
      stateWith({
        sidebarVisible: false,
        bottomPanelVisible: true,
        pdf: { ...DEFAULT_PDF, visible: false },
        tabBarVisible: true
      })
    );
    const pressed = (id: string) =>
      container.querySelector(`[data-testid="status-toggle-${id}"]`)?.getAttribute('aria-pressed');
    expect(pressed('view.toggleSidebar')).toBe('false');
    expect(pressed('view.togglePanel')).toBe('true');
    expect(pressed('pdf.toggleViewer')).toBe('false');
    expect(pressed('view.toggleTabBar')).toBe('true');
  });

  it('gives every control a title and an accessible name', async () => {
    await mount(stateWith());
    const controls = [...container.querySelectorAll('button')];
    expect(controls.length).toBeGreaterThan(6);
    for (const control of controls) {
      const name = control.getAttribute('aria-label');
      expect(name, `${control.textContent} has no aria-label`).toBeTruthy();
      expect(control.getAttribute('title'), `${name} has no title`).toBeTruthy();
    }
  });

  it('opens the build output panel from the build indicator', async () => {
    const calls: Array<string | undefined> = [];
    await mount(stateWith({ toggleBottomPanel: (view?: string) => calls.push(view) }));
    act(() => (container.querySelector('[data-testid="status-build"]') as HTMLButtonElement).click());
    expect(calls).toEqual(['output']);
  });

  it('opens the Problems panel from the problems indicator when problems exist', async () => {
    const calls: Array<string | undefined> = [];
    await mount(
      stateWith({
        build: { ...DEFAULT_BUILD, errorCount: 1 },
        toggleBottomPanel: (view?: string) => calls.push(view)
      })
    );
    act(() => (container.querySelector('[data-testid="status-problems"]') as HTMLButtonElement).click());
    expect(calls).toEqual(['problems']);
  });

  it('offers the build picker from the recipe label', async () => {
    await mount(stateWith());
    act(() => (container.querySelector('[data-testid="status-recipe"]') as HTMLButtonElement).click());
    expect(fake.executed).toContain('latex.buildWithRecipe');
  });

  it('cycles the theme', async () => {
    let cycles = 0;
    await mount(stateWith({ cycleTheme: () => (cycles += 1) }));
    act(() => (container.querySelector('[data-testid="status-theme"]') as HTMLButtonElement).click());
    expect(cycles).toBe(1);
  });

  it('re-runs tool detection from the TeX indicator', async () => {
    let detections = 0;
    await mount(
      stateWith({
        detectRecipes: () => {
          detections += 1;
          return Promise.resolve();
        }
      })
    );
    act(() => (container.querySelector('[data-testid="status-tools"]') as HTMLButtonElement).click());
    expect(detections).toBe(1);
  });

  it('does not render indentation button in status bar', async () => {
    await mount(stateWith());
    expect(container.querySelector('[data-testid="status-indentation"]')).toBeNull();
  });

  it('switches the encoding rather than offering a dead control', async () => {
    const writes: Array<[string, unknown]> = [];
    await mount(stateWith({ setSetting: (key: string, value: unknown) => writes.push([key, value]) }));
    act(() => (container.querySelector('[data-testid="status-encoding"]') as HTMLButtonElement).click());
    expect(writes).toEqual([['files.encoding', 'utf16le']]);
  });

  it('opens the root document', async () => {
    const opened: string[] = [];
    await mount(
      stateWith({
        openFile: (path?: string) => {
          if (path) opened.push(path);
          return Promise.resolve();
        }
      })
    );
    act(() => (container.querySelector('[data-testid="status-root-document"]') as HTMLButtonElement).click());
    expect(opened).toEqual(['D:/paper/main.tex']);
  });
});

describe('status bar overflow', () => {
  it('bounds a long root document name instead of letting it push the bar', async () => {
    // A deeply nested path is the case that used to stretch the item and shove
    // the layout cluster off the window.
    const nested = 'nested/'.repeat(20);
    fake.rootDocument = `D:/papers/${nested}very-long-thesis-root-document.tex`;
    await mount(stateWith());

    const button = container.querySelector('[data-testid="status-root-document"]') as HTMLButtonElement;
    const inner = button.querySelector('span') as HTMLSpanElement;
    expect(button.style.maxWidth).toBe('190px');
    expect(inner.textContent).toContain('very-long-thesis-root-document.tex');
    // Truncation needs a block-level span: `text-overflow` does not apply to a
    // flex container's own text.
    expect(inner.style.overflow).toBe('hidden');
    expect(inner.style.textOverflow).toBe('ellipsis');
    expect(inner.style.whiteSpace).toBe('nowrap');
    // The whole path is still available on hover.
    expect(button.getAttribute('title')).toContain(`D:/papers/${nested}`);
  });

  it('lets a long status message ellipsise too', async () => {
    const long = `Replaced 1200 occurrence(s) in 37 file(s) — ${'and more detail '.repeat(20)}`;
    vi.useFakeTimers();
    try {
      await mount(stateWith({ statusMessage: long }));
      const message = container.querySelector('[data-testid="status-message"]') as HTMLSpanElement;
      expect(message.style.maxWidth).toBe('420px');
      expect(message.getAttribute('title')).toBe(long);
      const inner = message.querySelector('span') as HTMLSpanElement;
      expect(inner.style.textOverflow).toBe('ellipsis');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the layout cluster shrink-proof', async () => {
    await mount(stateWith());
    for (const id of ['view.toggleSidebar', 'view.togglePanel', 'pdf.toggleViewer', 'view.toggleTabBar']) {
      const button = container.querySelector(`[data-testid="status-toggle-${id}"]`) as HTMLButtonElement;
      expect(button.style.flexShrink, `${id} can be squeezed out`).toBe('0');
    }
  });

  it('keeps the items the harness needs on one line of the bar', async () => {
    fake.rootDocument = `D:/papers/${'nested/'.repeat(20)}root.tex`;
    await mount(stateWith({ statusMessage: 'a message that is definitely long enough to be truncated' }));

    // Every item is still its own line of `innerText`, so the harness sees the
    // recipe regardless of how long the paths are.
    const text = harnessText();
    expect(text).toContain('latexmk');
  });

  it('reads as one line of innerText, which is what the harness filters on', async () => {
    // `src/main/smoke.ts` splits `document.body.innerText` on newlines and keeps
    // the lines matching /Ln \d+|latexmk|utf8/. The bar must therefore not
    // introduce a newline of its own, or the cursor and the recipe would fall
    // into a chunk the harness never looks at.
    //
    // jsdom does not implement `innerText`, so this asserts the property that
    // decides it: a browser breaks `innerText` at *block-level* descendants, and
    // every item in the bar is an inline-level box (`inline-flex`) or an inline
    // box. The bar's own text therefore stays on one line.
    await mount(stateWith());
    const bar = container.querySelector('[data-testid="status-bar"]') as HTMLElement;
    expect(bar.children.length).toBeGreaterThan(6);

    const stacked = [...bar.children].filter((child) => {
      const display = (child as HTMLElement).style.display;
      return display === '' || display === 'block' || display === 'flex' || display === 'grid';
    });
    // The only block-level child is the flex spacer, and it is empty: an empty
    // block generates no line box, so it cannot break the harness's line either.
    for (const child of stacked) {
      expect(child.textContent, `${child.tagName} would start a new line`).toBe('');
    }
  });
});
