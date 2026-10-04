/**
 * Break one keystroke down by phase, in the real application.
 *
 * The two-mode profile settled the first question and raised the second: typing costs
 * about the same in Visual Mode as in source mode, so the widgets, the decoration pass
 * and the SVG are not what makes typing slow. The remaining question is which part of
 * the shared keystroke path is, and a CPU profile cannot answer it on its own because
 * the phases are interleaved through React, a debounced linter and a background
 * analysis.
 *
 * So this measures them one at a time, by timing the observable boundaries of a
 * dispatch, and it counts the **tree walks** as well as the milliseconds:
 *
 *  1. `view.dispatch` itself — CodeMirror's transaction, the parse step, the decoration
 *     rebuild, the DOM update, and everything the editor's `updateListener` runs
 *     synchronously;
 *  2. the frame after it — layout, paint, and anything else the browser had queued;
 *  3. how many nodes the editor walked during (1), over what ranges. This is the part
 *     that explained the large document: on `cohomology.tex` a single keystroke entered
 *     **632 726 nodes** and read **1.82 M characters** of tree, which is about fourteen
 *     times the document's own node count. That is not a cost that hides in a profile —
 *     it is the profile.
 *
 * The injected script is a real file (`lib/keystroke-probe.client.js`), not a template
 * literal in here. `webContents.executeJavaScript` takes text, and a script written as a
 * template literal breaks on every backtick inside it — reported as a syntax error on
 * some unrelated line of the outer expression. That trap cost three rounds of debugging
 * on this file before it was moved out; keeping it out is the point.
 *
 * Usage:
 *   node scripts/probe-keystroke.mjs
 *   EUKOLIA_PROFILE_MODE=source node scripts/probe-keystroke.mjs
 *
 * `EUKOLIA_PROBE_DOCUMENT`, `EUKOLIA_PROBE_WORKSPACE` and `EUKOLIA_KEYSTROKE_STEPS` as
 * for the other probes.
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

const documentPath = process.env.EUKOLIA_PROBE_DOCUMENT
const workspace =
  process.env.EUKOLIA_PROBE_WORKSPACE ??
  (documentPath ? path.dirname(documentPath) : null)
if (!documentPath || !existsSync(documentPath)) {
  console.error('Set EUKOLIA_PROBE_DOCUMENT to a .tex file that exists.')
  process.exit(3)
}

const STEPS =
  Number(process.env.EUKOLIA_KEYSTROKE_STEPS) > 0
    ? Number(process.env.EUKOLIA_KEYSTROKE_STEPS)
    : 50

/*
 * The script is read, given its parameters, and called — it defines a function, so the
 * injected text is `<file contents>\nkeystrokeProbe(<options>)`. Reading it rather than
 * embedding it means `node --check` on that file checks the thing that actually runs.
 */
const clientSource = readFileSync(path.join(here, 'lib', 'keystroke-probe.client.js'), 'utf8')
const script = `${clientSource}\nreturn keystrokeProbe(${JSON.stringify({ steps: STEPS })});`

const reportPath = path.join(projectRoot, 'keystroke-probe.json')
rmSync(reportPath, { force: true })

const child = spawn(electronBinary, ['.'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    EUKOLIA_CARET_PROBE: '1',
    EUKOLIA_SMOKE_WORKSPACE: workspace,
    EUKOLIA_PROBE_DOCUMENT: documentPath,
    EUKOLIA_RASTER_SCRIPT: script,
    EUKOLIA_PROFILE_SWITCH_MODE: process.env.EUKOLIA_PROFILE_SWITCH_MODE ?? '',
    EUKOLIA_PROBE_EVALUATE_MS: '300000',
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
  /*
   * The renderer's own console, forwarded.
   *
   * `executeJavaScript` reports a failure from the *injected* script as "Script failed
   * to execute … check the renderer console for the error", and the renderer console is
   * where the actual message goes. Without this the only signal is that something in
   * some script threw, which is not a debugging aid.
   */
  for (const line of chunk.toString().split('\n')) {
    if (/console|Uncaught|SyntaxError|TypeError|ReferenceError/.test(line)) {
      process.stderr.write(`[renderer] ${line}\n`)
    }
  }
})

const timeoutMs =
  Number(process.env.EUKOLIA_PROBE_TIMEOUT_MS) > 0
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
  const payload = JSON.parse(
    stdout.slice(marker + '__EUKOLIA_RASTER_PROBE__'.length).split('\n')[0]
  )
  writeFileSync(reportPath, JSON.stringify(payload, null, 2))

  /*
   * Printed as a table rather than as JSON: the walks are the answer this probe exists
   * for, and `from: 0 → to: <middle of the document>` is a sentence a reader should not
   * have to assemble out of a nested object.
   */
  console.log(`surface: ${payload.surface} | ${payload.lines} lines, ${payload.chars} chars`)
  console.log(
    `keystroke: ${payload.keystrokeTotal.mean} ms ` +
      `(dispatch ${payload.dispatch.mean} + frame ${payload.frameAfterDispatch.mean}), ` +
      `p90 ${payload.keystrokeTotal.p90} ms`
  )
  console.log(
    `tree per keystroke: ${payload.walks.mean} walks, ` +
      `${payload.walkChars.mean} chars, ${payload.nodesEntered.mean} nodes entered`
  )
  const doc = payload.chars
  if (payload.contextScan) {
    const { reused, scanned, reasons } = payload.contextScan
    console.log(
      `\ncontext scan: reused ${reused}, scanned afresh ${scanned}` +
        (Object.keys(reasons).length > 0 ? ` — ${JSON.stringify(reasons)}` : '')
    )
  }
  if (payload.heaviestWalks.length > 0) {
    console.log('\nheaviest walks of one keystroke:')
    for (const walk of payload.heaviestWalks) {
      console.log(
        `  from ${String(walk.from).padStart(7)} to ${String(walk.to).padStart(7)}` +
          `  nodes ${String(walk.entered).padStart(7)}` +
          `  ${String(walk.ms).padStart(7)} ms` +
          `  tree ${walk.treeLength}`
      )
      for (const frame of walk.caller ?? []) console.log(`        ${frame}`)
    }
  }
  console.log(`\ndocument is ${doc} chars; a walk to the document end is ${doc}`)
  console.log(`\nfull report: ${reportPath}`)
  process.exit(0)
})
