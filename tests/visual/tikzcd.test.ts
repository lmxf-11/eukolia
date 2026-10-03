/**
 * The `tikzcd` parser.
 *
 * This module is the half of the port that has no MathJax in it, which is what
 * makes tikzcd's own syntax — the genuinely fiddly part — testable without a
 * typesetter. The assertions are the syntax real documents use, and the shapes
 * that made earlier versions of the parser wrong.
 *
 * The module has no `export` statements, deliberately: the renderer loads it as a
 * classic script from `file://`, where Chrome refuses to run a module script, so
 * it publishes its functions on a global instead. Importing it here runs it, and
 * the functions are read off that global — the same ones the extension gets.
 */
import { beforeAll, describe, expect, it } from 'vitest'

type GridPos = { row: number; column: number }
type Cell = GridPos & { content: string }
type ArrowSpec = {
  host: GridPos | null
  from: GridPos | null
  to: GridPos | null
  direction: string | null
  delta: { dx: number; dy: number } | null
  labels: string[]
  labelPlacements: string[]
  options: Array<[string, string | true]>
  command: string
}
type Box = {
  row: number
  column: number
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
  baseline: number
}

interface Parser {
  arrowCommandAt(
    tex: string,
    i: number,
  ): { name: string; end: number; matched: boolean } | null
  skipGroup(tex: string, i: number): number
  splitCommas(text: string): string[]
  parseOptions(text: string): Array<[string, string | true]>
  optionValue(
    options: Array<[string, string | true]>,
    name: string,
  ): string | true | undefined
  directionDelta(direction: string): { dx: number; dy: number } | null
  directionFromCommand(command: string): string | null
  parseCellRef(text: string): GridPos | null
  parseTikzcd(body: string): {
    cells: Cell[]
    arrows: ArrowSpec[]
    rows: number
    columns: number
    diagramOptions: string
    spacing?: { row: Record<number, string>; column: Record<number, string> }
    error: string | null
  }
  layoutGrid(metrics: {
    columnWidths: number[]
    rowHeights: number[]
    rowDepths: number[]
    rowBaselines: number[]
    rows: number
    columns: number
    columnSpacing: number
    rowSpacing: number
  }): { boxes: Box[]; width: number; height: number; depth: number }
  cellAnchors(box: {
    left: number
    right: number
    top: number
    bottom: number
  }): {
    left: number
    center: number
    right: number
    top: number
    middle: number
    bottom: number
  }
}

let parser: Parser

beforeAll(async () => {
  await import('../../public/mathjax/input/tex/extensions/tikzcd-parser.mjs')
  parser = (globalThis as unknown as { __eukoliaTikzcdParser: Parser })
    .__eukoliaTikzcdParser
})

/**
 * The parser's functions, read at call time.
 *
 * `beforeAll` runs after the module body, so they cannot be destructured at the
 * top — the global is only there once the import has run.
 */
const parseTikzcd = (body: string) => parser.parseTikzcd(body)
const arrowCommandAt = (tex: string, i: number) => parser.arrowCommandAt(tex, i)
const skipGroup = (tex: string, i: number) => parser.skipGroup(tex, i)
const splitCommas = (text: string) => parser.splitCommas(text)
const parseOptions = (text: string) => parser.parseOptions(text)
const optionValue = (options: Array<[string, string | true]>, name: string) =>
  parser.optionValue(options, name)
const directionDelta = (direction: string) => parser.directionDelta(direction)
const directionFromCommand = (command: string) =>
  parser.directionFromCommand(command)
const parseCellRef = (text: string) => parser.parseCellRef(text)
const layoutGrid = (metrics: Parameters<Parser['layoutGrid']>[0]) =>
  parser.layoutGrid(metrics)
const cellAnchors = (box: Parameters<Parser['cellAnchors']>[0]) =>
  parser.cellAnchors(box)

