// @vitest-environment jsdom

/**
 * The shell's sidebar layout.
 *
 * `sidebar-region.test.ts` pins the *rule* — when the sidebar is on screen, and
 * whether the activity bar comes with it. This file pins the other half, which
 * that one cannot see: that the shell actually asks. The strip was left behind
 * after a collapse not because the rule was wrong but because `App.tsx` did not
 * consult anything at all — it rendered the activity bar on
 * `state.activityBarVisible` alone, a flag collapsing the sidebar never touches.
 *
 * A rule with no caller is invisible to a test of the rule, so the shell is
 * rendered here against a supplied state and the two independent conditions are
 * read off the DOM: the element holding the view panel, and the strip.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const fake = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  /** Settings the shell reads directly, rather than through app state. */
  settings: {} as Record<string, unknown>
}));

vi.mock('../../src/renderer/ui/state', () => ({ useAppState: () => fake.state }));

vi.mock('../../src/renderer/core/settings', () => ({
  settingsManager: {
    getValue: (key: string) => fake.settings[key],
    setValue: () => undefined,
    on: () => () => undefined
  },
  setting: {
    bool: (key: string) => fake.settings[key] !== false,
    num: (key: string) => Number(fake.settings[key] ?? 0),
    str: (key: string) => String(fake.settings[key] ?? ''),
    list: (key: string) => (Array.isArray(fake.settings[key]) ? (fake.settings[key] as string[]) : [])
  },
  SETTING_CATEGORIES: []
}));

/**
 * The children are stubbed. This is a test about the shell's layout conditions,
 * and each of these pulls in a subsystem of its own — the editor, the PDF
 * worker, the terminal — none of which decides whether the sidebar or the strip
 * is rendered. A real `ActivityBar`, `Sidebar` and `TitleBar` are kept, since
 * those are the elements under test.
 */
const stub = (name: string) => {
  const Component = () => React.createElement('div', { 'data-stub': name });
  Component.displayName = name;
  return { [name]: Component };
};

vi.mock('../../src/renderer/ui/components/TabBar', () => stub('TabBar'));
vi.mock('../../src/renderer/ui/components/BottomPanel', () => stub('BottomPanel'));
vi.mock('../../src/renderer/ui/components/TabSwitcher', () => stub('TabSwitcher'));
vi.mock('../../src/renderer/ui/components/CommandPalette', () => stub('CommandPalette'));
vi.mock('../../src/renderer/ui/components/QuickOpen', () => stub('QuickOpen'));
vi.mock('../../src/renderer/ui/components/SettingsView', () => ({
  SettingsView: () => React.createElement('div', { 'data-testid': 'settings-view' }),
  SHORTCUTS_SECTION: 'shortcuts'
}));
vi.mock('../../src/renderer/ui/components/SplitPane', () => stub('SplitPane'));
vi.mock('../../src/renderer/ui/components/FocusPdfFloat', () => stub('FocusPdfFloat'));
vi.mock('../../src/renderer/ui/components/Modal', () => stub('Modal'));
vi.mock('../../src/renderer/visual/VisualEditor', () => stub('VisualEditor'));
vi.mock('../../src/renderer/pdf/PdfPane', () => stub('PdfPane'));
vi.mock('../../src/renderer/ui/components/StatusBar', () => stub('StatusBar'));
vi.mock('../../src/renderer/ui/components/TitleBar', () => stub('TitleBar'));

const { AppShell } = await import('../../src/renderer/ui/App');

let container: HTMLDivElement;
let root: Root;

/** A state with only what the shell's layout conditions read. */
async function mount(
  overrides: Record<string, unknown> & { collapseWithSidebar?: boolean } = {}
): Promise<void> {
  const { collapseWithSidebar, ...state } = overrides;
  fake.settings = {
    'appearance.collapseActivityBarWithSidebar': collapseWithSidebar ?? true,
    'appearance.sidebarWidth': 260
  };
  fake.state = {
    ready: true,
    bootError: null,
    layout: 'split',
    editorMode: 'code',
    sidebarView: 'explorer',
    sidebarVisible: true,
    activityBarVisible: true,
    settingsOpen: false,
    tabBarVisible: true,
    statusBarVisible: true,
    bottomPanelVisible: false,
    pdf: { path: null, visible: false, page: 1, pageCount: 0, zoom: 1, zoomMode: 'page-width', scrollTop: 0, loading: false, error: null, searchQuery: '', searchMatches: 0, outline: [] },
    documents: [],
    activeDoc: null,
    workspace: { workspacePath: null, workspaceName: null, documents: [], activeUri: null, recentWorkspaces: [], building: false },
    fileTree: [],
    outline: [],
    diagnostics: [],
    build: { status: 'idle', output: '', diagnostics: [], errorCount: 0, warningCount: 0, durationMs: 0, pdfPath: null },
    search: { query: '', replace: '', isRegex: false, caseSensitive: false, wholeWord: false, include: '*.tex', results: [], running: false, truncated: false, durationMs: 0, filesScanned: 0, error: null },
    cursor: { line: 1, column: 1, offset: 0, selectedChars: 0 },
    theme: 'dark',
    themeSetting: 'dark',
    themeAppearance: 'dark',
    statusMessage: null,
    paletteOpen: false,
    quickOpenOpen: false,
    shortcutsOpen: false,
    aboutOpen: false,
    buildPickerOpen: false,
    activeRecipes: [],
    activeRecipeName: null,
    tools: [],
    recentWorkspaces: [],
    settingsSection: 'Editor',
    terminalVisible: false,
    editorHandleRef: { current: null },
    documentCount: 0,
    ...overrides
  };
  await act(async () => {
    root.render(React.createElement(AppShell));
  });
  await act(async () => {});
}

