/**
 * Crash-recovery mirror tests (Instructions.md §59).
 *
 * The mirror is the one place where writing lazily can cost the user work, so
 * these pin both halves of the bargain: the write is coalesced off the keystroke
 * (a burst costs one write, made from the buffers as they are when it runs), and
 * it is never the only thing standing between unsaved work and a lost buffer —
 * saving, closing and shutting down all write it immediately, and a record from
 * an earlier session that no open buffer accounts for survives.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceService, primeWorkspaceRecovery, type UnsavedBufferRecord } from '../../src/renderer/services/workspace';

interface Harness {
  service: WorkspaceService;
  writes: Array<Record<string, UnsavedBufferRecord>>;
  files: Map<string, string>;
  listeners: Map<string, Array<() => void>>;
  /** Fires the listener the service registered for `event`. */
  emit(event: string): void;
}

function createHarness(previousSession: Record<string, UnsavedBufferRecord> = {}): Harness {
  const files = new Map<string, string>();
  const writes: Array<Record<string, UnsavedBufferRecord>> = [];
  const listeners = new Map<string, Array<() => void>>();

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
    }),
    listTree: vi.fn(async () => []),
    unwatch: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ unsavedBuffers: previousSession })),
    setState: vi.fn(async (patch: { unsavedBuffers?: Record<string, UnsavedBufferRecord> }) => {
      if (patch.unsavedBuffers) writes.push(patch.unsavedBuffers);
      return undefined;
    })
  };

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = {
    eukoliaApi: api,
    addEventListener: (event: string, listener: () => void) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    removeEventListener: () => undefined
  };

  const service = new WorkspaceService({
    createAnalyzer: async () => null,
    parseBibtex: () => [],
    detectRootDocument: () => null
  });

  return {
    service,
    writes,
    files,
    listeners,
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    }
  };
}

const WINDOW_MS = 250;

beforeEach(() => {
  vi.useRealTimers();
});

