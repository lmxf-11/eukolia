/*
 * One gesture, three segments, alternating configuration — the design that cannot drift.
 *
 * Every scroll measurement tried in this session was confounded by the same thing, and the
 * probe's own numbers said so each time: scrolling reveals mathematics, revealing it mounts
 * widgets, mounting them changes the document's height (1 234 865 → 1 307 616 px across four
 * gestures), and whoever runs next is measured against a document the previous run changed.
 * Warm-up alone moved a repeat of an identical configuration from p50 53.8 to 7.9 ms.
 *
 * The confound cannot be removed by warming up, because the document keeps growing as the
 * scroll advances. So this removes it by construction: **one continuous gesture**, long
 * enough to be measured in segments, with the configuration switched at segment boundaries.
 * There is no "next run" — the document is swept once, and the arms are three slices of the
 * same sweep. Whatever the document does while it is being swept, it does to all three.
 *
 * The sequence is A, B, A and the two A segments are the control: if they agree, the sweep
 * was steady enough for the B segment between them to mean something, and the report prints
 * that comparison rather than leaving the reader to trust it.
 *
 *   A  `animated` — `scrolling.smooth` on: the shell calls `preventDefault()` and glides
 *   B  `native`   — the notch applied directly, which is what the compositor's own scroll is
 *   A  `animated` — again
 *
 * Every segment covers the same distance, at the same notch size, so the only difference is
 * who moves the offset.
 */
async function abaProbe(options) {
  const view = window.__cmView;
  if (!view) throw new Error('no window.__cmView');
  const scroller = view.scrollDOM;
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const raf = () => new Promise(r => requestAnimationFrame(r));

  const setSmooth = value => {
    if (value === undefined) delete globalThis.__eukoliaSmoothScroll;
    else globalThis.__eukoliaSmoothScroll = value;
  };
  const savedBehavior = scroller.style.scrollBehavior;
  scroller.style.scrollBehavior = 'auto';

  const longFrames = [];
  let observing = false;
  const observer = PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
    ? new PerformanceObserver(list => {
        if (!observing) return;
        for (const entry of list.getEntries()) {
          longFrames.push({
            duration: entry.duration,
            blocking: entry.blockingDuration ?? 0,
            script: entry.scripts.reduce((n, s) => n + s.duration, 0),
          });
        }
      })
    : null;

  /* Where the sweep starts: far enough in that the preamble is behind us. */
  const maxOffset = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const startTop = Math.min(options.anchor, maxOffset);
  scroller.scrollTop = startTop;
  await settle(1500);

  const segment = async (arm, mode, steps, notch) => {
    setSmooth(mode === 'animated');
    /* The glide from the previous segment must land before this one is timed. */
    await settle(mode === 'animated' ? 300 : 120);
    observing = true;
    const from = scroller.scrollTop;
    const intervals = [];
    const trace = [];
    let last = performance.now();
    for (let step = 0; step < steps; step += 1) {
      const before = scroller.scrollTop;
      if (mode === 'animated') {
        scroller.dispatchEvent(
          new WheelEvent('wheel', { deltaY: notch, deltaMode: 0, bubbles: true, cancelable: true })
        );
      } else {
        scroller.scrollTop = Math.min(
          scroller.scrollHeight - scroller.clientHeight,
          scroller.scrollTop + notch
        );
      }
      const afterWrite = scroller.scrollTop;
      await raf();
      /* After a frame: what survived. A value that snaps back means something else owns it. */
      const afterFrame = scroller.scrollTop;
      if (step < 4) trace.push({ step, before, afterWrite, afterFrame });
      const now = performance.now();
      intervals.push(now - last);
      last = now;
    }
    await settle(mode === 'animated' ? 300 : 60);
    observing = false;
    if (observer) await settle(120);
    const to = scroller.scrollTop;
    intervals.shift();
    const sorted = [...intervals].sort((a, b) => a - b);
    const at = q =>
      Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10;
    const long = longFrames.slice();
    longFrames.length = 0;
    return {
      arm,
      mode,
      p50: at(0.5),
      p90: at(0.9),
      max: Math.round(sorted[sorted.length - 1] * 10) / 10,
      frames: intervals.length,
      over17: intervals.filter(v => v > 17.5).length,
      over33: intervals.filter(v => v > 33.4).length,
      over50: intervals.filter(v => v > 50).length,
      travelled: Math.round(to - from),
      trace,
      longFrames: long.length,
      blockingMs: Math.round(long.reduce((n, f) => n + f.blocking, 0) * 10) / 10,
      scriptMs: Math.round(long.reduce((n, f) => n + f.script, 0) * 10) / 10,
      worstLongFrame: long.length
        ? Math.round(Math.max(...long.map(f => f.duration)) * 10) / 10
        : null,
    };
  };

  const arms = ['animated', 'native', 'animated'];
  const modes = ['animated', 'native', 'animated'];
  const runs = [];
  for (let round = 0; round < options.rounds; round += 1) {
    for (let i = 0; i < arms.length; i += 1) {
      const reading = await segment(arms[i], modes[i], options.steps, options.notch);
      reading.round = round;
      runs.push(reading);
    }
  }
  setSmooth(undefined);
  scroller.style.scrollBehavior = savedBehavior;
  scroller.scrollTop = startTop;

  const meanOf = (rows, key) =>
    rows.length
      ? Math.round((rows.reduce((n, r) => n + (r[key] ?? 0), 0) / rows.length) * 10) / 10
      : null;
  const first = runs.filter(r => r.arm === 'animated' && r.mode === 'animated');
  const mid = runs.filter(r => r.arm === 'native');
  const last = runs.filter(r => r.arm === 'animated' && r.mode === 'animated');

  /*
   * The control comparison is the honest summary: A is measured twice in every round, so the
   * gap between the first and last A is what this design can resolve. If B's gap from A is
   * inside it, nothing has been established.
   */
  const aMean = meanOf(first.concat(last), 'p50');
  const bMean = meanOf(mid, 'p50');
  return {
    document: view.state.doc.lines + ' lines',
    notch: options.notch,
    stepsPerSegment: options.steps,
    rounds: options.rounds,
    runs,
    summary: {
      animatedP50: aMean,
      nativeP50: bMean,
      differenceMs: aMean !== null && bMean !== null ? Math.round((aMean - bMean) * 10) / 10 : null,
      animatedP90: meanOf(first.concat(last), 'p90'),
      nativeP90: meanOf(mid, 'p90'),
      controlSpreadP50: (() => {
        const a = first.map(r => r.p50);
        const b = last.map(r => r.p50);
        if (!a.length || !b.length) return null;
        const pairs = a.map((v, i) => Math.abs(v - (b[i] ?? v)));
        return Math.round((pairs.reduce((n, v) => n + v, 0) / pairs.length) * 10) / 10;
      })(),
      note: 'A-B-A in one continuous sweep; controlSpreadP50 is the gap between the two identical A segments',
    },
  };
}
return abaProbe({
  notch: Number(globalThis.__NOTCH || 120),
  steps: Number(globalThis.__STEPS || 45),
  rounds: Number(globalThis.__ROUNDS || 3),
  anchor: Number(globalThis.__ANCHOR || 250000),
});
