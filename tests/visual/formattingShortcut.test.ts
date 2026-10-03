/**
 * `Ctrl+B` means `\textbf` only when there is something to make bold.
 *
 * Three different things claim `Ctrl+B` in this application, and the collision is
 * not a mistake to be tidied away — each is a reasonable binding:
 *
 *  * the editor's keymap (`Prec.high`), to wrap the selection in `\textbf`;
 *  * the shell's command registry, to Toggle Sidebar (`view.toggleSidebar`);
 *  * the shell's command registry again, to Build Project (`latex.build`).
 *
 * Priority alone cannot settle it, because whichever layer wins, the other two are
 * unreachable with the caret in the document. What settles it is that the three can
 * be told apart by *state* rather than by key: with text selected, `\textbf` is
 * unambiguous and is what a reader means; with only a caret there is nothing to
 * wrap, and the reference's own `toggleRanges` would put an empty `\textbf{}` at
 * the caret. So the editor's binding declines when the selection is empty and the
 * event falls through to the shell.
 *
 * An Electron **menu accelerator** also used to take this key in the main process
 * — before any `keydown` reached the renderer — which made all three bindings
 * unreachable at once. That is pinned here too, because it is invisible from the
 * renderer and would silently come back.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..', '..')
const SHORTCUTS = fs.readFileSync(
  path.join(
    ROOT,
    'src',
    'renderer',
    'vendor',
    'overleaf',
    'languages',
    'latex',
    'shortcuts.ts'
  ),
  'utf8'
)
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf8')
const APP = fs.readFileSync(
  path.join(ROOT, 'src', 'renderer', 'ui', 'App.tsx'),
  'utf8'
)

// The ported LaTeX language constructs a lint Web Worker on import; jsdom has no
// `Worker`, so a minimal stub keeps the language loadable.
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

const rect = {
  top: 0,
  bottom: 16,
  left: 0,
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

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Prose that can be made bold.',
  '\\end{document}',
  '',
].join('\n')

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function mount(anchor: number, head = anchor) {
  const { EditorState } = await import('@codemirror/state')
  const { EditorView } = await import('@codemirror/view')
  const { forceParsing, syntaxTree } = await import('@codemirror/language')
  const { eukoliaEditorExtensions } = await import('@/visual/editorExtensions')
  const { createEditorScope, EUKOLIA_EDITOR_PHRASES } = await import('@/visual/scope')
  const { setEditable } = await import('@vendor/overleaf/extensions/editable')

  const scope = createEditorScope({
    id: 'shortcut-selection',
    filePath: 'D:/project/main.tex',
    projectRoot: 'D:/project',
    text: DOC,
    files: [{ path: 'D:/project/main.tex' }],
    phrases: EUKOLIA_EDITOR_PHRASES,
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: eukoliaEditorExtensions({
        scope,
        fileName: 'main.tex',
        theme: 'dark',
        startVisual: false,
      }),
      selection: { anchor, head },
    }),
    parent: host,
  })
  view.dispatch(setEditable(true))

  forceParsing(view, view.state.doc.length, 10000)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (syntaxTree(view.state).length === view.state.doc.length) break
    await wait(25)
  }
  await wait(100)
  return view
}

/** Presses Ctrl+B the way the browser reports it, on the focused editor. */
function pressCtrlB(view: Awaited<ReturnType<typeof mount>>): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'b',
      code: 'KeyB',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
  )
}

describe('the editor declines `Ctrl+B` when nothing is selected', () => {
  it('leaves the document alone with only a caret', async () => {
    const view = await mount(DOC.indexOf('Prose') + 5)
    try {
      pressCtrlB(view)
      await wait(60)
      const text = view.state.doc.toString()
      expect(text, 'the editor inserted a command with nothing selected').toBe(DOC)
      expect(text).not.toContain('\\textbf')
    } finally {
      view.destroy()
    }
  })

  it('wraps the selection when there is one', async () => {
    const from = DOC.indexOf('Prose')
    const view = await mount(from, from + 'Prose that'.length)
    try {
      pressCtrlB(view)
      await wait(60)
      expect(view.state.doc.toString()).toContain('\\textbf{Prose that}')
    } finally {
      view.destroy()
    }
  })

  it('declines by returning false, which is what lets the shell have the key', () => {
    // `true` from a keymap handler prevents the default; `false` lets the next
    // binding be tried and the event continue to the shell's own listener. The
    // distinction is the whole mechanism.
    expect(SHORTCUTS).toContain('needsSelection')
    expect(SHORTCUTS).toMatch(/some\(range => !range\.empty\)/)
    expect(SHORTCUTS).toContain('Prec.high')
    // And the reason is written down, because it is a divergence from the
    // reference and the next reader will otherwise "simplify" it away.
    expect(SHORTCUTS).toMatch(/Eukolia divergence/)
  })
})

describe('nothing upstream swallows the key first', () => {
  it('does not claim `Ctrl+B` as an Electron menu accelerator', () => {
    // A menu accelerator is handled in the main process, before the renderer sees
    // a `keydown` at all — no listener in the page runs, which is why this was
    // invisible from every renderer-side test and from the key log.
    const accelerators = [...MAIN.matchAll(/accelerator:\s*'([^']+)'/g)].map(match =>
      match[1].toLowerCase()
    )
    expect(accelerators).not.toContain('cmdorctrl+b')
    // The menu items are still there; they simply carry no accelerator.
    expect(MAIN).toContain("label: 'Build'")
    expect(MAIN).toContain("'menu:command', 'latex.build'")
    // And the reason is recorded where the accelerator was, because a menu
    // accelerator looks harmless and silently shadows every renderer binding.
    expect(MAIN).toMatch(/menu accelerator/i)
  })

  it('keeps every accelerator it does declare on a key the renderer does not need', () => {
    // The other accelerators are the standard ones — open, save, the mode
    // switches, the palette — and none of them is also a command binding whose
    // `when` clause could matter. A collision here would shadow the renderer the
    // same way `Ctrl+B` did.
    const accelerators = [...MAIN.matchAll(/accelerator:\s*'([^']+)'/g)].map(match =>
      match[1].toLowerCase()
    )
    expect(accelerators.length).toBeGreaterThan(0)
    for (const accelerator of accelerators) {
      expect(accelerator, `${accelerator} is claimed by the menu`).not.toBe('cmdorctrl+b')
      expect(accelerator).not.toBe('cmdorctrl+i')
    }
  })

  it('keeps the sidebar bound to `Ctrl+B` in the shell', () => {
    // The binding the key is supposed to reach once the editor declines it.
    expect(APP).toMatch(/id: 'view\.toggleSidebar'[^}]*keybinding: 'Ctrl\+B'/)
  })

  it('lets a focused input keep its own keys', () => {
    // The shell's handler must not steal the key from a text field, which is the
    // other half of "the right layer wins".
    expect(APP).toContain('isTypingField')
    expect(APP).toContain('GLOBAL_OVERLAY_COMMANDS')
  })
})
