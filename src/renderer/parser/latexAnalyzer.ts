/**
 * Eukolia LaTeX document analyzer.
 *
 * The implementation is the ported LaTeX Workshop machinery under
 * `src/renderer/vendor/latex-workshop/`:
 *
 *  - `parser/unified.ts`     — the reference's own unified-latex parser
 *                              (`resources/unified.js`, vendored verbatim);
 *  - `parser/unifiedDefs.ts` — `view.outline.*`-derived macro signatures;
 *  - `parser/astUtils.ts`    — `argContentToStr` / `sanitizeLabel`;
 *  - `parser/structure.ts`   — `nestNonSection`, `nestSection`,
 *                              `fixSectionToLine`;
 *  - `parser/newcommand.ts`  — the `\newcommand`-family walk.
 *
 * It is deliberately synchronous: `DocumentAnalyzer.analyze` runs on every
 * buffer change. The multi-file view of the same data (following `\input`
 * across the project) is `buildProjectStructure()` in `latexProject.ts`.
 */

import type { DocumentAnalysis, DocumentAnalyzer } from '../document/documentModel'
import type {
  CitationInfo,
  EnvironmentInfo,
  IncludedFileInfo,
  LabelInfo,
  MacroDefinitionInfo,
  OutlineItem,
  SectioningInfo
} from '../document/analysisTypes'
import { mergeSettings, type LwSettings } from '../vendor/latex-workshop/settings'
import type { AstNode, TeXElement } from '../vendor/latex-workshop/types'
import { TeXElementType } from '../vendor/latex-workshop/types'
import { argContentToStr, sanitizeLabel } from '../vendor/latex-workshop/parser/astUtils'
import { fixSectionToLine, nestNonSection, nestSection } from '../vendor/latex-workshop/parser/structure'
import { parseLatexWithArguments, stringifyAst } from '../vendor/latex-workshop/parser/unified'
import { refreshLatexModelConfig, type LatexStructureConfig } from '../vendor/latex-workshop/parser/unifiedDefs'
import {
  ENVIRONMENT_DEF_MACROS,
  LETLTXMACRO_ALIASES,
  MATH_OPERATOR_MACROS,
  NEW_COMMAND_MACROS,
  PRIMITIVE_DEF_MACROS,
  PROVIDE_COMMAND_MACROS,
  collectMacroDefinitions
} from '../vendor/latex-workshop/parser/newcommand'
import { DEFAULT_VERBATIM_ENVIRONMENTS, SOURCE_SCAN_LINES, scanLatexSource, type ScanOptions } from './latexScan'
import { readArgumentAt } from './sourceText'

/** `EnvironmentInfo` plus the plain line number `DocumentModel` asks for. */
export interface LatexEnvironmentInfo extends EnvironmentInfo {
  readonly line: number
}

/** Mutable `keys` because `DocumentModel`'s contract uses `string[]`. */
export interface LatexCitationInfo extends Omit<CitationInfo, 'keys'> {
  readonly keys: string[]
}

export interface LatexDocumentAnalysis
  extends Omit<
    DocumentAnalysis,
    'citations' | 'environments' | 'labels' | 'macroDefinitions' | 'includedFiles' | 'sectioning'
  > {
  readonly labels: LabelInfo[]
  readonly citations: LatexCitationInfo[]
  readonly macroDefinitions: MacroDefinitionInfo[]
  readonly environments: LatexEnvironmentInfo[]
  readonly includedFiles: IncludedFileInfo[]
  readonly sectioning: SectioningInfo[]
}

/** Citation commands, mirroring the reference's `intellisense.citation` regexes. */
const CITE_MACROS = /^(?:[a-zA-Z]*[Cc]ite[a-zA-Z]*\*?|bibentry|cites|parencites|textcites|footcites|autocites)$/

const INPUT_MACROS = new Set([
  'input',
  'InputIfFileExists',
  'include',
  'SweaveInput',
  'subfile',
  'subfileinclude',
  'loadglsentries',
  'markdownInput',
  'import',
  'inputfrom',
  'includefrom',
  'subimport',
  'subinputfrom',
  'subincludefrom'
])

const RESOURCE_MACROS = new Set([
  'includegraphics',
  'includesvg',
  'lstinputlisting',
  'verbatiminput',
  'bibliography',
  'addbibresource'
])

