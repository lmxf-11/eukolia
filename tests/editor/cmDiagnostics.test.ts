/**
 * CodeMirror 6 LaTeX diagnostics (`cmDiagnostics`).
 *
 * Two things are worth pinning down, because getting either wrong is invisible
 * until a squiggle lands on the wrong word:
 *
 *  * the compiler's 1-based line/column pairs become CodeMirror offsets, clamped
 *    rather than thrown when a stale build names a position the document no
 *    longer has; and
 *  * the compiler's diagnostics and the linter's live in separate state fields,
 *    so publishing one can never clear the other — the property the Monaco
 *    editor got from its two marker owners (`eukolia-compiler` /
 *    `eukolia-linter`).
 *
 * The tests drive a real `EditorState` through a stand-in for the view:
 * `setCompilerDiagnostics` only reads `state` and calls `dispatch`, and building
 * an `EditorView` would need a DOM that none of this logic uses.
 */

import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Transaction,
  type TransactionSpec
} from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { Diagnostic } from '@codemirror/lint';
import { describe, expect, it } from 'vitest';

import { compilerDiagnostics, latexLint, setCompilerDiagnostics } from '../../src/renderer/editor/cmDiagnostics';
import type { DiagnosticItem } from '../../src/renderer/compiler/logParser';

/** Three lines, so line 2 starts at offset 11: `first line\n` is ten characters. */
const DOC = 'first line\nsecond line\nthird line\n';

/** What the compiler's state field holds: CodeMirror diagnostics that remember their file. */
type PushedDiagnostic = Diagnostic & { file: string; code?: string };

/** A `DiagnosticItem` with everything a given test does not care about filled in. */
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

/**
 * The smallest stand-in for `EditorView` that `setCompilerDiagnostics` uses: a
 * state, and a `dispatch` that really applies the transaction.
 */
class TestView {
  public state: EditorState;
  public readonly transactions: Transaction[] = [];

  constructor(doc: string, extensions: Extension) {
    this.state = EditorState.create({ doc, extensions });
  }

  public dispatch(spec: TransactionSpec): void {
    const transaction = this.state.update(spec);
    this.transactions.push(transaction);
    this.state = transaction.state;
  }

  public asView(): EditorView {
    return this as unknown as EditorView;
  }
}

/**
 * The state fields an extension installs, read back out of the extension: a
 * `StateField` *is* an extension value, so `compilerDiagnostics()` and
 * `latexLint()` can each be asked which fields they bring. That is also how the
 * tests check that the two sources are separate.
 */
function stateFieldsOf(extension: Extension): StateField<unknown>[] {
  const values = Array.isArray(extension) ? extension : [extension];
  return values.filter((value): value is StateField<unknown> => value instanceof StateField);
}

const COMPILER = compilerDiagnostics();
const LINTER = latexLint();

const COMPILER_FIELD = stateFieldsOf(COMPILER)[0] as StateField<readonly PushedDiagnostic[]>;
const LINTER_FIELD = stateFieldsOf(LINTER)[0] as StateField<readonly Diagnostic[]>;

/** A view holding the extensions a given test needs, plus the fields to read back. */
function view(doc = DOC, extensions: Extension = COMPILER): TestView {
  return new TestView(doc, extensions);
}

function pushed(target: TestView): readonly PushedDiagnostic[] {
  return target.state.field(COMPILER_FIELD);
}

