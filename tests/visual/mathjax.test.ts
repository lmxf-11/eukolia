import { afterAll, describe, expect, it } from 'vitest'

import {
  createMathJaxTypesetter,
  resetMathJaxTypesetter,
  typesetToMarkup,
} from '@/visual/mathjax-typesetter'
import { loadMathJax } from '@/vendor/overleaf/eukolia/load-mathjax'

/**
 * Eukolia typesets Visual Mode's mathematics locally with MathJax 4.1.3 (the
 * published build of the `References/MathJax-src-master` sources).
 *
 * In the renderer the typesetter resolves to the same `MathJax` instance the
 * ported widgets call (`window.MathJax`, loaded from the vendored
 * `public/mathjax/tex-svg.js`). Under vitest there is no DOM, so
 * `mathjax-typesetter.ts` drives the same MathJax version through its Node
 * entry point and the LiteDOM adaptor — identical TeX configuration, identical
 * output markup — which is what makes these assertions meaningful.
 */

afterAll(() => {
  resetMathJaxTypesetter()
})

const expectRealMathJaxOutput = (markup: string) => {
  expect(markup.length).toBeGreaterThan(0)
  // MathJax wraps every result in an `mjx-container`, and the SVG output
  // contains a real `<svg>` element with `role="img"`.
  expect(markup).toContain('<mjx-container')
  expect(markup).toContain('<svg')
  expect(markup).toContain('role="img"')
  // A TeX failure would be rendered as an `merror` node instead.
  expect(markup).not.toContain('mjx-merror')
  expect(markup).not.toContain('data-mjx-error')
}

