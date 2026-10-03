// @vitest-environment jsdom
/**
 * Widget heights, read once for the whole pass.
 *
 * A widget's height is part of the document's geometry — CodeMirror builds the
 * height map it reasons about scroll positions with from `estimatedHeight` — so
 * Visual Mode's mathematics measures what it rendered. Two things about *where*
 * that measurement happens are what these tests pin, and both were wrong:
 *
 *  * **The element is not in the document when `toDOM` returns.** CodeMirror
 *    attaches what `toDOM` hands back (`WidgetView.sync`: `setDOM(toDOM(view))`),
 *    so reading `offsetHeight` inside `toDOM` measured a box with no layout and
 *    answered `0` — and `0` is not "unknown", it is a claim. It went into the
 *    height map as the height of the mathematics on every line that was mounted
 *    from the render cache, which is every line of a warm scroll.
 *
 *  * **A read forces a layout.** One read per widget, inside the pass that built
 *    every widget of the newly scrolled-into viewport, is one forced layout per
 *    widget: the first flushes what the previous widget's DOM write invalidated,
 *    and the next write invalidates it again. Collecting them costs one layout for
 *    the whole viewport, and the collected reads must therefore all happen *after*
 *    the pass that wrote the elements — which is what the counters below check,
 *    since jsdom has no layout engine to observe the flush itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorView } from '@codemirror/view'

import { MathWidget } from '@/vendor/overleaf/extensions/visual/visual-widgets/math'
import { measureWidgetHeight } from '@/vendor/overleaf/extensions/visual/visual-widgets/widget-heights'
import {
  clearRenderCache,
  rememberMathSvg,
} from '@/vendor/overleaf/extensions/visual/visual-widgets/math-render-cache'

/** A minimal stand-in for what MathJax hands back: a container with an SVG. */
const rendered = (label: string): HTMLElement => {
  const container = document.createElement('mjx-container')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '2ex')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('id', `glyph-${label}`)
  svg.appendChild(path)
  container.appendChild(svg)
  return container
}

/** Every `offsetHeight` read, which in a browser is a forced layout. */
let heightReads = 0
/** What each element reports, so a measurement is observable under jsdom. */
let heights = new Map<HTMLElement, number>()

const originalOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetHeight',
)

beforeEach(() => {
  clearRenderCache()
  heightReads = 0
  heights = new Map()
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      heightReads += 1
      return heights.get(this) ?? 0
    },
  })
})

afterEach(() => {
  if (originalOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
  }
})

/** A view to hand the widgets; nothing on these paths reads the view. */
const view = (): EditorView => ({}) as EditorView

const mount = (
  math: string,
  displayMode = false,
): { widget: MathWidget; element: HTMLElement } => {
  rememberMathSvg(math, displayMode, '', rendered(math))
  const widget = new MathWidget(math, displayMode, '')
  const element = widget.toDOM(view())
  // What CodeMirror does with it, in the same task.
  document.body.append(element)
  return { widget, element }
}

describe('a widget height is read after the pass that built the widget', () => {
  it('reads nothing while the widget is being built', () => {
    const { element } = mount('x^2')
    expect(element.querySelector('svg')).not.toBeNull()
    expect(heightReads).toBe(0)
  })

  it('collects the whole viewport into one pass rather than one layout per widget', async () => {
    const widgets: Array<{ widget: MathWidget; element: HTMLElement }> = []
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      const mounted = mount(name)
      heights.set(mounted.element, 30 + widgets.length)
      widgets.push(mounted)
    }
    // Nothing was measured while any of them was built — which is the point: a
    // read inline in `toDOM` is a forced layout inside CodeMirror's own DOM pass,
    // taken once per widget of the viewport.
    expect(heightReads).toBe(0)

    await Promise.resolve()
    expect(heightReads).toBe(widgets.length)
    // Each widget recorded the height its own element reported, so collecting the
    // reads did not cost any of them its answer.
    widgets.forEach(({ widget }, index) => {
      expect(widget.estimatedHeight).toBe(30 + index)
    })
  })

  it('records the measured height, so the next estimate is the real one', async () => {
    const { widget, element } = mount('\\frac{a}{b}', true)
    heights.set(element, 63)
    await Promise.resolve()
    expect(widget.estimatedHeight).toBe(63)
  })

  it('keeps the estimate when the measured height is nothing', async () => {
    // The bug this replaces, stated as its own case: the element had no box when
    // the height was asked for, `offsetHeight` answered 0, and the widget then
    // reported 0 as its own height for the rest of its life. Zero is never a
    // useful answer for mathematics — it is the empty box, not a small one — so it
    // must not displace the estimate.
    const { widget } = mount('x')
    expect(widget.estimatedHeight).toBeGreaterThan(0)
    await Promise.resolve()
    expect(widget.estimatedHeight).toBeGreaterThan(0)
  })

  it('keeps the estimate for a displayed block, which is never zero tall', async () => {
    const { widget } = mount('\\begin{aligned}a &= b\\end{aligned}', true)
    const estimate = widget.estimatedHeight
    expect(estimate).toBeGreaterThan(0)
    await Promise.resolve()
    expect(widget.estimatedHeight).toBe(estimate)
  })

  it('skips an element that is not in the document, rather than measuring a zero', async () => {
    const element = document.createElement('span')
    const applied: number[] = []
    measureWidgetHeight(element, height => applied.push(height))
    await Promise.resolve()
    expect(applied).toEqual([])
  })

  it('measures an element once, however many widgets ask in the same pass', async () => {
    const element = document.createElement('span')
    document.body.append(element)
    const applied: number[] = []
    measureWidgetHeight(element, height => applied.push(height))
    measureWidgetHeight(element, height => applied.push(height))
    await Promise.resolve()
    expect(heightReads).toBe(1)
    expect(applied).toEqual([0])
  })
})
