// Exercise the production service in Electron's file:// renderer, without jsdom.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, '.scratch'), { recursive: true });
const temp = await mkdtemp(path.join(root, '.scratch', 'mathjax-renderer-'));
try {
  await build({
    entryPoints: [path.join(root, 'tests/renderer/mathjax-browser.ts')],
    bundle: true,
    outfile: path.join(temp, 'browser.js'),
    platform: 'browser',
  });
  const base = pathToFileURL(path.join(root, 'public') + path.sep).href;
  const script = pathToFileURL(path.join(temp, 'browser.js')).href;
  await writeFile(path.join(temp, 'index.html'),
    `<!doctype html><base href="${base}"><script src="${script}"></script>`);
  const electron = createRequire(import.meta.url)('electron');
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(root, 'tests/renderer/mathjax-electron.cjs'), temp], {
      cwd: root, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Renderer tests timed out')); }, 45000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); resolve(code ?? 1); });
  });
  process.exitCode = exitCode;
} finally {
  await rm(temp, { recursive: true, force: true });
}
