/**
 * Eukolia — light-pdf's bookmarks sidebar, ported.
 *
 * `TableOfContents.cpp` builds the sidebar as a label with a close button
 * ("Bookmarks" + ×, `LabelWithCloseWnd`), a "Search Bookmarks" filter edit and a
 * full-row-select tree whose rows jump to a page (`CreateToc`,
 * `TableOfContents.cpp:1288-1339`). Its context menu is `Expand All`,
 * `Collapse All`, `Expand to Current Page` (`menuDefContextToc`,
 * `TableOfContents.cpp:575-587`), and the tree is themed with the same viewer
 * theme as the toolbar.
 *
 * The tree model — expansion, filtering, "expand to current page" — lives in
 * `lightpdf-toc.ts`; this component only draws it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  LIGHTPDF_TOC_DEFAULT_WIDTH,
  tocAllIds,
  tocCollapsedIds,
  tocExpandToPage,
  tocRowPage,
  tocRows,
  type LightPdfTocRow
} from './lightpdf-toc';
import {
  accentColor,
  bgrToHex,
  themeControlBackgroundColor,
  themeWindowLinkColor,
  themeWindowTextColor,
  type LightPdfThemeState
} from './lightpdf-theme';
import type { PdfOutlineItem } from '../../shared/ipc';

/** The white `FixedPageUI.BackgroundColor` input background light-pdf edits use. */
const INPUT_BACKGROUND = '#ffffff';

export interface LightPdfTocProps {
  outline: readonly PdfOutlineItem[];
  theme: LightPdfThemeState;
  /** The page the viewer is showing, for `Expand to Current Page` and the marker. */
  currentPage: number;
  onGoToPage(page: number): void;
  onClose(): void;
}

