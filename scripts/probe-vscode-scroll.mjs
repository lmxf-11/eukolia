/**
 * Measure scroll smoothness in a running VS Code window, through its own debugging port.
 *
 * ## Why this is comparable to `scripts/probe-scroll.mjs`
 *
 * The number that matters for a stutter is the **frame interval distribution during a
 * wheel gesture**, and it is the same measurement whichever editor produces it: drive
 * the scroller with real wheel events, and wait for `requestAnimationFrame` between them
 * so each step is bounded by the compositor's own frame. `probe-scroll.mjs` does exactly
 * that inside Eukolia; this does exactly that inside VS Code.
 *
 * What it deliberately does **not** do is compare "scroll speed" or "responsiveness" in
 * the abstract. VS Code is not rendering LaTeX, Eukolia is not a Monaco editor, and a
 * comparison that pretends otherwise would be theatre. What it answers is narrow and
 * real: *on the same file, at the same wheel delta, over the same distance, how often
 * does a frame take longer than a frame?*
 *
 * ## Driving it
 *
 * VS Code must be started with `--remote-debugging-port`. The already-running instance
 * cannot be made to listen after the fact, so this either attaches to a window the user
 * started that way, or launches its own:
 *
 *   code --remote-debugging-port=9222 "D:\LaTeX projects\The Stacks project\stacks-project-master"
 *
 * Usage:
 *   node scripts/probe-vscode-scroll.mjs --list
 *   node scripts/probe-vscode-scroll.mjs --file algebra.tex
 *   node scripts/probe-vscode-scroll.mjs --launch
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const PORT = Number(option('port', process.env.EUKOLIA_VSCODE_PORT ?? 9222))
const LABEL = option('label', 'vscode')
const STEPS = Number(option('steps', 60))
const DELTA = Number(option('delta', 120))
const PASSES = Number(option('passes', 4))
const DOCUMENT = option('file', process.env.EUKOLIA_PROBE_DOCUMENT ?? 'algebra.tex')
const CODE_CLI =
  process.env.EUKOLIA_VSCODE_CLI ??
  'C:\\Users\\Yinji\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'

const targets = async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null)
  if (!response || !response.ok) return null
  return response.json()
}

if (flag('launch')) {
  if (!existsSync(CODE_CLI)) {
    console.error(`no VS Code CLI at ${CODE_CLI}; set EUKOLIA_VSCODE_CLI`)
    process.exit(2)
  }
  const workspace =
    process.env.EUKOLIA_PROBE_WORKSPACE ??
    'D:\\LaTeX projects\\The Stacks project\\stacks-project-master'
  console.log(`launching VS Code with --remote-debugging-port=${PORT}`)
  console.log(`  workspace: ${workspace}`)
  /*
   * `detached` and `unref`, because this is the user's editor and it should outlive the
   * probe. `.cmd` needs a shell on Windows; the arguments are all paths and numbers, so
   * there is nothing here for a shell to reinterpret.
   */
  const child = spawn(
    CODE_CLI,
    [`--remote-debugging-port=${PORT}`, '--new-window', workspace],
    { detached: true, stdio: 'ignore', shell: true }
  )
  child.unref()
  console.log('waiting for the debugging port …')
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (await targets()) {
      console.log(`up after ${attempt + 1}s`)
      break
    }
  }
}

const list = await targets()
if (!list) {
  console.error(
    `No debugging endpoint on 127.0.0.1:${PORT}.\n` +
      `A running VS Code cannot be made to listen after the fact — start one with:\n` +
      `  node scripts/probe-vscode-scroll.mjs --launch\n` +
      `or\n` +
      `  code --remote-debugging-port=${PORT} "D:\\LaTeX projects\\The Stacks project\\stacks-project-master"`
  )
  process.exit(3)
}

if (flag('list')) {
  console.log(`${list.length} targets on ${PORT}:`)
  for (const target of list) {
    console.log(`  ${target.type.padEnd(10)} ${String(target.title).slice(0, 70)}`)
    console.log(`             ${target.webSocketDebuggerUrl}`)
  }
  process.exit(0)
}

/*
 * The workbench renderer, not the extension host and not a webview. VS Code's window is
 * the target whose title ends in the app name and which has a webSocketDebuggerUrl.
 */
const target =
  list.find(entry => entry.type === 'page' && /Visual Studio Code/i.test(entry.title ?? '')) ??
  list.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl) ??
  null
if (!target) {
  console.error('no page target with a debugger URL; run with --list to see what is there')
  process.exit(4)
}
console.log(`attached to: ${target.title}`)

/* ---- a minimal CDP client over the target's websocket --------------------- */
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

const evaluate = async expression => {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)
    )
  }
  return result.result.value
}

/*
 * The measurement, and it is deliberately the same shape as the one inside Eukolia:
 * wheel events at a fixed delta, one animation frame apart, reporting the interval
 * distribution and what the editor did during it.
 */
