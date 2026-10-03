/**
 * The `latex.completion.*` gates for the ported LaTeX Workshop providers.
 *
 * `latexWorkshopCompletion.ts` maps a provider's `CompletionItemKind` onto
 * Eukolia's completion kinds, and `cmCompletion.ts` turns each kind into a
 * setting gate and an icon. The mapping used to read the item's `detail` text
 * instead, and a reference's `detail` is the enclosing *section title* — so every
 * `\ref` / `\label` suggestion was typed as a macro: `latex.completion.references`
 * did not gate it, `latex.completion.commands` did, and it was drawn with the
 * function icon.
 *
 * These tests go through the real source, the real registry and the real ported
 * providers, so they assert what an editor would offer rather than what an
 * internal function returns, and they pin the gate from both sides: the setting
 * that must remove an entry, and the setting that must not.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';

import { latexCompletionSource } from '../../src/renderer/editor/cmCompletion';
import { settingsManager } from '../../src/renderer/core/settings';
import { DocumentModel } from '../../src/renderer/document/documentModel';
import { projectIndex, type BibEntry } from '../../src/renderer/document/projectIndex';
import { latexDocumentAnalyzer } from '../../src/renderer/parser/latexAnalyzer';

const FIXTURE_URI = 'C:/eukolia-completion-gates/main.tex';
const BIB_SOURCE = 'C:/eukolia-completion-gates/refs.bib';

const FIXTURE = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Group structure}\\label{sec:groups}',
  'See \\ref{sec:groups} and \\cite{knuth1984}.',
  '\\end{document}',
  ''
].join('\n');

const BIB_ENTRIES: BibEntry[] = [
  {
    key: 'knuth1984',
    type: 'article',
    fields: {},
    title: 'Literate Programming',
    authors: ['Donald E. Knuth'],
    year: '1984',
    journal: 'The Computer Journal',
    source: BIB_SOURCE,
    line: 1
  }
];

beforeAll(() => {
  const document = new DocumentModel(FIXTURE_URI, 'main.tex', FIXTURE);
  document.setAnalyzer(latexDocumentAnalyzer);
  projectIndex.registerDocument(document);
  projectIndex.registerBibEntries(BIB_SOURCE, BIB_ENTRIES);
});

afterEach(() => {
  // Settings are global; a test that changes one must not leak into the next.
  settingsManager.reset('latex', 'user');
});

afterAll(() => {
  projectIndex.unregisterDocument(FIXTURE_URI);
  projectIndex.removeBibSource(BIB_SOURCE);
});

/** Runs the completion source with the caret marked by `|`. */
async function complete(textWithCaret: string): Promise<CompletionResult | null> {
  const offset = textWithCaret.indexOf('|');
  if (offset === -1) throw new Error('the text needs a | marker');
  const doc = textWithCaret.replace('|', '');
  return latexCompletionSource(new CompletionContext(EditorState.create({ doc }), offset, true));
}

/** The labels a result offers. */
function labels(result: CompletionResult | null): string[] {
  return (result?.options ?? []).map((option) => option.label);
}

/** The offered option with a label, or undefined. */
function optionFor(result: CompletionResult | null, label: string) {
  return (result?.options ?? []).find((option) => option.label === label);
}

describe('the reference and label gate', () => {
  it('offers labels in a \\ref argument by default', async () => {
    const result = await complete('See \\ref{|} for the definition.');
    expect(labels(result)).toContain('sec:groups');
  });

  it('removes them when latex.completion.references is off', async () => {
    settingsManager.setValue('latex.completion.references', false, 'user');
    const result = await complete('See \\ref{|} for the definition.');
    expect(labels(result)).not.toContain('sec:groups');
  });

  it('keeps them when latex.completion.commands is off', async () => {
    // The regression this file exists for: while a reference was mapped to
    // `macro`, this setting — not `references` — is what removed it.
    settingsManager.setValue('latex.completion.commands', false, 'user');
    const result = await complete('See \\ref{|} for the definition.');

    expect(labels(result)).toContain('sec:groups');
    const offered = optionFor(result, 'sec:groups');
    // The reference icon, not the macro one.
    expect(offered?.type).toBe('variable');
  });
});

describe('the citation gate', () => {
  it('offers citations in a \\cite argument by default', async () => {
    const result = await complete('See \\cite{|} for the proof.');
    expect(labels(result)).toContain('knuth1984');
  });

  it('removes them when latex.completion.citations is off', async () => {
    settingsManager.setValue('latex.completion.citations', false, 'user');
    const result = await complete('See \\cite{|} for the proof.');
    expect(labels(result)).not.toContain('knuth1984');
  });

  it('keeps them when latex.completion.references is off', async () => {
    // A citation is not a reference: the two share VS Code's `Reference` kind,
    // and this is the assertion that they are still told apart.
    settingsManager.setValue('latex.completion.references', false, 'user');
    const result = await complete('See \\cite{|} for the proof.');
    expect(labels(result)).toContain('knuth1984');
  });
});

describe('the package gate', () => {
  it('removes package names when latex.completion.packages is off', async () => {
    const offered = labels(await complete('\\usepackage{|}'));
    expect(offered.length).toBeGreaterThan(0);

    settingsManager.setValue('latex.completion.packages', false, 'user');
    const gated = labels(await complete('\\usepackage{|}'));
    expect(gated.length).toBe(0);
  });
});
