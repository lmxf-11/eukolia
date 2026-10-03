/**
 * The workspace-scope settings file, and the directory that holds it.
 *
 * A project's settings live in `<root>/.eukolia/settings.json`, which the author
 * may commit. The directory is therefore *project content*: it is created when
 * the user saves a workspace setting, and at no other time. It used to be created
 * when the project was opened, because the watcher that keeps an external edit
 * live did `mkdirSync` first — so merely opening a folder left an empty
 * `.eukolia/` behind in every project, for a file that did not exist, and which
 * version control would then offer to commit.
 *
 * These tests drive the real module against a temporary directory, so the
 * assertion is about what is actually on disk rather than about which call was
 * made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `advancedSettings` reads the app data directory for the *user* scope. The
// module is imported for real; only Electron itself is stubbed, because these
// tests never touch the user scope.
vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'eukolia-settings-test-userdata') },
  shell: { openPath: () => Promise.resolve('') }
}));

const {
  WORKSPACE_SETTINGS_DIRECTORY,
  readSettingsFile,
  watchSettingsFile,
  writeSettingsFile,
  stopWatchingWorkspace,
  closeSettingsWatchers,
  onSettingsFileChanged
} = await import('../../src/main/settings/advancedSettings');

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eukolia-project-'));
});

afterEach(() => {
  closeSettingsWatchers();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const workspaceDirectory = () => path.join(projectRoot, WORKSPACE_SETTINGS_DIRECTORY);
const workspaceFile = () => path.join(workspaceDirectory(), 'settings.json');

describe('opening a project', () => {
  it('does not create a .eukolia directory just for watching it', () => {
    // This is what opening a project does: it installs the workspace watcher.
    // Nothing is written, so nothing should appear on disk.
    watchSettingsFile('workspace', projectRoot);

    expect(fs.existsSync(workspaceDirectory()), 'opening a project left .eukolia behind').toBe(false);
  });

  it('leaves a project that has no settings file completely untouched', () => {
    const before = fs.readdirSync(projectRoot).sort();

    watchSettingsFile('workspace', projectRoot);
    readSettingsFile('workspace', projectRoot);

    expect(fs.readdirSync(projectRoot).sort()).toEqual(before);
  });

  it('reports the settings file as absent without creating it', () => {
    const description = readSettingsFile('workspace', projectRoot);

    expect(description.exists).toBe(false);
    expect(description.path).toBe(workspaceFile());
    expect(fs.existsSync(workspaceDirectory())).toBe(false);
  });

  it('does nothing at all when no project is open', () => {
    watchSettingsFile('workspace', null);
    const description = readSettingsFile('workspace', null);
    expect(description.exists).toBe(false);
    expect(description.error).toBeTruthy();
  });
});

describe('writing a workspace setting', () => {
  it('creates the directory and the file, and only then', () => {
    expect(fs.existsSync(workspaceDirectory())).toBe(false);

    writeSettingsFile({ scope: 'workspace', values: { 'editor.fontSize': 14 } }, projectRoot);

    expect(fs.existsSync(workspaceFile())).toBe(true);
    expect(JSON.parse(fs.readFileSync(workspaceFile(), 'utf8'))).toEqual({ 'editor.fontSize': 14 });
  });

  it('round-trips through a later read', () => {
    writeSettingsFile({ scope: 'workspace', values: { 'appearance.accentColor': '#123456' } }, projectRoot);
    const description = readSettingsFile('workspace', projectRoot);
    expect(description.exists).toBe(true);
    expect(description.values).toEqual({ 'appearance.accentColor': '#123456' });
  });

  it('watches an existing directory, so an external edit is still picked up', async () => {
    // The other half of the fix: not creating the directory must not cost the
    // watch. A project that already carries `.eukolia` is watched, and a change
    // made outside the application reaches the listener.
    fs.mkdirSync(workspaceDirectory(), { recursive: true });
    fs.writeFileSync(workspaceFile(), JSON.stringify({ 'editor.fontSize': 12 }), 'utf8');

    const seen: Array<Record<string, unknown> | null> = [];
    onSettingsFileChanged((description) => seen.push(description.values));

    watchSettingsFile('workspace', projectRoot);
    // `fs.watch` reports through the event loop, so the write has to come after
    // the watcher is installed and be given a turn to be observed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(workspaceFile(), JSON.stringify({ 'editor.fontSize': 16 }), 'utf8');

    const deadline = Date.now() + 3000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    onSettingsFileChanged(null);

    expect(seen.length, 'an external edit was not reported').toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual({ 'editor.fontSize': 16 });
  });
});

describe('switching projects', () => {
  it("stops watching the previous project's file and leaves both on disk", () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), 'eukolia-project-a-'));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'eukolia-project-b-'));
    try {
      writeSettingsFile({ scope: 'workspace', values: {} }, first);
      writeSettingsFile({ scope: 'workspace', values: {} }, second);

      // Reopening must not throw, and must not delete the project's own file —
      // the watcher is what is torn down, not the settings.
      expect(() => stopWatchingWorkspace()).not.toThrow();
      expect(fs.existsSync(path.join(first, WORKSPACE_SETTINGS_DIRECTORY, 'settings.json'))).toBe(true);
      expect(fs.existsSync(path.join(second, WORKSPACE_SETTINGS_DIRECTORY, 'settings.json'))).toBe(true);

      watchSettingsFile('workspace', second);
      expect(fs.existsSync(path.join(first, WORKSPACE_SETTINGS_DIRECTORY))).toBe(true);
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  });
});
