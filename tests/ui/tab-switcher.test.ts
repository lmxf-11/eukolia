// @vitest-environment jsdom
/**
 * The shell's chrome: the `Ctrl+Tab` switcher, the settings-driven shortcuts and
 * the terminal's display path handling.
 *
 * Most of these cover pure logic — the tab ordering, the row focus that decides
 * which path slides, the binding resolution, the abbreviated terminal path —
 * because those are where a mistake is silent: a wrong MRU order or a path that
 * never slides looks like "the shortcut did nothing". The tab chrome itself is
 * rendered for real at the end of the file, because what it is asked to do only
 * exists in markup; the wheel it scrolls on belongs to `core/smoothScroll` and is
 * covered by `smooth-scroll.test.ts`.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  TabSwitcher,
  focusedRowIndex,
  isFocusedRow,
  marqueePlan,
  switcherOrder,
  tabTitle,
} from '@/ui/components/TabSwitcher';
import { TabBar } from '@/ui/components/TabBar';
import { displayPath } from '@/ui/components/Terminal';
import { CommandRegistry } from '@/core/commands';
import {
  KEYBINDING_SETTINGS,
  keybindingSettingFor,
  settingsManager,
} from '@/core/settings';
import type { OpenDocument } from '@/services/workspace';

/**
 * A stand-in app state for the rendered checks. `useAppState` is mocked so the
 * components can be mounted on their own, without booting the services behind
 * the real provider.
 *
 * Every field the two components read is here, including the ones the strip's
 * toolbar needs: a missing one is a `TypeError` inside the component rather than
 * an assertion failure, which reads as a broken test rather than a broken state.
 */
const appState = vi.hoisted(() => ({
  documents: [] as unknown[],
  activeDocument: null as unknown,
  setActiveDocument: () => undefined,
  closeDocument: () => Promise.resolve(),
  newFile: () => undefined,
  // `TabBar`'s toolbar reads these four; the build and PDF states are the two
  // whose values decide what it draws.
  build: { status: 'idle' },
  pdf: { path: null, visible: true, page: 1, pageCount: 0 },
  editorMode: 'code' as 'code' | 'visual',
  layout: 'split',
  // Whether the *document tabs* are drawn. The bar itself is always rendered —
  // it is the window's top edge — so without this the strip would be empty and
  // every tab assertion below would fail for a reason that is not about tabs.
  tabBarVisible: true,
  toggleFocusMode: () => undefined
}));

vi.mock('@/ui/state', () => ({ useAppState: () => appState }));

// React only batches inside `act` when the environment says so.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A minimal stand-in for an open document. */
const doc = (uri: string, text = 'line one\nline two\n', pinned = false): OpenDocument =>
  ({
    doc: {
      uri,
      filename: uri.replace(/^.*[\\/]/, ''),
      getText: () => text,
      getDirty: () => false,
    },
    recovered: false,
    externalChange: false,
    pinned,
  }) as unknown as OpenDocument;

describe('Ctrl+Tab switcher ordering', () => {
  const a = doc('D:/p/a.tex');
  const b = doc('D:/p/b.tex');
  const c = doc('D:/p/c.tex');

  it('puts the active tab first, then the recently used ones', () => {
    const order = switcherOrder([a, b, c], 'D:/p/c.tex', ['D:/p/b.tex', 'D:/p/a.tex']);
    expect(order.map(entry => entry.doc.filename)).toEqual(['c.tex', 'b.tex', 'a.tex']);
  });

  it('appends tabs that were never active, in tab order', () => {
    const order = switcherOrder([a, b, c], 'D:/p/a.tex', []);
    expect(order.map(entry => entry.doc.filename)).toEqual(['a.tex', 'b.tex', 'c.tex']);
  });

  it('ignores recently-used entries for documents that have been closed', () => {
    // Closures are common, and a stale entry must not produce a phantom row.
    const order = switcherOrder([a, c], 'D:/p/a.tex', ['D:/p/gone.tex', 'D:/p/c.tex']);
    expect(order.map(entry => entry.doc.filename)).toEqual(['a.tex', 'c.tex']);
  });

  it('does not repeat a document that is both active and recently used', () => {
    const order = switcherOrder([a, b], 'D:/p/a.tex', ['D:/p/a.tex', 'D:/p/b.tex']);
    expect(order.map(entry => entry.doc.filename)).toEqual(['a.tex', 'b.tex']);
  });

  it('handles an empty workspace', () => {
    expect(switcherOrder([], null, [])).toEqual([]);
  });
});

