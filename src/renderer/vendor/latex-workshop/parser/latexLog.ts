/**
 * Eukolia — LaTeX Workshop port: LaTeX `.log` parser.
 *
 * A faithful port of `out/src/parse/parser/latexlog.js` of LaTeX Workshop
 * 10.19.0. Every regular expression, the state machine
 * (`searchEmptyLine` / `insideBoxWarn` / `insideError` / `nested`), the
 * `(./file.tex` … `)` file-stack tracking and the `-file-line-error`
 * `file:line: message` handling are reproduced verbatim.
 *
 * Two documented adaptations:
 *
 *  1. `vscode.workspace.getConfiguration` is replaced by an injected
 *     `LwSettings`, and the diagnostic sink (`vscode.languages`) is dropped —
 *     the parser returns the reference's `buildLog` array instead.
 *  2. When a `!`-style error is followed by TeX's `l.<num> <source>` line the
 *     line number is now recorded on the message. The reference only kept that
 *     text in `errorPosText` and used it to refine the diagnostic column via the
 *     file cache; recording the number keeps the diagnostic correct when the
 *     file cache does not hold the source (which is the case whenever the
 *     document has never been opened, and in every unit test).
 */

import path from 'path'

import { settingOr, type LwSettings } from '../settings'
import type { LogMessage } from '../types'

