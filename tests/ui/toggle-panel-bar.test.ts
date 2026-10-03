// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { panelButtonsVisible } from '../../src/renderer/ui/sidebarRegion';
import { commandRegistry } from '../../src/renderer/core/commands';
import { settingsManager } from '../../src/renderer/core/settings';

// Mock state and settings for testing
const fake = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  settings: {} as Record<string, unknown>
}));

vi.mock('../../src/renderer/ui/state', () => ({
  useAppState: () => fake.state,
  useOptionalAppState: () => fake.state
}));

vi.mock('../../src/renderer/core/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/core/settings')>();
  return {
    ...actual,
    settingsManager: {
      ...actual.settingsManager,
      getValue: (key: string) => fake.settings[key],
      setValue: (key: string, value: unknown) => {
        fake.settings[key] = value;
      },
      on: () => () => undefined
    },
    setting: {
      ...actual.setting,
      bool: (key: string) => fake.settings[key] !== false
    }
  };
});

vi.mock('../../src/renderer/services/instance', () => ({
  workspaceService: { reorderDocument: () => undefined }
}));

const { StatusBar } = await import('../../src/renderer/ui/components/StatusBar');
const { ActivityBar } = await import('../../src/renderer/ui/components/ActivityBar');
const { TopLeftMenuButton } = await import('../../src/renderer/ui/components/TopLeftMenuButton');
const { TabBar } = await import('../../src/renderer/ui/components/TabBar');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('panelButtonsVisible helper', () => {
  it('shows panel buttons when the sidebar is requested/visible', () => {
    expect(panelButtonsVisible({ sidebarRequested: true, collapseWithSidebar: true })).toBe(true);
    expect(panelButtonsVisible({ sidebarRequested: true, collapseWithSidebar: false })).toBe(true);
  });

  it('hides panel buttons when sidebar is collapsed and collapseWithSidebar is true', () => {
    expect(panelButtonsVisible({ sidebarRequested: false, collapseWithSidebar: true })).toBe(false);
  });

  it('keeps panel buttons visible when sidebar is collapsed and collapseWithSidebar is false (Toggle Panel Bar is on)', () => {
    expect(panelButtonsVisible({ sidebarRequested: false, collapseWithSidebar: false })).toBe(true);
  });
});

describe('StatusBar Toggle Panel Bar button', () => {
  const mountStatusBar = async (collapseWithSidebar = true) => {
    fake.settings = {
      'appearance.collapseActivityBarWithSidebar': collapseWithSidebar,
      'files.encoding': 'utf8',
      'compilation.recipe': 'latexmk',
      'compilation.engine': 'latexmk',
      'editor.tabSize': 2,
      'editor.insertSpaces': true
    };
    fake.state = {
      build: { status: 'idle', durationMs: null, errorCount: 0, warningCount: 0 },
      tools: [],
      cursor: { line: 1, column: 1, offset: 0, selectedChars: 0 },
      theme: 'dark',
      themeSetting: 'dark',
      statusMessage: null,
      activeDoc: null,
      pdf: { path: null, visible: true },
      sidebarVisible: true,
      sidebarView: 'explorer',
      settingsOpen: false,
      bottomPanelVisible: false,
      bottomPanelView: 'problems',
      tabBarVisible: true,
      toggleBottomPanel: () => undefined,
      cycleTheme: () => undefined,
      openFile: () => undefined,
      detectRecipes: () => undefined,
      setSetting: () => undefined,
      togglePanelBar: () => undefined
    };

    await act(async () => {
      root.render(React.createElement(StatusBar));
    });
  };

  it('renders the Toggle Panel Bar button in the layout cluster', async () => {
    await mountStatusBar(true);
    const button = container.querySelector('[data-testid="status-toggle-view.togglePanelBar"]');
    expect(button).toBeTruthy();
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.getAttribute('aria-label')).toBe('Turn on Panel Bar');
  });

  it('shows pressed state when Toggle Panel Bar is on (collapseWithSidebar is false)', async () => {
    await mountStatusBar(false);
    const button = container.querySelector('[data-testid="status-toggle-view.togglePanelBar"]');
    expect(button).toBeTruthy();
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.getAttribute('aria-label')).toBe('Turn off Panel Bar');
  });

  it('dispatches view.togglePanelBar command on click', async () => {
    const executed: string[] = [];
    const origExecute = commandRegistry.execute;
    commandRegistry.execute = vi.fn().mockImplementation((id: string) => {
      executed.push(id);
      return Promise.resolve();
    });

    try {
      await mountStatusBar(true);
      const button = container.querySelector('[data-testid="status-toggle-view.togglePanelBar"]') as HTMLButtonElement;
      expect(button).toBeTruthy();
      button.click();
      expect(executed).toContain('view.togglePanelBar');
    } finally {
      commandRegistry.execute = origExecute;
    }
  });
});

