/*
 * Does the shell's own smooth-wheel animation cost frames, or save them?
 *
 * **This is the measurement every scroll number in this repository was missing.** The whole
 * shell installs one non-passive `wheel` listener at the window (`core/smoothScroll.ts`,
 * `installSmoothWheelScrolling`), calls `preventDefault()` on every mouse notch, and glides
 * the offset itself from a `requestAnimationFrame` loop — enabled by default
 * (`scrolling.smooth: true`, 180 ms). `probe-scroll.mjs` dispatches a synthetic
 * `WheelEvent`, deliberately, because that is how a scroll is driven in an automated run:
 * a synthetic event hits the same handler. So every scroll measurement in
 * `ARCHITECTURE.md` §3.33–§3.37 measured **the JavaScript animation**, and the sentence
 * those sections keep repeating — "`script 0 ms` in every long frame, so it is style, layout
 * and paint and not our code" — is what that looks like when the scroll is driven by a
 * scripted `scrollTop` write rather than by the compositor.
 *
 * Two arms, interleaved with a control for ordering, over the same distance:
 *
 *   animated  `scrolling.smooth` on — the shipped default. `__eukoliaSmoothScroll = true`.
 *   native    `scrolling.smooth` off — a per-frame `scrollTop` step, every notch honoured,
 *             which is what the platform's own scrolling amounts to and what the compositor
 *             can scroll without asking this thread.
 *   control   the animated arm again, so drift and warm-up land on all three.
 *
 * The switch is read live (`smoothScrollingEnabled` reads the global on every event), so the
 * arms are one build and the flag is the only difference between them.
 *
 * A note on what each arm can and cannot show. A **synthetic** `WheelEvent` never scrolls
 * anything by itself — untrusted events have no default action — so the "native" arm steps
 * `scrollTop` directly at the same distance per step. That is a faithful model of what the
 * compositor does with a wheel notch (move the offset, do not run JavaScript), but it is a
 * model: it cannot show that the browser's own asynchronous scrolling is smoother than a
 * `scrollTop` write. It can show whether the animation costs frames and input responsiveness,
 * which is the question.
 *
 * Every arm travels the same distance, because an arm that stutters covers less ground and
 * therefore reveals less, making a janky arm look cheap.
 */
