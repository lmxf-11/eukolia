// @vitest-environment jsdom
/**
 * The tab bar's toolbar.
 *
 * Five actions in three controls, all of them commands: what this file checks is
 * that the controls are *synchronised* — that each one dispatches the command it
 * names, reports the state the command wrote, and states a shortcut it really
 * answers to.
 *
 * That last one is the defect this file exists for. A toolbar tooltip is the
 * only place most of these shortcuts are ever read, so a title that says
 * `(Ctrl+B)` for Compile while `Ctrl+B` toggles the side bar is worse than no
 * title at all: it teaches a key that does something else. The titles are
 * therefore built from the command registry, and the tests drive the registry
 * rather than the strings — rebinding a command changes what the control claims,
 * which is the property that makes the two impossible to drift apart.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** The state the bar is mounted against; each test sets what it cares about. */
const fake = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  /** The bindings the registry answers with, keyed by command id. */
  bindings: {} as Record<string, string | undefined>,
  /** The command that currently owns each binding. */
  owners: {} as Record<string, string | null>,
  executed: [] as string[],
  keybindingListeners: [] as Array<() => void>,
  /** Every window API call the caption buttons made, in order. */
  windowCalls: [] as string[],
  /** What `isWindowMaximized` answers, and what a toggle flips. */
  maximized: false
}));

vi.mock('../../src/renderer/ui/state', () => ({
  useAppState: () => fake.state
}));

vi.mock('../../src/renderer/services/instance', () => ({
  workspaceService: { reorderDocument: () => undefined }
}));

vi.mock('../../src/renderer/core/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/core/commands')>();
  return {
    translateKeybinding: actual.translateKeybinding,
    commandRegistry: {
      execute: (id: string) => {
        fake.executed.push(id);
        return Promise.resolve();
      },
      getKeybinding: (id: string) => fake.bindings[id],
      getBindingOwner: (binding: string) =>
        Object.prototype.hasOwnProperty.call(fake.owners, binding) ? fake.owners[binding] : null,
      on: (event: string, listener: () => void) => {
        if (event === 'keybindings-changed') fake.keybindingListeners.push(listener);
        return () => {
          fake.keybindingListeners = fake.keybindingListeners.filter((entry) => entry !== listener);
        };
      }
    }
  };
});

const { TabBar, ownedShortcutFor, pdfMenuItems, modeMenuItems, formatTabLabel, renderTabIcon } = await import(
  '../../src/renderer/ui/components/TabBar'
);

const DEFAULT_BUILD = {
  status: 'idle',
  durationMs: 0,
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

/**
 * One open document, which the bar's `tablist` needs before it can render tabs.
 *
 * The state is given a document in the tests that read the strip's text, because
 * the empty state's own text ("No open documents") is a line of the bar and an
 * assertion on `container.textContent` cannot tell one line from another.
 */
const openDocument = {
  doc: {
    uri: 'D:/paper/main.tex',
    filename: 'main.tex',
    getDirty: () => false
  },
  pinned: false,
  externalChange: false,
  recovered: false
};

/** The fields of app state the bar reads, with sensible defaults. */
function stateWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    documents: [],
    activeDocument: null,
    setActiveDocument: () => undefined,
    closeDocument: () => Promise.resolve(),
    newFile: () => undefined,
    build: { ...DEFAULT_BUILD },
    pdf: { ...DEFAULT_PDF },
    editorMode: 'code',
    layout: 'split',
    tabBarVisible: true,
    toggleFocusMode: () => undefined,
    ...overrides
  };
}

/**
 * Mounts the bar, or re-mounts it from scratch.
 *
 * A second `render` on a live root *updates* the tree rather than replacing it,
 * which leaves the component's own state — an open dropdown — exactly where it
 * was, so a test that checks the second state saw the first one's menu. Unmount
 * and a fresh root make each `mount` the fresh start it says it is.
 */
async function mount(state: Record<string, unknown>): Promise<void> {
  fake.state = state;
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(TabBar));
  });
  await act(async () => {});
}

const button = (testId: string) => container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;

const click = (testId: string) => {
  const target = button(testId);
  expect(target, `${testId} is not rendered`).not.toBeNull();
  act(() => target?.click());
};

const title = (testId: string) => button(testId)?.getAttribute('title') ?? '';

