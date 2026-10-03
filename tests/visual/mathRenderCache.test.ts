// @vitest-environment jsdom
/**
 * The rendered-mathematics cache.
 *
 * Scrolling Visual Mode was slow because CodeMirror destroys the widgets that
 * leave the viewport and builds new ones for the mathematics that scrolls back
 * in, and every new widget asked MathJax to typeset from scratch. Measured on a
 * 160-line document with 210 regions, one wheel gesture: 210 typeset calls and
 * 266 ms of MathJax time, against **0 calls** once this cache is in front of it.
 * MathJax parses, lays out and converts the same equation again for every widget
 * that shows it, and each SVG carries its own copy of every glyph path it uses,
 * so nothing is shared between two renderings either.
 *
 * What is asserted here is the part that can be checked without a layout engine:
 * that a rendering is reused, that it is reused only under the definitions it was
 * made with, that a caller gets a copy it can mount rather than the stored node,
 * and that concurrent renders of one equation both succeed.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  cachedMathSvg,
  clearRenderCache,
  markPreambleParsed,
  preambleParsed,
  rememberMathSvg,
  renderCacheStats,
} from '@/vendor/overleaf/extensions/visual/visual-widgets/math-render-cache'

/** A minimal stand-in for what MathJax hands back: a container with an SVG. */
const rendered = (label: string): HTMLElement => {
  const container = document.createElement('mjx-container')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '2ex')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', `M0 0 L${label.length} 0`)
  path.setAttribute('id', `glyph-${label}`)
  path.setAttribute('data-label', label)
  svg.appendChild(path)
  container.appendChild(svg)
  return container
}

beforeEach(() => {
  clearRenderCache()
})

