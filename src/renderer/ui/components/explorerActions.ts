/**
 * Explorer actions.
 *
 * The file-explorer component must not know how files are created, renamed or
 * removed: the workspace service owns that, together with the tree refresh and
 * the event that keeps `AppState.fileTree` current (Instructions.md §40, §44).
 * This module is the seam — it imports the service singleton and returns plain
 * promise-returning functions, so `Sidebar.tsx` stays a presentational component.
 *
 * Only `reveal` and `createFile`/`createDirectory` (through the workspace
 * service) touch the preload bridge; nothing else here reaches for `window`.
 */

import type { FileNode } from '../../../shared/ipc';
import { workspaceService } from '../../services/instance';
import { joinPath } from '../../services/workspace';

export interface ExplorerActions {
  /** Creates a file (relative to the workspace root or to `directory`). */
  createFile(name: string, directory?: string): Promise<string>;
  /** Creates a directory (relative to the workspace root or to `directory`). */
  createFolder(name: string, directory?: string): Promise<string>;
  /** Renames an entry in place; `newName` is a single path segment. */
  rename(target: string, newName: string): Promise<string>;
  /** Copies `target` next to itself with a `-copy` suffix. */
  duplicate(target: string): Promise<string>;
  /** Deletes an entry, to the recycle bin by default. */
  remove(target: string, useTrash?: boolean): Promise<void>;
  /** Moves an entry to a target directory. */
  move(source: string, targetDirectory: string): Promise<string>;
  /** Imports an external file into a target directory. */
  importFile(source: string, targetDirectory: string): Promise<string>;
  /** Copies the absolute path to the clipboard; resolves with the path. */
  copyPath(target: string): Promise<string>;
  /** Shows the entry in the operating system's file manager. */
  reveal(target: string): Promise<void>;
  /** Re-reads the workspace tree from disk. */
  refresh(): Promise<FileNode[]>;
}

/** Windows-reserved device names, which cannot be used as file names. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Characters Windows rejects in a path segment. */
const INVALID_CHARACTERS = /[<>:"|?*\u0000-\u001f]/;
/** `.` and `..` are navigation, never names. */
const RELATIVE_SEGMENTS = /(^|[\\/])\.\.?([\\/]|$)/;

export interface ValidateNameOptions {
  /** Allow a workspace-relative path such as `sections/intro.tex`. */
  allowPath?: boolean;
}

/**
 * Validates a name typed into the explorer. Returns `null` when acceptable, or a
 * short reason the user can act on. Kept pure so it can be unit-tested and so the
 * inline input can show the reason before the user commits.
 */
export function validateExplorerName(name: string, options: ValidateNameOptions = {}): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name';
  if (RELATIVE_SEGMENTS.test(trimmed)) return 'Names cannot contain "." or ".."';
  if (!options.allowPath && /[\\/]/.test(trimmed)) return 'A name cannot contain a path separator';

  const segments = trimmed.split(/[\\/]/);
  for (const segment of segments) {
    if (!segment) return 'Empty path segment';
    if (INVALID_CHARACTERS.test(segment)) return 'A name cannot contain < > : " | ? *';
    if (/[. ]$/.test(segment)) return 'A name cannot end with a dot or a space';
    if (RESERVED_NAMES.test(segment)) return `"${segment}" is a reserved name`;
  }
  return null;
}

/** Resolves a typed name against a directory, normalising separators. */
export function resolveExplorerTarget(directory: string, name: string): string {
  return joinPath(directory, name.trim());
}

/** Writes text to the clipboard, with a fallback for environments without the async API. */
async function writeClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', 'true');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(area);
  if (!copied) throw new Error('The clipboard is not available');
}

export function createExplorerActions(): ExplorerActions {
  return {
    async createFile(name, directory) {
      if (!workspaceService.getWorkspacePath()) throw new Error('No folder is open');
      const trimmed = name.trim();
      const withExt = trimmed.includes('.') ? trimmed : `${trimmed}.tex`;
      return workspaceService.createFile(directory ? resolveExplorerTarget(directory, withExt) : withExt);
    },

    async createFolder(name, directory) {
      if (!workspaceService.getWorkspacePath()) throw new Error('No folder is open');
      return workspaceService.createFolder(directory ? resolveExplorerTarget(directory, name) : name.trim());
    },

    async rename(target, newName) {
      return workspaceService.rename(target, newName.trim());
    },

    async duplicate(target) {
      return workspaceService.duplicate(target);
    },

    async remove(target, useTrash = true) {
      await workspaceService.delete(target, useTrash);
    },

    async move(source, targetDirectory) {
      return workspaceService.move(source, targetDirectory);
    },

    async importFile(source, targetDirectory) {
      return workspaceService.importFile(source, targetDirectory);
    },

    async copyPath(target) {
      await writeClipboard(target);
      return target;
    },

    async reveal(target) {
      const api = window.eukoliaApi;
      if (!api) throw new Error('The desktop bridge is unavailable');
      await api.revealInExplorer(target);
    },

    async refresh() {
      return workspaceService.refreshTree();
    }
  };
}
