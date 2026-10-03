/**
 * Boot probe — is the built shell actually on screen?
 *
 * The smoke probe asserts behaviour, and when it fails at its first step every
 * later symptom is noise. This asks the question underneath all of them, of the
 * **real application**, through Chromium's own DevTools protocol: after the
 * window has had time to start, is `#eukolia-boot` still covering it, and is the
 * shell's chrome in the DOM?
 *
 * It drives the packaged entry point (`dist-electron/main.js`) exactly as
 * `npm run dev:electron` does, so the main process, the preload bridge and the
 * IPC handlers are the shipped ones — nothing is stubbed, and the answer is
 * therefore about the application rather than about a harness.
 *
 * ## Why this exists alongside `npm run smoke`
 *
 * The smoke probe reports a *list of symptoms*, and when the shell never mounts
 * every one of them is downstream of that one fact — a run reporting "no editor
 * mounted, no status bar, no PDF" has told you one thing, not five. Worse, the
 * likeliest reason the shell never mounts is not a defect at all: the application
 * does not start until a **project library** has a location, and the probe runs
 * against a throwaway user-data directory where none is configured. `--smoke`
 * reproduces that condition and reports the gate by name, so the next reader is
 * not sent looking for a broken editor that was never asked to open.
 *
 * A screenshot is written beside the payload, because "is it on screen?" is a
 * question a picture answers better than a list of selectors.
 *
 * Usage:
 *   node scripts/probe-boot.mjs            # a normal launch
 *   node scripts/probe-boot.mjs --smoke    # the smoke harness's own conditions
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

const PORT = Number(process.env.EUKOLIA_BOOT_PROBE_PORT ?? 9333);
const scratch = path.join(projectRoot, '.scratch');
mkdirSync(scratch, { recursive: true });

/**
 * `--smoke` reproduces the smoke harness's own conditions rather than a normal
 * launch: the probe gets a fresh user-data directory (so nothing is restored
 * from a previous session) and the fixture project is opened through the
 * protocol channel. Those two together are the difference between "the shell
 * draws" and "the shell draws *a project*", and a probe that only ever saw the
 * first was answering an easier question than the one being asked.
 */
const smokeMode = process.argv.includes('--smoke');

/**
 * The workspace the probe opens.
 *
 * The small checked-in fixture, not whatever session the user last had. Two
 * reasons, and the second is the important one:
 *
 *  - the probe boots the real application against the real user-data directory,
 *    so without this it *restores the user's whole project* — a large one takes
 *    long enough that the probe's ten-second window is spent watching it load;
 *  - a big project runs the LaTeX analyzer over every file, and a worker failure
 *    there is a fatal boot error that leaves the window showing "Eukolia failed to
 *    start" — which the probe would then report as "neither the shell nor the
 *    project-library gate is on screen", a verdict about a window it never let
 *    finish painting.
 */
const SMOKE_FIXTURE = path.join(projectRoot, 'tests', 'smoke', 'fixture');

const child = spawn(electronBinary, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    EUKOLIA_SMOKE_PROBE: '1',
    EUKOLIA_SMOKE_WORKSPACE: SMOKE_FIXTURE,
    EUKOLIA_SMOKE_ALLOW_MISSING_PDF: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A minimal CDP client over the built-in WebSocket. */
async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      /*
       * The *shell*, not the first page that answers.
       *
       * The auxiliary windows load the same document with a `window=` parameter,
       * so "the first page target" can be Settings or the Snippet Library — a
       * window with no editor, no tab bar and no status bar, whose every reading
       * would be a false negative. The shell is the one without the parameter.
       */
      const page = targets.find(
        (target) => target.type === 'page' && !/[?&]window=/.test(target.url ?? '')
      );
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* the port is not listening yet */
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
    /**
     * Everything the page said while the probe was watching.
     *
     * A renderer that fails to draw leaves no mark on the DOM — it *is* the mark
     * — so the only evidence is what it logged on the way down. `Runtime.enable`
     * is what makes these arrive, and it has to be asked for before the failure
     * rather than after it, which is why the subscription is unconditional.
     */
    this.events = [];
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.method) {
        this.events.push(message);
        return;
      }
      const resolver = this.pending.get(message.id);
      if (!resolver) return;
      this.pending.delete(message.id);
      resolver(message);
    });
  }

  /** What the page logged, flattened to strings a report can carry. */
  transcript() {
    const lines = [];
    for (const event of this.events) {
      if (event.method === 'Runtime.consoleAPICalled') {
        const text = (event.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? arg.type)
          .join(' ');
        lines.push(`console.${event.params.type}: ${text}`);
      } else if (event.method === 'Runtime.exceptionThrown') {
        const details = event.params.exceptionDetails ?? {};
        const description = details.exception?.description ?? details.text ?? 'unknown';
        lines.push(`exception: ${description}`);
      } else if (event.method === 'Log.entryAdded') {
        lines.push(`log.${event.params.entry.level}: ${event.params.entry.text}`);
      }
    }
    return lines;
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
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      return { __error: result.exceptionDetails.text ?? 'evaluation threw' };
    }
    return result.result?.value;
  }
}

