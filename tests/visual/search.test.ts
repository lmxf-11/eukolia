// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { EditorState, EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  openSearchPanel,
  closeSearchPanel,
  searchPanelOpen,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
} from '@codemirror/search'
import { search, scrollToMatch, toggleReplaceEffect } from '@/vendor/overleaf/extensions/search'

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

const SAMPLE_DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Hello world. This is a search test in document.',
  'Another hello to the world.',
  '\\end{document}',
].join('\n')

describe('in-document search panel (Ctrl+F)', () => {
  let host: HTMLElement
  let view: EditorView

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    view = new EditorView({
      state: EditorState.create({
        doc: SAMPLE_DOC,
        extensions: [
          search(null),
        ],
      }),
      parent: host,
    })
  })

  afterEach(() => {
    view.destroy()
    host.remove()
  })

  it('opens search panel and mounts input with main-field="true"', () => {
    expect(searchPanelOpen(view.state)).toBe(false)
    expect(host.querySelector('.eu-search-panel')).toBeNull()

    openSearchPanel(view)

    expect(searchPanelOpen(view.state)).toBe(true)
    const panel = host.querySelector('.eu-search-panel')
    expect(panel).not.toBeNull()

    const searchInput = panel?.querySelector<HTMLInputElement>('input[main-field="true"]')
    expect(searchInput).not.toBeNull()
    expect(searchInput?.placeholder).toBe('Find')
  })

  it('automatically populates search input with document selection upon openSearchPanel', () => {
    // Select "world" (first occurrence)
    const worldIndex = SAMPLE_DOC.indexOf('world')
    view.dispatch({
      selection: EditorSelection.single(worldIndex, worldIndex + 5),
    })

    openSearchPanel(view)

    const searchInput = host.querySelector<HTMLInputElement>('.eu-search-panel input[main-field="true"]')
    expect(searchInput).not.toBeNull()
    expect(searchInput?.value).toBe('world')
  })

  it('updates match counter and highlights matches', async () => {
    openSearchPanel(view)
    const searchInput = host.querySelector<HTMLInputElement>('.eu-search-panel input[main-field="true"]')!
    const countLabel = host.querySelector<HTMLElement>('.eu-search-count')!

    // Type "world"
    searchInput.value = 'world'
    searchInput.dispatchEvent(new Event('input'))

    // First match is immediately selected
    expect(countLabel.textContent).toBe('1 of 2')

    // Find next advances to second match
    findNext(view)
    expect(countLabel.textContent).toBe('2 of 2')

    // Wraps around to first match
    findNext(view)
    expect(countLabel.textContent).toBe('1 of 2')

    findPrevious(view)
    expect(countLabel.textContent).toBe('2 of 2')
  })

  it('reports "No results" for non-matching queries', () => {
    openSearchPanel(view)
    const searchInput = host.querySelector<HTMLInputElement>('.eu-search-panel input[main-field="true"]')!
    const countLabel = host.querySelector<HTMLElement>('.eu-search-count')!

    searchInput.value = 'nonexistentxyz'
    searchInput.dispatchEvent(new Event('input'))

    expect(countLabel.textContent).toBe('No results')
  })

  it('reports "Invalid regex" when regex option is enabled and pattern is broken', () => {
    openSearchPanel(view)
    const searchInput = host.querySelector<HTMLInputElement>('.eu-search-panel input[main-field="true"]')!
    const countLabel = host.querySelector<HTMLElement>('.eu-search-count')!
    const regexBtn = host.querySelector<HTMLButtonElement>('.eu-search-toggle-btn[title*="Regular Expression"]')!

    regexBtn.click()
    expect(regexBtn.classList.contains('active')).toBe(true)

    searchInput.value = '['
    searchInput.dispatchEvent(new Event('input'))

    expect(countLabel.textContent).toBe('Invalid regex')
    expect(countLabel.classList.contains('has-error')).toBe(true)
  })

  it('supports Replace and Replace All', () => {
    openSearchPanel(view)
    view.dispatch({ effects: toggleReplaceEffect.of(true) })

    const replaceRow = host.querySelector<HTMLElement>('.eu-search-replace-row')!
    expect(replaceRow.style.display).toBe('flex')

    const searchInput = host.querySelector<HTMLInputElement>('.eu-search-panel input[main-field="true"]')!
    const replaceInput = replaceRow.querySelector<HTMLInputElement>('input[placeholder="Replace"]')!

    searchInput.value = 'world'
    searchInput.dispatchEvent(new Event('input'))

    replaceInput.value = 'earth'
    replaceInput.dispatchEvent(new Event('input'))

    // Current selected match is first occurrence
    replaceNext(view)
    expect(view.state.doc.toString()).toContain('Hello earth.')

    // Replace all remaining
    replaceAll(view)
    expect(view.state.doc.toString()).not.toContain('world')
    expect(view.state.doc.toString()).toContain('Another hello to the earth.')
  })

  it('closes search panel and returns focus to editor', () => {
    openSearchPanel(view)
    expect(searchPanelOpen(view.state)).toBe(true)

    const closeBtn = host.querySelector<HTMLButtonElement>('.eu-search-close')!
    closeBtn.click()

    expect(searchPanelOpen(view.state)).toBe(false)
    expect(host.querySelector('.eu-search-panel')).toBeNull()
  })

  it('handles Enter, Shift+Enter, and Escape keydown events in panel', () => {
    openSearchPanel(view)
    const searchInput = host.querySelector<HTMLInputElement>('.eu-search-panel input[main-field="true"]')!
    const countLabel = host.querySelector<HTMLElement>('.eu-search-count')!

    searchInput.value = 'world'
    searchInput.dispatchEvent(new Event('input'))
    expect(countLabel.textContent).toBe('1 of 2')

    // Enter in search input triggers findNext
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(countLabel.textContent).toBe('2 of 2')

    // Shift+Enter triggers findPrevious
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    expect(countLabel.textContent).toBe('1 of 2')

    // Escape closes search panel
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(searchPanelOpen(view.state)).toBe(false)
    expect(host.querySelector('.eu-search-panel')).toBeNull()
  })

  it('toggles Case, Whole Word, and Regex options via keyboard shortcuts Alt+C, Alt+W, Alt+R', () => {
    openSearchPanel(view)
    const panel = host.querySelector<HTMLElement>('.eu-search-panel')!
    const caseBtn = panel.querySelector<HTMLButtonElement>('.eu-search-toggle-btn[title*="Match Case"]')!
    const wordBtn = panel.querySelector<HTMLButtonElement>('.eu-search-toggle-btn[title*="Match Whole Word"]')!
    const regexBtn = panel.querySelector<HTMLButtonElement>('.eu-search-toggle-btn[title*="Regular Expression"]')!

    expect(caseBtn.classList.contains('active')).toBe(false)
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', altKey: true, bubbles: true }))
    expect(caseBtn.classList.contains('active')).toBe(true)

    expect(wordBtn.classList.contains('active')).toBe(false)
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', altKey: true, bubbles: true }))
    expect(wordBtn.classList.contains('active')).toBe(true)

    expect(regexBtn.classList.contains('active')).toBe(false)
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', altKey: true, bubbles: true }))
    expect(regexBtn.classList.contains('active')).toBe(true)
  })

  it('toggles replace row using the chevron button', () => {
    openSearchPanel(view)
    const toggleBtn = host.querySelector<HTMLButtonElement>('.eu-search-toggle-replace')!
    const replaceRow = host.querySelector<HTMLElement>('.eu-search-replace-row')!

    expect(replaceRow.style.display).toBe('none')

    // Click expands replace row
    toggleBtn.click()
    expect(replaceRow.style.display).toBe('flex')

    // Click collapses replace row
    toggleBtn.click()
    expect(replaceRow.style.display).toBe('none')
  })

  it('says which toggle is on for a reader who cannot see the highlight', () => {
    openSearchPanel(view)
    const panel = host.querySelector<HTMLElement>('.eu-search-panel')!
    const caseBtn = panel.querySelector<HTMLButtonElement>('.eu-search-toggle-btn[title*="Match Case"]')!

    expect(caseBtn.getAttribute('aria-pressed')).toBe('false')
    caseBtn.click()
    expect(caseBtn.classList.contains('active')).toBe(true)
    expect(caseBtn.getAttribute('aria-pressed')).toBe('true')

    // The keyboard route sets the same state, so the two cannot drift.
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', altKey: true, bubbles: true }))
    expect(caseBtn.classList.contains('active')).toBe(false)
    expect(caseBtn.getAttribute('aria-pressed')).toBe('false')
  })

  it('disables the controls that need a match when there is none', () => {
    openSearchPanel(view)
    const panel = host.querySelector<HTMLElement>('.eu-search-panel')!
    const searchInput = panel.querySelector<HTMLInputElement>('input[main-field="true"]')!
    const byLabel = (label: string): HTMLButtonElement =>
      panel.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
    // Walking, selecting and replacing all need a match; the close button and
    // the replace chevron do not.
    const nav = (): boolean[] => [
      byLabel('Previous Match'),
      byLabel('Next Match'),
      byLabel('Select All Matches'),
      ...panel.querySelectorAll<HTMLButtonElement>('.eu-search-action-btn'),
    ].map((button) => button.disabled)

    // Nothing typed yet: nothing to walk, nothing to replace.
    expect(nav()).toEqual([true, true, true, true, true])

    searchInput.value = 'world'
    searchInput.dispatchEvent(new Event('input'))
    expect(nav()).toEqual([false, false, false, false, false])

    searchInput.value = 'nonexistentxyz'
    searchInput.dispatchEvent(new Event('input'))
    expect(nav()).toEqual([true, true, true, true, true])

    // A query that cannot be run is not a query with matches either.
    searchInput.value = 'world'
    searchInput.dispatchEvent(new Event('input'))
    panel.querySelector<HTMLButtonElement>('.eu-search-toggle-btn[title*="Regular Expression"]')!.click()
    searchInput.value = '['
    searchInput.dispatchEvent(new Event('input'))
    expect(nav()).toEqual([true, true, true, true, true])
  })

  it('keeps a match clear of the floating widget it is scrolled past', () => {
    // The widget floats over the top of the document, so a match brought to the
    // top edge would land under the card. The scroll target carries the margin
    // that keeps it below.
    const effect = scrollToMatch(EditorSelection.range(0, 5), view) as unknown as {
      value?: { y?: string; yMargin?: number }
    }
    expect(['nearest', 'center']).toContain(effect.value?.y)
    expect(effect.value?.yMargin).toBeGreaterThan(40)
  })
})

