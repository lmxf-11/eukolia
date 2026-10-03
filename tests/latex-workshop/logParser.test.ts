/**
 * LaTeX log parsing — ported from LaTeX Workshop `out/src/parse/parser/`.
 *
 * The fixture `fixtures/broken.log` is a **real** MiKTeX pdfTeX log: the
 * accompanying `fixtures/broken.tex` was compiled with
 * `pdflatex -interaction=nonstopmode -file-line-error broken.tex`
 * (MiKTeX 25.12, pdfTeX 1.40.28) and the log committed unchanged.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseLatexLog, parseLatexLogFull } from '../../src/renderer/compiler/logParser'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')
const ROOT_FILE = 'D:/proj/broken.tex'

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixtures, name), 'utf8')
}

describe('parseLatexLog on a real pdfTeX log', () => {
  const log = readFixture('broken.log')
  const result = parseLatexLog(log, { rootFile: ROOT_FILE })

  it('finds the undefined control sequence with its file and line', () => {
    const error = result.diagnostics.find((d) => d.message.includes('Undefined control sequence'))
    expect(error).toBeDefined()
    expect(error!.severity).toBe('error')
    expect(error!.level).toBe('error')
    expect(error!.category).toBe('compiler-error')
    expect(error!.line).toBe(7)
    expect(error!.file.replace(/\\/g, '/')).toBe(ROOT_FILE)
    expect(error!.errorPosText).toBe('\\undefinedcommand')
  })

  it('reports the undefined reference at the line the log names', () => {
    const warning = result.diagnostics.find((d) => d.category === 'undefined-reference')
    expect(warning).toBeDefined()
    expect(warning!.severity).toBe('warning')
    expect(warning!.line).toBe(5)
    expect(warning!.message).toBe("Cannot find reference `sec:nowhere'.")
  })

  it('reports the undefined citation', () => {
    const warning = result.diagnostics.find((d) => d.category === 'missing-citation')
    expect(warning).toBeDefined()
    expect(warning!.line).toBe(5)
    expect(warning!.message).toBe("Cannot find citation `knuth1984'.")
  })

  it('reports the missing input file as a LaTeX error', () => {
    const error = result.diagnostics.find((d) => d.message.includes("File `missingfile.tex' not found"))
    expect(error).toBeDefined()
    expect(error!.severity).toBe('error')
  })

  it('reports overfull boxes as bad boxes at their source line', () => {
    const boxes = result.diagnostics.filter((d) => d.category === 'badbox')
    expect(boxes.length).toBeGreaterThanOrEqual(2)
    for (const box of boxes) {
      expect(box.severity).toBe('information')
      expect(box.message).toContain('Overfull \\hbox')
    }
    const atLineNine = boxes.filter((box) => box.line === 9)
    expect(atLineNine).toHaveLength(2)
  })

  it('counts errors and warnings', () => {
    expect(result.errorCount).toBeGreaterThanOrEqual(3)
    expect(result.warningCount).toBe(2)
  })

  it('keeps the legacy DiagnosticItem aliases in sync', () => {
    for (const diagnostic of result.diagnostics) {
      expect(['error', 'warning', 'information']).toContain(diagnostic.severity)
      expect(typeof diagnostic.line).toBe('number')
      expect(diagnostic.raw).toBe(diagnostic.message)
      expect(diagnostic.source).toBe('latex')
    }
  })
})

describe('parseLatexLog on synthetic logs', () => {
  it('parses -file-line-error output without a root file', () => {
    const log = ['This is pdfTeX', '(./main.tex', './main.tex:42: Undefined control sequence', 'l.42 \\unknowncommand', ')'].join('\n')
    const result = parseLatexLog(log)
    expect(result.errorCount).toBe(1)
    expect(result.diagnostics[0].file).toBe('./main.tex')
    expect(result.diagnostics[0].line).toBe(42)
    expect(result.diagnostics[0].message).toBe('Undefined control sequence')
  })

  it('parses ! errors and recovers the l.<num> line', () => {
    const log = ['(main.tex', '! Undefined control sequence.', 'l.15 \\badmacro'].join('\n')
    const result = parseLatexLog(log)
    expect(result.errorCount).toBe(1)
    expect(result.diagnostics[0].line).toBe(15)
    expect(result.diagnostics[0].message).toContain('Undefined control sequence')
  })

  it('parses package warnings with their input line', () => {
    const log = ['(main.tex', 'Package hyperref Warning: Token not allowed in a PDF string on input line 12.'].join('\n')
    const result = parseLatexLog(log)
    expect(result.warningCount).toBe(1)
    expect(result.diagnostics[0].line).toBe(12)
    expect(result.diagnostics[0].message).toBe('Package hyperref: Token not allowed in a PDF string.')
  })

  it('tracks the (./file.tex … ) nesting for the reported file', () => {
    const log = [
      '(./main.tex',
      '(./chapters/one.tex',
      'LaTeX Warning: Reference `x\' on page 1 undefined on input line 3.',
      ')',
      'LaTeX Warning: Reference `y\' on page 1 undefined on input line 9.'
    ].join('\n')
    const result = parseLatexLog(log, { rootFile: 'D:/proj/main.tex' })
    const files = result.diagnostics.map((d) => d.file.replace(/\\/g, '/'))
    expect(files[0]).toBe('D:/proj/chapters/one.tex')
    expect(files[1]).toBe('D:/proj/main.tex')
  })

  it('honours message.latexlog.exclude', () => {
    const log = ['(main.tex', 'LaTeX Warning: Reference `x\' on page 1 undefined on input line 3.'].join('\n')
    const result = parseLatexLog(log, { settings: { 'message.latexlog.exclude': ['undefined'] } })
    expect(result.diagnostics).toHaveLength(0)
  })

  it('reports latexmk up-to-date runs through the dispatcher', () => {
    const out = 'Latexmk: All targets (broken.pdf) are up-to-date\n'
    const full = parseLatexLogFull(out)
    expect(full.isLaTeXmkSkipped).toBe(true)
    expect(full.diagnostics).toHaveLength(0)
  })

  it('dispatches Biber output to the Biber parser', () => {
    const out = [
      'INFO - This is Biber 2.19',
      "INFO - Found BibTeX data source 'refs.bib'",
      "WARN - I didn't find a database entry for 'nope' (section 0)"
    ].join('\n')
    const full = parseLatexLogFull(out, { rootFile: 'D:/proj/main.tex' })
    const warning = full.diagnostics.find((d) => d.message.includes("didn't find a database entry"))
    expect(warning).toBeDefined()
    expect(warning!.severity).toBe('warning')
    expect(warning!.source).toBe('biber')
  })

  it('exposes the raw ported messages alongside the diagnostics', () => {
    const log = [
      '(main.tex',
      "LaTeX Warning: Citation `a' on page 1 undefined on input line 4.",
      'Output written on main.pdf (1 page, 12345 bytes).'
    ].join('\n')
    const full = parseLatexLogFull(log, { rootFile: 'D:/proj/main.tex' })
    expect(full.messages[0].type).toBe('warning')
    expect(full.messages[0].line).toBe(4)
    expect(full.messages[0].source).toBe('latex')
    expect(full.errorCount).toBe(0)
    expect(full.warningCount).toBe(1)
  })
})
