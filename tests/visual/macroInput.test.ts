// @vitest-environment jsdom
/**
 * Mathematics that uses a macro from an `\input`ed file.
 *
 * A project keeps its macros in a shared file, and the mathematics in every
 * chapter uses them. Two things have to be true for that mathematics to render:
 *
 *  1. the macros reach the *preamble* the mathematics is typeset with, which is
 *     what `mathWidgets` reads back — the real widget's own preamble, from the
 *     real visual extension set;
 *  2. they reach it *in time*, which is the last test: the project index finishes
 *     reading the included files after the editor is built, so the table arrives
 *     late and the mathematics already on screen has to be typeset again.
 *
 * The failure this guards against is silent. MathJax does not report an unknown
 * control sequence: `\R` is rendered as a plain italic R. So the typesetting
 * assertions compare the *substantive* output with and without the macro — the
 * glyph paths and metrics, not the whole markup, whose ids and wrappers differ
 * for reasons that have nothing to do with the macro.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { atomicDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { mathSourceDecorations } from '@/editor/mathContext'
import {
  composeMacroPreamble,
  getProjectMacros,
  projectMacroUpdate,
  setProjectMacros,
  type MacroTable,
} from '@/editor/projectMacros'
import { builtInMathDefinitions } from '@/visual/builtinPreamble'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'

/** A document whose mathematics uses macros it does not define itself. */
const DOC = [
  '\\documentclass{article}',
  '\\input{macros}',
  '\\begin{document}',
  'The reals $\\R$ and a scale $\\scaled{v}$.',
  '\\end{document}',
].join('\n')

const PROJECT_MACROS: MacroTable = {
  R: '\\newcommand{\\R}{\\mathbb{R}}',
  scaled: '\\newcommand{\\scaled}[1]{\\mathbf{#1}}',
}

const createState = (): EditorState =>
  EditorState.create({
    doc: DOC,
    selection: { anchor: 0 },
    extensions: [
      LaTeXLanguage,
      phrases(EUKOLIA_EDITOR_PHRASES),
      filePreview(() => null),
      atomicDecorations,
      mathSourceDecorations,
    ],
  })

interface MathWidgetRange {
  text: string
  preamble: string | undefined
}

/** The mathematical widgets the editor painted, with the preamble each was built with. */
const mathWidgets = (view: EditorView): MathWidgetRange[] => {
  const found: MathWidgetRange[] = []
  for (const value of view.state.facet(EditorView.decorations)) {
    const set = typeof value === 'function' ? value(view) : value
    set.between(0, Math.max(view.state.doc.length, 1), (from, to, decoration) => {
      const spec = (decoration as { spec?: Record<string, unknown> }).spec
      const widget = spec?.widget as { preamble?: string } | undefined
      if (!widget || widget.constructor.name !== 'MathWidget') return
      found.push({ text: view.state.doc.sliceString(from, to), preamble: widget.preamble })
    })
  }
  return found
}

let view: EditorView | null = null
let host: HTMLElement | null = null

const mount = (): EditorView => {
  host = document.createElement('div')
  document.body.appendChild(host)
  view = new EditorView({ state: createState(), parent: host })
  return view
}

beforeEach(() => {
  setProjectMacros({})
})

afterEach(() => {
  view?.destroy()
  view = null
  host?.remove()
  host = null
  setProjectMacros({})
})

/**
 * The part of a widget's preamble that came from *this project*.
 *
 * A widget's preamble is three layers: the definitions Eukolia supplies for what
 * MathJax does not know (`visual/builtinPreamble.ts`), the project's macros, and
 * the document's own. These tests are about the middle layer, so the built-ins
 * are stripped rather than asserted around — otherwise "the project defined
 * nothing" and "the preamble is empty" would be the same statement, and they are
 * not.
 */
const localPartOf = (preamble: string | undefined): string =>
  (preamble ?? '').split('\n').filter(line => !line.startsWith('\\newenvironment{') && !line.startsWith('\\def\\qedhere')).join('\n').trim()

