/**
 * CommandPalette — fuzzy access to every registered command
 * (Instructions.md §46, §47, §48).
 *
 * The palette is a pure view over `commandRegistry`: searching, ordering,
 * recently-used commands and keybinding lookup all come from the registry, so a
 * button here and a keybinding elsewhere run exactly the same implementation.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../state';
import { commandRegistry, formatKeybinding, type Command } from '../../core/commands';
import { ScrollArea, type ScrollAreaHandle } from './ScrollArea';
import {
  AtSign,
  Code,
  FileCode,
  FileText,
  Keyboard,
  Search,
  Settings,
  SquareFunction,
  TerminalSquare,
  type LucideIcon
} from './icons';

export interface CommandPaletteProps {
  /** No props: the palette is driven entirely by `paletteOpen` in app state. */
}

export interface HighlightSegment {
  text: string;
  matched: boolean;
}

/** Hard cap on rendered rows; the list is not virtualised (Instructions.md §47). */
export const MAX_PALETTE_ROWS = 200;

/**
 * Fuzzy match score. `0` means "no match"; larger is better. A contiguous
 * substring always beats a subsequence match, and a hit at the start of a word
 * beats one in the middle — the same ordering rules the command registry uses,
 * so file and command results feel consistent.
 */
export function fuzzyScore(needle: string, haystack: string): number {
  const query = needle.trim().toLowerCase();
  const text = haystack.toLowerCase();
  if (!query) return 1;

  const substringIndex = text.indexOf(query);
  if (substringIndex !== -1) {
    const atBoundary = substringIndex === 0 || /[\s:.\-/\\_]/.test(text[substringIndex - 1]);
    return 1000 + (atBoundary ? 200 : 0) - substringIndex;
  }

  let score = 0;
  let cursor = 0;
  let streak = 0;
  for (const character of query) {
    const found = text.indexOf(character, cursor);
    if (found === -1) return 0;
    if (found === 0 || /[\s:.\-/\\_]/.test(text[found - 1])) score += 8;
    streak = found === cursor ? streak + 1 : 0;
    score += 2 + streak;
    cursor = found + 1;
  }
  return score;
}

/**
 * Splits `text` into runs so the caller can emphasise the characters that
 * matched `query`. A contiguous hit is highlighted as one run; otherwise the
 * fuzzy subsequence characters are marked individually.
 */
export function fuzzyHighlight(text: string, query: string): HighlightSegment[] {
  const trimmed = query.trim();
  if (!text) return [];
  if (!trimmed) return [{ text, matched: false }];

  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();

  const substringIndex = lowerText.indexOf(lowerQuery);
  if (substringIndex !== -1) {
    const segments: HighlightSegment[] = [];
    if (substringIndex > 0) segments.push({ text: text.slice(0, substringIndex), matched: false });
    segments.push({ text: text.slice(substringIndex, substringIndex + lowerQuery.length), matched: true });
    const rest = text.slice(substringIndex + lowerQuery.length);
    if (rest) segments.push({ text: rest, matched: false });
    return segments;
  }

  const matchedIndexes = new Set<number>();
  let cursor = 0;
  for (const character of lowerQuery) {
    const found = lowerText.indexOf(character, cursor);
    if (found === -1) return [{ text, matched: false }];
    matchedIndexes.add(found);
    cursor = found + 1;
  }

  const segments: HighlightSegment[] = [];
  for (let index = 0; index < text.length; index++) {
    const matched = matchedIndexes.has(index);
    const previous = segments[segments.length - 1];
    if (previous && previous.matched === matched) previous.text += text[index];
    else segments.push({ text: text[index], matched });
  }
  return segments;
}

