/**
 * The code inside Visual Mode is the same type as the code in Code Mode.
 *
 * The requirement is an equality — "the code displayed in Visual Mode and Math
 * Mode must use identical styling, including the same font family, font size,
 * weight, spacing, line height, colors, and caret appearance" — so it is held by
 * comparison rather than by writing the numbers twice.
 *
 * **What is deliberately not compared.** Visual Mode sets *prose* in the document
 * face: `--visual-font-family` and `--visual-font-size` belong to the ported
 * visual theme and reach `.cm-content` and `.cm-line`, which is what makes the
 * prose read as a document instead of as a source listing. Measured in the
 * running application, the container is `Latin Modern Roman 16.1px / 24.15px`
 * (the document face) against Code Mode's `14px / 21px` (the code face), and that
 * difference is the feature.
 *
 * What must not differ is anything that *is* code — commands, punctuation, the
 * mathematics source revealed under the caret, the preamble, `\verb`, the
 * verbatim environments, the gutter — and the interesting question about those
 * is which design token the stylesheet names. `--visual-font-size` is
 * `calc(var(--font-size) * 1.15)`, so a rule that reached for it would set code
 * one-and-a-bit times larger in Visual Mode and nowhere else. These read the
 * declarations and assert the token, which is exactly the regression that would
 * otherwise be invisible: the two variables resolve to the same *string shape*
 * and only differ by a factor.
 *
 * jsdom does not resolve custom properties, so it cannot answer "what is the
 * computed size" — `getComputedStyle` returns the literal `var(...)` text. The
 * computed values are measured in the real application instead, by
 * `scripts/probe-visual.mjs`; see `ARCHITECTURE.md`.
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const RENDERER = path.resolve(__dirname, '..', '..', 'src', 'renderer')
const VISUAL_EDITOR_CSS = fs.readFileSync(
  path.join(RENDERER, 'visual', 'visual-editor.css'),
  'utf8'
)
const VISUAL_THEME = fs.readFileSync(
  path.join(RENDERER, 'vendor', 'overleaf', 'extensions', 'visual', 'visual-theme.ts'),
  'utf8'
)

/** The declarations of every rule whose selector mentions `needle`. */
function declarationsFor(needle: string, css = VISUAL_EDITOR_CSS): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].includes(needle))
    .map(match => match[2])
    .join('\n')
}

/** The design tokens a block of declarations sets `font-size` to. */
function fontSizes(declarations: string): string[] {
  return [...declarations.matchAll(/font-size:\s*([^;]+);/g)].map(match =>
    match[1].trim()
  )
}

describe('the two size tokens, and which one is code', () => {
  it('makes the visual token the document size, not the code size', () => {
    // If this ever becomes equal to `--font-size`, the assertions below stop
    // being able to tell the two apart and the test would pass vacuously.
    expect(VISUAL_THEME).toContain("'--visual-font-size': 'calc(var(--font-size) * 1.15)'")
    expect(VISUAL_THEME).toContain("'--visual-font-family'")
    // Deliberately still the ported theme's own stack: the prose of a rendered
    // document is the document face, which Eukolia serves from `latin-modern.css`
    // through `--eu-serif-font`.
    expect(VISUAL_THEME).not.toContain('--eu-serif-font')
  })

  it('sets the mathematics source at the code size', () => {
    // The comment in `mathContext.ts` states the rule: without this the revealed
    // source inherits the prose face at 1.15×, so identical text was set two
    // different ways depending on which context it appeared in.
    const body = declarationsFor('eu-cm-math-source')
    expect(body, 'no rule for the mathematics source').not.toBe('')
    expect(fontSizes(body)).toContain('var(--font-size)')
    expect(body).not.toContain('var(--visual-font-size)')
  })

  it('sets the code tokens at the code size, not the visual one', () => {
    // Every class the highlighter uses for something that is literally code.
    for (const selector of [
      'ol-cm-monospace',
      'ol-cm-punctuation',
      'ol-cm-command-url',
      'ol-cm-environment-verbatim',
      'ol-cm-environment-lstlisting',
      'ol-cm-begin',
      'ol-cm-end',
    ]) {
      const body = declarationsFor(selector)
      expect(body, `${selector} has no rule`).not.toBe('')
      expect(body, `${selector} reaches for the visual size`).not.toContain(
        'var(--visual-font-size)'
      )
    }
  })

  it('sets the preamble, and everything inside it, at the code size', () => {
    const body = declarationsFor('ol-cm-preamble-line')
    expect(body, 'no rule for the preamble').not.toBe('')
    expect(fontSizes(body)).toContain('var(--font-size)')
    expect(body).not.toContain('var(--visual-font-size)')
    // Both the line and a descendant rule, because the reference's argument
    // marks carry `font-size` declarations of their own and would win otherwise.
    expect(body).toContain('var(--line-height)')
  })

  it('keeps the gutter out of the visual size', () => {
    // The gutter is chrome and must not shift when the mode changes. The probe
    // measures it at `14px / 21px` — the code size — in both modes; the risk here
    // is a rule reaching for the visual token, which would set the numbers in the
    // document face one-and-a-bit times larger.
    const gutter = VISUAL_EDITOR_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(gutter).toContain('.cm-gutters')
    expect(gutter).toContain('.cm-lineNumbers .cm-gutterElement')
    // Nothing about the gutter may name the visual size.
    const gutterRules = [...gutter.matchAll(/([^{}]*gutter[^{}]*)\{([^{}]*)\}/gi)]
    expect(gutterRules.length).toBeGreaterThan(0)
    for (const rule of gutterRules) {
      expect(rule[2], `${rule[1].trim()} uses the visual size`).not.toContain(
        '--visual-font-size'
      )
    }
    // And the tabular figures, which is what stops the numbers shifting sideways.
    expect(gutter).toContain('font-variant-numeric: tabular-nums')
  })
})

describe('the caret is coloured by editing context, not by mode', () => {
  it('declares a distinct caret colour for the mathematical context', () => {
    // `data-caret-math` is the only signal; there is no third editor and no
    // second caret element.
    const declarations = VISUAL_EDITOR_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = [...declarations.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    const mathCaret = rules.filter(
      rule => rule[1].includes('data-caret-math') && rule[2].includes('caret-color')
    )
    expect(mathCaret.length, 'no caret colour keyed on the mathematical context').toBeGreaterThan(
      0
    )
    // The ordinary caret is declared too, so the two can differ.
    const plainCaret = rules.filter(
      rule =>
        rule[1].includes('cm-cursor') &&
        !rule[1].includes('data-caret-math') &&
        rule[2].includes('caret-color')
    )
    expect(plainCaret.length).toBeGreaterThan(0)
  })

  it('draws the caret from a layer, which is why it needs a colour variable', () => {
    // CodeMirror's caret is a layer element, not a text caret: the theme draws it
    // per configuration and it cannot inherit `caret-color` from the text around
    // it. A variable is the only way the mathematical context can reach it.
    expect(VISUAL_EDITOR_CSS).toContain('--eu-caret-color')
    const declarations = VISUAL_EDITOR_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const using = [...declarations.matchAll(/--eu-caret-color:\s*([^;]+);/g)].map(match =>
      match[1].trim()
    )
    expect(using.length).toBeGreaterThanOrEqual(2) // the ordinary and mathematical
  })
})
