import {
  search as _search,
  setSearchQuery,
  getSearchQuery,
  openSearchPanel,
  SearchQuery,
  searchPanelOpen,
  searchKeymap,
  highlightSelectionMatches,
  closeSearchPanel,
  findNext,
  findPrevious,
  selectMatches,
  replaceNext,
  replaceAll,
} from '@codemirror/search'
// Overleaf's patched @codemirror/search exports a `togglePanel` effect, which
// the stored-selection field below watches. Eukolia declares the same effect and
// dispatches it from the panel's own key bindings.
import { togglePanel } from '@/vendor/overleaf/eukolia/search-panel-effect'
import {
  Decoration,
  EditorView,
  KeyBinding,
  keymap,
  Panel,
  runScopeHandlers,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view'
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  SelectionRange,
  StateEffect,
  StateField,
  TransactionSpec,
} from '@codemirror/state'
import { sendSearchEvent } from '@/vendor/overleaf/eukolia/analytics'
import { isVisual } from '@/vendor/overleaf/extensions/visual/visual'
import { beforeChangeDocEffect } from '@/vendor/overleaf/extensions/before-change-doc'

const restoreSearchQueryAnnotation = Annotation.define<boolean>()

const selectNextMatch = (query: SearchQuery, state: EditorState) => {
  if (!query.valid) {
    return false
  }

  let cursor = query.getCursor(state.doc, state.selection.main.from)

  let result = cursor.next()

  if (result.done) {
    cursor = query.getCursor(state.doc)
    result = cursor.next()
  }

  return result.done ? null : result.value
}

const storedSelectionEffect = StateEffect.define<EditorSelection | null>()

const storedSelectionState = StateField.define<EditorSelection | null>({
  create() {
    return null
  },
  update(value, tr) {
    if (value) {
      value = value.map(tr.changes)
    }

    for (const effect of tr.effects) {
      if (effect.is(storedSelectionEffect)) {
        value = effect.value
      } else if (effect.is(togglePanel) && effect.value === false) {
        value = null // clear the stored selection when closing the search panel
      }
    }

    if (searchPanelOpen(tr.startState) && !searchPanelOpen(tr.state)) {
      value = null
    }

    return value
  },
  provide(f) {
    return [
      EditorView.decorations.from(f, selection => {
        if (!selection) {
          return Decoration.none
        }
        const decorations = selection.ranges
          .filter(range => !range.empty)
          .map(range =>
            Decoration.mark({
              class: 'ol-cm-stored-selection',
            }).range(range.from, range.to)
          )
        return Decoration.set(decorations)
      }),
    ]
  },
})

export const getStoredSelection = (state: EditorState) =>
  state.field(storedSelectionState)

export const setStoredSelection = (selection: EditorSelection | null) => {
  return {
    effects: [
      storedSelectionEffect.of(selection),
      // TODO: only disable selection highlighting if the current selection is a search match
      highlightSelectionMatchesConf.reconfigure(
        selection ? [] : highlightSelectionMatchesExtension
      ),
    ],
  }
}

const highlightSelectionMatchesConf = new Compartment()

const highlightSelectionMatchesExtension = highlightSelectionMatches({
  wholeWords: true,
})

/**
 * Brings a match into view, clear of the floating widget.
 *
 * Exported because the margin below is the only part of the widget's placement
 * a test can assert without a layout engine.
 */
export const scrollToMatch = (range: SelectionRange, view: EditorView) => {
  const coords = {
    from: view.coordsAtPos(range.from),
    to: view.coordsAtPos(range.to),
  }
  const scrollRect = view.scrollDOM.getBoundingClientRect()
  const strategy =
    (coords.from && coords.from.top < scrollRect.top) ||
    (coords.to && coords.to.bottom > scrollRect.bottom)
      ? 'center'
      : 'nearest'

  return EditorView.scrollIntoView(range, {
    y: strategy,
    /*
     * The find widget floats over the top of the document (see
     * `searchFormTheme`), so "just visible" is not visible enough: a match
     * scrolled to the very top would land underneath the card. The margin is the
     * card's own height — 8px inset, 8px padding, a 28px row — plus a little
     * air, which is what keeps a match clear of it at every zoom of the UI.
     */
    yMargin: 64,
  })
}

export const toggleReplaceEffect = StateEffect.define<boolean>()

const CHEVRON_RIGHT_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`
const CHEVRON_DOWN_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`
const ARROW_UP_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`
const ARROW_DOWN_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>`
const SELECT_ALL_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>`
const CLOSE_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`

