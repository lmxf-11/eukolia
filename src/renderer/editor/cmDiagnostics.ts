/**
 * Eukolia — LaTeX diagnostics for the CodeMirror 6 editor.
 *
 * Code Mode and Visual Mode are being unified onto CodeMirror 6, so this module
 * carries the diagnostic half of `monacoLatex.ts`
 * (`setLatexDiagnostics` / `setLinterDiagnostics` / `clearLatexDiagnostics`)
 * over to `@codemirror/lint`. The behaviour is the specification; only the
 * engine changed.
 *
 * Two sources of diagnostics are published side by side:
 *
 *  * the **compiler's**, pushed by the application after a build through
 *    {@link setCompilerDiagnostics} and held in a state field; and
 *  * the **linter's**, produced by the ported Overleaf LaTeX linter while
 *    typing, through {@link latexLint}, and held in a *second* state field.
 *
 * They are separate fields for exactly the reason the Monaco editor used two
 * marker owners (`eukolia-compiler` and `eukolia-linter`): a lint pass must
 * never wipe the compiler's errors, and a build must never wipe the linter's
 * warnings. `@codemirror/lint` concatenates the diagnostics of every configured
 * linter, so both sets are drawn at once — squiggles in the text and markers in
 * the lint gutter — while each source stays independently replaceable.
 *
 * Note that `setDiagnostics` is *not* used to publish them: it replaces the
 * whole lint state, which is precisely the clobbering this module exists to
 * avoid. The diagnostics it would carry are what both sources hand to their
 * linter.
 *
 * Nothing here dispatches from React. The application pushes a list when it
 * changes; re-pushing an unchanged list is a no-op, so a re-render cannot drive
 * a loop.
 */

import {
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Text,
  type Transaction
} from '@codemirror/state';
import {
  GutterMarker,
  lineNumberMarkers,
  showTooltip,
  ViewPlugin,
  type EditorView,
  type Tooltip,
  type ViewUpdate
} from '@codemirror/view';
import {
  forEachDiagnostic,
  linter,
  setDiagnosticsEffect,
  type Diagnostic,
  type LintSource
} from '@codemirror/lint';

import type { DiagnosticItem } from '../compiler/logParser';
import { setting, settingsManager } from '../core/settings';
import { latexLintService, type LintDiagnostic } from './latexLinter';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * A compiler diagnostic that remembers which file the compiler blamed. The file
 * is not part of `@codemirror/lint`'s `Diagnostic`, but the application holds
 * the diagnostics of the whole project, so the editor has to be able to tell
 * one file's diagnostics from another's.
 */
interface CompilerDiagnostic extends Diagnostic {
  file: string;
  /** The compiler's own error code, when it has one. */
  code?: string;
}

/** Replaces the compiler's diagnostics wholesale. */
const setCompilerDiagnosticsEffect = StateEffect.define<readonly CompilerDiagnostic[]>();

/** The compiler's diagnostics, as the editor currently holds them. */
const compilerDiagnosticsField = StateField.define<readonly CompilerDiagnostic[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setCompilerDiagnosticsEffect)) return effect.value;
    }
    // The compiler described the document as it was when it ran; edits since
    // then have to move the diagnostics with the text. CodeMirror's own lint
    // state maps its decorations the same way.
    return mapThroughChanges(value, transaction);
  }
});

/** Replaces the linter's diagnostics wholesale. Separate from the compiler's on purpose. */
const setLinterDiagnosticsEffect = StateEffect.define<readonly Diagnostic[]>();

/** The linter's diagnostics — a different field from the compiler's, so neither can clear the other. */
const linterDiagnosticsField = StateField.define<readonly Diagnostic[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setLinterDiagnosticsEffect)) return effect.value;
    }
    return mapThroughChanges(value, transaction);
  }
});

/**
 * Carried by the transaction the settings watcher dispatches, so that a change
 * to a setting this module reads takes effect at once — in particular, turning
 * the linter off must remove what its last pass put on screen — instead of
 * waiting for the next keystroke. Nothing consumes the effect: it is a marker
 * that `@codemirror/lint` re-reads both sources, and a disabled source then
 * answers with nothing. No field is needed to hold it, which keeps each
 * extension down to the single field that holds its diagnostics.
 */
const settingsChangedEffect = StateEffect.define<null>();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Maps diagnostic ranges through the changes of a transaction, so a squiggle
 * stays on its text while the user types above it.
 */
