/** Real Electron PDF benchmark. Isolated profile and copied PDF; no user settings changed.
 * node scripts/probe-pdf-frames.mjs [file.pdf]
 * ELECTRON_BINARY selects a packaged executable; PDF_PROBE_OUTPUT selects report prefix.
 * rAF cadence is a proxy, not measured monitor presentation. Coverage samples run separately
 * from frame timing so DOM measurement does not distort the measured gesture.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { liveSwapFixture, probeLiveSwap } from './pdf-live-swap.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const binary = process.env.ELECTRON_BINARY || require('electron');
const source = path.resolve(process.argv[2] || path.join(root, 'tests/pdf/fixtures/fixture.pdf'));
const dir = path.join(root, '.scratch', `pdf-frames-${Date.now()}`);
const profile = path.join(dir, 'profile'), library = path.join(dir, 'library'), project = path.join(library, 'fixture');
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(library, '.eukolia'), { recursive: true });
const pdf = path.join(project, 'main.pdf'), tex = path.join(project, 'main.tex');
fs.copyFileSync(source, pdf);
if (process.env.PDF_PROBE_LIVE_SWAP) fs.writeFileSync(pdf, liveSwapFixture(5, 0));
fs.writeFileSync(tex, '\\documentclass{article}\n\\begin{document}PDF performance fixture.\\end{document}\n');
fs.writeFileSync(path.join(profile, 'project-library.json'), JSON.stringify({ root: library }));
fs.writeFileSync(path.join(library, '.eukolia/settings.json'), JSON.stringify({ 'pdf.toolbar': 'show', 'pdf.showToc': false, 'pdf.renderAheadPages': 1,
  ...(process.env.PDF_PROBE_LIVE_SWAP ? { 'pdf.autoReload': true, 'pdf.reloadCheckIntervalMs': 250 } : {}) }));
fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify({ workspacePath: project, openFiles: [tex], activeFile: tex,
  rootFile: tex, layout: 'split', editorMode: 'code', sidebarVisible: false, pdfVisible: true, pdfPath: pdf,
  pdfPage: 1, pdfZoom: 1, recentWorkspaces: [], unsavedBuffers: {} }));
const port = Number(process.env.PDF_PROBE_PORT || 9368);
const output = path.resolve(process.env.PDF_PROBE_OUTPUT || path.join(root, '.scratch/pdf-frames'));
const child = spawn(binary, [...(path.basename(binary).toLowerCase() === 'electron.exe' ? ['.'] : []),
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { cwd: root,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let errors = ''; child.stderr.on('data', b => { errors += b; }); child.stdout.resume();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, seq = 0; const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
const coverageScript = `(() => {
  const scroller = document.querySelector('[data-testid="pdf-scroll-container"]');
  const viewport = scroller.getBoundingClientRect();
  const intersect = (a,b) => ({left:Math.max(a.left,b.left),top:Math.max(a.top,b.top),right:Math.min(a.right,b.right),bottom:Math.min(a.bottom,b.bottom)});
  const area = r => Math.max(0,r.right-r.left)*Math.max(0,r.bottom-r.top);
  const union = rects => {
    const xs = [...new Set(rects.flatMap(r=>[r.left,r.right]))].sort((a,b)=>a-b); let total=0;
    for(let i=1;i<xs.length;i++) { const intervals=rects.filter(r=>r.left<xs[i]&&r.right>xs[i-1]).map(r=>[r.top,r.bottom]).sort((a,b)=>a[0]-b[0]);
      let end=-Infinity, height=0; for(const [a,b] of intervals){height+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);} total+=(xs[i]-xs[i-1])*height; }
    return total;
  };
  let total=0,covered=0,sharp=0;
  const scale=Number(scroller.dataset.scale)*devicePixelRatio;
  for(const page of scroller.querySelectorAll('[data-page]')) {
    const visible=intersect(page.getBoundingClientRect(),viewport); if(!area(visible))continue; total+=area(visible);
    const surfaces=[...page.querySelectorAll('canvas')].filter(c=>c.dataset.pdfTile||c.dataset.painted==='1');
    const rectangles=surfaces.map(c=>intersect(c.getBoundingClientRect(),visible)).filter(area); covered+=union(rectangles);
    const sharpRects=surfaces.filter(c=>c.dataset.pdfTile ? Math.abs(Number(c.dataset.pdfTile.split('/')[2])-scale)<0.02 : Math.abs(c.width/c.getBoundingClientRect().width-devicePixelRatio)<0.03).map(c=>intersect(c.getBoundingClientRect(),visible)).filter(area); sharp+=union(sharpRects);
  }
  return {coverage:total?covered/total:1,sharpness:total?sharp/total:1,scale,tiles:scroller.querySelectorAll('[data-pdf-tile]').length,
    maxCanvasPixels:Math.max(0,...[...scroller.querySelectorAll('canvas')].map(c=>c.width*c.height)),scrollTop:scroller.scrollTop,
    metrics:window.__eukoliaPdfMetrics?.snapshot(),state:{...scroller.dataset}};
})()`;
try {
  let target;
  for(let i=0;i<100;i++) { try { target=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page'&&t.url.includes('index.html')); }catch{} if(target)break; await sleep(200); }
  if(!target)throw new Error('No app window: '+errors.slice(-2000));
  socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',e=>{const m=JSON.parse(e.data); if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
  await send('Runtime.enable'); await send('Page.enable'); await send('Page.bringToFront');
  for(let i=0;i<120;i++){if(await evaluate(`!!document.querySelector('[data-testid="pdf-scroll-container"]') && !document.querySelector('#eukolia-boot')`))break;await sleep(250);}
  await sleep(1200);
  await evaluate(`window.__eukoliaPdfMetrics?.enable()`);
  const report={source, binary, profile, recordedAt:new Date().toISOString(), interpretation:'rAF cadence, not monitor presentation; cold and warm runs are distinct',scenarios:[]};
  if (process.env.PDF_PROBE_LIVE_SWAP) {
    report.liveSwap = await probeLiveSwap({ pdf, evaluate, send, sleep, coverageScript, output });
    fs.writeFileSync(output+'.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify(report.liveSwap,null,2));
  } else {
  for(const zoomClicks of [0,4]) {
    for(let i=0;i<zoomClicks;i++){await evaluate(`(() => {const button=document.querySelector('[data-testid="pdf-toolbar"] [data-command="295"]');if(!button)throw new Error('Zoom button missing');button.click();})()`);await sleep(200);}
    await sleep(1200);
    const start=await evaluate(coverageScript);
    const rect=await evaluate(`document.querySelector('[data-testid="pdf-scroll-container"]').getBoundingClientRect().toJSON()`);
    for(const direction of [1,-1]) {
      await evaluate(`window.__pdfFrames=[]; window.__pdfMeasuring=true; window.__pdfLast=0;
        requestAnimationFrame(function frame(t){if(!window.__pdfMeasuring)return;if(window.__pdfLast)window.__pdfFrames.push(t-window.__pdfLast);window.__pdfLast=t;requestAnimationFrame(frame);});`);
      for(let i=0;i<45;i++){await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:rect.x+rect.width/2,y:rect.y+rect.height/2,deltaY:direction*85,deltaX:0});await sleep(16);}
      await sleep(200);
      const frames=await evaluate(`window.__pdfMeasuring=false;window.__pdfFrames`);
      const immediate=await evaluate(coverageScript); await sleep(1200); const settled=await evaluate(coverageScript);
      const sorted=[...frames].sort((a,b)=>a-b), percentile=q=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))]||0;
      report.scenarios.push({zoomClicks,direction,start,immediate,settled,frames,summary:{p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),over50:frames.filter(n=>n>50).length}});
    }
  }
  await evaluate(`document.querySelector('[data-testid="pdf-toolbar"] [data-command="224"]').click()`);
  await sleep(1800);
  report.rotated = await evaluate(coverageScript);
  const rotatedShot=await send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(output+'-rotated.png',Buffer.from(rotatedShot.data,'base64'));
  await evaluate(`document.querySelector('[data-testid="pdf-toolbar"] [data-command="223"]').click()`);
  await sleep(800);
  const shot=await send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(output+'.png',Buffer.from(shot.data,'base64'));
  fs.writeFileSync(output+'.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report.scenarios.map(s=>({zoomClicks:s.zoomClicks,direction:s.direction,...s.summary,coverage:s.settled.coverage,sharpness:s.settled.sharpness,tiles:s.settled.tiles,maxCanvasPixels:s.settled.maxCanvasPixels})),null,2));
  if(report.scenarios.some(s=>s.settled.coverage<.98))throw new Error('Settled viewport coverage below 98%; inspect report/screenshot');
  if(!report.scenarios.some(s=>s.zoomClicks>0&&s.settled.tiles>0))throw new Error('High zoom never exercised tiled presentation');
  if(report.rotated.coverage<.98)throw new Error('Rotated viewport has uncovered regions');
  }
} finally { socket?.close(); child.kill(); fs.writeFileSync(output+'.stderr.log',errors); }
