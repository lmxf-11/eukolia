/**
 * Say what a Chrome trace spent its time on, grouped by phase.
 *
 * `scripts/probe-scroll.mjs` can ask `visualProbe.ts` to record a trace
 * (`EUKOLIA_VISUAL_TRACE_PATH`), which is the only instrument that sees *paint*:
 * `long-animation-frame` reports a frame as script + style-and-layout + blocking, and
 * "blocking" is everything else, including the rasterisation that a viewport of live
 * SVGs is supposed to cost. On `algebra.tex` that remainder was ~130 ms of a 170 ms
 * frame — 75 % of the stutter, unattributed.
 *
 * A raw trace is tens of megabytes of nested events, so this reduces it the way
 * `analyse-cpuprofile.mjs` reduces a profile: total **and** self time per event name,
 * with the element counts that `Paint` and `Layout` carry, and the worst frames listed
 * with their phases.
 *
 * Usage:
 *   node scripts/analyse-trace.mjs .scratch/scroll-algebra.trace.json
 *   node scripts/analyse-trace.mjs <trace> --top 25
 */
import fs from 'node:fs'

const [, , file, ...rest] = process.argv
if (!file) {
  console.error('usage: node scripts/analyse-trace.mjs <trace.json> [--top N]')
  process.exit(2)
}
if (!fs.existsSync(file)) {
  console.error(`no such trace: ${file}`)
  process.exit(2)
}

const topIndex = rest.indexOf('--top')
const TOP = topIndex >= 0 ? Number(rest[topIndex + 1]) || 20 : 20

const raw = fs.readFileSync(file, 'utf8')
let events
try {
  events = JSON.parse(raw)
} catch {
  console.error(`could not parse ${file} as JSON — a trace is written as one array of events`)
  process.exit(2)
}
if (!Array.isArray(events)) {
  console.error('the trace is not an array of events')
  process.exit(2)
}

/*
 * Only complete (`ph: 'X'`) events have a duration, and only those can be summed. The
 * `Tracing.dataCollected` payload uses microseconds.
 */
const complete = events.filter(event => event && event.ph === 'X' && typeof event.dur === 'number')

/** Total and self time per event name, in milliseconds. */
const totals = new Map()
const byTimestamp = [...complete].sort((a, b) => a.ts - b.ts)

for (const event of byTimestamp) {
  const entry = totals.get(event.name) ?? { total: 0, self: 0, count: 0, max: 0 }
  entry.total += event.dur / 1000
  entry.self += event.dur / 1000
  entry.count += 1
  entry.max = Math.max(entry.max, event.dur / 1000)
  totals.set(event.name, entry)
}

/*
 * Subtract each event's children from its self time, using a stack over the
 * time-ordered list. Chrome's `X` events nest by containment, not by `B`/`E` pairs.
 */
const stack = []
for (const event of byTimestamp) {
  const end = event.ts + event.dur
  while (stack.length > 0 && stack[stack.length - 1].end <= event.ts) stack.pop()
  const parent = stack[stack.length - 1]
  if (parent) {
    const entry = totals.get(parent.name)
    if (entry) entry.self -= event.dur / 1000
  }
  stack.push({ name: event.name, end })
}

const rows = [...totals.entries()]
  .map(([name, entry]) => ({ name, ...entry }))
  .sort((a, b) => b.self - a.self)

const span = (() => {
  if (byTimestamp.length === 0) return { from: 0, to: 0 }
  const first = byTimestamp[0]
  const last = byTimestamp[byTimestamp.length - 1]
  return { from: first.ts, to: last.ts + last.dur }
})()
const spanMs = (span.to - span.from) / 1000

console.log(
  `${file}\n${events.length} events, ${complete.length} with a duration, ` +
    `${spanMs.toFixed(0)} ms of timeline\n`
)
console.log('  self ms   total ms  count    max ms  event')
for (const row of rows.slice(0, TOP)) {
  console.log(
    String(Math.round(row.self)).padStart(9) +
      String(Math.round(row.total)).padStart(11) +
      String(row.count).padStart(7) +
      String(Math.round(row.max)).padStart(10) +
      '  ' +
      row.name
  )
}

/*
 * The phases that matter for a stutter, as one line each, so the answer does not depend
 * on reading the table above correctly.
 */
