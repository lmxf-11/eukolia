/**
 * Eukolia — the Settings window's view of the command catalogue.
 *
 * The shell registers the commands; this window lists them. `IPC.commands`
 * carries a derived catalogue between the two (`{id, title, category, binding,
 * hidden}` and never a handler), and this is the half that turns one back into
 * registry entries the keyboard-shortcut editor can draw.
 *
 * ## Why the entries are real registrations
 *
 * `ShortcutEditor` reads `commandRegistry.getAll()` and edits through
 * `setKeybinding`, so the catalogue has to *be* in the registry for the editor to
 * work at all. Each entry is therefore registered with a handler that explains
 * itself rather than one that does nothing: a command cannot be run from this
 * window — it has no editor, no build service and no project — and a handler that
 * silently succeeded would be a lie the first time somebody wired a button to it.
 *
 * Rebinding still works, and that is not an accident of this design: a shortcut
 * is a *setting* (`keybindings.*`), the settings manager is shared through
 * `settingsBridge`, and the shell resolves its bindings from the same settings.
 * Editing a binding here writes the setting; the shell reads it.
 */

import { commandRegistry, type Command, type CommandCatalogEntry } from './commands';

/** True for the windows that consume the catalogue rather than publishing it. */
function isAuxiliaryWindow(): boolean {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).get('window')) return true;
  const hash = window.location.hash.replace(/^#/, '');
  return hash === 'settings' || hash === 'snippets';
}

/**
 * Installs the catalogue as registry entries, and keeps it installed.
 *
 * Returns its own teardown. Calling it twice is safe: each catalogue replaces the
 * entries the previous one added, identified by id, so a republish is an update
 * rather than a duplicate — `register` warns loudly about a double registration
 * and that warning would be noise if this fired on every keybinding change.
 */
export function installCommandCatalog(): () => void {
  // The shell owns the catalogue. In that window the registry is already full of
  // the real commands, and registering stubs over them would replace working
  // handlers with ones that cannot run.
  if (!isAuxiliaryWindow()) return () => undefined;

  const api = window.eukoliaApi;
  if (!api?.getCommandCatalog) return () => undefined;

  const installed = new Set<string>();
  const disposers = new Map<string, () => void>();

  const adopt = (entries: readonly CommandCatalogEntry[] | null) => {
    if (!entries) return;

    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry?.id || seen.has(entry.id)) continue;
      seen.add(entry.id);

      // Re-registering the same id would trip the registry's double-registration
      // warning, so a command that is already installed is left as it is: its
      // title and binding come from the catalogue only when it is new, and both
      // are re-read live from the registry on every render anyway.
      if (installed.has(entry.id)) continue;

      const command: Command = {
        id: entry.id,
        title: entry.title,
        category: entry.category,
        keybinding: entry.binding,
        hidden: entry.hidden,
        handler: () => {
          console.warn(
            `[eukolia] "${entry.id}" was invoked from a Settings window; commands run in the main window`
          );
        }
      };
      disposers.set(entry.id, commandRegistry.register(command));
      installed.add(entry.id);
    }

    // A command the shell has since removed goes with it, so the editor cannot
    // offer a binding for something that no longer exists.
    for (const id of [...installed]) {
      if (seen.has(id)) continue;
      disposers.get(id)?.();
      disposers.delete(id);
      installed.delete(id);
    }
  };

  /*
   * Two ways in, and both are needed.
   *
   * The *read* covers the ordinary case: the shell started first, so its
   * catalogue is already being held by the main process and this window can have
   * it on its first frame. The *subscription* covers the other one: the Settings
   * window can open while the shell is still registering, and a window that only
   * read would show an empty list until it was reopened.
   */
  void api.getCommandCatalog().then(adopt).catch(() => undefined);
  const unsubscribe = api.onCommandCatalog?.(adopt);

  return () => {
    unsubscribe?.();
    for (const dispose of disposers.values()) dispose();
    disposers.clear();
    installed.clear();
  };
}
