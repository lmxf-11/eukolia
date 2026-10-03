/**
 * LaTeX navigation tests.
 *
 * Go to definition, Find All References and the clickable document links used to
 * be Monaco language providers, and their rules are subtle enough to be worth
 * pinning down: which argument kinds resolve and to what, where the two file
 * extension lists differ, and exactly which characters a link's range covers.
 *
 * The resolvers are pure functions over the document text and the project index,
 * so they are tested directly. The extension itself is instantiated into an
 * `EditorState` and its commands are run against the state alone, which is the
 * strongest check available without a DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';
import {
  fileExtensionsFor,
  findReferences,
  latexNavigation,
  linkAtOffset,
  resolveDefinition,
  resolveDocumentLinks,
  scanDocumentLinks,
  type LatexNavigationHost
} from '../../src/renderer/editor/cmNavigation';
import { DocumentModel } from '../../src/renderer/document/documentModel';
import { projectIndex } from '../../src/renderer/document/projectIndex';
import { latexDocumentAnalyzer } from '../../src/renderer/parser/latexAnalyzer';

const at = (text: string, marker = '|') => {
  const offset = text.indexOf(marker);
  if (offset === -1) throw new Error('marker not found');
  return { text: text.replace(marker, ''), offset };
};

const ROOT = 'C:/proj';

const FILES = [
  { path: 'C:/proj/main.tex', name: 'main.tex', isDirectory: false },
  { path: 'C:/proj/chapters/intro.tex', name: 'intro.tex', isDirectory: false },
  { path: 'C:/proj/preamble.sty', name: 'preamble.sty', isDirectory: false },
  { path: 'C:/proj/refs.bib', name: 'refs.bib', isDirectory: false },
  // The same stem twice: the extension split is only observable when a project
  // holds both a picture and a source file under one name.
  { path: 'C:/proj/figures/plot.png', name: 'plot.png', isDirectory: false },
  { path: 'C:/proj/figures/plot.tex', name: 'plot.tex', isDirectory: false }
];

/** Registers a document with the project index, as the workspace would. */
function register(uri: string, text: string): DocumentModel {
  const document = new DocumentModel(uri, uri.split('/').pop() ?? uri, text);
  document.setAnalyzer(latexDocumentAnalyzer);
  projectIndex.registerDocument(document);
  return document;
}

beforeEach(() => {
  projectIndex.setProjectRoot(ROOT);
  projectIndex.setFiles(FILES);
});

afterEach(() => {
  for (const document of projectIndex.getAllDocuments()) {
    projectIndex.unregisterDocument(document.uri);
  }
  // Also drops the file list, so nothing leaks into the next case.
  projectIndex.setProjectRoot(null);
});

describe('fileExtensionsFor', () => {
  it('gives \\includegraphics the picture extensions', () => {
    expect(fileExtensionsFor('includegraphics')).toEqual(['pdf', 'png', 'jpg', 'jpeg', 'eps', 'svg']);
  });

  it('gives every other file command the source extensions', () => {
    for (const command of ['input', 'include', 'subfile', 'bibliography', 'addbibresource']) {
      expect(fileExtensionsFor(command)).toEqual(['tex', 'ltx', 'sty', 'bib']);
    }
  });
});

