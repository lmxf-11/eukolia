/**
 * Eukolia — LaTeX Workshop port: BibTeX and Biber log parsers.
 *
 * Ported from `out/src/parse/parser/bibtexlog.js` and
 * `out/src/parse/parser/biberlog.js` of LaTeX Workshop 10.19.0. All regular
 * expressions, the aux-file/`.bib`-file resolution order and the exclusion
 * filters are unchanged.
 *
 * Adaptations: the reference resolves `.bib` and `.aux` names through
 * `lw.cache` and citation keys through `lw.completion.citation`; both are
 * supplied here as injected lookups so the parsers stay free of `vscode`.
 */

import { settingOr, type LwSettings } from '../settings'
import type { LogMessage } from '../types'

const multiLineWarning = /^Warning--(.+)\n--line (\d+) of file (.+)$/gm
const singleLineWarning = /^Warning--(.+) in ([^\s]+)\s*$/gm
const multiLineError = /^(.*)---line (\d+) of file (.*)\n([^]+?)\nI'm skipping whatever remains of this entry$/gm
const badCrossReference = /^(A bad cross reference---entry ".+?"\nrefers to entry.+?, which doesn't exist)$/gm
const multiLineMacroError = /^(.*)\n?---line (\d+) of file (.*)\n([^]+?)\nI'm skipping whatever remains of this command$/gm
const errorAuxFile = /^(.*)---while reading file (.*)$/gm

export interface BibLogLookups {
  /** Port of `lw.cache.getIncludedBib(rootFile)`. */
  getIncludedBib?: (rootFile: string) => string[]
  /** Port of `lw.cache.getIncludedTeX(rootFile)`. */
  getIncludedTeX?: (rootFile: string) => string[]
  /** Port of `lw.completion.citation.getItem(key)`; line is 1-based. */
  findKeyLocation?: (key: string) => { file: string; line: number } | undefined
  /** Port of `lw.cache.get(rootFile)` — gates the reference's resolution branch. */
  hasCacheEntry?: (rootFile: string) => boolean
}

export interface BibLogParseOptions extends BibLogLookups {
  settings?: LwSettings
  rootFile?: string
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

/** `resolveAuxFile` of `bibtexlog.js`. */
export function resolveAuxFile(filename: string, rootFile: string, lookups: BibLogLookups): string {
  const texName = filename.replace(/\.aux$/, '.tex')
  if (lookups.hasCacheEntry && !lookups.hasCacheEntry(rootFile)) {
    return texName
  }
  const texFiles = lookups.getIncludedTeX?.(rootFile) ?? []
  for (const tex of texFiles) {
    if (tex.endsWith(texName)) {
      return tex
    }
  }
  return texName
}

/** `resolveBibFile` of `bibtexlog.js` / `biberlog.js`. */
export function resolveBibFile(filename: string, rootFile: string, lookups: BibLogLookups): string {
  if (lookups.hasCacheEntry && !lookups.hasCacheEntry(rootFile)) {
    return filename
  }
  const bibFiles = lookups.getIncludedBib?.(rootFile) ?? []
  for (const bib of bibFiles) {
    if (bib.endsWith(filename)) {
      return bib
    }
  }
  return filename
}

/** `bibtexLogParser.parse` of the reference: returns the `buildLog` array. */
export function parseBibtexLog(log: string, options: BibLogParseOptions = {}): LogMessage[] {
  const settings = options.settings ?? {}
  const rootFile = options.rootFile
  if (rootFile === undefined) {
    return []
  }
  let excludeRegexp: RegExp[]
  try {
    excludeRegexp = settingOr<string[]>(settings, 'message.bibtexlog.exclude', []).map((regexp) => RegExp(regexp))
  } catch {
    return []
  }
  const buildLog: LogMessage[] = []
  let result: RegExpExecArray | null
  while ((result = singleLineWarning.exec(log))) {
    const location = options.findKeyLocation?.(result[2])
    if (location) {
      pushLog(buildLog, 'warning', location.file, result[1], location.line, excludeRegexp)
    }
  }
  while ((result = multiLineWarning.exec(log))) {
    const filename = resolveBibFile(result[3], rootFile, options)
    pushLog(buildLog, 'warning', filename, result[1], parseInt(result[2], 10), excludeRegexp)
  }
  while ((result = multiLineError.exec(log))) {
    const filename = resolveBibFile(result[3], rootFile, options)
    pushLog(buildLog, 'error', filename, result[1], parseInt(result[2], 10), excludeRegexp)
  }
  while ((result = multiLineMacroError.exec(log))) {
    const filename = resolveBibFile(result[3], rootFile, options)
    pushLog(buildLog, 'error', filename, result[1], parseInt(result[2], 10), excludeRegexp)
  }
  while ((result = badCrossReference.exec(log))) {
    pushLog(buildLog, 'error', rootFile, result[1], 1, excludeRegexp)
  }
  while ((result = errorAuxFile.exec(log))) {
    const filename = resolveAuxFile(result[2], rootFile, options)
    pushLog(buildLog, 'error', filename, result[1], 1, excludeRegexp)
  }
  return buildLog
}

const bibFileInfo = /^INFO - Found BibTeX data source '(.*)'$/
const lineError = /^ERROR - BibTeX subsystem.*, line (\d+), (.*)$/
const missingEntryWarning = /^WARN - (I didn't find a database entry for '.*'.*)$/
const lineWarning = /^WARN - (.* entry '(.*)' .*)$/

/** `biberLogParser.parse` of the reference: returns the `buildLog` array. */
export function parseBiberLog(log: string, options: BibLogParseOptions = {}): LogMessage[] {
  const settings = options.settings ?? {}
  const rootFile = options.rootFile
  if (rootFile === undefined) {
    return []
  }
  let excludeRegexp: RegExp[]
  try {
    excludeRegexp = settingOr<string[]>(settings, 'message.biberlog.exclude', []).map((regexp) => RegExp(regexp))
  } catch {
    return []
  }
  const buildLog: LogMessage[] = []
  const bibFileStack: string[] = [rootFile]
  const parseLine = (line: string): void => {
    let result: RegExpMatchArray | null = line.match(bibFileInfo)
    if (result) {
      const filename = resolveBibFile(result[1], bibFileStack[0], options)
      bibFileStack.push(filename)
    }
    result = line.match(lineError)
    if (result) {
      const lineNumber = parseInt(result[1], 10)
      const filename = bibFileStack.at(-1) ?? bibFileStack[0]
      pushLog(buildLog, 'error', filename, result[2], lineNumber, excludeRegexp)
      return
    }
    result = line.match(missingEntryWarning)
    if (result) {
      const filename = bibFileStack.at(-1) ?? bibFileStack[0]
      pushLog(buildLog, 'warning', filename, result[1], 1, excludeRegexp)
    }
    result = line.match(lineWarning)
    if (result) {
      const keyLocation = options.findKeyLocation?.(result[2])
      if (keyLocation) {
        pushLog(buildLog, 'warning', keyLocation.file, result[1], keyLocation.line, excludeRegexp)
      }
    }
  }
  for (const line of log.split('\n')) {
    parseLine(line)
  }
  return buildLog
}
