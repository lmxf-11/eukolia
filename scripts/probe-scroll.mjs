/**
 * Measure what a scroll *costs* in the real application, on a real chapter.
 *
 * The report is "the scroll becomes extremely stuttery and laggy in Visual Mode for
 * large files, especially those with dense SVG content". Frame time alone cannot say
 * why: many small transactions and one huge layout produce the same average and want
 * opposite fixes. So this reports, per wheel gesture, both the frame interval
 * distribution and what the editor did inside it — transactions (attributed to a
 * caller), widget builds, widget re-renders, decoration rebuilds, MathJax renders.
 *
 * The injected script is `scripts/lib/scroll-probe.client.js`, a real file: this text
 * goes through `webContents.executeJavaScript`, so as a template literal in here every
 * backtick inside it would break the outer expression and report the error on an
 * unrelated line of this file.
 *
 * Usage:
 *   npm run build
 *   node scripts/probe-scroll.mjs
 *   EUKOLIA_PROBE_DOCUMENT='…\\algebra.tex' node scripts/probe-scroll.mjs
 *
 * `EUKOLIA_SCROLL_STEPS` (default 60), `EUKOLIA_SCROLL_PASSES` (default 4),
 * `EUKOLIA_SCROLL_DELTA` (default 120), `EUKOLIA_PROFILE_MODE=source` to measure the
 * other surface.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const documentPath =
  process.env.EUKOLIA_PROBE_DOCUMENT ??
  'D:\\LaTeX projects\\The Stacks project\\stacks-project-master\\algebra.tex'
const workspace =
  process.env.EUKOLIA_PROBE_WORKSPACE ?? (documentPath ? path.dirname(documentPath) : null)
if (!documentPath || !existsSync(documentPath)) {
  console.error(`Set EUKOLIA_PROBE_DOCUMENT to a .tex file that exists (looked for ${documentPath}).`)
  process.exit(3)
}

const options = {
  steps: Number(process.env.EUKOLIA_SCROLL_STEPS) > 0 ? Number(process.env.EUKOLIA_SCROLL_STEPS) : 60,
  passes: Number(process.env.EUKOLIA_SCROLL_PASSES) > 0 ? Number(process.env.EUKOLIA_SCROLL_PASSES) : 4,
  deltaY: Number(process.env.EUKOLIA_SCROLL_DELTA) > 0 ? Number(process.env.EUKOLIA_SCROLL_DELTA) : 120,
  settleMs: Number(process.env.EUKOLIA_SCROLL_SETTLE_MS) > 0 ? Number(process.env.EUKOLIA_SCROLL_SETTLE_MS) : 600,
  /*
   * Measure the upper bound as well: the same gesture with the rendered mathematics
   * taken out of the DOM. It is the one experiment that separates "the mathematics is
   * expensive to paint" from "the mathematics is expensive to have on screen at all",
   * and it bounds what any technique of drawing it better could win.
   */
  removeMath: process.env.EUKOLIA_SCROLL_MATH_BOUND === '1',
  /*
   * Where the gesture starts, by line. Without it every reading begins at the top of the
   * file — the preamble, which is the cheapest part of a chapter — and two
   * configurations are compared from different places because each warms up where the
   * last one stopped.
   */
  startLine: Number(process.env.EUKOLIA_SCROLL_START_LINE) > 0
    ? Number(process.env.EUKOLIA_SCROLL_START_LINE)
    : 0,
  /*
   * A sweep: the same gesture from each of these lines, in one run, so the readings are
   * directly comparable. `EUKOLIA_SCROLL_SWEEP=0,5000,21000,42000`.
   */
  sweepLines: (process.env.EUKOLIA_SCROLL_SWEEP ?? '')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value > 0),
  /*
   * Passes per sweep position. More than one, because a single pass per position could
   * not tell a change from the noise: repeating an *unchanged* configuration moved p90 by
   * 40 % in both directions.
   */
  /* A/B from one build: turn the widget size reservation off. */
  /* Half-screens of margin the widget pass builds past the viewport; 0 means the default. */
  marginHalves: Number(process.env.EUKOLIA_MARGIN_HALVES) > 0
    ? Number(process.env.EUKOLIA_MARGIN_HALVES)
    : 0,
  noSizeReserve: process.env.EUKOLIA_NO_SIZE_RESERVE === '1',
  sweepPasses: Number(process.env.EUKOLIA_SCROLL_SWEEP_PASSES) > 0
    ? Number(process.env.EUKOLIA_SCROLL_SWEEP_PASSES)
    : 3,
  /*
   * Measure the refresh bound: the same gesture with the per-widget refresh transactions
   * dropped. They are the only thing happening ~90 times per gesture and each runs the
   * whole view update, so if anything in the editor is the stutter it is these.
   */
  noRefresh: process.env.EUKOLIA_SCROLL_REFRESH_BOUND === '1',
}

