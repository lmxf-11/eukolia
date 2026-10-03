// @vitest-environment jsdom
/**
 * The six defects from the preamble screenshot, each pinned to what it actually
 * was rather than to what it looked like.
 *
 *  1. `\geometry{margin=1in}` rendering half in the prose face and half in the
 *     source face — because the grammar does not know `\geometry`, and the ported
 *     theme gives *every* unrecognised command `font-family: monospace`.
 *  2. the preamble toggle reading `hide_document_preamble` and clipping its
 *     chevron — a missing phrase and a row laid out with `space-between`.
 *  3. multilingual text: the icon font that was never loaded (which is what the
 *     stray glyphs in the screenshot are) and the font stack the document face
 *     resolves to.
 *  4. `\newtheorem{definition}[theorem]{Definition}` registered and then never
 *     found, so `\begin{definition}` rendered as source.
 *  5. `tikzcd`, which MathJax cannot render with or without `tikz-cd`.
 *  6. `\qedhere`, which MathJax prints as its own name.
 *
 * The rendering half of 4–6 is asserted in `builtinPreamble.test.ts`, against the
 * real typesetter; this file is about what the editor produces.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing, syntaxTree } from '@codemirror/language'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { atomicDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'

/** The document from the report, with the preamble it shows. */
const DOC = [
  '\\documentclass{article}',
  '\\usepackage{graphicx}',
  '\\usepackage{tikz-cd}',
  '\\usepackage{amsthm}',
  '\\newtheorem{theorem}{Theorem}',
  '\\newtheorem{definition}[theorem]{Definition}',
  '\\geometry{margin=1in}',
  '\\title{Tôpô compact-mở}',
  '\\begin{document}',
  '\\begin{definition}',
  'A group is a set $G$ with multiplication.',
  '\\end{definition}',
  '\\begin{proof}',
  'Indeed $x = y$.\\qedhere',
  '\\end{proof}',
  '\\begin{tikzcd}',
  'A \\arrow[r] & B',
  '\\end{tikzcd}',
  '\\end{document}',
].join('\n')

const visualEditorCss = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'visual', 'visual-editor.css'),
  'utf8'
)

/** Rules in `visual-editor.css`, by exact selector, comments stripped. */
const cssRulesForExactSelector = (selector: string): string[] => {
  const css = visualEditorCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const wanted = selector.replace(/\s+/g, ' ').trim()
  const blocks: string[] = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) {
    const each = match[1].split(',').map(part => part.replace(/\s+/g, ' ').trim())
    if (each.includes(wanted)) blocks.push(match[2].replace(/\s+/g, ' ').trim())
  }
  return blocks
}

interface WidgetRange {
  name: string
  from: number
  to: number
  text: string
  widget: Record<string, unknown>
}

/** Every widget the visual editor would paint, with the widget instance. */
const widgets = (view: EditorView): WidgetRange[] => {
  const found: WidgetRange[] = []
  for (const value of view.state.facet(EditorView.decorations)) {
    const set = typeof value === 'function' ? value(view) : value
    set.between(0, Math.max(view.state.doc.length, 1), (from, to, decoration) => {
      const spec = (decoration as { spec?: Record<string, unknown> }).spec
      const widget = spec?.widget as { constructor: { name: string } } | undefined
      if (!widget) return
      found.push({
        name: widget.constructor.name,
        from,
        to,
        text: view.state.doc.sliceString(from, to),
        widget: widget as unknown as Record<string, unknown>,
      })
    })
  }
  return found
}

let view: EditorView

beforeAll(async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [
        LaTeXLanguage,
        phrases(EUKOLIA_EDITOR_PHRASES),
        filePreview(() => null),
        atomicDecorations,
      ],
      selection: { anchor: 0 },
    }),
    parent: host,
  })
  forceParsing(view, view.state.doc.length, 20000)
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (syntaxTree(view.state).length === view.state.doc.length) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}, 90000)

