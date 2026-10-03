/**
 * Settings and command-system tests.
 *
 * These exercise the parts of the shell the whole UI depends on: schema defaults
 * and validation, scope precedence (default < user < workspace), search, the
 * `vscode` bridge used by ported extension code, and keybinding resolution.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PROJECT_SCOPED_SETTINGS,
  SETTINGS_SCHEMA,
  canBeProjectScoped,
  defaultSettingsRecord,
  getSettingDescriptor,
  settingsManager,
  validateSettingValue
} from '../../src/renderer/core/settings';
import { commandRegistry, formatKeybinding, matchesKeybinding, parseKeybinding } from '../../src/renderer/core/commands';

// The settings manager persists to localStorage, which Node does not provide.
beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear()
    }
  });
});

describe('settings schema', () => {
  it('has a unique key for every descriptor', () => {
    const keys = SETTINGS_SCHEMA.map((descriptor) => descriptor.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every descriptor a category from the documented list', () => {
    const categories = new Set([
      'General',
      'Editor',
      'Visual Editor',
      'LaTeX',
      'Compilation',
      'PDF',
      'Snippets',
      'Formatting',
      'Files',
      'Appearance',
      'Scrolling',
      'Keyboard',
      'Advanced'
    ]);
    for (const descriptor of SETTINGS_SCHEMA) {
      expect(categories.has(descriptor.category), `${descriptor.key} has category ${descriptor.category}`).toBe(true);
    }
  });

  it('provides a default for every key', () => {
    const defaults = defaultSettingsRecord();
    for (const descriptor of SETTINGS_SCHEMA) {
      expect(defaults[descriptor.key], `missing default for ${descriptor.key}`).not.toBeUndefined();
    }
  });

  it('lists valid options for every enum', () => {
    for (const descriptor of SETTINGS_SCHEMA.filter((entry) => entry.type === 'enum')) {
      expect(descriptor.options?.length, `${descriptor.key} has no options`).toBeGreaterThan(0);
    }
  });
});

describe('validateSettingValue', () => {
  it('accepts a valid value of each type', () => {
    expect(validateSettingValue('editor.wordWrap', true)).toBeUndefined();
    expect(validateSettingValue('editor.tabSize', 4)).toBeUndefined();
    expect(validateSettingValue('editor.fontFamily', 'Consolas')).toBeUndefined();
    expect(validateSettingValue('general.theme', 'dark')).toBeUndefined();
    expect(validateSettingValue('compilation.extraArgs', ['-a'])).toBeUndefined();
    expect(validateSettingValue('appearance.accentColor', '#059669')).toBeUndefined();
  });

  it('rejects wrong types', () => {
    expect(validateSettingValue('editor.wordWrap', 'yes')).toMatch(/true or false/);
    expect(validateSettingValue('editor.tabSize', 'four')).toMatch(/number/);
  });

  it('enforces numeric bounds', () => {
    expect(validateSettingValue('editor.tabSize', 0)).toMatch(/at least 1/);
    expect(validateSettingValue('editor.tabSize', 99)).toMatch(/at most 16/);
  });

  it('rejects values outside an enum', () => {
    expect(validateSettingValue('general.theme', 'sepia')).toMatch(/must be one of/);
  });

  it('rejects a malformed colour', () => {
    expect(validateSettingValue('appearance.accentColor', 'green')).toMatch(/hex colour/);
  });

  it('does not complain about unknown keys', () => {
    expect(validateSettingValue('not.a.real.key', 1)).toBeUndefined();
  });

  it('keeps the project-scoped list and the schema in step, and keeps it small', () => {
    // The module checks this at import (a mismatch throws), so the assertion here
    // is about the *shape* of the list rather than its consistency: most settings
    // are the user's, and a change that made the project's list the bigger one
    // would be a different application.
    const declared = SETTINGS_SCHEMA.filter((descriptor) => descriptor.projectScoped === true);
    expect(declared.length).toBe(PROJECT_SCOPED_SETTINGS.length);
    expect(new Set(PROJECT_SCOPED_SETTINGS).size).toBe(PROJECT_SCOPED_SETTINGS.length);
    for (const key of PROJECT_SCOPED_SETTINGS) {
      expect(getSettingDescriptor(key), `${key} is not a declared setting`).toBeDefined();
      expect(canBeProjectScoped(key), `${key} is listed but not marked`).toBe(true);
    }
    expect(declared.length).toBeLessThan(SETTINGS_SCHEMA.length / 4);

    // The three families the rule is written around, so a key dropped from the
    // list is caught here rather than by a user whose project stopped building.
    for (const key of [
      'latex.rootDocument',
      'compilation.engine',
      'compilation.recipe',
      'compilation.outputDirectory',
      'snippets.snippetDirectories',
    ]) {
      expect(canBeProjectScoped(key), `${key} is a project setting`).toBe(true);
    }
    // ...and the ones that must never be.
    for (const key of [
      'editor.fontSize',
      'general.theme',
      'appearance.accentColor',
      'pdf.defaultZoom',
      'snippets.enabled',
      'keybindings.saveFile',
      'not.a.real.key',
    ]) {
      expect(canBeProjectScoped(key), `${key} is the user's`).toBe(false);
    }
  });
});

describe('settings scopes', () => {
  it('reports the default scope for an untouched key', () => {
    expect(settingsManager.getScope('editor.tabSize')).toBe('default');
  });

  it('lets a user value override the default', () => {
    settingsManager.setValue('editor.tabSize', 6, 'user');
    expect(settingsManager.getValue('editor.tabSize')).toBe(6);
    expect(settingsManager.getScope('editor.tabSize')).toBe('user');
    settingsManager.reset('editor.tabSize', 'user');
  });

  it('lets a workspace value override a user value, and restoring reveals the user value again', () => {
    // `compilation.recipe` is a setting a project owns — see
    // `PROJECT_SCOPED_SETTINGS`. The precedence itself (workspace over user, and
    // the user's value surfacing again when the project lets go) is what this
    // pins; which settings may take part is the next test's subject.
    settingsManager.setValue('compilation.recipe', 'xelatex', 'user');
    settingsManager.loadWorkspaceSettings('C:/proj/.eukolia.json', {
      'compilation.recipe': 'pdflatex ➞ bibtex ➞ pdflatex ×2',
    });

    expect(settingsManager.getValue('compilation.recipe')).toBe('pdflatex ➞ bibtex ➞ pdflatex ×2');
    expect(settingsManager.getScope('compilation.recipe')).toBe('workspace');

    settingsManager.loadWorkspaceSettings(null, null);
    expect(settingsManager.getValue('compilation.recipe')).toBe('xelatex');

    settingsManager.reset('compilation.recipe', 'user');
    expect(settingsManager.getValue('compilation.recipe')).toBe(
      getSettingDescriptor('compilation.recipe')?.default
    );
  });

  it('ignores invalid values in a workspace file instead of throwing', () => {
    settingsManager.loadWorkspaceSettings('C:/proj/.eukolia.json', {
      'compilation.synctex': 'not a boolean',
    });
    expect(settingsManager.getValue('compilation.synctex')).toBe(
      getSettingDescriptor('compilation.synctex')?.default
    );
    settingsManager.loadWorkspaceSettings(null, null);
  });

  it('refuses a project a setting the user owns', () => {
    settingsManager.setValue('editor.tabSize', 6, 'user');

    // The file is read, and the key in it is simply not the project's to set.
    settingsManager.loadWorkspaceSettings('C:/proj/.eukolia.json', {
      'editor.tabSize': 8,
      'editor.fontSize': 30,
      'general.theme': 'light',
      'appearance.accentColor': '#ff0000',
      'keybindings.saveFile': 'Ctrl+Shift+S',
      'compilation.recipe': 'xelatex',
    });

    expect(settingsManager.getValue('editor.tabSize'), 'a project changed the editor').toBe(6);
    expect(settingsManager.getScope('editor.tabSize'), 'a project claimed a user setting').toBe('user');
    expect(settingsManager.getValue('editor.fontSize')).toBe(
      getSettingDescriptor('editor.fontSize')?.default
    );
    expect(settingsManager.getValue('general.theme')).toBe(
      getSettingDescriptor('general.theme')?.default
    );
    expect(settingsManager.getValue('appearance.accentColor')).toBe(
      getSettingDescriptor('appearance.accentColor')?.default
    );
    // An undeclared key is not project-scoped either: the escape hatch belongs to
    // the user, which is where a per-command binding is written.
    expect(settingsManager.getValue('keybindings.saveFile')).toBe(
      getSettingDescriptor('keybindings.saveFile')?.default
    );
    // ...and the build, which the project does own, is applied in the same file.
    expect(settingsManager.getValue('compilation.recipe')).toBe('xelatex');

    settingsManager.loadWorkspaceSettings(null, null);
    settingsManager.reset('editor.tabSize', 'user');
  });

  it('refuses to write a user setting to the workspace scope, and says which settings a project may set', () => {
    expect(() => settingsManager.setValue('editor.tabSize', 8, 'workspace')).toThrow(
      /user setting and cannot be set for one project/
    );
    expect(() => settingsManager.setValue('editor.tabSize', 8, 'workspace')).toThrow(
      /compilation\.recipe/
    );
    expect(() => settingsManager.set('editor', { tabSize: 8 }, 'workspace')).toThrow(
      /cannot be set for one project/
    );
    // The workspace reset path is an API a caller can reach, so it is policed the
    // same way rather than silently clearing nothing.
    expect(() => settingsManager.reset('editor.tabSize', 'workspace')).toThrow(
      /cannot be set for one project/
    );

    // A setting the project owns goes through, and the user scope is untouched by
    // any of this: that is where the Settings UI writes.
    settingsManager.setValue('compilation.recipe', 'xelatex', 'workspace');
    expect(settingsManager.getScope('compilation.recipe')).toBe('workspace');
    settingsManager.loadWorkspaceSettings(null, null);
  });

  it('resets a whole section', () => {
    settingsManager.set('editor', { tabSize: 7, wordWrap: false }, 'user');
    settingsManager.reset('editor', 'user');
    expect(settingsManager.getValue('editor.tabSize')).toBe(getSettingDescriptor('editor.tabSize')?.default);
    expect(settingsManager.getValue('editor.wordWrap')).toBe(getSettingDescriptor('editor.wordWrap')?.default);
  });

  it('refuses to store an invalid value', () => {
    expect(() => settingsManager.setValue('editor.tabSize', 999, 'user')).toThrow(/Invalid value/);
  });
});

describe('settings search and grouping', () => {
  it('finds settings by key, label and description', () => {
    expect(settingsManager.search('tabSize').some((entry) => entry.key === 'editor.tabSize')).toBe(true);
    expect(settingsManager.search('smooth').some((entry) => entry.key.startsWith('scrolling.'))).toBe(true);
    expect(settingsManager.search('ampersand').some((entry) => entry.key === 'formatting.alignAmpersands')).toBe(true);
  });

  it('returns everything for an empty query', () => {
    expect(settingsManager.search('').length).toBe(SETTINGS_SCHEMA.length);
  });

  it('groups settings by category without empty groups', () => {
    const groups = settingsManager.byCategory();
    expect(groups.length).toBeGreaterThan(5);
    for (const group of groups) expect(group.settings.length).toBeGreaterThan(0);
  });
});

describe('vscode settings bridge', () => {
  it('resolves a key through its vscodeKey mapping', () => {
    settingsManager.setValue('formatting.alignEnvironments', ['align'], 'user');
    expect(settingsManager.getForVscode('texAligner', 'environments')).toEqual(['align']);
    settingsManager.reset('formatting.alignEnvironments', 'user');
  });

  it('falls back to a suffix match on the short key', () => {
    settingsManager.setValue('snippets.multiLineContext', 42, 'user');
    expect(settingsManager.getForVscode('hsnips', 'multiLineContext')).toBe(42);
    settingsManager.reset('snippets.multiLineContext', 'user');
  });
});

describe('keybinding parsing', () => {
  it('parses modifiers and a key', () => {
    const parsed = parseKeybinding('Ctrl+Shift+P');
    expect(parsed).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: 'p' });
  });

  it('normalises key aliases', () => {
    expect(parseKeybinding('Escape')?.key).toBe('escape');
    expect(parseKeybinding('Esc')?.key).toBe('escape');
    expect(parseKeybinding('Up')?.key).toBe('arrowup');
  });

  it('returns null for an empty binding', () => {
    expect(parseKeybinding('')).toBeNull();
  });

  it('accepts Cmd as an alias for Meta', () => {
    expect(parseKeybinding('Cmd+K')?.meta).toBe(true);
  });

  it('formats a binding for display', () => {
    expect(formatKeybinding('Ctrl+Shift+P', 'win32')).toBe('Ctrl+Shift+P');
    expect(formatKeybinding('Ctrl+Shift+P', 'darwin')).toBe('⌃⇧P');
  });
});

describe('keybinding matching', () => {
  const event = (init: Partial<KeyboardEvent>) =>
    ({ key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init }) as KeyboardEvent;

  it('matches a plain chord', () => {
    const parsed = parseKeybinding('Ctrl+B')!;
    expect(matchesKeybinding(event({ key: 'b', ctrlKey: true }), parsed)).toBe(true);
  });

  it('does not match when a modifier differs', () => {
    const parsed = parseKeybinding('Ctrl+B')!;
    expect(matchesKeybinding(event({ key: 'b', ctrlKey: true, shiftKey: true }), parsed)).toBe(false);
    expect(matchesKeybinding(event({ key: 'b' }), parsed)).toBe(false);
  });

  it('matches through the physical code for layout independence', () => {
    const parsed = parseKeybinding('Ctrl+B')!;
    expect(matchesKeybinding(event({ key: 'ъ', code: 'KeyB', ctrlKey: true }), parsed)).toBe(true);
  });

  /**
   * The fallback reads the *physical* key, which is what it already did for
   * letters and now does for digits and the keypad.
   *
   * This came out of the tab bar's end-to-end probe: every `Ctrl+Alt+…` chord in
   * that step failed. The chords turned out to be arriving perfectly formed (the
   * cause was a `contentEditable` target, and the probe's own fault), but the
   * investigation is what showed the fallback covered `Key*` and nothing else —
   * so `Ctrl+1` would have been lost to `event.key` on any layout that composes a
   * character for it, and to the numeric keypad always.
   */
  it('matches a digit through the physical code, row or keypad', () => {
    const parsed = parseKeybinding('Ctrl+Alt+1')!;
    // A layout (or a modifier) that rewrote what `key` reads as.
    expect(matchesKeybinding(event({ key: '¡', code: 'Digit1', ctrlKey: true, altKey: true }), parsed)).toBe(true);
    // …and still matches the ordinary spelling of the same chord.
    expect(matchesKeybinding(event({ key: '1', code: 'Digit1', ctrlKey: true, altKey: true }), parsed)).toBe(true);
    // `Ctrl+1` is not a different shortcut because the `1` came from the keypad.
    const plain = parseKeybinding('Ctrl+1')!;
    expect(matchesKeybinding(event({ key: '1', code: 'Numpad1', ctrlKey: true }), plain)).toBe(true);
    // A different physical key with the same modifiers is still a different key.
    expect(matchesKeybinding(event({ key: '2', code: 'Digit2', ctrlKey: true, altKey: true }), parsed)).toBe(false);
  });

  it('matches Ctrl+Alt+M through the physical key', () => {
    const parsed = parseKeybinding('Ctrl+Alt+M')!;
    expect(matchesKeybinding(event({ key: 'µ', code: 'KeyM', ctrlKey: true, altKey: true }), parsed)).toBe(true);
    expect(matchesKeybinding(event({ key: 'm', code: 'KeyM', ctrlKey: true, altKey: true }), parsed)).toBe(true);
    expect(matchesKeybinding(event({ key: 'm', code: 'KeyM', ctrlKey: true }), parsed)).toBe(false);
  });

  it('matches a spelled-out key through its code', () => {
    const parsed = parseKeybinding('PageDown')!;
    expect(matchesKeybinding(event({ key: 'PageDown', code: 'PageDown' }), parsed)).toBe(true);
    // The physical code is the same name, so the fallback answers here too.
    expect(matchesKeybinding(event({ key: 'Unidentified', code: 'PageDown' }), parsed)).toBe(true);
  });

  it('does not match a key the binding did not ask for', () => {
    // The fallback must not turn every unshifted letter into every other one.
    const parsed = parseKeybinding('Ctrl+B')!;
    expect(matchesKeybinding(event({ key: 'n', code: 'KeyN', ctrlKey: true }), parsed)).toBe(false);
    expect(matchesKeybinding(event({ key: 'F5', code: 'F5', ctrlKey: true }), parsed)).toBe(false);
  });
});

