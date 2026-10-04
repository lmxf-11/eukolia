/**
 * Run one client script (from `scripts/lib/`) against a real document in the real app and
 * print the JSON it returns.
 *
 * This is `probe-scroll.mjs`'s harness with the script swapped: same build check, same
 * Electron binary lookup, same marker protocol (`__EUKOLIA_RASTER_PROBE__`), same
 * `visualProbe.ts` payload wrapper and same `EUKOLIA_PROBE_DOCUMENT` handling — but the
 * injected text comes from a file named on the command line instead of being one fixed
 * measurement.
 *
 * The script **must end with `return`**
 * (`ARCHITECTURE.md` §3.38.1): an injected script whose last statement is a call
 * expression returns `undefined` and reports no failure, which cost this repository five
 * wrong hypotheses once already. `return runX();` is the shape.
 *
 *   node scripts/run-client-script.mjs scripts/lib/math-cache-probe.client.js
 *
 * `EUKOLIA_CLIENT_LABEL` names the report file (`.scratch/<label>-probe.json`);
 * `EUKOLIA_PROBE_DOCUMENT` and `EUKOLIA_PROBE_WORKSPACE` choose the document, and are the
 * same variables every other probe uses.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

const scriptArg = process.argv[2]
if (!scriptArg) {
  console.error('Usage: node scripts/run-client-script.mjs scripts/lib/<name>.client.js')
  process.exit(2)
}
const clientPath = path.resolve(projectRoot, scriptArg)
if (!existsSync(clientPath)) {
  console.error(`No such client script: ${clientPath}`)
  process.exit(2)
}

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
  process.env.EUKOLIA_PROBE_WORKSPACE ?? (documentPath ? path.dirname(documentPath) : null)
if (!documentPath || !existsSync(documentPath)) {
  console.error('Set EUKOLIA_PROBE_DOCUMENT to a .tex file that exists.')
  process.exit(3)
}

const label = process.env.EUKOLIA_CLIENT_LABEL ?? path.basename(clientPath).replace(/\.client\.js$/, '')
const reportPath = path.join(projectRoot, '.scratch', `${label}-probe.json`)
mkdirSync(path.dirname(reportPath), { recursive: true })

// One script, one scope — see the header. Nothing is appended after the script's own return.
/*
 * Every `EUKOLIA_CLIENT_*` variable is published to the page as a `__<name>` global, so a
 * client script can be parameterised from the command line without editing the file between
 * runs. `EUKOLIA_CLIENT_ARMS='["control","paint"]'` sets `globalThis.__ARMS`; values that
 * parse as JSON are parsed, so arrays and numbers arrive as themselves. The preamble goes
 * *before* the script, because the script ends with its own `return`.
 */
/**
 * Settings applied to the page before the client script runs.
 *
 * `EUKOLIA_CLIENT_SETTINGS='{"scrolling.smoothEditor":false}'` queues a value for each key and
 * `main.tsx` applies it over the persisted settings on the next frame — so a probe can ask for
 * a configuration without a second build, without writing to the user's settings file, and
 * without the client script having to know how settings are stored. The page is asked to
 * confirm it took effect and the runner prints the answer, so a run whose configuration did
 * not arrive says so instead of reporting a measurement of the default.
 */
const settingsArg = process.env.EUKOLIA_CLIENT_SETTINGS ?? ''
const bootstrap = settingsArg
  ? `
globalThis.__eukoliaSettingsBootstrap = ${settingsArg};
`
  : ''

const globals = Object.entries(process.env)
  .filter(([name]) => name.startsWith('EUKOLIA_CLIENT_') && name !== 'EUKOLIA_CLIENT_LABEL')
  .map(([name, value]) => {
    const key = '__' + name.slice('EUKOLIA_CLIENT_'.length)
    let parsed = value
    try {
      parsed = JSON.parse(value)
    } catch {
      /* a bare string is a legitimate value */
    }
    return `globalThis[${JSON.stringify(key)}] = ${JSON.stringify(parsed)};`
  })
const script =
  (globals.length ? globals.join('\n') + '\n' : '') + bootstrap + readFileSync(clientPath, 'utf8')

/*
 * Extra switches for the Electron process itself, space-separated —
 * `EUKOLIA_CLIENT_ELECTRON_ARGS='--force-device-scale-factor=1'`.
 *
 * A scroll measurement is a measurement of the rasteriser, and the rasteriser's workload is
 * set by the device scale factor: at 125 % every frame covers 1.56× the pixels of 100 %, and
 * an SVG-heavy viewport pays that per element. Being able to vary it from the command line is
 * what makes "is this machine's DPI scaling the cost?" an experiment rather than a theory.
 */
const electronArgs = (process.env.EUKOLIA_ELECTRON_ARGS ?? '')
  .split(' ')
  .map(value => value.trim())
  .filter(Boolean)

const child = spawn(electronBinary, ['.', ...electronArgs], {
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
})

const timeoutMs =
  Number(process.env.EUKOLIA_PROBE_TIMEOUT_MS) > 0
    ? Number(process.env.EUKOLIA_PROBE_TIMEOUT_MS)
    : 600_000
const timer = setTimeout(() => {
  console.error(`Probe did not finish within ${timeoutMs / 1000}s; killing it.`)
  child.kill()
}, timeoutMs)

child.on('exit', code => {
  clearTimeout(timer)
  const marker = '__EUKOLIA_RASTER_PROBE__'
  const at = stdout.indexOf(marker)
  if (at < 0) {
    console.error(`Probe produced no payload (exit ${code}).`)
    if (stdout.trim()) console.error('stdout:\n' + stdout.slice(-3000))
    if (stderr.trim()) console.error('stderr:\n' + stderr.slice(-4000))
    process.exit(1)
  }
  const raw = stdout.slice(at + marker.length).split('\n')[0]
  if (raw === 'undefined') {
    console.error(
      'Probe produced no result: the injected script threw or ended in a call expression. ' +
        'The renderer\'s own message is in .scratch/visual-probe.json.'
    )
    if (stderr.trim()) console.error('stderr:\n' + stderr.slice(-4000))
    process.exit(1)
  }
  const payload = JSON.parse(raw)
  writeFileSync(reportPath, JSON.stringify(payload, null, 2))
  console.log(JSON.stringify(payload.value ?? payload, null, 2))
  console.log(`\nfull report: ${reportPath}`)
  process.exit(0)
})
