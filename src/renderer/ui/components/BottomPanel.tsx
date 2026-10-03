/**
 * BottomPanel — Problems, Output, Log, Search Results and the Terminal
 * (Instructions.md §33, §49, §55).
 *
 * The panel is resizable from its top edge (pointer capture, plus arrow-key
 * support on the divider) and remembers its height for the session. Each tab
 * shows real data:
 *
 *  - Problems      — compiler diagnostics, filterable by severity, grouped by file;
 *  - Output        — the raw compiler stream, auto-followed while a build runs;
 *  - Log           — those messages as parsed by the LaTeX log parser, including
 *                    bad boxes and informational notes the Problems list buries;
 *  - Search Results— the project search hits from `AppState.search`;
 *  - Terminal      — a real PTY-backed shell in the project directory, drawn by
 *                    a VT emulator (`Terminal.tsx` owns the session and the
 *                    emulator; the panel only decides where it is shown).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../state';
import type { BottomPanelView } from '../state';
import type { DiagnosticSeverityName } from '../../compiler/logParser';
import { buildService } from '../../services/build';
import { setting } from '../../core/settings';
import { formatBuildFailure } from '../../compiler/buildFailure';
import { ScrollArea, type ScrollAreaHandle } from './ScrollArea';
import { highlightSearchHit, severityIcon } from './Sidebar';
import { ChevronDown, CircleAlert, CircleX, FileText, TriangleAlert } from './icons';
// The panel's look. The component keeps what is dynamic — the panel's height, the
// divider's dragging state, the cursor of a log row that cannot be jumped to —
// and the sheet owns the surfaces, the rows, the sticky bands and the terminal's
// frame; see its header for why the split is drawn where it is.
import '../panel-surfaces.css';

/**
 * The terminal is loaded on first use.
 *
 * `xterm.js` and its two addons are ~340 KB, and the panel mounts the terminal
 * only once its view has been visited (`terminalVisited` below) — so before this,
 * that 340 KB was fetched and evaluated by *every* launch, including the ones
 * that never open a shell. The dynamic import moves it to the interaction that
 * asks for one; the host keeps the panel's box while the chunk arrives, so
 * opening the terminal is a fill rather than a jump.
 */
const Terminal = React.lazy(() =>
  import('./Terminal').then((module) => ({
    default: module.Terminal
  }))
);

export interface BottomPanelProps {
  /** No props: visibility, the active tab and the data all come from app state. */
}

export const MIN_PANEL_HEIGHT = 90;
export const MAX_PANEL_HEIGHT = 720;
export const DEFAULT_PANEL_HEIGHT = 210;

/** Clamps a panel height into the usable range. */
export function clampPanelHeight(value: number, min = MIN_PANEL_HEIGHT, max = MAX_PANEL_HEIGHT): number {
  if (!Number.isFinite(value)) return DEFAULT_PANEL_HEIGHT;
  return Math.min(Math.max(value, min), max);
}

/** True when a scroll container is close enough to its bottom to keep following. */
export function isNearBottom(top: number, clientHeight: number, scrollHeight: number, slack = 24): boolean {
  return scrollHeight - (top + clientHeight) <= slack;
}

/**
 * The tail of a compiler log, and how many lines were left out.
 *
 * A build's log is bounded by characters (4 MB), and a MiKTeX run of a large
 * document reaches that: rendering it whole means laying out tens of thousands
 * of lines inside a `pre` in a panel a few hundred pixels tall, on every commit
 * that touches the panel. `compilation.maxLogLines` is what says how much of it
 * a reader wants, and the count that was dropped is returned rather than hidden
 * — a log that starts mid-sentence has to say that it does.
 *
 * `maximum <= 0` means the setting is unset or nonsensical; the whole log is
 * then the honest answer.
 */
export function tailLines(text: string, maximum: number): { text: string; dropped: number } {
  if (!Number.isFinite(maximum) || maximum <= 0) return { text, dropped: 0 };
  const lines = text.split('\n');
  if (lines.length <= maximum) return { text, dropped: 0 };
  const kept = lines.slice(lines.length - maximum);
  return { text: kept.join('\n'), dropped: lines.length - maximum };
}

/** The sentence the panel prints when a build failed. */
export function failureHeadline(failure: { step?: string; stepIndex?: number; totalSteps?: number }): string {
  return failure.step ? `Build failed — ${failure.step}` : 'Build failed';
}

