/**
 * TabSwitcher — the `Ctrl+Tab` popup.
 *
 * Holding `Ctrl` and pressing `Tab` opens a list of open tabs in most-recently-
 * used order, with the current tab first. `Tab` keeps cycling while `Ctrl` is
 * held; releasing `Ctrl` switches to the highlighted tab, so the whole gesture
 * is "hold, glance, release" without a second confirmation.
 *
 * Each row is a document's title, its path and its pin and close controls. The
 * path is always readable — a column of bare file names cannot tell two
 * `main.tex` apart — and the one row being pointed at (or, with the pointer
 * outside the list, the row the keyboard is on) slides its path across, so a
 * long one shows its tail without widening the popup or growing the row. A
 * pinned tab is shown by the colour of its pin, not by a second glyph.
 *
 * The popup owns its own keyboard handling rather than going through the command
 * registry: a command is a single keypress, and this gesture is a key *held*
 * across several presses, which the registry has no way to express. Its wheel is
 * the shell's (`core/smoothScroll`), which is why the popup is the one surface
 * marked `data-ctrl-wheel-scroll`: the gesture holds `Ctrl` down, and `Ctrl`+wheel
 * is the browser's zoom everywhere else, so without that claim the list could
 * never be scrolled with the mouse at all.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../state';
import { workspaceService } from '../../services/instance';
import { CTRL_WHEEL_ATTRIBUTE } from '../../core/smoothScroll';
import type { OpenDocument } from '../../services/workspace';
import { FileCode, FileText, Pin, X } from './icons';

/** A tab's display name, without its directory. */
export function tabTitle(entry: OpenDocument): string {
  const name = entry.doc.filename || entry.doc.uri;
  const base = name.replace(/^.*[\\/]/, '');
  return base || name;
}

/**
 * Orders tabs for the switcher: the active tab first, then the previously used
 * ones, then anything never visited.
 *
 * `mru` is the recently-used list maintained by {@link TabSwitcher}; it can
 * name documents that have since been closed, so it is filtered against the open
 * set rather than trusted.
 */
export function switcherOrder(
  documents: readonly OpenDocument[],
  activeUri: string | null,
  mru: readonly string[]
): OpenDocument[] {
  const open = new Map(documents.map(entry => [entry.doc.uri, entry]));
  const ordered: OpenDocument[] = [];
  const seen = new Set<string>();

  for (const uri of [activeUri ?? '', ...mru]) {
    if (!uri || seen.has(uri)) continue;
    const entry = open.get(uri);
    if (!entry) continue;
    seen.add(uri);
    ordered.push(entry);
  }

  for (const entry of documents) {
    if (seen.has(entry.doc.uri)) continue;
    seen.add(entry.doc.uri);
    ordered.push(entry);
  }

  return ordered;
}

/**
 * The one row whose path slides: the row under the pointer, or — with the
 * pointer outside the list — the row the keyboard is on.
 */
export function focusedRowIndex(hoveredIndex: number | null, selectedIndex: number): number {
  return hoveredIndex ?? selectedIndex;
}

/**
 * Whether a row is the focused one.
 *
 * Every row shows its path, so this no longer decides *whether* a path is
 * visible; it decides which single path is on the move. The pointer takes
 * precedence over the keyboard, so exactly one row is ever the focused one.
 */
export function isFocusedRow(entryIndex: number, hoveredIndex: number | null, selectedIndex: number): boolean {
  return entryIndex === focusedRowIndex(hoveredIndex, selectedIndex);
}

/**
 * How far a path has to slide for its tail to come into view, and how long that
 * should take.
 *
 * A path that already fits does not move at all, so a row whose URI is short
 * stays still under the pointer. The slide is paced by the distance rather than
 * given a fixed duration, which keeps a very long path from flying past.
 */
