/**
 * Eukolia — LaTeX Workshop port: shared plain types.
 *
 * Everything in `vendor/latex-workshop` that does not touch the editor is
 * expressed with the types in this file so the ported implementation stays
 * testable in plain Node and can be reused by the visual editor, the compiler
 * and the language services alike.
 *
 * Ported from `References/james-yu.latex-workshop-10.19.0/out/src/**`
 * (MIT — see `src/renderer/data/latex-workshop/README.md`).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Re-exported so consumers can import every shared type from one module.
 * The settings themselves live in `./settings`.
 */
export type { LwSettings, SettingsProvider } from './settings'

// ---------------------------------------------------------------------------
// Document structure (`out/src/types.ts` of the reference)
// ---------------------------------------------------------------------------

/** `TeXElementType` of `out/src/types.js`. */
export enum TeXElementType {
  Section = 0,
  SectionAst = 1,
  SubFile = 2,
  MagicComments = 3,
  Environment = 4,
  Macro = 5,
  SetCounter = 6
}

/** `TeXElement` of `out/src/types.d.ts`. */
export interface TeXElement {
  type: TeXElementType
  name: string
  label: string
  filePath: string
  lineFr: number
  lineTo: number
  children: TeXElement[]
  appendix?: boolean
  counterValue?: number
}

/** The AST node kinds produced by unified-latex (see `vendor/unified-latex`). */
export type AstNodeType =
  | 'root'
  | 'string'
  | 'whitespace'
  | 'parbreak'
  | 'comment'
  | 'macro'
  | 'environment'
  | 'mathenv'
  | 'group'
  | 'inlinemath'
  | 'displaymath'
  | 'verb'
  | 'verbatim'
  | 'argument'

export interface AstPosition {
  start: { offset: number; line: number; column: number }
  end: { offset: number; line: number; column: number }
}

export interface AstArgument {
  type: 'argument'
  content: AstNode[]
  openMark: string
  closeMark: string
}

export interface AstNode {
  type: AstNodeType
  content?: AstNode[] | string
  env?: string
  args?: AstArgument[]
  position?: AstPosition
  [key: string]: unknown
}

export interface AstRoot extends AstNode {
  type: 'root'
  content: AstNode[]
}

// ---------------------------------------------------------------------------
// Compiler diagnostics
// ---------------------------------------------------------------------------

/** The message kinds produced by the ported log parsers. */
export type LogMessageType = 'error' | 'warning' | 'information' | 'typesetting'

/** One entry of LaTeX Workshop's `buildLog` (`out/src/parse/parser/latexlog.js`). */
export interface LogMessage {
  type: LogMessageType
  file: string
  line: number
  text: string
  /** Text of the offending source line, used to refine the diagnostic range. */
  errorPosText?: string
  /**
   * Which compiler produced the message. The reference knows this implicitly
   * because each tool owns its own `buildLog`; Eukolia's dispatcher tags the
   * entries instead of keeping four parallel arrays.
   */
  source?: 'latex' | 'bibtex' | 'biber' | 'dvipdfmx' | 'latexmk'
}

// ---------------------------------------------------------------------------
// Build recipes (`out/src/compile/*`)
// ---------------------------------------------------------------------------

export interface Tool {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string | undefined>
  cwd?: string
}

export interface RecipeConfig {
  name: string
  tools: Array<string | Tool>
}

export interface StepContext {
  rootFile: string
  cwd: string
  recipeName: string
  index: number
  total: number
  isExternal: boolean
}

/** A fully resolved, executable command line — produced without spawning it. */
export interface BuildStepPlan {
  name: string
  command: string
  args: string[]
  env: Record<string, string | undefined>
  cwd: string
  rootFile: string
  recipeName: string
  index: number
  total: number
  isExternal: boolean
  /** Magic-comment options are a single shell fragment, exactly as in the reference. */
  shell: boolean
}

export interface BuildPlan {
  name: string
  rootFile: string
  cwd: string
  isExternal: boolean
  steps: BuildStepPlan[]
  /**
   * Eukolia modification: non-fatal problems found while resolving the recipe,
   * e.g. `Skipping undefined tool "pdflatexx" in recipe "mine".`
   *
   * The reference logs these and builds on; the log is a channel Eukolia does
   * not have for a build that never starts, so they travel with the plan and the
   * adapter decides whether they are a warning or the reason it failed.
   */
  messages: string[]
}

// ---------------------------------------------------------------------------
// File access abstraction
// ---------------------------------------------------------------------------

/**
 * The only filesystem surface the ported core needs. Eukolia injects a real
 * implementation; tests inject an in-memory one, which is why the ported
 * root-detection and dependency code stays independent of `vscode`.
 */
export interface FileProvider {
  exists(path: string): Promise<boolean>
  readFile(path: string): Promise<string | undefined>
  readDirectory(path: string): Promise<string[]>
  /** Files matching a workspace-relative include/exclude glob pair. */
  findFiles(includeGlob: string, excludeGlob?: string): Promise<string[]>
}
