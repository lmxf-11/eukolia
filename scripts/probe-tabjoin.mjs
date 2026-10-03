/**
 * Measure the tab bar's join in the live application.
 *
 * A focused probe rather than a general one: it boots the real packaged
 * application against a throwaway user-data directory, waits for the shell, and
 * reports the four numbers and the two computed colours that decide whether the
 * selected tab is joined to the document — the bar's box, the tab's box, the
 * editor's box, and what each of them actually paints.
 *
 * The whole point is that these are *computed* values from the running window, not
 * values read out of a stylesheet. A shadow can be sized correctly and still not
 * paint the colour it names, and only the running window can say which.
 *
 * Usage: node scripts/probe-tabjoin.mjs
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

const PORT = Number(process.env.EUKOLIA_TABJOIN_PORT ?? 9371);
const scratch = path.join(projectRoot, '.scratch');
mkdirSync(scratch, { recursive: true });

/**
 * The profile the probe runs against.
 *
 * A throwaway one, seeded with just enough state to get past the project-library
 * gate and land in the shell with a document open. Without it the application
 * correctly shows "choose a project library" and there is no tab bar to measure —
 * which is what makes this probe's own setup part of what it is testing.
 *
 * The profile directory is deleted and rebuilt every run, so nothing here can
 * accumulate and no run can be affected by the last one.
 */
const USER_DATA = path.join(scratch, 'tabjoin-profile');
const LIBRARY = path.join(scratch, 'tabjoin-library');

fs.rmSync(USER_DATA, { recursive: true, force: true });
fs.rmSync(LIBRARY, { recursive: true, force: true });
fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(LIBRARY, { recursive: true });

const project = path.join(LIBRARY, 'probe project');
fs.mkdirSync(project, { recursive: true });
/*
 * The library's shared folder.
 *
 * `describeLibrary` treats a library without it as broken and the gate refuses to
 * open the shell — correctly, since the injected `\input` files live here. A seed
 * that skipped it produced "ENOENT: no such file or directory" on the welcome
 * screen, which is the gate working and the probe's fixture being wrong.
 */
fs.mkdirSync(path.join(LIBRARY, '.eukolia'), { recursive: true });
const mainTex = path.join(project, 'main.tex');
fs.writeFileSync(
  mainTex,
  ['\\documentclass{article}', '\\begin{document}', 'Probe.', '\\end{document}', ''].join('\n'),
  'utf8'
);