describe('the preamble the mathematics is typeset with', () => {
  it('carries the project macros, before the document’s own definitions', () => {
    setProjectMacros(PROJECT_MACROS)

    const preamble = composeMacroPreamble('\\newcommand{\\local}{x}')

    expect(preamble).toContain('\\newcommand{\\R}{\\mathbb{R}}')
    expect(preamble).toContain('\\newcommand{\\scaled}[1]{\\mathbf{#1}}')
    // The document's own definitions come last, so the file the user is editing
    // is the definition in force when both define the same name.
    expect(preamble.indexOf('\\local')).toBeGreaterThan(preamble.indexOf('\\R'))
  })

  it('is just the document’s definitions when the project has none', () => {
    expect(composeMacroPreamble('\\newcommand{\\local}{x}')).toBe('\\newcommand{\\local}{x}')
  })

  it('is what the widget is built with, through the real extension set', () => {
    setProjectMacros(PROJECT_MACROS)

    const widgets = mathWidgets(mount())

    expect(widgets.map(widget => widget.text)).toEqual(['$\\R$', '$\\scaled{v}$'])
    for (const widget of widgets) {
      expect(widget.preamble).toContain('\\newcommand{\\R}{\\mathbb{R}}')
    }
  })

  it('has nothing project-local when the project defines nothing', () => {
    // The state before this fix: a document that defined no macros of its own had
    // nothing to hand MathJax, whatever the project held in its macro file — and
    // the mathematics was still rendered, with the macro mistaken for its name.
    const widgets = mathWidgets(mount())

    expect(widgets).toHaveLength(2)
    expect(widgets.every(widget => localPartOf(widget.preamble) === '')).toBe(true)
  })
})

describe('what MathJax makes of it', () => {
  // The rendering itself is asserted in `macroTypesetting.test.ts`, which runs
  // without a DOM: in jsdom the typesetter takes the renderer path, which loads
  // the vendored MathJax by injecting a script tag — and jsdom does not run one.
  // Here it is enough that the preamble the widget was built with is the TeX a
  // typesetting call receives.
  it('is the TeX the widget hands MathJax', () => {
    setProjectMacros(PROJECT_MACROS)

    const widget = mathWidgets(mount())[0]

    // Eukolia's own definitions, then the project's — the composition the widget
    // performs, with the document contributing nothing for this fixture.
    expect(widget.preamble).toBe(
      composeMacroPreamble(builtInMathDefinitions())
    )
    expect(widget.preamble).toContain('\\newcommand{\\R}{\\mathbb{R}}')
  })
})

describe('a table that arrives after the editor was built', () => {
  it('reaches the mathematics already on screen', () => {
    const mounted = mount()

    // The editor was built before the project's macros had been read, so nothing
    // project-local is in the preamble the mathematics on screen was built with.
    expect(mathWidgets(mounted).every(widget => localPartOf(widget.preamble) === '')).toBe(true)

    mounted.dispatch(projectMacroUpdate(PROJECT_MACROS))

    // The same transaction rebuilds the widgets, so the mathematics is typeset
    // again with the macros that have just arrived. It has to be the same
    // transaction: the decorations are *positions*, so nothing about them is
    // stale, and a rebuild that waited for a later one would leave the
    // mathematics on screen wrong until the user happened to edit the line.
    expect(getProjectMacros()).toEqual(PROJECT_MACROS)

    const rebuilt = mathWidgets(mounted)
    expect(rebuilt).toHaveLength(2)
    for (const widget of rebuilt) {
      expect(widget.preamble).toContain('\\newcommand{\\R}{\\mathbb{R}}')
    }
  })

  it('asks for no rebuild at all when the table has not changed', () => {
    setProjectMacros({})

    // Install the table, as the host does when the project index first has it.
    const install = projectMacroUpdate(PROJECT_MACROS)
    expect(install.effects.length).toBeGreaterThan(0)

    // The index re-reads on every analysis of every open document, so an equal
    // table arrives constantly — passing `sameMacroTable`, which is what keeps
    // the document from being typeset again for nothing (§62). `toBe` on the
    // state would not show this: CodeMirror builds a new `EditorState` for every
    // transaction, even one that changes nothing.
    const repeat = projectMacroUpdate({ ...PROJECT_MACROS })
    expect(repeat.effects).toEqual([])

    // And a table that does differ is carried.
    const changed = projectMacroUpdate({
      ...PROJECT_MACROS,
      R: '\\newcommand{\\R}{\\mathbf{R}}',
    })
    expect(changed.effects.length).toBeGreaterThan(0)
  })

  it('re-typesets when the table has changed', async () => {
    const mounted = mount()
    mounted.dispatch(projectMacroUpdate(PROJECT_MACROS))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mathWidgets(mounted)[0]?.preamble).toContain('\\mathbb{R}')

    // Editing the macro file is the live case: the project index re-reads it, the
    // table changes, and the mathematics on screen has to be typeset again.
    mounted.dispatch(
      projectMacroUpdate({
        ...PROJECT_MACROS,
        R: '\\newcommand{\\R}{\\mathbf{R}}',
      })
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    const rebuilt = mathWidgets(mounted)
    expect(rebuilt).toHaveLength(2)
    expect(rebuilt[0]?.preamble).toContain('\\mathbf{R}')
    expect(rebuilt[0]?.preamble).not.toContain('\\mathbb{R}')
  })
})
