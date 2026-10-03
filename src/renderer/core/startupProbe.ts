/**
 * Eukolia — startup profiler.
 *
 * Launching with `EUKOLIA_STARTUP_PROBE=1` (`npm run profile:startup`) turns this
 * on: the renderer records a milestone at every stage of the launch and, once the
 * shell has settled, prints one JSON payload that the main process forwards to
 * the profiler's stdout.
 *
 * Why it exists at all: "startup feels slow" is not a measurement. Every claim
 * about the launch sequence — which step dominates, what a change bought — has to
 * come from numbers taken in the real application, because the interesting parts
 * (module evaluation, the first paint, the project scan behind an IPC round trip)
 * cannot be reproduced in a test runner. This is the same discipline the PDF
 * viewer's measurements follow (`ARCHITECTURE.md` §3.6).
 *
 * Two properties keep it honest:
 *
 *  - **It is inert unless asked for.** `enabled` is false in a normal run, and
 *    every function below then does nothing beyond one boolean test. Nothing is
 *    observed, nothing is retained, no payload is produced.
 *  - **Its timeline is the renderer's own.** `performance.now()` is measured from
 *    the navigation start, so a milestone's value is "this many milliseconds after
 *    the renderer began", which is comparable between runs regardless of how long
 *    the main process took to reach `ready`.
 */

/**
 * The console prefix the main process looks for.
 *
 * Written out in both halves of the profiler rather than imported across the
 * main/renderer boundary: the renderer is deliberately free of main-process code
 * (and vice versa — see `ARCHITECTURE.md` §2), and a shared constant is not worth
 * breaking that. Changing it means changing both, which is why the string itself
 * names the marker it is.
 */
export const STARTUP_PROBE_PREFIX = '__EUKOLIA_STARTUP__';

/** How long the probe waits after `ready` before reporting. */
const SETTLE_MS = 2500;

/** Long tasks are only interesting if they are long enough to drop a frame. */
const LONG_TASK_MS = 50;

/** A named point on the startup timeline. */
export interface StartupMilestone {
  name: string;
  /** Milliseconds after the renderer's navigation start. */
  at: number;
  /** Milliseconds after the previous milestone. */
  delta: number;
  /** `visibilityState`/focus when the mark ran, which attributes a long gap. */
  detail: string;
}

export interface StartupPayload {
  kind: 'startup';
  /** The renderer's own epoch, for correlating with the main process. */
  timeOrigin: number;
  url: string;
  milestones: StartupMilestone[];
  /** Long tasks observed while starting, worst first. */
  longTasks: Array<{ at: number; durationMs: number }>;
  /** Longest gap between two animation frames during startup. */
  worstFrameGapMs: number;
  /** How many animation frames were observed while starting. */
  frameCount: number;
  /** Every `performance` measure the renderer recorded, for the detail behind a milestone. */
  measures: Array<{ name: string; startMs: number; durationMs: number }>;
  /** Wall-clock milliseconds from the module's first statement to the report. */
  totalMs: number;
}

function probeRequested(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as { __eukoliaStartupMarks?: unknown }).__eukoliaStartupMarks) return true;
  try {
    return new URLSearchParams(window.location.search).get('eukolia-startup-probe') === '1';
  } catch {
    return false;
  }
}

export const startupProbeEnabled: boolean = probeRequested();

/**
 * The marks `eukolia-boot.js` recorded before this module existed.
 *
 * They are the head of the timeline — the document's own start and
 * `DOMContentLoaded` — and are merged in ahead of everything this file records,
 * in the order they happened.
 */
const earlyMilestones: StartupMilestone[] =
  (typeof window === 'undefined'
    ? undefined
    : (window as { __eukoliaStartupMarks?: StartupMilestone[] }).__eukoliaStartupMarks)?.slice() ?? [];

const milestones: StartupMilestone[] = [...earlyMilestones];
const longTasks: Array<{ at: number; durationMs: number }> = [];
let lastMarkAt = 0;
let reporting = false;
let worstFrameGapMs = 0;
let frameCount = 0;
let firstFrameAt = 0;
let startedAt = 0;
let lastFrameAt = 0;

