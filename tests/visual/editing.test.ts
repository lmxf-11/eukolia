// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { atomicDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES, createEditorScope } from '@/visual/scope'
import {
  caretAnimationName,
  caretAppearance,
  caretDataAttributes,
  normalizeCursorBlinking,
} from '@/visual/caretAppearance'
import {
  carrySnapshotThroughChanges,
  clampSnapshot,
  computeMinimalDelta,
  countLines,
  createSnapshot,
  createSnapshotFromOffsets,
  deserializeSnapshot,
  emptySnapshot,
  lineStartOffset,
  mapOffsetThroughChange,
  mapOffsetThroughChanges,
  modeSwitchKey,
  modeSwitchStore,
  ModeSwitchStore,
  offsetAtPosition,
  positionAtOffset,
  scrollLineFor,
  serializeSnapshot,
  snapshotsEqual,
  type ModeSwitchSnapshot,
} from '@/visual/mode'
import { computeFigureEdits, formatWidth } from '@/visual/figures'
import { parseFigureData } from '@/vendor/overleaf/utils/tree-operations/environments'

const createState = (doc: string) =>
  EditorState.create({
    doc,
    extensions: [
      LaTeXLanguage,
      phrases(EUKOLIA_EDITOR_PHRASES),
      filePreview(() => null),
      atomicDecorations,
    ],
  })

describe('source-aware visual editing (Instructions.md §27)', () => {
  const doc = '\\(F:\\mathcal C\\to\\mathcal D\\)'

  it('changing a rendered F to G is a one-character delta', () => {
    const state = createState(doc)
    const from = doc.indexOf('F')

    const transaction = state.update({
      changes: { from, to: from + 1, insert: 'G' },
      userEvent: 'input.type',
    })

    // Exactly one change, exactly one character wide.
    const changes: { from: number; to: number; insert: string }[] = []
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ from: fromA, to: toA, insert: inserted.toString() })
    })
    expect(changes).toEqual([{ from, to: from + 1, insert: 'G' }])

    const next = transaction.state.doc.toString()
    expect(next).toBe('\\(G:\\mathcal C\\to\\mathcal D\\)')

    // Everything the user did not touch is byte-identical: removing the edited
    // character from both documents yields the same text.
    expect(next.slice(0, from) + next.slice(from + 1)).toBe(
      doc.slice(0, from) + doc.slice(from + 1)
    )
    expect(next).toContain('\\mathcal C\\to\\mathcal D')
  })

  it('reports exactly that delta when the editor tells the host about it', () => {
    const state = createState(doc)
    const from = doc.indexOf('F')
    const applyChange = vi.fn()

    // Mirrors the VisualEditor host's change reporter.
    const transaction = state.update({
      changes: { from, to: from + 1, insert: 'G' },
    })
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      applyChange({ from: fromA, to: toA, insert: inserted.toString() })
    })

    expect(applyChange).toHaveBeenCalledTimes(1)
    expect(applyChange).toHaveBeenCalledWith({ from, to: from + 1, insert: 'G' })

    // Applying the delta to the original text reproduces the edited text.
    const applied =
      doc.slice(0, from) + 'G' + doc.slice(from + 1)
    expect(applied).toBe(transaction.state.doc.toString())
  })

  it('applies an edit through the scope without rewriting anything else', () => {
    const scope = createEditorScope({ text: doc })
    const from = doc.indexOf('F')
    scope.applyChange({ from, to: from + 1, insert: 'G' })

    expect(scope.getText()).toBe('\\(G:\\mathcal C\\to\\mathcal D\\)')
    expect(scope.getVersion()).toBe(2)
  })

  it('never decorates the math the cursor is inside, so the source stays editable', () => {
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.indexOf('F') },
      extensions: [
        LaTeXLanguage,
        phrases(EUKOLIA_EDITOR_PHRASES),
        filePreview(() => null),
        atomicDecorations,
      ],
    })
    let replaced = 0
    for (const value of state.facet(EditorView.decorations)) {
      const set =
        typeof value === 'function' ? value({ state } as never) : value
      set.between(0, state.doc.length + 1, () => {
        replaced += 1
      })
    }
    expect(replaced).toBe(0)
  })
})

