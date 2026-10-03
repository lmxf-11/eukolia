/**
 * Eukolia — LaTeX Workshop port: configuration layer.
 *
 * The reference reads every setting through
 * `vscode.workspace.getConfiguration('latex-workshop').get(key)`. To keep the
 * ported implementation free of `vscode` (Instructions.md §13) the settings are
 * passed in as a plain record; the defaults below are copied verbatim from the
 * reference `package.json` `contributes.configuration` defaults.
 */

/** A plain snapshot of the `latex-workshop.*` settings. */
export interface LwSettings {
  [key: string]: unknown
}

/** The `contributes.configuration` section the reference registers. */
export const LATEX_WORKSHOP_PREFIX = 'latex-workshop.'

/**
 * Accept both spellings of every key.
 *
 * The reference reads settings from the `latex-workshop` configuration section,
 * so its keys are unprefixed (`latex.recipes`). An Eukolia adapter that mirrors
 * VS Code's flat `workspace.getConfiguration()` map naturally stores them
 * prefixed (`latex-workshop.latex.recipes`). Normalizing here means either
 * convention works and no integration has to remember which one is canonical.
 */
export function normalizeSettings(settings: LwSettings): LwSettings {
  let hasPrefix = false
  for (const key of Object.keys(settings)) {
    if (key.startsWith(LATEX_WORKSHOP_PREFIX)) {
      hasPrefix = true
      break
    }
  }
  if (!hasPrefix) {
    return settings
  }
  const result: LwSettings = { ...settings }
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(LATEX_WORKSHOP_PREFIX)) continue
    const short = key.slice(LATEX_WORKSHOP_PREFIX.length)
    if (result[short] === undefined) {
      result[short] = value
    }
  }
  return result
}

/** The value of `key`, honouring both the prefixed and the unprefixed spelling. */
function rawValue(settings: LwSettings, key: string): unknown {
  const value = settings[key]
  if (value !== undefined) {
    return value
  }
  return settings[LATEX_WORKSHOP_PREFIX + key]
}

/**
 * Defaults copied from
 * `References/james-yu.latex-workshop-10.19.0/package.json`
 * (`contributes.configuration.properties`), stripped of the
 * `latex-workshop.` prefix.
 */
