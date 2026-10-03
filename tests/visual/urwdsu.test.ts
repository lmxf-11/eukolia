// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing, syntaxTree } from '@codemirror/language'
import { normalizeSnippetFile, loadEusnipsIntoEngine } from '@/snippets/eusnips'
import { getSnippetEngine } from '@/snippets/engine'
import { eukoliaEditorExtensions } from '@/visual/editorExtensions'
import { setEditable } from '@vendor/overleaf/extensions/editable'
import { createEditorScope, EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'

import '../setup/dom'

const beforeRect = { top: 0, bottom: 16, left: 0, right: 50, width: 50, height: 16, x: 0, y: 0, toJSON: () => ({}) }
const mathRect = { top: 0, bottom: 16, left: 50, right: 120, width: 70, height: 16, x: 50, y: 0, toJSON: () => ({}) }
const afterRect = { top: 0, bottom: 16, left: 120, right: 130, width: 10, height: 16, x: 120, y: 0, toJSON: () => ({}) }

Range.prototype.getClientRects = function () {
  const text = this.startContainer?.textContent || ''
  if (text === ' ') {
    return [afterRect] as unknown as DOMRectList
  }
  return [beforeRect] as unknown as DOMRectList
}
Range.prototype.getBoundingClientRect = function () {
  const text = this.startContainer?.textContent || ''
  if (text === ' ') {
    return afterRect as DOMRect
  }
  return beforeRect as DOMRect
}
Element.prototype.getClientRects = function () {
  if (this.classList?.contains('ol-cm-math')) {
    return [mathRect] as unknown as DOMRectList
  }
  return [beforeRect] as unknown as DOMRectList
}
Element.prototype.getBoundingClientRect = function () {
  if (this.classList?.contains('ol-cm-math')) {
    return mathRect as DOMRect
  }
  return beforeRect as DOMRect
}

const urwdsuRaw = {
  id: 'urwdsu',
  trigger: {
    pattern: "(\\$)?(?<!\\.)(\\s*,|\\s+)(ds|sf|bb|bs|bf|bm|rm|cal|scr|frk)?([a-zA-Z0-9]+)'(a|e|h|sh|d|f)"
  },
  description: 'induced functions',
  priority: 1000,
  expand: 'auto',
  boundary: 'anywhere',
  context: 'text',
  body: '``\nif (m[1]) {\n    rv = "";\n} else {\n    rv = m[2] + "\\\\$" + "";\n}\n````\nif (m[3]) {\n    rv = "\\\\" + m[3] + "{" + m[4] + "}";\n} else {rv = m[4];}\n``^{``\nif (m[5] === \'a\') { rv = \'*\';} \nelse if (m[5] === \'e\') { rv = \'!\';}\nelse if (m[5] === \'h\') { rv = \'\\\\#\';}\nelse if (m[5] === \'sh\') { rv = \'\\\\sh\';}\nelse if (m[5] === \'d\') { rv = \'\\\\dagg\';}\nelse if (m[5] === \'f\') { rv = \'\\\\flat\';}\n;``}\\$'
}

describe('Snippet urwdsu caret position', () => {
  it('positions the visual caret after the math widget when urwdsu triggers without trailing space', async () => {
    const normalized = normalizeSnippetFile({
      version: 1,
      snippets: [urwdsuRaw as any],
    })

    const engine = getSnippetEngine()
    engine.clearStack()
    loadEusnipsIntoEngine(engine, [normalized])

    const doc = 'Hello world '
    const scope = createEditorScope({
      id: 'urwdsu-test',
      filePath: 'D:/project/homework.tex',
      projectRoot: 'D:/project',
      text: doc,
      files: [{ path: 'D:/project/homework.tex' }],
      phrases: EUKOLIA_EDITOR_PHRASES,
    })

    const parent = document.createElement('div')
    document.body.append(parent)

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: eukoliaEditorExtensions({
          scope,
          fileName: 'homework.tex',
          theme: 'light',
          startVisual: true,
        }),
      }),
    })
    view.dispatch(setEditable(true))
    forceParsing(view, doc.length, 5000)

    // Type "f'a"
    for (const char of "f'a") {
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: { from, to, insert: char },
        selection: { anchor: from + char.length },
        userEvent: 'input.type',
      })
    }

    // Wait for microtask (snippet expansion) and Lezer parsing
    await Promise.resolve()
    await Promise.resolve()
    for (let attempt = 0; attempt < 50; attempt++) {
      forceParsing(view, view.state.doc.length, 10000)
      if (syntaxTree(view.state).length === view.state.doc.length) break
      await new Promise(r => setTimeout(r, 10))
    }

    expect(view.state.doc.toString()).toBe('Hello world $f^{*}$')
    // Real caret position is at end of document (19), after the closing $
    expect(view.state.selection.main.head).toBe(19)

    // Visual coords at the start of math (12) should be at the left edge of the math widget (50)
    const coordsStart = view.coordsAtPos(12)
    expect(coordsStart?.left).toBe(50)

    // Visual coords at the end of math (19) should be at the right edge of the math widget (120)
    const coordsEnd = view.coordsAtPos(19)
    expect(coordsEnd?.left).toBe(120)

    // Visual caret rendered in DOM should be at 120px (matching real position after formula)
    const primaryCursor = parent.querySelector('.cm-cursor-primary') as HTMLElement
    expect(primaryCursor).not.toBeNull()
    expect(primaryCursor.style.left).toBe('120px')

    view.destroy()
    parent.remove()
  })

  it('positions the visual caret after the trailing space when snippet body ends with \\$ ', async () => {
    const urwdsuWithSpace = {
      ...urwdsuRaw,
      body: urwdsuRaw.body + ' ',
    }
    const normalized = normalizeSnippetFile({
      version: 1,
      snippets: [urwdsuWithSpace as any],
    })

    const engine = getSnippetEngine()
    engine.clearStack()
    loadEusnipsIntoEngine(engine, [normalized])

    const doc = 'Hello world '
    const scope = createEditorScope({
      id: 'urwdsu-space-test',
      filePath: 'D:/project/homework.tex',
      projectRoot: 'D:/project',
      text: doc,
      files: [{ path: 'D:/project/homework.tex' }],
      phrases: EUKOLIA_EDITOR_PHRASES,
    })

    const parent = document.createElement('div')
    document.body.append(parent)

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: eukoliaEditorExtensions({
          scope,
          fileName: 'homework.tex',
          theme: 'light',
          startVisual: true,
        }),
      }),
    })
    view.dispatch(setEditable(true))
    forceParsing(view, doc.length, 5000)

    // Type "f'a"
    for (const char of "f'a") {
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: { from, to, insert: char },
        selection: { anchor: from + char.length },
        userEvent: 'input.type',
      })
    }

    await Promise.resolve()
    await Promise.resolve()
    for (let attempt = 0; attempt < 50; attempt++) {
      forceParsing(view, view.state.doc.length, 10000)
      if (syntaxTree(view.state).length === view.state.doc.length) break
      await new Promise(r => setTimeout(r, 10))
    }

    expect(view.state.doc.toString()).toBe('Hello world $f^{*}$ ')
    // Real caret position is at end of document (20), after the space
    expect(view.state.selection.main.head).toBe(20)

    // Visual coords at 20 should be after the space (130)
    const coordsEnd = view.coordsAtPos(20)
    expect(coordsEnd?.left).toBe(130)

    const primaryCursor = parent.querySelector('.cm-cursor-primary') as HTMLElement
    expect(primaryCursor).not.toBeNull()
    expect(primaryCursor.style.left).toBe('130px')

    view.destroy()
    parent.remove()
  })
})
