// @vitest-environment jsdom
/**
 * Snippet Manager rendering.
 *
 * The pure helpers are pinned down in `snippets-manager.test.ts`. This file
 * mounts the real component, because the claims the two-mode editor makes are
 * *composition* claims that a unit test cannot see:
 *
 *  * switching from Simple to Advanced shows the fields Simple does not, and
 *    switching back does not lose them — a property of the mounted form, not of
 *    any one function in it;
 *  * the yellow triangle opens the list of problems, with the field each one
 *    belongs to, rather than a count;
 *  * a problem is shown under the field it belongs to as well as in the list, so
 *    the two cannot disagree.
 *
 * The store is a real `SnippetStore` over a fake filesystem, so what the manager
 * edits is the document it would actually write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The module touches the preload bridge at import time, so it is stubbed first.
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
    (globals.window as Record<string, unknown>).confirm = () => false;
  } else {
    globals.window = {
      eukoliaApi: ipc,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      confirm: () => false
    };
  }
});

const { SnippetManager, resetRememberedSnippetManagerState, getRememberedSnippetManagerState, saveRememberedSnippetManagerState } =
  await import('../../src/renderer/ui/components/SnippetManager');
const { SnippetStore } = await import('../../src/renderer/snippets/store');
const { EUSNIPS_VERSION } = await import('../../src/renderer/snippets/eusnips');
const { SnippetEngine } = await import('../../src/renderer/snippets/engine');
const { loadEusnipsIntoEngine } = await import('../../src/renderer/snippets/eusnips');

type EusnipsFile = import('../../src/renderer/snippets/eusnips').EusnipsFile;

/** A store over a string, with the same interface the preload bridge supplies. */
function memoryStore(initial: EusnipsFile) {
  let text: string | null = `${JSON.stringify(initial, null, 2)}\n`;
  const written: string[] = [];
  const reading = () => ({
    path: 'C:/Users/X/AppData/Roaming/eukolia/User/snippets/snippets.json',
    directory: 'C:/Users/X/AppData/Roaming/eukolia/User/snippets',
    exists: text !== null,
    text,
    legacyFiles: [] as string[]
  });

  const store = new SnippetStore(
    {
      read: async () => reading(),
      write: async (next: string) => {
        written.push(next);
        text = next;
        return { exists: true };
      },
      watch: async () => reading(),
      onChange: () => () => undefined,
      readLegacy: async () => []
    },
    () => new SnippetEngine()
  );
  return { store, written };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetRememberedSnippetManagerState();
  try {
    localStorage.clear();
  } catch {}
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(
  store: InstanceType<typeof SnippetStore>,
  props: Record<string, unknown> = {}
): Promise<void> {
  await act(async () => {
    root.render(React.createElement(SnippetManager, { store: store as never, ...props }));
  });
}

const text = (): string => container.textContent ?? '';

/** The element with this aria-label, or null. */
const byLabel = (label: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[aria-label="${label}"]`);

/** A button whose text is exactly this. */
const button = (label: string): HTMLButtonElement | null =>
  ([...container.querySelectorAll('button')] as HTMLButtonElement[]).find(
    (element) => element.textContent?.trim() === label
  ) ?? null;

const click = async (element: HTMLElement | null): Promise<void> => {
  expect(element, 'the control should be on screen').not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

/**
 * Hovers or focuses the triangle; React listens for the bubbling forms.
 */
const reveal = async (element: HTMLElement, event: 'mouseover' | 'focusin'): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent(event, { bubbles: true }));
  });
};

const setInputValue = async (input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  await act(async () => {
    const tracker = (input as any)._valueTracker;
    if (tracker) {
      tracker.setValue('');
    }
    const proto = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
};


const IDLE = { trigger: 'shrug', description: 'shrug', body: '\\shrug{$1}$0' };

describe('Simple and Advanced modes', () => {
  it('shows the common fields in Simple and the rest in Advanced', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ ...IDLE, id: 'shrug', multiline: true, tags: ['grouping'], metadata: { importedFrom: 'a.hsnips' } }]
    });
    await store.start();
    await mount(store);

    // Simple holds what a snippet needs to be useful: what it matches, whether
    // it fires by itself, whether it is offered, how it ranks, where it applies,
    // and what it is called.
    expect(byLabel('Trigger')).not.toBeNull();
    expect(byLabel('Automatic')).not.toBeNull();
    expect(byLabel('Hidden')).not.toBeNull();
    expect(byLabel('Snippet priority')).not.toBeNull();
    expect(byLabel('Snippet context')).not.toBeNull();
    expect(byLabel('Snippet description')).not.toBeNull();
    expect(byLabel('Snippet body')).not.toBeNull();
    // Every boolean is a tick box rather than a two-option list.
    for (const label of ['Automatic', 'Hidden']) {
      expect(byLabel(label)!.tagName).toBe('INPUT');
      expect((byLabel(label) as HTMLInputElement).type).toBe('checkbox');
    }
    // A trigger is one kind of thing now, so there is no kind to choose; the box
    // grows with the pattern instead of scrolling it sideways.
    expect(byLabel('Regular expression')).toBeNull();
    expect(byLabel('Trigger')!.tagName).toBe('TEXTAREA');
    // Flags are Advanced's business.
    expect(byLabel('Regular expression flags')).toBeNull();

    // ID is editable in the header bar in Simple mode.
    expect(byLabel('Snippet ID')).not.toBeNull();
    // Advanced-only controls are not there yet.
    expect(byLabel('Snippet metadata')).toBeNull();
    expect(byLabel('Trigger boundary')).toBeNull();
    expect(byLabel('Snippet tags')).toBeNull();

    await click(button('Advanced'));

    expect(byLabel('Snippet metadata')).not.toBeNull();
    expect(byLabel('Snippet namespace')).toBeNull(); // still the snippet section
    expect(byLabel('Trigger boundary')).not.toBeNull();
    expect(byLabel('Regular expression flags')).not.toBeNull();
    expect(byLabel('Snippet tags')).not.toBeNull();
    // Advanced keeps everything Simple showed.
    expect(byLabel('Snippet ID')).not.toBeNull();
    expect(byLabel('Trigger')).not.toBeNull();
    expect(byLabel('Snippet description')).not.toBeNull();
    expect(byLabel('Snippet body')).not.toBeNull();
  });

  it('offers only the contexts the engine evaluates in Simple', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ ...IDLE, id: 'shrug', context: 'math' }]
    });
    await store.start();
    await mount(store);

    const offered = (): string[] =>
      [...(byLabel('Snippet context') as HTMLSelectElement).options].map((option) => option.textContent ?? '');
    expect(offered()).toEqual(['Everywhere', 'Mathematics only', 'Text only']);

    await click(button('Advanced'));
    expect(offered()).toContain('Inside an environment');
    expect(offered()).toContain('With a package');
  });

  it('keeps a context Simple has no option for, rather than rewriting it', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ ...IDLE, id: 'shrug', context: { type: 'environment', name: 'align' } }]
    });
    await store.start();
    await mount(store);

    // The value is still on screen — selected, and named — so looking at an
    // entry in Simple can never be what changes it.
    const select = byLabel('Snippet context') as HTMLSelectElement;
    expect(select.value).toBe('environment');
    expect(select.selectedOptions[0].textContent).toContain('Inside an environment');
    expect((store.getSnapshot().file as EusnipsFile).snippets[0].context).toEqual({
      type: 'environment',
      name: 'align'
    });
  });

  it('stays quiet in Simple: the fields are there, the explanations are not', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ ...IDLE, id: 'shrug', body: 'a $1 b' }]
    });
    await store.start();
    await mount(store);

    const simple = text();
    expect(simple).toContain('Trigger');
    expect(simple).toContain('Body');
    expect(simple).not.toContain('Matched against the text before the cursor');
    expect(simple).not.toContain('Without a completion list');
    expect(simple).not.toContain('Higher wins when more than one snippet matches');
    expect(simple).not.toContain('What the snippet inserts');
    expect(simple).not.toContain('Shown in the completion list and in the snippet list');
    // The inspector is a tool for reading the format, so it lives in Advanced.
    expect(simple).not.toContain('Parsed body');
    // What the body *does* is still said: that is not guidance, it is the
    // consequence of what is in the box.
    expect(simple).toContain('Tab stops: $1');

    await click(button('Advanced'));
    const advanced = text();
    expect(advanced).toContain('Matched against the text before the cursor');
    expect(advanced).toContain('What the snippet inserts');
    expect(advanced).toContain('Parsed body');
  });

  it('draws every boolean as one tick box, in both modes', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ ...IDLE, id: 'shrug' }]
    });
    await store.start();
    await mount(store);

    // `Enabled` belongs to the behaviour section in Advanced, and nowhere else:
    // the same property drawn twice would be two controls that can disagree.
    const enabled = (): number => container.querySelectorAll('[aria-label="Enabled"]').length;
    expect(enabled()).toBe(0);
    await click(button('Advanced'));
    expect(enabled()).toBe(1);
  });

  it('does not lose a field when the mode changes', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ ...IDLE, id: 'shrug', multiline: true, tags: ['grouping'], metadata: { importedFrom: 'a.hsnips' } }]
    });
    await store.start();
    await mount(store);

    await click(button('Advanced'));
    await click(button('Simple'));

    // The entry is the same object throughout: a property the Simple controls do
    // not show is still in the file, unchanged.
    const snippet = store.getSnapshot().file?.snippets[0];
    expect(snippet).toMatchObject({
      id: 'shrug',
      multiline: true,
      tags: ['grouping'],
      metadata: { importedFrom: 'a.hsnips' }
    });
  });

  it('shows a change made in one mode when the other is switched on', async () => {
    // A text field is driven by React's own change events, which this environment
    // cannot synthesise faithfully; the store's edit path is what the manager
    // actually calls, and it is the same path for every mode. Driving it directly
    // tests the claim that matters — both modes render the one document, live.
    const { store, written } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ ...IDLE, id: 'shrug' }]
    });
    await store.start();
    await mount(store);

    await act(async () => {
      await store.update((file) => ({
        ...file,
        snippets: file.snippets.map((entry) => ({ ...entry, description: 'a shrug' }))
      }));
    });
    await store.flush();

    // Simple shows it…
    expect((byLabel('Snippet description') as HTMLInputElement).value).toBe('a shrug');
    // …and so does Advanced, which is the same entry seen through more controls.
    await click(button('Advanced'));
    expect((byLabel('Snippet description') as HTMLInputElement).value).toBe('a shrug');

    const onDisk = JSON.parse(written[written.length - 1]) as EusnipsFile;
    expect(onDisk.snippets[0].description).toBe('a shrug');
  });

  it('edits an entry from Advanced mode', async () => {
    const { store, written } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ ...IDLE, id: 'shrug' }]
    });
    await store.start();
    await mount(store);

    await click(button('Advanced'));

    // The id button is a real edit through the manager's own change callback, and
    // it writes an id that nothing in the file is using.
    await click(button('Generate'));
    await store.flush();

    const onDisk = JSON.parse(written[written.length - 1]) as EusnipsFile;
    expect(onDisk.snippets[0].id).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]{6}$/);
    expect(onDisk.snippets[0].id).not.toBe('shrug');
  });

  it('offers the Advanced file properties only in Advanced', async () => {
    const { store } = memoryStore({ version: EUSNIPS_VERSION, language: 'latex', snippets: [IDLE] });
    await store.start();
    await mount(store);

    await click(button('Library'));
    expect(byLabel('Library name')).not.toBeNull();
    expect(byLabel('Included snippet files')).toBeNull();

    await click(button('Advanced'));
    expect(byLabel('Included snippet files')).not.toBeNull();
    expect(byLabel('Global variables')).not.toBeNull();
    expect(byLabel('Library metadata')).not.toBeNull();
  });
});

describe('the warning triangle', () => {
  it('is absent for a snippet with nothing wrong', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [IDLE]
    });
    await store.start();
    await mount(store);
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('lists the specific problems, named by field, when hovered', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ trigger: { pattern: 'a`b' }, body: 'b', priority: 1.5 }]
    });
    await store.start();
    await mount(store);

    // The marker is reachable and labelled with what it will show.
    const marker = container.querySelector<HTMLElement>('[role="button"][aria-expanded]');
    expect(marker).not.toBeNull();
    const label = marker!.getAttribute('aria-label') ?? '';
    expect(label).toContain('error');
    expect(label).toContain('warning');

    await act(async () => {
      marker!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tooltip, 'hovering the triangle opens the problem list').not.toBeNull();
    const shown = tooltip!.textContent ?? '';
    // The list says which field and what is wrong — not "this snippet is invalid".
    expect(shown).toContain('Priority');
    expect(shown).toMatch(/whole number/);
    expect(shown).toContain('Trigger');
    expect(shown).toMatch(/backtick/);
  });

  it('explains an empty trigger well enough to fix it', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ id: 'fresh', trigger: { pattern: '' }, body: '' }]
    });
    await store.start();
    await mount(store);

    const marker = container.querySelector<HTMLElement>('[role="button"][aria-expanded]');
    expect(marker).not.toBeNull();
    // `focusin`, not `focus`: React delegates events at the root, so only the
    // bubbling form reaches the listener it installed.
    await reveal(marker!, 'focusin');
    const shown = container.querySelector<HTMLElement>('[role="tooltip"]')?.textContent ?? '';
    expect(shown).toContain('Trigger');
    expect(shown).toContain('never match');
    expect(shown).toContain('Type the text');
  });

  it('shows the same problem under the field it belongs to', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ id: 'fresh', trigger: { pattern: '' }, body: 'x' }]
    });
    await store.start();
    await mount(store);

    // Under the trigger box, in the form — the list's tooltip and this sentence
    // come from one call, so they cannot disagree.
    expect(text()).toContain('The trigger is empty');
    expect(text()).toContain('Type the text that should expand it.');
  });

  it('keeps the triangle on the entry, not on the form, after a mode switch', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ id: 'fresh', trigger: { pattern: '' }, body: 'x' }]
    });
    await store.start();
    await mount(store);

    await click(button('Advanced'));
    const marker = container.querySelector<HTMLElement>('[role="button"][aria-expanded]');
    expect(marker).not.toBeNull();
    await reveal(marker!, 'focusin');
    expect(container.querySelector<HTMLElement>('[role="tooltip"]')?.textContent ?? '').toContain('never match');
  });
});

