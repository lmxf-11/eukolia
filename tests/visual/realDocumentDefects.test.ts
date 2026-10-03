/**
 * Two defects a real paper had, and the shapes that hid them.
 *
 * Both were invisible to a fixture written one construct at a time, and both were
 * reported as "rendered" by checks that looked right. They are pinned here because
 * the obvious query for each is the wrong one.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing, syntaxTree } from '@codemirror/language'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { atomicDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { phrases } from '@vendor/overleaf/extensions/phrases'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'
import { composeMacroPreamble, setProjectMacros } from '@/editor/projectMacros'
import {
  UNRENDERABLE_MATH_ENVIRONMENTS,
  isUnrenderableMathEnvironment,
} from '@/visual/builtinPreamble'

const ROOT = path.resolve(__dirname, '..', '..')
const DECORATIONS = fs.readFileSync(
  path.join(
    ROOT,
    'src',
    'renderer',
    'vendor',
    'overleaf',
    'extensions',
    'visual',
    'atomic-decorations.ts'
  ),
  'utf8'
)

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * `tikzcd` written inside display brackets — the shape every real document uses.
 *
 * The fixture used to carry one as a *paragraph*, which reaches the decoration
 * pass by a different route, and every check of the fix passed on that shape while
 * the real one produced nothing at all.
 */
const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  'A diagram:',
  '\\[',
  '\\begin{tikzcd}',
  'A \\arrow[r] & B',
  '\\end{tikzcd}',
  '\\]',
  'After.',
  '\\end{document}',
  '',
].join('\n')

async function mount(): Promise<EditorView> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [
        LaTeXLanguage,
        phrases(EUKOLIA_EDITOR_PHRASES),
        atomicDecorations,
      ],
      // Away from the diagram, so it renders rather than revealing its source.
      selection: { anchor: DOC.indexOf('After') },
    }),
    parent: host,
  })
  forceParsing(view, DOC.length, 10000)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (syntaxTree(view.state).length === view.state.doc.length) break
    await wait(25)
  }
  await wait(120)
  return view
}

describe('a diagram inside display brackets renders as a diagram', () => {
  it('is recognised from the mathematics, not only from the environment node', () => {
    // The `$Environment` ancestor is the `BracketMath` of the brackets for this
    // shape, so an environment-name lookup that only walks up the tree returns
    // null. `tikzcd` is no longer diverted to an island, but the helper that reads
    // the name out of the content is still what tells the two apart, and it is
    // still what a future un-renderable environment would need.
    expect(DECORATIONS).toContain('unrenderableEnvironmentIn')
    expect(DECORATIONS).toContain("unrenderableEnvironmentIn(math?.content ?? '')")
  })

  it('matches an un-anchored `\\begin`, because the content keeps its delimiters', () => {
    // Measured: the content handed over is `" \\begin{tikzcd} … \\end{tikzcd} "` —
    // with the brackets' whitespace still in it. An anchored `/^\\begin/` matches
    // nothing, which is how the first version of the helper failed while reading
    // correctly.
    const helper = DECORATIONS.slice(
      DECORATIONS.indexOf('const unrenderableEnvironmentIn'),
      DECORATIONS.indexOf('const unrenderableEnvironmentIn') + 1200
    )
    expect(helper).not.toMatch(/=\s*\/\^\\\\begin/)
    expect(helper).toContain('/\\\\begin\\s*\\{([^}]+)\\}/')
  })

  it('no longer names tikzcd as un-renderable', () => {
    // The port draws the diagram, so the island is gone. The name list stays —
    // empty — for environments the typesetter genuinely cannot read.
    expect(isUnrenderableMathEnvironment('tikzcd')).toBe(false)
    expect(isUnrenderableMathEnvironment('align')).toBe(false)
    expect(UNRENDERABLE_MATH_ENVIRONMENTS).toEqual([])
  })

  it('renders no source island for the diagram, and no un-readable label', async () => {
    const view = await mount()
    try {
      expect(view.dom.querySelector('.ol-cm-unrenderable-math')).toBeNull()
      // The mathematics reaches the typesetter as mathematics. Under jsdom the
      // typesetter itself cannot run — the browser path loads MathJax with a
      // `<script>` and jsdom never fires its `load` — so what is asserted here is
      // the hand-off, and `mathjax.test.ts` asserts what it produces.
      expect(view.dom.querySelectorAll('.ol-cm-math').length).toBe(1)
    } finally {
      view.destroy()
    }
  })

  it('builds one mathematics widget for the diagram, and no island', async () => {
    // The two halves of the stage-5 change, in the shape the real document has:
    // the decoration pass no longer diverts the environment, so exactly one
    // mathematics widget stands where the island used to be. What that widget
    // then typesets is asserted in `mathjax.test.ts`, against the same extension.
    const view = await mount()
    try {
      expect(view.dom.querySelectorAll('.ol-cm-math').length).toBe(1)
      expect(view.dom.querySelectorAll('.ol-cm-unrenderable-math').length).toBe(0)
    } finally {
      view.destroy()
    }
  })
})

