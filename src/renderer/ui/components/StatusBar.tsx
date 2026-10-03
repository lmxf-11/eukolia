/**
 * StatusBar — the single line of persistent state at the bottom of the window
 * (Instructions.md §55: dense, uncluttered, no rarely used actions).
 *
 * The bar shows *live* state only, grouped and left to right:
 *
 *   • **build** — one indicator: glyph, state, duration. It is also the only
 *     place the build's outcome is stated; there is no second copy in a status
 *     message;
 *   • **problems** — the error and warning counts, and nothing at all when both
 *     are zero;
 *   • **recipe** — the engine the build will use, never twice;
 *   • **cursor** — line, column, selection and the indentation the editor is
 *     using;
 *   • **document** — language mode, encoding, line endings, root document;
 *   • **PDF** — the visible page and whether SyncTeX data exists;
 *   • the **layout cluster** and the transient status message on the far right.
 *
 * Reference information that is not live state lives behind an interaction: the
 * eight detected TeX tools collapse into one `TeX` indicator whose tooltip lists
 * each tool with its version and path, instead of occupying half the bar.
 *
 * Everything shown here is read from app state, `projectIndex` or the settings
 * manager. The only writes are the panel and viewer toggles, the theme switch,
 * the indentation and encoding settings, and a re-run of tool detection.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ToolInfo } from '../../../shared/ipc';
import { useAppState } from '../state';
import { sidebarShown } from '../sidebarRegion';
import { projectIndex } from '../../document/projectIndex';
import { settingsManager } from '../../core/settings';
import { commandRegistry } from '../../core/commands';
import { formatBuildFailure } from '../../compiler/buildFailure';
import { OPTIONAL_COMMANDS } from '../../compiler/recipeCatalog';
import { THEME_LABELS, type ThemeSetting } from '../../core/themes';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  LayoutPanelLeft,
  LayoutPanelTop,
  LoaderCircle,
  Moon,
  PanelBottom,
  PanelLeft,
  Sun,
  TriangleAlert,
  ZoomIn
} from './icons';

export interface StatusBarProps {
  /** No props: every value comes from app state or the project index. */
}

/** How long a transient status message stays on the bar before fading away. */
export const STATUS_MESSAGE_MS = 6000;

/**
 * The tools whose absence is not a defect.
 *
 * `makeindex` is only needed by documents with an index, `biber` and `tectonic`
 * only by the recipes that name them, and `synctex` only by documents that use
 * SyncTeX; none makes a TeX installation incomplete, so they are listed in the
 * indicator's tooltip but never counted as "missing". The list is the build
 * catalogue's own (`OPTIONAL_COMMANDS`), because the recipes and the indicator
 * are answering the same question about the same machine: a bar reading
 * "TeX 1 missing" for a tool no recipe the user has chosen needs is a false
 * alarm, and the catalogue is where "needed" is written down.
 */
export const OPTIONAL_TOOLS: readonly string[] = OPTIONAL_COMMANDS;

// ---------------------------------------------------------------------- pure
// The formatting decisions live here as pure functions, so the bar's own logic
// can be pinned down in `tests/ui/status-bar.test.ts` rather than through a
// rendered component.

/** Formats a build duration for the status bar. */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

/** Human-readable build status. */
export function buildStatusLabel(status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'): string {
  switch (status) {
    case 'running':
      return 'Building…';
    case 'succeeded':
      return 'Build succeeded';
    case 'failed':
      return 'Build failed';
    case 'cancelled':
      return 'Build cancelled';
    default:
      return 'Idle';
  }
}

/** `Ln 251, Col 2`, with `· 5 selected` appended while text is selected. */
export interface CursorDisplay {
  position: string;
  selection: string | null;
}

export function formatCursor(cursor: { line: number; column: number; selectedChars: number }): CursorDisplay {
  return {
    position: `Ln ${cursor.line}, Col ${cursor.column}`,
    selection: cursor.selectedChars > 0 ? `${cursor.selectedChars} selected` : null
  };
}

/**
 * The problems indicator.
 *
 * A clean build must look clean, so when there is nothing to report the counts
 * are dropped entirely rather than drawing two zeroes in the corner of the eye.
 */
export interface ProblemsDisplay {
  visible: boolean;
  errors: number;
  warnings: number;
}