function mapThroughChanges<T extends Diagnostic>(
  diagnostics: readonly T[],
  transaction: Transaction
): readonly T[] {
  if (!transaction.docChanged || diagnostics.length === 0) return diagnostics;

  const length = transaction.state.doc.length;
  return diagnostics.map((diagnostic) => {
    const from = clamp(transaction.changes.mapPos(diagnostic.from, 1), 0, length);
    const to = clamp(transaction.changes.mapPos(diagnostic.to, -1), from, length);
    if (from === diagnostic.from && to === diagnostic.to) return diagnostic;
    // The spread keeps whatever extra fields `T` adds to `Diagnostic` at
    // runtime; TypeScript cannot express that, hence the assertion.
    return { ...diagnostic, from, to } as T;
  });
}

/** Both sources spell their third severity differently: `information`, `info`. */
function severityName(severity: 'error' | 'warning' | 'information' | 'info'): Diagnostic['severity'] {
  switch (severity) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'info';
  }
}

/**
 * Monaco showed a marker's `code` beside its `source`; CodeMirror's `Diagnostic`
 * has a source but no code, so the code is folded into the message rather than
 * dropped.
 */
function messageOf(item: DiagnosticItem): string {
  if (!item.code || item.message.includes(item.code)) return item.message;
  return `${item.message} [${item.code}]`;
}

/** Compares two compiler paths the way the Monaco editor did: slash-agnostic, case-insensitive. */
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  return normalizePath(a) === normalizePath(b);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

/**
 * Turns a compiler diagnostic into a `@codemirror/lint` one.
 *
 * The compiler reports a 1-based line and column; CodeMirror addresses the
 * document by offset. A position the compiler invented — a stale build, a line
 * past the end of an edited file — is clamped onto the nearest real position
 * rather than thrown: a diagnostic must never take the editor down.
 *
 * The Monaco version underlined from the reported column to the end of the line
 * (`endColumn: model.getLineMaxColumn(line)`); the range below is the same.
 */
function toCompilerDiagnostic(item: DiagnosticItem, doc: Text): CompilerDiagnostic {
  const line = doc.line(clamp(Math.trunc(item.line) || 1, 1, doc.lines));
  const column = clamp(Math.trunc(item.column ?? 1) || 1, 1, line.length + 1);

  return {
    from: line.from + column - 1,
    to: line.to,
    severity: severityName(item.severity),
    message: messageOf(item),
    source: item.source,
    file: item.file,
    code: item.code
  };
}

/** Maps the linter's results, which already carry character offsets, onto `Diagnostic`s. */
function toLinterDiagnostics(diagnostics: readonly LintDiagnostic[], length: number): readonly Diagnostic[] {
  return diagnostics.map((diagnostic) => {
    // A pass that ended while the text was changing can name a position the
    // document no longer has, and `@codemirror/lint` rejects a range that runs
    // past the end of the document.
    const from = clamp(diagnostic.from, 0, length);
    const to = clamp(diagnostic.to, from, length);
    return {
      from,
      to,
      severity: severityName(diagnostic.severity),
      message: diagnostic.message,
      source: diagnostic.source || 'latex linter'
    };
  });
}

function sameDiagnostics(a: readonly CompilerDiagnostic[], b: readonly CompilerDiagnostic[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index];
    const right = b[index];
    if (
      left.from !== right.from ||
      left.to !== right.to ||
      left.severity !== right.severity ||
      left.message !== right.message ||
      left.source !== right.source ||
      left.file !== right.file ||
      left.code !== right.code
    ) {
      return false;
    }
  }
  return true;
}

/**
 * True when a setting this module reads has just been reported as changed.
 * {@link settingsWatcher} marks those transactions with {@link settingsChangedEffect}.
 */
function settingsChanged(update: ViewUpdate): boolean {
  return update.transactions.some((transaction) =>
    transaction.effects.some((effect) => effect.is(settingsChangedEffect))
  );
}

/**
 * True when something this module owns has changed: either diagnostic field, or
 * a setting it reads.
 *
 * `@codemirror/lint` combines the `needsRefresh` of every linter with `||` and
 * then re-reads *all* sources, which is what puts a newly pushed set of
 * diagnostics on screen. A lint pass itself never writes a field, so a refresh
 * cannot schedule another refresh: the two sources cannot loop.
 */
