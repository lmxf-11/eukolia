/**
 * Two ways a real macro file makes mathematics render wrongly *and silently*.
 *
 * Both were found in the 297-line `macros.tex` of a topology paper, and neither
 * produced a console error or a `data-mjx-error` a reader would ever look for.
 * They are pinned together because they are two readings of one idiom — save a
 * command's original under a new name with `\LetLtxMacro`, then redefine the
 * command in terms of the copy — and because each was mis-diagnosed at least once
 * before it was measured:
 *
 *  1. `\LetLtxMacro` was in none of the macro collector's command sets, so the
 *     saved originals did not exist. `\renewcommand{\forall}{\origforall\,}` then
 *     referred to a name defined nowhere, and MathJax — which prints an unknown
 *     command rather than failing on it — painted the reader the literal text
 *     `\origfal`. That is a *font* that is wrong, not a command that errored,
 *     which is what made it read as a typography defect.
 *
 *  2. `\renewcommand{\exists}{\exists\,}` — the same idiom with a typo in the saved
 *     name — expands to itself. MathJax answers that by refusing the whole
 *     expression: every other symbol in the equation disappears with it.
 *
 * The saved names are resolved to what the command meant *when it was saved*,
 * because that is what LaTeX's `\let` does and there is no MathJax primitive that
 * does the same. That distinction is the one that matters: resolving to the
 * command's *final* definition instead closes the loop the idiom exists to avoid.
 */
import { describe, expect, it } from 'vitest'

import { parseLatexWithArguments } from '@/vendor/latex-workshop/parser/unified'
import { collectMacroDefinitions } from '@/vendor/latex-workshop/parser/newcommand'
import {
  composeMacroPreamble,
  setProjectMacros,
  type MacroTable
} from '@/editor/projectMacros'

/** The saved-original block and the redefinitions, in the order the paper has them. */
const PAPER = [
  '\\LetLtxMacro{\\origforall}{\\forall}',
  '\\LetLtxMacro{\\Implies}{\\implies}',
  '\\LetLtxMacro{\\Iff}{\\iff}',
  '\\LetLtxMacro{\\Emptyset}{\\emptyset}',
  '\\LetLtxMacro{\\origexists}{\\exists}',
  '\\let\\emptyset\\relax',
  '\\let\\implies\\relax',
  '\\let\\iff\\relex',
  '\\newcommand{\\R}{\\mathbb{R}}',
  '\\renewcommand{\\forall}{\\origforall\\,}',
  // The typo: the author meant `\origexists`.
  '\\renewcommand{\\exists}{\\exists\\,}',
  '\\renewcommand{\\S}{\\mathbb{S}}'
].join('\n')

const tableFor = (source: string): MacroTable => {
  const definitions = collectMacroDefinitions(
    parseLatexWithArguments(source, {}).content,
    source
  )
  const table: MacroTable = {}
  for (const definition of definitions) table[definition.name] = definition.definition
  return table
}

/** Every glyph codepoint MathJax painted, so a literal command name is visible. */
const glyphsOf = (markup: string): string => {
  /*
   * `data-c` is MathJax's own record of the character, and it is on every glyph
   * however the glyph is drawn. Reading the `id` instead missed whole classes of
   * glyph — a first version of this helper looked only at ids and reported that
   * `\exists` had painted nothing when it had painted U+2203 correctly.
   */
  const codes = Array.from(markup.matchAll(/data-c="([0-9A-Fa-f]+)"/g)).map(match =>
    parseInt(match[1], 16)
  )
  return codes
    .map(code =>
      code >= 32 && code < 127 ? String.fromCharCode(code) : `U+${code.toString(16).toUpperCase()}`
    )
    .join(' ')
}

const errorOf = (markup: string): string | null =>
  /data-mjx-error="([^"]*)"/.exec(markup)?.[1] ?? null