export function marqueePlan(
  textWidth: number,
  clipWidth: number,
  pixelsPerSecond = 60
): { distance: number; durationMs: number } {
  if (!Number.isFinite(textWidth) || !Number.isFinite(clipWidth) || clipWidth <= 0) {
    return { distance: 0, durationMs: 0 };
  }
  const distance = Math.max(0, Math.ceil(textWidth - clipWidth));
  // A pixel of overflow is not worth an animation.
  if (distance <= 1) return { distance: 0, durationMs: 0 };
  const durationMs = Math.min(4000, Math.max(200, Math.round((distance / pixelsPerSecond) * 1000)));
  return { distance, durationMs };
}

/** The path that is currently sliding, measured from the row it belongs to. */
interface Marquee {
  /** The document whose path slides; the URI survives a reorder of the list. */
  uri: string;
  distance: number;
  durationMs: number;
}

/**
 * Measures a row's path against the space the row gives it.
 *
 * `scrollWidth` of the `nowrap` text is its full width whatever the clip is
 * doing, and the clip's `clientWidth` is what the row can actually show, so the
 * difference is exactly how far the text has to travel.
 */
function measureMarquee(row: Element | null): { distance: number; durationMs: number } | null {
  const text = row?.querySelector<HTMLElement>('[data-testid="tab-switcher-path-text"]');
  const clip = text?.parentElement;
  if (!text || !clip) return null;
  const plan = marqueePlan(text.scrollWidth, clip.clientWidth);
  return plan.distance > 0 ? plan : null;
}

export interface TabSwitcherProps {
  /** Called after a tab is committed, so the host can restore focus. */
  onCommitted?(uri: string): void;
}