/** Renders the highlighted label as spans. Shared with QuickOpen so both surfaces match. */
export const HighlightedLabel: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const segments = fuzzyHighlight(text, query);
  return (
    <>
      {segments.map((segment, index) =>
        segment.matched ? (
          // The emphasis is a class, not a colour: it has to survive the row
          // being highlighted underneath it, and weight is what does that on the
          // themes where the accent and the primary text are close together.
          <span key={index} className="eu-palette__match">
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  );
};

/**
 * The glyph a command's row leads with.
 *
 * It is chosen from the command's `category` — the one piece of structure the
 * registry already gives a row — rather than from its id, so a command
 * registered by anything at all gets an icon without being listed here. The
 * fallback is a generic file glyph, never nothing: a missing icon would leave
 * one row's title starting further left than every other row's, and a ragged
 * left edge is what makes a command list read as a heap.
 */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  Appearance: Code,
  Edit: Code,
  Editor: Code,
  File: FileText,
  Help: Keyboard,
  LaTeX: FileCode,
  Navigation: AtSign,
  PDF: FileText,
  Preferences: Settings,
  Selection: Code,
  Terminal: TerminalSquare,
  View: Search
};

const iconForCategory = (category: string): LucideIcon => CATEGORY_ICONS[category] ?? SquareFunction;

/** A keycap. The same chip the shell's shortcut lists draw, so a key looks like a key. */
const Key: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <kbd className={className ? `eu-kbd ${className}` : 'eu-kbd'}>{children}</kbd>
);

