import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { atomicDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { markDecorations } from '@/vendor/overleaf/extensions/visual/mark-decorations'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'

/**
 * The ported `atomicDecorations` publishes its ranges through the
 * `EditorView.decorations` facet, so a test can read exactly what the visual
 * editor would paint without a DOM: the facet values are `(view) =>
 * DecorationSet` functions that only read `view.state`.
 */
const createVisualState = (doc: string, anchor = 0) =>
  EditorState.create({
    doc,
    selection: { anchor },
    extensions: [
      LaTeXLanguage,
      phrases(EUKOLIA_EDITOR_PHRASES),
      filePreview(() => null),
      atomicDecorations,
    ],
  })

interface DecorationRange {
  from: number
  to: number
  widget?: string
  block: boolean
  className?: string
  /** The source text the range covers. */
  text: string
}

const collectRanges = (state: EditorState): DecorationRange[] => {
  const ranges: DecorationRange[] = []
  for (const value of state.facet(EditorView.decorations)) {
    const set =
      typeof value === 'function'
        ? value({ state } as unknown as EditorView)
        : value
    set.between(0, Math.max(state.doc.length, 1), (from, to, decoration) => {
      const spec = (
        decoration as {
          spec?: {
            widget?: { constructor: { name: string } }
            block?: boolean
            class?: string
            attributes?: Record<string, string>
          }
        }
      ).spec
      ranges.push({
        from,
        to,
        widget: spec?.widget?.constructor.name,
        block: Boolean(spec?.block),
        className: spec?.class ?? spec?.attributes?.class,
        text: state.doc.sliceString(from, to),
      })
    })
  }
  return ranges
}

const widgets = (state: EditorState) =>
  collectRanges(state).filter(range => range.widget !== undefined)

describe('ported Lezer LaTeX grammar inside a CodeMirror state', () => {
  it('parses a document with the vendored grammar', () => {
    const state = createVisualState(
      '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n'
    )
    const names: string[] = []
    syntaxTree(state).iterate({
      enter(node) {
        names.push(node.type.name)
      },
    })
    expect(names).toContain('DocumentEnvironment')
    expect(names).toContain('BeginEnv')
    expect(names).toContain('EndEnv')
    expect(syntaxTree(state).length).toBe(state.doc.length)
  })
})

describe('atomicDecorations', () => {
  it('renders \\section{X} as a heading: hides \\section{ and }, keeps the title', () => {
    const state = createVisualState('\\section{Groups}')
    const braces = collectRanges(state).filter(
      range => range.widget === 'BraceWidget'
    )

    expect(braces.map(range => range.text)).toEqual(['\\section{', '}'])
    // The heading text itself is untouched, editable source.
    expect(state.doc.toString()).toBe('\\section{Groups}')
  })

  it('replaces inline math with a MathWidget', () => {
    const doc = 'See $x^2$ here'
    const state = createVisualState(doc)
    const math = widgets(state).filter(range => range.widget === 'MathWidget')

    expect(math).toHaveLength(1)
    expect(math[0].text).toBe('$x^2$')
    expect(math[0].block).toBe(false)
  })

  it('replaces display math \\[ ... \\] with a block MathWidget', () => {
    const doc = 'Before\n\\[\n  gHg^{-1}=H.\n\\]\nAfter\n'
    const state = createVisualState(doc)
    const math = widgets(state).filter(range => range.widget === 'MathWidget')

    expect(math).toHaveLength(1)
    expect(math[0].block).toBe(true)
    expect(math[0].text).toBe('\\[\n  gHg^{-1}=H.\n\\]')
  })

  it('shows the source of math the cursor is inside', () => {
    // Overleaf expands a decoration when the selection intersects it; the
    // caret below sits inside `$x^2$`.
    const doc = 'See $x^2$ here'
    const state = createVisualState(doc, doc.indexOf('x'))
    expect(
      widgets(state).filter(range => range.widget === 'MathWidget')
    ).toHaveLength(0)
  })

  it('does not replace unclosed math with a MathWidget', () => {
    // Unclosed inline dollar math
    expect(
      widgets(createVisualState('See $x^2 here')).filter(range => range.widget === 'MathWidget')
    ).toHaveLength(0)

    // Unclosed inline paren math \( ...
    expect(
      widgets(createVisualState('See \\(x^2 here')).filter(range => range.widget === 'MathWidget')
    ).toHaveLength(0)

    // Unclosed display dollar math $$ ...
    expect(
      widgets(createVisualState('Before\n$$\nx^2\nAfter')).filter(range => range.widget === 'MathWidget')
    ).toHaveLength(0)

    // Unclosed display bracket math \[ ...
    expect(
      widgets(createVisualState('Before\n\\[\nx^2\nAfter')).filter(range => range.widget === 'MathWidget')
    ).toHaveLength(0)

    // Unclosed equation environment
    expect(
      widgets(createVisualState('Before\n\\begin{equation}\nx^2\nAfter')).filter(range => range.widget === 'MathWidget')
    ).toHaveLength(0)

    // Unclosed align environment
    expect(
      widgets(createVisualState('Before\n\\begin{align}\nx & y\nAfter')).filter(range => range.widget === 'MathWidget')
    ).toHaveLength(0)
  })

  it('renders \\begin{itemize}\\item a\\end{itemize} as a list', () => {
    const doc = 'Before\n\\begin{itemize}\n\\item a\n\\end{itemize}\n'
    const state = createVisualState(doc)
    const items = widgets(state).filter(range => range.widget === 'ItemWidget')

    expect(items).toHaveLength(1)
    expect(items[0].text).toContain('\\item')
    // The document source is never rewritten.
    expect(state.doc.toString()).toBe(doc)
  })

  it('renders \\emph{normal} with the command and braces hidden, word preserved', () => {
    const doc = 'A subgroup is \\emph{normal} if'
    const state = createVisualState(doc)
    const ranges = collectRanges(state)

    // \emph is an "other text formatting" command: the command name and the
    // opening brace are replaced by a brace widget, the closing brace is
    // removed, and the argument stays editable source.
    const beforeWord = ranges.filter(
      range => range.to <= doc.indexOf(' if')
    )
    expect(beforeWord.map(range => range.text)).toEqual(['\\emph{', '}'])
    expect(beforeWord[0].widget).toBe('BraceWidget')
    expect(beforeWord[1].widget).toBeUndefined()
    expect(state.doc.toString()).toBe(doc)
    expect(
      state.doc.sliceString(doc.indexOf('normal'), doc.indexOf('normal') + 6)
    ).toBe('normal')
  })

  it('renders a tabular environment as a TabularWidget', () => {
    const leading = 'Leading text\n'
    const table = '\\begin{tabular}{cc}a&b\\\\c&d\\\\\\end{tabular}'
    const state = createVisualState(leading + table)
    const tabular = widgets(state).filter(
      range => range.widget === 'TabularWidget'
    )

    expect(tabular).toHaveLength(1)
    expect(tabular[0].block).toBe(true)
    expect(tabular[0].text).toBe(table)
    expect(state.doc.toString()).toBe(leading + table)
  })

  it('reports a table it cannot render instead of deleting it', () => {
    // Three cells in a two-column table: the ported validator rejects the
    // structure, so the widget falls back to the "cannot be displayed" notice
    // rather than dropping the source.
    const doc =
      'Leading text\n\\begin{tabular}{cc}a&b&c\\\\d&e\\\\\\end{tabular}'
    const state = createVisualState(doc)
    const ranges = collectRanges(state)

    expect(ranges.some(range => range.widget === 'TabularWidget')).toBe(false)
    expect(
      ranges.some(range => range.widget === 'TableRenderingErrorWidget')
    ).toBe(true)
    expect(state.doc.toString()).toBe(doc)
  })

  it('keeps an unknown macro as visible, editable raw source', () => {
    // Instructions.md §24/§25: render what is understood, preserve visibly what
    // is not — never delete or rewrite it.
    const doc = 'Text \\myCustomMacro{X} more text'
    const state = createVisualState(doc)
    const removed = collectRanges(state)
      .filter(range => range.widget !== undefined && range.to > range.from)
      .map(range => range.text)
      .join('')

    expect(removed).not.toContain('myCustomMacro')
    expect(state.doc.toString()).toBe(doc)
    expect(state.doc.toString()).toContain('\\myCustomMacro{X}')
  })
})

describe('markDecorations (ported ViewPlugin)', () => {
  /**
   * `markDecorations` is a `ViewPlugin`, so its decoration set is only produced
   * for a live view. Its `create` function is reachable at runtime; calling it
   * with a view-shaped object that supplies `state` and `visibleRanges` is the
   * smallest honest way to exercise the ported logic without a DOM.
   */
  const decorationsFor = (doc: string) => {
    const state = createVisualState(doc)
    const create = (
      markDecorations as unknown as {
        create: (view: unknown) => { decorations: unknown }
      }
    ).create
    const value = create({
      state,
      visibleRanges: [{ from: 0, to: state.doc.length }],
    })
    const classes: { from: number; to: number; className: string }[] = []
    const set = value.decorations as {
      between(
        from: number,
        to: number,
        f: (from: number, to: number, value: unknown) => void
      ): void
    }
    set.between(0, state.doc.length + 1, (from, to, decoration) => {
      const spec = (decoration as { spec?: { class?: string } }).spec
      if (spec?.class) classes.push({ from, to, className: spec.class })
    })
    return { state, classes }
  }

  it('marks section headings with a heading class', () => {
    const { classes } = decorationsFor('\\section{Groups}\n')
    expect(classes.some(entry => entry.className.includes('ol-cm-heading'))).toBe(
      true
    )
  })

  it('marks formatting commands with their command class', () => {
    const { state, classes } = decorationsFor('A \\emph{normal} word\n')
    expect(
      classes.some(entry => entry.className === 'ol-cm-command-emph')
    ).toBe(true)
    expect(state.doc.toString()).toContain('\\emph{normal}')
  })
})