export function formatProblems(errorCount: number, warningCount: number): ProblemsDisplay {
  const errors = Math.max(0, Math.trunc(errorCount));
  const warnings = Math.max(0, Math.trunc(warningCount));
  return { visible: errors > 0 || warnings > 0, errors, warnings };
}

/** The indentation the editor is using, in the editor's own vocabulary. */
export interface IndentationDisplay {
  label: string;
  tabSize: number;
  insertSpaces: boolean;
}

export function formatIndentation(tabSize: number, insertSpaces: boolean): IndentationDisplay {
  const size = Number.isFinite(tabSize) && tabSize > 0 ? Math.trunc(tabSize) : 1;
  return {
    label: insertSpaces ? `Spaces: ${size}` : `Tab Size: ${size}`,
    tabSize: size,
    insertSpaces
  };
}

/** `utf8` is shown as `UTF-8`; an unknown value is upper-cased rather than hidden. */
export function formatEncodingLabel(encoding: string): string {
  switch (encoding.trim().toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return 'UTF-8';
    case 'utf16le':
    case 'utf-16le':
      return 'UTF-16 LE';
    case 'latin1':
    case 'iso-8859-1':
      return 'Latin-1';
    default:
      return encoding.trim().toUpperCase();
  }
}

/** How a document's language reads in the bar. */
const LANGUAGE_LABELS: Record<string, string> = {
  latex: 'LaTeX',
  tex: 'TeX',
  bibtex: 'BibTeX'
};

export function formatLanguageLabel(languageId: string | null): string | null {
  if (!languageId) return null;
  const known = LANGUAGE_LABELS[languageId.toLowerCase()];
  return known ?? languageId;
}

/** The theme's human-readable name; "system" says which theme it resolved to. */
export function formatThemeLabel(setting: ThemeSetting, resolved: string): string {
  if (setting === 'system') return `System: ${themeNameLabel(resolved)}`;
  return themeNameLabel(setting);
}

function themeNameLabel(name: string): string {
  if (Object.prototype.hasOwnProperty.call(THEME_LABELS, name)) {
    return THEME_LABELS[name as keyof typeof THEME_LABELS];
  }
  // A theme name the label table does not know is still shown, title-cased,
  // rather than silently rendering as "undefined".
  return titleCase(name);
}