const CHROME = `(() => {
  const q = (selector) => document.querySelector(selector);
  const text = (selector) => (q(selector)?.textContent ?? '').trim();
  const visible = (selector) => {
    const node = q(selector);
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  return {
    bootScreenPresent: !!q('#eukolia-boot'),
    bootDismissed: q('#eukolia-boot')?.getAttribute('data-dismissed') ?? null,
    bootStatus: text('#eukolia-boot-status'),
    bootError: text('#eukolia-boot-error'),
    readyState: document.readyState,
    rootChildren: q('#root')?.childElementCount ?? -1,
    bodyTextLength: (document.body.innerText ?? '').length,
    shell: {
      activityBar: visible('[data-testid="activity-bar"]'),
      sidebar: visible('[data-testid="sidebar-region"]'),
      tabBar: visible('[data-testid="tab-bar"]'),
      statusBar: visible('[data-testid="status-bar"]'),
      workspace: visible('#eu-workspace'),
      skipLink: visible('.eu-skip-link'),
      editor: visible('.cm-editor'),
      bottomPanel: visible('[data-testid="bottom-panel"]')
    },
    resolved: {
      shellClass: q('.eu-shell') ? true : false,
      titleBarClass: q('.eu-title-bar') ? true : false,
      designTokenSpace2: getComputedStyle(document.documentElement).getPropertyValue('--eu-space-2').trim(),
      designTokenRadiusMd: getComputedStyle(document.documentElement).getPropertyValue('--eu-radius-md').trim(),
      statusBarFontSize: (() => {
        const bar = q('[data-testid="status-bar"]');
        return bar ? getComputedStyle(bar).fontSize : null;
      })(),
      activityItemRadius: (() => {
        const item = q('.eu-activity-item');
        return item ? getComputedStyle(item).borderTopLeftRadius : null;
      })(),
      tabTransition: (() => {
        const tab = q('.eu-tab');
        return tab ? getComputedStyle(tab).transitionProperty : null;
      })(),
      panelHeaderEyebrow: (() => {
        const eyebrow = q('.eu-sidebar-panel__header .eu-eyebrow');
        return eyebrow ? getComputedStyle(eyebrow).textTransform : null;
      })()
    }
  };
})()`;

const CHROME_GATE = `(() => {
  const setup = document.querySelector('.library-setup');
  const welcome = document.querySelector('.library-welcome');
  const rect = welcome?.getBoundingClientRect();
  const style = welcome ? getComputedStyle(welcome) : null;
  return {
    projectLibraryGate: !!setup,
    gateHeading: setup ? (setup.querySelector('h1')?.textContent ?? '').trim() : null,
    gateLayout: welcome
      ? {
          box: { left: Math.round(rect.left), width: Math.round(rect.width) },
          viewportWidth: window.innerWidth,
          offsetFromCentre: Math.round(rect.left - (window.innerWidth - rect.width) / 2),
          maxWidth: style.maxWidth,
          marginInlineStart: style.marginInlineStart,
          marginBlockStart: style.marginBlockStart,
          display: style.display
        }
      : null
  };
})()`;

