/**
 * Eukolia — the Mathematical Symbols panel.
 *
 * A searchable, categorised grid of mathematical notation that inserts into the
 * active editor. It is not the Project Symbols index beside it: that panel
 * navigates what the project already defines, this one inserts notation the
 * catalog knows. They are separate views because they answer separate questions.
 *
 * Four decisions shape the file, and each is one `MathematicalSymbols.md` asks
 * for by name.
 *
 * **The grid is windowed.** A few thousand entries cannot be a few thousand
 * buttons: §10 requires the mounted DOM to stay bounded by the visible rows plus
 * a small overscan as the catalog grows, so the panel computes which rows the
 * scroll position can show and mounts only those. Row height is fixed, which is
 * what makes the arithmetic exact rather than a guess.
 *
 * **Nothing is typeset on open.** Ordinary symbols preview as their Unicode
 * glyph; only a symbol *without* a faithful glyph falls back to its command, and
 * only the details pane — one item — ever asks MathJax to draw anything. The
 * catalog is never rendered as mathematics.
 *
 * **Focus and selection are separate things.** Clicking a symbol inserts once
 * and returns focus to the source editor, so the remembered selection is the
 * editor's and never becomes a DOM selection from the search box. The search
 * field keeps its own text without stealing the editor's selection, which is why
 * the grid is a list of native buttons with roving focus rather than an ARIA
 * grid: one pattern, correctly implemented, instead of two that disagree.
 *
 * **The panel requests an insertion; it does not perform one.** Every click goes
 * through `EditorHandle.applyMathInsertion`, which applies the whole plan in one
 * transaction. The panel never touches a `Text` or dispatches a change itself,
 * so it cannot be the reason a document is half-edited.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { catalogIndex, catalogCoverageSummary, catalogVariantForCommand } from '../../mathSymbols/catalog'
import { categoryCounts, searchSymbols, type SearchHit } from '../../mathSymbols/search'
import { planInsertion, renderVariant } from '../../mathSymbols/insertMathSymbol'
import { buildProjectAliasIndex } from '../../mathSymbols/macroDefinition'
import { symbolPreview, typesetPreview, type SymbolPreview } from '../../mathSymbols/preview'
import { projectSymbolService } from '../../mathSymbols/projectSymbolService'
import {
  availabilityOf,
  bestCandidate,
  resolveCandidates,
  unavailableExplanation
} from '../../mathSymbols/resolveSymbol'
import type {
  MathSymbolCategory,
  MathSymbolEntry,
  MathSymbolMode,
  ProjectSymbolSnapshot,
  SymbolCandidate,
  SymbolVariant
} from '../../mathSymbols/types'
import { setting, settingsManager } from '../../core/settings'
import type { EditorState } from '@codemirror/state'
import { useAppState } from '../state'
import { EmptyHint, ViewHeader } from './Sidebar'
import { Copy, Star, StarOff } from './icons'

import '../math-symbols.css'

/** The grid's cell height in pixels, fixed so the windowing arithmetic is exact. */
const CELL_HEIGHT = 44
/** Rows mounted beyond the visible band, so a fast scroll does not show a gap. */
const OVERSCAN_ROWS = 4
/** How many recent insertions are remembered. §3 caps it at 30. */
const RECENT_LIMIT = 30
/** The columns the grid lays out at a given width. */
const MIN_CELL_WIDTH = 44

/** The selector's groups: the catalog's categories plus the three views over it. */
type SelectorKey = MathSymbolCategory | 'all' | 'project-macros' | 'favorites' | 'recent'

interface SelectorEntry {
  readonly key: SelectorKey
  readonly label: string
}

const SELECTOR_EXTRA: readonly SelectorEntry[] = [
  { key: 'all', label: 'All' },
  { key: 'favorites', label: 'Favorites' },
  { key: 'recent', label: 'Recent' },
  { key: 'project-macros', label: 'Project macros' }
]

const CATEGORY_LABELS: Readonly<Record<MathSymbolCategory, string>> = {
  greek: 'Greek',
  arrows: 'Arrows',
  relations: 'Relations',
  'binary-operators': 'Binary operators',
  'large-operators': 'Large operators',
  functions: 'Functions',
  'logic-sets': 'Logic and sets',
  delimiters: 'Delimiters',
  accents: 'Accents',
  alphabets: 'Alphabets',
  miscellaneous: 'Miscellaneous',
  templates: 'Templates'
}