describe('tikzcd cells and rows', () => {
  it('splits cells on & and rows on \\\\', () => {
    const body = parseTikzcd(String.raw`A & B \\ C & D`)
    expect(body.error).toBeNull()
    expect(body.rows).toBe(2)
    expect(body.columns).toBe(2)
    expect(
      body.cells.map((cell) => `${cell.row}-${cell.column}:${cell.content}`),
    ).toEqual(['1-1:A', '1-2:B', '2-1:C', '2-2:D'])
  })

  it('keeps a braced & inside one cell', () => {
    const body = parseTikzcd(String.raw`A_{&} & B`)
    expect(body.columns).toBe(2)
    expect(body.cells[0].content).toBe('A_{&}')
  })

  it('keeps a nested environment inside one cell', () => {
    // The `&` inside the matrix belongs to the matrix. This is the shape a real
    // diagram uses for a `\begin{matrix}` in a node, and the reason the splitter
    // tracks environment depth and not just braces.
    const body = parseTikzcd(String.raw`\begin{matrix} b & c \end{matrix} & d`)
    expect(body.columns).toBe(2)
    expect(body.cells[0].content).toBe(
      String.raw`\begin{matrix} b & c \end{matrix}`,
    )
    expect(body.cells[1].content).toBe('d')
  })

  it('does not split on an escaped &', () => {
    const body = parseTikzcd(String.raw`A \& B & C`)
    expect(body.columns).toBe(2)
    expect(body.cells[0].content).toBe(String.raw`A \& B`)
  })

  it('preserves row breaks inside a nested matrix', () => {
    const matrix = String.raw`\begin{matrix}a & b \\ c & d\end{matrix}`
    const body = parseTikzcd(String.raw`${matrix} \ar[r] & B \\ C \ar[r] & D`)
    expect(body.rows).toBe(2)
    expect(body.columns).toBe(2)
    expect(body.cells[0].content).toBe(matrix)
    expect(body.arrows.map((arrow) => arrow.host?.row)).toEqual([1, 2])
  })

  it('reads the leading [options] of the environment', () => {
    const body = parseTikzcd(String.raw`[column sep=small] A & B`)
    expect(body.diagramOptions).toBe('column sep=small')
    expect(body.columns).toBe(2)
    expect(body.cells[0].content).toBe('A')
  })

  it('reports an empty body rather than throwing', () => {
    const body = parseTikzcd('   ')
    expect(body.error).toBe('empty diagram')
    expect(body.rows).toBe(0)
    expect(body.columns).toBe(0)
  })
})

describe('tikzcd arrow commands', () => {
  it('recognises the \\ar and \\arrow families, and nothing else', () => {
    expect(arrowCommandAt(String.raw`\ar[r]`, 0)).toMatchObject({ name: 'ar' })
    expect(arrowCommandAt(String.raw`\arrow[dr]`, 0)).toMatchObject({
      name: 'arrow',
    })
    expect(arrowCommandAt(String.raw`\rar`, 0)).toMatchObject({ name: 'rar' })
    expect(arrowCommandAt(String.raw`\drar`, 0)).toMatchObject({ name: 'drar' })
    // A command with no `[` is not an arrow: the syntax requires the options.
    expect(arrowCommandAt(String.raw`\arrow x`, 0)).toBeNull()
    expect(arrowCommandAt(String.raw`\arrowhead`, 0)).toBeNull()
  })

  it('takes the arrows out of the cells they were written in', () => {
    const body = parseTikzcd(String.raw`A \ar[r] & B`)
    // An arrow belongs to the cell it is written in: `A \ar[r]` points from A.
    expect(body.cells.map((cell) => cell.content)).toEqual(['A', 'B'])
    expect(body.arrows).toHaveLength(1)
    expect(body.arrows[0].host).toEqual({ row: 1, column: 1 })
    expect(body.arrows[0].direction).toBe('r')
    expect(body.arrows[0].delta).toEqual({ dx: 1, dy: 0 })
  })

  it('keeps a space where the arrow was, so two names do not become one', () => {
    const body = parseTikzcd(String.raw`\alpha\ar[r]\beta & x`)
    expect(body.cells[0].content).toBe(String.raw`\alpha \beta`)
  })

  it('reads the shortcut family', () => {
    const body = parseTikzcd(String.raw`A \rar & B \\ C & D \uar`)
    expect(body.arrows.map((arrow) => arrow.direction)).toEqual(['r', 'u'])
    expect(directionFromCommand('rar')).toBe('r')
    expect(directionFromCommand('drar')).toBe('dr')
    expect(directionFromCommand('ar')).toBeNull()
    expect(directionFromCommand('arrow')).toBeNull()
  })

  it('reads an arrow that is on no cell: from= and to=', () => {
    const body = parseTikzcd(
      String.raw`A & B \\ C & D \arrow[from=1-1, to=2-2, "g"]`,
    )
    const arrow = body.arrows[0]
    expect(arrow.from).toEqual({ row: 1, column: 1 })
    expect(arrow.to).toEqual({ row: 2, column: 2 })
    expect(arrow.delta).toEqual({ dx: 1, dy: 1 })
    expect(arrow.labels).toEqual(['g'])
  })
})