describe('opening on one entry', () => {
  it('selects the entry the shell pointed at', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [
        { ...IDLE, id: 'first', description: 'first' },
        { ...IDLE, id: 'second', description: 'second' }
      ]
    });
    await store.start();
    await mount(store, { focusSnippetId: 'second' });

    // The form is showing the entry that was asked for, not the first row.
    expect((byLabel('Snippet description') as HTMLInputElement).value).toBe('second');
    const selected = container.querySelector('[aria-pressed="true"]');
    expect(selected?.textContent).toContain('second');
  });

  it('does nothing when the entry is not in the library', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ ...IDLE, id: 'only', description: 'only' }]
    });
    await store.start();
    await mount(store, { focusSnippetId: 'gone' });

    // A snippet from a hand-written `.hsnips` file has no library entry: the
    // window opens on the first row rather than on nothing.
    expect((byLabel('Snippet description') as HTMLInputElement).value).toBe('only');
  });
});

describe('unsaved changes', () => {
  it('marks the edited row, and unmarks it once the file is written', async () => {
    const { store, written } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ ...IDLE, id: 'shrug' }]
    });
    await store.start();
    await mount(store);

    const dots = (): number => container.querySelectorAll('[aria-label="Unsaved changes"]').length;
    // Nothing has been touched yet, so nothing is marked — the file on disk and
    // the document in memory are the same thing.
    expect(dots()).toBe(0);

    await act(async () => {
      // The edit path the form uses: applied in memory, not written.
      store.apply({
        ...(store.getSnapshot().file as EusnipsFile),
        snippets: [{ ...IDLE, id: 'shrug', description: 'changed' }]
      });
    });

    expect(dots()).toBe(1);
    expect(written).toHaveLength(0);
    expect(container.textContent).toContain('1 unsaved snippet');

    // Closing is what writes: the same call the window makes on the way out.
    await act(async () => {
      await store.flush();
    });

    expect(written).toHaveLength(1);
    expect(dots()).toBe(0);
    expect(container.textContent).toContain('Saved');
  });
});

