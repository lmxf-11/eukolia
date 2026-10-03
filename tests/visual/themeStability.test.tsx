// @vitest-environment jsdom
/**
 * Editor stability during theme changes and layout interactions.
 *
 * The editor and its content must NOT be reloaded, re-rendered or reconfigured
 * entirely when changing theme, toggling the sidebar, etc.
 * The underlying EditorView instance, document text, and caret position
 * must survive theme switches untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { EditorView } from '@codemirror/view'
import { VisualEditor } from '../../src/renderer/visual/VisualEditor'
import { createEditorScope, EUKOLIA_EDITOR_PHRASES } from '../../src/renderer/visual/scope'

// Minimal Worker stub for jsdom
class WorkerStub {
  onmessage: ((event: MessageEvent) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
Object.defineProperty(globalThis, 'Worker', {
  configurable: true,
  writable: true,
  value: WorkerStub,
})

// React only batches inside `act` when the environment says so.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Client rect stub for CodeMirror measuring
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

let container: HTMLDivElement
let root: Root

const SAMPLE_DOC = '\\documentclass{article}\n\\begin{document}\nHello stability test!\n\\end{document}\n'

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

describe('VisualEditor stability across theme changes', () => {
  it('preserves the same EditorView instance across theme switches without reloading or rebuilding', async () => {
    let docText = SAMPLE_DOC
    const scope = createEditorScope({
      id: 'test-stability',
      filePath: 'D:/test/doc.tex',
      projectRoot: 'D:/test',
      text: docText,
      files: [{ path: 'D:/test/doc.tex' }],
      phrases: EUKOLIA_EDITOR_PHRASES,
    })

    const handleRef = { current: null as any }

    // Mount initially with light theme
    await act(async () => {
      root.render(
        <VisualEditor
          getText={() => docText}
          applyChange={(change) => {
            docText = docText.slice(0, change.from) + change.insert + docText.slice(change.to)
          }}
          filePath="D:/test/doc.tex"
          scope={scope}
          theme="light"
          startVisual={true}
          handleRef={handleRef}
        />
      )
    })

    const initialView = handleRef.current?.getEditor() as EditorView
    expect(initialView).toBeTruthy()

    // Move caret to an arbitrary offset
    const targetOffset = 15
    await act(async () => {
      initialView.dispatch({ selection: { anchor: targetOffset, head: targetOffset } })
    })
    expect(handleRef.current?.getCursorOffset()).toBe(targetOffset)

    // Re-render with dark theme
    await act(async () => {
      root.render(
        <VisualEditor
          getText={() => docText}
          applyChange={(change) => {
            docText = docText.slice(0, change.from) + change.insert + docText.slice(change.to)
          }}
          filePath="D:/test/doc.tex"
          scope={scope}
          theme="dark"
          startVisual={true}
          handleRef={handleRef}
        />
      )
    })

    const viewAfterThemeChange = handleRef.current?.getEditor() as EditorView
    // The EditorView must be the exact same instance - NOT rebuilt or reloaded
    expect(viewAfterThemeChange).toBe(initialView)

    // Caret offset must remain unchanged
    expect(handleRef.current?.getCursorOffset()).toBe(targetOffset)

    // Host DOM element data-theme attribute must be updated
    const hostEl = container.querySelector('.eukolia-visual-editor')
    expect(hostEl?.getAttribute('data-theme')).toBe('dark')

    // Switch back to light theme
    await act(async () => {
      root.render(
        <VisualEditor
          getText={() => docText}
          applyChange={(change) => {
            docText = docText.slice(0, change.from) + change.insert + docText.slice(change.to)
          }}
          filePath="D:/test/doc.tex"
          scope={scope}
          theme="light"
          startVisual={true}
          handleRef={handleRef}
        />
      )
    })

    const viewAfterSecondChange = handleRef.current?.getEditor() as EditorView
    expect(viewAfterSecondChange).toBe(initialView)
    expect(handleRef.current?.getCursorOffset()).toBe(targetOffset)
    expect(hostEl?.getAttribute('data-theme')).toBe('light')
  })

  it('does not reload or rebuild the editor when non-editor settings (such as appearance.sidebarWidth) change', async () => {
    const { settingsManager } = await import('../../src/renderer/core/settings')
    let docText = SAMPLE_DOC
    const scope = createEditorScope({
      id: 'test-stability-settings',
      filePath: 'D:/test/doc.tex',
      projectRoot: 'D:/test',
      text: docText,
      files: [{ path: 'D:/test/doc.tex' }],
      phrases: EUKOLIA_EDITOR_PHRASES,
    })

    const handleRef = { current: null as any }

    await act(async () => {
      root.render(
        <VisualEditor
          getText={() => docText}
          applyChange={(change) => {
            docText = docText.slice(0, change.from) + change.insert + docText.slice(change.to)
          }}
          filePath="D:/test/doc.tex"
          scope={scope}
          theme="light"
          startVisual={true}
          handleRef={handleRef}
        />
      )
    })

    const initialView = handleRef.current?.getEditor() as EditorView
    expect(initialView).toBeTruthy()

    // Changing sidebar width setting
    await act(async () => {
      settingsManager.setValue('appearance.sidebarWidth', 320)
    })

    const viewAfterSidebarChange = handleRef.current?.getEditor() as EditorView
    expect(viewAfterSidebarChange).toBe(initialView)

    // Changing general theme setting
    await act(async () => {
      settingsManager.setValue('general.theme', 'dark')
    })

    const viewAfterThemeSetting = handleRef.current?.getEditor() as EditorView
    expect(viewAfterThemeSetting).toBe(initialView)
  })
})
