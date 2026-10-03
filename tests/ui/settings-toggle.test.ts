// @vitest-environment jsdom

/**
 * The settings pane's open/closed transitions.
 *
 * Settings is the one surface that *replaces* the editor rather than floating
 * over it, which makes it the one that can trap the user: if nothing brings it
 * down, the activity bar behind it looks inert because the view it changes is
 * hidden. These tests drive the real `AppStateProvider` — not a copy of its
 * logic — and assert the invariant that matters: choosing somewhere else to look
 * takes the user there.
 *
 * `AppStateProvider` is rendered with `react-dom/client` directly rather than a
 * testing library: the project has no DOM testing dependency, and the provider is
 * the whole subject here.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// React only batches inside `act` when the environment says so.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.hoisted(() => {
  // Every IPC call resolves to an empty object rather than `undefined`: the
  // provider's startup path reads fields off the results (a settings-file
  // description, a snippet-file description), and a stub that returned nothing
  // would fail inside code this test is not about.
  const ipc = new Proxy(
    {},
    {
      get: (_target, property) => (..._args: unknown[]) => {
        if (typeof property === 'string' && property.startsWith('on')) return () => undefined;
        return Promise.resolve({});
      }
    }
  );
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = {
    eukoliaApi: ipc,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  };
});

const { AppStateProvider, useAppState } = await import('../../src/renderer/ui/state');
const { SHORTCUTS_SECTION } = await import('../../src/renderer/ui/components/SettingsView');
const { SETTING_CATEGORIES } = await import('../../src/renderer/core/settings');
const { escapeFromSettings } = await import('../../src/renderer/ui/App');

type AppState = ReturnType<typeof useAppState>;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let latest: AppState;

const Probe: React.FC = () => {
  latest = useAppState();
  return null;
};

/** Renders the real provider and returns a way to read its current state. */
async function mount(): Promise<() => AppState> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(AppStateProvider, null, React.createElement(Probe))
    );
  });
  return () => latest;
}

