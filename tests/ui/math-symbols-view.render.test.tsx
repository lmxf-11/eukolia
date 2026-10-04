// @vitest-environment jsdom
/**
 * The Mathematical Symbols panel, mounted.
 *
 * The pure halves of the feature are pinned elsewhere — the catalog, the search
 * ranking, the context classification, the insertion plan and the project
 * resolution each have their own file. What is left is *composition*, and
 * `MathematicalSymbols.md` §11 lists the properties that only a mounted panel
 * can be wrong about:
 *
 *  * clicking a symbol inserts **through the active editor handle**, once, and
 *    returns focus to the source editor rather than leaving it in the search box;
 *  * a symbol the project cannot compile is still shown, is marked, and explains
 *    itself instead of inserting;
 *  * the grid is operable from the keyboard alone;
 *  * favourites and recent history are written to the settings as **stable item
 *    ids**, never as commands, and the recent list is capped;
 *  * and the panel asks the *editor* for its state at the moment of the click
 *    rather than trusting anything it captured when it rendered.
 *
 * The mocks are deliberately thin: the project service is a stub that hands the
 * panel a snapshot, and the preview adapter is stubbed so no test loads MathJax.
 * Everything else — the catalog, the search, the resolver, the planner — is the
 * real implementation, because those are the parts a composition test can
 * actually falsify.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import type { ProjectMacro, ProjectSymbolSnapshot } from '@/mathSymbols/types'

/** An in-memory settings store, and a record of what the panel wrote. */
const store = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  writes: [] as Array<{ key: string; value: unknown }>,
  listeners: [] as Array<() => void>
}))

/** The app state the panel reads, and the editor handle it drives. */
const harness = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  insertions: [] as unknown[],
  focuses: 0,
  /** Replaced by the test with the live editor state. */
  editorState: null as unknown
}))

vi.mock('../../src/renderer/ui/state', () => ({
  useAppState: () => harness.state
}))

vi.mock('../../src/renderer/core/settings', () => ({
  setting: {
    list: (key: string) => (Array.isArray(store.values[key]) ? (store.values[key] as string[]) : []),
    str: (key: string) => (typeof store.values[key] === 'string' ? (store.values[key] as string) : 'available'),
    bool: () => false,
    num: () => 0
  },
  settingsManager: {
    getValue: (key: string) => store.values[key],
    setValue: (key: string, value: unknown) => {
      store.values[key] = value
      store.writes.push({ key, value })
      // The real manager emits `change`, which is how the panel learns that its
      // own write landed and how it keeps its favourites and recents in step.
      // A mock that swallowed the event would make the panel look as though it
      // replaced the list on every click instead of prepending to it.
      for (const listener of store.listeners) listener()
    },
    // `settingsManager.on(event, callback)` — two arguments, as `EventEmitter`
    // defines it. A mock that took only the callback would record the event
    // *name* as a listener and throw on the first write.
    on: (_event: string, listener: () => void) => {
      store.listeners.push(listener)
      return () => {
        store.listeners = store.listeners.filter((item) => item !== listener)
      }
    },
    off: () => undefined,
    emit: () => undefined
  }
}))

/** The project context, as a stub the test can fill in. */
const project = vi.hoisted(() => ({
  snapshot: null as ProjectSymbolSnapshot | null,
  listeners: [] as Array<(event: { snapshot: ProjectSymbolSnapshot }) => void>,
  starts: 0,
  stops: 0
}))

vi.mock('../../src/renderer/mathSymbols/projectSymbolService', () => ({
  projectSymbolService: {
    start: () => {
      project.starts += 1
    },
    stop: () => {
      project.stops += 1
    },
    subscribe: (listener: (event: { snapshot: ProjectSymbolSnapshot }) => void) => {
      project.listeners.push(listener)
      return () => {
        project.listeners = project.listeners.filter((item) => item !== listener)
      }
    },
    getSnapshot: () => project.snapshot,
    refresh: () => project.snapshot
  }
}))

/**
 * A preview adapter that never loads MathJax.
 *
 * The real one typesets a template through the application's MathJax instance;
 * a panel test is about the panel, and loading a TeX engine inside jsdom would
 * measure the engine instead.
 */
vi.mock('../../src/renderer/mathSymbols/preview', async () => {
  const actual = await vi.importActual<typeof import('@/mathSymbols/preview')>(
    '@/mathSymbols/preview'
  )
  return {
    ...actual,
    typesetPreview: async () => null,
    symbolPreview: (entry: { glyph: string | null; preview: string; variants: Array<{ command: string | null }>; name: string }) =>
      entry.preview === 'glyph' && entry.glyph
        ? { kind: 'glyph', glyph: entry.glyph, command: entry.variants[0]?.command ?? entry.name, svg: null, error: null }
        : {
            kind: 'command',
            glyph: null,
            command: entry.variants[0]?.command ?? entry.name,
            svg: null,
            error: null
          }
  }
})

