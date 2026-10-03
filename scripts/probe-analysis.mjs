/**
 * Does the analyzer actually run in the main process?
 *
 * `src/renderer/parser/latexAnalysis.ts` prefers the `analysis:analyze` channel and
 * *falls back* to the renderer's own analyzer when the channel is unusable. The
 * fallback is deliberate — a window whose preload predates the channel must not
 * lose its macro index — and that is exactly what makes it dangerous: the fallback
 * works, the feature works, and the only symptom is that every parse now runs on
 * the thread the user is typing on. It logged one console warning and nothing else.
 *
 * So the question "is the analyzer in the main process?" cannot be answered by
 * whether analysis *happens*. It is answered by whether the renderer ever fetched
 * its own analyzer chunk: if the transport is in use, `latexAnalyzer` is never
 * loaded in the renderer at all, because the fallback is a dynamic import that only
 * runs when it is needed.
 *
 * That is what this checks, against a real project with a real `\input`, so the
 * project index has something to walk.
 *
 * Usage: node scripts/probe-analysis.mjs
 */
import { spawn } from 'node:child_process';
import fs, { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

function electronBinary() {
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

const binary = electronBinary();
if (!binary) {
  console.error('Could not locate the Electron binary.');
  process.exit(7);
}

const PORT = Number(process.env.EUKOLIA_ANALYSIS_PORT ?? 9381);
const scratch = path.join(projectRoot, '.scratch');
const USER_DATA = path.join(scratch, 'analysis-profile');
const LIBRARY = path.join(scratch, 'analysis-library');

fs.rmSync(USER_DATA, { recursive: true, force: true });
fs.rmSync(LIBRARY, { recursive: true, force: true });
fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(path.join(LIBRARY, '.eukolia'), { recursive: true });

/*
 * A project with included files, because that is what the walk is for: a single
 * document is analysed once, and the fallback might not be reached at all.
 */
const project = path.join(LIBRARY, 'analysis project');
fs.mkdirSync(project, { recursive: true });

const chapters = [];
for (let index = 1; index <= 6; index += 1) {
  const name = `chapter-${index}.tex`;
  fs.writeFileSync(
    path.join(project, name),
    [
      `\\chapter{Chapter ${index}}`,
      `\\label{ch:${index}}`,
      `\\section{Section ${index}.1}`,
      `\\begin{theorem}\\label{thm:${index}}A statement.\\end{theorem}`,
      `See \\ref{ch:${index}} and \\cite{knuth}.`,
      ''
    ].join('\n'),
    'utf8'
  );
  chapters.push(`\\input{${name.replace(/\.tex$/, '')}}`);
}

const mainTex = path.join(project, 'main.tex');
fs.writeFileSync(
  mainTex,
  [
    '\\documentclass{book}',
    '\\newcommand{\\probe}{probe}',
    '\\begin{document}',
    ...chapters,
    '\\end{document}',
    ''
  ].join('\n'),
  'utf8'
);

fs.writeFileSync(path.join(USER_DATA, 'project-library.json'), JSON.stringify({ root: LIBRARY }, null, 2), 'utf8');
fs.writeFileSync(
  path.join(USER_DATA, 'state.json'),
  JSON.stringify(
    {
      workspacePath: project,
      openFiles: [mainTex],
      activeFile: mainTex,
      rootFile: mainTex,
      layout: 'editor',
      editorMode: 'code',
      sidebarVisible: true,
      sidebarWidth: 260,
      pdfVisible: false,
      pdfPath: null,
      pdfPage: 1,
      pdfZoom: 1,
      theme: 'dark',
      recentWorkspaces: [],
      unsavedBuffers: {}
    },
    null,
    2
  ),
  'utf8'
);

const child = spawn(binary, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
  cwd: projectRoot,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shellTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
      const page = list.find((entry) => entry.type === 'page' && !/[?&]window=/.test(entry.url ?? ''));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  return null;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    this.console = [];
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(' ');
        this.console.push(`${message.params.type}: ${text}`);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails ?? {};
        this.console.push(`exception: ${details.exception?.description ?? details.text ?? 'unknown'}`);
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

/*
 * What the renderer actually fetched, and whether the channel is there.
 *
 * `performance.getEntriesByType('resource')` is the evidence: a chunk that was
 * never requested cannot appear in it, and the fallback analyzer is a dynamic
 * import that is only requested when it is used.
 */
const REPORT = `(() => {
  const names = performance.getEntriesByType('resource').map((entry) => entry.name);
  const has = (needle) => names.filter((name) => name.indexOf(needle) !== -1);
  return {
    analyzeDocumentOnBridge: typeof window.eukoliaApi?.analyzeDocument,
    totalResources: names.length,
    rendererAnalyzerChunks: has('latexAnalyzer'),
    linterWorkerChunks: has('latex-linter.worker'),
    documentMounted: !!document.querySelector('.cm-editor'),
    tabCount: document.querySelectorAll('[role="tab"]').length,
    editorLength: (document.querySelector('.cm-content')?.innerText ?? '').length
  };
})()`;

let payload = null;

try {
  const url = await shellTarget();
  if (!url) throw new Error(`no debuggable shell window on port ${PORT}`);

  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send('Runtime.enable');
  // Long enough for the session to restore, the project to be indexed and the
  // walk to reach its included files.
  await sleep(20_000);

  const report = await cdp.evaluate(REPORT);
  payload = { ok: true, report, console: cdp.console.slice(-40) };
} catch (error) {
  payload = { ok: false, error: String(error?.message ?? error), stderrTail: stderr.slice(-1500) };
} finally {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

writeFileSync(path.join(scratch, 'analysis-probe.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

if (!payload.ok) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

const r = payload.report;
console.log(`analyzeDocument on the bridge : ${r.analyzeDocumentOnBridge}`);
console.log(`editor mounted                : ${r.documentMounted} (${r.editorLength} chars, ${r.tabCount} tab(s))`);
console.log(`resources fetched by renderer : ${r.totalResources}`);
console.log(`renderer analyzer chunks      : ${r.rendererAnalyzerChunks.length ? r.rendererAnalyzerChunks.join(', ') : 'none  <- the transport is in use'}`);
console.log(`linter worker chunks          : ${r.linterWorkerChunks.length ? r.linterWorkerChunks.join(', ') : 'none'}`);
console.log('');
console.log('console, last 40 lines:');
for (const line of payload.console) console.log('  ', line.slice(0, 220));

const transportInUse = r.analyzeDocumentOnBridge === 'function' && r.rendererAnalyzerChunks.length === 0;
console.log('');
console.log(transportInUse
  ? 'VERDICT: the analyzer runs in the main process; the renderer never loaded its own copy'
  : 'VERDICT: the renderer loaded its own analyzer - the fallback is being used');
process.exit(transportInUse ? 0 : 1);