describe('drag and drop reordering', () => {
  it('renders rows as draggable with grip handles and reorders on drop', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [
        { ...IDLE, id: 'first', description: 'first' },
        { ...IDLE, id: 'second', description: 'second' },
        { ...IDLE, id: 'third', description: 'third' }
      ]
    });
    await store.start();
    await mount(store);

    const rows = container.querySelectorAll<HTMLElement>('[role="button"][aria-pressed]');
    expect(rows.length).toBe(3);
    expect(rows[0].getAttribute('draggable')).toBe('true');
    expect(rows[0].querySelector('svg')).not.toBeNull();

    vi.spyOn(rows[2], 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 140,
      height: 40,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 100,
      toJSON: () => {}
    });

    const dataStore: Record<string, string> = {};
    const dataTransfer = {
      setData: (format: string, data: string) => {
        dataStore[format] = data;
      },
      getData: (format: string) => dataStore[format] ?? '',
      effectAllowed: 'move',
      dropEffect: 'none'
    };

    // Drag row 0 ('first') and drop after row 2 ('third') -> clientY = 130 (> 120 midY)
    await act(async () => {
      const dragStartEvent = new Event('dragstart', { bubbles: true });
      Object.assign(dragStartEvent, { dataTransfer });
      rows[0].dispatchEvent(dragStartEvent);
    });

    await act(async () => {
      const dragOverEvent = new Event('dragover', { bubbles: true, cancelable: true });
      Object.assign(dragOverEvent, { dataTransfer, clientY: 130 });
      rows[2].dispatchEvent(dragOverEvent);
    });

    await act(async () => {
      const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
      Object.assign(dropEvent, { dataTransfer, clientY: 130 });
      rows[2].dispatchEvent(dropEvent);
    });

    const updated = store.getSnapshot().file?.snippets.map((s) => s.id);
    expect(updated).toEqual(['second', 'third', 'first']);
  });
});

