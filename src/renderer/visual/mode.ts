/**
 * Code Mode ⇄ Visual Mode hand-off.
 *
 * Instructions.md §28: switching between the two editors must preserve the
 * active document, the logical cursor position, the selection and the scroll
 * position, and both editors must edit the same document.
 *
 * The hand-off is expressed in the unit **both editors can reproduce exactly**:
 * 1-based line and column for the caret (the same numbers the status bar shows)
 * and the **top visible line number** for the scroll position. Monaco and
 * CodeMirror have different fonts, line heights and wrapping, so a pixel
 * scroll offset would not survive the crossing; a line number does. Both
 * editors also carry the equivalent character offset, which is what gets
 * mapped through edits made while the other editor was on screen.
 *
 * Everything here is pure and takes plain text, so the hand-off can be tested
 * without constructing an editor — the CodeMirror and Monaco adapters only
 * supply/consume the snapshot.
 */

/** A logical, editor-independent position in a document. */
export interface ModeSwitchSnapshot {
  /** Selection anchor, as a character offset. */
  anchor: number
  /** Selection head (== anchor for a caret), as a character offset. */
  head: number
  /** Selection anchor, as a 1-based line/column. */
  anchorPosition: LineColumn
  /** Selection head (== anchor for a caret), as a 1-based line/column. */
  headPosition: LineColumn
  /** 1-based number of the line at the top of the viewport. */
  topLine: number
  /** Offset of the first character of `topLine`. */
  topOffset: number
  /** Document length the offsets were captured against. */
  docLength: number
  /** Exact pixel scrollTop of the viewport, when known. */
  scrollTop?: number
  /** Whether the caret was visible in the viewport when captured. */
  caretVisible?: boolean
  /** Vertical fraction of viewport height where caret sat (0..1), if visible. */
  caretViewportFraction?: number
}

/** A 1-based line/column position, the way the status bar reports one. */
export interface LineColumn {
  line: number
  column: number
}

export interface TextChange {
  from: number
  to: number
  /** Length of the inserted text. */
  insertLength: number
}

const EMPTY: ModeSwitchSnapshot = {
  anchor: 0,
  head: 0,
  anchorPosition: { line: 1, column: 1 },
  headPosition: { line: 1, column: 1 },
  topLine: 1,
  topOffset: 0,
  docLength: 0,
  scrollTop: 0,
  caretVisible: true,
  caretViewportFraction: 0,
}

/** A line/column pair, with the line clamped to a document's line count. */
const clampLine = (value: number, lines: number): number =>
  Math.max(1, Math.min(Math.floor(value) || 1, lines))

/** A column, which is always at least 1. */
const clampColumn = (value: number): number => Math.max(1, Math.floor(value) || 1)

/** A line number with no upper bound known, so only the lower bound applies. */
const clampUnboundedLine = (value: number): number =>
  Math.max(1, Math.floor(value) || 1)

/* ------------------------------------------------------------------ *
 * Text positions
 * ------------------------------------------------------------------ */

/** The offset of the first character of a 1-based line, or -1. */
export function lineStartOffset(text: string, line: number): number {
  const target = Math.max(1, Math.floor(line) || 1)
  if (target === 1) return 0

  let current = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 /* \n */) {
      current += 1
      if (current === target) return index + 1
    }
  }
  return -1
}

/** The number of lines in a document; always at least 1. */
export function countLines(text: string): number {
  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 /* \n */) lines += 1
  }
  return lines
}

/**
 * Maps a character offset onto a 1-based line/column, the way both editors do
 * it internally (`ITextModel.getPositionAt` / `Text.lineAt`). An offset past
 * the end of the document lands at the end of the last line.
 */
export function positionAtOffset(text: string, offset: number): LineColumn {
  const clamped = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, text.length))

  let line = 1
  let lineStart = 0
  for (let index = 0; index < clamped; index += 1) {
    if (text.charCodeAt(index) === 10 /* \n */) {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, column: clamped - lineStart + 1 }
}

/**
 * Maps a 1-based line/column onto a character offset, clamping both parts into
 * the document. This is the inverse of `positionAtOffset`.
 */
export function offsetAtPosition(text: string, position: LineColumn): number {
  const line = Math.max(1, Math.min(Math.floor(position.line) || 1, countLines(text)))
  const start = lineStartOffset(text, line)
  if (start < 0) return text.length

  const lineEnd = text.indexOf('\n', start)
  const limit = lineEnd < 0 ? text.length : lineEnd
  const column = Math.max(1, Math.floor(position.column) || 1)
  return Math.min(start + column - 1, limit)
}

/* ------------------------------------------------------------------ *
 * Offset mapping
 * ------------------------------------------------------------------ */

