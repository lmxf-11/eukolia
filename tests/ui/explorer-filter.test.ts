/**
 * The Explorer's file list.
 *
 * The tree is not decoration: it is the only way to browse to a file, so what it
 * lists decides what the project appears to contain. Two rules are pinned here —
 * a file-type filter driven by `files.explorerInclude`, and the rule that folders
 * survive the filter even when everything inside them is hidden.
 */

import { describe, expect, it } from 'vitest';
import { extensionOf, filterExplorerNodes, matchesExplorerTypes } from '../../src/renderer/ui/components/Sidebar';
import { SETTINGS_SCHEMA, defaultSettingsRecord } from '../../src/renderer/core/settings';
import type { FileNode } from '../../src/shared/ipc';

const node = (name: string, isDirectory = false, children?: FileNode[]): FileNode => ({
  name,
  path: `D:/proj/${name}`,
  isDirectory,
  size: 0,
  mtimeMs: 0,
  ...(children ? { children } : {})
});

/** The default file-type list, read from the schema rather than restated. */
const DEFAULT_INCLUDE = (() => {
  const value = defaultSettingsRecord()['files.explorerInclude'];
  if (!Array.isArray(value)) {
    throw new Error('files.explorerInclude must be an array setting with a default');
  }
  return value as string[];
})();

describe('the setting that drives the filter', () => {
  it('is a declared array setting in the Files category', () => {
    const descriptor = SETTINGS_SCHEMA.find((entry) => entry.key === 'files.explorerInclude');
    expect(descriptor, 'the Explorer filter must be configurable').toBeTruthy();
    expect(descriptor?.type).toBe('array');
    expect(descriptor?.category).toBe('Files');
    expect(descriptor?.description, 'the setting needs to explain what it does').toBeTruthy();
  });

  it('keeps the application\'s own workspace folder out of the tree by default', () => {
    // `.eukolia` is created only when a workspace setting is saved, and it holds
    // this application's file rather than the project's — so it is noise in the
    // tree. It is a removable default, not a hard exclusion, so a user who wants
    // to hand-edit the file can still browse to it.
    const exclude = defaultSettingsRecord()['files.exclude'];
    expect(Array.isArray(exclude) && exclude).toContain('.eukolia');
  });
});

describe('the setting that chooses what the sidebar toggle collapses', () => {
  it('is a declared boolean in the Appearance category, defaulting to hiding all', () => {
    const descriptor = SETTINGS_SCHEMA.find((entry) => entry.key === 'appearance.collapseActivityBarWithSidebar');
    expect(descriptor, 'the choice must be configurable').toBeTruthy();
    expect(descriptor?.type).toBe('boolean');
    expect(descriptor?.category).toBe('Appearance');
    // A default of `true` is what makes an untouched project collapse the whole
    // sidebar rather than leaving the strip behind.
    expect(descriptor?.default).toBe(true);
    expect(
      descriptor?.description,
      'both behaviours have to be named, or the label is ambiguous'
    ).toMatch(/activity bar/i);
    expect(descriptor?.description).toMatch(/sidebar/i);
  });

  it('is recorded with that default, so an unset value means "hide all"', () => {
    expect(defaultSettingsRecord()['appearance.collapseActivityBarWithSidebar']).toBe(true);
  });
});

describe('reading a file extension', () => {
  it('lower-cases the extension and drops the dot', () => {
    expect(extensionOf('main.tex')).toBe('tex');
    expect(extensionOf('Figure.PNG')).toBe('png');
    expect(extensionOf('paper.final.pdf')).toBe('pdf');
  });

  it('treats a leading dot as part of the name, not as a separator', () => {
    // `.gitignore` is a dotfile, not a file of type `gitignore`. Reading it the
    // other way would let a stray entry in the setting list match it.
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('.eukolia')).toBe('');
  });

  it('reports no extension for a name with no usable one', () => {
    expect(extensionOf('Makefile')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });
});

describe('matching a file against the configured types', () => {
  it('accepts the types the setting lists, with or without the dot', () => {
    expect(matchesExplorerTypes('main.tex', ['tex', 'pdf', 'md'])).toBe(true);
    // A user copying a glob-ish or dotted list should not silently match nothing.
    expect(matchesExplorerTypes('main.tex', ['.tex'])).toBe(true);
    expect(matchesExplorerTypes('main.tex', [' TEX '])).toBe(true);
  });

  it('rejects a type the setting does not list', () => {
    expect(matchesExplorerTypes('main.aux', ['tex', 'pdf', 'md'])).toBe(false);
    expect(matchesExplorerTypes('main.tex', ['pdf', 'md'])).toBe(false);
  });

  it('matches case-insensitively on both sides', () => {
    expect(matchesExplorerTypes('MAIN.TEX', ['tex'])).toBe(true);
    expect(matchesExplorerTypes('main.tex', ['TeX'])).toBe(true);
  });

  it('reads an empty list as no restriction rather than as show nothing', () => {
    // Clearing the setting is how a user asks for their files back; returning an
    // empty tree would look like the project had been deleted.
    expect(matchesExplorerTypes('main.aux', [])).toBe(true);
    expect(matchesExplorerTypes('anything.xyz', [])).toBe(true);
  });

  it('hides an extensionless file when a list is configured', () => {
    expect(matchesExplorerTypes('Makefile', ['tex', 'md'])).toBe(false);
  });
});