describe('4. a theorem environment the document declares', () => {
  it('renders the header, with the name the declaration gave it', () => {
    // `\newtheorem{definition}[theorem]{Definition}` is registered by the port's
    // own reader and then looked up nowhere: the decoration consulted the
    // built-in map alone, so the declared environment fell through to plain
    // source. Both halves are asserted — that the header is produced, and that it
    // carries the declared name rather than the environment's own.
    const definition = widgets(view).find(w => w.text.startsWith('\\begin{definition}'))

    expect(definition, 'no theorem header for the declared environment').toBeDefined()
    expect(definition?.name).toBe('BeginTheoremWidget')
    expect(definition?.widget.environment).toBe('definition')
    expect(definition?.widget.name).toBe('Definition')
  })

  it('still renders an environment nobody declared', () => {
    // The built-in four are a fallback, not a special case: a document that
    // declares nothing still gets a header for `\begin{proof}`.
    const proof = widgets(view).find(w => w.text.startsWith('\\begin{proof}'))

    expect(proof?.name).toBe('BeginTheoremWidget')
    expect(proof?.widget.name).toBe('Proof')
  })
})

describe('5. tikzcd, which Eukolia now draws', () => {
  it('is handed to the typesetter as a mathematics widget', () => {
    // `tikzcd` used to be diverted to an explained source island because MathJax
    // could not read it. Eukolia ships a port of the package, so it is mathematics
    // again — and the widget is what carries it to the extension, with the whole
    // `\begin{tikzcd}…\end{tikzcd}` as its source.
    const tikzcd = widgets(view).find(w => w.text.startsWith('\\begin{tikzcd}'))

    expect(tikzcd, 'the diagram was not handed to the typesetter').toBeDefined()
    expect(tikzcd?.name).toBe('MathWidget')
    expect(tikzcd?.widget.displayMode).toBe(true)
    expect(String(tikzcd?.widget.math)).toContain('\\arrow[r]')
  })

  it('is no longer shown as an island', () => {
    expect(widgets(view).some(w => w.name === 'UnrenderableMathWidget')).toBe(false)
  })

  it('keeps the island styling for anything that still needs it', () => {
    // The island was the right answer for an un-renderable environment, and it
    // stays in the stylesheet for that: the list of such names is empty today, not
    // the concept.
    const rules = cssRulesForExactSelector('.eukolia-visual-editor .ol-cm-unrenderable-math')
    expect(rules.join(' ')).toContain('var(--eu-visual-raw-latex-bg)')
  })
})

describe('6. the QED mark', () => {
  it('is defined for MathJax before any mathematics is typeset', () => {
    // MathJax does not error on `\qedhere` — it prints the name, which is the
    // worse failure. The definition travels with every widget's preamble.
    const math = widgets(view).find(w => w.name === 'MathWidget')
    expect(String(math?.widget.preamble)).toContain('\\qedhere')
  })

  it('does not draw a second mark at the end of a proof that writes one', () => {
    // The proof environment's closing part is a paragraph break, not a QED mark:
    // `\qedhere` is where AMS puts the mark and where the document says it goes.
    const math = widgets(view).find(w => w.name === 'MathWidget')
    const preamble = String(math?.widget.preamble)

    expect(preamble).toContain('\\newenvironment{proof}')
    expect(preamble).not.toMatch(/newenvironment\{proof\}[^\n]*\\blacksquare/)
  })
})

describe('2. the preamble toggle', () => {
  it('says what it does, through phrases that exist', () => {
    // The key was missing from the phrase table, and `state.phrase` answers with
    // its argument when it finds nothing — so the button read
    // `hide_document_preamble`, and that was its accessible name too.
    for (const key of [
      'hide_document_preamble',
      'show_document_preamble',
      'learn_more',
      'expand',
      'collapse',
    ]) {
      expect(EUKOLIA_EDITOR_PHRASES[key], `${key} is missing from the phrase table`).toBeTruthy()
      expect(EUKOLIA_EDITOR_PHRASES[key]).not.toBe(key)
    }
  })

  it('lays the label and the chevron out as one target', () => {
    const widget = cssRulesForExactSelector('.eukolia-visual-editor .ol-cm-preamble-widget').join(
      ' '
    )
    // A row, not a `space-between` pair: the ported theme's layout put the chevron
    // after the text with a fixed 32 px box, which clipped it off the right edge.
    expect(widget).toContain('display: flex')
    expect(widget).not.toContain('justify-content: space-between')
    // And a real button, so the browser's chrome is removed rather than inherited.
    expect(widget).toContain('appearance: none')
  })

  it('turns the chevron rather than rotating a fixed glyph', () => {
    const icon = cssRulesForExactSelector(
      '.eukolia-visual-editor .ol-cm-preamble-expand-icon'
    ).join(' ')
    expect(icon).toContain('transform: none')
  })
})

