/**
 * Eukolia — light-pdf's bookmarks sidebar (table of contents), modelled.
 *
 * light-pdf's document window has a sidebar holding the document's bookmarks:
 * `ShowToc` (`gen-settings.ts:729-734`, default true) decides whether it is
 * shown *when the document has one*, `CmdToggleBookmarks` (`F12`) toggles it,
 * and `TableOfContents.cpp` builds it as a label-with-close plus a
 * "Search Bookmarks" filter and a tree view (`CreateToc`,
 * `TableOfContents.cpp:1288-1339`) whose rows jump to a page
 * (`TocTreeSelectionChanged`). The context menu offers `Expand All`,
 * `Collapse All` and `Expand to Current Page` (`menuDefContextToc`,
 * `TableOfContents.cpp:575-587`).
 *
 * This module is the pure half: it turns a `PdfOutlineItem` tree plus the
 * expansion set and the filter text into the flat list of rows the sidebar
 * draws. Keeping it free of React and of the DOM is what makes "expand to the
 * current page" and "filter" testable.
 */

import type { PdfOutlineItem } from '../../shared/ipc';

/** One visible row of the sidebar. */
export interface LightPdfTocRow {
  /** Stable identity: the path of menu indices, e.g. `0.2.1`. */
  id: string;
  item: PdfOutlineItem;
  /** Nesting level, 0 for a top-level bookmark. */
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * A bookmark's identity: the indices visited from the root, joined. light-pdf
 * tracks expansion state as a set of ids too, but *toggled* ids rather than
 * expanded ones (`FileState::TocState`, `gen-settings.ts:550-559`); Eukolia
 * keeps the expanded set directly, which is the same information without the
 * diff bookkeeping the settings file needs.
 */
export function tocRowId(parentId: string, index: number): string {
  return parentId === '' ? String(index) : `${parentId}.${index}`;
}

/** True when the row itself or any descendant matches `filter`. */
export function tocMatches(item: PdfOutlineItem, filter: string): boolean {
  if (!filter) return true;
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  if (item.title.toLowerCase().includes(needle)) return true;
  return item.children.some((child) => tocMatches(child, needle));
}

/**
 * Flattens the bookmarks into the rows to draw, honouring the expansion set.
 *
 * A filter forces every matching branch open, which is how a searchable tree
 * stays usable: the player still has to be able to see the hits.
 */
export function tocRows(
  items: readonly PdfOutlineItem[],
  expanded: ReadonlySet<string>,
  filter = ''
): LightPdfTocRow[] {
  const rows: LightPdfTocRow[] = [];
  const needle = filter.trim().toLowerCase();

  const walk = (list: readonly PdfOutlineItem[], depth: number, parentId: string): void => {
    list.forEach((item, index) => {
      if (!tocMatches(item, needle)) return;
      const id = tocRowId(parentId, index);
      const hasChildren = item.children.length > 0;
      const isExpanded = needle !== '' || expanded.has(id);
      rows.push({ id, item, depth, hasChildren, expanded: isExpanded });
      if (hasChildren && isExpanded) walk(item.children, depth + 1, id);
    });
  };

  walk(items, 0, '');
  return rows;
}

/** `CmdExpandAll` — every branch open. */
export function tocAllIds(items: readonly PdfOutlineItem[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: readonly PdfOutlineItem[], parentId: string): void => {
    list.forEach((item, index) => {
      const id = tocRowId(parentId, index);
      if (item.children.length > 0) {
        ids.add(id);
        walk(item.children, id);
      }
    });
  };
  walk(items, '');
  return ids;
}

/** `CmdCollapseAll` — every branch closed. */
export function tocCollapsedIds(): Set<string> {
  return new Set<string>();
}

/**
 * `CmdExpandToCurrentPage` — open the branch that contains the bookmark for
 * `page`, so the current position is visible in the tree.
 *
 * `CmdExpandToCurrentPage` (`TableOfContents.cpp:585-587`) walks to the bookmark
 * whose page is the last one at or before the current page, which is what this
 * returns along with the ancestors that have to be open for it.
 */
export function tocExpandToPage(
  items: readonly PdfOutlineItem[],
  page: number
): { expanded: Set<string>; rowId: string | null } {
  const expanded = new Set<string>();
  let best: { rowId: string; page: number } | null = null;

  const walk = (list: readonly PdfOutlineItem[], parentId: string, ancestors: string[]): void => {
    list.forEach((item, index) => {
      const id = tocRowId(parentId, index);
      if (typeof item.page === 'number' && item.page <= page) {
        if (!best || item.page >= best.page) best = { rowId: id, page: item.page };
      }
      walk(item.children, id, [...ancestors, id]);
    });
  };
  walk(items, '', []);

  const chosen = best as { rowId: string; page: number } | null;
  if (!chosen) return { expanded, rowId: null };
  // Open every ancestor of the chosen row.
  const parts = chosen.rowId.split('.');
  for (let length = 1; length < parts.length; length += 1) {
    expanded.add(parts.slice(0, length).join('.'));
  }
  return { expanded, rowId: chosen.rowId };
}

/** The page a row jumps to, or `null` for a bookmark without a page target. */
export function tocRowPage(row: LightPdfTocRow): number | null {
  return typeof row.item.page === 'number' ? row.item.page : null;
}

/** Default width of the sidebar, in CSS pixels. */
export const LIGHTPDF_TOC_DEFAULT_WIDTH = 220;

/**
 * `TableOfContents.cpp:36` — light-pdf can show a page number per row; it is a
 * compile-time option there ("Define if you want page numbers to be displayed in
 * the ToC sidebar"), so the sidebar here shows it whenever the bookmark has a
 * page target.
 */
export function tocRowPageLabel(row: LightPdfTocRow): string {
  const page = tocRowPage(row);
  return page === null ? '' : String(page);
}
