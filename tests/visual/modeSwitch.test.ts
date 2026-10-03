// @vitest-environment jsdom
/**
 * Switching mode holds the caret line's place in the viewport (Code Mode ⇄
 * Visual Mode).
 *
 * A mode switch is a reconfiguration of one `EditorView`, not a rebuild, so the
 * caret and the document survive it untouched — but the *viewport* needs
 * holding: CodeMirror's own measure-time anchoring is computed against line
 * heights that are still arriving, and when the viewport is scrolled away from
 * the caret it can aim past the end of the re-laid-out content and let the
 * browser clamp the result, which leaves the viewport at the end of the
 * document. Measured in the running application as a request for 389 px in a
 * 381 px scroll range.
 *
 * `switchEditorMode` therefore takes the caret line's position in the viewport
 * before the reconfiguration and re-applies it after — through CodeMirror's own
 * `EditorView.scrollSnapshot()`, whose `isSnapshot` scroll target is resolved
 * from line geometry *inside* the measure that follows, with the caret's line as
 * the anchor and `fraction × viewport height` as the margin. That is why the
 * position is a fraction of the viewport and not a top line: the two modes lay
 * the same source out at different heights.
 *
 * jsdom has no layout, so the scroller is given one: a height, because CodeMirror
 * only applies a scroll target when it has measured one, and a `scrollTop` that
 * records every write. That recording is what makes the mechanism observable —
 * with the stub metrics unchanged by the reconfiguration, the anchoring on its
 * own finds nothing to adjust and writes nothing at all.
 */
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { captureCaretViewport, caretMargin, switchEditorMode } from '@/visual/modeSwitch'
import { eukoliaEditorExtensions, isVisual } from '@/visual/editorExtensions'
import { createEditorScope, EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'

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

const DOC = Array.from({ length: 60 }, (_, index) => `Line ${index + 1}`)
  .join('\n')
  .concat('\n')

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const mount = (startVisual: boolean): EditorView => {
  const scope = createEditorScope({
    id: 'mode-switch',
    filePath: 'D:/project/homework.tex',
    projectRoot: 'D:/project',
    text: DOC,
    files: [{ path: 'D:/project/homework.tex' }],
    phrases: EUKOLIA_EDITOR_PHRASES,
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  return new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: eukoliaEditorExtensions({
        scope,
        fileName: 'homework.tex',
        theme: 'light',
        startVisual,
      }),
      selection: { anchor: DOC.indexOf('Line 16') },
    }),
    parent: host,
  })
}

/** A scroller with a height, and a `scrollTop` that records every write. */
const withLayout = (view: EditorView): { writes: number[] } => {
  const scroller = view.scrollDOM
  const writes: number[] = []
  let scrollTop = 0
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      writes.push(value)
      scrollTop = value
    },
  })
  Object.defineProperty(scroller, 'clientHeight', {
    configurable: true,
    value: 400,
  })
  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    value: 4000,
  })
  return { writes }
}

/** The line whose block sits at the given offset — the anchor line, in effect. */
const lineAt = (view: EditorView, offset: number): number =>
  view.state.doc.lineAt(offset).number