const latexError = /^(?!.*ignored error)(?:(.*):(\d+):|!)(?:\s?(.+) [Ee]rror:)? (.+?)$/
const latexOverfullBox = /^(Overfull \\[vh]box \([^)]*\)) in paragraph at lines (\d+)--(\d+)$/
const latexOverfullBoxAlt = /^(Overfull \\[vh]box \([^)]*\)) detected at line (\d+)$/
const latexOverfullBoxOutput = /^(Overfull \\[vh]box \([^)]*\)) has occurred while \\output is active(?: \[(\d+)\])?/
const latexUnderfullBox = /^(Underfull \\[vh]box \([^)]*\)) in paragraph at lines (\d+)--(\d+)$/
const latexUnderfullBoxAlt = /^(Underfull \\[vh]box \([^)]*\)) detected at line (\d+)$/
const latexUnderfullBoxOutput = /^(Underfull \\[vh]box \([^)]*\)) has occurred while \\output is active(?: \[(\d+)\])?/
const latexInfo = /^((?:(?:Class|Package|Module) \S*)|LaTeX(?: \S*)?|LaTeX3) (Info):\s+(.*?)(?: on(?: input)? line (\d+))?(\.|\?|)$/
const latexWarn = /^((?:(?:Class|Package|Module) \S*)|LaTeX(?: \S*)?|LaTeX3) (Warning):\s+(.*?)(?: on(?: input)? line (\d+))?(\.|\?|)$/
const latexPackageWarningExtraLines = /^\((.*)\)\s+(.*?)(?: +on input line (\d+))?(\.)?$/
const latexMissChar = /^\s*(Missing character:.*?!)/
const latexNoPageOutput = /^No pages of output\.$/
const bibEmpty = /^Empty `thebibliography' environment/
const biberWarn = /^Biber warning:.*WARN - I didn't find a database entry for '([^']+)'/
// LaTeX Warning: Reference `non-exist' on page 1 undefined on input line 10.
// LaTeX Warning: Citation `also-nothing' on page 1 undefined on input line 12.
const UNDEFINED_REFERENCE = /^LaTeX Warning: (Reference|Citation) `(.*?)' on page (?:\d+) undefined on input line (\d+).$/
// A line with an error message will start with an 'l' character followed by a line number and then a space.
// After that it shows the line with the error but only up to the position of the error.
// If the error comes very late in the line, the error output will start with 3 dots.
// The regular expression is set up to include the 3 dots as an optional element, such that the capture group $2
// always contains actual text that appears in the line.
const messageLine = /^l\.(\d+)\s(\.\.\.)?(.*)$/

interface ParserState {
  searchEmptyLine: boolean
  insideBoxWarn: boolean
  insideError: boolean
  currentResult: PendingLogMessage
  nested: number
  rootFile: string | undefined
  fileStack: Array<string | undefined>
}

/** The result being assembled; `type` is `''` until a message starts. */
type PendingLogMessage = Omit<LogMessage, 'type'> & { type: LogMessage['type'] | '' }

function initParserState(rootFile: string | undefined): ParserState {
  return {
    searchEmptyLine: false,
    insideBoxWarn: false,
    insideError: false,
    currentResult: { type: '', file: '', text: '', line: 1 },
    nested: 0,
    rootFile,
    fileStack: [rootFile]
  }
}

export interface LatexLogParseOptions {
  settings?: LwSettings
  rootFile?: string
}

/**
 * `latexLogParser.parse` of the reference: returns the `buildLog` array.
 */
export function parseLatexLogMessages(log: string, options: LatexLogParseOptions = {}): LogMessage[] {
  const settings = options.settings ?? {}
  const rootFile = options.rootFile
  const lines = log.split('\n')
  const buildLog: LogMessage[] = []
  const state = initParserState(rootFile)
  let excludeRegexp: RegExp[]
  try {
    excludeRegexp = settingOr<string[]>(settings, 'message.latexlog.exclude', []).map((regexp) => RegExp(regexp))
  } catch {
    return []
  }
  for (const line of lines) {
    parseLine(line, state, buildLog, excludeRegexp, settings)
  }
  // Push the final result
  if (state.currentResult.type !== '' && !state.currentResult.text.match(bibEmpty)) {
    buildLog.push(state.currentResult as LogMessage)
  }
  return buildLog
}

function parseLine(
  line: string,
  state: ParserState,
  buildLog: LogMessage[],
  excludeRegexp: RegExp[],
  settings: LwSettings
): void {
  // Compose the current file
  const top = state.fileStack[state.fileStack.length - 1]
  const filename =
    state.rootFile !== undefined
      ? path.resolve(path.dirname(state.rootFile), top ?? '')
      : (top ?? state.rootFile ?? '')
  // Skip the first line after a box warning, this is just garbage
  if (state.insideBoxWarn) {
    state.insideBoxWarn = false
    return
  }
  // Append the read line, since we have a corresponding result in the matching
  if (state.searchEmptyLine) {
    if (line.trim() === '' || (state.insideError && line.match(/^\s/))) {
      state.currentResult.text = state.currentResult.text + '\n'
      state.searchEmptyLine = false
      state.insideError = false
    } else {
      const packageExtraLineResult = line.match(latexPackageWarningExtraLines)
      if (packageExtraLineResult) {
        state.currentResult.text += '\n(' + packageExtraLineResult[1] + ')\t' + packageExtraLineResult[2] + (packageExtraLineResult[4] ? '.' : '')
        state.currentResult.line = packageExtraLineResult[3] ? parseInt(packageExtraLineResult[3], 10) : 1
      } else if (state.insideError) {
        const match = messageLine.exec(line)
        if (match && match.length >= 2) {
          const subLine = match[3]
          // remember the text where the error message occurred:
          state.currentResult.errorPosText = subLine
          // Adaptation 2: keep TeX's own line number for `!`-style errors.
          state.currentResult.line = parseInt(match[1], 10)
          // skip rest of error message (usually not useful)
          state.searchEmptyLine = false
          state.insideError = false
        } else {
          state.currentResult.text = state.currentResult.text + '\n' + line
        }
      } else {
        state.currentResult.text = state.currentResult.text + '\n' + line
      }
    }
    return
  }
  for (const regexp of excludeRegexp) {
    if (line.match(regexp)) {
      return
    }
  }
  if (parseUndefinedReference(line, filename, state, buildLog)) {
    return
  }
  if (parseBadBox(line, filename, state, buildLog, settingOr<string>(settings, 'message.badbox.show', 'both'), excludeRegexp, settings)) {
    return
  }
  let result = line.match(latexNoPageOutput)
  if (result) {
    if (state.currentResult.type !== '') {
      buildLog.push(state.currentResult as LogMessage)
    }
    state.currentResult = {
      type: 'error',
      file: filename,
      line: 1,
      text: result[1]
    }
    state.searchEmptyLine = true
    state.insideError = true
    return
  }
  result = line.match(latexMissChar)
  if (result) {
    if (state.currentResult.type !== '') {
      buildLog.push(state.currentResult as LogMessage)
    }
    state.currentResult = {
      type: 'warning',
      file: filename,
      line: 1,
      text: result[1]
    }
    state.searchEmptyLine = false
    return
  }
  result = line.match(latexInfo)
  if (result) {
    if (state.currentResult.type !== '') {
      buildLog.push(state.currentResult as LogMessage)
    }
    state.currentResult = {
      type: 'information',
      file: filename,
      line: result[4] ? parseInt(result[4], 10) : 1,
      text: result[1] + ': ' + result[3] + result[5]
    }
    state.searchEmptyLine = true
    return
  }
  result = line.match(latexWarn)
  if (result) {
    if (state.currentResult.type !== '') {
      buildLog.push(state.currentResult as LogMessage)
    }
    state.currentResult = {
      type: 'warning',
      file: filename,
      line: result[4] ? parseInt(result[4], 10) : 1,
      text: result[1] + ': ' + result[3] + result[5]
    }
    state.searchEmptyLine = true
    return
  }
  result = line.match(biberWarn)
  if (result) {
    if (state.currentResult.type !== '') {
      buildLog.push(state.currentResult as LogMessage)
    }
    state.currentResult = {
      type: 'warning',
      file: '',
      line: 1,
      text: `No bib entry found for '${result[1]}'`
    }
    state.searchEmptyLine = false
    parseLine(line.substring(result[0].length), state, buildLog, excludeRegexp, settings)
    return
  }
  result = line.match(latexError)
  if (result) {
    if (state.currentResult.type !== '') {
      buildLog.push(state.currentResult as LogMessage)
    }
    state.currentResult = {
      type: 'error',
      text: result[3] && result[3] !== 'LaTeX' ? `${result[3]}: ${result[4]}` : result[4],
      // Adaptation: keep the raw path when no root file is known, instead of
      // letting `path.resolve(path.dirname(undefined), ...)` throw.
      file: result[1] ? (state.rootFile !== undefined ? path.resolve(path.dirname(state.rootFile), result[1]) : result[1]) : filename,
      line: result[2] ? parseInt(result[2], 10) : 1
    }
    state.searchEmptyLine = true
    state.insideError = true
    return
  }
  state.nested = parseLaTeXFileStack(line, state.fileStack, state.nested)
  if (state.fileStack.length === 0) {
    state.fileStack.push(state.rootFile)
  }
}

function parseUndefinedReference(line: string, filename: string, state: ParserState, buildLog: LogMessage[]): boolean {
  if (line === 'LaTeX Warning: There were undefined references.') {
    return true
  }
  const match = line.match(UNDEFINED_REFERENCE)
  if (match === null) {
    return false
  }
  if (state.currentResult.type !== '') {
    buildLog.push(state.currentResult as LogMessage)
  }
  state.currentResult = {
    type: 'warning',
    file: filename,
    line: match[3] ? parseInt(match[3], 10) : 1,
    text: `Cannot find ${match[1].toLowerCase()} \`${match[2]}'.`,
    errorPosText: match[2]
  }
  state.searchEmptyLine = false
  return true
}

