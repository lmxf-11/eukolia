/**
 * LaTeX analyzer tests.
 *
 * `LatexDocumentAnalyzer` feeds the outline, the project index, the macro table
 * Visual Mode renders with, and every completion source. These tests assert the
 * analysis of a document that exercises all of those, so a regression in the
 * ported structure builder shows up here rather than as missing UI.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { latexDocumentAnalyzer } from '../../src/renderer/parser/latexAnalyzer';

const FIXTURE = path.resolve(__dirname, '..', 'smoke', 'fixture', 'main.tex');
const uri = 'C:/fixture/main.tex';

function analyze(text: string) {
  return latexDocumentAnalyzer.analyze(text, uri);
}

describe('LatexDocumentAnalyzer', () => {
  const text = readFileSync(FIXTURE, 'utf8');
  const analysis = analyze(text);

  it('reports every environment name as a string', () => {
    expect(analysis.environments.length).toBeGreaterThan(0);
    for (const environment of analysis.environments) {
      expect(typeof environment.name, `environment name ${JSON.stringify(environment.name)}`).toBe('string');
      expect(environment.name.length).toBeGreaterThan(0);
    }
  });

  it('reports every label, citation, macro and section title as a string', () => {
    for (const label of analysis.labels) expect(typeof label.name).toBe('string');
    for (const citation of analysis.citations) expect(typeof citation.command).toBe('string');
    for (const macro of analysis.macroDefinitions) {
      expect(typeof macro.name).toBe('string');
      expect(typeof macro.definition).toBe('string');
    }
    for (const section of analysis.sectioning) expect(typeof section.title).toBe('string');
  });

  it('finds the document environments', () => {
    const names = analysis.environments.map((environment) => environment.name);
    expect(names).toContain('document');
    expect(names).toContain('align');
    expect(names).toContain('itemize');
    expect(names).toContain('equation');
  });

  it('finds the labels', () => {
    const names = analysis.labels.map((label) => label.name).sort();
    expect(names).toContain('sec:groups');
    expect(names).toContain('sec:alignment');
    expect(names).toContain('sec:references');
    expect(names).toContain('eq:pythagoras');
  });

  it('finds the macro definitions with their argument counts', () => {
    const macros = new Map(analysis.macroDefinitions.map((macro) => [macro.name.replace(/^\\/, ''), macro]));
    expect(macros.get('R')?.args).toBe(0);
    expect(macros.get('Z')?.args).toBe(0);
    expect(macros.get('R')?.definition).toContain('mathbb');
  });

  it('builds a nested outline with section titles', () => {
    const titles = JSON.stringify(analysis.outline);
    expect(titles).toContain('Groups');
    expect(titles).toContain('Alignment');
    expect(titles).toContain('References');

    // `Alignment` is a `\subsection` of `Groups`, so it must nest beneath it.
    const groups = analysis.outline.find((item) => item.title === 'Groups');
    expect(groups, 'the Groups section must be in the outline').toBeTruthy();
    expect(JSON.stringify(groups?.children ?? [])).toContain('Alignment');
  });

  it('returns sectioning entries with usable offsets', () => {
    for (const section of analysis.sectioning) {
      expect(section.offset).toBeGreaterThanOrEqual(0);
      expect(section.offset).toBeLessThanOrEqual(text.length);
      expect(text.slice(section.offset, section.offset + 8)).toContain('\\');
    }
  });

  it('is idempotent and does not mutate its input', () => {
    const again = analyze(text);
    expect(again.environments.length).toBe(analysis.environments.length);
    expect(text).toBe(readFileSync(FIXTURE, 'utf8'));
  });

  it('survives malformed input rather than throwing', () => {
    for (const broken of ['\\begin{align}', '\\section{', '\\newcommand{\\x}', '{{{}}}', '% only a comment']) {
      expect(() => analyze(broken), `analyzing ${JSON.stringify(broken)}`).not.toThrow();
    }
  });

  it('reports an empty analysis for an empty document', () => {
    const empty = analyze('');
    expect(empty.outline).toEqual([]);
    expect(empty.labels).toEqual([]);
    expect(empty.macroDefinitions).toEqual([]);
  });
});