/**
 * The join between the selected tab and the editor, measured rather than looked
 * at.
 *
 * A seam is one pixel of the wrong colour in a place nobody thinks to look, so
 * this reports the four numbers that decide whether there is one — where the tab
 * bar ends, where the selected tab ends, where the editor begins, and whether
 * anything at all sits between them — along with the two backgrounds that have
 * to match for the join to be invisible.
 *
 * The pixels themselves are checked separately, by `scripts/pngcolumn.py` against
 * this probe's own screenshot: `elementFromPoint` answers what is *there*, and
 * only the rendered image answers what was *painted*.
 */
const CHROME_JOIN = `(() => {
  const round = (value) => Math.round(value * 10) / 10;
  const describe = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      className: node.className && typeof node.className === 'string' ? node.className : node.tagName,
      top: round(rect.top),
      bottom: round(rect.bottom),
      height: round(rect.height),
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage === 'none' ? null : 'gradient',
      borderBottom: style.borderBottomWidth + ' ' + style.borderBottomStyle + ' ' + style.borderBottomColor,
      boxShadow: style.boxShadow,
      display: style.display
    };
  };

  /* What the tabs actually paint, with their custom properties expanded. */
  const tabPaint = (node) => {
    if (!node) return null;
    const style = getComputedStyle(node);
    return {
      className: node.className,
      background: resolveToken(style.backgroundColor),
      boxShadow: resolveToken(style.boxShadow),
      beforeShadow: resolveToken(getComputedStyle(node, '::before').boxShadow),
      afterShadow: resolveToken(getComputedStyle(node, '::after').boxShadow)
    };
  };

  const bar = document.querySelector('[data-testid="tab-bar"]');
  const tab = document.querySelector('[role="tab"][aria-selected="true"]');
  const strip = document.querySelector('.eu-tab-strip');
  const drop = document.querySelector('#eu-workspace');
  const editor = document.querySelector('.cm-editor');
  const scroller = document.querySelector('.cm-scroller');

  /*
   * The divider, as computed rather than as written.
   *
   * The surface colour is set inline by the component as a custom-property
   * *reference*, so a shadow meant to be the editor's own colour reads back as
   * the token text unless it is expanded. This expands it to what the browser
   * would actually paint.
   *
   * No backticks and no dollar-brace in this comment: it lives inside a template
   * literal, where either one ends the string or starts an interpolation and the
   * file stops parsing several lines further down.
   */
  const resolveToken = (value) => {
    if (typeof value !== 'string') return value;
    const open = value.indexOf('var(');
    if (open === -1) return value;
    const close = value.indexOf(')', open);
    const name = value.slice(open + 4, close).split(',')[0].trim();
    const fromRoot = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const fromBody = getComputedStyle(document.body).getPropertyValue(name).trim();
    return fromRoot || fromBody || value;
  };

  const tabBox = tab ? tab.getBoundingClientRect() : null;
  const dropBox = drop ? drop.getBoundingClientRect() : null;

  /* Every child of the workspace column, in the band between the selected tab's
     feet and the editor's head — the pixels a stray surface would be painted
     in. An empty list is the answer being asked for. */
  const between = [];
  if (tabBox && dropBox) {
    const column = drop.parentElement;
    for (const child of column ? column.children : []) {
      const rect = child.getBoundingClientRect();
      if (rect.bottom <= tabBox.bottom + 0.5) continue;
      if (rect.top >= dropBox.top) break;
      between.push(describe(child));
    }
  }

  /*
   * What sits in the two pixels either side of the divider.
   *
   * A "thick white line" is either a border, a shadow, or a bar whose own
   * background is lighter than the surfaces above and below it. Hit testing
   * cannot tell a shadow from a border, so both are reported, and at the exact
   * rows that matter.
   *
   * The summary is built by concatenation and without braces: this function lives
   * inside a template literal, so a dollar sign followed by an opening brace is
   * read as an interpolation by the outer literal and the file stops parsing.
   */
  const seam = [];
  if (bar) {
    const barBox = bar.getBoundingClientRect();
    const probes = [
      ['above the divider', Math.round(barBox.bottom) - 2],
      ['the divider', Math.round(barBox.bottom) - 1],
      ['below the divider', Math.round(barBox.bottom)],
      ['first editor row', Math.round(barBox.bottom) + 1]
    ];
    for (const probe of probes) {
      const label = probe[0];
      const y = probe[1];
      const x = Math.round((dropBox ? dropBox.left : 0) + 40);
      const stack = document.elementsFromPoint(x, y).slice(0, 3).map((node) => {
        const style = getComputedStyle(node);
        const name = typeof node.className === 'string' && node.className ? node.className.split(' ')[0] : node.tagName.toLowerCase();
        return [
          name,
          'bg=' + resolveToken(style.backgroundColor),
          'borderTop=' + style.borderTopWidth + ' ' + style.borderTopColor,
          'borderBottom=' + style.borderBottomWidth + ' ' + style.borderBottomColor,
          'shadow=' + resolveToken(style.boxShadow)
        ].join(' | ');
      });
      seam.push({ label: label, y: y, stack: stack });
    }
  }

  /*
   * What is painted in the first rows of the editor.
   *
   * Every layer at each point is listed, read top-down, because an overlay with
   * pointer-events disabled is invisible to hit testing — a line drawn by one
   * would otherwise be attributed to whatever is underneath it.
   *
   * Written without backticks: this block is itself inside a template literal,
   * and one backtick in a comment would close it and turn the rest of this
   * file's prose into JavaScript. The parser reports that as a syntax error
   * several lines later, in a comment, which is a confusing way to be told.
   */
  const editorRows = [];
  if (dropBox) {
    const midX = Math.round(dropBox.left + dropBox.width / 2);
    for (let y = Math.round(dropBox.top) + 6; y <= Math.round(dropBox.top) + 12; y += 1) {
      const stack = document.elementsFromPoint(midX, y);
      editorRows.push({
        y: y,
        elements: stack.slice(0, 4).map((node) => {
          const name = typeof node.className === 'string' ? node.className.split(' ')[0] : '';
          return name || node.tagName.toLowerCase();
        })
      });
    }
  }

  return {
    bar: describe(bar),
    strip: describe(strip),
    selectedTab: describe(tab),
    paint: {
      barSurfaceToken: resolveToken(getComputedStyle(bar).getPropertyValue('--eu-tab-surface').trim()),
      barSurfaceInline: bar ? bar.style.getPropertyValue('--eu-tab-surface') : null,
      selected: tabPaint(tab),
      firstInactive: tabPaint(document.querySelector('[role="tab"][aria-selected="false"]') || document.querySelectorAll('[role="tab"]')[1])
    },
    editorTopGap: tabBox && dropBox ? round(dropBox.top - tabBox.bottom) : null,
    editor: describe(editor),
    scroller: describe(scroller),
    between: between,
    editorRows: editorRows,
    seam: seam,
    dropTop: dropBox ? round(dropBox.top) : null,
    tabBottom: tabBox ? round(tabBox.bottom) : null
  };
})()`;

