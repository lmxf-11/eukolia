/**
 * Read the *main* tab strip's shape, and the rows of pixels it draws.
 *
 * Everything that decides a tab's corner, read off the live element in Obsidian
 * itself: the container, its inner row, the active tab, an inactive tab, and both
 * pseudo-elements of each — plus the chain of ancestors, because which box paints the
 * line under the tabs is the question this whole thing turns on.
 *
 * Usage: node scripts/probe-obsidian-main.mjs
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
  const px = (value) => Math.round(parseFloat(value) * 100) / 100;
  const describe = (node, label) => {
    if (!node) return { label: label, absent: true };
    const s = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const pseudo = (which) => {
      const p = getComputedStyle(node, which);
      return {
        content: p.content,
        width: p.width, height: p.height,
        top: p.top, bottom: p.bottom, left: p.left, right: p.right,
        position: p.position,
        background: p.backgroundImage === 'none' ? p.backgroundColor : 'image:' + p.backgroundImage.slice(0, 60),
        boxShadow: p.boxShadow,
        radius: p.borderTopLeftRadius + ' ' + p.borderTopRightRadius + ' ' + p.borderBottomRightRadius + ' ' + p.borderBottomLeftRadius,
        clipPath: p.clipPath,
        transform: p.transform,
        mask: p.maskImage
      };
    };
    return {
      label: label,
      classes: typeof node.className === 'string' ? node.className : '',
      rect: { x: px(rect.x), y: px(rect.y), right: px(rect.right), bottom: px(rect.bottom), w: px(rect.width), h: px(rect.height) },
      background: s.backgroundColor,
      backgroundImage: s.backgroundImage === 'none' ? null : s.backgroundImage.slice(0, 80),
      radius: s.borderTopLeftRadius + ' ' + s.borderTopRightRadius + ' ' + s.borderBottomRightRadius + ' ' + s.borderBottomLeftRadius,
      borderTop: s.borderTopWidth + ' ' + s.borderTopStyle + ' ' + s.borderTopColor,
      borderBottom: s.borderBottomWidth + ' ' + s.borderBottomStyle + ' ' + s.borderBottomColor,
      borderLeft: s.borderLeftWidth + ' ' + s.borderLeftColor,
      borderRight: s.borderRightWidth + ' ' + s.borderRightColor,
      boxShadow: s.boxShadow,
      margin: s.marginTop + ' ' + s.marginRight + ' ' + s.marginBottom + ' ' + s.marginLeft,
      padding: s.paddingTop + ' ' + s.paddingRight + ' ' + s.paddingBottom + ' ' + s.paddingLeft,
      position: s.position,
      zIndex: s.zIndex,
      overflow: s.overflow,
      clipPath: s.clipPath,
      transform: s.transform,
      before: pseudo('::before'),
      after: pseudo('::after')
    };
  };

  const containers = [...document.querySelectorAll('.workspace-tab-header-container')];
  const container = containers[1];
  const inner = container.querySelector('.workspace-tab-header-container-inner');
  const tabs = [...container.querySelectorAll('.workspace-tab-header')];
  const active = tabs.find((tab) => tab.classList.contains('is-active')) || tabs[0];
  const idle = tabs.find((tab) => tab !== active);

  /* The ancestor chain, so it is clear which box could be painting the line. */
  const chain = [];
  for (let node = container; node && node !== document.documentElement; node = node.parentElement) {
    const s = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    chain.push({
      classes: (typeof node.className === 'string' ? node.className : node.tagName).slice(0, 70),
      rect: { y: px(rect.y), h: px(rect.height) },
      background: s.backgroundColor,
      borderBottom: s.borderBottomWidth + ' ' + s.borderBottomColor,
      paddingBottom: s.paddingBottom,
      overflow: s.overflow
    });
  }

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    dpr: window.devicePixelRatio,
    container: describe(container, 'container'),
    inner: describe(inner, 'inner'),
    active: describe(active, 'active'),
    idle: describe(idle, 'idle'),
    activeFirstChild: active.firstElementChild ? describe(active.firstElementChild, 'active.firstChild') : null,
    activeLastChild: active.lastElementChild ? describe(active.lastElementChild, 'active.lastChild') : null,
    chain: chain
  };
})()`;

const report = await evaluate(REPORT);
if (report.__error) {
  console.error(report.__error);
  process.exit(1);
}

const out = path.join(projectRoot, '.scratch', 'obsidian-main.json');
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`viewport ${report.viewport.w}x${report.viewport.h} @${report.dpr}x\n`);

for (const key of ['container', 'inner', 'active', 'idle', 'activeFirstChild', 'activeLastChild']) {
  const node = report[key];
  if (!node) continue;
  console.log(`== ${key} ==`);
  if (node.absent) {
    console.log('   absent\n');
    continue;
  }
  console.log(`  classes  ${node.classes}`);
  console.log(`  rect     x ${node.rect.x} .. ${node.rect.right}   y ${node.rect.y} .. ${node.rect.bottom}   (${node.rect.w} x ${node.rect.h})`);
  console.log(`  bg       ${node.background}${node.backgroundImage ? '  image=' + node.backgroundImage : ''}`);
  console.log(`  radius   ${node.radius}`);
  console.log(`  border   top[${node.borderTop}] bottom[${node.borderBottom}] left[${node.borderLeft}] right[${node.borderRight}]`);
  console.log(`  shadow   ${node.boxShadow}`);
  console.log(`  margin   ${node.margin}   padding ${node.padding}`);
  console.log(`  layout   ${node.position} z=${node.zIndex} overflow=${node.overflow}`);
  console.log(`  clip     ${node.clipPath}   transform ${node.transform}`);
  for (const which of ['before', 'after']) {
    const p = node[which];
    console.log(`  ${which.padEnd(7)} content=${p.content}  ${p.width} x ${p.height}  ${p.position}`);
    console.log(`          top=${p.top} bottom=${p.bottom} left=${p.left} right=${p.right}`);
    console.log(`          bg=${p.background}`);
    console.log(`          shadow=${p.boxShadow}`);
    console.log(`          radius=${p.radius} clip=${p.clipPath} mask=${p.mask}`);
  }
  console.log('');
}

console.log('== ancestor chain (nearest first) ==');
for (const item of report.chain) {
  console.log(`  y ${item.rect.y} h ${item.rect.h}  bg ${item.background}  border-bottom ${item.borderBottom}  pb ${item.paddingBottom}  overflow ${item.overflow}`);
  console.log(`      ${item.classes}`);
}
console.log(`\n${path.relative(projectRoot, out)}`);
process.exit(0);
