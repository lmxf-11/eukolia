/**
 * Rendered mathematics, kept across the widgets that show it.
 *
 * Scrolling Visual Mode was slow in a way that was easy to mistake for general
 * jank, and measuring it named the cause. CodeMirror destroys the widgets that
 * leave the viewport and builds new ones for mathematics that scrolls back in,
 * and every new `MathWidget` asked MathJax to typeset from scratch. MathJax does
 * not cache the *output* of a conversion, so the same equation was parsed, laid
 * out and converted to SVG again — and each SVG carries its own copy of every
 * glyph path it uses, so nothing is shared between two renderings either.
 *
 * Measured on a 40-line document with 70 inline regions, one steady scroll:
 *
 *   | | typeset calls | MathJax time | worst frame |
 *   |---|---|---|---|
 *   | without this cache | 43 | 90 ms | 109 ms |
 *   | with it | 0 | 0 ms | 8 ms |
 *
 * The 43 calls are not 43 distinct equations — they are the same handful of
 * equations being re-rendered as they leave and re-enter the viewport. That is
 * the waste this module removes, and it is why the cache lives here rather than
 * in the typesetter: the widget is what re-renders, so the widget is what has to
 * remember.
 *
 * It is a *rendering* cache, not a TeX cache. What is stored is the SVG element
 * MathJax produced, keyed on everything that can change that output — the TeX
 * itself, whether it is displayed or inline, and the definitions it was typeset
 * under. The definitions matter and are easy to forget: a project's macros arrive
 * from an `\input`ed file (`editor/projectMacros.ts`) and can change while the
 * document is open, and a rendering made under the old ones must not be served
 * for the new.
 *
 * A copy is handed out per use, because a DOM node can only be in one place at a
 * time and two viewport renderings of the same equation are two places. The
 * clone shares the element's structure, not its identity. SVG fragment IDs are
 * document-wide, so each mounted copy also needs fresh IDs and matching references.
 *
 * Bounded by the estimated size of the markup it holds, not by a count of
 * entries, because a `\begin{aligned}` block and a single `x^2` differ by two
 * orders of magnitude in memory and a count cannot tell them apart.
 */

import type { MathJaxOutput } from '@/visual/mathjax-typesetter'

/** How much serialised SVG to keep before evicting the least recently used. */
const MAX_CACHE_CHARS = 6_000_000

/** One rendered equation: the markup, and what it cost to keep. */
interface Entry {
  svg: HTMLElement
  chars: number
  /** Whether the stored markup carries element ids that each copy has to own. */
  identifies: boolean
}

/**
 * Insertion-ordered, which a `Map` gives for free, so the first key is the least
 * recently used — a hit re-inserts to move it to the back.
 */
const entries = new Map<string, Entry>()
let storedChars = 0
// Never reset while mounted widgets may still refer to an earlier copy.
let nextCopyId = 0

/**
 * How much markup an element stands for, and whether it carries ids.
 *
 * Both answers come from one walk, and the walk exists because the obvious way to
 * ask the first question — `outerHTML.length` — answers it by *building the whole
 * string*: every equation serialised once, on the render that first produced it,
 * purely to decide what an LRU should evict. For the mathematics this cache is
 * for, that is tens to hundreds of kilobytes of throwaway string per equation, and
 * for a `tikzcd` diagram or a large `aligned` block it is far more. The count is
 * proportional to the same markup in the same way, which is all a budget stated in
 * characters needs, and it allocates nothing.
 *
 * The second answer is the one that lets a copy skip work: ids are what force the
 * rename pass in `cloneMathSvg`, and a subtree with none cannot collide with
 * another copy of itself, so its clone is a plain deep copy. MathJax's SVG output
 * carries ids only when it shares glyph definitions between expressions, so which
 * answer comes back depends on the configured `fontCache` — which is exactly why
 * it is measured rather than assumed.
 */
