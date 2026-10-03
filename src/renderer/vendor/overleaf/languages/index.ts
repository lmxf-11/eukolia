import { LanguageDescription, type LanguageSupport } from '@codemirror/language'

export const languages: LanguageDescription[] = [
  LanguageDescription.of({
    name: 'latex',
    extensions: [
      'tex',
      'sty',
      'cls',
      'clo',
      'bbl',
      'pdf_tex',
      'pdf_t',
      'fd',
      'def',
      'pgf',
      'tikz',
      'bbx',
      'cbx',
      'dbx',
      'lbx',
      'lco',
      'ldf',
      'xmpdata',
      'Rnw',
      'rnw',
      'inc',
      'dtx',
      'hak',
      'eps_tex',
      'brf',
      'ins',
      'hva',
      'Rtex',
      'rtex',
      'pstex',
      'pstex_t',
      'gin',
      'fontspec',
      'pygstyle',
      'pygtex',
      'ps_tex',
      'ltx',
    ],
    load: () => {
      return import('./latex').then(m => m.latex())
    },
  }),
  LanguageDescription.of({
    name: 'bibtex',
    extensions: ['bib'],
    load: () => {
      return import('./bibtex').then(m => m.bibtex())
    },
  }),
  LanguageDescription.of({
    name: 'json',
    alias: ['json'],
    extensions: ['json'],
    load: () => {
      return import('@codemirror/lang-json').then(m => m.json())
    },
  }),
  LanguageDescription.of({
    name: 'javascript',
    alias: ['js', 'mjs', 'cjs', 'jsx', 'javascript', 'ts', 'typescript', 'tsx'],
    extensions: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'],
    load: () => {
      return import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true, typescript: true }))
    },
  }),
  LanguageDescription.of({
    name: 'markdown',
    alias: ['md', 'markdown'],
    extensions: ['md', 'markdown', 'mdown', 'mkdn'],
    load: (): Promise<LanguageSupport> => {
      return import('@codemirror/lang-markdown').then(m => m.markdown({ codeLanguages: languages }))
    },
  }),
]
