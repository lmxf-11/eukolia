// @vitest-environment jsdom
/**
 * Restoring the viewport when the editor is rebuilt (a mode switch, a settings
 * change, a document switch).
 *
 * This exists because of a real defect: switching mode with the viewport at the
 * **end** of the document dropped the view to the very top (`scrollTop 649 → 0`),
 * while the same code worked with the viewport at the top. The cause was not the
 * recorded position but the way it was applied — `EditorView.scrollIntoView`
 * resolves its target through `coordsAt`, which answers only for lines the view
 * has already *rendered*, and `ViewState.scrollIntoView` returns silently when it
 * gets `null`. A freshly built view has rendered the first screenful, so a target
 * near the end of the document could never be reached, and a target at the top
 * always could.
 *
 * jsdom performs no layout, so nothing here observes real scrolling. What it can
 * pin is exactly the two things that were wrong:
 *
 *  * the *offset* the restore computes for a snapshot taken with the caret and
 *    the viewport at the end of the document (the recorded line, never the
 *    caret's line and never 1); and
 *  * that the restore moves the viewport by *geometry* — `lineBlockAt(…).top` —
 *    for a line the view has not rendered, where `coordsAt` answers `null` and
 *    the `scrollIntoView` route does nothing at all.
 */
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { createSnapshot, scrollLineFor } from '@/visual/mode'
import {
  restoreOffsetFor,
  revealCaretIfOffscreen,
  scrollLineToTop,
  topVisibleLine,
} from '@/visual/scrollRestore'

// jsdom performs no layout, and CodeMirror measures text through client rects.
const rect = {
  top: 0,
  left: 0,
  bottom: 16,
  right: 100,
  width: 100,
  height: 16,
  x: 0,
  y: 0,
  toJSON: () => ({}),
}
const rectList = [rect] as unknown as DOMRectList
Range.prototype.getClientRects = () => rectList
Range.prototype.getBoundingClientRect = () => rect as DOMRect
Element.prototype.getClientRects = () => rectList

/** 65 lines, the shape the defect was measured on. */
const LINES = Array.from({ length: 65 }, (_, index) => `Line ${index + 1}`)
const DOC = `${LINES.join('\n')}\n`

/** A view whose caret sits on the last line — the end-of-document case. */
const mount = (): EditorView => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: { anchor: DOC.length - 2 },
    }),
    parent: host,
  })
}

/**
 * Gives the view a layout to reason about: jsdom has none, so `scrollTop` is
 * inert and every element is zero-sized. The scroller is given a height and a
 * `scrollTop` this test can read back, which is how "what did the restore write"
 * becomes observable without a real scroll.
 */
const withLayout = (
  view: EditorView,
  { height = 400, content = 4000 } = {}
): { written: () => number | null } => {
  const scroller = view.scrollDOM
  let written: number | null = null
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => written ?? 0,
    set: (value: number) => {
      written = value
    },
  })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: height })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: content })
  return { written: () => written }
}

/** The snapshot a mode switch records with the viewport at the bottom. */
const atBottom = (topLine: number) =>
  createSnapshot(DOC, {
    anchor: { line: LINES.length, column: 1 },
    head: { line: LINES.length, column: 1 },
    topLine,
  })

describe('the end-of-document target', () => {
  it('is the recorded top line, not the caret’s line and not the first line', () => {
    const view = mount()
    const snapshot = atBottom(40)

    const offset = restoreOffsetFor(view, snapshot)
    expect(offset).toBe(view.state.doc.line(40).from)
    expect(offset).not.toBe(view.state.doc.line(1).from)
    expect(offset).not.toBe(view.state.doc.line(LINES.length).from)

    view.destroy()
  })

  it('clamps a top line past the end of the document to the last line', () => {
    const view = mount()
    // A snapshot from a longer document, or a stale store entry: `createSnapshot`
    // clamps against the text it is given, so this is built by hand.
    const stale = { ...atBottom(40), topLine: 999 }

    expect(scrollLineFor(stale)).toBe(999)
    // The document's own last line — 66 for this text, because the trailing
    // newline is a line of its own as far as CodeMirror is concerned.
    const lastLine = view.state.doc.line(view.state.doc.lines)
    expect(restoreOffsetFor(view, stale)).toBe(lastLine.from)

    view.destroy()
  })

  it('keeps the last line itself when that is what was recorded', () => {
    const view = mount()
    expect(restoreOffsetFor(view, atBottom(LINES.length))).toBe(
      view.state.doc.line(LINES.length).from
    )
    view.destroy()
  })
})

