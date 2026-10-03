// @vitest-environment jsdom

/**
 * The sidebar region's toggle.
 *
 * `toggleSidebar` is what `Ctrl+B`, the status bar button and the command
 * palette's "Toggle Sidebar" all run, so whatever it does is what the user
 * experiences as "the sidebar". Its contract is the one this file exists to pin
 * down: one press always flips the sidebar between on screen and off screen,
 * where "on screen" means the region holding Explorer, Search, Outline, Symbols,
 * Snippets and Problems is rendered at all.
 *
 * The failure it guards against is subtle rather than absent. `sidebarVisible`
 * is a *request*, and the region can be off screen while that request is `true` —
 * with the settings pane in its slot, or with no view ever chosen. A toggle
 * written against the raw flag looks correct on the two ordinary presses and
 * silently does nothing in those two states: it collapses nothing, or reports a
 * sidebar it never revealed.
 *
 * The real `AppStateProvider` is driven here, not a copy of its logic, so the
 * assertions are about the provider's actual transitions. It is rendered with
 * `react-dom/client` directly, following `settings-toggle.test.ts`: the project
 * has no DOM testing dependency and the provider is the whole subject.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// React only batches inside `act` when the environment says so.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.hoisted(() => {
  // Every IPC call resolves to an empty object rather than `undefined`: the
  // provider's startup path reads fields off the results, and a stub returning
  // nothing would fail inside code this test is not about.
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
const { sidebarChromeVisible, sidebarShown } = await import('../../src/renderer/ui/sidebarRegion');

type AppState = ReturnType<typeof useAppState>;

/** The region's state as the shell would read it — the one question that matters. */
const shown = (state: AppState): boolean =>
  sidebarShown({ visible: state.sidebarVisible, view: state.sidebarView, settingsOpen: state.settingsOpen });

/**
 * Whether the activity bar is on screen, exactly as `App.tsx` decides it.
 *
 * `collapseWithSidebar` mirrors `appearance.collapseActivityBarWithSidebar`,
 * whose default is on; the provider under test does not read it, so it is passed
 * explicitly rather than mocked.
 */
const chromeVisible = (state: AppState, collapseWithSidebar = true): boolean =>
  sidebarChromeVisible({
    sidebarRequested: state.sidebarVisible,
    activityBarEnabled: state.activityBarVisible,
    collapseWithSidebar
  });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let latest: AppState;

const Probe: React.FC = () => {
  latest = useAppState();
  return null;
};

async function mount(): Promise<() => AppState> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(AppStateProvider, null, React.createElement(Probe)));
  });
  return () => latest;
}

async function run(action: (state: AppState) => void): Promise<void> {
  await act(async () => {
    action(latest);
  });
}

/** One press of Ctrl+B, or of the status bar's sidebar button. */
const pressToggle = (state: AppState): void => state.toggleSidebar();

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
});

describe('one press flips the sidebar between on screen and off screen', () => {
  it('collapses the region when a view is showing', async () => {
    const state = await mount();
    await run((s) => s.setSidebarView('explorer'));
    expect(shown(state())).toBe(true);

    await run(pressToggle);

    expect(shown(state())).toBe(false);
  });

  it('brings it back on the same view', async () => {
    const state = await mount();
    await run((s) => s.setSidebarView('outline'));
    await run(pressToggle);

    await run(pressToggle);

    // Collapsing is not a way to lose your place in the sidebar.
    expect(shown(state())).toBe(true);
    expect(state().sidebarView).toBe('outline');
  });

  it('collapses a region whose views were switched, whichever was showing', async () => {
    // Every view of the region answers to the same toggle: the panels are one
    // element, so there is no view that survives the collapse.
    const state = await mount();
    for (const view of ['explorer', 'search', 'outline', 'symbols', 'snippets', 'problems'] as const) {
      await run((s) => s.setSidebarView(view));
      expect(shown(state()), `${view} should be on screen`).toBe(true);

      await run(pressToggle);
      expect(shown(state()), `${view} should collapse with the region`).toBe(false);

      await run(pressToggle);
      expect(state().sidebarView, `${view} should come back`).toBe(view);
    }
  });

  it('is a real flip from either direction, over many presses', async () => {
    // The invariant in one line: the toggle always lands on the opposite of
    // what was on screen. A toggle keyed off the raw `sidebarVisible` flag
    // passes this from the ordinary state and fails it from the ones below.
    const state = await mount();
    let previous = shown(state());
    for (let press = 0; press < 8; press += 1) {
      await run(pressToggle);
      const current = shown(state());
      expect(current, `press ${press + 1} of the toggle`).toBe(!previous);
      previous = current;
    }
  });
});

