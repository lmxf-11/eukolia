/**
 * Eukolia — LaTeX Workshop port: compiler-output dispatcher.
 *
 * Ported from `out/src/parse/parser.js` of LaTeX Workshop 10.19.0: the same
 * output sniffers decide which of the four log parsers consumes a chunk of
 * compiler output, and the same `trimPattern` helpers strip `latexmk` wrappers
 * and repeated TeX runs before parsing.
 *
 * The reference accumulates into global `buildLog` arrays and pushes the result
 * to `vscode.languages` diagnostic collections; here the messages are returned
 * so the caller decides where they go.
 */

import { parseLatexLogMessages, type LatexLogParseOptions } from './latexLog'
import { parseBibtexLog, parseBiberLog, type BibLogParseOptions } from './bibLog'
import { parseDvipdfmxLog } from './dvipdfmxLog'
import type { LogMessage } from '../types'

// Notice that 'Output written on filename.pdf' isn't output in draft mode.
// https://github.com/James-Yu/LaTeX-Workshop/issues/2893#issuecomment-936312853
const latexPattern = /^Output\swritten\son\s(.*)\s\(.*\)\.$/gm
const latexFatalPattern = /Fatal error occurred, no output PDF file produced!/gm
const latexIntErrPattern = /^! Internal error: /gm
const latexXeNoOutputPattern = /^No pages of output.$/gm
const latexmkPattern = /^Latexmk:\sapplying\srule/gm
const latexmkLogLatex = /^Latexmk:\sapplying\srule\s'(pdf|lua|xe)?latex'/
const latexmkUpToDate = /^Latexmk: All targets \(.*\) are up-to-date/m
const latexRepeatPattern = /^This\sis\s(pdf|LuaHB|Xe|e-up)TeX,\sVersion/gm
const latexRepeatLog = /^This\sis\s(pdf|LuaHB|Xe|e-up)TeX,\sVersion/
const latexRepeatLogLatex = /^This\sis\s(pdf|LuaHB|Xe|e-up)TeX,\sVersion/
const dvipdfmxPattern = /(\.dvi|\.xdv|stdin) -> .*\.pdf/
const dvipdfmxPatternAlt = /^x?dvipdfmx: ((Missing argument|Unexpected argument in).*|Multiple dvi filenames\?)/
const dvipdfmxConfigOption = /^config_special: Unknown option .*?/
const bibtexPattern = /^This is BibTeX, Version.*$/m
const biberPattern = /^INFO - This is Biber .*$/m
const bibtexPatternAlt = /^The top-level auxiliary file: .*$/m // #4197

export interface CompilerOutputParseOptions extends LatexLogParseOptions, BibLogParseOptions {
  /** Port of `lw.compile.backend`, the detected `l3backend-<driver>.def`. */
  backend?: string
}

export interface LogParseResult {
  /** Every message the matching parsers produced, in the reference's order. */
  messages: LogMessage[]
  /**
   * `lw.parser.parse.log`'s return value: latexmk decided the build was already
   * up to date.
   */
  isLaTeXmkSkipped: boolean
  errors: number
  warnings: number
}

function emptyResult(): LogParseResult {
  return { messages: [], isLaTeXmkSkipped: false, errors: 0, warnings: 0 }
}

function summarize(messages: LogMessage[], isLaTeXmkSkipped: boolean): LogParseResult {
  return {
    messages,
    isLaTeXmkSkipped,
    errors: messages.filter((m) => m.type === 'error').length,
    warnings: messages.filter((m) => m.type === 'warning').length
  }
}

/**
 * Port of `parse/parser.js#log`. Feeds one chunk of compiler output to the
 * parsers selected by the reference's sniffers and returns everything they
 * produced.
 */
export function parseCompilerOutput(msg: string, options: CompilerOutputParseOptions = {}): LogParseResult {
  if (msg.trim().length === 0) {
    return emptyResult()
  }
  const messages: LogMessage[] = []
  let isLaTeXmkSkipped = false
  // Canonicalize line-endings
  msg = msg.replace(/(\r\n)|\r/g, '\n')
  // Keep the original output for skipped-build detection: repeated-run
  // trimming can remove the latexmk rule marker. See #4981.
  const untrimmedMsg = msg
  if (msg.match(bibtexPattern) || msg.match(bibtexPatternAlt)) {
    messages.push(...tag(parseBibtexLog(msg.match(latexmkPattern) ? trimLaTeXmkBibTeX(msg) : msg, options), 'bibtex'))
  } else if (msg.match(biberPattern)) {
    messages.push(...tag(parseBiberLog(msg.match(latexmkPattern) ? trimLaTeXmkBiber(msg) : msg, options), 'biber'))
  }
  if (msg.match(latexRepeatPattern)) {
    msg = trimLatexRepeat(msg)
  }
  if (msg.match(latexPattern) || msg.match(latexFatalPattern) || msg.match(latexIntErrPattern) || msg.match(latexXeNoOutputPattern)) {
    messages.push(...tag(parseLatexLogMessages(msg, options), 'latex'))
  } else if (latexmkSkipped(untrimmedMsg)) {
    isLaTeXmkSkipped = true
  }
  if (msg.match(dvipdfmxPattern) || msg.match(dvipdfmxPatternAlt) || msg.match(dvipdfmxConfigOption)) {
    messages.push(
      ...tag(parseDvipdfmxLog(msg, { ...options, backend: options.backend ?? 'unknown' }), 'dvipdfmx')
    )
  }
  return summarize(messages, isLaTeXmkSkipped)
}

/**
 * Eukolia addition: the reference keeps one `buildLog` array per parser, so the
 * producer of a message is implicit. The dispatcher tags each entry instead,
 * which is what lets a diagnostic say whether it came from LaTeX, BibTeX, Biber
 * or dvipdfmx.
 */
function tag(messages: LogMessage[], source: NonNullable<LogMessage['source']>): LogMessage[] {
  for (const message of messages) {
    message.source = source
  }
  return messages
}

function trimLaTeXmkBibTeX(msg: string): string {
  return trimPattern(msg, bibtexPattern, latexmkLogLatex)
}

function trimLaTeXmkBiber(msg: string): string {
  return trimPattern(msg, biberPattern, latexmkLogLatex)
}

function trimLatexRepeat(msg: string): string {
  return trimPattern(msg, latexRepeatLogLatex, latexRepeatLog)
}

/**
 * Return the lines between the last occurrences of `beginPattern` and
 * `endPattern`. If `endPattern` is not found, the lines from the last
 * occurrence of `beginPattern` up to the end is returned.
 */
export function trimPattern(msg: string, beginPattern: RegExp, endPattern: RegExp): string {
  const lines = msg.split('\n')
  let startLine = -1
  let finalLine = -1
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    let result = line.match(beginPattern)
    if (result) {
      startLine = index
    }
    result = line.match(endPattern)
    if (result) {
      finalLine = index
    }
  }
  if (finalLine <= startLine) {
    return lines.slice(startLine).join('\n')
  } else {
    return lines.slice(startLine, finalLine).join('\n')
  }
}

function latexmkSkipped(msg: string): boolean {
  return Boolean(msg.match(latexmkUpToDate) && !msg.match(latexmkPattern))
}

/** `parser.clearLog` of the reference is a no-op without diagnostic collections. */
export function clearLog(): void {
  /* diagnostics are owned by the caller in Eukolia */
}
