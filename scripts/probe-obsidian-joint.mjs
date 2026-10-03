/**
 * Read Obsidian's *joint* between two adjacent tabs out of the running window.
 *
 * The single-tab corner was readable from the stylesheet; the joint is not, because it
 * is whatever two neighbouring tabs' edges leave between them, and that depends on the
 * gap they are laid out with and on each one's radius. So this reports, for a pair of
 * adjacent tabs:
 *
 *   - both rects, and therefore the gap between them;
 *   - every computed value that could draw something in that gap, including the
 *     pseudo-elements of both tabs, since that is where a browser tab's joint is
 *     usually drawn and where a stylesheet tells you the least;
 *   - the same for the container, because a gap is often the container's background
 *     showing through rather than anything the tabs draw.
 *
 * Usage: node scripts/probe-obsidian-joint.mjs
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
        background: p.backgroundImage === 'none' ? p.backgroundColor : 'image:' + p.backgroundImage.slice(0, 70),
        boxShadow: p.boxShadow,
        radius: p.borderTopLeftRadius + ' ' + p.borderTopRightRadius + ' ' + p.borderBottomRightRadius + ' ' + p.borderBottomLeftRadius,
        clipPath: p.clipPath,
        transform: p.transform
      };
    };
    return {
      label: label,
      classes: typeof node.className === 'string' ? node.className : '',
      rect: { x: px(rect.x), right: px(rect.right), y: px(rect.y), bottom: px(rect.bottom), w: px(rect.width), h: px(rect.height) },
      background: s.backgroundColor,
      radius: s.borderTopLeftRadius + ' ' + s.borderTopRightRadius + ' ' + s.borderBottomRightRadius + ' ' + s.borderBottomLeftRadius,
      borderBottom: s.borderBottomWidth + ' ' + s.borderBottomStyle + ' ' + s.borderBottomColor,
      boxShadow: s.boxShadow,
      margin: s.marginTop + ' ' + s.marginRight + ' ' + s.marginBottom + ' ' + s.marginLeft,
      padding: s.paddingTop + ' ' + s.paddingRight + ' ' + s.paddingBottom + ' ' + s.paddingLeft,
      position: s.position,
      overflow: s.overflow,
      before: pseudo('::before'),
      after: pseudo('::after')
    };
  };

  const containers = [...document.querySelectorAll('.workspace-tab-header-container')];
  const container = containers[1];
  const inner = container.querySelector('.workspace-tab-header-container-inner');
  const tabs = [...container.querySelectorAll('.workspace-tab-header')];

  /*
   * The pair to measure: two neighbours that are actually next to each other, chosen by
   * smallest gap rather than by index, because a strip can have tabs in any order and the
   * joint is what matters.
   */
  let pair = null;
  let smallest = Infinity;
  for (let index = 0; index + 1 < tabs.length; index += 1) {
    const left = tabs[index].getBoundingClientRect();
    const right = tabs[index + 1].getBoundingClientRect();
    const gap = right.left - left.right;
    if (gap >= -1 && gap < smallest) {
      smallest = gap;
      pair = [index, index + 1];
    }
  }

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    dpr: window.devicePixelRatio,
    tabCount: tabs.length,
    tabRects: tabs.map((tab, index) => {
      const rect = tab.getBoundingClientRect();
      return { index: index, x: px(rect.x), right: px(rect.right), bottom: px(rect.bottom), w: px(rect.width), active: tab.classList.contains('is-active') };
    }),
    pair: pair,
    gap: pair ? px(tabs[pair[1]].getBoundingClientRect().left - tabs[pair[0]].getBoundingClientRect().right) : null,
    container: describe(container, 'container'),
    inner: describe(inner, 'inner'),
    left: pair ? describe(tabs[pair[0]], 'left tab') : null,
    right: pair ? describe(tabs[pair[1]], 'right tab') : null
  };
})()`;

const report = await evaluate(REPORT);
if (report.__error) {
  console.error(report.__error);
  process.exit(1);
}

fs.mkdirSync(path.join(projectRoot, '.scratch'), { recursive: true });
const out = path.join(projectRoot, '.scratch', 'obsidian-joint.json');
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`viewport ${report.viewport.w}x${report.viewport.h} @${report.dpr}x   ${report.tabCount} tabs`);
console.log(`\ntabs: ${report.tabRects.map((t) => `[${t.index}]${t.active ? '*' : ''} ${t.x}..${t.right}`).join('  ')}`);
console.log(`\nclosest pair: ${JSON.stringify(report.pair)}   gap = ${report.gap}`);

for (const key of ['container', 'inner', 'left', 'right']) {
  const node = report[key];
  if (!node) continue;
  console.log(`\n== ${key} ==`);
  if (node.absent) {
    console.log('   absent');
    continue;
  }
  console.log(`  rect     x ${node.rect.x} .. ${node.rect.right}   y ${node.rect.y} .. ${node.rect.bottom}`);
  console.log(`  bg       ${node.background}`);
  console.log(`  radius   ${node.radius}`);
  console.log(`  border-b ${node.borderBottom}`);
  console.log(`  shadow   ${node.boxShadow}`);
  console.log(`  margin   ${node.margin}   padding ${node.padding}`);
  for (const which of ['before', 'after']) {
    const p = node[which];
    console.log(`  ${which.padEnd(7)} content=${p.content}  ${p.width} x ${p.height}  ${p.position}`);
    console.log(`          bottom=${p.bottom} left=${p.left} right=${p.right} top=${p.top}`);
    console.log(`          bg=${p.background}`);
    console.log(`          shadow=${p.boxShadow}`);
    console.log(`          radius=${p.radius} clip=${p.clipPath}`);
  }
}

console.log(`\n${path.relative(projectRoot, out)}`);
process.exit(0);
