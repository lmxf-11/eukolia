import { describe, expect, it } from 'vitest'

import { resetMathJaxTypesetter, typesetToMarkup } from '@/visual/mathjax-typesetter'

/**
 * What one rendered equation is made of, in the DOM.
 *
 * The scroll cost is paint, so the number that matters is not how many bytes the
 * markup is but how many *elements* the compositor has to consider, and how much
 * unique glyph outline data is in them. This prints that shape for a few
 * representative equations, including two dense display expressions, so a change to
 * the typesetting configuration can be judged on the thing that is painted.
 *
 * It uses the headless typesetter (`typesetToMarkup`), which is the same TeX
 * configuration the editor runs through the same vendored MathJax — a measurement in
 * vitest is not a measurement of the application, but the *shape* of the output is a
 * property of MathJax and not of the window.
 */

const CASES: [string, string, boolean][] = [
  ['inline short', 'a_1^2 + b', false],
  ['inline fraction', '\\frac{n(n+1)}{2}', false],
  ['display sum', '\\sum_{i=1}^{n} i', true],
  [
    'display aligned',
    '\\begin{aligned} \\alpha + \\beta &= \\gamma \\\\ \\delta &= \\epsilon \\end{aligned}',
    true,
  ],
  ['greek run', '\\alpha\\beta\\gamma\\delta\\epsilon\\zeta\\eta\\theta', false],
]

describe('the DOM shape of one rendered equation', () => {
  it('prints elements and glyph data per equation', async () => {
    resetMathJaxTypesetter()
    const rows: string[] = []
    for (const [label, tex, display] of CASES) {
      let svg: string
      try {
        svg = await typesetToMarkup(tex, display)
      } catch (error) {
        rows.push(`${label}: typeset failed (${String(error).slice(0, 60)})`)
        continue
      }
      if (!svg) {
        rows.push(`${label}: empty output`)
        continue
      }
      const count = (pattern: RegExp) => (svg.match(pattern) ?? []).length
      const pathBytes = [...svg.matchAll(/ d="([^"]*)"/g)].reduce(
        (sum, match) => sum + match[1].length,
        0
      )
      rows.push(
        [
          label.padEnd(17),
          `bytes ${String(svg.length).padStart(6)}`,
          `elements ${String(count(/<[a-zA-Z]/g)).padStart(4)}`,
          `path ${String(count(/<path/g)).padStart(3)}`,
          `use ${String(count(/<use/g)).padStart(3)}`,
          `defs ${String(count(/<defs/g)).padStart(2)}`,
          `pathData ${String(pathBytes).padStart(6)}`,
        ].join('  ')
      )
    }
    // eslint-disable-next-line no-console
    console.log('\n' + rows.join('\n'))
    expect(rows.length).toBe(CASES.length)
  })

  /**
   * What the same document costs when two equations share glyphs.
   *
   * This is the number that decides whether a shared glyph cache is worth building:
   * sixteen equations over one small alphabet are, between them, mostly *the same
   * paths written out sixteen times*, and every one of those copies is rasterised
   * separately. If MathJax's own global font cache collapses that, no new machinery
   * is needed.
   */
  it('prints what two equations with shared glyphs cost together', async () => {
    resetMathJaxTypesetter()
    const equations = [
      '\\alpha + \\beta = \\gamma',
      '\\alpha - \\beta = \\delta',
      '\\alpha \\cdot \\beta = \\epsilon',
      '\\alpha / \\beta = \\zeta',
    ]
    const parts: string[] = []
    for (const tex of equations) parts.push(await typesetToMarkup(tex, false))
    const together = parts.join('')
    const pathBytes = [...together.matchAll(/ d="([^"]*)"/g)].reduce(
      (sum, match) => sum + match[1].length,
      0
    )
    const distinctPaths = new Set(
      [...together.matchAll(/ d="([^"]*)"/g)].map(match => match[1])
    ).size
    const totalPaths = (together.match(/<path/g) ?? []).length
    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        `${equations.length} equations: bytes ${together.length}`,
        `  path elements ${totalPaths}, of which distinct ${distinctPaths}`,
        `  glyph data ${pathBytes} bytes, of which distinct ${
          [...new Set([...together.matchAll(/ d="([^"]*)"/g)].map(m => m[1]))].reduce(
            (sum, data) => sum + data.length,
            0
          )
        } bytes`,
      ].join('\n')
    )
    expect(totalPaths).toBeGreaterThan(0)
  })
})
