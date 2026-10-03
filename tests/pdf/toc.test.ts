/**
 * light-pdf's bookmarks sidebar (`ShowToc`, `CmdToggleBookmarks`, `F12`).
 *
 * The model is checked against `TableOfContents.cpp`'s behaviour: the tree shows
 * the bookmarks of the open document, `Expand All` / `Collapse All` /
 * `Expand to Current Page` are its context-menu commands
 * (`menuDefContextToc`, `TableOfContents.cpp:575-587`), and its filter edit
 * ("Search Bookmarks", `TableOfContents.cpp:1313`) narrows the tree to matching
 * bookmarks *and their ancestors*.
 */

import { describe, expect, it } from 'vitest';

import {
  tocAllIds,
  tocCollapsedIds,
  tocExpandToPage,
  tocRowId,
  tocRowPage,
  tocRowPageLabel,
  tocRows
} from '@/pdf/lightpdf-toc';
import { LIGHTPDF_TOC_DEFAULT_WIDTH } from '@/pdf/lightpdf-toc';
import { LIGHTPDF_TOC_MIN_PANE_WIDTH, tocIsShown } from '@/pdf/PdfPane';
import type { PdfOutlineItem } from '../../src/shared/ipc';

const item = (title: string, page: number | null, children: PdfOutlineItem[] = []): PdfOutlineItem => ({
  title,
  page,
  uri: null,
  children
});

const outline: PdfOutlineItem[] = [
  item('Introduction', 1, [item('Motivation', 2), item('Prior work', 3, [item('Baselines', 4)])]),
  item('Method', 5, [item('Model', 6)]),
  item('Conclusion', 9)
];

describe('row identity', () => {
  it('is the path of indices, so a row survives a re-render', () => {
    expect(tocRowId('', 0)).toBe('0');
    expect(tocRowId('0', 2)).toBe('0.2');
    expect(tocRowId('0.2', 1)).toBe('0.2.1');
  });
});

describe('tocRows', () => {
  it('shows the top level when nothing is expanded', () => {
    const rows = tocRows(outline, new Set());
    expect(rows.map((row) => row.item.title)).toEqual(['Introduction', 'Method', 'Conclusion']);
    expect(rows.map((row) => row.depth)).toEqual([0, 0, 0]);
    expect(rows.map((row) => row.expanded)).toEqual([false, false, false]);
  });

  it('shows the children of an expanded row without recursing into collapsed ones', () => {
    const rows = tocRows(outline, new Set(['0']));
    expect(rows.map((row) => row.item.title)).toEqual([
      'Introduction',
      'Motivation',
      'Prior work',
      'Method',
      'Conclusion'
    ]);
    expect(rows[2].depth).toBe(1);
    expect(rows[2].hasChildren).toBe(true);
    expect(rows[2].expanded).toBe(false);
  });

  it('walks nested branches when every ancestor is open', () => {
    const rows = tocRows(outline, tocAllIds(outline));
    expect(rows.map((row) => row.item.title)).toEqual([
      'Introduction',
      'Motivation',
      'Prior work',
      'Baselines',
      'Method',
      'Model',
      'Conclusion'
    ]);
    expect(rows[3].depth).toBe(2);
  });

  it('narrows to matching bookmarks and keeps their ancestors visible', () => {
    const rows = tocRows(outline, new Set(), 'model');
    expect(rows.map((row) => row.item.title)).toEqual(['Method', 'Model']);
    expect(rows[0].hasChildren).toBe(true);
    // A filter forces the branch open: the hit has to be reachable.
    expect(rows[0].expanded).toBe(true);
  });

  it('matches case-insensitively and reports an empty result honestly', () => {
    expect(tocRows(outline, new Set(), 'BASELINE').map((row) => row.item.title)).toEqual([
      'Introduction',
      'Prior work',
      'Baselines'
    ]);
    expect(tocRows(outline, new Set(), 'nothing here')).toEqual([]);
  });
});

describe('expand all and collapse all', () => {
  it('collects every branch exactly once', () => {
    expect([...tocAllIds(outline)].sort()).toEqual(['0', '0.1', '1']);
    expect(tocCollapsedIds().size).toBe(0);
  });
});

describe('expand to current page', () => {
  it('opens the branch holding the last bookmark at or before the page', () => {
    const result = tocExpandToPage(outline, 4);
    // `Baselines` is on page 4, inside `Introduction` → `Prior work`.
    expect(result.rowId).toBe('0.1.0');
    // Its ancestors are open so the row is actually visible.
    expect([...result.expanded].sort()).toEqual(['0', '0.1']);
    expect(tocRows(outline, result.expanded).map((row) => row.item.title)).toContain('Baselines');
  });

  it('picks the nearest earlier bookmark for a page between bookmarks', () => {
    expect(tocExpandToPage(outline, 7).rowId).toBe('1.0');
    expect(tocExpandToPage(outline, 8).rowId).toBe('1.0');
    expect(tocExpandToPage(outline, 9).rowId).toBe('2');
  });

  it('reports nothing to expand before the first bookmark', () => {
    const result = tocExpandToPage([item('Later', 5)], 1);
    expect(result.rowId).toBeNull();
    expect(result.expanded.size).toBe(0);
  });
});

describe('row targets', () => {
  it('reports the page a row jumps to, or nothing for a non-page bookmark', () => {
    const rows = tocRows([item('Text', null), item('Page', 3)], new Set());
    expect(tocRowPage(rows[0])).toBeNull();
    expect(tocRowPageLabel(rows[0])).toBe('');
    expect(tocRowPage(rows[1])).toBe(3);
    expect(tocRowPageLabel(rows[1])).toBe('3');
  });
});

/**
 * `ShowToc`'s third condition: room for the sidebar and a page.
 *
 * The sidebar is `SidebarDx` — light-pdf's remembered *window* dimension, so it
 * neither grows nor shrinks — and a pane narrower than it used to push the
 * viewer past the window's right edge rather than narrowing it, leaving the page
 * fitted to a width the reader could not see.
 */
describe('whether the sidebar is shown', () => {
  it('needs the preference and a document that has bookmarks', () => {
    expect(tocIsShown(true, true, 900)).toBe(true);
    expect(tocIsShown(false, true, 900)).toBe(false);
    expect(tocIsShown(true, false, 900)).toBe(false);
  });

  it('stands down in a pane without room for it and a page', () => {
    // `LIGHTPDF_TOC_DEFAULT_WIDTH` is the sidebar's own width, so a pane at that
    // width leaves nothing for the page.
    expect(tocIsShown(true, true, LIGHTPDF_TOC_DEFAULT_WIDTH)).toBe(false);
    expect(tocIsShown(true, true, LIGHTPDF_TOC_MIN_PANE_WIDTH - 1)).toBe(false);
    expect(tocIsShown(true, true, LIGHTPDF_TOC_MIN_PANE_WIDTH)).toBe(true);
    expect(LIGHTPDF_TOC_MIN_PANE_WIDTH).toBeGreaterThan(LIGHTPDF_TOC_DEFAULT_WIDTH);
  });

  it('does not stand down before the pane has been measured', () => {
    // A pane with no width yet is one that has not been laid out — hiding the
    // sidebar there would flicker it away at every mount, and a pane that really
    // is narrow reports its width on the next layout.
    expect(tocIsShown(true, true, 0)).toBe(true);
  });
});