describe('ActivityBar rendering of Menu and panel buttons', () => {
  const mountActivityBar = async (sidebarVisible: boolean, collapseWithSidebar: boolean) => {
    fake.settings = {
      'appearance.collapseActivityBarWithSidebar': collapseWithSidebar
    };
    fake.state = {
      sidebarView: 'explorer',
      sidebarVisible,
      settingsOpen: false,
      setSidebarView: vi.fn(),
      toggleSettings: vi.fn()
    };

    await act(async () => {
      root.render(React.createElement(ActivityBar, { collapseWithSidebar }));
    });
  };

  it('always renders the Menu button even when panel buttons are collapsed', async () => {
    await mountActivityBar(false, true);

    // Menu button is present
    expect(container.querySelector('[data-testid="activity-bar-menu"]')).toBeTruthy();

    // Panel buttons are hidden
    expect(container.querySelector('[data-testid="activity-bar-explorer"]')).toBeNull();
    expect(container.querySelector('[data-testid="activity-bar-search"]')).toBeNull();
    expect(container.querySelector('[data-testid="activity-bar-outline"]')).toBeNull();
  });

  it('renders both Menu and panel buttons when sidebar is visible', async () => {
    await mountActivityBar(true, true);

    expect(container.querySelector('[data-testid="activity-bar-menu"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="activity-bar-explorer"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="activity-bar-search"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="activity-bar-outline"]')).toBeTruthy();
  });

  it('renders both Menu and panel buttons when sidebar is collapsed but Toggle Panel Bar is on', async () => {
    await mountActivityBar(false, false);

    expect(container.querySelector('[data-testid="activity-bar-menu"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="activity-bar-explorer"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="activity-bar-search"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="activity-bar-outline"]')).toBeTruthy();
  });
});

describe('TopLeftMenuButton and TabBar integration', () => {
  const mountTopLeftMenuButton = async (sidebarVisible = false, sidebarView: string | null = null) => {
    const setSidebarView = vi.fn();
    const toggleSidebar = vi.fn();
    fake.state = {
      sidebarVisible,
      sidebarView,
      setSidebarView,
      toggleSidebar
    };

    await act(async () => {
      root.render(React.createElement(TopLeftMenuButton));
    });

    return { setSidebarView, toggleSidebar };
  };

  it('renders compact TopLeftMenuButton with Menu icon and label', async () => {
    await mountTopLeftMenuButton(false, null);
    const button = container.querySelector('[data-testid="top-left-menu-button"]');
    expect(button).toBeTruthy();
    expect(button?.textContent).toContain('Menu');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
  });

  it('switches to menu view when clicked while sidebar is closed', async () => {
    const { setSidebarView, toggleSidebar } = await mountTopLeftMenuButton(false, null);
    const button = container.querySelector('[data-testid="top-left-menu-button"]') as HTMLButtonElement;
    expect(button).toBeTruthy();

    await act(async () => {
      button.click();
    });

    expect(setSidebarView).toHaveBeenCalledWith('menu');
    expect(toggleSidebar).not.toHaveBeenCalled();
  });

  it('toggles sidebar when clicked while menu view is already active', async () => {
    const { setSidebarView, toggleSidebar } = await mountTopLeftMenuButton(true, 'menu');
    const button = container.querySelector('[data-testid="top-left-menu-button"]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      button.click();
    });

    expect(toggleSidebar).toHaveBeenCalled();
  });

  it('renders TopLeftMenuButton inside TabBar when panelBarShown is false', async () => {
    fake.settings = {
      'appearance.collapseActivityBarWithSidebar': true
    };
    fake.state = {
      documents: [],
      activeDocument: null,
      build: { status: 'idle' },
      pdf: { visible: false, path: null, page: 1, pageCount: 0 },
      layout: 'split',
      editorMode: 'code',
      tabBarVisible: true,
      sidebarVisible: false,
      sidebarView: null,
      activityBarVisible: true,
      closeDocument: vi.fn(),
      setActiveDocument: vi.fn(),
      newFile: vi.fn(),
      toggleFocusMode: vi.fn(),
      toggleSidebar: vi.fn(),
      setSidebarView: vi.fn()
    };

    await act(async () => {
      root.render(React.createElement(TabBar, { panelBarShown: false }));
    });

    expect(container.querySelector('[data-testid="top-left-menu-button"]')).toBeTruthy();
  });

  it('does NOT render TopLeftMenuButton inside TabBar when panelBarShown is true', async () => {
    fake.settings = {
      'appearance.collapseActivityBarWithSidebar': false
    };
    fake.state = {
      documents: [],
      activeDocument: null,
      build: { status: 'idle' },
      pdf: { visible: false, path: null, page: 1, pageCount: 0 },
      layout: 'split',
      editorMode: 'code',
      tabBarVisible: true,
      sidebarVisible: false,
      sidebarView: null,
      activityBarVisible: true,
      closeDocument: vi.fn(),
      setActiveDocument: vi.fn(),
      newFile: vi.fn(),
      toggleFocusMode: vi.fn(),
      toggleSidebar: vi.fn(),
      setSidebarView: vi.fn()
    };

    await act(async () => {
      root.render(React.createElement(TabBar, { panelBarShown: true }));
    });

    expect(container.querySelector('[data-testid="top-left-menu-button"]')).toBeNull();
  });
});