describe('the recovery mirror is coalesced', () => {
  it('writes once for a burst, from the text as it is when the pass runs', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await primeWorkspaceRecovery();
      harness.files.set('/w/main.tex', 'start');
      const doc = await harness.service.openFile('/w/main.tex');

      const from = doc.getLength();
      doc.replaceRange(from, from, 'a');
      // Nothing is written from inside the change: the clone and the IPC are the
      // keystroke's own cost otherwise, and this is what keeps them off it.
      expect(harness.writes).toEqual([]);

      doc.replaceRange(from + 1, from + 1, 'b');
      doc.replaceRange(from + 2, from + 2, 'c');
      expect(harness.writes).toEqual([]);

      vi.advanceTimersByTime(WINDOW_MS);
      await Promise.resolve();

      expect(harness.writes).toHaveLength(1);
      // The latest text, not a snapshot taken when the first pass was armed.
      expect(harness.writes[0]['/w/main.tex'].content).toBe('startabc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the exposure bounded: a pass is written within one window of the last change', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await primeWorkspaceRecovery();
      harness.files.set('/w/main.tex', 'x');
      const doc = await harness.service.openFile('/w/main.tex');

      // Keep typing, never pausing for a whole window.
      for (let i = 0; i < 10; i++) {
        const at = doc.getLength();
        doc.replaceRange(at, at, 'y');
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      }

      // Ten keystrokes spread over 1000 ms cost at most one write per window —
      // the work is coalesced without the record ever being a whole burst behind.
      expect(harness.writes.length).toBeGreaterThanOrEqual(4);
      expect(harness.writes.length).toBeLessThanOrEqual(5);
      expect(harness.writes[harness.writes.length - 1]['/w/main.tex'].content).toBe(`x${'y'.repeat(10)}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes nothing while crash recovery is switched off', async () => {
    const harness = createHarness();
    await primeWorkspaceRecovery();
    const { settingsManager } = await import('../../src/renderer/core/settings');
    settingsManager.setValue('general.crashRecovery', false, 'user');
    try {
      harness.files.set('/w/main.tex', 'start');
      const doc = await harness.service.openFile('/w/main.tex');
      doc.replaceRange(doc.getLength(), doc.getLength(), 'a');
      await harness.service.flushRecovery();
      expect(harness.writes).toEqual([]);
    } finally {
      settingsManager.reset('general', 'user');
    }
  });
});

describe('the recovery record is the live set, not a startup snapshot', () => {
  it('does not roll another buffer back to the text it had at startup', async () => {
    // The earlier session left a record for a file the user has since edited and
    // saved; this session reopens it and changes it again.
    const harness = createHarness({
      '/w/other.tex': { content: 'STALE-FROM-LAST-SESSION', timestamp: 1, languageId: 'latex' }
    });
    await primeWorkspaceRecovery();
    harness.files.set('/w/other.tex', 'from disk');
    harness.files.set('/w/main.tex', 'main');

    const other = await harness.service.openFile('/w/other.tex');
    const main = await harness.service.openFile('/w/main.tex');
    other.replaceRange(other.getLength(), other.getLength(), '!');
    main.replaceRange(main.getLength(), main.getLength(), '?');

    await harness.service.flushRecovery();

    const record = harness.writes[harness.writes.length - 1];
    // Typing in `main` used to re-send `other` as it was at startup.
    expect(record['/w/other.tex'].content).toBe('from disk!');
    expect(record['/w/main.tex'].content).toBe('main?');
  });

  it('keeps work from an earlier session that no open buffer accounts for', async () => {
    const harness = createHarness({
      '/w/unrecovered.tex': { content: 'never reopened', timestamp: 1, languageId: 'latex' }
    });
    await primeWorkspaceRecovery();
    harness.files.set('/w/main.tex', 'main');
    const doc = await harness.service.openFile('/w/main.tex');
    doc.replaceRange(doc.getLength(), doc.getLength(), 'x');

    await harness.service.flushRecovery();

    const record = harness.writes[harness.writes.length - 1];
    expect(record['/w/unrecovered.tex'].content).toBe('never reopened');
    expect(record['/w/main.tex'].content).toBe('mainx');
  });

  it('drops a buffer that holds no unsaved work', async () => {
    const harness = createHarness();
    await primeWorkspaceRecovery();
    harness.files.set('/w/main.tex', 'on disk');
    const doc = await harness.service.openFile('/w/main.tex');
    // Never edited: nothing to recover, and nothing to offer back later.
    await harness.service.flushRecovery();
    expect(harness.writes[harness.writes.length - 1]).toEqual({});

    doc.replaceRange(doc.getLength(), doc.getLength(), 'edit');
    await harness.service.flushRecovery();
    expect(Object.keys(harness.writes[harness.writes.length - 1])).toEqual(['/w/main.tex']);
  });
});

describe('the recovery mirror is written immediately when waiting is pointless', () => {
  it('writes on an explicit save, and drops the saved buffer', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await primeWorkspaceRecovery();
      harness.files.set('/w/main.tex', 'start');
      const doc = await harness.service.openFile('/w/main.tex');
      doc.replaceRange(doc.getLength(), doc.getLength(), ' typed');

      // A pass is armed but has not run.
      expect(harness.writes).toEqual([]);
      await harness.service.save(doc);

      // The save wrote the mirror itself; the saved buffer is not in it.
      expect(harness.writes.length).toBeGreaterThanOrEqual(1);
      expect(harness.writes[harness.writes.length - 1]['/w/main.tex']).toBeUndefined();

      // And the armed pass cannot resurrect it afterwards.
      const writesAfterSave = harness.writes.length;
      vi.advanceTimersByTime(WINDOW_MS * 4);
      await Promise.resolve();
      expect(harness.writes.length).toBe(writesAfterSave);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes on close, and drops the closed buffer', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await primeWorkspaceRecovery();
      harness.files.set('/w/main.tex', 'start');
      const doc = await harness.service.openFile('/w/main.tex');
      doc.replaceRange(doc.getLength(), doc.getLength(), ' typed');

      expect(harness.service.closeDocument('/w/main.tex', { force: true })).toBe(true);
      await Promise.resolve();

      expect(harness.writes.length).toBeGreaterThanOrEqual(1);
      expect(harness.writes[harness.writes.length - 1]['/w/main.tex']).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes on the shutdown hook', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await primeWorkspaceRecovery();
      harness.files.set('/w/main.tex', 'start');
      const doc = await harness.service.openFile('/w/main.tex');
      doc.replaceRange(doc.getLength(), doc.getLength(), ' unsaved');

      expect(harness.writes).toEqual([]);
      await harness.service.flushAutoSave();
      expect(harness.writes[harness.writes.length - 1]['/w/main.tex'].content).toBe('start unsaved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes when the window is going away', async () => {
    const harness = createHarness();
    await primeWorkspaceRecovery();
    harness.files.set('/w/main.tex', 'start');
    const doc = await harness.service.openFile('/w/main.tex');
    doc.replaceRange(doc.getLength(), doc.getLength(), ' typed');

    // The renderer is never told that the application is quitting, so the events
    // the browser does raise are what stands in for it.
    for (const event of ['beforeunload', 'pagehide', 'blur']) {
      expect(harness.listeners.get(event)?.length ?? 0).toBe(1);
    }
    harness.emit('beforeunload');
    await Promise.resolve();
    expect(harness.writes[harness.writes.length - 1]['/w/main.tex'].content).toBe('start typed');
  });
});
