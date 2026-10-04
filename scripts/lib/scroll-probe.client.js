/*
 * The measurement `scripts/probe-scroll.mjs` injects into the running editor.
 *
 * A file, not a template literal in the runner: this text is injected by
 * `webContents.executeJavaScript`, so as a template literal every backtick inside it
 * would break the outer expression and report the error on an unrelated line of the
 * runner. That trap cost three debugging rounds on `probe-keystroke.mjs` before the
 * script was moved out.
 *
 * ## Two top-level functions, and why
 *
 * The runner splits this text on a boundary line so that V8's sampler can be started
 * between the halves — `visualProbe.ts` does the split, the runner asks for it. That means
 * **each half has to be a program on its own**: a boundary inside a single function body
 * leaves two halves that are both syntax errors.
 *
 * So the measurement is `scrollProbeSetUp` and `scrollProbeRun`, and the shape is
 *
 *     const session = await scrollProbeSetUp(options)
 *     <the boundary line>
 *     scrollProbeRun(session)
 *
 * with the state carried in a `session` object rather than in closure variables. When no
 * profile is asked for, the runner emits the same text with the boundary line simply
 * absent, and the whole thing runs as one program.
 *
 * **The marker must not appear in this file at all**, not even in a comment, and that is
 * not a stylistic point. The split is an `indexOf` on the marker, so the first mention
 * wins — and the paragraph you are reading first named the boundary in order to explain
 * it, so the runner cut the file 522 characters in, in the middle of this comment, leaving
 * two halves that were not JavaScript. The probe reported only "Script failed to execute",
 * which is `executeJavaScript`'s message for anything that fails to parse. The marker is
 * spelled out in the runner instead.
 *
 * ## What it answers
 *
 * The report is "the scroll is extremely stuttery in Visual Mode, especially dense SVG
 * content". Frame time alone cannot say *why* a gesture was slow — many small dispatches
 * and one huge layout produce the same average and want opposite fixes — so this counts,
 * per gesture:
 *
 *   - every `view.dispatch`, attributed to a caller by its stack, because a transaction
 *     per rendered widget and a transaction per keystroke are the same number and
 *     different problems;
 *   - every widget `toDOM` (a fresh equation element) and `updateDOM` (an in-place
 *     re-render), by widget class;
 *   - decoration-field rebuilds, from the application's own counter;
 *   - frame intervals, and how many exceed one and two frames.
 *
 * The wrappers are installed once and do nothing until a gesture *arms* them, so the
 * reading is not the reading of a probe attached to it — the first version of the
 * keystroke probe allocated per walk and doubled the number it was measuring.
 */