describe('TabSwitcher row content', () => {
  it('shows a bare file name, not the whole path', () => {
    expect(tabTitle(doc('D:/projects/paper/sections/intro.tex'))).toBe('intro.tex');
    expect(tabTitle(doc('C:\\work\\main.tex'))).toBe('main.tex');
  });

  it('falls back to the raw uri when there is no name', () => {
    const entry = doc('untitled:Untitled-1');
    (entry.doc as unknown as { filename: string }).filename = '';
    expect(tabTitle(entry)).toBe('untitled:Untitled-1');
  });
});

describe('TabSwitcher focused row', () => {
  it('focuses the highlighted row when the pointer is outside the list', () => {
    expect(isFocusedRow(1, null, 1)).toBe(true);
    expect(isFocusedRow(0, null, 1)).toBe(false);
    expect(isFocusedRow(2, null, 1)).toBe(false);
  });

  it('focuses the row under the pointer instead of the highlighted one', () => {
    // Cycling with the keyboard while the pointer rests on another row: the
    // pointer wins, so the two never both slide their path.
    expect(isFocusedRow(2, 2, 0)).toBe(true);
    expect(isFocusedRow(0, 2, 0)).toBe(false);
  });

  it('never focuses more than one row at a time', () => {
    const rows = [0, 1, 2, 3];
    for (const hoveredIndex of [null, 0, 2, 3]) {
      const focused = rows.filter(entryIndex => isFocusedRow(entryIndex, hoveredIndex, 1));
      expect(focused, `pointer on ${String(hoveredIndex)}`).toHaveLength(1);
    }
  });

  it('focuses nothing for a highlight that names no row', () => {
    // The switcher clamps the highlight to the list; this is the rule's own
    // edge, where an index past the end simply matches nothing.
    const rows = [0, 1];
    expect(rows.filter(entryIndex => isFocusedRow(entryIndex, null, 2))).toEqual([]);
  });

  it('names the focused row as the pointer’s row, or the highlighted one', () => {
    expect(focusedRowIndex(2, 0)).toBe(2);
    expect(focusedRowIndex(null, 0)).toBe(0);
    // The pointer outside the list is what hands the row back to the keyboard,
    // which is the only case the index is not the selected one.
    expect(focusedRowIndex(null, 3)).toBe(3);
  });
});

describe('TabSwitcher path marquee', () => {
  it('leaves a path that already fits exactly where it is', () => {
    expect(marqueePlan(120, 120)).toEqual({ distance: 0, durationMs: 0 });
    // A pixel of rounding is not worth animating.
    expect(marqueePlan(121, 120)).toEqual({ distance: 0, durationMs: 0 });
  });

  it('slides a long path by exactly its overflow', () => {
    expect(marqueePlan(320, 120)).toEqual({ distance: 200, durationMs: 3333 });
  });

  it('paces a longer slide over a longer run, up to a cap', () => {
    expect(marqueePlan(220, 120).durationMs).toBeLessThan(marqueePlan(620, 120).durationMs);
    // A path longer than any popup still finishes: the run is capped.
    expect(marqueePlan(9000, 120).durationMs).toBe(4000);
    // …and a short one is still given time to be seen moving.
    expect(marqueePlan(122, 120).durationMs).toBe(200);
  });

  it('does not slide against a clip it never had', () => {
    // Before layout, or in an environment without one, there is nothing to
    // measure, and a divide by it must not produce a distance out of nowhere.
    expect(marqueePlan(320, 0)).toEqual({ distance: 0, durationMs: 0 });
    expect(marqueePlan(Number.NaN, 120)).toEqual({ distance: 0, durationMs: 0 });
  });
});

// ---------------------------------------------------------------------------
// Rendered markup — the parts no pure function can express
// ---------------------------------------------------------------------------

