/**
 * The work a keystroke and a caret move are allowed to do.
 *
 * These are the two interactions that measured worst in the running application,
 * and both were paying for work that could not have changed anything:
 *
 *  * **Cursor movement.** The port rebuilds the whole decoration set on every
 *    selection change. Measured on a 500-line document: 109 rebuilds for 100
 *    arrow-key presses, 7.2 ms each, and 8 719 widget constructions for a caret
 *    that moved across one screen — 787 ms of script.
 *  * **The widget preamble.** Each `MathWidget` composed its own definitions
 *    string, so a page of mathematics assembled the same multi-kilobyte string
 *    once per equation, in every rebuild.
 *
 * The fixes are `selectionSignature` and a hoisted composition. Timing them in a
 * test would be flaky — and jsdom performs no layout, so the numbers would not be
 * the application's anyway — so these assert the *mechanism* instead: how many
 * times the expensive thing is called. That is deterministic, and it is also what
 * the fix actually guarantees. The wall-clock numbers are measured in the running
 * application by `scripts/probe-visual.mjs`; `ARCHITECTURE.md` §3.23 records them.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorView } from '@codemirror/view'
import fs from 'node:fs'
import path from 'node:path'

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
  left: 0,
  bottom: 16,
  right: 100,
  width: 100,
  height: 16,
  x: 0,
  y: 0,
  toJSON: () => ({}),
}
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => rect as DOMRect
Element.prototype.getClientRects = () => [rect] as unknown as DOMRectList

const VISUAL = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'renderer',
  'vendor',
  'overleaf',
  'extensions',
  'visual'
)
const DECORATIONS = fs.readFileSync(path.join(VISUAL, 'atomic-decorations.ts'), 'utf8')
const BUILT_IN = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'visual', 'builtinPreamble.ts'),
  'utf8'
)

const DOC = [
  '\\documentclass{article}',
  '\\usepackage{amsmath}',
  '\\newcommand{\\R}{\\mathbb{R}}',
  '',
  '\\begin{document}',
  '',
  'Prose with $x^2$ and more prose, then $\\R$ again.',
  '',
  'More prose in a second paragraph, long enough to move a caret through.',
  '',
  '\\begin{definition}',
  'A set $G$ with $G \\times G \\to G$.',
  '\\end{definition}',
  '',
  '\\end{document}',
  '',
].join('\n')

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function mount(anchor: number) {
  const { EditorState } = await import('@codemirror/state')
  const { EditorView } = await import('@codemirror/view')
  const { forceParsing, syntaxTree } = await import('@codemirror/language')
  const { eukoliaEditorExtensions } = await import('@/visual/editorExtensions')
  const { createEditorScope, EUKOLIA_EDITOR_PHRASES } = await import('@/visual/scope')
  const { setEditable } = await import('@vendor/overleaf/extensions/editable')

  const scope = createEditorScope({
    id: 'decorate-work',
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
        startVisual: true,
      }),
      selection: { anchor },
    }),
    parent: host,
  })
  view.dispatch(setEditable(true))

  forceParsing(view, view.state.doc.length, 10000)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (syntaxTree(view.state).length === view.state.doc.length) break
    await wait(25)
  }
  await wait(120)
  return view
}

/**
 * How many times the decoration pass rebuilt, observed from outside.
 *
 * The field's value is not exported, so this counts the atomic range set's
 * identity across transactions — the same instrument the appearance probe uses,
 * and the same thing a rebuild replaces.
 */
function withRebuildCounter(view: Awaited<ReturnType<typeof mount>>) {
  let rebuilds = 0
  const raw = view.dispatch.bind(view)
  const setsOf = () => view.state.facet(EditorView.atomicRanges)
  let last = setsOf().length ? setsOf()[0](view) : null
  view.dispatch = ((...args: Parameters<typeof view.dispatch>) => {
    raw(...args)
    const now = setsOf().length ? setsOf()[0](view) : null
    if (now !== last) rebuilds += 1
    last = now
  }) as typeof view.dispatch
  return {
    take: () => {
      const n = rebuilds
      rebuilds = 0
      return n
    },
  }
}

