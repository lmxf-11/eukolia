import { EditorSelection } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import { loadMathJax } from '@/vendor/overleaf/eukolia/load-mathjax'
import { mathAncestorNode } from '../../../utils/tree-operations/math'
import {
  getDisplayMathLineRange,
  getMathEntryStart,
  getMathEntryEnd,
} from '../visual-math-navigation'
// Eukolia: mathematics arrives asynchronously, and the editor has to be told when
// it has — see `async-widget-render.ts`.
import { refreshAfterAsyncWidgetRender } from '../async-widget-render'
import {
  cachedMathSvg,
  markPreambleParsed,
  preambleParsed,
  rememberMathSvg,
} from './math-render-cache'
import { widgetCoordsAt } from './coords'
import { measureWidgetHeight } from './widget-heights'

export class MathWidget extends WidgetType {
  destroyed = false
  cachedHeight: number | undefined = undefined

  /**
   * Records what the rendered mathematics actually occupies.
   *
   * Read where the SVG was written this would answer `0`: CodeMirror attaches the
   * element *after* `toDOM` returns, so at that moment it has no box. A height of
   * zero is worse than no height at all — it is a claim, and
   * `ContentBuilder.point` puts it in the document's height map, which is what
   * every scroll offset is derived from. `widget-heights.ts` reads it once the
   * element is attached, and once for the whole viewport rather than once per
   * widget, because each read is a forced layout.
   *
   * A zero that survives that — an element whose contents did not render — is
   * refused rather than recorded, for the same reason: no piece of mathematics is
   * zero pixels tall, so the answer is the empty box rather than a measurement, and
   * the fallback estimate is the better claim of the two.
   */
  private measureHeight(element: HTMLElement): void {
    measureWidgetHeight(element, height => {
      if (height > 0) this.cachedHeight = height
    })
  }

  constructor(
    public math: string,
    public displayMode: boolean,
    public preamble?: string
  ) {
    super()
  }

  toDOM(view: EditorView) {
    // Counted for the performance probe: how often the editor asks for fresh DOM
    // for an equation. CodeMirror owns the DOM and discards what leaves the
    // viewport, so this number is expected to be large; what matters is how it
    // compares with `renders` below.
    const toDomCounters = (globalThis as unknown as {
      __eukoliaMathCounters?: { mounts: number; renders: number; cacheHits: number }
    }).__eukoliaMathCounters
    if (toDomCounters) toDomCounters.mounts += 1
    this.destroyed = false
    const element: HTMLElement = document.createElement(
      this.displayMode ? 'div' : 'span'
    )
    element.classList.add('ol-cm-math')
    if (this.displayMode) {
      element.style.height = this.estimatedHeight + 'px'
    }

    element.addEventListener('mousedown', e => {
      const event = e as MouseEvent
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()

      const pos = view.posAtDOM(element)
      const ancestor =
        mathAncestorNode(view.state, pos, 1) ??
        mathAncestorNode(view.state, pos)
      if (!ancestor) return

      let targetPos: number
      if (this.displayMode) {
        const { firstContentLine, lastContentLine } =
          getDisplayMathLineRange(view.state, ancestor)
        const rect = element.getBoundingClientRect()
        if (rect.height > 0 && lastContentLine > firstContentLine) {
          const ratioY = Math.max(
            0,
            Math.min(1, (event.clientY - rect.top) / rect.height)
          )
          const targetLineNum = Math.min(
            lastContentLine,
            Math.max(
              firstContentLine,
              firstContentLine +
                Math.floor(ratioY * (lastContentLine - firstContentLine + 1))
            )
          )
          const targetLine = view.state.doc.line(targetLineNum)
          const ratioX =
            rect.width > 0
              ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
              : 0
          targetPos = Math.min(
            targetLine.to,
            targetLine.from + Math.round(ratioX * targetLine.length)
          )
        } else {
          targetPos = getMathEntryStart(view.state, ancestor)
        }
      } else {
        const entryStart = getMathEntryStart(view.state, ancestor)
        const entryEnd = getMathEntryEnd(view.state, ancestor)
        const rect = element.getBoundingClientRect()
        if (rect.width > 0 && entryEnd > entryStart) {
          const ratio = Math.max(
            0,
            Math.min(1, (event.clientX - rect.left) / rect.width)
          )
          targetPos = Math.round(entryStart + ratio * (entryEnd - entryStart))
        } else {
          targetPos = entryStart
        }
      }

      view.dispatch({
        selection: EditorSelection.cursor(targetPos),
        scrollIntoView: true,
      })
      view.focus()
    })

    // Eukolia: immediately insert pre-cached SVG if available so that the SVG is
    // rendered synchronously with zero delay when the caret leaves the math block.
    const preamble = this.preamble ?? ''
    const cached = cachedMathSvg(this.math, this.displayMode, preamble)
    if (cached) {
      if (toDomCounters) {
        toDomCounters.renders += 1
        toDomCounters.cacheHits += 1
      }
      element.replaceChildren(cached)
      if (this.displayMode) {
        element.style.height = 'auto'
      }
      this.measureHeight(element)
      return element
    }

    // in a timeout so the element can be rendered for metrics
    window.setTimeout(() => {
      this.renderMath(element)
        .catch(() => {
          element.classList.add('ol-cm-math-error')
        })
        .finally(() => {
          // Eukolia: the element this replaces had no box until MathJax put the
          // SVG in it, so every position on the line — and the caret drawn for
          // one — was measured against a gap. `requestMeasure` alone re-lays-out
          // the document but does not redraw the cursor layer, because that is a
          // layer whose markers only rebuild when the editor state changes. See
          // `async-widget-render.ts`.
          refreshAfterAsyncWidgetRender(view, element)
        })
    }) // TODO: re-render on element resize
    return element
  }