/* The library the gate looks for, and the session it restores. */
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
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  },
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
 * The whole measurement, as one expression.
 *
 * Every value is read through `getComputedStyle` on the live element, and every
 * custom property is *expanded* — a shadow whose colour is the string
 * `var(--eu-editor-bg)` paints nothing, and the difference between "the stylesheet
 * says the right thing" and "the window paints the right thing" is the entire
 * question.
 *
 * No backticks and no dollar-brace in this string: it is itself a template literal.
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
  const box = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      rectX: Math.round(rect.left * 10) / 10,
      rectRight: Math.round(rect.right * 10) / 10,
      top: Math.round(rect.top * 10) / 10,
      bottom: Math.round(rect.bottom * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      background: expand(style.backgroundColor),
      borderBottom: style.borderBottomWidth + ' ' + style.borderBottomStyle + ' ' + expand(style.borderBottomColor),
      boxShadow: expand(style.boxShadow),
      /*
       * The corner radii and the pseudo-elements, which is where the shape of the
       * tab actually lives. Reading them off the live element is the only way to
       * know which declaration won: the component sets the radii inline and the
       * stylesheet tries to round the feet, and whichever the cascade picks is not
       * visible in either file.
       */
      radius: style.borderTopLeftRadius + ' / ' + style.borderBottomLeftRadius + ' / ' + style.borderBottomRightRadius + ' / ' + style.borderTopRightRadius,
      beforeContent: getComputedStyle(node, '::before').content,
      beforeSize: getComputedStyle(node, '::before').width + ' x ' + getComputedStyle(node, '::before').height,
      beforeBackground: getComputedStyle(node, '::before').backgroundImage === 'none'
        ? getComputedStyle(node, '::before').backgroundColor
        : 'gradient',
      zIndex: style.zIndex,
      position: style.position,
      overflow: style.overflow
    };
  };
  const bar = document.querySelector('[data-testid="tab-bar"]');
  const selected = document.querySelector('[role="tab"][aria-selected="true"]');
  const idle = document.querySelector('[role="tab"][aria-selected="false"]');
  const editor = document.querySelector('.cm-editor');
  const pane = document.querySelector('#eu-workspace');

  /*
   * Name the element that paints a given row.
   *
   * A hit test is the only reliable way to attribute a *colour* to an element.
   * Reading the computed style of every box says what each one would paint; only
   * the hit test says which of them wins at that pixel. The stack comes back
   * topmost first, so its head is the element whose background is being seen.
   *
   * No backticks in this comment: it lives inside a template literal, and one
   * would end the string and turn the rest of the file into a syntax error.
   */
  const stackAt = (x, y) =>
    document.elementsFromPoint(x, y).map((node) => {
      const style = getComputedStyle(node);
      const name = typeof node.className === 'string' && node.className ? node.className.split(' ')[0] : node.tagName.toLowerCase();
      return {
        name: name,
        tag: node.tagName.toLowerCase(),
        background: expand(style.backgroundColor),
        backgroundImage: style.backgroundImage === 'none' ? null : 'gradient',
        borderBottom: style.borderBottomWidth + ' ' + expand(style.borderBottomColor),
        boxShadow: expand(style.boxShadow),
        height: Math.round(node.getBoundingClientRect().height * 10) / 10,
        top: Math.round(node.getBoundingClientRect().top * 10) / 10
      };
    });

  /*
   * The rows the join is made of, hit-tested at a column inside the *selected tab*
   * and at one inside the strip but outside every tab. Two columns, because the
   * two questions are different: what covers the divider where the tab is, and
   * what draws it where the tab is not.
   */
  const rows = [];
  if (bar) {
    const edge = bar.getBoundingClientRect().bottom;
    const selectedBox = selected ? selected.getBoundingClientRect() : null;
    const columns = {
      inSelectedTab: selectedBox ? Math.round(selectedBox.left + selectedBox.width / 2) : null,
      inStrip: selectedBox ? Math.round(selectedBox.right + 12) : null
    };
    for (let y = Math.floor(edge) - 2; y <= Math.floor(edge) + 4; y += 1) {
      const entry = { y: y, columns: {} };
      for (const key of Object.keys(columns)) {
        const x = columns[key];
        entry.columns[key] = x === null ? null : stackAt(x, y).slice(0, 5);
      }
      rows.push(entry);
    }
  }

  return {
    devicePixelRatio: window.devicePixelRatio,
    surfaceVariable: bar ? expand(getComputedStyle(bar).getPropertyValue('--eu-tab-surface').trim()) : null,
    surfaceInline: bar ? bar.style.getPropertyValue('--eu-tab-surface') : null,
    tabCount: document.querySelectorAll('[role="tab"]').length,
    bar: box(bar),
    selected: box(selected),
    idle: box(idle),
    editor: box(editor),
    pane: box(pane),
    selectedAfter: selected ? expand(getComputedStyle(selected, '::after').boxShadow) : null,
    rows: rows
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
  await sleep(9_000);

  const measured = await cdp.evaluate(MEASURE);

  /*
   * Focus the selected tab and measure again.
   *
   * The corner has to hold in both states, and the focused one is where a ring is
   * most likely to appear: a focus rule that adds a shadow is a rule that draws a
   * border around the tab, which is the defect this corner keeps growing. Measuring
   * only the resting state would never show it.
   */
  const focus = await cdp.evaluate(`(() => {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    if (!tab) return { focused: false };
    tab.focus();
    const style = getComputedStyle(tab);
    return {
      focused: document.activeElement === tab,
      matchesFocusVisible: tab.matches(':focus-visible'),
      boxShadow: style.boxShadow,
      outline: style.outlineWidth + ' ' + style.outlineStyle + ' ' + style.outlineColor,
      radius: style.borderTopLeftRadius + ' / ' + style.borderBottomLeftRadius + ' / ' + style.borderBottomRightRadius + ' / ' + style.borderTopRightRadius
    };
  })()`);

  /*
   * Open two more documents, so the strip has three tabs and therefore two joints.
   *
   * A single tab has no joint to look at, and the joint — the seam between two adjacent
   * tabs, where each one's rounded foot curves away from the other — is the thing being
   * judged. Clicking the strip's own new-file button is as close as a probe can get to
   * what a person does, and it exercises the same code path.
   */
  const opened = await cdp.evaluate(`(async () => {
    const button = document.querySelector('[data-testid="tab-bar-new-file"]');
    if (!button) return 0;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return document.querySelectorAll('[role="tab"]').length;
  })()`);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(scratch, 'tabjoin-live.png');
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

  payload = { ok: true, screenshot: shotPath, measured, focus, opened };
} catch (error) {
  payload = { ok: false, error: String(error?.message ?? error), stderrTail: stderr.slice(-1500) };
} finally {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

writeFileSync(path.join(scratch, 'tabjoin-live.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

if (!payload.ok) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

const m = payload.measured;
console.log(`device pixel ratio : ${m.devicePixelRatio}`);
console.log(`tabs in the strip  : ${m.tabCount}`);
console.log(`--eu-tab-surface   : inline ${m.surfaceInline}  ->  ${m.surfaceVariable}`);
console.log('');
for (const key of ['bar', 'selected', 'idle', 'pane', 'editor']) {
  const node = m[key];
  if (!node) {
    console.log(`${key.padEnd(9)} : absent`);
    continue;
  }
  console.log(`${key.padEnd(9)} : ${node.top}..${node.bottom} (h ${node.height}) bg ${node.background}`);
  console.log(`${' '.repeat(11)}border-bottom ${node.borderBottom}`);
  console.log(`${' '.repeat(11)}shadow ${node.boxShadow}`);
}
console.log('');
console.log(`selected ::after   : ${m.selectedAfter}`);
console.log('');
console.log('the rows the join is made of, hit-tested at two columns:');
for (const row of m.rows ?? []) {
  console.log(`  y=${row.y}`);
  for (const key of Object.keys(row.columns ?? {})) {
    const stack = row.columns[key];
    if (!stack) continue;
    console.log(`    ${key}:`);
    for (const node of stack) {
      const shadow = node.boxShadow && node.boxShadow !== 'none' ? ` shadow=${node.boxShadow}` : '';
      console.log(`        ${node.name.padEnd(20)} bg=${String(node.background).padEnd(20)} h=${node.height} y=${node.top} bb=${node.borderBottom}${shadow}`);
    }
  }
}
console.log('');
console.log(`screenshot         : ${path.relative(projectRoot, payload.screenshot)}`);
