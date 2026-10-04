/*
 * The compositor experiment: does isolating the scroller change the frame interval?
 *
 * `ARCHITECTURE.md` §3.33 named this first among the things left, and §3.34/§3.36 record
 * that nothing like it was ever measured cleanly. The one related result is `contain: paint`
 * making the scroll *worse* (72.5 ms against 56.3 ms) — a different property on an
 * unrecorded element, so it neither confirms nor refutes this.
 *
 * The measurement is the repository's method, because the method is the part that has
 * repeatedly been got wrong here: **alternate the configurations in a repeating sequence
 * and include a control that changes nothing.** Whichever configuration runs first meets
 * the coldest document, so a block-per-configuration table measures the order it ran in.
 * The control is what turns "the number moved" into "the change moved it".
 *
 * What each arm does, all applied to `view.scrollDOM` (the element the wheel events are
 * dispatched at) or its child unless stated:
 *
 *   control     re-asserts the shipped computed values — proves the harness itself is inert
 *   contain     `contain: strict` on the scroller: layout, style, paint and size all bounded
 *   content     `contain: content` (= layout paint style, size left intrinsic)
 *   paint       `contain: paint` alone, the one that was measured worse
 *   layer       `will-change: transform` — a compositor layer for the scroller itself
 *   layerChild  `will-change: transform` on `contentDOM`, so the paint is its own layer
 *   cv          `content-visibility: hidden` on the sizer — never laid out or painted
 *
 * Every arm is reverted to the recorded inline style before the next one, so the document is
 * never measured with two of them applied. `!important` is used so a stylesheet in the
 * application cannot silently win and turn an arm into a second control.
 *
 * One thing this cannot answer, and says so in its own report: a compositor layer changes
 * *rasterisation*, which the `long-animation-frame` attribution does not see. The frame
 * interval is the arbiter here; if an arm wins, the mechanism still needs a trace.
 */
