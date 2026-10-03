/**
 * Auxiliary-window probe — is the Settings / Snippet Library window right?
 *
 * Both are renderers of their own, so neither can be reached by a probe of the
 * main window: the shortcut editor's rows, the settings rail, the snippet list
 * and the pane split all live behind a window that the main probe never opens.
 * And both are where a UI *regression* is easiest to miss, because a window that
 * is blank, unstyled or sized to nothing still launches without error.
 *
 * What it answers, per window:
 *
 *  - **Does the content fit the window?** The measured box of the pane against
 *    the window's own viewport, at whatever size the window happens to be. A
 *    layout that only looks right at one width is the defect this is for.
 *  - **Is the content there?** The keyboard-shortcut editor's row count is the
 *    specific one: it reads its rows from a registry the *shell* populates, in
 *    another process, so zero rows is a wiring failure rather than an empty
 *    application.
 *  - **What does it look like?** A screenshot of each window, and one of the
 *    region under test.
 *
 * Usage: node scripts/probe-windows.mjs
 */
import { spawn } from 'node:child_process';
import fs, { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  if (process.env.ELECTRON_BINARY && existsSync(process.env.ELECTRON_BINARY)) return process.env.ELECTRON_BINARY;
  try {
    const require = createRequire(import.meta.url);
    const resolved = require('electron');
    if (typeof resolved === 'string' && existsSync(resolved)) return resolved;
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
  console.error('Could not locate the Electron binary.');
  process.exit(7);
}

const PORT = Number(process.env.EUKOLIA_WINDOW_PROBE_PORT ?? 9340);
const scratch = path.join(projectRoot, '.scratch');
mkdirSync(scratch, { recursive: true });

/*
 * A throwaway profile, and the reason is not tidiness.
 *
 * This probe used to launch against the default user-data directory, which is
 * whatever profile the machine has — and on this machine that is the *running,
 * packaged application's*, with its own lock. Electron's single-instance
 * behaviour then made this run a second instance of something already running:
 * the process started, DevTools listened, and no window ever appeared, which
 * reads exactly like "the application no longer boots".
 *
 * So the profile is seeded here the way `probe-chrome.mjs` and
 * `probe-tabjoin.mjs` seed theirs: enough project library to get past the gate,
 * so the shell comes up and can open the two windows this probe is about. It is
 * deleted and rebuilt every run, so nothing accumulates and no run can be
 * affected by the last one.
 */
const USER_DATA = path.join(scratch, 'windows-profile');
const LIBRARY = path.join(scratch, 'windows-library');

fs.rmSync(USER_DATA, { recursive: true, force: true });
fs.rmSync(LIBRARY, { recursive: true, force: true });
fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(path.join(LIBRARY, '.eukolia'), { recursive: true });

const project = path.join(LIBRARY, 'probe project');
fs.mkdirSync(project, { recursive: true });
const mainTex = path.join(project, 'main.tex');
fs.writeFileSync(
  mainTex,
  ['\\documentclass{article}', '\\begin{document}', 'Probe.', '\\end{document}', ''].join('\n'),
  'utf8'
);

fs.writeFileSync(path.join(USER_DATA, 'project-library.json'), JSON.stringify({ root: LIBRARY }, null, 2), 'utf8');
fs.writeFileSync(
  path.join(USER_DATA, 'state.json'),
  JSON.stringify(
    {
      workspacePath: project,
      openFiles: [mainTex],
      activeFile: mainTex,
      rootFile: mainTex,
      layout: 'split',
      editorMode: 'code',
      sidebarVisible: true,
      sidebarWidth: 260,
      pdfVisible: false,
      pdfPath: null,
      pdfPage: 1,
      pdfZoom: 1,
      theme: 'dark',
      recentWorkspaces: [],
      unsavedBuffers: {}
    },
    null,
    2
  ),
  'utf8'
);

const child = spawn(electronBinary, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
  cwd: projectRoot,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.method) return;
      const resolver = this.pending.get(message.id);
      if (!resolver) return;
      this.pending.delete(message.id);
      resolver(message);
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => {
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: timed out`));
      }, 30_000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) return { __error: result.exceptionDetails.text ?? 'threw' };
    return result.result?.value;
  }
}

async function targets() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
      if (list.some((target) => target.type === 'page')) return list;
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  return [];
}

async function attach(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return cdp;
}

/** The window's own URL, so a target can be told apart from the shell. */
function windowKind(target) {
  const url = target.url ?? '';
  if (url.includes('window=snippets')) return 'snippets';
  if (url.includes('window=settings')) return 'settings';
  return 'shell';
}

/**
 * What the window measures.
 *
 * `overflows` is the load-bearing number: a pane wider or taller than the
 * viewport it is in means the layout was sized for some other window, which is
 * exactly the "does not adjust to the window size" report.
 */
const MEASURE = `(() => {
  const box = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left)
    };
  };
  const viewport = { width: window.innerWidth, height: window.innerHeight };

  const settings = document.querySelector('.eu-settings');
  const snippets = document.querySelector('.eu-snippets');
  const shortcutRows = document.querySelectorAll('.eu-settings__shortcut-row').length;
  const snippetRows = document.querySelectorAll('[data-testid^="snippet-row"], .eu-snippets__row').length;
  const firstRow = document.querySelector('.eu-settings__shortcut-row');
  const categories = document.querySelectorAll('.eu-settings__category').length;

  /*
   * The auxiliary windows' own title bar.
   *
   * These windows are frameless and the platform's window-control overlay is not
   * configured for them any more, so this bar draws its own three buttons — and it
   * used to reserve 140px of empty space on Windows for an overlay that was never
   * painted there. The reservation showing up as a gap in rightGap is the whole
   * point of measuring it: the buttons have to end at the window's right edge.
   *
   * No backticks in this comment: it lives inside a template literal.
   */
  const titleBar = document.querySelector('.eu-title-bar');
  const titleControls = document.querySelector('.eu-standalone-title__controls');
  const titleButtons = titleControls ? titleControls.querySelectorAll('.eu-window-button') : [];
  const barRect = titleBar ? titleBar.getBoundingClientRect() : null;
  const controlsRect = titleControls ? titleControls.getBoundingClientRect() : null;
  const brand = document.querySelector('.eu-standalone-title__brand');
  const brandRect = brand ? brand.getBoundingClientRect() : null;

  return {
    kind: new URLSearchParams(location.search).get('window') ?? 'shell',
    titleBar: barRect
      ? {
          width: Math.round(barRect.width),
          height: Math.round(barRect.height),
          top: Math.round(barRect.top),
          // A second bar in the tree would mean querySelector picked one of two,
          // which is a different diagnosis from a layout that is wrong.
          count: document.querySelectorAll('.eu-title-bar').length,
          buttons: titleButtons.length,
          buttonNames: Array.from(titleButtons).map((button) => button.getAttribute('title')),
          rightGap: controlsRect ? Math.round(barRect.right - controlsRect.right) : null,
          controlsRight: controlsRect ? Math.round(controlsRect.right) : null,
          brand: brandRect ? { width: Math.round(brandRect.width), right: Math.round(brandRect.right) } : null,
          /*
           * The flex facts, because the box alone cannot say which rule won.
           *
           * A brand that did not grow reads identically whether its flex was never
           * applied or was overridden, and the two have different fixes.
           *
           * No backticks and no dollar-brace in this comment or the expressions
           * below: this whole block is itself a template literal.
           */
          brandFlex: brand
            ? [getComputedStyle(brand).flexGrow, getComputedStyle(brand).flexShrink, getComputedStyle(brand).flexBasis].join(' ')
            : null,
          barFlex: titleBar
            ? [getComputedStyle(titleBar).flexGrow, getComputedStyle(titleBar).flexShrink, getComputedStyle(titleBar).flexBasis].join(' ')
            : null,
          barJustify: titleBar ? getComputedStyle(titleBar).justifyContent : null,
          parent: titleBar.parentElement
            ? {
                tag: titleBar.parentElement.tagName.toLowerCase(),
                width: Math.round(titleBar.parentElement.getBoundingClientRect().width),
                display: getComputedStyle(titleBar.parentElement).display
              }
            : null
        }
      : null,
    viewport,
    root: box('#root > *'),
    settings: settings ? box('.eu-settings') : null,
    rail: box('.eu-settings__rail'),
    body: box('.eu-settings__body'),
    shortcuts: box('.eu-settings__shortcuts'),
    shortcutScroll: box('.eu-settings__shortcut-scroll'),
    snippets: snippets ? box('.eu-snippets') : null,
    listPane: box('.eu-snippets__list-pane'),
    editorPane: box('.eu-snippets__editor-pane'),
    counts: { categories, shortcutRows, snippetRows },
    firstRowText: firstRow ? firstRow.textContent.trim().slice(0, 80) : null,
    overflows: {
      horizontally: document.documentElement.scrollWidth > viewport.width + 1,
      vertically: document.documentElement.scrollHeight > viewport.height + 1
    }
  };
})()`;

/** Asks a window to open itself, through the commands the shell already has. */
const OPEN_SETTINGS = `window.eukoliaApi.openSettingsWindow('Keyboard Shortcuts')`;
const OPEN_SNIPPETS = `window.eukoliaApi.openSnippetsWindow()`;

let results = null;

try {
  // The shell has to exist first: it is what opens the others, and it is what
  // publishes the command catalogue they read.
  const list = await targets();
  const shellTarget = list.find((target) => target.type === 'page' && windowKind(target) === 'shell')
    ?? list.find((target) => target.type === 'page');
  if (!shellTarget) throw new Error(`no debuggable page on port ${PORT}`);

  const shell = await attach(shellTarget.webSocketDebuggerUrl);
  // The shell registers its commands once its session has been restored, and the
  // catalogue it publishes is what the Settings window lists.
  await sleep(9_000);
  await shell.evaluate(OPEN_SETTINGS);
  await sleep(4_000);
  await shell.evaluate(OPEN_SNIPPETS);
  await sleep(6_000);

  const all = await targets();
  results = { windows: {}, verdicts: [] };

  for (const target of all.filter((entry) => entry.type === 'page')) {
    const kind = windowKind(target);
    if (kind === 'shell') continue;
    const cdp = await attach(target.webSocketDebuggerUrl);
    // A window that has just been shown may not have painted; the measurement
    // is of the real layout, so it waits for the frame rather than the clock.
    await cdp.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
    const measured = await cdp.evaluate(MEASURE);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shotPath = path.join(scratch, `window-${kind}.png`);
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    results.windows[kind] = { url: target.url, screenshot: shotPath, measured };
  }

  const settings = results.windows.settings?.measured;
  const snippets = results.windows.snippets?.measured;

  results.verdicts.push({
    check: 'the shortcut editor has rows',
    ok: Boolean(settings && settings.counts.shortcutRows > 0),
    detail: settings ? `${settings.counts.shortcutRows} rows, first: ${settings.firstRowText ?? '—'}` : 'the Settings window did not open'
  });
  results.verdicts.push({
    check: 'the settings panes fit the window',
    ok: Boolean(
      settings &&
        settings.settings &&
        settings.settings.width <= settings.viewport.width + 1 &&
        settings.settings.height <= settings.viewport.height + 1 &&
        !settings.overflows.horizontally
    ),
    detail: settings ? `pane ${settings.settings?.width}×${settings.settings?.height} in ${settings.viewport.width}×${settings.viewport.height}` : '—'
  });
  results.verdicts.push({
    check: 'the settings rail and body share the width',
    ok: Boolean(
      settings?.rail &&
        settings?.body &&
        Math.abs(settings.rail.width + settings.body.width - (settings.settings?.width ?? 0)) <= 2
    ),
    detail: settings?.rail ? `rail ${settings.rail.width} + body ${settings.body.width} = ${(settings.rail.width + settings.body.width)}` : '—'
  });
  results.verdicts.push({
    check: 'the snippet library opened and fits',
    ok: Boolean(
      snippets &&
        snippets.snippets &&
        snippets.snippets.width <= snippets.viewport.width + 1 &&
        !snippets.overflows.horizontally
    ),
    detail: snippets ? `pane ${snippets.snippets?.width}×${snippets.snippets?.height} in ${snippets.viewport.width}×${snippets.viewport.height}` : 'the Snippet Library window did not open'
  });

  /*
   * The list pane's own width, at whatever size the window is.
   *
   * A percentage width is the one thing in this window that can be right at one
   * size and useless at another, and the failure is silent: the pane still
   * renders, it simply cannot hold its own rows. The check is against the pane's
   * *floor* — the width at which the trigger column and a few words of preview
   * both fit — rather than against the window, because the window is not what
   * the columns are read from.
   */
  const listWidth = snippets?.listPane?.width ?? 0;
  results.verdicts.push({
    check: 'the snippet list pane holds its columns',
    ok: Boolean(snippets && listWidth >= 260),
    detail: snippets
      ? `list pane ${listWidth}px in a ${snippets.viewport.width}px window (floor 260px)`
      : '—'
  });

  /*
   * The auxiliary windows' own title bar, which is where the window controls are
   * for these two windows.
   *
   * Three facts, and each was wrong at some point: the bar exists at all (it is
   * the window's only drag region), it draws exactly three buttons, and they end
   * at the window's right edge — a `rightGap` around 140 is the reservation for
   * the platform overlay that these windows no longer have.
   */
  for (const kind of ['settings', 'snippets']) {
    const bar = results.windows[kind]?.measured?.titleBar;
    results.verdicts.push({
      check: `the ${kind} window's title bar draws its own controls at the edge`,
      ok: Boolean(bar && bar.buttons === 3 && bar.rightGap !== null && Math.abs(bar.rightGap) <= 6),
      detail: bar
        ? `${bar.buttons} buttons [${(bar.buttonNames ?? []).join(', ')}], bar ${bar.width}×${bar.height}, right gap ${bar.rightGap}px`
        : 'no .eu-title-bar in this window'
    });
  }

  results.ok = results.verdicts.every((verdict) => verdict.ok);
} catch (error) {
  results = { ok: false, error: String(error?.message ?? error), stderrTail: stderr.slice(-3000) };
} finally {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

writeFileSync(path.join(scratch, 'window-probe.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(results, null, 2));
process.exit(results.ok ? 0 : 1);