describe('switching mode', () => {
  it('reconfigures the live view rather than replacing it', () => {
    const view = mount(false)
    expect(isVisual(view)).toBe(false)

    expect(switchEditorMode(view, true)).toBe(true)
    expect(isVisual(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(DOC)

    expect(switchEditorMode(view, false)).toBe(true)
    expect(isVisual(view)).toBe(false)
    view.destroy()
  })

  it('does nothing when the editor is already in the requested mode', () => {
    const view = mount(false)
    const { writes } = withLayout(view)

    expect(switchEditorMode(view, false)).toBe(false)
    expect(writes).toEqual([])

    view.destroy()
  })

  it('holds the caret line’s place in the viewport, with one scroll write', async () => {
    const view = mount(false)
    const { writes } = withLayout(view)
    // Scroll away from the top, the way the failing case is set up: the caret's
    // line is then somewhere in the middle of the viewport rather than at the top.
    view.scrollDOM.scrollTop = 1200
    writes.length = 0
    await wait(50)

    const held = captureCaretViewport(view)
    expect(held, 'the stubbed scroller has a height, so a fraction can be taken')
      .not.toBeNull()
    expect(held!.fraction).toBeGreaterThanOrEqual(0)
    expect(held!.fraction).toBeLessThanOrEqual(1)
    expect(held!.offset).toBe(view.state.selection.main.head)

    expect(switchEditorMode(view, true)).toBe(true)
    await wait(100)

    // Exactly one write, from the snapshot's `isSnapshot` target, which the
    // switch re-points at the caret's line: CodeMirror's anchoring alone writes
    // nothing here, because the stub metrics do not change across the
    // reconfiguration (and with the snapshot removed this test fails on the
    // length). *Where* the target points is asserted in the test below, and how
    // faithfully the position survives is a property of real line heights, so it
    // is measured by the end-to-end probe rather than here — jsdom estimates a
    // document height, and loses it entirely across the reconfiguration, which
    // makes the written value meaningless.
    expect(writes).toHaveLength(1)
    expect(Number.isFinite(writes[0])).toBe(true)

    view.destroy()
  })

  it('aims the snapshot at the caret’s line, at the captured fraction', async () => {
    const view = mount(false)
    withLayout(view)
    view.scrollDOM.scrollTop = 1200
    await wait(50)

    const held = captureCaretViewport(view)!
    const height = view.scrollDOM.clientHeight

    // The scroll target is where the caret-relative position is decided, so it
    // is asserted directly: an `isSnapshot` target anchored on the caret's line,
    // with `fraction × viewport height` as the margin. `ScrollTarget` is not
    // exported by `@codemirror/view`, so the effect's own value is read.
    const effects: unknown[] = []
    const original = view.dispatch.bind(view)
    view.dispatch = ((...specs: Parameters<typeof original>) => {
      for (const spec of specs) {
        if (spec && typeof spec === 'object' && 'effects' in spec) {
          const value = (spec as { effects?: unknown }).effects
          if (Array.isArray(value)) effects.push(...value)
          else if (value) effects.push(value)
        }
      }
      return original(...specs)
    }) as typeof view.dispatch

    expect(switchEditorMode(view, true)).toBe(true)
    await wait(100)

    const targetEffects = effects.filter(
      effect =>
        typeof effect === 'object' &&
        effect !== null &&
        'value' in effect &&
        typeof (effect as { value: unknown }).value === 'object'
    ) as Array<{ value: { isSnapshot?: boolean; range?: { head: number }; yMargin?: number } }>

    const snapshot = targetEffects.find(effect => effect.value?.isSnapshot === true)
    expect(snapshot, 'the switch must dispatch a scroll snapshot').toBeDefined()
    expect(snapshot!.value.range?.head).toBe(held.offset)
    expect(snapshot!.value.yMargin).toBeCloseTo(caretMargin(held.fraction, height), 6)

    view.destroy()
  })

  it('holds it on the way back too', async () => {
    const view = mount(true)
    const { writes } = withLayout(view)
    view.scrollDOM.scrollTop = 900
    writes.length = 0
    await wait(50)

    const held = captureCaretViewport(view)
    expect(held).not.toBeNull()

    expect(switchEditorMode(view, false)).toBe(true)
    await wait(100)

    const scroller = view.scrollDOM
    expect(writes).toHaveLength(1)
    expect(Number.isFinite(writes[0])).toBe(true)

    view.destroy()
  })

  it('is a no-op on a view with no layout to read a fraction from', async () => {
    // A pane that has never been laid out — no client height — has no viewport
    // to hold, so the switch must not invent one. The caret and the document are
    // untouched either way, which is the part that matters.
    const view = mount(false)
    const scroller = view.scrollDOM
    const writes: number[] = []
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 0 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: (value: number) => writes.push(value),
    })

    expect(captureCaretViewport(view)).toBeNull()
    expect(switchEditorMode(view, true)).toBe(true)
    await wait(100)
    expect(isVisual(view)).toBe(true)
    expect(writes).toEqual([])

    view.destroy()
  })
})
