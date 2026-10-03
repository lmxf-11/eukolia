// @vitest-environment jsdom
/**
 * `editor.renderWhitespace` on the CodeMirror editor.
 *
 * Monaco rendered whitespace from this setting and CodeMirror has no equivalent
 * switch, so `whitespaceRendering.ts` implements it. These tests pin the three
 * values down against a real editor: what `none` leaves alone, which characters
 * Monaco's `boundary` rule marks (every whitespace character except a single
 * space between two words) and that `all` marks every one of them.
 *
 * They also pin the *default*, which is `none`: the marks are something the
 * reader asks for, not something the editor draws at them.
 */
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import {
  DEFAULT_WHITESPACE_RENDERING,
  markedAtBoundary,
  normalizeWhitespaceRendering,
  whitespaceRendering,
} from '@/visual/whitespaceRendering'
import { setting, settingsManager } from '@/core/settings'
import {
  sourceOnly,
  toggleVisualEffect,
} from '@/vendor/overleaf/extensions/visual/visual'

// jsdom performs no layout, and CodeMirror measures text through client rects.
const rect = {
  top: 0,
  left: 0,
  bottom: 16,
  right: 100,
  width: 100,
  height: 16,
  x: 0,
  y: 0,
  toJSON: () => ({}),
}
const rectList = [rect] as unknown as DOMRectList
Range.prototype.getClientRects = () => rectList
Range.prototype.getBoundingClientRect = () => rect as DOMRect
Element.prototype.getClientRects = () => rectList

const mount = (
  doc: string,
  mode: 'none' | 'boundary' | 'all'
): EditorView => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [whitespaceRendering(mode)],
    }),
    parent: host,
  })
}

const marks = (view: EditorView, className: string): string[] =>
  [...view.dom.querySelectorAll(`.${className}`)].map(
    element => element.textContent ?? ''
  )

describe('editor.renderWhitespace', () => {
  it('falls back to `none` — marking nothing — for a value it does not know', () => {
    expect(normalizeWhitespaceRendering('none')).toBe('none')
    expect(normalizeWhitespaceRendering('all')).toBe('all')
    expect(normalizeWhitespaceRendering('boundary')).toBe('boundary')
    expect(normalizeWhitespaceRendering('selection')).toBe('none')
    expect(normalizeWhitespaceRendering('')).toBe('none')
  })

  it('is off unless the setting asks for it', () => {
    // The schema and the extension must not drift: the setting decides whether
    // the extension is mounted at all, and both defaults are `none`, so a
    // document with trailing spaces is shown plainly.
    const descriptor = settingsManager.getDescriptor('editor.renderWhitespace')
    expect(descriptor?.options).toEqual(['none', 'boundary', 'all'])
    expect(descriptor?.default).toBe('none')
    expect(DEFAULT_WHITESPACE_RENDERING).toBe('none')
  })

  it('shows nothing under the shipped default, on a line of trailing spaces', () => {
    // The case that made the default wrong: a `\begin{theorem}` line that once
    // picked up a dozen trailing spaces wore a dozen dots across the source under
    // `boundary`. The value read here is the one the application ships, so the
    // default in the schema is what is being tested, not a literal.
    expect(settingsManager.getScope('editor.renderWhitespace')).toBe('default')
    const view = mount(
      '\\begin{theorem}            \n\\end{theorem}\n',
      normalizeWhitespaceRendering(setting.str('editor.renderWhitespace'))
    )
    expect(marks(view, 'cm-highlightSpace')).toEqual([])
    view.destroy()
  })

  it('leaves the document alone for `none`', () => {
    const view = mount('  a b   c\td  \n', 'none')
    expect(marks(view, 'cm-highlightSpace')).toEqual([])
    expect(marks(view, 'cm-highlightTab')).toEqual([])
    view.destroy()
  })

  it('marks every space and tab for `all`', () => {
    const view = mount('  a b   c\td  \n', 'all')
    // '    ' — two leading, one between words, three interior, two trailing.
    expect(marks(view, 'cm-highlightSpace')).toHaveLength(8)
    expect(marks(view, 'cm-highlightTab')).toEqual(['\t'])
    view.destroy()
  })

  it('marks everything but a single space between two words for `boundary`', () => {
    const view = mount('  a b   c\td  \n', 'boundary')
    // The single space between `a` and `b` is the only one left alone.
    expect(marks(view, 'cm-highlightSpace')).toHaveLength(7)
    expect(marks(view, 'cm-highlightTab')).toEqual(['\t'])
    view.destroy()
  })

  it('marks a lone space at the start or end of a line', () => {
    const view = mount('a \nb\n c\n', 'boundary')
    // Trailing space on line 1, leading space on line 3 — but not the newlines
    // around the untouched `b`.
    expect(marks(view, 'cm-highlightSpace')).toHaveLength(2)
    view.destroy()
  })

  it('only marks runs of two or more spaces when the run is interior', () => {
    expect(markedAtBoundary(' ', 2, 10)).toBe(false)
    expect(markedAtBoundary(' ', 0, 10)).toBe(true)
    expect(markedAtBoundary(' ', 9, 10)).toBe(true)
    expect(markedAtBoundary('  ', 2, 10)).toBe(true)
    expect(markedAtBoundary('\t', 2, 10)).toBe(true)
  })

  it('comes and goes with the mode, without the editor being rebuilt', () => {
    // How the editor's composition mounts this: `sourceOnly`, so the extension
    // belongs to the source mode and a mode switch reconfigures it in place. The
    // view must be the same object before and after — that is what keeps the
    // scroll and the caret — while the marks appear and disappear.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView({
      state: EditorState.create({
        doc: '  indented line\n',
        extensions: [sourceOnly(false, whitespaceRendering('boundary'))],
      }),
      parent: host,
    })

    expect(marks(view, 'cm-highlightSpace').length).toBeGreaterThan(0)

    view.dispatch({ effects: toggleVisualEffect.of(true) })
    expect(marks(view, 'cm-highlightSpace')).toEqual([])

    view.dispatch({ effects: toggleVisualEffect.of(false) })
    expect(marks(view, 'cm-highlightSpace').length).toBeGreaterThan(0)

    view.destroy()
  })
})