export const LightPdfToc: React.FC<LightPdfTocProps> = (props) => {
  const { theme } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set<string>());
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // A new document starts with its top level open, which is how a tree of
  // bookmarks is readable without a click.
  useEffect(() => {
    setExpanded(new Set(props.outline.map((_, index) => String(index))));
    setSelected(null);
    setFilter('');
  }, [props.outline]);

  const rows = useMemo(() => tocRows(props.outline, expanded, filter), [props.outline, expanded, filter]);

  const controlBg = themeControlBackgroundColor(theme);
  const textColor = bgrToHex(themeWindowTextColor(theme));
  const linkColor = bgrToHex(themeWindowLinkColor(theme));
  const edgeColor = bgrToHex(accentColor(controlBg, 40));
  const hotColor = bgrToHex(accentColor(controlBg, 20));

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandToCurrentPage = useCallback(() => {
    const result = tocExpandToPage(props.outline, props.currentPage);
    setExpanded(result.expanded);
    setSelected(result.rowId);
  }, [props.outline, props.currentPage]);

  const runMenuCommand = useCallback(
    (command: 'expand-all' | 'collapse-all' | 'expand-to-page') => {
      setMenu(null);
      if (command === 'expand-all') setExpanded(tocAllIds(props.outline));
      else if (command === 'collapse-all') setExpanded(tocCollapsedIds());
      else expandToCurrentPage();
    },
    [props.outline, expandToCurrentPage]
  );

  // A context menu closes on any click outside it, as a Win32 popup menu does.
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const activate = useCallback(
    (row: LightPdfTocRow) => {
      setSelected(row.id);
      const page = tocRowPage(row);
      if (page !== null) props.onGoToPage(page);
    },
    [props]
  );

  return (
    <div
      data-testid="pdf-toc"
      style={{
        width: LIGHTPDF_TOC_DEFAULT_WIDTH,
        // `SidebarDx` is light-pdf's remembered *window* dimension, so the
        // sidebar neither grows nor shrinks (`.tsx`'s caller stands it down when
        // the pane is too narrow for it). `maxWidth`/`overflow` are the belt to
        // that braces: a flex item whose content is wider than its basis would
        // otherwise push its siblings — and the page — out of the pane.
        maxWidth: '100%',
        overflow: 'hidden',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: bgrToHex(controlBg),
        borderRight: `1px solid ${edgeColor}`,
        fontFamily: 'Segoe UI, system-ui, sans-serif',
        fontSize: 12,
        color: textColor,
        userSelect: 'none'
      }}
    >
      {/* `LabelWithCloseWnd` — the sidebar title with its close button. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 4,
          padding: '2px 2px 2px 4px',
          borderBottom: `1px solid ${edgeColor}`,
          fontWeight: 600
        }}
      >
        <span>Bookmarks</span>
        <button
          type="button"
          title="Close"
          aria-label="Close bookmarks"
          data-testid="pdf-toc-close"
          onClick={props.onClose}
          style={{
            width: 18,
            height: 18,
            padding: 0,
            border: 'none',
            borderRadius: 2,
            background: 'transparent',
            color: textColor,
            cursor: 'pointer',
            lineHeight: '16px'
          }}
        >
          ×
        </button>
      </div>

      {/* `TableOfContents.cpp:1308-1319` — the "Search Bookmarks" filter. */}
      <input
        value={filter}
        placeholder="Search Bookmarks"
        aria-label="Search Bookmarks"
        data-testid="pdf-toc-filter"
        onChange={(event) => setFilter(event.target.value)}
        style={{
          margin: 4,
          height: 18,
          padding: '0 4px',
          fontSize: 12,
          fontFamily: 'inherit',
          color: textColor,
          background: INPUT_BACKGROUND,
          border: `1px solid ${edgeColor}`,
          outline: 'none'
        }}
      />

      <div
        role="tree"
        aria-label="Bookmarks"
        data-testid="pdf-toc-tree"
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 2px 4px' }}
      >
        {rows.length === 0 && (
          <div style={{ padding: '4px 2px', opacity: 0.75 }}>
            {filter ? 'No bookmark matches.' : 'This document has no bookmarks.'}
          </div>
        )}
        {rows.map((row) => {
          const page = tocRowPage(row);
          const isCurrent = page !== null && page === props.currentPage;
          return (
            <div
              key={row.id}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={selected === row.id}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              data-toc-row={row.id}
              data-toc-page={page ?? ''}
              title={row.item.title}
              onClick={() => activate(row)}
              onDoubleClick={() => toggle(row.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                paddingLeft: 2 + row.depth * 12,
                height: 18,
                borderRadius: 2,
                background: selected === row.id ? hotColor : 'transparent',
                color: isCurrent ? linkColor : textColor,
                cursor: page !== null ? 'pointer' : 'default',
                whiteSpace: 'nowrap',
                overflow: 'hidden'
              }}
            >
              {row.hasChildren ? (
                <button
                  type="button"
                  aria-label={row.expanded ? 'Collapse' : 'Expand'}
                  data-toc-twisty={row.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(row.id);
                  }}
                  style={{
                    width: 12,
                    height: 12,
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    color: textColor,
                    cursor: 'pointer',
                    fontSize: 9,
                    lineHeight: '12px'
                  }}
                >
                  {row.expanded ? '▼' : '▶'}
                </button>
              ) : (
                <span style={{ width: 12, flexShrink: 0 }} />
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.item.title}</span>
              {page !== null && (
                // `TableOfContents.cpp:36` — an optional page number per row.
                <span style={{ marginLeft: 'auto', paddingLeft: 6, opacity: 0.7 }}>{page}</span>
              )}
            </div>
          );
        })}
      </div>

      {menu && (
        // `menuDefContextToc` — the tree's own context menu.
        <div
          ref={menuRef}
          data-testid="pdf-toc-menu"
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            zIndex: 40,
            minWidth: 160,
            padding: '2px 0',
            background: bgrToHex(controlBg),
            border: `1px solid ${edgeColor}`,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
            color: textColor
          }}
        >
          {(
            [
              ['expand-all', 'Expand All'],
              ['collapse-all', 'Collapse All'],
              ['expand-to-page', 'Expand to Current Page']
            ] as const
          ).map(([command, label]) => (
            <div
              key={command}
              role="menuitem"
              data-toc-command={command}
              onClick={() => runMenuCommand(command)}
              style={{ padding: '3px 10px', cursor: 'pointer' }}
            >
              {label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