/**
 * The popup and the strip are rendered for real here, against the fake app state
 * above, because what they were asked to do lives in markup: a list that is a
 * scroll container, a row scrolled back into view, the one glyph whose colour is
 * the pinned state, the path that is always on screen and slides when its row is
 * focused, the close button that is always there.
 *
 * `jsdom` has no layout engine, so these read the declared styles, the measured
 * widths (stubbed below) and the events the components emit rather than measured
 * geometry; the React-level rendering and the `scrollIntoView` call are checked
 * exactly.
 */

/** jsdom does not implement `scrollIntoView`; the popup must call it. */
const scrollSpy = vi.fn();

beforeEach(() => {
  scrollSpy.mockClear();
  Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
  // jsdom has no layout engine, so every element would otherwise measure zero
  // and no path would ever be seen to overflow. One stub for the text (what the
  // path needs) and one for its clip (what the row gives it) is enough to make
  // the marquee decide something: 320px of path in a 120px row.
  Object.defineProperty(Element.prototype, 'scrollWidth', { configurable: true, get: () => 320 });
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 120 });
  document.body.innerHTML = '';
});

const renderComponent = async (element: React.ReactElement): Promise<HTMLElement> => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return container;
};

/** Holds Ctrl and presses Tab, the gesture that opens and cycles the popup. */
const pressCtrlTab = async (): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
  });
};

