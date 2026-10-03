/**
 * `files.autoSave` — the four modes (Instructions.md §45).
 *
 * The setting is a promise about *when* Eukolia writes a file the user has not
 * saved, so each test below pins one mode at the moment it acts, and the moments
 * it must not. Two of those are not preferences but rules:
 *
 *  * a buffer with no file behind it is never written automatically — `save()`
 *    would open a Save dialog to ask where to put it, and a timer must never
 *    raise one (VS Code refuses untitled working copies for the same reason);
 *  * the policy lives in one table (`core/autoSave.ts`), so the modes are checked
 *    against the table as well as through the workspace that consults it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../../src/renderer/services/workspace';
import {
  AUTO_SAVE_MODES,
  autoSaveRunsFor,
  type AutoSaveMode,
  type AutoSaveTrigger
} from '../../src/renderer/core/autoSave';
import { SETTINGS_SCHEMA, settingsManager, validateSettingValue } from '../../src/renderer/core/settings';

/** The schema's own default for `files.autoSaveDelayMs`. */
const DELAY = 1500;

interface Harness {
  service: WorkspaceService;
  /** The files on the fake disk, and the writes that changed them. */
  files: Map<string, string>;
  writes: Array<{ path: string; content: string }>;
  /** How many times a Save dialog was raised — it must stay at zero. */
  saveDialogs: number;
}

function createHarness(): Harness {
  const files = new Map<string, string>();
  const writes: Array<{ path: string; content: string }> = [];
  const harness: Harness = { service: null as unknown as WorkspaceService, files, writes, saveDialogs: 0 };

  const api = {
    stat: vi.fn(async (path: string) => ({
      exists: files.has(path),
      isDirectory: false,
      mtimeMs: Date.now(),
      size: files.get(path)?.length ?? 0
    })),
    readFile: vi.fn(async (path: string) => files.get(path) ?? ''),
    writeFile: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
      writes.push({ path, content });
    }),
    listTree: vi.fn(async () => []),
    watch: vi.fn(async () => undefined),
    unwatch: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ unsavedBuffers: {} })),
    setState: vi.fn(async () => undefined),
    saveFileDialog: vi.fn(async () => {
      harness.saveDialogs += 1;
      return null;
    })
  };

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = {
    eukoliaApi: api,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };

  harness.service = new WorkspaceService({
    createAnalyzer: async () => null,
    parseBibtex: () => [],
    detectRootDocument: () => null
  });
  return harness;
}

function setMode(mode: string): void {
  settingsManager.setValue('files.autoSave', mode, 'user');
}

/** Types `text` at the end of a buffer, which is what arms an autosave. */
function type(doc: { getLength(): number; replaceRange(from: number, to: number, insert: string): void }, text: string): void {
  doc.replaceRange(doc.getLength(), doc.getLength(), text);
}

