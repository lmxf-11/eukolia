/**
 * Which files a project search reads.
 *
 * The include filter is the one part of the search scope a user can get caught
 * out by, and it was broken in a way that made the *whole feature* look dead:
 * a bare `*` — the broadest possible request — matched nothing, because the
 * matcher treated a glob as a string suffix. Asking to search everything
 * searched nothing.
 *
 * These tests pin the filter against absolute paths, which is what the search
 * actually walks.
 */

import { describe, expect, it } from 'vitest';
import { matchesSearchFilter, splitPatterns } from '../../src/main/ipc/searchFilter';

const ROOT = 'D:/proj';
const main = `${ROOT}/main.tex`;
const readme = `${ROOT}/README.md`;
const bib = `${ROOT}/refs.bib`;
const nested = `${ROOT}/chapters/intro.tex`;
const deep = `${ROOT}/a/b/c/deep.tex`;
const script = `${ROOT}/build.py`;

describe('splitting the filter syntax', () => {
  it('splits on commas and trims', () => {
    expect(splitPatterns('*.tex, *.md ,*.bib')).toEqual(['*.tex', '*.md', '*.bib']);
  });

  it('drops empty entries, so a trailing comma is harmless', () => {
    expect(splitPatterns('*.tex,')).toEqual(['*.tex']);
    expect(splitPatterns('   ')).toEqual([]);
    expect(splitPatterns('')).toEqual([]);
    expect(splitPatterns(undefined)).toEqual([]);
  });
});

describe('an empty filter searches everything', () => {
  it('admits every file when no include is given', () => {
    // Clearing the box is how a user asks for "all files". Reading an empty
    // filter as "match nothing" would make that look like a broken search.
    for (const file of [main, readme, bib, nested, deep, script]) {
      expect(matchesSearchFilter(file, undefined, undefined), file).toBe(true);
      expect(matchesSearchFilter(file, '', undefined), file).toBe(true);
      expect(matchesSearchFilter(file, '   ', undefined), file).toBe(true);
    }
  });
});

describe('a bare star means everything', () => {
  it('admits every file', () => {
    // The regression this file exists for: `*` used to take the `*.` branch,
    // strip the star, and ask whether the path ended in `.` — so it matched
    // nothing at all.
    for (const file of [main, readme, bib, nested, deep, script]) {
      expect(matchesSearchFilter(file, '*', undefined), file).toBe(true);
    }
  });

  it('admits files regardless of how deep they are', () => {
    expect(matchesSearchFilter(deep, '*', undefined)).toBe(true);
  });
});

describe('extension globs', () => {
  it('matches the extension at any depth', () => {
    // A user writing `*.tex` means "the LaTeX files", not "the LaTeX files in
    // the project root" — the relative form is matched at any depth.
    expect(matchesSearchFilter(main, '*.tex', undefined)).toBe(true);
    expect(matchesSearchFilter(nested, '*.tex', undefined)).toBe(true);
    expect(matchesSearchFilter(deep, '*.tex', undefined)).toBe(true);
  });

  it('excludes the other extensions', () => {
    expect(matchesSearchFilter(readme, '*.tex', undefined)).toBe(false);
    expect(matchesSearchFilter(bib, '*.tex', undefined)).toBe(false);
  });

  it('accepts a comma-separated list as a union', () => {
    const filter = '*.tex, *.md';
    expect(matchesSearchFilter(main, filter, undefined)).toBe(true);
    expect(matchesSearchFilter(readme, filter, undefined)).toBe(true);
    expect(matchesSearchFilter(nested, filter, undefined)).toBe(true);
    expect(matchesSearchFilter(bib, filter, undefined)).toBe(false);
  });

  it('is case-insensitive, as the underlying glob engine is', () => {
    expect(matchesSearchFilter('D:/proj/MAIN.TEX', '*.tex', undefined)).toBe(true);
  });
});

describe('patterns that name a folder', () => {
  it('matches a directory-qualified glob', () => {
    // This used to be tested as a substring of the absolute path, so it could
    // never match and silently returned nothing.
    expect(matchesSearchFilter(nested, 'chapters/*.tex', undefined)).toBe(true);
    expect(matchesSearchFilter(main, 'chapters/*.tex', undefined)).toBe(false);
  });

  it('matches a `**` pattern across depths', () => {
    expect(matchesSearchFilter(deep, '**/*.tex', undefined)).toBe(true);
    expect(matchesSearchFilter(main, '**/*.tex', undefined)).toBe(true);
  });

  it('matches a bare folder name only as a real path segment', () => {
    // `chapter` must not behave like a substring search over the whole path.
    expect(matchesSearchFilter(nested, 'chapters/*', undefined)).toBe(true);
    expect(matchesSearchFilter(main, 'chapters/*', undefined)).toBe(false);
  });
});

describe('nothing is admitted when the filter cannot match', () => {
  it('returns no files for a pattern that matches no extension', () => {
    // Honest: the filter really does exclude everything, and the panel reports
    // that it searched zero files rather than claiming "no matches".
    expect(matchesSearchFilter(main, '*.rst', undefined)).toBe(false);
    expect(matchesSearchFilter(readme, '*.rst', undefined)).toBe(false);
  });
});

describe('the exclude filter', () => {
  it('removes files that the include admitted', () => {
    expect(matchesSearchFilter(main, '*.tex', undefined)).toBe(true);
    expect(matchesSearchFilter(main, '*.tex', '*.tex')).toBe(false);
  });

  it('narrows a broad include rather than replacing it', () => {
    expect(matchesSearchFilter(main, '*', '*.md')).toBe(true);
    expect(matchesSearchFilter(readme, '*', '*.md')).toBe(false);
  });

  it('accepts a list', () => {
    expect(matchesSearchFilter(bib, '*.tex, *.bib', '*.bib, *.md')).toBe(false);
    expect(matchesSearchFilter(main, '*.tex, *.bib', '*.bib, *.md')).toBe(true);
  });
});
