/**
 * Find Obsidian's *main* tab strip, not the sidebar's.
 *
 * The first query for `.workspace-tab-header-container` returned a 290px-wide strip of
 * eleven 25px icon tabs — a sidebar panel's list, which shares the class with the real
 * one. Reading the wrong element and believing it is the exact failure this whole
 * investigation has been made of, so this enumerates every candidate, reports the
 * geometry that distinguishes them, and reads the one that spans the window.
 *
 * Usage: node scripts/probe-obsidian-tabs.mjs
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

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    return { __error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'threw' };
  }
  return result.result?.value;
}

await send('Runtime.enable');

const REPORT = `(() => {
  const containers = [...document.querySelectorAll('.workspace-tab-header-container')];
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
    candidates: containers.map((node, index) => {
      const rect = node.getBoundingClientRect();
      const tabs = [...node.querySelectorAll('.workspace-tab-header')];
      return {
        index: index,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        tabCount: tabs.length,
        tabWidths: tabs.slice(0, 4).map((tab) => Math.round(tab.getBoundingClientRect().width)),
        labels: tabs.slice(0, 6).map((tab) => (tab.getAttribute('data-type') || '') + ':' + (tab.textContent || '').trim().slice(0, 24)),
        parentClasses: (node.parentElement?.className || '') + ' < ' + (node.parentElement?.parentElement?.className || '')
      };
    })
  };
})()`;

const report = await evaluate(REPORT);
if (report.__error) {
  console.error(report.__error);
  process.exit(1);
}

console.log(`viewport ${report.viewport.w}x${report.viewport.h} @${report.devicePixelRatio}x`);
console.log(`\n${report.candidates.length} elements carry .workspace-tab-header-container:\n`);
for (const candidate of report.candidates) {
  console.log(`  [${candidate.index}] ${candidate.rect.w}x${candidate.rect.h} at (${candidate.rect.x},${candidate.rect.y})  ${candidate.tabCount} tabs, widths ${candidate.tabWidths.join(',')}`);
  console.log(`      ${candidate.labels.join(' | ')}`);
  console.log(`      in ${candidate.parentClasses}`);
}

const out = path.join(projectRoot, '.scratch', 'obsidian-candidates.json');
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\n${path.relative(projectRoot, out)}`);
process.exit(0);
