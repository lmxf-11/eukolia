/**
 * Eukolia — the auxiliary files a clean removes.
 *
 * `LaTeX: Clean Auxiliary Files` deletes these beside (or in the output
 * directory of) the root document. The list lives here, in `shared/`, because
 * two processes need it and they must not disagree: the settings schema in the
 * renderer is what the command actually passes, and the main process's own
 * fallback is what runs when the setting is empty or was never sent.
 *
 * They disagreed until this file existed — the schema's default stopped at
 * `run.xml` while the fallback also carried the glossary family, `.xdv`, `.dvi`
 * and `.synctex` — so an XeLaTeX build left a `main.xdv` behind that the app's
 * own clean command would not remove, and a `makeglossaries` run left its `.gls`
 * and `.acn` files. The union is therefore the list, ordered as a TeX run
 * produces them: engine output first, then bibliography, index, glossary and
 * SyncTeX.
 */
export const CLEAN_EXTENSIONS: readonly string[] = [
  // Engine and SyncTeX output.
  'aux',
  'log',
  'fls',
  'fdb_latexmk',
  'synctex.gz',
  'synctex',
  'xdv',
  'dvi',
  'out',
  'toc',
  'lof',
  'lot',
  'nav',
  'snm',
  'vrb',
  // Bibliography: BibTeX and biblatex/biber.
  'bbl',
  'blg',
  'bcf',
  'run.xml',
  // Index.
  'idx',
  'ind',
  'ilg',
  'ist',
  // Glossary and acronyms.
  'acn',
  'acr',
  'alg',
  'glg',
  'glo',
  'gls',
  'loa',
  'lol',
  'nlo',
  'nls',
  'spl'
];