/** Maps a single offset through one change, mirroring CodeMirror's rules. */
export function mapOffsetThroughChange(
  offset: number,
  change: TextChange
): number {
  const { from, to, insertLength } = change
  if (offset <= from) return offset
  if (offset >= to) return offset - (to - from) + insertLength
  // Inside the replaced range: collapse to the end of the insertion.
  return from + insertLength
}

/**
 * Maps an offset through a list of non-overlapping changes, each expressed
 * against the document the changes were made to.
 */
export function mapOffsetThroughChanges(
  offset: number,
  changes: readonly TextChange[]
): number {
  let mapped = offset
  for (const change of changes) {
    mapped = mapOffsetThroughChange(mapped, change)
  }
  return mapped
}

/* ------------------------------------------------------------------ *
 * Snapshots
 * ------------------------------------------------------------------ */

/**
 * Clamps a snapshot's offsets into a document of `docLength` characters.
 *
 * Line numbers are only bounded below, because a line count cannot be derived
 * from a length: the editor that consumes the snapshot clamps the line against
 * the document it is actually restoring into, and every caller that *builds* a
 * snapshot clamps against the real text (see `createSnapshot`).
 */
export function clampSnapshot(
  snapshot: ModeSwitchSnapshot,
  docLength: number
): ModeSwitchSnapshot {
  const clamp = (value: number) =>
    Math.max(0, Math.min(Number.isFinite(value) ? value : 0, docLength))
  return {
    anchor: clamp(snapshot.anchor),
    head: clamp(snapshot.head),
    anchorPosition: {
      line: clampUnboundedLine(snapshot.anchorPosition.line),
      column: clampColumn(snapshot.anchorPosition.column),
    },
    headPosition: {
      line: clampUnboundedLine(snapshot.headPosition.line),
      column: clampColumn(snapshot.headPosition.column),
    },
    topLine: clampUnboundedLine(snapshot.topLine),
    topOffset: clamp(snapshot.topOffset),
    docLength,
    scrollTop:
      typeof snapshot.scrollTop === 'number' && Number.isFinite(snapshot.scrollTop)
        ? Math.max(0, snapshot.scrollTop)
        : undefined,
    caretVisible: snapshot.caretVisible,
    caretViewportFraction: snapshot.caretViewportFraction,
  }
}

/**
 * Carries a snapshot across an external edit, so switching modes after a change
 * made in the other editor still lands on the same logical position.
 *
 * Offsets are mapped through the changes and the line/column — and the top
 * visible line — are re-derived from the mapped offsets against the new text.
 * That is deliberate: mapping a line number arithmetically is not possible from
 * a delta, but the mapped offset is exactly the caret's new home, and its line
 * is what the other editor will reveal.
 */
export function carrySnapshotThroughChanges(
  snapshot: ModeSwitchSnapshot,
  changes: readonly TextChange[],
  nextText: string
): ModeSwitchSnapshot {
  const docLength = nextText.length
  if (changes.length === 0) {
    return clampSnapshot(snapshot, docLength)
  }

  const anchor = mapOffsetThroughChanges(snapshot.anchor, changes)
  const head = mapOffsetThroughChanges(snapshot.head, changes)
  const topOffset = mapOffsetThroughChanges(snapshot.topOffset, changes)

  return clampSnapshot(
    {
      anchor,
      head,
      anchorPosition: positionAtOffset(nextText, anchor),
      headPosition: positionAtOffset(nextText, head),
      // The top line follows the mapped top offset, so a change above the
      // viewport drags the viewport with it instead of leaving it behind.
      topLine: positionAtOffset(nextText, topOffset).line,
      topOffset,
      docLength,
      scrollTop: snapshot.scrollTop,
      caretVisible: snapshot.caretVisible,
      caretViewportFraction: snapshot.caretViewportFraction,
    },
    docLength
  )
}

/** The snapshot for a document nobody has positioned a cursor in yet. */
export const emptySnapshot = (docLength = 0): ModeSwitchSnapshot =>
  clampSnapshot(EMPTY, docLength)

/** A caret/selection position given the way an editor reports one. */
export interface SnapshotInput {
  /** Selection anchor as a 1-based line/column (the caret, in Monaco terms). */
  anchor: LineColumn
  /** Selection head as a 1-based line/column. */
  head: LineColumn
  /** 1-based number of the top visible line. */
  topLine: number
  /** Exact pixel scrollTop of the viewport, if known. */
  scrollTop?: number
  /** Whether the caret was visible in the viewport when captured. */
  caretVisible?: boolean
  /** Vertical fraction of viewport height where caret sat (0..1), if visible. */
  caretViewportFraction?: number
}

/**
 * Builds a snapshot from the shape the editors actually report — 1-based
 * line/column pairs plus the top visible line — deriving the character offsets
 * from them. This is the entry point an editor adapter uses.
 */