describe('Ctrl+Tab popup markup', () => {
  it('drops the thumbnails and keeps a pin and a close control on every row', async () => {
    appState.documents = [doc('D:/p/a.tex'), doc('D:/p/b.tex', '', true), doc('D:/p/c.tex')];
    appState.activeDocument = appState.documents[0];

    const container = await renderComponent(React.createElement(TabSwitcher, {}));
    await pressCtrlTab();

    expect(container.querySelector('[data-testid="tab-switcher"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="tab-thumbnail"]').length).toBe(0);
    expect(container.querySelectorAll('[data-testid="tab-switcher-pin"]').length).toBe(3);
    expect(container.querySelectorAll('[data-testid="tab-switcher-close"]').length).toBe(3);

    const rows = Array.from(container.querySelectorAll('[data-testid="tab-switcher-row"]'));
    expect(rows.map(row => row.getAttribute('data-uri'))).toEqual(['D:/p/a.tex', 'D:/p/b.tex', 'D:/p/c.tex']);
  });

  it('makes the list the flexing scroll container under a fixed header', async () => {
    appState.documents = [doc('D:/p/a.tex'), doc('D:/p/b.tex')];
    appState.activeDocument = appState.documents[0];

    const container = await renderComponent(React.createElement(TabSwitcher, {}));
    await pressCtrlTab();

    const list = container.querySelector('[role="listbox"]') as HTMLElement;
    expect(list.style.overflowY).toBe('auto');
    // A flex item will not shrink below its content without this, which is what
    // stopped the rows from scrolling.
    expect(list.style.minHeight).toBe('0px');
    expect(list.style.flexGrow).toBe('1');

    const panel = list.parentElement as HTMLElement;
    expect(panel.style.display).toBe('flex');
    expect(panel.style.flexDirection).toBe('column');
    expect(panel.style.maxHeight).toBe('60vh');
    expect((panel.firstElementChild as HTMLElement).style.flexShrink).toBe('0');
  });

  it('scrolls the highlighted row into view as Tab cycles the list', async () => {
    appState.documents = [doc('D:/p/a.tex'), doc('D:/p/b.tex'), doc('D:/p/c.tex')];
    appState.activeDocument = appState.documents[0];

    const container = await renderComponent(React.createElement(TabSwitcher, {}));
    await pressCtrlTab();

    const rows = Array.from(container.querySelectorAll('[data-testid="tab-switcher-row"]'));
    // The first press highlights the second tab: one tap plus release returns to
    // the previously used document.
    expect(rows[1].getAttribute('data-selected')).toBe('true');
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
    // …and it is the highlighted row itself that is pulled into view.
    expect(scrollSpy.mock.contexts.at(-1)).toBe(rows[1]);

    scrollSpy.mockClear();
    await pressCtrlTab();
    expect(rows[2].getAttribute('data-selected')).toBe('true');
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollSpy.mock.contexts.at(-1)).toBe(rows[2]);
  });

  it('colours a pinned row’s pin with the accent and keeps an unpinned one muted', async () => {
    appState.documents = [doc('D:/p/a.tex'), doc('D:/p/b.tex', '', true)];
    appState.activeDocument = appState.documents[0];

    const container = await renderComponent(React.createElement(TabSwitcher, {}));
    await pressCtrlTab();

    const pins = Array.from(container.querySelectorAll('[data-testid="tab-switcher-pin"]')) as HTMLElement[];
    expect(pins[0].style.color).toBe('var(--eu-fg-secondary)');
    expect(pins[1].style.color).toBe('var(--eu-accent)');
  });

  it('keeps one pin glyph, so the state is the colour and nothing else', async () => {
    appState.documents = [doc('D:/p/a.tex'), doc('D:/p/b.tex', '', true)];
    appState.activeDocument = appState.documents[0];

    const container = await renderComponent(React.createElement(TabSwitcher, {}));
    await pressCtrlTab();

    const pins = Array.from(container.querySelectorAll('[data-testid="tab-switcher-pin"]')) as HTMLElement[];
    // The same control in both states: swapping the glyph for a crossed-out pin
    // makes one control read as two, and the accent already says "pinned".
    expect(pins[0].innerHTML).toBe(pins[1].innerHTML);
    expect(pins[0].innerHTML).toContain('<svg');
    expect(pins[0].getAttribute('data-pinned')).toBe('false');
    expect(pins[1].getAttribute('data-pinned')).toBe('true');
  });

  it('keeps the pin out of the title', async () => {
    appState.documents = [doc('D:/p/a.tex'), doc('D:/p/b.tex', '', true)];
    appState.activeDocument = appState.documents[0];

    const container = await renderComponent(React.createElement(TabSwitcher, {}));
    await pressCtrlTab();

    const rows = Array.from(container.querySelectorAll('[data-testid="tab-switcher-row"]'));
    const titles = rows.map(row => row.querySelector('[data-testid="tab-switcher-title"]') as HTMLElement);
    // A title is a title: the name starts where the row starts, and the pin
    // lives with the other control at the end of the row.
    expect(titles.map(title => title.textContent)).toEqual(['a.tex', 'b.tex']);
    for (const title of titles) expect(title.querySelector('svg')).toBeNull();
    expect(titles[0].style.textOverflow).toBe('ellipsis');
  });

  it('keeps a row two tight lines tall, whatever it holds', async () => {
    appState.documents = [doc('D:/p/a.tex'), doc('D:/p/b.tex')];
    appState.activeDocument = appState.documents[0];

    const container = await renderComponent(React.createElement(TabSwitcher, {}));
    await pressCtrlTab();

    const row = container.querySelector('[data-testid="tab-switcher-row"]') as HTMLElement;
    const title = row.querySelector('[data-testid="tab-switcher-title"]')!.parentElement as HTMLElement;
    const path = row.querySelector('[data-testid="tab-switcher-path"]') as HTMLElement;
    // Title 13 + path 11 + 2px of padding either side: a 28px row, against the
    // 38px the reserved path lane used to cost.
    expect(row.style.paddingTop).toBe('2px');
    expect(row.style.paddingBottom).toBe('2px');
    expect(title.style.height).toBe('13px');
    expect(path.style.height).toBe('11px');
  });

  it('shows every row’s path, and slides only the focused one', async () => {
    appState.documents = [doc('D:/p/a.tex'), doc('D:/p/b.tex'), doc('D:/p/c.tex')];
    appState.activeDocument = appState.documents[0];

    const container = await renderComponent(React.createElement(TabSwitcher, {}));
    await pressCtrlTab();

    const rows = Array.from(container.querySelectorAll('[data-testid="tab-switcher-row"]'));
    const pathOf = (row: Element) => row.querySelector('[data-testid="tab-switcher-path-text"]') as HTMLElement;

    // The path is a permanent part of the row — no hover needed to read where a
    // document lives, and nothing vanishes when the pointer moves on.
    expect(rows.map(row => pathOf(row).textContent)).toEqual(['D:/p/a.tex', 'D:/p/b.tex', 'D:/p/c.tex']);

    // Exactly one path moves, and it moves by its overflow: the stubs above put
    // every path at 320px in a 120px row.
    expect(rows[1].getAttribute('data-focused')).toBe('true');
    expect(pathOf(rows[1]).getAttribute('data-marquee')).toBe('true');
    expect(pathOf(rows[1]).style.transform).toContain('-200px');
    expect(pathOf(rows[0]).getAttribute('data-marquee')).toBe('false');
    // Settled under its clip: the CSSOM drops the unit from a zero length, so
    // this is `translateX(0px)` as the browser stores it.
    expect(pathOf(rows[0]).style.transform).toBe('translateX(0)');

    // Cycling with Tab moves the slide to the new row and settles the old one.
    await pressCtrlTab();
    expect(rows[2].getAttribute('data-focused')).toBe('true');
    expect(pathOf(rows[2]).getAttribute('data-marquee')).toBe('true');
    expect(pathOf(rows[1]).getAttribute('data-marquee')).toBe('false');
  });

  it('claims Ctrl+wheel for itself, because Ctrl is held for the whole gesture', async () => {
    appState.documents = [doc('D:/p/a.tex'), doc('D:/p/b.tex'), doc('D:/p/c.tex')];
    appState.activeDocument = appState.documents[0];

    const container = await renderComponent(React.createElement(TabSwitcher, {}));
    await pressCtrlTab();

    const popup = container.querySelector('[data-testid="tab-switcher"]') as HTMLElement;
    const list = container.querySelector('[role="listbox"]') as HTMLElement;

    // The shell's wheel handler (`core/smoothScroll`) gives Ctrl+wheel to the
    // browser's zoom — except here, where the popup only exists while Ctrl is
    // down, so a notch over it could otherwise never scroll the list at all. The
    // claim is on the popup rather than the list so the backdrop cannot zoom the
    // window behind it either.
    expect(popup.hasAttribute('data-ctrl-wheel-scroll')).toBe(true);
    expect(list.style.overflowY).toBe('auto');
    expect(list.style.minHeight).toBe('0px');
  });
});

