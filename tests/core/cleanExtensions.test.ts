/**
 * What a clean removes.
 *
 * This is a data module, so the test is about the two things that can go wrong
 * with one: the list can lose a file type the build produces, and the *schema's*
 * default can drift from the list the main process actually deletes with. The
 * second is what happened — the schema stopped at `run.xml` while the cleaner
 * carried the glossary family, `.xdv` and `.dvi`, so an XeLaTeX build left a
 * `main.xdv` behind under a command called "Clean Auxiliary Files".
 */

import { describe, expect, it } from 'vitest';

import { CLEAN_EXTENSIONS } from '../../src/shared/cleanExtensions';
import { SETTINGS_SCHEMA } from '../../src/renderer/core/settings';

function schemaDefault(): unknown {
  return SETTINGS_SCHEMA.find((descriptor) => descriptor.key === 'compilation.cleanExtensions')?.default;
}

describe('the auxiliary extensions a clean removes', () => {
  it('is the list the setting ships with', () => {
    // One list, two readers: the schema is what the command passes and the main
    // process's fallback is what runs when nothing is passed.
    expect(schemaDefault()).toEqual([...CLEAN_EXTENSIONS]);
  });

  it('covers every engine a recipe can run', () => {
    for (const extension of ['aux', 'log', 'fls', 'fdb_latexmk', 'out', 'toc', 'synctex.gz', 'xdv', 'dvi']) {
      expect(CLEAN_EXTENSIONS, `${extension} is left behind`).toContain(extension);
    }
  });

  it('covers the bibliography, index and glossary families', () => {
    for (const extension of ['bbl', 'blg', 'bcf', 'run.xml', 'idx', 'ind', 'ilg', 'acn', 'gls', 'glo']) {
      expect(CLEAN_EXTENSIONS).toContain(extension);
    }
  });

  it('has no duplicates, and no entry that carries a dot of its own beyond the suffix', () => {
    expect(new Set(CLEAN_EXTENSIONS).size).toBe(CLEAN_EXTENSIONS.length);
    for (const extension of CLEAN_EXTENSIONS) {
      if (extension === 'run.xml') continue;
      expect(extension.startsWith('.'), `${extension} should be a bare extension`).toBe(false);
    }
  });
});