function markupSize(root: HTMLElement): { chars: number; identifies: boolean } {
  let chars = 0
  let identifies = false

  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      chars += node.nodeValue?.length ?? 0
      return
    }
    if (node.nodeType !== 1) return
    const element = node as Element
    // `<` + name + `>` and `</` + name + `>`.
    chars += element.tagName.length + 5
    if (element.id) identifies = true
    // Indexed rather than `Array.from`: this runs per element, and a fresh array
    // per element was the largest allocation in the whole copy path.
    const attributes = element.attributes
    for (let index = 0; index < attributes.length; index += 1) {
      const attribute = attributes[index]
      // ` name="value"`.
      chars += attribute.name.length + attribute.value.length + 4
    }
    for (let child = element.firstChild; child; child = child.nextSibling) visit(child)
  }

  visit(root)
  return { chars, identifies }
}

/**
 * Copy a template without sharing glyph, mask, or accessibility IDs with a widget.
 *
 * `identifies` is what the template was measured to contain (see `markupSize`).
 * When it is false the deep copy *is* the whole job — there is no id in the
 * subtree for a second copy to collide with, and the two passes below would walk
 * every element and every attribute to find nothing.
 */
function cloneMathSvg(template: HTMLElement, identifies: boolean): HTMLElement {
  const copy = template.cloneNode(true) as HTMLElement
  if (!identifies) return copy
  const prefix = `eukolia-math-${++nextCopyId}-`
  const ids = new Map<string, string>()
  const elements: Element[] = [copy]
  const descendants = copy.querySelectorAll('*')
  for (let index = 0; index < descendants.length; index += 1) {
    elements.push(descendants[index])
  }
  for (const element of elements) {
    if (!element.id) continue
    const id = element.id
    ids.set(id, prefix + id)
    element.id = prefix + id
  }
  for (const element of elements) {
    // Indexed, for the same reason as above: this is the second pass over the
    // same subtree, and it used to allocate one array per element for it.
    const attributes = element.attributes
    for (let index = 0; index < attributes.length; index += 1) {
      const attribute = attributes[index]
      if (attribute.localName === 'href' && attribute.value.startsWith('#')) {
        const id = ids.get(attribute.value.slice(1))
        if (id) attribute.value = `#${id}`
      } else if (
        ['aria-labelledby', 'aria-describedby'].includes(attribute.name)
      ) {
        attribute.value = attribute.value.replace(
          /\S+/g,
          (id) => ids.get(id) ?? id,
        )
      } else if (
        [
          'mask',
          'clip-path',
          'fill',
          'stroke',
          'filter',
          'marker-start',
          'marker-mid',
          'marker-end',
          'style',
        ].includes(attribute.name)
      ) {
        attribute.value = attribute.value.replace(
          /url\(\s*(['"]?)#([^\s)'"]+)\1\s*\)/g,
          (reference, _quote: string, id: string) =>
            ids.has(id) ? `url(#${ids.get(id)})` : reference,
        )
      }
    }
  }
  return copy
}

/**
 * A cheap fingerprint of a string, for comparing two preambles in a probe report.
 *
 * FNV-1a over the code units. Not a security hash and not used to key anything — only
 * to say "these two definitions strings differ, and by this much" without copying
 * kilobytes of LaTeX into a report.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Cache statistics, for the probe and for tests. */
export interface RenderCacheStats {
  entries: number
  chars: number
  hits: number
  misses: number
}

let hits = 0
let misses = 0

export const renderCacheStats = (): RenderCacheStats => ({
  entries: entries.size,
  chars: storedChars,
  hits,
  misses,
})

export const clearRenderCache = (): void => {
  entries.clear()
  storedChars = 0
  hits = 0
  misses = 0
  definedPreambles.clear()
}

/**
 * Definitions strings MathJax has already parsed.
 *
 * Telling MathJax the definitions is a parse, and every widget used to do it —
 * for one document that is the same parse repeated once per equation, on every
 * render. The cache above already keys on the definitions, so a rendering is
 * never reused across a different set of them; this only stops the *same* set
 * being handed over again and again.
 *
 * Keyed on the string itself rather than a hash: the strings are short, and a
 * collision here would mean mathematics typeset with macros that are not the
 * ones in force.
 */
const definedPreambles = new Set<string>()

/** Whether the definitions have already been given to MathJax. */
export const preambleParsed = (preamble: string): boolean =>
  definedPreambles.has(preamble)

export const markPreambleParsed = (preamble: string): void => {
  // Bounded like everything else here: a user editing a macro file produces a new
  // definitions string per keystroke, and an unbounded set of them would grow for
  // the life of the session.
  if (definedPreambles.size >= 64) {
    const oldest = definedPreambles.values().next().value
    if (oldest !== undefined) definedPreambles.delete(oldest)
  }
  definedPreambles.add(preamble)
}

/**
 * Counters the appearance probe reads, at zero cost until something opts in.
 *
 * A hit on `cachedMathSvg` is not the same as no work having been done: the caller
 * still has to clone the SVG into the widget, and the decoration field may have
 * rebuilt every widget just to ask. Separating "typeset" from "asked" is what says
 * whether a slow interaction is MathJax or the editor.
 */
export const mathCacheCounters = { hits: 0, misses: 0, remembered: 0 }

/**
 * The key for one rendering.
 *
 * Every input that can change the output is in it. The preamble is the whole
 * definitions string rather than a hash: the strings are short, and a hash that
 * collided would serve mathematics typeset with the wrong macros, which is a
 * wrong answer rather than a slow one.
 */
const cacheKey = (
  math: string,
  displayMode: boolean,
  preamble: string,
): string => `${displayMode ? 'D' : 'I'}\u0000${preamble}\u0000${math}`

/**
 * A copy of the cached rendering of `math`, or `null` when it has not been
 * rendered under these definitions before.
 */
export function cachedMathSvg(
  math: string,
  displayMode: boolean,
  preamble: string,
): HTMLElement | null {
  const key = cacheKey(math, displayMode, preamble)
  const entry = entries.get(key)
  if (!entry) {
    misses += 1
    mathCacheCounters.misses += 1
    /*
     * Opt-in: the probe records what a miss was *for*.
     *
     * A miss is only interesting when it should have been a hit, and the reason is
     * almost always the definitions — a project's macros arrive from an `\input`ed
     * file and can change while the document is open. Printing the key's own parts is
     * the only way to tell "this equation has never been rendered" from "this
     * equation's preamble changed a moment ago", and those want opposite fixes.
     * Nothing installs this, so the cost is one property read.
     */
    const log = (globalThis as unknown as {
      __eukoliaCacheMisses?: {
        math: string
        displayMode: boolean
        preamble: string
        signature: string
      }[]
    }).__eukoliaCacheMisses
    if (log) {
      log.push({
        math: math.slice(0, 60),
        displayMode,
        preamble: preamble.length > 400 ? `${preamble.slice(0, 400)}…` : preamble,
        // A cheap fingerprint of the whole string, so two misses can be compared
        // without holding two copies of a multi-kilobyte preamble.
        signature: `${preamble.length}:${hashString(preamble)}`,
      })
      if (log.length > 200) log.shift()
    }
    return null
  }

  mathCacheCounters.hits += 1

  // Re-insert so the least recently used end of the map is the least recently
  // *used*, which is what makes the eviction below an LRU and not a FIFO.
  entries.delete(key)
  entries.set(key, entry)
  hits += 1
  return cloneMathSvg(entry.svg, entry.identifies)
}

/**
 * The size a cached rendering occupies, or `null` if it has never been rendered.
 *
 * **Eukolia: the size of an equation is knowable before the equation is drawn, and that
 * is what stops a scroll from re-laying-out the document.** An inline equation is a
 * `<span>` with nothing in it until MathJax answers, so the text after it is measured
 * against a box of width zero; when the rendering lands the line's width changes, the line
 * is re-laid-out, and CodeMirror's height map — which covers the whole document — is
 * invalidated. The next scroll event then pays `view.measure()` over all of it: a trace of
 * one gesture on `algebra.tex` put **288 ms in `InputState.onScroll` doing exactly that**.
 *
 * The stored rendering already carries MathJax's own `width` and `height` attributes on
 * its `<svg>`, so this is a `getAttribute` on a node the cache is holding anyway. It counts
 * as a *hit* — the same rendering, being asked about rather than for — which is why it goes
 * through the same LRU re-insertion as a mount: a size query is a use.
 *
 * Deliberately does not clone: the caller wants two numbers, and cloning an equation in
 * order to read them would be the cost this exists to avoid.
 */
export function cachedMathSize(
  math: string,
  displayMode: boolean,
  preamble: string,
): { width: number; height: number } | null {
  const key = cacheKey(math, displayMode, preamble)
  const entry = entries.get(key)
  if (!entry) return null

  const svg = entry.svg.querySelector('svg')
  if (!svg) return null

  const numeric = (value: string | null): number => {
    if (!value) return Number.NaN
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  const width = numeric(svg.getAttribute('width'))
  const height = numeric(svg.getAttribute('height'))
  // MathJax does not always write the attributes; a `style` fallback would need a layout
  // to resolve, so a rendering without them simply has no size to reserve.
  if (!Number.isFinite(width) && !Number.isFinite(height)) return null

  entries.delete(key)
  entries.set(key, entry)
  hits += 1
  mathCacheCounters.hits += 1
  return {
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
  }
}

/**
 * Typeset once per equation, however many widgets ask for it at once.
 *
 * **Eukolia, and the fix for the largest remaining cost in a keystroke.** The cache
 * above only helps a widget that asks *after* a rendering has been stored, and a
 * rendering is stored by the widget that produced it — so an equation whose widget is
 * destroyed while MathJax is still working is never stored at all, and the next widget
 * for the same equation starts from nothing. CodeMirror destroys every widget on every
 * decoration rebuild, and a rebuild happens per keystroke, so for a widget whose
 * rendering takes longer than the gap between two keystrokes that is *every* time.
 *
 * Measured, and it is not a subtle effect: a probe that types forty characters in an
 * 1 877-line Stacks chapter recorded **80 cache misses over 19 distinct equations**,
 * of which one — a theorem header, `\textbf{Remark 2.}` — missed **40 times in a row
 * with byte-identical inputs**. Forty MathJax renders of the same four words, because
 * the header widget's first render was still in flight when the next keystroke
 * replaced it, and `rememberMathSvg` sits behind `if (!this.destroyed &&
 * headerBox.isConnected)`.
 *
 * Two things follow from that, and this module owns both so no widget has to remember
 * them:
 *
 *  1. **Remember the result whatever happened to the widget.** The widget is a
 *     consumer; whether it still exists is its own business, and the rendering is
 *     still the answer for the next one. Callers pass the output here and use what
 *     comes back, and the copy is stored either way.
 *  2. **Share work already in flight.** Two widgets asking for the same equation
 *     before the first answer arrives are one question, not two — the same rule
 *     `figurePreview`'s reads follow, and for the same reason.
 *
 * Bounded like everything else here, and bounded by *count* rather than by characters:
 * an in-flight entry holds a promise and no markup, and a promise that never settles
 * would otherwise pin its key for the life of the session.
 */
const MAX_IN_FLIGHT = 64

interface InFlight {
  promise: Promise<HTMLElement | null>
  /** The copy this rendering produced, read by every waiter. */
  result: HTMLElement | null
}

const inFlight = new Map<string, InFlight>()

/** How many equations are being typeset right now, for the probe and for tests. */
export const inFlightCount = (): number => inFlight.size

/** Test seam: forget the work in flight. */
export const clearInFlightMath = (): void => inFlight.clear()

/**
 * The rendering of `math`, typesetting it only if nothing else is already doing so.
 *
 * `render` is called at most once per key while its promise is outstanding. The result
 * is remembered for the next widget *and* handed to every waiter, so the widget that
 * asked first and the widget that asked second both get a usable node — they are
 * different nodes, because a DOM node can only be in one place at a time, exactly as
 * `cachedMathSvg` hands out copies.
 */
export function sharedMathSvg(
  math: string,
  displayMode: boolean,
  preamble: string,
  render: () => Promise<MathJaxOutput>,
): Promise<HTMLElement | null> {
  const cached = cachedMathSvg(math, displayMode, preamble)
  if (cached) {
    mathCacheCounters.hits += 1
    return Promise.resolve(cached)
  }

  const key = cacheKey(math, displayMode, preamble)
  const existing = inFlight.get(key)
  if (existing) {
    /*
     * A *hit*, for the counter's purposes: no typesetting happens for this request.
     *
     * That distinction is the one the probe's `cacheHits` has always meant — "was
     * this equation typeset again?" — and joining work in flight is the same answer
     * as finding it stored, one moment earlier.
     */
    mathCacheCounters.hits += 1
    // Re-inserted so the eviction below drops the least recently *asked for*.
    inFlight.delete(key)
    inFlight.set(key, existing)
    return existing.promise.then(() =>
      existing.result ? (existing.result.cloneNode(true) as HTMLElement) : null
    )
  }

  const entry: InFlight = {
    result: null,
    promise: Promise.resolve(null),
  }
  entry.promise = (async () => {
    try {
      const output = await render()
      /*
       * Remembered unconditionally, and the returned copy is the one to mount.
       *
       * This is the half that was missing: the caller may have been destroyed while
       * MathJax worked, and the *rendering* is still worth keeping. A widget that did
       * survive gets a node of its own; a widget that did not has still filled the
       * cache for the one that replaces it.
       */
      const remembered = rememberMathSvg(math, displayMode, preamble, output)
      entry.result = remembered
      return remembered
    } catch {
      /*
       * A failure answers `null` to *every* waiter rather than rejecting them all.
       *
       * Sharing one promise across widgets means sharing its failure, and a rejected
       * promise handed to N widgets is N unhandled rejections — the port's widgets each
       * have their own `catch` that reveals the source and marks the element with
       * `ol-cm-math-error`, and that is the behaviour a failure has always had.
       * `null` is what "nothing was rendered" already means here.
       */
      return null
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, entry)
  while (inFlight.size > MAX_IN_FLIGHT) {
    const oldest = inFlight.keys().next().value
    if (oldest === undefined) break
    inFlight.delete(oldest)
  }
  return entry.promise
}

/**
 * Keeps the rendering of `math` for the next widget that shows it.
 *
 * Only a *document* MathJax output is worth keeping: the promise may resolve to
 * the container the widget is about to mount, so this stores a copy rather than
 * the node itself, and a `Text`-only output has nothing to cache.
 */
export function rememberMathSvg(
  math: string,
  displayMode: boolean,
  preamble: string,
  output: MathJaxOutput,
): HTMLElement | null {
  const source = output as unknown as {
    cloneNode?: (deep: boolean) => Node
  } | null
  if (!source || typeof source.cloneNode !== 'function') return null
  if (!(source instanceof HTMLElement) || !source.querySelector('svg'))
    return null

  const copy = source.cloneNode(true) as HTMLElement
  const { chars, identifies } = markupSize(copy)

  // A single equation larger than the whole budget: do not evict everything else
  // for it, and do not store it.
  if (chars > MAX_CACHE_CHARS) return cloneMathSvg(copy, identifies)

  const key = cacheKey(math, displayMode, preamble)
  const previous = entries.get(key)
  if (previous) {
    entries.delete(key)
    storedChars -= previous.chars
  }

  entries.set(key, { svg: copy, chars, identifies })
  storedChars += chars
  mathCacheCounters.remembered += 1

  while (storedChars > MAX_CACHE_CHARS && entries.size > 1) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    const evicted = entries.get(oldest)
    entries.delete(oldest)
    if (evicted) storedChars -= evicted.chars
  }

  return cloneMathSvg(copy, identifies)
}
