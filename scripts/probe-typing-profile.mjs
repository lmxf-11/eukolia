/**
 * Profile the Visual Editor's typing path, in the real application.
 *
 * The scroll cost has been measured and is not the SVG: hiding every rendered
 * equation's artwork changes nothing (`scripts/probe-raster.mjs`). So the remaining
 * complaint — "too laggy" — has to be answered by profiling the *other* interaction,
 * and typing in a large document is the one with no explanation yet: measured at
 * 121 ms per character on `cohomology.tex`, of which the decoration rebuild is 5.7 ms.
 * Something else is spending a hundred milliseconds, and a profile names it.
 *
 * The script below has two halves separated by a boundary line. The first warms the
 * editor and types once so nothing in the measured window is a first-time cost; the
 * second is the window `visualProbe.ts` profiles. Everything in it is a keystroke, a
 * caret move, or a measurement — so the profile is a profile of typing.
 *
 * Usage:
 *   npm run build
 *   node scripts/probe-typing-profile.mjs
 *   node scripts/analyse-cpuprofile.mjs .scratch/typing.cpuprofile --top 40
 *
 * `EUKOLIA_PROBE_DOCUMENT` and `EUKOLIA_PROBE_WORKSPACE` as for `probe-visual.mjs`.
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

if (!existsSync(path.join(projectRoot, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing. Run `npm run build` first.')
  process.exit(2)
}

const require = createRequire(import.meta.url)
const electronBinary = (() => {
  try {
    const fromModule = require('electron')
    if (typeof fromModule === 'string' && existsSync(fromModule)) return fromModule
  } catch {
    /* fall through */
  }
  return [
    path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron'),
  ].find(candidate => existsSync(candidate))
})()
if (!electronBinary) {
  console.error('Could not locate the Electron binary.')
  process.exit(7)
}

const documentPath = process.env.EUKOLIA_PROBE_DOCUMENT
const workspace =
  process.env.EUKOLIA_PROBE_WORKSPACE ??
  (documentPath ? path.dirname(documentPath) : null)
if (!documentPath || !existsSync(documentPath)) {
  console.error('Set EUKOLIA_PROBE_DOCUMENT to a .tex file that exists.')
  process.exit(3)
}

const STEPS = Number(process.env.EUKOLIA_PROFILE_STEPS) > 0
  ? Number(process.env.EUKOLIA_PROFILE_STEPS)
  : 40

/*
 * Visual Mode or source mode, decided by the same command channel the menu bar uses.
 *
 * The comparison this exists for: **typing costs something in any editor, and the
 * question is how much of it is Visual Mode.** The same document, the same script, the
 * same 40 keystrokes — once with the widgets mounted and once without — says which
 * half of the cost the visual surface owns, and a CPU profile of each says which
 * functions in it. Without the second reading there is no way to tell a widget path
 * that is slow from a keystroke path that is slow in both modes.
 */
const mode = process.env.EUKOLIA_PROFILE_MODE === 'source' ? 'source' : 'visual'
const profileSuffix = mode === 'source' ? 'source' : 'visual'

/**
 * Where the position sweep types, as fractions of the document.
 *
 * Middle first, then outwards, so a monotone drift in the machine lands on the *sequence* rather
 * than on the trend the sweep is looking for.
 *
 * `EUKOLIA_SWEEP_FRACTIONS` overrides it. The value is interpolated into the injected script:
 * a constant that lives here is not in scope in the page, which is what the first run of this
 * reported as `SWEEP_FRACTIONS is not defined`.
 */
const SWEEP_FRACTIONS = (process.env.EUKOLIA_SWEEP_FRACTIONS ?? '0.5,0.05,0.95,0.25,0.75')
  .split(',')
  .map(Number)
  .filter(value => Number.isFinite(value) && value > 0 && value < 1)

