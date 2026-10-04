/**
 * The commands behind the tab bar's toolbar.
 *
 * The toolbar is only a set of buttons; what it *means* is the command list in
 * `ui/App.tsx`, and that list is not importable on its own — it is registered
 * from a hook inside `AppShell`, which pulls in the editor, the PDF worker and
 * everything else. So the list is read as *source*, which is the same technique
 * `tests/pdf/engineErrorHandling.test.ts` uses on the native engine: a static
 * reading is the only way to check a declaration that cannot be executed in
 * isolation, and a duplicate shortcut is precisely the kind of defect that no
 * amount of executing one command can reveal.
 *
 * Three things this file pins, all of which the toolbar depends on:
 *
 *   1. every command the toolbar names exists, in the category the menus gather;
 *   2. no two commands are registered on the same key, except the one pair that
 *      is deliberately one gesture (`view.focusMode` / `view.toggleFocusMode`);
 *   3. the chrome toggles have both a command and a `keybindings.*` setting, so
 *      the Settings UI and the keyboard cannot disagree.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandRegistry, translateKeybinding } from '@/core/commands';
import { KEYBINDING_SETTINGS, SETTINGS_SCHEMA } from '@/core/settings';

const appSource = readFileSync(path.join(process.cwd(), 'src/renderer/ui/App.tsx'), 'utf8');

interface RegisteredCommand {
  id: string;
  title: string;
  category: string;
  keybinding?: string;
}

/**
 * Every command object literal in App.tsx.
 *
 * A command's *span* is the text from its `id:` to the next `id:` — the fields
 * follow the id inside one entry object, so the span is exactly the entry. The
 * first attempt instead scanned a fixed-size window after each id and silently
 * cut the binding off any command whose doc comment ran long, which made the
 * uniqueness assertion below pass while testing almost nothing.
 */
