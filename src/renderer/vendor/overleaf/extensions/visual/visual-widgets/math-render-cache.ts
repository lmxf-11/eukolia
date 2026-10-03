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