const label = process.env.EUKOLIA_SCROLL_LABEL ?? path.basename(documentPath).replace(/\.tex$/, '')
const reportPath = path.join(projectRoot, `scroll-probe-${label}.json`)
rmSync(reportPath, { force: true })


const clientSource = readFileSync(path.join(here, 'lib', 'scroll-probe.client.js'), 'utf8')
/*
 * One program, and no CPU profile — deliberately.
 *
 * A profiled script has to be **two separate programs**, because `visualProbe.ts` splits
 * the text on a boundary line and runs each half through its own `executeJavaScript`,
 * and each is its own scope: the second half cannot call a function the first declared,
 * and answers `… is not defined`. (Both halves also have to *parse* on their own, so a
 * boundary inside a function body produces two `SyntaxError`s, which is what an earlier
 * version of this did.)
 *
 * Trying to keep one scope instead — embedding both halves in a single wrapper and
 * starting the sampler from inside the page — deadlocks: the renderer ends up waiting for
 * a message the main process cannot send while it is awaiting the renderer.
 *
 * This probe does not need a profile. It answers "what does a scroll gesture cost" from
 * its own counters plus the browser's own long-animation-frame attribution, which splits
 * a long frame into script, style-and-layout and blocking. When a profile *is* wanted,
 * the shape to copy is `probe-typing-profile.mjs`: two self-contained programs.
 */
const script = `${clientSource}\nreturn scrollProbe(${JSON.stringify(options)});`

if (process.env.EUKOLIA_SCROLL_CHECK === '1') {
  const assembled = path.join(projectRoot, '.scratch', 'scroll-assembled.js')
  writeFileSync(assembled, script)
  console.log(`assembled ${script.length} chars; check with: node --check ${assembled}`)
}

const child = spawn(electronBinary, ['.'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    EUKOLIA_CARET_PROBE: '1',
    EUKOLIA_SMOKE_WORKSPACE: workspace,
    EUKOLIA_PROBE_DOCUMENT: documentPath,
    EUKOLIA_RASTER_SCRIPT: script,
    EUKOLIA_PROFILE_SWITCH_MODE: process.env.EUKOLIA_PROFILE_SWITCH_MODE ?? '',
    /*
     * A trace instead of a profile: it is the only instrument that sees paint, and paint
     * is where the scroll stutter lives. `scripts/analyse-trace.mjs` reduces it.
     */
    EUKOLIA_VISUAL_TRACE_PATH: process.env.EUKOLIA_VISUAL_TRACE_PATH ?? '',
    EUKOLIA_PROBE_EVALUATE_MS: '600000',
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
  for (const line of chunk.toString().split('\n')) {
    if (/Uncaught|SyntaxError|TypeError|ReferenceError/.test(line)) {
      process.stderr.write(`[renderer] ${line}\n`)
    }
  }
})

const timeoutMs =
  Number(process.env.EUKOLIA_PROBE_TIMEOUT_MS) > 0 ? Number(process.env.EUKOLIA_PROBE_TIMEOUT_MS) : 1_800_000
const timer = setTimeout(() => {
  console.error(`Probe did not finish within ${timeoutMs / 1000}s; killing it.`)
  child.kill()
}, timeoutMs)

const num = value => (typeof value === 'number' ? value : Number(value ?? 0))
const mean = values => (values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : 0)

