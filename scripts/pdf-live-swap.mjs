/** Real-app live-preview regression scenarios for probe-pdf-frames.mjs.
 * PowerShell: $env:PDF_PROBE_LIVE_SWAP='1'; node scripts/probe-pdf-frames.mjs
 * Only the harness's isolated copy is rewritten. No compiler or user file is touched.
 */
import fs from 'node:fs';

export function liveSwapFixture(count, revision) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${count} /Kids [${Array.from({length:count},(_,i)=>`${4+i*2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i=0;i<count;i++) {
    const text = `BT /F1 20 Tf 50 700 Td (Live preview page ${i+1}) Tj 0 -40 Td (Committed revision ${revision}) Tj` +
      Array.from({length:10+revision},(_,line)=>` 0 -25 Td (Appended line ${line+1}) Tj`).join('') + ' ET';
    const width = count > 5 && i === count-1 ? 1200 : 612;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
  }
  let pdf = '%PDF-1.4\n'; const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);
  pdf+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('');
  return Buffer.from(pdf+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

export async function probeLiveSwap({pdf,evaluate,send,sleep,coverageScript,output}) {
  const results=[];
  const state=()=>evaluate(`(() => {const s=document.querySelector('[data-testid="pdf-scroll-container"]');return {generation:Number(s.dataset.docGeneration),top:s.scrollTop,left:s.scrollLeft,scale:s.dataset.scale,pages:Number(s.dataset.docPageCount)};})()`);
  const waitFor=async(predicate)=>{for(let i=0;i<100;i++){const s=await state();if(predicate(s))return s;await sleep(100);}throw new Error('Preview did not converge');};
  const fingerprint=()=>evaluate(`(() => {const s=document.querySelector('[data-testid="pdf-scroll-container"]');let hash=2166136261;for(const c of s.querySelectorAll('[data-page="2"] canvas')){if(!c.width||!c.height)continue;const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let i=0;i<a.length;i+=4){hash=Math.imul(hash^a[i],16777619);}}return hash>>>0;})()`);
  for(const tiled of [false,true]) {
    if(tiled)for(let i=0;i<4;i++){await evaluate(`document.querySelector('[data-testid="pdf-toolbar"] [data-command="295"]').click()`);await sleep(150);}
    await evaluate(`(()=>{const s=document.querySelector('[data-testid="pdf-scroll-container"]');s.scrollTop=${tiled?1700:900};s.dispatchEvent(new Event('scroll'));})()`);
    await sleep(1000);
    const before=await state(), oldPixels=await fingerprint();
    await evaluate(`window.__swapSamples=[];window.__swapMonitoring=true;requestAnimationFrame(function sample(){if(!window.__swapMonitoring)return;const s=document.querySelector('[data-testid="pdf-scroll-container"]');window.__swapSamples.push({top:s.scrollTop,left:s.scrollLeft,scale:s.dataset.scale,overlay:/Opening PDF|Could not open the PDF/.test(s.parentElement.textContent),painted:s.querySelectorAll('canvas[data-painted="1"],[data-pdf-tile]').length});requestAnimationFrame(sample);})`);
    // Identical bytes with a new filesystem stamp must not trigger new pixels.
    const bytes=fs.readFileSync(pdf);fs.writeFileSync(pdf,bytes);await sleep(750);
    if((await state()).generation!==before.generation)throw new Error('Identical PDF invalidated the preview');
    // Leave a partial compiler output long enough for the watcher and retry.
    fs.writeFileSync(pdf,bytes.subarray(0,Math.floor(bytes.length/3)));await sleep(1800);
    if((await state()).generation!==before.generation)throw new Error('Partial document was committed');
    const preserved=await evaluate(coverageScript);
    if(preserved.coverage<.98)throw new Error('Failed refresh lost old page coverage');
    const revision=tiled?4:2;
    fs.writeFileSync(pdf,liveSwapFixture(6,revision));
    const after=await waitFor(s=>s.generation>before.generation&&s.pages===6);
    await sleep(1000);
    const coverage=await evaluate(coverageScript),newPixels=await fingerprint();
    const samples=await evaluate('window.__swapMonitoring=false;window.__swapSamples');
    const moved=samples.filter(s=>Math.abs(s.top-before.top)>.5||Math.abs(s.left-before.left)>.5||s.scale!==before.scale);
    const overlays=samples.filter(s=>s.overlay),blank=samples.filter(s=>s.painted===0);
    const result={tiled,before,after,samples:samples.length,moved:moved.length,overlays:overlays.length,blank:blank.length,
      preservedCoverage:preserved.coverage,settledCoverage:coverage.coverage,pixelsChanged:oldPixels!==newPixels,oldPixels,newPixels,tiles:coverage.tiles,state:coverage.state};
    results.push(result);
    fs.writeFileSync(output+'-swap-progress.json',JSON.stringify(results,null,2));
    const shot=await send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(output+`-swap-${tiled?'tiles':'pages'}.png`,Buffer.from(shot.data,'base64'));
    if(moved.length||overlays.length||blank.length||coverage.coverage<.98||oldPixels===newPixels||(tiled&&coverage.tiles===0))
      throw new Error('Live swap presentation regression: '+JSON.stringify(result));
  }
  return results;
}