/**
 * The environment name as a plain string.
 *
 * unified-latex carries it three different ways depending on the node:
 *   - `environment` (`\begin{document}`) → `env` is the plain string;
 *   - `mathenv` (`\begin{align}`)       → `env` is a single AST node;
 *   - some producers                   → `env` is the argument node list.
 * All three are flattened here, because a non-string silently leaks into the
 * project index and breaks anything that compares or sorts environment names.
 */
function environmentName(node: AstNode): string {
  const env = node.env
  if (typeof env === 'string') return env.trim()
  if (Array.isArray(env)) return argContentToStr(env).trim()
  if (env && typeof env === 'object') return argContentToStr([env as AstNode]).trim()
  return ''
}

function startOffset(node: AstNode): number {  return node.position?.start.offset ?? 0
}

function startLine(node: AstNode): number {
  return node.position?.start.line ?? 1
}

/** The last argument that actually carries content — the mandatory one. */
function lastFilledArgumentText(node: AstNode): string {
  const args = node.args ?? []
  for (let i = args.length - 1; i >= 0; i--) {
    if ((args[i].content?.length ?? 0) > 0) {
      return argContentToStr(args[i].content)
    }
  }
  return ''
}

interface CollectState {
  labels: LabelInfo[]
  citations: LatexCitationInfo[]
  macroDefinitions: MacroDefinitionInfo[]
  environments: LatexEnvironmentInfo[]
  includedFiles: IncludedFileInfo[]
  depth: number
  environmentStack: string[]
}

function walk(nodes: AstNode[], state: CollectState, source: string): void {
  for (const node of nodes) {
    if (node.type === 'macro') {
      const name = node.content as string
      const offset = startOffset(node)
      const line = startLine(node)

      if (name === 'label' || name === 'linelabel') {
        const label = lastFilledArgumentText(node).trim()
        if (label) {
          state.labels.push({
            name: label,
            offset,
            line,
            environment: state.environmentStack[state.environmentStack.length - 1]
          })
        }
      } else if (CITE_MACROS.test(name)) {
        // The keys live in the mandatory argument; the optional ones carry
        // pre/post notes and must not contribute keys.
        const args = node.args ?? []
        let keys: string[] = []
        for (let i = args.length - 1; i >= 0; i--) {
          if (args[i].openMark !== '{' || (args[i].content?.length ?? 0) === 0) continue
          keys = argContentToStr(args[i].content)
            .split(',')
            .map((key) => key.trim())
            .filter((key) => key.length > 0)
          break
        }
        if (keys.length === 0) {
          /*
           * The parser attached no mandatory argument — which happens for a citation
           * carrying optional notes (`\citep[see][p.~3]{lamport1994}`), where the
           * arguments it does attach are all `[…]`. The keys are in the source, so
           * they are read from there; without this, citation completion is missing
           * every key cited that way.
           */
          const gobbled = readArgumentAt(source, node.position?.end.offset ?? startOffset(node))
          keys = (gobbled ?? '')
            .split(',')
            .map((key) => key.trim())
            .filter((key) => key.length > 0)
        }
        if (keys.length > 0) {
          state.citations.push({ keys, offset, line, command: name })
        }
      } else if (INPUT_MACROS.has(name) || RESOURCE_MACROS.has(name)) {
        /*
         * The argument from the AST, or — when the parser had no signature for this
         * command and therefore attached nothing — from the source, where it plainly
         * is. `\addbibresource{refs.bib}` is the case that matters: it has no entry in
         * the parser's macro table, so its argument never arrived and the
         * bibliography it names was not followed by the project index. The scan path
         * has always read it from the source; this is the same reader, so the two
         * paths agree wherever they overlap.
         */
        const path =
          lastFilledArgumentText(node) ||
          readArgumentAt(source, node.position?.end.offset ?? startOffset(node))
        if (path) {
          state.includedFiles.push({ path, offset, line, command: name })
        }
      }
    } else if (node.type === 'environment' || node.type === 'mathenv') {
      // `node.env` is the environment name as written: a plain string for
      // `mathenv`, but an AST for `environment` (unified-latex keeps the
      // `{...}` argument as nodes). It is flattened here so callers always get a
      // string — a non-string leaks into the project index and breaks anything
      // that compares or sorts environment names.
      const name = environmentName(node)
      const beginOffset = startOffset(node)
      const beginLine = startLine(node)
      state.environments.push({
        name,
        beginOffset,
        beginLine,
        endOffset: node.position?.end.offset ?? null,
        endLine: node.position?.end.line ?? null,
        nested: state.depth > 0,
        line: beginLine
      })
      state.depth += 1
      state.environmentStack.push(name)
      if (Array.isArray(node.content)) {
        walk(node.content, state, source)
      }
      state.environmentStack.pop()
      state.depth -= 1
    } else if (Array.isArray(node.content)) {
      walk(node.content, state, source)
    }
  }
}