function registeredCommands(): RegisteredCommand[] {
  const starts = [...appSource.matchAll(/\bid:\s*'([^']+)'/g)];
  const commands: RegisteredCommand[] = [];

  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index];
    const from = match.index ?? 0;
    const to = index + 1 < starts.length ? (starts[index + 1].index ?? appSource.length) : appSource.length;
    const span = appSource.slice(from, to);

    const title = /title:\s*'((?:[^'\\]|\\.)*)'/.exec(span)?.[1];
    const category = /category:\s*'([^']+)'/.exec(span)?.[1];
    const keybinding = /keybinding:\s*'([^']+)'/.exec(span)?.[1];
    if (title && category) {
      commands.push({ id: match[1], title: title.replace(/\\'/g, "'"), category, keybinding });
    }
  }
  return commands;
}

const commands = registeredCommands();

describe('the command list the toolbar names', () => {
  it('reads the application’s commands out of App.tsx', () => {
    // A guard on the reader itself: a regex that matched nothing would make
    // every assertion below vacuously true.
    expect(commands.length).toBeGreaterThan(50);
    // Every command entry states a binding, so a span that lost one is a reader
    // defect rather than a command without a shortcut.
    const withBindings = commands.filter((command) => command.keybinding);
    expect(withBindings.length).toBeGreaterThan(35);
    expect(withBindings.map((command) => command.id)).toContain('view.toggleActivityBar');
    expect(withBindings.map((command) => command.id)).toContain('latex.build');
  });

  it('registers the commands the toolbar dispatches', () => {
    const ids = new Set(commands.map((command) => command.id));
    for (const id of [
      'latex.build',
      'latex.buildAndView',
      'latex.buildWithRecipe',
      'latex.stopBuild',
      'pdf.toggleViewer',
      'editor.codeMode',
      'editor.visualMode',
      'editor.toggleMode',
      'view.focusMode',
      'file.newFile'
    ]) {
      expect(ids, `${id} is not registered`).toContain(id);
    }
  });

  it('files the new commands under View, so the View menu shows them', () => {
    // `APP_MENUS` gathers the View category, so a command in any other
    // category would be in the palette but in no menu.
    const command = commands.find((entry) => entry.id === 'view.focusMode');
    expect(command?.category, 'view.focusMode is not in the View category').toBe('View');
  });

  it('keeps Focus Mode to one command, so one key reaches it', () => {
    /*
     * The first version of this registered two: `view.focusMode` to enter and a
     * `view.toggleFocusMode` to leave, sharing `Ctrl+Alt+1`. The registry keeps a
     * *list* per binding and resolves it to the first command whose `when` clause
     * passes, so the second was unreachable from the keyboard while still
     * appearing in the shortcut editor — and the tab bar's button, which
     * dispatched the toggle, reported a state the key could not produce. The
     * end-to-end probe caught it; this stops it coming back.
     */
    expect(commands.filter((command) => command.id === 'view.toggleFocusMode')).toHaveLength(0);
    const focus = commands.find((command) => command.id === 'view.focusMode');
    expect(focus?.title).toContain('Toggle');
    /*
     * Read through the *live* state view, which is what the handler must call.
     *
     * The command list is registered once and its reads go through `liveState` (a
     * ref-backed view), because re-registering and re-indexing all eighty commands
     * whenever the application state changed cost about 5.4 ms of every keystroke —
     * measured, see `useApplicationCommands` in `App.tsx`. An earlier version of this
     * string was `state.toggleFocusMode()`, which is now the bug rather than the
     * expectation: a handler closing over the state it was built with would act on a
     * stale one, and `Save` would write yesterday's text.
     */
    expect(appSource).toContain('handler: () => liveState.toggleFocusMode()');
  });

  it('registers the command list once, and reads state through the live view', () => {
    /*
     * The property is two halves that only work together, which is why they are one
     * test: `[]` without `liveState` freezes every handler on the state the shell
     * mounted with, and `liveState` without `[]` pays the re-registration again.
     *
     * The cost it removes, measured by CPU-profiling forty keystrokes in an 1 877-line
     * Stacks chapter (`scripts/probe-typing-profile.mjs`): `reindexKeybindings` 179 ms,
     * `getValue` 159 ms, `register` 92 ms, `unregister` 50 ms — roughly 5.4 ms per
     * keystroke spent tearing down and rebuilding a keybinding table that had not
     * changed. Reporting the caret writes application state on every keystroke, so the
     * effect's `[state]` dependency made that happen on every keystroke.
     */
    expect(appSource).toContain('}, []);');
    expect(
      appSource.includes("handler: () => liveState."),
      'the command handlers must read the live state view'
    ).toBe(true);
    // And nothing in the command list may read the captured `state` directly.
    const listStart = appSource.indexOf('commandRegistry.registerAll([');
    const listEnd = appSource.indexOf('}, []);', listStart);
    expect(listStart).toBeGreaterThan(0);
    expect(listEnd).toBeGreaterThan(listStart);
    const commandList = appSource.slice(listStart, listEnd);
    const captured = commandList.match(/(^|[^\w$.])state\./g) ?? [];
    expect(
      captured,
      `the command list still reads the captured state ${captured.length} time(s)`
    ).toHaveLength(0);
  });

  it('gives Focus Mode a shortcut and no other command that key', () => {
    const focus = commands.find((command) => command.id === 'view.focusMode');
    expect(focus?.keybinding).toBe('Ctrl+Alt+1');
    const holders = commands.filter((command) => command.keybinding === 'Ctrl+Alt+1');
    expect(holders.map((command) => command.id)).toEqual(['view.focusMode']);
  });

  it('no longer registers a menu bar at all', () => {
    /*
     * The menu strip was removed from the window, and its command went with it.
     *
     * It is asserted rather than left implicit because the failure is silent in
     * both directions: a command still registered would appear in the palette and
     * in Settings → Keyboard offering to toggle a strip that does not exist, and
     * a `Ctrl+Alt+M` binding left behind would be a key that does nothing at all.
     * The menus themselves are not gone — the sidebar's Menu view draws them from
     * `ui/appMenus.ts`, and `tests/ui/app-menus.test.ts` pins that structure.
     */
    expect(commands.filter((command) => command.id === 'view.toggleMenuBar')).toHaveLength(0);
    expect(appSource).not.toContain('view.toggleMenuBar');
    expect(KEYBINDING_SETTINGS['keybindings.toggleMenuBar']).toBeUndefined();
    expect(SETTINGS_SCHEMA.find((entry) => entry.key === 'appearance.showMenuBar')).toBeUndefined();
  });

  it('pins the one shared key the application already had, and what wins it', () => {
    /*
     * `Ctrl+B` is both "toggle the side bar" (VS Code's binding, and the one
     * this application's status bar, title bar and documentation all state) and
     * "build the project" (the LaTeX convention, stated by the tab bar's new
     * Compile button).
     *
     * That collision predates this toolbar, and it is not resolved here because
     * either rebind would break a key its own users already know — the honest
     * reading is that the *sidebar* wins, because `view.toggleSidebar` is
     * registered before `latex.build` and the registry resolves first-match.
     * `Ctrl+Alt+B` is the same story between "toggle the status bar" and "Build
     * and View", and the status bar wins it.
     *
     * The test states the collisions and their winners rather than asserting
     * there are none: if a later change flips the order — the whole list is one
     * literal, so removing a command above these is enough — the keyboard would
     * silently start doing something else, and this is what notices.
     */
    const byBinding = new Map<string, string[]>();
    for (const command of commands) {
      if (!command.keybinding) continue;
      byBinding.set(command.keybinding, [...(byBinding.get(command.keybinding) ?? []), command.id]);
    }

    const shared = [...byBinding.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([binding, ids]) => `${binding}: ${ids.join(', ')}`)
      .sort();

    // Focus Mode is deliberately *absent* from this list: it is one command on
    // one key, which is what this file now enforces.
    expect(shared).toEqual([
      'Ctrl+Alt+B: view.toggleStatusBar, latex.buildAndView',
      'Ctrl+B: view.toggleSidebar, latex.build'
    ]);
  });

  it('gives the toolbar’s own shortcuts no competition at all', () => {
    // The keys the toolbar's tooltips state, minus the two pairs above: each is
    // held by exactly one command, so every control's stated shortcut does what
    // it says.
    const byBinding = new Map<string, string[]>();
    for (const command of commands) {
      if (!command.keybinding) continue;
      byBinding.set(command.keybinding, [...(byBinding.get(command.keybinding) ?? []), command.id]);
    }
    for (const binding of ['Ctrl+Alt+1', 'Ctrl+Shift+V', 'Ctrl+1', 'Ctrl+2', 'Ctrl+Alt+V', 'Ctrl+Shift+B']) {
      expect(byBinding.get(binding), binding).toHaveLength(1);
    }
  });

  it('leaves the shortcuts the tab bar already advertised alone', () => {
    // The toolbar states these in its tooltips, and a user who has learnt them
    // should not find that the toolbar renamed them.
    const expected: Record<string, string> = {
      'latex.build': 'Ctrl+B',
      'latex.buildAndView': 'Ctrl+Alt+B',
      'latex.buildWithRecipe': 'Ctrl+Shift+B',
      'pdf.toggleViewer': 'Ctrl+Alt+V',
      'editor.codeMode': 'Ctrl+1',
      'editor.visualMode': 'Ctrl+2',
      'editor.toggleMode': 'Ctrl+Shift+V',
      'view.toggleTabBar': 'Ctrl+Alt+T',
      'view.toggleStatusBar': 'Ctrl+Alt+B',
      'view.toggleActivityBar': 'Ctrl+Alt+A'
    };
    for (const [id, binding] of Object.entries(expected)) {
      expect(commands.find((command) => command.id === id)?.keybinding, id).toBe(binding);
    }
  });
});

describe('the chrome toggles are settings as well as commands', () => {
  it('has a keybindings setting for focus mode', () => {
    expect(KEYBINDING_SETTINGS['keybindings.toggleFocusMode']).toBe('view.focusMode');
  });

  it('states the same default in the setting as in the command', () => {
    // The registry prefers the setting, so a disagreement would silently move the
    // key rather than produce a conflict.
    const defaults = new Map(SETTINGS_SCHEMA.map((entry) => [entry.key, entry.default]));
    expect(defaults.get('keybindings.toggleFocusMode')).toBe('Ctrl+Alt+1');
  });

  it('gives the chrome that can hide itself a setting, and the tab bar only one', () => {
    /*
     * The rule is VS Code's and it is about a way back: a piece of chrome with a
     * command that hides it needs a persisted preference behind the command, or
     * the Settings UI and the keyboard disagree.
     *
     * Tab-bar visibility is session state, controlled by its command and the
     * status-bar button, rather than a persisted appearance setting.
     */
    for (const key of ['appearance.showStatusBar', 'appearance.showActivityBar']) {
      const descriptor = SETTINGS_SCHEMA.find((entry) => entry.key === key);
      expect(descriptor, `${key} is missing`).toBeTruthy();
      expect(descriptor?.type).toBe('boolean');
      expect(descriptor?.category).toBe('Appearance');
    }
    expect(SETTINGS_SCHEMA.find((entry) => entry.key === 'appearance.showTabBar')).toBeUndefined();
    expect(SETTINGS_SCHEMA.find((entry) => entry.key === 'appearance.showTitleBar')).toBeUndefined();
  });
});

describe('the registry a rebind goes through', () => {
  it('answers with the setting rather than the registered default', () => {
    const registry = new CommandRegistry();
    registry.register({
      id: 'view.focusMode',
      title: 'Toggle Focus Mode',
      category: 'View',
      keybinding: 'Ctrl+Alt+1',
      handler: () => undefined
    });
    expect(registry.getKeybinding('view.focusMode')).toBe('Ctrl+Alt+1');

    // Settings win, which is how Settings → Keyboard moves a key.
    registry.setSettingsResolver((id) => (id === 'view.focusMode' ? 'Ctrl+Alt+1' : undefined));
    expect(registry.getKeybinding('view.focusMode')).toBe('Ctrl+Alt+1');

    registry.setSettingsResolver((id) => (id === 'view.focusMode' ? 'Ctrl+Alt+9' : undefined));
    expect(registry.getKeybinding('view.focusMode')).toBe('Ctrl+Alt+9');

    // An empty string is "unbound" rather than "no opinion", so the toolbar's
    // tooltip has nothing to state and says nothing rather than lying.
    registry.setSettingsResolver((id) => (id === 'view.focusMode' ? '' : undefined));
    expect(registry.getKeybinding('view.focusMode')).toBe('');
  });

  it('spells a binding the way the platform does', () => {
    expect(translateKeybinding('Ctrl+Alt+M', 'win32')).toBe('Ctrl+Alt+M');
    expect(translateKeybinding('Ctrl+B', 'win32')).toBe('Ctrl+B');
    expect(translateKeybinding('Ctrl+Alt+M', 'darwin')).toBe('⌃⌥M');
    // `Meta` is written as `Cmd` in some bindings and as `Win` on Windows.
    expect(translateKeybinding('Meta+K', 'win32')).toBe('Win+K');
    // A binding that names a key rather than a letter keeps its name.
    expect(translateKeybinding('Ctrl+`', 'win32')).toBe('Ctrl+`');
  });
});