async function scrollProbe(options) {
  const steps = options.steps
  const settleMs = options.settleMs
  /*
   * One switch for an A/B that does not need two builds. The application reads it as a
   * global flag, so the same bundle is measured both ways and the only difference between
   * the two runs is the flag.
   */
  globalThis.__eukoliaNoSizeReserve = options.noSizeReserve === true
  /*
   * The decoration field's own counters, so a gesture can be asked how many times Visual
   * Mode **rebuilt its widgets**. That number is the heart of the comparison: Code Mode
   * builds nothing while scrolling, and a rebuild re-walks the span and constructs every
   * widget in it. The application installs none of this, so the cost is one property read
   * per rebuild when the probe is not attached.
   */
  globalThis.__eukoliaDecorationProfile = globalThis.__eukoliaDecorationProfile ?? {
    rebuilds: 0,
    ms: 0,
    preambleMs: 0,
    rangeMs: 0,
    ranges: 0,
    widgets: 0,
    setMs: 0, skips: 0,
  }
  if (typeof globalThis.__eukoliaDecorationProfile.setMs !== 'number') {
    globalThis.__eukoliaDecorationProfile.setMs = 0
  }
  /*
   * How far past the viewport the widget pass builds, in screens. The A/B that chose the
   * shipped value runs from one build by setting this.
   */
  if (typeof options.marginHalves === 'number' && options.marginHalves > 0) {
    globalThis.__eukoliaMarginHalves = options.marginHalves
  }
  /*
   * The render cache's miss log, so a scroll can be asked *why* it rendered.
   *
   * The counters say how many misses; they cannot say whether those were equations never
   * seen before — which a scroll into new ground produces by definition — or the same
   * equations rendered again because their key changed underneath them, which is a bug. The
   * log records the equation and a fingerprint of the definitions for each miss, so the
   * answer is a signature count rather than a guess.
   */
  globalThis.__eukoliaCacheMisses = []
  const view = window.__cmView
  const scroller = view.scrollDOM
  const settle = ms => new Promise(r => setTimeout(r, ms))

  const counters = {
    dispatch: 0,
    refreshDispatch: 0,
    dispatchMs: 0,
    refreshDispatchMs: 0,
    refreshDispatchMax: 0,
    dispatchByCaller: {},
    mathRenderMs: 0,
    mathRenders: 0,
    widgets: 0,
  }
  let armed = false

  /*
   * Time inside MathJax, measured at the one place every rendering goes through.
   *
   * The render cache is the whole reason a scroll should be cheap after the first pass
   * over a region, and the counters say it is not: on `algebra.tex` a *warm* pass
   * recorded 367 misses against 491 hits. A miss means MathJax typeset the equation
   * again, and typesetting is tens of milliseconds — so the question "how much of the
   * frame is MathJax?" is answered by timing it rather than by inferring it from a
   * count, because a count cannot tell a 2 ms render from a 40 ms one.
   *
   * `tex2svgPromise` is wrapped on the prototype of whatever MathJax instance the
   * application holds, found through the render cache it also publishes.
   */
  const wrapMathJax = () => {
    const stats = window.__eukoliaRenderStats
    if (typeof stats !== 'function') return false
    const anyMathJax = window.__eukoliaMathJax
    if (!anyMathJax || typeof anyMathJax.tex2svgPromise !== 'function') return false
    const original = anyMathJax.tex2svgPromise.bind(anyMathJax)
    anyMathJax.tex2svgPromise = async function (...args) {
      if (!armed) return original(...args)
      counters.mathRenders += 1
      const started = performance.now()
      try {
        return await original(...args)
      } finally {
        counters.mathRenderMs += performance.now() - started
      }
    }
    return true
  }
  const mathJaxWrapped = wrapMathJax()

  /* ---- every transaction, attributed to a caller ---------------------------- */
  const originalDispatch = view.dispatch.bind(view)
  view.dispatch = function (...args) {
    if (!armed) return originalDispatch(...args)
    counters.dispatch += 1
    const spec = args[0]
    const effects = spec && spec.effects
    let isRefresh = false
    if (effects) {
      const list = Array.isArray(effects) ? effects : [effects]
      /*
       * The asynchronous-widget refresh is an effects-bearing transaction that also
       * restates a selection unchanged — one per rendered equation. Recognising it is
       * what tells "the editor is redrawing itself" from "the user is typing", and the
       * effect itself is not importable here (this is a bundle with no module
       * registry), so it is recognised by shape.
       */
      if (spec.selection && list.length > 0) isRefresh = true
    }
    /*
     * The one experiment that asks whether these are the cost: swallow them.
     *
     * They are the only thing happening ~90 times per gesture, each running the whole
     * view update, and the caret they exist for is not visible during a scroll. Dropping
     * them is *not* a fix — it is the measurement that says whether the fix is worth
     * designing, and the same shape as removing the mathematics from the DOM, which
     * answered its question the same way.
     */
    if (isRefresh && counters.dropRefreshes) {
      counters.refreshDispatch += 1
      return
    }
    /*
     * Frames that name the *reason* rather than the mechanism. Everything goes through
     * CodeMirror's `update`/`updatePlugins`, so those are skipped; the first frame above
     * them is the caller that asked.
     */
    const stack = (new Error().stack ?? '').split('\n').slice(2)
    let caller = 'anonymous'
    for (const line of stack) {
      const name = line.trim().replace(/^at\s+/, '').replace(/\s*\(.*\)$/, '')
      if (!name) continue
      if (/^(dispatch|update|updatePlugins|updateState|dispatchTransactions|Object\.|Array\.)/.test(name)) {
        continue
      }
      caller = name
      break
    }
    const key = caller.replace(/\d+/g, '#').slice(0, 64)
    counters.dispatchByCaller[key] = (counters.dispatchByCaller[key] ?? 0) + 1

    /*
     * Timed, because the count says nothing about the cost. A transaction runs the whole
     * view update — every plugin's `update`, the document-view sync, and a measure — so a
     * hundred cheap-looking transactions can be the entire frame budget, and that is
     * exactly what the first reading of `algebra.tex` suggested: 101 refresh dispatches
     * in 60 frames.
     */
    const started = performance.now()
    try {
      return originalDispatch(...args)
    } finally {
      const spent = performance.now() - started
      counters.dispatchMs += spent
      if (isRefresh) {
        counters.refreshDispatch += 1
        counters.refreshDispatchMs += spent
        if (spent > counters.refreshDispatchMax) counters.refreshDispatchMax = spent
      }
    }
  }

  /*
   * Widget `toDOM` and `updateDOM` were instrumented here, through a map of widget
   * classes the application published for the purpose. They answered their question and
   * the answer was **no**: on `algebra.tex` a 60-step gesture spent 16.9 ms building 221
   * fresh equation elements and 3 ms re-rendering 12 of them, against 468 ms of
   * transactions inside a 2 246 ms gesture. The hook is gone from the application rather
   * than left in for a measurement that has already been made.
   */

  /**
   * Where a gesture starts.
   *
   * Every reading in this repository so far began at `scrollTop = 0`, which is the
   * *preamble* of a Stacks chapter — `\documentclass`, `\input`, `\newcommand`, almost no
   * mathematics and no environments. A comparison run from there measures the cheapest
   * part of the document, and worse, the two modes were being compared from wherever the
   * probe happened to warm up rather than from the same place. A line number fixes both:
   * the same ground is covered, in both modes, in every configuration.
   */
  const startAtLine = () => {
    if (!options.startLine) return 0
    const line = view.state.doc.line(
      Math.max(1, Math.min(options.startLine, view.state.doc.lines))
    )
    const block = view.lineBlockAt(line.from)
    return Math.max(0, block.top)
  }

  const gesture = async (label, count, deltaY) => {
    scroller.scrollTop = startAtLine()
    await settle(settleMs)

    /*
     * Long frames, attributed by the browser rather than by me.
     *
     * The phase timings account for 0.6 s of a 2.8 s gesture on `algebra.tex`, and
     * "unattributed" is not a finding: the rest is style, layout and paint, which no
     * amount of wrapping JavaScript can see. The `long-animation-frame` entries carry
     * exactly that split — `script` (itself), `styleAndLayout`, and `blockingDuration`
     * (the render-blocking part) — so one observer says whether the stutter is our
     * JavaScript, the browser's style pass, or its layout.
     */
    const longFrames = []
    const observer =
      typeof PerformanceObserver === 'function' &&
      PerformanceObserver.supportedEntryTypes &&
      PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
        ? new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
              const scripts = entry.scripts ?? []
              longFrames.push({
                duration: Math.round(entry.duration),
                blocking: Math.round(entry.blockingDuration ?? 0),
                styleAndLayout: Math.round(entry.styleAndLayoutStart
                  ? Math.max(0, entry.startTime + entry.duration - entry.styleAndLayoutStart)
                  : 0),
                script: Math.round(
                  scripts.reduce((sum, script) => sum + Math.max(0, script.duration), 0)
                ),
                scriptCount: scripts.length,
              })
            }
          })
        : null
    if (observer) observer.observe({ type: 'long-animation-frame', buffered: false })

    /*
     * What the editor is actually holding, which is the layout's input.
     *
     * Every rendered equation is an `<svg>` whose glyphs are `<path>` or `<use>`
     * elements, so the viewport's node count is what a style pass walks and what a
     * layout has to position. A stutter that is *not* in the script is a function of
     * these numbers, and they are cheap to read.
     */
    const domBefore = {
      nodes: view.contentDOM.querySelectorAll('*').length,
      svgs: view.contentDOM.querySelectorAll('svg').length,
      paths: view.contentDOM.querySelectorAll('svg path').length,
      uses: view.contentDOM.querySelectorAll('svg use').length,
      math: view.contentDOM.querySelectorAll('.ol-cm-math').length,
      lines: view.contentDOM.querySelectorAll('.cm-line').length,
    }
    /*
     * What the viewport's elements *are*.
     *
     * "1 600 elements against Code Mode's 560" is a fact without a cause until it is broken
     * down, and the breakdown decides whether there is anything to remove: two hundred
     * decoration spans each wrapping one character are a different problem from two hundred
     * equations, and they want different fixes. Counted by the application's own class
     * prefixes, `ol-cm-*` and `eu-*`.
     */
    const classNameCensus = () => {
      const census = {}
      for (const element of view.contentDOM.querySelectorAll('*')) {
        for (const name of element.classList) {
          if (!name.startsWith('ol-cm-') && !name.startsWith('eu-')) continue
          census[name] = (census[name] ?? 0) + 1
        }
      }
      return Object.entries(census)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 14)
    }

    /*
     * The upper bound, when the runner asks for it: how fast is this gesture with the
     * mathematics not there at all?
     *
     * `visibility: hidden` was already measured and changes nothing, and it is not the
     * same experiment: a hidden element still has geometry to lay out and a subtree the
     * style pass walks. Removing the rendered nodes is the only way to ask what the
     * mathematics *costs*, and the answer bounds every possible fix — if taking it all
     * away buys 20 %, no technique of rendering it more cleverly is going to matter, and
     * if it buys 80 % then rendering less of it is the whole answer.
     *
     * Only the SVG contents are taken out, not the `.ol-cm-math` box. The box is what
     * carries the inline geometry the line is laid out against, so removing it would
     * change the document's layout as well as its paint — two variables at once, and the
     * question here is about painting. Removing the glyphs leaves every box exactly the
     * size it was.
     *
     * They are put back afterwards, and the stylesheet is untouched, so the page is not
     * left modified.
     */
    let mathRemoval = null
    if (options.removeMath) {
      const contents = [...view.contentDOM.querySelectorAll('.ol-cm-math')]
      const stash = []
      for (const node of contents) {
        const glyphs = [...node.children]
        for (const child of glyphs) {
          stash.push({
            node: child,
            parent: node,
            next:
              child.nextSibling && node.contains(child.nextSibling)
                ? child.nextSibling
                : null,
          })
          node.removeChild(child)
        }
      }
      mathRemoval = {
        count: stash.length,
        restore: () => {
          /*
           * CodeMirror owns this DOM and keeps rearranging it. The parent element can be
           * gone by the time a gesture ends — the line it was in left the viewport — and
           * the sibling it sat before can have gone with it, so a failing `insertBefore`
           * is expected rather than exceptional and must not take the measurement down
           * with it.
           */
          for (const { node, parent, next } of stash) {
            if (node.parentNode || !parent.isConnected) continue
            try {
              parent.insertBefore(node, next)
            } catch {
              try {
                parent.appendChild(node)
              } catch {
                /* the parent has gone; the widget will be rebuilt anyway */
              }
            }
          }
        },
      }
    }

    for (const key of Object.keys(counters.dispatchByCaller)) delete counters.dispatchByCaller[key]
    counters.dispatch = 0
    counters.refreshDispatch = 0
    counters.dispatchMs = 0
    counters.refreshDispatchMs = 0
    counters.refreshDispatchMax = 0
    counters.mathRenderMs = 0
    counters.mathRenders = 0
    counters.dropRefreshes = options.dropRefreshes === true

    globalThis.__eukoliaCacheMisses.length = 0
    const rebuildsBefore = window.__eukoliaDecorationProfile
      ? window.__eukoliaDecorationProfile.rebuilds
      : null
    const profile = window.__eukoliaDecorationProfile
    const profileMsBefore = profile ? profile.ms : 0
    const profileWidgetsBefore = profile ? profile.widgets : 0
    const profileRangesBefore = profile ? profile.ranges : 0
    const profileSetBefore = profile ? (profile.setMs ?? 0) : 0

    const intervals = []
    let last = performance.now()
    const started = last
    const startedScrollTop = scroller.scrollTop
    armed = true
    const frameSnapshots = []
    for (let step = 0; step < count; step += 1) {
      scroller.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
        })
      )
      await new Promise(r =>
        requestAnimationFrame(() => {
          const now = performance.now()
          intervals.push(now - last)
          last = now
          /*
           * The counters as of this frame, so a slow frame can be attributed to what
           * happened *in* it rather than to the gesture as a whole. Read after the frame's
           * own work, which is the point: these are the numbers the browser had when the
           * frame was slow.
           */
          const decoration = window.__eukoliaDecorationProfile
          frameSnapshots.push({
            dispatches: counters.dispatch,
            rebuilds: decoration ? decoration.rebuilds : 0,
            widgets: decoration ? decoration.widgets : 0,
          })
          r()
        })
      )
    }
    armed = false
    const wall = performance.now() - started
    if (observer) {
      // The entries for the last frames arrive a moment after the gesture.
      await settle(120)
      observer.disconnect()
    }
    // Put the mathematics back before anything else reads the DOM.
    if (mathRemoval) mathRemoval.restore()

    /*
     * What the render cache was asked for and missed, for *this* gesture only: the log is
     * cleared as the gesture starts, so the signatures describe this ground rather than the
     * whole session.
     */
    const misses = (globalThis.__eukoliaCacheMisses ?? []).slice(-400)
    const bySignature = new Map()
    for (const miss of misses) {
      bySignature.set(miss.signature, (bySignature.get(miss.signature) ?? 0) + 1)
    }
    const cacheMisses = {
      count: misses.length,
      distinctDefinitions: bySignature.size,
      distinctEquations: new Set(misses.map(miss => miss.math)).size,
      bySignature: [...bySignature.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
    }

    const rebuildsAfter = window.__eukoliaDecorationProfile
      ? window.__eukoliaDecorationProfile.rebuilds
      : null
    const profileMsAfter = profile ? profile.ms : 0
    const profileWidgetsAfter = profile ? profile.widgets : 0
    const profileRangesAfter = profile ? profile.ranges : 0
    const profileSetAfter = profile ? (profile.setMs ?? 0) : 0
    const sorted = [...intervals].sort((a, b) => a - b)
    const at = q =>
      Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10

    const domAfter = {
      nodes: view.contentDOM.querySelectorAll('*').length,
      svgs: view.contentDOM.querySelectorAll('svg').length,
      paths: view.contentDOM.querySelectorAll('svg path').length,
      uses: view.contentDOM.querySelectorAll('svg use').length,
      math: view.contentDOM.querySelectorAll('.ol-cm-math').length,
      lines: view.contentDOM.querySelectorAll('.cm-line').length,
    }

    /*
     * The long frames, summed and split. `styleAndLayout` is the browser's own style
     * recalculation and layout for that frame; `script` is the part attributable to
     * JavaScript, and `blocking` is the render-blocking time the browser reports.
     */
    const longSummary = longFrames.length
      ? {
          count: longFrames.length,
          worstMs: Math.max(...longFrames.map(frame => frame.duration)),
          totalMs: longFrames.reduce((sum, frame) => sum + frame.duration, 0),
          scriptMs: longFrames.reduce((sum, frame) => sum + frame.script, 0),
          styleAndLayoutMs: longFrames.reduce((sum, frame) => sum + frame.styleAndLayout, 0),
          blockingMs: longFrames.reduce((sum, frame) => sum + frame.blocking, 0),
          worst: [...longFrames].sort((a, b) => b.duration - a.duration).slice(0, 5),
        }
      : null

    /*
     * Every frame, in order, paired with the counters that moved during it.
     *
     * A distribution says *that* a gesture stutters and cannot say *which* frame did, and the
     * answer to "what is the remaining cost" is in the identity of the bad frames — the one
     * after a rebuild, the one a rendering landed in, the first frame of the gesture — rather
     * than in an average. This is the cheapest instrument that can attribute a 140 ms frame
     * without a trace: the counters are already there, and pairing them with the interval is
     * a subtraction per frame.
     */
    const worstFrames = intervals
      .map((ms, index) => ({
        frame: index,
        ms: Math.round(ms * 10) / 10,
        dispatches: frameSnapshots[index] ? frameSnapshots[index].dispatches : null,
        rebuilds: frameSnapshots[index] ? frameSnapshots[index].rebuilds : null,
        widgetsBuilt: frameSnapshots[index] ? frameSnapshots[index].widgets : null,
      }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 8)

    return {
      label,
      wallMs: Math.round(wall),
      travelled: Math.round(scroller.scrollTop - startedScrollTop),
      startScrollTop: startedScrollTop,
      endScrollTop: scroller.scrollTop,
      frames: intervals.length,
      interval: {
        p50: at(0.5),
        p90: at(0.9),
        p99: at(0.99),
        max: Math.round(sorted[sorted.length - 1]),
        over33: intervals.filter(v => v > 33).length,
        over100: intervals.filter(v => v > 100).length,
      },
      dom: { before: domBefore, after: domAfter },
      longFrames: longSummary,
      worstFrames,
      classNameCensus: classNameCensus(),
      cacheMisses,
      dispatches: counters.dispatch,
      refreshDispatches: counters.refreshDispatch,
      /*
       * Where the gesture's wall time went, in milliseconds. These are the numbers that
       * decide the fix: the frame intervals say the scroll stutters, and these say
       * whether the stutter is transactions, widget construction, or MathJax.
       */
      ms: {
        dispatch: Math.round(counters.dispatchMs * 10) / 10,
        refreshDispatch: Math.round(counters.refreshDispatchMs * 10) / 10,
        refreshDispatchMax: Math.round(counters.refreshDispatchMax * 10) / 10,
        mathRender: Math.round(counters.mathRenderMs * 10) / 10,
        mathRenders: counters.mathRenders,
        wall: Math.round(wall),
      },
      dispatchesByCaller: Object.entries(counters.dispatchByCaller)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
      rebuilds:
        rebuildsAfter !== null && rebuildsBefore !== null ? rebuildsAfter - rebuildsBefore : null,
      /*
       * Where the decoration pass's time went, which is the question "why is Visual Mode
       * slower" asked precisely. `rebuilds` says how often it ran, `widgets` how many
       * objects it constructed, and `msWork` the whole pass — so a gesture can be
       * attributed between "it runs often" and "each run is expensive", which want opposite
       * fixes and which no frame time can separate.
       */
      decorationWork:
        rebuildsAfter !== null && rebuildsBefore !== null
          ? {
              rebuilds: rebuildsAfter - rebuildsBefore,
              ms: Math.round((profileMsAfter - profileMsBefore) * 10) / 10,
              widgets: profileWidgetsAfter - profileWidgetsBefore,
              ranges: profileRangesAfter - profileRangesBefore,
              setMs: Math.round((profileSetAfter - profileSetBefore) * 10) / 10,
            }
          : null,
      renderStats: window.__eukoliaRenderStats ? window.__eukoliaRenderStats() : null,
      mathCounters: window.__eukoliaMathCounters ? { ...window.__eukoliaMathCounters } : null,
    }
  }



  const cold = await gesture('cold', steps, options.deltaY)
  const warm = await gesture('warm', steps, options.deltaY)

  /*
   * Alternating passes, because one reading measures the order it ran in: whichever
   * pass runs first meets the most work, whatever is being compared. That is the
   * confound which invalidated this repository's first scroll experiment, and it is why
   * the sequence repeats rather than being read once.
   */
  const passes = []
  for (let pass = 0; pass < options.passes; pass += 1) {
    passes.push(await gesture('pass #' + pass, steps, options.deltaY))
  }

  /*
   * The upper bound, if the runner asked for it — **and interleaved**, because a bound
   * measured in a block of its own is a bound measured in a different phase of the
   * document's life. The same gesture runs twice more with the mathematics taken out of
   * the DOM between them, so the two readings differ only in whether it is there.
   */
  let withMath = null
  let withMath2 = null
  let withoutMath = null
  if (options.removeMath) {
    withMath = await gesture('with math', steps, options.deltaY)
    options.removeMath = true
    withoutMath = await gesture('without math', steps, options.deltaY)
    options.removeMath = false
    withMath2 = await gesture('with math #2', steps, options.deltaY)
  }

  /*
   * The refresh bound, if asked for and interleaved with its control: the same gesture
   * with the widget refreshes dropped, and then with them restored. Same shape as the
   * mathematics bound below, and for the same reason — a bound measured in a block of its
   * own is measured in a different phase of the document's life.
   */
  let refreshBound = null
  if (options.noRefresh) {
    const kept = await gesture('refreshes kept', steps, options.deltaY)
    options.dropRefreshes = true
    const dropped = await gesture('refreshes dropped', steps, options.deltaY)
    options.dropRefreshes = false
    const keptAgain = await gesture('refreshes kept #2', steps, options.deltaY)
    refreshBound = {
      kept: { p50: kept.interval.p50, p90: kept.interval.p90, over33: kept.interval.over33 },
      dropped: {
        p50: dropped.interval.p50,
        p90: dropped.interval.p90,
        over33: dropped.interval.over33,
      },
      keptAgain: {
        p50: keptAgain.interval.p50,
        p90: keptAgain.interval.p90,
        over33: keptAgain.interval.over33,
      },
      longFramesKept: kept.longFrames,
      longFramesDropped: dropped.longFrames,
    }
  }

  /*
   * A sweep across the document, when asked for: the same gesture from several starting
   * lines.
   *
   * This is the measurement that decides whether the widget DOM is *the* cost or merely
   * correlated with it. A Stacks chapter is not uniform — the preamble has no mathematics
   * at all and the body does — so a single reading cannot separate "Visual Mode is slow"
   * from "Visual Mode is slow where the mathematics is". Sweeping the same gesture across
   * positions of known density gives the curve, and the curve says how much of the frame
   * time a given reduction in elements would buy.
   */
  const sweep = []
  if (options.sweepLines && options.sweepLines.length > 0) {
    /*
     * Several passes per position, and the **mean of them** is what is reported.
     *
     * A single pass per position was the first version, and it could not answer the
     * question: repeating the same configuration gave p90 readings that moved 40 % in both
     * directions depending on where the pass landed, so a change measured once per
     * position was measuring the noise. The passes alternate, so a systematic effect of
     * order — the first pass in a region meets the most work — lands on every position
     * equally.
     */
    const passesPerPosition = Math.max(1, options.sweepPasses ?? 3)
    for (const line of options.sweepLines) {
      options.startLine = line
      const taken = []
      for (let pass = 0; pass < passesPerPosition; pass += 1) {
        taken.push(await gesture('line ' + line + ' #' + pass, steps, options.deltaY))
      }
      const mean = key =>
        Math.round((taken.reduce((sum, p) => sum + (p.interval[key] ?? 0), 0) / taken.length) * 10) / 10
      const last = taken[taken.length - 1]
      sweep.push({
        line,
        passes: taken.length,
        p50: mean('p50'),
        p90: mean('p90'),
        max: mean('max'),
        over33: mean('over33'),
        nodes: last.dom.after.nodes,
        svgs: last.dom.after.svgs,
        math: last.dom.after.math,
        lines: last.dom.after.lines,
        longFrames: last.longFrames,
      })
    }
    options.startLine = options.sweepLines[0]
  }

  const summary = {
    lines: view.state.doc.lines,
    chars: view.state.doc.length,
    surface:
      view.state
        .facet(view.constructor.editorAttributes)
        .map(a => a['data-mode'])
        .filter(Boolean)[0] || 'unknown',
    steps,
    deltaY: options.deltaY,
    cold,
    warm,
    passes: passes.map(p => ({
      label: p.label,
      p50: p.interval.p50,
      p90: p.interval.p90,
      max: p.interval.max,
      over33: p.interval.over33,
      over100: p.interval.over100,
      dispatches: p.dispatches,
      refreshDispatches: p.refreshDispatches,
      rebuilds: p.rebuilds,
      travelled: p.travelled,
    })),
    lastPassDetail: passes[passes.length - 1] ?? null,
    coldDetail: cold,
    /*
     * The upper bound: the same gesture with the rendered mathematics in the DOM and
     * with it removed. The gap between them is everything any technique of drawing the
     * mathematics better could possibly win.
     */
    mathBound: withMath && withoutMath
      ? {
          withMath: {
            p50: withMath.interval.p50,
            p90: withMath.interval.p90,
            over33: withMath.interval.over33,
            over100: withMath.interval.over100,
            nodes: withMath.dom.before.nodes,
          },
          withoutMath: {
            p50: withoutMath.interval.p50,
            p90: withoutMath.interval.p90,
            over33: withoutMath.interval.over33,
            over100: withoutMath.interval.over100,
            nodes: withoutMath.dom.before.nodes,
          },
          withMathAgain: {
            p50: withMath2 ? withMath2.interval.p50 : null,
            p90: withMath2 ? withMath2.interval.p90 : null,
          },
          longFramesWith: withMath.longFrames,
          longFramesWithout: withoutMath.longFrames,
        }
      : null,
    refreshBound,
    sweep,
  }

  return summary
}