const activityBar = () => container.querySelector('[data-testid="activity-bar"]');
const sidebarPanel = () => container.querySelector('[data-testid="sidebar-region"]');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('the activity bar is part of the sidebar', () => {
  it('renders the strip while the sidebar is showing', async () => {
    await mount();
    expect(activityBar(), 'the strip is up with the sidebar').toBeTruthy();
  });

  it('removes the Panel Bar completely when the sidebar is collapsed and collapseWithSidebar is true', async () => {
    // When Toggle Panel Bar is off (collapseWithSidebar: true), closing the sidebar
    // removes the Panel Bar completely and wraps the Menu button into the top-left expandable button.
    await mount({ sidebarVisible: false, collapseWithSidebar: true });
    expect(activityBar(), 'the panel bar is completely removed').toBeNull();
  });

  it('brings the strip back when the sidebar is restored', async () => {
    // `sidebarVisible` is the user's request and is never written by a collapse,
    // so restoring the sidebar restores the strip without a second action.
    await mount({ sidebarVisible: true });
    expect(activityBar()).toBeTruthy();
  });

  it('keeps the strip while the settings pane is open if sidebar was open', async () => {
    // The pane replaces the sidebar's slot; the strip stays so a view is one
    // click away from inside it.
    await mount({ settingsOpen: true, sidebarVisible: true });
    expect(container.querySelector('[data-testid="settings-view"]')).toBeTruthy();
    expect(activityBar(), 'Settings keeps its route to a view').toBeTruthy();
  });

  it('does not resurrect the panel bar when settings pane opens with collapsed sidebar', async () => {
    // Opening Settings is not a request to bring the panel bar back.
    await mount({ settingsOpen: true, sidebarVisible: false, collapseWithSidebar: true });
    expect(activityBar()).toBeNull();
  });

  it('still honours the setting that turns the strip off', async () => {
    await mount({ activityBarVisible: false });
    expect(activityBar()).toBeNull();
  });
});

/**
 * `appearance.collapseActivityBarWithSidebar`, read from the settings manager
 * rather than app state, so the shell has to be rendered to prove it is wired.
 */
describe('collapsing only the container, not the strip', () => {
  it('leaves the strip and panel buttons up when the sidebar is collapsed and collapseWithSidebar is false', async () => {
    await mount({ sidebarVisible: false, collapseWithSidebar: false });
    expect(sidebarPanel(), 'the sidebar container is gone').toBeNull();
    expect(activityBar(), 'the strip stays as the way back').toBeTruthy();
    expect(container.querySelector('[data-testid="activity-bar-menu"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="activity-bar-explorer"]')).toBeTruthy();
  });

  it('keeps both up when the sidebar is showing', async () => {
    await mount({ collapseWithSidebar: false });
    expect(sidebarPanel()).toBeTruthy();
    expect(activityBar()).toBeTruthy();
    expect(container.querySelector('[data-testid="activity-bar-menu"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="activity-bar-explorer"]')).toBeTruthy();
  });

  it('removes the Panel Bar completely by default when sidebar is collapsed, without the setting being touched', async () => {
    // The default is the tied behaviour: no project overrides this setting, so
    // "unset" means panel bar collapses with sidebar completely.
    await mount({ sidebarVisible: false, collapseWithSidebar: true });
    expect(sidebarPanel()).toBeNull();
    expect(activityBar()).toBeNull();
  });
});

describe('the sidebar region itself', () => {
  it('renders the view panel only when a view is chosen', async () => {
    await mount({ sidebarView: 'explorer' });
    expect(sidebarPanel(), 'the explorer is up').toBeTruthy();

    await act(async () => {
      fake.state = { ...fake.state, sidebarView: null };
      root.render(React.createElement(AppShell));
    });
    await act(async () => {});
    expect(sidebarPanel()).toBeNull();
  });

  it('renders no view panel while the settings pane holds the slot', async () => {
    await mount({ settingsOpen: true });
    expect(container.querySelector('[data-testid="settings-view"]')).toBeTruthy();
    expect(sidebarPanel()).toBeNull();
  });
});
