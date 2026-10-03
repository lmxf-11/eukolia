/**
 * Screenshot a local HTML file with Electron's own Chromium.
 *
 * A question about rendered pixels — does this corner curve the right way, is
 * there a line between these two surfaces — cannot be answered by reading CSS, and
 * opening the application to ask it would mean writing to the session of whoever
 * is using the application. This loads a file into a throwaway window instead:
 * same engine, same stylesheets, no session.
 *
 * Usage: node scripts/probe-harness.mjs <file.html> <out.png> [width] [height] [scale]
 *        node scripts/probe-harness.mjs <file.html> <out.png> --view x y w h [scale]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

const file = path.resolve(projectRoot, process.argv[2] ?? '.scratch/tabjoin.html');
const out = path.resolve(projectRoot, process.argv[3] ?? '.scratch/tabjoin.png');

/*
 * A region of the page to look at closely.
 *
 * The window is *sized* to the region and the page scrolled to it, rather than the
 * region being cropped out of a larger capture. Cropping should be the simpler
 * thing and is not: `capturePage` with a rect returns an empty image for a window
 * that is not shown, and `NativeImage.crop` on the whole capture came back blank as
 * well. A small window that happens to be showing the right 40 pixels needs neither
 * of them, and the image is then enlarged, so what is inspected is the shipped
 * rendering at its real size rather than a re-layout at a larger one.
 */
const viewIndex = process.argv.indexOf('--view');
const view =
  viewIndex === -1
    ? null
    : {
        x: Number(process.argv[viewIndex + 1]),
        y: Number(process.argv[viewIndex + 2]),
        width: Number(process.argv[viewIndex + 3]),
        height: Number(process.argv[viewIndex + 4])
      };

const width = view ? view.width : Number(process.argv[4] ?? 900);
const height = view ? view.height : Number(process.argv[5] ?? 300);
const scaleArg = view ? process.argv[viewIndex + 5] : process.argv[6];
const scale = Number(scaleArg ?? 3);

if (!fs.existsSync(file)) {
  console.error(`no such harness: ${file}`);
  process.exit(2);
}

function electronBinary() {
  try {
    const require = createRequire(import.meta.url);
    const resolved = require('electron');
    if (typeof resolved === 'string' && fs.existsSync(resolved)) return resolved;
  } catch {
    /* fall through */
  }
  const candidates = [
    path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

const binary = electronBinary();
if (!binary) {
  console.error('Could not locate the Electron binary.');
  process.exit(7);
}

/*
 * The capture script runs *in the main process*, which is the point: only there
 * is `BrowserWindow` reachable, and a window is what has a page to screenshot.
 */
const mainScript = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const target = ${JSON.stringify(file)};
const out = ${JSON.stringify(out)};
const scale = ${scale};

app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: ${width},
    height: ${height},
    show: false,
    backgroundColor: '#0e1017',
    webPreferences: { offscreen: false, contextIsolation: true, nodeIntegration: false }
  });
  await window.loadFile(target);
  // A frame after load, so the stylesheet is applied and painted.
  await new Promise((resolve) => setTimeout(resolve, 900));

  /*
   * The capture.
   *
   * With a view the document is scrolled so the region fills a window that is
   * exactly its size; without one the whole page is captured. Either way the page
   * is drawn at its real size, and the enlargement happens on the captured image.
   *
   * No backticks in this comment: it is inside a template literal.
   */
  const view = ${JSON.stringify(view)};
  if (view) {
    await window.webContents.executeJavaScript(
      'window.scrollTo(' + view.x + ',' + view.y + '); true'
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  let image = await window.webContents.capturePage();
  if (view && ${scale} > 1) {
    image = image.resize({
      width: Math.round(view.width * ${scale}),
      height: Math.round(view.height * ${scale}),
      quality: 'best'
    });
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  app.exit(0);
});
`;

const mainPath = path.join(projectRoot, '.scratch', 'harness-main.cjs');
fs.mkdirSync(path.dirname(mainPath), { recursive: true });
fs.writeFileSync(mainPath, mainScript, 'utf8');

const child = spawn(binary, [mainPath], {
  cwd: projectRoot,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

const timer = setTimeout(() => {
  console.error('the harness timed out');
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  process.exit(3);
}, 60_000);

child.on('close', (code) => {
  clearTimeout(timer);
  if (fs.existsSync(out)) {
    console.log(`${path.relative(projectRoot, out)}  (${Math.round(fs.statSync(out).size / 1024)} kB)`);
    process.exit(0);
  }
  console.error(`no screenshot (exit ${code})\n${stderr.slice(-2000)}`);
  process.exit(1);
});
