/**
 * Eukolia — application smoke test.
 *
 * Launches the **real** Electron main process against the built renderer bundle,
 * opens a real LaTeX project through the real `eukolia://` protocol path, and
 * probes the live DOM. This is the end-to-end check the unit tests cannot give:
 * it proves the merged subsystems actually start and cooperate.
 *
 * Usage: node scripts/smoke-electron.mjs
 *   npm run smoke          (after `npm run build`)
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

/**
 * Resolve the real Electron executable.
 *
 * Node 24 refuses to spawn a `.cmd` shim without a shell, and going through a
 * shell mangles the arguments, so the binary is located directly.
 */
function resolveElectronBinary() {
  if (process.env.ELECTRON_BINARY && existsSync(process.env.ELECTRON_BINARY)) {
    return process.env.ELECTRON_BINARY;
  }
  try {
    const require = createRequire(import.meta.url);
    const fromModule = require('electron');
    if (typeof fromModule === 'string' && existsSync(fromModule)) return fromModule;
  } catch {
    /* fall through to the well-known location */
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

// `--allow-missing-pdf` downgrades the PDF-viewer steps to "skipped" when the
// native worker has not been built, so the other surfaces can still be verified
// while the native engine is being rebuilt.
const allowMissingPdf = process.argv.includes('--allow-missing-pdf');

/*
 * Delete any previous report before launching. Without this, a run that dies
 * before producing a payload leaves the *previous* report in place and the next
 * reader silently analyses stale numbers — which is exactly the confusion this
 * file exists to prevent.
 */
const reportPath = path.join(projectRoot, 'smoke-report.json');
try {
  rmSync(reportPath, { force: true });
} catch {
  /* nothing to remove */
}

const launchArgs = electronBinary.toLowerCase().endsWith('eukolia.exe') ? [] : ['.'];
const child = spawn(electronBinary, launchArgs, {
  cwd: projectRoot,
  env: {
    ...process.env,
    EUKOLIA_SMOKE_PROBE: '1',
    EUKOLIA_SMOKE_WORKSPACE: process.env.EUKOLIA_SMOKE_WORKSPACE ?? path.join(projectRoot, 'tests', 'smoke', 'fixture'),
    EUKOLIA_SMOKE_ALLOW_MISSING_PDF: allowMissingPdf ? '1' : '0',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

/**
 * The probe walks every surface — Code Mode, Visual Mode, the aligner, snippets,
 * a real latexmk build, diagnostics, SyncTeX, the PDF viewer, the custom title
 * bar, the tab switcher and a real shell — and waits on wall-clock delays between
 * most steps, so the total is dominated by those waits rather than by anything
 * variable. 420 s was enough until the viewer's keyboard, the terminal and the
 * title bar were added; the cap is raised rather than trimming the waits, because
 * trimming them is what makes the probe flaky.
 */
/** How long the whole probe may take before the run is abandoned. */
const SMOKE_TIMEOUT_MS =
  Number(process.env.EUKOLIA_SMOKE_TIMEOUT_MS) > 0
    ? Number(process.env.EUKOLIA_SMOKE_TIMEOUT_MS)
    : 700_000;
const timeout = setTimeout(() => {
  // The buffers are printed before exiting: on a timeout they are the only
  // evidence of how far the probe got, and discarding them turns "it hung" into
  // an unanswerable question.
  console.error(`Smoke test timed out after ${SMOKE_TIMEOUT_MS / 1000} s.`);
  if (stdout.trim()) console.error('stdout so far:\n' + stdout.slice(-4000));
  if (stderr.trim()) console.error('stderr so far:\n' + stderr.slice(-4000));
  child.kill();
  process.exit(3);
}, SMOKE_TIMEOUT_MS);

child.on('close', (code, signal) => {
  clearTimeout(timeout);

  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('__EUKOLIA_PROBE__'))
    .pop();

  if (!line) {
    console.error(`No probe payload was produced (exit=${code}, signal=${signal ?? 'none'}).`);
    console.error('stdout tail:', stdout.slice(-1500));
    console.error('stderr tail:', stderr.slice(-2500));
    process.exit(4);
  }

  let payload;
  try {
    payload = JSON.parse(line.slice('__EUKOLIA_PROBE__'.length));
  } catch (error) {
    console.error('Could not parse the probe payload:', error.message);
    process.exit(5);
  }

  // The report is also written to a file: Electron's stdout is not reliably
  // flushed when this script's own output is piped, so the file is the
  // authoritative record and the console copy is a convenience.
  try {
    writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error('Could not write the smoke report:', error.message);
  }

  // The probe's step trace goes to stderr. It is printed even on success,
  // because "which steps ran, and in what order" is the first question a
  // surprising result raises and the payload does not answer it.
  const steps = stderr
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('[smoke] step:'));
  if (steps.length > 0) {
    console.error(steps.map((entry) => entry.replace('[smoke] step: ', '  · ')).join('\n'));
  }

  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.ok ? 0 : 1);
});

child.on('error', (error) => {
  clearTimeout(timeout);
  console.error('Failed to launch Electron:', error.message);
  process.exit(6);
});



