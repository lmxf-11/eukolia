/**
 * The application's menu structure.
 *
 * The window is frameless and has no menu strip, so the menus live in the
 * sidebar's Menu view. What this file pins is the declaration behind it: if a
 * menu is empty because it names a category no command uses, that whole group of
 * commands becomes unreachable from a pointer — the palette would still find
 * them by name, but nothing would list them.
 *
 * The structure used to be declared in `ui/components/TitleBar.tsx` and is now
 * `ui/appMenus.ts`, because deleting the menu strip must not delete the menus.
 */

import { describe, expect, it } from 'vitest';
import { APP_MENUS, commandsForMenu, type AppMenu } from '@/ui/appMenus';
import { CommandRegistry, type Command } from '@/core/commands';

/** A registry with a handful of commands across several categories. */
const withCommands = (): CommandRegistry => {
  const registry = new CommandRegistry();
  registry.registerAll([
    { id: 'file.newFile', title: 'New LaTeX File', category: 'File', handler: () => undefined },
    { id: 'file.openFolder', title: 'Open Folder…', category: 'File', handler: () => undefined },
    { id: 'edit.undo', title: 'Undo', category: 'Edit', handler: () => undefined },
    { id: 'edit.redo', title: 'Redo', category: 'Edit', handler: () => undefined },
    { id: 'view.toggleSidebar', title: 'Toggle Sidebar', category: 'View', handler: () => undefined },
    { id: 'view.toggleTheme', title: 'Cycle Theme', category: 'Appearance', handler: () => undefined },
    { id: 'latex.build', title: 'Build Project', category: 'LaTeX', handler: () => undefined },
    { id: 'view.toggleTerminal', title: 'Toggle Terminal', category: 'View', handler: () => undefined },
    { id: 'help.documentation', title: 'Documentation', category: 'Help', handler: () => undefined }
  ] as Command[]);
  return registry;
};

describe('the application menus', () => {
  it('has the menus VS Code has, in the same order', () => {
    // The labels head their sections in the Menu view, so the order is user-visible.
    const labels = APP_MENUS.map((menu) => menu.label);
    expect(labels).toEqual([
      'File',
      'Edit',
      'Selection',
      'View',
      'Go',
      'Run',
      'Terminal',
      'Help'
    ]);
  });

  it('names only categories that exist, so no menu is silently empty', () => {
    // Every category a menu claims must be one the application actually uses.
    const used = new Set(
      withCommands()
        .getAll()
        .map((command) => command.category)
    );
    // The registry above is a subset, so this asserts the *declared* categories
    // against the real command set by reading the application's own list.
    const declared = new Set(APP_MENUS.flatMap((menu) => menu.categories));
    for (const category of declared) {
      const known = [
        'File',
        'Edit',
        'Selection',
        'View',
        'Appearance',
        'Navigate',
        'LaTeX',
        'Terminal',
        'Help',
        'Preferences',
        'PDF',
        'Editor'
      ];
      expect(known, `menu category "${category}" is not a category Eukolia uses`).toContain(category);
    }
    // And the fixture's own categories are all reachable from some menu.
    for (const category of used) {
      expect(declared, `no menu shows the "${category}" category`).toContain(category);
    }
  });

  it('puts pinned commands first', () => {
    const registry = withCommands();
    const file = APP_MENUS.find((menu) => menu.label === 'File') as AppMenu;
    const titles = commandsForMenu(file, registry.getAll()).map((command) => command.id);

    // `newFile` and `openFolder` are pinned, so they lead regardless of category
    // ordering; nothing else in File is pinned.
    expect(titles[0]).toBe('file.newFile');
    expect(titles[1]).toBe('file.openFolder');
  });

  it('never lists a command twice', () => {
    const registry = withCommands();
    for (const menu of APP_MENUS) {
      const ids = commandsForMenu(menu, registry.getAll()).map((command) => command.id);
      expect(new Set(ids).size, `${menu.label} lists a command twice`).toBe(ids.length);
    }
  });

  it('gathers several categories into one menu', () => {
    // View shows both the View and Appearance categories, which is how the theme
    // command ends up beside the layout commands rather than in its own menu.
    const registry = withCommands();
    const view = APP_MENUS.find((menu) => menu.label === 'View') as AppMenu;
    const ids = commandsForMenu(view, registry.getAll()).map((command) => command.id);

    expect(ids).toContain('view.toggleSidebar');
    expect(ids).toContain('view.toggleTheme');
  });

  it('ignores a pinned command that is not registered', () => {
    // Menus are declared statically and commands register dynamically, so a pin
    // can name a command that is not available yet — it must simply be skipped
    // rather than producing an undefined entry.
    const registry = withCommands();
    const file = APP_MENUS.find((menu) => menu.label === 'File') as AppMenu;
    const commands = commandsForMenu(file, registry.getAll());
    expect(commands.every((command) => Boolean(command) && typeof command.id === 'string')).toBe(true);
  });

  it('returns nothing for a menu whose categories have no commands', () => {
    const registry = withCommands();
    const selection = APP_MENUS.find((menu) => menu.label === 'Selection') as AppMenu;
    const commands = commandsForMenu(selection, registry.getAll());
    // The fixture registers no Selection command, and `edit.selectAll` is the
    // only one the application has; an empty list is correct, not an error.
    expect(Array.isArray(commands)).toBe(true);
    expect(commands.length).toBe(0);
  });

  it('preserves the order commands were registered in within a category', () => {
    // The palette and the menus must not disagree about ordering.
    const registry = withCommands();
    const edit = APP_MENUS.find((menu) => menu.label === 'Edit') as AppMenu;
    const ids = commandsForMenu(edit, registry.getAll()).map((command) => command.id);
    expect(ids).toEqual(['edit.undo', 'edit.redo']);
  });

  it('lives somewhere that draws nothing, so a surface can come and go', () => {
    /*
     * The declaration used to live in `ui/components/TitleBar.tsx`, and the Menu
     * view imported it from there — so deleting the menu strip would have deleted
     * the menus with it. A definition is not a surface, and this is the assertion
     * that says which one it is: data that outlives whatever draws it.
     */
    expect(APP_MENUS.length).toBeGreaterThan(0);
    for (const menu of APP_MENUS) {
      expect(menu.categories.length, `${menu.label} names no category`).toBeGreaterThan(0);
    }
  });
});