function diagnosticsChanged(update: ViewUpdate): boolean {
  return (
    settingsChanged(update) ||
    update.startState.field(compilerDiagnosticsField, false) !==
      update.state.field(compilerDiagnosticsField, false) ||
    update.startState.field(linterDiagnosticsField, false) !==
      update.state.field(linterDiagnosticsField, false)
  );
}

// ---------------------------------------------------------------------------
// Lint sources
// ---------------------------------------------------------------------------

/**
 * Timing is owned here rather than by `@codemirror/lint`: the linter debounces
 * its own worker pass, and the compiler's diagnostics are already computed when
 * they are pushed. The delay is combined across linters with `Math.max`, so a
 * non-zero value here would also hold the other source back.
 */
const lintConfig = {
  delay: 0,
  needsRefresh: diagnosticsChanged
};

/**
 * Re-publishes the compiler's field, scoped to the document on screen.
 *
 * `latex.diagnostics.fromCompiler` is honoured at read time, so switching it off
 * removes the diagnostics already on screen instead of waiting for the next
 * build.
 */
function compilerLintSource(file: () => string | null): LintSource {
  return (view) => {
    if (!setting.bool('latex.diagnostics.fromCompiler')) return [];

    const diagnostics = view.state.field(compilerDiagnosticsField, false) ?? [];
    if (diagnostics.length === 0) return diagnostics;

    const scope = file();
    // No path to compare with: the caller is responsible for what it pushes.
    if (!scope) return diagnostics;
    return diagnostics.filter((diagnostic) => samePath(diagnostic.file, scope));
  };
}

/** Re-publishes the linter's field; nothing at all while the linter is switched off. */
const linterLintSource: LintSource = (view) => {
  if (!setting.bool('latex.diagnostics.linter')) return [];
  return view.state.field(linterDiagnosticsField, false) ?? [];
};

// ---------------------------------------------------------------------------
// View plugins
// ---------------------------------------------------------------------------

/**
 * Marker that highlights a line number in the gutter when an error or warning
 * occurs on that line. Does not define `toDOM`, so the line number text is
 * preserved while the gutter element receives the diagnostic CSS classes.
 */
class DiagnosticLineMarker extends GutterMarker {
  constructor(readonly severity: 'error' | 'warning') {
    super();
    this.elementClass =
      severity === 'error'
        ? 'cm-lint-error cm-lint-line-error cm-lint-marker-error'
        : 'cm-lint-warning cm-lint-line-warning cm-lint-marker-warning';
  }

  eq(other: GutterMarker): boolean {
    return other instanceof DiagnosticLineMarker && this.severity === other.severity;
  }
}

const errorLineMarker = new DiagnosticLineMarker('error');
const warningLineMarker = new DiagnosticLineMarker('warning');

/**
 * Computes line-number gutter markers from active diagnostics.
 * When both an error and a warning fall on the same line, the error takes
 * precedence (red).
 */
function markersForDiagnostics(doc: Text, diagnostics: readonly Diagnostic[]): RangeSet<GutterMarker> {
  const byLine = new Map<number, 'error' | 'warning'>();
  for (const diagnostic of diagnostics) {
    const severity = diagnostic.severity;
    if (severity !== 'error' && severity !== 'warning') continue;
    const pos = clamp(diagnostic.from, 0, doc.length);
    const line = doc.lineAt(pos);
    const current = byLine.get(line.from);
    if (severity === 'error' || !current) {
      byLine.set(line.from, severity);
    }
  }

  if (byLine.size === 0) return RangeSet.empty;

  const markers: Range<GutterMarker>[] = [];
  for (const [lineFrom, severity] of byLine) {
    markers.push((severity === 'error' ? errorLineMarker : warningLineMarker).range(lineFrom));
  }
  markers.sort((a, b) => a.from - b.from);
  return RangeSet.of(markers, true);
}