describe('resolveDefinition', () => {
  it('jumps from a \\ref to the label it names', () => {
    register('C:/proj/main.tex', '\\section{Intro}\n\\label{sec:intro}\n');
    const { text, offset } = at('see \\ref{sec:int|ro} for details');

    expect(resolveDefinition(text, offset)).toEqual({ file: 'C:/proj/main.tex', line: 2, column: 1 });
  });

  it('resolves the other reference commands the same way', () => {
    register('C:/proj/main.tex', '\\label{sec:intro}');
    for (const command of ['ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'vref']) {
      const { text, offset } = at(`\\${command}{sec:int|ro}`);
      expect(resolveDefinition(text, offset)?.file).toBe('C:/proj/main.tex');
    }
  });

  it('resolves a \\label to its own occurrence', () => {
    register('C:/proj/main.tex', 'x\n\\label{sec:intro}');
    const { text, offset } = at('\\label{sec:int|ro}');

    expect(resolveDefinition(text, offset)).toEqual({ file: 'C:/proj/main.tex', line: 2, column: 1 });
  });

  it('finds nothing for a label the project does not define', () => {
    const { text, offset } = at('\\ref{nowhe|re}');
    expect(resolveDefinition(text, offset)).toBeNull();
  });

  it('opens the file an \\input names, at its top', () => {
    const { text, offset } = at('\\input{chapters/int|ro}');
    expect(resolveDefinition(text, offset)).toEqual({ file: 'C:/proj/chapters/intro.tex', line: 1, column: 1 });
  });

  it('takes the picture for \\includegraphics and the source file for \\input', () => {
    const graphics = at('\\includegraphics{figures/pl|ot}');
    expect(resolveDefinition(graphics.text, graphics.offset)?.file).toBe('C:/proj/figures/plot.png');

    const source = at('\\input{figures/pl|ot}');
    expect(resolveDefinition(source.text, source.offset)?.file).toBe('C:/proj/figures/plot.tex');
  });

  it('skips an optional argument on the way to the path', () => {
    const { text, offset } = at('\\includegraphics[width=2cm]{figures/pl|ot}');
    expect(resolveDefinition(text, offset)?.file).toBe('C:/proj/figures/plot.png');
  });

  it('jumps from a macro name to its definition', () => {
    register('C:/proj/preamble.sty', '\\newcommand{\\R}{\\mathbb{R}}');
    const { text, offset } = at('\\newcommand{\\R|}{}');

    expect(resolveDefinition(text, offset)).toEqual({ file: 'C:/proj/preamble.sty', line: 1, column: 1 });
  });

  it('finds nothing for a macro the project does not define', () => {
    const { text, offset } = at('\\newcommand{\\nope|}');
    expect(resolveDefinition(text, offset)).toBeNull();
  });

  it('finds nothing for a command that names no symbol', () => {
    const { text, offset } = at('\\textbf{wo|rd}');
    expect(resolveDefinition(text, offset)).toBeNull();
  });

  it('finds nothing outside an argument, however stale the offset', () => {
    expect(resolveDefinition('plain text', 5)).toBeNull();
    expect(resolveDefinition('\\ref{sec:intro}', 999)).toBeNull();
    expect(resolveDefinition('\\ref{sec:intro}', Number.NaN)).toBeNull();
  });

  it('finds nothing in an unclosed argument', () => {
    expect(resolveDefinition('\\ref{sec:intro', 13)).toBeNull();
  });
});

describe('findReferences', () => {
  /** Two documents that both define the label, and each refer to it. */
  const registerProject = (): void => {
    register('C:/proj/main.tex', '\\label{sec:intro}\n\nSee \\ref{sec:intro} and \\eqref{sec:intro}.\n');
    register('C:/proj/chapters/intro.tex', 'text\n\\label{sec:intro}\nmore\n\\pageref{sec:intro}\n');
  };

  it('lists the definition and every reference, de-duplicated, in project order', () => {
    registerProject();
    const { text, offset } = at('\\label{sec:int|ro}');

    expect(findReferences(text, offset)).toEqual({
      label: 'sec:intro',
      occurrences: [
        { file: 'C:/proj/main.tex', line: 1 },
        { file: 'C:/proj/chapters/intro.tex', line: 2 },
        { file: 'C:/proj/main.tex', line: 3 },
        { file: 'C:/proj/chapters/intro.tex', line: 4 }
      ]
    });
  });

  it('answers only for a \\label argument, as the provider did', () => {
    registerProject();
    const { text, offset } = at('\\ref{sec:int|ro}');
    expect(findReferences(text, offset)).toBeNull();
  });

  it('escapes the label name before scanning for it', () => {
    register('C:/proj/main.tex', '\\ref{fig:1.2}\n\\ref{fig:1x2}\n\\ref{a+b}\n\\ref{ab}\n');

    // An unescaped `.` would also match the `fig:1x2` decoy on the next line.
    const dotted = at('\\label{fig:1|.2}');
    expect(findReferences(dotted.text, dotted.offset)?.occurrences).toEqual([
      { file: 'C:/proj/main.tex', line: 1 }
    ]);

    // An unescaped `+` would quantify the `a` and match `\ref{ab}` instead.
    const plussed = at('\\label{a|+b}');
    expect(findReferences(plussed.text, plussed.offset)?.occurrences).toEqual([
      { file: 'C:/proj/main.tex', line: 3 }
    ]);
  });

  it('reports a label nothing refers to as an empty list', () => {
    const { text, offset } = at('\\label{lonel|y}');
    expect(findReferences(text, offset)).toEqual({ label: 'lonely', occurrences: [] });
  });

  it('finds nothing outside an argument', () => {
    expect(findReferences('plain text', 5)).toBeNull();
  });
});

describe('scanDocumentLinks', () => {
  it('covers the path inside the braces, not the whole command', () => {
    const text = '\\input{chapters/intro}\n';
    const [link] = scanDocumentLinks(text);

    expect(link.kind).toBe('file');
    expect(link.command).toBe('input');
    expect(link.text).toBe('chapters/intro');
    expect(link.from).toBe('\\input{'.length);
    expect(link.to).toBe('\\input{chapters/intro'.length);
    expect(text.slice(link.from, link.to)).toBe('chapters/intro');
  });

  it('covers the path but not an optional argument before it', () => {
    const text = '\\includegraphics[width=2cm]{figures/plot}';
    const [link] = scanDocumentLinks(text);

    expect(link.command).toBe('includegraphics');
    expect(text.slice(link.from, link.to)).toBe('figures/plot');
  });

  it('finds file links and URLs, each over its own text', () => {
    const text = '\\input{a}\n\\bibliography{refs}\nSee https://example.com/x?y=1 for details.';
    const links = scanDocumentLinks(text);

    expect(links.map((link) => [link.kind, link.text, text.slice(link.from, link.to)])).toEqual([
      ['file', 'a', 'a'],
      ['file', 'refs', 'refs'],
      ['url', 'https://example.com/x?y=1', 'https://example.com/x?y=1']
    ]);
  });

  it('stops a URL at a brace, so only the URL is linked', () => {
    const text = '\\url{https://example.com/a}';
    const links = scanDocumentLinks(text);

    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('https://example.com/a');
    expect(text.slice(links[0].from, links[0].to)).toBe('https://example.com/a');
  });

  it('ignores an empty argument and a command that names no file', () => {
    expect(scanDocumentLinks('\\input{}')).toEqual([]);
    expect(scanDocumentLinks('\\input{   }')).toEqual([]);
    expect(scanDocumentLinks('\\foo{bar}')).toEqual([]);
  });

  it('does not throw on a malformed document', () => {
    expect(scanDocumentLinks('\\input{unclosed')).toEqual([]);
    expect(scanDocumentLinks('}}{{')).toEqual([]);
  });
});

describe('resolveDocumentLinks', () => {
  it('resolves a source path through the project index', () => {
    const text = '\\input{chapters/intro}';
    const [link] = resolveDocumentLinks(scanDocumentLinks(text), text.length);

    expect(link.path).toBe('C:/proj/chapters/intro.tex');
    expect(link.tooltip).toBe('chapters/intro.tex');
    expect(link.clickable).toBe(true);
    expect(link.url).toBeNull();
  });

  it('keeps an unresolvable path, but never as a link', () => {
    const text = '\\input{missing/chapter}';
    const [link] = resolveDocumentLinks(scanDocumentLinks(text), text.length);

    expect(link.path).toBeNull();
    expect(link.url).toBeNull();
    expect(link.clickable).toBe(false);
    expect(link.tooltip).toBe('File not found: missing/chapter');
  });

  it('resolves \\includegraphics and \\input with their own extension lists', () => {
    const text = '\\includegraphics{figures/plot}\n\\input{figures/plot}';
    const [graphics, source] = resolveDocumentLinks(scanDocumentLinks(text), text.length);

    expect(graphics.path).toBe('C:/proj/figures/plot.png');
    expect(source.path).toBe('C:/proj/figures/plot.tex');
  });

  it('takes a URL as its own target', () => {
    const text = 'see https://example.com/a';
    const [link] = resolveDocumentLinks(scanDocumentLinks(text), text.length);

    expect(link.url).toBe('https://example.com/a');
    expect(link.tooltip).toBe('https://example.com/a');
    expect(link.clickable).toBe(true);
    expect(link.path).toBeNull();
  });

  it('clamps a range to the document instead of throwing', () => {
    const links = scanDocumentLinks('\\input{chapters/intro}');

    // A document shorter than the range it was scanned from.
    const [clamped] = resolveDocumentLinks(links, 8);
    expect({ from: clamped.from, to: clamped.to }).toEqual({ from: 7, to: 8 });

    // A range entirely past the end collapses rather than inverting.
    const [collapsed] = resolveDocumentLinks(links, 0);
    expect({ from: collapsed.from, to: collapsed.to }).toEqual({ from: 0, to: 0 });

    const stale = resolveDocumentLinks(
      [{ from: Number.NaN, to: Number.NaN, kind: 'url', text: 'https://x.test', command: '' }],
      10
    );
    expect({ from: stale[0].from, to: stale[0].to }).toEqual({ from: 0, to: 0 });
  });
});

describe('linkAtOffset', () => {
  const text = '\\input{chapters/intro}\n\\input{missing/file}';
  const links = resolveDocumentLinks(scanDocumentLinks(text), text.length);

  it('answers for the characters the link covers, and for no others', () => {
    expect(links).toHaveLength(2);
    const [source] = links;

    expect(linkAtOffset(links, source.from - 1)).toBeNull();
    expect(linkAtOffset(links, source.from)?.text).toBe('chapters/intro');
    expect(linkAtOffset(links, source.to - 1)?.text).toBe('chapters/intro');
    // Half-open: the closing brace belongs to the command, not to the link.
    expect(linkAtOffset(links, source.to)).toBeNull();
  });

  it('answers for an unresolvable path too, which the click then refuses', () => {
    const missing = links[1];
    expect(linkAtOffset(links, missing.from)?.clickable).toBe(false);
  });
});

describe('latexNavigation', () => {
  const createHost = (): LatexNavigationHost => ({ openFile: vi.fn(), showReferences: vi.fn() });

  /** The command bound to `key`, so it can be run without a DOM. */
  const commandFor = (state: EditorState, key: string) => {
    const binding = state.facet(keymap).flat().find((entry) => entry.key === key);
    if (!binding?.run) throw new Error(`no command bound to ${key}`);
    return binding.run;
  };

  /** The only part of a view the commands read. */
  const viewOf = (state: EditorState): EditorView => ({ state }) as unknown as EditorView;

  const stateFor = (host: LatexNavigationHost, text: string, anchor: number): EditorState =>
    EditorState.create({ doc: text, selection: { anchor }, extensions: [latexNavigation(host)] });

  it('binds F12 to go to definition and Shift+F12 to find all references', () => {
    const extensions: Extension = latexNavigation(createHost());
    const state = EditorState.create({ doc: '\\ref{sec:intro}', extensions: [extensions] });

    expect(state.facet(keymap).flat().map((binding) => binding.key)).toEqual(['F12', 'Shift-F12']);
  });

  it('opens the definition the caret is on when F12 runs', () => {
    register('C:/proj/main.tex', 'text\n\\label{sec:intro}');
    const host = createHost();
    const { text, offset } = at('see \\ref{sec:int|ro}');
    const state = stateFor(host, text, offset);

    expect(commandFor(state, 'F12')(viewOf(state))).toBe(true);
    expect(host.openFile).toHaveBeenCalledWith('C:/proj/main.tex', 2, 1);
  });

  it('reports every reference when Shift+F12 runs', () => {
    register('C:/proj/main.tex', '\\label{sec:intro}\n\nref \\ref{sec:intro}');
    const host = createHost();
    const { text, offset } = at('\\label{sec:int|ro}');
    const state = stateFor(host, text, offset);

    expect(commandFor(state, 'Shift-F12')(viewOf(state))).toBe(true);
    expect(host.showReferences).toHaveBeenCalledWith('sec:intro', [
      { file: 'C:/proj/main.tex', line: 1 },
      { file: 'C:/proj/main.tex', line: 3 }
    ]);
  });

  it('leaves the keys alone when there is nothing to navigate to', () => {
    const host = createHost();
    const state = stateFor(host, 'plain text', 3);

    expect(commandFor(state, 'F12')(viewOf(state))).toBe(false);
    expect(commandFor(state, 'Shift-F12')(viewOf(state))).toBe(false);
    expect(host.openFile).not.toHaveBeenCalled();
    expect(host.showReferences).not.toHaveBeenCalled();
  });
});