describe('scrolling to the line', () => {
  it('moves the viewport to the line’s own geometry, unrendered or not', () => {
    const view = mount()
    const layout = withLayout(view)
    const offset = view.state.doc.line(40).from

    // The line is far outside what this view has rendered — which is the whole
    // point: `coordsAtPos` answers for rendered lines only, `coordsAtPos`
    // returning null is what makes `EditorView.scrollIntoView` give up silently.
    expect(view.coordsAtPos(offset)).toBeNull()

    const block = view.lineBlockAt(offset)
    expect(block.top).toBeGreaterThan(0)

    const target = scrollLineToTop(view, offset)
    expect(target).toBe(block.top)
    expect(layout.written()).toBe(block.top)

    view.destroy()
  })

  it('stops at the end of the scroller instead of asking for more', () => {
    const view = mount()
    // A thousand pixels of content in a four-hundred pixel viewport: the last
    // line cannot be put at the top, so the restore lands at the bottom.
    const layout = withLayout(view, { height: 400, content: 1000 })
    const offset = view.state.doc.line(LINES.length).from

    const target = scrollLineToTop(view, offset)
    expect(target).toBe(600)
    expect(layout.written()).toBe(600)

    view.destroy()
  })
})

describe('the top-visible-line rule', () => {
  // This is the rule a probe needs as much as the application does, and it is
  // easy to get wrong in a way that throws from inside CodeMirror rather than
  // returning something wrong: `lineBlockAtHeight` returns a `BlockInfo`, not an
  // offset, and `doc.lineAt(<BlockInfo>)` reads `.length` of `undefined` deep in
  // `@codemirror/state`. Every height here — including ones far past the end of
  // the content, which is what a scrolled-to-the-bottom probe measures — must
  // come back as a real line number.
  it('answers a real line for any height, including past the end', () => {
    const view = mount()
    const lines = view.state.doc.lines

    for (const height of [0, 1, 200, 1000, 100_000]) {
      const line = topVisibleLine(view, height)
      expect(Number.isInteger(line), `height ${height}`).toBe(true)
      expect(line, `height ${height}`).toBeGreaterThanOrEqual(1)
      expect(line, `height ${height}`).toBeLessThanOrEqual(lines)
    }

    expect(topVisibleLine(view, 0)).toBe(1)
    // Past the content: the last line is the topmost line on screen.
    expect(topVisibleLine(view, 100_000)).toBe(lines)

    view.destroy()
  })
})

describe('keeping the caret on screen', () => {
  it('does nothing while the caret is inside the viewport', () => {
    const view = mount()
    const layout = withLayout(view, { height: 400, content: 4000 })

    // Line 1 is visible from the top of the viewport.
    view.dispatch({ selection: { anchor: 0 } })
    expect(revealCaretIfOffscreen(view)).toBeNull()
    expect(layout.written()).toBeNull()

    view.destroy()
  })

  it('brings a caret below the viewport back with the smallest scroll', () => {
    const view = mount()
    const layout = withLayout(view, { height: 100, content: 4000 })
    const block = view.lineBlockAt(view.state.selection.main.head)

    const target = revealCaretIfOffscreen(view)
    expect(target).toBe(block.bottom - 100)
    expect(layout.written()).toBe(block.bottom - 100)

    view.destroy()
  })
})