describe('trailing whitespace indicator in REGEX and BODY', () => {
  it('renders thin green vertical line when trigger has trailing whitespace', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [
        { id: 'spaces', trigger: { pattern: 'test   ' }, description: 'test', body: 'body' }
      ]
    });
    await store.start();
    await mount(store);

    const triggerTextArea = byLabel('Trigger') as HTMLTextAreaElement;
    expect(triggerTextArea).not.toBeNull();
    expect(triggerTextArea.value).toBe('test   ');

    const indicators = container.querySelectorAll('[data-testid="trailing-whitespace-indicator"]');
    expect(indicators.length).toBeGreaterThan(0);
    const indicator = indicators[0] as HTMLElement;
    expect(indicator.style.borderRight).toContain('solid');
  });

  it('renders thin green vertical line when body has trailing whitespace', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [
        { id: 'bodyspaces', trigger: { pattern: 'trigger' }, description: 'test', body: 'line1  \nline2\nline3 ' }
      ]
    });
    await store.start();
    await mount(store);

    const bodyTextArea = byLabel('Snippet body') as HTMLTextAreaElement;
    expect(bodyTextArea).not.toBeNull();

    const indicators = container.querySelectorAll('[data-testid="trailing-whitespace-indicator"]');
    // Lines 1 and 3 have trailing whitespace, line 2 does not.
    expect(indicators.length).toBe(2);
  });

  it('does not render trailing whitespace indicator when there is no trailing whitespace', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [
        { id: 'clean', trigger: { pattern: 'clean_trigger' }, description: 'test', body: 'clean_body' }
      ]
    });
    await store.start();
    await mount(store);

    const indicators = container.querySelectorAll('[data-testid="trailing-whitespace-indicator"]');
    expect(indicators.length).toBe(0);
  });
});