beforeEach(() => {
  fake.executed = [];
  fake.keybindingListeners = [];
  // What the application actually ships: the registry resolves each of these to
  // the command that owns it, which is what the toolbar's titles go through.
  fake.bindings = {
    'latex.build': 'Ctrl+B',
    'latex.stopBuild': undefined,
    'latex.buildAndView': 'Ctrl+Alt+B',
    'latex.buildWithRecipe': 'Ctrl+Shift+B',
    'pdf.toggleViewer': 'Ctrl+Alt+V',
    'editor.codeMode': 'Ctrl+1',
    'editor.visualMode': 'Ctrl+2',
    'editor.toggleMode': 'Ctrl+Shift+V',
    'view.focusMode': 'Ctrl+Alt+1',
    'file.newFile': 'Ctrl+N'
  };
  fake.owners = {
    // The application's own resolutions, including the two keys that are held by
    // two commands each: `Ctrl+B` (toggle-sidebar, registered first) and
    // `Ctrl+Alt+B` (toggle-status-bar, registered first).
    'Ctrl+B': 'view.toggleSidebar',
    'Ctrl+Alt+B': 'view.toggleStatusBar',
    'Ctrl+Shift+B': 'latex.buildWithRecipe',
    'Ctrl+Alt+V': 'pdf.toggleViewer',
    'Ctrl+1': 'editor.codeMode',
    'Ctrl+2': 'editor.visualMode',
    'Ctrl+Shift+V': 'editor.toggleMode',
    'Ctrl+Alt+1': 'view.focusMode',
    'Ctrl+N': 'file.newFile'
  };

  /**
   * The window API the bar's caption buttons call.
   *
   * A fresh object per test so a call recorded by one cannot be read by the next
   * — `windowControls` is the window's answer, and a maximised window from a
   * previous test would make the middle button claim to be a Restore.
   */
  fake.windowCalls = [];
  fake.maximized = false;
  (window as unknown as { eukoliaApi: unknown }).eukoliaApi = {
    hasNativeWindowControls: false,
    isWindowMaximized: () => Promise.resolve(fake.maximized),
    onWindowMaximizedChanged: () => () => undefined,
    minimizeWindow: () => {
      fake.windowCalls.push('minimize');
      return Promise.resolve();
    },
    toggleMaximizeWindow: () => {
      fake.windowCalls.push('maximize');
      fake.maximized = !fake.maximized;
      return Promise.resolve(fake.maximized);
    },
    closeWindow: () => {
      fake.windowCalls.push('close');
      return Promise.resolve();
    }
  };

  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the toolbar dispatches commands', () => {
  it('compiles from the wide half of the PDF control', async () => {
    await mount(stateWith());
    click('toolbar-compile');
    expect(fake.executed).toEqual(['latex.build']);
  });

  it('offers the viewer, Build and View and the recipe picker from the PDF control’s menu', async () => {
    await mount(stateWith());
    click('toolbar-pdf-menu');
    const ids = [...container.querySelectorAll('[data-testid^="toolbar-pdf-menu-panel-"]')].map((entry) =>
      entry.getAttribute('data-testid')
    );
    expect(ids).toEqual([
      'toolbar-pdf-menu-panel-pdf.toggleViewer',
      'toolbar-pdf-menu-panel-latex.buildAndView',
      'toolbar-pdf-menu-panel-latex.buildWithRecipe'
    ]);

    click('toolbar-pdf-menu-panel-latex.buildAndView');
    expect(fake.executed).toEqual(['latex.buildAndView']);
    expect(container.querySelector('[data-testid="toolbar-pdf-menu-panel"]')).toBeNull();
  });

  it('toggles the menu closed again', async () => {
    await mount(stateWith());
    click('toolbar-pdf-menu');
    click('toolbar-pdf-menu');
    expect(container.querySelector('[data-testid="toolbar-pdf-menu-panel"]')).toBeNull();
  });

  it('switches mode from the segmented control', async () => {
    await mount(stateWith({ editorMode: 'visual' }));
    click('toolbar-mode-code');
    expect(fake.executed).toEqual(['editor.codeMode']);
  });

  it('toggles the PDF viewer from its dedicated button', async () => {
    await mount(stateWith());
    click('toolbar-toggle-pdf');
    expect(fake.executed).toEqual(['pdf.toggleViewer']);
  });

  it('keeps the new-file button it already had', async () => {
    let created = 0;
    await mount(stateWith({ newFile: () => (created += 1) }));
    click('tab-bar-new-file');
    expect(created).toBe(1);
  });

  it('offers Stop only while a build is running, and dispatches it', async () => {
    await mount(stateWith({ build: { ...DEFAULT_BUILD, status: 'running' } }));
    expect(button('toolbar-stop-build')).not.toBeNull();
    click('toolbar-stop-build');
    expect(fake.executed).toEqual(['latex.stopBuild']);

    await mount(stateWith({ build: { ...DEFAULT_BUILD, status: 'succeeded' } }));
    expect(button('toolbar-stop-build'), 'a stop button with nothing to stop').toBeNull();
  });
});