describe('filtering the project tree', () => {
  const include = ['tex', 'pdf', 'md'];

  it('keeps the listed types and drops the rest', () => {
    const tree = [node('main.tex'), node('notes.md'), node('main.aux'), node('main.log'), node('figure.png')];
    expect(filterExplorerNodes(tree, include).map((entry) => entry.name)).toEqual(['main.tex', 'notes.md']);
  });

  it('keeps a folder even when everything inside it is filtered away', () => {
    // Every row that remains is openable: a folder is a way in, not a claim that
    // something is there.
    const tree = [node('figures', true, [node('plot.png'), node('plot.eps')])];
    const filtered = filterExplorerNodes(tree, include);
    expect(filtered.map((entry) => entry.name)).toEqual(['figures']);
    expect(filtered[0].children).toEqual([]);
  });

  it('filters at every depth, not only the top level', () => {
    const tree = [
      node('chapters', true, [
        node('one.tex'),
        node('one.aux'),
        node('images', true, [node('a.png'), node('b.pdf')])
      ])
    ];
    const filtered = filterExplorerNodes(tree, include);
    expect(filtered[0].children?.map((entry) => entry.name)).toEqual(['one.tex', 'images']);
    expect(filtered[0].children?.[1].children?.map((entry) => entry.name)).toEqual(['b.pdf']);
  });

  it('keeps a file the caller marks as always visible, whatever its type', () => {
    // The file open in the editor and the PDF in the viewer stay listed, because
    // the Explorer is where both are marked as active — a view that highlights a
    // row which is not rendered cannot show you where you are.
    const tree = [node('main.tex'), node('refs.bib'), node('main.aux')];
    const filtered = filterExplorerNodes(tree, include, new Set(['D:/proj/refs.bib']));
    // `refs.bib` survives despite its type; `main.aux` is still hidden, so the
    // escape hatch is per file and not a switch that disables the filter.
    expect(filtered.map((entry) => entry.name)).toEqual(['main.tex', 'refs.bib']);
  });

  it('does not mutate the tree it was given', () => {
    // `fileTree` in app state is also the project index's file list, which root
    // detection and `\input` resolution walk — filtering it in place would hide
    // files from the parser, not just from the view.
    const tree = [node('chapters', true, [node('one.tex'), node('one.aux')])];
    const before = JSON.stringify(tree);
    filterExplorerNodes(tree, include);
    expect(JSON.stringify(tree)).toBe(before);
  });

  it('shows the whole tree when the setting is empty', () => {
    const tree = [node('main.tex'), node('main.aux'), node('Makefile')];
    expect(filterExplorerNodes(tree, [])).toHaveLength(3);
  });
});

describe('the default file types', () => {
  it('includes the three the Explorer is specified to show', () => {
    expect(DEFAULT_INCLUDE).toEqual(expect.arrayContaining(['tex', 'pdf', 'md']));
  });

  it('includes the LaTeX support files and images a project is made of', () => {
    for (const extension of ['bib', 'cls', 'sty', 'png', 'jpg', 'jpeg']) {
      expect(DEFAULT_INCLUDE, `${extension} should be listed by default`).toContain(extension);
    }
  });

  it('includes the source languages a mixed project carries', () => {
    for (const extension of ['py', 'java', 'cpp']) {
      expect(DEFAULT_INCLUDE, `${extension} should be listed by default`).toContain(extension);
    }
  });

  it('leaves build artefacts out, so the tree is not noise after a build', () => {
    // These appear next to the document the moment it is compiled. A default that
    // showed them would bury the sources under generated files.
    for (const extension of ['aux', 'log', 'out', 'fls', 'fdb_latexmk', 'synctex', 'toc', 'bbl']) {
      expect(DEFAULT_INCLUDE, `${extension} should not be listed by default`).not.toContain(extension);
    }
  });

  it('stores plain extensions, without leading dots', () => {
    for (const entry of DEFAULT_INCLUDE) {
      expect(entry, `${entry} should be a bare extension`).toBe(entry.replace(/^\./, '').toLowerCase());
    }
  });
});