describe('newline start vertical line indicators in REGEX and BODY', () => {
  it('renders newline start indicator and guide on Trigger and Body textareas', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [
        { id: 'sample', trigger: { pattern: 'test' }, description: 'test', body: 'body content' }
      ]
    });
    await store.start();
    await mount(store);

    const newlineIndicators = container.querySelectorAll('[data-testid="newline-start-indicator"]');
    expect(newlineIndicators.length).toBe(2); // One on Trigger, one on Body
    const newlineGuides = container.querySelectorAll('[data-testid="newline-start-guide"]');
    expect(newlineGuides.length).toBe(2); // One on Trigger, one on Body
  });
});

describe('comprehensive filters and drawer', () => {
  it('toggles filter drawer and filters snippets list by context, expansion, boundary, tag, and script', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [
        { id: 's1', trigger: { pattern: 'alpha' }, description: 'first', body: 'math-auto', context: 'math', expand: 'auto', boundary: 'whitespace', tags: ['greek'] },
        { id: 's2', trigger: { pattern: 'beta' }, description: 'second', body: 'text-manual', context: 'text', expand: 'manual', boundary: 'word', tags: ['latin'] },
        { id: 's3', trigger: { pattern: 'gamma' }, description: 'third', body: '``rv = 1``', context: 'math', expand: 'manual', boundary: 'line-start' }
      ]
    });
    await store.start();
    await mount(store);

    const getRows = () => container.querySelectorAll<HTMLElement>('[role="button"][aria-pressed]');
    expect(getRows().length).toBe(3);

    // Filter drawer should initially be closed
    expect(container.querySelector('[data-testid="comprehensive-filters"]')).toBeNull();

    // Toggle filter drawer open
    const toggleBtn = container.querySelector<HTMLButtonElement>('[aria-label="Toggle comprehensive filters"]')!;
    expect(toggleBtn).not.toBeNull();
    await click(toggleBtn);

    // Filter drawer is now visible
    expect(container.querySelector('[data-testid="comprehensive-filters"]')).not.toBeNull();

    // Filter by context: math (should keep s1 and s3)
    const contextSelect = container.querySelector<HTMLSelectElement>('[aria-label="Filter by context"]')!;
    expect(contextSelect).not.toBeNull();
    await act(async () => {
      contextSelect.value = 'math';
      contextSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(getRows().length).toBe(2);

    // Reset filters button should appear in the library row
    const resetBtn = button('Reset filters');
    expect(resetBtn).not.toBeNull();
    await click(resetBtn);

    // All 3 rows should be visible again
    expect(getRows().length).toBe(3);

    // Filter by tag: latin
    const tagSelect = container.querySelector<HTMLSelectElement>('[aria-label="Filter by tag"]')!;
    expect(tagSelect).not.toBeNull();
    await act(async () => {
      tagSelect.value = 'latin';
      tagSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(getRows().length).toBe(1);

    // Click "Clear all" inside the comprehensive filters drawer
    const clearAllBtn = button('Clear all');
    expect(clearAllBtn).not.toBeNull();
    await click(clearAllBtn);
    expect(getRows().length).toBe(3);
  });
});

describe('remembering state across closing and reopening', () => {
  it('preserves query, filter, and selected snippet when closed and reopened', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [
        { id: 'first', trigger: { pattern: 'one' }, description: 'one', body: '1' },
        { id: 'second', trigger: { pattern: 'two' }, description: 'two', body: '2' },
        { id: 'third', trigger: { pattern: 'three' }, description: 'three', body: '3' }
      ]
    });
    await store.start();
    await mount(store);

    // Select second row (index 1)
    const rows = container.querySelectorAll<HTMLElement>('[role="button"][aria-pressed]');
    await click(rows[1]);
    expect(rows[1].getAttribute('aria-pressed')).toBe('true');

    // Type a query in search box
    const searchInput = container.querySelector<HTMLInputElement>('input[placeholder="Filter snippets"]')!;
    await setInputValue(searchInput, 'two');

    // Unmount SnippetManager (simulating closing the window)
    act(() => root.unmount());
    container.innerHTML = '';
    root = createRoot(container);

    // Remount SnippetManager (simulating reopening the window)
    await mount(store);

    // Query should be remembered
    const restoredSearchInput = container.querySelector<HTMLInputElement>('input[placeholder="Filter snippets"]')!;
    expect(restoredSearchInput.value).toBe('two');

    // Filtered list should show the matching snippet
    const restoredRows = container.querySelectorAll<HTMLElement>('[role="button"][aria-pressed]');
    expect(restoredRows.length).toBe(1);
    expect(restoredRows[0].textContent).toContain('two');
  });

  it('does not reset state when editing a snippet', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [
        { id: 'first', trigger: { pattern: 'one' }, description: 'first snippet', body: '1' },
        { id: 'second', trigger: { pattern: 'two' }, description: 'second snippet', body: '2' }
      ]
    });
    await store.start();
    await mount(store);

    // Apply a search filter
    const searchInput = container.querySelector<HTMLInputElement>('input[placeholder="Filter snippets"]')!;
    await setInputValue(searchInput, 'snippet');

    // Select second row
    const rows = container.querySelectorAll<HTMLElement>('[role="button"][aria-pressed]');
    expect(rows.length).toBe(2);
    await click(rows[1]);
    expect(rows[1].getAttribute('aria-pressed')).toBe('true');

    // Edit the description of the selected snippet
    const descInput = byLabel('Snippet description') as HTMLInputElement;
    expect(descInput).not.toBeNull();
    await setInputValue(descInput, 'updated second snippet');

    // State MUST NOT reset: query should still be 'snippet', and selection should remain on second snippet
    expect(searchInput.value).toBe('snippet');
    const rowsAfterEdit = container.querySelectorAll<HTMLElement>('[role="button"][aria-pressed]');
    expect(rowsAfterEdit.length).toBe(2);
    expect(rowsAfterEdit[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('resets state when reload button is clicked', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [
        { id: 'first', trigger: { pattern: 'one' }, description: 'first', body: '1' },
        { id: 'second', trigger: { pattern: 'two' }, description: 'second', body: '2' }
      ]
    });
    await store.start();
    await mount(store);

    // Apply query
    const searchInput = container.querySelector<HTMLInputElement>('input[placeholder="Filter snippets"]')!;
    await setInputValue(searchInput, 'two');
    expect(searchInput.value).toBe('two');

    // Click Reload button
    const reloadBtn = button('Reload');
    expect(reloadBtn).not.toBeNull();
    await click(reloadBtn);

    // After reload, search should be reset to empty
    expect(searchInput.value).toBe('');
    const state = getRememberedSnippetManagerState();
    expect(state.query).toBe('');
    expect(state.status).toBe('all');
  });
});