async function run(action: (state: AppState) => void): Promise<void> {
  await act(async () => {
    action(latest);
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
});

describe('leaving the settings pane', () => {
  it('setting a sidebar view while settings are open closes settings', async () => {
    const state = await mount();
    await run((s) => s.setSettingsOpen(true));
    expect(state().settingsOpen).toBe(true);

    // Exactly what the activity bar's Explorer icon does.
    await run((s) => s.setSidebarView('explorer'));

    expect(state().settingsOpen).toBe(false);
    expect(state().sidebarView).toBe('explorer');
    expect(state().sidebarVisible).toBe(true);
  });

  it('closes settings for a view that is not the one already selected', async () => {
    const state = await mount();
    await run((s) => {
      s.setSidebarView('explorer');
      s.setSettingsOpen(true);
    });

    await run((s) => s.setSidebarView('outline'));

    expect(state().settingsOpen).toBe(false);
    expect(state().sidebarView).toBe('outline');
  });

  it('closes settings when the sidebar is dismissed from inside it', async () => {
    const state = await mount();
    await run((s) => {
      s.setSidebarView('explorer');
      s.setSettingsOpen(true);
    });

    // The activity bar's "click the active icon again" gesture.
    await run((s) => s.setSidebarView(null));

    expect(state().settingsOpen).toBe(false);
    expect(state().sidebarVisible).toBe(false);
  });

  it('closes settings when a view is chosen from inside the snippet manager', async () => {
    const state = await mount();
    // The route the user described: open Settings, go to Manage snippets, then
    // click Explorer. The section is part of the pane, so the pane has to come
    // down with it.
    await run((s) => s.toggleSettings());
    await run((s) => s.openSettingsSection(SHORTCUTS_SECTION));
    expect(state().settingsSection).toBe(SHORTCUTS_SECTION);

    await run((s) => s.setSidebarView('explorer'));

    expect(state().settingsOpen).toBe(false);
    expect(state().sidebarView).toBe('explorer');
  });

  it('dismisses the palette and quick open as well, since both float above settings', async () => {
    const state = await mount();
    await run((s) => {
      s.setSettingsOpen(true);
      s.setPaletteOpen(true);
      s.setQuickOpenOpen(true);
    });

    await run((s) => s.setSidebarView('search'));

    expect(state().settingsOpen).toBe(false);
    expect(state().paletteOpen).toBe(false);
    expect(state().quickOpenOpen).toBe(false);
  });

  it('toggles settings closed on a second press of the same control', async () => {
    const state = await mount();
    await run((s) => s.toggleSettings());
    expect(state().settingsOpen).toBe(true);

    await run((s) => s.toggleSettings());
    expect(state().settingsOpen).toBe(false);
  });

  it('keeps the selected view when settings are opened and closed again', async () => {
    const state = await mount();
    await run((s) => s.setSidebarView('problems'));
    await run((s) => s.toggleSettings());
    await run((s) => s.toggleSettings());

    // The gear is an overlay on the sidebar, not a replacement for the choice.
    expect(state().sidebarView).toBe('problems');
    expect(state().sidebarVisible).toBe(true);
  });
});

describe('settings sections', () => {
  it('opens on the first category', async () => {
    const state = await mount();
    expect(state().settingsSection).toBe(SETTING_CATEGORIES[0]);
  });

  it('opens a synthetic section, and steps back when it is pressed again', async () => {
    const state = await mount();
    await run((s) => s.openSettingsSection(SHORTCUTS_SECTION));
    expect(state().settingsOpen).toBe(true);
    expect(state().settingsSection).toBe(SHORTCUTS_SECTION);

    await run((s) => s.openSettingsSection(SHORTCUTS_SECTION));
    expect(state().settingsSection).toBe(SETTING_CATEGORIES[0]);
    // Stepping back within the pane must not close it.
    expect(state().settingsOpen).toBe(true);
  });

  it('steps back from the shortcuts section the same way', async () => {
    const state = await mount();
    await run((s) => s.openSettingsSection(SHORTCUTS_SECTION));
    await run((s) => s.openSettingsSection(SHORTCUTS_SECTION));
    expect(state().settingsSection).toBe(SETTING_CATEGORIES[0]);
    expect(state().settingsOpen).toBe(true);
  });

  it('leaves a synthetic section for a category when a category is chosen', async () => {
    const state = await mount();
    await run((s) => s.openSettingsSection(SHORTCUTS_SECTION));
    await run((s) => s.openSettingsSection('Editor'));
    expect(state().settingsSection).toBe('Editor');
    expect(state().settingsOpen).toBe(true);
  });

  it('opens the pane when a section is chosen while it is closed', async () => {
    const state = await mount();
    expect(state().settingsOpen).toBe(false);
    await run((s) => s.openSettingsSection('Snippets'));
    expect(state().settingsOpen).toBe(true);
    expect(state().settingsSection).toBe('Snippets');
  });
});

describe('the snippet library window', () => {
  it('opens and closes on its own, without touching the settings pane', async () => {
    const state = await mount();
    expect(state().snippetsOpen).toBe(false);

    await run((s) => s.toggleSnippets());
    expect(state().snippetsOpen).toBe(true);
    // It is a window rather than a settings section: the pane it used to live in
    // stays exactly as it was.
    expect(state().settingsOpen).toBe(false);
    expect(state().settingsSection).toBe(SETTING_CATEGORIES[0]);

    await run((s) => s.toggleSnippets());
    expect(state().snippetsOpen).toBe(false);
  });

  it('dismisses the palette and quick open, which would otherwise float over it', async () => {
    const state = await mount();
    await run((s) => {
      s.setPaletteOpen(true);
      s.setQuickOpenOpen(true);
    });

    await run((s) => s.toggleSnippets());

    expect(state().snippetsOpen).toBe(true);
    expect(state().paletteOpen).toBe(false);
    expect(state().quickOpenOpen).toBe(false);
  });

  it('can be dismissed while it is open, without opening it again', async () => {
    const state = await mount();
    await run((s) => s.setSnippetsOpen(true));
    await run((s) => s.setSnippetsOpen(false));
    expect(state().snippetsOpen).toBe(false);
  });
});

describe('what Escape does', () => {
  const base = {
    settingsOpen: true,
    settingsSection: SETTING_CATEGORIES[0],
    paletteOpen: false,
    quickOpenOpen: false,
    shortcutsOpen: false,
    aboutOpen: false,
    buildPickerOpen: false,
    snippetsOpen: false
  };

  it('does nothing while the settings pane is closed', () => {
    expect(escapeFromSettings({ ...base, settingsOpen: false })).toBe('none');
  });

  it('closes the pane from the category list', () => {
    expect(escapeFromSettings(base)).toBe('close-settings');
    expect(escapeFromSettings({ ...base, settingsSection: 'Snippets' })).toBe('close-settings');
  });

  it('leaves the section first when the shortcut editor is showing', () => {
    expect(escapeFromSettings({ ...base, settingsSection: SHORTCUTS_SECTION })).toBe('leave-section');
  });

  it('stands aside for every overlay that sits above the pane', () => {
    // One press, one dismissal: the overlay closes and the pane stays, which is
    // what makes the second press the one that leaves Settings. The snippet
    // library is one of these now — it is a window above the pane rather than a
    // section of it, and it closes itself.
    for (const overlay of [
      'paletteOpen',
      'quickOpenOpen',
      'shortcutsOpen',
      'aboutOpen',
      'buildPickerOpen',
      'snippetsOpen'
    ] as const) {
      expect(
        escapeFromSettings({ ...base, [overlay]: true }),
        `${overlay} should own Escape while it is open`
      ).toBe('none');
      expect(
        escapeFromSettings({ ...base, settingsSection: SHORTCUTS_SECTION, [overlay]: true }),
        `${overlay} should own Escape from a section too`
      ).toBe('none');
    }
  });
});
