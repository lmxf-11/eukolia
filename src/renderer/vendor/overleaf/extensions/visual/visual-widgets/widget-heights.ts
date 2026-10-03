/**
 * Eukolia — one layout for every widget height asked for in the same pass.
 *
 * A widget's height is not a detail of the widget: it is part of the document's
 * geometry. CodeMirror builds the height map it reasons about scroll positions
 * with from `WidgetType.estimatedHeight`, read while the lines are being
 * constructed, so a widget that can answer with what it actually measured is
 * worth more than one that answers with a guess. Visual Mode's mathematics is
 * therefore measured — see the call sites in `math.ts`.
 *
 * Two things make *where* it is measured matter.
 *
 * **A widget's element is not in the document when `toDOM` returns.** CodeMirror
 * builds the element and only then attaches it (`WidgetView.sync`:
 * `this.setDOM(this.widget.toDOM(view))`). Reading `offsetHeight` there — which is
 * what this used to do — is a measurement of a box that has no layout at all: it
 * answers `0`, and `estimatedHeight` then answered `0` with it, so every equation
 * mounted from the render cache claimed to be no taller than the line it sat in
 * and the height map was built short by exactly the mathematics on screen. The
 * height is read here instead, after the pass that built the elements has
 * finished and they are attached, which is the first moment the number exists.
 *
 * **A read forces a layout.** `replaceChildren` followed by `offsetHeight` is a
 * forced synchronous layout, and CodeMirror mounts every widget of a newly
 * scrolled-into viewport in one pass: each element's read flushed the layout the
 * previous element's write had just invalidated, so a viewport of thirty
 * equations paid thirty layouts, inside the frame that was already busy. Collecting
 * the reads and running them once, adjacent to each other with nothing written
 * between them, costs one layout for the whole viewport — the layout the first
 * read forces is still valid for the rest.
 *
 * The reads run in a microtask, which is the earliest point at which the elements
 * are attached *and* the caller's DOM work for the pass is done; it is still
 * before the frame's own layout and paint, so nothing is deferred to a later
 * frame. A widget whose element never became connected — a detached editor, a
 * viewport that moved on first — is skipped rather than measured, because the
 * only number available for it would be the misleading zero this module exists to
 * stop handing out.
 */

/** A height, once it is knowable, and who wanted it. */
type HeightSink = (height: number) => void

/**
 * The reads owed to the current pass, keyed by element so a widget that is
 * mounted twice in one pass is only measured once.
 */
let pending = new Map<HTMLElement, HeightSink>()
let scheduled = false

function flush(): void {
  scheduled = false
  // Detached before running, so a sink that mounts another widget — a
  // re-render, a decoration rebuild — does not extend the batch it is inside.
  const batch = pending
  pending = new Map()

  for (const [element, apply] of batch) {
    if (!element.isConnected) continue
    // Every read before the next write: the layout the first one forces is
    // valid for all of them, and `apply` only records a number.
    apply(element.offsetHeight)
  }
}

/**
 * Hands `apply` the element's rendered height, once the elements built in this
 * pass are in the document.
 *
 * `apply` is called at most once, and is not called at all when the element
 * never became connected — a caller must therefore treat "no answer yet" as its
 * own case rather than assuming a height arrives, which is what the widget's
 * fallback estimate is for.
 */
export function measureWidgetHeight(element: HTMLElement, apply: HeightSink): void {
  pending.set(element, apply)
  if (scheduled) return
  scheduled = true
  if (typeof queueMicrotask === 'function') queueMicrotask(flush)
  else Promise.resolve().then(flush)
}