describe('the saved-original idiom, read the way LaTeX reads it', () => {
  it('collects a saved original from both spellings of \\LetLtxMacro', () => {
    const braced = collectMacroDefinitions(
      parseLatexWithArguments('\\LetLtxMacro{\\origforall}{\\forall}', {}).content,
      '\\LetLtxMacro{\\origforall}{\\forall}'
    )
    const bare = collectMacroDefinitions(
      parseLatexWithArguments('\\LetLtxMacro\\origforall\\forall', {}).content,
      '\\LetLtxMacro\\origforall\\forall'
    )
    // The definition is rewritten to the `\def` that means the same thing, because
    // MathJax has no `\LetLtxMacro` and cannot be given the statement itself.
    expect(braced.map(d => [d.name, d.definition])).toEqual([
      ['origforall', '\\def\\origforall{\\forall}']
    ])
    expect(bare.map(d => [d.name, d.definition])).toEqual([
      ['origforall', '\\def\\origforall{\\forall}']
    ])
  })

  it('names the saved originals the paper saves', () => {
    const table = tableFor(PAPER)
    for (const name of ['origforall', 'origexists', 'Implies', 'Iff', 'Emptyset']) {
      // The stored table is keyed by the bare name for `\newcommand` definitions
      // and by the backslash form for primitives; the collector decides.
      expect(Object.keys(table)).toContain(name)
    }
    expect(table.origforall).toBe('\\def\\origforall{\\forall}')
  })

  it('renders \\forall as the symbol, not as the name of its saved original', async () => {
    setProjectMacros(tableFor(PAPER))
    const { typesetToMarkup } = await import('@/visual/mathjax-typesetter')
    await typesetToMarkup(composeMacroPreamble(''), false)

    for (const tex of ['\\forall x', '\\origforall x']) {
      const markup = await typesetToMarkup(tex, false)
      expect(errorOf(markup), `${tex} must not be refused`).toBeNull()
      // U+2200 is the mathematics the paper asked for. The failure this pins
      // painted the letters of `\origforall` instead, with no error anywhere.
      expect(glyphsOf(markup), `${tex} must paint the forall glyph`).toContain('U+2200')
      expect(markup).not.toContain('origfal')
    }
  }, 120000)

  it('does not let the recursion reach \\exists', async () => {
    setProjectMacros(tableFor(PAPER))
    const { typesetToMarkup } = await import('@/visual/mathjax-typesetter')
    await typesetToMarkup(composeMacroPreamble(''), false)

    const markup = await typesetToMarkup('\\exists x', false)
    expect(errorOf(markup)).toBeNull()
    expect(markup).not.toContain('recursive macro call')
    // U+2203 is `\exists`; the recursive definition removed the symbol entirely.
    expect(glyphsOf(markup)).toContain('U+2203')
  }, 120000)

  it('leaves a redefinition that does not close a loop alone', async () => {
    setProjectMacros(tableFor(PAPER))
    const preamble = composeMacroPreamble('')
    // `\S` is redefined outright — its body names `\S` only in the sense that `\S`
    // is what is being defined — so it must reach MathJax as written, and not be
    // mistaken for the saved-original idiom.
    expect(preamble).toContain('\\renewcommand{\\S}{\\mathbb{S}}')
    expect(preamble).toContain('\\newcommand{\\R}{\\mathbb{R}}')

    const { typesetToMarkup } = await import('@/visual/mathjax-typesetter')
    await typesetToMarkup(preamble, false)
    const markup = await typesetToMarkup('\\S', false)
    expect(errorOf(markup)).toBeNull()
    // U+1D54A is the double-struck S that `\renewcommand{\S}{\mathbb{S}}` asks for.
    expect(glyphsOf(markup)).toContain('U+1D54A')
  }, 120000)

  it('keeps the other definitions in a file that contains the idiom', async () => {
    setProjectMacros(tableFor(PAPER))
    const preamble = composeMacroPreamble('')
    // The point of resolving rather than dropping: 230-odd definitions still have
    // to arrive, and a preamble that throws is a preamble that defines nothing.
    expect(preamble.length).toBeGreaterThan(0)

    const { typesetToMarkup } = await import('@/visual/mathjax-typesetter')
    await typesetToMarkup(preamble, false)
    const markup = await typesetToMarkup('\\R', false)
    expect(errorOf(markup)).toBeNull()
    // U+211D is `\mathbb{R}`.
    expect(glyphsOf(markup)).toContain('U+211D')
  }, 120000)
})
