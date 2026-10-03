/**
 * QuickOpen — the fuzzy file finder (Instructions.md §49 "File search").
 *
 * Plain queries search the project index by file name and relative path. Two
 * suffixes extend the same input field, which is what makes the surface useful
 * without adding controls:
 *
 *   - `main.tex:120`      → open that file at line 120
 *   - `main.tex:120:8`    → …at line 120, column 8
 *   - `@introduction`     → jump to a section of the current file's outline
 *
 * Keyboard handling and highlighting are deliberately identical to the command
 * palette; `HighlightedLabel` is imported from there rather than reimplemented.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../state';
import { projectIndex } from '../../document/projectIndex';
import type { OutlineItem } from '../../document/analysisTypes';
import { fuzzyScore, HighlightedLabel, MAX_PALETTE_ROWS } from './CommandPalette';
import { ScrollArea, type ScrollAreaHandle } from './ScrollArea';
import { AtSign, CornerDownLeft, FileText, Search } from './icons';

export interface QuickOpenProps {
  /** No props: driven entirely by `quickOpenOpen` in app state. */
}

export interface QuickOpenTarget {
  /** File part of the query, with any `:line[:column]` suffix removed. */
  path: string;
  line?: number;
  column?: number;
  /** True when the query used the `@` symbol prefix. */
  symbol: boolean;
  /** Text after `@`; empty means "list every symbol". */
  symbolQuery: string;
}

const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/;

/**
 * Splits a quick-open query into an optional file path, an optional position and
 * an optional symbol search. A suffix that would leave the path empty (`:12`) is
 * not treated as a position, so a stray colon cannot silently clear the query.
 */
export function parseQuickOpenQuery(query: string): QuickOpenTarget {
  const raw = query.trim();

  if (raw.startsWith('@')) {
    return { path: '', symbol: true, symbolQuery: raw.slice(1).trim() };
  }

  const match = LINE_SUFFIX.exec(raw);
  if (match && match.index > 0) {
    const path = raw.slice(0, match.index);
    const line = Math.max(1, Number(match[1]));
    const column = match[2] === undefined ? undefined : Math.max(1, Number(match[2]));
    return { path, line, column, symbol: false, symbolQuery: '' };
  }

  return { path: raw, symbol: false, symbolQuery: '' };
}

/** Flattens an outline tree into jump targets, keeping the visual depth. */
export interface FlatSymbol {
  title: string;
  level: number;
  line: number;
  labels: readonly string[];
}

export function flattenOutline(items: readonly OutlineItem[]): FlatSymbol[] {
  const result: FlatSymbol[] = [];
  const walk = (list: readonly OutlineItem[]) => {
    for (const item of list) {
      result.push({ title: item.title, level: item.level, line: item.line, labels: item.labels });
      if (item.children.length > 0) walk(item.children);
    }
  };
  walk(items);
  return result;
}