export class EukoliaSearchPanel implements Panel {
  readonly dom: HTMLElement
  readonly top = true
  readonly pos = 100
  readonly view: EditorView

  private searchInput: HTMLInputElement
  private replaceInput: HTMLInputElement
  private caseBtn: HTMLButtonElement
  private wordBtn: HTMLButtonElement
  private regexBtn: HTMLButtonElement
  private countLabel: HTMLElement
  private searchGroup: HTMLElement
  private replaceRow: HTMLElement
  private toggleReplaceBtn: HTMLButtonElement
  /**
   * The controls that need a match to act on.
   *
   * They are held rather than left as locals because their enabled state follows
   * the match count: with nothing to find, "next", "select all", "Replace" and
   * "Replace All" are disabled rather than silently doing nothing.
   */
  private prevBtn: HTMLButtonElement
  private nextBtn: HTMLButtonElement
  private selectBtn: HTMLButtonElement
  private replaceBtn: HTMLButtonElement
  private replaceAllBtn: HTMLButtonElement
  private replaceExpanded = false
  private currentQuery: SearchQuery

  constructor(view: EditorView) {
    this.view = view
    this.currentQuery = getSearchQuery(view.state)

    this.dom = document.createElement('div')
    this.dom.className = 'cm-panel eu-search-panel'
    this.dom.setAttribute('role', 'region')
    this.dom.setAttribute('aria-label', 'Search in document')

    this.dom.addEventListener('keydown', (e: KeyboardEvent) => {
      if (runScopeHandlers(this.view, e, 'search-panel')) {
        e.preventDefault()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSearchPanel(this.view)
        return
      }
      if (e.key === 'Enter') {
        if (e.target === this.searchInput) {
          e.preventDefault()
          if (e.shiftKey) {
            findPrevious(this.view)
          } else {
            findNext(this.view)
          }
        } else if (e.target === this.replaceInput) {
          e.preventDefault()
          if ((e.ctrlKey || e.metaKey) && e.altKey) {
            replaceAll(this.view)
          } else {
            replaceNext(this.view)
          }
        }
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === 'c' || e.key === 'C') {
          e.preventDefault()
          this.toggleCase()
        } else if (e.key === 'w' || e.key === 'W') {
          e.preventDefault()
          this.toggleWord()
        } else if (e.key === 'r' || e.key === 'R') {
          e.preventDefault()
          this.toggleRegex()
        } else if (e.key === 'Enter' && e.target === this.searchInput) {
          e.preventDefault()
          selectMatches(this.view)
        }
      }
    })

    // --- Row 1: Find controls ---
    const findRow = document.createElement('div')
    findRow.className = 'eu-search-row'

    // Replace toggle button
    this.toggleReplaceBtn = document.createElement('button')
    this.toggleReplaceBtn.type = 'button'
    this.toggleReplaceBtn.className = 'eu-search-btn eu-search-toggle-replace'
    this.toggleReplaceBtn.title = 'Toggle Replace (Ctrl+H)'
    this.toggleReplaceBtn.setAttribute('aria-label', 'Toggle Replace')
    // The replace row starts folded, which is the state the chevron points at.
    this.toggleReplaceBtn.setAttribute('aria-expanded', 'false')
    this.toggleReplaceBtn.innerHTML = CHEVRON_RIGHT_SVG
    this.toggleReplaceBtn.onclick = () => this.setReplaceExpanded(!this.replaceExpanded)
    findRow.appendChild(this.toggleReplaceBtn)

    // Search input group
    this.searchGroup = document.createElement('div')
    this.searchGroup.className = 'eu-search-input-group'

    this.searchInput = document.createElement('input')
    this.searchInput.type = 'text'
    this.searchInput.className = 'eu-search-input'
    this.searchInput.placeholder = 'Find'
    this.searchInput.setAttribute('main-field', 'true')
    this.searchInput.setAttribute('aria-label', 'Find in document')
    this.searchInput.spellcheck = false
    this.searchInput.autocomplete = 'off'
    this.searchInput.value = this.currentQuery.search || ''
    this.searchInput.oninput = () => this.commit()

    this.caseBtn = document.createElement('button')
    this.caseBtn.type = 'button'
    this.caseBtn.className = 'eu-search-toggle-btn'
    this.caseBtn.title = 'Match Case (Alt+C)'
    this.caseBtn.textContent = 'Aa'
    this.caseBtn.onclick = () => this.toggleCase()