const WARM = `
  const view = window.__cmView;
  const doc = view.state.doc;
  const settle = (ms) => new Promise(r => setTimeout(r, ms));
  const at = Math.floor(doc.length / 2);
  /*
   * Opt in to the render cache's miss log.
   *
   * A miss is only interesting when it should have been a hit, and the reason is almost
   * always the definitions string the mathematics is typeset with. Recording it turns
   * "the cache did not hit" into "the cache did not hit *because the preamble
   * changed*", which is a different bug from "the equation is new".
   */
  window.__eukoliaCacheMisses = [];
  /*
   * The decoration pass's own counters, so a keystroke can be asked how much it *allocates*.
   *
   * The claim under test is that the pass constructs a widget object for every construct in
   * the span on every rebuild, and that the resulting garbage is a measurable part of the
   * ~57 ms of GC per keystroke this file's profile showed on cohomology.tex. A profile says
   * GC happened; it cannot say what was allocated, and the counter can — widgets, ranges,
   * and the time the pass itself took.
   */
  /*
   * Initialised **in place**, field by field, and never replaced.
   *
   * Two ways this went wrong before, both worth keeping written down. Replacing the global with a
   * fresh object leaves the application incrementing the object it captured at startup, so the probe
   * reads zeros while the editor counts into a different map — which is what one real counter and
   * the rest arriving as NaN looked like on the wire. And a partial initialiser leaves every other
   * field undefined, which is the same NaN without the replacement.
   *
   * Only absent fields are filled, so a value the application has already set survives.
   */
  const counter = (globalThis.__eukoliaDecorationProfile =
    globalThis.__eukoliaDecorationProfile || {});
  for (const field of ['rebuilds', 'ms', 'preambleMs', 'rangeMs', 'ranges', 'widgets', 'setMs', 'skips']) {
    if (typeof counter[field] !== 'number') counter[field] = 0;
  }
  view.dispatch({ selection: { anchor: at }, effects: view.constructor.scrollIntoView(at) });
  await settle(1500);
  // One typing burst so the parse, the decoration build and the render cache are all
  // warm before the profiled window: what is being measured is steady-state typing.
  for (let step = 0; step < ${STEPS}; step += 1) {
    view.dispatch({
      changes: { from: at + step, insert: 'w' },
      selection: { anchor: at + step + 1 },
      userEvent: 'input.type',
    });
    await new Promise(r => requestAnimationFrame(r));
  }
  await settle(2500);
  return { warm: true, at, lines: doc.lines };
`

