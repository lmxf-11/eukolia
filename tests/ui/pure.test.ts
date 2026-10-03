/**
 * Pure-helper tests for the presentational components.
 *
 * The components themselves need a DOM and app state; the logic that is easy to
 * get wrong — fuzzy highlighting, `:line:col` parsing, ratio clamping, keybinding
 * capture — is exported as plain functions and is covered here.
 *
 * `vitest` runs in the `node` environment, so the preload bridge the service
 * singletons touch at import time is stubbed before the component modules are
 * evaluated (that is what `vi.hoisted` is for).
 */

import { describe, expect, it, vi } from 'vitest';

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
  globals.window = { eukoliaApi: ipc, addEventListener: () => undefined, removeEventListener: () => undefined };
});

const { fuzzyHighlight, fuzzyScore } = await import('../../src/renderer/ui/components/CommandPalette');
const { parseQuickOpenQuery, flattenOutline } = await import('../../src/renderer/ui/components/QuickOpen');
const { clampRatio, ratioFromPointerDelta, readStoredRatio, dividerGeometry, RESET_RATIO } = await import('../../src/renderer/ui/components/SplitPane');
const { clampDropIndex } = await import('../../src/renderer/ui/components/TabBar');
const { clampPanelHeight, isNearBottom } = await import('../../src/renderer/ui/components/BottomPanel');
const { formatDuration, buildStatusLabel } = await import('../../src/renderer/ui/components/StatusBar');
const { captureBinding, parseListValue, formatListValue, buildShortcutGroups } = await import('../../src/renderer/ui/components/SettingsView');
const { validateExplorerName, resolveExplorerTarget } = await import('../../src/renderer/ui/components/explorerActions');
const { defaultExpandedPaths } = await import('../../src/renderer/ui/components/Sidebar');
const { parseKeybinding } = await import('../../src/renderer/core/commands');
const { highlightSearchHit } = await import('../../src/renderer/ui/components/Sidebar');

// ---------------------------------------------------------------------------
// Command palette / quick open — fuzzy matching and highlighting
// ---------------------------------------------------------------------------

describe('fuzzyHighlight', () => {
  it('marks nothing when the query is empty', () => {
    expect(fuzzyHighlight('Save All', '')).toEqual([{ text: 'Save All', matched: false }]);
    expect(fuzzyHighlight('Save All', '   ')).toEqual([{ text: 'Save All', matched: false }]);
  });

  it('highlights a contiguous, case-insensitive substring', () => {
    expect(fuzzyHighlight('Save All', 'all')).toEqual([
      { text: 'Save ', matched: false },
      { text: 'All', matched: true }
    ]);
    expect(fuzzyHighlight('Save All', 've')).toEqual([
      { text: 'Sa', matched: false },
      { text: 've', matched: true },
      { text: ' All', matched: false }
    ]);
  });

  it('falls back to marking fuzzy subsequence characters', () => {
    expect(fuzzyHighlight('Toggle Sidebar', 'tsb')).toEqual([
      { text: 'T', matched: true },
      { text: 'oggle ', matched: false },
      { text: 'S', matched: true },
      { text: 'ide', matched: false },
      { text: 'b', matched: true },
      { text: 'ar', matched: false }
    ]);
  });

  it('marks nothing when the text cannot match', () => {
    expect(fuzzyHighlight('Save', 'zz')).toEqual([{ text: 'Save', matched: false }]);
  });

  it('handles empty text', () => {
    expect(fuzzyHighlight('', 'abc')).toEqual([]);
  });
});