describe('tikzcd directions', () => {
  it('counts the steps in a direction string', () => {
    expect(directionDelta('r')).toEqual({ dx: 1, dy: 0 })
    expect(directionDelta('l')).toEqual({ dx: -1, dy: 0 })
    expect(directionDelta('d')).toEqual({ dx: 0, dy: 1 })
    expect(directionDelta('u')).toEqual({ dx: 0, dy: -1 })
    expect(directionDelta('dr')).toEqual({ dx: 1, dy: 1 })
    expect(directionDelta('ur')).toEqual({ dx: 1, dy: -1 })
    expect(directionDelta('rr')).toEqual({ dx: 2, dy: 0 })
    expect(directionDelta('dd')).toEqual({ dx: 0, dy: 2 })
    expect(directionDelta('rrd')).toEqual({ dx: 2, dy: 1 })
  })

  it('rejects anything that is not a direction, or that goes nowhere', () => {
    expect(directionDelta('x')).toBeNull()
    expect(directionDelta('rl')).toBeNull()
    expect(directionDelta('ud')).toBeNull()
    expect(directionDelta('')).toBeNull()
  })
})

describe('tikzcd labels and options', () => {
  it('retains loop directions and braced label placement keys', () => {
    const body = parseTikzcd(
      String.raw`A \arrow[loop above,"f"{pos=.25,sloped}]`,
    )
    expect(body.arrows[0].delta).toEqual({ dx: 0, dy: 0 })
    expect(body.arrows[0].labelPlacements).toEqual(['pos=.25,sloped'])
  })

  it('does not consume the next cell as placement after a trailing quoted label', () => {
    const body = parseTikzcd(String.raw`A \arrow[r] "f"' & B \\ C & D`)
    expect(body.rows).toBe(2)
    expect(body.columns).toBe(2)
    expect(body.arrows[0].labelPlacements).toEqual(["'"])
    expect(body.cells[1].content).toBe('B')
  })
  it('reads a quoted label from the option list — the shape real diagrams use', () => {
    const body = parseTikzcd(
      String.raw`X\times Z \ar[r,"\,\mathrm{id}\times\hat g\,"] & X\times \cal{C}(X,Y) \ar[r,"\operatorname{ev}"] & Y`,
    )
    expect(body.columns).toBe(3)
    expect(body.cells.map((cell) => cell.content)).toEqual([
      String.raw`X\times Z`,
      String.raw`X\times \cal{C}(X,Y)`,
      'Y',
    ])
    expect(body.arrows.map((arrow) => arrow.labels)).toEqual([
      [String.raw`\,\mathrm{id}\times\hat g\,`],
      [String.raw`\operatorname{ev}`],
    ])
    expect(body.arrows.every((arrow) => arrow.direction === 'r')).toBe(true)
  })

  it('reads ` and `` as a placement, not as part of the label', () => {
    const body = parseTikzcd(
      String.raw`A \arrow[r, "f"'] & B \\ C \arrow[u, "g"''] & D`,
    )
    expect(body.arrows[0].labels).toEqual(['f'])
    expect(body.arrows[0].labelPlacements).toEqual(["'"])
    expect(body.arrows[1].labels).toEqual(['g'])
    expect(body.arrows[1].labelPlacements).toEqual(["''"])
  })

  it('reads {below} and {above}', () => {
    const body = parseTikzcd(String.raw`A \arrow[r, "f" below] & B`)
    expect(body.arrows[0].labels).toEqual(['f'])
    expect(body.arrows[0].labelPlacements).toEqual(['below'])
  })

  it('reads labels written after the options', () => {
    const body = parseTikzcd(String.raw`A \arrow[r] "f" & B`)
    expect(body.arrows[0].labels).toEqual(['f'])
  })

  it('splits an option list without breaking braces or quotes', () => {
    expect(splitCommas(String.raw`r, "f, g", bend left=30`)).toEqual([
      'r',
      ' "f, g"',
      ' bend left=30',
    ])
    const options = parseOptions(
      String.raw`r, bend left=30, Rightarrow, shift left=2`,
    )
    expect(optionValue(options, 'bend left')).toBe('30')
    expect(optionValue(options, 'Rightarrow')).toBe(true)
    expect(optionValue(options, 'shift left')).toBe('2')
    expect(optionValue(options, 'missing')).toBeUndefined()
  })

  it('reads from= and to= in the braced spelling too', () => {
    expect(parseCellRef('1-2')).toEqual({ row: 1, column: 2 })
    expect(parseCellRef('{1}-{2}')).toEqual({ row: 1, column: 2 })
    expect(parseCellRef(' 3 - 4 ')).toEqual({ row: 3, column: 4 })
    expect(parseCellRef('nope')).toBeNull()
  })
})