describe('a caret moving through prose does not rebuild the decorations', () => {
  it('rebuilds on entering or leaving mathematics, and almost nowhere else', async () => {
    const view = await mount(DOC.indexOf('Prose') + 2)
    try {
      const counter = withRebuildCounter(view)
      await wait(120)
      counter.take()

      // Thirty caret positions inside one plain paragraph: no construct is entered
      // or left, so no rebuild can change anything.
      const paragraph = DOC.indexOf('More prose in a second paragraph')
      const moves: number[] = []
      for (let step = 0; step < 30; step += 1) {
        view.dispatch({ selection: { anchor: paragraph + step } })
        await wait(2)
        moves.push(counter.take())
      }

      const rebuilds = moves.reduce((sum, n) => sum + n, 0)
      expect(
        rebuilds,
        `thirty caret moves inside one paragraph caused ${rebuilds} rebuilds`
      ).toBeLessThanOrEqual(2)

      // And entering mathematics still rebuilds, because that is the moment the
      // rendering genuinely changes — the source has to be revealed.
      const math = DOC.indexOf('$x^2') + 2
      view.dispatch({ selection: { anchor: math } })
      await wait(30)
      expect(counter.take(), 'entering mathematics did not rebuild').toBeGreaterThan(0)
    } finally {
      view.destroy()
    }
  })

  it('rebuilds when the selection is dragged across a construct', async () => {
    // The other direction: a signature that never changed would be a stale
    // rendering. A selection that grows from prose into an equation must rebuild.
    const view = await mount(DOC.indexOf('Prose') + 2)
    try {
      const counter = withRebuildCounter(view)
      await wait(120)
      counter.take()

      const math = DOC.indexOf('$x^2')
      for (const length of [1, 4, 8, 12]) {
        view.dispatch({ selection: { anchor: math - 6, head: math + length } })
        await wait(10)
      }
      expect(
        counter.take(),
        'dragging a selection across an equation never rebuilt'
      ).toBeGreaterThan(0)
    } finally {
      view.destroy()
    }
  })
})

describe('the widget preamble is composed once, not once per equation', () => {
  it('hoists the composition out of the per-widget path', () => {
    // The mechanism, read from the source: every widget in one pass sees the same
    // `commandDefinitions`, so the string is built once and reused. Without the
    // memo the same multi-kilobyte string is assembled per equation, per rebuild.
    expect(DECORATIONS).toContain('composedFor(commandDefinitions)')
    expect(DECORATIONS).toContain('const composedFor = (definitions: string)')
    expect(DECORATIONS).toContain('if (definitions === lastDefinitions) return lastComposed')
    // And the call it replaced is gone from the widget path.
    const widgetPath = DECORATIONS.slice(
      DECORATIONS.indexOf('if (math && math.passToMathJax)'),
      DECORATIONS.indexOf('return false // never decorate inside math')
    )
    expect(widgetPath).not.toContain('composeMacroPreamble(')
    expect(widgetPath).toContain('composedFor(')
  })

  it('computes the built-in definitions once for the life of the module', () => {
    // A pure function of two constants, asked for on every rebuild — and returning
    // the *same* string is what lets `MathWidget.eq` recognise an unchanged
    // equation, since it compares preambles.
    expect(BUILT_IN).toContain('let builtInDefinitions: string | null = null')
    expect(BUILT_IN).toContain('if (builtInDefinitions !== null) return builtInDefinitions')

    // And it really is stable, which is the property the widgets depend on.
    return import('@/visual/builtinPreamble').then(({ builtInMathDefinitions }) => {
      const first = builtInMathDefinitions()
      const second = builtInMathDefinitions()
      expect(second).toBe(first)
      expect(first).toContain('\\qedhere')
      expect(first.length).toBeGreaterThan(100)
    })
  })
})

describe('the render cache is consulted before MathJax', () => {
  it('asks the cache first and only then loads the typesetter', () => {
    // The order is the fix from §3.19 and it is easy to lose: a widget that loads
    // MathJax before checking the cache has already paid the parse.
    const math = fs.readFileSync(path.join(VISUAL, 'visual-widgets', 'math.ts'), 'utf8')
    const cacheLookup = math.indexOf('cachedMathSvg(')
    const typesetter = math.indexOf('await loadMathJax()')
    expect(cacheLookup).toBeGreaterThan(0)
    expect(typesetter).toBeGreaterThan(0)
    expect(cacheLookup, 'the cache is consulted after MathJax is loaded').toBeLessThan(
      typesetter
    )
  })
})