interface DiagnosticLineHighlightState {
  readonly markers: RangeSet<GutterMarker>;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Tracks active diagnostics and feeds markers to the line-number gutter via
 * `lineNumberMarkers`.
 */
const diagnosticLineHighlightField = StateField.define<DiagnosticLineHighlightState>({
  create() {
    return { markers: RangeSet.empty, diagnostics: [] };
  },
  update(value, tr) {
    let markers = value.markers.map(tr.changes);
    let diagnostics = value.diagnostics;

    let hasNewDiagnostics = false;
    for (const effect of tr.effects) {
      if (effect.is(setDiagnosticsEffect)) {
        diagnostics = effect.value;
        hasNewDiagnostics = true;
      }
    }

    if (hasNewDiagnostics) {
      markers = markersForDiagnostics(tr.state.doc, diagnostics);
    } else if (tr.docChanged && diagnostics.length > 0) {
      diagnostics = mapThroughChanges(diagnostics, tr);
    }

    return { markers, diagnostics };
  },
  provide: (field) => lineNumberMarkers.from(field, (val) => val.markers)
});

/**
 * Returns all active diagnostics falling on a given 1-based line number.
 * Errors are sorted first, followed by warnings, then info/hints.
 */
export function getDiagnosticsForLine(state: EditorState, lineNumber: number): readonly Diagnostic[] {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return [];
  const line = state.doc.line(lineNumber);
  const found: Diagnostic[] = [];

  forEachDiagnostic(state, (diag, from, to) => {
    if (from <= line.to && to >= line.from) {
      if (!found.includes(diag)) {
        found.push(diag);
      }
    }
  });

  if (found.length === 0) {
    const highlightState = state.field(diagnosticLineHighlightField, false);
    if (highlightState && highlightState.diagnostics.length > 0) {
      for (const diag of highlightState.diagnostics) {
        const pos = clamp(diag.from, 0, state.doc.length);
        const diagLine = state.doc.lineAt(pos);
        if (diagLine.number === lineNumber) {
          if (!found.includes(diag)) {
            found.push(diag);
          }
        }
      }
    }
  }

  const severityRank = (s: Diagnostic['severity']): number => {
    switch (s) {
      case 'error':
        return 0;
      case 'warning':
        return 1;
      case 'info':
        return 2;
      default:
        return 3;
    }
  };

  return found.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.from - b.from);
}

/**
 * State effect to show or dismiss the line diagnostic tooltip.
 */
export const setLineDiagnosticTooltipEffect = StateEffect.define<Tooltip | null>();

/**
 * State field holding the currently active line diagnostic tooltip, providing
 * it to CodeMirror's `showTooltip` facet.
 */
export const lineDiagnosticTooltipField = StateField.define<Tooltip | null>({
  create() {
    return null;
  },
  update(tooltip, tr) {
    if (tooltip && tr.docChanged) {
      tooltip = { ...tooltip, pos: tr.changes.mapPos(tooltip.pos) };
    }
    for (const effect of tr.effects) {
      if (effect.is(setLineDiagnosticTooltipEffect)) {
        return effect.value;
      }
    }
    return tooltip;
  },
  provide: (field) => showTooltip.from(field)
});

function createDiagnosticSvgIcon(severity: Diagnostic['severity']): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'cm-line-diagnostic-icon');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  if (severity === 'error') {
    svg.innerHTML =
      '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>';
  } else if (severity === 'warning') {
    svg.innerHTML =
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>';
  } else {
    svg.innerHTML =
      '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>';
  }
  return svg;
}

/**
 * Builds the modern tooltip DOM for line diagnostics.
 */
function renderModernDiagnosticTooltip(
  view: EditorView,
  diagnostics: readonly Diagnostic[],
  lineNumber: number
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'cm-tooltip-line-diagnostic cm-tooltip-lint';
  container.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  const header = document.createElement('div');
  header.className = 'cm-line-diagnostic-header';

  const title = document.createElement('span');
  title.className = 'cm-line-diagnostic-title';
  title.textContent = `Line ${lineNumber}`;

  const count = document.createElement('span');
  count.className = 'cm-line-diagnostic-count';
  count.textContent = diagnostics.length === 1 ? '1 problem' : `${diagnostics.length} problems`;

  header.appendChild(title);
  header.appendChild(count);
  container.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'cm-line-diagnostic-list';

  for (const diagnostic of diagnostics) {
    const item = document.createElement('li');
    item.className = `cm-line-diagnostic-item cm-line-diagnostic-item-${diagnostic.severity}`;

    const topRow = document.createElement('div');
    topRow.className = 'cm-line-diagnostic-item-top';

    const badge = document.createElement('span');
    badge.className = `cm-line-diagnostic-badge cm-line-diagnostic-badge-${diagnostic.severity}`;
    badge.appendChild(createDiagnosticSvgIcon(diagnostic.severity));

    const label =
      diagnostic.severity === 'error'
        ? 'Error'
        : diagnostic.severity === 'warning'
          ? 'Warning'
          : 'Info';
    badge.appendChild(document.createTextNode(label));
    topRow.appendChild(badge);

    if (diagnostic.source) {
      const source = document.createElement('span');
      source.className = 'cm-line-diagnostic-source';
      source.textContent = diagnostic.source;
      topRow.appendChild(source);
    }
    item.appendChild(topRow);

    const messageEl = document.createElement('div');
    messageEl.className = 'cm-line-diagnostic-message';
    if (diagnostic.renderMessage) {
      messageEl.appendChild(diagnostic.renderMessage(view));
    } else {
      messageEl.textContent = diagnostic.message;
    }
    item.appendChild(messageEl);

    if (diagnostic.actions && diagnostic.actions.length > 0) {
      const actionsContainer = document.createElement('div');
      actionsContainer.className = 'cm-line-diagnostic-actions';
      for (const action of diagnostic.actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cm-line-diagnostic-action-btn';
        btn.textContent = action.name;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          action.apply(view, diagnostic.from, diagnostic.to);
        });
        actionsContainer.appendChild(btn);
      }
      item.appendChild(actionsContainer);
    }

    list.appendChild(item);
  }

  container.appendChild(list);
  return container;
}

