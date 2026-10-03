/**
 * Eukolia — compiler diagnostics.
 *
 * The parsing itself is the **ported LaTeX Workshop implementation**
 * (`src/renderer/vendor/latex-workshop/parser/`), which in turn is a faithful
 * port of `References/james-yu.latex-workshop-10.19.0/out/src/parse/parser/`:
 *
 *   - `latexLog.ts`    : `latexlog.js` — `-file-line-error` output,
 *                        `! LaTeX Error`, `LaTeX Warning`, `Package … Warning`,
 *                        Overfull/Underfull boxes, undefined references and
 *                        citations, `l.<num>` source lines and the `(./file.tex`
 *                        … `)` file stack;
 *   - `bibLog.ts`      : `bibtexlog.js` / `biberlog.js`;
 *   - `dvipdfmxLog.ts` : `dvipdfmxlog.js`;
 *   - `logParser.ts`   : `parse/parser.js` — the dispatcher that sniffs which
 *                        parser consumes a chunk of compiler output;
 *   - `diagnostics.ts` : `parserutils.js` — `getErrorPosition` and the severity
 *                        table.
 *
 * This module keeps Eukolia's stable public surface (`DiagnosticItem`,
 * `parseLatexLog`, `LatexLogParser`) and adds the richer `parseLatexLogFull`.
 */

import { settingOr, type LwSettings } from '../vendor/latex-workshop/settings'
import { categoryOf, getErrorPosition, levelOf, type DiagnosticCategory } from '../vendor/latex-workshop/parser/diagnostics'
import { parseLatexLogMessages } from '../vendor/latex-workshop/parser/latexLog'
import { parseCompilerOutput } from '../vendor/latex-workshop/parser/logParser'
import type { LogMessage } from '../vendor/latex-workshop/types'

export type { DiagnosticCategory }

/** Severity names used by the Problems panel and Monaco markers. */
export type DiagnosticSeverityName = 'error' | 'warning' | 'information'

/** Which compiler produced a diagnostic. */
export type DiagnosticSource = 'latex' | 'bibtex' | 'biber' | 'latexmk' | 'dvipdfmx'

export interface DiagnosticItem {
  /** Absolute path of the offending file (raw compiler path when unknown). */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column, when the source line was available. */
  column?: number;
  severity: DiagnosticSeverityName;
  message: string;
  source: DiagnosticSource;
  code?: string;
  /** The offending source line, for the problems-panel preview. */
  lineText?: string;

  // --- aliases kept for the existing Eukolia consumers -------------------
  /** `error`/`warning`/`info` — the historical field of this module. */
  level: 'error' | 'warning' | 'info';
  /** The raw compiler text of the message. */
  raw: string;
  category: DiagnosticCategory;
  /** The source text TeX echoed after `l.<num>`. */
  errorPosText?: string;
}

export interface ParseLatexLogOptions {
  /** Root file, used to resolve the relative paths recorded in the log. */
  rootFile?: string;
  settings?: LwSettings;
  /** Supplies file content for the precise error range of `parserutils.js`. */
  getContent?: (file: string) => string | undefined;
  source?: DiagnosticSource;
}

export interface LatexLogParseResult {
  diagnostics: DiagnosticItem[]
  errorCount: number
  warningCount: number
}

export interface FullLogParseResult extends LatexLogParseResult {
  /** True when latexmk reported the document as already up to date. */
  isLaTeXmkSkipped: boolean
  /** The ported parser's raw messages, in compiler order. */
  messages: LogMessage[]
}

function toDiagnosticItem(
  message: LogMessage,
  options: ParseLatexLogOptions,
  source: DiagnosticSource
): DiagnosticItem {
  const content = options.getContent?.(message.file)
  const position = getErrorPosition(message, content)
  const lineText = content ? content.split('\n')[message.line - 1] : undefined
  const level = levelOf(message.type)
  return {
    file: message.file,
    line: message.line,
    column: position ? position.start + 1 : undefined,
    severity: level === 'info' ? 'information' : level,
    message: message.text,
    source,
    lineText,
    level,
    raw: message.text,
    category: categoryOf(message),
    errorPosText: message.errorPosText
  }
}

function summarize(diagnostics: DiagnosticItem[], messages: LogMessage[], isLaTeXmkSkipped = false): FullLogParseResult {
  return {
    diagnostics,
    errorCount: diagnostics.filter((d) => d.level === 'error').length,
    warningCount: diagnostics.filter((d) => d.level === 'warning').length,
    isLaTeXmkSkipped,
    messages
  }
}

/**
 * Parse a LaTeX `.log` file (or the stdout of a `-file-line-error` LaTeX run)
 * into Eukolia diagnostics.
 */
export function parseLatexLog(logText: string, options: ParseLatexLogOptions = {}): LatexLogParseResult {
  const settings = options.settings ?? {}
  const messages = parseLatexLogMessages(logText, { settings, rootFile: options.rootFile })
  const diagnostics = messages.map((message) => toDiagnosticItem(message, options, options.source ?? 'latex'))
  return {
    diagnostics,
    errorCount: diagnostics.filter((d) => d.level === 'error').length,
    warningCount: diagnostics.filter((d) => d.level === 'warning').length
  }
}

/**
 * Parse *compiler output* rather than a `.log` file: the ported dispatcher
 * selects the LaTeX, BibTeX, Biber and dvipdfmx parsers the same way
 * `lw.parser.parse.log` does, and reports latexmk's up-to-date skip.
 */
export function parseLatexLogFull(logText: string, options: ParseLatexLogOptions = {}): FullLogParseResult {
  const settings = options.settings ?? {}
  const result = parseCompilerOutput(logText, { settings, rootFile: options.rootFile })
  const diagnostics = result.messages.map((message) => toDiagnosticItem(message, options, sourceOf(message, options.source)))
  return {
    ...summarize(diagnostics, result.messages, result.isLaTeXmkSkipped),
    errorCount: diagnostics.filter((d) => d.level === 'error').length,
    warningCount: diagnostics.filter((d) => d.level === 'warning').length
  }
}

/**
 * The dispatcher tags each message with its producer; fall back to the caller's
 * declared source when a message carries none.
 */
function sourceOf(message: LogMessage, fallback?: DiagnosticSource): DiagnosticSource {
  return message.source ?? fallback ?? 'latex'
}

/** Backwards-compatible class wrapper around `parseLatexLog`. */
export class LatexLogParser {
  constructor(
    private readonly logContent: string,
    private readonly options: ParseLatexLogOptions = {}
  ) {}

  public parse(): LatexLogResultShape {
    return parseLatexLog(this.logContent, this.options)
  }
}

interface LatexLogResultShape {
  diagnostics: DiagnosticItem[]
  errorCount: number
  warningCount: number
}

/** Convenience: the effective `message.badbox.show` setting. */
export function badboxSetting(settings: LwSettings): string {
  return settingOr<string>(settings, 'message.badbox.show', 'both')
}