const MEASURED = `
  const view = window.__cmView;
  const doc = view.state.doc;
  const settle = (ms) => new Promise(r => setTimeout(r, ms));
  const at = Math.floor(doc.length / 3);

  const burst = async (label, count, position) => {
    const before = {
      entries: window.__eukoliaRenderStats ? window.__eukoliaRenderStats().entries : null,
      hits: window.__eukoliaRenderStats ? window.__eukoliaRenderStats().hits : null,
    };
    const decoration = window.__eukoliaDecorationProfile;
    /*
     * Every counter the burst reports on must be captured **here as well as after**, or the
     * difference is a subtraction of two undefineds and the report prints null. The macro-preamble
     * counter was added to the subtraction without being added to the capture, which is how a
     * counter the pass has maintained all along went missing from the report and looked like a
     * missing instrument.
     */
    const snapshot = () => decoration
      ? {
          rebuilds: decoration.rebuilds,
          ms: decoration.ms,
          widgets: decoration.widgets,
          ranges: decoration.ranges,
          setMs: decoration.setMs ?? 0,
          preambleMs: decoration.preambleMs ?? 0,
          rangeMs: decoration.rangeMs ?? 0,
        }
      : null;
    const decorationBefore = snapshot();
    const frames = [];
    let last = performance.now();
    const started = last;
    for (let step = 0; step < count; step += 1) {
      view.dispatch({
        changes: { from: position + step, insert: 'q' },
        selection: { anchor: position + step + 1 },
        userEvent: 'input.type',
      });
      await new Promise(r => requestAnimationFrame(() => {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        r();
      }));
    }
    const wall = performance.now() - started;
    const sorted = [...frames].sort((a, b) => a - b);
    const at2 = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10;
    const after = window.__eukoliaRenderStats ? window.__eukoliaRenderStats() : { entries: null, hits: null };
    const decorationAfter = snapshot();
    return {
      label,
      perKeystrokeMs: Math.round((wall / count) * 10) / 10,
      p50: at2(0.5),
      p90: at2(0.9),
      max: Math.round(sorted[sorted.length - 1]),
      typesetCalls: after.hits !== null && before.hits !== null ? after.hits - before.hits : null,
      cacheEntries: after.entries,
      /*
       * What the pass allocated, per keystroke. This is the number that decides whether
       * reusing widget objects is worth its risk: widgets is one object per construct in
       * the span, ranges is the decoration set built from them, and ms is the pass's own
       * time — so a change that cuts allocation can be told from one that only moves time.
       */
      decoration: decorationBefore && decorationAfter
        ? {
            rebuilds: decorationAfter.rebuilds - decorationBefore.rebuilds,
            widgets: decorationAfter.widgets - decorationBefore.widgets,
            ranges: decorationAfter.ranges - decorationBefore.ranges,
            ms: Math.round((decorationAfter.ms - decorationBefore.ms) * 10) / 10,
            setMs: Math.round((decorationAfter.setMs - decorationBefore.setMs) * 10) / 10,
            preambleMs: Math.round((decorationAfter.preambleMs - decorationBefore.preambleMs) * 10) / 10,
            /*
             * The raw snapshots, kept because a difference of two undefineds prints as JSON null on
             * the wire, and null says nothing about which side was missing. Three runs were spent
             * guessing at that; the operands cost nothing to carry.
             */
            rawBefore: decorationBefore,
            rawAfter: decorationAfter,
            perKeystroke: {
              widgets: Math.round(((decorationAfter.widgets - decorationBefore.widgets) / count) * 10) / 10,
              ranges: Math.round(((decorationAfter.ranges - decorationBefore.ranges) / count) * 10) / 10,
              ms: Math.round(((decorationAfter.ms - decorationBefore.ms) / count) * 100) / 100,
              preambleMs:
                Math.round(((decorationAfter.preambleMs - decorationBefore.preambleMs) / count) * 100) / 100,
            },
          }
        : { missing: true, rawBefore: decorationBefore, rawAfter: decorationAfter },
    };
  };

  view.dispatch({ selection: { anchor: at }, effects: view.constructor.scrollIntoView(at) });
  await settle(1200);

  // Profiled ground: typing in the body of the document.
  const prose = await burst('prose', ${STEPS}, at);

  /*
   * The asymmetry, measured properly this time.
   *
   * The two bursts above do **not** compare like with like and cannot: the prose burst types at
   * a third of the way into the document — about offset 173 000 in this chapter — and the maths
   * burst types at the first equation, about offset 861. Different ground, different viewport,
   * different number of rendered equations on screen, so "typing in prose is slower than typing
   * in mathematics" was a comparison between two places and not between two contexts.
   *
   * These two do compare: the same equation, the same viewport, the same ground, with the caret
   * one character *before* the opening delimiter and then one character *inside* it. The only
   * difference is whether the selection is in mathematics, which is what
   * mathCaretAttribute/shouldDecorateMath react to.
   *
   * Three bursts, not two, so the ordering is visible: last-one-wins would otherwise be
   * indistinguishable from "the second configuration is faster".
   */
  const sameGround = (() => {
    /*
     * Its own copy of the text, not the text the maths burst declares further down: that is a
     * const in the same scope and reading it here is a temporal-dead-zone error, which is a
     * mistake worth leaving a note about rather than renaming quietly.
     */
    const scan = doc.toString().slice(0, 400000);
    const match = /\\$[^$]{4,40}\\$/.exec(scan);
    if (!match) return null;
    return { before: Math.max(1, match.index - 2), inside: match.index + 2 };
  })();

  let contextBefore = null;
  let contextInside = null;
  let contextBeforeAgain = null;
  if (sameGround) {
    view.dispatch({ selection: { anchor: sameGround.before }, effects: view.constructor.scrollIntoView(sameGround.before) });
    await settle(1200);
    contextBefore = await burst('same ground, caret in prose', ${STEPS}, sameGround.before);

    view.dispatch({ selection: { anchor: sameGround.inside }, effects: view.constructor.scrollIntoView(sameGround.inside) });
    await settle(1200);
    contextInside = await burst('same ground, caret in mathematics', ${STEPS}, sameGround.inside);

    view.dispatch({ selection: { anchor: sameGround.before }, effects: view.constructor.scrollIntoView(sameGround.before) });
    await settle(1200);
    contextBeforeAgain = await burst('same ground, caret in prose (again)', ${STEPS}, sameGround.before);
  }

  // And a burst with the caret parked inside a mathematical region, which takes a
  // different path: the widget is destroyed, the source is revealed, and the
  // decoration pass rebuilds for the selection.
  const text = doc.toString();
  const mathAt = (() => {
    const match = /\\$[^$]{4,40}\\$/.exec(text.slice(0, 400000));
    return match ? match.index + 2 : at + 5000;
  })();
  view.dispatch({ selection: { anchor: mathAt }, effects: view.constructor.scrollIntoView(mathAt) });
  await settle(1200);
  const math = await burst('inside mathematics', ${STEPS}, mathAt);

  /*
   * The misses the two bursts caused, in order, with the definitions each was for.
   *
   * Read at the end so the report carries the *reason* and not only the count: a run
   * whose misses are all one signature is an equation being rendered repeatedly under
   * definitions that never change (the cache failing), and one whose misses carry many
   * signatures is the definitions changing underneath it (the preamble moving).
   */
  const misses = (window.__eukoliaCacheMisses || []).slice(-80);

  /*
   * The position sweep: the same burst at several offsets into the document.
   *
   * This is the measurement the same-ground result asked for. Typing at offset 861 costs 63 ms a
   * keystroke and typing at offset 173 000 costs 99 ms — **57 % more for the same document, the
   * same mode and the same caret context** — so the variable is *where you are*, and the shape of
   * that curve says what grows with position.
   *
   * A cost that climbs with offset is prefix-linear: the context scan, the walk's starting
   * context, or anything else that reads the document above the caret. A cost that is flat means
   * the two bursts differed for a reason this sweep has not been told about, which is worth
   * knowing before hunting a mechanism that does not exist.
   *
   * The offsets are fractions of the document, and the sweep runs from the middle outwards so
   * that a monotone drift in the machine lands on the sequence rather than on the trend.
   */
  /*
   * The sweep runs only when asked for, and the flag is **interpolated**: a conditional
   * written as plain source would be evaluated in the page, which has no environment.
   *
   * Without this, a CPU profile of "typing" is mostly a profile of the sweep — the first one
   * taken this way was 26 MB and answered a question about 40 keystrokes with 440 of them.
   */
  const withSweep = false;
  const sweep = [];
  if (withSweep) {
  /*
   * Interpolated, not referenced: a constant of the *runner* is not in scope in the page, which is
   * what SWEEP_FRACTIONS is not defined was.
   */
  for (const fraction of ${JSON.stringify(SWEEP_FRACTIONS)}) {
    const offset = Math.min(doc.length - 1, Math.max(1, Math.floor(doc.length * fraction)));
    view.dispatch({ selection: { anchor: offset }, effects: view.constructor.scrollIntoView(offset) });
    await settle(1200);
    const pass = await burst('sweep at ' + Math.round(fraction * 100) + '%', ${STEPS}, offset);
    sweep.push({ fraction, offset, ...pass });
  }
  }

  return {
    prose,
    math,
    warmAt: at,
    mathAt,
    misses,
    /*
     * The position sweep: the same burst at several offsets, so the *shape* of the cost against
     * document position is visible rather than inferred from two points.
     */
    sweep: sweep.map(entry => ({
      fraction: entry.fraction,
      offset: entry.offset,
      perKeystrokeMs: entry.perKeystrokeMs,
      p50: entry.p50,
      p90: entry.p90,
      decorationMs: entry.decoration ? entry.decoration.perKeystroke.ms : null,
      widgets: entry.decoration ? entry.decoration.perKeystroke.widgets : null,
      rebuilds: entry.decoration ? entry.decoration.rebuilds : null,
    })),
    /*
     * The three same-ground bursts, side by side. This is the comparison that answers whether
     * the caret's *context* changes the cost of a keystroke, as opposed to the ground under it.
     */
    sameGround: sameGround
      ? {
          at: sameGround,
          proseBefore: contextBefore,
          insideMath: contextInside,
          proseAgain: contextBeforeAgain,
        }
      : null,
  };
`