    this.wordBtn = document.createElement('button')
    this.wordBtn.type = 'button'
    this.wordBtn.className = 'eu-search-toggle-btn'
    this.wordBtn.title = 'Match Whole Word (Alt+W)'
    this.wordBtn.textContent = '\\b'
    this.wordBtn.onclick = () => this.toggleWord()

    this.regexBtn = document.createElement('button')
    this.regexBtn.type = 'button'
    this.regexBtn.className = 'eu-search-toggle-btn'
    this.regexBtn.title = 'Use Regular Expression (Alt+R)'
    this.regexBtn.textContent = '.*'
    this.regexBtn.onclick = () => this.toggleRegex()

    // The three option toggles are pressed/unpressed controls, and the class
    // that draws them is not something a screen reader can see.
    this.setToggle(this.caseBtn, this.currentQuery.caseSensitive)
    this.setToggle(this.wordBtn, this.currentQuery.wholeWord)
    this.setToggle(this.regexBtn, this.currentQuery.regexp)

    this.searchGroup.appendChild(this.searchInput)
    this.searchGroup.appendChild(this.caseBtn)
    this.searchGroup.appendChild(this.wordBtn)
    this.searchGroup.appendChild(this.regexBtn)
    findRow.appendChild(this.searchGroup)

    // Match count badge
    this.countLabel = document.createElement('span')
    this.countLabel.className = 'eu-search-count'
    // The one read-out in the widget: announced as it changes, because "no
    // results" is the answer to the question the reader just typed.
    this.countLabel.setAttribute('aria-live', 'polite')
    findRow.appendChild(this.countLabel)

    // Previous button
    this.prevBtn = document.createElement('button')
    this.prevBtn.type = 'button'
    this.prevBtn.className = 'eu-search-btn'
    this.prevBtn.title = 'Previous Match (Shift+Enter)'
    this.prevBtn.setAttribute('aria-label', 'Previous Match')
    this.prevBtn.innerHTML = ARROW_UP_SVG
    this.prevBtn.onclick = () => findPrevious(this.view)
    findRow.appendChild(this.prevBtn)

    // Next button
    this.nextBtn = document.createElement('button')
    this.nextBtn.type = 'button'
    this.nextBtn.className = 'eu-search-btn'
    this.nextBtn.title = 'Next Match (Enter)'
    this.nextBtn.setAttribute('aria-label', 'Next Match')
    this.nextBtn.innerHTML = ARROW_DOWN_SVG
    this.nextBtn.onclick = () => findNext(this.view)
    findRow.appendChild(this.nextBtn)

    // Select All button
    this.selectBtn = document.createElement('button')
    this.selectBtn.type = 'button'
    this.selectBtn.className = 'eu-search-btn'
    this.selectBtn.title = 'Select All Matches (Alt+Enter)'
    this.selectBtn.setAttribute('aria-label', 'Select All Matches')
    this.selectBtn.innerHTML = SELECT_ALL_SVG
    this.selectBtn.onclick = () => selectMatches(this.view)
    findRow.appendChild(this.selectBtn)

    // Close button
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'eu-search-btn eu-search-close'
    closeBtn.title = 'Close (Escape)'
    closeBtn.setAttribute('aria-label', 'Close Search')
    closeBtn.innerHTML = CLOSE_SVG
    closeBtn.onclick = () => closeSearchPanel(this.view)
    findRow.appendChild(closeBtn)

    this.dom.appendChild(findRow)

    // --- Row 2: Replace controls (collapsible) ---
    this.replaceRow = document.createElement('div')
    this.replaceRow.className = 'eu-search-row eu-search-replace-row'
    this.replaceRow.style.display = 'none'

    const indent = document.createElement('div')
    // Sized by the theme, at the chevron's own width, so the two fields line up
    // as one column instead of at a number written here.
    indent.className = 'eu-search-replace-indent'
    this.replaceRow.appendChild(indent)

    const replaceGroup = document.createElement('div')
    replaceGroup.className = 'eu-search-input-group'

    this.replaceInput = document.createElement('input')
    this.replaceInput.type = 'text'
    this.replaceInput.className = 'eu-search-input'
    this.replaceInput.placeholder = 'Replace'
    this.replaceInput.setAttribute('aria-label', 'Replace with')
    this.replaceInput.spellcheck = false
    this.replaceInput.autocomplete = 'off'
    this.replaceInput.value = this.currentQuery.replace || ''
    this.replaceInput.oninput = () => this.commit()
    replaceGroup.appendChild(this.replaceInput)
    this.replaceRow.appendChild(replaceGroup)