export const DEFAULT_SETTINGS: LwSettings = {
  'latex.recipes': [
    { name: 'latexmk', tools: ['latexmk'] },
    { name: 'latexmk (latexmkrc)', tools: ['latexmk_rconly'] },
    { name: 'latexmk (lualatex)', tools: ['lualatexmk'] },
    { name: 'latexmk (xelatex)', tools: ['xelatexmk'] },
    { name: 'pdflatex -> bibtex -> pdflatex * 2', tools: ['pdflatex', 'bibtex', 'pdflatex', 'pdflatex'] },
    { name: 'Compile Rnw files', tools: ['rnw2tex', 'latexmk'] },
    { name: 'Compile Jnw files', tools: ['jnw2tex', 'latexmk'] },
    { name: 'Compile Pnw files', tools: ['pnw2tex', 'latexmk'] },
    { name: 'tectonic', tools: ['tectonic'] }
  ],
  'latex.tools': [
    {
      name: 'latexmk',
      command: 'latexmk',
      args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-pdf', '-outdir=%OUTDIR%', '-auxdir=%AUXDIR%', '%DOC%']
    },
    {
      name: 'lualatexmk',
      command: 'latexmk',
      args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-lualatex', '-outdir=%OUTDIR%', '-auxdir=%AUXDIR%', '%DOC%']
    },
    {
      name: 'xelatexmk',
      command: 'latexmk',
      args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-xelatex', '-outdir=%OUTDIR%', '-auxdir=%AUXDIR%', '%DOC%']
    },
    { name: 'latexmk_rconly', command: 'latexmk', args: ['%DOC%'] },
    { name: 'pdflatex', command: 'pdflatex', args: ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '%DOC%'] },
    { name: 'bibtex', command: 'bibtex', args: ['%DOCFILE%'] },
    { name: 'rnw2tex', command: 'Rscript', args: ['-e', "knitr::opts_knit$set(concordance = TRUE); knitr::knit('%DOCFILE_EXT%')"] },
    { name: 'jnw2tex', command: 'julia', args: ['-e', 'using Weave; weave("%DOC_EXT%", doctype="tex")'] },
    { name: 'jnw2texminted', command: 'julia', args: ['-e', 'using Weave; weave("%DOC_EXT%", doctype="texminted")'] },
    { name: 'pnw2tex', command: 'pweave', args: ['-f', 'tex', '%DOC_EXT%'] },
    { name: 'pnw2texminted', command: 'pweave', args: ['-f', 'texminted', '%DOC_EXT%'] },
    { name: 'tectonic', command: 'tectonic', args: ['--synctex', '--keep-logs', '--print', '%DOC%.tex'] }
  ],
  'latex.recipe.default': 'first',
  'latex.magic.args': ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '%DOC%'],
  'latex.magic.bib.args': ['%DOCFILE%'],
  'latex.outDir': '%DIR%',
  'latex.auxDir': '%OUTDIR%',
  'latex.texDirs': [],
  'latex.verbatimEnvs': ['verbatim', 'lstlisting', 'minted'],
  'latex.rootFile.indicator': '\\documentclass[]{}',
  'latex.build.enableMagicComments': true,
  'latex.build.fromFolder': '',
  'latex.build.rootfileInStatus': false,
  'latex.build.clearLog.everyRecipeStep.enabled': true,
  'latex.build.forceRecipeUsage': true,
  'latex.autoBuild.run': 'onFileChange',
  'latex.autoBuild.interval': 1000,
  'latex.autoBuild.cleanAndRetry.enabled': true,
  'latex.autoBuild.onSave.files.ignore': ['**/*.sty', '**/*.cls'],
  'latex.option.maxPrintLine.enabled': true,
  'latex.search.rootFiles.include': ['**/*.tex', '**/*.rnw', '**/*.Rnw'],
  'latex.search.rootFiles.exclude': [],
  'latex.external.build.command': '',
  'latex.external.build.args': [],
  'docker.enabled': false,
  'message.badbox.show': 'both',
  'message.latexlog.exclude': [],
  'message.convertFilenameEncoding': false,
  // Every sectioning level LaTeX has, not just the five the reference stops at.
  //
  // This key is what decides which commands the parser recognises *at all*: the
  // signature table is built from it (`unifiedDefs.getMacroDefs`) and the
  // structure walk matches against that table, so a command missing here is not
  // merely skipped in the outline — its argument is never parsed as an argument.
  // The reference's five-level default therefore dropped `\paragraph` and
  // `\subparagraph` silently, which is the outline looking broken in a document
  // whose structure lives at those levels. `SECTIONING_ORDER`
  // (`document/analysisTypes.ts`) already models all seven, and the outline view
  // indents by level, so the parser is the only piece that disagreed.
  'view.outline.sections': [
    'part',
    'chapter',
    'section',
    'subsection',
    'subsubsection',
    'paragraph',
    'subparagraph'
  ],
  'view.outline.commands': ['label'],
  'view.outline.floats.enabled': true,
  'view.outline.floats.caption.enabled': true,
  'view.outline.floats.number.enabled': true,
  'view.outline.numbers.enabled': true,
  'view.outline.sync.viewer': false,
  'intellisense.label.command': ['label', 'linelabel'],
  'intellisense.citation.type': 'inline',
  'intellisense.citation.fuzzy': true,
  'intellisense.atSuggestion.trigger.latex': '@',
  'intellisense.package.enabled': true,
  'intellisense.includegraphics.preview.enabled': true,
  'hover.preview.maxLines': 20,
  'hover.preview.newcommand.newcommandFile': '',
  'hover.preview.newcommand.parseTeXFile.enabled': true,
  'hover.ref.enabled': true,
  'latex.autoClean.run': 'never',
  'latex.clean.fileTypes': [
    '%DOCFILE%.aux', '%DOCFILE%.bbl', '%DOCFILE%.blg', '%DOCFILE%.idx', '%DOCFILE%.ind',
    '%DOCFILE%.lof', '%DOCFILE%.lot', '%DOCFILE%.out', '%DOCFILE%.toc', '%DOCFILE%.acn',
    '%DOCFILE%.acr', '%DOCFILE%.alg', '%DOCFILE%.glg', '%DOCFILE%.glo', '%DOCFILE%.gls',
    '%DOCFILE%.fls', '%DOCFILE%.log', '%DOCFILE%.fdb_latexmk', '%DOCFILE%.snm',
    '%DOCFILE%.synctex(busy)', '%DOCFILE%.synctex.gz(busy)', '%DOCFILE%.nav', '%DOCFILE%.vrb'
  ]
}

/**
 * Anything that can resolve the `latex-workshop` settings for a scope.
 * The renderer adapter backs this with `vscode.workspace.getConfiguration`;
 * tests use `defaultSettingsProvider`.
 */
export type SettingsProvider = (scope?: string) => LwSettings

export function mergeSettings(overrides?: LwSettings): LwSettings {
  return { ...DEFAULT_SETTINGS, ...(overrides ? normalizeSettings(overrides) : undefined) }
}

export function defaultSettingsProvider(overrides?: LwSettings): SettingsProvider {
  const settings = mergeSettings(overrides)
  return () => settings
}

/** Typed `configuration.get(key)` with the reference default as fallback. */
export function setting<T>(settings: LwSettings, key: string): T {
  const value = rawValue(settings, key)
  if (value === undefined) {
    return DEFAULT_SETTINGS[key] as T
  }
  return value as T
}

export function settingOr<T>(settings: LwSettings, key: string, fallback: T): T {
  const value = rawValue(settings, key)
  if (value === undefined) {
    const def = DEFAULT_SETTINGS[key]
    return (def === undefined ? fallback : (def as T))
  }
  return value as T
}
