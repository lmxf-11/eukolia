// @vitest-environment jsdom
/**
 * Indentation guides.
 *
 * Monaco drew a thin line at every indentation level and the editor that
 * replaced it should look as good, so `indentGuides.ts` reproduces the geometry:
 * a guide at every tab stop a line is nested *inside* — which is why the
 * innermost line of a block carries none — in the caret line's brighter active
 * colour.
 *
 * The geometry is a pure function of the line's text and the tab size, so most
 * of it is tested without an editor at all. The DOM assertions then check that
 * the marks land on the right *characters*, which is what makes a guide sit in
 * the right column without moving the text.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import {
  guideColumns,
  guideOffsets,
  indentGuides,
  indentationColumns,
  MAX_INDENT_GUIDE_LEVELS,
} from '@/visual/indentGuides'

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

const mount = (doc: string, anchor = 0, tabSize = 2): EditorView => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [EditorState.tabSize.of(tabSize), indentGuides()],
    }),
    parent: host,
  })
  return view
}

/** The guide marks the editor rendered, as `[level, text]` pairs. */
const rendered = (view: EditorView): Array<[string, string]> =>
  [...view.dom.querySelectorAll('.cm-indent-guide')].map(element => [
    element.getAttribute('data-indent-level') ?? '',
    element.textContent ?? '',
  ])

/**
 * Builds a view from the *whole* extension set, so a test can assert what the
 * set mounts. Loaded in `beforeAll`: the editor's module graph takes seconds to
 * transform under vite-node, which is not a cost a single test should pay.
 */
let buildEditor:
  | ((fileName: string) => EditorView)
  | null = null
let settingsManager: typeof import('@/core/settings').settingsManager
let setting: typeof import('@/core/settings').setting

