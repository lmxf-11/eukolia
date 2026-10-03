// @vitest-environment jsdom

/**
 * How an `enum` setting explains its options (§56).
 *
 * The four auto save modes differ only in *when* they write, so the option names
 * alone are a vocabulary test: `onFocusChange` and `onWindowChange` are one word
 * apart and mean different things. These assertions pin the answer the pane
 * gives — the sentence under the row for the mode that is set, and the same
 * sentence on each option of the dropdown, which is where VS Code puts its
 * `enumDescriptions` too.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// React only batches inside `act` when the environment says so.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const { settingsManager } = await import('../../src/renderer/core/settings');
const { AUTO_SAVE_MODES } = await import('../../src/renderer/core/autoSave');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  settingsManager.reset('files.autoSave', 'user');
  await settingsManager.flushFileWrite();
  localStorage.clear();
});

async function mount(section: string): Promise<void> {
  await act(async () => {
    root.render(React.createElement(SettingsView, { section, onSectionChange: () => undefined }));
  });
}

/** The row for one setting, by its dotted key. */
function rowFor(key: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('.eu-settings__row')].find((candidate) =>
    candidate.querySelector('.eu-settings__key')?.textContent === key
  );
  if (!row) throw new Error(`${key} is not in the pane`);
  return row;
}

describe('the auto save row', () => {
  it('offers the four modes, each carrying the sentence that explains it', async () => {
    await mount('Files');
    const select = rowFor('files.autoSave').querySelector('select') as HTMLSelectElement;

    expect([...select.options].map((option) => option.value)).toEqual([...AUTO_SAVE_MODES]);
    expect(select.options[1].title).toMatch(/after the configured auto save delay/i);
    expect(select.options[2].title).toMatch(/when the editor loses focus/i);
    expect(select.options[3].title).toMatch(/when the window loses focus/i);
  });

  it('spells out the mode that is set', async () => {
    await mount('Files');
    const hint = (): string | undefined => rowFor('files.autoSave').querySelector('.eu-settings__option-hint')?.textContent ?? undefined;

    // The default: nothing is written behind the user's back.
    expect(hint()).toMatch(/never automatically saved/i);

    await act(async () => {
      settingsManager.setValue('files.autoSave', 'onFocusChange', 'user');
    });

    // The one distinction a reader has to get right: leaving the editor saves,
    // which the four mode names alone do not say.
    expect(hint()).toMatch(/when the editor loses focus/i);
  });
});
