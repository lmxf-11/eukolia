/**
 * Eukolia — project-wide LaTeX structure.
 *
 * Composes the ported LaTeX Workshop pieces into the multi-file view Eukolia
 * needs (Instructions.md §29, §30, §51):
 *
 *  - `vendor/latex-workshop/parser/structure.ts` builds the reference's
 *    `TeXElement` tree, following `\input`/`\include`/`\subfile`/`\import`/
 *    `\subimport` across files;
 *  - `latexAnalyzer.ts` supplies per-file labels, citations, macro definitions
 *    and environments;
 *  - `vendor/latex-workshop/core/projectCache.ts` (via `LatexProjectCache`) is
 *    what the async file lookups run through.
 *
 * The outline returned by `buildProjectStructure` is the same
 * `analysisTypes.OutlineItem` shape the single-document analyzer produces, so
 * the sidebar, the command palette and the visual editor can consume either
 * interchangeably.
 */

import type { OutlineItem } from '../document/analysisTypes'
import { LatexProjectCache } from '../vendor/latex-workshop/core/projectCache'
import { defaultSettingsProvider, mergeSettings, type LwSettings } from '../vendor/latex-workshop/settings'
import type { AstRoot, FileProvider, TeXElement } from '../vendor/latex-workshop/types'
import { TeXElementType } from '../vendor/latex-workshop/types'
import { construct, type StructureFile, type StructureSource } from '../vendor/latex-workshop/parser/structure'
import { parseLatexWithArguments } from '../vendor/latex-workshop/parser/unified'
import { refreshLatexModelConfig } from '../vendor/latex-workshop/parser/unifiedDefs'
import { LatexDocumentAnalyzer, type LatexDocumentAnalysis } from './latexAnalyzer'

export interface ProjectStructureOptions {
  fs: FileProvider
  settings?: LwSettings
  /** Overrides the settings' `view.outline.numbers.enabled`. */
  numberSections?: boolean
  /** Overrides the settings' `view.outline.floats.number.enabled`. */
  numberFloats?: boolean
}

export interface ProjectStructure {
  /** The reference's `TeXElement` tree, with sub-files spliced in. */
  elements: TeXElement[]
  /** The same tree expressed as Eukolia outline items. */
  outline: OutlineItem[]
  /** Every file visited, in depth-first order. */
  files: string[]
  /** Per-file analysis, keyed by absolute path. */
  analysis: Map<string, LatexDocumentAnalysis>
}

interface SourceCacheEntry {
  content: string
  ast: AstRoot
}

/**
 * A `StructureSource` backed by the injected `FileProvider`, with a per-file
 * memo so a project refresh parses each document once.
 *
 * Note: the AST is built from the **raw** file content, not from the
 * comment-stripped `contentTrimmed` the reference parses. Line numbers are
 * identical either way, but the raw text keeps node offsets exact, which
 * Eukolia's source-preserving visual editing requires.
 */
export class FileStructureSource implements StructureSource {
  readonly files: string[] = []
  private readonly cache = new Map<string, SourceCacheEntry | undefined>()
  private readonly analyses = new Map<string, LatexDocumentAnalysis>()

  constructor(
    readonly fs: FileProvider,
    readonly settings: LwSettings,
    readonly rootFile: string | undefined
  ) {}

  async get(filePath: string): Promise<StructureFile | undefined> {
    const cached = this.cache.get(filePath)
    if (cached !== undefined || this.cache.has(filePath)) {
      return cached
    }
    const content = await this.fs.readFile(filePath)
    if (content === undefined) {
      this.cache.set(filePath, undefined)
      return undefined
    }
    const ast = parseLatexWithArguments(content, this.settings)
    const entry: SourceCacheEntry = { content, ast }
    this.cache.set(filePath, entry)
    this.files.push(filePath)
    return entry
  }

  /** The raw text of a visited file. */
  contentOf(filePath: string): string | undefined {
    return this.cache.get(filePath)?.content
  }