function parseLineNumber(gutterEl: HTMLElement, view: EditorView): number | null {
  const text = gutterEl.textContent?.trim() || '';
  const num = Number.parseInt(text, 10);
  if (Number.isFinite(num) && num >= 1 && num <= view.state.doc.lines) {
    return num;
  }
  try {
    const rect = gutterEl.getBoundingClientRect();
    if (rect.height > 0) {
      const lineBlock = view.lineBlockAtHeight(rect.top + rect.height / 2);
      return view.state.doc.lineAt(lineBlock.from).number;
    }
  } catch {
    // ignore
  }
  return null;
}

const lineDiagnosticHoverPlugin = ViewPlugin.fromClass(
  class {
    private hoverTimeout: ReturnType<typeof setTimeout> | null = null;
    private currentLine: number | null = null;
    private currentElement: HTMLElement | null = null;
    private isTracking = false;
    private destroyed = false;

    constructor(private readonly view: EditorView) {
      this.handleMouseMove = this.handleMouseMove.bind(this);
      this.handleWindowMouseMove = this.handleWindowMouseMove.bind(this);
      this.handleKeyDown = this.handleKeyDown.bind(this);

      view.dom.addEventListener('mousemove', this.handleMouseMove);
      view.dom.addEventListener('mouseover', this.handleMouseMove);
      view.dom.addEventListener('keydown', this.handleKeyDown);
    }

    private handleMouseMove(event: MouseEvent): void {
      if (this.destroyed) return;

      const target = event.target as HTMLElement | null;
      if (!target) return;

      if (target.closest('.cm-tooltip-line-diagnostic')) {
        return;
      }

      const gutterEl = target.closest<HTMLElement>('.cm-lineNumbers .cm-gutterElement');
      if (gutterEl) {
        const lineNum = parseLineNumber(gutterEl, this.view);
        if (lineNum !== null) {
          const diagnostics = getDiagnosticsForLine(this.view.state, lineNum);
          if (diagnostics.length > 0) {
            if (this.currentLine === lineNum && this.view.state.field(lineDiagnosticTooltipField, false)) {
              return;
            }

            if (this.hoverTimeout && this.currentLine !== lineNum) {
              clearTimeout(this.hoverTimeout);
              this.hoverTimeout = null;
            }

            if (this.currentLine !== lineNum) {
              this.currentLine = lineNum;
              this.currentElement = gutterEl;

              const hasOpenTooltip = Boolean(this.view.state.field(lineDiagnosticTooltipField, false));
              const delay = hasOpenTooltip ? 0 : 80;

              if (delay === 0) {
                this.showTooltip(lineNum, gutterEl, diagnostics);
              } else {
                this.hoverTimeout = setTimeout(() => {
                  this.hoverTimeout = null;
                  if (this.destroyed) return;
                  this.showTooltip(lineNum, gutterEl, diagnostics);
                }, delay);
              }
            }
            return;
          }
        }
      }

      this.checkDismiss(event);
    }

    private handleWindowMouseMove(event: MouseEvent): void {
      if (this.destroyed) return;
      this.checkDismiss(event);
    }

    private checkDismiss(event: MouseEvent): void {
      if (!this.view.state.field(lineDiagnosticTooltipField, false) && !this.hoverTimeout) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.cm-tooltip-line-diagnostic')) {
        return;
      }

      if (this.currentElement) {
        const rect = this.currentElement.getBoundingClientRect();
        const margin = 10;
        if (
          event.clientX >= rect.left - margin &&
          event.clientX <= rect.right + margin &&
          event.clientY >= rect.top - margin &&
          event.clientY <= rect.bottom + margin
        ) {
          return;
        }
      }

      const gutterEl = target?.closest?.<HTMLElement>('.cm-lineNumbers .cm-gutterElement');
      if (gutterEl && gutterEl !== this.currentElement) {
        const lineNum = parseLineNumber(gutterEl, this.view);
        if (lineNum !== null && getDiagnosticsForLine(this.view.state, lineNum).length > 0) {
          this.handleMouseMove(event);
          return;
        }
      }

      this.hideTooltip();
    }

    private showTooltip(lineNum: number, gutterEl: HTMLElement, diagnostics: readonly Diagnostic[]): void {
      if (this.destroyed) return;
      const line = this.view.state.doc.line(lineNum);
      const tooltip: Tooltip = {
        pos: line.from,
        above: false,
        clip: false,
        create: (view) => ({
          dom: renderModernDiagnosticTooltip(view, diagnostics, lineNum),
          getCoords: () => {
            const rect = gutterEl.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom
            };
          }
        })
      };

      this.view.dispatch({ effects: setLineDiagnosticTooltipEffect.of(tooltip) });

      if (!this.isTracking) {
        this.isTracking = true;
        window.addEventListener('mousemove', this.handleWindowMouseMove);
      }
    }

    private hideTooltip(): void {
      if (this.hoverTimeout) {
        clearTimeout(this.hoverTimeout);
        this.hoverTimeout = null;
      }
      this.currentLine = null;
      this.currentElement = null;

      if (this.isTracking) {
        this.isTracking = false;
        window.removeEventListener('mousemove', this.handleWindowMouseMove);
      }

      if (this.view.state.field(lineDiagnosticTooltipField, false)) {
        this.view.dispatch({ effects: setLineDiagnosticTooltipEffect.of(null) });
      }
    }

    private handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        this.hideTooltip();
      }
    }

    update(update: ViewUpdate): void {
      if (update.docChanged && this.currentLine !== null) {
        if (this.currentLine > update.state.doc.lines) {
          this.hideTooltip();
        } else {
          const diagnostics = getDiagnosticsForLine(update.state, this.currentLine);
          if (diagnostics.length === 0) {
            this.hideTooltip();
          }
        }
      }
    }

    destroy(): void {
      this.destroyed = true;
      this.hideTooltip();
      this.view.dom.removeEventListener('mousemove', this.handleMouseMove);
      this.view.dom.removeEventListener('mouseover', this.handleMouseMove);
      this.view.dom.removeEventListener('keydown', this.handleKeyDown);
    }
  }
);