describe('1. code and prose are different faces', () => {
  it('sets the whole preamble as code, arguments included', () => {
    // `\geometry{margin=1in}` came out with the command in one face and its
    // argument in another, at two sizes, because the ported theme gives every
    // `UnknownCommand` the monospace face and the argument fell back to prose.
    //
    // The first fix restored the *document's* face for the argument, on the
    // reasoning that an argument is prose — and the report that came back said it
    // was backwards, because a preamble is code from end to end. The rule is now
    // the region-wide one: every line of the preamble is `ol-cm-preamble-line`,
    // and that single rule sets the source face at the code size. There is
    // deliberately no per-argument rule left to contradict it.
    const preamble = [
      '.eukolia-visual-editor .cm-line.ol-cm-preamble-line',
      '.eukolia-visual-editor .cm-line.ol-cm-preamble-line [class] [class]',
    ]
    const rule = preamble
      .map(selector => cssRulesForExactSelector(selector).join(' '))
      .join(' ')
    expect(rule).toContain('font-family: var(--source-font-family)')
    expect(rule).toContain('font-size: var(--font-size)')

    // And nothing in the stylesheet sends a preamble argument back to prose.
    const unknown = cssRulesForExactSelector(
      '.eukolia-visual-editor .ol-cm-command-unknown'
    ).join(' ')
    expect(unknown).not.toContain('var(--eu-serif-font)')
  })

  it('leaves a font the author asked for alone', () => {
    // `\textsf{}` asks for a sans face; the source stack is only the port's
    // stand-in for one, and overriding it would ignore the document.
    expect(
      cssRulesForExactSelector('.eukolia-visual-editor .ol-cm-command-textsf').join(' ')
    ).not.toContain('font-family: var(--eu-serif-font)')
  })
})

describe('3. the icon font, which was never loaded', () => {
  it('is vendored and declared, rather than fetched', () => {
    // Every `material-symbols` span in the ported chrome was painted as its
    // ligature text — the stray "expand", "help" and "abc" in the screenshot —
    // because the font was never part of the port and no stylesheet declared it.
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'renderer', 'material-symbols.css'),
      'utf8'
    )
    // Comments stripped first: this stylesheet explains *why* it does not fetch
    // from Google, and the explanation must not be mistaken for a fetch.
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '')

    expect(css).toContain('@font-face')
    expect(css).toContain("font-family: 'Material Symbols Outlined'")
    expect(css).toContain('.material-symbols')
    // Local, and no network: Eukolia is an offline application.
    expect(css).toContain('/material-symbols/material-symbols-outlined.woff2')
    expect(css).not.toContain('fonts.googleapis.com')
    expect(css).not.toContain('fonts.gstatic.com')

    const font = path.resolve(
      __dirname,
      '..',
      '..',
      'public',
      'material-symbols',
      'material-symbols-outlined.woff2'
    )
    expect(fs.existsSync(font), 'the vendored icon font is missing').toBe(true)
    expect(fs.statSync(font).size).toBeGreaterThan(1000)
  })

  it('is loaded by the renderer, so the shell’s icons work too', () => {
    const entry = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'renderer', 'main.tsx'),
      'utf8'
    )
    expect(entry).toContain("import './material-symbols.css'")
  })

  it('gives the document face a stack that covers the diacritics', () => {
    // Vietnamese prose is the case that exposed it: the document face must be a
    // stack the platform can resolve, not a LaTeX face that is usually absent.
    const indexCss = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'renderer', 'index.css'),
      'utf8'
    )
    const serif = /--eu-serif-font:\s*([^;]+);/.exec(indexCss)?.[1] ?? ''
    expect(serif).toContain('serif')
    // Georgia and Times New Roman both carry the Vietnamese diacritics and are
    // present on Windows; a stack that named only LaTeX faces would fall through
    // to whatever the platform picked.
    expect(serif).toMatch(/Georgia|Times New Roman/)
  })
})