/*
 * ## A script that ends in a bare call expression returns `undefined` — the rule
 *
 * This cost most of a session and five wrong hypotheses, and the cause is one line of JavaScript
 * semantics. `visualProbe.ts` injects the script as the body of its own async function:
 *
 *     `(async () => { try { return { __eukoliaProbeOk: true, value: await (async () => { ${text} })() }; ...`
 *
 * so if `text`'s last statement is a call expression whose value is a **promise** — a
 * self-invoking async function, the most natural way to write a probe — then what the wrapper
 * awaits and returns is the promise, and `JSON.stringify` of the resolved value never happens
 * where it is expected. The value comes back as the four characters `undefined`, with no failure
 * recorded, because nothing threw.
 *
 * Measured, one arrangement per run (`.scratch/test-iife-arrangements.mjs`):
 *
 *   | arrangement | result |
 *   | --- | --- |
 *   | `const v = await (async () => {…})(); return v;` | the payload |
 *   | a bare IIFE, nothing else | `undefined` |
 *   | two IIFEs, no return | `undefined` |
 *   | two IIFEs then `return v` | the payload |
 *   | assignment without `await`, returned | the payload |
 *
 * **So: never end an injected script with a call expression.** End it with `return`.**
 *
 * Everything ruled out on the way, kept so it is not re-investigated: it is not the profile
 * boundary (a bare `__EUKOLIA_PROFILE_START__` line is a `ReferenceError` when nothing splits on
 * it, and removing the boundary changes nothing); not a missing `await` in `visualProbe.ts` (all
 * four `evaluate` calls are awaited); not the two halves sharing a scope (they do not — a binding
 * made before the boundary is `not defined` after it, which is a separate, correct behaviour); and
 * not the script's text being malformed by a backtick or a dollar-brace in the runner's own
 * template literal, though that hazard is real and has its own checker,
 * `.scratch/check-template-hazards.mjs`.
 */
