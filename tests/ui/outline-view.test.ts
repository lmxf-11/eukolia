// @vitest-environment jsdom

/**
 * The Outline panel.
 *
 * The tree is a list of heading titles and nothing else. It used to carry each
 * heading's `\label`s as inline chips after the title, which cost the title the
 * width it needed — a `flexShrink: 0` chip never yields, so the title truncated
 * at whatever the chips left over, which was nothing, while the column beside it
 * sat empty. Every heading in a labelled document was clipped to "Formal lan…"
 * with a blank gutter to its right.
 *
 * So two things are pinned here: the title is the row's flexible child and takes
 * the width, and the labels moved into a dialog that opens on hover *and* on
 * focus.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const fake = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock('../../src/renderer/ui/state', () => ({ useAppState: () => fake.state }));
vi.mock('../../src/renderer/document/projectIndex', () => ({
  projectIndex: { on: () => () => undefined, getProjectRoot: () => null, getMacroTable: () => ({}) }
}));

const { Sidebar, outlineDialogLayout } = await import('../../src/renderer/ui/components/Sidebar');

const item = (
  command: string,
  title: string,
  level: number,
  line: number,
  labels: string[] = [],
  children: unknown[] = []
): unknown => ({ command, title, level, line, offset: line * 10, labels, starred: false, children });

/** A document with the shape that made the old layout clip: long titles, labels. */
const OUTLINE = [
  item('section', 'Formal language and syntax', 2, 10, ['sec:fol-syntax'], [
    item('subsection', 'Signatures, variables, and terms', 3, 12, [], []),
    item('subsection', 'Renaming and substitution', 3, 20, ['sec:renaming'], []),
    item('subsection', 'Induction on syntax and derivations', 3, 28, [], [])
  ])
];

let container: HTMLDivElement;
let root: Root;

async function mount(outline: unknown[] = OUTLINE): Promise<void> {
  fake.state = {
    sidebarView: 'outline',
    setSidebarView: () => undefined,
    outline,
    revealInEditor: () => undefined,
    activeDocument: { uri: 'D:/p/main.tex', doc: {} }
  };
  await act(async () => {
    root.render(React.createElement(Sidebar));
  });
  await act(async () => {});
}

const rows = (): HTMLElement[] => [...container.querySelectorAll('[role="treeitem"]')] as HTMLElement[];
const dialog = (): HTMLElement | null => container.querySelector('[data-testid="outline-dialog"]');

const enter = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
};
const leave = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('the heading titles get the width', () => {
  it('renders no label chips in the tree', async () => {
    await mount();
    // The chip was the reason a labelled heading clipped. Nothing in the tree
    // should carry the label text any more.
    expect(container.textContent).not.toContain('sec:fol-syntax');
    expect(container.textContent).not.toContain('sec:renaming');
  });

  it('renders every heading title in full', async () => {
    await mount();
    const titles = rows().map((row) => row.textContent);
    expect(titles).toEqual([
      'Formal language and syntax',
      'Signatures, variables, and terms',
      'Renaming and substitution',
      'Induction on syntax and derivations'
    ]);
  });

  it('gives the title the row', async () => {
    await mount();
    const title = rows()[0].firstElementChild?.nextElementSibling as HTMLElement | null;
    // `flex: 1` with `minWidth: 0`: takes the row, and is still allowed to
    // ellipsise rather than pushing the row wider than the panel.
    const style = (title?.getAttribute('style') ?? '').replace(/\s/g, '');
    expect(style).toContain('flex:1');
    expect(style).toContain('min-width:0');
    expect(style).toContain('text-overflow:ellipsis');
  });

  it('trims the row and the indent', async () => {
    await mount();
    // Compact: 20px rows and a 10px step, down from 22px and 12px.
    for (const row of rows()) {
      expect(row.style.height).toBe('20px');
    }
    const top = rows()[0].style.paddingLeft;
    const child = rows()[1].style.paddingLeft;
    expect(parseInt(child, 10) - parseInt(top, 10)).toBe(10);
  });
});

