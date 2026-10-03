/**
 * Eukolia — the command catalogue relay.
 *
 * Commands are registered by the **app shell**, which is the window that has an
 * editor to edit, a build service to drive and a PDF viewer to scroll. The
 * Settings window is a separate renderer: it shares no memory with the shell, so
 * its `commandRegistry` is empty. The keyboard-shortcut editor reads its rows
 * from that registry, which is why it used to render "No shortcuts match" for a
 * list nobody had filtered — it was being handed no rows at all.
 *
 * So the shell announces its catalogue and the main process holds it:
 *
 *   shell  --publish-->  main  --changed-->  every settings window
 *   settings window  --catalog-->  main  (to read it on open)
 *
 * ## Why the main process holds it rather than the shell answering
 *
 * The Settings window can open *before* the shell has registered anything, and
 * can outlive a shell that is still starting. A relay with a last-known value
 * answers both cases with one rule: whoever asks gets the most recent catalogue,
 * and whoever is listening gets every later one. The alternative — the Settings
 * window asking the shell directly — needs the two to find each other and to
 * agree on what happens when the answer is "not yet".
 *
 * ## What a settings window is allowed to do
 *
 * Nothing but read. `publish` is accepted from a window that is *not* an
 * auxiliary window, so a Settings window cannot overwrite the catalogue it was
 * given, and the relay never echoes a catalogue back to its own sender.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC, type CommandCatalogEntry } from '../../shared/ipc';

/** True for a window loaded with `?window=settings` or `?window=snippets`. */
function isAuxiliarySender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? event.sender.getURL();
  try {
    return Boolean(new URL(url).searchParams.get('window'));
  } catch {
    return false;
  }
}

export function registerCommandCatalogHandlers(): void {
  ipcMain.handle(IPC.commands.publish, (event, entries: CommandCatalogEntry[]): void => {
    // Only the shell owns the catalogue; an auxiliary window that published one
    // would be overwriting the thing it is displaying.
    if (isAuxiliarySender(event)) return;
    publishCommandCatalog(Array.isArray(entries) ? entries : []);
  });

  ipcMain.handle(IPC.commands.catalog, (): CommandCatalogEntry[] | null => commandCatalog);
}

/**
 * The catalogue as last published, or `null` before the shell has started.
 *
 * `null` and `[]` are different answers and the editor distinguishes them: no
 * catalogue yet means "the shell is still starting, ask again", while an empty
 * one means the application genuinely has no commands to offer.
 */
let commandCatalog: CommandCatalogEntry[] | null = null;

/** Announces a catalogue to every auxiliary window, and remembers it. */
export function publishCommandCatalog(entries: CommandCatalogEntry[]): void {
  commandCatalog = entries;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(IPC.commands.changed, entries);
  }
}

/** The remembered catalogue, for a newly opened window to read on mount. */
export function currentCommandCatalog(): CommandCatalogEntry[] | null {
  return commandCatalog;
}

/** Pushes the remembered catalogue to one window, if there is one to push. */
export function sendCommandCatalog(window: BrowserWindow): void {
  if (commandCatalog === null || window.isDestroyed()) return;
  window.webContents.send(IPC.commands.changed, commandCatalog);
}

/** Test seam: forgets the published catalogue. */
export function resetCommandCatalog(): void {
  commandCatalog = null;
}
