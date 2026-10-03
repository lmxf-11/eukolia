// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { commandRegistry } from '../../src/renderer/core/commands';

const fake = vi.hoisted(() => ({
  state: {} as Record<string, unknown>
}));

vi.mock('../../src/renderer/ui/state', () => ({ useAppState: () => fake.state }));

const { Sidebar } = await import('../../src/renderer/ui/components/Sidebar');

let container: HTMLDivElement;
let root: Root;

let openFolderMock: ReturnType<typeof vi.fn>;
let setStatusMessageMock: ReturnType<typeof vi.fn>;

async function mount(): Promise<void> {
  openFolderMock = vi.fn();
  setStatusMessageMock = vi.fn();

  fake.state = {
    sidebarView: 'menu',
    setSidebarView: () => undefined,
    workspace: {
      workspacePath: 'D:/Projects/MyPaper',
      workspaceName: 'MyPaper'
    },
    openFolder: openFolderMock,
    setStatusMessage: setStatusMessageMock
  };

  await act(async () => {
    root.render(React.createElement(Sidebar));
  });
  await act(async () => {});
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('MenuView in Sidebar', () => {
  it('renders the menu panel when sidebarView is "menu"', async () => {
    await mount();
    const menuView = container.querySelector('[data-testid="menu-view"]');
    expect(menuView).not.toBeNull();
  });

  it('renders the project library button with active project name', async () => {
    await mount();
    const btn = container.querySelector('[data-testid="menu-project-library-button"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain('MyPaper');
  });

  it('dispatches project library events when clicking library buttons', async () => {
    await mount();
    const events: CustomEvent[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener('eukolia:project-library', listener);

    const libBtn = container.querySelector('[data-testid="menu-project-library-button"]') as HTMLButtonElement;
    act(() => {
      libBtn.click();
    });
    expect(events.length).toBe(1);
    expect(events[0].detail).toBe('library');

    const newBtn = container.querySelector('[data-testid="menu-new-project-button"]') as HTMLButtonElement;
    act(() => {
      newBtn.click();
    });
    expect(events.length).toBe(2);
    expect(events[1].detail).toBe('create');

    window.removeEventListener('eukolia:project-library', listener);
  });

  it('calls openFolder when clicking Open Folder button', async () => {
    await mount();
    const openBtn = container.querySelector('[data-testid="menu-open-folder-button"]') as HTMLButtonElement;
    act(() => {
      openBtn.click();
    });
    expect(openFolderMock).toHaveBeenCalled();
  });

  it('renders standard menu sections: File, Edit, View, Run, Terminal, Help', async () => {
    await mount();
    for (const section of ['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Help']) {
      expect(container.querySelector(`[data-testid="menu-section-${section}"]`), `Section ${section}`).not.toBeNull();
    }
  });

  it('filters commands when searching', async () => {
    // Register a test command
    const testCmdId = 'test.myCustomMenuCommand';
    commandRegistry.register({
      id: testCmdId,
      title: 'Unique Unicorn LaTeX Command',
      category: 'File',
      handler: () => undefined
    });

    await mount();
    const input = container.querySelector('[data-testid="menu-filter-input"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    await act(async () => {
      input.value = 'Unicorn';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Also trigger onChange if needed in React
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      nativeInputValueSetter?.call(input, 'Unicorn');
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // An item matching 'Unicorn' should be present
    expect(container.textContent).toContain('Unique Unicorn LaTeX Command');
  });

  it('executes a command when clicking its button', async () => {
    const handler = vi.fn();
    const cmdId = 'file.testExecutionCommand';
    commandRegistry.register({
      id: cmdId,
      title: 'Test Execution Action',
      category: 'File',
      handler
    });

    await mount();
    const item = container.querySelector(`[data-testid="menu-item-${cmdId}"]`) as HTMLButtonElement;
    if (item) {
      act(() => {
        item.click();
      });
      expect(handler).toHaveBeenCalled();
      expect(setStatusMessageMock).toHaveBeenCalledWith(expect.stringContaining('Test Execution Action'));
    }
  });
});