/*
 * The injected script is **two self-invoking async bodies plus an explicit `return`**, and the
 * `return` is the part that matters.
 *
 * `visualProbe.ts` puts this text inside its own async function, so a bare `return` here reaches
 * the *wrapper's* top level — which is what makes the value come back, and is the shape every
 * passing case in `.scratch/check-probe-mechanism.mjs` uses. The two bodies are IIFEs because
 * they each `return` a result of their own; as plain bodies their returns would be the wrapper's
 * (a syntax error at top level, and a wrong value otherwise).
 *
/*
 * Four arrangements were tried against the real probe before this one. The conclusion drawn at the
 * time — "only a top-level `return` returns a value" — was **right about the cure and wrong about
 * the cause**: removing the boundary below and keeping the `return` still worked, and keeping the
 * boundary without a `return` still did not. The boundary was never the problem. It was removed
 * once on the strength of that misreading, which silently disabled profiling (`at` becomes -1, so
 * `visualProbe.ts` never takes the profiled branch), and that is worth recording as the cost of
 * fixing a symptom before reading the rule.
 *
 * The boundary stays. Everything before it warms the editor and everything after it is the window
 * the profile describes, so the warm-up burst is not in the sample — which matters, because the
 * first burst pays for a cold parse, a cold render cache and a cold decoration field.
 */
const script = `
const __warm = await (async () => {
${WARM}
})()
;
__EUKOLIA_PROFILE_START__
const __measured = await (async () => {
${MEASURED}
})()
;
return __measured
`

/*
 * Write the assembled script and stop, so the halves can be run on their own.
 *
 * Reading the runner to work out what it injects is how three attempts at this bug went
 * wrong; asking it for the text removes the reconstruction.
 */
if (process.env.EUKOLIA_TYPING_DUMP === '1') {
  writeFileSync(path.join(projectRoot, '.scratch', 'typing-script.txt'), script)
  console.log('wrote .scratch/typing-script.txt (' + script.length + ' chars)')
  process.exit(0)
}