describe('scroll to top and bottom buttons in snippets list', () => {
  it('renders scroll-to-top and scroll-to-bottom buttons in snippets list header', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [
        { id: 'first', trigger: { pattern: 'one' }, description: 'one', body: '1' },
        { id: 'second', trigger: { pattern: 'two' }, description: 'two', body: '2' }
      ]
    });
    await store.start();
    await mount(store);

    const topBtn = container.querySelector<HTMLButtonElement>('[data-testid="scroll-to-top-button"]');
    const bottomBtn = container.querySelector<HTMLButtonElement>('[data-testid="scroll-to-bottom-button"]');

    expect(topBtn).not.toBeNull();
    expect(bottomBtn).not.toBeNull();
    expect(topBtn?.getAttribute('aria-label')).toBe('Scroll to top');
    expect(bottomBtn?.getAttribute('aria-label')).toBe('Scroll to bottom');

    // Click buttons without throwing errors
    await click(topBtn!);
    await click(bottomBtn!);
  });
});

describe('reliable saving on close and unmount', () => {
  it('registers close handler and flushes dirty store when closed through registerCloseHandler', async () => {
    let closeHandler: (() => Promise<boolean>) | null = null;
    const registerCloseHandler = (fn: () => Promise<boolean>) => {
      closeHandler = fn;
      return () => {
        closeHandler = null;
      };
    };

    const { store, written } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ id: 's1', trigger: { pattern: 'test' }, description: 'test', body: 'body1' }]
    });
    await store.start();

    let closed = false;
    await mount(store, {
      registerCloseHandler,
      onClose: () => {
        closed = true;
      }
    });

    expect(closeHandler).not.toBeNull();

    // Edit a snippet to make store dirty
    const bodyInput = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Snippet body"]')!;
    expect(bodyInput).not.toBeNull();
    await setInputValue(bodyInput, 'body2');

    expect(store.getSnapshot().dirty).toBe(true);
    expect(written.length).toBe(0);

    // Call closeHandler (as toggleSnippets or shell would)
    let success = false;
    await act(async () => {
      success = await closeHandler!();
    });
    expect(success).toBe(true);
    expect(closed).toBe(true);
    expect(written.length).toBe(1);
    expect(JSON.parse(written[0]).snippets[0].body).toBe('body2');
  });

  it('flushes dirty store on unmount if unmounted directly', async () => {
    const { store, written } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ id: 's1', trigger: { pattern: 'test' }, description: 'test', body: 'body1' }]
    });
    await store.start();

    await mount(store);

    const bodyInput = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Snippet body"]')!;
    await setInputValue(bodyInput, 'unmount-edit');
    expect(store.getSnapshot().dirty).toBe(true);

    // Directly unmount component without calling close
    await act(async () => {
      root.unmount();
    });

    // Unmount cleanup should trigger flush
    expect(written.length).toBe(1);
    expect(JSON.parse(written[0]).snippets[0].body).toBe('unmount-edit');
  });

  it('handles Escape key in textarea to trigger save and close', async () => {
    const { store, written } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ id: 's1', trigger: { pattern: 'test' }, description: 'test', body: 'body1' }]
    });
    await store.start();

    let closed = false;
    await mount(store, {
      onClose: () => {
        closed = true;
      }
    });

    const bodyInput = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Snippet body"]')!;
    await setInputValue(bodyInput, 'escaped-body');
    expect(store.getSnapshot().dirty).toBe(true);

    // Press Escape inside the textarea
    await act(async () => {
      bodyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    expect(closed).toBe(true);
    expect(written.length).toBe(1);
    expect(JSON.parse(written[0]).snippets[0].body).toBe('escaped-body');
  });

  it('handles Ctrl+S in textarea to flush without closing', async () => {
    const { store, written } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ id: 's1', trigger: { pattern: 'test' }, description: 'test', body: 'body1' }]
    });
    await store.start();

    let closed = false;
    await mount(store, {
      onClose: () => {
        closed = true;
      }
    });

    const bodyInput = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Snippet body"]')!;
    await setInputValue(bodyInput, 'ctrl-s-body');
    expect(store.getSnapshot().dirty).toBe(true);

    // Press Ctrl+S inside textarea
    await act(async () => {
      bodyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    });

    expect(closed).toBe(false);
    expect(written.length).toBe(1);
    expect(JSON.parse(written[0]).snippets[0].body).toBe('ctrl-s-body');
    expect(store.getSnapshot().dirty).toBe(false);
  });

  it('shows an x button in the search bar to clear filter text', async () => {
    const { store } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [
        { id: 'alpha', trigger: { pattern: 'alpha' }, description: 'alpha test', body: 'alpha body' },
        { id: 'beta', trigger: { pattern: 'beta' }, description: 'beta test', body: 'beta body' }
      ]
    });
    await store.start();
    await mount(store);

    const searchInput = byLabel('Filter snippets') as HTMLInputElement;
    expect(searchInput).not.toBeNull();
    // Initially empty, so clear button is not present
    expect(byLabel('Clear search')).toBeNull();

    // Type into search input
    await setInputValue(searchInput, 'alpha');
    expect(searchInput.value).toBe('alpha');

    // Clear button should now be visible
    const clearButton = byLabel('Clear search');
    expect(clearButton).not.toBeNull();

    // Clicking clear button clears query and hides the button
    await click(clearButton);
    expect(searchInput.value).toBe('');
    expect(byLabel('Clear search')).toBeNull();
  });

  it('assigns a unique id on request using the header Generate button in Simple mode', async () => {
    const { store, written } = memoryStore({
      version: EUSNIPS_VERSION,
      language: 'latex',
      snippets: [{ ...IDLE, id: 'simple-id' }]
    });
    await store.start();
    await mount(store);

    const idInput = byLabel('Snippet ID') as HTMLInputElement;
    expect(idInput).not.toBeNull();
    expect(idInput.value).toBe('simple-id');

    await click(button('Generate'));
    await store.flush();

    const onDisk = JSON.parse(written[written.length - 1]) as EusnipsFile;
    expect(onDisk.snippets[0].id).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]{6}$/);
    expect(onDisk.snippets[0].id).not.toBe('simple-id');
  });
});