/** `entryId|command` — how a spelling preference is stored in the settings. */
const PREFERENCE_SEPARATOR = '|'

function readPreferences(): {
  favorites: string[]
  recent: string[]
  preferred: Map<string, string>
} {
  const favorites = setting.list('mathSymbols.favorites')
  const recent = setting.list('mathSymbols.recent')
  const preferred = new Map<string, string>()
  for (const item of setting.list('mathSymbols.preferredVariants')) {
    const at = item.indexOf(PREFERENCE_SEPARATOR)
    if (at <= 0) continue
    preferred.set(item.slice(0, at), item.slice(at + 1))
  }
  return { favorites, recent, preferred }
}

/**
 * The panel.
 *
 * `projectIndex` reaches this component only through `projectSymbolService`, and
 * the service is started on mount and stopped on unmount — so a project switch
 * or a panel close leaves no subscription behind, which §10 lists as an
 * acceptance condition rather than a nicety.
 */
export const MathematicalSymbolsView: React.FC = () => {
  const { editorHandleRef } = useAppState()
  const catalog = useMemo(() => catalogIndex(), [])
  const counts = useMemo(() => categoryCounts(catalog), [catalog])

  const [snapshot, setSnapshot] = useState(() => projectSymbolService.getSnapshot())
  const [query, setQuery] = useState('')
  const [selector, setSelector] = useState<SelectorKey>('all')
  const [availabilityFilter, setAvailabilityFilter] = useState<'available' | 'all'>(
    () => (setting.str('mathSymbols.availability') === 'all' ? 'all' : 'available')
  )
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [status, setStatus] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [gridWidth, setGridWidth] = useState(0)
  const [preferences, setPreferences] = useState(readPreferences)

  const searchRef = useRef<HTMLInputElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)

  /*
   * The project context, subscribed for exactly as long as the panel is on
   * screen. `stop()` on unmount is what keeps repeated project switches and
   * panel toggles from accumulating listeners.
   */
  useEffect(() => {
    projectSymbolService.start()
    const dispose = projectSymbolService.subscribe(({ snapshot: next }) => setSnapshot(next))
    setSnapshot(projectSymbolService.getSnapshot())
    return () => {
      dispose()
      projectSymbolService.stop()
    }
  }, [])

  // Favourites, recents and spelling preferences are settings, so they can
  // change from the settings window while the panel is open.
  useEffect(() => settingsManager.on('change', () => setPreferences(readPreferences())), [])

  const aliases = useMemo(() => (snapshot ? buildProjectAliasIndex(snapshot.macros) : null), [snapshot])

  /** The candidates for an entry, ranked for the current project. */
  const candidatesFor = useCallback(
    (entry: MathSymbolEntry): SymbolCandidate[] => {
      /*
       * A project macro is available by definition — the project declares it —
       * so it is not run through the requirement machinery at all. Its
       * `requires` is empty because there is nothing to require, and letting
       * that read as "unknown" would hide every project macro from the default
       * filter, which is the one place the panel should never hide anything.
       */
      if (entry.id.startsWith('project:')) {
        return [
          {
            entryId: entry.id,
            variantId: entry.variants[0].id,
            command: entry.variants[0].command ?? entry.name,
            origin: 'project-macro',
            availability: {
              status: 'project',
              package: null,
              reason: 'defined by this project',
              verified: true
            },
            mode: 'math-only',
            selfContainedMath: false,
            declaredAt: null,
            notes: [
              ...(entry.description ? [entry.description] : []),
              // §7: a project macro's mode is not modelled, so the panel says
              // what it will do rather than leaving the user to find out.
              'inserted exactly as this project declares it, with no math wrapper'
            ],
            insertable: true
          }
        ]
      }
      if (!snapshot || !aliases) {        // No project context yet: core availability is a static fact, so the
        // canonical variants are still offered and everything else is unknown.
        return entry.variants.map((variant) => ({
          entryId: entry.id,
          variantId: variant.id,
          command: variant.command ?? entry.name,
          origin: 'canonical' as const,
          availability: {
            status: 'unknown' as const,
            package: null,
            reason: 'the project has not been analysed yet',
            verified: false
          },
          mode: variant.mode,
          selfContainedMath: variant.selfContainedMath,
          declaredAt: null,
          notes: [],
          insertable: variant.requires.every((requirement) => requirement.kind === 'core')
        }))
      }
      return resolveCandidates({
        entry,
        snapshot,
        aliases,
        preferredCommand: preferences.preferred.get(entry.id) ?? null
      })
    },
    [snapshot, aliases, preferences]
  )

  const projectMacroEntries = useMemo<MathSymbolEntry[]>(() => {
    if (!snapshot) return []
    return snapshot.macros
      .filter((macro) => macro.inScope)
      .map((macro) => ({
        id: `project:${macro.name}`,
        name: `\\${macro.name}`,
        glyph: null,
        preview: 'command' as const,
        previewSource: null,
        categories: ['templates' as MathSymbolCategory],
        aliases: [],
        keywords: macro.uncertainty ? ['project macro', 'uncertain'] : ['project macro'],
        description:
          macro.kind === 'DeclareMathOperator'
            ? `Defined by this project as an operator.`
            : macro.uncertainty ?? `Defined by this project.`,
        core: null,
        source: macro.file ? `${macro.file}:${macro.line}` : `line ${macro.line}`,
        variants: [
          {
            id: `project:${macro.name}@macro`,
            command: `\\${macro.name}`,
            parts: macro.args > 0
              ? [
                  { text: `\\${macro.name}` },
                  ...Array.from({ length: macro.args }, (_, index) => [
                    { text: '{' },
                    { slot: index + 1 },
                    { text: '}' }
                  ]).flat()
                ]
              : [{ text: `\\${macro.name}` }],
            slots: Array.from({ length: macro.args }, (_, index) => ({
              index: index + 1,
              required: index === 0,
              default: '',
              select: index === 0 ? ('selected-text' as const) : ('placeholder' as const)
            })),
            requires: [],
            engines: null,
            /*
             * The mode comes from evidence when there is any, and from nothing
             * when there is not.
             *
             * §7 warns against classifying an arbitrary text macro as
             * mathematics, and the warning is right — a declaration's mode is
             * not something a name can be trusted for. But the declaration's
             * *body* frequently names a catalog command, and a body that starts
             * with `\mathbf` or `\mathbb` is mathematics by the catalog's own
             * reviewed attribution of those commands. `\newcommand{\vect}[1]
             * {\mathbf{#1}}` therefore inherits `math-only` and is wrapped in
             * prose; a body whose head command the catalog does not know —
             * `\section`, a prose macro, anything at all — inherits nothing and
             * is inserted exactly as declared.
             *
             * Measured: without this, a prose use of the fixture project's
             * `\vect` produced `\vect{v}` and pdflatex refused it with `\mathbf
             * allowed only in math mode`.
             */
            mode: modeForExpansion(macro.expansion),
            selfContainedMath: false
          }
        ]
      }))
  }, [snapshot])

  /* ------------------------------------------------------------- the list */

  const hits = useMemo<SearchHit[]>(() => {
    const categories: MathSymbolCategory[] | undefined =
      selector !== 'all' &&
      selector !== 'favorites' &&
      selector !== 'recent' &&
      selector !== 'project-macros'
        ? [selector]
        : undefined

    if (selector === 'project-macros') {
      const needle = query.trim().toLowerCase()
      return projectMacroEntries
        .filter((entry) => (needle ? entry.name.toLowerCase().includes(needle) : true))
        .map((entry) => ({
          entry,
          variant: entry.variants[0],
          score: 0,
          field: 'none' as const
        }))
    }

    const found = searchSymbols(catalog, { query, categories })
    if (selector === 'favorites') {
      const wanted = new Set(preferences.favorites)
      return found.filter((hit) => wanted.has(hit.entry.id))
    }
    if (selector === 'recent') {
      const order = new Map(preferences.recent.map((id, index) => [id, index]))
      return found
        .filter((hit) => order.has(hit.entry.id))
        .sort((a, b) => (order.get(a.entry.id) ?? 0) - (order.get(b.entry.id) ?? 0))
    }
    return found
  }, [catalog, selector, query, preferences, projectMacroEntries])

  /**
   * The list after the availability filter.
   *
   * The filter is applied *after* ranking rather than folded into the search, so
   * the search module stays free of project state — and so switching the filter
   * cannot change the order of what remains.
   */
  const visible = useMemo(() => {
    if (availabilityFilter === 'all') return hits
    return hits.filter((hit) => {
      const candidate = bestCandidate(candidatesFor(hit.entry))
      return candidate !== null
    })
  }, [hits, availabilityFilter, candidatesFor])

  /* ------------------------------------------------------------- windowing */

  const columns = Math.max(1, Math.floor(gridWidth / MIN_CELL_WIDTH))

  useEffect(() => {
    const element = gridRef.current
    if (!element) return
    const measure = () => setGridWidth(element.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const rowCount = Math.ceil(visible.length / columns)
  const firstRow = Math.max(0, Math.floor(scrollTop / CELL_HEIGHT) - OVERSCAN_ROWS)
  const lastRow = Math.min(
    rowCount,
    Math.ceil((scrollTop + (gridRef.current?.clientHeight ?? 0)) / CELL_HEIGHT) + OVERSCAN_ROWS
  )
  const windowed = visible.slice(firstRow * columns, lastRow * columns)

  const focusedEntry = useMemo(
    () => visible.find((hit) => hit.entry.id === focusedId)?.entry ?? visible[0]?.entry ?? null,
    [visible, focusedId]
  )

  /* ------------------------------------------------------------ insertion */

  const insert = useCallback(
    (entry: MathSymbolEntry, candidate: SymbolCandidate) => {
      const handle = editorHandleRef.current
      if (!handle) {
        setStatus({ tone: 'warn', text: 'No editor is open to insert into.' })
        return
      }
      const variant: SymbolVariant | undefined =
        resolvedVariantFor(entry, candidate) ??
        entry.variants.find((item) => item.id === candidate.variantId) ??
        entry.variants[0]
      if (!variant) return
      // The plan is built from the *editor's own* state at this instant, never
      // from anything the panel captured when it rendered: an async preview or a
      // stale query result must not decide what a document that happened to be
      // active gets written into.
      const editorState = editorStateOf(handle)
      if (!editorState) {
        setStatus({ tone: 'warn', text: 'The editor is not ready.' })
        return
      }
      const result = planInsertion({
        entryId: entry.id,
        variant,
        state: editorState,
        explanation: candidate.notes[0] ?? candidate.availability.reason
      })
      if (!result.ok) {
        setStatus({ tone: 'warn', text: result.message })
        return
      }
      const applied = handle.applyMathInsertion(result)
      if (!applied) {
        setStatus({ tone: 'warn', text: 'The editor went away before the symbol could be inserted.' })
        return
      }
      // §3: "Pointer activation inserts once and returns focus to the source
      // editor." The handle focuses as part of applying, and this says so at the
      // point the requirement is stated rather than leaving it to a caller three
      // modules away to remember.
      handle.focus()
      setStatus({ tone: 'ok', text: `Inserted ${result.preview}` })
      const next = [entry.id, ...preferences.recent.filter((id) => id !== entry.id)].slice(
        0,
        RECENT_LIMIT
      )
      settingsManager.setValue('mathSymbols.recent', next)
    },
    [editorHandleRef, preferences.recent]
  )

  const toggleFavorite = useCallback(
    (entryId: string) => {
      const has = preferences.favorites.includes(entryId)
      const next = has
        ? preferences.favorites.filter((id) => id !== entryId)
        : [...preferences.favorites, entryId]
      settingsManager.setValue('mathSymbols.favorites', next)
    },
    [preferences.favorites]
  )

  const prefer = useCallback(
    (entryId: string, command: string) => {
      const next = preferences.preferred
      const items: string[] = []
      for (const [key, value] of next) {
        if (key === entryId) continue
        items.push(`${key}${PREFERENCE_SEPARATOR}${value}`)
      }
      items.push(`${entryId}${PREFERENCE_SEPARATOR}${command}`)
      settingsManager.setValue('mathSymbols.preferredVariants', items)
    },
    [preferences.preferred]
  )

  const copyCode = useCallback((entry: MathSymbolEntry, candidate: SymbolCandidate | null) => {
    const variant =
      entry.variants.find((item) => item.id === candidate?.variantId) ?? entry.variants[0]
    if (!variant) return
    const text = renderVariant(variant).text
    void navigator.clipboard?.writeText(text)
    setStatus({ tone: 'ok', text: `Copied ${text}` })
  }, [])

  /* ------------------------------------------------------------- keyboard */

  const moveFocus = useCallback(
    (delta: number) => {
      if (visible.length === 0) return
      const current = Math.max(
        0,
        visible.findIndex((hit) => hit.entry.id === focusedEntry?.id)
      )
      const next = Math.max(0, Math.min(visible.length - 1, current + delta))
      const entry = visible[next]?.entry
      if (!entry) return
      setFocusedId(entry.id)
      setScrollTop((top) => {
        const row = Math.floor(next / columns)
        const cellTop = row * CELL_HEIGHT
        const viewHeight = gridRef.current?.clientHeight ?? 0
        if (cellTop < top) return cellTop
        if (cellTop + CELL_HEIGHT > top + viewHeight) return cellTop + CELL_HEIGHT - viewHeight
        return top
      })
    },
    [visible, focusedEntry, columns]
  )

  const onGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        moveFocus(1)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        moveFocus(-1)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveFocus(columns)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveFocus(-columns)
      } else if (event.key === 'Home') {
        event.preventDefault()
        moveFocus(-visible.length)
      } else if (event.key === 'End') {
        event.preventDefault()
        moveFocus(visible.length)
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        if (!focusedEntry) return
        const candidate = bestCandidate(candidatesFor(focusedEntry))
        if (candidate) insert(focusedEntry, candidate)
        else setStatus({ tone: 'warn', text: unavailableExplanation(candidatesFor(focusedEntry)) })
      } else if (event.key === 'Escape') {
        event.preventDefault()
        editorHandleRef.current?.focus()
      }
    },
    [moveFocus, columns, visible.length, focusedEntry, candidatesFor, insert, editorHandleRef]
  )

  /* The search field hands the keyboard back on Escape, as the grid does. */
  const onSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // The shell's global keybindings listen on the window; without this a
      // single-letter shortcut would fire while the user is typing a query.
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        editorHandleRef.current?.focus()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        event.preventDefault()
        gridRef.current?.focus()
      }
    },
    [editorHandleRef]
  )

  /* ---------------------------------------------------------------- render */

  const selectorEntries: SelectorEntry[] = [
    ...SELECTOR_EXTRA.slice(0, 1),
    ...catalog.categories.map((category) => ({ key: category, label: CATEGORY_LABELS[category] })),
    ...SELECTOR_EXTRA.slice(1)
  ]

  const focusedCandidates = focusedEntry ? candidatesFor(focusedEntry) : []
  const chosen = bestCandidate(focusedCandidates)
  // The same resolution the insert button uses, so the code on screen is the code
  // that will be written.
  const chosenVariant = focusedEntry ? resolvedVariantFor(focusedEntry, chosen) : null
  const chosenAvailability = chosenVariant
    ? availabilityOf(chosenVariant, snapshot ?? emptySnapshot())
    : null

  /*
   * The typeset preview, for the focused entry only.
   *
   * This is the single place the panel asks MathJax for anything. The effect's
   * cleanup is what makes the request cancellable: `typesetPreview` carries a
   * token, and a render that finishes after the focus moved on resolves to
   * `null` instead of drawing the previous symbol in the details pane.
   */
  const [focusedPreview, setFocusedPreview] = useState<SymbolPreview | null>(null)
  useEffect(() => {
    if (!focusedEntry) {
      setFocusedPreview(null)
      return
    }
    const immediate = symbolPreview(focusedEntry)
    setFocusedPreview(immediate)
    if (immediate.kind !== 'math') return
    let cancelled = false
    void typesetPreview(focusedEntry).then((result) => {
      if (!cancelled && result) setFocusedPreview(result)
    })
    return () => {
      cancelled = true
    }
  }, [focusedEntry])

  return (
    <div className="eu-sidebar-panel eu-math-symbols">
      <ViewHeader title="Mathematical Symbols">
        <button
          type="button"
          className="eu-math-symbols__filter eu-pressable"
          title={
            availabilityFilter === 'available'
              ? 'Showing symbols this project can compile. Click to show the whole catalog.'
              : 'Showing the whole catalog. Click to show only what this project can compile.'
          }
          aria-pressed={availabilityFilter === 'all'}
          onClick={() => {
            const next = availabilityFilter === 'available' ? 'all' : 'available'
            setAvailabilityFilter(next)
            settingsManager.setValue('mathSymbols.availability', next)
          }}
        >
          {availabilityFilter === 'available' ? 'Available' : 'All'}
        </button>
      </ViewHeader>

      <div className="eu-sidebar-panel__body eu-math-symbols__search">
        <input
          ref={searchRef}
          className="eu-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search names, \commands, keywords or a glyph…"
          aria-label="Search mathematical symbols"
          title="Search by name, command with or without its backslash, keyword, or a pasted glyph"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {/* A wrapping selector rather than a horizontal toolbar: the sidebar is
          narrow, and a scroller would hide the categories with no sign that it
          had. §3 asks for exactly this. */}
      <div
        className="eu-math-symbols__categories"
        role="group"
        aria-label="Symbol categories"
      >
        {selectorEntries.map((item) => {
          const count =
            item.key === 'all'
              ? catalog.entries.length
              : item.key === 'project-macros'
                ? projectMacroEntries.length
                : item.key === 'favorites'
                  ? preferences.favorites.length
                  : item.key === 'recent'
                    ? preferences.recent.length
                    : counts[item.key as MathSymbolCategory] ?? 0
          return (
            <button
              key={item.key}
              type="button"
              className="eu-math-symbols__category eu-pressable"
              aria-pressed={selector === item.key}
              data-active={selector === item.key ? 'true' : 'false'}
              title={`${item.label} — ${count} symbol${count === 1 ? '' : 's'}`}
              onClick={() => {
                setSelector(item.key)
                setScrollTop(0)
                if (gridRef.current) gridRef.current.scrollTop = 0
              }}
            >
              {item.label}
              <span className="eu-math-symbols__category-count">{count}</span>
            </button>
          )
        })}
      </div>

      {!snapshot?.complete && (
        <div className="eu-math-symbols__indexing" role="status">
          Indexing the project… core commands are ready; package availability is still being checked.
        </div>
      )}

      <div
        ref={gridRef}
        className="eu-math-symbols__grid eu-scroll-area"
        role="listbox"
        aria-label="Mathematical symbols"
        aria-activedescendant={focusedEntry ? `eu-math-symbol-${focusedEntry.id}` : undefined}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {/* The spacer is what makes windowing possible without a virtualiser
            library: one element of the full height, and only the visible rows
            mounted inside it. */}
        <div
          className="eu-math-symbols__grid-inner"
          style={{ height: rowCount * CELL_HEIGHT }}
          aria-hidden={false}
        >
          <div
            className="eu-math-symbols__grid-rows"
            style={{
              transform: `translateY(${firstRow * CELL_HEIGHT}px)`,
              gridTemplateColumns: `repeat(${columns}, minmax(${MIN_CELL_WIDTH}px, 1fr))`
            }}
          >
            {windowed.map((hit) => (
              <SymbolCell
                key={hit.entry.id}
                entry={hit.entry}
                candidate={bestCandidate(candidatesFor(hit.entry))}
                focused={focusedEntry?.id === hit.entry.id}
                favorite={preferences.favorites.includes(hit.entry.id)}
                onFocus={() => setFocusedId(hit.entry.id)}
                onInsert={() => {
                  const candidate = bestCandidate(candidatesFor(hit.entry))
                  if (candidate) insert(hit.entry, candidate)
                  else setStatus({ tone: 'warn', text: unavailableExplanation(candidatesFor(hit.entry)) })
                }}
              />
            ))}
          </div>
        </div>
        {visible.length === 0 && (
          <EmptyHint>
            {hits.length === 0
              ? 'Nothing matches that search.'
              : 'Nothing here is available in this project yet — switch to All to see the rest of the catalog.'}
          </EmptyHint>
        )}
      </div>

      {/* The details area keeps its height whatever it holds, so focusing a
          symbol cannot move the grid under the pointer. */}
      <div className="eu-math-symbols__details" aria-live="polite">
        {focusedEntry ? (
          <>
            <div className="eu-math-symbols__details-head">
              <DetailsPreview entry={focusedEntry} preview={focusedPreview} />
              <span className="eu-math-symbols__details-name">
                {focusedEntry.name}
                {focusedEntry.description ? ` — ${focusedEntry.description}` : ''}
              </span>
              <button
                type="button"
                className="eu-math-symbols__star eu-pressable"
                aria-pressed={preferences.favorites.includes(focusedEntry.id)}
                title={
                  preferences.favorites.includes(focusedEntry.id)
                    ? 'Remove from favourites'
                    : 'Add to favourites'
                }
                onClick={() => toggleFavorite(focusedEntry.id)}
              >
                {preferences.favorites.includes(focusedEntry.id) ? (
                  <Star size={13} strokeWidth={1.8} />
                ) : (
                  <StarOff size={13} strokeWidth={1.8} />
                )}
              </button>
            </div>
            <div className="eu-math-symbols__details-code" title="The exact code the insert button writes">
              {chosenVariant ? renderVariant(chosenVariant).text : focusedEntry.name}
            </div>
            <div className="eu-math-symbols__details-meta">
              {chosenAvailability
                ? chosenAvailability.reason
                : unavailableExplanation(focusedCandidates)}
              {chosen?.declaredAt ? ` · defined at line ${chosen.declaredAt.line}` : ''}
            </div>
            {chosen?.notes.map((note) => (
              <div key={note} className="eu-math-symbols__details-note">
                {note}
              </div>
            ))}
            <div className="eu-math-symbols__details-actions">
              {focusedCandidates.length > 1 && (
                <select
                  className="eu-math-symbols__variants"
                  aria-label="Spelling to insert"
                  value={chosen?.variantId ?? ''}
                  onChange={(event) => {
                    const candidate = focusedCandidates.find(
                      (item) => item.variantId === event.target.value
                    )
                    if (candidate) prefer(focusedEntry.id, candidate.command)
                  }}
                >
                  {focusedCandidates.map((candidate) => (
                    <option key={candidate.variantId} value={candidate.variantId}>
                      {candidate.command}
                      {candidate.insertable ? '' : ' (unavailable)'}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="eu-btn eu-pressable"
                title="Copy the code for this symbol"
                onClick={() => copyCode(focusedEntry, chosen)}
              >
                <Copy size={12} strokeWidth={1.8} />
                Copy
              </button>
            </div>
            {focusedEntry.description && (
              <div className="eu-math-symbols__details-description">{focusedEntry.description}</div>
            )}
            <div className="eu-math-symbols__details-source" title={catalogCoverageSummary()}>
              {focusedEntry.source}
            </div>
          </>
        ) : (
          <EmptyHint>Focus a symbol to see its code, availability and provenance.</EmptyHint>
        )}
      </div>

      {status && (
        <div
          className="eu-math-symbols__status"
          data-tone={status.tone}
          role="status"
          title={status.text}
        >
          {status.text}
        </div>
      )}
    </div>
  )
}

/** One cell: a native button, so Tab and the screen reader see a real control. */
const SymbolCell: React.FC<{
  entry: MathSymbolEntry
  candidate: SymbolCandidate | null
  focused: boolean
  favorite: boolean
  onFocus(): void
  onInsert(): void
}> = ({ entry, candidate, focused, favorite, onFocus, onInsert }) => {
  const unavailable = candidate === null
  const label = candidate ? candidate.command : `${entry.name} — not available in this project`
  const preview = symbolPreview(entry)
  return (
    <button
      type="button"
      id={`eu-math-symbol-${entry.id}`}
      role="option"
      aria-selected={focused}
      aria-label={label}
      title={
        unavailable
          ? `${entry.name} — not available in this project`
          : `${entry.name} — insert ${candidate.command}`
      }
      data-testid="math-symbol-cell"
      data-unavailable={unavailable ? 'true' : 'false'}
      data-favorite={favorite ? 'true' : 'false'}
      data-preview={preview.kind}
      className="eu-math-symbols__cell eu-pressable"
      style={{ height: CELL_HEIGHT }}
      onFocus={onFocus}
      onMouseEnter={onFocus}
      onClick={onInsert}
    >
      <span
        className="eu-math-symbols__cell-glyph"
        data-kind={preview.kind}
        aria-hidden="true"
      >
        {preview.kind === 'glyph' ? preview.glyph : preview.command}
      </span>
      {/* Availability is stated with an attribute and a marker as well as a
          colour, because §3 forbids relying on colour alone. */}
      {unavailable && <span className="eu-math-symbols__cell-marker" aria-hidden="true" />}
    </button>
  )
}

/**
 * The details pane's preview.
 *
 * A glyph where the character is faithful and drawable, a typeset SVG for a
 * template, and the command in every other case — including a typeset preview
 * that failed, because a symbol that cannot be *drawn* is still a symbol that can
 * be inserted, and hiding it would be the wrong answer.
 */
const DetailsPreview: React.FC<{ entry: MathSymbolEntry; preview: SymbolPreview | null }> = ({
  entry,
  preview
}) => {
  if (preview?.kind === 'glyph' && preview.glyph) {
    return (
      <span className="eu-math-symbols__details-glyph" aria-hidden="true">
        {preview.glyph}
      </span>
    )
  }
  if (preview?.kind === 'math' && preview.svg) {
    return (
      <span
        className="eu-math-symbols__details-glyph eu-math-symbols__details-glyph--math"
        aria-hidden="true"
        // The SVG is produced by the application's own MathJax instance from
        // catalog data, not from user input, and is the same markup the Visual
        // Editor inserts into its widgets.
        dangerouslySetInnerHTML={{ __html: preview.svg }}
      />
    )
  }
  const command = preview?.command ?? entry.variants[0]?.command ?? entry.name
  return (
    <span className="eu-math-symbols__details-glyph eu-math-symbols__details-glyph--command" aria-hidden="true">
      {command}
    </span>
  )
}

/**
 * The editor state behind the handle.
 *
 * The handle is deliberately engine-neutral and has no `state` accessor, so this
 * reads the one member it does expose — the live editor — and asks it for the
 * state the transaction will be built against. Reaching for the editor at the
 * moment of the click is the point: a state captured when the panel rendered
 * could belong to a document that is no longer active.
 */
function editorStateOf(handle: { getEditor(): unknown }): EditorState | null {
  const editor = handle.getEditor() as { state?: EditorState } | null
  return editor?.state ?? null
}

/**
 * The variant a candidate will actually insert.
 *
 * One decision, used by both the details pane and the insert button, so the code
 * the panel *shows* and the code it *writes* cannot disagree — which they did
 * until the built application was probed: the details pane looked the candidate's
 * id up among the entry's own variants, found nothing for a project alias, and
 * fell back to the canonical spelling while the click would have written the
 * alias. §1 asks the panel to "show the exact code that will be inserted".
 *
 * The two alias forms insert differently:
 *
 *  * A **zero-argument** alias *is* the construct — `\newcommand{\R}{\mathbb{R}}`
 *    means `\R` denotes ℝ whole — so it is inserted as its own name with no
 *    slots. Splicing it into `\mathbb`'s parts would give `\R{...}`, which is not
 *    what the project defined.
 *  * A **parameterised** alias is another way of writing the catalog command —
 *    `\newcommand{\vect}[1]{\mathbf{#1}}` is `\mathbf` with its argument in the
 *    same position — so it takes the same parts and only the first command name
 *    is replaced. That equivalence is not assumed: the signature match in
 *    `buildProjectAliasIndex` is what established it. A `\let` alias is the same
 *    shape, with the catalog variant's own arity.
 */
function resolvedVariantFor(
  entry: MathSymbolEntry,
  candidate: SymbolCandidate | null
): SymbolVariant | null {
  if (!candidate) return null
  const marker = candidate.variantId.indexOf('@project:')
  if (marker === -1) {
    return entry.variants.find((item) => item.id === candidate.variantId) ?? null
  }
  const base = entry.variants.find((item) => item.id === candidate.variantId.slice(0, marker))
  if (!base) return null

  const isCommandAlias = candidate.variantId.includes('@command:')
  const arity = candidate.aliasArgCount ?? base.slots.length
  if (!isCommandAlias && arity === 0) {
    return { ...base, command: candidate.command, parts: [{ text: candidate.command }], slots: [] }
  }

  const [first, ...rest] = base.parts
  if (!first || !('text' in first)) return null
  return { ...base, command: candidate.command, parts: [{ text: candidate.command }, ...rest] }
}

/**
 * The insertion mode a declaration's body implies, or `mode-independent`.
 *
 * Read from the body's own head command, and only from a command the catalog has
 * a *reviewed* attribution for — which is what keeps this evidence rather than a
 * guess. A body the catalog does not recognise implies nothing, and nothing is
 * the honest answer: the project's command goes in exactly as the project wrote
 * it, which is §7's rule for a macro whose meaning Eukolia cannot establish.
 */
function modeForExpansion(expansion: string | null): MathSymbolMode {
  if (!expansion) return 'mode-independent'
  const head = /^\\([A-Za-z]+)/.exec(expansion.trim())
  if (!head) return 'mode-independent'
  return catalogVariantForCommand(`\\${head[1]}`)?.variant.mode ?? 'mode-independent'
}

/** A snapshot with nothing in it, for the details pane before analysis lands. */
function emptySnapshot(): ProjectSymbolSnapshot {
  return {
    revision: 0,
    workspaceRoot: null,
    compilationRoot: null,
    complete: false,
    macros: [],
    packages: [],
    engine: null,
    inclusions: [],
    limitations: { root: null, truncated: false, notes: [] }
  }
}

export default MathematicalSymbolsView
