/**
 * Name the one pixel row at the top of the editor.
 *
 * `probe-boot.mjs` says the tab strip joins the editor with nothing between them
 * — and a rendered screenshot still shows one hairline a few pixels below the
 * join. This asks which element draws it, by walking the boxes that actually
 * occupy that row rather than by hit-testing, which a `pointer-events: none`
 * overlay is invisible to.
 *
 * Prints a table: every element whose border box contains the row, plus the
 * border and background it has there.
 *
 * Usage: node scripts/probe-editor-top.mjs [rows]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

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

const PORT = Number(process.env.EUKOLIA_EDITOR_TOP_PORT ?? 9350);
const scratch = path.join(projectRoot, '.scratch');
mkdirSync(scratch, { recursive: true });

const child = spawn(electronBinary, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: projectRoot,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});

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
    if (result.exceptionDetails) {
      return { __error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'threw' };
    }
    return result.result?.value;
  }
}

async function targetUrl() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
      const page = list.find((entry) => entry.type === 'page' && !entry.url.includes('window='));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  return null;
}

/*
 * Everything whose box contains the row, with the border and background it
 * paints there, plus the pixels immediately above and below so the row can be
 * confirmed to be the odd one out.
 */
const SCRIPT = (fromTop, toTop) => `(() => {
  const editor = document.querySelector('.cm-editor');
  if (!editor) return { error: 'no editor' };
  const box = editor.getBoundingClientRect();
  const out = [];
  const all = document.querySelectorAll('.cm-editor, .cm-editor *');
  for (let y = Math.round(box.top) + ${fromTop}; y <= Math.round(box.top) + ${toTop}; y += 1) {
    const owners = [];
    for (const node of all) {
      const rect = node.getBoundingClientRect();
      if (rect.height === 0 || rect.width === 0) continue;
      if (y < rect.top || y >= rect.bottom) continue;
      const style = getComputedStyle(node);
      const name = typeof node.className === 'string' && node.className ? node.className.split(' ')[0] : node.tagName.toLowerCase();
      owners.push({
        node: name,
        top: Math.round(rect.top * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        borderTop: style.borderTopWidth + ' ' + style.borderTopStyle + ' ' + style.borderTopColor,
        borderBottom: style.borderBottomWidth + ' ' + style.borderBottomStyle + ' ' + style.borderBottomColor,
        background: style.backgroundColor
      });
    }
    out.push({ y: y, owners: owners });
  }
  return { editorTop: Math.round(box.top * 10) / 10, rows: out };
})()`;

let payload = null;
let cdp = null;

try {
  const url = await targetUrl();
  if (!url) throw new Error(`no debuggable shell window on port ${PORT}`);

  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });
  cdp = new Cdp(socket);
  await cdp.send('Runtime.enable');
  await sleep(9_000);

  payload = await cdp.evaluate(SCRIPT(6, 14));
} catch (error) {
  payload = { error: String(error?.message ?? error) };
} finally {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

writeFileSync(path.join(scratch, 'editor-top.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
if (payload.error || payload.__error) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(`editor top = ${payload.editorTop}`);
for (const row of payload.rows) {
  /* Only the elements that could be painting a line: a border, or a fill that
     is not the editor's own background. */
  const interesting = row.owners.filter(
    (owner) =>
      !owner.borderTop.startsWith('0px') ||
      !owner.borderBottom.startsWith('0px') ||
      (owner.background !== 'rgba(0, 0, 0, 0)' && owner.background !== 'rgb(14, 16, 23)')
  );
  const summary = interesting.length
    ? interesting.map((owner) => `${owner.node}[bt=${owner.borderTop} bb=${owner.borderBottom} bg=${owner.background}]`).join(' ')
    : '(nothing but transparent layers and the editor background)';
  console.log(`  y=${row.y}  ${summary}`);
}