function parseBadBox(
  line: string,
  filename: string,
  state: ParserState,
  buildLog: LogMessage[],
  type: string,
  excludeRegexp: RegExp[],
  settings: LwSettings
): boolean {
  if (type === undefined || type === 'none') {
    return false
  }
  const regexs: RegExp[] = []
  if (['both', 'overfull'].includes(type)) {
    regexs.push(latexOverfullBox, latexOverfullBoxAlt, latexOverfullBoxOutput)
  }
  if (['both', 'underfull'].includes(type)) {
    regexs.push(latexUnderfullBox, latexUnderfullBoxAlt, latexUnderfullBoxOutput)
  }
  for (const regex of regexs) {
    const result = line.match(regex)
    if (result === null) {
      continue
    }
    if (state.currentResult.type !== '') {
      buildLog.push(state.currentResult as LogMessage)
    }
    if ([latexOverfullBoxOutput, latexUnderfullBoxOutput].includes(regex)) {
      state.currentResult = {
        type: 'typesetting',
        file: filename,
        line: 1,
        text: result[2] ? `${result[1]} in page ${result[2]}` : result[1]
      }
      parseLine(line.substring(result[0].length), state, buildLog, excludeRegexp, settings)
    } else {
      state.currentResult = {
        type: 'typesetting',
        file: filename,
        line: parseInt(result[2], 10),
        text: result[1]
      }
      state.insideBoxWarn = true
      state.searchEmptyLine = false
    }
    return true
  }
  return false
}

function parseLaTeXFileStack(line: string, fileStack: Array<string | undefined>, nested: number): number {
  const result = line.match(/(\(|\))/)
  if (result && result.index !== undefined && result.index > -1) {
    line = line.substring(result.index + 1)
    if (result[1] === '(') {
      const pathResult = line.match(/^"?((?:(?:[a-zA-Z]:|\.|\/)?(?:\/|\\\\?))[^"()[\]]*)/)
      const mikTeXPathResult = line.match(/^"?([^"()[\]]*\.[a-z]{3,})/)
      if (pathResult) {
        fileStack.push(pathResult[1].trim())
      } else if (mikTeXPathResult) {
        fileStack.push(`./${mikTeXPathResult[1].trim()}`)
      } else {
        nested += 1
      }
    } else {
      if (nested > 0) {
        nested -= 1
      } else {
        fileStack.pop()
      }
    }
    nested = parseLaTeXFileStack(line, fileStack, nested)
  }
  return nested
}
