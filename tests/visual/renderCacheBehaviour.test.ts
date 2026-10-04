// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import {
  cachedMathSvg,
  clearInFlightMath,
  clearRenderCache,
  inFlightCount,
  renderCacheStats,
  rememberMathSvg,
  sharedMathSvg,
} from '@/vendor/overleaf/extensions/visual/visual-widgets/math-render-cache'

/**
 * Does the render cache hit for the same equation, and is its key what it claims?
 *
 * The typing profile says MathJax is being asked to typeset during a keystroke burst —
 * `newcommand` in the profiler's frame is the vendored MathJax's own code — which is the
 * largest single remaining cost, and this cache exists precisely to prevent it. So
 * either a hit does not work, or the key changes when it should not.
 *
 * The cache stores **DOM**, so what it is handed here is a small `<mjx-container>`
 * built by hand rather than a real rendering: the questions are about the key, the
 * eviction and the copy, and none of them is about MathJax. (A real rendering would
 * need either the headless typesetter — which needs Node, and `rememberMathSvg` tests
 * `instanceof HTMLElement` — or a jsdom that runs the `<script>` the renderer path
 * injects, which jsdom does not.)
 */

const EQUATION = 'a_1^2 + b'
const PREAMBLE = '\\newcommand{\\R}{\\mathbb{R}}'

/**
 * A stand-in for a rendered equation.
 *
 * `identifies` gives it an `id` and a `<use href="#…">` pointing at it, which is the
 * shape MathJax produces when it shares glyph definitions inside one expression — and
 * is what makes `cloneMathSvg` take its renaming path rather than a plain deep copy.
 * The markup has to survive `cloneNode(true)`, so it is real DOM and not a stub.
 */
const rendering = (label: string, identifies = false): HTMLElement => {
  const container = document.createElement('mjx-container')
  container.setAttribute('class', 'MathJax')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  if (identifies) {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('id', `MJX-${label}`)
    path.setAttribute('d', 'M0 0L10 10Z')
    defs.appendChild(path)
    svg.appendChild(defs)
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
    use.setAttribute('href', `#MJX-${label}`)
    svg.appendChild(use)
  } else {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('data-mml-node', label)
    svg.appendChild(g)
  }
  container.appendChild(svg)
  return container as unknown as HTMLElement
}

describe('the render cache', () => {
  it('hits for the same equation, definitions and display mode', () => {
    clearRenderCache()
    rememberMathSvg(EQUATION, false, PREAMBLE, rendering('a', true) as never)
    expect(renderCacheStats().entries).toBe(1)

    const hit = cachedMathSvg(EQUATION, false, PREAMBLE)
    const stats = renderCacheStats()

    // eslint-disable-next-line no-console
    console.log(`entries ${stats.entries}, hits ${stats.hits}, misses ${stats.misses}, hit ${hit !== null}`)
    expect(hit).not.toBeNull()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(0)
  })

  it('misses for a definition set it has never seen, and for the other display mode', () => {
    clearRenderCache()
    rememberMathSvg(EQUATION, false, PREAMBLE, rendering('a', false) as never)

    // The definitions are part of the key on purpose: a rendering made under one
    // preamble must never be served for another.
    expect(cachedMathSvg(EQUATION, false, `${PREAMBLE}\n\\newcommand{\\Q}{\\mathbb{Q}}`)).toBeNull()
    // So is the display mode: the same TeX is a different rendering inline and block.
    expect(cachedMathSvg(EQUATION, true, PREAMBLE)).toBeNull()
    // And the equation itself.
    expect(cachedMathSvg('c^2 + d', false, PREAMBLE)).toBeNull()
    // While the key it was stored under still hits.
    expect(cachedMathSvg(EQUATION, false, PREAMBLE)).not.toBeNull()
  })

  it('hands out a copy, and renames the ids in it so two copies cannot collide', () => {
    clearRenderCache()
    const template = rendering('a', true)
    rememberMathSvg(EQUATION, false, PREAMBLE, template as never)

    const first = cachedMathSvg(EQUATION, false, PREAMBLE) as HTMLElement
    const second = cachedMathSvg(EQUATION, false, PREAMBLE) as HTMLElement
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    // Two copies, not the same node: a DOM node can only be in one place at a time.
    expect(first).not.toBe(second)

    const idOf = (element: HTMLElement) => element.querySelector('path')?.getAttribute('id')
    const hrefOf = (element: HTMLElement) => element.querySelector('use')?.getAttribute('href')
    // eslint-disable-next-line no-console
    console.log(
      `ids: ${idOf(first)} / ${idOf(second)}; hrefs: ${hrefOf(first)} / ${hrefOf(second)}`
    )
    expect(idOf(first)).not.toBe(idOf(second))
    // And each copy's own reference follows its own id, or the glyph is not found.
    expect(hrefOf(first)).toBe(`#${idOf(first)}`)
    expect(hrefOf(second)).toBe(`#${idOf(second)}`)
  })

  it('does not clear what it holds when another equation is remembered', () => {
    clearRenderCache()
    rememberMathSvg(EQUATION, false, PREAMBLE, rendering('a', false) as never)
    const before = renderCacheStats()
    rememberMathSvg('c^2 + d', false, PREAMBLE, rendering('c', false) as never)
    const after = renderCacheStats()

    // eslint-disable-next-line no-console
    console.log(`entries before ${before.entries}, after ${after.entries}`)
    expect(after.entries).toBe(before.entries + 1)
    expect(cachedMathSvg(EQUATION, false, PREAMBLE)).not.toBeNull()
  })
})

