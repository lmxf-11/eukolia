import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipc';
import {
  describeLibrary,
  initializeLibrary,
  createLibraryProject,
  libraryUserDirectory,
} from './projectLibrary';
import {
  userSnippetsPath,
  ensureUserSnippetsDirectory,
} from '../snippets/store';

export function registerLibraryHandlers(): void {
  const appData = () => app.getPath('userData');
  ipcMain.handle(IPC.library.describe, () => describeLibrary(appData()));
  ipcMain.handle(IPC.library.choose, async (event) => {
    // Changing a live library would race existing settings writes and file watchers.
    // The setup screen runs before services; a healthy existing library is retained.
    const current = describeLibrary(appData());
    if (current.root) return current;
    const options: Electron.OpenDialogOptions = {
      title: 'Choose or create your Eukolia project library',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current.configuredRoot ?? app.getPath('documents'),
    };
    const window = BrowserWindow.fromWebContents(event.sender);
    const selection = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (selection.canceled || !selection.filePaths[0]) return null;
    let legacy: string | undefined;
    try {
      legacy = userSnippetsPath();
    } catch {
      /* Damaged bootstrap location can be repaired by setup. */
    }
    const result = initializeLibrary(appData(), selection.filePaths[0], legacy);
    ensureUserSnippetsDirectory();
    return result;
  });
  ipcMain.handle(IPC.library.create, (_event, request) =>
    createLibraryProject(appData(), request),
  );
  ipcMain.handle(IPC.library.openShared, async () => {
    const directory = libraryUserDirectory(appData());
    if (!directory) throw new Error('Choose a project library first.');
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
}