describe('quoting, which cost several wrong turns', () => {
  it('closes a label at its last quote', () => {
    // Each of these was returned one character too early by a first version, which
    // put the closing quote inside the label's text.
    expect(skipGroup('"g"', 0)).toBe(3)
    expect(skipGroup(String.raw`"g"'`, 0)).toBe(3)
    expect(skipGroup(String.raw`"g"''`, 0)).toBe(3)
    expect(skipGroup(String.raw`"f''"`, 0)).toBe(5)
  })
})

describe('column gap precedence', () => {
  it('keeps the first row gap when a later row supplies another length', () => {
    const parsed = parseTikzcd(String.raw`A &[1em] B \\ C &[4em] D`)
    expect(parsed.spacing?.column).toEqual({ 0: '1em' })
    expect(parsed.cells.map((cell) => cell.content.trim())).toEqual([
      'A',
      'B',
      'C',
      'D',
    ])
  })

  it('does not replace a default gap with a later explicit length', () => {
    expect(
      parseTikzcd(String.raw`A & B \\ C &[4em] D`).spacing?.column,
    ).toEqual({})
  })

  it('accepts a gap when a later row introduces a new column', () => {
    expect(
      parseTikzcd(String.raw`A \\ C &[1em] D \\ E &[4em] F`).spacing?.column,
    ).toEqual({ 0: '1em' })
  })
})

describe('grid geometry', () => {
  it('places cells from the sizes MathJax measured', () => {
    const layout = layoutGrid({
      columnWidths: [1, 2],
      rowHeights: [0.8, 0.6],
      rowDepths: [0.2, 0.4],
      rowBaselines: [0.2, -0.6],
      rows: 2,
      columns: 2,
      columnSpacing: 0.5,
      rowSpacing: 0.5,
    })
    expect(layout.width).toBeCloseTo(3.5)
    const at = (row: number, column: number) =>
      layout.boxes.find((box) => box.row === row && box.column === column)!
    const first = at(1, 1)
    const second = at(1, 2)
    const below = at(2, 1)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(below).toBeDefined()
    expect(first.left).toBe(0)
    expect(first.right).toBeCloseTo(1)
    expect(second.left).toBeCloseTo(1.5)
    expect(second.right).toBeCloseTo(3.5)
    // The second row sits one row spacing below the first row's bottom edge.
    expect(below.top).toBeLessThan(first.bottom)
  })

  it('degrades to a small cell rather than NaN when a measurement is missing', () => {
    const layout = layoutGrid({
      columnWidths: [],
      rowHeights: [],
      rowDepths: [],
      rowBaselines: [],
      rows: 1,
      columns: 1,
      columnSpacing: 0,
      rowSpacing: 0,
    })
    expect(Number.isFinite(layout.width)).toBe(true)
    for (const box of layout.boxes) {
      expect(Number.isFinite(box.left)).toBe(true)
      expect(Number.isFinite(box.top)).toBe(true)
    }
  })

  it('names the edge points an arrow can attach to', () => {
    const anchors = cellAnchors({ left: 0, right: 2, top: 1, bottom: -1 })
    expect(anchors.left).toBe(0)
    expect(anchors.right).toBe(2)
    expect(anchors.center).toBe(1)
    expect(anchors.top).toBe(1)
    expect(anchors.bottom).toBe(-1)
    expect(anchors.middle).toBe(0)
  })
})