const phase = name => totals.get(name) ?? { total: 0, self: 0, count: 0, max: 0 }
const interesting = [
  'Paint',
  'PaintImage',
  'Layout',
  'UpdateLayerTree',
  'CompositeLayers',
  'UpdateLayoutTree',
  'RasterTask',
  'DecodeImage',
  'FunctionCall',
  'TimerFire',
  'EventDispatch',
  'HitTest',
  'ParseHTML',
  'RecalculateStyles',
]
console.log('\n  phases (total ms, count, worst ms):')
for (const name of interesting) {
  const entry = phase(name)
  if (entry.count === 0) continue
  console.log(
    `    ${name.padEnd(20)} ${String(Math.round(entry.total)).padStart(8)} ms  ` +
      `${String(entry.count).padStart(7)}  worst ${String(Math.round(entry.max)).padStart(6)} ms`
  )
}

/*
 * What the JavaScript was.
 *
 * `FunctionCall` and `TimerFire` carry the *name and location* of the function in their
 * args, which is the only place a trace says which code ran — `analyse-cpuprofile.mjs`
 * answers that for a CPU profile, and this is its counterpart for a trace. Worth having
 * because the two instruments disagreed here: the browser's `long-animation-frame`
 * entries attributed `script 0 ms` to every long frame, while the trace showed
 * `FunctionCall` totalling 794 ms. One of them is not measuring what its name suggests.
 */
const byFunction = new Map()
for (const event of complete) {
  if (event.name !== 'FunctionCall' && event.name !== 'TimerFire' && event.name !== 'EvaluateScript') {
    continue
  }
  const data = event.args?.data ?? {}
  const key = `${data.functionName || '(anonymous)'}  ${data.url || ''}:${data.lineNumber ?? '?'}`
  byFunction.set(key, (byFunction.get(key) ?? 0) + event.dur / 1000)
}
const functions = [...byFunction.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP)
if (functions.length > 0) {
  console.log('\n  the JavaScript, by function (total ms):')
  for (const [name, ms] of functions) {
    console.log(`    ${String(Math.round(ms)).padStart(7)}  ${name}`)
  }
}

/*
 * Paint and Layout detail: what was painted and how much of it.
 */
const paints = complete.filter(event => event.name === 'Paint')
const paintCounts = paints
  .map(event => event.args?.data?.elementCount)
  .filter(count => typeof count === 'number')
if (paintCounts.length > 0) {
  const mean = paintCounts.reduce((sum, count) => sum + count, 0) / paintCounts.length
  console.log(
    `\n  Paint element counts: mean ${Math.round(mean)}, ` +
      `worst ${Math.max(...paintCounts)}, over ${paintCounts.length} paints`
  )
}

const layouts = complete.filter(event => event.name === 'Layout')
const layoutCounts = layouts
  .map(event => event.args?.beginData?.dirtyObjects ?? event.args?.data?.dirtyObjects)
  .filter(count => typeof count === 'number')
if (layoutCounts.length > 0) {
  const mean = layoutCounts.reduce((sum, count) => sum + count, 0) / layoutCounts.length
  console.log(
    `  Layout dirty objects: mean ${Math.round(mean)}, worst ${Math.max(...layoutCounts)}`
  )
}

/*
 * The worst frames, with the phases that filled them. A frame is a `DrawFrame` in the
 * compositor or a `RunTask` on the main thread; either way the phases inside it are what
 * a reader wants.
 */
const frames = complete
  .filter(event => event.name === 'DrawFrame' || event.name === 'BeginFrame')
  .sort((a, b) => b.dur - a.dur)
  .slice(0, 5)
if (frames.length > 0) {
  console.log('\n  worst frames:')
  for (const frame of frames) {
    const from = frame.ts
    const to = frame.ts + frame.dur
    const inside = complete
      .filter(event => event.ts >= from && event.ts + event.dur <= to)
      .reduce((acc, event) => {
        acc[event.name] = (acc[event.name] ?? 0) + event.dur / 1000
        return acc
      }, {})
    const top = Object.entries(inside)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, ms]) => `${name} ${Math.round(ms)}`)
      .join(', ')
    console.log(`    ${Math.round(frame.dur / 1000)} ms: ${top || '(nothing nested)'}`)
  }
}
