/**
 * Photograph the window's top strip in the live application.
 *
 * The menu strip was removed from the window and the three window controls moved
 * into the tab bar, so the questions this answers are the ones no unit test can:
 *
 *   • is the tab bar the top row of the window, with no band of chrome above it?
 *   • are the three caption buttons drawn at the window's right-hand edge, at the
 *     bar's own height — Windows' `titleBarOverlay` is not configured for this
 *     window, so nothing else draws them;
 *   • is the strip still a drag region, and are the buttons *out* of it? Chromium
 *     computes the draggable area as the `drag` rectangles minus the `no-drag`
 *     ones, and only the running window reports the result.
 *
 * The screenshot comes back with the numbers, so the shape can be looked at and
 * measured in the same run. Nothing here is asserted: the values are printed, and
 * `npm run smoke` is where the same questions are checked automatically.
 *
 * Usage: node scripts/probe-chrome.mjs
 */
import { spawn } from 'node:child_process';
import fs, { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

function electronBinary() {
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

const binary = electronBinary();
if (!binary) {
  console.error('Could not locate the Electron binary.');
  process.exit(7);
}

const PORT = Number(process.env.EUKOLIA_CHROME_PORT ?? 9381);
const scratch = path.join(projectRoot, '.scratch');
mkdirSync(scratch, { recursive: true });

/*
 * A throwaway profile, seeded with just enough to get past the project-library
 * gate and into the shell with a document open. Without it the application shows
 * "choose a project library" and there is no tab bar to photograph — which is the
 * gate working, not the probe failing.
 */
const USER_DATA = path.join(scratch, 'chrome-profile');
const LIBRARY = path.join(scratch, 'chrome-library');

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

const child = spawn(binary, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
  cwd: projectRoot,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shellTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
      const page = list.find((entry) => entry.type === 'page' && !/[?&]window=/.test(entry.url ?? ''));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  return null;
}

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
    if (result.exceptionDetails) {
      return { __error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'threw' };
    }
    return result.result?.value;
  }
}

/*
 * The measurement, as one expression.
 *
 * No backticks and no dollar-brace in this string: it is itself a template
 * literal. Every custom property is expanded, because a box shadow whose colour is
 * the string `var(--eu-...)` paints nothing and the difference matters.
 */
const MEASURE = `(() => {
  const expand = (value) => {
    if (typeof value !== 'string') return value;
    const open = value.indexOf('var(');
    if (open === -1) return value;
    const close = value.indexOf(')', open);
    const name = value.slice(open + 4, close).split(',')[0].trim();
    const fromRoot = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return fromRoot || value;
  };
  const appRegion = (node) => {
    if (!node) return null;
    const style = getComputedStyle(node);
    return (
      style.getPropertyValue('-webkit-app-region') ||
      style.getPropertyValue('app-region') ||
      style.webkitAppRegion ||
      'none'
    );
  };
  const box = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      x: Math.round(rect.left),
      right: Math.round(rect.right),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      background: expand(style.backgroundColor),
      color: expand(style.color),
      appRegion: appRegion(node)
    };
  };

  const bar = document.querySelector('[data-testid="tab-bar"]');
  const strip = document.querySelector('.eu-tab-strip');
  const toolbar = document.querySelector('[data-testid="tab-bar-toolbar"]');
  const controls = document.querySelector('[data-testid="tab-bar-window-controls"]');
  const editor = document.querySelector('.cm-editor');

  return {
    window: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio },
    hasLegacy: {
      titleBar: !!document.querySelector('[data-testid="title-bar"]'),
      menus: !!document.querySelector('[data-testid="title-bar-menus"]'),
      commandCentre: !!document.querySelector('[data-testid="title-bar-command-centre"]')
    },
    bar: box(bar),
    strip: box(strip),
    toolbar: box(toolbar),
    editor: box(editor),
    controls: box(controls),
    // Each caption button, left to right, with the interval between them: a gap
    // or an overlap here is what "the three buttons" being on the bar means.
    buttons: controls
      ? Array.from(controls.querySelectorAll('button')).map((button) => ({
          id: button.getAttribute('data-testid'),
          name: button.getAttribute('aria-label'),
          box: box(button),
          glyph: button.querySelector('svg')
            ? Math.round(button.querySelector('svg').getBoundingClientRect().width)
            : null
        }))
      : [],
    // What is painted at the very top of the window, a few pixels in from the
    // right edge: the button that closes it, or the bar behind it.
    topRightStack: document
      .elementsFromPoint(window.innerWidth - 19, 6)
      .map((node) => (typeof node.className === 'string' && node.className ? node.className.split(' ')[0] : node.tagName.toLowerCase()))
  };
})()`;

let payload = null;

