/**
 * Measure the raster experiment cleanly.
 *
 * The first run of this in `visualProbe.ts` was confounded, and the confound is in
 * its own data: `mounts` rises monotonically across all twelve gestures (2 337 →
 * 4 420) whatever the configuration is, so the later configurations are measured
 * against a document that has changed underneath them. The per-round table reads
 * "baseline 14.7 ms, content-visibility 7.0 ms" only because baseline ran first.
 *
 * Three fixes, and the first is the one that matters:
 *
 *  1. **zero the mount counters before every gesture**, so `mounts` is what *that*
 *     gesture mounted rather than a running total — the growth is then either gone
 *     (and the configurations are comparable) or measured rather than hidden;
 *  2. alternate the configurations in a repeating sequence over many cycles, and
 *     report every sample so drift is visible;
 *  3. a control that changes nothing at all, which is the only way to see how much
 *     of a difference is drift.
 *
 * Usage: node scripts/probe-raster.mjs
 *   EUKOLIA_PROBE_DOCUMENT / EUKOLIA_PROBE_WORKSPACE as for `probe-visual.mjs`.
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

const document = process.env.EUKOLIA_PROBE_DOCUMENT
const workspace = process.env.EUKOLIA_PROBE_WORKSPACE ??
  (document ? path.dirname(document) : null)
if (!document || !existsSync(document)) {
  console.error('Set EUKOLIA_PROBE_DOCUMENT to a .tex file that exists.')
  process.exit(3)
}

/*
 * The script the renderer runs.
 *
 * `CYCLES` repetitions of the sequence, and within a cycle every configuration runs
 * once. The sequence repeats rather than each configuration running in a block, so
 * drift lands on all of them equally — and the first cycle is reported separately
 * because the document has genuinely never shown that ground.
 */
const SCRIPT = `(async () => {
  const view = window.__cmView;
  const scroller = view.scrollDOM;
  const settle = (ms) => new Promise(r => setTimeout(r, ms));
  const at = (sorted, q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10;

  const widgets = () => [...view.dom.querySelectorAll('.ol-cm-math')];

  const sheet = [...document.styleSheets].find(s => {
    try { return [...s.cssRules].some(r => r.selectorText === '.ol-cm-math'); }
    catch { return false; }
  });
  const overflowRule = sheet
    ? [...sheet.cssRules].find(r => r.selectorText === '.ol-cm-math' && r.style.overflowX)
    : null;
  const originalOverflow = overflowRule ? overflowRule.style.overflowX : null;

  const clearAll = () => {
    for (const w of widgets()) {
      w.style.contain = '';
      w.style.contentVisibility = '';
      w.style.overflowX = '';
    }
    for (const svg of view.dom.querySelectorAll('.ol-cm-math svg')) {
      svg.style.visibility = '';
    }
    if (overflowRule && originalOverflow !== null) {
      overflowRule.style.overflowX = originalOverflow;
    }
  };

  const configs = [
    { name: 'control (unchanged)',
      note: 're-applies nothing; measures drift',
      apply: clearAll },
    { name: 'no overflow-x: auto',
      note: 'removes the per-widget scroll container',
      apply: () => {
        clearAll();
        for (const w of widgets()) w.style.overflowX = 'visible';
        if (overflowRule) overflowRule.style.overflowX = 'visible';
      } },
    { name: 'content-visibility: auto',
      note: 'skips painting what is off screen',
      apply: () => {
        clearAll();
        for (const w of widgets()) w.style.contentVisibility = 'auto';
      } },
    { name: 'svg not painted (raster control)',
      note: 'same boxes, no artwork',
      apply: () => {
        clearAll();
        for (const svg of view.dom.querySelectorAll('.ol-cm-math svg')) {
          svg.style.visibility = 'hidden';
        }
      } },
  ];

  const gesture = async (steps) => {
    scroller.scrollTop = 0;
    await settle(400);
    // Per-gesture, not cumulative: the counter is what this gesture mounted.
    window.__eukoliaMathCounters = { mounts: 0, renders: 0, cacheHits: 0 };
    const intervals = [];
    let last = performance.now();
    const started = last;
    for (let step = 0; step < steps; step += 1) {
      scroller.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true,
      }));
      await new Promise(r => requestAnimationFrame(() => {
        const now = performance.now();
        intervals.push(now - last);
        last = now;
        r();
      }));
    }
    const wall = performance.now() - started;
    await settle(200);
    const sorted = [...intervals].sort((a, b) => a - b);
    const counters = window.__eukoliaMathCounters;
    return {
      wallMs: Math.round(wall),
      travelled: Math.round(scroller.scrollTop),
      p50: at(sorted, 0.5),
      p90: at(sorted, 0.9),
      max: Math.round(sorted[sorted.length - 1]),
      over33: intervals.filter(v => v > 33).length,
      over100: intervals.filter(v => v > 100).length,
      mounts: counters.mounts,
      renders: counters.renders,
      cacheHits: counters.cacheHits,
      widgets: widgets().length,
      svgs: view.dom.querySelectorAll('.ol-cm-math svg').length,
      nodes: view.dom.querySelectorAll('*').length,
    };
  };

  // One warm-up gesture over the whole range so the render cache is filled, then
  // every measurement starts from the same state.
  const warmup = await gesture(60);
  clearAll();

  const CYCLES = 5;
  const STEPS = 24;
  const samples = [];
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    for (const config of configs) {
      config.apply();
      const result = await gesture(STEPS);
      samples.push({ cycle, config: config.name, note: config.note, ...result });
    }
  }
  clearAll();

  const summary = {};
  for (const config of configs) {
    const rows = samples.filter(s => s.config === config.name);
    const mean = (key) =>
      Math.round((rows.reduce((sum, r) => sum + r[key], 0) / rows.length) * 10) / 10;
    summary[config.name] = {
      note: config.note,
      meanP50: mean('p50'),
      meanP90: mean('p90'),
      meanOver33: mean('over33'),
      worstMax: Math.max(...rows.map(r => r.max)),
      meanMounts: mean('mounts'),
      meanRenders: mean('renders'),
      mountsPerCycle: rows.map(r => r.mounts),
    };
  }

  return { warmup, samples, summary, configs: configs.map(c => c.name) };
})()`

/*
 * No `--user-data-dir`: the application gives every probe its own `userData` and
 * seeds a project library from `EUKOLIA_PROBE_DOCUMENT` (`seedVisualProbeLibrary`), so
 * a flag here would be overridden. What matters is that the run does not touch the
 * developer's own profile — a probe against that is a second instance that never
 * opens a window.
 */
const reportPath = path.join(projectRoot, 'raster-probe.json')
rmSync(reportPath, { force: true })

const child = spawn(electronBinary, ['.'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    EUKOLIA_CARET_PROBE: '1',
    EUKOLIA_SMOKE_WORKSPACE: workspace,
    EUKOLIA_PROBE_DOCUMENT: document,
    EUKOLIA_RASTER_SCRIPT: SCRIPT,
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
    if (stdout.trim()) console.error('stdout:\n' + stdout.slice(-4000))
    if (stderr.trim()) console.error('stderr:\n' + stderr.slice(-4000))
    process.exit(1)
  }
  const payload = JSON.parse(
    stdout.slice(marker + '__EUKOLIA_RASTER_PROBE__'.length).split('\n')[0]
  )
  writeFileSync(reportPath, JSON.stringify(payload, null, 2))
  console.log(JSON.stringify(payload, null, 2))
  process.exit(0)
})