describe('fuzzyScore', () => {
  it('scores every non-empty query above no-match', () => {
    expect(fuzzyScore('zz', 'Save')).toBe(0);
    expect(fuzzyScore('save', 'Save')).toBeGreaterThan(0);
  });

  it('prefers prefix and word-boundary hits', () => {
    expect(fuzzyScore('a', 'An Apple')).toBeGreaterThan(fuzzyScore('a', 'Save All'));
    expect(fuzzyScore('all', 'Save All')).toBeGreaterThan(fuzzyScore('all', 'Smaller'));
  });

  it('treats an empty query as a neutral match', () => {
    expect(fuzzyScore('', 'anything')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Quick open — query parsing
// ---------------------------------------------------------------------------

describe('parseQuickOpenQuery', () => {
  it('accepts a bare file name', () => {
    expect(parseQuickOpenQuery('main.tex')).toEqual({ path: 'main.tex', symbol: false, symbolQuery: '' });
  });

  it('parses a :line suffix', () => {
    expect(parseQuickOpenQuery('main.tex:120')).toEqual({ path: 'main.tex', line: 120, column: undefined, symbol: false, symbolQuery: '' });
  });

  it('parses a :line:col suffix', () => {
    expect(parseQuickOpenQuery('chapters/intro.tex:12:8')).toEqual({
      path: 'chapters/intro.tex',
      line: 12,
      column: 8,
      symbol: false,
      symbolQuery: ''
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseQuickOpenQuery('  main.tex:3  ')).toMatchObject({ path: 'main.tex', line: 3 });
  });

  it('clamps a zero line or column to 1', () => {
    expect(parseQuickOpenQuery('main.tex:0')).toMatchObject({ path: 'main.tex', line: 1 });
    expect(parseQuickOpenQuery('main.tex:4:0')).toMatchObject({ path: 'main.tex', line: 4, column: 1 });
  });

  it('ignores a suffix that would leave the path empty', () => {
    expect(parseQuickOpenQuery(':12')).toEqual({ path: ':12', symbol: false, symbolQuery: '' });
  });

  it('keeps a Windows drive path intact', () => {
    expect(parseQuickOpenQuery('C:\\docs\\main.tex')).toEqual({ path: 'C:\\docs\\main.tex', symbol: false, symbolQuery: '' });
  });

  it('switches to symbol mode on a leading @', () => {
    expect(parseQuickOpenQuery('@introduction')).toEqual({ path: '', symbol: true, symbolQuery: 'introduction' });
    expect(parseQuickOpenQuery('@')).toEqual({ path: '', symbol: true, symbolQuery: '' });
  });
});

describe('flattenOutline', () => {
  it('walks the outline depth first and keeps the level', () => {
    const flat = flattenOutline([
      {
        level: 0,
        title: 'Introduction',
        offset: 0,
        line: 3,
        labels: ['sec:intro'],
        command: 'section',
        starred: false,
        children: [
          { level: 1, title: 'Motivation', offset: 20, line: 8, labels: [], command: 'subsection', starred: false, children: [] }
        ]
      },
      { level: 0, title: 'Preliminaries', offset: 60, line: 20, labels: [], command: 'section', starred: true, children: [] }
    ]);

    expect(flat.map((entry) => entry.title)).toEqual(['Introduction', 'Motivation', 'Preliminaries']);
    expect(flat.map((entry) => entry.level)).toEqual([0, 1, 0]);
    expect(flat[0].labels).toEqual(['sec:intro']);
    expect(flat[1].line).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Split pane
// ---------------------------------------------------------------------------

describe('clampRatio', () => {
  it('clamps into the configured range', () => {
    expect(clampRatio(150, 20, 85)).toBe(85);
    expect(clampRatio(10, 20, 85)).toBe(20);
    expect(clampRatio(50, 20, 85)).toBe(50);
  });

  it('defaults to a full 0–100 range', () => {
    expect(clampRatio(50)).toBe(50);
    expect(clampRatio(-10)).toBe(0);
    expect(clampRatio(1000)).toBe(100);
  });

  it('falls back to the minimum for a non-finite value', () => {
    expect(clampRatio(Number.NaN, 20, 85)).toBe(20);
    expect(clampRatio(Number.POSITIVE_INFINITY, 0, 100)).toBe(100);
  });

  it('exposes 50 as the double-click reset target', () => {
    expect(clampRatio(RESET_RATIO, 20, 85)).toBe(50);
  });
});

describe('ratioFromPointerDelta', () => {
  it('converts pixels into a ratio', () => {
    expect(ratioFromPointerDelta(50, 25, 100, 0, 100)).toBe(75);
    expect(ratioFromPointerDelta(50, -25, 100, 0, 100)).toBe(25);
  });

  it('clamps the result', () => {
    expect(ratioFromPointerDelta(95, 25, 100, 20, 85)).toBe(85);
    expect(ratioFromPointerDelta(22, -25, 100, 20, 85)).toBe(20);
  });

  it('ignores a degenerate container size', () => {
    expect(ratioFromPointerDelta(50, 25, 0, 0, 100)).toBe(50);
  });
});

describe('readStoredRatio', () => {
  it('uses the initial value without a storage key', () => {
    expect(readStoredRatio(undefined, 42, 20, 85)).toBe(42);
  });

  it('reads, validates and clamps a stored value', () => {
    const store = new Map<string, string>([['split', '70'], ['bad', 'not-a-number'], ['low', '5']]);
    (globalThis as unknown as Record<string, unknown>).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value)
    };

    expect(readStoredRatio('split', 50, 20, 85)).toBe(70);
    expect(readStoredRatio('bad', 50, 20, 85)).toBe(50);
    expect(readStoredRatio('low', 50, 20, 85)).toBe(20);
    expect(readStoredRatio('missing', 33, 20, 85)).toBe(33);
  });
});

describe('dividerGeometry', () => {
  it('draws a one-pixel rule with a wider grab box around it', () => {
    const geometry = dividerGeometry('horizontal');
    expect(geometry.rulePixels).toBe(1);
    // Wide enough to grab, narrow enough to stay a divider rather than a bar.
    expect(geometry.hitAreaPixels).toBeGreaterThanOrEqual(4);
    expect(geometry.hitAreaPixels).toBeLessThanOrEqual(6);
    expect(geometry.hitAreaPixels).toBeGreaterThan(geometry.rulePixels);
  });

  it('centres the rule inside the grab box by overhanging both panes equally', () => {
    for (const direction of ['horizontal', 'vertical'] as const) {
      const geometry = dividerGeometry(direction);
      expect(geometry.overhangPixels * 2 + geometry.rulePixels).toBe(geometry.hitAreaPixels);
    }
  });

  it('uses the cursor that matches the axis the panes are split along', () => {
    expect(dividerGeometry('horizontal').cursor).toBe('col-resize');
    expect(dividerGeometry('vertical').cursor).toBe('row-resize');
  });
});

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

describe('clampDropIndex', () => {
  it('moves a tab to the end of an unpinned strip', () => {
    expect(clampDropIndex(3, 0, 0, 3)).toBe(2);
    expect(clampDropIndex(0, 2, 0, 3)).toBe(0);
    expect(clampDropIndex(1, 0, 0, 3)).toBe(0);
  });

  it('keeps unpinned tabs behind the pinned block', () => {
    // [pinned, a, b] — dragging `a` to the front still lands after the pin.
    expect(clampDropIndex(0, 1, 1, 3)).toBe(1);
    expect(clampDropIndex(3, 1, 1, 3)).toBe(2);
  });

  it('keeps pinned tabs inside the pinned block', () => {
    // [p0, p1, u0] — dropping p0 on the left half of p1 leaves it where it is…
    expect(clampDropIndex(1, 0, 2, 3)).toBe(0);
    // …and on the right half it swaps places with p1.
    expect(clampDropIndex(2, 0, 2, 3)).toBe(1);
    // Dragging a pinned tab towards the unpinned region cannot cross the block.
    expect(clampDropIndex(3, 0, 1, 3)).toBe(0);
  });

  it('handles an empty strip', () => {
    expect(clampDropIndex(0, -1, 0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bottom panel
// ---------------------------------------------------------------------------

describe('clampPanelHeight', () => {
  it('keeps the panel inside its usable range', () => {
    expect(clampPanelHeight(50)).toBe(90);
    expect(clampPanelHeight(5000)).toBe(720);
    expect(clampPanelHeight(300)).toBe(300);
  });

  it('falls back to the default for a non-finite height', () => {
    expect(clampPanelHeight(Number.NaN)).toBe(210);
  });
});

describe('isNearBottom', () => {
  it('detects a container parked at the bottom', () => {
    expect(isNearBottom(900, 100, 1000)).toBe(true);
    expect(isNearBottom(980, 100, 1000)).toBe(true);
    expect(isNearBottom(500, 100, 1000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

describe('formatDuration / buildStatusLabel', () => {
  it('formats milliseconds and seconds', () => {
    expect(formatDuration(500)).toBe('500 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(15000)).toBe('15.0 s');
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });

  it('labels every build status', () => {
    expect(buildStatusLabel('idle')).toBe('Idle');
    expect(buildStatusLabel('running')).toBe('Building…');
    expect(buildStatusLabel('succeeded')).toBe('Build succeeded');
    expect(buildStatusLabel('failed')).toBe('Build failed');
    expect(buildStatusLabel('cancelled')).toBe('Build cancelled');
  });
});

// ---------------------------------------------------------------------------
// Settings — keybinding capture and list editing
// ---------------------------------------------------------------------------

const keyEvent = (key: string, modifiers: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...modifiers
});

describe('captureBinding', () => {
  it('builds a binding the command registry can parse back', () => {
    const capture = captureBinding(keyEvent('S', { ctrlKey: true, shiftKey: true }));
    expect(capture).toEqual({ kind: 'binding', binding: 'Ctrl+Shift+S' });
    if (capture.kind !== 'binding') throw new Error('expected a binding');
    const parsed = parseKeybinding(capture.binding);
    expect(parsed).toMatchObject({ ctrl: true, shift: true, alt: false, meta: false, key: 's' });
  });

  it('normalises named keys the way parseKeybinding expects', () => {
    expect(captureBinding(keyEvent(' '))).toEqual({ kind: 'binding', binding: 'Space' });
    expect(captureBinding(keyEvent('Enter'))).toEqual({ kind: 'binding', binding: 'Enter' });
    expect(captureBinding(keyEvent('ArrowUp', { ctrlKey: true }))).toEqual({ kind: 'binding', binding: 'Ctrl+ArrowUp' });

    expect(parseKeybinding('Space')?.key).toBe('space');
    expect(parseKeybinding('Enter')?.key).toBe('enter');
    expect(parseKeybinding('Ctrl+ArrowUp')?.key).toBe('arrowup');
  });

  it('cancels on Escape and clears on Backspace or Delete', () => {
    expect(captureBinding(keyEvent('Escape'))).toEqual({ kind: 'cancel' });
    expect(captureBinding(keyEvent('Backspace'))).toEqual({ kind: 'clear' });
    expect(captureBinding(keyEvent('Delete'))).toEqual({ kind: 'clear' });
  });

  it('waits while only modifiers are held', () => {
    expect(captureBinding(keyEvent('Control', { ctrlKey: true }))).toEqual({ kind: 'ignore' });
    expect(captureBinding(keyEvent('Shift', { shiftKey: true }))).toEqual({ kind: 'ignore' });
  });

  it('refuses the "+" key, which the binding syntax cannot express', () => {
    expect(captureBinding(keyEvent('+', { ctrlKey: true }))).toEqual({ kind: 'ignore' });
  });
});

describe('list settings', () => {
  it('splits on commas and newlines and drops blanks', () => {
    expect(parseListValue('a, b\nc\n\n  d  ')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseListValue('')).toEqual([]);
  });

  it('formats a list back into one entry per line', () => {
    expect(formatListValue(['aux', 'log'])).toBe('aux\nlog');
    expect(formatListValue('not-a-list')).toBe('');
  });
});

describe('buildShortcutGroups', () => {
  it('lists every visible command, bound or not, with its effective binding', () => {
    const groups = buildShortcutGroups(
      [
        { id: 'a', title: 'Alpha', category: 'File' },
        { id: 'b', title: 'Beta', category: 'File' },
        { id: 'c', title: 'Hidden', category: 'File', hidden: true }
      ],
      [
        { commandId: 'a', binding: 'Ctrl+A' },
        { commandId: 'a', binding: 'Ctrl+Alt+A' }
      ],
      (id) => (id === 'b' ? undefined : 'Ctrl+A')
    );

    expect(groups.map((group) => group.commandId)).toEqual(['a', 'b']);
    expect(groups[0]).toMatchObject({ binding: 'Ctrl+A', secondary: ['Ctrl+Alt+A'] });
    expect(groups[1]).toMatchObject({ binding: '', secondary: [] });
  });
});

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

describe('validateExplorerName', () => {
  it('accepts an ordinary file name', () => {
    expect(validateExplorerName('main.tex')).toBeNull();
    expect(validateExplorerName('  main.tex  ')).toBeNull();
  });

  it('rejects empty names and relative segments', () => {
    expect(validateExplorerName('')).toBe('Enter a name');
    expect(validateExplorerName('..')).toContain('"." or ".."');
    expect(validateExplorerName('a/../b')).toContain('"." or ".."');
  });

  it('only allows separators when a path is expected', () => {
    expect(validateExplorerName('sections/intro.tex')).toBe('A name cannot contain a path separator');
    expect(validateExplorerName('sections/intro.tex', { allowPath: true })).toBeNull();
  });

  it('rejects characters and names the platform refuses', () => {
    expect(validateExplorerName('a<b.tex')).toContain('< >');
    expect(validateExplorerName('name.')).toContain('dot');
    expect(validateExplorerName('CON')).toContain('reserved');
    expect(validateExplorerName('lpt1.txt')).toContain('reserved');
  });
});

describe('resolveExplorerTarget', () => {
  it('joins a name onto a directory with the directory separator', () => {
    expect(resolveExplorerTarget('C:\\project', 'sections/intro.tex')).toBe('C:\\project\\sections\\intro.tex');
    expect(resolveExplorerTarget('/home/me/project', 'intro.tex')).toBe('/home/me/project/intro.tex');
  });
});

// ---------------------------------------------------------------------------
// Explorer tree defaults
// ---------------------------------------------------------------------------

describe('defaultExpandedPaths', () => {
  const tree = [
    {
      name: 'chapters',
      path: '/p/chapters',
      isDirectory: true,
      size: 0,
      mtimeMs: 0,
      children: [
        {
          name: 'one',
          path: '/p/chapters/one',
          isDirectory: true,
          size: 0,
          mtimeMs: 0,
          children: [{ name: 'deep', path: '/p/chapters/one/deep', isDirectory: true, size: 0, mtimeMs: 0, children: [] }]
        },
        { name: 'intro.tex', path: '/p/chapters/intro.tex', isDirectory: false, size: 10, mtimeMs: 0 }
      ]
    },
    { name: 'main.tex', path: '/p/main.tex', isDirectory: false, size: 10, mtimeMs: 0 }
  ];

  it('expands the first two levels only', () => {
    const expanded = defaultExpandedPaths(tree);
    expect([...expanded].sort()).toEqual(['/p/chapters', '/p/chapters/one']);
  });

  it('can collect every directory', () => {
    expect([...defaultExpandedPaths(tree, Number.POSITIVE_INFINITY)].sort()).toEqual([
      '/p/chapters',
      '/p/chapters/one',
      '/p/chapters/one/deep'
    ]);
  });
});

// ---------------------------------------------------------------------------
// Search result rendering helpers
// ---------------------------------------------------------------------------

describe('highlightSearchHit', () => {
  it('returns the plain text when there is nothing to mark', () => {
    expect(highlightSearchHit({ path: 'a.tex', line: 1, column: 1, text: 'hello', matchLength: 0 })).toBe('hello');
    expect(highlightSearchHit({ path: 'a.tex', line: 1, column: 40, text: 'hello', matchLength: 3 })).toBe('hello');
  });

  it('splits the line around the match', () => {
    const rendered = highlightSearchHit({ path: 'a.tex', line: 1, column: 7, text: 'find the match here', matchLength: 5 });
    const children = (rendered as { props: { children: unknown[] } }).props.children;
    expect(children[0]).toBe('find t');
    expect(children[1]).toMatchObject({ type: 'mark' });
    expect(children[2]).toBe('tch here');
  });
});
