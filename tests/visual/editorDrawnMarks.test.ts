/**
 * The two marks the visual editor draws *itself*, without the typesetter.
 *
 * Both come from the same report, and both had been "fixed" already in a way that
 * could not work, which is the reason they are pinned here rather than left to
 * the MathJax tests:
 *
 *  * **`\qedhere` is never handed to MathJax.** It is written after the
 *    mathematics — `Indeed $x = y$.\qedhere` — so it is ordinary source on the
 *    line, outside the `$…$` region. Defining it for the typesetter (which
 *    `builtinPreamble.test.ts` covers, and which is still worth doing for the
 *    spelling inside `$…$`) changed nothing about what a reader saw. The mark has
 *    to be a widget, because there is no other thing on the line to draw it.
 *
 *  * **`tikzcd` cannot be rendered by any configuration.** `tikz-cd` draws
 *    through TikZ, a graphics package, not a mathematics engine: MathJax answers
 *    `Unknown environment 'tikzcd'` with `\usepackage{tikz-cd}` in the preamble
 *    and with `\require{tikz-cd}` in the definitions alike. A source island that
 *    says so is the honest answer; an error box is not.
 *
 * `builtinPreamble.test.ts` covers what Eukolia tells MathJax. This covers what
 * the editor does when MathJax is not the right instrument at all.
 */
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BUILT_IN_THEOREM_ENVIRONMENTS,
  builtInMathDefinitions,
  isUnrenderableMathEnvironment,
} from '@/visual/builtinPreamble'
import { QedWidget } from '@vendor/overleaf/extensions/visual/visual-widgets/qed'
import { UnrenderableMathWidget } from '@vendor/overleaf/extensions/visual/visual-widgets/unrenderable-math'

const VISUAL = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'renderer',
  'vendor',
  'overleaf',
  'extensions',
  'visual'
)

const DECORATIONS = fs.readFileSync(path.join(VISUAL, 'atomic-decorations.ts'), 'utf8')

describe('the QED mark', () => {
  it('draws the square, and hides the command it replaces', () => {
    const widget = new QedWidget()
    const element = widget.toDOM()

    expect(element.textContent).toBe('\u25a1')
    // It is a mark, not content: a screen reader announcing "white square" after
    // every proof is noise, and the proof environment already says where it ends.
    expect(element.getAttribute('aria-hidden')).toBe('true')
    expect(element.classList.contains('ol-cm-qed')).toBe(true)
  })

  it('is a replacement, not decoration, so the command cannot show through', () => {
    // The distinction is the whole fix. A mark decoration would leave `\qedhere`
    // on the line and draw the square beside it.
    const at = DECORATIONS.indexOf("commandName === '\\\\qedhere'")
    expect(at, 'the qedhere branch is gone').toBeGreaterThan(0)
    // Sliced to the branch's own closing brace rather than to a fixed number of
    // characters: an earlier version used a 900-character window, and a comment
    // added inside the branch pushed the assertion's subject out of it.
    const start = DECORATIONS.lastIndexOf('\n', at)
    const end = DECORATIONS.indexOf('\n            }', at)
    const branch = DECORATIONS.slice(start, end > 0 ? end : at + 1200)

    expect(branch).toContain('Decoration.replace')
    expect(branch).toContain('new QedWidget()')
    expect(branch).not.toContain('Decoration.mark')
    // And the widget class comes from the module tested above, so the two cannot
    // drift apart.
    expect(DECORATIONS).toContain("import { QedWidget } from './visual-widgets/qed'")
  })

  it('is worth drawing even though MathJax also knows the command', () => {
    // Both spellings have to work, because a document may write either: the one
    // after `$…$` reaches the widget, the one inside reaches the typesetter.
    // That is why `builtInMathDefinitions()` still defines it.
    expect(builtInMathDefinitions()).toContain('\\qedhere')
  })
})

