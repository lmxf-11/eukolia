/*
 * How long after a wheel notch does the page actually move?
 *
 * **The number this project has never taken.** Every scroll measurement in
 * `ARCHITECTURE.md` §3.33–§3.37 reports frame intervals, and frame interval is the wrong
 * quantity for "laggy": a scroll can average 16 ms a frame and still feel dead if nothing
 * moves for a tenth of a second after the wheel turns. What a reader feels as lag is
 * `first movement − wheel event`, and what they feel as jank is the *distribution* of frame
 * intervals after that.
 *
 * It matters here because of a specific design decision. `core/smoothScroll.ts` installs a
 * **non-passive** `wheel` listener on the window and calls `preventDefault()` on every mouse
 * notch, then glides the offset from a `requestAnimationFrame` loop (180 ms by default,
 * `scrolling.smooth: true`). A non-passive listener is a promise to the browser that the
 * event may be cancelled, so the browser must run the handler before it may scroll — and the
 * glide is an exponential approach, so the first frame covers only a fraction of the notch.
 * A trackpad is exempted by default (`scrolling.trackpadMomentum: true`), which is the tell:
 * *the same wheel does two different things depending on the device.*
 *
 * Three arms, one build, toggled through `__eukoliaSmoothScroll`:
 *
 *   animated  the shipped default — `preventDefault`, then glide
 *   native    the notch applied directly, one frame later, at full distance
 *   control   the animated arm again, for the order/drift
 *
 * Per notch it records: the delay until the offset first changed, how much of the notch had
 * been covered at that moment and 100 ms later, and the frame interval. A `settle` between
 * notches keeps each measurement a single isolated notch rather than a gesture, because the
 * quantity being measured is per-notch response.
 */
async function latencyProbe(options) {
  const view = window.__cmView;
  if (!view) throw new Error('no window.__cmView');
  const scroller = view.scrollDOM;
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const raf = () => new Promise(r => requestAnimationFrame(r));

  const setSmooth = value => {
    if (value === undefined) delete globalThis.__eukoliaSmoothScroll;
    else globalThis.__eukoliaSmoothScroll = value;
  };

  /*
   * Measured from *inside* the page: `performance.now()` at dispatch, then a
   * `requestAnimationFrame` loop that polls `scrollTop` until it differs. One frame of
   * granularity is the honest resolution — an offset cannot change between frames.
   */
  const measureNotch = async (mode, deltaY) => {
    const before = scroller.scrollTop;
    const dispatchedAt = performance.now();
    if (mode === 'animated') {
      scroller.dispatchEvent(
        new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true })
      );
    } else {
      scroller.scrollTop = before + deltaY;
    }
    const movedAtFrame = [];
    let firstMoveAt = null;
    let coveredAtFirstMove = null;
    let at100 = null;
    let frames = 0;
    const startedAt = performance.now();
    while (performance.now() - startedAt < options.window && frames < 40) {
      await raf();
      frames += 1;
      const now = performance.now();
      const delta = scroller.scrollTop - before;
      movedAtFrame.push(delta);
      if (firstMoveAt === null && delta !== 0) {
        firstMoveAt = now - dispatchedAt;
        coveredAtFirstMove = delta;
      }
      if (at100 === null && now - dispatchedAt >= 100) at100 = delta;
    }
    return {
      latency: firstMoveAt === null ? null : Math.round(firstMoveAt * 10) / 10,
      coveredAtFirstMove,
      coveredAt100: at100,
      finalCovered: Math.round((scroller.scrollTop - before) * 10) / 10,
      deltaY,
      framesToSettle: frames,
    };
  };

  const samples = [];
  const plan = [];
  for (let cycle = 0; cycle < options.cycles; cycle += 1) plan.push('animated', 'native', 'control');
  for (const arm of plan) {
    setSmooth(arm === 'native' ? false : true);
    /* Back to a fixed ground so every arm meets the same content and the same offset. */
    scroller.style.scrollBehavior = 'auto';
    scroller.scrollTop = options.anchor;
    await raf();
    await settle(400);
    for (let i = 0; i < options.notches; i += 1) {
      const reading = await measureNotch(arm === 'native' ? 'native' : 'animated', options.deltaY);
      reading.arm = arm;
      samples.push(reading);
      /*
       * The glide has to finish before the next notch, or notch 2 is measured against an
       * animation still running from notch 1 — which is a real thing a user does, but it is
       * a different question and it would swamp the per-notch number.
       */
      await settle(options.setttleBetween ?? 350);
      scroller.scrollTop = options.anchor;
      await raf();
    }
  }
  setSmooth(undefined);
  scroller.scrollTop = options.anchor;

  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return null;
    return sorted[Math.floor(sorted.length / 2)];
  };
  const byArm = {};
  for (const arm of ['animated', 'native', 'control']) {
    const taken = samples.filter(s => s.arm === arm);
    if (!taken.length) continue;
    const latencies = taken.map(s => s.latency).filter(v => typeof v === 'number');
    const covered = taken.map(s => s.coveredAtFirstMove).filter(v => typeof v === 'number');
    byArm[arm] = {
      notches: taken.length,
      medianLatency: median(latencies),
      worstLatency: latencies.length ? Math.max(...latencies) : null,
      medianCoveredAtFirstMove: median(covered),
      medianCoveredAt100: median(taken.map(s => s.coveredAt100 ?? 0)),
      medianFinalCovered: median(taken.map(s => s.finalCovered)),
      deltaY: options.deltaY,
    };
  }
  return {
    document: view.state.doc.lines + ' lines',
    deltaY: options.deltaY,
    setting: 'scrolling.smooth (default true), toggled live through __eukoliaSmoothScroll',
    samples,
    byArm,
    /*
     * The fraction of the notch the shipped glide has covered by its first frame is the
     * direct measure of why it feels slower: the browser's own scrolling moves the whole
     * notch at once, and an exponential approach moves `1 - exp(-t/tau)` of it.
     */
    reading: 'medianLatency is ms from the wheel notch to the first frame the offset changed',
  };
}
return latencyProbe({
  deltaY: Number(globalThis.__DELTAY || 120),
  notches: Number(globalThis.__NOTCHES || 8),
  cycles: Number(globalThis.__CYCLES || 3),
  anchor: Number(globalThis.__ANCHOR || 0),
  window: 1200,
});