describe('TeX primitives never reach MathJax', () => {
  it('drops a stored `\\let` rather than passing the statement through', () => {
    // The macro collector reads `\let` as a definition, which is right for an
    // index and wrong for a typesetter: MathJax has no `\let` and cannot ignore
    // it, so `\let\cal\relax` arrived as that literal text. On the paper this was
    // found on, `\cal` is used 38 times and every one rendered as a red command
    // name — because the document's own preamble *disables* `\cal`.
    setProjectMacros({ cal: '\\let\\cal\\relax', R: '\\newcommand{\\R}{\\mathbb{R}}' })
    try {
      const preamble = composeMacroPreamble('')
      expect(preamble).not.toContain('\\let')
      expect(preamble).toContain('\\R')
    } finally {
      setProjectMacros({})
    }
  })

  it('keeps every definition MathJax can actually execute', () => {
    setProjectMacros({
      a: '\\newcommand{\\a}{x}',
      b: '\\def\\b{y}',
      c: '\\DeclareMathOperator{\\c}{c}',
      d: '\\edef\\d{z}',
    })
    try {
      const preamble = composeMacroPreamble('')
      expect(preamble).toContain('\\newcommand{\\a}{x}')
      expect(preamble).toContain('\\def\\b{y}')
      expect(preamble).toContain('\\DeclareMathOperator{\\c}{c}')
      expect(preamble).not.toContain('\\edef')
    } finally {
      setProjectMacros({})
    }
  })

  it('still puts the document last, so the file being edited wins', () => {
    setProjectMacros({ R: '\\newcommand{\\R}{project}' })
    try {
      const preamble = composeMacroPreamble('\\newcommand{\\R}{document}')
      expect(preamble.indexOf('project')).toBeLessThan(preamble.indexOf('document'))
    } finally {
      setProjectMacros({})
    }
  })
})

describe('the legacy font commands are defined for MathJax', () => {
  it('names them in the typesetter configuration', () => {
    // MathJax 4 dropped the LaTeX 2.09 font commands. `\cal` in particular is not
    // obsolete in practice — it was standard notation for a calligraphic family
    // for twenty years, and the `require` package is disabled in this
    // configuration so `\require{cal}` has no path to it either.
    const service = fs.readFileSync(
      path.join(ROOT, 'src', 'renderer', 'math', 'mathjaxService.ts'),
      'utf8'
    )
    for (const name of ['cal', 'frak', 'Bbb', 'sf', 'tt', 'bf', 'rm', 'it']) {
      expect(service, `${name} is not defined`).toMatch(
        new RegExp(`^\\s+${name}: '\\\\\\\\[a-z]+',$`, 'm')
      )
    }
    expect(service).toMatch(/cal: '\\\\mathcal'/)
    expect(service).toMatch(/frak: '\\\\mathfrak'/)
    expect(service).toMatch(/Bbb: '\\\\mathbb'/)
  })
})