describe('line and column to offset', () => {
  it('places a diagnostic at the reported line and column', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), [item({ line: 2, column: 3 })]);

    const [diagnostic] = pushed(target);
    // Column 3 of `second line` is the `c` of `cond line`; the range runs to the
    // end of the line, which is what the Monaco markers underlined.
    expect(DOC.slice(diagnostic.from, diagnostic.to)).toBe('cond line');
    expect(diagnostic.from).toBe(13);
    expect(diagnostic.to).toBe(22);
  });

  it('defaults the column to the start of the line when the compiler gave none', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), [item({ line: 2, column: undefined })]);

    expect(pushed(target)[0].from).toBe(11);
  });

  it('clamps a line past the end of the document onto the last line', () => {
    const target = view('first line\nsecond line\nthird line');
    setCompilerDiagnostics(target.asView(), [item({ line: 99, column: 3 })]);

    const [diagnostic] = pushed(target);
    // The last line is `third line`, 23..33; column 3 is the `i` of `ird line`.
    expect(diagnostic.from).toBe(25);
    expect(diagnostic.to).toBe(33);
    expect(diagnostic.to).toBeLessThanOrEqual(target.state.doc.length);
  });

  it('clamps onto the empty line a trailing newline leaves behind', () => {
    // `DOC` ends with a newline, so its last line is empty — exactly what
    // Monaco's `getLineCount()` reported.
    const target = view();
    setCompilerDiagnostics(target.asView(), [item({ line: 99, column: 3 })]);

    expect(pushed(target)[0].from).toBe(DOC.length);
  });

  it('clamps line and column zero onto the first character', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), [item({ line: 0, column: 0 })]);

    const [diagnostic] = pushed(target);
    expect(diagnostic.from).toBe(0);
    expect(diagnostic.to).toBe(10);
  });

  it('clamps a column past the end of its line onto the line break', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), [item({ line: 2, column: 99 })]);

    const [diagnostic] = pushed(target);
    expect(diagnostic.from).toBe(22);
    expect(diagnostic.to).toBe(22);
  });

  it('never runs past the end of a document shorter than the compiler thought', () => {
    const target = view('ab');
    setCompilerDiagnostics(target.asView(), [item({ line: 5, column: 9 })]);

    const [diagnostic] = pushed(target);
    expect(diagnostic.from).toBe(2);
    expect(diagnostic.to).toBe(2);
  });

  it('keeps every range ordered and inside the document', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), [
      item({ line: 0, column: 0 }),
      item({ line: 2, column: 4 }),
      item({ line: 900, column: 900 })
    ]);

    for (const diagnostic of pushed(target)) {
      expect(diagnostic.from).toBeGreaterThanOrEqual(0);
      expect(diagnostic.to).toBeGreaterThanOrEqual(diagnostic.from);
      expect(diagnostic.to).toBeLessThanOrEqual(DOC.length);
    }
  });
});

describe('severity', () => {
  it('maps the compiler’s severities onto CodeMirror’s', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), [
      item({ line: 1, severity: 'error' }),
      item({ line: 2, severity: 'warning' }),
      item({ line: 3, severity: 'information' })
    ]);

    expect(pushed(target).map((diagnostic) => diagnostic.severity)).toEqual(['error', 'warning', 'info']);
  });
});

describe('message and provenance', () => {
  it('keeps the compiler’s message and source, and the file for scoping', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), [
      item({ file: 'chapters/intro.tex', source: 'bibtex', message: 'I found no \\citation commands.' })
    ]);

    const [diagnostic] = pushed(target);
    expect(diagnostic.message).toBe('I found no \\citation commands.');
    expect(diagnostic.source).toBe('bibtex');
    expect(diagnostic.file).toBe('chapters/intro.tex');
  });

  it('folds the compiler’s error code into the message, which CodeMirror has no field for', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), [item({ message: 'Emergency stop.', code: 'LTX-7' })]);

    expect(pushed(target)[0].message).toBe('Emergency stop. [LTX-7]');
  });

  it('does not repeat a code the message already carries', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), [item({ message: 'Emergency stop. [LTX-7]', code: 'LTX-7' })]);

    expect(pushed(target)[0].message).toBe('Emergency stop. [LTX-7]');
  });
});

describe('pushing the compiler’s diagnostics', () => {
  it('is a no-op when the same list is pushed again', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), [item({ line: 2, column: 3 })]);
    const afterFirst = pushed(target);

    // A re-render hands over a new array with the same contents; the state must
    // not move, or a React effect could drive an update loop.
    setCompilerDiagnostics(target.asView(), [item({ line: 2, column: 3 })]);

    expect(target.transactions).toHaveLength(1);
    expect(pushed(target)).toBe(afterFirst);
  });

  it('is a no-op when clearing an already empty list', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), []);
    setCompilerDiagnostics(target.asView(), []);

    expect(target.transactions).toHaveLength(0);
    expect(pushed(target)).toHaveLength(0);
  });

  it('replaces the diagnostics when the list really changed', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), [item({ line: 1 })]);
    setCompilerDiagnostics(target.asView(), [item({ line: 1 }), item({ line: 2, message: 'Overfull \\hbox.' })]);
    setCompilerDiagnostics(target.asView(), []);

    expect(target.transactions).toHaveLength(3);
    expect(pushed(target)).toHaveLength(0);
  });

  it('does nothing when the editor was not given compilerDiagnostics()', () => {
    const target = view(DOC, []);

    setCompilerDiagnostics(target.asView(), [item()]);

    expect(target.transactions).toHaveLength(0);
    expect(target.state.field(COMPILER_FIELD, false)).toBeUndefined();
  });
});