export function createSnapshot(text: string, input: SnapshotInput): ModeSwitchSnapshot {
  const lines = countLines(text)

  const anchor = offsetAtPosition(text, {
    line: clampLine(input.anchor.line, lines),
    column: clampColumn(input.anchor.column),
  })
  const head = offsetAtPosition(text, {
    line: clampLine(input.head.line, lines),
    column: clampColumn(input.head.column),
  })
  const topLine = clampLine(input.topLine, lines)

  return clampSnapshot(
    {
      anchor,
      head,
      // Derive the columns back out of the offsets, so a reported column past
      // the end of a line reads as that line's end in both editors.
      anchorPosition: positionAtOffset(text, anchor),
      headPosition: positionAtOffset(text, head),
      topLine,
      topOffset: offsetAtPosition(text, { line: topLine, column: 1 }),
      docLength: text.length,
      scrollTop: input.scrollTop,
      caretVisible: input.caretVisible,
      caretViewportFraction: input.caretViewportFraction,
    },
    text.length
  )
}

/**
 * Builds a snapshot from character offsets, the shape Monaco reports a
 * selection in (`getOffsetAt`). The line/column and top line are derived from
 * the text, so both adapters produce the same snapshot either way round.
 */
export function createSnapshotFromOffsets(
  text: string,
  offsets: { anchor: number; head: number; topOffset: number }
): ModeSwitchSnapshot {
  const lines = countLines(text)
  const clampOffset = (value: number) =>
    Math.max(0, Math.min(Number.isFinite(value) ? value : 0, text.length))

  const anchor = clampOffset(offsets.anchor)
  const head = clampOffset(offsets.head)
  const topLine = clampLine(positionAtOffset(text, clampOffset(offsets.topOffset)).line, lines)

  return clampSnapshot(
    {
      anchor,
      head,
      anchorPosition: positionAtOffset(text, anchor),
      headPosition: positionAtOffset(text, head),
      topLine,
      topOffset: offsetAtPosition(text, { line: topLine, column: 1 }),
      docLength: text.length,
    },
    text.length
  )
}

/** Compact, JSON-safe form, for persisting the hand-off across sessions. */
export interface SerializedSnapshot {
  a: number
  h: number
  /** Anchor column; the line is derived from `a`. */
  ac: number
  /** Head column; the line is derived from `h`. */
  hc: number
  /** 1-based top visible line. */
  tl: number
  l: number
  /** Exact pixel scrollTop of the viewport, if known. */
  st?: number
  /** Whether the caret was visible in the viewport when captured. */
  cv?: boolean
  /** Vertical fraction of viewport height where caret sat (0..1), if visible. */
  cvf?: number
}

/**
 * The serialized form carries the line-based position — the anchor/head offsets
 * and their columns, the top visible line, and the document length they were
 * captured against.
 */
export const serializeSnapshot = (
  snapshot: ModeSwitchSnapshot
): SerializedSnapshot => ({
  a: snapshot.anchor,
  h: snapshot.head,
  ac: snapshot.anchorPosition.column,
  hc: snapshot.headPosition.column,
  tl: snapshot.topLine,
  l: snapshot.docLength,
  st: snapshot.scrollTop,
  cv: snapshot.caretVisible,
  cvf: snapshot.caretViewportFraction,
})

export const deserializeSnapshot = (
  value: SerializedSnapshot | null | undefined,
  text: string
): ModeSwitchSnapshot => {
  if (!value) return emptySnapshot(text.length)

  const lines = countLines(text)
  const topLine = clampLine(value.tl, lines)

  return clampSnapshot(
    {
      anchor: value.a,
      head: value.h,
      anchorPosition: {
        line: positionAtOffset(text, value.a).line,
        column: clampColumn(value.ac),
      },
      headPosition: {
        line: positionAtOffset(text, value.h).line,
        column: clampColumn(value.hc),
      },
      topLine,
      // The line is authoritative; the offset is recomputed against the text it
      // will be restored into, so a document edited in between still lands on
      // the right line.
      topOffset: offsetAtPosition(text, { line: topLine, column: 1 }),
      docLength: value.l,
      scrollTop: value.st,
      caretVisible: value.cv,
      caretViewportFraction: value.cvf,
    },
    text.length
  )
}

/** True when the two snapshots describe the same logical position. */
export const snapshotsEqual = (
  a: ModeSwitchSnapshot,
  b: ModeSwitchSnapshot
): boolean =>
  a.anchor === b.anchor &&
  a.head === b.head &&
  a.topLine === b.topLine &&
  a.topOffset === b.topOffset

/**
 * Per-document store of the last hand-off snapshot.
 *
 * The host calls `save(key, snapshot)` when leaving a mode and `load(key, text)`
 * when entering the other one. The key is the document's `DocumentModel.uri`
 * (`C:\path\file.tex`) — the same string on both sides, never Monaco's model
 * URI, which is `file:///C:/path/file.tex`.
 */