async function smoothScrollProbe(options) {
  const view = window.__cmView;
  if (!view) throw new Error('no window.__cmView');
  const scroller = view.scrollDOM;
  const settle = ms => new Promise(r => setTimeout(r, ms));
  const raf = () => new Promise(r => requestAnimationFrame(r));

  const SIZER = scroller.firstElementChild;
  const savedScrollBehavior = scroller.style.scrollBehavior;
  /*
   * The switch is deleted rather than set to `undefined`, so the gate in
   * `smoothScrollingEnabled` sees no override at all and the setting is back in charge —
   * leaving the application as it was found is part of the measurement being honest about
   * what it changed.
   */
  const setSmooth = value => {
    if (value === undefined) delete globalThis.__eukoliaSmoothScroll;
    else globalThis.__eukoliaSmoothScroll = value;
  };

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

  const originalDispatch = view.dispatch.bind(view);
  let dispatches = 0;
  view.dispatch = function (...args) {
    dispatches += 1;
    return originalDispatch(...args);
  };
  const originalMeasure = view.measure.bind(view);
  let measureCalls = 0;
  view.measure = function (...args) {
    measureCalls += 1;
    return originalMeasure(...args);
  };

  /*
   * A gesture: both arms travel from `startTop` to **the same target offset**, at the same
   * step size, one step per frame. Then both return.
   *
   * Every earlier version of this probe compared arms that travelled *different distances*,
   * and the numbers said so: `travelled 4725` against `wanted 7200` for the stepped arm
   * against `7340` for the animated one. An arm that reveals less mathematics mounts fewer
   * widgets and renders less, so falling short made it look cheap. A scroll comparison is
   * only a comparison if both arms arrive at the same place.
   *
   * The return leg is the other half of that, and the reason is the same: scrolling reveals
   * ground that has never been rendered, and rendering it changes the document for whoever
   * runs next. Returning means every arm meets the ground in the state the previous arm left
   * it, so warm-up and reveal land on all of them equally.
   *
   * `scroll-behavior` is forced to `auto` for the duration, because assigning `scrollTop` on
   * an element with smooth behaviour asks the browser to animate — a second animator writing
   * the same offset frame by frame against whichever one is under test.
   */
  const gesture = async (label, mode, steps, stepSize, target) => {
    setSmooth(mode === 'animated');
    scroller.style.scrollBehavior = 'auto';
    scroller.scrollTop = startTop;
    await raf();
    await settle(250);
    dispatches = 0;
    measureCalls = 0;
    longFrames.length = 0;
    observing = true;

    const intervals = [];
    let last = performance.now();
    for (let step = 0; step < steps; step += 1) {
      /*
       * A **fixed notch per frame**, which is what a mouse produces and what the previous
       * version got wrong: it sized the notch as `wanted - scrollTop`, so once the handler
       * had moved the offset the next notch was computed as zero and the gesture stopped
       * dead. 240 wheel events over 60 frames read `travelled 90` and `0 frames over 33 ms`
       * — the smoothest scroll ever recorded here, and it had not moved.
       */
      const remaining = target - scroller.scrollTop;
      if (remaining <= 0) break;
      if (mode === 'animated') {
        scroller.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: stepSize,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
          })
        );
      } else {
        scroller.scrollTop = Math.min(target, scroller.scrollTop + stepSize);
      }
      await raf();
      const now = performance.now();
      intervals.push(now - last);
      last = now;
    }
    /*
     * The animated arm's glide is still running when the notches stop (180 ms of exponential
     * approach). Let it land before anything is read, or the next arm starts mid-glide and
     * the frame it inherits is charged to it.
     */
    await settle(mode === 'animated' ? 260 : 0);
    const forwardTop = scroller.scrollTop;
    const measuredDispatches = dispatches;
    const measuredMeasures = measureCalls;
    const measuredLong = longFrames.slice();
    observing = false;

    scroller.scrollTop = startTop;
    await raf();
    await settle(250);

    intervals.shift();
    const sorted = [...intervals].sort((a, b) => a - b);
    const at = q => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10;
    return {
      label,
      mode,
      p50: at(0.5),
      p90: at(0.9),
      p99: at(0.99),
      max: Math.round(sorted[sorted.length - 1] * 10) / 10,
      over17: intervals.filter(v => v > 17.5).length,
      over33: intervals.filter(v => v > 33.4).length,
      over50: intervals.filter(v => v > 50).length,
      frames: intervals.length,
      wanted: Math.round(target - startTop),
      travelled: Math.round(forwardTop - startTop),
      dispatches: measuredDispatches,
      measureCalls: measuredMeasures,
      longFrames: measuredLong.length
        ? {
            count: measuredLong.length,
            worstMs: Math.round(Math.max(...measuredLong.map(f => f.duration)) * 10) / 10,
            blockingMs: Math.round(measuredLong.reduce((n, f) => n + f.blocking, 0) * 10) / 10,
            scriptMs: Math.round(measuredLong.reduce((n, f) => n + f.script, 0) * 10) / 10,
          }
        : null,
    };
  };

  if (options.startLine > 0) {
    const pos = view.state.doc.line(Math.min(options.startLine, view.state.doc.lines)).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: view.constructor.scrollIntoView(pos, { y: 'start' }),
    });
    await settle(1500);
  }
  const startTop = scroller.scrollTop;
  /*
   * One target, used by every arm: the distance is bounded by what the document can actually
   * scroll, so no arm is clamped short and `travelled` matching `wanted` is checkable in the
   * report rather than assumed.
   */
  const maxOffset = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const target = Math.min(startTop + options.distance, maxOffset);
  const stepSize = options.deltaY;
  const steps = Math.max(1, Math.ceil((target - startTop) / stepSize));

  const samples = [];
  const cycles = options.cycles;
  /*
   * The order the arms run in, and it is deliberately not one block per arm: the whole
   * sequence is `animated, native, control` repeated, so drift and warm-up land on all
   * three. `control` *is* the animated arm — the same configuration measured twice — which
   * is what makes the gap between them the noise floor rather than a result.
   */
  const plan = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) plan.push('animated', 'native', 'control');
  for (let i = 0; i < plan.length; i += 1) {
    const arm = plan[i];
    const cycle = Math.floor(i / 3);
    const reading = await gesture(
      `${arm} #${cycle}`,
      arm === 'native' ? 'native' : 'animated',
      steps,
      stepSize,
      target
    );
    reading.arm = arm;
    reading.cycle = cycle;
    samples.push(reading);
    if (observer) await settle(150);
  }
  observing = false;
  if (observer) observer.disconnect();
  view.dispatch = originalDispatch;
  view.measure = originalMeasure;
  setSmooth(undefined);
  scroller.style.scrollBehavior = savedScrollBehavior;
  scroller.scrollTop = startTop;
  const mean = values =>
    values.length ? Math.round((values.reduce((n, v) => n + v, 0) / values.length) * 10) / 10 : 0;
  const byArm = {};
  for (const arm of ['animated', 'native', 'control']) {
    const taken = samples.filter(s => s.arm === arm);
    if (!taken.length) continue;
    byArm[arm] = {
      runs: taken.length,
      p50: mean(taken.map(s => s.p50)),
      p90: mean(taken.map(s => s.p90)),
      p99: mean(taken.map(s => s.p99)),
      max: mean(taken.map(s => s.max)),
      over17: mean(taken.map(s => s.over17)),
      over33: mean(taken.map(s => s.over33)),
      over50: mean(taken.map(s => s.over50)),
      travelled: mean(taken.map(s => s.travelled)),
      wanted: taken[taken.length - 1] ? taken[taken.length - 1].wanted : null,
      dispatches: mean(taken.map(s => s.dispatches)),
      measureCalls: mean(taken.map(s => s.measureCalls)),
      blockingMs: mean(taken.map(s => (s.longFrames ? s.longFrames.blockingMs : 0))),
      longFrames: mean(taken.map(s => (s.longFrames ? s.longFrames.count : 0))),
    };
  }
  /*
   * The control is the animated arm by construction, so the gap between them is the noise
   * floor — the same reasoning §3.33.1 used for its third pass. A difference between
   * `animated` and `native` that is inside this gap has not been measured.
   */
  const noiseFloor =
    byArm.control && byArm.animated
      ? {
          p50: Math.round(Math.abs(byArm.animated.p50 - byArm.control.p50) * 10) / 10,
          p90: Math.round(Math.abs(byArm.animated.p90 - byArm.control.p90) * 10) / 10,
          note: 'control is the animated arm repeated; this is the spread of two identical configurations',
        }
      : null;

  return {
    document: view.state.doc.lines + ' lines',
    steps,
    stepSize,
    wanted: Math.round(target - startTop),
    cycles,
    smoothSetting: 'scrolling.smooth (default true); toggled live through __eukoliaSmoothScroll',
    samples,
    byArm,
    noiseFloor,
  };
}
return smoothScrollProbe({
  deltaY: Number(globalThis.__DELTAY || 120),
  distance: Number(globalThis.__DISTANCE || 7200),
  cycles: Number(globalThis.__CYCLES || 4),
  startLine: Number(globalThis.__STARTLINE || 0),
});