describe('the find widget is a floating card', () => {
  /**
   * The theme is a `EditorView.theme` object, so the rules only exist as CSS
   * once an editor has mounted — which is why this reads the injected stylesheet
   * rather than the module. It is the one part of the widget that no behavioural
   * test can see: "does it float" is a question about CSS and nothing else.
   */
  const injectedCss = (): string => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const editor = new EditorView({
      state: EditorState.create({ doc: 'hello world', extensions: [search(null)] }),
      parent: host,
    })
    const css = [...document.querySelectorAll('style')]
      .map((style) => style.textContent ?? '')
      .join('\n')
    editor.destroy()
    host.remove()
    return css
  }

  /** The declarations of one rule of the injected stylesheet. */
  const cssBlock = (css: string, selector: string): string => {
    const at = css.indexOf(selector)
    if (at === -1) return ''
    return css.slice(at, css.indexOf('}', at) + 1)
  }

  it('lifts the card out of the panel slot, below whatever else is in it', () => {
    const decls = cssBlock(injectedCss(), '.eu-search-panel')
    // Absolute inside CodeMirror's sticky panel slot: the card cannot push the
    // document down. `top: 100%` puts it under the slot rather than over it,
    // which is what keeps the visual-mode toolbar — the slot's other tenant —
    // in view.
    expect(decls).toMatch(/position:\s*absolute/)
    expect(decls).toMatch(/top:\s*100%/)
    expect(decls).toMatch(/right:\s*0/)
  })

  it('draws the card on the elevation ladder rather than on a fixed shadow', () => {
    const decls = cssBlock(injectedCss(), '.eu-search-panel')
    expect(decls).toMatch(/var\(--eu-shadow-pop/)
    expect(decls).toMatch(/var\(--eu-radius-xl/)
    expect(decls).toMatch(/var\(--eu-bg-card/)
  })
})