export class ModeSwitchStore {
  private readonly entries = new Map<string, ModeSwitchSnapshot>()

  public save(key: string, snapshot: ModeSwitchSnapshot): void {
    this.entries.set(key, snapshot)
  }

  public load(key: string, text: string): ModeSwitchSnapshot {
    const stored = this.entries.get(key)
    if (!stored) return emptySnapshot(text.length)
    // The document may have changed while the other editor was active. A
    // snapshot is saved immediately before the other editor mounts, so the two
    // texts normally agree and the offsets are already correct; when they do
    // not, the caret is re-anchored at the line/column the user last saw.
    if (stored.docLength === text.length) return clampSnapshot(stored, text.length)
    return clampSnapshot(reanchor(stored, text), text.length)
  }

  public has(key: string): boolean {
    return this.entries.has(key)
  }

  public clear(key?: string): void {
    if (key === undefined) this.entries.clear()
    else this.entries.delete(key)
  }
}

/**
 * Re-anchors a snapshot whose document length no longer matches.
 *
 * A snapshot is always saved immediately before the other editor mounts, so the
 * two texts normally agree and this only runs for a document that changed while
 * neither editor was showing it. In that case there is no change log to map
 * through, and the only honest thing to do with an offset is to place it back
 * on the line and column the user last saw — clamped into the new document —
 * and to derive the offset from there. Keeping the line is deliberate: the line
 * number *is* the hand-off's unit, so a caret stays on the line it was on even
 * if the text under it moved.
 */
function reanchor(
  snapshot: ModeSwitchSnapshot,
  text: string
): ModeSwitchSnapshot {
  const lines = countLines(text)
  const topLine = Math.min(snapshot.topLine, lines)
  const anchorPosition = {
    line: Math.min(snapshot.anchorPosition.line, lines),
    column: snapshot.anchorPosition.column,
  }
  const headPosition = {
    line: Math.min(snapshot.headPosition.line, lines),
    column: snapshot.headPosition.column,
  }
  const anchor = offsetAtPosition(text, anchorPosition)
  const head = offsetAtPosition(text, headPosition)

  return {
    anchor,
    head,
    anchorPosition: positionAtOffset(text, anchor),
    headPosition: positionAtOffset(text, head),
    topLine,
    topOffset: offsetAtPosition(text, { line: topLine, column: 1 }),
    docLength: text.length,
    scrollTop: snapshot.scrollTop,
    caretVisible: snapshot.caretVisible,
    caretViewportFraction: snapshot.caretViewportFraction,
  }
}

/** The process-wide hand-off store. */
export const modeSwitchStore = new ModeSwitchStore()

/** Key used for a document, derived from its path. */
export const modeSwitchKey = (filePath: string | null): string =>
  filePath ?? 'untitled'

/* ------------------------------------------------------------------ *
 * Editor adapters
 * ------------------------------------------------------------------ */

/**
 * The line an editor should put at the top of the viewport for a snapshot: the
 * line that was recorded there.
 *
 * A recorded top line of `1` is a real position — the viewport was at the top of
 * the document — and is restored as such. This used to fall back to the *caret's*
 * line in that case, from the days when two editors handed the document to each
 * other and a top line of 1 meant "no scroll was ever recorded". Since there is
 * one editor, the top line is captured live by the very editor that restores it,
 * so the fallback only did harm: switching mode with the viewport at the top of a
 * long document and the caret below it jumped the viewport down to the caret's
 * line. Keeping the caret on screen is the host's job, and it does that with the
 * smallest scroll that only moves the viewport when the caret is genuinely
 * outside it (see `VisualEditor.tsx`).
 */
export const scrollLineFor = (snapshot: ModeSwitchSnapshot): number =>
  snapshot.topLine

/* ------------------------------------------------------------------ *
 * Minimal deltas
 * ------------------------------------------------------------------ */

/**
 * Deltas between two documents, in the shape `DocumentModel.applyDeltas` wants.
 *
 * Used by the Visual Editor to report what the user changed as a minimal edit
 * (Instructions.md §27): a single rendered-character change must produce a
 * single-character delta, never a rewritten paragraph.
 */
export function computeMinimalDelta(
  before: string,
  after: string
): { from: number; to: number; insert: string } {
  if (before === after) {
    return { from: 0, to: 0, insert: '' }
  }

  let from = 0
  const maxPrefix = Math.min(before.length, after.length)
  while (from < maxPrefix && before[from] === after[from]) from += 1

  let suffix = 0
  const maxSuffix = Math.min(before.length - from, after.length - from)
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  return {
    from,
    to: before.length - suffix,
    insert: after.slice(from, after.length - suffix),
  }
}