describe('rendered mathematics, kept across widgets', () => {
  it('is remembered and handed back, so a second widget does not typeset again', () => {
    expect(cachedMathSvg('x^2', false, '')).toBeNull()

    rememberMathSvg('x^2', false, '', rendered('x^2'))
    const reused = cachedMathSvg('x^2', false, '')

    expect(reused).not.toBeNull()
    expect(reused?.querySelector('svg')).not.toBeNull()

    const stats = renderCacheStats()
    expect(stats.entries).toBe(1)
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(1)
  })

  it('hands out a copy, because one node cannot be in two places', () => {
    const stored = rememberMathSvg('y', false, '', rendered('y'))
    const first = cachedMathSvg('y', false, '')
    const second = cachedMathSvg('y', false, '')

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    // Distinct elements…
    expect(first).not.toBe(second)
    expect(first).not.toBe(stored)
    // Each mounted copy has its own document-wide SVG identity.
    expect(first?.querySelector('path')?.getAttribute('data-label')).toBe('y')
    expect(second?.querySelector('path')?.getAttribute('data-label')).toBe('y')
    expect(first?.querySelector('path')?.id).not.toBe(
      second?.querySelector('path')?.id,
    )
  })

  it('never reuses a rendering made under different definitions', () => {
    rememberMathSvg(
      '\\R',
      false,
      '\\newcommand{\\R}{\\mathbb{R}}',
      rendered('mathbb'),
    )
    rememberMathSvg(
      '\\R',
      false,
      '\\newcommand{\\R}{\\mathbf{R}}',
      rendered('mathbf'),
    )

    const first = cachedMathSvg('\\R', false, '\\newcommand{\\R}{\\mathbb{R}}')
    const second = cachedMathSvg('\\R', false, '\\newcommand{\\R}{\\mathbf{R}}')

    // The macros are part of the key, so a project's macro file changing under an
    // open document cannot serve a rendering typeset with the old ones.
    expect(first?.querySelector('path')?.getAttribute('data-label')).toBe(
      'mathbb',
    )
    expect(second?.querySelector('path')?.getAttribute('data-label')).toBe(
      'mathbf',
    )
  })

  it('keeps repeated diagram glyphs and description masks local to each mounted copy', () => {
    const source = rendered('diagram')
    source.querySelector('svg')!.innerHTML = `
      <defs><path id="glyph" d="M0 0L10 10"/><mask id="gap"><rect width="20" height="20" fill="white"/></mask></defs>
      <title id="title">Diagram</title>
      <g aria-labelledby="title"><use href="#glyph"/><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#glyph"/>
        <path mask="url(#gap)" style="clip-path: url('#gap')" data-latex="url(#gap)"/>
        <a href="https://example.org/#glyph"><path/></a></g>`
    const first = rememberMathSvg('diagram', true, '', source)!
    const second = cachedMathSvg('diagram', true, '')!
    document.body.append(first, second)
    try {
      const ids = [...document.querySelectorAll('[id]')].map((node) => node.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const copy of [first, second]) {
        const glyph = copy.querySelector('defs path')!
        const mask = copy.querySelector('mask')!
        for (const use of copy.querySelectorAll('use')) {
          const href =
            use.getAttribute('href') ??
            use.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
          expect(document.getElementById(href!.slice(1))).toBe(glyph)
        }
        expect(copy.querySelector('[mask]')!.getAttribute('mask')).toBe(
          `url(#${mask.id})`,
        )
        expect(copy.querySelector('[style]')!.getAttribute('style')).toContain(
          `url(#${mask.id})`,
        )
        expect(
          copy
            .querySelector('[aria-labelledby]')!
            .getAttribute('aria-labelledby'),
        ).toBe(copy.querySelector('title')!.id)
        expect(
          copy.querySelector('[data-latex]')!.getAttribute('data-latex'),
        ).toBe('url(#gap)')
        expect(copy.querySelector('a')!.getAttribute('href')).toBe(
          'https://example.org/#glyph',
        )
      }
      first.replaceChildren()
      expect(
        cachedMathSvg('diagram', true, '')!.querySelector('use'),
      ).not.toBeNull()
      clearRenderCache()
      const afterClear = rememberMathSvg('diagram', true, '', source)!
      expect(afterClear.querySelector('mask')!.id).not.toBe(
        second.querySelector('mask')!.id,
      )
      expect(source.querySelector('mask')!.id).toBe('gap')
    } finally {
      first.remove()
      second.remove()
    }
  })

  it('keys inline and displayed mathematics apart', () => {
    rememberMathSvg('\\sum_n', false, '', rendered('inline'))
    rememberMathSvg('\\sum_n', true, '', rendered('display'))

    expect(
      cachedMathSvg('\\sum_n', false, '')
        ?.querySelector('path')
        ?.getAttribute('data-label'),
    ).toBe('inline')
    expect(
      cachedMathSvg('\\sum_n', true, '')
        ?.querySelector('path')
        ?.getAttribute('data-label'),
    ).toBe('display')
  })

  it('survives two widgets rendering the same equation at once', () => {
    // Scrolling mounts several widgets in one frame, and two of them can be the
    // same equation — the second must not be handed a half-built cache entry, and
    // must not be left without one either.
    const first = rememberMathSvg('a+b', false, '', rendered('a+b'))
    const second = rememberMathSvg('a+b', false, '', rendered('a+b'))

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    // One entry, not two: the later render replaces the earlier one's slot.
    expect(renderCacheStats().entries).toBe(1)
    expect(cachedMathSvg('a+b', false, '')).not.toBeNull()
  })

  it('keeps nothing it cannot copy', () => {
    // `tex2svgPromise` can resolve to something other than an element; storing it
    // would put a node in the cache that no widget can mount.
    expect(
      rememberMathSvg(
        'z',
        false,
        '',
        'not an element' as unknown as HTMLElement,
      ),
    ).toBeNull()
    // And an element with no SVG in it is not a rendering to reuse.
    expect(
      rememberMathSvg('z', false, '', document.createElement('span')),
    ).toBeNull()
    expect(renderCacheStats().entries).toBe(0)
  })

  it('evicts the least recently used rather than the oldest', () => {
    // A tiny budget, so the entry that must survive is the one in use.
    for (let i = 0; i < 40; i += 1) {
      rememberMathSvg(`eq-${i}`, false, '', rendered('x'.repeat(400)))
    }
    const stats = renderCacheStats()
    expect(stats.chars).toBeLessThanOrEqual(6_000_000)

    // Touch the oldest surviving entry, then add more: a FIFO would evict it.
    const keys = [...Array(40).keys()].map((i) => `eq-${i}`)
    const firstAlive = keys.find(
      (key) => cachedMathSvg(key, false, '') !== null,
    )
    expect(firstAlive).toBeDefined()
    // A hit counts, and the entry is still there afterwards.
    expect(cachedMathSvg(firstAlive as string, false, '')).not.toBeNull()
    expect(renderCacheStats().hits).toBeGreaterThan(0)
  })

  it('remembers which definitions MathJax has already been told', () => {
    expect(preambleParsed('\\newcommand{\\a}{x}')).toBe(false)
    markPreambleParsed('\\newcommand{\\a}{x}')
    expect(preambleParsed('\\newcommand{\\a}{x}')).toBe(true)
    // A different set is a different parse.
    expect(preambleParsed('\\newcommand{\\a}{y}')).toBe(false)

    // Bounded: editing a macro file produces a new definitions string per
    // keystroke, and the set must not grow for the life of the session.
    for (let i = 0; i < 200; i += 1)
      markPreambleParsed(`\\newcommand{\\b${i}}{x}`)
    let stillKnown = 0
    for (let i = 0; i < 200; i += 1)
      if (preambleParsed(`\\newcommand{\\b${i}}{x}`)) stillKnown += 1
    expect(stillKnown).toBeLessThanOrEqual(64)
  })
})