describe('the region cannot be reported as showing when it is not rendered', () => {
  it('reveals it on a press while the settings pane holds its slot', async () => {
    // Settings replaces the sidebar, so the stored request is still `true` with
    // no sidebar on screen. A toggle that wrote that flag would pass straight
    // through and leave the user pressing Ctrl+B at a sidebar they cannot see.
    const state = await mount();
    await run((s) => s.setSidebarView('outline'));
    await run((s) => s.setSettingsOpen(true));
    expect(state().sidebarVisible, 'the request survives while settings is up').toBe(true);
    expect(shown(state())).toBe(false);

    await run(pressToggle);

    expect(shown(state())).toBe(true);
    expect(state().settingsOpen, 'the pane holding the slot has to step aside').toBe(false);
    expect(state().sidebarView, 'and the view is the one that was asked for').toBe('outline');
  });

  it('reveals it on a press when no view was ever chosen', async () => {
    const state = await mount();
    await run((s) => s.setSidebarView(null));
    expect(state().sidebarVisible).toBe(false);

    await run(pressToggle);

    // A region with no view would come back as an empty panel, so it comes back
    // on Explorer instead.
    expect(shown(state())).toBe(true);
    expect(state().sidebarView).toBe('explorer');
  });

  it('answers a press from a collapsed region, and from there keeps flipping', async () => {
    const state = await mount();
    await run((s) => s.setSidebarView(null));
    await run((s) => s.setSidebarView('search'));
    await run(pressToggle);
    expect(shown(state())).toBe(false);

    await run(pressToggle);
    expect(shown(state())).toBe(true);
    expect(state().sidebarView).toBe('search');
  });
});

describe('the views move together, and nothing else does', () => {
  it('takes the activity bar down with the region, and not the setting', async () => {
    // The strip holds the buttons for the views, so leaving it up after the
    // region it switches has been collapsed puts six panel buttons on screen
    // with none of those panels rendered.
    const state = await mount();
    expect(state().activityBarVisible).toBe(true);
    expect(chromeVisible(state())).toBe(true);

    await run(pressToggle);

    expect(shown(state())).toBe(false);
    expect(chromeVisible(state()), 'the strip goes with the region').toBe(false);
    // The user's preference is untouched: restoring the sidebar must bring the
    // strip back, not require turning it on again.
    expect(state().activityBarVisible, 'the setting is not what changed').toBe(true);

    await run(pressToggle);
    expect(shown(state())).toBe(true);
    expect(chromeVisible(state())).toBe(true);
  });

  it('keeps the strip while the settings pane is open', async () => {
    // Settings replaces the sidebar's slot, and the strip deliberately stays so
    // a view can be reached from inside the pane in one click. Hiding it there
    // would strand the pane.
    const state = await mount();
    await run((s) => s.setSidebarView('explorer'));
    await run((s) => s.setSettingsOpen(true));

    expect(shown(state())).toBe(false);
    expect(chromeVisible(state()), 'the pane must keep its route to a view').toBe(true);
  });

  it('still honours the activity bar setting', async () => {
    const state = await mount();
    expect(chromeVisible(state())).toBe(true);

    await run((s) => s.toggleActivityBar());

    expect(state().activityBarVisible).toBe(false);
    expect(chromeVisible(state()), 'the setting still hides the strip').toBe(false);
  });

  it('leaves the bottom panel alone', async () => {
    // Problems and Search Results also appear in the bottom panel, but that is a
    // different axis with its own toggle (Ctrl+J) — collapsing the sidebar is
    // not a panel toggle.
    const state = await mount();
    await run((s) => s.toggleBottomPanel());
    expect(state().bottomPanelVisible).toBe(true);

    await run(pressToggle);

    expect(shown(state())).toBe(false);
    expect(state().bottomPanelVisible).toBe(true);
  });

  it('shows the sidebar without collapsing it when a view command runs', async () => {
    // `view.explorer` and friends mean "show me this", so they must not behave
    // like a toggle and hide a sidebar that is already up.
    const state = await mount();
    await run((s) => s.setSidebarView('explorer'));
    await run(pressToggle);
    expect(shown(state())).toBe(false);

    await run((s) => s.showSidebar());

    expect(shown(state())).toBe(true);
  });
});