describe('TabBar markup', () => {
  it('shows close button for the active tab and on hover for inactive tab, including pinned tabs', async () => {
    appState.documents = [doc('D:/p/a.tex', '', true), doc('D:/p/b.tex')];
    appState.activeDocument = appState.documents[0];

    const container = await renderComponent(React.createElement(TabBar, {}));
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    expect(tabs.length).toBe(2);
    // Active tab has close button visible
    const activeBtn = tabs[0].querySelector('button[aria-label^="Close "]') as HTMLElement;
    const inactiveBtn = tabs[1].querySelector('button[aria-label^="Close "]') as HTMLElement;
    expect(activeBtn).not.toBeNull();
    expect(inactiveBtn).not.toBeNull();
    expect(activeBtn.style.opacity).toBe('1');
    expect(inactiveBtn.style.opacity).toBe('0');

    // Hover inactive tab -> close button appears
    await act(async () => {
      tabs[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      tabs[1].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    });
    expect(inactiveBtn.style.opacity).toBe('1');

    // The pin indicator stays: it explains why the pinned tab sorts first.
    expect(container.querySelector('[data-testid="tab-pinned-indicator"]')).not.toBeNull();
  });
});

describe('shortcuts are configurable in settings', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
    registry.register({
      id: 'view.toggleTerminal',
      title: 'Toggle Terminal',
      category: 'View',
      keybinding: 'Ctrl+`',
      handler: () => undefined,
    } as never);
    registry.register({
      id: 'view.toggleSidebar',
      title: 'Toggle Sidebar',
      category: 'View',
      keybinding: 'Ctrl+B',
      handler: () => undefined,
    } as never);
  });

  it('has a dedicated setting for every toggle the user asked to rebind', () => {
    // The four toggles named in the request, plus the tab switcher.
    for (const commandId of [
      'view.toggleTerminal',
      'view.toggleSidebar',
      'pdf.toggleViewer',
      'view.toggleTabBar',
      'workbench.tabSwitcher',
    ]) {
      const key = keybindingSettingFor(commandId);
      expect(key, `${commandId} has no settings entry`).toBeTruthy();
      expect(KEYBINDING_SETTINGS[key!]).toBe(commandId);
    }
  });

  it('uses the registered default until settings say otherwise', () => {
    registry.setSettingsResolver(() => undefined);
    expect(registry.getKeybinding('view.toggleTerminal')).toBe('Ctrl+`');
  });

  it('lets a setting replace the default', () => {
    registry.setSettingsResolver(commandId =>
      commandId === 'view.toggleTerminal' ? 'Ctrl+Shift+T' : undefined
    );
    expect(registry.getKeybinding('view.toggleTerminal')).toBe('Ctrl+Shift+T');
    expect(registry.getKeybinding('view.toggleSidebar')).toBe('Ctrl+B');
  });

  it('honours an empty setting as "unbound"', () => {
    registry.setSettingsResolver(commandId =>
      commandId === 'view.toggleTerminal' ? '   ' : undefined
    );
    expect(registry.getKeybinding('view.toggleTerminal')).toBe('');
  });

  it('resolves a rebound shortcut to the command', () => {
    registry.setSettingsResolver(commandId =>
      commandId === 'view.toggleTerminal' ? 'Ctrl+Shift+T' : undefined
    );
    const event = {
      key: 'T',
      code: 'KeyT',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    } as unknown as KeyboardEvent;
    expect(registry.resolveKeybinding(event)).toBe('view.toggleTerminal');
  });

  it('stops resolving the old shortcut once it is rebound', () => {
    registry.setSettingsResolver(commandId =>
      commandId === 'view.toggleTerminal' ? 'Ctrl+Shift+T' : undefined
    );
    const oldEvent = {
      key: '`',
      code: 'Backquote',
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    } as unknown as KeyboardEvent;
    expect(registry.resolveKeybinding(oldEvent)).toBeNull();
  });

  it('accepts a binding for a command that has no dedicated setting', () => {
    // The advanced-settings escape hatch: `keybindings.<command id>` in JSON.
    registry.setSettingsResolver(commandId =>
      commandId === 'view.toggleSidebar' ? 'Ctrl+Alt+S' : undefined
    );
    expect(registry.getKeybinding('view.toggleSidebar')).toBe('Ctrl+Alt+S');
  });

  it('ships a default for every dedicated keybinding setting', () => {
    for (const key of Object.keys(KEYBINDING_SETTINGS)) {
      const value = settingsManager.getValue(key);
      expect(typeof value, `${key} has no string default`).toBe('string');
    }
  });
});