describe('command registry', () => {
  it('registers, resolves and executes a command', async () => {
    const handler = vi.fn();
    const dispose = commandRegistry.register({ id: 'test.simple', title: 'Simple', category: 'Test', handler });

    await commandRegistry.execute('test.simple');
    expect(handler).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('refuses to run a command whose when-clause fails', async () => {
    const handler = vi.fn();
    const dispose = commandRegistry.register({
      id: 'test.conditional',
      title: 'Conditional',
      category: 'Test',
      when: (context) => context.hasWorkspace,
      handler
    });

    commandRegistry.setContext({ hasWorkspace: false });
    await commandRegistry.execute('test.conditional');
    expect(handler).not.toHaveBeenCalled();

    commandRegistry.setContext({ hasWorkspace: true });
    await commandRegistry.execute('test.conditional');
    expect(handler).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('swallows a handler error and reports it as an event', async () => {
    const onError = vi.fn();
    commandRegistry.on('error', onError);
    const dispose = commandRegistry.register({
      id: 'test.throwing',
      title: 'Throwing',
      category: 'Test',
      handler: () => {
        throw new Error('boom');
      }
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(commandRegistry.execute('test.throwing')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);

    spy.mockRestore();
    dispose();
  });

  it('orders palette results by fuzzy score and always puts recency first on an empty query', async () => {
    const dispose = commandRegistry.registerAll([
      { id: 'zeta.alignThings', title: 'Align Things', category: 'Zeta', handler: () => undefined },
      { id: 'alpha.openFolder', title: 'Open Folder', category: 'Alpha', handler: () => undefined }
    ]);

    const results = commandRegistry.search('openfold');
    expect(results[0]?.id).toBe('alpha.openFolder');

    await commandRegistry.execute('zeta.alignThings');
    expect(commandRegistry.search('')[0]?.id).toBe('zeta.alignThings');

    dispose();
  });

  it('lets a user override replace the declared keybinding', () => {
    const dispose = commandRegistry.register({
      id: 'test.rebindable',
      title: 'Rebindable',
      category: 'Test',
      keybinding: 'Ctrl+9',
      handler: () => undefined
    });

    expect(commandRegistry.getKeybinding('test.rebindable')).toBe('Ctrl+9');
    commandRegistry.setKeybinding('test.rebindable', 'Ctrl+Alt+9');
    expect(commandRegistry.getKeybinding('test.rebindable')).toBe('Ctrl+Alt+9');

    const resolved = commandRegistry.resolveKeybinding({
      key: '9',
      code: 'Digit9',
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false
    } as KeyboardEvent);
    expect(resolved).toBe('test.rebindable');

    commandRegistry.setKeybinding('test.rebindable', null);
    expect(commandRegistry.getKeybinding('test.rebindable')).toBe('Ctrl+9');
    dispose();
  });
});
