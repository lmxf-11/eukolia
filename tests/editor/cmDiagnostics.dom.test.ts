// @vitest-environment jsdom
/**
 * `cmDiagnostics` inside a real CodeMirror 6 editor.
 *
 * `cmDiagnostics.test.ts` covers the pure state logic without a DOM. What it
 * cannot cover is the part that only exists once `@codemirror/lint` is running:
 * that a pushed diagnostic actually reaches the lint state as a squiggle, that
 * the two sources are *both* on screen at once, and that publishing one leaves
 * the other alone. Those are the requirements the Monaco editor met with two
 * marker owners, so they are worth an end-to-end check.
 *
 * The linter's worker is stubbed — nothing here pretends to run the ported
 * Overleaf worker — but everything else is the real extension stack.
 */

import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { diagnosticCount, forEachDiagnostic, type Diagnostic } from '@codemirror/lint';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { compilerDiagnostics, latexLint, setCompilerDiagnostics } from '../../src/renderer/editor/cmDiagnostics';
import { latexLintService, type LintDiagnostic } from '../../src/renderer/editor/latexLinter';
import { settingsManager } from '../../src/renderer/core/settings';
import type { DiagnosticItem } from '../../src/renderer/compiler/logParser';

const DOC = 'first line\nsecond line\nthird line\n';

function item(overrides: Partial<DiagnosticItem> = {}): DiagnosticItem {
  return {
    file: 'main.tex',
    line: 1,
    column: 1,
    severity: 'error',
    message: 'Undefined control sequence.',
    source: 'latex',
    level: 'error',
    raw: 'Undefined control sequence.',
    category: 'compiler-error',
    ...overrides
  };
}

function lintDiagnostic(overrides: Partial<LintDiagnostic> = {}): LintDiagnostic {
  return {
    from: 0,
    to: 5,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 6,
    severity: 'warning',
    message: 'linter warning',
    source: 'latex linter',
    ...overrides
  };
}

/** The editor publishes asynchronously (the lint plugin runs on a timer), so wait for it. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function diagnosticsOf(view: EditorView): Array<{ message: string; from: number; to: number; diagnostic: Diagnostic }> {
  const found: Array<{ message: string; from: number; to: number; diagnostic: Diagnostic }> = [];
  forEachDiagnostic(view.state, (diagnostic, from, to) =>
    found.push({ message: diagnostic.message, from, to, diagnostic })
  );
  return found;
}

const views: EditorView[] = [];

function openEditor(extensions: Extension[]): EditorView {
  const view = new EditorView({ state: EditorState.create({ doc: DOC, extensions: [lineNumbers(), ...extensions] }) });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.restoreAllMocks();
  // The settings manager is global: put back what the schema defines. Because
  // `getValue` reads the schema default for an unknown key, this leaves the rest
  // of the suite with the same settings it would have had on its own.
  settingsManager.reset('latex.diagnostics.delayMs');
  settingsManager.setValue('latex.diagnostics.fromCompiler', true, 'default');
});

describe('compiler diagnostics in a real editor', () => {
  it('reaches @codemirror/lint at the position the compiler named', async () => {
    const view = openEditor([compilerDiagnostics({ file: 'main.tex' })]);
    setCompilerDiagnostics(view, [item({ line: 2, column: 3 })]);

    await until(() => diagnosticCount(view.state) === 1, 'the compiler’s diagnostic');

    const [found] = diagnosticsOf(view);
    expect(found.from).toBe(13);
    expect(found.to).toBe(22);
    expect(found.diagnostic.severity).toBe('error');
    // `@codemirror/lint` draws the squiggle and the line-number gutter highlight
    // from this state, which is what the class names below come from.
    await until(() => view.dom.querySelector('.cm-lintRange-error') !== null, 'the squiggle');
    await until(() => view.dom.querySelector('.cm-lint-error, .cm-lint-marker-error') !== null, 'the line number error highlight');
  });

  it('keeps another file’s diagnostics out of the document', async () => {
    const view = openEditor([compilerDiagnostics({ file: 'main.tex' })]);
    setCompilerDiagnostics(view, [
      item({ line: 2, column: 3 }),
      item({ file: 'chapters/intro.tex', line: 1, message: 'Undefined control sequence.' })
    ]);

    await until(() => diagnosticCount(view.state) === 1, 'a single diagnostic');

    expect(diagnosticsOf(view)).toHaveLength(1);
  });

  it('shows the compiler’s errors and the linter’s warnings at the same time', async () => {
    settingsManager.setValue('latex.diagnostics.delayMs', 0, 'default');
    vi.spyOn(latexLintService, 'lint').mockResolvedValue([lintDiagnostic()]);

    const view = openEditor([compilerDiagnostics({ file: 'main.tex' }), latexLint()]);
    setCompilerDiagnostics(view, [item({ line: 2, column: 3 })]);

    await until(() => diagnosticCount(view.state) === 2, 'both sources');

    expect(diagnosticsOf(view).map((found) => found.message).sort()).toEqual([
      'Undefined control sequence.',
      'linter warning'
    ]);

    // Publishing the compiler's diagnostics again, and then clearing them, must
    // both leave the linter's warning where it was.
    setCompilerDiagnostics(view, [item({ line: 3, column: 1 })]);
    await until(() => diagnosticCount(view.state) === 2, 'both sources after a second push');

    setCompilerDiagnostics(view, []);
    await until(() => diagnosticCount(view.state) === 1, 'the linter’s warning alone');

    const remaining = diagnosticsOf(view);
    expect(remaining.map((found) => found.message)).toEqual(['linter warning']);
    expect(remaining[0].diagnostic.source).toBe('latex linter');
  });

  it('honours latex.diagnostics.fromCompiler without waiting for another build', async () => {
    const view = openEditor([compilerDiagnostics({ file: 'main.tex' })]);
    setCompilerDiagnostics(view, [item({ line: 2, column: 3 })]);
    await until(() => diagnosticCount(view.state) === 1, 'the compiler’s diagnostic');

    settingsManager.setValue('latex.diagnostics.fromCompiler', false, 'default');
    await until(() => diagnosticCount(view.state) === 0, 'the diagnostics to be suppressed');

    settingsManager.setValue('latex.diagnostics.fromCompiler', true, 'default');
    await until(() => diagnosticCount(view.state) === 1, 'the diagnostics to come back');
  });
});
