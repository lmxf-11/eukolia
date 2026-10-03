/**
 * Eukolia — main-process half of the startup profiler.
 *
 * Enabled only by `EUKOLIA_STARTUP_PROBE=1` (`npm run profile:startup`). It
 * records the main process's own launch milestones, asks the renderer for the
 * document's timing (which is the only way to see how long the browser spent
 * fetching and parsing the bundle), collects the renderer's payload and prints
 * one JSON document for `scripts/profile-startup.mjs` to read.
 *
 * Nothing here runs in a normal launch: `isStartupProbeEnabled()` is false and
 * every hook below is skipped.
 */

import { app, type BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc';
import fs from 'fs';

/**
 * The console prefix the renderer reports under.
 *
 * Spelled out here rather than imported from `renderer/core/startupProbe.ts`:
 * the main process does not import renderer code (`ARCHITECTURE.md` §2), and this
 * one string is not a reason to start. The renderer's copy says the same.
 */
const STARTUP_PROBE_PREFIX = '__EUKOLIA_STARTUP__';

/**
 * With `EUKOLIA_STARTUP_CPU_PROFILE=1`, the renderer is CPU-profiled from before
 * the document loads until the report, and the profile is written here.
 *
 * This exists because a timeline of marks can only say *when* the renderer was
 * busy; when the answer is "between these two marks", the next question is always
 * "doing what", and only a sampling profile answers it. The CDP session is
 * attached before `loadFile`, so the profile covers module evaluation too.
 */
function cpuProfilePath(): string | null {
  return process.env.EUKOLIA_STARTUP_CPU_PROFILE === '1'
    ? process.env.EUKOLIA_STARTUP_CPU_PROFILE_PATH || null
    : null;
}

function startCpuProfile(window: BrowserWindow): void {
  if (cpuProfilePath() === null) return;
  try {
    const debuggerApi = window.webContents.debugger;
    debuggerApi.attach('1.3');
    void debuggerApi.sendCommand('Profiler.enable');
    void debuggerApi.sendCommand('Profiler.setSamplingInterval', { interval: 200 });
    void debuggerApi.sendCommand('Profiler.start');
  } catch {
    /* a profiling failure must not fail the run */
  }
}

async function stopCpuProfile(window: BrowserWindow): Promise<void> {
  const target = cpuProfilePath();
  if (target === null) return;
  try {
    const debuggerApi = window.webContents.debugger;
    const result = (await debuggerApi.sendCommand('Profiler.stop')) as { profile?: unknown };
    if (result?.profile) {
      fs.writeFileSync(target, JSON.stringify(result.profile), 'utf8');
    }
  } catch {
    /* ignore */
  }
}

export function isStartupProbeEnabled(): boolean {
  return process.env.EUKOLIA_STARTUP_PROBE === '1';
}

/** The query the renderer reads to switch its own half of the probe on. */
export const STARTUP_PROBE_QUERY = 'eukolia-startup-probe';

/** Epoch values the profiler needs to place both timelines on one axis. */
export interface WallClock {
  /** `performance.timeOrigin` of the main process, in epoch milliseconds. */
  mainTimeOrigin: number;
  /** `performance.timeOrigin` of the renderer, in epoch milliseconds. */
  rendererTimeOrigin: number;
  /** Epoch milliseconds at which the window was shown. */
  windowShownAt: number | null;
}

interface Milestone {
  name: string;
  /** Milliseconds after this process started, as `performance.now()` reports it. */
  at: number;
  delta: number;
}

interface ResourceTiming {
  name: string;
  durationMs: number;
  transferSize: number;
  decodedBodySize: number;
}

const startedAt = performance.now();
const milestones: Milestone[] = [];
let lastAt = startedAt;
let reported = false;
let windowShownAt: number | null = null;

/**
 * Records the epoch time at which the window was shown.
 *
 * The one number that can be compared across the two processes: `performance.now()`
 * in the main process and in the renderer are measured from different origins, so
 * a renderer milestone means nothing to the main process's timeline — but
 * `performance.timeOrigin` is an epoch timestamp in both, and `Date.now()` is the
 * same clock. See `probeWallClock`.
 */
export function probeNoteWindowShown(): void {
  if (!isStartupProbeEnabled() || windowShownAt !== null) return;
  windowShownAt = Date.now();
}

/** The clock alignment the profiler needs to place both timelines on one axis. */
export function probeWallClock(): WallClock {
  return {
    mainTimeOrigin: performance.timeOrigin,
    // Filled in by the profiler from the renderer's own payload; the main process
    // cannot know it.
    rendererTimeOrigin: 0,
    windowShownAt
  };
}

export function probeMark(name: string): void {
  if (!isStartupProbeEnabled()) return;
  const at = performance.now();
  milestones.push({ name, at: Math.round(at * 10) / 10, delta: Math.round((at - lastAt) * 10) / 10 });
  lastAt = at;
}

/** The main process's timeline, in the same shape the renderer's payload uses. */
function mainProcessReport(): Record<string, unknown> {
  return {
    milestones,
    // `performance.timeOrigin` is the process's own epoch, so the two timelines
    // can be placed on one wall clock even though they start at different times.
    timeOrigin: performance.timeOrigin,
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    wallClockStart: Date.now() - performance.now(),
    totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
    userData: app.getPath('userData'),
    args: process.argv.slice(1),
    /**
     * Epoch milliseconds at which the window was shown, for the one measurement
     * that is comparable across the two processes: process start → the shell being
     * on screen.
     */
    windowShownAt,
    wallClock: probeWallClock()
  };
}

/**
 * Reads the document's own navigation timing plus the bundle's transfer sizes.
 *
 * `performance.getEntriesByType('resource')` is what says *why* the first paint
 * took as long as it did: a three-and-a-half megabyte entry script and a four
 * megabyte icon font are different problems from a slow parse, and the byte
 * counts are the only way to tell them apart from outside the renderer.
 */
const DOCUMENT_TIMING_SCRIPT = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const resources = performance.getEntriesByType('resource').map((entry) => ({
    name: entry.name,
    durationMs: Math.round(entry.duration * 10) / 10,
    transferSize: entry.transferSize || 0,
    decodedBodySize: entry.decodedBodySize || 0
  }));
  const paints = {};
  for (const entry of performance.getEntriesByType('paint')) paints[entry.name] = Math.round(entry.startTime * 10) / 10;
  return {
    timeOrigin: performance.timeOrigin,
    domInteractive: nav ? Math.round(nav.domInteractive * 10) / 10 : 0,
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd * 10) / 10 : 0,
    loadEventEnd: nav ? Math.round(nav.loadEventEnd * 10) / 10 : 0,
    responseEnd: nav ? Math.round(nav.responseEnd * 10) / 10 : 0,
    paints,
    resources,
    /*
     * Whether the window is on screen by the time the document is ready.
     *
     * This is the number the loading screen is about. The window used to be shown
     * only once the renderer had painted its first frame — after the entry bundle
     * had been fetched, parsed and evaluated — so at this point it did not exist
     * at all and the user was looking at nothing. Read here rather than inferred
     * from a main-process mark, because "the window was shown" and "the renderer
     * knows it is visible" are different claims and only the second one is what a
     * person experiences.
     */
    visibilityAtDomReady: document.visibilityState,
    bootScreenPresent: Boolean(document.getElementById('eukolia-boot'))
  };
})()`;

export interface ProbeComplete {
  main: Record<string, unknown>;
  renderer: Record<string, unknown> | null;
  document: Record<string, unknown> | null;
}

/**
 * Watches a window for the renderer's startup payload.
 *
 * The payload arrives as a console message rather than over IPC on purpose: it
 * has to work before `main.ts` has registered any handler, and it must not add a
 * channel to the frozen contract in `shared/ipc.ts` that only a profiler uses.
 */
export function attachStartupProbe(window: BrowserWindow, onComplete: (result: ProbeComplete) => void): void {
  if (!isStartupProbeEnabled()) return;

  startCpuProfile(window);

  let renderer: Record<string, unknown> | null = null;
  let documentTiming: Record<string, unknown> | null = null;
  let finishTimer: NodeJS.Timeout | null = null;

  // Collected as early as possible: the navigation timeline is still there
  // later, but the *paint* entries are only complete once the first frame has
  // been committed, and asking later is free.
  window.webContents.once('dom-ready', () => {
    probeMark('dom-ready');
    void window.webContents
      .executeJavaScript(DOCUMENT_TIMING_SCRIPT)
      .then((value) => {
        documentTiming = value as Record<string, unknown>;
        probeMark('document-timing');
      })
      .catch(() => {
        /* an early failure here is not worth failing the run for */
      });
  });

  /**
   * One line per renderer console message, forwarded to the profiler's stderr.
   *
   * A console message is the only thing that crosses the boundary here, so an
   * error the renderer logged while starting would otherwise be invisible: the
   * window looks idle and nothing says why. `--verbose` in the profiler prints
   * these.
   */
  window.webContents.on('console-message', (_event, level, message) => {
    if (process.env.EUKOLIA_STARTUP_VERBOSE !== '1') return;
    if (typeof message !== 'string' || message.startsWith(STARTUP_PROBE_PREFIX)) return;
    process.stderr.write(`[renderer:${level}] ${message.slice(0, 400)}\n`);
  });

  /**
   * With `EUKOLIA_STARTUP_PHASES=1`, the probe asks the live DOM what is on
   * screen at two moments: right after the report's own "the shell rendered"
   * point and again at the end.
   *
   * "The code ran" and "the window shows the shell" are different claims, and a
   * timeline cannot tell them apart — an effect that never fired and a tree that
   * never committed look identical in it. Reading the DOM twice is what separates
   * them, and it is the only way to tell whether the boot screen is still up.
   */
  const phaseTimers: NodeJS.Timeout[] = [];
  if (process.env.EUKOLIA_STARTUP_PHASES === '1') {
    const snapshot = async (label: string): Promise<void> => {
      try {
        const seen = (await window.webContents.executeJavaScript(`(() => ({
          boot: Boolean(document.getElementById('eukolia-boot')),
          bootDismissed: document.getElementById('eukolia-boot')?.getAttribute('data-dismissed') === 'true',
          bootFaded: Boolean(document.getElementById('eukolia-boot') && getComputedStyle(document.getElementById('eukolia-boot')).opacity !== '1'),
          bootStatus: document.getElementById('eukolia-boot-status')?.textContent ?? null,
          shell: Boolean(document.querySelector('[data-testid="tab-bar"]')),
          sidebar: Boolean(document.querySelector('[data-testid="sidebar-region"]')),
          statusBar: Boolean(document.querySelector('[data-testid="status-bar"]')),
          editor: Boolean(document.querySelector('.cm-editor')),
          visibility: document.visibilityState,
          rootChildren: document.getElementById('root')?.childElementCount ?? -1,
          text: (document.getElementById('root')?.textContent ?? '').slice(0, 90)
        }))()`)) as Record<string, unknown>;
        process.stderr.write(`[phases:${label}] ${JSON.stringify(seen)}\n`);
      } catch (error) {
        process.stderr.write(`[phases:${label}] failed: ${String(error)}\n`);
      }
    };
    // Early enough to catch the loading screen, and often enough to see the
    // hand-over happen rather than only its result.
    //
    // The window used to end at 3 200 ms, and on a 2 850-file project the editor is
    // still not mounted by then — the last snapshot read `editor: false` with the boot
    // screen saying "Restoring your project…", so the measurement stopped before the
    // thing being measured had happened. `EUKOLIA_STARTUP_PHASE_MS` overrides the list
    // while that boundary is being found.
    const phaseTimes = (process.env.EUKOLIA_STARTUP_PHASE_MS ?? '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
    const timers = phaseTimes.length > 0 ? phaseTimes : [250, 600, 1200, 2600, 3200, 4500, 6000, 8000, 10000];
    for (const at of timers) {
      phaseTimers.push(setTimeout(() => void snapshot(`${at}ms`), at));
    }
  }

  window.webContents.on('console-message', (_event, _level, message) => {
    if (typeof message !== 'string' || !message.startsWith(STARTUP_PROBE_PREFIX)) return;
    try {
      renderer = JSON.parse(message.slice(STARTUP_PROBE_PREFIX.length)) as Record<string, unknown>;
    } catch {
      renderer = { parseError: message.slice(0, 200) };
    }
    probeMark('renderer-report');
    // A short grace period so the document-timing promise (issued at `dom-ready`)
    // has landed before the report goes out.
    if (finishTimer) clearTimeout(finishTimer);
    /*
     * The grace period is also the measurement's end.
     *
     * It was 600 ms, chosen so the document-timing promise could land — and on a real
     * project that closes the run at "shell ready", *before* the editor mounts, so no
     * phase snapshot could ever report the editor and "project restoration" could not
     * be timed at all. `EUKOLIA_STARTUP_LINGER_MS` holds the run open so the later
     * phases are captured; the payload is unchanged.
     */
    const lingerMs = Number(process.env.EUKOLIA_STARTUP_LINGER_MS ?? 600) || 600;
    finishTimer = setTimeout(() => finish(), lingerMs);
  });

  function finish(): void {
    if (reported) return;
    reported = true;
    probeMark('report');
    void stopCpuProfile(window).then(() => {
      onComplete({ main: mainProcessReport(), renderer, document: documentTiming });
    });
  }

  window.once('ready-to-show', () => probeMark('ready-to-show'));
  window.once('show', () => probeMark('show'));
  window.webContents.once('did-finish-load', () => probeMark('did-finish-load'));
}

/**
 * Attaches the probe to one window of a profile run, and reports the whole run from
 * whichever window finishes first.
 *
 * The application opens a **library window** first and the editor window second, and
 * only the editor window builds a shell — so attaching to the first window alone
 * measured the launcher and then waited out its twenty-second timeout, reporting
 * `shell: false` and a restoration timeline that had never started. Every window is
 * attached now, the first one to report wins, and the payload says which window it
 * came from.
 *
 * `openWorkspace` names a project to open the moment that first window is ready,
 * which is what a profile of *restoring a project* has to do: the launcher does not
 * open anything until a person picks a library, and nothing else in a headless run
 * ever will.
 */
let runReported = false;

export function attachStartupProbeToRun(window: BrowserWindow, options: { openWorkspace?: string | null } = {}): void {
  if (!isStartupProbeEnabled()) return;

  if (options.openWorkspace) {
    window.webContents.once('did-finish-load', () => {
      /*
       * Late, deliberately — later than the library's own open.
       *
       * The request has to arrive after the surface has finished opening what it opens
       * for itself: a configured library puts its own root in the workspace as it
       * mounts, and a project request sent before that settles is replaced by it —
       * which is what left both this profiler and `probe-visual.mjs` reporting a
       * library window with `editor: false`. The delay is not a measurement; it is
       * "after the launcher has stopped moving", and `EUKOLIA_STARTUP_OPEN_DELAY_MS`
       * overrides it while that is being established.
       */
      const delayMs = Number(process.env.EUKOLIA_STARTUP_OPEN_DELAY_MS ?? 2000) || 2000;
      setTimeout(() => {
        if (window.isDestroyed()) return;
        window.webContents.send(IPC.protocol.openProject, options.openWorkspace);
      }, delayMs);
    });
  }

  attachStartupProbe(window, (result) => {
    if (runReported) return;
    runReported = true;
    process.stdout.write(`__EUKOLIA_STARTUP__${JSON.stringify({ ...result, window: 'first-to-report' })}\n`);
    setTimeout(() => app.exit(0), 80);
  });
}