if (startupProbeEnabled) {
  startedAt = performance.now();
  lastMarkAt = startedAt;

  // A long task is the renderer's own main thread being unavailable to input —
  // which is exactly what "the window did not respond" means — so the profiler
  // reports them individually rather than only as a total.
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= LONG_TASK_MS) {
          longTasks.push({ at: Math.round(entry.startTime * 10) / 10, durationMs: Math.round(entry.duration * 10) / 10 });
        }
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* not every Chromium build exposes longtask; the rest of the probe still works */
  }

  // The frame gap is the other half of it: a long task that lands between two
  // frames costs a dropped frame, and that is what a person actually sees.
  const tick = (): void => {
    const now = performance.now();
    if (firstFrameAt === 0) {
      firstFrameAt = now;
    } else {
      worstFrameGapMs = Math.max(worstFrameGapMs, now - lastFrameAt);
    }
    lastFrameAt = now;
    frameCount++;
    if (!reporting) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Records a milestone. Cheap enough to leave in a hot path: a boolean test and an
 * array push when the probe is on, a boolean test when it is off.
 */
export function startupMark(name: string): void {
  if (!startupProbeEnabled) return;
  const at = performance.now();
  const detail = `${document.visibilityState}/${document.hasFocus() ? 'focused' : 'blurred'}`;
  milestones.push({
    name,
    at: Math.round(at * 10) / 10,
    delta: Math.round((at - lastMarkAt) * 10) / 10,
    detail
  });
  lastMarkAt = at;
  // A mark records *when the renderer got to it*, not when the work it describes
  // finished: a task that is queued behind a long one lands late, and a timer in a
  // hidden frame lands later still. The visibility and focus state beside it is
  // what says which of those a gap was.
  console.log(`[startup] ${name} +${Math.round(at)}ms ${detail}`);
}

/** Times one async step and records it as a milestone. */
export async function startupMeasure<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (!startupProbeEnabled) return work();
  const before = performance.now();
  try {
    return await work();
  } finally {
    performance.mark(`${name}:end`);
    performance.measure(name, { start: before, end: performance.now() });
    startupMark(name);
  }
}

export function startupPayload(): StartupPayload {
  const measures: StartupPayload['measures'] = [];
  if (startupProbeEnabled) {
    for (const entry of performance.getEntriesByType('measure')) {
      measures.push({
        name: entry.name,
        startMs: Math.round(entry.startTime * 10) / 10,
        durationMs: Math.round(entry.duration * 10) / 10
      });
    }
  }
  return {
    kind: 'startup',
    timeOrigin: performance.timeOrigin,
    url: typeof location === 'undefined' ? '' : location.href,
    milestones,
    longTasks: [...longTasks].sort((a, b) => b.durationMs - a.durationMs).slice(0, 12),
    worstFrameGapMs: Math.round(worstFrameGapMs * 10) / 10,
    frameCount,
    measures,
    totalMs: Math.round((performance.now() - startedAt) * 10) / 10
  };
}

/**
 * Reports once the shell has settled.
 *
 * `ready` is called by the application state when the editor shell is showing;
 * the probe waits `SETTLE_MS` more so the report covers the secondary services
 * that load *after* first paint — which is the whole point of separating them —
 * rather than stopping the moment the window becomes visible.
 */
export function startupReport(reason: string): void {
  if (!startupProbeEnabled || reporting) return;
  reporting = true;
  startupMark(`report:${reason}`);
  const payload = startupPayload();
  // The prefix is what the main process forwards to the profiler's stdout;
  // Electron's own stdout is not reliably flushed, so the JSON goes out in one
  // line and the consumer treats a missing line as a failure rather than as a
  // zero.
  console.log(`${STARTUP_PROBE_PREFIX}${JSON.stringify(payload)}`);
}

/**
 * Arms the automatic report. Called by the renderer entry point, so a probe run
 * that never reaches `ready` still reports what it managed to do — a startup that
 * hangs is a result, not a reason to produce nothing.
 */
export function installStartupReport(): void {
  if (!startupProbeEnabled) return;
  const hardStop = window.setTimeout(() => {
    startupMark('report:timeout');
    startupReport('timeout');
  }, 20000);
  reportTimers.push(hardStop);
  // The first paint is the milestone the whole file exists to measure: it is
  // when the user stops looking at a blank window.
  requestAnimationFrame(() => {
    startupMark('first-frame');
    requestAnimationFrame(() => startupMark('second-frame'));
  });
}

const reportTimers: number[] = [];

/** Schedules the settled report. Called once the shell is interactive. */
export function scheduleStartupReport(): void {
  if (!startupProbeEnabled) return;
  for (const timer of reportTimers) clearTimeout(timer);
  reportTimers.length = 0;
  reportTimers.push(window.setTimeout(() => startupReport('settled'), SETTLE_MS));
}