import { MathematicalSymbolsView } from '@/ui/components/MathematicalSymbolsView'

const MAIN = 'D:/project/main.tex'

/** A snapshot with the given macros and packages. */
function snapshotOf(
  macros: ProjectMacro[],
  packages: string[] = [],
  complete = true
): ProjectSymbolSnapshot {
  return {
    revision: 1,
    workspaceRoot: 'D:/project',
    compilationRoot: MAIN,
    complete,
    macros,
    packages,
    engine: 'pdflatex',
    inclusions: [],
    limitations: { root: MAIN, truncated: false, notes: [] }
  }
}

function macroOf(fields: Partial<ProjectMacro> & Pick<ProjectMacro, 'name'>): ProjectMacro {
  return {
    kind: 'newcommand',
    args: 0,
    definition: `\\newcommand{\\${fields.name}}{\\alpha}`,
    expansion: '\\alpha',
    file: MAIN,
    line: 7,
    inScope: true,
    uncertainty: null,
    ...fields
  }
}

let container: HTMLDivElement
let root: Root

/** Mounts the panel and lets React settle. */
async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<MathematicalSymbolsView />)
  })
}

/** Unmounts, so one test's subscriptions cannot reach the next. */
async function unmount(): Promise<void> {
  await act(async () => {
    root.unmount()
  })
  container.remove()
}

/** Every mounted grid cell, in document order. */
const cells = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('[data-testid="math-symbol-cell"]')
]

/** The cell whose label names `command`, or undefined. */
const cellFor = (command: string): HTMLButtonElement | undefined =>
  cells().find((cell) => (cell.getAttribute('aria-label') ?? '').includes(command))

