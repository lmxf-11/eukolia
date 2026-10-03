/**
 * Eukolia — startup profiler.
 *
 * Launches the real built application with `EUKOLIA_STARTUP_PROBE=1`, waits for it
 * to report, and prints the launch timeline: the main process's milestones, the
 * renderer's milestones, the document's navigation timings, what each resource
 * cost, the long tasks that blocked the main thread and the worst frame gap.
 *
 * Usage:
 *   npm run build && npm run profile:startup
 *   npm run profile:startup -- --runs 3 --json startup-report.json
 *   npm run profile:startup -- --workspace D:\path\to\project
 *
 * It never opens a folder unless `--workspace` names one: a profile of the cold
 * start with nothing remembered and a profile of restoring a large project are
 * two different measurements, and conflating them is how a startup number stops
 * meaning anything.
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index !== -1 && argv[index + 1] ? argv[index + 1] : fallback;
};

const runs = Math.max(1, Number(value('runs', '1')) || 1);
const jsonPath = value('json', path.join(projectRoot, 'startup-report.json'));
/** Keeps the user's real state out of the measurement unless asked otherwise. */
const useRealProfile = flag('use-profile');
/**
 * A project to restore, which is a different measurement from a cold start.
 *
 * With `--workspace <dir>` each run's fresh `userData` is seeded with a session
 * that names that folder, so the launch measures *restoring a project*: the tree
 * scan, root detection, the bibliography parses and the open buffers. Without it
 * the measurement is the window opening on nothing, which is the other half of
 * the launch and the one a first run always sees.
 */
const workspace = value('workspace', null);
const timeoutMs = Number(value('timeout', '120000')) || 120_000;