describe('computeMinimalDelta', () => {
  it('is empty for identical text', () => {
    expect(computeMinimalDelta('abc', 'abc')).toEqual({
      from: 0,
      to: 0,
      insert: '',
    })
  })

  it('reports a single-character replacement', () => {
    expect(computeMinimalDelta('abc', 'axc')).toEqual({
      from: 1,
      to: 2,
      insert: 'x',
    })
  })

  it('reports an insertion with an empty range', () => {
    expect(computeMinimalDelta('ac', 'abc')).toEqual({
      from: 1,
      to: 1,
      insert: 'b',
    })
  })

  it('reports a deletion with an empty insert', () => {
    expect(computeMinimalDelta('abc', 'ac')).toEqual({
      from: 1,
      to: 2,
      insert: '',
    })
  })

  it('round-trips arbitrary edits', () => {
    const before = '\\section{A}\nText $x^2$ here\n'
    const after = '\\section{B}\nText $y^2$ and more here\n'
    const delta = computeMinimalDelta(before, after)
    const applied =
      before.slice(0, delta.from) + delta.insert + before.slice(delta.to)
    expect(applied).toBe(after)
  })
})

describe('mode.ts — Code Mode ⇄ Visual Mode hand-off (Instructions.md §28)', () => {
  const DOC = ['\\documentclass{article}', '', '\\begin{document}', 'Line four', 'Line five'].join('\n')

  it('clamps offsets into the document', () => {
    const clamped = clampSnapshot(
      {
        anchor: 99,
        head: -5,
        anchorPosition: { line: 9, column: 4 },
        headPosition: { line: 0, column: 0 },
        topLine: 12,
        topOffset: 12,
        docLength: 0,
      },
      10
    )
    // Offsets cannot exceed the document; line/column can only be clamped
    // *below*, because a length does not imply a line count.
    expect(clamped.anchor).toBe(10)
    expect(clamped.head).toBe(0)
    expect(clamped.topOffset).toBe(10)
    expect(clamped.docLength).toBe(10)
    expect(clamped.anchorPosition).toEqual({ line: 9, column: 4 })
    expect(clamped.headPosition).toEqual({ line: 1, column: 1 })
    expect(clamped.topLine).toBe(12)
  })

  it('counts lines and finds line starts', () => {
    expect(countLines('')).toBe(1)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\nb\n')).toBe(3)
    expect(lineStartOffset(DOC, 1)).toBe(0)
    expect(lineStartOffset(DOC, 3)).toBe(DOC.indexOf('\\begin{document}'))
    expect(lineStartOffset(DOC, 99)).toBe(-1)
  })

  it('maps between offsets and 1-based line/column', () => {
    expect(positionAtOffset(DOC, 0)).toEqual({ line: 1, column: 1 })
    expect(positionAtOffset(DOC, DOC.indexOf('Line four'))).toEqual({ line: 4, column: 1 })
    expect(positionAtOffset(DOC, DOC.indexOf('Line four') + 5)).toEqual({ line: 4, column: 6 })
    // A newline character is the last character of its own line; the character
    // after it starts the next line at column 1.
    const firstNewline = DOC.indexOf('\n')
    expect(positionAtOffset(DOC, firstNewline)).toEqual({ line: 1, column: firstNewline + 1 })
    expect(positionAtOffset(DOC, firstNewline + 1)).toEqual({ line: 2, column: 1 })
    expect(positionAtOffset(DOC, DOC.length)).toEqual({ line: 5, column: 10 })

    // The inverse holds for every offset in the document.
    for (let offset = 0; offset <= DOC.length; offset += 1) {
      expect(offsetAtPosition(DOC, positionAtOffset(DOC, offset))).toBe(offset)
    }

    // Out-of-range positions clamp into the document: a line past the last one
    // is read as the last line, and a column past the end of a line as its end.
    expect(offsetAtPosition(DOC, { line: 99, column: 3 })).toBe(
      DOC.indexOf('Line five') + 2
    )
    expect(offsetAtPosition(DOC, { line: 3, column: 99 })).toBe(
      DOC.indexOf('\n', DOC.indexOf('\\begin{document}'))
    )
  })

  it('builds a line-based snapshot from line/column and the top line', () => {
    const start = DOC.indexOf('Line four')
    const snapshot = createSnapshot(DOC, {
      anchor: { line: 4, column: 6 },
      head: { line: 4, column: 6 },
      topLine: 3,
    })

    expect(snapshot.anchor).toBe(start + 5)
    expect(snapshot.anchorPosition).toEqual({ line: 4, column: 6 })
    expect(snapshot.headPosition).toEqual({ line: 4, column: 6 })
    expect(snapshot.topLine).toBe(3)
    expect(snapshot.topOffset).toBe(DOC.indexOf('\\begin{document}'))
    expect(snapshot.docLength).toBe(DOC.length)
  })

  it('clamps a reported column past the end of its line', () => {
    const snapshot = createSnapshot(DOC, {
      anchor: { line: 4, column: 200 },
      head: { line: 4, column: 200 },
      topLine: 40,
    })
    // Line four is "Line four" (9 characters), so the caret lands at its end…
    expect(snapshot.anchorPosition).toEqual({ line: 4, column: 10 })
    // …and a top line past the last one lands on the last line.
    expect(snapshot.topLine).toBe(countLines(DOC))
  })

  it('builds the same snapshot from offsets as from line/column', () => {
    const start = DOC.indexOf('Line five')
    const fromPositions = createSnapshot(DOC, {
      anchor: { line: 5, column: 3 },
      head: { line: 3, column: 1 },
      topLine: 4,
    })
    const fromOffsets = createSnapshotFromOffsets(DOC, {
      anchor: start + 2,
      head: DOC.indexOf('\\begin{document}'),
      topOffset: DOC.indexOf('Line four'),
    })

    expect(fromOffsets).toEqual(fromPositions)
  })

  it('maps offsets through a change before the offset', () => {
    // Insert 2 characters at 0: an offset of 5 becomes 7.
    expect(mapOffsetThroughChange(5, { from: 0, to: 0, insertLength: 2 })).toBe(7)
    // Delete 3 characters at 0: an offset of 5 becomes 2.
    expect(mapOffsetThroughChange(5, { from: 0, to: 3, insertLength: 0 })).toBe(2)
  })

  it('maps offsets through a change after the offset', () => {
    expect(mapOffsetThroughChange(2, { from: 5, to: 6, insertLength: 9 })).toBe(2)
  })

  it('collapses an offset inside the replaced range to the end of the insert', () => {
    expect(mapOffsetThroughChange(4, { from: 2, to: 8, insertLength: 1 })).toBe(3)
  })

  it('maps a sequence of changes in order', () => {
    const changes = [
      { from: 0, to: 0, insertLength: 1 },
      { from: 4, to: 4, insertLength: 1 },
    ]
    // 0-based: offset 3 -> 4 after the first insert, then unchanged.
    expect(mapOffsetThroughChanges(3, changes)).toBe(4)
  })

  it('carries a snapshot across an edit made in the other editor', () => {
    const before = 'abc'
    const after = 'aXbc'
    const snapshot = createSnapshot(before, {
      anchor: { line: 1, column: 3 },
      head: { line: 1, column: 4 },
      topLine: 1,
    })
    const carried = carrySnapshotThroughChanges(
      snapshot,
      [{ from: 1, to: 1, insertLength: 1 }],
      after
    )
    expect(carried.anchor).toBe(3)
    expect(carried.head).toBe(4)
    expect(carried.anchorPosition).toEqual({ line: 1, column: 4 })
    expect(carried.headPosition).toEqual({ line: 1, column: 5 })
    expect(carried.docLength).toBe(after.length)
  })

  it('drags the top line along when an edit lands above the viewport', () => {
    const before = ['one', 'two', 'three'].join('\n')
    const after = ['zero', 'one', 'two', 'three'].join('\n')
    const snapshot = createSnapshot(before, {
      anchor: { line: 3, column: 1 },
      head: { line: 3, column: 1 },
      topLine: 3,
    })

    const carried = carrySnapshotThroughChanges(
      snapshot,
      [{ from: 0, to: 0, insertLength: 5 }],
      after
    )
    // The viewport was on "three", which is now line 4 — and it stays there.
    expect(carried.topLine).toBe(4)
    expect(carried.topOffset).toBe(after.indexOf('three'))
    expect(carried.anchorPosition).toEqual({ line: 4, column: 1 })
  })

  it('clamps a carried snapshot when the document shrank', () => {
    const snapshot = createSnapshot('0123456789', {
      anchor: { line: 1, column: 8 },
      head: { line: 1, column: 9 },
      topLine: 1,
    })
    const carried = carrySnapshotThroughChanges(
      snapshot,
      [{ from: 0, to: 8, insertLength: 0 }],
      '89'
    )
    // Both selection ends were inside the deleted range, so they collapse to
    // its start and are clamped into what is left.
    expect(carried.anchor).toBe(0)
    expect(carried.head).toBe(0)
    expect(carried.docLength).toBe(2)
  })

  it('round-trips through its serialized form', () => {
    const snapshot = createSnapshot(DOC, {
      anchor: { line: 4, column: 6 },
      head: { line: 5, column: 2 },
      topLine: 3,
    })
    const restored = deserializeSnapshot(serializeSnapshot(snapshot), DOC)
    expect(restored).toEqual(snapshot)
    // The line-based facts survive verbatim.
    expect(serializeSnapshot(snapshot).tl).toBe(3)
    expect(restored.anchorPosition).toEqual({ line: 4, column: 6 })
    expect(restored.headPosition).toEqual({ line: 5, column: 2 })

    expect(deserializeSnapshot(undefined, DOC)).toEqual(emptySnapshot(DOC.length))
  })

  it('re-derives the top offset against the document it is restored into', () => {
    const snapshot = createSnapshot(DOC, {
      anchor: { line: 4, column: 1 },
      head: { line: 4, column: 1 },
      topLine: 4,
    })
    const serialized = serializeSnapshot(snapshot)
    // Same document: the offset matches the line exactly.
    expect(deserializeSnapshot(serialized, DOC).topOffset).toBe(DOC.indexOf('Line four'))

    // A shorter document: the stored length is stale, so the top line is
    // clamped and the offset recomputed rather than trusted.
    const shorter = 'a\nb'
    const restored = deserializeSnapshot(serialized, shorter)
    expect(restored.topLine).toBe(countLines(shorter))
    expect(restored.topOffset).toBe(shorter.indexOf('b'))
  })

  it('compares snapshots logically', () => {
    const base = createSnapshot(DOC, {
      anchor: { line: 4, column: 1 },
      head: { line: 4, column: 1 },
      topLine: 1,
    })
    expect(snapshotsEqual(base, { ...base, docLength: 999 })).toBe(true)
    expect(
      snapshotsEqual(base, { ...base, topLine: 3 })
    ).toBe(false)
    expect(
      snapshotsEqual(base, {
        ...base,
        anchor: base.anchor + 1,
        anchorPosition: { line: 4, column: 2 },
        head: base.anchor + 1,
        headPosition: { line: 4, column: 2 },
      })
    ).toBe(false)
  })

  it('puts the recorded top line back, at the top or not', () => {
    const scrolled = createSnapshot(DOC, {
      anchor: { line: 5, column: 1 },
      head: { line: 5, column: 1 },
      topLine: 3,
    })
    expect(scrollLineFor(scrolled)).toBe(3)

    // A caret below the fold with the viewport at the top stays at the top: the
    // recorded line is where the user was, and a mode switch keeps it there. The
    // caret is not lost — the host brings it back on screen with the smallest
    // scroll that does, which moves the viewport only when the caret is actually
    // outside it, rather than always jumping the viewport to the caret's line.
    const atTop = createSnapshot(DOC, {
      anchor: { line: 4, column: 1 },
      head: { line: 4, column: 1 },
      topLine: 1,
    })
    expect(scrollLineFor(atTop)).toBe(1)
  })

  it('stores one snapshot per document', () => {
    const store = new ModeSwitchStore()
    const a = createSnapshot('0123456789', {
      anchor: { line: 1, column: 6 },
      head: { line: 1, column: 6 },
      topLine: 1,
    })
    const b = createSnapshot('0123456789', {
      anchor: { line: 1, column: 2 },
      head: { line: 1, column: 2 },
      topLine: 1,
    })
    store.save('a.tex', a)
    store.save('b.tex', b)

    expect(store.load('a.tex', '0123456789')).toEqual(a)
    expect(store.load('b.tex', '0123456789')).toEqual(b)
    expect(store.load('missing.tex', '0123456789')).toEqual(emptySnapshot(10))

    store.clear('a.tex')
    expect(store.has('a.tex')).toBe(false)
    expect(store.has('b.tex')).toBe(true)
  })

  it('re-anchors a stored snapshot at its line when the document changed', () => {
    const store = new ModeSwitchStore()
    // Two lines are appended while neither editor is showing the document.
    const longer = `${DOC}\nA new last line\nAnd another`
    const snapshot = createSnapshot(DOC, {
      anchor: { line: 4, column: 6 },
      head: { line: 4, column: 6 },
      topLine: 4,
    })
    store.save('doc', snapshot)

    // Same length: the offsets are taken as they are.
    expect(store.load('doc', DOC)).toEqual(snapshot)

    // Different length: the caret goes back to the line and column it was at,
    // and the top line is kept.
    const restored = store.load('doc', longer)
    expect(restored.anchorPosition).toEqual({ line: 4, column: 6 })
    expect(restored.anchor).toBe(DOC.indexOf('Line four') + 5)
    expect(restored.topLine).toBe(4)
    expect(restored.topOffset).toBe(DOC.indexOf('Line four'))

    // A document that shrank below the stored line clamps to its last (only)
    // line, which is where the caret and the viewport land.
    const shorter = 'only one line'
    const clamped = store.load('doc', shorter)
    expect(clamped.anchorPosition.line).toBe(1)
    expect(clamped.topLine).toBe(1)
    expect(clamped.topOffset).toBe(0)
    // Column 6 on line 1 is the sixth character of the surviving line.
    expect(clamped.anchorPosition.column).toBe(6)
    expect(clamped.anchor).toBe(5)
    expect(clamped.anchor).toBeLessThanOrEqual(shorter.length)
  })

  it('uses a stable key for untitled buffers', () => {
    expect(modeSwitchKey(null)).toBe('untitled')
    expect(modeSwitchKey('D:/p/a.tex')).toBe('D:/p/a.tex')
    expect(modeSwitchStore).toBeInstanceOf(ModeSwitchStore)
  })
})

