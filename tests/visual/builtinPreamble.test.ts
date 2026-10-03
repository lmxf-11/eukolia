/**
 * The definitions Eukolia gives MathJax, against the real typesetter.
 *
 * Everything here was verified against MathJax 4.4.1 before it was written, and
 * two of the answers are counter-intuitive enough to be worth stating:
 *
 *  * **`\newtheorem` does not define an environment in MathJax.** It is accepted
 *    without complaint and defines nothing, so `\begin{definition}` after
 *    `\newtheorem{definition}{Definition}` answers `Unknown environment
 *    'definition'`. The editor's own reader parses `\newtheorem` for the header
 *    it draws, which makes the port *look* like it handles this; MathJax never
 *    learns the environment exists.
 *  * **`\qedhere` does not error.** It is printed — the word "qedhere" trailing a
 *    proof — which is worse than an error, because nothing says anything is wrong.
 *
 * No DOM, so this runs the headless typesetter, as `mathjax.test.ts` does.
 */
import { afterAll, describe, expect, it } from 'vitest'

import {
  UNRENDERABLE_MATH_ENVIRONMENTS,
  builtInMathDefinitions,
  isUnrenderableMathEnvironment,
} from '@/visual/builtinPreamble'
import { resetMathJaxTypesetter, typesetToMarkup } from '@/visual/mathjax-typesetter'

afterAll(() => {
  resetMathJaxTypesetter()
})

/** Renders the way a widget does: the built-in definitions, then the mathematics. */
const typesetWithBuiltIns = (tex: string): Promise<string> =>
  typesetToMarkup(`${builtInMathDefinitions()}\n${tex}`, true)

/** The parts of a rendering that carry the mathematics: the glyph outlines. */
const substance = (markup: string): string => {
  const paths = markup.match(/<path\b[^>]*\bd="[^"]*"/g) ?? []
  return paths.map(path => path.replace(/\sid="[^"]*"/, '')).join('|')
}

const metrics = (markup: string): string =>
  /\bwidth="([^"]+)"\s+height="([^"]+)"/.exec(markup)?.slice(1).join('x') ?? ''

describe('a theorem environment, declared by the document or by Eukolia', () => {
  it('renders `\\begin{definition}` after a `\\newtheorem` declaration', async () => {
    // Before: `Unknown environment 'definition'` — MathJax's `\newtheorem` defines
    // nothing, so the document's own declaration reached the typesetter as a
    // promise it does not keep.
    const markup = await typesetWithBuiltIns('\\begin{definition}x = y\\end{definition}')

    expect(markup).not.toContain('data-mjx-error')
    expect(markup).not.toContain('Unknown environment')
    expect(substance(markup).length).toBeGreaterThan(0)
    // The body is typeset as mathematics, which is the point: the error box
    // swallowed it.
    const plain = await typesetToMarkup('x = y', true)
    expect(substance(markup)).toContain(substance(plain).split('|')[0])
  })

  it('renders `\\begin{proof}`', async () => {
    const markup = await typesetWithBuiltIns('\\begin{proof}x = y\\end{proof}')

    expect(markup).not.toContain('data-mjx-error')
    // The label is drawn, so a reader can see which environment they are in.
    expect(metrics(markup)).not.toBe('')
    expect(substance(markup)).not.toBe(substance(await typesetToMarkup('x = y', true)))
  })

  it('renders every environment it claims to', async () => {
    for (const name of ['theorem', 'lemma', 'corollary', 'proposition', 'remark', 'example']) {
      const markup = await typesetWithBuiltIns(`\\begin{${name}}a = b\\end{${name}}`)
      expect(markup, `${name} did not render`).not.toContain('data-mjx-error')
      expect(substance(markup).length, `${name} rendered nothing`).toBeGreaterThan(0)
    }
  })
})

describe('the QED mark', () => {
  it('draws a symbol for `\\qedhere`, not the word', async () => {
    const without = await typesetToMarkup('x = y', false)
    const withMark = await typesetWithBuiltIns('x = y \\qedhere')

    // The word "qedhere" would be drawn from the same glyphs as the letters; the
    // mark is a filled square, so both the glyphs and the width differ.
    expect(substance(withMark)).not.toBe(substance(without))
    expect(metrics(withMark)).not.toBe(metrics(without))
    expect(withMark).not.toContain('data-mjx-error')
  })

  it('draws it at the end of a proof, where the document puts it', async () => {
    const markup = await typesetWithBuiltIns(
      '\\begin{proof}x = y \\qedhere\\end{proof}'
    )

    expect(markup).not.toContain('data-mjx-error')
    // One mark: the proof environment's closing part is a paragraph break, so a
    // proof that writes `\qedhere` does not get two.
    const mark = await typesetToMarkup('\\blacksquare', false)
    const marks = substance(markup).split(substance(mark)).length - 1
    expect(marks).toBe(1)
  })
})

describe('what Eukolia will not hand to MathJax', () => {
  it('is empty, because the one name it held is now rendered', () => {
    // `tikz-cd` draws through TikZ — a graphics package, not a mathematics engine —
    // so stock MathJax answers `Unknown environment 'tikzcd'` with or without
    // `\usepackage{tikz-cd}`. Eukolia ships a port of the package, so the name has
    // moved to the other side of the line and the list is empty. It stays a list,
    // not a deletion: the island below is still right for anything genuinely
    // un-renderable.
    expect(isUnrenderableMathEnvironment('tikzcd')).toBe(false)
    expect(isUnrenderableMathEnvironment('align')).toBe(false)
    expect(isUnrenderableMathEnvironment(null)).toBe(false)
    expect(UNRENDERABLE_MATH_ENVIRONMENTS).toEqual([])
  })
})