    this.replaceBtn = document.createElement('button')
    this.replaceBtn.type = 'button'
    this.replaceBtn.className = 'eu-search-action-btn'
    this.replaceBtn.title = 'Replace (Enter)'
    this.replaceBtn.textContent = 'Replace'
    this.replaceBtn.onclick = () => replaceNext(this.view)
    this.replaceRow.appendChild(this.replaceBtn)

    this.replaceAllBtn = document.createElement('button')
    this.replaceAllBtn.type = 'button'
    this.replaceAllBtn.className = 'eu-search-action-btn'
    this.replaceAllBtn.title = 'Replace All (Ctrl+Alt+Enter)'
    this.replaceAllBtn.textContent = 'Replace All'
    this.replaceAllBtn.onclick = () => replaceAll(this.view)
    this.replaceRow.appendChild(this.replaceAllBtn)

    this.dom.appendChild(this.replaceRow)
    // Nothing has been searched for yet, so there is nothing to walk or replace.
    this.setMatchControlsEnabled(false)
  }

  /**
   * Draws and announces a toggle's state.
   *
   * `aria-pressed` and the `active` class are the same fact told twice — once to
   * the eye and once to a screen reader — so they are set together and cannot
   * drift apart.
   */
  private setToggle(button: HTMLButtonElement, pressed: boolean) {
    button.classList.toggle('active', pressed)
    button.setAttribute('aria-pressed', pressed ? 'true' : 'false')
  }

  /** Enables the controls that act on a match, or the ones that need one. */
  private setMatchControlsEnabled(enabled: boolean) {
    for (const button of [
      this.prevBtn,
      this.nextBtn,
      this.selectBtn,
      this.replaceBtn,
      this.replaceAllBtn,
    ]) {
      button.disabled = !enabled
    }
  }

  private toggleCase() {
    this.setToggle(this.caseBtn, !this.caseBtn.classList.contains('active'))
    this.commit()
  }

  private toggleWord() {
    this.setToggle(this.wordBtn, !this.wordBtn.classList.contains('active'))
    this.commit()
  }

  private toggleRegex() {
    this.setToggle(this.regexBtn, !this.regexBtn.classList.contains('active'))
    this.commit()
  }

  setReplaceExpanded(expanded: boolean) {
    this.replaceExpanded = expanded
    this.replaceRow.style.display = expanded ? 'flex' : 'none'
    this.toggleReplaceBtn.innerHTML = expanded ? CHEVRON_DOWN_SVG : CHEVRON_RIGHT_SVG
    this.toggleReplaceBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    if (expanded) {
      this.replaceInput.focus()
      this.replaceInput.select()
    }
  }

  private commit() {
    const newQuery = new SearchQuery({
      search: this.searchInput.value,
      caseSensitive: this.caseBtn.classList.contains('active'),
      wholeWord: this.wordBtn.classList.contains('active'),
      regexp: this.regexBtn.classList.contains('active'),
      replace: this.replaceInput.value,
    })
    if (!newQuery.eq(this.currentQuery)) {
      this.currentQuery = newQuery
      this.view.dispatch({ effects: setSearchQuery.of(newQuery) })
    }
    this.updateMatchCount()
  }

  mount() {
    const q = getSearchQuery(this.view.state)
    if (q && q.search) {
      this.currentQuery = q
      this.searchInput.value = q.search
      this.setToggle(this.caseBtn, q.caseSensitive)
      this.setToggle(this.wordBtn, q.wholeWord)
      this.setToggle(this.regexBtn, q.regexp)
      if (q.replace) this.replaceInput.value = q.replace
    }
    this.searchInput.focus()
    this.searchInput.select()
    this.updateMatchCount()
  }

  destroy() {}

  update(update: ViewUpdate) {
    let queryChanged = false
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery)) {
          const q = effect.value
          if (!q.eq(this.currentQuery)) {
            this.currentQuery = q
            queryChanged = true
            if (this.searchInput.value !== q.search) {
              this.searchInput.value = q.search
            }
            if (this.replaceInput.value !== q.replace) {
              this.replaceInput.value = q.replace
            }
            this.setToggle(this.caseBtn, q.caseSensitive)
            this.setToggle(this.wordBtn, q.wholeWord)
            this.setToggle(this.regexBtn, q.regexp)
          }
        } else if (effect.is(toggleReplaceEffect)) {
          this.setReplaceExpanded(effect.value)
        }
      }
    }
    if (queryChanged || update.docChanged || update.selectionSet) {
      this.updateMatchCount()
    }
  }

  private updateMatchCount() {
    const query = this.currentQuery
    if (!query.search) {
      this.countLabel.textContent = ''
      this.countLabel.classList.remove('has-error')
      this.searchGroup.classList.remove('has-error')
      this.setMatchControlsEnabled(false)
      return
    }
    if (!query.valid) {
      this.countLabel.textContent = 'Invalid regex'
      this.countLabel.classList.add('has-error')
      this.searchGroup.classList.add('has-error')
      this.setMatchControlsEnabled(false)
      return
    }
    this.countLabel.classList.remove('has-error')
    this.searchGroup.classList.remove('has-error')

    const maxMatches = 1000
    let count = 0
    let current = 0
    const sel = this.view.state.selection.main
    const cursor = query.getCursor(this.view.state.doc)
    let match = cursor.next()
    while (!match.done) {
      count++
      if (match.value.from === sel.from && match.value.to === sel.to) {
        current = count
      } else if (current === 0 && sel.from >= match.value.from && sel.to <= match.value.to) {
        current = count
      }
      if (count > maxMatches) break
      match = cursor.next()
    }
    const isCapped = count > maxMatches
    const totalStr = isCapped ? `${maxMatches}+` : `${count}`
    if (count === 0) {
      this.countLabel.textContent = 'No results'
    } else if (current > 0) {
      this.countLabel.textContent = `${current} of ${totalStr}`
    } else {
      this.countLabel.textContent = `${totalStr} found`
    }
    // A query with no match has nothing for "next", "select all" or either
    // replace button to act on, so they say so instead of doing nothing.
    this.setMatchControlsEnabled(count > 0)
  }
}

