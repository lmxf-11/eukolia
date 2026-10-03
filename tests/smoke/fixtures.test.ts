/**
 * Guards on the smoke-test fixtures.
 *
 * `npm run smoke` drives the real application against these files and asserts
 * specific things about them. Twice during development the harness silently
 * rotted because a run mutated its own fixture, and the failures looked like
 * product bugs. These checks fail fast and say what is wrong, so the harness
 * cannot quietly stop testing anything.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const FIXTURE_DIR = path.resolve(__dirname, 'fixture');

const read = (name: string): string => readFileSync(path.join(FIXTURE_DIR, name), 'utf8');

describe('smoke fixture: main.tex', () => {
  const tex = read('main.tex');

  it('has ragged ampersands, so the aligner has something to do', () => {
    // The aligner's whole purpose is padding these. If the checked-in copy were
    // already aligned, the aligner check would pass without testing anything.
    const block = /\\begin\{align\}([\s\S]*?)\\end\{align\}/.exec(tex);
    expect(block, 'main.tex must contain an align block').toBeTruthy();

    const rows = block![1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('&'));

    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      // Aligned rows are padded to the widest cell, producing a run of spaces
      // before the ampersand; the ragged form has exactly one.
      expect(row, `"${row}" is already padded; the fixture must stay ragged`).not.toMatch(/\S {2,}&/);
      expect(row, `"${row}" must contain a single space before &`).toMatch(/\S &/);
    }
  });

  it('ends with a single-line maths span for the snippet check to land in', () => {
    // The probe presses Ctrl+End then ArrowLeft twice and types `RR`; that only
    // lands inside mathematics if the last line is a one-character maths span.
    const lines = tex.split('\n').map((line) => line.trimEnd());
    const lastContent = [...lines].reverse().find((line) => line.length > 0);
    expect(lastContent, 'the document must end with the probe landing pad').toBe('\\(x\\)');
  });

  it('has sections, labels and mathematics for the outline and maths checks', () => {
    expect(tex).toContain('\\section{');
    expect(tex).toContain('\\label{');
    expect(tex).toMatch(/\\\[[\s\S]*?\\\]/);
    expect(tex).toMatch(/\\\([\s\S]*?\\\)/);
  });
});

describe('smoke fixture: broken.tex', () => {
  const broken = read('broken.tex');

  it('contains an undefined command, which the compiler must report', () => {
    expect(broken).toContain('\\thisCommandDoesNotExist');
  });

  it('contains an undefined reference, which the compiler must warn about', () => {
    expect(broken).toMatch(/\\ref\{sec:does-not-exist\}/);
  });

  it('is well formed enough that the failure is a real compile error, not a parse crash', () => {
    expect(broken).toContain('\\documentclass');
    expect(broken).toContain('\\begin{document}');
    expect(broken).toContain('\\end{document}');
  });
});

describe('smoke fixture: lint.tex', () => {
  const lint = read('lint.tex');

  it('has an unclosed group, which is what the linter detects', () => {
    // The linter reports structural problems, not undefined commands, which is
    // why this fixture exists separately from broken.tex.
    expect(lint).toMatch(/\\textbf\{[^}]*\.\n/);
  });

  it('is otherwise well formed', () => {
    expect(lint).toContain('\\documentclass');
    expect(lint).toContain('\\end{document}');
  });
});

describe('smoke fixture directory', () => {
  it('contains no build output from a previous run', () => {
    // A stale .pdf or .fdb_latexmk makes latexmk report "nothing to do", which
    // would hide the diagnostics the harness asserts on. A PDF is a legitimate
    // fixture only when it is an `\includegraphics` asset — that is, when no
    // `.tex` of the same name sits beside it (so `main.pdf` and `homework.pdf`
    // stay excluded while `figure.pdf` is allowed).
    const strays = readdirSync(FIXTURE_DIR).filter((name) => {
      if (name.endsWith('.tex')) return false;
      if (name.endsWith('.pdf')) {
        return existsSync(path.join(FIXTURE_DIR, `${name.replace(/\.pdf$/i, '')}.tex`));
      }
      return true;
    });
    expect(strays, `unexpected files in the fixture directory: ${strays.join(', ')}`).toEqual([]);
  });

  it('provides the realistic document used for the appearance checks', () => {
    const homework = read('homework.tex');
    expect(homework).toContain('\\begin{definition}');
    expect(homework).toMatch(/\\section\{/);
  });
});

describe('smoke fixture: figure.pdf', () => {
  const bytes = readFileSync(path.join(FIXTURE_DIR, 'figure.pdf'));

  it('is a real PDF the native engine can open', () => {
    // The probe asserts that Visual Mode paints this figure. If the asset were
    // missing or truncated, the failure would look like a graphics-widget bug.
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.subarray(-6).toString('latin1').trim()).toBe('%%EOF');
  });

  it('is regenerable from a checked-in script', () => {
    // Binary fixtures rot silently; this one has a documented source.
    const script = readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'make-fixture-pdf.mjs'), 'utf8');
    expect(script).toContain('figure.pdf');
  });

  it('is actually included by homework.tex', () => {
    const homework = read('homework.tex');
    expect(homework, 'the figure must be loadable').toMatch(/\\usepackage(\[[^\]]*\])?\{graphicx\}/);
    expect(homework, 'the probe looks for a painted canvas from this inclusion').toContain('\\includegraphics');
    expect(homework).toContain('figure.pdf');
  });
});
