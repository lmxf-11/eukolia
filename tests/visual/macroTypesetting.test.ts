/**
 * Macros from an `\input`ed file, as MathJax actually renders them.
 *
 * This is the assertion that gives the feature its meaning, and it needs the
 * real typesetter: MathJax does not report an unknown control sequence, it
 * renders the macro's *name* in the current font — so `\R` without a definition
 * comes out as a plain italic R and nothing anywhere says so. The only way to
 * tell the two apart is to look at what was typeset.
 *
 * No DOM here on purpose. Under jsdom the typesetter takes the renderer path,
 * which loads the vendored MathJax by injecting a `<script>` — and jsdom does not
 * run one, so the promise never settles. `mathjax.test.ts` runs in the same
 * environment for the same reason.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  composeMacroPreamble,
  setProjectMacros,
  type MacroTable,
} from '@/editor/projectMacros'
import { resetMathJaxTypesetter, typesetToMarkup } from '@/visual/mathjax-typesetter'

const PROJECT_MACROS: MacroTable = {
  R: '\\newcommand{\\R}{\\mathbb{R}}',
  half: '\\newcommand{\\half}[2]{\\frac{#1}{#2}}',
}

/**
 * The glyph outlines of a rendering, without their ids.
 *
 * Comparing the whole markup would prove nothing: MathJax numbers the glyph
 * definitions per call, so two runs of the *same* input differ in their ids.
 * The outlines are what changes when a macro resolves to a different character —
 * `\R` undefined is an italic R, defined it is blackboard bold — along with the
 * metrics, which are picked up separately from the container's `viewBox`.
 */
const substance = (markup: string): string => {
  const paths = markup.match(/<path\b[^>]*\bd="[^"]*"/g) ?? []
  return paths.map(path => path.replace(/\sid="[^"]*"/, '')).join('|')
}

/** The width and height MathJax laid the result out at. */
const metrics = (markup: string): string =>
  /\bwidth="([^"]+)"\s+height="([^"]+)"/.exec(markup)?.slice(1).join('x') ?? ''

/**
 * Renders `tex` the way a widget does: the definitions it was constructed with,
 * then the mathematics.
 */
const typesetWithProjectMacros = async (tex: string): Promise<string> =>
  typesetToMarkup(`${composeMacroPreamble('')}\n${tex}`)

beforeEach(() => {
  // A fresh MathJax per test: `\newcommand` is *global* in a TeX input jax, so a
  // definition from one test would still be in force in the next and the
  // undefined runs below would silently be defined runs.
  resetMathJaxTypesetter()
  setProjectMacros(PROJECT_MACROS)
})
afterAll(() => {
  setProjectMacros({})
  resetMathJaxTypesetter()
})

describe('mathematics using a macro from an included file', () => {
  it('renders the macro as its definition, not as its own name', async () => {
    // Undefined, `\R` is an italic R — a real rendering, with no error marker
    // anywhere, which is why this defect went unnoticed.
    const undefinedRun = await typesetToMarkup('\\R')
    expect(undefinedRun).not.toContain('mjx-merror')
    expect(substance(undefinedRun)).toContain('<path')

    // Defined, it is blackboard bold: different glyphs, and a different size on
    // the page — `2.796ex` against `1.633ex` wide for the same letter.
    const definedRun = await typesetWithProjectMacros('\\R')

    expect(substance(definedRun)).not.toBe(substance(undefinedRun))
    expect(metrics(definedRun)).not.toBe(metrics(undefinedRun))
    expect(definedRun).not.toContain('mjx-merror')
  })

  it('renders a macro that takes an argument the same way', async () => {
    // `\half` is defined by the project as `\frac{#1}{#2}`, and MathJax makes an
    // *undefined* control sequence print its own name — so the two renderings
    // differ in whether there is a fraction in them at all.
    const undefinedRun = await typesetToMarkup('\\half{1}{2}')
    const definedRun = await typesetWithProjectMacros('\\half{1}{2}')

    expect(substance(definedRun)).not.toBe(substance(undefinedRun))
    expect(metrics(definedRun)).not.toBe(metrics(undefinedRun))
    expect(definedRun).not.toContain('mjx-merror')
  })

  it('renders an expression that mixes the macro with built-in mathematics', async () => {
    const markup = await typesetWithProjectMacros('\\frac{\\R}{2}')

    expect(markup).toContain('<mjx-container')
    expect(markup).not.toContain('mjx-merror')
    // `\frac` is built in, so the fraction bar is present whatever the macro
    // resolved to; the macro is what makes this more than a fraction of two
    // plain characters.
    const plain = await typesetToMarkup('\\frac{R}{2}')
    expect(substance(markup)).not.toBe(substance(plain))
  })

  it('lets the document override a project macro of the same name', async () => {
    // The widget preamble is `composeMacroPreamble(documentDefinitions)`, and the
    // document's definitions come last, so the file being edited wins.
    const overridden = await typesetToMarkup(
      `${composeMacroPreamble('\\newcommand{\\R}{\\mathbf{R}}')}\n\\R`
    )
    const fromProject = await typesetWithProjectMacros('\\R')

    expect(substance(overridden)).not.toBe(substance(fromProject))
    expect(overridden).not.toContain('mjx-merror')
  })
})
