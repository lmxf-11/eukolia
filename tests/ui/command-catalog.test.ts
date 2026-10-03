// @vitest-environment jsdom
/**
 * The Settings window's half of the command catalogue.
 *
 * `ShortcutEditor` builds its rows from `commandRegistry.getAll()`, and in the
 * Settings window that registry is empty — the commands belong to the app shell,
 * a different renderer. This is the piece that fills it, and what it has to get
 * right is narrow but easy to get wrong in three ways:
 *
 *   • the shell must not adopt its own catalogue as stubs, or a window that can
 *     already save a file would have its Save button replaced by one that cannot;
 *   • a republish must be an update, not a second registration, because the
 *     registry warns loudly about a double registration and that warning would
 *     fire on every keybinding change;
 *   • a command the shell has since dropped must be dropped here too, or the
 *     editor offers a binding for something that no longer exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandRegistry } from '@/core/commands';
import { installCommandCatalog } from '@/core/commandCatalog';

/** What the bridge hands out, and what it lets a test push. */
let catalog: unknown = null;
let push: ((entries: unknown) => void) | null = null;

function setLocation(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

beforeEach(() => {
  catalog = null;
  push = null;
  (window as unknown as { eukoliaApi: unknown }).eukoliaApi = {
    getCommandCatalog: vi.fn(async () => catalog),
    onCommandCatalog: (callback: (entries: unknown) => void) => {
      push = callback;
      return () => {
        push = null;
      };
    }
  };
  setLocation('?window=settings');
});

afterEach(() => {
  for (const command of commandRegistry.getAll()) commandRegistry.unregister(command.id);
  setLocation('');
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('installing the catalogue', () => {
  it('registers the shell\'s commands so the editor has rows to draw', async () => {
    catalog = [
      { id: 'file.save', title: 'Save', category: 'File', binding: 'Ctrl+S' },
      { id: 'latex.build', title: 'Build Project', category: 'LaTeX' }
    ];

    installCommandCatalog();
    await settle();

    expect(commandRegistry.getAll().map((command) => command.id).sort()).toEqual([
      'file.save',
      'latex.build'
    ]);
    expect(commandRegistry.get('file.save')?.title).toBe('Save');
    // The catalogue's `binding` is the command's *declared* default, so a
    // command the shell declared without one arrives without one — the editor
    // draws it as `unbound` rather than inventing a key.
    expect(commandRegistry.get('latex.build')?.keybinding).toBeUndefined();
  });

  it('adopts a catalogue published after the window opened', async () => {
    installCommandCatalog();
    await settle();
    expect(commandRegistry.getAll()).toHaveLength(0);

    // The Settings window can open while the shell is still registering, which
    // is why the read is not the only way in.
    push?.([{ id: 'file.openFile', title: 'Open File…', category: 'File' }]);
    await settle();

    expect(commandRegistry.get('file.openFile')?.title).toBe('Open File…');
  });

  it('updates rather than re-registering when the catalogue is republished', async () => {
    catalog = [{ id: 'file.save', title: 'Save', category: 'File' }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    installCommandCatalog();
    await settle();
    push?.([{ id: 'file.save', title: 'Save', category: 'File' }]);
    await settle();

    expect(commandRegistry.getAll()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops a command the shell no longer declares', async () => {
    catalog = [
      { id: 'file.save', title: 'Save', category: 'File' },
      { id: 'latex.build', title: 'Build Project', category: 'LaTeX' }
    ];

    installCommandCatalog();
    await settle();
    expect(commandRegistry.getAll()).toHaveLength(2);

    push?.([{ id: 'file.save', title: 'Save', category: 'File' }]);
    await settle();

    expect(commandRegistry.getAll().map((command) => command.id)).toEqual(['file.save']);
  });

  it('will not run a command that belongs to the shell', async () => {
    catalog = [{ id: 'file.save', title: 'Save', category: 'File' }];
    installCommandCatalog();
    await settle();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await commandRegistry.execute('file.save');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('leaves the shell\'s own registry alone', async () => {
    setLocation('');
    catalog = [{ id: 'file.save', title: 'Save', category: 'File' }];

    installCommandCatalog();
    await settle();

    // In the shell the registry is already full of the real commands; adopting
    // the catalogue there would replace working handlers with inert ones.
    expect(commandRegistry.getAll()).toHaveLength(0);
  });

  it('removes what it installed when torn down', async () => {
    catalog = [{ id: 'file.save', title: 'Save', category: 'File' }];
    const dispose = installCommandCatalog();
    await settle();
    expect(commandRegistry.getAll()).toHaveLength(1);

    dispose();
    expect(commandRegistry.getAll()).toHaveLength(0);
  });
});