export const QuickOpen: React.FC<QuickOpenProps> = () => {

  const { quickOpenOpen, setQuickOpenOpen, openFile, outline, activeDocument } = useAppState();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<ScrollAreaHandle | null>(null);
  const listElementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!quickOpenOpen) return;
    setQuery('');
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [quickOpenOpen]);

  const target = useMemo(() => parseQuickOpenQuery(query), [query]);

  const fileRows = useMemo(() => {
    if (!quickOpenOpen || target.symbol) return [];
    const files = projectIndex.getFiles().filter((file) => !file.isDirectory);
    if (!target.path) {
      return files.slice(0, MAX_PALETTE_ROWS).map((file) => ({ path: file.path, name: file.name, relativePath: file.relativePath, score: 0 }));
    }
    return files
      .map((file) => ({
        path: file.path,
        name: file.name,
        relativePath: file.relativePath,
        score: Math.max(fuzzyScore(target.path, file.name) * 1.2, fuzzyScore(target.path, file.relativePath))
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
      .slice(0, MAX_PALETTE_ROWS);
  }, [quickOpenOpen, target.path, target.symbol]);

  const symbolRows = useMemo(() => {
    if (!quickOpenOpen || !target.symbol) return [];
    const flat = flattenOutline(outline);
    if (!target.symbolQuery) return flat.slice(0, MAX_PALETTE_ROWS);
    return flat
      .map((symbol) => ({ symbol, score: fuzzyScore(target.symbolQuery, symbol.title) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.symbol)
      .slice(0, MAX_PALETTE_ROWS);
  }, [quickOpenOpen, outline, target.symbol, target.symbolQuery]);

  const totalMatches = target.symbol ? symbolRows.length : fileRows.length;
  const clampedIndex = totalMatches === 0 ? -1 : Math.min(activeIndex, totalMatches - 1);

  useEffect(() => {
    listRef.current?.scrollTo(0, false);
  }, [query]);

  useEffect(() => {
    if (clampedIndex < 0) return;
    const container = listElementRef.current;
    container?.querySelector<HTMLElement>(`[data-row-index="${clampedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [clampedIndex, fileRows, symbolRows]);

  const accept = useCallback(() => {
    if (target.symbol) {
      const symbol = symbolRows[clampedIndex];
      const uri = activeDocument?.doc.uri;
      if (!symbol || !uri) return;
      setQuickOpenOpen(false);
      void openFile(uri, symbol.line, 1);
      return;
    }

    const chosen = fileRows[clampedIndex]?.path ?? target.path;
    if (!chosen) return;
    setQuickOpenOpen(false);
    void openFile(chosen, target.line, target.column);
  }, [activeDocument, clampedIndex, fileRows, openFile, setQuickOpenOpen, symbolRows, target]);

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
        case 'Enter':
          event.preventDefault();
          event.stopPropagation();
          accept();
          break;
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          setQuickOpenOpen(false);
          break;
        default:
          break;
      }
    },
    [accept, setQuickOpenOpen, totalMatches]
  );

  if (!quickOpenOpen) return null;

  const symbolModeUnavailable = target.symbol && !activeDocument;

  return (
    <div
      // Quick open is the palette's sibling and is drawn as one: the same scrim,
      // the same top-hung panel, the same search band. The user opens both with
      // a keystroke, so the only thing that should differ between them is what
      // the rows contain.
      className="eu-backdrop eu-overlay--top"
      // One below the palette (220), so opening the palette over quick open
      // leaves the palette on top.
      style={{ zIndex: 210 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setQuickOpenOpen(false);
      }}
    >
      <div className="eu-dialog eu-palette" role="dialog" aria-modal="true" aria-label="Quick open">
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
            placeholder="Search files by name · add :line[:col] to jump · @ for symbols in this file"
            aria-label="Search files"
            aria-controls="eukolia-quick-open-list"
            role="combobox"
            aria-expanded="true"
            spellCheck={false}
            className="eu-palette__input"
          />
          {/* The mode is part of the query syntax, so its two markers are stated
              on the field rather than in a control: there is nothing to click,
              and the user has to be told the syntax somewhere. */}
          <span className="eu-palette__hint">
            <kbd className="eu-kbd">Ctrl</kbd>
            <kbd className="eu-kbd">P</kbd>
          </span>
        </div>

        <ScrollArea className="eu-palette__list" handleRef={listRef} style={{ maxHeight: '60vh' }}>
          <div id="eukolia-quick-open-list" ref={listElementRef} role="listbox" aria-label="Files">
            {!target.symbol &&
              fileRows.map((file, index) => (
                <button
                  key={file.path}
                  type="button"
                  role="option"
                  aria-selected={index === clampedIndex}
                  data-row-index={index}
                  tabIndex={-1}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={accept}
                  title={file.path}
                  className="eu-row eu-palette__row"
                  // See the palette: the selected row's surface is the only
                  // per-render value; the accent rule and the transition into it
                  // are the stylesheet's.
                  style={{ background: index === clampedIndex ? 'var(--eu-bg-selection-list)' : 'transparent' }}
                >
                  <FileText size={13} strokeWidth={1.8} className="eu-palette__icon" />
                  <span className="eu-palette__basename eu-mono">
                    <HighlightedLabel text={file.name} query={target.path} />
                  </span>
                  {/* The directory: dim, and clipped from its *start* when it
                      has to clip, because the end of a path is the part that
                      identifies it. */}
                  <span className="eu-palette__dirname eu-mono">
                    <span>{file.relativePath}</span>
                  </span>
                  {target.line !== undefined && (
                    <span className="eu-palette__position">
                      :{target.line}
                      {target.column !== undefined ? `:${target.column}` : ''}
                    </span>
                  )}
                </button>
              ))}

            {target.symbol &&
              symbolRows.map((symbol, index) => (
                <button
                  key={`${symbol.line}-${symbol.title}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === clampedIndex}
                  data-row-index={index}
                  tabIndex={-1}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={accept}
                  title={`${symbol.title} — line ${symbol.line}`}
                  className="eu-row eu-palette__row"
                  style={{
                    // The indent is the outline's own depth, which only the data
                    // knows, so it is computed here; everything else the row
                    // wears is the palette's.
                    paddingLeft: 12 + symbol.level * 12,
                    background: index === clampedIndex ? 'var(--eu-bg-selection-list)' : 'transparent'
                  }}
                >
                  <span className="eu-palette__line">{symbol.line}</span>
                  <span className="eu-palette__title">
                    <HighlightedLabel text={symbol.title} query={target.symbolQuery} />
                  </span>
                  <span className="eu-palette__labels">
                    {symbol.labels.map((label) => (
                      <span key={label} className="eu-palette__label">
                        {label}
                      </span>
                    ))}
                  </span>
                </button>
              ))}

            {totalMatches === 0 && (
              <div className="eu-empty">
                {symbolModeUnavailable
                  ? 'Symbol search needs an open document.'
                  : target.symbol
                    ? 'No outline entry matches.'
                    : 'No indexed file matches. Press Enter to open the typed path.'}
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="eu-palette__footer">
          <span className="eu-palette__legend">
            <AtSign size={11} strokeWidth={2} aria-hidden="true" />
            <span>symbols in this file</span>
          </span>
          <span className="eu-palette__footer-sep">·</span>
          <span className="eu-palette__legend">
            <code className="eu-palette__syntax">:line:col</code>
            <span>jump to a position</span>
          </span>
          <span className="eu-palette__count eu-palette__legend">
            <CornerDownLeft size={11} strokeWidth={2} aria-hidden="true" />
            open · Esc close
          </span>
        </div>
      </div>
    </div>
  );
};

/*
 * Every geometry decision this overlay makes is in `../overlays.css`, in the
 * section it shares with the command palette: the two are one control seen
 * twice. What is left in the render is the backdrop's `zIndex` (which has to
 * lose to the palette's) and an outline entry's indent.
 */

export default QuickOpen;