interface OutlineBuild {
  outline: OutlineItem[]
  /** Labels attached to each outline element, keyed by source offset. */
  labelsByOffset: Map<number, string[]>
}

function collectSectioning(nodes: AstNode[], config: LatexStructureConfig): SectioningInfo[] {
  const result: SectioningInfo[] = []
  const visit = (list: AstNode[]): void => {
    for (const node of list) {
      if (node.type === 'macro' && config.macros.secs.includes(node.content as string) && node.args?.[2]?.openMark === '{') {
        const starred = Boolean(node.args?.[0]?.content[0])
        const short = (node.args?.[1]?.content?.length ?? 0) > 0 ? node.args?.[1] : undefined
        result.push({
          level: config.secIndex[node.content as string] ?? 0,
          title: sanitizeLabel((short ?? node.args?.[2])?.content ?? []),
          offset: startOffset(node),
          line: startLine(node),
          command: node.content as string,
          starred
        })
      }
      if (Array.isArray(node.content)) {
        visit(node.content)
      }
    }
  }
  visit(nodes)
  return result
}

function buildOutline(
  sectioning: SectioningInfo[],
  labels: LabelInfo[],
  config: LatexStructureConfig,
  lineCount: number,
  uri: string
): OutlineBuild {
  const elementFor = new Map<TeXElement, SectioningInfo>()
  const elements: TeXElement[] = sectioning.map((section) => {
    const element: TeXElement = {
      type: section.starred ? TeXElementType.SectionAst : TeXElementType.Section,
      name: section.command,
      label: section.title,
      filePath: uri,
      lineFr: section.line - 1,
      lineTo: section.line - 1,
      children: []
    }
    elementFor.set(element, section)
    return element
  })

  let structure = nestNonSection(elements)
  structure = nestSection(structure, config)
  fixSectionToLine(structure, config, Math.max(lineCount - 1, 0))

  // Attach each label to the deepest section whose line range contains it:
  // children claim first (post-order), the parent takes what is left.
  const labelsByOffset = new Map<number, string[]>()
  const claimed = new Set<LabelInfo>()
  const attach = (items: TeXElement[]): void => {
    for (const item of items) {
      attach(item.children)
    }
    for (const item of items) {
      const info = elementFor.get(item)
      if (!info) continue
      const mine: string[] = []
      for (const label of labels) {
        if (claimed.has(label)) continue
        if (label.line - 1 >= item.lineFr && label.line - 1 <= item.lineTo) {
          claimed.add(label)
          mine.push(label.name)
        }
      }
      labelsByOffset.set(info.offset, mine)
    }
  }
  attach(structure)

  const toItem = (element: TeXElement): OutlineItem => {
    const info = elementFor.get(element)!
    return {
      level: config.secIndex[element.name] ?? 0,
      title: element.label,
      offset: info.offset,
      line: element.lineFr + 1,
      labels: labelsByOffset.get(info.offset) ?? [],
      children: element.children.filter((child) => elementFor.has(child)).map(toItem),
      command: element.name,
      starred: info.starred
    }
  }

  return { outline: structure.map(toItem), labelsByOffset }
}

export interface LatexDocumentAnalyzerOptions {
  settings?: LwSettings
}

/** `DocumentAnalyzer` backed by the ported LaTeX Workshop parser. */
export class LatexDocumentAnalyzer implements DocumentAnalyzer {
  readonly id = 'latex-workshop'

  private settings: LwSettings

  constructor(options: LatexDocumentAnalyzerOptions = {}) {
    this.settings = mergeSettings(options.settings)
  }

  /** Update the settings snapshot; the next analysis uses them. */
  setSettings(settings: LwSettings): void {
    this.settings = mergeSettings(settings)
  }