const profilePath = path.join(projectRoot, '.scratch', `typing-${profileSuffix}.cpuprofile`)
rmSync(profilePath, { force: true })
const reportPath = path.join(projectRoot, `typing-profile-${profileSuffix}.json`)
rmSync(reportPath, { force: true })

const child = spawn(electronBinary, ['.'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    EUKOLIA_CARET_PROBE: '1',
    EUKOLIA_SMOKE_WORKSPACE: workspace,
    EUKOLIA_PROBE_DOCUMENT: documentPath,
    EUKOLIA_RASTER_SCRIPT: script,
    EUKOLIA_VISUAL_CPU_PROFILE_PATH: profilePath,
    EUKOLIA_PROBE_EVALUATE_MS: '300000',
    EUKOLIA_PROFILE_SWITCH_MODE: mode,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.on('data', chunk => {
  stdout += chunk.toString()
})
child.stderr.on('data', chunk => {
  stderr += chunk.toString()
})

const timeoutMs = Number(process.env.EUKOLIA_PROBE_TIMEOUT_MS) > 0
  ? Number(process.env.EUKOLIA_PROBE_TIMEOUT_MS)
  : 900_000
const timer = setTimeout(() => {
  console.error(`Probe did not finish within ${timeoutMs / 1000}s; killing it.`)
  child.kill()
}, timeoutMs)

child.on('exit', code => {
  clearTimeout(timer)
  const marker = stdout.indexOf('__EUKOLIA_RASTER_PROBE__')
  if (marker < 0) {
    console.error(`Probe produced no payload (exit ${code}).`)
    if (stdout.trim()) console.error('stdout:\n' + stdout.slice(-3000))
    if (stderr.trim()) console.error('stderr:\n' + stderr.slice(-3000))
    process.exit(1)
  }
  if (stdout.slice(marker + 24).split(String.fromCharCode(10))[0] === 'undefined') {
    console.error(
      'The injected script returned undefined. A script that ends in a call expression does ' +
        'that: see the note at the top of the script assembly in this file.'
    )
    process.exit(1)
  }
  const payload = JSON.parse(
    stdout.slice(marker + '__EUKOLIA_RASTER_PROBE__'.length).split('\n')[0]
  )
  writeFileSync(reportPath, JSON.stringify(payload, null, 2))
  /*
   * The allocation line, printed rather than buried in the JSON.
   *
   * `widgets` is one object per construct in the span, rebuilt for every keystroke — the
   * claim that decides whether reusing widget objects is worth its risk. A change that cuts
   * allocation can then be told from one that only moves time.
   */
  for (const burst of [payload.prose, payload.math]) {
    if (!burst || !burst.decoration) continue
    const work = burst.decoration
    console.log(
      `\n${burst.label}: the widget pass per keystroke — ` +
        `${work.perKeystroke.widgets} widget objects, ${work.perKeystroke.ranges} ranges, ` +
        `${work.perKeystroke.ms} ms  (${work.rebuilds} rebuilds, ${Math.round(work.setMs)} ms in Decoration.set, ` +
        `${Math.round(work.preambleMs ?? 0)} ms composing the macro preamble)`
    )
  }
  if (payload.sweep && payload.sweep.length > 0) {
    console.log(String.fromCharCode(10) + 'SWEEP: the same burst at different document positions')
    console.log('  offset    %      ms/keystroke    p50    p90   widget pass')
    for (const row of payload.sweep) {
      console.log(
        '  ' + String(row.offset).padStart(7) +
        String(Math.round(row.fraction * 100)).padStart(6) +
        String(row.perKeystrokeMs).padStart(14) +
        String(row.p50).padStart(8) +
        String(row.p90).padStart(7) +
        String(row.decorationMs === null ? '-' : row.decorationMs).padStart(14)
      )
    }
  }
  console.log(JSON.stringify(payload, null, 2))
  console.log(
    `\nprofile: ${existsSync(profilePath) ? profilePath : 'NOT WRITTEN'}` +
      `\nanalyse: node scripts/analyse-cpuprofile.mjs ${profilePath} --top 40`
  )
  process.exit(0)
})