const searchPanelToggleKeymap: KeyBinding[] = [
  {
    key: 'Mod-f',
    preventDefault: true,
    scope: 'editor search-panel',
    run(view) {
      if (!searchPanelOpen(view.state)) {
        sendSearchEvent('search-open', {
          searchType: 'document',
          method: 'keyboard',
          mode: isVisual(view) ? 'visual' : 'source',
        })
      }
      openSearchPanel(view)
      return true
    },
  },
  {
    key: 'Mod-h',
    preventDefault: true,
    scope: 'editor search-panel',
    run(view) {
      if (!searchPanelOpen(view.state)) {
        sendSearchEvent('search-open', {
          searchType: 'document',
          method: 'keyboard',
          mode: isVisual(view) ? 'visual' : 'source',
        })
      }
      openSearchPanel(view)
      view.dispatch({ effects: toggleReplaceEffect.of(true) })
      return true
    },
  },
  {
    key: 'Escape',
    scope: 'editor search-panel',
    run(view) {
      view.dispatch({ effects: togglePanel.of(false) })
      return closeSearchPanel(view)
    },
  },
]

/**
 * A collection of extensions related to the search feature.
 */
export const search = (initialSearchQuery: SearchQuery | null) => {
  return [
    // panel toggle effect, dispatched before the built-in search shortcuts
    Prec.highest(keymap.of(searchPanelToggleKeymap)),

    // keymap for search
    keymap.of(searchKeymap),

    // highlight text which matches the current selection
    highlightSelectionMatchesConf.of(highlightSelectionMatchesExtension),

    // a stored selection for use in "within selection" searches
    storedSelectionState,

    /**
     * The CodeMirror `search` extension, configured with Eukolia's custom panel
     * and scrolling the search match into view when needed.
     */
    _search({
      top: true,
      scrollToMatch,
      createPanel: view => new EukoliaSearchPanel(view),
    }),

    // restore a stored search and re-open the search panel
    ViewPlugin.define(view => {
      if (initialSearchQuery) {
        const _searchQuery = initialSearchQuery
        window.setTimeout(() => {
          openSearchPanel(view)
          view.dispatch({
            effects: setSearchQuery.of(_searchQuery),
            annotations: restoreSearchQueryAnnotation.of(true),
          })
        }, 0)
      }

      return {
        // Fire an event containing the search query before a document change
        // so that it can be persisted for the next document
        update(update: ViewUpdate) {
          for (const tr of update.transactions) {
            for (const effect of tr.effects) {
              if (effect.is(beforeChangeDocEffect)) {
                const searchQuery = searchPanelOpen(view.state) ? getSearchQuery(view.state) : null
                window.dispatchEvent(
                  new CustomEvent('search-panel-before-doc-change', {
                    detail: searchQuery,
                  })
                )
              }
            }
          }
        },
      }
    }),

    // select a match while searching
    EditorView.updateListener.of(update => {
      // if the search panel wasn't open, don't select a match
      if (!searchPanelOpen(update.startState)) {
        return
      }

      for (const tr of update.transactions) {
        // avoid changing the selection and viewport when switching between files
        if (tr.annotation(restoreSearchQueryAnnotation)) {
          continue
        }

        for (const effect of tr.effects) {
          if (effect.is(setSearchQuery)) {
            const query = effect.value
            if (!query) return

            const currentQuery = getSearchQuery(tr.startState)
            if (currentQuery === query) {
              return // avoiding selecting the next match when opening the search form with no selected text
            }

            // The rest of this messes up searching in Vim, which is handled by
            // the Vim extension, so bail out here in Vim mode. Happily, the
            // Vim extension sticks an extra property on the query value that
            // can be checked
            if ('forVim' in query) return

            const next = selectNextMatch(query, tr.state)

            if (next) {
              // select a match if possible
              const spec: TransactionSpec = {
                selection: { anchor: next.from, head: next.to },
                userEvent: 'select.search',
              }

              // scroll into view if not opening the panel
              if (searchPanelOpen(tr.startState)) {
                spec.effects = scrollToMatch(
                  EditorSelection.range(next.from, next.to),
                  update.view
                )
              }

              update.view.dispatch(spec)
            } else {
              // clear the selection if the query became invalid
              const prevQuery = getSearchQuery(tr.startState)

              if (prevQuery.valid) {
                const { from } = tr.startState.selection.main

                update.view.dispatch({
                  selection: { anchor: from },
                })
              }
            }
          }
        }
      }
    }),
    searchFormTheme,
  ]
}