describe('the labels appear in a dialog on hover', () => {
  it('says nothing until the reader looks', async () => {
    await mount();
    expect(dialog()).toBeNull();
  });

  it('opens on hover with the heading and its labels', async () => {
    await mount();
    await enter(rows()[0]);

    const panel = dialog();
    expect(panel, 'hovering a heading opens its dialog').toBeTruthy();
    expect(panel?.textContent).toContain('Formal language and syntax');
    expect(panel?.textContent).toContain('sec:fol-syntax');
    expect(panel?.textContent).toContain('line 10');
    // The command, so the reader can tell a `\section` from a `\chapter`.
    expect(panel?.textContent).toContain('\\section');
  });

  it('closes when the pointer leaves', async () => {
    await mount();
    const row = rows()[0];
    await enter(row);
    expect(dialog()).toBeTruthy();

    await leave(row);
    expect(dialog()).toBeNull();
  });

  it('opens for a heading with no labels too', async () => {
    // A dialog that appears for some rows and not others reads as broken, and
    // the command and line are worth having on their own.
    await mount();
    await enter(rows()[1]);

    expect(dialog()?.textContent).toContain('Signatures, variables, and terms');
    expect(dialog()?.textContent).toContain('\\subsection');
  });

  it('lists every label a heading carries', async () => {
    await mount([item('section', 'Many labels', 2, 5, ['sec:a', 'sec:b', 'eq:c'], [])]);
    await enter(rows()[0]);

    const text = dialog()?.textContent ?? '';
    for (const label of ['sec:a', 'sec:b', 'eq:c']) expect(text).toContain(label);
  });

  it('never opens more than one at a time', async () => {
    await mount();
    await enter(rows()[0]);
    await leave(rows()[0]);
    await enter(rows()[1]);
    expect(container.querySelectorAll('[data-testid="outline-dialog"]')).toHaveLength(1);
  });
});

describe('the labels are reachable without a mouse', () => {
  it('opens on focus, so the keyboard can read them too', async () => {
    await mount();
    await act(async () => rows()[0].focus());
    expect(dialog(), 'focusing a heading opens its dialog').toBeTruthy();
    expect(dialog()?.textContent).toContain('sec:fol-syntax');
  });

  it('closes when focus leaves', async () => {
    await mount();
    await act(async () => rows()[0].focus());
    await act(async () => rows()[0].blur());
    expect(dialog()).toBeNull();
  });

  it('closes on Escape', async () => {
    await mount();
    await act(async () => rows()[0].focus());
    await act(async () => {
      rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(dialog()).toBeNull();
  });

  it('describes every heading to a screen reader, dialog or not', async () => {
    // The tree cannot rely on a hover-only dialog to carry the labels, so the
    // row's own label names them.
    await mount();
    const label = rows()[0].getAttribute('aria-label') ?? '';
    expect(label).toContain('Formal language and syntax');
    expect(label).toContain('section');
    expect(label).toContain('line 10');
    expect(label).toContain('1 label');
  });
});

describe('placing the dialog', () => {
  const anchor = { x: 40, y: 300, top: 280 };

  it('hangs beneath the heading when there is room below', () => {
    const layout = outlineDialogLayout(anchor, { width: 1200, height: 900 });
    expect(layout.left).toBe(40);
    expect(layout.flipAbove).toBe(false);
    expect(layout.offsetY).toBeGreaterThan(0);
  });

  it('flips above a heading near the foot of the window', () => {
    const layout = outlineDialogLayout({ x: 40, y: 880, top: 860 }, { width: 1200, height: 900 });
    expect(layout.flipAbove).toBe(true);
    expect(layout.offsetY).toBeLessThan(0);
  });

  it('keeps a wide sidebar from pushing the labels off the right edge', () => {
    // The sidebar can be dragged to 700px; a dialog anchored to a heading near
    // that edge would otherwise be clipped, and the labels are the whole point.
    const layout = outlineDialogLayout({ x: 690, y: 200, top: 180 }, { width: 1000, height: 900 });
    expect(layout.left + layout.width).toBeLessThanOrEqual(1000);
    expect(layout.left).toBeGreaterThanOrEqual(0);
  });

  it('stays on screen in a narrow window', () => {
    const layout = outlineDialogLayout({ x: 10, y: 100, top: 80 }, { width: 200, height: 600 });
    expect(layout.left).toBeGreaterThanOrEqual(0);
  });
});