/**
 * Highlights line numbers in red for errors and yellow for warnings, avoiding
 * a separate gutter column so the line index bar stays narrow, and displays
 * modern diagnostic tooltips on hover.
 */
export const diagnosticLineHighlight: Extension = [
  diagnosticLineHighlightField,
  lineDiagnosticTooltipField,
  lineDiagnosticHoverPlugin
];

/**
 * Backward-compatible alias for `diagnosticLineHighlight`.
 */
export const diagnosticGutter: Extension = diagnosticLineHighlight;

/**
 * Turns a settings change into a transaction, and drops a linter pass whose
 * setting has just been switched off.
 *
 * The dispatch is deferred by a microtask so that it can never run inside an
 * editor update: `EditorView.update` may not be called while one is in
 * progress, and a settings event could in principle be raised from a listener
 * that is itself reacting to an editor update.
 */
const settingsWatcher = ViewPlugin.fromClass(
  class {
    private readonly unsubscribe: () => void;
    private destroyed = false;

    constructor(private readonly view: EditorView) {
      this.unsubscribe = settingsManager.on('change', () => this.notify());
    }

    private notify(): void {
      queueMicrotask(() => {
        if (this.destroyed) return;

        const effects: StateEffect<unknown>[] = [settingsChangedEffect.of(null)];
        const stale = this.view.state.field(linterDiagnosticsField, false);
        if (stale?.length && !setting.bool('latex.diagnostics.linter')) {
          effects.push(setLinterDiagnosticsEffect.of([]));
        }
        this.view.dispatch({ effects });
      });
    }

    destroy(): void {
      this.destroyed = true;
      this.unsubscribe();
    }
  }
);

