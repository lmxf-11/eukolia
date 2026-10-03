// @vitest-environment jsdom
/**
 * Compiler diagnostics in the unified editor.
 *
 * Code Mode used to draw the compiler's problems with Monaco markers
 * (`setLatexDiagnostics`), scoped to the model's path — the application holds the
 * whole project's diagnostics, so another file's error must never be drawn over
 * this document's text. `cmDiagnostics.ts` carries that over; this file mounts the
 * real host component and checks the wiring end to end:
 *
 *  * a diagnostic naming the open document is drawn, a *warning* included;
 *  * a diagnostic naming another file is not;
 *  * an empty push clears what is on screen.
 *
 * The warning matters: Overleaf's `annotations()` installs a global lint config
 * whose `markerFilter` keeps errors only (`src/renderer/vendor/overleaf/
 * extensions/annotations.ts`), and `@codemirror/lint` combines those configs
 * across every linter. If it were mounted beside `latexLint()`, the warning below
 * would be invisible — which is the assertion this file exists for.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { EditorView } from '@codemirror/view'
import type { EditorHandle } from '@/editor/editorHandle'
import type { DiagnosticItem } from '@/compiler/logParser'

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

// React's `act` refuses to flush effects unless it is told it is driving a test.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FILE = 'D:/project/homework.tex'
const DOC = '\\section{Introduction}\n\nHello world.\n\nA second line.\n'

const compilerProblem = (
  file: string,
  severity: 'error' | 'warning' | 'information',
  message: string
): DiagnosticItem => ({
  file,
  line: 3,
  column: 1,
  severity,
  message,
  source: 'latex',
  level: severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'info',
  raw: message,
  category: 'compiler-error',
})

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let root: Root
let host: HTMLElement
let handleRef: React.MutableRefObject<EditorHandle | null>
let HostComponent: React.ComponentType<Record<string, unknown>>
let diagnostics: readonly DiagnosticItem[] = []

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(
      React.createElement(HostComponent, {
        getText: () => DOC,
        applyChange: () => undefined,
        filePath: FILE,
        theme: 'light',
        startVisual: false,
        handleRef,
        diagnostics,
      })
    )
  })
}

const view = (): EditorView => {
  const editor = handleRef.current?.getEditor() as EditorView | null
  if (!editor) throw new Error('the editor did not publish a handle')
  return editor
}

/** How many squiggles of a severity are rendered right now. */
const markers = (severity: 'error' | 'warning'): number =>
  view().dom.querySelectorAll(`.cm-lintRange-${severity}, .cm-lint-marker-${severity}`)
    .length

beforeAll(async () => {
  const { VisualEditor } = await import('@/visual/VisualEditor')
  HostComponent = VisualEditor as unknown as React.ComponentType<
    Record<string, unknown>
  >
  handleRef = { current: null }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)

  await render()
  for (let attempt = 0; attempt < 40 && !handleRef.current; attempt++) {
    await wait(25)
  }
}, 60000)

afterAll(async () => {
  await act(async () => {
    root.unmount()
  })
  host.remove()
})

describe('compiler diagnostics in the editor', () => {
  it('draws a warning for the open document', async () => {
    diagnostics = [
      compilerProblem(FILE, 'warning', 'Underfull \\hbox (badness 10000)'),
    ]
    await render()
    await wait(400)

    expect(markers('warning')).toBeGreaterThan(0)
  })

  it('does not draw a diagnostic that names another file', async () => {
    diagnostics = [
      compilerProblem(FILE, 'warning', 'Underfull \\hbox (badness 10000)'),
      compilerProblem('D:/project/other.tex', 'error', 'Undefined control sequence'),
    ]
    await render()
    await wait(400)

    expect(markers('warning')).toBeGreaterThan(0)
    expect(markers('error')).toBe(0)
  })

  it('clears what is on screen when the application pushes an empty list', async () => {
    diagnostics = []
    await render()
    await wait(400)

    expect(markers('warning')).toBe(0)
    expect(markers('error')).toBe(0)
  })
})