describe('an environment no configuration can render', () => {
  it('no longer names tikzcd, and never names one MathJax can do', () => {
    // `tikzcd` was the one entry, and Eukolia's port renders it now. The list
    // stays — empty — for anything that turns out to be genuinely un-renderable.
    expect(isUnrenderableMathEnvironment('tikzcd')).toBe(false)
    // The environments that *look* like they should be here but are real MathJax
    // environments, so refusing them would be a regression.
    for (const renderable of ['align', 'equation', 'pmatrix', 'cases', 'array', 'proof']) {
      expect(isUnrenderableMathEnvironment(renderable), renderable).toBe(false)
    }
    expect(isUnrenderableMathEnvironment(null)).toBe(false)
  })

  it('still shows the source and says why, for anything that needs it', () => {
    // The island is not gone: it is what a genuinely un-renderable environment
    // still gets, and this is the widget that provides it.
    const source = '\\begin{tikzcd}\nA \\arrow[r] & B\n\\end{tikzcd}'
    const widget = new UnrenderableMathWidget('tikzcd', source)
    const element = widget.toDOM()

    expect(element.classList.contains('ol-cm-unrenderable-math')).toBe(true)
    // The environment is named on the element, so a later reader (or a test) can
    // tell which construct produced the island.
    expect(element.getAttribute('data-environment')).toBe('tikzcd')

    // The label explains it. Without this the island is indistinguishable from
    // the ordinary source islands a user sees for a construct under the caret.
    const label = element.querySelector('.ol-cm-unrenderable-math-label')
    expect(label, 'the island has no explanation').not.toBeNull()
    expect(label!.textContent).toContain('tikzcd')
    expect(label!.textContent).toMatch(/source/i)

    // And the source is shown verbatim, so the author can still read their own
    // diagram and copy it out.
    const shown = element.querySelector('.ol-cm-unrenderable-math-source')
    expect(shown, 'the island does not show the source').not.toBeNull()
    expect(shown!.textContent).toBe(source)
  })

  it('is consulted before the mathematics is handed to MathJax', () => {
    // The order is the fix. Asking MathJax first produces an error box that
    // swallows the source; the check has to come first.
    const check = DECORATIONS.indexOf('isUnrenderableMathEnvironment')
    const handover = DECORATIONS.indexOf('math.passToMathJax')
    expect(check, 'the un-renderable check is gone').toBeGreaterThan(0)
    expect(handover, 'the MathJax hand-over is gone').toBeGreaterThan(0)
    expect(check).toBeLessThan(handover)
  })
})

describe('a theorem environment declared by the document', () => {
  it('reads the document\'s own `\\newtheorem`, not only Eukolia\'s list', () => {
    // The report: `\newtheorem{definition}[theorem]{Definition}` was not
    // recognised although the parser read it correctly. The decoration consulted
    // only the built-in map, so a declaration the document had made itself was
    // invisible and the environment was rendered as plain source.
    expect(DECORATIONS).toContain('theoremEnvironments')
    // The document's declarations are looked up *first*, so a document may rename
    // or re-label an environment Eukolia also knows.
    const lookup = DECORATIONS.indexOf('theoremEnvironments')
    const builtIn = DECORATIONS.indexOf('builtInTheoremEnvironments')
    expect(lookup).toBeGreaterThan(0)
    expect(builtIn).toBeGreaterThan(0)
    expect(lookup).toBeLessThan(builtIn)
  })

  it('also carries every environment that needs no declaration', () => {
    // `amsthm`'s own set, plus the two that are not theorems but are set like
    // them. A document using any of these without a `\newtheorem` must still get
    // a header.
    for (const name of ['theorem', 'lemma', 'corollary', 'proposition', 'definition']) {
      expect(BUILT_IN_THEOREM_ENVIRONMENTS).toContain(name)
    }
    expect(BUILT_IN_THEOREM_ENVIRONMENTS).toContain('proof')
  })
})