/**
 * A stand-in for the two editors.
 *
 * `CodeSurface` behaves like Monaco and `VisualSurface` like CodeMirror, in the
 * only respect the hand-off cares about: both hold the *same* text, both read
 * their position from it as 1-based line/column plus a top visible line, and
 * neither one ever rewrites the document to move a cursor. A round trip is then
 * a plain sequence of captures and restores, which is exactly what the two
 * components do on unmount and mount.
 */
class Surface {
  public caret: { line: number; column: number }
  public topLine = 1
  public replacements: { from: number; to: number; insert: string }[] = []

  constructor(
    private text: string,
    caret: { line: number; column: number },
    private readonly key: string,
    private readonly store: ModeSwitchStore
  ) {
    this.caret = caret
  }

  public getText(): string {
    return this.text
  }

  /** Leaving this mode: record where the user is, in line-based terms. */
  public unmount(): void {
    const before = this.text
    const snapshot = createSnapshot(this.text, {
      anchor: this.caret,
      head: this.caret,
      topLine: this.topLine,
    })
    this.store.save(this.key, snapshot)
    // Capturing a position must never touch the document.
    expect(this.text).toBe(before)
  }

  /** Entering this mode: adopt the stored position, without rewriting text. */
  public mount(): void {
    const snapshot = this.store.load(this.key, this.text)
    this.caret = snapshot.headPosition
    this.topLine = snapshotsEqual(snapshot, emptySnapshot(this.text.length))
      ? 1
      : scrollLineFor(snapshot)
  }