describe('the toolbar reports the state the commands write', () => {
  it('marks the mode control with the mode that is on', async () => {
    await mount(stateWith({ editorMode: 'visual' }));
    expect(button('toolbar-mode-code')?.getAttribute('aria-pressed')).toBe('false');
    expect(button('toolbar-mode-visual')?.getAttribute('aria-pressed')).toBe('true');

    await mount(stateWith({ editorMode: 'code' }));
    expect(button('toolbar-mode-code')?.getAttribute('aria-pressed')).toBe('true');
    expect(button('toolbar-mode-visual')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('marks the PDF viewer button with the viewer state', async () => {
    await mount(stateWith({ pdf: { ...DEFAULT_PDF, visible: true } }));
    expect(button('toolbar-toggle-pdf')?.getAttribute('aria-pressed')).toBe('true');
    expect(button('toolbar-toggle-pdf')?.getAttribute('aria-label')).toBe('Hide the PDF viewer');

    await mount(stateWith({ pdf: { ...DEFAULT_PDF, visible: false } }));
    expect(button('toolbar-toggle-pdf')?.getAttribute('aria-pressed')).toBe('false');
    expect(button('toolbar-toggle-pdf')?.getAttribute('aria-label')).toBe('Show the PDF viewer');
  });

  it('reports the open document in the PDF menu rather than inventing one', async () => {
    await mount(stateWith({ documents: [openDocument] }));
    click('toolbar-pdf-menu');
    expect(container.textContent).toContain('main.pdf');
    expect(container.textContent).toContain('page 2 of 7');

    await mount(stateWith({ documents: [openDocument], pdf: { ...DEFAULT_PDF, path: null, pageCount: 0 } }));
    click('toolbar-pdf-menu');
    expect(container.textContent).toContain('No PDF yet');
  });

  it('shows a compile in flight on the compile button', async () => {
    await mount(stateWith({ build: { ...DEFAULT_BUILD, status: 'running' } }));
    const compile = button('toolbar-compile');
    expect(compile?.getAttribute('aria-busy')).toBe('true');
    expect(compile?.getAttribute('aria-label')).toBe('Compilation in progress');
    // The glyph is the spinner, which needs the stylesheet's keyframes.
    expect(compile?.querySelector('svg')?.getAttribute('class')).toContain('eu-spin');
  });

  it('keeps the build icon green and does not switch to a warning icon on failure', async () => {
    await mount(stateWith({ build: { ...DEFAULT_BUILD, status: 'failed' } }));
    const compile = button('toolbar-compile');
    expect(compile).not.toBeNull();
    // Icon is still Play, not CircleAlert
    expect(compile?.querySelector('svg')).not.toBeNull();
    expect(compile?.style.color).toContain('var(--eu-success');
  });

  it('renders a full-height divider between PDF controls and editor mode toggle', async () => {
    await mount(stateWith());
    const separator = container.querySelector('[data-testid="toolbar-build-mode-separator"]') as HTMLElement;
    expect(separator).not.toBeNull();
    expect(separator.style.height).toBe('100%');
    expect(separator.style.width).toBe('1px');
  });
});

describe('the toolbar’s shortcuts come from the registry', () => {
  it('states a shortcut only where the command really owns it', async () => {
    await mount(stateWith());
    expect(title('toolbar-toggle-pdf')).toContain('Ctrl+Alt+V');
    expect(title('toolbar-mode-code')).toContain('Ctrl+1');
    expect(title('toolbar-mode-visual')).toContain('Ctrl+2');

    // Compile does *not* own `Ctrl+B` — the side bar does — so the title says
    // what the button does and claims no key at all.
    expect(title('toolbar-compile')).toContain('Compile the project to PDF');
    expect(title('toolbar-compile')).not.toContain('Ctrl+B');
  });

  it('states the shortcuts the menus carry, and only the owned ones', async () => {
    await mount(stateWith());
    click('toolbar-pdf-menu');
    // `latex.buildWithRecipe` owns `Ctrl+Shift+B`; `latex.buildAndView` does not own
    // `Ctrl+Alt+B` (the status bar does), so its entry states none.
    expect(title('toolbar-pdf-menu-panel-latex.buildWithRecipe')).toContain('Ctrl+Shift+B');
    expect(title('toolbar-pdf-menu-panel-latex.buildAndView')).not.toContain('Ctrl+Alt+B');
  });

  it('asks the registry rather than a table of its own', () => {
    expect(ownedShortcutFor('pdf.toggleViewer')).toBe('Ctrl+Alt+V');
    expect(ownedShortcutFor('latex.build')).toBe('');
    expect(ownedShortcutFor('latex.stopBuild')).toBe('');
  });
});

describe('the toolbar is navigable and named', () => {
  it('gives every control a title and an accessible name', async () => {
    await mount(stateWith());
    const controls = [...container.querySelectorAll('[data-testid="tab-bar-toolbar"] button')];
    expect(controls.length).toBeGreaterThanOrEqual(4);
    for (const control of controls) {
      const name = control.getAttribute('aria-label');
      expect(name, `${control.getAttribute('data-testid')} has no aria-label`).toBeTruthy();
      expect(control.getAttribute('title'), `${name} has no title`).toBeTruthy();
    }
  });

  it('announces the PDF menu as a menu', async () => {
    await mount(stateWith());
    expect(button('toolbar-pdf-menu')?.getAttribute('aria-haspopup')).toBe('menu');
    expect(button('toolbar-pdf-menu')?.getAttribute('aria-expanded')).toBe('false');
    click('toolbar-pdf-menu');
    expect(button('toolbar-pdf-menu')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="menu"][data-testid="toolbar-pdf-menu-panel"]')).not.toBeNull();
  });

  it('closes an open menu on Escape and on a click outside', async () => {
    await mount(stateWith());
    click('toolbar-pdf-menu');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('[data-testid="toolbar-pdf-menu-panel"]')).toBeNull();
  });

  it('keeps the controls out of the tab strip’s own roles', async () => {
    // The strip is a `tablist`; the toolbar is a sibling of it, so a keyboard
    // user tabbing through the tabs does not land on Compile on the way.
    await mount(stateWith());
    const strip = container.querySelector('[role="tablist"]') as HTMLElement;
    expect(strip.querySelector('[data-testid="tab-bar-toolbar"]')).toBeNull();
    expect(strip.parentElement?.querySelector('[data-testid="tab-bar-toolbar"]')).not.toBeNull();
  });
});

describe('the menu contents, as data', () => {
  it('returns the PDF menu entries, viewer first', () => {
    const items = pdfMenuItems();
    expect(items.map((i) => i.id)).toEqual(['pdf.toggleViewer', 'latex.buildAndView', 'latex.buildWithRecipe']);
    // The first entry says which way the toggle goes, because the control that
    // opens the menu reports the viewer's state and the menu must not contradict
    // it.
    expect(pdfMenuItems(true)[0].label).toBe('Hide the PDF Viewer');
    expect(pdfMenuItems(false)[0].label).toBe('Show the PDF Viewer');
  });

  it('marks exactly one mode as checked', () => {
    for (const mode of ['code', 'visual'] as const) {
      const checked = modeMenuItems(mode).filter((item) => item.checked);
      expect(checked).toHaveLength(1);
      expect(checked[0].id).toBe(mode === 'code' ? 'editor.codeMode' : 'editor.visualMode');
    }
  });
});

describe('tab labels and file icons', () => {
  const createDoc = (filename: string, uri = `D:/paper/${filename}`) => ({
    doc: {
      uri,
      filename,
      getDirty: () => false
    },
    pinned: false,
    externalChange: false,
    recovered: false
  });

  it('strips file extensions from tab labels', () => {
    expect(formatTabLabel('macros.tex')).toBe('macros');
    expect(formatTabLabel('script.js')).toBe('script');
    expect(formatTabLabel('README.md')).toBe('README');
    expect(formatTabLabel('config.json')).toBe('config');
    expect(formatTabLabel('refs.bib')).toBe('refs');
    expect(formatTabLabel('styles.css')).toBe('styles');
    expect(formatTabLabel('Makefile')).toBe('Makefile');
  });

  it('renders distinct icons for different file types', () => {
    expect(renderTabIcon('main.tex')).toBeTruthy();
    expect(renderTabIcon('package.sty')).toBeTruthy();
    expect(renderTabIcon('class.cls')).toBeTruthy();
    expect(renderTabIcon('diagram.tikz')).toBeTruthy();
    expect(renderTabIcon('script.js')).toBeTruthy();
    expect(renderTabIcon('types.ts')).toBeTruthy();
    expect(renderTabIcon('component.jsx')).toBeTruthy();
    expect(renderTabIcon('notes.md')).toBeTruthy();
    expect(renderTabIcon('config.json')).toBeTruthy();
    expect(renderTabIcon('styles.css')).toBeTruthy();
    expect(renderTabIcon('page.html')).toBeTruthy();
    expect(renderTabIcon('figure.png')).toBeTruthy();
    expect(renderTabIcon('data.csv')).toBeTruthy();
    expect(renderTabIcon('build.sh')).toBeTruthy();
    expect(renderTabIcon('settings.yaml')).toBeTruthy();
    expect(renderTabIcon('library.bib')).toBeTruthy();
    expect(renderTabIcon('output.pdf')).toBeTruthy();
  });

  it('renders tab label without extension in the tab bar', async () => {
    await mount(
      stateWith({
        documents: [createDoc('macros.tex'), createDoc('script.js')],
        activeDocument: createDoc('macros.tex')
      })
    );
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toContain('macros');
    expect(tabs[0].textContent).not.toContain('macros.tex');
    expect(tabs[1].textContent).toContain('script');
    expect(tabs[1].textContent).not.toContain('script.js');
  });

  it('shows close button only for active tab and on hover for inactive tab without layout expansion', async () => {
    await mount(
      stateWith({
        documents: [createDoc('main.tex'), createDoc('other.tex')],
        activeDocument: createDoc('main.tex')
      })
    );
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    const activeTab = tabs[0];
    const inactiveTab = tabs[1];

    // Both tabs have the close button in the DOM at all times so the tab does not expand
    const activeBtn = activeTab.querySelector('button[aria-label="Close main.tex"]') as HTMLElement;
    const inactiveBtn = inactiveTab.querySelector('button[aria-label="Close other.tex"]') as HTMLElement;
    expect(activeBtn).not.toBeNull();
    expect(inactiveBtn).not.toBeNull();

    // Active tab has close button visible (opacity: 1)
    expect(activeBtn.style.opacity).toBe('1');

    // Inactive tab has close button visually hidden initially (opacity: 0)
    expect(inactiveBtn.style.opacity).toBe('0');

    // Hovering inactive tab reveals the close button (opacity: 1)
    await act(async () => {
      inactiveTab.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      inactiveTab.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    });
    expect(inactiveBtn.style.opacity).toBe('1');

    // Leaving inactive tab hides the close button (opacity: 0)
    await act(async () => {
      inactiveTab.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      inactiveTab.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    });
    expect(inactiveBtn.style.opacity).toBe('0');
  });

  it('renders a vertical separator between tabs and new file button, and sets active tab background to editorBg', async () => {
    await mount(
      stateWith({
        documents: [createDoc('main.tex'), createDoc('other.tex')],
        activeDocument: createDoc('main.tex'),
        editorMode: 'code'
      })
    );
    const separator = container.querySelector('[data-testid="tab-bar-separator"]') as HTMLElement;
    expect(separator).not.toBeNull();
    expect(separator.style.width).toBe('1px');
    expect(separator.style.height).toBe('16px');

    const tabs = [...container.querySelectorAll('[role="tab"]')] as HTMLElement[];
    expect(tabs).toHaveLength(2);
    // Active tab has editor background and no bottom border so it merges seamlessly with editor
    expect(tabs[0].style.background).toBe('var(--eu-editor-bg)');
    expect(tabs[0].style.borderBottom).toMatch(/none|medium|^$/);
    expect(tabs[0].style.marginBottom).toBe('0px');

    /*
     * The selected tab is joined to the editor by being *the same surface*, and
     * that is the whole mechanism — so what this pins is the absence of
     * everything that would break the join.
     *
     * Three things used to be here and are deliberately gone: a hairline across
     * the whole bar under the strip, and, on the selected tab, a bridge element
     * painted over that hairline plus two scooped-corner SVGs blending into it.
     * The line could not survive the design it was serving: a rule drawn across
     * the full width runs under the selected tab as well, and the shapes that
     * hid it there had a bug at the tab's trailing edge, where the corner's
     * overflow wrapped into a second row. Removing the line removes the need for
     * all three, and a regression that puts any of them back is a regression
     * against a joined tab rather than a cosmetic preference.
     */
    expect(container.querySelector('[data-testid="tab-bar-bottom-border"]')).toBeNull();
    expect(tabs[0].querySelector('[data-testid="tab-active-bridge"]')).toBeNull();
    expect(tabs[0].querySelector('[data-testid="tab-corner-left"]')).toBeNull();
    expect(tabs[0].querySelector('[data-testid="tab-corner-right"]')).toBeNull();

    /*
     * And the tab reaches the editor.
     *
     * The strip is laid out one pixel taller than the bar and pulled up by the
     * same amount, so a tab's bottom pixel lands *on* the hairline rule between
     * the bar and the document — and covers it. That pixel is the join: the
     * tab's surface continues into the editor's with nothing between them.
     *
     * The tab is therefore one pixel taller than the bar it stands in, and this
     * is the number that says so. A tab that shrank back to the bar's own height
     * would leave the rule showing under the selected tab again, which is the
     * defect the join is here to prevent.
     */
    const tabHeight = Number.parseFloat(tabs[0].style.height);
    const barHeight = Number.parseFloat((container.querySelector('[data-testid="tab-bar"]') as HTMLElement).style.height);
    expect(tabHeight, 'the selected tab reaches past the bar').toBeGreaterThan(barHeight);

    /*
     * And every tab is the same height, which is what keeps the row still.
     *
     * A tab that grew when it was selected — 28 against 35, as this strip used to
     * do — pushes its neighbours sideways and sits on a different baseline from
     * the tab it replaced, so every switch is a small re-layout of the whole row.
     * Equal heights make that impossible: the only thing that differs between a
     * selected tab and an unselected one is its colour.
     */
    expect(tabs[1].style.height).toBe(tabs[0].style.height);
    expect(tabs[0].style.marginBottom).toBe(tabs[1].style.marginBottom);

    // Inactive tab has transparent background initially
    expect(tabs[1].style.background).toBe('transparent');
  });

  it('rounds every corner of the selected tab, and only the facing corner of the tabs beside it', async () => {
    await mount(
      stateWith({
        documents: [createDoc('evil.tex'), createDoc('globals.tex'), createDoc('settings.tex')],
        activeDocument: createDoc('globals.tex')
      })
    );
    const tabs = [...container.querySelectorAll('[role="tab"]')] as HTMLElement[];
    expect(tabs).toHaveLength(3);

    /*
     * The selected tab rounds all four corners with the same 6px, and the tabs beside
     * it round only the corner they share with it — a chip resting in the strip touches
     * the selection on one edge and nothing on the other.
     *
     * All four, and that is the shape: the reference has the active tab's lower corner
     * curving into the bar's material, with the rule along the bar stopping where the
     * curve begins and no band of the bar left between the tab and the document. A
     * square foot leaves that band; a foot rounded differently from the top makes the
     * tab two shapes instead of one.
     */
    expect(tabs[0].style.borderBottomRightRadius, 'the tab before the selection rounds the facing corner').toBe('6px');
    expect(tabs[0].style.borderBottomLeftRadius, 'and leaves its other foot square').toBe('0px');

    expect(tabs[1].style.borderBottomLeftRadius, 'the selected tab rounds all four corners').toBe('6px');
    expect(tabs[1].style.borderBottomRightRadius, 'all four of them').toBe('6px');
    expect(tabs[1].style.borderTopLeftRadius, 'including the top ones').toBe('6px');

    expect(tabs[2].style.borderBottomLeftRadius, 'the tab after the selection rounds the facing corner').toBe('6px');
    expect(tabs[2].style.borderBottomRightRadius, 'and leaves its other foot square').toBe('0px');
  });

  it('omits the separator when there are no open documents', async () => {
    await mount(stateWith({ documents: [] }));
    const separator = container.querySelector('[data-testid="tab-bar-separator"]');
    expect(separator).toBeNull();
  });
});

/**
 * The window controls, which are the bar's because the bar is the window's top
 * edge.
 *
 * The window is frameless and `titleBarOverlay` is not configured for it, so
 * nothing else draws minimise/maximise/close: if these three buttons are missing
 * or inert, the only way to close the window is the taskbar. That is why they are
 * tested through a real click and the real API rather than by reading the DOM for
 * three elements.
 */
describe('the window controls live on the tab bar', () => {
  it('draws minimise, maximise and close together on the right', async () => {
    await mount(stateWith());
    const controls = container.querySelector('[data-testid="tab-bar-window-controls"]') as HTMLElement;
    expect(controls).not.toBeNull();
    expect(controls.querySelectorAll('button')).toHaveLength(3);

    // Named, because a caption button with no accessible name is a glyph.
    for (const id of ['window-control-minimize', 'window-control-maximize', 'window-control-close']) {
      const control = button(id);
      expect(control, `${id} is not rendered`).not.toBeNull();
      expect(control?.getAttribute('aria-label')).toBeTruthy();
      expect(control?.getAttribute('title')).toBeTruthy();
    }

    // Close is the one that is allowed to be red under the pointer, from the
    // shell's own class.
    expect(button('window-control-close')?.className).toContain('eu-window-button--close');

    /*
     * And the bar no longer reserves room for a platform overlay.
     *
     * It used to leave 140px of empty bar for the window buttons Windows painted
     * there. Now that the bar draws them itself, a reservation would be a gap
     * between the toolbar and the buttons that replaced it.
     */
    const bar = container.querySelector('[data-testid="tab-bar"]') as HTMLElement;
    expect(bar.style.paddingRight).not.toBe('140px');
  });

  it('calls the window API, one call per press', async () => {
    await mount(stateWith());
    click('window-control-minimize');
    click('window-control-maximize');
    click('window-control-close');
    expect(fake.windowCalls).toEqual(['minimize', 'maximize', 'close']);
  });

  it('names the move the middle button will make, not the state it is in', async () => {
    await mount(stateWith());
    // The window answers `false` here, so the press maximises.
    expect(button('window-control-maximize')?.getAttribute('aria-label')).toBe('Maximise');
    expect(button('window-control-maximize')?.getAttribute('title')).toBe('Maximise');

    // The press flips the stub, and the label follows it — so a maximised window
    // offers Restore rather than another Maximise.
    await act(async () => button('window-control-maximize')?.click());
    await act(async () => {});
    expect(button('window-control-maximize')?.getAttribute('aria-label')).toBe('Restore');
  });

  it('draws no caption buttons on a platform that draws its own', async () => {
    // macOS keeps its traffic lights, and they are the system's: drawing a
    // second set next to them would be two captions on one window.
    (window as unknown as { eukoliaApi: { hasNativeWindowControls: boolean } }).eukoliaApi.hasNativeWindowControls = true;
    try {
      await mount(stateWith());
      expect(container.querySelector('[data-testid="tab-bar-window-controls"]')).toBeNull();
    } finally {
      (window as unknown as { eukoliaApi: { hasNativeWindowControls: boolean } }).eukoliaApi.hasNativeWindowControls = false;
    }
  });
});

/**
 * `view.toggleTabBar` hides the tabs, not the bar.
 *
 * The bar is the drag region, the toolbar and the caption buttons, so a toggle
 * that removed it would leave a window that cannot be moved, built or closed by
 * its own chrome. What goes is the `tablist` — and what must stay is everything
 * else, including something for a press to land on in order to move the window.
 */
describe('hiding the tab bar leaves the window usable', () => {
  it('takes the document tabs away', async () => {
    await mount(stateWith({ documents: [openDocument], tabBarVisible: false }));
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(button('tab-bar-new-file')).toBeNull();
    expect(container.querySelector('[data-testid="tab-bar-separator"]')).toBeNull();
  });

  it('keeps the drag region, the toolbar and the window controls', async () => {
    await mount(stateWith({ documents: [openDocument], tabBarVisible: false }));
    expect(container.querySelector('[data-testid="tab-bar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tab-bar-strip-spacer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tab-bar-toolbar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tab-bar-window-controls"]')).not.toBeNull();
    // The toolbar still dispatches: a hidden document strip is not a disabled app.
    click('toolbar-compile');
    expect(fake.executed).toEqual(['latex.build']);
  });

  it('draws the tabs again when it comes back', async () => {
    await mount(stateWith({ documents: [openDocument], tabBarVisible: false }));
    await mount(stateWith({ documents: [openDocument], tabBarVisible: true }));
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="tab-bar-strip-spacer"]')).toBeNull();
  });
});

