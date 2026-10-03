// @vitest-environment jsdom

/**
 * The settings category list (Instructions.md §56).
 *
 * Both of the claims below are about what the pane looks like once it is put
 * together, so they are pinned on the mounted view rather than on a helper:
 *
 *  * a category entry says what the category is and how many settings it holds,
 *    and nothing else. It used to carry a coloured dot as well, claiming that
 *    something in the category had been saved as a user setting — a question the
 *    rows themselves already answer, with the scope that actually won (§57);
 *  * the snippet library has one way in from the pane: the button at the top of
 *    the Snippets section. It used to have a second one in the grey column, which
 *    read as a category of its own.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module reaches the preload bridge at import time, so it is stubbed first.
vi.hoisted(() => {
  const ipc = new Proxy(
    {},
    {
      get: (_target, property) => (..._args: unknown[]) => {
        if (typeof property === 'string' && property.startsWith('on')) return () => undefined;
        return Promise.resolve(undefined);
      }
    }
  );
  const globals = globalThis as unknown as Record<string, unknown>;
  if (globals.window) {
    (globals.window as Record<string, unknown>).eukoliaApi = ipc;
  } else {
    globals.window = {
      eukoliaApi: ipc,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    } as never;
  }
});

const { SettingsView } = await import('../../src/renderer/ui/components/SettingsView');
const { SETTING_CATEGORIES, settingsManager } = await import('../../src/renderer/core/settings');

let container: HTMLDivElement;
let root: Root;

/** User-level settings this file saves, put back afterwards. */
const saved: string[] = [];

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  for (const key of saved) settingsManager.reset(key, 'user');
  saved.length = 0;
  // The manager coalesces its file write; nothing may outlive the test.
  await settingsManager.flushFileWrite();
  localStorage.clear();
});

/** Saves one boolean setting at user scope, and answers with its key. */
function saveOneUserSetting(): string {
  const descriptor = settingsManager
    .byCategory()
    .flatMap((group) => group.settings)
    .find((candidate) => candidate.type === 'boolean');
  if (!descriptor) throw new Error('the schema declares no boolean setting');
  settingsManager.setValue(descriptor.key, !Boolean(settingsManager.getValue(descriptor.key)), 'user');
  saved.push(descriptor.key);
  return descriptor.key;
}

async function mount(section: string = SETTING_CATEGORIES[0]): Promise<void> {
  await act(async () => {
    root.render(React.createElement(SettingsView, { section, onSectionChange: () => undefined }));
  });
}

/** The grey column of categories. */
const column = (): HTMLElement => container.firstElementChild?.firstElementChild as HTMLElement;

/** The settings body beside the column. */
const body = (): HTMLElement => container.firstElementChild?.children[1] as HTMLElement;

const buttonsIn = (where: HTMLElement): HTMLButtonElement[] => [...where.querySelectorAll('button')];

const labelOf = (button: HTMLButtonElement): string => button.firstElementChild?.textContent ?? '';

const containing = (where: HTMLElement, text: string): HTMLButtonElement[] =>
  buttonsIn(where).filter((button) => (button.textContent ?? '').includes(text));

describe('the settings category list', () => {
  it('lists every category in order, each with no more than its name and its count', async () => {
    await mount();
    const entries = settingsManager.byCategory();

    const categories = buttonsIn(column()).filter((button) =>
      (SETTING_CATEGORIES as readonly string[]).includes(labelOf(button))
    );
    expect(categories.map(labelOf)).toEqual(entries.map((group) => group.category));

    for (const [index, button] of categories.entries()) {
      const count = entries[index].settings.length;
      // Name and count, and no third child: no scope or customisation marker.
      expect(button.children.length, `${labelOf(button)} has an extra marker`).toBe(2);
      expect(button.children[1].textContent).toBe(String(count));
      expect(button.title).toBe(`${count} settings`);
    }
  });

  it('shows no marker for a category that holds a saved user setting', async () => {
    const key = saveOneUserSetting();
    // The setup is only worth anything if the setting really is user-scoped.
    expect(settingsManager.getScope(key)).toBe('user');

    await mount();

    const category = settingsManager.getDescriptor(key)?.category ?? '';
    const entries = settingsManager.byCategory();
    const button = buttonsIn(column()).find((candidate) => labelOf(candidate) === category);
    expect(button, `${category} is not in the list`).toBeDefined();

    const count = entries.find((group) => group.category === category)?.settings.length ?? 0;
    expect(button?.children.length).toBe(2);
    expect(button?.title).toBe(`${count} settings`);
  });

  it('has no entry of its own for the snippet library', async () => {
    await mount();
    const entryCount = settingsManager.byCategory().length;
    // Every category, plus the synthetic Keyboard Shortcuts section — and nothing
    // between them, so nothing can be mistaken for one of them.
    expect(buttonsIn(column()).length).toBe(entryCount + 1);
    expect(containing(column(), 'Manage snippets')).toEqual([]);
  });

  it('keeps the way into the library in the Snippets section', async () => {
    await mount('Snippets');
    expect(containing(body(), 'Manage snippets').length).toBeGreaterThan(0);
  });
});
