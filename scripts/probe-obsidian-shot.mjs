/**
 * Screenshot the running Obsidian window.
 *
 * Reads its live styles is one thing; the shape it actually paints is another, and
 * the two have diverged often enough in this investigation to be worth checking
 * separately. The active tab's rect comes back with the image, so the corner can be
 * read at a known coordinate rather than hunted for.
 *
 * Usage: node scripts/probe-obsidian-shot.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const PORT = Number(process.env.OBSIDIAN_PORT ?? 9222);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((entry) => entry.type === 'page' && /obsidian\.md/.test(entry.url ?? ''));
if (!page) {
  console.error('no Obsidian page on the debug port');
  process.exit(2);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
});

let next = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  const resolver = pending.get(message.id);
  if (!resolver) return;
  pending.delete(message.id);
  resolver(message);
});

function send(method, params = {}) {
  const id = next++;
  return new Promise((resolve, reject) => {
    pending.set(id, (message) => {
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method}: timed out`));
    }, 20_000);
  });
}

await send('Runtime.enable');

const GEOMETRY = `(() => {
  const containers = [...document.querySelectorAll('.workspace-tab-header-container')];
  const container = containers[1];
  const tabs = [...container.querySelectorAll('.workspace-tab-header')];
  const active = tabs.find((tab) => tab.classList.contains('is-active')) || tabs[0];
  const rect = active.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return {
    dpr: window.devicePixelRatio,
    active: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, w: rect.width, h: rect.height },
    container: { x: containerRect.x, y: containerRect.y, right: containerRect.right, bottom: containerRect.bottom, h: containerRect.height }
  };
})()`;

const geometry = await (async () => {
  const result = await send('Runtime.evaluate', { expression: GEOMETRY, returnByValue: true });
  return result.result?.value;
})();

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync(path.join(projectRoot, '.scratch'), { recursive: true });
const out = path.join(projectRoot, '.scratch', 'obsidian-window.png');
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

const meta = path.join(projectRoot, '.scratch', 'obsidian-shot.json');
fs.writeFileSync(meta, `${JSON.stringify(geometry, null, 2)}\n`, 'utf8');

console.log(`saved ${path.relative(projectRoot, out)}`);
console.log(`dpr ${geometry.dpr}`);
console.log(`active tab   x ${geometry.active.x} .. ${geometry.active.right}   y ${geometry.active.y} .. ${geometry.active.bottom}`);
console.log(`container    x ${geometry.container.x} .. ${geometry.container.right}   y ${geometry.container.y} .. ${geometry.container.bottom}`);
console.log(`at ${geometry.dpr}x, the active tab's bottom-left corner is near device pixel x=${Math.round(geometry.active.x * geometry.dpr)}, y=${Math.round(geometry.active.bottom * geometry.dpr)}`);
process.exit(0);