  /** A minimal range replacement, reported exactly as `applyChange` does. */
  public applyChange(change: { from: number; to: number; insert: string }): void {
    this.replacements.push(change)
    this.text = this.text.slice(0, change.from) + change.insert + this.text.slice(change.to)
    this.caret = positionAtOffset(this.text, change.from + change.insert.length)
  }
}

describe('mode round trip (Instructions.md §28)', () => {
  const DOC = [
    '\\documentclass{article}',
    '',
    '\\begin{document}',
    '\\section{One}',
    'Text on line five.',
    'More text on line six.',
    '\\end{document}',
  ].join('\n')

  const CARET = { line: 6, column: 8 }

  it('leaves the text byte-identical through Code → Visual → Code → Visual', () => {
    const store = new ModeSwitchStore()
    const key = modeSwitchKey('D:/project/homework.tex')

    // Code Mode is showing, with the user parked on line 6 and scrolled down.
    const code = new Surface(DOC, CARET, key, store)
    code.topLine = 4
    const before = code.getText()

    // Code → Visual
    code.unmount()
    const visual = new Surface(before, { line: 1, column: 1 }, key, store)
    visual.mount()
    expect(visual.caret).toEqual({ line: 6, column: 8 })
    expect(visual.topLine).toBe(4)
    expect(visual.getText()).toBe(before)

    // Visual → Code
    visual.unmount()
    const code2 = new Surface(visual.getText(), { line: 1, column: 1 }, key, store)
    code2.mount()
    expect(code2.caret).toEqual({ line: 6, column: 8 })
    expect(code2.topLine).toBe(4)
    expect(code2.getText()).toBe(before)

    // Code → Visual again
    code2.unmount()
    const visual2 = new Surface(code2.getText(), { line: 1, column: 1 }, key, store)
    visual2.mount()

    // Byte-identical throughout: no surface rewrote the document, and no edit
    // was reported.
    expect(visual2.getText()).toBe(DOC)
    expect(visual2.getText()).toBe(before)
    expect(visual2.caret).toEqual({ line: 6, column: 8 })
    expect([
      ...code.replacements,
      ...visual.replacements,
      ...code2.replacements,
      ...visual2.replacements,
    ]).toEqual([])
  })

  it('records and restores the top visible line, not a character offset', () => {
    const store = new ModeSwitchStore()
    const key = modeSwitchKey(null)
    const code = new Surface(DOC, { line: 7, column: 1 }, key, store)
    code.topLine = 5
    code.unmount()

    const snapshot = store.load(key, DOC)
    expect(snapshot.topLine).toBe(5)
    expect(snapshot.topOffset).toBe(lineStartOffset(DOC, 5))
    expect(snapshot.anchorPosition).toEqual({ line: 7, column: 1 })
    expect(snapshot.headPosition).toEqual({ line: 7, column: 1 })
  })

  it('keeps the line when the document changed underneath the hand-off', () => {
    const store = new ModeSwitchStore()
    const key = modeSwitchKey('D:/project/homework.tex')
    const code = new Surface(DOC, { line: 6, column: 8 }, key, store)
    code.topLine = 5
    code.unmount()

    // A line is inserted above everything while neither editor is showing.
    const edited = `% a new comment\n${DOC}`
    const visual = new Surface(edited, { line: 1, column: 1 }, key, store)
    visual.mount()

    // The stored length no longer matches, so the caret is re-anchored at the
    // line/column the user last saw rather than at a stale offset…
    expect(visual.caret).toEqual({ line: 6, column: 8 })
    expect(visual.topLine).toBe(5)
    // …and the document is still the host's, untouched by the hand-off.
    expect(visual.getText()).toBe(edited)
  })
})