/*
 * The find widget's look.
 *
 * It is a floating card, not the strip CodeMirror draws by default. The card is
 * taken out of the panel's flow and pinned to the corner below the slot, so the
 * first lines of the document stay where they are and the widget hovers over
 * them — the place VS Code puts its find widget.
 *
 * `top: 100%` rather than `top: 0` is what keeps it honest about the *other*
 * tenant of that slot: the visual-mode toolbar is a top panel too, and the
 * toolbar is mounted in **both** modes (its state field starts `true`), so the
 * slot is a real strip in visual mode and a zero-height one in code mode. Pinned
 * below the slot, the widget floats at the top of the editor when there is
 * nothing above it, and under the toolbar when there is — never over the
 * toolbar, and never pushing the text down either way.
 *
 * The slot itself is left exactly as CodeMirror made it (`position: sticky`,
 * full width, the theme's panel background): with the card out of its flow it
 * collapses to the height of whatever else is in it, which is nothing in code
 * mode.
 *
 * Every value is a token — from `index.css` for the palette and
 * `ui/eukolia-design.css` for the spacing, radius, type and elevation scales —
 * so the widget follows all the themes, the light/dark elevation ladder and the
 * reduced-motion and raised-contrast preferences without a line of JavaScript.
 * The fallbacks are the dark theme's, for the first paint before the theme
 * manager has run.
 */