/** Types into the search box the way a user would. */
async function search(text: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')
  if (!input) throw new Error('the search box is missing')
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set
  await act(async () => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Presses a key on an element and lets React settle. */
async function press(target: Element, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

const settingsWrites = (key: string): unknown[] =>
  store.writes.filter((write) => write.key === key).map((write) => write.value)

beforeEach(() => {
  store.values = {}
  store.writes = []
  store.listeners = []
  // No project macros by default: an alias changes *which* spelling wins for a
  // symbol, so a test that is about anything else should not have one in play.
  project.snapshot = snapshotOf([])
  project.listeners = []
  project.starts = 0
  project.stops = 0
  harness.insertions = []
  harness.focuses = 0

  const state = EditorState.create({ doc: 'prose alpha here', extensions: [LaTeXLanguage] })
  ensureSyntaxTree(state, state.doc.length, 10_000)
  harness.editorState = state

  harness.state = {
    editorHandleRef: {
      current: {
        getEditor: () => ({ state: harness.editorState }),
        focus: () => {
          harness.focuses += 1
        },
        applyMathInsertion: (plan: unknown) => {
          harness.insertions.push(plan)
          return { carets: [] }
        }
      }
    }
  }
})

afterEach(async () => {
  await unmount()
})

describe('the panel renders the catalog', () => {
  it('names itself and offers the availability filter', async () => {
    await mount()
    expect(container.textContent).toContain('Mathematical Symbols')
    const filter = container.querySelector<HTMLButtonElement>('.eu-math-symbols__filter')
    expect(filter?.textContent).toBe('Available')
  })

  it('offers every catalog category plus the three views over it', async () => {
    await mount()
    const labels = [...container.querySelectorAll('.eu-math-symbols__category')].map(
      (button) => button.textContent?.replace(/\d+$/, '')
    )
    expect(labels).toContain('All')
    expect(labels).toContain('Greek')
    expect(labels).toContain('Arrows')
    expect(labels).toContain('Templates')
    expect(labels).toContain('Favorites')
    expect(labels).toContain('Recent')
    expect(labels).toContain('Project macros')
  })

  it('says it is still indexing rather than claiming a package is missing', async () => {
    project.snapshot = snapshotOf([], [], false)
    await mount()
    expect(container.textContent).toMatch(/Indexing the project/)
  })

  it('shows the project macros it knows about, and marks them available', async () => {
    // A project macro is available by definition — the project declares it — so
    // the default "Available" filter must not hide it. Its `requires` is empty
    // because there is nothing to require, and reading that as "unknown" would
    // hide every project macro in the one place the panel should hide nothing.
    project.snapshot = snapshotOf([macroOf({ name: 'R', definition: '\\newcommand{\\R}{\\alpha}' })])
    await mount()
    const projectMacros = [...container.querySelectorAll('.eu-math-symbols__category')].find(
      (button) => button.textContent?.startsWith('Project macros')
    )
    expect(projectMacros?.textContent).toMatch(/Project macros1/)
    await act(async () => {
      ;(projectMacros as HTMLButtonElement).click()
    })
    const cell = cellFor('\\R')
    expect(cell).toBeDefined()
    expect(cell?.getAttribute('data-unavailable')).toBe('false')
  })

  it('exposes a macro with arguments as a template with slots', async () => {
    project.snapshot = snapshotOf([
      macroOf({ name: 'vect', args: 1, definition: '\\newcommand{\\vect}[1]{\\mathbf{#1}}', expansion: '\\mathbf{#1}' })
    ])
    await mount()
    const projectMacros = [...container.querySelectorAll('.eu-math-symbols__category')].find(
      (button) => button.textContent?.startsWith('Project macros')
    )!
    await act(async () => {
      ;(projectMacros as HTMLButtonElement).click()
    })
    expect(container.querySelector('.eu-math-symbols__details-code')?.textContent).toBe('\\vect{}')
  })
})

describe('search', () => {
  it('filters the grid as the user types', async () => {
    await mount()
    const before = cells().length
    expect(before).toBeGreaterThan(0)

    await search('\\alpha')
    const first = cells()[0]
    expect(first?.getAttribute('aria-label')).toContain('\\alpha')
  })

  it('reaches a symbol from a keyword when the command is unknown', async () => {
    await mount()
    await search('summation')
    // The query reaches `\sum`, whose command the user did not know.
    expect(cells()[0]?.getAttribute('aria-label')).toContain('\\sum')
  })

  it('accepts a command with or without its backslash', async () => {
    await mount()
    await search('\\beta')
    const withSlash = cells()[0]?.getAttribute('aria-label')

    await search('beta')
    expect(cells()[0]?.getAttribute('aria-label')).toBe(withSlash)
  })

  it('keeps the shell out of the search box', async () => {
    // The global keybindings listen on the window, so a single-letter shortcut
    // would otherwise fire while a query is being typed: `a` would run whatever
    // command owns it and the character would never reach the box.
    await mount()
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!

    let reachedWindow = false
    const spy = () => {
      reachedWindow = true
    }
    window.addEventListener('keydown', spy)
    try {
      await press(input, 'a')
    } finally {
      window.removeEventListener('keydown', spy)
    }

    expect(reachedWindow, 'the keystroke must not reach the window bindings').toBe(false)
  })
})

describe('insertion', () => {
  it('inserts through the editor handle and returns focus to the editor', async () => {
    await mount()
    await search('\\alpha')
    const cell = cells()[0]
    await act(async () => {
      cell.click()
    })

    expect(harness.insertions).toHaveLength(1)
    // The plan is the real planner's, built from the *editor's* state: `prose
    // alpha here` has the caret at 0, so a math-only symbol is wrapped.
    const plan = harness.insertions[0] as { ok: boolean; preview: string }
    expect(plan.ok).toBe(true)
    expect(plan.preview).toBe('$\\alpha$')
    expect(harness.focuses, 'focus must return to the source editor').toBe(1)
  })

  it('prefers a project alias when the project defines one', async () => {
    project.snapshot = snapshotOf([macroOf({ name: 'a' })])
    await mount()
    await search('\\alpha')
    const cell = cells()[0]
    await act(async () => {
      cell.click()
    })
    const plan = harness.insertions[0] as { preview: string }
    // `\a` is this project's own spelling of `\alpha`, and §7 asks for it.
    expect(plan.preview).toBe('$\\a$')
  })

  it('marks a symbol the project cannot compile and refuses to insert it', async () => {
    // `\qty` needs the `physics` package, which this project does not load.
    await mount()
    await act(async () => {
      ;(container.querySelector('.eu-math-symbols__filter') as HTMLButtonElement).click()
    })
    await search('\\qty')
    const cell = cellFor('\\qty') ?? cells()[0]
    expect(cell.getAttribute('data-unavailable')).toBe('true')

    await act(async () => {
      cell.click()
    })
    expect(harness.insertions, 'an unavailable symbol must not be inserted').toHaveLength(0)
    expect(container.querySelector('.eu-math-symbols__status')?.textContent).toMatch(/physics/)
  })

  it('offers Copy for a symbol it will not insert', async () => {
    await mount()
    await act(async () => {
      ;(container.querySelector('.eu-math-symbols__filter') as HTMLButtonElement).click()
    })
    await search('\\qty')
    expect(container.querySelector('.eu-math-symbols__details-actions')?.textContent).toContain('Copy')
  })

  it('states the exact code it will insert', async () => {
    await mount()
    await search('\\alpha')
    expect(container.querySelector('.eu-math-symbols__details-code')?.textContent).toBe('\\alpha')
  })
})

describe('the keyboard', () => {
  it('moves the selection with the arrow keys and inserts with Enter', async () => {
    await mount()
    await search('\\alpha')
    const grid = container.querySelector<HTMLElement>('.eu-math-symbols__grid')!

    await press(grid, 'ArrowRight')
    const selected = container.querySelector('[aria-selected="true"]')
    expect(selected).not.toBeNull()

    await press(grid, 'Enter')
    expect(harness.insertions).toHaveLength(1)
  })

  it('returns focus to the editor on Escape', async () => {
    await mount()
    const grid = container.querySelector<HTMLElement>('.eu-math-symbols__grid')!
    await press(grid, 'Escape')
    expect(harness.focuses).toBe(1)
  })

  it('moves from the search box into the grid on ArrowDown', async () => {
    await mount()
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
    await press(input, 'ArrowDown')
    // Focus moved, so the grid's own key handling now owns the arrows.
    expect(document.activeElement).toBe(container.querySelector('.eu-math-symbols__grid'))
  })
})

describe('favourites and recent history', () => {
  it('stores a favourite as a stable catalog id, not as a command', async () => {
    await mount()
    await search('\\alpha')
    const star = container.querySelector<HTMLButtonElement>('.eu-math-symbols__star')!
    await act(async () => {
      star.click()
    })

    const written = settingsWrites('mathSymbols.favorites').at(-1)
    expect(Array.isArray(written)).toBe(true)
    const ids = written as string[]
    expect(ids).toHaveLength(1)
    // A command would go stale when the catalog's canonical spelling changes; an
    // id keeps the favourite pointing at the same *symbol*.
    expect(ids[0]).toMatch(/^[a-z]+:[A-Za-z0-9@-]+$/)
    expect(ids[0]).not.toContain('\\')
  })

  it('records an insertion in the recent list, newest first', async () => {
    await mount()
    await search('\\alpha')
    await act(async () => {
      cells()[0].click()
    })
    await search('\\beta')
    await act(async () => {
      cells()[0].click()
    })

    const recents = settingsWrites('mathSymbols.recent') as string[][]
    expect(recents, JSON.stringify(recents)).toHaveLength(2)
    // Newest first, and the second insertion did not replace the first.
    expect(recents[1]).toHaveLength(2)
    expect(recents[1][0]).not.toBe(recents[1][1])
    expect(recents[1][1]).toBe(recents[0][0])
  })

  it('caps the recent list', async () => {
    // §3 caps history at 30 entries: the list is a convenience, not a second
    // catalog.
    store.values['mathSymbols.recent'] = Array.from({ length: 30 }, (_, index) => `mjs:pad${index}`)
    await mount()
    await search('\\alpha')
    await act(async () => {
      cells()[0].click()
    })
    const latest = (settingsWrites('mathSymbols.recent') as string[][]).at(-1)!
    expect(latest).toHaveLength(30)
  })
})

describe('lifecycle', () => {
  it('subscribes while mounted and unsubscribes on unmount', async () => {
    // §10 lists "no subscriptions left behind after repeated project switches
    // and panel unmounts" as an acceptance condition, so the panel owning its
    // subscription is the behaviour, not an implementation detail.
    await mount()
    expect(project.starts).toBe(1)
    expect(project.listeners).toHaveLength(1)

    await unmount()
    expect(project.stops).toBe(1)
    expect(project.listeners).toHaveLength(0)
  })

  it('re-renders when the project context changes', async () => {
    await mount()
    await act(async () => {
      ;(container.querySelector('.eu-math-symbols__filter') as HTMLButtonElement).click()
    })
    await search('\\qty')
    expect(cellFor('\\qty')?.getAttribute('data-unavailable')).toBe('true')

    // A new snapshot that loads `physics` makes the same symbol available,
    // without the panel being remounted.
    await act(async () => {
      project.snapshot = snapshotOf([], ['physics'])
      for (const listener of project.listeners) listener({ snapshot: project.snapshot })
    })
    expect(cellFor('\\qty')?.getAttribute('data-unavailable')).toBe('false')
  })
})