  /** Per-file analysis (labels, citations, macros, environments). */
  analysisOf(filePath: string): LatexDocumentAnalysis | undefined {
    const cached = this.analyses.get(filePath)
    if (cached) {
      return cached
    }
    const content = this.contentOf(filePath)
    if (content === undefined) {
      return undefined
    }
    const analyzer = new LatexDocumentAnalyzer({ settings: this.settings })
    const analysis = analyzer.analyze(content, filePath)
    this.analyses.set(filePath, analysis)
    return analysis
  }

  get analysesMap(): Map<string, LatexDocumentAnalysis> {
    return this.analyses
  }
}

/**
 * Build the project outline for `rootFile`, following every include.
 */
export async function buildProjectStructure(
  rootFile: string,
  options: ProjectStructureOptions
): Promise<ProjectStructure> {
  const settings = mergeSettings(options.settings)
  const source = new FileStructureSource(options.fs, settings, rootFile)
  const elements = await construct(rootFile, source, { subFile: true })

  if (options.numberSections === false) {
    stripSectionNumbers(elements)
  }
  if (options.numberFloats === false) {
    stripFloatNumbers(elements)
  }

  const overview = new Set<string>()
  for (const filePath of source.files) {
    overview.add(filePath)
  }

  const outline = elements
    .filter((element) => element.type === TeXElementType.Section || element.type === TeXElementType.SectionAst)
    .map((element) => toOutlineItem(element, source, settings))

  return { elements, outline, files: [...overview], analysis: source.analysesMap }
}

function toOutlineItem(element: TeXElement, source: FileStructureSource, settings: LwSettings): OutlineItem {
  const config = refreshLatexModelConfig(settings, true)
  const content = source.contentOf(element.filePath)
  const analysis = source.analysisOf(element.filePath)
  const labels = (analysis?.labels ?? [])
    .filter((label) => label.line - 1 >= element.lineFr && (element.lineTo < 0 || label.line - 1 <= element.lineTo))
    .map((label) => label.name)
  return {
    level: config.secIndex[element.name] ?? 0,
    title: stripLeadingNumber(element.label),
    offset: content ? offsetOfLine(content, element.lineFr) : 0,
    line: element.lineFr + 1,
    labels,
    children: element.children
      .filter((child) => child.type === TeXElementType.Section || child.type === TeXElementType.SectionAst)
      .map((child) => toOutlineItem(child, source, settings)),
    command: element.name,
    starred: element.type === TeXElementType.SectionAst
  }
}

/** Byte offset of the first character of a 0-based line. */
export function offsetOfLine(content: string, line: number): number {
  let offset = 0
  for (let i = 0; i < line; i++) {
    const next = content.indexOf('\n', offset)
    if (next === -1) {
      return content.length
    }
    offset = next + 1
  }
  return offset
}

/** Remove the `2.1 ` prefix `addSectionNumber` added. */
function stripLeadingNumber(label: string): string {
  return label.replace(/^(?:[0-9A-Z]+(?:\.[0-9]+)*|\*) /, '')
}

function stripSectionNumbers(elements: TeXElement[]): void {
  for (const element of elements) {
    if (element.type === TeXElementType.Section || element.type === TeXElementType.SectionAst) {
      element.label = stripLeadingNumber(element.label)
    }
    stripSectionNumbers(element.children)
  }
}

function stripFloatNumbers(elements: TeXElement[]): void {
  for (const element of elements) {
    if (element.type === TeXElementType.Environment) {
      element.label = element.label.replace(/^([A-Za-z]+) \d+(?:\.\d+)*/, '$1')
    }
    stripFloatNumbers(element.children)
  }
}

/** Convenience wrapper used by the outline view and the symbol search. */
export async function getProjectOutline(rootFile: string, options: ProjectStructureOptions): Promise<OutlineItem[]> {
  return (await buildProjectStructure(rootFile, options)).outline
}

/**
 * The project cache Eukolia's adapters use for `\input` completion and for the
 * root detector's inclusion queries.
 */
export function createProjectCache(
  fs: FileProvider,
  settings?: LwSettings,
  tmpDir = ''
): LatexProjectCache {
  const resolved = settings ?? defaultSettingsProvider()()
  return new LatexProjectCache({ fs, settings: resolved, tmpDir })
}