function titleCase(value: string): string {
  return value
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** TeX tool availability, collapsed into one quiet indicator. */
export interface ToolSummary {
  detected: boolean;
  label: string;
  missing: string[];
  tone: 'success' | 'warning' | 'error' | 'muted';
}

export function summariseTools(
  tools: readonly ToolInfo[],
  optional: readonly string[] = OPTIONAL_TOOLS
): ToolSummary {
  // An empty list means detection has not answered yet, which is different from
  // "answered, and nothing is installed" — the two must not read the same.
  if (tools.length === 0) return { detected: false, label: 'TeX …', missing: [], tone: 'muted' };

  const required = tools.filter((tool) => !optional.includes(tool.name));
  const missing = required.filter((tool) => !tool.available).map((tool) => tool.name);

  if (missing.length === 0) return { detected: true, label: 'TeX ✓', missing, tone: 'success' };
  if (missing.length === required.length) return { detected: true, label: 'TeX ✗', missing, tone: 'error' };
  return { detected: true, label: `TeX ${missing.length} missing`, missing, tone: 'warning' };
}

/** One tool per line: name, version, path — the detail the bar no longer shows. */
export function formatToolList(tools: readonly ToolInfo[]): string {
  if (tools.length === 0) return 'No TeX tools detected yet';
  return tools
    .map((tool) =>
      [
        `${tool.name} — ${tool.available ? 'found' : 'not found'}`,
        tool.version ?? (tool.available ? 'version unknown' : 'not installed'),
        tool.path ?? 'not on PATH'
      ].join('\n')
    )
    .join('\n\n');
}

/** The build indicator's tooltip: outcome, recipe, current step, counts. */
export function formatBuildTooltip(
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled',
  duration: string | null,
  parts: { recipe: string; currentLabel: string; errors: number; warnings: number; failure?: string | null }
): string {
  const lines = [`${buildStatusLabel(status)}${duration ? ` in ${duration}` : ''}`, `Recipe: ${parts.recipe}`];
  if (parts.currentLabel && status === 'running') lines.push(`Step: ${parts.currentLabel}`);
  // A failed build's tooltip leads with the reason: the tooltip is where a
  // reader who missed the transient message goes looking, and "Build failed"
  // three lines above the exit code is a worse answer than the exit code alone.
  if (status === 'failed' && parts.failure) lines.push(parts.failure);
  lines.push(`Problems: ${parts.errors} error(s), ${parts.warnings} warning(s)`);
  return lines.join('\n');
}

/** The problems indicator's tooltip, naming what the click will do. */
export function formatProblemsTooltip(errors: number, warnings: number, panelOpen: boolean): string {
  const counts = `${errors} error(s), ${warnings} warning(s)`;
  if (errors === 0 && warnings === 0) {
    return `No problems — ${panelOpen ? 'hide' : 'show'} the Problems panel`;
  }
  return `Problems: ${counts} — ${panelOpen ? 'hide' : 'show'} the Problems panel`;
}

// ---------------------------------------------------------------- file probes
//
// Two facts the bar reports cannot be read from state: whether a `.synctex.gz`
// exists next to the PDF, and whether the file on disk uses CRLF. Both are
// answered by the file system and cached, so the bar does not re-stat on every
// caret move.

/** `.pdf` → `.synctex.gz`, which is where every TeX engine puts the data. */
export function synctexPathFor(pdfPath: string): string {
  return pdfPath.replace(/\.pdf$/i, '.synctex.gz');
}

const syncTexCache = new Map<string, boolean>();

/** True when SyncTeX data exists for the PDF, false when it does not, null while unknown. */
function useSyncTexAvailable(pdfPath: string | null): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(() =>
    pdfPath ? (syncTexCache.get(pdfPath) ?? null) : null
  );

  useEffect(() => {
    if (!pdfPath) {
      setAvailable(null);
      return;
    }
    const cached = syncTexCache.get(pdfPath);
    if (cached !== undefined) {
      setAvailable(cached);
      return;
    }
    let disposed = false;
    void window.eukoliaApi
      .stat(synctexPathFor(pdfPath))
      .then((result) => {
        syncTexCache.set(pdfPath, result.exists);
        if (!disposed) setAvailable(result.exists);
      })
      .catch(() => {
        // A PDF that cannot be stat-ed has no SyncTeX data as far as the bar can
        // tell; the indicator stays dimmed rather than claiming otherwise.
        if (!disposed) setAvailable(false);
      });
    return () => {
      disposed = true;
    };
  }, [pdfPath]);

  return available;
}

/** The line endings a file on disk uses. */
export type LineEnding = 'LF' | 'CRLF' | 'mixed';

/**
 * The line endings a file on disk uses.
 *
 * This cannot come from the document: `DocumentModel` normalises every buffer to
 * LF (and writes it back that way), so the buffer would claim `LF` for a file
 * that is still `CRLF` on disk. A throwaway read of the file is the only honest
 * answer — and because Eukolia always replaces a file rather than writing into
 * it, one cached answer per URI is enough.
 */
const eolCache = new Map<string, LineEnding | null>();

/** Classifies a file's line endings; `null` when it has no line break to read. */
export function detectLineEnding(text: string): LineEnding | null {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return text.includes('\n') ? 'LF' : null;
  const loneLf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return loneLf === 0 ? 'CRLF' : 'mixed';
}

/**
 * Drops what the bar has learned about a document or a PDF.
 *
 * The two probes cache a fact read from disk, and the bar is remounted against
 * different state in tests; without this a previous document's line ending, or
 * a previous PDF's SyncTeX answer, would leak into the next mount.
 */
export function clearFileProbeCaches(uri?: string): void {
  if (uri === undefined) {
    eolCache.clear();
    syncTexCache.clear();
    return;
  }
  eolCache.delete(uri);
  syncTexCache.delete(uri);
}

function useLineEnding(uri: string | null, revision: number): LineEnding | null {
  const [eol, setEol] = useState<LineEnding | null>(() => (uri ? (eolCache.get(uri) ?? null) : null));

  useEffect(() => {
    if (!uri || uri.startsWith('untitled:')) {
      setEol(null);
      return;
    }
    // A write invalidates the cached answer: the next save replaces the file,
    // and a save in place keeps the same URI.
    if (revision > 0) eolCache.delete(uri);
    const cached = eolCache.get(uri);
    if (cached !== undefined) {
      setEol(cached);
      return;
    }
    let disposed = false;
    void window.eukoliaApi
      .readFile(uri)
      .then((text) => {
        const detected = detectLineEnding(text);
        eolCache.set(uri, detected);
        if (!disposed) setEol(detected);
      })
      .catch(() => {
        if (!disposed) setEol(null);
      });
    return () => {
      disposed = true;
    };
    // `revision` counts writes to the file, not edits to the buffer, and it is a
    // dependency so that a write invalidates the cached answer and the file is
    // read again. See `useDiskRevision`.
  }, [uri, revision]);

  return eol;
}