export const TabSwitcher: React.FC<TabSwitcherProps> = ({ onCommitted }) => {

  const { documents, activeDocument, setActiveDocument, closeDocument } = useAppState();

  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  // The row the pointer is over; `null` when the pointer is outside the list.
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  // The path currently sliding, and how far. Measured from the DOM, so it is
  // state rather than something the render can work out on its own.
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const mruRef = useRef<string[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedRowRef = useRef<HTMLDivElement | null>(null);

  // Most-recently-used order, updated whenever the active tab changes.
  const activeUri = activeDocument?.doc.uri ?? null;
  useEffect(() => {
    if (!activeUri) return;
    mruRef.current = [activeUri, ...mruRef.current.filter(uri => uri !== activeUri)];
  }, [activeUri]);

  const order = useMemo(
    () => switcherOrder(documents, activeUri, mruRef.current),
    // `mruRef` is deliberately not a dependency: it is a ref, and the order is
    // recomputed from the open set every time the popup opens instead.
    [documents, activeUri, open]
  );

  const selectedIndex = Math.min(index, order.length - 1);

  const orderRef = useRef(order);
  orderRef.current = order;
  const openRef = useRef(open);
  openRef.current = open;
  const indexRef = useRef(index);
  indexRef.current = index;

  const commit = useCallback(() => {
    const entry = orderRef.current[indexRef.current];
    setOpen(false);
    if (entry) {
      setActiveDocument(entry.doc.uri);
      onCommitted?.(entry.doc.uri);
    }
  }, [setActiveDocument, onCommitted]);

  /**
   * Opens the popup, or cycles it when already open.
   *
   * `Tab` moves the highlight; the popup stays up until `Ctrl` is released.
   */
  const advance = useCallback((backwards: boolean) => {
    const count = orderRef.current.length;
    if (count === 0) return;
    if (!openRef.current) {
      // Opening: the first press highlights the second tab, so one `Ctrl+Tab`
      // followed by release returns to the previous tab — the behaviour a
      // quick tap is expected to have.
      setOpen(true);
      // The pointer is wherever it was left, so the slide starts from the
      // keyboard selection rather than a stale hover.
      setHoveredIndex(null);
      setIndex(count > 1 ? 1 : 0);
      return;
    }
    setIndex(previous => {
      const next = backwards ? previous - 1 : previous + 1;
      return ((next % count) + count) % count;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      // `Ctrl+Tab` only; `Ctrl+Alt+Tab` belongs to the window manager.
      if (!event.ctrlKey || event.altKey || event.metaKey) return;

      event.preventDefault();
      event.stopPropagation();
      advance(event.shiftKey);
    };

    /**
     * Releasing `Ctrl` commits. `keyup` for the modifier is the only reliable
     * signal: the popup must survive every `Tab` press in between, so it cannot
     * close on the first keyup it sees.
     */
    const onKeyUp = (event: KeyboardEvent) => {
      if (!openRef.current) return;
      if (event.key === 'Control' || event.key === 'Meta') {
        event.preventDefault();
        commit();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };

    // Losing focus while the popup is up (alt-tab away) must not leave it stuck.
    const onBlur = () => setOpen(false);

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [advance, commit]);

  /**
   * Cycling with `Tab` can move the highlight outside the slice of a long list
   * that is currently visible, so the selected row is pulled back into view every
   * time the selection moves.
   */
  useEffect(() => {
    if (!open) return;
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, index, order.length]);

  /**
   * The path the focused row slides, measured after the row is on screen.
   *
   * Which row is focused is known before the render; how far its path has to
   * travel is a measurement, so it is taken here — and re-taken whenever the
   * focus moves or the list itself changes, which is what lets `Tab` cycle
   * through long paths as well as the pointer open one.
   */
  useEffect(() => {
    if (!open) {
      setMarquee(null);
      return;
    }
    const focused = focusedRowIndex(hoveredIndex, selectedIndex);
    const uri = order[focused]?.doc.uri ?? null;
    const plan = uri ? measureMarquee(listRef.current?.querySelector(`[data-row-index="${focused}"]`) ?? null) : null;
    setMarquee(plan ? { uri, ...plan } : null);
  }, [open, hoveredIndex, selectedIndex, order]);

  if (!open || order.length === 0) return null;

  return (
    <div
      // The one overlay in the application with no scrim at all: `Ctrl` is held
      // for the whole gesture, so anything that dimmed the editor would flicker
      // under a held key. The backdrop is therefore only the gesture's own hit
      // area — and the thing that closes the popup when it is clicked.
      style={backdrop}
      data-testid="tab-switcher"
      // The popup covers the window while `Ctrl` is held, so it claims the whole
      // of `Ctrl`+wheel: over the list it scrolls, and over the backdrop it does
      // nothing rather than zooming the shell behind it.
      {...{ [CTRL_WHEEL_ATTRIBUTE]: 'true' }}
      onMouseDown={() => setOpen(false)}
    >
      {/*
        The popup's surface is `.eu-popover` + `.eu-tab-switcher`; its *layout*
        is stated inline as well, because
        `tests/ui/tab-switcher.test.ts` ("makes the list the flexing scroll
        container under a fixed header") reads `display`, `flexDirection` and
        `maxHeight` back off this element and off the header below it. Keeping
        the four declarations together is also the only way to read the rule they
        encode: the header is fixed, the list flexes, the panel has a ceiling.
      */}
      <div
        className="eu-popover eu-tab-switcher"
        style={panel}
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="eu-tab-switcher__header" style={header}>
          <span className="eu-eyebrow">Tabs</span>
          <span className="eu-tab-switcher__hint">
            {index + 1} / {order.length} · release Ctrl to switch
          </span>
        </div>

        <div
          ref={listRef}
          // `overflowY`, `minHeight` and `flex` are stated inline as well: what
          // makes the rows scroll rather than the panel grow is asserted in
          // `tests/ui/tab-switcher.test.ts` ("makes the list the flexing scroll
          // container under a fixed header"), which reads them back off the
          // element. The class carries the padding and the scrollbar.
          style={list}
          className="eu-scroll eu-tab-switcher__list"
          role="listbox"
          aria-label="Open tabs"
          // Leaving the list hands the slide back to the keyboard, so the row
          // the highlight is on is the one that stays open.
          onMouseLeave={() => setHoveredIndex(null)}
        >
          {order.map((entry, entryIndex) => {
            const uri = entry.doc.uri;
            const isSelected = entryIndex === selectedIndex;
            const isFocused = isFocusedRow(entryIndex, hoveredIndex, selectedIndex);
            const running = marquee?.uri === uri ? marquee : null;
            const DocumentIcon = /\.tex$/i.test(tabTitle(entry)) ? FileText : FileCode;
            return (
              <div
                key={uri}
                ref={isSelected ? selectedRowRef : undefined}
                role="option"
                aria-selected={isSelected}
                data-testid="tab-switcher-row"
                data-uri={uri}
                data-row-index={entryIndex}
                data-selected={isSelected ? 'true' : 'false'}
                data-focused={isFocused ? 'true' : 'false'}
                onMouseEnter={() => {
                  setIndex(entryIndex);
                  setHoveredIndex(entryIndex);
                }}
                onMouseDown={event => {
                  event.stopPropagation();
                  setIndex(entryIndex);
                  setActiveDocument(uri);
                  setOpen(false);
                  onCommitted?.(uri);
                }}
                className="eu-tab-switcher__row"
                // `...row` is the row's pinned rhythm — 2px of padding, which
                // `tests/ui/tab-switcher.test.ts` reads back (`row.style.paddingTop`
                // is `'2px'`), and which is what keeps a title swapping for a path
                // from changing the list's height. It is inline so that rhythm can
                // be read next to the two line heights it is a sum of.
                style={{ ...row, background: isSelected ? 'var(--eu-bg-active)' : 'transparent' }}
              >
                {/* The document glyph: the row's left edge, and the only thing
                    in the popup that is not text. It sits outside the title so
                    a row's name starts where every other row's does — and so a
                    title is a title, which is also what the tests assert. */}
                <DocumentIcon size={13} strokeWidth={1.8} className="eu-tab-switcher__icon" />

                <span className="eu-tab-switcher__body">
                  <span style={rowTitle}>
                    <span data-testid="tab-switcher-title" style={titleText}>{tabTitle(entry)}</span>
                    {entry.doc.getDirty() && <span style={{ color: 'var(--eu-warning)' }}>●</span>}
                  </span>
                  {/*
                    The path is always on screen; the focused row's is the one
                    that moves, so a path wider than the row still shows its tail.
                  */}
                  <span className="eu-tab-switcher__path" style={rowPath} data-testid="tab-switcher-path">
                    <span
                      style={pathText(running)}
                      data-testid="tab-switcher-path-text"
                      data-marquee={running ? 'true' : 'false'}
                    >
                      {uri}
                    </span>
                  </span>
                </span>

                <button
                  type="button"
                  data-testid="tab-switcher-pin"
                  data-pinned={entry.pinned ? 'true' : 'false'}
                  title={entry.pinned ? 'Unpin tab' : 'Pin tab'}
                  aria-label={entry.pinned ? `Unpin ${tabTitle(entry)}` : `Pin ${tabTitle(entry)}`}
                  onMouseDown={event => {
                    event.stopPropagation();
                    // Keep the popup up: pinning reorders the list, so the user
                    // stays in the popup to see the result.
                    workspaceService.togglePin(uri);
                  }}
                  // One glyph for both states, coloured by the state: a pin that
                  // changes shape reads as a different control rather than as
                  // the same control switched on. The colour is inline because
                  // `tests/ui/tab-switcher.test.ts` reads exactly that string off
                  // the element ("colours a pinned row's pin with the accent").
                  className="eu-icon-btn eu-tab-switcher__action"
                  style={{ color: entry.pinned ? 'var(--eu-accent)' : 'var(--eu-fg-secondary)' }}
                >
                  <Pin size={12} strokeWidth={2} />
                </button>

                <button
                  type="button"
                  data-testid="tab-switcher-close"
                  title="Close tab"
                  aria-label={`Close ${tabTitle(entry)}`}
                  onMouseDown={event => {
                    event.stopPropagation();
                    closeDocument(uri);
                    setIndex(previous => Math.max(0, Math.min(previous, orderRef.current.length - 2)));
                  }}
                  className="eu-icon-btn eu-tab-switcher__action"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/* --------------------------------------------------------------- styling */

/**
 * What is *not* here is the point: the popup's surface, its header band, its
 * scroll list and its rows are `.eu-popover`, `.eu-tab-switcher__*` and
 * `.eu-row` in `../overlays.css`, beside the palette and quick open, which are
 * the same kind of surface. Only the two things a render decides are left:
 * where the popup hangs, and how far a path has slid.
 */

const backdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  paddingTop: '12vh',
  background: 'transparent'
};

/**
 * The panel and its header, stated inline because the tests read them back:
 * `tests/ui/tab-switcher.test.ts` asserts `display: flex`, `flexDirection:
 * column` and `maxHeight: 60vh` on the panel, and `flexShrink: 0` on its first
 * child. The *look* — the surface, the shadow, the radius, the arrival — is
 * `.eu-popover` and `.eu-tab-switcher` in `../overlays.css`; these two objects
 * are the layout those rules have to leave alone.
 */
const panel: React.CSSProperties = {
  width: 460,
  maxWidth: '80vw',
  maxHeight: '60vh',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden'
};

const header: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  // The header is fixed: the list below it is what flexes and scrolls when the
  // panel hits its `maxHeight`.
  flexShrink: 0
};

const list: React.CSSProperties = {
  flex: '1 1 auto',
  // Without this a flex item refuses to shrink below its content, which is what
  // stopped the rows from scrolling and let the panel grow past its cap.
  minHeight: 0,
  overflowY: 'auto',
  padding: 3
};

/**
 * A row is two tight lines — the title over its path — so a long list fits in
 * the popup. The heights are pinned rather than left to the line boxes, because
 * a row swapping its title for a path must not change the list's rhythm.
 *
 * These three sets of numbers are asserted in `tests/ui/tab-switcher.test.ts`
 * ("keeps a row two tight lines tall, whatever it holds"), which reads
 * `paddingTop`, the title's `height` and the path's `height` straight off the
 * elements — so they stay inline, where the sum they make is visible.
 */
const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '2px 6px',
  borderRadius: 5,
  cursor: 'pointer'
};

const rowTitle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  height: 13,
  fontSize: 12,
  lineHeight: '13px',
  color: 'var(--eu-fg-primary)',
  minWidth: 0
};

const titleText: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
};

const rowPath: React.CSSProperties = {
  height: 11,
  fontSize: 10,
  lineHeight: '11px',
  color: 'var(--eu-fg-muted)',
  // The clip is what the sliding text moves behind, so it owns the overflow.
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  minWidth: 0
};

/** The path's own moving part: still, or sliding left to bring its tail in. */
function pathText(running: { distance: number; durationMs: number } | null): React.CSSProperties {
  return {
    display: 'inline-block',
    whiteSpace: 'nowrap',
    // `max-content` keeps the text at its own width instead of being squeezed to
    // the clip: the element that is measured is then the whole path, and what
    // the clip hides is exactly what has to be slid into view.
    width: 'max-content',
    maxWidth: 'none',
    transform: running ? `translateX(-${running.distance}px)` : 'translateX(0)',
    // The slide is linear and paced by the distance; letting go of the row eases
    // the path back under its own short transition. `prefers-reduced-motion`
    // collapses both to nothing, so the path simply appears where it lands.
    transition: running ? `transform ${running.durationMs}ms linear` : 'transform 150ms ease-out'
  };
}

export default TabSwitcher;