child.on('exit', code => {
  clearTimeout(timer)
  const marker = stdout.indexOf('__EUKOLIA_RASTER_PROBE__')
  if (marker < 0) {
    console.error(`Probe produced no payload (exit ${code}).`)
    if (stdout.trim()) console.error('stdout:\n' + stdout.slice(-3000))
    if (stderr.trim()) console.error('stderr:\n' + stderr.slice(-4000))
    process.exit(1)
  }
  /*
   * `undefined` is a *result*, not a parse failure.
   *
   * The payload is `JSON.stringify(result)`, so an injected script that threw before
   * producing anything prints the four characters `undefined` — and `JSON.parse` then
   * fails with "undefined is not valid JSON", which is a message about the runner and
   * not about the probe. The renderer's own error is in `visual-probe.json`; saying so
   * here is the difference between a five-second diagnosis and the ten minutes this
   * cost the first time.
   */
  const rawPayload = stdout.slice(marker + '__EUKOLIA_RASTER_PROBE__'.length).split('\n')[0]
  if (rawPayload === 'undefined') {
    console.error(
      'Probe produced no result: the injected script threw. The renderer\'s own message is in ' +
        'visual-probe.json (and on stderr if the wrapper caught it).'
    )
    if (stderr.trim()) console.error('stderr:\n' + stderr.slice(-4000))
    process.exit(1)
  }
  const payload = JSON.parse(rawPayload)
  writeFileSync(reportPath, JSON.stringify(payload, null, 2))

  console.log(
    `\n${label}: ${payload.lines} lines, ${payload.chars} chars, surface ${payload.surface}`
  )

  /*
   * The passes are printed one per row rather than summarised, because a scroll
   * measurement reports the order it ran in unless the order is visible: whichever pass
   * runs first meets the most work. The alternating sequence is the control.
   */
  console.log('\n  pass            p50    p90    max   >33ms  >100ms  dispatch  refresh  rebuild  travelled')
  for (const pass of payload.passes) {
    console.log(
      '  ' +
        String(pass.label).padEnd(14) +
        String(pass.p50).padStart(6) +
        String(pass.p90).padStart(7) +
        String(pass.max).padStart(7) +
        String(pass.over33).padStart(7) +
        String(pass.over100).padStart(8) +
        String(pass.dispatches).padStart(10) +
        String(pass.refreshDispatches).padStart(9) +
        String(pass.rebuilds ?? '-').padStart(9) +
        String(pass.travelled).padStart(10)
    )
  }

  const csv = key => payload.passes.map(pass => num(pass[key]))
  console.log(
    `\n  mean over ${payload.passes.length} passes: p50 ${mean(csv('p50'))} ms, p90 ${mean(csv('p90'))} ms, ` +
      `${mean(csv('over33'))} frames over 33 ms, ${mean(csv('over100'))} over 100 ms`
  )

  if (payload.mathBound) {
    const bound = payload.mathBound
    console.log(
      `\n  WHAT THE MATHEMATICS COSTS (the same gesture, interleaved):` +
        `\n    with it       p50 ${String(bound.withMath.p50).padStart(6)} ms  p90 ${String(bound.withMath.p90).padStart(6)} ms` +
        `  ${String(bound.withMath.over33).padStart(3)} frames over 33 ms   ${bound.withMath.nodes} elements` +
        `\n    without it    p50 ${String(bound.withoutMath.p50).padStart(6)} ms  p90 ${String(bound.withoutMath.p90).padStart(6)} ms` +
        `  ${String(bound.withoutMath.over33).padStart(3)} frames over 33 ms   ${bound.withoutMath.nodes} elements` +
        `\n    with it again p50 ${String(bound.withMathAgain.p50).padStart(6)} ms  p90 ${String(bound.withMathAgain.p90).padStart(6)} ms` +
        `   (the control for order)` +
        `\n    -> removing every rendered equation changes p50 by ` +
        `${Math.round((bound.withoutMath.p50 - bound.withMath.p50) * 10) / 10} ms ` +
        `and leaves ${bound.withoutMath.over33} of ${bound.withMath.over33} slow frames`
    )
    const withLf = bound.longFramesWith
    const withoutLf = bound.longFramesWithout
    if (withLf && withoutLf) {
      console.log(
        `    long frames: with ${withLf.count} (script ${withLf.scriptMs}, style+layout ${withLf.styleAndLayoutMs}, blocking ${withLf.blockingMs})` +
          ` / without ${withoutLf.count} (script ${withoutLf.scriptMs}, style+layout ${withoutLf.styleAndLayoutMs}, blocking ${withoutLf.blockingMs})`
      )
    }
  }

  if (payload.refreshBound) {
    const bound = payload.refreshBound
    console.log(
      `\n  WHAT THE WIDGET REFRESHES COST (the same gesture, interleaved):` +
        `\n    kept       p50 ${String(bound.kept.p50).padStart(6)} ms  p90 ${String(bound.kept.p90).padStart(6)} ms  ${String(bound.kept.over33).padStart(3)} over 33 ms` +
        `\n    dropped    p50 ${String(bound.dropped.p50).padStart(6)} ms  p90 ${String(bound.dropped.p90).padStart(6)} ms  ${String(bound.dropped.over33).padStart(3)} over 33 ms` +
        `\n    kept again p50 ${String(bound.keptAgain.p50).padStart(6)} ms  p90 ${String(bound.keptAgain.p90).padStart(6)} ms  ${String(bound.keptAgain.over33).padStart(3)} over 33 ms` +
        `   (the control for order)`
    )
    const kept = bound.longFramesKept
    const dropped = bound.longFramesDropped
    if (kept && dropped) {
      console.log(
        `    long frames: kept ${kept.count} (script ${kept.scriptMs}, style+layout ${kept.styleAndLayoutMs}, blocking ${kept.blockingMs})` +
          ` / dropped ${dropped.count} (script ${dropped.scriptMs}, style+layout ${dropped.styleAndLayoutMs}, blocking ${dropped.blockingMs})`
      )
    }
  }

  if (payload.sweep && payload.sweep.length > 0) {
    console.log('\n  SWEEP — the same gesture from different places in the file:')
    console.log('    line   passes     p50     p90     max   >33ms   nodes   svg   math  lines')
    for (const row of payload.sweep) {
      console.log(
        '    ' +
          String(row.line).padStart(6) +
          String(row.passes ?? 1).padStart(8) +
          String(row.p50).padStart(8) +
          String(row.p90).padStart(8) +
          String(row.max).padStart(8) +
          String(row.over33).padStart(7) +
          String(row.nodes).padStart(8) +
          String(row.svgs).padStart(6) +
          String(row.math).padStart(6) +
          String(row.lines).padStart(7)
      )
    }
    const meanOf = key =>
      Math.round(
        (payload.sweep.reduce((sum, row) => sum + (row[key] ?? 0), 0) / payload.sweep.length) * 10
      ) / 10
    console.log(
      `    mean: p50 ${meanOf('p50')} ms, p90 ${meanOf('p90')} ms, max ${meanOf('max')} ms, ` +
        `${meanOf('over33')} frames over 33 ms`
    )
  }

  const detail = payload.lastPassDetail
  if (detail) {
    console.log(`\nlast pass (${detail.label}) in detail:`)
    console.log(
      `  frames ${detail.frames}, travelled ${detail.travelled} px, ` +
        `dispatches ${detail.dispatches} (${detail.refreshDispatches} widget refreshes)`
    )
    console.log('  transactions by caller:')
    for (const [caller, count] of detail.dispatchesByCaller) {
      console.log(`    ${String(count).padStart(5)}  ${caller}`)
    }
    console.log(`  render cache: ${JSON.stringify(detail.renderStats)}`)
    if (detail.decorationWork) {
      const work = detail.decorationWork
      console.log(
        `\n  the widget pass during this gesture:` +
          `\n    ${work.rebuilds} rebuilds, ${Math.round(work.ms)} ms in total` +
          ` (${work.rebuilds ? Math.round(work.ms / work.rebuilds) : 0} ms each)` +
          `\n    ${work.widgets} widget objects constructed, ${work.ranges} decoration ranges` +
          `\n    ${Math.round(work.setMs)} ms of that in Decoration.set (building the query tree)`
      )
    }
    if (detail.dom) {
      const { before, after } = detail.dom
      console.log(
        `\n  the viewport holds (before → after a gesture):` +
          `\n    elements ${before.nodes} → ${after.nodes}` +
          `   svg ${before.svgs} → ${after.svgs}` +
          `   path ${before.paths} → ${after.paths}` +
          `   use ${before.uses} → ${after.uses}` +
          `\n    rendered equations ${before.math} → ${after.math}` +
          `   lines ${before.lines} → ${after.lines}`
      )
    }
    if (detail.longFrames) {
      const lf = detail.longFrames
      console.log(
        `\n  long frames (>50 ms), as the browser splits them:` +
          `\n    ${lf.count} of ${detail.frames} frames, worst ${lf.worstMs} ms, total ${lf.totalMs} ms` +
          `\n    script ${lf.scriptMs} ms   style+layout ${lf.styleAndLayoutMs} ms   blocking ${lf.blockingMs} ms`
      )
      for (const frame of lf.worst) {
        console.log(
          `      ${String(frame.duration).padStart(4)} ms  script ${String(frame.script).padStart(4)}` +
            `  style+layout ${String(frame.styleAndLayout).padStart(4)}  blocking ${String(frame.blocking).padStart(4)}` +
            `  (${frame.scriptCount} script spans)`
        )
      }
    }
    if (detail.ms) {
      const ms = detail.ms
      console.log(
        `\n  where the ${ms.wall} ms of wall time went:` +
          `\n    transactions      ${String(ms.dispatch).padStart(8)} ms  (${detail.dispatches} of them)` +
          `\n      of which widget refreshes ${String(ms.refreshDispatch).padStart(6)} ms  ` +
          `(${detail.refreshDispatches}, worst ${ms.refreshDispatchMax} ms)` +
          `\n    MathJax renders   ${String(ms.mathRender).padStart(8)} ms  (${ms.mathRenders} of them)` +
          `\n    unattributed      ${String(Math.max(0, ms.wall - ms.dispatch)).padStart(8)} ms  ` +
          `(layout, paint, and the gesture's own frames)`
      )
    }
  }

  console.log(`\nfull report: ${reportPath}`)
  process.exit(0)
})