// -------------------------------------------------------------------- hooks

/** The root document tracked by the project index, kept in step with its events. */
function useRootDocument(): string | null {
  const [root, setRoot] = useState<string | null>(() => projectIndex.getRootDocumentPath());
  useEffect(
    () =>
      projectIndex.on('root-document-change', () => {
        setRoot(projectIndex.getRootDocumentPath());
      }),
    []
  );
  return root;
}

/** Everything the bar reads from the settings, re-read on every change. */
export interface StatusBarSettings {
  encoding: string;
  recipe: string;
  engine: string;
  tabSize: number;
  insertSpaces: boolean;
  collapseActivityBarWithSidebar: boolean;
}

export function readStatusBarSettings(): StatusBarSettings {
  return {
    encoding: String(settingsManager.getValue('files.encoding') ?? 'utf8'),
    recipe: String(settingsManager.getValue('compilation.recipe') ?? ''),
    engine: String(settingsManager.getValue('compilation.engine') ?? 'latexmk'),
    tabSize: Number(settingsManager.getValue('editor.tabSize') ?? 2),
    insertSpaces: Boolean(settingsManager.getValue('editor.insertSpaces') ?? true),
    collapseActivityBarWithSidebar: Boolean(settingsManager.getValue('appearance.collapseActivityBarWithSidebar') ?? true)
  };
}

function useDisplaySettings(): StatusBarSettings {
  const [version, setVersion] = useState(0);
  useEffect(
    () =>
      settingsManager.on('change', () => {
        setVersion((value) => value + 1);
      }),
    []
  );
  return useMemo(() => {
    void version;
    return readStatusBarSettings();
  }, [version]);
}

/**
 * How many times `doc` has been **written to disk** since it was subscribed to.
 *
 * The bar must not re-read the file on every caret move — a caret move re-renders
 * the bar — and it must not re-read it on every *keystroke* either, which is what
 * this counter used to count. Subscribing to `change` made the line-ending probe
 * a whole-file `fs:readFile` across IPC, plus a regex over the whole text, for
 * every character typed: a megabyte read and serialised per keystroke, to answer a
 * question whose answer cannot have moved. `DocumentModel` normalises every buffer
 * to LF, so nothing the user types in the editor can change what the file on disk
 * uses; only a write can, and a write is `saved` (Eukolia replaces the file) or
 * `reloaded` (something outside the editor replaced it).
 *
 * The item's own tooltip already says which of the two the label describes: "Line
 * endings in the file on disk".
 */
function useDiskRevision(doc: { on(event: string, listener: () => void): () => void } | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(0);
    if (!doc) return;
    const bump = () => setCount((value) => value + 1);
    const unbind = [doc.on('saved', bump), doc.on('reloaded', bump)];
    return () => unbind.forEach((off) => off());
  }, [doc]);
  return count;
}

/**
 * A transient status message: the newest one is shown, and it fades on its own.
 *
 * Instructions.md §55 calls for VS Code's behaviour, where the message area is a
 * notification rather than a permanent label — a message that says "Build
 * failed" and then stays there for the rest of the session is not a status line.
 */
