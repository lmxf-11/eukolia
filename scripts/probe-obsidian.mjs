/**
 * Read Obsidian's own tab bar out of the running application.
 *
 * The point of this over reading `app.css` is that the cascade is not visible in a
 * stylesheet. A rule can be present and overridden; a shadow can resolve to `none`; a
 * pseudo-element can exist with no `content` and therefore no box at all. Those are
 * exactly the failures that cost six rounds on Eukolia's corner, and every one of them
 * is invisible in the source and obvious in the computed style.
 *
 * So: connect to the live window, find the tab strip, and report what each part
 * actually resolves to — plus the geometry, so the corner can be reconstructed from
 * measurements instead of inferred.
 *
 * Usage: node scripts/probe-obsidian.mjs
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
  console.error('no Obsidian page on the debug port; launch it with --remote-debugging-port=9222');
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
await new Promise((resolve) => setTimeout(resolve, 1500));

/*
 * Everything about a tab that decides its shape, read through `getComputedStyle` on
 * the live elements — including the pseudo-elements, which is where a browser-tab
 * corner is usually drawn and where a stylesheet alone tells you the least.
 */
const REPORT = `(() => {
  const style = (node, pseudo) => getComputedStyle(node, pseudo || undefined);
  const describe = (node, label) => {
    if (!node) return { label: label, absent: true };
    const s = style(node);
    const rect = node.getBoundingClientRect();
    const before = style(node, '::before');
    const after = style(node, '::after');
    const pseudo = (p, name) => ({
      content: p.content,
      width: p.width,
      height: p.height,
      left: p.left,
      right: p.right,
      bottom: p.bottom,
      top: p.top,
      position: p.position,
      background: p.backgroundImage === 'none' ? p.backgroundColor : 'image',
      boxShadow: p.boxShadow,
      borderTopLeftRadius: p.borderTopLeftRadius,
      borderBottomLeftRadius: p.borderBottomLeftRadius,
      borderBottomRightRadius: p.borderBottomRightRadius,
      borderTopRightRadius: p.borderTopRightRadius,
      transform: p.transform,
      clipPath: p.clipPath,
      maskImage: p.maskImage,
      name: name
    });
    return {
      label: label,
      className: typeof node.className === 'string' ? node.className : '',
      rect: { x: Math.round(rect.x * 10) / 10, y: Math.round(rect.y * 10) / 10, w: Math.round(rect.width * 10) / 10, h: Math.round(rect.height * 10) / 10 },
      background: s.backgroundColor,
      backgroundImage: s.backgroundImage === 'none' ? null : 'image',
      borderRadius: s.borderTopLeftRadius + ' / ' + s.borderTopRightRadius + ' / ' + s.borderBottomRightRadius + ' / ' + s.borderBottomLeftRadius,
      borderTop: s.borderTopWidth + ' ' + s.borderTopColor,
      borderBottom: s.borderBottomWidth + ' ' + s.borderBottomColor,
      borderLeft: s.borderLeftWidth + ' ' + s.borderLeftColor,
      boxShadow: s.boxShadow,
      margin: s.marginTop + ' ' + s.marginRight + ' ' + s.marginBottom + ' ' + s.marginLeft,
      padding: s.paddingTop + ' ' + s.paddingRight + ' ' + s.paddingBottom + ' ' + s.paddingLeft,
      position: s.position,
      zIndex: s.zIndex,
      overflow: s.overflow,
      clipPath: s.clipPath,
      maskImage: s.maskImage,
      before: pseudo(before, '::before'),
      after: pseudo(after, '::after'),
      childCount: node.children.length,
      text: (node.textContent || '').trim().slice(0, 40)
    };
  };

  const container = document.querySelector('.workspace-tab-header-container');
  const inner = document.querySelector('.workspace-tab-header-container-inner');
  const tabs = [...document.querySelectorAll('.workspace-tab-header')];
  const active = tabs.find((tab) => tab.classList.contains('is-active')) || tabs[0];
  const idle = tabs.find((tab) => tab !== active);

  const variables = {};
  const root = style(document.body);
  for (const name of ['--tab-curve', '--tab-radius-active', '--tab-outline-color', '--tab-outline-width', '--tab-background-active', '--tab-container-background', '--tab-width', '--tab-max-width', '--header-height', '--background-primary', '--background-secondary']) {
    variables[name] = root.getPropertyValue(name).trim();
  }

  return {
    tabCount: tabs.length,
    variables: variables,
    container: describe(container, 'container'),
    inner: describe(inner, 'inner'),
    active: describe(active, 'active'),
    idle: describe(idle, 'idle'),
    order: [...(container?.parentElement?.children ?? [])].map((child) => (typeof child.className === 'string' ? child.className : child.tagName)).filter(Boolean).slice(0, 12)
  };
})()`;

const report = await evaluate(REPORT);
const out = path.join(projectRoot, '.scratch', 'obsidian-tabs.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

if (report.__error) {
  console.error(report.__error);
  process.exit(1);
}

console.log(`tabs: ${report.tabCount}`);
console.log('\n-- variables --');
for (const [name, value] of Object.entries(report.variables)) console.log(`  ${name.padEnd(26)} ${value}`);

for (const key of ['container', 'inner', 'active', 'idle']) {
  const node = report[key];
  console.log(`\n-- ${key} --`);
  if (!node || node.absent) {
    console.log('  absent');
    continue;
  }
  console.log(`  class      ${node.className}`);
  console.log(`  rect       x=${node.rect.x} y=${node.rect.y} w=${node.rect.w} h=${node.rect.h}`);
  console.log(`  background ${node.background}${node.backgroundImage ? ' +image' : ''}`);
  console.log(`  radius     ${node.borderRadius}`);
  console.log(`  border     top ${node.borderTop} | bottom ${node.borderBottom} | left ${node.borderLeft}`);
  console.log(`  shadow     ${node.boxShadow}`);
  console.log(`  margin     ${node.margin}`);
  console.log(`  padding    ${node.padding}`);
  console.log(`  position   ${node.position} z=${node.zIndex} overflow=${node.overflow}`);
  console.log(`  clip/mask  ${node.clipPath} / ${node.maskImage}`);
  for (const pseudo of ['before', 'after']) {
    const p = node[pseudo];
    console.log(`  ${pseudo}       content=${p.content} size=${p.width}x${p.height} pos=${p.position} bottom=${p.bottom} left=${p.left} right=${p.right} top=${p.top}`);
    console.log(`             bg=${p.background} shadow=${p.boxShadow}`);
    console.log(`             radius=${p.borderTopLeftRadius}/${p.borderTopRightRadius}/${p.borderBottomRightRadius}/${p.borderBottomLeftRadius} clip=${p.clipPath}`);
  }
}

console.log('\n-- the container\'s children, in paint order --');
for (const item of report.order) console.log(`  ${item}`);
console.log(`\nfull report: ${path.relative(projectRoot, out)}`);
process.exit(0);
