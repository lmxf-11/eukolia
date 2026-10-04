/*
 * The measurement `scripts/probe-keystroke.mjs` injects into the running editor.
 *
 * It lives in its own file rather than inside a template literal in the script, and
 * that is not tidiness: this text is injected by `webContents.executeJavaScript`, so it
 * used to be a JS template literal, and **every backtick inside it broke the outer
 * literal** — reported as a syntax error on some unrelated line of the *outer*
 * expression. That trap cost three separate debugging rounds on this file alone. Here
 * it is a real module: the editor parses it, so a mistake is reported where it is.
 *
 * It is a function, not a module with side effects, so the probe can read the file and
 * call it with its own parameters. Everything it needs is on `window` already:
 * `__cmView` is the live editor, `__eukoliaEditorProps` the callbacks it reports
 * through, and `__eukoliaRenderStats` the widget counters.
 */
async function keystrokeProbe(options) {
  const steps = options.steps
  const view = window.__cmView
  const doc = view.state.doc
  const settle = ms => new Promise(r => setTimeout(r, ms))
  const frame = () => new Promise(r => requestAnimationFrame(r))

  /* Which surface is on screen, so the report says what it measured. */
  const surface =
    view.state
      .facet(view.constructor.editorAttributes)
      .map(a => a['data-mode'])
      .filter(Boolean)[0] || 'unknown'

  /*
   * Count what the editor *walks* per keystroke, not only what it spends.
   *
   * The CPU profile of a large document is dominated by lezer's own tree traversal —
   * `enter` and `iterate` — and a traversal can be expensive for two entirely different
   * reasons: many walks over a small tree, or one walk over a huge one. Time alone
   * cannot tell them apart and the fix is opposite in each case, so the number of nodes
   * entered per keystroke is the measurement that decides it.
   *
   * The **prototype** is wrapped, not one tree: every walk in the renderer goes through
   * `Tree.prototype.iterate`, including the ones over trees this function has no handle
   * on, and a keystroke's parse replaces the tree object — so wrapping an instance
   * would miss exactly the walks that matter.
   *
   * Finding a tree to read the prototype from is the awkward part: the renderer is a
   * bundle with no module registry, so `await import('@codemirror/language')` fails with
   * "Failed to resolve module specifier". A tree is found through the editor's own
   * state instead — the language package keeps one in a state field, and anything with
   * an `iterate` method and a `length` will do.
   */
  let nodesEntered = 0
  let walks = 0
  let walkChars = 0
  let lastDetail = []

  const findTree = (value, depth) => {
    if (!value || depth > 4 || typeof value !== 'object') return null
    if (typeof value.iterate === 'function' && typeof value.length === 'number') {
      return value
    }
    for (const key of Object.keys(value)) {
      const found = findTree(value[key], depth + 1)
      if (found) return found
    }
    return null
  }

  const anyTree = (() => {
    const state = view.state
    for (const key of Object.keys(state)) {
      const found = findTree(state[key], 0)
      if (found) return found
    }
    return null
  })()

  let armWalkProbe = () => {}
  if (anyTree) {
    const proto = Object.getPrototypeOf(anyTree)
    const originalIterate = proto.iterate
    /*
     * A wrapper that is *transparent* until it is switched on.
     *
     * The first version always allocated — a detail record and a spread of the spec for
     * every walk — and that alone moved the measured keystroke from 155 ms to 388 ms,
     * which is a probe measuring itself. `armed` is false for every walk outside the
     * measured burst, so those take one boolean test and call straight through.
     */
    let armed = false
    const detail = []
    proto.iterate = function (spec) {
      if (!armed) return originalIterate.call(this, spec)
      const from = spec && typeof spec.from === 'number' ? spec.from : 0
      const to = spec && typeof spec.to === 'number' ? spec.to : this.length
      walks += 1
      walkChars += to - from
      const enter = spec && spec.enter
      const span = { from, to, entered: 0, treeLength: this.length, ms: 0 }
      /*
       * Who asked, as a short stack rather than a guess.
       *
       * A range identifies a walk but not a caller, and the question this probe is
       * pointed at is *which part of the editor* walks the whole document on a
       * keystroke. The stack is taken here, on entry, where it still contains the
       * caller; frames are trimmed to function names because the bundle's paths are
       * meaningless.
       */
      const stack = new Error().stack ?? ''
      span.caller = stack
        .split('\n')
        .slice(1, 12)
        .map(line => line.trim().replace(/^at\s+/, '').replace(/\s*\(.*\)$/, ''))
        .filter(name => name && !name.startsWith('iterate') && !name.startsWith('proto.'))
        .slice(0, 6)
      detail.push(span)
      const started = performance.now()
      const result = originalIterate.call(this, {
        ...spec,
        enter(node) {
          nodesEntered += 1
          span.entered += 1
          return enter ? enter(node) : undefined
        },
      })
      span.ms = performance.now() - started
      return result
    }
    armWalkProbe = on => {
      armed = on
      if (!on) return
      nodesEntered = 0
      walks = 0
      walkChars = 0
      detail.length = 0
      lastDetail = detail
    }
    lastDetail = detail
  }

  /*
   * Wrap the callbacks the editor reports through.
   *
   * The view keeps its props in a ref it reads on every update, so replacing the
   * functions on that object measures the real call sites without touching the editor:
   * `onChange`, `applyChange` (the host's document update) and `onSelectionChange`
   * (which sets the cursor in application state, and so re-renders the shell).
   */
  const stats = {}
  const wrap = (target, key) => {
    const original = target[key]
    if (typeof original !== 'function') return false
    stats[key] = { calls: 0, ms: 0, max: 0 }
    target[key] = function (...args) {
      const started = performance.now()
      try {
        return original.apply(this, args)
      } finally {
        const spent = performance.now() - started
        const entry = stats[key]
        entry.calls += 1
        entry.ms += spent
        entry.max = Math.max(entry.max, spent)
      }
    }
    return true
  }
  const props = window.__eukoliaEditorProps
  const wrapped = []
  if (props) {
    for (const key of ['onChange', 'applyChange', 'onSelectionChange']) {
      if (wrap(props, key)) wrapped.push(key)
    }
  }

  const at = Math.floor(doc.length / 2)
  view.dispatch({ selection: { anchor: at }, effects: view.constructor.scrollIntoView(at) })
  await settle(2000)
  // Opt in to the context scan's own counters: whether it carried its answer over or
  // re-read the prefix is invisible from the outside, and it is a whole prefix walk.
  window.__eukoliaContextScan = { reused: 0, scanned: 0, reasons: {} }

  // Warm: one burst so nothing measured below is a first-time cost.
  for (let step = 0; step < 20; step += 1) {
    view.dispatch({
      changes: { from: at + step, insert: 'w' },
      selection: { anchor: at + step + 1 },
      userEvent: 'input.type',
    })
    await frame()
  }
  await settle(2500)
  for (const key of Object.keys(stats)) stats[key] = { calls: 0, ms: 0, max: 0 }

  const dispatchMs = []
  const frameMs = []
  const docToStringMs = []
  const totalMs = []
  const nodesPerStep = []
  const walksPerStep = []
  const charsPerStep = []
  const heaviestWalks = []

  for (let step = 0; step < steps; step += 1) {
    const position = at + 20 + step
    const overall = performance.now()

    armWalkProbe(true)
    const beforeDispatch = performance.now()
    view.dispatch({
      changes: { from: position, insert: 'q' },
      selection: { anchor: position + 1 },
      userEvent: 'input.type',
    })
    dispatchMs.push(performance.now() - beforeDispatch)
    armWalkProbe(false)
    nodesPerStep.push(nodesEntered)
    walksPerStep.push(walks)
    charsPerStep.push(walkChars)
    heaviestWalks.push(
      [...lastDetail]
        .sort((a, b) => b.entered - a.entered)
        .slice(0, 5)
        .map(({ from, to, entered, treeLength, ms, caller }) => ({
          from,
          to,
          entered,
          treeLength,
          ms: Math.round(ms * 100) / 100,
          caller,
        }))
    )

    const beforeToString = performance.now()
    const text = view.state.doc.toString()
    docToStringMs.push(performance.now() - beforeToString)
    void text

    const beforeFrame = performance.now()
    await frame()
    frameMs.push(performance.now() - beforeFrame)
    totalMs.push(performance.now() - overall)
  }

  const summarise = list => {
    const sorted = [...list].sort((a, b) => a - b)
    const at2 = q =>
      Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10
    return {
      mean: Math.round((list.reduce((sum, value) => sum + value, 0) / list.length) * 10) / 10,
      p50: at2(0.5),
      p90: at2(0.9),
      max: Math.round(sorted[sorted.length - 1] * 10) / 10,
    }
  }

  const callbacks = {}
  for (const [key, entry] of Object.entries(stats)) {
    callbacks[key] = {
      calls: entry.calls,
      meanMs: entry.calls ? Math.round((entry.ms / entry.calls) * 100) / 100 : 0,
      totalMs: Math.round(entry.ms * 10) / 10,
      maxMs: Math.round(entry.max * 100) / 100,
    }
  }

  return {
    surface,
    lines: doc.lines,
    chars: doc.length,
    steps,
    wrapped,
    dispatch: summarise(dispatchMs),
    frameAfterDispatch: summarise(frameMs),
    docToString: summarise(docToStringMs),
    keystrokeTotal: summarise(totalMs),
    walks: summarise(walksPerStep),
    walkChars: summarise(charsPerStep),
    nodesEntered: summarise(nodesPerStep),
    /*
     * The heaviest walks of the last measured keystroke, so a node count can be
     * attributed to a range without a stack trace. The bounds are the ones the caller
     * asked for; `from: 0` with a `to` inside the document is a walk over everything
     * above the viewport, which is the shape that does not belong in a keystroke.
     */
    heaviestWalks: heaviestWalks[heaviestWalks.length - 1] ?? [],
    /** Every fifth keystroke's heaviest walks, so a one-off is not mistaken for a rule. */
    sampledWalks: heaviestWalks.filter((_, index) => index % 5 === 0),
    callbacks,
    contextScan: window.__eukoliaContextScan ?? null,
    renderStats: window.__eukoliaRenderStats ? window.__eukoliaRenderStats() : null,
  }
}