/** Lets the promises an event handler started run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  settingsManager.reset('files.autoSave', 'user');
  settingsManager.reset('files.autoSaveDelayMs', 'user');
  await settingsManager.flushFileWrite();
});

describe('files.autoSave: afterDelay', () => {
  it('writes the buffer once the delay has passed, and not before', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      setMode('afterDelay');
      harness.files.set('/w/main.tex', 'start');
      const doc = await harness.service.openFile('/w/main.tex');
      type(doc, ' typed');

      await vi.advanceTimersByTimeAsync(DELAY - 1);
      expect(harness.writes).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(harness.writes).toEqual([{ path: '/w/main.tex', content: 'start typed' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is pushed out for as long as the user keeps typing', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      setMode('afterDelay');
      harness.files.set('/w/main.tex', 'start');
      const doc = await harness.service.openFile('/w/main.tex');

      type(doc, 'a');
      await vi.advanceTimersByTimeAsync(DELAY - 500);
      type(doc, 'b');
      await vi.advanceTimersByTimeAsync(DELAY - 500);
      // Two delays have passed since the first keystroke, but a whole one has not
      // passed since the last: the write waits for the typist, it does not chase
      // them.
      expect(harness.writes).toEqual([]);

      await vi.advanceTimersByTimeAsync(500);
      expect(harness.writes).toHaveLength(1);
      expect(harness.files.get('/w/main.tex')).toBe('startab');
    } finally {
      vi.useRealTimers();
    }
  });

  it('changes nothing on a focus change, on either focus', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      setMode('afterDelay');
      harness.files.set('/w/main.tex', 'start');
      const doc = await harness.service.openFile('/w/main.tex');
      type(doc, ' typed');

      // The two focus triggers belong to the two focus modes; this mode owns a
      // timer and nothing else.
      expect(await harness.service.runAutoSave('editorFocusLost')).toBe(0);
      expect(await harness.service.runAutoSave('windowFocusLost')).toBe(0);
      expect(harness.writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('files.autoSave: off', () => {
  it('never writes on its own, whatever happens', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      setMode('off');
      harness.files.set('/w/main.tex', 'start');
      const doc = await harness.service.openFile('/w/main.tex');
      type(doc, ' typed');

      await vi.advanceTimersByTimeAsync(DELAY * 4);
      expect(await harness.service.runAutoSave('editorFocusLost')).toBe(0);
      expect(await harness.service.runAutoSave('windowFocusLost')).toBe(0);
      await harness.service.flushAutoSave();

      expect(harness.writes).toEqual([]);
      // Still unsaved, and still the user's decision to make.
      expect(doc.getDirty()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('files.autoSave: onFocusChange', () => {
  it('saves the buffer the editor was showing when it loses focus', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      setMode('onFocusChange');
      harness.files.set('/w/main.tex', 'start');
      const doc = await harness.service.openFile('/w/main.tex');
      type(doc, ' typed');

      // Not a delay mode: waiting changes nothing.
      await vi.advanceTimersByTimeAsync(DELAY * 3);
      expect(harness.writes).toEqual([]);

      expect(await harness.service.runAutoSave('editorFocusLost')).toBe(1);
      expect(harness.files.get('/w/main.tex')).toBe('start typed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves on a window focus change too, which is a way for the editor to lose focus', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      setMode('onFocusChange');
      harness.files.set('/w/main.tex', 'start');
      const doc = await harness.service.openFile('/w/main.tex');
      type(doc, ' typed');

      expect(await harness.service.runAutoSave('windowFocusLost')).toBe(1);
      expect(harness.files.get('/w/main.tex')).toBe('start typed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves the editor that was left when another document becomes active', async () => {
    const harness = createHarness();
    setMode('onFocusChange');
    harness.files.set('/w/a.tex', 'a');
    harness.files.set('/w/b.tex', 'b');

    const first = await harness.service.openFile('/w/a.tex');
    type(first, '!');
    // Opening the second document activates it, which is the moment the first one
    // is left behind.
    await harness.service.openFile('/w/b.tex');
    await settle();

    expect(harness.files.get('/w/a.tex')).toBe('a!');
    expect(harness.files.get('/w/b.tex')).toBe('b');
  });

  it('saves only the buffer that was left, not every other dirty one', async () => {
    const harness = createHarness();
    setMode('onFocusChange');
    harness.files.set('/w/a.tex', 'a');
    harness.files.set('/w/b.tex', 'b');

    const first = await harness.service.openFile('/w/a.tex');
    type(first, '!');
    // Opened without activating: `a` is still the buffer the editor is showing.
    const second = await harness.service.openFile('/w/b.tex', { activate: false });
    type(second, '?');

    expect(await harness.service.runAutoSave('editorFocusLost')).toBe(1);
    expect(harness.files.get('/w/a.tex')).toBe('a!');
    expect(harness.files.get('/w/b.tex')).toBe('b');

    // The window going away is the one trigger that saves everything: which editor
    // happened to hold focus says nothing about what the user was working on.
    expect(await harness.service.runAutoSave('windowFocusLost')).toBe(1);
    expect(harness.files.get('/w/b.tex')).toBe('b?');
  });
});

describe('files.autoSave: onWindowChange', () => {
  it('ignores the editor losing focus and saves when the window does', async () => {
    const harness = createHarness();
    setMode('onWindowChange');
    harness.files.set('/w/main.tex', 'start');
    const doc = await harness.service.openFile('/w/main.tex');
    type(doc, ' typed');

    expect(await harness.service.runAutoSave('editorFocusLost')).toBe(0);
    expect(harness.writes).toEqual([]);

    expect(await harness.service.runAutoSave('windowFocusLost')).toBe(1);
    expect(harness.files.get('/w/main.tex')).toBe('start typed');
  });

  it('ignores a document being left for another one', async () => {
    const harness = createHarness();
    setMode('onWindowChange');
    harness.files.set('/w/a.tex', 'a');
    harness.files.set('/w/b.tex', 'b');

    const first = await harness.service.openFile('/w/a.tex');
    type(first, '!');
    await harness.service.openFile('/w/b.tex');
    await settle();

    expect(harness.writes).toEqual([]);
  });
});

describe('a buffer with no file behind it', () => {
  it('is never written by the delay, and never asks where to put it', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      setMode('afterDelay');
      const draft = harness.service.createUntitled('draft');
      type(draft, '!');

      await vi.advanceTimersByTimeAsync(DELAY * 3);

      expect(harness.writes).toEqual([]);
      expect(harness.saveDialogs).toBe(0);
      // It stays dirty, so the tab keeps saying so and crash recovery keeps it.
      expect(draft.getDirty()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is skipped by an autosave pass even while a file beside it is written', async () => {
    const harness = createHarness();
    setMode('onFocusChange');
    harness.files.set('/w/main.tex', 'start');
    const doc = await harness.service.openFile('/w/main.tex');
    type(doc, ' typed');
    const draft = harness.service.createUntitled('draft');
    type(draft, '!');

    expect(await harness.service.runAutoSave('windowFocusLost')).toBe(1);

    expect(harness.files.get('/w/main.tex')).toBe('start typed');
    expect(harness.saveDialogs).toBe(0);
    expect(draft.getDirty()).toBe(true);
  });

  it('is not turned into a Save dialog by the shutdown flush', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      setMode('afterDelay');
      harness.files.set('/w/main.tex', 'start');
      const doc = await harness.service.openFile('/w/main.tex');
      type(doc, ' typed');
      const draft = harness.service.createUntitled('draft');
      type(draft, '!');

      await harness.service.flushAutoSave();

      // The pending delayed write is flushed rather than lost...
      expect(harness.files.get('/w/main.tex')).toBe('start typed');
      // ...and the buffer with nowhere to go is left to the recovery mirror (§59).
      expect(harness.saveDialogs).toBe(0);
      expect(draft.getDirty()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the trigger table', () => {
  const TRIGGERS: readonly AutoSaveTrigger[] = ['afterDelay', 'editorFocusLost', 'windowFocusLost', 'activeEditorChange'];

  it('says exactly which events each mode acts on', () => {
    const expected: Record<AutoSaveMode, Record<AutoSaveTrigger, boolean>> = {
      off: { afterDelay: false, editorFocusLost: false, windowFocusLost: false, activeEditorChange: false },
      afterDelay: { afterDelay: true, editorFocusLost: false, windowFocusLost: false, activeEditorChange: false },
      onFocusChange: { afterDelay: false, editorFocusLost: true, windowFocusLost: true, activeEditorChange: true },
      onWindowChange: { afterDelay: false, editorFocusLost: false, windowFocusLost: true, activeEditorChange: false }
    };

    for (const mode of AUTO_SAVE_MODES) {
      for (const trigger of TRIGGERS) {
        expect(autoSaveRunsFor(mode, trigger), `${mode} × ${trigger}`).toBe(expected[mode][trigger]);
      }
    }
  });
});

describe('the settings entry', () => {
  it('offers the four modes, each with the sentence that explains it', () => {
    const descriptor = SETTINGS_SCHEMA.find((candidate) => candidate.key === 'files.autoSave');
    expect(descriptor).toBeDefined();
    expect(descriptor?.options).toEqual([...AUTO_SAVE_MODES]);
    expect(descriptor?.optionDescriptions).toHaveLength(AUTO_SAVE_MODES.length);
    expect(descriptor?.default).toBe('off');
    // The four modes are the only values the schema will take.
    for (const mode of AUTO_SAVE_MODES) {
      expect(validateSettingValue('files.autoSave', mode)).toBeUndefined();
    }
    expect(validateSettingValue('files.autoSave', 'onSave')).toBeDefined();
  });

  it('says which mode the delay applies to', () => {
    const delay = SETTINGS_SCHEMA.find((candidate) => candidate.key === 'files.autoSaveDelayMs');
    expect(delay?.description).toMatch(/afterDelay/);
  });
});