describe('advanced settings values', () => {
  it('keeps keys the schema does not name', () => {
    // This is the point of the JSON file: a keybinding for a command the schema
    // has never heard of must survive being written back out.
    settingsManager.applyAdvancedSettings({
      'keybindings.some.experimental.command': 'Ctrl+Alt+9',
      'editor.tabSize': 3,
    });
    const values = settingsManager.advancedSettingsValues('user');
    expect(values['keybindings.some.experimental.command']).toBe('Ctrl+Alt+9');
    expect(values['editor.tabSize']).toBe(3);
  });

  it('rejects a value of the wrong type for a key the schema does name', () => {
    settingsManager.applyAdvancedSettings({ 'editor.tabSize': 'not a number' });
    // The bad value is ignored rather than replacing a good one.
    expect(settingsManager.getValue('editor.tabSize')).not.toBe('not a number');
  });
});

describe('terminal path display', () => {
  // The panel prints the working directory the way a prompt does, so the header
  // stays short no matter how deep in the user's profile the project sits.
  it('abbreviates the home directory to a tilde', () => {
    expect(displayPath('C:\\Users\\Yinji', 'C:\\Users\\Yinji')).toBe('~');
    expect(displayPath('C:\\Users\\Yinji\\Documents\\paper', 'C:\\Users\\Yinji')).toBe('~\\Documents\\paper');
  });

  it('leaves a path outside the home directory alone', () => {
    expect(displayPath('D:\\Projects\\Eukolia', 'C:\\Users\\Yinji')).toBe('D:\\Projects\\Eukolia');
  });

  it('leaves the path alone when the home directory is unknown', () => {
    expect(displayPath('/home/me/paper', '')).toBe('/home/me/paper');
  });
});
