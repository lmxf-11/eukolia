// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StandaloneTitleBar } from '@/ui/components/StandaloneTitleBar';
import { StandaloneSettingsWindow } from '@/ui/StandaloneSettingsWindow';
import { StandaloneSnippetsWindow } from '@/ui/StandaloneSnippetsWindow';
import { SnippetManager } from '@/ui/components/SnippetManager';
import { Settings, Zap } from '@/ui/components/icons';
import { getSnippetStore } from '@/snippets/store';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('StandaloneTitleBar', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders title, subtitle, and icon', async () => {
    await act(async () => {
      root.render(
        <StandaloneTitleBar
          title="Settings"
          subtitle="Editor"
          icon={Settings}
        />
      );
    });

    expect(container.textContent).toContain('Eu');
    expect(container.textContent).toContain('Settings');
    expect(container.textContent).toContain('Editor');
  });

  it('calls onClose when close button is clicked in non-native mode', async () => {
    const onClose = vi.fn();
    (window as any).eukoliaApi = {
      hasNativeWindowControls: false,
      isWindowMaximized: vi.fn().mockResolvedValue(false),
      onWindowMaximizedChanged: vi.fn().mockReturnValue(() => undefined),
      setTitleBarTheme: vi.fn().mockResolvedValue(undefined)
    };

    await act(async () => {
      root.render(
        <StandaloneTitleBar
          title="Snippet Library"
          icon={Zap}
          onClose={onClose}
        />
      );
    });

    const closeBtn = container.querySelector('button[title="Close"]');
    expect(closeBtn).not.toBeNull();
    closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SnippetManager standalone mode', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const snippetFile = {
      version: 1,
      language: 'latex',
      snippets: [{ id: 'test-snippet', trigger: { pattern: 'test' }, body: 'body' }]
    };
    (window as any).eukoliaApi = {
      hasNativeWindowControls: true,
      isWindowMaximized: vi.fn().mockResolvedValue(false),
      onWindowMaximizedChanged: vi.fn().mockReturnValue(() => undefined),
      setTitleBarTheme: vi.fn().mockResolvedValue(undefined),
      closeWindow: vi.fn().mockResolvedValue(undefined),
      readSnippetFile: vi.fn().mockResolvedValue({
        exists: true,
        path: 'User/snippets/snippets.json',
        directory: 'User/snippets',
        text: JSON.stringify(snippetFile),
        legacyFiles: []
      }),
      watchSnippetFile: vi.fn().mockResolvedValue({
        exists: true,
        path: 'User/snippets/snippets.json',
        directory: 'User/snippets',
        text: JSON.stringify(snippetFile),
        legacyFiles: []
      }),
      onSnippetFileChanged: vi.fn().mockReturnValue(() => undefined),
      readLegacySnippetFiles: vi.fn().mockResolvedValue([])
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders StandaloneTitleBar and does not wrap in modal dialog when standalone=true', async () => {
    const store = getSnippetStore();
    await store.start();
    await act(async () => {
      root.render(
        <SnippetManager
          store={store}
          open={true}
          standalone={true}
        />
      );
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('Snippet Library');
    expect(container.querySelector('header')).not.toBeNull();
  });

  it('renders editable snippet ID in header bar and protects mode toggle buttons', async () => {
    const store = getSnippetStore();
    await store.start();
    await act(async () => {
      root.render(
        <SnippetManager
          store={store}
          open={true}
          standalone={true}
          focusSnippetId="test-snippet"
        />
      );
    });

    const idInput = container.querySelector<HTMLInputElement>('input[aria-label="Snippet ID"]');
    expect(idInput).not.toBeNull();
    expect(idInput?.value).toBe('test-snippet');
    const modeGroup = container.querySelector('[aria-label="Snippet editor mode"]');
    expect(modeGroup).not.toBeNull();
  });
});

describe('StandaloneSettingsWindow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    (window as any).eukoliaApi = {
      hasNativeWindowControls: true,
      isWindowMaximized: vi.fn().mockResolvedValue(false),
      onWindowMaximizedChanged: vi.fn().mockReturnValue(() => undefined),
      setTitleBarTheme: vi.fn().mockResolvedValue(undefined),
      onNavigateSettings: vi.fn().mockReturnValue(() => undefined),
      readAdvancedSettings: vi.fn().mockResolvedValue({ exists: false, values: {} }),
      writeAdvancedSettings: vi.fn().mockResolvedValue({}),
      onAdvancedSettingsChanged: vi.fn().mockReturnValue(() => undefined)
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders Settings view with titlebar and specified section', async () => {
    await act(async () => {
      root.render(<StandaloneSettingsWindow initialSection="Editor" />);
    });

    expect(container.textContent).toContain('Settings');
    expect(container.textContent).toContain('Editor');
    expect(container.querySelector('header')).not.toBeNull();
  });
});