describe('figures.ts — minimal figure option edits', () => {
  const figureDoc = [
    '\\begin{figure}',
    '  \\centering',
    '  \\includegraphics[width=0.5\\textwidth]{plot.png}',
    '  \\caption{Old caption}',
    '  \\label{fig:old}',
    '\\end{figure}',
  ].join('\n')

  /** Resolves the figure environment and the ported `FigureData` for a doc. */
  const figureOf = (doc: string) => {
    const state = createState(doc)
    let figureNode: SyntaxNode | null = null
    syntaxTree(state).iterate({
      enter(node) {
        if (node.type.is('FigureEnvironment')) {
          figureNode = node.node
          return false
        }
      },
    })
    if (!figureNode) throw new Error('no figure environment in test document')
    const figure = parseFigureData(figureNode, state)
    if (!figure) throw new Error('parseFigureData returned null')
    return { state, figure }
  }

  const applyEdits = (
    state: EditorState,
    edits: { from: number; to: number; insert: string }[]
  ) => {
    let text = state.doc.toString()
    for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
      text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
    }
    return text
  }

  it('formats widths as \\textwidth multiples', () => {
    expect(formatWidth(0.25)).toBe('0.25\\textwidth')
    expect(formatWidth(0.5)).toBe('0.5\\textwidth')
    expect(formatWidth(1)).toBe('\\textwidth')
    expect(formatWidth(0.755)).toBe('0.76\\textwidth')
    expect(formatWidth(0.01)).toBe('0.05\\textwidth')
  })

  it('changes only the width option and leaves the rest of the figure intact', () => {
    const { state, figure } = figureOf(figureDoc)
    const edits = computeFigureEdits(state, figure, { width: 0.75 })

    expect(edits).toHaveLength(1)
    const next = applyEdits(state, edits)
    expect(next).toContain('\\includegraphics[width=0.75\\textwidth]{plot.png}')
    expect(next).toContain('\\caption{Old caption}')
    expect(next).toContain('\\label{fig:old}')
    expect(next.replace('width=0.75\\textwidth', 'width=0.5\\textwidth')).toBe(
      figureDoc
    )
  })

  it('changes only the caption text', () => {
    const { state, figure } = figureOf(figureDoc)
    const edits = computeFigureEdits(state, figure, { caption: 'New caption' })
    const next = applyEdits(state, edits)

    expect(next).toContain('\\caption{New caption}')
    expect(next).toContain('\\includegraphics[width=0.5\\textwidth]{plot.png}')
    expect(next).toContain('\\label{fig:old}')
  })

  it('changes only the label text', () => {
    const { state, figure } = figureOf(figureDoc)
    const edits = computeFigureEdits(state, figure, { label: 'fig:new' })
    const next = applyEdits(state, edits)

    expect(next).toContain('\\label{fig:new}')
    expect(next).toContain('\\caption{Old caption}')
  })

  it('produces no edits when the requested options are unchanged', () => {
    const { state, figure } = figureOf(figureDoc)
    const edits = computeFigureEdits(state, figure, {
      width: 0.5,
      caption: 'Old caption',
      label: 'fig:old',
    })
    expect(edits).toEqual([])
  })
})