const PANEL_TABS: Array<{ view: BottomPanelView; label: string; title: string }> = [
  { view: 'problems', label: 'Problems', title: 'Compiler diagnostics (Ctrl+Shift+M)' },
  { view: 'output', label: 'Output', title: 'Raw compiler output' },
  { view: 'log', label: 'Log', title: 'Messages parsed from the LaTeX log' },
  { view: 'search', label: 'Search Results', title: 'Project search results' },
  { view: 'terminal', label: 'Terminal', title: 'Integrated terminal (Ctrl+`)' }
];

/**
 * The element each view renders its own content into.
 *
 * A test id per view rather than one per panel, because "the panel is open" and
 * "the panel is showing this view's content" are different claims: the first is
 * true of a panel whose body failed to render, and only the second one is what a
 * reader means by the panel working. The end-to-end probe switches through all
 * five and asserts each one's own marker.
 */
const VIEW_TEST_IDS: Record<BottomPanelView, string> = {
  problems: 'problems-list',
  output: 'output-stream',
  log: 'log-list',
  search: 'search-list',
  terminal: 'terminal-panel'
};

type SeverityFilter = 'all' | DiagnosticSeverityName;

export const BottomPanel: React.FC<BottomPanelProps> = () => {

  const {
    bottomPanelVisible,
    bottomPanelView,
    setBottomPanelView,
    toggleBottomPanel,
    diagnostics,
    build,
    search,
    workspace,
    goToSource
  } = useAppState();

  const [height, setHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [problemFilter, setProblemFilter] = useState('');
  const [following, setFollowing] = useState(true);
  const outputRef = useRef<ScrollAreaHandle | null>(null);
  const [dragging, setDragging] = useState(false);
  // The terminal is mounted on first visit and then kept mounted for as long as
  // the panel is open, so switching to Problems and back keeps the shell and its
  // scrollback. It is unmounted — which ends the session — when the panel itself
  // closes or the view is never opened.
  const [terminalVisited, setTerminalVisited] = useState(bottomPanelView === 'terminal');

  useEffect(() => {
    if (bottomPanelView === 'terminal') setTerminalVisited(true);
  }, [bottomPanelView]);

  const errorCount = useMemo(() => diagnostics.filter((item) => item.severity === 'error').length, [diagnostics]);
  const warningCount = useMemo(() => diagnostics.filter((item) => item.severity === 'warning').length, [diagnostics]);

  // The Output view shows the tail of the log, bounded by the setting that says
  // how much of it a reader wants. The full text stays in `build.output`, which
  // is what the log parser and the diagnostics are built from.
  const maxLogLines = setting.num('compilation.maxLogLines');
  const trimmedOutput = useMemo(() => tailLines(build.output, maxLogLines), [build.output, maxLogLines]);

  // ---------------------------------------------------------- output follow

  useEffect(() => {
    if (!following || build.status !== 'running') return;
    const element = outputRef.current?.getElement();
    if (!element) return;
    outputRef.current?.scrollTo(element.scrollHeight, false);
  }, [build.output, build.status, following, bottomPanelView, bottomPanelVisible]);

  // ------------------------------------------------------------ resizing

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      const startY = event.clientY;
      const startHeight = height;
      handle.setPointerCapture(event.pointerId);
      setDragging(true);

      const onPointerMove = (moveEvent: PointerEvent) => {
        setHeight(clampPanelHeight(startHeight - (moveEvent.clientY - startY)));
      };
      const onPointerUp = () => {
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', onPointerUp);
        handle.removeEventListener('pointercancel', onPointerUp);
        try {
          handle.releasePointerCapture(event.pointerId);
        } catch {
          /* already released */
        }
        setDragging(false);
      };

      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', onPointerUp);
      handle.addEventListener('pointercancel', onPointerUp);
    },
    [height]
  );

  if (!bottomPanelVisible) return null;

  const problems = diagnostics.filter((item) => {
    if (severityFilter !== 'all' && item.severity !== severityFilter) return false;
    const needle = problemFilter.trim().toLowerCase();
    if (!needle) return true;
    return `${item.message} ${item.file} ${item.code ?? ''}`.toLowerCase().includes(needle);
  });

  const problemGroups = new Map<string, typeof diagnostics>();
  for (const item of problems) {
    const list = problemGroups.get(item.file);
    if (list) list.push(item);
    else problemGroups.set(item.file, [item]);
  }

  const searchGroups = new Map<string, typeof search.results>();
  for (const hit of search.results) {
    const list = searchGroups.get(hit.path);
    if (list) list.push(hit);
    else searchGroups.set(hit.path, [hit]);
  }

  return (
    <div style={{ ...panel, height }} className="eu-bottom-panel" data-testid="bottom-panel" data-panel-view={bottomPanelView}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the panel"
        aria-valuenow={Math.round(height)}
        aria-valuemin={MIN_PANEL_HEIGHT}
        aria-valuemax={MAX_PANEL_HEIGHT}
        tabIndex={0}
        title="Drag to resize · ↑ ↓ to adjust · Home/End for the limits"
        onPointerDown={onPointerDown}
        onDoubleClick={() => setHeight(DEFAULT_PANEL_HEIGHT)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setHeight((value) => clampPanelHeight(value + 16));
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setHeight((value) => clampPanelHeight(value - 16));
          } else if (event.key === 'Home') {
            event.preventDefault();
            setHeight(MAX_PANEL_HEIGHT);
          } else if (event.key === 'End') {
            event.preventDefault();
            setHeight(MIN_PANEL_HEIGHT);
          }
        }}
        className="eu-panel-divider"
        style={dragging ? { ...divider, background: 'var(--eu-accent)' } : divider}
      />

      <div style={tabStrip} className="eu-bottom-panel__tabs">
        {PANEL_TABS.map((tab) => {
          const active = bottomPanelView === tab.view;
          const count = tab.view === 'problems' ? diagnostics.length : tab.view === 'search' ? search.results.length : 0;
          return (
            <button
              key={tab.view}
              type="button"
              title={tab.title}
              aria-pressed={active}
              data-testid={`bottom-panel-tab-${tab.view}`}
              onClick={() => setBottomPanelView(tab.view)}
              className="eu-bottom-panel__tab"
            >
              {tab.label}
              {count > 0 && <span className="eu-badge eu-bottom-panel__tab-count">{count}</span>}
              {tab.view === 'problems' && diagnostics.length > 0 && (
                <span className="eu-bottom-panel__tab-glyphs">
                  {errorCount > 0 && <CircleAlert size={11} strokeWidth={2} style={{ color: 'var(--eu-error)' }} />}
                  {warningCount > 0 && <TriangleAlert size={11} strokeWidth={2} style={{ color: 'var(--eu-warning)' }} />}
                </span>
              )}
            </button>
          );
        })}

        <span style={{ flex: 1 }} />

        {bottomPanelView === 'output' && (
          <>
            <button
              type="button"
              title={following ? 'Stop following the build output' : 'Follow the build output again'}
              onClick={() => {
                setFollowing((value) => {
                  const next = !value;
                  if (next) {
                    const element = outputRef.current?.getElement();
                    if (element) outputRef.current?.scrollTo(element.scrollHeight, false);
                  }
                  return next;
                });
              }}
              // The button says which state it is in *and* shows it: the word
              // changes with the state, and the tint is what makes the state
              // readable at a glance in a strip of quiet controls.
              data-eu-active={following}
              className="eu-btn eu-btn-quiet eu-bottom-panel__action"
            >
              {following ? 'Following' : 'Follow'}
            </button>
            <button
              type="button"
              title="Clear the compiler output"
              onClick={() => buildService.clearOutput()}
              className="eu-btn eu-btn-quiet eu-bottom-panel__action"
            >
              Clear
            </button>
          </>
        )}

        <button
          type="button"
          title="Hide the panel (Ctrl+J)"
          aria-label="Hide the panel"
          onClick={() => toggleBottomPanel()}
          className="eu-btn eu-btn-quiet eu-bottom-panel__action eu-bottom-panel__action--icon"
        >
          <ChevronDown size={13} strokeWidth={2} />
        </button>
      </div>

      <div
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        data-testid="bottom-panel-body"
        data-view={bottomPanelView}
      >
        {bottomPanelView === 'problems' && (
          <>
            <div className="eu-bottom-panel__filters">
              <input
                value={problemFilter}
                onChange={(event) => setProblemFilter(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                placeholder="Filter problems"
                aria-label="Filter problems"
                title="Filter by message, file or code"
                spellCheck={false}
                className="eu-input eu-bottom-panel__filter"
              />
              {(['all', 'error', 'warning', 'information'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  title={`Show ${value === 'all' ? 'every severity' : value + 's'}`}
                  aria-pressed={severityFilter === value}
                  onClick={() => setSeverityFilter(value)}
                  className="eu-chip"
                >
                  {value === 'all' ? 'All' : value === 'information' ? 'Info' : `${value[0].toUpperCase()}${value.slice(1)}s`}
                  <span className="eu-bottom-panel__chip-count">
                    {value === 'all' ? diagnostics.length : diagnostics.filter((item) => item.severity === value).length}
                  </span>
                </button>
              ))}
            </div>

            <ScrollArea style={{ flex: 1 }} testId="problems-list">
              {[...problemGroups.entries()].map(([file, items]) => (
                <div key={file}>
                  <div className="eu-section eu-bottom-panel__group" title={file}>
                    <FileText size={12} strokeWidth={1.8} />
                    <span className="eu-bottom-panel__group-name">{file.replace(/^.*[\\/]/, '')}</span>
                    <span className="eu-bottom-panel__group-path">{file}</span>
                    <span style={{ flex: 1 }} />
                    <span className="eu-badge">{items.length}</span>
                  </div>
                  {items.map((item, index) => (
                    <div
                      key={`${item.line}-${index}`}
                      /*
                       * A problem the compiler placed in a file is a button; one
                       * it could not place is not. The build's own failure entry
                       * carries line 0 — there is no line to go to — and a row
                       * that opens a file at line 0 to show nothing is worse
                       * than a row that says it by being inert (`panel-surfaces
                       * .css` styles `[role='button']` and nothing else).
                       */
                      role={item.line > 0 ? 'button' : undefined}
                      tabIndex={item.line > 0 ? 0 : undefined}
                      data-testid="problem-row"
                      data-severity={item.severity}
                      data-file={item.file}
                      data-line={item.line}
                      title={`${item.file}${item.line > 0 ? `:${item.line}${item.column ? `:${item.column}` : ''}` : ''} — ${item.source}${item.code ? ` [${item.code}]` : ''}`}
                      onClick={item.line > 0 ? () => void goToSource(item.file, item.line, item.column ?? 1) : undefined}
                      onKeyDown={
                        item.line > 0
                          ? (event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                void goToSource(item.file, item.line, item.column ?? 1);
                              }
                            }
                          : undefined
                      }
                      className="eu-bottom-panel__row"
                    >
                      {severityIcon(item.severity)}
                      <span className="eu-bottom-panel__row-text">
                        <span className="eu-bottom-panel__row-message">{item.message}</span>
                        {item.lineText && <span className="eu-bottom-panel__row-source">{item.lineText}</span>}
                      </span>
                      <span className="eu-bottom-panel__row-locator">
                        {item.line > 0 ? `${item.file.replace(/^.*[\\/]/, '')}:${item.line}` : item.category}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
              {problemGroups.size === 0 && (
                <div className="eu-empty eu-bottom-panel__empty">
                  {diagnostics.length === 0 ? 'No problems have been reported.' : 'No problems match the current filter.'}
                </div>
              )}
            </ScrollArea>
          </>
        )}

        {bottomPanelView === 'output' && (
          <>
            {/*
              The row that reports the build is the row that shows it: while a
              build is running the panel publishes that state here and the sheet
              draws the indeterminate line at the row's bottom edge. No element is
              added for it — the indication cannot be scrolled away, and it cannot
              be confused with a second scrollbar.
            */}
            <div className="eu-bottom-panel__status eu-tnum" data-eu-running={build.status === 'running'}>
              <span>
                {build.status === 'running'
                  ? `Building${build.totalSteps > 0 ? ` (${build.stepIndex}/${build.totalSteps})` : ''}${build.currentLabel ? `: ${build.currentLabel}` : ''}`
                  : `Build ${build.status}`}
              </span>
              {build.recipeName && (
                <span data-testid="build-recipe" title="The recipe this build resolved">
                  {build.recipeName}
                </span>
              )}
              {build.durationMs !== null && <span>{build.durationMs} ms</span>}
              {build.skipped && <span className="eu-bottom-panel__fact--warning">nothing to do</span>}
              {trimmedOutput.dropped > 0 && (
                <span
                  className="eu-bottom-panel__fact--warning"
                  data-testid="output-trimmed"
                  title={`The panel shows the last ${maxLogLines.toLocaleString()} lines of the compiler output; older lines are in the full log on disk.`}
                >
                  last {maxLogLines.toLocaleString()} of {(maxLogLines + trimmedOutput.dropped).toLocaleString()} lines
                </span>
              )}
              <span className="eu-bottom-panel__spacer" style={{ flex: 1 }} />
              <span>{build.output.length.toLocaleString()} characters</span>
            </div>

            {/*
              Why the build failed, in full and in the open.
              
              The status row above says *that* it failed and the list below holds
              the compiler's own words; neither answers "what do I do next" when
              the build never started — an engine that is not installed, a recipe
              naming a tool that does not exist, a step killed after its time
              limit. This strip is that answer: the exact command, its exit code
              or its launch error, and the first error the compiler reported when
              there is one. It wraps rather than truncating, because a reason cut
              off at the panel's edge is the defect it exists to fix.
            */}
            {build.failure && (
              <div
                className="eu-bottom-panel__failure"
                data-testid="build-failure"
                data-failure-kind={build.failure.kind}
                role="status"
              >
                <CircleX size={13} strokeWidth={2} />
                <div className="eu-bottom-panel__failure-body">
                  <span className="eu-bottom-panel__failure-message">{failureHeadline(build.failure)}</span>
                  <span className="eu-bottom-panel__failure-reason">{formatBuildFailure(build.failure)}</span>
                  {build.failure.command && (
                    <span className="eu-bottom-panel__failure-command" title={build.failure.command}>
                      {build.failure.command}
                    </span>
                  )}
                  {build.failure.kind === 'launch' && (
                    <span className="eu-bottom-panel__failure-hint">
                      The command was not found where the build runs. Install it, or choose another recipe with Build
                      with Recipe… (Ctrl+Shift+B).
                    </span>
                  )}
                </div>
              </div>
            )}

            <ScrollArea
              handleRef={outputRef}
              style={{ flex: 1 }}
              onScroll={(top) => {
                const element = outputRef.current?.getElement();
                if (!element) return;
                setFollowing(isNearBottom(top, element.clientHeight, element.scrollHeight));
              }}
            >
              <pre
                data-testid="output-stream"
                className={build.output ? 'eu-bottom-panel__output' : 'eu-bottom-panel__output eu-bottom-panel__output--empty eu-empty'}
              >
                {trimmedOutput.text || 'No compiler output yet. Run a build to see it here.'}
              </pre>
            </ScrollArea>
          </>
        )}

        {bottomPanelView === 'log' && (
          <>
            <div className="eu-bottom-panel__status eu-tnum">
              <span>Parsed with the LaTeX log parser</span>
              <span>
                {diagnostics.length} message{diagnostics.length === 1 ? '' : 's'}
              </span>
              <span className="eu-bottom-panel__fact--error">{errorCount} errors</span>
              <span className="eu-bottom-panel__fact--warning">{warningCount} warnings</span>
              {build.skipped && <span className="eu-bottom-panel__fact--warning">latexmk reported nothing to do</span>}
              {/*
                The failures that never reached the log parser — a missing
                engine, a recipe that resolves to nothing — are stated here too,
                because this is the view a reader opens when the Problems list is
                empty and they want to know what the compiler actually said.
              */}
              {build.failure && (
                <span
                  className="eu-bottom-panel__fact--error"
                  data-testid="log-failure"
                  title={formatBuildFailure(build.failure)}
                >
                  {build.failure.message}
                </span>
              )}
              <span className="eu-bottom-panel__spacer" style={{ flex: 1 }} />
              <span>
                {build.totalSteps} step{build.totalSteps === 1 ? '' : 's'}
              </span>
            </div>
            <ScrollArea style={{ flex: 1 }} testId="log-list">
              {diagnostics.length === 0 && (
                <div className="eu-empty eu-bottom-panel__empty">Nothing has been parsed yet. Build the project to fill the log.</div>
              )}
              {diagnostics.map((item, index) => (
                <div
                  key={`log-${index}`}
                  data-testid="log-row"
                  role={item.line > 0 ? 'button' : undefined}
                  tabIndex={item.line > 0 ? 0 : undefined}
                  title={item.raw || item.message}
                  onClick={item.line > 0 ? () => void goToSource(item.file, item.line, item.column ?? 1) : undefined}
                  onKeyDown={
                    item.line > 0
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            void goToSource(item.file, item.line, item.column ?? 1);
                          }
                        }
                      : undefined
                  }
                  className="eu-bottom-panel__row eu-bottom-panel__row--log"
                >
                  {severityIcon(item.severity)}
                  <span className="eu-bottom-panel__row-text">
                    <span className="eu-bottom-panel__row-message">{item.message}</span>
                    {item.errorPosText && <span className="eu-bottom-panel__row-source">{item.errorPosText}</span>}
                  </span>
                  <span className="eu-bottom-panel__row-locator">
                    {item.source} · {item.category}
                    {item.line > 0 ? ` · ${item.line}${item.column ? `:${item.column}` : ''}` : ''}
                  </span>
                </div>
              ))}
            </ScrollArea>
          </>
        )}

        {bottomPanelView === 'search' && (
          <>
            <div className="eu-bottom-panel__status eu-tnum">
              <span>
                {search.results.length} result{search.results.length === 1 ? '' : 's'}
              </span>
              {search.durationMs > 0 && <span>{search.durationMs} ms</span>}
              {search.truncated && <span className="eu-bottom-panel__fact--warning">truncated</span>}
              {search.error && <span className="eu-bottom-panel__fact--error">{search.error}</span>}
              {search.running && <span>running…</span>}
            </div>
            <ScrollArea style={{ flex: 1 }} testId="search-list">
              {[...searchGroups.entries()].map(([path, hits]) => (
                <div key={path}>
                  <div className="eu-section eu-bottom-panel__group" title={path}>
                    <FileText size={12} strokeWidth={1.8} />
                    <span className="eu-bottom-panel__group-name">{path.replace(/^.*[\\/]/, '')}</span>
                    <span className="eu-bottom-panel__group-path">{path}</span>
                    <span style={{ flex: 1 }} />
                    <span className="eu-badge">{hits.length}</span>
                  </div>
                  {hits.map((hit, index) => (
                    <div
                      key={`${hit.line}-${hit.column}-${index}`}
                      data-testid="search-row"
                      role="button"
                      tabIndex={0}
                      title={`${path}:${hit.line}:${hit.column} — open this match`}
                      onClick={() => void goToSource(hit.path, hit.line, hit.column)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          void goToSource(hit.path, hit.line, hit.column);
                        }
                      }}
                      className="eu-bottom-panel__row"
                    >
                      <span className="eu-bottom-panel__hit-line">{hit.line}</span>
                      <span className="eu-bottom-panel__hit-text">{highlightSearchHit(hit)}</span>
                    </div>
                  ))}
                </div>
              ))}
              {search.results.length === 0 && (
                <div className="eu-empty eu-bottom-panel__empty">
                  No search results. Use Search in the sidebar to run a project search.
                </div>
              )}
            </ScrollArea>
          </>
        )}

        {terminalVisited && (
          <div style={bottomPanelView === 'terminal' ? terminalHost : hiddenTerminalHost}>
            <React.Suspense fallback={<div style={terminalHost} />}>
              <Terminal cwd={workspace.workspacePath} active={bottomPanelView === 'terminal'} />
            </React.Suspense>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * What is left inline is what the component *computes*: the panel's height and
 * floor, the geometry of the divider the resize gesture captures the pointer on,
 * and the boxes that exist only to be laid out. The surfaces, the type, the rows
 * and everything driven by state live in `panel-surfaces.css` — including the
 * panel's own background, which is the token the sheet lifts with a shadow.
 */
const panel: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flexShrink: 0,
  minHeight: MIN_PANEL_HEIGHT,
  overflow: 'hidden'
};

/**
 * The resize handle.
 *
 * Its 5px height is the gesture's hit area rather than decoration, which is why
 * it stays here beside the pointer-capture code instead of moving into the sheet
 * with everything else. The paint is `.eu-panel-divider`'s — it owns the hairline
 * and the hover highlight — and the dragging state is written inline because it
 * is a state of *this component*, not a class of that element.
 */
const divider: React.CSSProperties = {
  height: 5,
  flexShrink: 0,
  cursor: 'row-resize',
  touchAction: 'none'
};

/**
 * The terminal's slot. Hiding it rather than unmounting it is what keeps the
 * shell session alive across a switch to another view; the panel's own height
 * still bounds it, and the terminal scrolls its output inside that.
 */
const terminalHost: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0
};

const hiddenTerminalHost: React.CSSProperties = {
  ...terminalHost,
  display: 'none'
};

/**
 * The tab strip's skeleton: a row whose children reach its full height, because
 * the selected tab's accent rule is drawn on the strip's bottom edge. Its
 * surface, its padding and its divider belong to `.eu-bottom-panel__tabs`, so the
 * strip and the tabs inside it cannot drift apart.
 */
const tabStrip: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  height: 26,
  flexShrink: 0
};

export default BottomPanel;