const measure = `
(async () => {
  const steps = ${STEPS}
  const deltaY = ${DELTA}
  const settle = ms => new Promise(r => setTimeout(r, ms))

  /*
   * The editor's scroller. Monaco's is \`.monaco-scrollable-element\`; VS Code may have
   * several editors open, so the one with the most lines wins — that is the file being
   * measured rather than the sidebar's tree or a diff view.
   */
  const editors = [...document.querySelectorAll('.monaco-editor')]
    .map(editor => {
      const scroller = editor.querySelector('.monaco-scrollable-element')
      const lines = editor.querySelectorAll('.view-line').length
      const visible = editor.getBoundingClientRect()
      /*
       * The text actually on screen, so the report can say *which* file was measured.
       * A VS Code window has several Monaco instances — the editor, the minimap, the
       * breadcrumbs, the terminal's find widget — and "the biggest one" is a heuristic
       * that would be worth nothing if it silently picked the wrong one.
       */
      const firstLines = [...editor.querySelectorAll('.view-line')]
        .slice(0, 2)
        .map(node => (node.textContent || '').trim().slice(0, 60))
      return {
        editor,
        scroller,
        lines,
        area: visible.width * visible.height,
        scrollHeight: scroller ? scroller.scrollHeight : 0,
        firstLines,
      }
    })
    .filter(entry => entry.scroller && entry.area > 0)
    .sort((a, b) => b.area - a.area)
  if (editors.length === 0) return { error: 'no visible Monaco editor in this window' }
  const { editor, scroller, lines, scrollHeight, firstLines } = editors[0]

  const gesture = async (label) => {
    scroller.scrollTop = 0
    await settle(700)
    const intervals = []
    let last = performance.now()
    const started = last
    for (let step = 0; step < steps; step += 1) {
      scroller.dispatchEvent(new WheelEvent('wheel', {
        deltaY, deltaMode: 0, bubbles: true, cancelable: true,
      }))
      await new Promise(r => requestAnimationFrame(() => {
        const now = performance.now()
        intervals.push(now - last)
        last = now
        r()
      }))
    }
    const wall = performance.now() - started
    const sorted = [...intervals].sort((a, b) => a - b)
    const at = q => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10
    return {
      label,
      wallMs: Math.round(wall),
      travelled: Math.round(scroller.scrollTop),
      frames: intervals.length,
      p50: at(0.5),
      p90: at(0.9),
      p99: at(0.99),
      max: Math.round(sorted[sorted.length - 1]),
      over33: intervals.filter(v => v > 33).length,
      over100: intervals.filter(v => v > 100).length,
    }
  }

  const passes = []
  for (let pass = 0; pass < ${PASSES}; pass += 1) passes.push(await gesture('pass #' + pass))
  return {
    editor: { lines, viewLines: lines, scrollHeight, firstLines },
    document: {
      title: document.title,
      // What is open, as VS Code reports it in the tab title area.
      tabs: [...document.querySelectorAll('.tab .label-name, .tabs-container .tab')]
        .slice(0, 6)
        .map(node => (node.textContent || '').trim())
        .filter(Boolean),
    },
    model: (() => {
      const input = document.querySelector('.monaco-editor textarea')
      return input ? { hasTextarea: true } : { hasTextarea: false }
    })(),
    steps,
    deltaY,
    passes,
  }
})()
`

let payload
try {
  payload = await evaluate(measure)
} catch (error) {
  console.error('the measurement threw:', String(error).slice(0, 600))
  socket.close()
  process.exit(5)
}
socket.close()

if (!payload || payload.error) {
  console.error(payload ? payload.error : 'no payload')
  process.exit(6)
}

const reportPath = path.join(projectRoot, `scroll-probe-${LABEL}.json`)
writeFileSync(reportPath, JSON.stringify(payload, null, 2))

const mean = key => {
  const values = payload.passes.map(pass => pass[key] ?? 0)
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
}

console.log(`\n${payload.document.title}`)
console.log(`  editor: ${payload.editor.lines} view lines rendered, scrollHeight ${payload.editor.scrollHeight}`)
console.log(`  on screen: ${JSON.stringify(payload.editor.firstLines)}`)
console.log(`  tabs:   ${payload.document.tabs.join(' | ') || '(none visible)'}`)
console.log(`  deltaY ${payload.deltaY}, ${payload.steps} steps, ${payload.passes.length} passes`)
console.log(
  '\n  pass            p50    p90    p99    max   >33ms  >100ms  travelled'
)
for (const pass of payload.passes) {
  console.log(
    '  ' +
      String(pass.label).padEnd(14) +
      String(pass.p50).padStart(6) +
      String(pass.p90).padStart(7) +
      String(pass.p99).padStart(7) +
      String(pass.max).padStart(7) +
      String(pass.over33).padStart(7) +
      String(pass.over100).padStart(8) +
      String(pass.travelled).padStart(10)
  )
}
console.log(
  `\n  mean: p50 ${mean('p50')} ms, p90 ${mean('p90')} ms, ` +
    `${mean('over33')} frames over 33 ms, ${mean('over100')} over 100 ms`
)
console.log(`\nfull report: ${reportPath}`)
