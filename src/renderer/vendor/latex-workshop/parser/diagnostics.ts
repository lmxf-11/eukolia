/**
 * Eukolia — LaTeX Workshop port: diagnostics.
 *
 * Ported from `out/src/parse/parser/parserutils.js` of LaTeX Workshop 10.19.0.
 * `getErrorPosition` — the routine that turns TeX's echoed source line
 * (`errorPosText`) into a precise range — is reproduced exactly, and the
 * reference's `DIAGNOSTIC_SEVERITY` table becomes the Eukolia level mapping.
 *
 * Eukolia's `DiagnosticItem` (`src/renderer/compiler/logParser.ts`) is produced
 * from the reference's `buildLog` entries here, so the ported parser and the
 * application keep a stable contract.
 */

import type { LogMessage, LogMessageType } from '../types'

export interface ErrorPosition {
  start: number
  end: number
}

/**
 * `getErrorPosition` of the reference: locate the echoed source text inside the
 * offending line and return the range of its last word, which is where TeX
 * actually stopped.
 */
export function getErrorPosition(item: LogMessage, content: string | undefined): ErrorPosition | undefined {
  if (!item.errorPosText) {
    return undefined
  }
  if (!content) {
    return undefined
  }
  // Try to find the errorPosText in the respective line of the document
  const lines = content.split('\n')
  if (lines.length >= item.line) {
    const line = lines[item.line - 1]
    let pos = line.indexOf(item.errorPosText)
    if (pos >= 0) {
      pos += item.errorPosText.length
      // Find the length of the last word in the error.
      // This is the length of the error-range
      const len = item.errorPosText.length - item.errorPosText.lastIndexOf(' ') - 1
      if (len > 0) {
        return { start: pos - len, end: pos }
      }
    }
  }
  return undefined
}

/** The reference's severity table, mapped to Eukolia's levels. */
export function levelOf(type: LogMessageType): 'error' | 'warning' | 'info' {
  switch (type) {
    case 'error':
      return 'error'
    case 'warning':
      return 'warning'
    case 'typesetting':
    case 'information':
      return 'info'
  }
}

export type DiagnosticCategory =
  | 'badbox'
  | 'undefined-reference'
  | 'missing-citation'
  | 'compiler-error'
  | 'general'
  /**
   * Eukolia modification: a failure of the *build* rather than of the document —
   * an engine that is not installed, a recipe that names a tool that does not
   * exist, a run that exited non-zero with no error the compiler could point at
   * a line for. The reference has no such entry because every one of its
   * failures is a compiler message; in Eukolia the build can fail before any
   * compiler runs, and the Problems list has to be able to say so.
   */
  | 'build'

/** Categorise a `buildLog` entry the way Eukolia's Problems panel labels them. */
export function categoryOf(message: LogMessage): DiagnosticCategory {
  switch (message.type) {
    case 'typesetting':
      return 'badbox'
    case 'error':
      return 'compiler-error'
    case 'warning':
      if (message.text.startsWith('Cannot find reference')) {
        return 'undefined-reference'
      }
      if (message.text.startsWith('Cannot find citation')) {
        return 'missing-citation'
      }
      if (/No bib entry found for/.test(message.text)) {
        return 'missing-citation'
      }
      return 'general'
    default:
      return 'general'
  }
}
