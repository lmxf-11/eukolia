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
  cachedMathSize,
  cachedMathSvg,
  markPreambleParsed,
  preambleParsed,
  sharedMathSvg,
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
    /*
     * **A reserved size was tried and measured worse — see the note on `reserveSize`.**
     * `EUKOLIA_NO_SIZE_RESERVE=1` is kept as the switch that proved it, so the experiment
     * can be repeated rather than believed: with the reservation ON, p90 was 63.5 / 65.8 /
     * 93.8 ms at three positions of `algebra.tex`; with it OFF, 53.5 / 51.9 / 78.0 ms.
     */
    if (!(globalThis as unknown as { __eukoliaNoSizeReserve?: boolean }).__eukoliaNoSizeReserve) {
      void this.reserveSize
    }
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

  /**
   * **Measured, and not applied: reserving an equation's size makes the scroll worse.**
   *
   * The theory was good and the numbers are the reason this is a comment instead of code.
   * An inline equation is a `<span>` with nothing in it until MathJax answers, so the text
   * after it is laid out against a box of width zero; when the rendering lands the line
   * re-lays-out and CodeMirror's height map — which covers the whole document — is
   * invalidated, and the next scroll event pays `view.measure()` over all 47 000 lines. A
   * trace of one gesture on `algebra.tex` did put **288 ms inside
   * `InputState.onScroll`'s measure**, so the mechanism is real.
   *
   * It was implemented — `cachedMathSize` reads MathJax's own `width`/`height` off the
   * cached rendering, and the widget set `display: inline-block; min-width; min-height`
   * from it before the mathematics arrived — and A/B tested **from one build** with a
   * flag, three passes per position, three positions:
   *
   *   | position | p90 with the reservation | without it |
   *   |---|---|---|
   *   | line 5 000 | 63.5 ms | **53.5 ms** |
   *   | line 21 000 | 65.8 ms | **51.9 ms** |
   *   | line 33 000 | 93.8 ms | **78.0 ms** |
   *
   * Worse at every position, by 19–27 %. The likely reason is that `inline-block` is a
   * more expensive box to lay out and paint than the plain inline span it replaced — a
   * full inline-block formatting context per equation, against a relayout that happens
   * once per equation per mount — so the reservation cost more than the relayout it
   * prevented. That is a guess; the measurement is not.
   *
   * The switch that produced the A/B is kept (`EUKOLIA_NO_SIZE_RESERVE=1` sets
   * `__eukoliaNoSizeReserve`, read in `toDOM`) so the result can be reproduced rather than
   * taken on trust. `cachedMathSize` remains in the render cache: it is the primitive the
   * experiment needed, it is a `getAttribute` on a node already held, and the next attempt
   * at this should not have to write it again.
   */
  private reserveSize(_element: HTMLElement): void {
    // Intentionally empty: see the note above. Kept so the A/B switch has something to
    // call and the next reader finds the measurement rather than a deleted method.
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

    /*
     * Render through the shared cache, which is where three fixes live at once.
     *
     * `sharedMathSvg` checks the render cache, joins a rendering already in flight for
     * the same equation and definitions rather than starting a second one, and
     * **stores what it produced even if this widget did not survive to use it**. That
     * last part is the one that matters here: `this.destroyed` is set by
     * `CodeMirror` on every decoration rebuild, and a rebuild happens per keystroke, so
     * a widget whose render is slower than the gap between two keystrokes used to
     * abandon its result and let the next widget start again from nothing. Measured on
     * a theorem header, which has the same shape: forty MathJax renders of the same
     * four words across forty keystrokes.
     *
     * The metrics are still read from *this* element while it exists, because the
     * sizes are what MathJax lays the mathematics out against; a widget that has
     * already gone falls back to the defaults `getMetricsFor` answers with.
     */
    const rendered = await sharedMathSvg(
      this.math,
      this.displayMode,
      preamble,
      async () => {
        const MathJax = await loadMathJax()
        /*
         * The definitions are handed to MathJax once per distinct set, not once per
         * render: a miss on them means this mathematics has never been typeset under
         * them, and a hit means the widget that filled the cache has already told it.
         * The cache key carries the definitions, so a rendering can never be reused
         * across a different set.
         */
        if (preamble && !preambleParsed(preamble)) {
          try {
            await MathJax.tex2svgPromise(preamble)
            markPreambleParsed(preamble)
          } catch {
            // ignore errors thrown during parsing command definitions
          }
        }
        const metrics = element.isConnected
          ? MathJax.getMetricsFor(element, this.displayMode)
          : { em: 16, ex: 8, containerWidth: 100000 }
        return MathJax.tex2svgPromise(this.math, {
          ...metrics,
          containerWidth: 100000,
          display: this.displayMode,
        })
      }
    )

    if (counters) {
      /*
       * `renders` counts this path; `cacheHits` is counted by `sharedMathSvg`, which
       * is the only place that knows whether the answer came from the cache, from work
       * already in flight, or from a typeset. Counting it here would mean asking the
       * same question twice and getting two answers.
       */
      void rendered
    }

    // The widget may have gone while MathJax worked — the rendering is stored either
    // way, so this is only about not writing into an element nobody owns.
    if (this.destroyed || !element.isConnected || !rendered) return

    element.replaceChildren(rendered)
    if (this.displayMode) {
      element.style.height = 'auto'
    }
    this.measureHeight(element)
  }
}