function useTransientMessage(message: string | null): string | null {
  const [shown, setShown] = useState<string | null>(message);
  const shownRef = useRef<string | null>(message);

  useEffect(() => {
    if (message === shownRef.current) return;
    shownRef.current = message;
    setShown(message);
  }, [message]);

  useEffect(() => {
    if (shown === null) return;
    const timer = setTimeout(() => {
      shownRef.current = null;
      setShown(null);
    }, STATUS_MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  return shown;
}

/** A button that closes its popover on an outside click or Escape. */
export function useDismissable(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      // The target is a `Node` for a click on the document and the *window*
      // itself for one that reaches no element, and `contains` throws on
      // anything that is not a node rather than answering false.
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

// ---------------------------------------------------------------- component

export const StatusBar: React.FC<StatusBarProps> = () => {

  const {
    build,
    tools,
    cursor,
    theme,
    themeSetting,
    statusMessage,
    activeDoc,
    pdf,
    sidebarVisible,
    sidebarView,
    settingsOpen,
    bottomPanelVisible,
    bottomPanelView,
    tabBarVisible,
    toggleBottomPanel,
    cycleTheme,
    openFile,
    detectRecipes,
    setSetting
  } = useAppState();

  const rootDocument = useRootDocument();
  const display = useDisplaySettings();
  // Whether the sidebar region is on screen — the same derivation the shell
  // renders from, so this control's pressed state cannot outlive the panel.
  const sidebarIsShown = sidebarShown({ visible: sidebarVisible, view: sidebarView, settingsOpen });
  const panelBarActive = !display.collapseActivityBarWithSidebar;
  const diskRevision = useDiskRevision(activeDoc);
  const message = useTransientMessage(statusMessage);
  const duration = formatDuration(build.durationMs);
  /*
   * The recipe the bar names is the one that *ran*, when one has: the settings
   * can say `default` and leave the engine to decide, and a bar reading "Build
   * recipe: default" would be naming a setting rather than a command line. The
   * settings are the fallback for the state before the first build.
   */
  const recipe = build.recipeName ?? (display.recipe && display.recipe !== 'default' ? display.recipe : display.engine);
  const problems = formatProblems(build.errorCount, build.warningCount);
  const problemsActive = bottomPanelVisible && bottomPanelView === 'problems';
  const cursorText = formatCursor(cursor);
  const encodingLabel = formatEncodingLabel(display.encoding);
  const language = formatLanguageLabel(activeDoc?.languageId ?? null);
  const themeLabel = formatThemeLabel(themeSetting, theme);
  const toolSummary = summariseTools(tools);

  // Line endings are read from the file on disk: the document model normalises
  // every buffer to LF, so the buffer can never answer this question.
  const lineEnding = useLineEnding(activeDoc && !activeDoc.uri.startsWith('untitled:') ? activeDoc.uri : null, diskRevision);

  // The built PDF is authoritative when a build has produced one; the PDF pane's
  // own path is the fallback for a project that has not been built this session.
  const pdfPath = build.pdfPath ?? pdf.path;
  const syncTexAvailable = useSyncTexAvailable(pdfPath);

  const run = useCallback((id: string) => {
    void commandRegistry.execute(id);
  }, []);

  const statusColor =
    build.status === 'failed'
      ? 'var(--eu-error)'
      : build.status === 'succeeded'
        ? 'var(--eu-success)'
        : build.status === 'running'
          ? 'var(--eu-info)'
          : 'var(--eu-fg-secondary)';

  const statusGlyph =
    build.status === 'running' ? (
      <LoaderCircle size={12} strokeWidth={2} className="eu-spin" />
    ) : build.status === 'failed' ? (
      <CircleX size={12} strokeWidth={2} />
    ) : build.status === 'succeeded' ? (
      <CircleCheck size={12} strokeWidth={2} />
    ) : (
      <CircleDashed size={12} strokeWidth={2} />
    );

  const toolColor =
    toolSummary.tone === 'success'
      ? 'var(--eu-success)'
      : toolSummary.tone === 'warning'
        ? 'var(--eu-warning)'
        : toolSummary.tone === 'error'
          ? 'var(--eu-error)'
          : 'var(--eu-fg-muted)';

  return (
    <div className="eu-status-bar" style={bar} data-testid="status-bar">
      {/* ------------------------------------------------------------ build */}
      <button
        type="button"
        data-testid="status-build"
        data-build-status={build.status}
        className={`eu-status-item eu-btn${build.status === 'running' ? ' eu-status-bar__running' : ''}`}
        aria-label={
          build.status === 'failed' && build.failure
            ? `Build failed: ${formatBuildFailure(build.failure)} — show the build output`
            : `${buildStatusLabel(build.status)}${duration ? ` in ${duration}` : ''} — show the build output`
        }
        title={formatBuildTooltip(build.status, duration, {
          recipe,
          currentLabel: build.currentLabel,
          errors: problems.errors,
          warnings: problems.warnings,
          failure: build.failure ? formatBuildFailure(build.failure) : null
        })}
        onClick={() => toggleBottomPanel('output')}
        style={{ ...iconButton, color: statusColor, width: 24, height: 22, justifyContent: 'center' }}
      >
        {statusGlyph}
      </button>

      {/*
        The exact failure, next to the indicator it belongs to.
        
        The transient message on the far right says it too and fades after six
        seconds; this one stays for as long as the failed build is the last thing
        that happened, which is what makes it readable a minute later — or after
        a glance at the log and a return to the bar. It is the same sentence the
        bottom panel prints, from the same value.
      */}
      {build.status === 'failed' && build.failure && (
        <button
          type="button"
          data-testid="status-build-failure"
          className="eu-status-item eu-btn"
          aria-label={`Build failed: ${formatBuildFailure(build.failure)} — show the build output`}
          title={formatBuildFailure(build.failure)}
          onClick={() => toggleBottomPanel('output')}
          style={{ ...cell, maxWidth: 420, flexShrink: 1, color: 'var(--eu-error)' }}
        >
          <CircleX size={12} strokeWidth={2} />
          <span style={ellipsis}>{build.failure.message}</span>
        </button>
      )}

      {/* --------------------------------------------------------- problems */}
      {problems.visible && (
        <button
          type="button"
          data-testid="status-problems"
          className="eu-status-item eu-btn"
          aria-label={`Problems: ${problems.errors} error(s), ${problems.warnings} warning(s)`}
          title={formatProblemsTooltip(problems.errors, problems.warnings, problemsActive)}
          onClick={() => toggleBottomPanel('problems')}
          style={{ ...cell, padding: '0 6px', gap: 4 }}
        >
          {problems.errors > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--eu-error)' }}>
              <CircleAlert size={12} strokeWidth={2} />
              <span className="eu-tnum">{problems.errors}</span>
            </span>
          )}
          {problems.warnings > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--eu-warning)' }}>
              <TriangleAlert size={12} strokeWidth={2} />
              <span className="eu-tnum">{problems.warnings}</span>
            </span>
          )}
        </button>
      )}

      {/* ----------------------------------------------------------- recipe */}
      <button
        type="button"
        data-testid="status-recipe"
        className="eu-status-item eu-btn"
        aria-label={`Build recipe: ${recipe} — choose a recipe`}
        title={`Recipe: ${recipe}\nEngine: ${display.engine}\nClick to choose a build recipe`}
        onClick={() => run('latex.buildWithRecipe')}
        style={{ ...cell, maxWidth: 160 }}
      >
        <span style={ellipsis}>{recipe}</span>
      </button>

      {/* ----------------------------------------------------------- cursor */}
      {/*
        Line and column are live state and are always on the bar; the selection
        is drawn quietly beside them while there is one.

        `Ln`, `Col` and the comma are a contract: `src/main/smoke.ts` reads the
        bar with /Ln \d+/, and a bar that shows the position only while text is
        selected is one the probe — and the reader — cannot find it in.
      */}
      <span
        data-testid="status-cursor"
        title={`Cursor position: ${cursorText.position}`}
        className="eu-tnum"
        style={label}
      >
        <span>{cursorText.position}</span>
        {cursorText.selection && (
          <span data-testid="status-selection" style={{ color: 'var(--eu-fg-muted)' }}>
            {cursorText.selection}
          </span>
        )}
      </span>

      <span className="eu-status-divider" />

      {/* --------------------------------------------------------- document */}
      {language && (
        <span data-testid="status-language" title="Language mode of the active document" style={label}>
          {language}
        </span>
      )}

      {lineEnding && (
        <span
          data-testid="status-line-ending"
          title={`Line endings in the file on disk: ${lineEnding === 'mixed' ? 'both CRLF and LF' : lineEnding}`}
          style={{ ...label, color: 'var(--eu-fg-muted)' }}
        >
          {lineEnding}
        </span>
      )}

      <button
        type="button"
        data-testid="status-encoding"
        className="eu-status-item eu-btn"
        aria-label={`File encoding: ${encodingLabel} — change it`}
        title={`File encoding: ${encodingLabel}\nThe encoding used when reading and writing documents. Click to switch.`}
        onClick={() => {
          const options = ['utf8', 'utf16le', 'latin1'];
          const next = options[(options.indexOf(display.encoding) + 1) % options.length];
          setSetting('files.encoding', next);
        }}
        style={{ ...cell, color: 'var(--eu-fg-muted)' }}
      >
        {encodingLabel}
      </button>

      <button
        type="button"
        data-testid="status-root-document"
        className="eu-status-item eu-btn"
        aria-label={rootDocument ? `Root document: ${rootDocument} — open it` : 'No root document detected in this project'}
        title={rootDocument ? `Root document: ${rootDocument}\nClick to open it` : 'No root document detected in this project'}
        onClick={() => {
          if (rootDocument) void openFile(rootDocument);
        }}
        style={{
          ...cell,
          maxWidth: 190,
          flexShrink: 1,
          color: rootDocument ? 'var(--eu-fg-secondary)' : 'var(--eu-fg-muted)'
        }}
      >
        <span style={ellipsis}>{rootDocument ? rootDocument.replace(/^.*[\\/]/, '') : 'no root document'}</span>
      </button>

      {/* -------------------------------------------------------------- PDF */}
      {(pdf.pageCount > 0 || syncTexAvailable !== null) && <span className="eu-status-divider" />}

      {pdf.pageCount > 0 && (
        <button
          type="button"
          data-testid="status-pdf-page"
          className="eu-status-item eu-btn eu-tnum"
          aria-label={`PDF page ${pdf.page} of ${pdf.pageCount} — show the PDF viewer`}
          title={`Page ${pdf.page} of ${pdf.pageCount}${pdf.path ? `\n${pdf.path}` : ''}\nClick to show the PDF viewer`}
          onClick={() => run('pdf.toggleViewer')}
          style={cell}
        >
          Page {pdf.page} / {pdf.pageCount}
        </button>
      )}

      {syncTexAvailable !== null && (
        <span
          data-testid="status-synctex"
          title={
            syncTexAvailable
              ? `SyncTeX data found: ${synctexPathFor(pdfPath ?? '')}\nCtrl+click in the PDF or the source to jump between them`
              : `No .synctex.gz beside ${pdfPath ?? 'the PDF'}\nSet "Generate SyncTeX data" and rebuild to enable source ↔ PDF jumps`
          }
          style={{
            ...label,
            color: syncTexAvailable ? 'var(--eu-success)' : 'var(--eu-fg-muted)',
            opacity: syncTexAvailable ? 1 : 0.7
          }}
        >
          SyncTeX
        </span>
      )}

      {/* ----------------------------------------------------- TeX tooling */}
      <span className="eu-status-divider" />

      <button
        type="button"
        data-testid="status-tools"
        className="eu-status-item eu-btn"
        aria-label={toolSummary.detected ? `TeX tools: ${toolSummary.label} — detect again` : 'TeX tools have not been detected — detect them'}
        title={`${toolSummary.detected ? `TeX tools: ${toolSummary.label}` : 'TeX tool detection has not run yet'}\n\n${formatToolList(tools)}\n\nClick to detect again`}
        onClick={() => void detectRecipes()}
        style={{ ...cell, color: toolColor }}
      >
        <span className="eu-dot" style={{ background: toolColor }} />
        {toolSummary.label}
      </button>

      <span className="eu-status-bar__spacer" style={spacer} />

      {/* --------------------------------------------------- transient message */}
      {message && (
        <span
          data-testid="status-message"
          title={message}
          className="eu-status-message eu-btn"
          style={{
            ...label,
            maxWidth: 420,
            flexShrink: 1,
            color: 'var(--eu-fg-primary)',
            padding: '0 8px'
          }}
        >
          <span style={ellipsis}>{message}</span>
        </span>
      )}

      {/* --------------------------------------------------- layout cluster */}
      <button
        type="button"
        data-testid="status-toggle-view.togglePanelBar"
        className="eu-status-item eu-icon-btn"
        aria-label={`${panelBarActive ? 'Turn off' : 'Turn on'} Panel Bar`}
        aria-pressed={panelBarActive}
        title={`Toggle Panel Bar (${panelBarActive ? 'On' : 'Off'})`}
        onClick={() => run('view.togglePanelBar')}
        style={iconButton}
      >
        <PanelLeft size={13} strokeWidth={2} />
      </button>

      <button
        type="button"
        data-testid="status-toggle-view.toggleSidebar"
        className="eu-status-item eu-icon-btn"
        aria-label={`${sidebarIsShown ? 'Hide' : 'Show'} the sidebar`}
        aria-pressed={sidebarIsShown}
        title={`${sidebarIsShown ? 'Hide' : 'Show'} the sidebar (Ctrl+B)`}
        onClick={() => run('view.toggleSidebar')}
        style={iconButton}
      >
        <LayoutPanelLeft size={13} strokeWidth={2} />
      </button>

      <button
        type="button"
        data-testid="status-toggle-view.togglePanel"
        className="eu-status-item eu-icon-btn"
        aria-label={`${bottomPanelVisible ? 'Hide' : 'Show'} the bottom panel`}
        aria-pressed={bottomPanelVisible}
        title={`${bottomPanelVisible ? 'Hide' : 'Show'} the bottom panel (Ctrl+J)`}
        onClick={() => run('view.togglePanel')}
        style={iconButton}
      >
        <PanelBottom size={13} strokeWidth={2} />
      </button>

      <button
        type="button"
        data-testid="status-toggle-pdf.toggleViewer"
        className="eu-status-item eu-icon-btn"
        aria-label={`${pdf.visible ? 'Hide' : 'Show'} the PDF viewer`}
        aria-pressed={pdf.visible}
        title={`${pdf.visible ? 'Hide' : 'Show'} the PDF viewer (Ctrl+Alt+V)`}
        onClick={() => run('pdf.toggleViewer')}
        style={iconButton}
      >
        <ZoomIn size={13} strokeWidth={2} />
      </button>

      <button
        type="button"
        data-testid="status-toggle-view.toggleTabBar"
        className="eu-status-item eu-icon-btn"
        aria-label={`${tabBarVisible ? 'Hide' : 'Show'} the tab bar`}
        aria-pressed={tabBarVisible}
        title={`${tabBarVisible ? 'Hide' : 'Show'} the tab bar (Ctrl+Alt+T)`}
        onClick={() => run('view.toggleTabBar')}
        style={iconButton}
      >
        <LayoutPanelTop size={13} strokeWidth={2} />
      </button>

      <span className="eu-status-divider" />

      {/* ------------------------------------------------------------- theme */}
      <button
        type="button"
        data-testid="status-theme"
        className="eu-status-item eu-btn"
        aria-label={`Theme: ${themeLabel} — switch to the next theme`}
        title={`Theme: ${themeLabel}\nSetting: ${themeSetting}\nClick to switch to the next theme`}
        onClick={() => cycleTheme()}
        style={{ ...cell, padding: '0 8px' }}
      >
        {theme === 'dark' ? <Moon size={12} strokeWidth={2} /> : <Sun size={12} strokeWidth={2} />}
        <span>{themeLabel}</span>
      </button>
    </div>
  );
};

