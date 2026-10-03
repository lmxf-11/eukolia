/**
 * Eukolia — LaTeX Workshop port, public surface.
 *
 * Everything below is a faithful port of
 * `References/james-yu.latex-workshop-10.19.0/out/src/**` with the VS Code
 * coupling removed (Instructions.md §13): no module under this directory
 * imports `vscode`. The editor-facing adapters live in
 * `src/renderer/document/rootDoc.ts`, `src/renderer/compiler/` and
 * `src/renderer/parser/`.
 */

// -- configuration ----------------------------------------------------------
export {
  DEFAULT_SETTINGS,
  defaultSettingsProvider,
  mergeSettings,
  setting,
  settingOr,
  type LwSettings,
  type SettingsProvider
} from './settings'

// -- core: root detection and the project inclusion graph -------------------
export {
  MAGIC_ROOT_REGEX,
  ROOT_INDICATORS,
  RootDetector,
  SUBFILES_ROOT_REGEX,
  createRootDocumentState,
  rootIndicator,
  type RootDetectorHost,
  type RootDocumentState
} from './core/rootDetector'
export {
  LatexProjectCache,
  discoverDependencies,
  getIncludedTeX,
  normalizePath,
  type Dependency,
  type LatexFileCache
} from './core/projectCache'
export { InputFileRegExp, MatchType, type InputMatch } from './utils/inputFileRegexp'
export {
  getWorkingFolder,
  replaceArgumentPlaceholders,
  resolveFile,
  resolveFileGlob,
  resolveFileSync,
  sanitizeInputFilePath
} from './utils/files'
export { MemoryFileProvider } from './fs/memoryFileProvider'
export { NodeFileProvider } from './fs/nodeFileProvider'

// -- compile: recipes, plans and steps --------------------------------------
export {
  createExternalRecipe,
  createMagicTool,
  createMagicTools,
  createRecipe,
  filterByLanguage,
  findConfig,
  findMagicComments,
  getLastRecipeName,
  initializeRecipeState,
  resolveRecipe,
  type MagicComments,
  type Recipe,
  type RecipeResolverOptions
} from './compile/recipe'
export { buildSteps, configureMaxPrintLine, populateTools, resolveTools, type PlanContext } from './compile/plan'
export { Step, normalizeBibtexArgument } from './compile/step'
export {
  BIB_MAGIC_PROGRAM_NAME,
  MAGIC_PROGRAM_ARGS_SUFFIX,
  MAX_PRINT_LINE,
  TEX_MAGIC_PROGRAM_NAME
} from './compile/constants'

// -- parser: logs, structure, macros, tokens --------------------------------
export { parseLatexLogMessages, type LatexLogParseOptions } from './parser/latexLog'
export { parseBiberLog, parseBibtexLog, type BibLogParseOptions, type BibLogLookups } from './parser/bibLog'
export { parseDvipdfmxLog, type DvipdfmxParseOptions } from './parser/dvipdfmxLog'
export {
  clearLog,
  parseCompilerOutput,
  trimPattern,
  type CompilerOutputParseOptions,
  type LogParseResult
} from './parser/logParser'
export { categoryOf, getErrorPosition, levelOf, type DiagnosticCategory } from './parser/diagnostics'
export {
  construct,
  addFloatNumber,
  addSectionNumber,
  applySectionCounters,
  fixSectionToLine,
  getChildPaths,
  getDocumentClass,
  insertSubFile,
  nestNonSection,
  nestSection,
  parseRnwChildMacro,
  traverseSectionTree,
  type StructureFile,
  type StructureSource
} from './parser/structure'
export {
  collectMacroDefinitions,
  countParameters,
  normalizeDefinition
} from './parser/newcommand'
export {
  getEnvDefs,
  getMacroDefs,
  refreshLatexModelConfig,
  type LatexStructureConfig,
  type MacroDef
} from './parser/unifiedDefs'
export { parseLaTeX, parseLatexWithArguments, resetParser, stringifyAst } from './parser/unified'
export { argContentToStr, chooseCaption, labelContentToStr, sanitizeLabel } from './parser/astUtils'

// -- math symbols and tokenization ------------------------------------------
export {
  findUnimathCommands,
  getUnicodeMathSymbol,
  getUnicodeMathSymbols,
  getUnimathSymbols,
  searchUnimathSymbols
} from './unimath'
export {
  GRAMMAR_RULES,
  SUGGESTED_MONACO_SEMANTIC_TYPES,
  braceEnd,
  tokenizeLatex,
  tokensOfType,
  type LatexToken,
  type LatexTokenType
} from './tokenizer'

// -- shared types -----------------------------------------------------------
export type {
  BuildPlan,
  BuildStepPlan,
  FileProvider,
  LogMessage,
  LogMessageType,
  RecipeConfig,
  StepContext,
  TeXElement,
  Tool
} from './types'
export { TeXElementType } from './types'
export { ACTIVE_ROOTFILE_EXT, FILE_URI_SCHEMES, getLangId, hasAlwaysRootExt, hasLaTeXClassPackageLangId, hasLaTeXLangId } from './core/constants'