async function compositorProbe(options) {
  const view = window.__cmView;
  if (!view) throw new Error('no window.__cmView');
  const scroller = view.scrollDOM;
  const content = view.contentDOM;
  const sizer = scroller.firstElementChild;

  const settle = ms => new Promise(r => setTimeout(r, ms));
  const raf = () => new Promise(r => requestAnimationFrame(r));

  const ARMS = {
    control: () => {},
    /*
     * `strict` is `size layout paint style`, and it was the only arm that beat the control
     * (p50 139.5 -> 85.1 ms over three cycles). `size` is the part that cannot ship: it
     * makes the element size itself as if it had no contents, which is safe only because
     * the scroller happens to get its box from its parent. The three below take `strict`
     * apart so the win can be attributed to a property that is defensible on its own.
     */
    strict: () => {
      scroller.style.setProperty('contain', 'strict', 'important');
    },
    sizeLayoutPaint: () => {
      scroller.style.setProperty('contain', 'size layout paint', 'important');
    },
    sizeLayout: () => {
      scroller.style.setProperty('contain', 'size layout', 'important');
    },
    layout: () => {
      scroller.style.setProperty('contain', 'layout', 'important');
    },
    layoutPaint: () => {
      scroller.style.setProperty('contain', 'layout paint', 'important');
    },
    layoutPaintStyle: () => {
      scroller.style.setProperty('contain', 'layout paint style', 'important');
    },
    style: () => {
      scroller.style.setProperty('contain', 'style', 'important');
    },
    paint: () => {
      scroller.style.setProperty('contain', 'paint', 'important');
    },
    layer: () => {
      scroller.style.setProperty('will-change', 'transform', 'important');
    },
    layerChild: () => {
      content.style.setProperty('will-change', 'transform', 'important');
    },
    cv: () => {
      if (!sizer) throw new Error('scroller has no sizer child');
      sizer.style.setProperty('content-visibility', 'hidden', 'important');
    },
  };

  /*
   * The recorded inline style is restored *verbatim* between arms rather than by removing
   * the properties the arm set, so an arm cannot leave a trace for the next one. The
   * application sets some of these itself; taking a copy first is what makes that safe.
   */
  const saved = {
    scroller: scroller.getAttribute('style'),
    content: content.getAttribute('style'),
    sizer: sizer ? sizer.getAttribute('style') : null,
  };
  const restore = () => {
    const put = (element, value) => {
      if (value === null) element.removeAttribute('style');
      else element.setAttribute('style', value);
    };
    put(scroller, saved.scroller);
    put(content, saved.content);
    if (sizer) put(sizer, saved.sizer);
  };

  const requested = Array.isArray(options.arms) && options.arms.length > 0 ? options.arms : ['control', 'contain', 'content', 'layer'];
  const arms = requested.filter(name => name in ARMS);
  if (arms.length === 0) throw new Error('no known arms requested');

  const counters = { dispatches: 0 };
  /* Counted per arm, not per gesture, so "what did this arm do to the editor" is answerable. */
  const originalDispatch = view.dispatch.bind(view);
  view.dispatch = function (...args) {
    counters.dispatches += 1;
    return originalDispatch(...args);
  };

  const longFrames = [];
  let observing = false;
  const observer = PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
    ? new PerformanceObserver(list => {
        if (!observing) return;
        for (const entry of list.getEntries()) {
          longFrames.push({
            duration: Math.round(entry.duration * 10) / 10,
            blocking: Math.round((entry.blockingDuration ?? 0) * 10) / 10,
            script: Math.round(entry.scripts.reduce((n, s) => n + s.duration, 0) * 10) / 10,
            /*
             * `styleAndLayoutStart` is an absolute timestamp, and the style/layout phase runs
             * to the end of the entry — so the span is measured from it rather than summed.
             */
            styleAndLayout:
              Math.round(
                Math.max(0, entry.startTime + entry.duration - entry.styleAndLayoutStart) * 10
              ) / 10,
            scriptCount: entry.scripts.length,
          });
        }
      })
    : null;

  /* `view.measure()` is CodeMirror's own cost on this path (§3.34: 1367 ms of a trace). */
  const originalMeasure = view.measure.bind(view);
  let measureCalls = 0;
  view.measure = function (...args) {
    measureCalls += 1;
    return originalMeasure(...args);
  };

  const gesture = async (label, steps, deltaY) => {
    const before = {
      nodes: content.querySelectorAll('*').length,
      svgs: content.querySelectorAll('svg').length,
      math: content.querySelectorAll('.ol-cm-math').length,
    };
    const scrollBefore = scroller.scrollTop;
    /*
     * The geometry a containment bug would break, read before and after: CodeMirror lays the
     * document out in `sizer` and reads this element back through `view.measure()`, so a
     * `contain` that stops the sizer contributing its height would show up here first — as a
     * collapsed `sizer.height`, a `scrollHeight` that no longer exceeds `clientHeight`, or a
     * viewport that stops showing a screenful of lines. An arm that wins on frame time and
     * collapses the document is not a fix, and this is how that is caught rather than
     * discovered later.
     */
    const geometry = () => ({
      clientHeight: scroller.clientHeight,
      clientWidth: scroller.clientWidth,
      scrollHeight: scroller.scrollHeight,
      sizerHeight: sizer ? Math.round(sizer.getBoundingClientRect().height) : null,
      contentHeight: Math.round(content.getBoundingClientRect().height),
      lines: content.querySelectorAll('.cm-line').length,
    });
    const geometryBefore = geometry();
    measureCalls = 0;
    counters.dispatches = 0;
    longFrames.length = 0;
    observing = true;

    const intervals = [];
    let last = performance.now();
    for (let step = 0; step < steps; step += 1) {
      scroller.dispatchEvent(
        new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true })
      );
      await raf();
      const now = performance.now();
      intervals.push(now - last);
      last = now;
    }
    observing = false;
    /*
     * The first interval is the wait *before* the first frame and belongs to no gesture step;
     * dropping it is what keeps a warm-up cost out of the distribution. Every arm pays it.
     */
    intervals.shift();
    const sorted = [...intervals].sort((a, b) => a - b);
    const at = q => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10;
    const domAfter = {
      nodes: content.querySelectorAll('*').length,
      svgs: content.querySelectorAll('svg').length,
      math: content.querySelectorAll('.ol-cm-math').length,
    };
    return {
      label,
      p50: at(0.5),
      p90: at(0.9),
      max: Math.round(sorted[sorted.length - 1] * 10) / 10,
      over33: intervals.filter(v => v > 33.4).length,
      over50: intervals.filter(v => v > 50).length,
      frames: intervals.length,
      travelled: Math.round(scroller.scrollTop - scrollBefore),
      dispatches: counters.dispatches,
      measureCalls,
      nodesBefore: before.nodes,
      nodesAfter: domAfter.nodes,
      mathBefore: before.math,
      mathAfter: domAfter.math,
      geometryBefore,
      geometryAfter: geometry(),
      longFrames: longFrames.length
        ? {
            count: longFrames.length,
            worstMs: Math.max(...longFrames.map(f => f.duration)),
            totalMs: Math.round(longFrames.reduce((n, f) => n + f.duration, 0) * 10) / 10,
            blockingMs: Math.round(longFrames.reduce((n, f) => n + f.blocking, 0) * 10) / 10,
            scriptMs: Math.round(longFrames.reduce((n, f) => n + f.script, 0) * 10) / 10,
          }
        : null,
    };
  };

  /* Warm the region once so every arm starts on ground that has been seen. */
  if (options.startLine > 0) {
    const pos = view.state.doc.line(Math.min(options.startLine, view.state.doc.lines)).from;
    view.dispatch({ selection: { anchor: pos }, effects: view.constructor.scrollIntoView(pos, { y: 'start' }) });
    await settle(1200);
  }
  const scrollStart = scroller.scrollTop;

  const samples = [];
  const cycles = options.cycles ?? 3;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (const arm of arms) {
      restore();
      scroller.scrollTop = scrollStart;
      await raf();
      await raf();
      ARMS[arm]();
      await raf();
      const reading = await gesture(`${arm} #${cycle}`, options.steps, options.deltaY);
      reading.cycle = cycle;
      reading.arm = arm;
      /* Read back what the arm actually got, so an arm the application overrides is visible. */
      reading.applied = {
        contain: getComputedStyle(scroller).contain,
        willChange: getComputedStyle(scroller).willChange,
        sizerContentVisibility: sizer ? getComputedStyle(sizer).contentVisibility : null,
      };
      samples.push(reading);
      if (observer) {
        await settle(120);
      }
    }
  }
  observing = false;
  if (observer) observer.disconnect();
  restore();
  view.dispatch = originalDispatch;
  view.measure = originalMeasure;
  scroller.scrollTop = scrollStart;

  const mean = values =>
    values.length ? Math.round((values.reduce((n, v) => n + v, 0) / values.length) * 10) / 10 : 0;
  const byArm = {};
  for (const arm of arms) {
    const taken = samples.filter(s => s.arm === arm);
    byArm[arm] = {
      runs: taken.length,
      p50: mean(taken.map(s => s.p50)),
      p90: mean(taken.map(s => s.p90)),
      max: mean(taken.map(s => s.max)),
      over33: mean(taken.map(s => s.over33)),
      over50: mean(taken.map(s => s.over50)),
      measureCalls: mean(taken.map(s => s.measureCalls)),
      dispatches: mean(taken.map(s => s.dispatches)),
      nodesAfter: mean(taken.map(s => s.nodesAfter)),
      blockingMs: mean(taken.map(s => (s.longFrames ? s.longFrames.blockingMs : 0))),
      longFrames: mean(taken.map(s => (s.longFrames ? s.longFrames.count : 0))),
      /* The document's geometry must survive the arm, or the arm is not a candidate. */
      geometry: taken[taken.length - 1] ? taken[taken.length - 1].geometryAfter : null,
      applied: taken[taken.length - 1] ? taken[taken.length - 1].applied : null,
    };
  }

  return {
    document: view.state.doc.lines + ' lines',
    steps: options.steps,
    deltaY: options.deltaY,
    cycles,
    arms,
    samples,
    byArm,
    /* The control's own spread is the noise floor: any arm inside it has not been measured. */
    control: byArm.control ?? null,
  };
}
/*
 * A gesture is defined by the **distance it travels**, not by its step count.
 *
 * Every arm must move the document the same amount or the comparison measures how far each
 * one scrolled: at a fixed step count, the arm that stutters less covers more ground and
 * therefore reveals more mathematics, which makes the smoother arm look worse. Early runs
 * here compared 43 186 px against 102 136 px worth of reveal for that reason.
 *
 * `__DELTAY` is the wheel step — 100 is a real mouse wheel — and `__DISTANCE` is how far the
 * gesture goes; steps are derived. The synthetic `WheelEvent` path is what `probe-scroll.mjs`
 * has always used, so a reading here is comparable with every scroll number in
 * `ARCHITECTURE.md` §3.33–§3.37.
 */
const deltaY = Number(globalThis.__DELTAY || 100);
const distance = Number(globalThis.__DISTANCE || 24000);
return compositorProbe({
  deltaY,
  steps: Math.max(1, Math.round(distance / deltaY)),
  cycles: Number(globalThis.__CYCLES || 3),
  startLine: Number(globalThis.__STARTLINE || 0),
  arms:
    Array.isArray(globalThis.__ARMS) && globalThis.__ARMS.length
      ? globalThis.__ARMS
      : ['control', 'strict', 'layout', 'layoutPaint', 'layoutPaintStyle', 'paint'],
});