/**
 * The two rules that make a keystroke stop re-typesetting what is already on screen.
 *
 * Both exist because of one measured fact: a widget's element is destroyed by the
 * decoration rebuild that follows any edit, so a widget whose rendering is slower than
 * the gap between two keystrokes never lives long enough to store its own result. A
 * theorem header was typeset **forty times across forty keystrokes** for the same four
 * words.
 */
describe('sharedMathSvg', () => {
  const countRenders = () => {
    let calls = 0
    const render = async () => {
      calls += 1
      // A turn of the event loop, so two callers genuinely overlap.
      await new Promise(resolve => setTimeout(resolve, 0))
      return rendering(`shared-${calls}`, true) as never
    }
    return { render, calls: () => calls }
  }

  it('typesets once for two widgets that ask at the same time', async () => {
    clearRenderCache()
    clearInFlightMath()
    const { render, calls } = countRenders()

    const [first, second] = await Promise.all([
      sharedMathSvg(EQUATION, false, PREAMBLE, render),
      sharedMathSvg(EQUATION, false, PREAMBLE, render),
    ])

    // eslint-disable-next-line no-console
    console.log(`render calls ${calls()}, in flight after ${inFlightCount()}`)
    expect(calls()).toBe(1)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    // Copies, because a DOM node can only be in one place at a time.
    expect(first).not.toBe(second)
  })

  it('remembers the rendering even when the widget that asked for it is gone', async () => {
    clearRenderCache()
    clearInFlightMath()
    const { render, calls } = countRenders()

    /*
     * The caller here is standing in for a widget that CodeMirror destroyed while
     * MathJax worked: it does not use what it is handed. What matters is that the
     * *next* caller finds it — which is the whole of the fix, because before it the
     * result was thrown away with the widget.
     */
    await sharedMathSvg(EQUATION, false, PREAMBLE, render)
    const stored = renderCacheStats()

    const second = await sharedMathSvg(EQUATION, false, PREAMBLE, render)
    const afterSecond = renderCacheStats()

    // eslint-disable-next-line no-console
    console.log(
      `entries after first ${stored.entries}; render calls ${calls()}; ` +
        `hits ${afterSecond.hits} misses ${afterSecond.misses}`
    )
    expect(stored.entries).toBe(1)
    // One typeset in total: the second call was served from the cache.
    expect(calls()).toBe(1)
    expect(second).not.toBeNull()
    expect(afterSecond.hits).toBeGreaterThan(0)
  })

  it('leaves nothing in flight when a render rejects, and reports it as no rendering', async () => {
    clearRenderCache()
    clearInFlightMath()
    const failing = sharedMathSvg(EQUATION, false, PREAMBLE, async () => {
      throw new Error('MathJax could not read this')
    })

    await expect(failing).resolves.toBeNull()
    // eslint-disable-next-line no-console
    console.log(`in flight after a failure: ${inFlightCount()}`)
    // A key that never settles must not be pinned: the next widget has to be able to
    // try again.
    expect(inFlightCount()).toBe(0)
  })
})