  analyze(text: string, uri: string): LatexDocumentAnalysis {
    const config = refreshLatexModelConfig(this.settings, false)
    const lineCount = countLines(text)

    /*
     * A large document is scanned rather than parsed.
     *
     * The AST costs ~0.19 ms per line — 380 ms at 2 000 lines, 13 s at 47 886 — and it
     * is built on whichever thread asked for the analysis, which for an open buffer is
     * the one drawing the window. `latexScan.ts` has the measurements and the rule.
     */
    if (lineCount > SOURCE_SCAN_LINES) {
      return analyzeByScan(text, uri, this.settings, lineCount)
    }
    const ast = parseLatexWithArguments(text, this.settings)
    const state: CollectState = {
      labels: [],
      citations: [],
      macroDefinitions: collectMacroDefinitions(ast.content, text),
      environments: [],
      includedFiles: [],
      depth: 0,
      environmentStack: []
    }
    walk(ast.content, state, text)
    const sectioning = collectSectioning(ast.content, config)
    const { outline } = buildOutline(sectioning, state.labels, config, lineCount, uri)

    return {
      outline,
      labels: state.labels,
      citations: state.citations,
      macroDefinitions: state.macroDefinitions,
      environments: state.environments,
      includedFiles: state.includedFiles,
      sectioning
    }
  }
}

/** The vocabulary the scan is given, so both paths collect the same things. */
function scanOptions(config: LatexStructureConfig, settings: LwSettings): ScanOptions {
  const sections = new Map<string, number>()
  for (const name of config.macros.secs) sections.set(name, config.secIndex[name] ?? 0)
  const configured = settings['latex.verbatimEnvs']
  return {
    sections,
    inputCommands: INPUT_MACROS,
    resourceCommands: RESOURCE_MACROS,
    citeCommands: CITE_MACROS,
    newCommandCommands: NEW_COMMAND_MACROS,
    provideCommandCommands: PROVIDE_COMMAND_MACROS,
    mathOperatorCommands: MATH_OPERATOR_MACROS,
    environmentCommands: ENVIRONMENT_DEF_MACROS,
    primitiveCommands: PRIMITIVE_DEF_MACROS,
    aliasCommands: LETLTXMACRO_ALIASES,
    // `latex.verbatimEnvs` is the list the parser itself is built with, so reading it
    // here is what keeps a user-added verbatim environment from being scanned as
    // LaTeX by one path and not the other.
    verbatimEnvironments: Array.isArray(configured) && configured.length > 0
      ? new Set(configured.map((name) => String(name)))
      : DEFAULT_VERBATIM_ENVIRONMENTS
  }
}

/**
 * The analysis of a large document, from the linear scan.
 *
 * Exported because it is a real path — everything above `SOURCE_SCAN_LINES` comes
 * through here — and because the tests hold it to the same answers as the parser on
 * documents of every size (`tests/latex-workshop/scanAgreement.test.ts`).
 */
export function analyzeByScan(
  text: string,
  uri: string,
  settings?: LwSettings,
  knownLineCount?: number
): LatexDocumentAnalysis {
  const resolved = mergeSettings(settings)
  const config = refreshLatexModelConfig(resolved, false)
  const scanned = scanLatexSource(text, scanOptions(config, resolved))
  const lineCount = knownLineCount ?? countLines(text)
  const { outline } = buildOutline(scanned.sectioning, scanned.labels, config, lineCount, uri)

  return {
    outline,
    labels: scanned.labels,
    // `DocumentAnalysis`'s citation contract asks for mutable keys; the scan produces
    // the readonly ones its own types use.
    citations: scanned.citations.map((citation) => ({ ...citation, keys: [...citation.keys] })),
    macroDefinitions: scanned.macroDefinitions,
    environments: scanned.environments,
    includedFiles: scanned.includedFiles,
    sectioning: scanned.sectioning
  }
}

/** Shared analyzer instance for the application shell. */
export const latexDocumentAnalyzer = new LatexDocumentAnalyzer()

/**
 * The number of lines in `text`, counted rather than materialised.
 *
 * `text.split('\n').length` was the obvious spelling and it built the whole array
 * to read one number off it: on a 30 000-line paper that is 30 000 throwaway
 * strings per analysis, allocation and collection for a count. The loop visits the
 * same characters and allocates nothing.
 */
function countLines(text: string): number {
  let lines = 1
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    lines += 1
  }
  return lines
}

/**
 * `argContentToStr`/`stringifyAst` re-exported so the visual editor can render a
 * macro node exactly the way the reference does.
 */
export { argContentToStr, stringifyAst }