  eq(widget: MathWidget) {
    return (
      widget.math === this.math &&
      widget.displayMode === this.displayMode &&
      widget.preamble === this.preamble
    )
  }

  updateDOM(element: HTMLElement, view: EditorView) {
    this.destroyed = false
    const preamble = this.preamble ?? ''
    const cached = cachedMathSvg(this.math, this.displayMode, preamble)
    if (cached) {
      element.replaceChildren(cached)
      if (this.displayMode) {
        element.style.height = 'auto'
      }
      this.measureHeight(element)
      return true
    }

    this.renderMath(element)
      .catch(() => {
        element.classList.add('ol-cm-math-error')
      })
      .finally(() => {
        refreshAfterAsyncWidgetRender(view, element)
      })

    return true
  }

  ignoreEvent(event: Event) {
    if (
      event.type === 'mousedown' ||
      event.type === 'mouseup' ||
      event.type === 'click'
    ) {
      return true
    }
    return true
  }

  destroy() {
    this.destroyed = true
  }

  get estimatedHeight() {
    if (this.cachedHeight !== undefined) {
      return this.cachedHeight
    }
    if (!this.displayMode) {
      return 20
    }
    return Math.max(36, this.math.split('\n').length * 28)
  }

  coordsAt(element: HTMLElement, pos?: number, side?: number) {
    return widgetCoordsAt(element, pos, side)
  }

  async renderMath(element: HTMLElement) {
    /*
     * Counters the performance probe reads, at zero cost when nobody is looking.
     *
     * `mounts` (above) is fresh DOM the editor asked for; `renders` is how many of
     * those then needed the mathematics put into them; `cacheHits` is how many were
     * served from the render cache. The distinction is the whole question about
     * scrolling: CodeMirror owns the DOM and discards what leaves the viewport, so
     * a warm pass *should* mount — but it should be served by the cache and never
     * reach MathJax. Measured on a real paper, a warm pass over ground already
     * covered mounted 131 widgets and **rendered 131 of them**, which is what this
     * pair of counters exists to catch.
     */
    const counters = (globalThis as unknown as {
      __eukoliaMathCounters?: { mounts: number; renders: number; cacheHits: number }
    }).__eukoliaMathCounters
    if (counters) counters.renders += 1
    // Eukolia: a rendering of this equation, under these definitions, may already
    // exist from a widget that has since been scrolled out of the viewport and
    // destroyed. Mathematics is re-rendered constantly while scrolling, and
    // MathJax does not cache its own output — see `math-render-cache.ts`, which
    // is where the measurement lives.
    const preamble = this.preamble ?? ''
    const cached = cachedMathSvg(this.math, this.displayMode, preamble)
    if (cached) {
      if (counters) counters.cacheHits += 1
      element.replaceChildren(cached)
      if (this.displayMode) {
        element.style.height = 'auto'
      }
      this.measureHeight(element)
      return
    }

    const MathJax = await loadMathJax()

    // abandon if the widget has been destroyed
    if (this.destroyed) {
      return
    }

    // A miss on the definitions means the mathematics has never been rendered
    // under them, so they have to be parsed before it is. A hit on the
    // definitions — the common case while scrolling — has already been parsed by
    // the widget that filled the cache, and re-telling MathJax costs a parse per
    // render for nothing. The cache key carries the definitions, so a rendering
    // can never be reused across a different set of them.
    if (preamble && !preambleParsed(preamble)) {
      try {
        await MathJax.tex2svgPromise(preamble)
        markPreambleParsed(preamble)
      } catch {
        // ignore errors thrown during parsing command definitions
      }
    }

    // abandon if the element has been removed from the DOM
    if (!element.isConnected) {
      return
    }

    const metrics = MathJax.getMetricsFor(element, this.displayMode)
    const math = await MathJax.tex2svgPromise(this.math, {
      ...metrics,
      containerWidth: 100000,
      display: this.displayMode,
    })
    const remembered = rememberMathSvg(this.math, this.displayMode, preamble, math)
    element.replaceChildren(remembered ?? math)
    if (this.displayMode) {
      element.style.height = 'auto'
    }
    this.measureHeight(element)
  }
}