const searchFormTheme = EditorView.theme({
  // ----------------------------------------------------------------- the card
  '.eu-search-panel': {
    position: 'absolute',
    // Directly below the panel slot: the editor's top edge in code mode, the
    // toolbar's bottom edge in visual mode.
    top: '100%',
    right: '0',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--eu-space-2)',
    // The gap from the corner is what reads as "floating": flush against the
    // edge the card would look like the strip it used to be.
    margin: 'var(--eu-space-2) var(--eu-space-3) 0 0',
    padding: 'var(--eu-space-2)',
    width: 'max-content',
    // Percentages resolve against the panel slot, which spans the editor, so a
    // narrow pane shrinks the widget rather than pushing it off the edge.
    maxWidth: 'calc(100% - var(--eu-space-6))',
    minWidth: '320px',
    backgroundColor: 'var(--eu-bg-card, #181b25)',
    border: '1px solid var(--eu-border, #232838)',
    borderRadius: 'var(--eu-radius-xl, 12px)',
    // The one place in the application that uses the "pop" step: it is the
    // elevation for a surface that hovers over content rather than sitting in it.
    boxShadow: 'var(--eu-shadow-pop, 0 10px 30px rgba(0, 0, 0, 0.46))',
    color: 'var(--eu-fg-primary, #e8ecf4)',
    fontFamily: 'var(--eu-ui-font, sans-serif)',
    fontSize: 'var(--eu-text-sm, 12px)',
    lineHeight: 'var(--eu-leading-tight, 1.25)',
    userSelect: 'none',
  },

  // ----------------------------------------------------------------- the rows
  '.eu-search-row': {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--eu-space-2)',
    flexWrap: 'nowrap',
  },
  /*
   * The replace row starts where the find field starts, not where the row does:
   * the indent stands in for the chevron above it, so the two fields line up as
   * one column and the widget reads as a single form.
   */
  '.eu-search-replace-indent': {
    flex: '0 0 26px',
    width: '26px',
  },

  // ---------------------------------------------------------------- the field
  '.eu-search-input-group': {
    display: 'inline-flex',
    alignItems: 'center',
    // The field takes the slack and the controls keep their size, which is what
    // keeps the widget from reflowing as the match count changes width.
    flex: '1 1 auto',
    minWidth: '0',
    height: '28px',
    padding: '0 var(--eu-space-1) 0 var(--eu-space-2)',
    backgroundColor: 'var(--eu-bg-input, #0b0d13)',
    border: '1px solid var(--eu-border, #232838)',
    borderRadius: 'var(--eu-radius-lg, 8px)',
    boxShadow: 'var(--eu-inset-field, none)',
    transition:
      'border-color var(--eu-dur-fast) var(--eu-ease-out), box-shadow var(--eu-dur-fast) var(--eu-ease-out)',
    '&:focus-within': {
      borderColor: 'var(--eu-border-focus, #3d7dff)',
      boxShadow: 'var(--eu-ring-accent, 0 0 0 1px var(--eu-border-focus, #3d7dff))',
    },
    '&.has-error': {
      borderColor: 'var(--eu-error, #ff6b6b)',
      boxShadow: '0 0 0 1px var(--eu-error, #ff6b6b)',
    },
  },
  '.eu-search-input': {
    flex: '1 1 auto',
    minWidth: '0',
    width: '200px',
    padding: '0',
    border: 'none',
    outline: 'none',
    backgroundColor: 'transparent',
    color: 'var(--eu-fg-primary, #e8ecf4)',
    fontFamily: 'var(--eu-ui-font, sans-serif)',
    fontSize: 'var(--eu-text-sm, 12px)',
    lineHeight: '20px',
    '&::placeholder': {
      color: 'var(--eu-fg-muted, #6e7889)',
    },
  },

  // ------------------------------------------------------- the option toggles
  /*
   * `Aa`, `\b` and `.*` sit inside the field, so they are drawn as a quiet
   * inset row: a tinted background says "on" without the solid accent block,
   * which at 22px reads as three buttons competing with the field itself.
   */
  '.eu-search-toggle-btn': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    width: '22px',
    height: '22px',
    padding: '0',
    margin: '0',
    border: 'none',
    borderRadius: 'var(--eu-radius-sm, 4px)',
    backgroundColor: 'transparent',
    color: 'var(--eu-fg-muted, #6e7889)',
    fontSize: 'var(--eu-text-xs, 11px)',
    fontWeight: 'var(--eu-weight-semibold, 600)',
    fontFamily: 'var(--eu-mono-font, monospace)',
    lineHeight: '1',
    cursor: 'pointer',
    transition:
      'background-color var(--eu-dur-fast) var(--eu-ease-out), color var(--eu-dur-fast) var(--eu-ease-out)',
    '&:hover': {
      backgroundColor: 'var(--eu-hover-tint, rgba(255, 255, 255, 0.045))',
      color: 'var(--eu-fg-primary, #e8ecf4)',
    },
    '&:focus-visible': {
      outline: 'none',
      boxShadow: 'var(--eu-ring-accent, 0 0 0 1px var(--eu-border-focus, #3d7dff))',
    },
    '&.active': {
      backgroundColor: 'var(--eu-accent-muted, rgba(61, 125, 255, 0.16))',
      color: 'var(--eu-accent, #3d7dff)',
    },
  },

  // ------------------------------------------------------------- the controls
  /*
   * The icon row and the two replace buttons borrow the design system's own
   * recipes rather than inventing a third one: quiet controls for the icons
   * (`.eu-btn-quiet` — a hairline that appears on hover, so the row is only
   * bordered where the pointer is) and secondary buttons for replace
   * (`.eu-btn-secondary` — a real outline that turns accent-coloured when it is
   * the one under the pointer).
   */
  '.eu-search-btn': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    width: '26px',
    height: '26px',
    padding: '0',
    // Transparent rather than absent, so the icon does not shift by a pixel as
    // the pointer arrives.
    border: '1px solid transparent',
    borderRadius: 'var(--eu-radius-md, 6px)',
    backgroundColor: 'transparent',
    color: 'var(--eu-fg-secondary, #a2acc0)',
    cursor: 'pointer',
    transition:
      'background-color var(--eu-dur-fast) var(--eu-ease-out), border-color var(--eu-dur-fast) var(--eu-ease-out), color var(--eu-dur-fast) var(--eu-ease-out), opacity var(--eu-dur-fast) var(--eu-ease-out)',
    '&:hover': {
      borderColor: 'var(--eu-border, #232838)',
      backgroundColor: 'var(--eu-bg-hover, #1e2230)',
      color: 'var(--eu-fg-primary, #e8ecf4)',
    },
    '&:active': {
      backgroundColor: 'var(--eu-bg-active, #232838)',
    },
    '&:focus-visible': {
      outline: 'none',
      borderColor: 'var(--eu-accent, #3d7dff)',
      boxShadow: 'var(--eu-ring-accent, 0 0 0 1px var(--eu-accent, #3d7dff))',
    },
    // No match to go to, nothing to select: the control says so rather than
    // being a button that does nothing.
    '&:disabled': {
      opacity: '0.35',
      cursor: 'default',
      backgroundColor: 'transparent',
      borderColor: 'transparent',
      color: 'var(--eu-fg-secondary, #a2acc0)',
    },
  },
  '.eu-search-action-btn': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    height: '28px',
    padding: '0 var(--eu-space-3)',
    border: '1px solid var(--eu-border-strong, #333a4e)',
    borderRadius: 'var(--eu-radius-md, 6px)',
    backgroundColor: 'transparent',
    color: 'var(--eu-fg-primary, #e8ecf4)',
    fontSize: 'var(--eu-text-xs, 11px)',
    fontWeight: 'var(--eu-weight-medium, 500)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition:
      'background-color var(--eu-dur-fast) var(--eu-ease-out), border-color var(--eu-dur-fast) var(--eu-ease-out), opacity var(--eu-dur-fast) var(--eu-ease-out)',
    '&:hover': {
      borderColor: 'var(--eu-accent, #3d7dff)',
      backgroundColor: 'var(--eu-accent-muted, rgba(61, 125, 255, 0.16))',
    },
    '&:active': {
      backgroundColor: 'var(--eu-bg-active, #232838)',
    },
    '&:focus-visible': {
      outline: 'none',
      borderColor: 'var(--eu-accent, #3d7dff)',
      boxShadow: 'var(--eu-ring-accent, 0 0 0 1px var(--eu-accent, #3d7dff))',
    },
    '&:disabled': {
      opacity: '0.45',
      cursor: 'default',
    },
  },

  // ------------------------------------------------------------ the read-outs
  '.eu-search-count': {
    display: 'inline-block',
    flex: '0 0 auto',
    minWidth: '52px',
    padding: '0 var(--eu-space-1)',
    fontSize: 'var(--eu-text-xs, 11px)',
    // Tabular figures, so "9 of 10" and "10 of 10" do not shove the controls
    // beside them sideways as the count crosses a digit.
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
    whiteSpace: 'nowrap',
    color: 'var(--eu-fg-muted, #6e7889)',
    '&.has-error': {
      color: 'var(--eu-error, #ff6b6b)',
    },
  },
  '.eu-search-close': {
    marginLeft: 'var(--eu-space-1)',
  },

  // ------------------------------------------------------------ the document
  '.ol-cm-stored-selection': {
    background: 'rgba(125, 125, 125, 0.1)',
    paddingTop: 'var(--half-leading, 0)',
    paddingBottom: 'var(--half-leading, 0)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(234, 179, 8, 0.28) !important',
    borderRadius: '2px',
  },
  '.cm-searchMatch-selected': {
    backgroundColor: 'rgba(59, 130, 246, 0.45) !important',
    outline: '1px solid var(--eu-accent, #3d7dff)',
    borderRadius: '2px',
  },
})
