/**
 * Eukolia — visual-editor appearance probe.
 *
 * Boots the **real** application against the built renderer and reports what the
 * live visual editor actually paints: the faces its text resolves to, whether the
 * vendored icon glyphs render, and what the mathematics produced. The questions
 * are about measured appearance, so they can only be answered here — jsdom
 * performs no layout and no CSS cascade.
 *
 * Usage: node scripts/probe-visual.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

if (!existsSync(path.join(projectRoot, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing. Run `npm run build` first.');
  process.exit(2);
}

function resolveElectronBinary() {
  if (process.env.ELECTRON_BINARY && existsSync(process.env.ELECTRON_BINARY)) {
    return process.env.ELECTRON_BINARY;
  }
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
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

const electronBinary = resolveElectronBinary();
if (!electronBinary) {
  console.error('Could not locate the Electron binary. Run `npm install` first.');
  process.exit(7);
}

/**
 * The workspace the probe reads. A scratch copy of the fixture, so the probe's
 * own document never lands in the repository's fixture.
 *
 * `EUKOLIA_PROBE_DOCUMENT` points the probe at a real project instead, and then the
 * workspace is that project's own directory: the probe opens the document and never
 * writes to it, and a report about scrolling on a real paper needs a real paper.
 *
 * `EUKOLIA_PROBE_WORKSPACE` separates the two, which a document inside a chapter
 * needs: the document's own directory is the chapter's `include/` folder, and opening
 * *that* as the project left the application in its project-library window instead of
 * the editor — `visualEditorMounted: false`, and a probe that reports nothing. The
 * workspace is what the application opens a project from; the document is what it
 * opens in the editor, and they are not always the same directory.
 */
const documentOverride = process.env.EUKOLIA_PROBE_DOCUMENT;
const workspaceOverride = process.env.EUKOLIA_PROBE_WORKSPACE;
const workspace = workspaceOverride
  ? workspaceOverride
  : documentOverride
    ? path.dirname(documentOverride)
    : path.join(projectRoot, '.scratch', 'visual-probe-workspace');

if (workspaceOverride && !existsSync(workspaceOverride)) {
  console.error(`EUKOLIA_PROBE_WORKSPACE does not exist: ${workspaceOverride}`);
  process.exit(4);
}

if (!documentOverride) {
  rmSync(workspace, { recursive: true, force: true });
  const fixture = path.join(projectRoot, 'tests', 'smoke', 'fixture');
  if (existsSync(fixture)) {
    const { cpSync } = await import('node:fs');
    cpSync(fixture, workspace, { recursive: true });
  } else {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(workspace, { recursive: true });
  }
} else {
  if (!existsSync(documentOverride)) {
    console.error(`EUKOLIA_PROBE_DOCUMENT does not exist: ${documentOverride}`);
    process.exit(3);
  }
  console.log(`probing a real document: ${documentOverride}`);
}

const reportPath = path.join(projectRoot, 'visual-probe.json');
rmSync(reportPath, { force: true });

/*
 * The application runs a probe in its own `userData` directory, and the shell it
 * drives does not exist until a project library does — so the *main process* seeds
 * one (`seedVisualProbeLibrary` in `src/main/main.ts`), exactly as `seedSmokeLibrary`
 * does for the smoke probe. `EUKOLIA_PROBE_DOCUMENT` is what it seeds from, so
 * pointing this probe at a real paper is enough to reach the editor; the earlier
 * version of this script tried to seed a profile itself and the application's own
 * `app.setPath('userData', …)` overrode it, leaving the run reporting
 * `visualEditorMounted: false` on the welcome screen.
 */
const child = spawn(electronBinary, ['.'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    EUKOLIA_CARET_PROBE: '1',
    EUKOLIA_SMOKE_WORKSPACE: workspace,
    ...(documentOverride ? { EUKOLIA_PROBE_DOCUMENT: documentOverride } : {}),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => {
  stdout += chunk.toString();
});
child.stderr.on('data', chunk => {
  stderr += chunk.toString();
});

/*
 * The probe measures by waiting: it lets widgets typeset, scrolls the document
 * several times from the top, and walks every line of the file it was pointed at.
 * On a 189-line paper that is a few minutes of deliberate settling, and the first
 * default here — two minutes — began cutting it off part-way, which shows up as
 * "no payload" rather than as a partial report. `EUKOLIA_PROBE_TIMEOUT_MS` raises
 * it further for a longer document.
 */
const timeoutMs = Number(process.env.EUKOLIA_PROBE_TIMEOUT_MS) > 0
  ? Number(process.env.EUKOLIA_PROBE_TIMEOUT_MS)
  : 360_000;

const timer = setTimeout(() => {
  console.error(`Probe did not finish within ${timeoutMs / 1000}s; killing it.`);
  child.kill();
}, timeoutMs);

child.on('exit', code => {
  clearTimeout(timer);
  const marker = stdout.indexOf('__EUKOLIA_VISUAL_PROBE__');
  if (marker < 0) {
    console.error(`Probe produced no payload (exit ${code}).`);
    if (stdout.trim()) console.error('stdout:\n' + stdout.slice(-4000));
    if (stderr.trim()) console.error('stderr:\n' + stderr.slice(-4000));
    process.exit(1);
  }
  const payload = JSON.parse(stdout.slice(marker + '__EUKOLIA_VISUAL_PROBE__'.length).split('\n')[0]);
  writeFileSync(reportPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
});
