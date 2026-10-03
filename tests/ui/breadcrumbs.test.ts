/**
 * Breadcrumb derivation.
 *
 * The strip is only useful if it is *right*: a path that keeps a leading
 * separator, or a symbol chain that names a section the caret has already left,
 * sends the reader to the wrong place. Both halves are pure functions so they can
 * be pinned down here rather than through a rendered component.
 */

import { describe, expect, it } from 'vitest';
import { buildCrumbs, outlinePathAt, pathCrumbs } from '@/ui/components/Breadcrumbs';
import type { OutlineItem } from '@/document/analysisTypes';

/** An outline item, with only the fields the derivation reads. */
const item = (command: string, title: string, offset: number, line: number, children: OutlineItem[] = []): OutlineItem =>
  ({ command, title, offset, line, labels: [], children, level: 0, starred: false }) as OutlineItem;

/**
 * A document shaped like a real paper:
 *
 *   \section{Intro}            offset 0
 *     \subsection{Background}  offset 40
 *     \subsection{Related}     offset 200
 *   \section{Method}           offset 400
 *     \subsection{Model}       offset 440
 */
const OUTLINE: OutlineItem[] = [
  item('section', 'Intro', 0, 1, [
    item('subsection', 'Background', 40, 5),
    item('subsection', 'Related', 200, 20)
  ]),
  item('section', 'Method', 400, 40, [item('subsection', 'Model', 440, 44)])
];

describe('breadcrumb paths', () => {
  it('is relative to the project root', () => {
    expect(pathCrumbs('D:/paper/sections/intro.tex', 'D:/paper')).toEqual([
      'sections',
      'intro.tex'
    ]);
  });

  it('handles Windows separators', () => {
    // The document URI uses backslashes; the project root may use either.
    expect(pathCrumbs('D:\\paper\\main.tex', 'D:/paper')).toEqual(['main.tex']);
    expect(pathCrumbs('D:\\paper\\a\\b.tex', 'D:\\paper')).toEqual(['a', 'b.tex']);
  });

  it('ignores a trailing separator on the root', () => {
    expect(pathCrumbs('D:/paper/main.tex', 'D:/paper/')).toEqual(['main.tex']);
  });

  it('keeps an absolute path absolute when the file is outside the project', () => {
    // Truncating to a project-relative-looking path would be a lie about where
    // the file is.
    const crumbs = pathCrumbs('D:/elsewhere/other.tex', 'D:/paper');
    expect(crumbs).toEqual(['D:', 'elsewhere', 'other.tex']);
    expect(crumbs.join('/')).toContain('elsewhere');
  });

  it('does not treat a sibling directory as inside the project', () => {
    // `D:/papers/x.tex` must not be read as inside `D:/paper`.
    expect(pathCrumbs('D:/papers/x.tex', 'D:/paper')).toEqual(['D:', 'papers', 'x.tex']);
  });

  it('is empty without a document', () => {
    expect(pathCrumbs(null, 'D:/paper')).toEqual([]);
  });

  it('handles a file at the project root', () => {
    expect(pathCrumbs('D:/paper/main.tex', 'D:/paper')).toEqual(['main.tex']);
  });
});

describe('breadcrumb symbol chain', () => {
  it('names the section the caret is inside', () => {
    const chain = outlinePathAt(OUTLINE, 10);
    expect(chain.map((node) => node.title)).toEqual(['Intro']);
  });

  it('names the nested subsection as well', () => {
    const chain = outlinePathAt(OUTLINE, 60);
    expect(chain.map((node) => node.title)).toEqual(['Intro', 'Background']);
  });

  it('leaves a section the caret has moved past', () => {
    // Offset 250 is after `Background` (40) and after `Related` (200), so the
    // deepest enclosing item is `Related`, not `Background`.
    expect(outlinePathAt(OUTLINE, 250).map((node) => node.title)).toEqual(['Intro', 'Related']);
  });

  it('switches to the next top-level section', () => {
    expect(outlinePathAt(OUTLINE, 410).map((node) => node.title)).toEqual(['Method']);
    expect(outlinePathAt(OUTLINE, 500).map((node) => node.title)).toEqual(['Method', 'Model']);
  });

  it('is empty before the first section', () => {
    // A caret in the preamble must not claim to be in the first section.
    const later = [item('section', 'Intro', 100, 9)];
    expect(outlinePathAt(later, 10)).toEqual([]);
  });

  it('is empty for an empty outline', () => {
    expect(outlinePathAt([], 42)).toEqual([]);
  });

  it('always returns ancestors in document order', () => {
    const chain = outlinePathAt(OUTLINE, 500);
    for (let index = 1; index < chain.length; index += 1) {
      expect(chain[index].offset).toBeGreaterThanOrEqual(chain[index - 1].offset);
    }
  });
});

describe('buildCrumbs', () => {
  const crumbsAt = (offset: number) =>
    buildCrumbs({
      filePath: 'D:/paper/sections/intro.tex',
      projectRoot: 'D:/paper',
      outline: OUTLINE,
      offset
    });

  it('puts the path first and the symbol chain after it', () => {
    expect(crumbsAt(60).map((crumb) => crumb.label)).toEqual([
      'sections',
      'intro.tex',
      'Intro',
      'Background'
    ]);
  });

  it('makes only the symbol crumbs clickable', () => {
    const crumbs = crumbsAt(60);
    // Path segments have no action in Eukolia, so they carry no offset and the
    // component renders them as labels rather than dead buttons.
    expect(crumbs.filter((crumb) => crumb.offset === undefined).map((crumb) => crumb.label)).toEqual([
      'sections',
      'intro.tex'
    ]);
    expect(crumbs.filter((crumb) => crumb.offset !== undefined).map((crumb) => crumb.label)).toEqual([
      'Intro',
      'Background'
    ]);
  });

  it('carries the source offset a symbol crumb should reveal', () => {
    const background = crumbsAt(60).find((crumb) => crumb.label === 'Background');
    expect(background?.offset).toBe(40);
  });

  it('gives every crumb a tooltip', () => {
    for (const crumb of crumbsAt(60)) {
      expect(crumb.title.length, `${crumb.label} has no title`).toBeGreaterThan(0);
    }
  });

  it('still shows the path when there is no enclosing section', () => {
    const crumbs = buildCrumbs({
      filePath: 'D:/paper/main.tex',
      projectRoot: 'D:/paper',
      outline: [item('section', 'Intro', 100, 9)],
      offset: 5
    });
    expect(crumbs.map((crumb) => crumb.label)).toEqual(['main.tex']);
  });

  it('is empty without a document', () => {
    expect(
      buildCrumbs({ filePath: null, projectRoot: 'D:/paper', outline: OUTLINE, offset: 0 })
    ).toEqual([]);
  });
});