/**
 * Runs the ported Overleaf linter while typing.
 *
 * The scheduling is the Monaco editor's: every content change re-arms a timer of
 * `latex.diagnostics.delayMs`, and the pass is dropped when the document has
 * moved on before the worker answered — the linter is a worker round-trip, and a
 * stale answer must never be painted over newer text.
 */
const lintWhileTyping = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;

    constructor(private readonly view: EditorView) {
      // The document that is already open deserves the same treatment as one
      // that was just typed into.
      this.schedule();
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || settingsChanged(update)) this.schedule();
    }

    destroy(): void {
      this.destroyed = true;
      this.cancel();
    }

    private cancel(): void {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }

    /** Re-arms the delay. A newer keystroke always wins, so nothing queues up. */
    private schedule(): void {
      this.cancel();
      if (!setting.bool('latex.diagnostics.linter')) return;

      this.timer = setTimeout(() => {
        this.timer = null;
        this.run();
      }, Math.max(0, setting.num('latex.diagnostics.delayMs')));
    }

    private run(): void {
      if (this.destroyed || !setting.bool('latex.diagnostics.linter')) return;

      const document = this.view.state.doc;
      const text = document.toString();
      const cursor = this.view.state.selection.main.head;

      void latexLintService
        .lint(text, cursor)
        .then((diagnostics) => {
          if (this.destroyed) return;
          // The buffer moved on: this pass describes text that is no longer
          // there. An edit always produces a new `Text`, so identity is enough.
          if (this.view.state.doc !== document) return;
          // The linter may have been switched off while the worker was busy;
          // its answer must not come back to life when it is switched on again.
          if (!setting.bool('latex.diagnostics.linter')) return;
          this.view.dispatch({
            effects: setLinterDiagnosticsEffect.of(toLinterDiagnostics(diagnostics, document.length))
          });
        })
        .catch((error) => {
          console.error('[eukolia] LaTeX lint failed', error);
        });
    }
  }
);

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------

/**
 * The compiler's diagnostics: a state field holding them, and a linter that
 * publishes them.
 *
 * `file` scopes them to the document on screen, exactly as the Monaco version
 * compared every `DiagnosticItem.file` with the model's path — the application
 * holds the diagnostics of the whole project, so without a path another file's
 * errors would be drawn over this document's text. Pass the open document's
 * path; a getter is accepted for an editor that swaps documents under one view.
 * With no path at all the extension shows every diagnostic it is given, because
 * it cannot tell which of them belong to the document.
 */
export function compilerDiagnostics(options: { file?: string | null | (() => string | null) } = {}): Extension {
  const scope = options.file;
  const file = typeof scope === 'function' ? scope : () => scope ?? null;

  return [
    compilerDiagnosticsField,
    linter(compilerLintSource(file), lintConfig),
    diagnosticGutter,
    settingsWatcher
  ];
}

/**
 * Pushes the compiler's diagnostics into the editor. Idempotent: a list equal to
 * the one already held is not dispatched, so calling this from a React effect
 * that runs on every render is harmless.
 *
 * `clearLatexDiagnostics`' replacement is `setCompilerDiagnostics(view, [])`.
 */
export function setCompilerDiagnostics(view: EditorView, items: readonly DiagnosticItem[]): void {
  // Without `compilerDiagnostics()` in the editor there is no field to hold
  // them and nothing would render them.
  const current = view.state.field(compilerDiagnosticsField, false);
  if (!current) return;

  const next = items.map((item) => toCompilerDiagnostic(item, view.state.doc));
  if (sameDiagnostics(current, next)) return;

  view.dispatch({ effects: setCompilerDiagnosticsEffect.of(next) });
}

/**
 * Runs the ported LaTeX linter while typing, on the configured delay, and
 * publishes its diagnostics from a field of their own so a lint pass cannot
 * clear the compiler's errors.
 */
export function latexLint(): Extension {
  return [
    linterDiagnosticsField,
    linter(linterLintSource, lintConfig),
    diagnosticGutter,
    settingsWatcher,
    lintWhileTyping
  ];
}
