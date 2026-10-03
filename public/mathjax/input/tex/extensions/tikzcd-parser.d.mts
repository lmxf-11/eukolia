/**
 * Types for `tikzcd-parser.mjs`, which is plain JavaScript on purpose.
 *
 * The parser is loaded as a classic browser script or imported under Node,
 * publishing its API on globalThis.__eukoliaTikzcdParser. Tests and
 * any future TypeScript consumer are checked by `tsc`, and without this file the
 * module is one implicit `any`.
 */

/** A grid position, 1-based, row first. `{row: 1, column: 2}` is `1-2`. */
export interface GridPos {
  row: number
  column: number
}

/** One cell of the grid, with every arrow command removed from its content. */
export interface Cell extends GridPos {
  content: string
}

/** An arrow option: its name, and its value when it has one. */
export type ArrowOption = [string, string | true]

/** The `\arrow[…]` command, as written; nothing has been resolved to geometry. */
export interface ArrowSpec {
  host: GridPos | null
  from: GridPos | null
  to: GridPos | null
  direction: string | null
  delta: { dx: number; dy: number } | null
  labels: string[]
  labelPlacements: string[]
  options: ArrowOption[]
  command: string
}

export interface TikzcdBody {
  cells: Cell[]
  arrows: ArrowSpec[]
  rows: number
  columns: number
  diagramOptions: string
  spacing?: { row: Record<number, string>; column: Record<number, string> }
  error: string | null
}

/** A cell's box in ems, y upwards from the baseline. */
export interface CellBox {
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

export interface GridLayout {
  boxes: CellBox[]
  width: number
  height: number
  depth: number
}

export interface GridMetrics {
  columnWidths: number[]
  rowHeights: number[]
  rowDepths: number[]
  rowBaselines: number[]
  rows: number
  columns: number
  columnSpacing: number
  rowSpacing: number
}

export const ARROW_COMMANDS: string[]

export function arrowCommandAt(
  tex: string,
  i: number
): { name: string; end: number; matched: boolean } | null
export function skipGroup(tex: string, i: number): number
export function splitCommas(text: string): string[]
export function parseOptions(text: string): ArrowOption[]
export function optionValue(
  options: ArrowOption[],
  name: string
): string | true | undefined
export function hasOption(options: ArrowOption[], name: string): boolean
export function numberOption(options: ArrowOption[], name: string, fallback: number): number
export function directionDelta(direction: string): { dx: number; dy: number } | null
export function directionFromCommand(command: string): string | null
export function parseCellRef(text: string): GridPos | null
export function parseTikzcd(rawBody: string): TikzcdBody
export function layoutGrid(metrics: GridMetrics): GridLayout
export function cellAnchors(box: {
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
