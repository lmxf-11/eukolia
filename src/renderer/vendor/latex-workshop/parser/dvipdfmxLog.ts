/**
 * Eukolia — LaTeX Workshop port: dvipdfmx / xdvipdfmx log parser.
 *
 * Ported from `out/src/parse/parser/dvipdfmxlog.js` of LaTeX Workshop 10.19.0.
 * The line classifiers, the buffering state machine and the `l3backend` driver
 * mismatch message are reproduced; the diagnostic sink is replaced by the
 * returned `buildLog` array.
 */

import { settingOr, type LwSettings } from '../settings'
import type { LogMessage } from '../types'

const divpdfmxWarn = /^x?dvipdfmx:warning: (.+)$/
const dvipdfmxContinuedWarn = /^x?dvipdfmx:warning: >> (.*)$/
const divpdfmxFatal = /^x?dvipdfmx:fatal: (.+)$/
const dvipdfmxArgsError = /^x?dvipdfmx: ((Missing argument|Unexpected argument in) .+?|Multiple dvi filenames\?)/
const dvipdfmxConfigError = /^config_special: (Unknown option .+)/
const additionalMessage = /^\s*(CMap name:|input str:|Font:|CMap:|Current input buffer is)/
const dvipdfmxInfo = /(fontmap|pdf_color|pdf_font|pdf_image|subfont|truetype|otf_cmap|otl_gsub)>> (.*)/
const kpathseaMissfont = 'kpathsea: Appending font creation commands to missfont.log.'
const noOutputPDF = 'No output PDF file written.'
const latexWorkshopMesg = 'Message from LaTeX Workshop:'

interface DvipdfmxState {
  currentType: LogMessage['type'] | undefined
  buffer: string[]
}

export interface DvipdfmxParseOptions {
  settings?: LwSettings
  rootFile?: string
  /** Port of `lw.compile.backend`; the detected `l3backend-<driver>.def`. */
  backend?: string
}

function pushLog(
  buildLog: LogMessage[],
  type: LogMessage['type'],
  file: string,
  message: string,
  line: number,
  excludeRegexp: RegExp[]
): void {
  for (const regexp of excludeRegexp) {
    if (message.match(regexp)) {
      return
    }
  }
  buildLog.push({ type, file, text: message, line })
}

/** `dvipdfmxLogParser.parse` of the reference: returns the `buildLog` array. */
export function parseDvipdfmxLog(log: string, options: DvipdfmxParseOptions = {}): LogMessage[] {
  const settings = options.settings ?? {}
  const rootFile = options.rootFile
  if (rootFile === undefined) {
    return []
  }
  let excludeRegexp: RegExp[]
  try {
    excludeRegexp = settingOr<string[]>(settings, 'message.dvipdfmxlog.exclude', []).map((regexp) => RegExp(regexp))
  } catch {
    return []
  }
  const buildLog: LogMessage[] = []
  const state: DvipdfmxState = { currentType: undefined, buffer: [] }
  const backend = options.backend ?? 'unknown'
  if (backend !== 'dvipdfmx' && backend !== 'xetex' && backend !== 'unknown') {
    pushLog(
      buildLog,
      'information',
      rootFile,
      `${latexWorkshopMesg} Detected l3backend driver: \`${backend}'.\nThe build recipe uses dvipdfmx, but the l3backend used in the DVI file generated this time\ndoes not support it. You should add \`dvipdfmx' to option list of  \\documentclass.\n\t\\documentclass[dvipdfmx, ...]{...}`,
      1,
      excludeRegexp
    )
  }
  for (const line of log.split('\n')) {
    parseLine(line, state, rootFile, excludeRegexp, buildLog)
  }
  flushLog(state, rootFile, excludeRegexp, buildLog)
  return buildLog
}

let infoTag = ''

function parseLine(
  line: string,
  state: DvipdfmxState,
  rootFile: string,
  excludeRegexp: RegExp[],
  buildLog: LogMessage[]
): void {
  let result: RegExpMatchArray | null = line.match(dvipdfmxContinuedWarn)
  if (result) {
    if (state.currentType !== 'warning') {
      flushLog(state, rootFile, excludeRegexp, buildLog)
      state.currentType = 'warning'
    }
    state.buffer.push(result[1].trim())
    return
  }
  result = line.match(additionalMessage)
  if (result) {
    if (state.currentType !== 'warning') {
      flushLog(state, rootFile, excludeRegexp, buildLog)
      state.currentType = 'warning'
    }
    line = line.replace(/^\s*/, '\t')
    state.buffer.push(line)
    return
  }
  result = line.match(dvipdfmxInfo)
  if (result) {
    const tag = result[1]
    const msg = result[2]
    if (state.currentType !== 'information') {
      flushLog(state, rootFile, excludeRegexp, buildLog)
      infoTag = tag
      state.currentType = 'information'
      state.buffer.push(`${tag}>>\n\t${msg}`)
    } else if (infoTag === tag) {
      state.buffer.push(`\t${msg}`)
    } else {
      flushLog(state, rootFile, excludeRegexp, buildLog)
      infoTag = tag
      state.currentType = 'information'
      state.buffer.push(`${tag}>>\n\t${msg}`)
    }
    return
  }
  result = line.match(divpdfmxWarn)
  if (result) {
    flushLog(state, rootFile, excludeRegexp, buildLog)
    state.currentType = 'warning'
    state.buffer.push(result[1].trim())
    return
  }
  result = line.match(divpdfmxFatal)
  if (result) {
    if (result[1] !== 'Cannot proceed without .vf or "physical" font for PDF output...') {
      flushLog(state, rootFile, excludeRegexp, buildLog)
    }
    state.currentType = 'error'
    state.buffer.push(result[1].trim())
    return
  }
  result = line.match(dvipdfmxArgsError)
  if (result) {
    flushLog(state, rootFile, excludeRegexp, buildLog)
    state.currentType = 'error'
    state.buffer.push(result[1].trim())
    return
  }
  result = line.match(dvipdfmxConfigError)
  if (result) {
    flushLog(state, rootFile, excludeRegexp, buildLog)
    state.currentType = 'error'
    state.buffer.push(result[1].trim())
    return
  }
  if (line.match(kpathseaMissfont)) {
    flushLog(state, rootFile, excludeRegexp, buildLog)
    pushLog(buildLog, 'information', rootFile, kpathseaMissfont, 1, excludeRegexp)
    return
  }
  if (line.includes(noOutputPDF)) {
    flushLog(state, rootFile, excludeRegexp, buildLog)
    pushLog(buildLog, 'error', rootFile, line, 1, excludeRegexp)
    return
  }
}

function flushLog(state: DvipdfmxState, rootFile: string, excludeRegexp: RegExp[], buildLog: LogMessage[]): void {
  if (state.currentType && state.buffer.length > 0) {
    pushLog(buildLog, state.currentType, rootFile, state.buffer.join('\n'), 1, excludeRegexp)
  }
  state.buffer.length = 0
  state.currentType = undefined
}
