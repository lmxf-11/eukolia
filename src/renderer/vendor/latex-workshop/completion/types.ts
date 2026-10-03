/**
 * Eukolia — LaTeX Workshop port: completion types.
 *
 * The reference completion providers return `vscode.CompletionItem`s built from
 * `lw.cache`, `lw.completion.*` and `vscode.workspace.getConfiguration`. Eukolia
 * splits that in two (Instructions.md §13): the ported providers return the plain
 * `LatexCompletionItem` below, and a thin adapter turns them into editor
 * completion entries. The project state they consult arrives through
 * `CompletionProjectState`, so the providers stay unit-testable.
 */

/** The numeric `vscode.CompletionItemKind` values the ported code uses. */
export const CompletionItemKind = {
  Text: 0,
  Method: 1,
  Function: 2,
  Constructor: 3,
  Field: 4,
  Variable: 5,
  Class: 6,
  Interface: 7,
  Module: 8,
  Property: 9,
  Unit: 10,
  Value: 11,
  Enum: 12,
  Keyword: 13,
  Snippet: 14,
  Color: 15,
  File: 16,
  Reference: 17,
  Folder: 18,
  EnumMember: 19,
  Constant: 20,
  Struct: 21,
  Event: 22,
  Operator: 23,
  TypeParameter: 24
} as const

export type CompletionItemKindValue = (typeof CompletionItemKind)[keyof typeof CompletionItemKind]

export interface CompletionTextRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

export interface CompletionTextEdit {
  range: CompletionTextRange
  newText: string
}

/** A `vscode.CompletionItem` expressed as plain data. */
export interface LatexCompletionItem {
  label: string
  kind?: CompletionItemKindValue
  detail?: string
  documentation?: string
  /** When set, replaces `label` on insert (snippet syntax is preserved). */
  insertText?: string
  filterText?: string
  sortText?: string
  preselect?: boolean
  textEdit?: CompletionTextEdit
  command?: { command: string; title: string; arguments?: unknown[] }
  /** Provider-private payload, mirroring the reference's extra item fields. */
  data?: Record<string, unknown>
}

/** The cursor/document facts every provider needs. */
export interface CompletionArgs {
  uri: string
  langId: string
  /** Full text of the line the cursor is on. */
  line: string
  /** 0-based cursor column. */
  character: number
  /**
   * 0-based line number of the cursor. Optional because the reference providers
   * only ever build ranges on the cursor's own line; the editor adapter should
   * supply it so `textEdit.range` is absolute (defaults to 0).
   */
  lineNumber?: number
  /**
   * Number of editor selections. The reference gates the `ForBegin` environment
   * snippet on `selections.length === 1`; a single cursor is assumed when this is
   * omitted.
   */
  selectionCount?: number
  settings: import('../settings').LwSettings
}

export interface LabelCompletionEntry {
  name: string
  file: string
  /** 1-based */
  line: number
  /** The text of the line holding the label, used for documentation. */
  text?: string
  /** Enclosing sectioning title, when known. */
  section?: string
}

export interface CitationCompletionEntry {
  key: string
  type: string
  title?: string
  author?: string
  authors?: string[]
  year?: string
  journal?: string
  booktitle?: string
  doi?: string
  url?: string
  /** Absolute path of the `.bib` file. */
  source: string
  /** 1-based */
  line: number
  /** Fields as written, used for the completion documentation block. */
  fields?: Record<string, string>
}

export interface MacroCompletionEntry {
  name: string
  args: number
  definition: string
  file: string
  line: number
}

export interface FileCompletionEntry {
  path: string
  name: string
  relativePath: string
  isDirectory: boolean
}

export interface EnvironmentCompletionEntry {
  name: string
  /** Snippet body for the environment's argument, from `environments.json`. */
  snippet?: string
  format?: string
  detail?: string
  documentation?: string
}

/**
 * The project/document state the ported providers read. The renderer adapter
 * backs this with `projectIndex` and the open `DocumentModel`s; tests back it
 * with literals.
 */
export interface CompletionProjectState {
  labels(): LabelCompletionEntry[]
  /** Citation keys that appear in the project's documents. */
  citedKeys(): string[]
  bibEntries(): CitationCompletionEntry[]
  macros(): MacroCompletionEntry[]
  /** Environment names known from the document's `\newenvironment`s. */
  documentEnvironments(uri: string): string[]
  /** `\usepackage`/`\RequirePackage` names used in the document. */
  packages(uri: string): string[]
  /** `\documentclass` name used in the document. */
  documentClass(uri: string): string | undefined
  /** Glossary/acronym entries defined in the project. */
  glossaryEntries(): Array<{ name: string; file: string; line: number }>
  /** Every project file, for `\input`/`\include`/`\includegraphics` completion. */
  files(): FileCompletionEntry[]
  /** `\graphicspath` directories of the document, absolute. */
  graphicsPaths(uri: string): string[]
  /** Raw text of a document, used for "already used in this file" filtering. */
  documentText(uri: string): string | undefined
  /**
   * Absolute path of the document, used as the base for `\input` completion.
   * When absent, providers fall back to the folder of `args.uri`.
   */
  rootFile?(uri: string): string | undefined
}

export interface CompletionContext {
  args: CompletionArgs
  project: CompletionProjectState
}