beforeAll(async () => {
  const settings = await import('@/core/settings')
  const { eukoliaEditorExtensions } = await import('@/visual/editorExtensions')
  const { createEditorScope, EUKOLIA_EDITOR_PHRASES } = await import(
    '@/visual/scope'
  )
  settingsManager = settings.settingsManager
  setting = settings.setting

  buildEditor = (fileName: string): EditorView => {
    const doc = '      indented\n'
    const scope = createEditorScope({
      id: 'indent-guides',
      filePath: 'D:/project/homework.tex',
      projectRoot: 'D:/project',
      text: doc,
      files: [{ path: 'D:/project/homework.tex' }],
      phrases: EUKOLIA_EDITOR_PHRASES,
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    return new EditorView({
      state: EditorState.create({
        doc,
        extensions: eukoliaEditorExtensions({
          scope,
          // A file no language claims, so the set has nothing to load
          // asynchronously: the test is about which extensions get mounted.
          fileName,
          theme: 'light',
          startVisual: false,
        }),
        selection: { anchor: 0 },
      }),
      parent: host,
    })
  }
}, 120000)

describe('indentation geometry', () => {
  it('draws a guide at every tab stop a line is nested inside', () => {
    // Monaco's rule: a guide for each tab stop strictly *inside* the line's own
    // indentation, which is what makes the innermost line of a block carry none.
    expect(guideColumns(0, 2)).toEqual([])
    expect(guideColumns(1, 2)).toEqual([])
    expect(guideColumns(2, 2)).toEqual([])
    expect(guideColumns(4, 2)).toEqual([2])
    expect(guideColumns(6, 2)).toEqual([2, 4])
    // A half-level indentation still gets the tab stops below it.
    expect(guideColumns(5, 2)).toEqual([2, 4])
    expect(guideColumns(3, 4)).toEqual([])
    expect(guideColumns(6, 4)).toEqual([4])
  })

  it('measures a line’s indentation in columns, tabs included', () => {
    expect(indentationColumns('    text', 2)).toBe(4)
    expect(indentationColumns('\ttext', 4)).toBe(4)
    expect(indentationColumns('\t\ttext', 4)).toBe(8)
    // A tab advances to the next tab stop, not by a fixed amount.
    expect(indentationColumns('  \ttext', 4)).toBe(4)
    expect(indentationColumns('text', 4)).toBe(0)
    expect(indentationColumns('', 4)).toBe(0)
  })

  it('hangs each guide on the character that starts its column', () => {
    // `    text` at tab size 2 is nested two levels deep, so it gets one guide —
    // at column 2, on the third space.
    expect(guideOffsets('    text', 2)).toEqual([{ offset: 2, level: 0 }])
    expect(guideOffsets('      text', 2)).toEqual([
      { offset: 2, level: 0 },
      { offset: 4, level: 1 },
    ])
    // Two tabs at tab size 4: the guide for column 4 belongs to the *second*
    // tab, because that is the character whose box starts there.
    expect(guideOffsets('\t\ttext', 4)).toEqual([{ offset: 1, level: 0 }])
    expect(guideOffsets('  text', 2)).toEqual([])
  })

  it('stops at the deepest level it has a decoration for', () => {
    const deep = ' '.repeat(MAX_INDENT_GUIDE_LEVELS * 2 + 8)
    expect(guideColumns(deep.length, 2)).toHaveLength(MAX_INDENT_GUIDE_LEVELS)
    expect(guideOffsets(deep, 2)).toHaveLength(MAX_INDENT_GUIDE_LEVELS)
  })
})

describe('indentation guides in the editor', () => {
  it('marks the indentation of the lines it rendered', () => {
    // The viewport is the caret's line only in jsdom, so the caret goes on the
    // deeply indented line.
    const doc = 'first\n  second\n      third\n'
    const view = mount(doc, doc.indexOf('third'))

    // `      third` is indented by 6 columns at tab size 2 → guides at 2 and 4,
    // each hung on the space that starts that column.
    expect(rendered(view)).toEqual([
      ['1', ' '],
      ['2', ' '],
    ])

    view.destroy()
  })

  it('uses the active colour for the caret’s own line and the plain one elsewhere', () => {
    const doc = '      first\n      second\n'
    const view = mount(doc, 0)

    const guides = [...view.dom.querySelectorAll('.cm-indent-guide')]
    const active = guides.filter(element =>
      element.classList.contains('cm-indent-guide-active')
    )
    expect(guides.length).toBeGreaterThan(0)
    expect(active.length).toBeGreaterThan(0)
    // The caret is on line 1, so line 2's guides are not active.
    expect(active.length).toBeLessThan(guides.length)

    view.destroy()
  })

  it('leaves a line that is not indented alone', () => {
    const view = mount('flush\n', 0)
    expect(rendered(view)).toEqual([])
    view.destroy()
  })

  it('reads the tab size from the editor state', () => {
    const doc = '\t\ttext\n'
    const view = mount(doc, 0, 4)
    // Two tabs at tab size 4 → the guide for column 4 lands on the second tab.
    expect(rendered(view)).toEqual([['1', '\t']])
    view.destroy()
  })

  it('is mounted from the editor setting, and off means off', async () => {
    // `editor.renderIndentGuides` is Monaco's own name for this chrome, and it
    // is read at build time like every other `editor.*` setting. The whole
    // extension set is built here — not just `indentGuides()` — so the gate
    // itself is what is under test; the import that makes that possible is done
    // once in `beforeAll`, because loading the editor's module graph takes
    // seconds under vite-node and would otherwise eat this test's timeout.
    expect(buildEditor).not.toBeNull()

    try {
      settingsManager.setValue('editor.renderIndentGuides', true, 'default')
      expect(setting.bool('editor.renderIndentGuides')).toBe(true)
      const on = buildEditor!('notes.txt')
      expect(rendered(on).length).toBeGreaterThan(0)
      on.destroy()

      settingsManager.setValue('editor.renderIndentGuides', false, 'default')
      expect(setting.bool('editor.renderIndentGuides')).toBe(false)
      const off = buildEditor!('notes.txt')
      expect(rendered(off)).toEqual([])
      off.destroy()
    } finally {
      settingsManager.reset('editor.renderIndentGuides')
    }
  })
})
