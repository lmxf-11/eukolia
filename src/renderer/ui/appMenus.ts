/**
 * The application's menus, as *data*.
 *
 * A menu is a name and the command *categories* that fill it — never a second
 * command list. `commandsForMenu` gathers the registry's own commands for those
 * categories, so a command registered once appears in the menu, the palette and
 * the shortcut editor together, and a menu cannot drift out of step with the
 * palette because it has nothing of its own to drift.
 *
 * ## Where a menu is drawn, and why this file holds no components
 *
 * The window is frameless, and since the menu strip was removed from it the menus
 * have exactly two surfaces:
 *
 *   • the sidebar's **Menu** view (`ui/components/Sidebar.tsx`), which is one
 *     collapsible section per menu below — the pointer route, reached from the
 *     activity bar's top entry, the tab bar's leading Menu control and
 *     `view.menu`;
 *   • the **command palette** (`Ctrl+Shift+P`), which searches the same registry
 *     without going through a menu at all.
 *
 * Both read the structures here, which is why they live in their own module
 * rather than beside whichever component happens to draw them first: a
 * definition that outlives its surface cannot be deleted along with a component.
 * It was `ui/components/TitleBar.tsx` before the menu strip went away, and the
 * Menu view imported it from there — so removing the strip would have removed
 * the menus with it.
 */

import type { Command } from '../core/commands';

/** One menu, and which command categories fill it. */
export interface AppMenu {
  label: string;
  /** Categories whose commands appear in this menu, in order. */
  categories: string[];
  /** Command ids pinned to the top of the menu, before the category lists. */
  pinned?: string[];
}

/**
 * The menu structure.
 *
 * It mirrors VS Code's — File, Edit, Selection, View, Go, Run, Terminal, Help —
 * but is built from Eukolia's command *categories* rather than from a second
 * command list.
 */
export const APP_MENUS: readonly AppMenu[] = [
  { label: 'File', categories: ['File'], pinned: ['file.newProject', 'file.projectLibrary', 'file.newFile', 'file.openFolder', 'workbench.quickOpen'] },
  { label: 'Edit', categories: ['Edit'] },
  { label: 'Selection', categories: ['Selection'] },
  { label: 'View', categories: ['View', 'Appearance'] },
  { label: 'Go', categories: ['Navigate'] },
  { label: 'Run', categories: ['LaTeX'] },
  { label: 'Terminal', categories: ['Terminal'], pinned: ['view.toggleTerminal'] },
  { label: 'Help', categories: ['Help', 'Preferences'] }
];

/**
 * The commands a menu shows: its pinned entries first, then its categories.
 *
 * A pin naming a command that is not registered is skipped rather than rendered
 * as an empty row — the menus are declared statically and commands register
 * dynamically, so "not there yet" is an ordinary state.
 */
export function commandsForMenu(
  menu: AppMenu,
  available: readonly Command[]
): Command[] {
  const pinned = (menu.pinned ?? [])
    .map((id) => available.find((command) => command.id === id))
    .filter((command): command is Command => Boolean(command));

  const fromCategories = available.filter(
    (command) => menu.categories.includes(command.category) && !(menu.pinned ?? []).includes(command.id)
  );

  return [...pinned, ...fromCategories];
}
