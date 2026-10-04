/*
 * Does the Mathematical Symbols panel work in the real renderer?
 *
 * Everything about this feature is verified in jsdom, and jsdom is exactly the
 * instrument that cannot answer these questions: whether the lazy chunk loads,
 * whether the real CodeMirror view receives the transaction, whether the real
 * command registry opens the panel, and whether MathJax is *not* asked to
 * typeset the grid. So this drives the built application and reports what it
 * sees rather than asserting anything:
 *
 *   opened        did the command open the panel, and how long did the lazily
 *                 imported catalog take to arrive
 *   grid          how many cells are mounted, against how many entries the
 *                 catalog holds — the §10 bound
 *   typeset       `mjx-container` elements inside the grid, which must be zero:
 *                 the catalog is never typeset, only the one focused preview
 *   project       whether this project's own `\R` is the spelling the panel
 *                 offers for the real-number entry
 *   insertion     the document text before and after a click, and the caret
 *
 * Ends with `return` — an injected script whose last statement is a call
 * expression returns `undefined` and reports nothing.
 */

async function mathSymbolsProbe() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const waitFor = async (test, label, timeoutMs = 20000) => {
    const started = performance.now()
    for (;;) {
      const value = test()
      if (value) return { value, ms: Math.round(performance.now() - started) }
      if (performance.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
      await wait(50)
    }
  }

  const view = window.__cmView
  if (!view) throw new Error('no window.__cmView — this build has no probe hook')

  const report = {
    document: null,
    opened: null,
    grid: null,
    typeset: null,
    project: null,
    availability: null,
    insertion: null
  }

  report.document = {
    path: view.state.doc.length,
    length: view.state.doc.length,
    excerpt: view.state.doc.sliceString(0, 80)
  }

  /* ---------------------------------------------------------------- open */

  const button = await waitFor(
    () => document.querySelector('[data-testid="activity-bar-math-symbols"]'),
    'the activity bar entry'
  )
  button.value.click()

  const panel = await waitFor(
    () => document.querySelector('.eu-math-symbols'),
    'the panel',
    30000
  )
  report.opened = {
    ms: panel.ms,
    mounted: true,
    header: document.querySelector('.eu-sidebar-panel__title')?.textContent ?? null
  }

  /* ---------------------------------------------------------------- grid */

  const cells = () => [...document.querySelectorAll('[data-testid="math-symbol-cell"]')]
  await waitFor(() => cells().length > 0, 'grid cells')

  const allButton = [...document.querySelectorAll('.eu-math-symbols__category')].find(node =>
    node.textContent?.startsWith('All')
  )
  const catalogCount = Number((allButton?.textContent ?? '').replace(/^All/, '')) || 0
  const inner = document.querySelector('.eu-math-symbols__grid-inner')

  report.grid = {
    catalogEntries: catalogCount,
    mountedCells: cells().length,
    scrollHeight: inner ? inner.getBoundingClientRect().height : null,
    viewportHeight: document.querySelector('.eu-math-symbols__grid')?.clientHeight ?? null,
    categories: document.querySelectorAll('.eu-math-symbols__category').length,
    bounded: catalogCount > 0 && cells().length < catalogCount / 10
  }

  /* ------------------------------------------------------------- typeset */

  report.typeset = {
    inGrid: document.querySelectorAll('.eu-math-symbols__grid mjx-container').length,
    inDetails: document.querySelectorAll('.eu-math-symbols__details mjx-container').length,
    firstCellPreview: cells()[0]?.getAttribute('data-preview') ?? null,
    firstCellLabel: cells()[0]?.getAttribute('aria-label') ?? null
  }

  /* ------------------------------------------------------------- project */

  const searchBox = document.querySelector('.eu-math-symbols input[type="search"]')
  const setQuery = async text => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(searchBox, text)
    searchBox.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(250)
  }

  await setQuery('\\alpha')
  const alphaLabel = cells()[0]?.getAttribute('aria-label') ?? null

  /* §7's headline example. The project defines `\R` as `\mathbb{R}`, and the
   * constant `cur:reals` is reached by its glyph — the alphabet *template* is a
   * different entry and answers to the words, which is why this asks for the
   * character. */
  await setQuery('ℝ')
  await wait(300)
  const realsCell = cells()[0]
  if (realsCell) realsCell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await wait(200)
  const realsCode = document.querySelector('.eu-math-symbols__details-code')?.textContent ?? null
  const realsMeta = document.querySelector('.eu-math-symbols__details-meta')?.textContent ?? null

  /* The project's own macros, under their own category. The query from the step
   * above is cleared first: a search for `ℝ` inside the project-macro category
   * correctly finds nothing, and reading that as "the category is empty" would
   * be a probe bug rather than a finding. */
  await setQuery('')
  const projectButton = [...document.querySelectorAll('.eu-math-symbols__category')].find(node =>
    node.textContent?.startsWith('Project macros')
  )
  const projectMacroCount = Number((projectButton?.textContent ?? '').replace(/^Project macros/, '')) || 0
  projectButton?.click()
  await wait(300)
  const projectMacroLabels = cells().map(cell => cell.getAttribute('aria-label'))

  report.project = {
    alphaFirst: alphaLabel,
    realsFirst: realsCell?.getAttribute('aria-label') ?? null,
    realsCode,
    realsMeta,
    projectMacroCount,
    projectMacroLabels
  }

  /* A symbol the project cannot compile, under `All`, must be marked rather
   * than hidden and must explain itself. */
  const pickCategory = async prefix => {
    const node = [...document.querySelectorAll('.eu-math-symbols__category')].find(candidate =>
      candidate.textContent?.startsWith(prefix)
    )
    node?.click()
    await wait(250)
  }
  document.querySelector('.eu-math-symbols__filter')?.click()
  await wait(200)
  /* The project-macro category from the step above is still selected, and `\qty`
   * is not a project macro — so the whole catalog has to be showing before this
   * asks its question at all. */
  await pickCategory('All')
  await setQuery('\\qty')
  const unavailable = cells()[0]
  report.availability = {
    filter: document.querySelector('.eu-math-symbols__filter')?.textContent ?? null,
    first: unavailable?.getAttribute('aria-label') ?? null,
    marked: unavailable?.getAttribute('data-unavailable') ?? null,
    /** While analysis is still running this says so rather than claiming a
     * package is missing — §6's "never label a command available merely because
     * analysis has not finished", stated in the other direction. */
    whileIndexing: document.querySelector('.eu-math-symbols__details-meta')?.textContent ?? null,
    hasCopy: Boolean(
      [...document.querySelectorAll('.eu-math-symbols__details-actions button')].find(node =>
        node.textContent?.includes('Copy')
      )
    )
  }

  /* Wait for the project analysis to announce itself, and read the same line
   * again: it should move from "still checking" to naming the package. */
  const settled = await waitFor(
    () => {
      const text = document.querySelector('.eu-math-symbols__details-meta')?.textContent ?? ''
      return text.includes('\\usepackage') ? text : null
    },
    'the missing-package explanation',
    25000
  ).catch(() => null)
  report.availability.afterIndexing = settled ? settled.value : null
  report.availability.indexingSettledMs = settled ? settled.ms : null

  /* ----------------------------------------------------------- insertion */

  /* Back to the whole catalog — the project-macro category from the step above
   * is still selected, and a symbol that is not a project macro is invisible
   * under it. */
  await pickCategory('All')
  await setQuery('\\omega')
  const before = view.state.doc.toString()
  const target = cells()[0]
  if (!target) throw new Error('no cell to click after searching for \\omega')
  target.click()
  await wait(400)

  const after = view.state.doc.toString()
  const selection = view.state.selection.main
  report.insertion = {
    changed: before !== after,
    deltaLength: after.length - before.length,
    insertedAt: (() => {
      for (let at = 0; at < Math.max(before.length, after.length); at += 1) {
        if (before[at] !== after[at]) return at
      }
      return null
    })(),
    around: after.slice(Math.max(0, (selection.head ?? 0) - 24), (selection.head ?? 0) + 12),
    caret: selection.head,
    focusReturned: document.activeElement === view.contentDOM,
    status: document.querySelector('.eu-math-symbols__status')?.textContent ?? null
  }

  return report
}

return mathSymbolsProbe()