describe('document changes', () => {
  it('moves the diagnostics with the text while the next build is running', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), [item({ line: 2, column: 3 })]);

    // Four characters typed above the diagnostic push it down by four.
    target.dispatch({ changes: { from: 0, insert: 'new\n' } });

    const [diagnostic] = pushed(target);
    expect(diagnostic.from).toBe(17);
    expect(diagnostic.to).toBe(26);
  });

  it('keeps a range ordered when the document shrinks underneath it', () => {
    const target = view();
    setCompilerDiagnostics(target.asView(), [item({ line: 3, column: 5 })]);

    target.dispatch({ changes: { from: 0, to: DOC.length, insert: 'ab' } });

    const [diagnostic] = pushed(target);
    expect(diagnostic.from).toBe(2);
    expect(diagnostic.to).toBe(2);
    expect(diagnostic.to).toBeLessThanOrEqual(2);
  });

  it('re-reads line and column against the document when the application pushes again', () => {
    // What the application holds is the compiler's line and column, so a push is
    // interpreted against the text as it is now — the Monaco editor converted
    // them against the model on every push in exactly the same way. Until the
    // application speaks again, the field keeps the mapped positions.
    const target = view();
    const items = [item({ line: 2, column: 3 })];
    setCompilerDiagnostics(target.asView(), items);
    expect(pushed(target)[0].from).toBe(13);

    target.dispatch({ changes: { from: 0, insert: 'new\n' } });
    expect(pushed(target)[0].from).toBe(17);

    setCompilerDiagnostics(target.asView(), items);
    // Line 2 of `new\nfirst line\n…` is `first line`, whose column 3 is offset 6.
    expect(pushed(target)[0].from).toBe(6);
  });
});

describe('the two sources do not clobber each other', () => {
  it('installs one state field per source, and they are different fields', () => {
    expect(stateFieldsOf(COMPILER)).toHaveLength(1);
    expect(stateFieldsOf(LINTER)).toHaveLength(1);
    expect(COMPILER_FIELD).not.toBe(LINTER_FIELD);
  });

  it('leaves the linter’s diagnostics alone when the compiler publishes', () => {
    const target = view(DOC, [COMPILER, LINTER]);
    const linterBefore = target.state.field(LINTER_FIELD);

    setCompilerDiagnostics(target.asView(), [item({ line: 2, column: 3 })]);

    expect(pushed(target)).toHaveLength(1);
    expect(target.state.field(LINTER_FIELD)).toBe(linterBefore);
  });

  it('leaves the compiler’s diagnostics alone when another source publishes', () => {
    const target = view(DOC, [COMPILER, LINTER]);
    setCompilerDiagnostics(target.asView(), [item({ line: 2, column: 3 })]);
    const compilerBefore = pushed(target);

    // A linter pass writes its own field through its own effect; from the
    // compiler's field that is an effect it does not own, so the value stands.
    const anotherSourcesEffect = StateEffect.define<readonly Diagnostic[]>();
    const after = target.state.update({
      effects: anotherSourcesEffect.of([{ from: 0, to: 0, severity: 'warning', message: 'Overfull \\hbox.' }])
    }).state;

    expect(after.field(COMPILER_FIELD)).toBe(compilerBefore);
    expect(after.field(LINTER_FIELD)).toHaveLength(0);
  });

  it('clears only the compiler’s diagnostics when the application pushes an empty list', () => {
    const target = view(DOC, [COMPILER, LINTER]);
    setCompilerDiagnostics(target.asView(), [item({ line: 2, column: 3 })]);
    const linterBefore = target.state.field(LINTER_FIELD);

    setCompilerDiagnostics(target.asView(), []);

    expect(pushed(target)).toHaveLength(0);
    expect(target.state.field(LINTER_FIELD)).toBe(linterBefore);
  });
});