export const CommandPalette: React.FC<CommandPaletteProps> = () => {

  const { paletteOpen, setPaletteOpen } = useAppState();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [version, setVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<ScrollAreaHandle | null>(null);
  const listElementRef = useRef<HTMLDivElement | null>(null);

  // Commands can be (un)registered while the palette is open; keep in step.
  useEffect(() => {
    if (!paletteOpen) return;
    const disposers = [
      commandRegistry.on('registered', () => setVersion((value) => value + 1)),
      commandRegistry.on('unregistered', () => setVersion((value) => value + 1)),
      commandRegistry.on('keybindings-changed', () => setVersion((value) => value + 1)),
      commandRegistry.on('context', () => setVersion((value) => value + 1))
    ];
    return () => disposers.forEach((dispose) => dispose());
  }, [paletteOpen]);

  useEffect(() => {
    if (!paletteOpen) return;
    setQuery('');
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [paletteOpen]);

  const rows = useMemo<Command[]>(() => {
    if (!paletteOpen) return [];
    // `version` is a dependency so newly registered commands appear at once.
    void version;
    return commandRegistry.search(query).slice(0, MAX_PALETTE_ROWS);
  }, [paletteOpen, query, version]);

  const recentIds = useMemo(() => {
    if (!paletteOpen || query.trim()) return new Set<string>();
    return new Set(commandRegistry.getRecentlyUsed().map((command) => command.id));
  }, [paletteOpen, query, version]);

  const totalMatches = rows.length;
  const clampedIndex = totalMatches === 0 ? -1 : Math.min(activeIndex, totalMatches - 1);

  // A new query means a new result list; start it from the top.
  useEffect(() => {
    listRef.current?.scrollTo(0, false);
  }, [query]);

  // Keep the active row visible without animating the whole list.
  useEffect(() => {
    if (clampedIndex < 0) return;
    const container = listElementRef.current;
    if (!container) return;
    const row = container.querySelector<HTMLElement>(`[data-row-index="${clampedIndex}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [clampedIndex, rows]);

  const run = useCallback(
    (command: Command | undefined) => {
      if (!command) return;
      setPaletteOpen(false);
      // Closing first keeps the UI responsive and lets the command open its own
      // surface (settings, a modal, …) without fighting this one.
      void commandRegistry.execute(command.id);
    },
    [setPaletteOpen]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          event.stopPropagation();
          if (totalMatches === 0) return;
          setActiveIndex((index) => (index + 1) % totalMatches);
          break;
        case 'ArrowUp':
          event.preventDefault();
          event.stopPropagation();
          if (totalMatches === 0) return;
          setActiveIndex((index) => (index - 1 + totalMatches) % totalMatches);
          break;
        case 'PageDown':
          event.preventDefault();
          event.stopPropagation();
          setActiveIndex((index) => Math.min(index + 10, Math.max(0, totalMatches - 1)));
          break;
        case 'PageUp':
          event.preventDefault();
          event.stopPropagation();
          setActiveIndex((index) => Math.max(index - 10, 0));
          break;
        case 'Home':
          if (event.ctrlKey) break;
          event.preventDefault();
          setActiveIndex(0);
          break;
        case 'End':
          if (event.ctrlKey) break;
          event.preventDefault();
          setActiveIndex(Math.max(0, totalMatches - 1));
          break;
        case 'Enter':
          event.preventDefault();
          event.stopPropagation();
          run(rows[clampedIndex]);
          break;
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          setPaletteOpen(false);
          break;
        default:
          break;
      }
    },
    [clampedIndex, rows, run, setPaletteOpen, totalMatches]
  );

  if (!paletteOpen) return null;

  let headerRendered = false;

  return (
    <div
      // The palette is a dialog that hangs from the top of the window rather
      // than sitting in the middle of it — its height changes as the user types,
      // and a centred panel that grew would move the field the user is typing
      // into. `.eu-backdrop` supplies the scrim, the fade and the blur;
      // `--top` the alignment.
      className="eu-backdrop eu-overlay--top"
      // The one thing the palette decides for itself: it has to sit above the
      // quick-open overlay (210) so that whichever opened last is on top.
      style={{ zIndex: 220 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPaletteOpen(false);
      }}
    >
      <div className="eu-dialog eu-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="eu-palette__search">
          <Search size={16} strokeWidth={2} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command…"
            aria-label="Search commands"
            aria-controls="eukolia-command-palette-list"
            role="combobox"
            aria-expanded="true"
            spellCheck={false}
            className="eu-palette__input"
          />
          {/* The trailing hint: the shortcut that reopens this surface, so the
              gesture is learnable from the surface itself. */}
          <span className="eu-palette__hint">
            <Key>Ctrl</Key>
            <Key>Shift</Key>
            <Key>P</Key>
          </span>
        </div>

        <ScrollArea className="eu-palette__list" handleRef={listRef} style={{ maxHeight: '60vh' }}>
          <div id="eukolia-command-palette-list" ref={listElementRef} role="listbox" aria-label="Commands">
            {rows.map((command, index) => {
              const binding = commandRegistry.getKeybinding(command.id);
              const showRecentHeader = !headerRendered && recentIds.has(command.id);
              const showAllHeader = !showRecentHeader && !headerRendered && !recentIds.has(command.id);
              if (showRecentHeader || showAllHeader) headerRendered = true;
              const Icon = iconForCategory(command.category);

              return (
                <React.Fragment key={`${command.id}-${index}`}>
                  {showRecentHeader && <div className="eu-section eu-palette__group">Recently used</div>}
                  {showAllHeader && <div className="eu-section eu-palette__group">All commands</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === clampedIndex}
                    data-row-index={index}
                    tabIndex={-1}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => run(command)}
                    title={binding ? `${command.category}: ${command.title} (${formatKeybinding(binding)})` : `${command.category}: ${command.title}`}
                    className="eu-row eu-palette__row"
                    // The highlighted row's *surface* is the only thing computed
                    // per render here; the leading accent rule, the icon colour
                    // and the transition into both are the stylesheet's, so that
                    // an arrow keypress repaints two properties and not a layout.
                    style={{ background: index === clampedIndex ? 'var(--eu-bg-selection-list)' : 'transparent' }}
                  >
                    <Icon size={13} strokeWidth={1.8} className="eu-palette__icon" />
                    <span className="eu-palette__title">
                      <HighlightedLabel text={command.title} query={query} />
                    </span>
                    <span className="eu-chip eu-palette__category">{command.category}</span>
                    {binding && <Key className="eu-palette__key">{formatKeybinding(binding)}</Key>}
                  </button>
                </React.Fragment>
              );
            })}

            {rows.length === 0 && <div className="eu-empty">No matching commands.</div>}
          </div>
        </ScrollArea>

        <div className="eu-palette__footer">
          <span className="eu-palette__legend">
            <Key>↑</Key> <Key>↓</Key> navigate
          </span>
          <span className="eu-palette__legend">
            <Key>↵</Key> run
          </span>
          <span className="eu-palette__legend">
            <Key>Esc</Key> close
          </span>
          <span className="eu-palette__count">
            {totalMatches}
            {totalMatches >= MAX_PALETTE_ROWS ? `+ of ${commandRegistry.getAvailable().length}` : ''} command{totalMatches === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </div>
  );
};

/*
 * The palette's own geometry — the panel's width and height cap, the search
 * band, the sticky group bands, the highlighted row's tinted surface and accent
 * rule — is in `../overlays.css`, where it sits beside quick open's, because the
 * two are one control seen twice and any difference between them is a bug.
 *
 * What is left here is only what a render computes: the backdrop's `zIndex`
 * (which has to beat the quick-open overlay) and the selected row's `background`.
 */

export default CommandPalette;