if (!existsSync(path.join(projectRoot, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing. Run `npm run build` first.');
  process.exit(2);
}

function resolveElectronBinary() {
  if (process.env.ELECTRON_BINARY && existsSync(process.env.ELECTRON_BINARY)) return process.env.ELECTRON_BINARY;
  try {
    const require = createRequire(import.meta.url);
    const fromModule = require('electron');
    if (typeof fromModule === 'string' && existsSync(fromModule)) return fromModule;
  } catch {
    /* fall through */
  }
  const candidates = [
    path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron')
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const electronBinary = resolveElectronBinary();
if (!electronBinary) {
  console.error('Could not locate the Electron binary. Run `npm install` first.');
  process.exit(7);
}

function runOnce(index) {
  return new Promise((resolve) => {
    /*
     * A profile run gets its own `userData` directory by default.
     *
     * Two reasons, and the second is the important one: settings and state are
     * read at startup, so a profile taken against a developer's real profile
     * measures *their* settings; and a run that leaves state behind makes the
     * next run measure a warm start, which is a different number that looks like
     * an improvement. `--use-profile` opts back in when the warm case is what is
     * being measured.
     *
     * Chromium's own `--user-data-dir` switch is used rather than an environment
     * variable, so the profiler needs no hook inside the application: the flag
     * moves `app.getPath('userData')` before any application code runs.
     */
    const userData = useRealProfile
      ? null
      : mkdtempSync(path.join(tmpdir(), `eukolia-profile-${index}-`));

    const switches = userData ? [`--user-data-dir=${userData}`] : [];
    if (userData && workspace) {
      /*
       * The library has to be configured as well as the session.
       *
       * With only `state.json` seeded, the application starts on its welcome screen —
       * "Choose a project library to keep your mathematics…" — because
       * `configuredLibraryRoot()` reads `project-library.json` and a fresh `userData`
       * has none. The run then measured a window that never opens a project, and the
       * probe waited out its twenty-second timeout: a "restore" number that described
       * nothing. The library root is the parent that holds `.eukolia` (the user's
       * settings and snippets), which `--library` overrides.
       */
      const library = value('library', null) ?? path.dirname(path.resolve(workspace));
      writeFileSync(
        path.join(userData, 'project-library.json'),
        `${JSON.stringify({ root: path.resolve(library) }, null, 2)}\n`,
        'utf8'
      );

      // The session the renderer will read: the workspace, and the files it had
      // open. Written before the process starts so `getState()` sees it on the
      // first call, which is what makes this a restore rather than a fresh open.
      const session = {
        workspacePath: path.resolve(workspace),
        openFiles: [],
        activeFile: null,
        rootFile: null
      };
      try {
        const mainFile = ['main.tex', 'paper.tex', 'thesis.tex', 'root.tex', 'document.tex']
          .map((name) => path.join(session.workspacePath, name))
          .find((candidate) => existsSync(candidate));
        if (mainFile) {
          session.openFiles = [mainFile];
          session.activeFile = mainFile;
        }
      } catch {
        /* the fixture may not have a conventional root; the scan is the point */
      }
      writeFileSync(path.join(userData, 'state.json'), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    }
    const cpuProfile = flag('cpu') ? path.join(projectRoot, '.scratch', `startup-cpu-${index}.cpuprofile`) : null;
    if (cpuProfile) {
      try {
        rmSync(cpuProfile, { force: true });
      } catch {
        /* nothing to remove */
      }
    }
    const child = spawn(electronBinary, ['.', ...switches], {
      cwd: projectRoot,
      env: {
        ...process.env,
        EUKOLIA_STARTUP_PROBE: '1',
        /*
         * Open the project from the main process, once the window is ready.
         *
         * A configured library shows its project list; it does not open anything until
         * a person clicks. `EUKOLIA_STARTUP_OPEN_WORKSPACE` sends the same
         * `protocol:openProject` request the library's own list sends, so a profile run
         * reaches the editor without a hand on the mouse — which is the only way a
         * restoration timeline can be measured at all.
         */
        ...(workspace ? { EUKOLIA_STARTUP_OPEN_WORKSPACE: path.resolve(workspace) } : {}),
        ...(flag('verbose') ? { EUKOLIA_STARTUP_VERBOSE: '1' } : {}),
        ...(flag('phases') ? { EUKOLIA_STARTUP_PHASES: '1' } : {}),
        ...(cpuProfile ? { EUKOLIA_STARTUP_CPU_PROFILE: '1', EUKOLIA_STARTUP_CPU_PROFILE_PATH: cpuProfile } : {}),
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, error: `timed out after ${timeoutMs} ms`, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const line = stdout
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith('__EUKOLIA_STARTUP__'))
        .pop();
      if (!line) {
        resolve({ ok: false, error: 'no startup payload was produced', stdout: stdout.slice(-2000), stderr: stderr.slice(-8000) });
        return;
      }
      try {
        resolve({ ok: true, payload: JSON.parse(line.slice('__EUKOLIA_STARTUP__'.length)), stderr });
      } catch (error) {
        resolve({ ok: false, error: `could not parse the payload: ${error.message}` });
      }
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `could not launch Electron: ${error.message}` });
    });
  });
}

/** One row of the printed table. */
function renderRun(payload, index) {
  const main = payload.main ?? {};
  const renderer = payload.renderer ?? {};
  const doc = payload.document ?? {};
  const rendererMilestones = renderer.milestones ?? [];
  /*
   * The two numbers the whole exercise is about.
   *
   * `shell:render#<n>` is reported by the shell for every pass it makes, so the
   * *first* one is the moment the window stops showing the boot screen — which is
   * the claim being optimised — and later ones are re-renders that must not be
   * mistaken for it.
   */
  const firstShellRender = rendererMilestones.find((m) => m.name.startsWith('shell:render#'));
  const stateReady = rendererMilestones.find((m) => m.name === 'state:ready');
  const firstBootRender = rendererMilestones.find((m) => m.name.startsWith('shell:boot-render#'));
  /**
   * The one measurement that spans both processes, in epoch milliseconds.
   *
   * `performance.now()` in the renderer is measured from the navigation start and
   * in the main process from its own start, so a renderer milestone cannot be
   * placed on the process's timeline without an anchor. `performance.timeOrigin`
   * is that anchor and it is an epoch timestamp in both processes, so
   * `main.timeOrigin + rendererMs` is an epoch time too — and subtracting the
   * main process's own origin gives "milliseconds after the process started",
   * which is what a person waiting for the application experiences.
   */
  const rendererOrigin = renderer.timeOrigin ?? 0;
  const mainOrigin = main.timeOrigin ?? 0;
  /** Epoch milliseconds at which the shell first had a real frame. */
  const shellEpoch = rendererOrigin && firstShellRender ? rendererOrigin + firstShellRender.at : null;
  const shownAt = main.windowShownAt ?? null;
  return {
    index: index + 1,
    ok: true,
    /** Milliseconds from navigation start to the first shell paint. */
    shellVisibleMs: firstShellRender?.at ?? null,
    /** Milliseconds from `executable start` to the shell being on screen. */
    processToShellMs:
      shellEpoch !== null && main.timeOrigin ? Math.round((shellEpoch - main.timeOrigin) * 10) / 10 : null,
    /** Milliseconds from `executable start` to a window being on screen at all. */
    processToWindowMs:
      shownAt !== null && main.timeOrigin ? Math.round((shownAt - main.timeOrigin) * 10) / 10 : null,
    /** Milliseconds from navigation start to the loading screen's own first render. */
    bootVisibleMs: firstBootRender?.at ?? null,
    /** Milliseconds from navigation start to the readiness flag. */
    stateReadyMs: stateReady?.at ?? null,
    main: { milestones: main.milestones ?? [], timeOrigin: main.timeOrigin, totalMs: main.totalMs },
    renderer: {
      milestones: rendererMilestones,
      longTasks: renderer.longTasks ?? [],
      worstFrameGapMs: renderer.worstFrameGapMs ?? 0,
      frameCount: renderer.frameCount ?? 0,
      totalMs: renderer.totalMs ?? 0
    },
    document: {
      domInteractive: doc.domInteractive ?? 0,
      domContentLoaded: doc.domContentLoaded ?? 0,
      loadEventEnd: doc.loadEventEnd ?? 0,
      responseEnd: doc.responseEnd ?? 0,
      paints: doc.paints ?? {},
      visibilityAtDomReady: doc.visibilityAtDomReady ?? null,
      bootScreenPresent: doc.bootScreenPresent ?? null
    },
    resources: (doc.resources ?? [])
      .slice()
      .sort((a, b) => b.decodedBodySize - a.decodedBodySize)
      .slice(0, 12)
  };
}

function describe(run) {
  const lines = [];
  lines.push(`── run ${run.index} ${'─'.repeat(58)}`);
  lines.push(`  window on screen     ${run.processToWindowMs ?? '—'} ms after process start`);
  lines.push(`  shell on screen      ${run.processToShellMs ?? '—'} ms after process start   (${run.shellVisibleMs ?? '—'} ms after navigation start)`);
  lines.push(`  loading screen       ${run.bootVisibleMs ?? '—'} ms after navigation start`);
  lines.push(`  shell ready          ${run.stateReadyMs ?? '—'} ms after navigation start`);
  lines.push(`  window at dom-ready  ${run.document.visibilityAtDomReady ?? '—'}   (loading screen present: ${run.document.bootScreenPresent ?? '—'})`);
  lines.push('  main process  (ms after the process started)');
  for (const milestone of run.main.milestones) {
    lines.push(`    ${String(milestone.at).padStart(9)}  +${String(milestone.delta).padStart(8)}  ${milestone.name}`);
  }
  lines.push('  renderer  (ms after navigation start)');
  for (const milestone of run.renderer.milestones) {
    lines.push(`    ${String(milestone.at).padStart(9)}  +${String(milestone.delta).padStart(8)}  ${milestone.name}`);
  }
  lines.push('  document');
  lines.push(`    ${String(run.document.responseEnd).padStart(9)}           response end`);
  lines.push(`    ${String(run.document.domInteractive).padStart(9)}           dom interactive`);
  lines.push(`    ${String(run.document.domContentLoaded).padStart(9)}           dom content loaded`);
  lines.push(`    ${String(run.document.loadEventEnd).padStart(9)}           load event end`);
  for (const [name, at] of Object.entries(run.document.paints)) {
    lines.push(`    ${String(at).padStart(9)}           paint ${name}`);
  }
  if (run.resources.length > 0) {
    lines.push('  largest resources');
    for (const resource of run.resources) {
      const name = resource.name.replace(/^.*[\\/]/, '');
      lines.push(
        `    ${String(Math.round(resource.decodedBodySize / 1024)).padStart(7)} KB  ${String(resource.durationMs).padStart(8)} ms  ${name}`
      );
    }
  }
  if (run.renderer.longTasks.length > 0) {
    lines.push('  long tasks (>50 ms)');
    for (const task of run.renderer.longTasks) {
      lines.push(`    ${String(task.durationMs).padStart(9)} ms  at ${task.at} ms`);
    }
  }
  lines.push(`  worst frame gap      ${run.renderer.worstFrameGapMs} ms over ${run.renderer.frameCount} frames`);
  return lines.join('\n');
}

const results = [];
const rendererLogs = [];
for (let index = 0; index < runs; index++) {
  const result = await runOnce(index);
  if (!result.ok) {
    console.error(`run ${index + 1} failed: ${result.error}`);
    if (result.stdout) console.error('stdout tail:\n' + result.stdout);
    if (result.stderr) console.error('stderr tail:\n' + result.stderr);
    process.exit(1);
  }
  for (const line of (result.stderr ?? '').split(/\r?\n/)) {
    if (line.startsWith('[renderer:')) rendererLogs.push(line);
    if (line.startsWith('[phases:')) rendererLogs.push(line);
  }
  results.push(renderRun(result.payload, index));
}

for (const run of results) console.log(describe(run));

if (rendererLogs.length > 0) {
  console.log('\nrenderer console (errors and warnings during the launch)');
  for (const line of [...new Set(rendererLogs)].slice(0, 25)) console.log(`  ${line}`);
}

try {
  writeFileSync(jsonPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), useRealProfile, runs: results }, null, 2)}\n`, 'utf8');
  console.log(`\nreport written to ${jsonPath}`);
} catch (error) {
  console.error(`could not write ${jsonPath}: ${error.message}`);
}