try {
  const url = await shellTarget();
  if (!url) throw new Error(`no debuggable shell window on port ${PORT}`);

  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send('Runtime.enable');
  await sleep(10_000);

  const measured = await cdp.evaluate(MEASURE);

  /*
   * The close button under the pointer.
   *
   * It is the one caption button that may go red, and it is the only destructive
   * control in the strip: a hover that paints it the same as its neighbours makes
   * the button that ends the session indistinguishable from the one that minimises
   * it. Real mouse input rather than a synthetic event, because the rule is a
   * `:hover` and only the browser can enter that state.
   */
  let closeHover = null;
  const closeTarget = await cdp.evaluate(`(() => {
    const button = document.querySelector('[data-testid="window-control-close"]');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  if (closeTarget) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: closeTarget.x, y: closeTarget.y });
    await sleep(400);
    closeHover = await cdp.evaluate(`(() => {
      const expand = (value) => {
        if (typeof value !== 'string') return value;
        const open = value.indexOf('var(');
        if (open === -1) return value;
        const close = value.indexOf(')', open);
        const name = value.slice(open + 4, close).split(',')[0].trim();
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || value;
      };
      const button = document.querySelector('[data-testid="window-control-close"]');
      const minimise = document.querySelector('[data-testid="window-control-minimize"]');
      if (!button) return null;
      return {
        closeBackground: expand(getComputedStyle(button).backgroundColor),
        closeColour: expand(getComputedStyle(button).color),
        hovered: button.matches(':hover'),
        minimisedNeighbour: expand(getComputedStyle(minimise).backgroundColor)
      };
    })()`);
    // Off the button again, so the screenshots below are of the resting state.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 300 });
    await sleep(300);
  }

  /*
   * The normal state first, then the maximised one.
   *
   * The bar is 35px tall and 32px when the window is maximised, and the caption
   * buttons fill whatever the bar is — so both states are photographed, because a
   * button sized from the wrong one is a button that overflows or floats.
   */
  const full = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const fullPath = path.join(scratch, 'chrome-window.png');
  writeFileSync(fullPath, Buffer.from(full.data, 'base64'));

  const stripClip = await cdp.evaluate(`(() => {
    const bar = document.querySelector('[data-testid="tab-bar"]');
    if (!bar) return null;
    const rect = bar.getBoundingClientRect();
    return { x: 0, y: 0, width: Math.round(rect.width), height: Math.round(rect.height) + 8, scale: 2 };
  })()`);
  let stripPath = null;
  if (stripClip) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: stripClip });
    stripPath = path.join(scratch, 'chrome-strip.png');
    writeFileSync(stripPath, Buffer.from(shot.data, 'base64'));
  }

  // Maximise through the renderer's own button, and measure that state too.
  await cdp.evaluate(`(() => {
    const button = document.querySelector('[data-testid="window-control-maximize"]');
    if (button) button.click();
    return true;
  })()`);
  await sleep(1200);
  const maximized = await cdp.evaluate(MEASURE);
  const maxShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const maxPath = path.join(scratch, 'chrome-maximized.png');
  writeFileSync(maxPath, Buffer.from(maxShot.data, 'base64'));
  // Put it back, so the next probe to run is not affected.
  await cdp.evaluate(`(() => {
    const button = document.querySelector('[data-testid="window-control-maximize"]');
    if (button) button.click();
    return true;
  })()`);
  await sleep(900);

  payload = { ok: true, screenshot: fullPath, strip: stripPath, maximizedScreenshot: maxPath, measured, maximized, closeHover };
} catch (error) {
  payload = { ok: false, error: String(error?.message ?? error), stderrTail: stderr.slice(-1500) };
} finally {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

writeFileSync(path.join(scratch, 'chrome-probe.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

if (!payload.ok) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

const line = (label, node) =>
  node ? `${String(label).padEnd(16)}: x ${node.x}..${node.right} (w ${node.width})  y ${node.top}..${node.bottom} (h ${node.height})  region ${node.appRegion}` : `${String(label).padEnd(16)}: absent`;

for (const [label, state] of [
  ['normal', payload.measured],
  ['maximised', payload.maximized]
]) {
  console.log(`--- ${label} (window ${state.window.innerWidth}x${state.window.innerHeight} @${state.window.dpr}x) ---`);
  console.log(line('tab bar', state.bar));
  console.log(line('tab strip', state.strip));
  console.log(line('toolbar', state.toolbar));
  console.log(line('window controls', state.controls));
  for (const button of state.buttons ?? []) {
    console.log(
      `  ${String(button.id).padEnd(26)} ${button.name ?? '—'}  x ${button.box.x}..${button.box.right} (w ${button.box.width}) h ${button.box.height} glyph ${button.glyph} region ${button.box.appRegion}`
    );
  }
  console.log(`legacy chrome left: ${JSON.stringify(state.hasLegacy)}`);
  console.log(`top-right stack   : ${(state.topRightStack ?? []).join(' < ')}`);
  console.log('');
}

console.log(`screenshot         : ${path.relative(projectRoot, payload.screenshot)}`);
console.log(`top strip          : ${payload.strip ? path.relative(projectRoot, payload.strip) : 'n/a'}`);
console.log(`maximised          : ${path.relative(projectRoot, payload.maximizedScreenshot)}`);
if (payload.closeHover) {
  console.log('');
  console.log(`close under pointer: ${JSON.stringify(payload.closeHover)}`);
}