describe('local MathJax 4 typesetting', () => {
  it('renders \\frac{a}{b} to real MathJax output', async () => {
    const markup = await typesetToMarkup('\\frac{a}{b}')
    expectRealMathJaxOutput(markup)
    // The rendered fraction produces SVG path data, not a placeholder.
    expect(markup).toMatch(/<path[^>]*d="M/)
    expect(markup.length).toBeGreaterThan(500)
  })

  it('renders an align environment in display mode', async () => {
    const markup = await typesetToMarkup(
      '\\begin{align}\n  a &= b \\\\\n  c &= d\n\\end{align}',
      true,
    )
    expectRealMathJaxOutput(markup)
    expect(markup).toContain('display="true"')
  })

  it('renders \\mathcal{C}', async () => {
    const markup = await typesetToMarkup('\\mathcal{C}')
    expectRealMathJaxOutput(markup)
  })

  it('renders a matrix', async () => {
    const markup = await typesetToMarkup(
      '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
    )
    expectRealMathJaxOutput(markup)
  })

  it('renders \\begin{cases}', async () => {
    const markup = await typesetToMarkup(
      'f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}',
    )
    expectRealMathJaxOutput(markup)
  })

  it('typesets the maths the Visual Editor example uses', async () => {
    // Instructions.md §22: `A subgroup \(H\leq G\) is \emph{normal} if \[ gHg^{-1}=H. \]`
    const inline = await typesetToMarkup('H\\leq G')
    expectRealMathJaxOutput(inline)
    const display = await typesetToMarkup('gHg^{-1}=H.', true)
    expectRealMathJaxOutput(display)
  })
})

describe('loadMathJax — the interface the ported widgets call', () => {
  it('resolves to a MathJax instance with the widget surface', async () => {
    const MathJax = await loadMathJax()
    expect(typeof MathJax.texReset).toBe('function')
    expect(typeof MathJax.tex2svgPromise).toBe('function')
    expect(typeof MathJax.typesetPromise).toBe('function')
    expect(typeof MathJax.typesetClear).toBe('function')
    expect(typeof MathJax.getMetricsFor).toBe('function')
    expect(typeof MathJax.svgStylesheet).toBe('function')
  })

  it('renders through tex2svgPromise exactly as visual-widgets/math.ts does', async () => {
    // This mirrors the ported widget body: texReset, then tex2svgPromise, then
    // read the produced markup.
    const MathJax = await loadMathJax()
    MathJax.texReset([0])
    const output = await MathJax.tex2svgPromise('\\frac{a}{b}', {
      display: false,
    })
    const markup = String(output)
    expectRealMathJaxOutput(markup)
  })

  it('is idempotent: repeated calls share one instance', async () => {
    const first = await createMathJaxTypesetter()
    const second = await createMathJaxTypesetter()
    expect(second).toBe(first)
  })

  it('reports metrics for a widget element', async () => {
    const MathJax = await loadMathJax()
    const metrics = MathJax.getMetricsFor(null, false)
    expect(metrics.em).toBeGreaterThan(0)
    expect(metrics.ex).toBeGreaterThan(0)
    expect(metrics.containerWidth).toBeGreaterThan(0)
  })
})

/**
 * The `tikzcd` extension, rendered through the same typesetter the editor uses.
 *
 * These are the acceptance tests of the port. `tikzcd` used to be an explained
 * source island precisely because MathJax could not read it, and the shapes below
 * are the ones the staged plan builds in order: a grid, then straight arrows with
 * labels, then diagonals and the option set.
 */
describe('tikzcd diagrams', () => {
  /** A diagram's markup, asserting on the way in that nothing errored. */
  const diagram = async (body: string) => {
    const markup = await typesetToMarkup(
      `\\begin{tikzcd}${body}\\end{tikzcd}`,
      true,
    )
    expect(markup).not.toContain('mjx-merror')
    expect(markup).not.toContain('data-mjx-error')
    return markup
  }

  it('lays a 2x2 grid out as four cells with their letters', async () => {
    const markup = await diagram(' A & B \\\\ C & D ')
    expect(markup).toContain('data-tikzcd-grid="2x2"')
    expect((markup.match(/data-mml-node="mtd"/g) ?? []).length).toBe(4)
    // The four letters are drawn as glyphs, not as text nodes.
    for (const code of ['1D434', '1D435', '1D436', '1D437']) {
      expect(markup, `glyph ${code} is missing`).toContain(code)
    }
  })

  it('draws an arrow for \\ar[r], with a shaft and a head', async () => {
    const markup = await diagram(' A \\ar[r] & B ')
    expect(markup).toContain('data-tikzcd-arrows="1"')
    expect(markup).toContain('data-tikzcd-shaft="1"')
    expect(markup).toContain('data-tikzcd-head="1"')
  })

  it('draws all four arrows on both rows of a commuting square', async () => {
    const markup = await diagram(
      String.raw`A \ar[r] \ar[d] & B \ar[d] \\ C \ar[r] & D`,
    )
    const shafts = [
      ...markup.matchAll(
        /<path[^>]*\bd="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"[^>]*data-tikzcd-shaft="1"/g,
      ),
    ].map((match) => match.slice(1).map(Number))
    expect(shafts).toHaveLength(4)
    const vertical = shafts.filter(([x1, , x2]) => x1 === x2)
    const horizontal = shafts.filter(([, y1, , y2]) => y1 === y2)
    expect(vertical).toHaveLength(2)
    expect(horizontal).toHaveLength(2)
    for (const [, y1, , y2] of vertical) expect(y2).toBeLessThan(y1)
    expect(horizontal[0][1]).toBeGreaterThan(horizontal[1][1])
    // Measured from the compiled 10pt TikZ-CD fixture, in ems. New Computer
    // Modern has slightly different glyph metrics from pdfTeX's Computer Modern.
    expect(
      Math.abs((vertical[1][0] - vertical[0][0]) / 1000 - 4.067),
    ).toBeLessThan(0.06)
    expect(
      Math.abs((horizontal[0][1] - horizontal[1][1]) / 1000 - 3.215),
    ).toBeLessThan(0.06)
    expect(markup).toContain('stroke-width="40"')
    const heads = [
      ...markup.matchAll(/<path[^>]*data-tikzcd-head="1"[^>]*>/g),
    ].map((match) => match[0])
    expect(heads).toHaveLength(4)
    for (const head of heads) {
      expect(head).toContain('fill="none"')
      expect(head).toMatch(/d="M[^\"]*C[^\"]*C[^\"]*"/)
    }
  })

  it('does not count a matrix inside a cell as rows of the diagram', async () => {
    const markup = await diagram(
      String.raw`\begin{matrix}a & b \\ c & d\end{matrix} \ar[r] & B \\ C \ar[r] & D`,
    )
    expect((markup.match(/data-tikzcd-shaft/g) ?? []).length).toBe(2)
  })

  // Compare drawn arrow geometry, not just the attributes passed to MathJax.
  const squareDistances = (markup: string) => {
    const shafts = [
      ...markup.matchAll(
        /<path[^>]*\bd="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"[^>]*data-tikzcd-shaft="1"/g,
      ),
    ].map((match) => match.slice(1).map(Number))
    const vertical = shafts.filter(([x1, , x2]) => x1 === x2)
    const horizontal = shafts.filter(([, y1, , y2]) => y1 === y2)
    expect(vertical).toHaveLength(2)
    expect(horizontal).toHaveLength(2)
    return {
      column: (vertical[1][0] - vertical[0][0]) / 1000,
      row: (horizontal[0][1] - horizontal[1][1]) / 1000,
    }
  }
  const square = String.raw`A \ar[r] \ar[d] & B \ar[d] \\ C \ar[r] & D`

  it.each([
    ['tiny', 0.25],
    ['small', 0.5],
    ['scriptsize', 0.75],
    ['normal', 1],
    ['large', 1.5],
    ['huge', 2],
  ])('uses TikZ-CD named separation %s on both axes', async (name, scale) => {
    const normal = squareDistances(await diagram(square))
    const changed = squareDistances(await diagram(`[sep=${name}] ${square}`))
    expect(changed.column - normal.column).toBeCloseTo(
      2.4 * (Number(scale) - 1),
      3,
    )
    expect(changed.row - normal.row).toBeCloseTo(1.8 * (Number(scale) - 1), 3)
  })

  it('applies spacing overrides in source order without affecting later diagrams', async () => {
    const normal = squareDistances(await diagram(square))
    const changed = squareDistances(
      await diagram(`[sep=huge,row sep={.5 em},column sep=12pt] ${square}`),
    )
    expect(changed.column - normal.column).toBeCloseTo(-1.2, 3)
    expect(changed.row - normal.row).toBeCloseTo(-1.3, 3)
    expect(
      squareDistances(await diagram(`[row sep=tiny,sep=normal] ${square}`)),
    ).toEqual(normal)
    expect(squareDistances(await diagram(square))).toEqual(normal)
  })

  it.each([
    ['1cm', 7.227 / 2.54],
    ['10mm', 7.227 / 2.54],
    ['.1in', 0.7227],
    ['1pc', 1.2],
    ['10bp', 72.27 / 72],
    ['2ex', 0.862],
  ])('resolves a TeX dimension %s', async (length, em) => {
    const normal = squareDistances(await diagram(square))
    const changed = squareDistances(
      await diagram(`[column sep=${length}] ${square}`),
    )
    expect(changed.column - normal.column).toBeCloseTo(Number(em) - 2.4, 3)
    expect(changed.row).toBe(normal.row)
  })

  it('reports unsupported separation expressions instead of silently using normal spacing', async () => {
    const markup = await typesetToMarkup(
      String.raw`\begin{tikzcd}[sep={not-a-length}]A \ar[r] & B\end{tikzcd}`,
      true,
    )
    expect(markup).toContain('Unsupported tikzcd sep')
    expect(squareDistances(await diagram(square)).column).toBeGreaterThan(4)
  })

  it('renders the diagram the motivating document uses, labels and all', async () => {
    // The one diagram in the paper this port was started for: two `\ar[r]` arrows
    // in a single row, each with a quoted label.
    const markup = await diagram(
      String.raw` X\times Z \ar[r,"\,\mathrm{id}\times\hat g\,"] & X\times \cal{C}(X,Y) \ar[r,"\operatorname{ev}"] & Y `,
    )
    expect(markup).toContain('data-tikzcd-grid="1x3"')
    expect((markup.match(/data-tikzcd-shaft/g) ?? []).length).toBe(2)
    expect((markup.match(/data-tikzcd-head/g) ?? []).length).toBe(2)
    const labels = markup.slice(markup.indexOf('data-tikzcd-arrows="1"'))
    expect(labels).toContain('data-mml-node="mover"') // the hat on g survives
    expect(labels).toContain('data-tikzcd-label-tex="\\operatorname{ev}"')
    expect(labels).toContain('<use ')
    expect(labels).not.toContain('<text ')
  })

  it('typesets fractions and document macros in arrow labels', async () => {
    const markup = await typesetToMarkup(
      String.raw`\def\labelmap{\frac{\alpha_1}{\beta^2}}\begin{tikzcd}A \ar[r,"\labelmap"] & B\end{tikzcd}`,
      true,
    )
    expect(markup).not.toContain('data-mjx-error')
    const labels = markup.slice(markup.indexOf('data-tikzcd-arrows="1"'))
    expect(labels).toContain('data-mml-node="mfrac"')
    expect(labels).toContain('data-mml-node="msub"')
    expect(labels).toContain('data-mml-node="msup"')
  })

  it('puts an arrow between the cell boxes it joins', async () => {
    // The failure this guards against is an arrow drawn at the wrong place —
    // inside a letter, or off the diagram — which a "has an arrow" assertion
    // cannot see.
    const markup = await diagram(' A \\ar[r] & B ')
    const viewBox = /viewBox="0 (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(markup)
    expect(viewBox, 'no viewBox in the output').not.toBeNull()
    const shaft =
      /<path[^>]*\bd="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"[^>]*data-tikzcd-shaft="1"/.exec(
        markup,
      )
    expect(shaft, 'the shaft path is not a straight line').not.toBeNull()
    const [, x1, y1, x2, y2] = shaft!.map(Number)
    expect(x2).toBeGreaterThan(x1)
    expect(y2).toBeCloseTo(y1, 3)
    // And the two ends are far enough apart to be a drawn arrow rather than a dot.
    expect(x2 - x1).toBeGreaterThan(200)
  })

  it('draws a diagonal arrow between the borders of the cells it joins', async () => {
    const markup = await diagram(' A \\ar[dr] & B \\\\ C & D ')
    expect(markup).toContain('data-tikzcd-arrows="1"')
    const shaft =
      /<path[^>]*\bd="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"[^>]*data-tikzcd-shaft="1"/.exec(
        markup,
      )
    expect(shaft).not.toBeNull()
    const [, x1, y1, x2, y2] = shaft!.map(Number)
    expect(x2).toBeGreaterThan(x1)
    expect(y2).toBeLessThan(y1)
  })

  it('draws an arrow that leaves the grid rather than folding it back', async () => {
    // `\ar[r]` on the last cell of a row points out of the diagram. Clamping the
    // target back inside — which a first version did — draws it on its own source.
    const markup = await diagram(' A & B \\ar[r] ')
    expect((markup.match(/data-tikzcd-shaft/g) ?? []).length).toBe(1)
  })

  it('draws an arrow given by from= and to= instead of a direction', async () => {
    const markup = await diagram(' A & B \\\\ C & D \\arrow[from=1-1, to=2-2] ')
    expect((markup.match(/data-tikzcd-shaft/g) ?? []).length).toBe(1)
  })

  it('honours the arrow option set', async () => {
    const dashed = await diagram(' A \\arrow[r, dashed] & B ')
    expect(dashed).toContain('stroke-dasharray')
    const twoHeads = await diagram(' A \\arrow[r, two heads] & B ')
    expect((twoHeads.match(/data-tikzcd-head/g) ?? []).length).toBe(2)
    const noHead = await diagram(' A \\arrow[r, no head] & B ')
    expect(noHead).not.toContain('data-tikzcd-head')
    const bent = await diagram(' A \\arrow[r, bend left=30] & B ')
    expect(
      /<path[^>]*\bd="M[\d.-]+ [\d.-]+C[^"]*"[^>]*data-tikzcd-shaft="1"/.test(
        bent,
      ),
    ).toBe(true)
  })

  it.each([
    ['rightarrow', 1, 0, 1],
    ['leftarrow', 1, 1, 0],
    ['leftrightarrow', 1, 1, 1],
    ['Rightarrow', 2, 0, 1],
    ['Leftarrow', 2, 1, 0],
    ['Leftrightarrow', 2, 1, 1],
    ['two heads', 1, 0, 2],
    ['twoheadleftarrow', 1, 2, 0],
    ['twoheadrightarrow', 1, 0, 2],
    ['equal', 2, 0, 0],
    ['equals', 2, 0, 0],
    ['dash', 1, 0, 0],
    ['leftarrow,no head', 1, 1, 0],
    ['leftrightarrow,no tail', 1, 0, 1],
    ['no head,to head', 1, 0, 1],
    ['to head,no head', 1, 0, 0],
    ['two heads,leftarrow', 1, 1, 0],
    ['leftarrow,two heads', 1, 1, 2],
  ])(
    'draws the correct shafts and endpoints for %s',
    async (style, shafts, start, end) => {
      const markup = await diagram(`A \\arrow[r,${style}] & B`)
      expect((markup.match(/data-tikzcd-shaft=/g) ?? []).length).toBe(shafts)
      expect((markup.match(/data-tikzcd-endpoint="start"/g) ?? []).length).toBe(
        start,
      )
      expect((markup.match(/data-tikzcd-endpoint="end"/g) ?? []).length).toBe(
        end,
      )
    },
  )

  it('places both surjection tips near the target and in the same direction', async () => {
    const markup = await diagram(String.raw`A \arrow[r,two heads] & B`)
    const heads = [
      ...markup.matchAll(/<path[^>]*d="([^"]+)"[^>]*data-tikzcd-head="1"/g),
    ].map((match) => match[1].match(/-?\d+(?:\.\d+)?/g)!.map(Number))
    expect(heads).toHaveLength(2)
    expect(heads[0][6] - heads[1][6]).toBeCloseTo(144, 2)
    for (const head of heads) expect(head[6]).toBeGreaterThan(head[0])
    const shaftEnd =
      /d="M[\d.-]+ [\d.-]+L([\d.-]+) ([\d.-]+)"[^>]*data-tikzcd-shaft/.exec(
        markup,
      )!
    expect(Number(shaftEnd[1])).toBeCloseTo(heads[0][6], 2)
  })

  it('draws transparent parallel double shafts with equal-sign separation', async () => {
    const markup = await diagram(String.raw`A \arrow[r,Rightarrow] & B`)
    const shafts = [
      ...markup.matchAll(
        /<path[^>]*d="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"[^>]*data-tikzcd-shaft="1"/g,
      ),
    ].map((match) => match.slice(1).map(Number))
    expect(shafts).toHaveLength(2)
    expect(shafts[1][1] - shafts[0][1]).toBeCloseTo(193.95, 2)
    expect(shafts[0][0]).toBe(shafts[1][0])
    expect(shafts[0][2]).toBe(shafts[1][2])
    expect(markup).not.toContain('fill="white"')
  })

  it('aligns a bent arrowhead with the endpoint tangent', async () => {
    const markup = await diagram(String.raw`A \arrow[r,bend left=30] & B`)
    const shaft =
      /d="M([\d.-]+) ([\d.-]+)C([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)"[^>]*data-tikzcd-shaft/
        .exec(markup)!
        .slice(1)
        .map(Number)
    const head = /d="([^"]+)"[^>]*data-tikzcd-head/
      .exec(markup)![1]
      .match(/-?\d+(?:\.\d+)?/g)!
      .map(Number)
    const tip = [head[6], head[7]]
    const back = [(head[0] + head[12]) / 2, (head[1] + head[13]) / 2]
    const hx = tip[0] - back[0],
      hy = tip[1] - back[1]
    const tx = shaft[6] - shaft[4],
      ty = shaft[7] - shaft[5]
    expect(
      Math.abs((hx * ty - hy * tx) / Math.hypot(hx, hy) / Math.hypot(tx, ty)),
    ).toBeLessThan(0.0001)
    expect(hx * tx + hy * ty).toBeGreaterThan(0)
  })

  it.each(['above', 'below', 'left', 'right'])(
    'renders a labelled loop %s',
    async (side) => {
      const markup = await diagram(`A \\arrow[loop ${side},"f"]`)
      expect(markup).toContain('data-tikzcd-shaft')
      expect(markup).toContain('data-tikzcd-label')
      expect(markup).not.toContain('NaN')
      const box = /viewBox="([^"]+)"/.exec(markup)![1].split(' ').map(Number)
      expect(
        side === 'above' || side === 'below' ? box[3] : box[2],
      ).toBeGreaterThan(2400)
    },
  )

  it.each([
    'hookrightarrow',
    'hookleftarrow',
    'mapsto',
    'mapsfrom',
    'Mapsto',
    'Mapsfrom',
    'rightharpoonup',
    'rightharpoondown',
    'leftharpoonup',
    'leftharpoondown',
    'tail',
  ])('renders %s tip geometry', async (style) => {
    const markup = await diagram(`A \\arrow[r,${style}] & B`)
    expect(markup).toContain('data-tikzcd-head')
    expect(markup).not.toContain('NaN')
    if (style.includes('harpoon')) {
      const path = /d="([^"]+)"[^>]*data-tikzcd-head/.exec(markup)![1]
      expect(path.match(/C/g)).toHaveLength(1)
    }
    if (style === 'mapsto')
      expect(markup).toMatch(
        /d="M[^"]+L[^"]+"[^>]*data-tikzcd-head="1" data-tikzcd-endpoint="start"/,
      )
  })

  it('uses center distances for origin-based separation', async () => {
    const distance = squareDistances(
      await diagram(`[sep={4em,between origins}] ${square}`),
    )
    expect(distance.column).toBeCloseTo(4, 1)
    expect(distance.row).toBeCloseTo(4, 3)
  })

  it('adds per-gap spacing and expands document length macros', async () => {
    const normal = squareDistances(await diagram(square))
    const changed = squareDistances(
      await diagram(
        String.raw`A \ar[r] \ar[d] &[1em] B \ar[d] \\[2em] C \ar[r] & D`,
      ),
    )
    expect(changed.column - normal.column).toBeCloseTo(1, 3)
    expect(changed.row - normal.row).toBeCloseTo(2, 3)
    const macro = await typesetToMarkup(
      String.raw`\def\diagramgap{3em}\begin{tikzcd}[sep=\diagramgap]` +
        square +
        String.raw`\end{tikzcd}`,
      true,
    )
    expect(macro).not.toContain('data-mjx-error')
    expect(squareDistances(macro).column - normal.column).toBeCloseTo(0.6, 3)
  })

  it('places and rotates labels at specified curve positions', async () => {
    const markup = await diagram(
      String.raw`A \arrow[dr,"f"{pos=.25,sloped}] & B \\ C & D`,
    )
    expect(markup).toMatch(/rotate\(-[\d.]+\)/)
    const description = await diagram(
      String.raw`A \arrow[r,"f" description] & B`,
    )
    expect(description).toContain('<mask ')
    expect(description).toContain('mask="url(#tikzcd-label-mask-')
  })

  it('matches PGF column gap precedence across rows', async () => {
    const normal = squareDistances(await diagram(square))
    const firstGap = squareDistances(
      await diagram(
        String.raw`A \ar[r] \ar[d] &[1em] B \ar[d] \\ C \ar[r] &[4em] D`,
      ),
    )
    const laterGap = squareDistances(
      await diagram(
        String.raw`A \ar[r] \ar[d] & B \ar[d] \\ C \ar[r] &[4em] D`,
      ),
    )
    expect(firstGap.column - normal.column).toBeCloseTo(1, 3)
    expect(laterGap.column).toBeCloseTo(normal.column, 3)
  })

  it('keeps curved double shafts parallel along the curve', async () => {
    const markup = await diagram(
      String.raw`A \arrow[r,Rightarrow,bend left=40] & B`,
    )
    const paths = [
      ...markup.matchAll(/d="([^"]+)"[^>]*data-tikzcd-shaft/g),
    ].map((m) => m[1].match(/-?\d+(?:\.\d+)?/g)!.map(Number))
    expect(paths).toHaveLength(2)
    const n = Math.min(paths[0].length, paths[1].length)
    for (let i = 0; i < n - 2; i += 2)
      expect(
        Math.hypot(
          paths[0][i] - paths[1][i],
          paths[0][i + 1] - paths[1][i + 1],
        ),
      ).toBeCloseTo(193.95, 1)
  })

  it('places a label below the arrow when the placement says so', async () => {
    const markup = await diagram(String.raw` A \arrow[r, "f"'] & B `)
    const label =
      /transform="translate\(([\d.-]+),([\d.-]+)\)[^"]*" data-tikzcd-label="1"/.exec(
        markup,
      )
    const shaft = /<path[^>]*\bd="M([\d.-]+) ([\d.-]+)L/.exec(markup)
    expect(label).not.toBeNull()
    expect(shaft).not.toBeNull()
    // The arrows are drawn in the flipped coordinate system the grid is measured
    // in, so a label below its arrow has a *smaller* y than the shaft.
    expect(Number(label![2])).toBeLessThan(Number(shaft![2]))
  })

  it('answers an empty diagram with an empty grid, not an error', async () => {
    // `\begin{tikzcd}` followed straight by `\end{tikzcd}` is the shape an editor
    // passes through on the way to a real diagram.
    const markup = await typesetToMarkup('\\begin{tikzcd}\\end{tikzcd}', true)
    expect(markup).not.toContain('data-mjx-error')
  })

  it('preserves mathematics after an empty diagram', async () => {
    const markup = await typesetToMarkup(
      String.raw`\begin{tikzcd}\end{tikzcd}+Z`,
      true,
    )
    expect(markup).not.toContain('data-mjx-error')
    expect(markup).toContain('data-latex="Z"')
  })

  it('shows the source rather than an error when the body cannot be read', async () => {
    // Nothing hangs and nothing throws; the reader keeps their own text.
    const markup = await typesetToMarkup(
      '\\begin{tikzcd} \\frac{ & \\end{tikzcd}',
      true,
    )
    expect(markup).toContain('tikzcd')
  })
})