/* --------------------------------------------------------------- styling */

/**
 * The bar's own geometry.
 *
 * Everything above it — the surface, the top border, the type scale, the hover
 * and pressed states, the running-build indicator — is in
 * `ui/eukolia-shell.css`, where it sits beside the title bar and the tab strip
 * so the three strips cannot drift apart. What stays here is the height and the
 * clipping, which are what keep a long line of state on one line.
 */
const bar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  height: 22,
  flexShrink: 0,
  overflow: 'hidden'
};

/**
 * An item that is a *control*: geometry inline, everything else from
 * `.eu-status-item`.
 *
 * `flexShrink: 0` is stated here rather than in the stylesheet because
 * `tests/ui/status-bar.render.test.ts` reads it back off the element — the
 * layout cluster must never be squeezed out by a long file path, and that is a
 * guarantee worth keeping where a test can see it.
 */
const cell: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '0 7px',
  flexShrink: 0,
  borderRadius: 3
};

/** An item that is *read*, not pressed: the same box with a default cursor. */
const label: React.CSSProperties = {
  ...cell,
  cursor: 'default'
};

/**
 * Truncation needs a block-level span: `text-overflow` does not apply to a flex
 * container's own text, so the label is wrapped in this. `tests/ui/
 * status-bar.render.test.ts` pins all three declarations.
 */
const ellipsis: React.CSSProperties = {
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0
};

/**
 * A glyph control in the bar.
 *
 * `width: 22` and `flexShrink: 0` are inline for the same reason as `cell`'s:
 * the layout cluster is the last thing on the bar and must survive whatever the
 * document's path is called.
 */
const iconButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  flexShrink: 0,
  padding: 0,
  borderRadius: 3
};

/** The gap that pushes everything after it to the right-hand end. */
const spacer: React.CSSProperties = {
  minWidth: 4
};

export default StatusBar;