describe('caretAppearance — Visual Mode reads the same caret settings as Code Mode', () => {
  it('normalizes `editor.cursorBlinking` the way Monaco does', () => {
    expect(normalizeCursorBlinking('blink')).toBe('blink')
    expect(normalizeCursorBlinking('smooth')).toBe('smooth')
    expect(normalizeCursorBlinking('phase')).toBe('phase')
    expect(normalizeCursorBlinking('expand')).toBe('expand')
    expect(normalizeCursorBlinking('solid')).toBe('solid')
    // Monaco falls back to its own default for an unknown value.
    expect(normalizeCursorBlinking('nonsense')).toBe('blink')
  })

  it('never animates a solid caret and always animates a blinking one', () => {
    // `draw-selection.ts` only ever writes these two names, so they are the
    // whole surface the stylesheet has to cover.
    expect(caretAnimationName('solid')).toBe('none')
    expect(caretAnimationName('blink')).toBe('cm-blink')
    expect(caretAnimationName('smooth')).toBe('cm-blink')
    expect(caretAnimationName('phase')).toBe('cm-blink')
    expect(caretAnimationName('expand')).toBe('cm-blink')
  })

  it('exposes the settings as data attributes for the stylesheet', () => {
    expect(caretDataAttributes({ cursorBlinking: 'phase', smoothCaret: true })).toEqual({
      'data-caret-blinking': 'phase',
      'data-caret-smooth': 'on',
    })
    expect(caretDataAttributes({ cursorBlinking: 'solid', smoothCaret: false })).toEqual({
      'data-caret-blinking': 'solid',
      'data-caret-smooth': 'off',
    })
    expect(
      caretDataAttributes({ cursorBlinking: 'nonsense', smoothCaret: false })[
        'data-caret-blinking'
      ]
    ).toBe('blink')
  })

  it('marks the live editor and starts its cursor layer animating', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    const view = new EditorView({
      state: EditorState.create({
        doc: 'one\ntwo\nthree',
        extensions: [caretAppearance({ cursorBlinking: 'smooth', smoothCaret: true })],
      }),
      parent: host,
    })

    try {
      // The attributes the stylesheet keys off are on the editor element, which
      // is what lets one stylesheet cover every mode.
      expect(view.dom.getAttribute('data-caret-blinking')).toBe('smooth')
      expect(view.dom.getAttribute('data-caret-smooth')).toBe('on')

      // CodeMirror's own `drawSelection` writes this property from `mount`;
      // the vendored copy omits that call, so the extension has to.
      const layer = view.dom.querySelector<HTMLElement>('.cm-cursorLayer')
      if (layer) expect(layer.style.animationName).toBe('cm-blink')
    } finally {
      view.destroy()
      host.remove()
    }
  })

  it('starts a solid caret with no animation at all', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    const view = new EditorView({
      state: EditorState.create({
        doc: 'one',
        extensions: [caretAppearance({ cursorBlinking: 'solid', smoothCaret: false })],
      }),
      parent: host,
    })

    try {
      expect(view.dom.getAttribute('data-caret-blinking')).toBe('solid')
      expect(view.dom.getAttribute('data-caret-smooth')).toBe('off')
      const layer = view.dom.querySelector<HTMLElement>('.cm-cursorLayer')
      if (layer) expect(layer.style.animationName).toBe('none')
    } finally {
      view.destroy()
      host.remove()
    }
  })
})