/** True when the shell's own chrome is on screen, rather than the library gate. */
function shellUpNow(chrome) {
  return Boolean(chrome?.shell?.activityBar || chrome?.shell?.editor);
}

let cdp = null;
let payload = null;

try {
  const wsUrl = await connect();
  if (!wsUrl) throw new Error(`no debuggable page on port ${PORT}`);

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });
  cdp = new Cdp(socket);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  // The application reads its session over IPC and has to paint a frame before
  // it dismisses the boot screen; ten seconds is generous for a cold start and
  // short enough that a hang is reported rather than waited out.
  await sleep(smokeMode ? 7_000 : 10_000);

  /*
   * In smoke mode the fixture project is opened by the harness itself. What can
   * be checked from here is whether that delivery *landed*: the renderer writes
   * the open workspace back to its session, so the probe's own user-data
   * directory is the receipt. A session that still says `workspacePath: null`
   * after the application has been up for twenty seconds did not receive the
   * project — which is the difference between "the interface is broken" and
   * "the interface was never given anything to draw".
   */
  const delivery = [];
  if (smokeMode) {
    const stateDir = process.env.TEMP ?? process.env.TMP ?? '/tmp';
    const roots = fs
      .readdirSync(stateDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('eukolia-smoke-userdata-'))
      .map((entry) => path.join(stateDir, entry.name, 'state.json'))
      .filter((file) => existsSync(file))
      .map((file) => ({ file, at: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    const freshest = roots[0];
    delivery.push({
      step: 'harness-session',
      file: freshest?.file ?? null,
      workspacePath: freshest ? JSON.parse(fs.readFileSync(freshest.file, 'utf8')).workspacePath : null
    });
  }

  const chrome = await cdp.evaluate(CHROME);
  const gate = await cdp.evaluate(CHROME_GATE);
  const shellUp = shellUpNow(chrome);
  const join = shellUp ? await cdp.evaluate(CHROME_JOIN) : null;

  /*
   * The capture.
   *
   * The measurements above are the authority — they are taken from the live
   * layout — and the picture is taken after them so that what a reviewer looks
   * at is the same frame the numbers describe rather than the one before it.
   */
  await cdp.evaluate(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  })`);

  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const screenshotPath = path.join(scratch, 'boot-probe.png');
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  /*
   * Region crops.
   *
   * "Is it on screen?" is answered by the full window, but "is it *polished*?"
   * is a question about 40-pixel-tall strips and 8-pixel gutters, which are
   * unreadable in a 1800px-wide picture. Each region is captured at its own
   * device scale so a reviewer sees the pixels that were actually decided.
   */
  const viewport = await cdp.evaluate(
    '({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })'
  );
  const regions = [
    ['chrome-top', 0, 0, viewport.width, 120],
    ['sidebar', 0, 0, 300, viewport.height - 60],
    ['tab-strip', 380, 0, viewport.width - 380, 80],
    /*
     * The join between the selected tab and the editor, at 3×.
     *
     * This is the one seam in the shell where a single pixel of the wrong colour
     * *is* the defect, and a 1px line at 1× is not something a reviewer can
     * judge. Captured larger than it is drawn, because the question is whether
     * there is a line there at all.
     */
    ['tab-join', 380, 0, Math.min(560, viewport.width - 380), 120, 3],
    ['status-bar', 0, viewport.height - 40, viewport.width, 40],
    ['editor', 380, 80, Math.round(viewport.width * 0.5), 320]
  ];
  const crops = [];
  for (const [name, x, y, width, height, scale] of regions) {
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x, y, width, height, scale: scale ?? Math.min(2, Math.max(1, viewport.dpr ?? 1)) }
    });
    const target = path.join(scratch, `boot-${name}.png`);
    writeFileSync(target, Buffer.from(shot.data, 'base64'));
    crops.push(target);
  }

  payload = {
    /*
     * The verdict is about the *interface*, so a window that is showing the
     * project-library gate is not a failure — it is the application working
     * exactly as designed, with nothing to open yet. What would be a failure is
     * neither: a blank window, or the boot screen still covering it.
     */
    ok: shellUp || gate.projectLibraryGate,
    verdict: shellUp
      ? 'the shell is on screen'
      : gate.projectLibraryGate
        ? 'the project-library gate is on screen: no library is configured for this user-data directory, so the shell has correctly not started'
        : 'neither the shell nor the project-library gate is on screen',
    smokeMode,
    screenshot: screenshotPath,
    crops,
    delivery,
    transcript: cdp.transcript().slice(-60),
    rootHtml: shellUp ? null : await cdp.evaluate("(document.getElementById('root')?.innerHTML ?? '').slice(0, 400)"),
    join,
    chrome: { ...chrome, ...gate }
  };
} catch (error) {
  payload = { ok: false, error: String(error?.message ?? error), stderrTail: stderr.slice(-3000) };
} finally {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

writeFileSync(path.join(scratch, 'boot-probe.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
