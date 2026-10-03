/**
 * Eukolia — end-to-end smoke probe.
 *
 * Enabled only when `EUKOLIA_SMOKE_PROBE` is set (`npm run smoke`). It drives the
 * real built application through the real services and reports what happened:
 *
 *   1. opens the smoke fixture as a workspace;
 *   2. opens `main.tex` and checks Monaco mounted with real content;
 *   3. switches to Visual Mode and checks the Overleaf-derived CodeMirror
 *      surface mounted and decorated the document;
 *   4. runs the ampersand aligner and checks the source actually changed;
 *   5. compiles the document and checks a real PDF was produced;
 *   6. checks the PDF viewer opened it and rendered at least one page.
 *
 * Unit tests cover the pieces; this covers the wiring between them.
 */

import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { IPC } from '../shared/ipc';
import {
  configuredLibraryRoot,
  initializeLibrary,
  libraryUserDirectory,
  resolveUserSettingsFile,
  userSettingsSearchPaths,
} from './library/projectLibrary';

export function isSmokeProbeEnabled(): boolean {
  return process.env.EUKOLIA_SMOKE_PROBE === '1';
}

/**
 * Gives the probe its own project library, so the shell is reachable at all.
 *
 * The probe runs in a user-data directory of its own (§`main.ts`), which means
 * the first-run setup screen — "Choose or create a folder" — is what the window
 * opens on, and nothing behind it exists: no editor, no bottom panel, no status
 * bar. Every step of this probe is *inside* the shell, so the library has to
 * exist before the renderer asks for it.
 *
 * It is a real library in a scratch directory rather than a stub pointer, so the
 * probe exercises the same code path a user's first launch does. The snippets of
 * the machine's own library are *copied* into it when one is configured, because
 * the probe's snippet steps type triggers that live in that library ("RR",
 * "@a") — copying keeps those steps meaningful without letting a probe that
 * toggles a setting write into the library the developer works in. Settings are
 * not copied: the probe's own directory has none, which is what makes the run
 * isolated.
 *
 * Returns the root, or null when the seed failed (the probe then reports the
 * setup screen it is looking at rather than a mystery).
 */
export function seedSmokeLibrary(userData: string, realUserData: string): string | null {
  try {
    const root = path.join(app.getPath('temp'), `eukolia-smoke-library-${process.pid}`);
    fs.mkdirSync(userData, { recursive: true });
    let snippets: string | undefined;
    try {
      const configured = configuredLibraryRoot(realUserData);
      if (configured) {
        const shared = path.join(configured, '.eukolia');
        if (fs.existsSync(shared)) snippets = shared;
      }
    } catch {
      /* a damaged pointer in the developer's own directory is not the probe's problem */
    }
    initializeLibrary(userData, root, snippets);
    return root;
  } catch (error) {
    process.stderr.write(`[smoke] could not seed a project library: ${String(error)}\n`);
    return null;
  }
}

/**
 * When set, a PDF step that cannot run because the native worker is missing is
 * reported as skipped rather than as a failure.
 *
 * This exists for developing the *other* surfaces while the native engine is
 * being rebuilt — the visual editor has nothing to do with MuPDF, and blocking
 * its verification on a native link error wastes a cycle. The default remains
 * strict, so the end-to-end check still fails loudly when the engine is absent.
 */
function allowsMissingNativeEngine(): boolean {
  return process.env.EUKOLIA_SMOKE_ALLOW_MISSING_PDF === '1';
}

/**
 * The fixture workspace, copied to a scratch directory before use.
 *
 * The probe saves the document and compiles it, so running it against the
 * checked-in fixture would rewrite the very file it is asserting on — the second
 * run would then see an already-aligned document and report a false failure.
 * Copying per run keeps `tests/smoke/fixture/` canonical.
 */
function fixtureDirectory(): string {
  const explicit = process.env.EUKOLIA_SMOKE_WORKSPACE;
  const source = explicit && fs.existsSync(explicit) ? explicit : path.join(app.getAppPath(), 'tests', 'smoke', 'fixture');

  const target = path.join(app.getPath('temp'), `eukolia-smoke-${process.pid}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    // Sources are always copied. A previous run's build output would make
    // latexmk report "nothing to do" and hide the diagnostics being asserted on,
    // so a PDF is copied only when no `.tex` of the same name sits beside it —
    // that admits `\includegraphics` assets while excluding `main.pdf` and
    // `homework.pdf`.
    const isSource = /\.(tex|bib|cls|sty)$/i.test(entry.name);
    const isAsset =
      /\.pdf$/i.test(entry.name) &&
      !fs.existsSync(
        path.join(source, `${entry.name.replace(/\.pdf$/i, '')}.tex`)
      );
    if (!isSource && !isAsset) continue;
    fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name));
  }

  return target;
}

interface ProbeReport {
  ok: boolean;
  stage: string;
  problems: string[];
  probe: Record<string, unknown>;
  consoleMessages: string[];
}

/** One `executeJavaScript` result, as plain data. */
type ProbeSection = Record<string, unknown>;

/** Reads a probe section that the script always produces. */
function section(probe: Record<string, unknown>, key: string): ProbeSection {
  const value = probe[key];
  return value && typeof value === 'object' ? (value as ProbeSection) : {};
}

export async function runSmokeProbe(window: BrowserWindow): Promise<void> {
  const consoleMessages: string[] = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) consoleMessages.push(message);
  });

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const evaluate = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script) as Promise<T>;

  const probe = {} as Record<string, unknown>;
  const problems: string[] = [];

  const finish = (stage: string): void => {
    const fatal = consoleMessages.filter(
      (message) =>
        !/Electron Security Warning|Insecure Content-Security-Policy|unsafe-eval|DevTools|Autofill/i.test(message) &&
        /error|uncaught|failed|refused/i.test(message)
    );
    if (fatal.length > 0) problems.push(`renderer console errors: ${fatal.slice(0, 3).join(' | ')}`);
    const report: ProbeReport = { ok: problems.length === 0, stage, problems, probe, consoleMessages: consoleMessages.slice(0, 12) };
    probe.panelTrace = panelTrace;
    process.stdout.write(`__EUKOLIA_PROBE__${JSON.stringify(report)}\n`);
    setTimeout(() => app.exit(report.ok ? 0 : 1), 80);
  };

  /**
   * Records that a step has been reached, and what the bottom panel was showing.
   *
   * The step name goes to stderr, which the runner captures and prints: a probe
   * that hangs produces no payload, so without this the only evidence is "it
   * hung" with no indication of which surface was being exercised.
   *
   * The panel view is sampled alongside it because a state change between two
   * steps is otherwise invisible in the payload — the report says what the panel
   * showed when it was *read*, not what changed it on the way there. Sampling is
   * fire-and-forget so a step never blocks on it.
   */
  const panelTrace: Array<{ step: string; view: string | null; visible: boolean | null }> = [];
  const step = async (name: string): Promise<void> => {
    process.stderr.write('[smoke] step: ' + name + '\n');
    void window.webContents
      .executeJavaScript(
        `(() => {
          const panel = document.querySelector('[data-testid="bottom-panel"]');
          return { view: panel ? panel.getAttribute('data-panel-view') : null, visible: !!panel };
        })()`
      )
      .then((state: { view: string | null; visible: boolean }) => {
        panelTrace.push({ step: name, view: state?.view ?? null, visible: state?.visible ?? null });
      })
      .catch(() => undefined);
    // Awaited by every call site so the trace records the state each step *began*
    // in: fire-and-forget samples resolve out of order and make the sequence
    // unreadable.
    await new Promise((resolve) => setTimeout(resolve, 120));
  };
  const command = (id: string) => window.webContents.send('menu:command', id);

  /**
   * Saves a PNG of the window so a mode's appearance can be inspected directly
   * rather than inferred from DOM counts.
   */
  const capture = async (name: string): Promise<string | null> => {
    try {
      const image = await window.webContents.capturePage();
      const target = path.join(app.getAppPath(), '.scratch', `${name}.png`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, image.toPNG());
      return target;
    } catch (error) {
      console.error(`[smoke] could not capture ${name}:`, error);
      return null;
    }
  };

  try {
    await wait(7000);

    const workspace = fixtureDirectory();
    const texFile = path.join(workspace, 'main.tex');
    const pdfFile = path.join(workspace, 'main.pdf');

    // Screenshots of every surface are written next to the report so the
    // appearance of each mode can be reviewed without re-running the probe.
    probe.screenshots = path.join(app.getAppPath(), '.scratch');

    if (!fs.existsSync(texFile)) {
      problems.push(`smoke fixture is missing at ${texFile}`);
      finish('preflight');
      return;
    }

    // A stale PDF would make the build check meaningless.
    for (const stale of [pdfFile, path.join(workspace, 'main.synctex.gz'), path.join(workspace, 'main.aux')]) {
      if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
    }
    // The same applies to the failing document: latexmk caches its state, so a
    // second run would report "nothing to do" and produce no diagnostics at all.
    for (const artefact of ['aux', 'log', 'fls', 'fdb_latexmk', 'pdf', 'out', 'synctex.gz']) {
      const stale = path.join(workspace, `broken.${artefact}`);
      if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
    }

    window.webContents.send(IPC.protocol.openProject, workspace);
    await wait(6000);

    window.webContents.send(IPC.protocol.openFile, { kind: 'open', path: texFile });
    await wait(7000);

    // ---------------------------------------------------------- 1. Code Mode
    await step('1 Code Mode');
    //
    // The editing surface is being moved from Monaco to CodeMirror 6 so that Code
    // Mode and Visual Mode are one editor rather than two. The probe must not care
    // which engine is hosting it: these selectors are resolved once, in the page,
    // and the engine that answered is recorded. The same assertions therefore hold
    // before, during and after the move, instead of the probe having to be
    // rewritten in step with the editor — which would leave no way to tell a
    // broken editor from a stale selector.
    const EDITOR_DOM = `
      const cmRoot = document.querySelector('.cm-editor');
      const editorRoot = cmRoot || document.querySelector('.monaco-editor');
      const engine = cmRoot ? 'codemirror' : (editorRoot ? 'monaco' : null);
      const lineSelector = engine === 'codemirror' ? '.cm-line' : '.view-line';
      const gutterSelector = engine === 'codemirror' ? '.cm-lineNumbers .cm-gutterElement' : '.line-numbers';
      const tokenSelector = engine === 'codemirror' ? '[class*="tok-"]' : '[class*="mtk"]';
      const contentSelector = engine === 'codemirror' ? '.cm-content' : '.view-lines';
      const inputSelector = engine === 'codemirror' ? '.cm-content' : 'textarea.inputarea';
      const lineCount = () => document.querySelectorAll(lineSelector).length;
      const contentText = () => document.querySelector(contentSelector)?.innerText ?? '';
      const focusEditor = () => {
        const target = document.querySelector(inputSelector);
        if (target && typeof target.focus === 'function') target.focus();
        return !!target;
      };
      const errorMarkerSelector = engine === 'codemirror' ? '.cm-lintRange-error, .cm-lint-marker-error' : '.monaco-editor .squiggly-error';
      const warnMarkerSelector = engine === 'codemirror' ? '.cm-lintRange-warning, .cm-lint-marker-warning' : '.monaco-editor .squiggly-warning';
      const infoMarkerSelector = engine === 'codemirror' ? '.cm-lintRange-info, .cm-lint-marker-info' : '.monaco-editor .squiggly-info';
      const anyMarkerSelector = errorMarkerSelector + ', ' + warnMarkerSelector + ', ' + infoMarkerSelector;
    `;

    probe.codeMode = await evaluate<Record<string, unknown>>(`(() => {
      ${EDITOR_DOM}
      return {
        engine,
        editorMounted: !!editorRoot,
        renderedLines: lineCount(),
        gutterNumbers: document.querySelectorAll(gutterSelector).length,
        hasHighlighting: document.querySelectorAll(tokenSelector).length > 0,
        tabCount: document.querySelectorAll('[role="tab"], button[title*="main.tex"]').length,
        outlineEntries: (document.body.innerText.match(/Groups|Alignment|References/g) || []).length,
        // The bar is a single line of text; the encoding label is matched
        // case-insensitively so renaming the display (utf8 -> UTF-8) does not
        // silently empty this evidence field.
        statusBar: (document.body.innerText.split('\\n').filter((l) => /Ln \\d+|latexmk|utf-?8/i.test(l)) || []).join(' | ')
      };
    })()`);

    const codeMode = section(probe, 'codeMode');
    if (codeMode.editorMounted !== true) {
      problems.push(`Code Mode: no editor mounted (engine: ${String(codeMode.engine)})`);
    }
    if (Number(codeMode.renderedLines) < 10) {
      problems.push(`Code Mode: the editor rendered only ${codeMode.renderedLines} lines`);
    }
    if (codeMode.hasHighlighting !== true) problems.push('Code Mode: no syntax tokens were produced');
    if (Number(codeMode.gutterNumbers) === 0) {
      problems.push(`Code Mode: the editor rendered no line numbers (engine: ${String(codeMode.engine)})`);
    }
    // The status bar is part of the editor surface, so its two most useful facts
    // are asserted rather than only recorded: the cursor readout and the
    // encoding. Both were present before the bar was simplified, and a rewrite
    // that quietly drops one is a regression a screenshot would not catch.
    if (!/Ln \d+, Col \d+/.test(String(codeMode.statusBar ?? ''))) {
      problems.push(`Status bar: no \`Ln n, Col n\` cursor readout (${JSON.stringify(codeMode.statusBar)})`);
    }
    if (!/utf-?8/i.test(String(codeMode.statusBar ?? ''))) {
      problems.push(`Status bar: no encoding label (${JSON.stringify(codeMode.statusBar)})`);
    }

    await capture('01-code-mode');

    // ---------------------------------------------------------- 1b. dynamic imports
    await step('1b dynamic imports');
    //
    // Both the LaTeX language for Visual Mode and the LaTeX Workshop data are
    // loaded through dynamic `import()`, which Vite emits as a relative
    // specifier. That is a systemic risk under `file://`, and when one fails the
    // symptom is silence — an empty syntax tree rather than an error. Probing a
    // real chunk proves the mechanism works.
    const assetDirectory = path.join(app.getAppPath(), 'dist', 'assets');
    let probeChunk: string | null = null;
    try {
      probeChunk =
        fs
          .readdirSync(assetDirectory)
          .filter((name) => name.endsWith('.js') && name !== path.basename(window.webContents.getURL()))
          .sort((a, b) => a.length - b.length)[0] ?? null;
    } catch {
      probeChunk = null;
    }

    if (probeChunk) {
      probe.progressiveLoading = await evaluate<Record<string, unknown>>(`(async () => {
        const started = performance.now();
        try {
          const module_ = await import('./assets/${probeChunk}');
          return { chunk: ${JSON.stringify(probeChunk)}, loaded: true, exports: Object.keys(module_).length, ms: Math.round(performance.now() - started) };
        } catch (error) {
          return { chunk: ${JSON.stringify(probeChunk)}, loaded: false, error: String(error && error.message ? error.message : error) };
        }
      })()`);

      const loading = section(probe, 'progressiveLoading');
      if (loading.loaded !== true) {
        problems.push(
          `Code splitting: a dynamic import failed under file:// (${String(loading.chunk)}): ${String(loading.error)}`
        );
      }
    }

    // ---------------------------------------------------------- 2. Visual Mode
    await step('2 Visual Mode');
    //
    // Judged on the realistic document: a short fixture cannot show whether
    // headings, theorem blocks, lists and mathematics render as visual widgets
    // rather than raw LaTeX.
    const richFile = path.join(workspace, 'homework.tex');
    if (fs.existsSync(richFile)) {
      window.webContents.send(IPC.protocol.openFile, { kind: 'open', path: richFile });
      await wait(6000);
    }
    command('editor.visualMode');
    await wait(8000);

    probe.visualMode = await evaluate<Record<string, unknown>>(`(() => {
      const editor = document.querySelector('.cm-editor');
      const rendered = editor ? editor.innerText : '';
      // When the surface is missing, report what *is* in the editor pane: a
      // CodeMirror view can exist without being attached to the document, and
      // that is indistinguishable from "never mounted" without this.
      const host = document.querySelector('.eukolia-visual-editor');
      const paneText = (document.body.innerText || '').slice(0, 400);
      return {
        codeMirrorMounted: !!editor,
        hostPresent: !!host,
        hostChildren: host ? host.children.length : 0,
        detachedCmNodes: document.querySelectorAll('.cm-content, .cm-scroller, .cm-line').length,
        cmClassesAnywhere: Array.from(document.querySelectorAll('[class]'))
          .flatMap((node) => Array.from(node.classList))
          .filter((name) => name.startsWith('cm-'))
          .slice(0, 12),
        paneText,
        hasContent: !!editor && !!editor.querySelector('.cm-content'),
        renderedLength: rendered.length,
        // The visual editor renders a heading for \\section and drops the braces.
        showsHeadingWithoutBraces: rendered.includes('Groups') && !rendered.includes('\\\\section{Groups}'),
        mathRendered: !!document.querySelector('mjx-container, .cm-math, [class*="math"]'),
        rawIslandPreserved: rendered.includes('\\\\newcommand') || rendered.includes('newcommand'),
        domNodes: editor ? editor.querySelectorAll('*').length : 0
      };
    })()`);

    const visualMode = section(probe, 'visualMode');
    if (visualMode.codeMirrorMounted !== true) problems.push('Visual Mode: the CodeMirror surface did not mount');
    if (visualMode.hasContent !== true) problems.push('Visual Mode: no content element was rendered');
    if (Number(visualMode.renderedLength) < 200) {
      problems.push(`Visual Mode: only ${visualMode.renderedLength} characters were rendered`);
    }
    if (Number(visualMode.domNodes) < 50) {
      problems.push(`Visual Mode: only ${visualMode.domNodes} DOM nodes — decorations may not be applied`);
    }

    // `\includegraphics{figure.pdf}` must show the rendered page. The ported
    // Overleaf graphics widget draws into a canvas it owns, so the check is that
    // such a canvas exists *and* has more than one distinct colour in it — a
    // blank or never-painted canvas would satisfy a mere existence check.
    //
    // The figure is brought into view first. CodeMirror only builds DOM for the
    // lines it is showing, so a widget below the viewport simply is not in the
    // document, and a canvas lookup would report "no widget" for a figure that
    // renders perfectly well. The caret is put two lines *past* the figure:
    // a caret inside the node suppresses its own decoration by design, so
    // scrolling to the figure itself would hide the thing being checked.
    probe.visualFigureScrolled = await evaluate<Record<string, unknown>>(`(() => {
      const view = window.__cmView;
      if (!view) return { scrolled: false, reason: 'no editor view' };
      const text = view.state.doc.toString();
      const at = text.lastIndexOf('\\\\includegraphics');
      if (at < 0) return { scrolled: false, reason: 'no \\\\includegraphics in the document' };
      const line = view.state.doc.lineAt(at).number;
      const target = Math.min(view.state.doc.lines, line + 3);
      view.dispatch({
        selection: { anchor: view.state.doc.line(target).from },
        scrollIntoView: true
      });
      return { scrolled: true, figureLine: line, caretLine: target };
    })()`);
    await wait(1200);

    probe.visualFigure = await evaluate<Record<string, unknown>>(`(() => {
      const editor = document.querySelector('.cm-editor');
      if (!editor) return { error: 'no editor' };
      const canvases = Array.from(editor.querySelectorAll('canvas'));
      for (const canvas of canvases) {
        if (!canvas.width || !canvas.height) continue;
        let context = null;
        try { context = canvas.getContext('2d'); } catch { context = null; }
        if (!context) continue;
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const seen = new Set();
        let opaque = 0;
        for (let i = 0; i + 4 <= data.length && seen.size < 32; i += 4) {
          if (data[i + 3] === 0) continue;
          opaque += 1;
          seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        }
        if (seen.size > 1) {
          return { canvasCount: canvases.length, width: canvas.width, height: canvas.height, distinctColors: seen.size, opaque };
        }
      }
      return {
        canvasCount: canvases.length,
        painted: false,
        sizes: canvases.map(c => c.width + 'x' + c.height),
        // Why there is no painted canvas. The graphics widget has two failure
        // states that both leave zero canvases — an unresolvable path (it renders
        // the file name instead) and a render that threw (it replaces the canvas
        // with an error element) — and reporting only "no canvas" cannot tell
        // them apart.
        unresolvedPath: !!editor.querySelector('.ol-cm-graphics-error'),
        renderError: !!editor.querySelector('.ol-cm-graphics-loading-error'),
        figureNodes: editor.querySelectorAll('[class*="ol-cm-graphics"]').length,
        errorText: (editor.querySelector('.ol-cm-graphics-error, .ol-cm-graphics-loading-error') || {}).textContent || null
      };
    })()`);

    const visualFigure = section(probe, 'visualFigure');
    if (visualFigure.painted === false) {
      const cause = visualFigure.unresolvedPath
        ? 'the image path could not be resolved'
        : visualFigure.renderError
          ? 'the render threw'
          : `no widget state found (${String(visualFigure.figureNodes)} graphics nodes)`;
      problems.push(
        `Visual Mode: \\includegraphics showed no rendered figure — ${cause}` +
          (visualFigure.errorText ? ` (${String(visualFigure.errorText).slice(0, 120)})` : '')
      );
    } else if (typeof visualFigure.distinctColors === 'number' && visualFigure.distinctColors < 2) {
      problems.push('Visual Mode: the figure canvas was painted but is a single flat colour');
    }

    // How much of the document is actually presented visually rather than as raw
    // source. This is what separates an Overleaf-like editor from a text box.
    probe.visualDetail = await evaluate<Record<string, unknown>>(`(() => {
      const editor = document.querySelector('.cm-editor');
      if (!editor) return { error: 'no editor' };
      const classCounts = {};
      for (const node of editor.querySelectorAll('[class]')) {
        for (const name of node.classList) {
          if (!name.startsWith('ol-cm-')) continue;
          classCounts[name] = (classCounts[name] || 0) + 1;
        }
      }
      const rendered = editor.innerText;
      return {
        classes: Object.entries(classCounts).sort((a, b) => b[1] - a[1]).slice(0, 24),
        rawBackslashCommands: (rendered.match(/\\\\[a-zA-Z]+/g) || []).length,
        mjx: editor.querySelectorAll('mjx-container').length,
        headings: editor.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
        lists: editor.querySelectorAll('ul,ol').length,
        rules: editor.querySelectorAll('hr').length,
        text: rendered.slice(0, 600)
      };
    })()`);

    probe.visualScroll = await evaluate<Record<string, unknown>>(`(async () => {
      const scroller = document.querySelector('.cm-scroller');
      if (!scroller) return { error: 'no scroller' };

      const initialScroll = scroller.scrollTop;
      scroller.scrollTop = 1200;
      scroller.dispatchEvent(new Event('scroll'));
      await new Promise(r => setTimeout(r, 600));
      const scrollAfter600 = scroller.scrollTop;
      await new Promise(r => setTimeout(r, 1200));
      const scrollAfter1800 = scroller.scrollTop;

      return {
        initialScroll,
        scrollAfter600,
        scrollAfter1800,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      };
    })()`);

    const visualScroll = section(probe, 'visualScroll');
    if (typeof visualScroll.scrollAfter600 === 'number' && (visualScroll.scrollAfter600 as number) < 500) {
      problems.push(
        `Visual Mode: scrolling down was snapped back to top (scrollAfter600=${visualScroll.scrollAfter600}, scrollAfter1800=${visualScroll.scrollAfter1800})`
      );
    }

    await capture('02-visual-mode');

    // ---------------------------------------------------------- 2b. Visual Mode inherits Code Mode editing
    await step('2b Visual Mode inherits Code Mode editing');
    //
    // Code Mode and Visual Mode are two editors over one document, so switching
    // must not lose the gutter, the snippet engine, or the caret. Each of these
    // was separately broken while the port was being assembled, and each failure
    // is invisible in a screenshot, so they are asserted on the live editor.

    /** Sends a key, optionally with modifiers, to the focused element. */
    const pressKey = async (
      keyCode: string,
      modifiers: Array<'control' | 'shift'> = []
    ): Promise<void> => {
      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      if (keyCode.length === 1) {
        await window.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
      }
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await wait(240);
    };

    const focusVisualEditor = () =>
      evaluate<boolean>(`(() => {
        const content = document.querySelector('.cm-content');
        if (!content) return false;
        content.focus();
        return document.activeElement === content || document.activeElement?.closest('.cm-editor') !== null;
      })()`);

    await focusVisualEditor();
    await wait(400);

    // The right-hand editor's buffer, straight from the live CodeMirror view.
    // Reading the document rather than the rendered DOM is deliberate: a
    // decoration must never change the text, so the text is the ground truth.
    const visualBuffer = () =>
      evaluate<{ text: string; head: number; lineFrom: number; lineTo: number } | null>(
        `(() => {
          const view = window.__cmView;
          if (!view) return null;
          const head = view.state.selection.main.head;
          const line = view.state.doc.lineAt(head);
          return { text: view.state.doc.toString(), head, lineFrom: line.from, lineTo: line.to };
        })()`
      );

    probe.visualGutter = await evaluate<Record<string, unknown>>(`(() => {
      const gutter = document.querySelector('.cm-editor .cm-lineNumbers');
      const elements = gutter
        ? Array.from(gutter.querySelectorAll('.cm-gutterElement'))
        : [];
      // CodeMirror keeps one hidden element holding a wide placeholder ("999")
      // to size the gutter; it is not a line number.
      const numbers = elements
        .filter((element) => element.style.display !== 'none' && element.getAttribute('aria-hidden') !== 'true')
        .map((element) => parseInt(element.textContent || '', 10))
        .filter((value) => Number.isFinite(value) && value < 900);
      return {
        gutterPresent: !!gutter,
        lineNumberCount: numbers.length,
        first: numbers[0] ?? null,
        last: numbers[numbers.length - 1] ?? null,
        ascending: numbers.every((value, index) => index === 0 || value > numbers[index - 1]),
        gutterClasses: Array.from(document.querySelectorAll('.cm-editor .cm-gutter'))
          .map((element) => element.className),
      };
    })()`);

    const visualGutter = section(probe, 'visualGutter');
    if (visualGutter.gutterPresent !== true || Number(visualGutter.lineNumberCount) < 5) {
      problems.push(
        `Visual Mode: the line-number gutter is missing (${JSON.stringify(visualGutter.gutterClasses)})`
      );
    }
    if (visualGutter.ascending !== true) {
      problems.push(
        `Visual Mode: the gutter line numbers are not in order (${String(visualGutter.first)}..${String(visualGutter.last)})`
      );
    }

    // Snippets: `@a` is an automatic (`A`), in-math (`i`) HyperSnips trigger that
    // expands to `\\alpha`. Typing it inside `$...$` at the end of the document
    // must expand on this surface exactly as it does in Code Mode.
    await focusVisualEditor();
    await pressKey('End', ['control']);
    await pressKey('Enter');
    await pressKey('$');
    await wait(600);
    const afterDollar = await visualBuffer();
    await pressKey('@');
    await wait(300);
    const afterAt = await visualBuffer();
    await pressKey('a');
    // Read immediately, then again after the host round-trip has had time to
    // run: the two editors share one buffer, so a wrong delta shows up as the
    // text changing *after* the expansion rather than during it.
    const immediately = await visualBuffer();
    await wait(1500);
    const afterSnippet = await visualBuffer();

    probe.visualSnippets = {
      trigger: '@a',
      afterDollar: (afterDollar?.text ?? '').slice(-30),
      afterAt: (afterAt?.text ?? '').slice(-30),
      immediately: (immediately?.text ?? '').slice(-30),
      settled: (afterSnippet?.text ?? '').slice(-30),
      stable: immediately?.text === afterSnippet?.text,
      expanded: /\\alpha/.test(afterSnippet?.text ?? ''),
    };
    if (!section(probe, 'visualSnippets').expanded) {
      problems.push('Visual Mode: the `@a` snippet did not expand (see probe.visualSnippets)');
    }

    // An embedded figure must not swallow the caret. Typing an `\\includegraphics`
    // command turns the line into a block widget once the caret leaves it; coming
    // back with ArrowUp and typing again has to continue *after* the command, not
    // be pinned to the widget's left edge where the character lands before the
    // image. The character is `X`, so the assertion is on where it was inserted.
    await focusVisualEditor();
    await pressKey('End', ['control']);
    await pressKey('Enter');
    for (const character of '\\includegraphics{figure.pdf}') {
      await pressKey(character);
    }
    await wait(900);
    // Leave the line, which is what releases the source and renders the widget.
    await pressKey('Enter');
    await wait(900);
    await pressKey('ArrowUp');
    await wait(400);
    await pressKey('X');
    await wait(900);

    probe.visualFigureCursor = await evaluate<Record<string, unknown>>(`(() => {
      const view = window.__cmView;
      if (!view) return { error: 'no editor' };
      const doc = view.state.doc.toString();
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      const start = doc.lastIndexOf('\\\\includegraphics');
      const end = start < 0 ? -1 : doc.indexOf('}', start) + 1;
      return {
        head,
        lineFrom: line.from,
        lineTo: line.to,
        lineText: line.text,
        graphicsStart: start,
        graphicsEnd: end,
        // The typed character must land after the whole graphics command.
        typedAfterGraphics: end > 0 && doc.slice(end).includes('X') && !doc.slice(start, end).includes('X'),
        renderedAsFigure: !!document.querySelector('.cm-editor .ol-cm-environment-figure'),
      };
    })()`);

    const figureCursor = section(probe, 'visualFigureCursor');
    if (figureCursor.typedAfterGraphics !== true) {
      problems.push(
        `Visual Mode: typing beside an embedded figure landed left of it ` +
          `(head=${String(figureCursor.head)}, graphics=${String(figureCursor.graphicsStart)}..${String(figureCursor.graphicsEnd)}, ` +
          `line=${JSON.stringify(figureCursor.lineText)})`
      );
    }

    // ---------------------------------------------------------- 3. ampersand alignment
    await step('3 ampersand alignment');
    command('editor.codeMode');
    await wait(2000);
    // Back to the fixture for the functional checks, which mutate the file.
    window.webContents.send(IPC.protocol.openFile, { kind: 'open', path: texFile });
    await wait(5000);

    const before = fs.readFileSync(texFile, 'utf8');
    command('editor.formatAmpersands');
    await wait(3000);

    // The aligner rewrites the shared buffer; the file only changes on save.
    // Checking the saved bytes is stronger than scraping Monaco's rendered
    // rows, whose `innerText` collapses whitespace and would hide the padding
    // the aligner exists to produce.
    command('file.save');
    await wait(3000);
    const aligned = fs.readFileSync(texFile, 'utf8');

    probe.alignment = {
      // Which document the editor is actually showing, so a check that mutates a
      // file cannot silently act on a different one.
      activeDocument: await evaluate<string>(`(() => {
        const selected = document.querySelector('[role="tab"][aria-selected="true"]');
        return selected ? (selected.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      })()`),
      paddedRow: (aligned.match(/^a\s+& = b.*$/m) ?? [null])[0],
      paddedSecondRow: (aligned.match(/^abc\s+& = d.*$/m) ?? [null])[0],
      changedOnDisk: aligned !== before,
      beforeHead: before.split('\n').slice(32, 38).join(' | ')
    };
    const alignment = section(probe, 'alignment');
    if (alignment.changedOnDisk !== true) {
      problems.push('Aligner: the document on disk was unchanged after Align Ampersands + Save');
    }
    if (typeof alignment.paddedRow !== 'string' || !/^a\s{2,}& = b/.test(alignment.paddedRow)) {
      problems.push(`Aligner: the row was not padded (${JSON.stringify(alignment.paddedRow)})`);
    }

    // ---------------------------------------------------------- 4. snippets
    await step('4 snippets');
    //
    // The fixture ends with a single-line `\\(x\\)`, so Ctrl+End plus two
    // ArrowLeft presses puts the caret inside mathematics at a known offset.
    // Typing `RR` there must expand through the HyperSnips `A` (automatic) path.
    await evaluate(`(() => {
      ${EDITOR_DOM}
      return focusEditor();
    })()`);
    await wait(500);

    const typeKeys = async (keys: readonly string[]) => {
      for (const key of keys) {
        await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
        // Navigation keys must not also insert a character.
        if (key.length === 1) await window.webContents.sendInputEvent({ type: 'char', keyCode: key });
        await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
        await wait(260);
      }
    };

    // Move the caret into the maths: Ctrl+End, then back over `\)`.
    await typeKeys(['End']);
    await typeKeys(['Left', 'Left']);
    await evaluate(`(() => {
      ${EDITOR_DOM}
      return focusEditor();
    })()`);
    await wait(400);

    const textBefore = await evaluate<string>(`(() => {
      ${EDITOR_DOM}
      return contentText();
    })()`);
    await typeKeys(['R', 'R']);
    await wait(1500);
    const textAfter = await evaluate<string>(`(() => {
      ${EDITOR_DOM}
      return contentText();
    })()`);

    probe.snippets = {
      before: textBefore.slice(-120),
      after: textAfter.slice(-160),
      expanded: textAfter.includes('\\mathbb') || textAfter.includes('mathbb'),
      sourcesLogged: true
    };
    if (!section(probe, 'snippets').expanded) {
      problems.push('Snippets: typing the `RR` trigger did not expand (see probe.snippets)');
    }

    // ---------------------------------------------------------- 5. build
    await step('5 build');
    //
    // The build is driven through the recipe the settings resolve (the default,
    // `latexmk`), and the *recipe picker* is exercised separately below: the
    // picker and the resolver read the same catalogue, and the check that they
    // agree is what the recipe list is asserted against.
    command('latex.build');

    let built = false;
    for (let attempt = 0; attempt < 45; attempt++) {
      await wait(2000);
      if (fs.existsSync(pdfFile) && fs.statSync(pdfFile).size > 2000) {
        built = true;
        break;
      }
    }
    probe.build = {
      pdfProduced: built,
      pdfBytes: fs.existsSync(pdfFile) ? fs.statSync(pdfFile).size : 0,
      synctexProduced: fs.existsSync(path.join(workspace, 'main.synctex.gz')),
      auxProduced: fs.existsSync(path.join(workspace, 'main.aux'))
    };
    if (!built) problems.push('Build: no PDF was produced (see the Output panel in the app for the compiler log)');
    if (section(probe, 'build').synctexProduced !== true) problems.push('Build: SyncTeX data was not produced');

    // ------------------------------------------------- 5b the bottom panel
    await step('5b bottom panel');
    //
    // Every view of the panel, selected through its own tab — the control a user
    // actually presses, not the command behind it — and checked for the element
    // that view renders. "The panel is open" is not the claim: one component
    // switching its body can be open on the wrong view, and a body that renders
    // nothing looks identical from the outside. The build that just succeeded is
    // what the Output and Log views are read against.
    probe.bottomPanel = await evaluate<Record<string, unknown>>(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const views = ['problems', 'output', 'log', 'search', 'terminal'];
      const markers = {
        problems: '[data-testid="problems-list"]',
        output: '[data-testid="output-stream"]',
        log: '[data-testid="log-list"]',
        search: '[data-testid="search-list"]',
        terminal: '[data-testid="terminal-panel"]'
      };
      const report = {};
      for (const view of views) {
        const tab = document.querySelector('[data-testid="bottom-panel-tab-' + view + '"]');
        if (!tab) { report[view] = { tab: false }; continue; }
        tab.click();
        // The terminal is a lazily imported chunk, so it is given time to arrive;
        // the other four views are in the panel's own bundle.
        await wait(view === 'terminal' ? 3000 : 500);
        const root = document.querySelector('[data-testid="bottom-panel"]');
        const body = document.querySelector('[data-testid="bottom-panel-body"]');
        const marker = document.querySelector(markers[view]);
        report[view] = {
          tab: true,
          pressed: tab.getAttribute('aria-pressed'),
          view: root ? root.getAttribute('data-panel-view') : null,
          bodyView: body ? body.getAttribute('data-view') : null,
          marker: !!marker,
          text: marker ? (marker.textContent || '').trim().slice(0, 160) : '',
          rows: marker ? marker.querySelectorAll('[data-testid$="-row"]').length : 0
        };
      }
      // Leave the panel on Output, where the next steps read the build from.
      const output = document.querySelector('[data-testid="bottom-panel-tab-output"]');
      if (output) output.click();
      await wait(300);
      return report;
    })()`);

    {
      const panel = section(probe, 'bottomPanel');
      for (const view of ['problems', 'output', 'log', 'search', 'terminal']) {
        const entry = panel[view] as Record<string, unknown> | undefined;
        if (!entry || entry.tab !== true) {
          problems.push(`Bottom panel: the ${view} tab is not in the strip`);
          continue;
        }
        if (entry.pressed !== 'true') problems.push(`Bottom panel: clicking the ${view} tab did not select it`);
        if (entry.view !== view) {
          problems.push(`Bottom panel: the ${view} tab left the panel showing "${String(entry.view)}"`);
        }
        if (entry.bodyView !== view) {
          problems.push(`Bottom panel: the ${view} body reported "${String(entry.bodyView)}"`);
        }
        if (entry.marker !== true) problems.push(`Bottom panel: the ${view} view rendered no content element`);
      }
      const output = panel.output as Record<string, unknown> | undefined;
      if (output && !/Output written on|Latexmk/i.test(String(output.text))) {
        problems.push(`Bottom panel: the Output view does not hold the compiler log (${String(output.text).slice(0, 80)})`);
      }
      const log = panel.log as Record<string, unknown> | undefined;
      if (log && !String(log.text)) {
        problems.push('Bottom panel: the Log view is empty after a build');
      }
    }

    // ------------------------------------------------- 5c recipe picker
    await step('5c recipe picker');
    //
    // The picker and the resolver must not be able to disagree. This is the check
    // that would have caught the original defect — a picker listing `pdflatex`,
    // `xelatex` and three other names that no recipe answered to, so choosing one
    // failed with "Failed to resolve build recipe: pdflatex." It opens the real
    // picker, picks the first recipe this machine can actually run that is not
    // the default, builds with it, and asserts the build says which recipe it
    // used.
    command('latex.buildWithRecipe');
    await wait(1500);
    probe.recipePicker = await evaluate<Record<string, unknown>>(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const rows = Array.from(document.querySelectorAll('[data-recipe]')).map((row) => ({
        name: row.getAttribute('data-recipe'),
        available: row.getAttribute('data-available') === 'true',
        text: (row.textContent || '').trim().slice(0, 120)
      }));
      const picked =
        rows.find((row) => row.available && row.name !== 'latexmk') ?? rows.find((row) => row.available) ?? null;
      const button = picked ? document.querySelector('[data-recipe="' + picked.name + '"]') : null;
      if (button) button.click();
      await wait(400);
      return {
        count: rows.length,
        rows: rows.slice(0, 12),
        picked: picked ? picked.name : null,
        dialogClosed: !document.querySelector('[data-recipe]')
      };
    })()`);

    {
      const picker = section(probe, 'recipePicker');
      if (Number(picker.count) < 5) {
        problems.push(`Recipe picker: only ${String(picker.count)} recipe(s) offered (${JSON.stringify(picker.rows)})`);
      }
      if (!picker.picked) problems.push(`Recipe picker: no runnable recipe was offered (${JSON.stringify(picker.rows)})`);
      if (picker.dialogClosed !== true) problems.push('Recipe picker: choosing a recipe did not close the picker');

      // Wait for that build to finish, then read what the panel says it used.
      let recipeStatus = '';
      for (let attempt = 0; attempt < 40; attempt++) {
        await wait(2000);
        recipeStatus = await evaluate<string>(
          `(() => { const el = document.querySelector('[data-testid="status-build"]'); return el ? (el.getAttribute('data-build-status') || '') : ''; })()`
        );
        if (recipeStatus === 'succeeded' || recipeStatus === 'failed') break;
      }
      const recipeReport = await evaluate<Record<string, unknown>>(`(() => {
        const tab = document.querySelector('[data-testid="bottom-panel-tab-output"]');
        if (tab) tab.click();
        const name = document.querySelector('[data-testid="build-recipe"]');
        const failure = document.querySelector('[data-testid="build-failure"]');
        return {
          recipe: name ? (name.textContent || '').trim() : null,
          failure: failure ? (failure.textContent || '').trim().slice(0, 200) : null
        };
      })()`);
      probe.recipeBuild = { status: recipeStatus, ...recipeReport };

      if (recipeStatus !== 'succeeded') {
        problems.push(
          `Recipe picker: building with "${String(picker.picked)}" reported "${recipeStatus}" — ${String(recipeReport.failure) || 'no failure stated'}`
        );
      }
      if (recipeReport.recipe !== picker.picked) {
        problems.push(
          `Recipe picker: the build reported recipe "${String(recipeReport.recipe)}" rather than "${String(picker.picked)}"`
        );
      }
    }

    // ---------------------------------------------------------- 6. SyncTeX
    await step('6 SyncTeX');
    //
    // Ctrl+Alt+J is the forward-search command: it must map the caret's source
    // line onto a page-space position in the PDF and report it.
    command('latex.forwardSearch');
    await wait(6000);

    probe.synctex = await evaluate<Record<string, unknown>>(`(() => {
      const text = document.body.innerText;
      const match = text.match(/SyncTeX: [^\\n]*/);
      const failed = text.match(/SyncTeX failed: [^\\n]*/);
      const noMatch = text.match(/SyncTeX: no match[^\\n]*/);
      return {
        status: match ? match[0] : null,
        failure: failed ? failed[0] : null,
        noMatch: noMatch ? noMatch[0] : null,
        highlightPresent: !!document.querySelector('[data-testid="pdf-scroll-container"] [style*="pdf-sync-highlight"], [data-testid="pdf-scroll-container"] [style*="--eu-accent"]')
      };
    })()`);

    const synctex = section(probe, 'synctex');
    if (synctex.failure) {
      problems.push(`SyncTeX: forward search failed (${String(synctex.failure)})`);
    } else if (synctex.noMatch) {
      problems.push('SyncTeX: forward search found no mapping for the cursor line');
    } else if (!synctex.status) {
      problems.push('SyncTeX: forward search produced no status message');
    }

    // ---------------------------------------------------------- 6c. PDF viewer keyboard
    await step("6c PDF viewer keyboard");
    //
    // The viewer is driven from the keyboard in light-pdf, so the ported
    // accelerators are checked through the real key path rather than by calling
    // the handlers: focus the pane, press the key, and read what changed.
    //
    // This runs straight after the successful build on purpose, and must stay
    // there. The pane follows the *last* build's output, and the diagnostics
    // section below builds a document that fails yet still emits a valid
    // one-page PDF, because pdflatex recovers from an undefined control sequence
    // in nonstopmode. Asserting "go to the last page" against one page reports a
    // correct viewer as broken, since `End` is already there and `N` has nowhere
    // to go. The precondition is asserted rather than assumed, so a future move
    // fails with the document's name instead of an unexplained page number.

    {
      // Deliberately not gated on earlier problems: a failure in one surface
      // must not silently skip the checks for another, or a single regression
      // hides every later one.
      await evaluate(`(() => {
        const pane = document.querySelector('[data-testid="pdf-pane-root"]');
        if (pane) pane.focus();
        return !!pane;
      })()`);
      await wait(400);

      /** Reads a `data-` attribute from the viewer's scroll container. */
      const viewerAttribute = (name: string) =>
        evaluate<string>(
          `(() => { const el = document.querySelector('[data-testid="pdf-scroll-container"]'); return el ? (el.getAttribute('${name}') || '') : ''; })()`
        );
      const scaleOf = () => viewerAttribute('data-scale');
      /** The page the viewer considers current. */
      const pageOf = () => viewerAttribute('data-current-page');

      // `End` is `CmdGoToLastPage` and `Home` is `CmdGoToFirstPage`. Both
      // directions are checked, so a viewer that is already at an end cannot mask
      // a binding that does nothing. That is why `Home` goes first: the SyncTeX
      // forward search above leaves the pane on the page the caret maps to, which
      // for this fixture is the last one, and pressing `End` there proves nothing
      // — the assertion below would compare the last page with itself and call a
      // working viewer broken.
      const pageInitial = await pageOf();
      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Home' });
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Home' });
      await wait(1500);
      const pageAfterHome = await pageOf();

      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End' });
      await wait(1500);
      const pageAfterEnd = await pageOf();

      // The toolbar's page box shows the pane's own `pageCount`, which is what
      // `End` and `N` compute their target from. Reading it distinguishes "the
      // command computed page 1 and did nothing" from "the viewer did not move".
      const pageBox = await evaluate<string>(
        `(() => {
          const box = document.querySelector('[data-testid="pdf-toolbar"] input');
          const toolbar = document.querySelector('[data-testid="pdf-toolbar"]');
          return JSON.stringify({
            input: box ? box.value : null,
            count: toolbar ? toolbar.getAttribute("data-page-count") : null,
            panePage: toolbar ? toolbar.getAttribute("data-pane-page") : null,
            // The pane's own box, so the fit assertions below can tell whether
            // the two fit modes are *able* to differ: fit-width and fit-page
            // coincide whenever the viewport happens to share the page's aspect
            // ratio, which is a property of the window, not a defect.
            paneWidth: (() => { const s = document.querySelector('[data-testid="pdf-scroll-container"]'); return s ? s.clientWidth : null; })(),
            paneHeight: (() => { const s = document.querySelector('[data-testid="pdf-scroll-container"]'); return s ? s.clientHeight : null; })(),
            // Every ancestor of the scroller, with the height each one actually
            // resolved to. The PDF pane was measured at 1578px inside a ~650px
            // window: the scroll container is not height-constrained, so the
            // viewer feeds its own canvas height back in as the viewport size and
            // the layout centres every page off-screen. Naming the ancestor that
            // fails to constrain it is the whole question, and inferring it from
            // the outside has already cost several rounds.
            ancestors: (() => {
              const out = [];
              let node = document.querySelector('[data-testid="pdf-scroll-container"]');
              while (node && node !== document.documentElement) {
                const style = getComputedStyle(node);
                out.push({
                  tag: node.tagName.toLowerCase(),
                  testid: node.getAttribute('data-testid') || null,
                  cls: (node.getAttribute('class') || '').slice(0, 40),
                  clientH: node.clientHeight,
                  clientW: node.clientWidth,
                  height: style.height,
                  maxHeight: style.maxHeight,
                  minHeight: style.minHeight,
                  flex: style.flex,
                  overflow: style.overflowY,
                  display: style.display
                });
                node = node.parentElement;
              }
              out.push({ tag: 'window', clientH: window.innerHeight, clientW: window.innerWidth });
              return out;
            })(),
            canvasWidth: (() => { const c = document.querySelector('[data-testid="pdf-scroll-container"] canvas'); return c ? Math.round(c.getBoundingClientRect().width) : null; })(),
            canvasHeight: (() => { const c = document.querySelector('[data-testid="pdf-scroll-container"] canvas'); return c ? Math.round(c.getBoundingClientRect().height) : null; })(),
            text: toolbar ? (toolbar.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : null
          });
        })()`
      );

      // `N` is `CmdGoToNextPage`. It is pressed from page 1 rather than from
      // wherever `End` left the pane, or a `N` that did nothing at the last page
      // would look like success.
      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Home' });
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Home' });
      await wait(1500);
      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'N' });
      await window.webContents.sendInputEvent({ type: 'char', keyCode: 'n' });
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'N' });
      await wait(1500);
      const pageAfterNext = await pageOf();

      // `Ctrl+2` is `CmdZoomFitWidth`, `Ctrl+0` is `CmdZoomFitPage`.
      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: '2', modifiers: ['control'] });
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: '2', modifiers: ['control'] });
      await wait(1200);
      const scaleFitWidth = await scaleOf();

      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['control'] });
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: '0', modifiers: ['control'] });
      await wait(1200);
      const scaleFitPage = await scaleOf();

      // `Ctrl+A` is `CmdSelectAll`: the page text layer must come back.
      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
      await wait(2500);
      const selectionText = await evaluate<string>(
        `(() => { const view = document.querySelector('[data-testid="pdf-scroll-container"]'); return view ? (view.getAttribute('data-selection-length') || '0') : '0'; })()`
      );

      probe.lightPdfKeys = {
        pageInitial,
        pageAfterHome,
        pageAfterEnd,
        pageAfterNext,
        visiblePages: await viewerAttribute('data-visible-pages'),
        zoomFitWidth: scaleFitWidth,
        zoomFitPage: scaleFitPage,
        pageBox,
        viewerDocPageCount: await viewerAttribute('data-doc-page-count'),
        viewerStartPage: await viewerAttribute('data-start-page'),
        // Which document the viewer holds. Without it a page-count mismatch is
        // ambiguous between "the viewer has a stale handle" and "the viewer is
        // correctly showing a different, shorter document".
        viewerDocumentPath: await viewerAttribute('data-document-path'),
        selectionLength: Number(selectionText)
      };

      const keys = section(probe, 'lightPdfKeys');
      /** The document on screen, for a failure message that names it. */
      const shown = `${path.basename(String(keys.viewerDocumentPath ?? '')) || 'unknown'} (${String(keys.viewerDocPageCount)} page(s))`;
      // The keyboard checks below only mean anything if the pane is holding the
      // document the build just produced, so the precondition is asserted rather
      // than assumed.
      if (path.basename(String(keys.viewerDocumentPath ?? '')) !== path.basename(pdfFile)) {
        problems.push(
          `PDF keyboard: the viewer holds ${shown} rather than ${path.basename(pdfFile)}, so the page checks below cannot be trusted`
        );
      }
      // `Home` comes first, so "the last page" is a real destination rather than
      // wherever the forward search happened to leave the pane.
      if (String(keys.pageAfterHome) !== '1') {
        problems.push(
          `PDF keyboard: pressing \`Home\` did not go to the first page (${String(keys.pageInitial)} -> ${String(keys.pageAfterHome)}, ${String(keys.visiblePages)} page(s) laid out) in ${shown}`
        );
      }
      if (String(keys.pageAfterEnd) !== String(keys.viewerDocPageCount)) {
        problems.push(
          `PDF keyboard: pressing \`End\` did not go to the last page (${String(keys.pageAfterHome)} -> ${String(keys.pageAfterEnd)}, expected ${String(keys.viewerDocPageCount)}) in ${shown}`
        );
      }
      if (String(keys.pageAfterNext) === String(keys.pageAfterHome) && Number(keys.viewerDocPageCount) > 1) {
        // `N` has nowhere to go on a one-page document — the fixture is one page —
        // so the check only means something when there is a next page to reach.
        problems.push(
          `PDF keyboard: pressing \`N\` did not change the page (${String(keys.pageAfterHome)} -> ${String(keys.pageAfterNext)}) in ${shown}`
        );
      }
      // `Ctrl+2` is fit-width and `Ctrl+0` is fit-page. Fit-width is
      // `paneW / pageW`; fit-page is `min(paneW / pageW, paneH / pageH)`. The two
      // are therefore only *able* to differ when the height is the binding
      // constraint, i.e. when `paneAspect > pageAspect` — when the pane is
      // relatively wider than the page. A pane narrower than the page's aspect
      // (a tall, column-like pane, which is what the split layouts give) makes
      // them equal by arithmetic, and asserting otherwise fails the viewer for a
      // property of the window. Twice now I have written this check from an
      // assumption rather than from the geometry; this is the geometry.
      const box = (() => {
        try {
          return JSON.parse(pageBox) as Record<string, number | null>;
        } catch {
          return {} as Record<string, number | null>;
        }
      })();
      const paneWidth = Number(box.paneWidth ?? 0);
      const paneHeight = Number(box.paneHeight ?? 0);
      const canvasWidth = Number(box.canvasWidth ?? 0);
      const canvasHeight = Number(box.canvasHeight ?? 0);
      const paneAspect = paneWidth > 0 && paneHeight > 0 ? paneWidth / paneHeight : 0;
      const pageAspect = canvasWidth > 0 && canvasHeight > 0 ? canvasWidth / canvasHeight : 0;
      // The two fit modes can only diverge when the pane is relatively wider
      // than the page.
      const canDiffer = paneAspect > 0 && pageAspect > 0 && paneAspect > pageAspect * 1.02;

      if (!keys.zoomFitWidth) {
        problems.push('PDF keyboard: Ctrl+2 produced no scale at all');
      } else if (canDiffer && keys.zoomFitWidth === keys.zoomFitPage) {
        problems.push(
          `PDF keyboard: the pane (${paneWidth}x${paneHeight}, aspect ${paneAspect.toFixed(3)}) is wider than the page (aspect ${pageAspect.toFixed(3)}), so Ctrl+2 and Ctrl+0 should differ, but both gave ${String(keys.zoomFitWidth)}`
        );
      } else if (!canDiffer && canvasWidth > 0 && canvasWidth + 24 < paneWidth) {
        // When the modes legitimately coincide, fit-width must still fill the
        // width. The gap allowed for is `pdf.windowMargin` (8px by default), so
        // this only fires on a real shortfall rather than on the margin.
        problems.push(
          `PDF keyboard: Ctrl+2 did not fill the pane width (page ${canvasWidth}px in a ${paneWidth}px pane, margin ${paneWidth - canvasWidth}px)`
        );
      }
      if (!(Number(keys.selectionLength) > 0)) {
        problems.push('PDF keyboard: Ctrl+A selected no text');
      }
    }

    // ---------------------------------------------------------- 7. diagnostics
    await step('7 diagnostics');
    //
    // A document with a real error must produce problems with a file and line,
    // and selecting one must navigate to the source.
    const brokenFile = path.join(workspace, 'broken.tex');
    if (fs.existsSync(brokenFile)) {
      window.webContents.send(IPC.protocol.openFile, { kind: 'open', path: brokenFile });
      await wait(6000);

      // Markers before any build can only come from the linter, which is the
      // ported Overleaf one running in its own worker. `broken.tex` is
      // structurally valid, so it is expected to produce none; the unclosed
      // group in `lint.tex` is what the linter exists to catch.
      probe.linter = await evaluate<Record<string, unknown>>(`(() => {
        ${EDITOR_DOM}
        return { structuredEngine: engine, structurallyValidMarkers: document.querySelectorAll(anyMarkerSelector).length };
      })()`);

      const lintFile = path.join(workspace, 'lint.tex');
      if (fs.existsSync(lintFile)) {
        window.webContents.send(IPC.protocol.openFile, { kind: 'open', path: lintFile });
        await wait(8000);
        const linted = await evaluate<Record<string, unknown>>(`(() => {
          ${EDITOR_DOM}
          const markers = document.querySelectorAll(anyMarkerSelector);
          return { markerCount: markers.length, titles: Array.from(markers).slice(0, 3).map((n) => n.getAttribute('title') ?? '') };
        })()`);
        probe.linter = { ...section(probe, 'linter'), unclosedGroupMarkers: linted.markerCount, titles: linted.titles };

        if (Number(linted.markerCount) === 0) {
          problems.push('Linter: the LaTeX linter reported nothing for a document with an unclosed group');
        }
        window.webContents.send(IPC.protocol.openFile, { kind: 'open', path: brokenFile });
        await wait(4000);
      }

      command('view.problems');
      await wait(1500);
      // The detected root is `main.tex`, so a plain Build would compile that and
      // never surface this file's errors; the active file is built explicitly.
      command('latex.buildActiveFile');
      await wait(25000);

      probe.diagnostics = await evaluate<Record<string, unknown>>(`(() => {
        ${EDITOR_DOM}
        const rows = Array.from(document.querySelectorAll('[data-testid="problem-row"]')).map((row) => ({
          severity: row.getAttribute('data-severity'),
          file: row.getAttribute('data-file'),
          line: row.getAttribute('data-line'),
          text: (row.textContent || '').slice(0, 160)
        }));
        const panel = document.querySelector('[data-testid="bottom-panel"]');
        return {
          panelPresent: !!panel,
          panelView: panel ? panel.getAttribute('data-panel-view') : null,
          rowCount: rows.length,
          rows: rows.slice(0, 6),
          // A usable problem points at a real file and a positive line number.
          locatedRows: rows.filter((row) => /broken\\.tex$/i.test(String(row.file)) && Number(row.line) > 0).length,
          errorRows: rows.filter((row) => row.severity === 'error').length,
          markersRendered: document.querySelectorAll(errorMarkerSelector).length
        };
      })()`);

      const diagnostics = section(probe, 'diagnostics');
      if (diagnostics.panelPresent !== true) problems.push('Diagnostics: the Problems panel is not in the DOM');
      if (diagnostics.panelView !== 'problems') {
        problems.push(`Diagnostics: the panel is showing "${diagnostics.panelView}" rather than problems`);
      }
      if (Number(diagnostics.rowCount) === 0) {
        problems.push('Diagnostics: the Problems panel is empty after a failing build');
      }
      if (Number(diagnostics.locatedRows) === 0) {
        problems.push(`Diagnostics: no problem pointed at broken.tex with a line number (${JSON.stringify(diagnostics.rows)})`);
      }
      if (Number(diagnostics.errorRows) === 0) {
        problems.push('Diagnostics: the failing build produced no error-severity problem');
      }

      /*
       * And the failure itself, stated.
       *
       * The Problems list holds the compiler's own words; a build that failed
       * before the compiler could say anything — a missing engine, a recipe that
       * resolves to nothing — has none, and the two words "Build failed" are not
       * an answer. The Output view carries the exact sentence: which command,
       * which exit code, and what the compiler said first. It is read through the
       * tab the user presses, with the strip's own attributes as the assertion.
       */
      probe.buildFailure = await evaluate<Record<string, unknown>>(`(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const tab = document.querySelector('[data-testid="bottom-panel-tab-output"]');
        if (tab) tab.click();
        await wait(600);
        const strip = document.querySelector('[data-testid="build-failure"]');
        const status = document.querySelector('[data-testid="status-build-failure"]');
        const build = document.querySelector('[data-testid="status-build"]');
        return {
          present: !!strip,
          kind: strip ? strip.getAttribute('data-failure-kind') : null,
          text: strip ? (strip.textContent || '').trim().slice(0, 300) : '',
          statusBar: status ? (status.textContent || '').trim().slice(0, 200) : null,
          buildStatus: build ? build.getAttribute('data-build-status') : null
        };
      })()`);

      const failure = section(probe, 'buildFailure');
      if (failure.present !== true) {
        problems.push('Failure: a failing build left no statement of what failed in the bottom panel');
      }
      if (String(failure.kind) !== 'exit') {
        problems.push(`Failure: the failing build was reported as "${String(failure.kind)}" rather than an exit code`);
      }
      if (!/exited with code/i.test(String(failure.text))) {
        problems.push(`Failure: the panel did not state the exit code (${String(failure.text).slice(0, 120)})`);
      }
      if (failure.buildStatus !== 'failed') {
        problems.push(`Failure: the status bar reports the build as "${String(failure.buildStatus)}"`);
      }
      if (!failure.statusBar) {
        problems.push('Failure: the status bar states no reason for the failed build');
      }

      // Return to the good document. The PDF pane keeps showing the failing
      // build's output — `broken.tex` fails on an undefined control sequence,
      // which pdflatex *recovers* from in nonstopmode, so it still writes a
      // perfectly valid one-page `broken.pdf`. That is why the viewer's keyboard
      // checks run back in section 6c, against the two-page `main.pdf` this
      // section's detour would otherwise replace: on a single page `End` is
      // already at the end and `N` has nowhere to go, so asserting navigation
      // here reports a correct viewer as broken.
      window.webContents.send(IPC.protocol.openFile, { kind: 'open', path: texFile });
      await wait(4000);
    }

    // The PDF viewer picks the new file up through the build result.
    await wait(6000);
    probe.pdfViewer = await evaluate<Record<string, unknown>>(`(() => {
      const canvases = Array.from(document.querySelectorAll('canvas')).map((canvas) => ({
        w: canvas.width,
        h: canvas.height,
        cssW: Math.round(canvas.getBoundingClientRect().width),
        cssH: Math.round(canvas.getBoundingClientRect().height),
        // Monaco uses canvases too; PDF pages live inside the viewer's scroller.
        inPdfPane: !!canvas.closest('[data-testid="pdf-scroll-container"]')
      }));
      const pdfCanvases = canvases.filter((entry) => entry.inPdfPane);
      return {
        canvasCount: canvases.length,
        pdfCanvases: pdfCanvases.length,
        // A pristine canvas is 300x150; anything still that size was never
        // painted, which is why the threshold is above the default.
        pdfPagesWithPixels: pdfCanvases.filter((entry) => entry.w > 320 || entry.h > 200).length,
        largest: pdfCanvases.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null,
        samples: pdfCanvases.slice(0, 4),
        pdfPanePresent: !!document.querySelector('[data-testid="pdf-scroll-container"]'),
        renderStatus: document.querySelector('[data-testid="pdf-scroll-container"]')?.getAttribute('data-render-status') ?? null,
        renderAttempts: document.querySelector('[data-testid="pdf-scroll-container"]')?.getAttribute('data-render-attempts') ?? null,
        visiblePages: document.querySelector('[data-testid="pdf-scroll-container"]')?.getAttribute('data-visible-pages') ?? null,
        appliedScale: document.querySelector('[data-testid="pdf-scroll-container"]')?.getAttribute('data-scale') ?? null,
        // The pane's own page readout, read here because this is the moment the
        // failing build has just replaced a two-page document with a one-page
        // one. The count and the page arrive in separate patches, and a document
        // that opens already laid out need not produce the view change that
        // updates the page, so this is where a readout of 2 of 1 used to appear.
        panePageReadout: (() => {
          const toolbar = document.querySelector('[data-testid="pdf-toolbar"]');
          return toolbar
            ? { page: Number(toolbar.getAttribute('data-pane-page')), count: Number(toolbar.getAttribute('data-page-count')) }
            : null;
        })(),
        overlayText: (document.querySelector('[data-testid="pdf-scroll-container"]')?.parentElement?.innerText ?? '')
          .split('\\n')
          .filter((line) => /error|fail|could not|render/i.test(line))
          .slice(0, 3)
      };
    })()`);

    // How sharp is the rendered page, as a number rather than an opinion. The
    // user's report is that the page is blurred, and every theory about why has
    // been cheaper to argue than to settle; this makes a change measurable.
    //
    // The metric is the mean absolute luminance gradient across the page, with
    // the ink fraction beside it for normalisation: glyph strokes against paper
    // are the strongest edges a page has, so a render that has been resampled or
    // composited through a blending group smears them and the number falls. It
    // is a relative instrument — compare runs, do not read it absolutely.
    probe.pdfSharpness = await evaluate<Record<string, unknown>>(`(() => {
      const canvas = document.querySelector('[data-testid="pdf-scroll-container"] canvas');
      if (!canvas) return { error: 'no canvas in the viewer' };
      const width = canvas.width;
      const height = canvas.height;
      if (!width || !height) return { error: 'canvas has no backing store' };
      const context = canvas.getContext('2d');
      if (!context) return { error: 'no 2d context' };
      let data;
      try {
        data = context.getImageData(0, 0, width, height).data;
      } catch (error) {
        return { error: 'getImageData failed: ' + String(error) };
      }
      const luminance = (x, y) => {
        const index = (y * width + x) * 4;
        return 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
      };
      let total = 0;
      let samples = 0;
      let ink = 0;
      for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
          const here = luminance(x, y);
          if (here < 128) ink++;
          total += Math.abs(luminance(x + 1, y) - here) + Math.abs(luminance(x, y + 1) - here);
          samples += 2;
        }
      }
      return {
        width,
        height,
        meanGradient: samples > 0 ? Number((total / samples).toFixed(4)) : -1,
        inkFraction: samples > 0 ? Number((ink / (samples / 2)).toFixed(4)) : -1
      };
    })()`);

    const sharpness = section(probe, 'pdfSharpness');
    if (sharpness.error) {
      problems.push(`PDF sharpness: could not measure the rendered page (${String(sharpness.error)})`);
    } else if (!(Number(sharpness.inkFraction) > 0)) {
      // A blank page would make the gradient meaningless rather than good.
      problems.push(`PDF sharpness: the page has no ink (${JSON.stringify(sharpness)}), so the measurement means nothing`);
    }

    // The same measurement again after zooming in, because the one above is
    // taken at fit-page on a page that is mostly whitespace - an instrument that
    // samples blank paper cannot tell a sharp render from a blurred one, which
    // is exactly the question the user's report raises. At 200% the glyph edges
    // dominate the sample, so the number becomes sensitive to resampling.
    //
    // `Ctrl+=` is `CmdZoomIn` (Commands.h 295, bound in lightpdf-keyboard.ts).
    await evaluate(`(() => {
      const pane = document.querySelector('[data-testid="pdf-pane-root"]');
      if (pane) pane.focus();
      return !!pane;
    })()`);
    await wait(300);
    // Ten steps, deliberately: six land on scale 4.000, which is exactly the
    // ceiling the removed `pdf.devicePixelRatioCap` used to impose, so stopping
    // there would leave the removal itself untested. Going past it is what shows
    // the page is still rendered at full resolution where the cap used to bind.
    for (let step = 0; step < 10; step++) {
      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['control'] });
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: '=', modifiers: ['control'] });
      await wait(400);
    }
    await wait(2500);

    probe.pdfSharpnessZoomed = await evaluate<Record<string, unknown>>(`(() => {
      const canvas = document.querySelector('[data-testid="pdf-scroll-container"] canvas');
      const view = document.querySelector('[data-testid="pdf-scroll-container"]');
      if (!canvas) return { error: 'no canvas in the viewer' };
      const width = canvas.width;
      const height = canvas.height;
      const context = canvas.getContext('2d');
      if (!context) return { error: 'no 2d context' };
      let data;
      try {
        data = context.getImageData(0, 0, width, height).data;
      } catch (error) {
        return { error: 'getImageData failed: ' + String(error) };
      }
      const luminance = (x, y) => {
        const index = (y * width + x) * 4;
        return 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
      };
      let total = 0;
      let samples = 0;
      let ink = 0;
      for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width - 1; x++) {
          const here = luminance(x, y);
          if (here < 128) ink++;
          total += Math.abs(luminance(x + 1, y) - here) + Math.abs(luminance(x, y + 1) - here);
          samples += 2;
        }
      }
      return {
        width,
        height,
        // The CSS box the bitmap is painted into, so the sample can prove the
        // page is not being stretched: for a 1:1 blit the backing width equals
        // the CSS width times the device pixel ratio. This is the one remaining
        // way a page can look soft, and it is the failure the removed render
        // scale ceiling would have produced past 400%.
        cssWidth: Math.round(canvas.getBoundingClientRect().width),
        cssHeight: Math.round(canvas.getBoundingClientRect().height),
        devicePixelRatio: window.devicePixelRatio || 1,
        scale: view ? view.getAttribute('data-scale') : null,
        // The allocation guard announces itself when it binds. A page stretched
        // *because* the guard bound is the designed behaviour and the pane says
        // so on screen; a page stretched silently is a defect. The assertion
        // below distinguishes the two.
        constrained: view ? view.getAttribute('data-render-scale-constrained') : null,
        meanGradient: samples > 0 ? Number((total / samples).toFixed(4)) : -1,
        inkFraction: samples > 0 ? Number((ink / (samples / 2)).toFixed(4)) : -1
      };
    })()`);

    const zoomed = section(probe, 'pdfSharpnessZoomed');
    // Not asserted as a sharpness pass or fail: the reading of the gradient is a
    // comparison against the fit-page sample. The *stretch* check below is
    // asserted, because unlike the gradient it has a right answer.
    if (zoomed.error) {
      problems.push(`PDF sharpness: could not measure the zoomed page (${String(zoomed.error)})`);
    } else {
      const expected = Number(zoomed.cssWidth) * Number(zoomed.devicePixelRatio);
      const actual = Number(zoomed.width);
      const constrained = zoomed.constrained !== null && zoomed.constrained !== '';
      if (Number(zoomed.cssWidth) > 0 && expected > 0 && Math.abs(actual - expected) / expected > 0.02 && !constrained) {
        problems.push(
          `PDF viewer: at ${String(zoomed.scale)} the page is stretched — the bitmap is ${actual}px for a ${String(zoomed.cssWidth)}px box at dpr ${String(zoomed.devicePixelRatio)} (expected ${Math.round(expected)}px), and the viewer did not report the allocation guard as binding`
        );
      }
      if (constrained && Math.abs(actual - expected) / expected <= 0.02) {
        // The guard claims to be binding while the bitmap still matches the
        // screen, which would mean the flag lies about what is on screen.
        problems.push(
          `PDF viewer: the allocation guard reports itself as binding at ${String(zoomed.scale)} while the bitmap still matches the display (${actual}px against ${Math.round(expected)}px expected)`
        );
      }
    }

    // The text layer is what makes selection and click targets land on the
    // glyphs, and it is invisible by design, so nothing else in this probe would
    // notice if it silently disappeared or lost its horizontal scaling. Each run
    // must carry the PDF box and a scaleX that reconciles it with the browser's
    // rendering of the same text.
    probe.pdfTextLayer = await evaluate<Record<string, unknown>>(`(() => {
      const layers = Array.from(document.querySelectorAll('[data-text-layer]'));
      const runs = layers.flatMap((layer) => Array.from(layer.querySelectorAll('span')));
      const scaled = runs.filter((run) => /scaleX/.test(run.style.transform || '')).length;
      const boxed = runs.filter((run) => run.style.width && run.style.height).length;
      const styled = runs.filter((run) => run.style.fontFamily).length;
      const first = runs[0] || null;
      return {
        layers: layers.length,
        runs: runs.length,
        scaled,
        boxed,
        styled,
        sample: first
          ? {
              width: first.style.width,
              height: first.style.height,
              transform: first.style.transform,
              fontFamily: (first.style.fontFamily || '').slice(0, 60)
            }
          : null
      };
    })()`);

    const textLayer = section(probe, 'pdfTextLayer');
    if (Number(textLayer.runs) === 0) {
      problems.push('PDF text layer: no selectable runs were built, so text cannot be selected or copied by hand');
    } else {
      // A run without the PDF box shrink-wraps to the browser's own rendering of
      // the text, which is what used to put hit targets off the end of the line
      // and make dragging pan instead of select.
      if (Number(textLayer.boxed) !== Number(textLayer.runs)) {
        problems.push(`PDF text layer: ${Number(textLayer.runs) - Number(textLayer.boxed)} of ${textLayer.runs} runs have no PDF box`);
      }
      if (Number(textLayer.scaled) !== Number(textLayer.runs)) {
        problems.push(`PDF text layer: ${Number(textLayer.runs) - Number(textLayer.scaled)} of ${textLayer.runs} runs are not horizontally scaled to the glyphs`);
      }
      if (Number(textLayer.styled) !== Number(textLayer.runs)) {
        problems.push(`PDF text layer: ${Number(textLayer.runs) - Number(textLayer.styled)} of ${textLayer.runs} runs carry no font`);
      }
    }

    const viewer = section(probe, 'pdfViewer');
    if (viewer.pdfPanePresent !== true) problems.push('PDF viewer: the scroll container is not in the DOM');

    // The page readout must stay inside the document even though the count and
    // the page are patched separately.
    const readout = viewer.panePageReadout as { page: number; count: number } | null;
    if (readout && readout.count > 0 && readout.page > readout.count) {
      problems.push(`PDF viewer: the page readout is past the end of the document (page ${readout.page} of ${readout.count})`);
    }
    if (readout && readout.page < 1) {
      problems.push(`PDF viewer: the page readout is below the first page (page ${readout.page} of ${readout.count})`);
    }

    await capture('03-pdf-viewer');

    // Call the bridge directly to separate an IPC failure from a viewer bug.
    probe.pdfIpc = await evaluate<Record<string, unknown>>(`(async () => {
      const withTimeout = (promise, ms) =>
        Promise.race([
          promise.then((value) => ({ settled: 'resolved', value })),
          new Promise((resolve) => setTimeout(() => resolve({ settled: 'timeout' }), ms)),
          promise.catch((error) => ({ settled: 'rejected', error: String(error && error.message ? error.message : error) }))
        ]);
      const info = await withTimeout(window.eukoliaApi.pdfOpen(${JSON.stringify(pdfFile)}), 15000);
      const render = await withTimeout(
        window.eukoliaApi.pdfRender({ requestId: 900001, path: ${JSON.stringify(pdfFile)}, page: 0, scale: 1.2 }),
        15000
      );
      return {
        open: info.settled,
        openDetail: info.settled === 'resolved' ? { pageCount: info.value && info.value.pageCount, engine: info.value && info.value.engine } : info,
        render: render.settled,
        renderDetail:
          render.settled === 'resolved'
            ? { w: render.value.width, h: render.value.height, bytes: render.value.pixels ? render.value.pixels.length : 0, order: render.value.order }
            : render,
        available: await window.eukoliaApi.pdfAvailable()
      };
    })()`);

    const ipc = section(probe, 'pdfIpc');
    const nativeMissing = /not found|was not found|build:native/i.test(
      String(ipc.renderDetail ?? ipc.error ?? viewer.overlayText ?? '')
    );

    if (nativeMissing && allowsMissingNativeEngine()) {
      probe.pdfSkipped = 'the native PDF worker is not built; PDF viewer steps were skipped';
      // Only the problems that are caused by the missing worker are dropped; a
      // genuine SyncTeX or build failure must still be reported.
      for (let index = problems.length - 1; index >= 0; index--) {
        if (/was not found|not built|native PDF/i.test(problems[index])) problems.splice(index, 1);
      }
    } else {
      if (ipc.render !== 'resolved') {
        problems.push(`PDF bridge: pdfRender did not resolve (${JSON.stringify(ipc.renderDetail ?? ipc.render)})`);
      }
      if (Number(viewer.pdfPagesWithPixels) === 0) {
        problems.push(`PDF viewer: no page canvas with real pixels (samples: ${JSON.stringify(viewer.samples)})`);
      }
    }

    probe.alignmentFileUnchanged = fs.readFileSync(texFile, 'utf8') === before;

    // ------------------------------------------------------ 6b. the window chrome
    await step('6b the window chrome');
    //
    // The window is frameless and has no title bar: the tab bar is its top edge.
    // The menus it used to carry are the sidebar's Menu view now, so what is
    // checked here is that the menus are reachable from *somewhere* and that the
    // three window buttons are drawn — nothing else in the application draws
    // them, and a frameless window whose caption is missing cannot be closed by
    // its own chrome.
    probe.windowChrome = await evaluate<Record<string, unknown>>(`(() => {
      const bar = document.querySelector('[data-testid="tab-bar"]');
      const strip = document.querySelector('.eu-tab-strip');
      const controls = document.querySelector('[data-testid="tab-bar-window-controls"]');
      const status = document.querySelector('[data-testid="status-bar"]');
      const style = strip ? getComputedStyle(strip) : null;
      return {
        tabBar: !!bar,
        tabBarHeight: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
        tabBarTop: bar ? Math.round(bar.getBoundingClientRect().top) : -1,
        dragRegion: style ? (style.getPropertyValue('-webkit-app-region') || '') : '',
        controls: controls ? controls.querySelectorAll('button').length : 0,
        controlIds: controls
          ? Array.from(controls.querySelectorAll('button')).map((button) => button.getAttribute('data-testid'))
          : [],
        layoutToggles: status ? status.querySelectorAll('[data-testid^="status-toggle-"]').length : 0,
        // The chrome that was removed. Either of these still being in the tree
        // means a row of the window survived that was supposed to go.
        legacyTitleBar: !!document.querySelector('[data-testid="title-bar"]'),
        legacyMenuStrip: !!document.querySelector('[data-testid="title-bar-menus"]')
      };
    })()`);

    const windowChrome = section(probe, 'windowChrome');
    if (windowChrome.tabBar !== true) {
      problems.push('Window: a frameless window has no tab bar, so it has neither a drag region nor a caption');
    }
    if (windowChrome.tabBarTop !== 0) {
      problems.push(`Window: the tab bar is not the top row of the window (top ${String(windowChrome.tabBarTop)})`);
    }
    if (windowChrome.dragRegion !== 'drag') {
      problems.push('Window: the tab strip is not the drag region, so the window cannot be moved by its own chrome');
    }
    if (Number(windowChrome.controls) !== 3) {
      problems.push(`Window: ${String(windowChrome.controls)} caption buttons were drawn; minimise, maximise and close need three`);
    }
    if (Number(windowChrome.layoutToggles) < 4) {
      problems.push('Window: the layout toggles are missing from the status bar, which is where the removed title bar kept them');
    }
    if (windowChrome.legacyTitleBar === true) {
      problems.push('Window: the title bar is still in the tree; the menu strip above the tab bar was removed');
    }

    // The menus are the sidebar's Menu view now. Opened through the real command,
    // because "the Menu view draws them" is a claim about the application rather
    // than about a data structure — `tests/ui/app-menus.test.ts` covers the latter.
    {
      command('view.menu');
      await wait(500);
      probe.sidebarMenu = await evaluate<Record<string, unknown>>(`(() => {
        const region = document.querySelector('[data-testid="sidebar-region"]');
        const text = region ? (region.textContent || '') : '';
        return {
          open: !!region,
          sections: ['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Help']
            .filter((label) => text.includes(label)),
          textLength: text.length
        };
      })()`);
      // Back to the view the rest of the run expects.
      command('view.explorer');
      await wait(400);

      const sidebarMenu = section(probe, 'sidebarMenu');
      const drawn = Array.isArray(sidebarMenu.sections) ? sidebarMenu.sections.length : 0;
      if (sidebarMenu.open !== true || drawn < 8) {
        problems.push(
          `Menus: the sidebar Menu view drew ${String(drawn)} of the 8 menus, and it is the only pointer route to them now`
        );
      }
    }

    // Focus Mode, driven from the command the status bar's layout cluster also
    // dispatches: the cluster is where the removed title bar's toggles went, so
    // one of them working is what says the row's commands survived it.
    {
      command('view.focusMode');
      await wait(700);
      const focusOn = await evaluate<boolean>(`!!document.querySelector('[data-testid="focus-pdf-float"]')`);
      command('view.focusMode');
      await wait(700);
      const focusOff = await evaluate<boolean>(`!!document.querySelector('[data-testid="focus-pdf-float"]')`);
      probe.windowChrome = {
        ...section(probe, 'windowChrome'),
        focusFloatEntered: focusOn,
        focusFloatLeft: focusOff
      };
      if (focusOn !== true) problems.push('Layout: Focus Mode did not open its floating viewer');
      if (focusOff !== false) problems.push('Layout: Focus Mode did not close its floating viewer');
    }

    // ---------------------------------------------------------- 7a. user settings are on disk
    await step('7a user settings are on disk');
    //
    // The user's settings live beside their snippets — in the `.eukolia` folder
    // of the project library they chose — with the application-data layouts that
    // came before it still honoured. Changing a setting has to appear in the file
    // the user is actually reading, which is what makes it the record of their
    // configuration rather than an empty placeholder.
    {
      command('view.toggleTheme');
      // The write is coalesced by a quarter of a second.
      await wait(1500);

      const appData = app.getPath('userData');
      const candidates = userSettingsSearchPaths(appData);
      const settingsPath = resolveUserSettingsFile(appData) ?? candidates[0];
      // The library's `.eukolia` is where the snippets are written too; before a
      // library exists they live in `User/snippets` in application data.
      const snippetsPath = libraryUserDirectory(appData) ?? path.join(appData, 'User', 'snippets');

      let written: Record<string, unknown> | null = null;
      let parseError: string | null = null;
      if (fs.existsSync(settingsPath)) {
        try {
          written = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
        }
      }

      probe.userSettings = {
        path: settingsPath,
        searched: candidates,
        exists: fs.existsSync(settingsPath),
        snippetsDirectory: fs.existsSync(snippetsPath),
        keys: written ? Object.keys(written).length : 0,
        theme: written ? written['general.theme'] : null,
        parseError
      };

      const userSettings = section(probe, 'userSettings');
      if (userSettings.exists !== true) {
        problems.push(`User settings: ${settingsPath} was not written`);
      } else if (userSettings.parseError) {
        problems.push(`User settings: the file is not valid JSON (${String(userSettings.parseError)})`);
      } else if (Number(userSettings.keys) === 0) {
        problems.push('User settings: changing a setting did not reach the user settings file');
      }
      if (userSettings.snippetsDirectory !== true) {
        problems.push('User settings: the user snippets directory was not created');
      }
    }

    // ---------------------------------------------------------- 8. window chrome and terminal
    await step('8 window chrome and terminal');
    //
    // These are the toggles that can be rebound in settings, and the terminal
    // they switch on. Each is checked through its real interaction: the switcher
    // by holding Ctrl and pressing Tab, the terminal by running a command in the
    // real shell and reading its output back.

    command('view.toggleTabBar');
    await wait(600);
    const afterTabBarOff = await evaluate<Record<string, unknown>>(
      `(() => ({ tabListVisible: !!document.querySelector('[role="tablist"]') }))()`
    );
    command('view.toggleTabBar');
    await wait(600);
    const afterTabBarOn = await evaluate<Record<string, unknown>>(
      `(() => ({ tabListVisible: !!document.querySelector('[role="tablist"]') }))()`
    );

    probe.chromeToggles = {
      tabBarHidden: afterTabBarOff.tabListVisible === false,
      tabBarRestored: afterTabBarOn.tabListVisible === true
    };
    if (afterTabBarOff.tabListVisible !== false) {
      problems.push('View: toggling the tab bar off did not hide it');
    }
    if (afterTabBarOn.tabListVisible !== true) {
      problems.push('View: toggling the tab bar back on did not restore it');
    }

    // The status bar and the activity bar are the two pieces of chrome that have
    // *both* a setting and a command (`appearance.showStatusBar`,
    // `appearance.showActivityBar`). They used to be dead settings — visible in
    // the Settings UI, read by nothing — so this checks the command actually
    // moves the chrome, which is the half a settings-file assertion cannot see.
    const toggleChrome = async (id: string, selector: string) => {
      command(id);
      await wait(600);
      const off = await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
      command(id);
      await wait(600);
      const on = await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
      return { off, on };
    };

    const statusBar = await toggleChrome('view.toggleStatusBar', '[data-testid="status-bar"]');

    // The activity bar is part of the sidebar — it is rendered only while the
    // sidebar is showing — so this toggle is only observable with the sidebar
    // up. The sidebar is revealed first, explicitly: without that, a step
    // earlier in the run having collapsed it would make the strip legitimately
    // absent and this would report a broken toggle that is not broken.
    command('view.explorer');
    await wait(600);
    const sidebarUp = await evaluate<boolean>(`!!document.querySelector('[data-testid="sidebar-region"]')`);
    const activityBar = await toggleChrome('view.toggleActivityBar', '[data-testid="activity-bar"]');

    probe.chromeToggles = {
      ...section(probe, 'chromeToggles'),
      sidebarUpForActivityBar: sidebarUp,
      statusBarHidden: statusBar.off === false,
      statusBarRestored: statusBar.on === true,
      activityBarHidden: activityBar.off === false,
      activityBarRestored: activityBar.on === true
    };
    if (sidebarUp !== true) {
      problems.push('View: the sidebar could not be shown, so the activity bar toggle is untested');
    }
    if (statusBar.off !== false) {
      problems.push('View: toggling the status bar off did not hide it');
    }
    if (statusBar.on !== true) {
      problems.push('View: toggling the status bar back on did not restore it');
    }
    if (activityBar.off !== false) {
      problems.push('View: toggling the activity bar off did not hide it');
    }
    if (activityBar.on !== true) {
      problems.push('View: toggling the activity bar back on did not restore it');
    }

    /*
     * The tab bar is the fourth piece of chrome with both a command and a
     * setting, and it is the one that must *not* leave.
     *
     * It carries the window's drag region, its caption buttons and its toolbar,
     * so a toggle that removed the bar would leave a window that cannot be moved,
     * built or closed by its own chrome. What goes is the document strip inside it
     * — which is what `view.toggleTabBar` now means, and what the check below is
     * written against.
     */
    const tabsHidden = await toggleChrome('view.toggleTabBar', '[data-testid="tab-bar"] [role="tablist"]');
    const windowSurvivesTabs = await evaluate<Record<string, unknown>>(
      `(() => ({
        bar: !!document.querySelector('[data-testid="tab-bar"]'),
        controls: !!document.querySelector('[data-testid="tab-bar-window-controls"]'),
        toolbar: !!document.querySelector('[data-testid="tab-bar-toolbar"]')
      }))()`
    );

    probe.chromeToggles = {
      ...section(probe, 'chromeToggles'),
      tabsHidden: tabsHidden.off === true,
      tabsRestored: tabsHidden.on === true,
      windowSurvivesTabs:
        windowSurvivesTabs.bar === true &&
        windowSurvivesTabs.controls === true &&
        windowSurvivesTabs.toolbar === true
    };
    if (tabsHidden.off !== true) {
      problems.push('View: toggling the tab bar off did not hide the document tabs');
    }
    if (tabsHidden.on !== true) {
      problems.push('View: toggling the tab bar back on did not restore the document tabs');
    }
    if (windowSurvivesTabs.bar !== true || windowSurvivesTabs.controls !== true) {
      problems.push(
        'View: hiding the tab bar took the window controls with it — a frameless window would have no caption left and no drag region'
      );
    }

    // ------------------------------------------------- 8b. the tab bar's toolbar
    await step('8b tab bar toolbar');
    //
    // Five actions in three controls on the tab strip's right-hand end: Compile,
    // the PDF viewer's own menu, the Code/Visual segmented control, Focus Mode and
    // the menu bar. Each is a command, so this checks the two halves that a unit
    // test cannot: that the *real* keyboard reaches the same commands the buttons
    // dispatch, and that the buttons report what those commands did. A button and
    // a key that disagree is exactly the failure this step exists for.

    /** Clicks a control by its `data-testid`, through the real DOM. */
    const clickControl = async (testId: string): Promise<boolean> => {
      const clicked = await evaluate<boolean>(
        `(() => {
          const control = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
          if (!control) return false;
          control.click();
          return true;
        })()`
      );
      await wait(320);
      return clicked;
    };

    /** Reads the toolbar's live state: what is pressed, and what is drawn. */
    const readToolbar = () =>
      evaluate<Record<string, unknown>>(
        `(() => {
          const pressed = (id) => {
            const control = document.querySelector('[data-testid="' + id + '"]');
            return control ? control.getAttribute('aria-pressed') : null;
          };
          const toolbar = document.querySelector('[data-testid="tab-bar-toolbar"]');
          return {
            present: !!toolbar,
            controls: toolbar ? toolbar.querySelectorAll('button').length : 0,
            codePressed: pressed('toolbar-mode-code'),
            visualPressed: pressed('toolbar-mode-visual'),
            focusPressed: pressed('toolbar-focus-mode'),
            compileTitle: document.querySelector('[data-testid="toolbar-compile"]')?.getAttribute('title') ?? null,
            modeTitle: document.querySelector('[data-testid="toolbar-mode"]')?.getAttribute('title') ?? null
          };
        })()`
      );

    const toolbarBefore = await readToolbar();

    /*
     * A real keystroke, with modifiers, to the window.
     *
     * The shell's key handler ignores a shortcut while a typing field has focus,
     * which is what lets `Ctrl+1` reach the PDF viewer and leaves the editor's own
     * keys alone; CodeMirror's content element *is* a typing field.
     */
    const pressWithModifiers = async (
      keyCode: string,
      modifiers: Array<'control' | 'shift' | 'alt'>
    ): Promise<void> => {
      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await wait(400);
    };

    /*
     * Focus is moved off the editor before any chord, and read back every time.
     *
     * The shell's key handler ignores a shortcut while a typing field has focus,
     * which is what lets `Ctrl+1` reach the PDF viewer and leaves the editor's own
     * keys alone — and CodeMirror's content element *is* a typing field. This is
     * why the first version of this step reported four working shortcuts as
     * broken: `blur()` empties an editor's focus but leaves CodeMirror in the tab
     * order, and the very next press landed back in the editor, on a
     * `contentEditable` target the handler is right to ignore.
     *
     * Tabbing to the toolbar with the keyboard is not a workaround, it is the
     * gesture a user performs: the strip's own controls are in the tab order, and
     * `document.activeElement` after the Tab is the proof that the press that
     * follows will not be swallowed.
     */
    const focusToolbar = async (): Promise<boolean> => {
      const focused = await evaluate<boolean>(
        `(() => {
          const active = document.activeElement;
          if (active && active !== document.body && typeof active.blur === 'function') active.blur();
          if (typeof document.body.focus === 'function') document.body.focus();
          const toolbar = document.querySelector('[data-testid="tab-bar-toolbar"]');
          if (!toolbar || typeof toolbar.focus !== 'function') return false;
          toolbar.focus();
          const target = document.activeElement;
          return !!target && target.closest && target.closest('[data-testid="tab-bar-toolbar"]') !== null;
        })()`
      );
      await wait(120);
      return focused;
    };

    /*
     * What the renderer actually receives for a chord.
     *
     * Recorded because "the shortcut did not fire" has several causes that look
     * identical from the DOM — the event never arrived, it arrived with different
     * modifiers, or it arrived and something rejected it — and the recorded event
     * is what tells them apart. This is what identified the failure above.
     */
    const recordNextChord = (): Promise<void> =>
      evaluate<void>(
        `(() => {
          window.__euChord = null;
          const onKey = (event) => {
            if (event.key === 'Escape' || event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt') return;
            window.__euChord = {
              key: event.key,
              code: event.code,
              ctrl: event.ctrlKey,
              alt: event.altKey,
              shift: event.shiftKey,
              meta: event.metaKey,
              target: event.target && event.target.tagName ? event.target.tagName : null,
              contentEditable: event.target && event.target.isContentEditable === true
            };
            window.removeEventListener('keydown', onKey, true);
          };
          window.addEventListener('keydown', onKey, true);
        })()`
      );

    const readChord = () => evaluate<Record<string, unknown> | null>('window.__euChord || null');


    // The viewer's menu, opened from its own chevron and read as a menu.
    const viewerMenuOpened = await clickControl('toolbar-pdf-menu');
    const viewerMenu = await evaluate<Record<string, unknown>>(
      `(() => {
        const panel = document.querySelector('[data-testid="toolbar-pdf-menu-panel"]');
        if (!panel) return { open: false };
        return {
          open: true,
          entries: Array.from(panel.querySelectorAll('[role="menuitem"]')).map((entry) => (entry.textContent || '').trim()),
          text: (panel.textContent || '').trim()
        };
      })()`
    );
    // Closing it again so the rest of the step reads a stable screen.
    await clickControl('toolbar-pdf-menu');

    await focusToolbar();
    await pressWithModifiers('1', ['control']);
    const afterCtrl1 = await readToolbar();
    // Focus is re-established before every chord: a mode change re-renders the
    // editor, and a re-render is enough to take focus back out of the strip.
    await focusToolbar();
    await pressWithModifiers('2', ['control']);
    const afterCtrl2 = await readToolbar();

    // Focus Mode, driven by its own shortcut: `Ctrl+Alt+1` twice, which is the
    // toggle the toolbar's button dispatches. The chord the renderer receives is
    // recorded alongside, so a failure here says whether the key arrived at all.
    await focusToolbar();
    await recordNextChord();
    await pressWithModifiers('1', ['control', 'alt']);
    const focusChord = await readChord();
    const afterFocusOn = await readToolbar();
    await focusToolbar();
    await pressWithModifiers('1', ['control', 'alt']);
    const afterFocusOff = await readToolbar();

    // The window controls, clicked for real. Nothing else in the application
    // draws them, so an inert button here is a window that can only be closed
    // from the taskbar. Minimise and maximise are exercised because they are
    // reversible; Close is checked for its presence and its name rather than
    // clicked, because the run would end.
    const captionControls = await evaluate<Record<string, unknown>>(
      `(() => {
        const controls = document.querySelector('[data-testid="tab-bar-window-controls"]');
        if (!controls) return { present: false };
        const buttons = Array.from(controls.querySelectorAll('button'));
        const rect = controls.getBoundingClientRect();
        const bar = document.querySelector('[data-testid="tab-bar"]');
        return {
          present: true,
          count: buttons.length,
          ids: buttons.map((button) => button.getAttribute('data-testid')),
          names: buttons.map((button) => button.getAttribute('aria-label')),
          // The cluster is the last thing in the bar, at the window's own edge.
          atRightEdge: bar ? Math.abs(rect.right - bar.getBoundingClientRect().right) < 2 : false,
          height: Math.round(rect.height)
        };
      })()`
    );
    let maximiseWorked = false;
    let restoreWorked = false;
    if (captionControls.present === true) {
      const wasMaximized = window.isMaximized();
      await clickControl('window-control-maximize');
      await wait(700);
      maximiseWorked = window.isMaximized() !== wasMaximized;
      await clickControl('window-control-maximize');
      await wait(700);
      restoreWorked = window.isMaximized() === wasMaximized;
    }

    probe.windowControls = { ...captionControls, maximiseWorked, restoreWorked };

    if (captionControls.present !== true) {
      problems.push('Window: the tab bar drew no caption buttons, and nothing else draws them');
    } else {
      if (Number(captionControls.count) !== 3) {
        problems.push(`Window: ${String(captionControls.count)} caption buttons were drawn instead of three`);
      }
      if (captionControls.atRightEdge !== true) {
        problems.push('Window: the caption buttons are not at the window’s right-hand edge');
      }
      for (const name of (captionControls.names as string[] | undefined) ?? []) {
        if (!name) problems.push('Window: a caption button has no accessible name');
      }
      if (maximiseWorked !== true) {
        problems.push('Window: pressing Maximise did not change the window’s maximised state');
      }
      if (restoreWorked !== true) {
        problems.push('Window: pressing Maximise a second time did not restore the window');
      }
    }

    probe.tabBarToolbar = {
      ...toolbarBefore,
      viewerMenuOpened,
      viewerMenuEntries: viewerMenu.entries ?? [],
      viewerMenuNamesTheDocument: typeof viewerMenu.text === 'string' && viewerMenu.text.includes('.pdf'),
      codePressedAfterCtrl1: afterCtrl1.codePressed,
      visualPressedAfterCtrl2: afterCtrl2.visualPressed,
      focusChord,
      focusPressedAfterShortcut: afterFocusOn.focusPressed,
      focusReleasedAfterSecondShortcut: afterFocusOff.focusPressed
    };

    if (toolbarBefore.present !== true) {
      problems.push('Tab bar: the toolbar is not rendered');
    }
    if (Number(toolbarBefore.controls) < 5) {
      problems.push(`Tab bar: the toolbar drew ${String(toolbarBefore.controls)} controls; five actions need at least five buttons`);
    }
    if (viewerMenuOpened !== true || viewerMenu.open !== true) {
      problems.push('Tab bar: the PDF control did not open its menu');
    }
    if ((viewerMenu.entries as unknown[] | undefined)?.length !== 3) {
      problems.push('Tab bar: the PDF menu should offer the viewer, Build and View, and the recipe picker');
    }
    if (afterCtrl1.codePressed !== 'true' || afterCtrl2.visualPressed !== 'true') {
      problems.push('Tab bar: the Code/Visual control did not follow Ctrl+1 and Ctrl+2');
    }
    if (afterFocusOn.focusPressed !== 'true') {
      problems.push(
        `Tab bar: Ctrl+Alt+1 did not put the Focus Mode control in its pressed state (the renderer received ${JSON.stringify(focusChord)})`
      );
    }
    if (afterFocusOff.focusPressed !== 'false') {
      problems.push('Tab bar: Ctrl+Alt+1 did not release the Focus Mode control on the second press');
    }

    // A tooltip that states a key has to state the *current* one, and only while
    // the command really answers to it: `Ctrl+B` belongs to the side bar here, so
    // Compile must not claim it.
    const compileTitle = typeof toolbarBefore.compileTitle === 'string' ? toolbarBefore.compileTitle : '';
    if (/Ctrl\+B\b/.test(compileTitle)) {
      problems.push(`Tab bar: the Compile tooltip claims Ctrl+B, which toggles the sidebar: ${compileTitle}`);
    }
    const modeTitle = typeof toolbarBefore.modeTitle === 'string' ? toolbarBefore.modeTitle : '';
    if (!modeTitle.includes('Ctrl+Shift+V')) {
      problems.push(`Tab bar: the mode control's tooltip does not state its shortcut: ${modeTitle}`);
    }

    // --- the Ctrl+Tab switcher: hold Ctrl, press Tab, release Ctrl ---
    const ctrlTab = async (keyCode: string, modifiers: Array<'control'> = ['control']) => {
      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      await wait(220);
    };

    await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['control'] });
    await wait(400);

    probe.tabSwitcher = await evaluate<Record<string, unknown>>(`(() => {
      const popup = document.querySelector('[data-testid="tab-switcher"]');
      if (!popup) return { open: false };
      const rows = Array.from(popup.querySelectorAll('[data-testid="tab-switcher-row"]'));
      const selected = rows.findIndex((row) => row.getAttribute('data-selected') === 'true');
      const first = rows[0];
      return {
        open: true,
        rowCount: rows.length,
        selectedIndex: selected,
        // Every row carries its two controls. Thumbnails were removed from the
        // switcher deliberately — a row is title plus controls, and a per-tab
        // raster preview was both slow and redundant with the tab bar.
        pins: popup.querySelectorAll('[data-testid="tab-switcher-pin"]').length,
        closes: popup.querySelectorAll('[data-testid="tab-switcher-close"]').length,
        titles: rows.map((row) => (row.textContent || '').slice(0, 40)),
        selectedText: selected >= 0 ? (rows[selected].textContent || '').slice(0, 40) : null,
        firstText: first ? (first.textContent || '').slice(0, 40) : null
      };
    })()`);

    // Still holding Ctrl: another Tab must move the highlight, not close it.
    await ctrlTab('Tab');
    probe.tabSwitcherAfterSecondTab = await evaluate<Record<string, unknown>>(`(() => {
      const popup = document.querySelector('[data-testid="tab-switcher"]');
      if (!popup) return { open: false };
      const rows = Array.from(popup.querySelectorAll('[data-testid="tab-switcher-row"]'));
      return {
        open: true,
        selectedIndex: rows.findIndex((row) => row.getAttribute('data-selected') === 'true'),
        rowCount: rows.length
      };
    })()`);

    // The row itself: what a row shows, how tall it is, and that the pin is one
    // glyph whose colour carries the state.
    probe.tabSwitcherRows = await evaluate<Record<string, unknown>>(`(() => {
      const popup = document.querySelector('[data-testid="tab-switcher"]');
      if (!popup) return { open: false };
      const rows = Array.from(popup.querySelectorAll('[data-testid="tab-switcher-row"]'));
      const pathOf = (row) => row.querySelector('[data-testid="tab-switcher-path-text"]');
      const clipOf = (row) => row.querySelector('[data-testid="tab-switcher-path"]');
      // The fixture's paths fit in a 460px popup, which is the case where the
      // path has nothing to do. Narrowing the popup puts a path wider than its
      // row, which is the case the slide exists for; the width is put back after
      // the hover below.
      const panel = popup.firstElementChild;
      if (panel) panel.style.width = '220px';
      const overflowing = rows.findIndex((row) => {
        const text = pathOf(row);
        const clip = clipOf(row);
        return !!text && !!clip && text.scrollWidth > clip.clientWidth + 1;
      });
      const rect = overflowing >= 0 ? rows[overflowing].getBoundingClientRect() : null;
      return {
        open: true,
        rowCount: rows.length,
        selectedIndex: rows.findIndex((row) => row.getAttribute('data-selected') === 'true'),
        heights: rows.map((row) => Math.round(row.getBoundingClientRect().height * 10) / 10),
        paths: rows.map((row) => ((pathOf(row) || {}).textContent || '')),
        // A path is a permanent part of the row: none may be missing, invisible
        // or faded out, which is what the old hover-only reveal amounted to.
        fadedPaths: rows.filter((row) => {
          const clip = clipOf(row);
          const text = pathOf(row);
          if (!clip || !text || !(text.textContent || '').length) return true;
          const style = getComputedStyle(clip);
          return Number(style.opacity) < 0.99 || style.visibility === 'hidden';
        }).length,
        // …and the name starts the row: no glyph in front of the title.
        titleGlyphs: rows.filter((row) => {
          const title = row.querySelector('[data-testid="tab-switcher-title"]');
          return !!title && title.querySelector('svg') !== null;
        }).length,
        // One distinct glyph across every pin control, pinned or not.
        pinGlyphs: Array.from(new Set(Array.from(popup.querySelectorAll('[data-testid="tab-switcher-pin"]')).map((pin) => pin.innerHTML))).length,
        overflowingIndex: overflowing,
        hoverPoint: rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null
      };
    })()`);

    // The wheel, over the list. The popup only exists while Ctrl is held, and
    // Ctrl+wheel is Chromium's zoom, so the popup claims it (`data-ctrl-wheel-scroll`)
    // and the shell's handler — `core/smoothScroll` — glides the list. The notch is
    // sent with Ctrl held, which is the only way a user can send it here.
    probe.tabSwitcherWheel = await (async (): Promise<Record<string, unknown>> => {
      const opened = await evaluate<Record<string, unknown>>(`(() => {
        const list = document.querySelector('[data-testid="tab-switcher"] [role="listbox"]');
        if (!list) return { present: false };
        // The fixture opens four tabs, which do not fill the popup, so a notch
        // would have nowhere to go and the check would pass on nothing. Capping
        // the list puts it in the state a long list is in; the cap is lifted once
        // the glide has been measured.
        list.style.maxHeight = '80px';
        const before = list.scrollTop;
        const event = new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true, ctrlKey: true });
        list.dispatchEvent(event);
        return { present: true, prevented: event.defaultPrevented, scrollable: list.scrollHeight > list.clientHeight, before };
      })()`);
      if (opened.present !== true) return opened;

      const offset = `(() => { const list = document.querySelector('[data-testid="tab-switcher"] [role="listbox"]'); return list ? list.scrollTop : -1; })()`;
      // The first movement is what separates a glide from a jump: sampled on the
      // frames after the notch rather than once at the end.
      let first: number | null = null;
      for (let attempt = 0; attempt < 16; attempt++) {
        await wait(25);
        const seen = await evaluate<number>(offset);
        if (seen > Number(opened.before) + 0.5) {
          first = seen;
          break;
        }
      }
      await wait(800);
      const after = await evaluate<number>(offset);
      await evaluate(`(() => { const list = document.querySelector('[data-testid="tab-switcher"] [role="listbox"]'); if (list) list.style.maxHeight = ''; return true; })()`);
      return { ...opened, first, after };
    })();

    // Hovering a row whose path is wider than the row must slide that path.
    const rowProbe = section(probe, 'tabSwitcherRows');
    const hoverPoint = rowProbe.hoverPoint as { x: number; y: number } | null | undefined;
    if (hoverPoint && typeof hoverPoint.x === 'number') {
      const overflowingIndex = String(rowProbe.overflowingIndex);
      await window.webContents.sendInputEvent({ type: 'mouseMove', x: hoverPoint.x, y: hoverPoint.y });

      // Wait for the pointer to land before timing anything: a busy main process
      // can deliver the move late, and a transform read in the frame the style
      // was first applied is still the starting one.
      for (let attempt = 0; attempt < 20; attempt++) {
        const focused = await evaluate<string>(
          `(() => { const row = document.querySelector('[data-testid="tab-switcher"] [data-row-index="${overflowingIndex}"]'); return row ? row.getAttribute('data-focused') || '' : ''; })()`
        );
        if (focused === 'true') break;
        await wait(150);
      }
      await wait(900);

      probe.tabSwitcherMarquee = await evaluate<Record<string, unknown>>(`(() => {
        const row = document.querySelector('[data-testid="tab-switcher"] [data-row-index="${overflowingIndex}"]');
        if (!row) return { present: false };
        const text = row.querySelector('[data-testid="tab-switcher-path-text"]');
        const clip = text ? text.parentElement : null;
        return {
          present: true,
          focused: row.getAttribute('data-focused'),
          marquee: text ? text.getAttribute('data-marquee') : null,
          // Both the style the component set and what the browser made of it.
          inlineTransform: text ? text.style.transform : null,
          transform: text ? getComputedStyle(text).transform : null,
          left: text ? Math.round(text.getBoundingClientRect().left * 10) / 10 : null,
          clipLeft: clip ? Math.round(clip.getBoundingClientRect().left * 10) / 10 : null
        };
      })()`);

      // Put the pointer back on the row the keyboard was on, so the commit below
      // still tests what it was written to test.
      const selectedIndex = Number(rowProbe.selectedIndex);
      const restore = await evaluate<{ x: number; y: number } | null>(`(() => {
        const row = document.querySelector('[data-testid="tab-switcher"] [data-row-index="${selectedIndex}"]');
        if (!row) return null;
        const rect = row.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`);
      if (restore) {
        await window.webContents.sendInputEvent({ type: 'mouseMove', x: restore.x, y: restore.y });
        await wait(200);
      }

      // The popup goes back to its own width before the commit below.
      await evaluate(
        `(() => { const panel = document.querySelector('[data-testid="tab-switcher"] > div'); if (panel) panel.style.width = ''; return true; })()`
      );
    }

    // Releasing Ctrl commits the highlighted tab.
    await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control', modifiers: [] });
    await wait(900);

    probe.tabSwitcherCommitted = await evaluate<Record<string, unknown>>(`(() => ({
      open: !!document.querySelector('[data-testid="tab-switcher"]'),
      activeTab: (document.querySelector('[role="tab"][aria-selected="true"]') || {}).title || null
    }))()`);

    // --- smooth scrolling: the same wheel, the same glide, on every surface ---
    //
    // A real `mouseWheel` input event rather than a dispatched one, because what
    // is being checked is the shell's own window listener on a genuine notch. The
    // shape of the movement is what matters: a surface the shell drives glides, so
    // the first sample lands between where it started and where it finished, while
    // a surface left to the browser jumps straight to the end.
    const wheelSurface = async (contentSelector: string, capHeight?: number): Promise<Record<string, unknown>> => {
      const located = await evaluate<Record<string, unknown> | null>(`(() => {
        const content = document.querySelector(${JSON.stringify(contentSelector)});
        if (!content) return null;
        const box = content.closest('[data-scroll]') || content;
        ${capHeight === undefined ? '' : `box.style.maxHeight = '${capHeight}px';`}
        const rect = box.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) return { present: false, reason: 'not on screen' };
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        // Where a synthesized coordinate actually lands. A window/page scale
        // difference can put it on another surface entirely, and then the notch
        // would be measuring the wrong thing while looking like a scroll bug.
        const hit = document.elementFromPoint(x, y);
        const chain = [];
        for (let node = hit; node && chain.length < 8; node = node.parentElement) {
          const style = getComputedStyle(node);
          chain.push({
            tag: node.tagName,
            cls: String(node.className || '').slice(0, 40),
            oy: style.overflowY,
            ox: style.overflowX,
            sh: node.scrollHeight,
            ch: node.clientHeight
          });
        }
        return {
          present: true,
          x,
          y,
          dpr: window.devicePixelRatio,
          before: box.scrollTop,
          scrollable: box.scrollHeight > box.clientHeight,
          hitInside: !!hit && (hit === box || box.contains(hit)),
          hit: hit ? hit.tagName : null,
          chain
        };
      })()`);
      if (!located || located.present !== true) return located ?? { present: false };

      // What the renderer actually receives, so "the notch never arrived" cannot
      // be misread as "the surface did not move". Registered in the bubble phase,
      // which is where the shell's own handler runs: by the time this listener
      // sees the event, `defaultPrevented` says whether the shell took it.
      await evaluate(`(() => {
        window.__euWheel = { seen: 0, prevented: 0 };
        window.addEventListener('wheel', (event) => {
          window.__euWheel.seen += 1;
          if (event.defaultPrevented) window.__euWheel.prevented += 1;
        });
        return true;
      })()`);

      let via = 'input';
      if (located.hitInside === true) {
        await window.webContents.sendInputEvent({
          type: 'mouseWheel',
          x: Number(located.x),
          y: Number(located.y),
          // Electron's wheel delta carries the opposite sign to the DOM's, and a
          // notch without `hasPreciseScrollingDeltas` is not delivered at all: this
          // is the shape that arrives as `deltaY: +120`, a notch downwards.
          deltaX: 0,
          deltaY: -120,
          hasPreciseScrollingDeltas: true,
          wheelTicksX: 0,
          wheelTicksY: 1,
          canScroll: true
        });
      } else {
        // The synthesized coordinate missed the surface — a narrow sidebar can be
        // missed by an input coordinate that does not share its scale — so the
        // notch is sent from a child of it instead. The handler under test is the
        // shell's window listener either way, and the report says which route was
        // taken rather than pretending the two are the same.
        via = 'dispatched';
        await evaluate(`(() => {
          const content = document.querySelector(${JSON.stringify(contentSelector)});
          const child = content && (content.firstElementChild || content);
          if (child) child.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true }));
          return true;
        })()`);
      }

      const offset = `(() => { const content = document.querySelector(${JSON.stringify(contentSelector)}); if (!content) return -1; const box = content.closest('[data-scroll]') || content; return box.scrollTop; })()`;
      let first: number | null = null;
      for (let attempt = 0; attempt < 16; attempt++) {
        await wait(25);
        const seen = await evaluate<number>(offset);
        if (seen > Number(located.before) + 0.5) {
          first = seen;
          break;
        }
      }
      await wait(800);
      const after = await evaluate<number>(offset);

      // Whatever the cap was, the surface goes back to its own size.
      await evaluate(`(() => { const content = document.querySelector(${JSON.stringify(contentSelector)}); if (!content) return false; const box = content.closest('[data-scroll]') || content; box.style.maxHeight = ''; return true; })()`);

      const received = await evaluate<{ seen: number; prevented: number }>(`window.__euWheel`);
      return {
        present: true,
        via,
        hitInside: located.hitInside,
        hit: located.hit,
        point: { x: located.x, y: located.y, dpr: located.dpr },
        scrollable: located.scrollable,
        before: located.before,
        first,
        after,
        seen: received?.seen ?? 0,
        prevented: received?.prevented ?? 0
      };
    };

    // The sidebar and the panel are opened deliberately, so the two lists checked
    // here are on screen whatever the earlier steps left behind. The caps put a
    // short list into the state a long one is in; the wheel handling under test is
    // the same either way.
    command('view.explorer');
    await wait(400);
    command('view.output');
    await wait(900);

    probe.smoothScroll = {
      editor: await wheelSurface('.cm-scroller'),
      sidebar: await wheelSurface('[role="tree"][aria-label="Project files"]', 80),
      panel: await wheelSurface('[data-testid="bottom-panel"] [data-scroll]', 80),
      pdfNative: await evaluate<boolean>(
        `(() => { const scroller = document.querySelector('[data-testid="pdf-scroll-container"]'); return !!scroller && !!scroller.closest('[data-native-scroll]'); })()`
      )
    };

    const switcher = section(probe, 'tabSwitcher');
    const second = section(probe, 'tabSwitcherAfterSecondTab');
    const committed = section(probe, 'tabSwitcherCommitted');
    if (switcher.open !== true) {
      problems.push('Ctrl+Tab did not open the tab switcher');
    } else {
      if (Number(switcher.rowCount) < 2) {
        problems.push(`Ctrl+Tab listed ${String(switcher.rowCount)} tab(s); the fixture opens more than one`);
      }
      if (Number(switcher.pins) !== Number(switcher.rowCount)) {
        problems.push(`Ctrl+Tab: ${String(switcher.pins)} pin controls for ${String(switcher.rowCount)} rows`);
      }
      if (Number(switcher.closes) !== Number(switcher.rowCount)) {
        problems.push(`Ctrl+Tab: ${String(switcher.closes)} close controls for ${String(switcher.rowCount)} rows`);
      }
      if (second.open !== true) {
        problems.push('Ctrl+Tab: pressing Tab again closed the popup instead of cycling');
      } else if (Number(second.selectedIndex) === Number(switcher.selectedIndex)) {
        problems.push(
          `Ctrl+Tab: pressing Tab did not move the highlight (still ${String(second.selectedIndex)})`
        );
      }
      if (Number(switcher.selectedIndex) === 0) {
        problems.push('Ctrl+Tab: the first press should highlight the previously used tab, not the current one');
      }
      if (committed.open !== false) {
        problems.push('Ctrl+Tab: releasing Ctrl did not close the switcher');
      }
    }

    // What the row checks were asked to show: every row carries its path, the
    // name starts the row, the pin is one glyph, the rows stay compact, and the
    // wheel moves the list rather than zooming the window.
    const rows = section(probe, 'tabSwitcherRows');
    if (rows.open === true) {
      const heights = Array.isArray(rows.heights) ? (rows.heights as number[]) : [];
      const tallest = heights.length > 0 ? Math.max(...heights) : 0;
      if (tallest > 31) {
        problems.push(`Ctrl+Tab: a row is ${tallest}px tall; the list should stay compact`);
      }
      const paths = Array.isArray(rows.paths) ? (rows.paths as string[]) : [];
      if (paths.length !== Number(rows.rowCount) || paths.some((path) => !path)) {
        problems.push(`Ctrl+Tab: ${String(rows.rowCount)} rows carry ${paths.filter((path) => !!path).length} paths`);
      }
      if (Number(rows.fadedPaths) !== 0) {
        problems.push(`Ctrl+Tab: ${String(rows.fadedPaths)} row(s) hide their path`);
      }
      if (Number(rows.titleGlyphs) !== 0) {
        problems.push('Ctrl+Tab: a glyph is still rendered in front of a title');
      }
      if (Number(rows.overflowingIndex) < 0) {
        problems.push('Ctrl+Tab: no path was wider than its row, so the slide was never exercised');
      }
      if (Number(rows.pinGlyphs) !== 1) {
        problems.push(
          `Ctrl+Tab: the pin control renders ${String(rows.pinGlyphs)} different glyphs; the state should be its colour alone`
        );
      }
    }

    const wheel = section(probe, 'tabSwitcherWheel');
    if (wheel.present !== true) {
      problems.push('Ctrl+Tab: the popup has no list to scroll');
    } else if (wheel.prevented !== true) {
      // Ctrl is held for as long as the popup is up, and Ctrl+wheel is the
      // browser's zoom: an unprevented notch zooms instead of scrolling.
      problems.push('Ctrl+Tab: a wheel notch over the list was left to the browser');
    } else if (wheel.scrollable !== true) {
      problems.push('Ctrl+Tab: the list could not be made scrollable, so the notch proved nothing');
    } else if (Number(wheel.after) <= Number(wheel.before)) {
      problems.push(
        `Ctrl+Tab: a wheel notch did not move the scrollable list (${String(wheel.before)} → ${String(wheel.after)})`
      );
    } else if (!(Number(wheel.first) > Number(wheel.before) && Number(wheel.first) < Number(wheel.after))) {
      problems.push(
        `Ctrl+Tab: the list jumped instead of gliding (${String(wheel.before)} → ${String(wheel.first)} → ${String(wheel.after)})`
      );
    }

    // Every other surface is driven by the same handler, so each of these has to
    // glide — and the two that own their scrolling have to say so, or the handler
    // would be writing an offset their engine is already moving.
    const smooth = section(probe, 'smoothScroll');
    for (const [label, key] of [
      ['the editor', 'editor'],
      ['the file tree', 'sidebar'],
      ['the output panel', 'panel']
    ] as const) {
      const entry = section(smooth, key);
      if (entry.present !== true) {
        problems.push(`Smooth scrolling: ${label} was not on screen to wheel over (${String(entry.reason ?? 'missing')})`);
        continue;
      }
      if (entry.scrollable !== true) {
        problems.push(`Smooth scrolling: ${label} had nothing to scroll, so the notch proved nothing`);
        continue;
      }
      if (Number(entry.seen) < 1) {
        problems.push(`Smooth scrolling: the wheel notch never reached the renderer over ${label}`);
        continue;
      }
      if (Number(entry.prevented) < 1) {
        problems.push(`Smooth scrolling: ${label} left the notch to the browser instead of the shell`);
        continue;
      }
      const before = Number(entry.before);
      const first = Number(entry.first);
      const after = Number(entry.after);
      if (!(after > before)) {
        problems.push(`Smooth scrolling: a wheel notch over ${label} moved nothing (${before} → ${after})`);
        continue;
      }
      if (!(first > before && first < after)) {
        problems.push(`Smooth scrolling: ${label} jumped instead of gliding (${before} → ${String(entry.first)} → ${after})`);
      }
    }
    if (smooth.pdfNative !== true) {
      problems.push('Smooth scrolling: the PDF viewer is not left to its own engine');
    }

    const marquee = section(probe, 'tabSwitcherMarquee');
    // Only judged when the pointer actually reached the row: a synthetic move
    // need not be delivered at all, and a missing hover is not a bug in the row.
    if (marquee.present === true && marquee.focused === 'true') {
      const inline = typeof marquee.inlineTransform === 'string' ? marquee.inlineTransform : '';
      const computed = typeof marquee.transform === 'string' ? marquee.transform : '';
      // The component sets a negative `translateX`; the browser is then expected
      // to be mid-slide, so the computed matrix is not the identity either.
      const slid = /translateX\(-/.test(inline);
      const moved = computed !== '' && computed !== 'none' && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(computed);
      if (marquee.marquee !== 'true' || !slid || !moved) {
        problems.push(
          `Ctrl+Tab: the hovered row's long path did not slide (inline ${inline || 'none'}, computed ${computed || 'none'})`
        );
      }
    }

    // --- the integrated terminal ---
    command('view.toggleTerminal');
    await wait(1200);

    const terminalMounted = await evaluate<Record<string, unknown>>(
      `(() => {
         const panel = document.querySelector('[data-testid="terminal-panel"]');
         const screen = document.querySelector('[data-testid="terminal-screen"]');
         return {
           present: !!panel,
           // The panel is only a terminal if a pty and an emulator are behind it.
           tty: panel ? panel.getAttribute('data-terminal-tty') : null,
           emulator: !!document.querySelector('[data-testid="terminal-screen"] .xterm-screen'),
           // The shell's wheel handler has to keep out of here: on the alternate
           // screen a notch is an arrow key sent to the program, not a scroll.
           nativeScroll: !!screen && !!screen.closest('[data-native-scroll]')
         };
       })()`
    );
    let terminalReady = false;
    if (terminalMounted.present !== true) {
      problems.push('Terminal: the panel did not appear when it was toggled on');
    } else {
      if (terminalMounted.nativeScroll !== true) {
        problems.push('Smooth scrolling: the terminal does not hand its wheel back to xterm');
      }
      if (terminalMounted.tty !== 'pty') {
        problems.push('Terminal: the panel is not running on a pty');
      }
      if (terminalMounted.emulator !== true) {
        problems.push('Terminal: no xterm emulator was mounted in the panel');
      }
      // The shell has to be up before anything can be typed into it: keystrokes
      // sent before the pty exists have nowhere to go, and PowerShell can take a
      // second or two to start.
      for (let attempt = 0; attempt < 40; attempt++) {
        const status = await evaluate<string>(
          `(() => { const panel = document.querySelector('[data-testid="terminal-panel"]'); return panel ? (panel.getAttribute('data-terminal-status') || '') : ''; })()`
        );
        if (status === 'ready') {
          terminalReady = true;
          break;
        }
        if (status === 'exited') break;
        await wait(250);
      }

      probe.terminalReady = terminalReady;
      if (!terminalReady) problems.push('Terminal: the shell never reached the ready state');
    }

    if (terminalMounted.present === true && terminalReady) {
      // Run a real command in the real shell and read its output back. The
      // keystrokes go where a user's would: into the emulator's own input
      // element, and from there down the pty.
      const marker = `eukolia-terminal-${process.pid}`;
      const focused = await evaluate<boolean>(`(() => {
        const input = document.querySelector('.xterm-helper-textarea');
        if (input) input.focus();
        return !!input;
      })()`);
      if (!focused) problems.push('Terminal: the emulator exposes no input element to type into');
      await wait(300);
      for (const character of `echo ${marker}`) {
        await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: character });
        await window.webContents.sendInputEvent({ type: 'char', keyCode: character });
        await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: character });
        await wait(40);
      }
      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      await window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

      let echoed = false;
      let screenText = '';
      for (let attempt = 0; attempt < 30; attempt++) {
        await wait(400);
        // The rendered screen, not a data model: if the emulator drew the answer,
        // the pty, the escape-stream forwarding and the emulator all work.
        //
        // Read from `.xterm-rows` rather than the panel's whole subtree: xterm
        // injects its own stylesheet *inside* the terminal element, and a
        // `textContent` of the container picks up the rules as well as the text.
        // Matching a marker against injected CSS would pass without a terminal
        // ever drawing anything.
        screenText = await evaluate<string>(`(() => {
          const rows = document.querySelectorAll('.xterm-rows > div');
          return Array.from(rows).map((row) => row.textContent || '').join('\\n');
        })()`);
        if (screenText.includes(marker)) {
          echoed = true;
          break;
        }
      }

      probe.terminal = { present: true, marker, echoed };
      if (!echoed) {
        problems.push(`Terminal: running \`echo ${marker}\` produced no output`);
      }

      // --- the emulator, not just the stream ---
      //
      // A terminal is not a text view, and "it echoed my command" does not prove
      // one. What separates the two is whether escape sequences survive the whole
      // trip: a script prints a line in green and sets the window title, and the
      // *rendered* markup is then inspected for the colour and the panel's header
      // for the title. A log view that strips or ignores escapes fails both, which
      // is exactly the regression this pins down.
      //
      // The command is run from a file because it is typed through the keyboard:
      // sending `$`, `[`, quotes and `;` as individual key events would test the
      // probe's typing far more than the emulator, and a shell that is not
      // PowerShell would answer none of it.
      const colourLine = `rendered-${process.pid}`;
      const probeTitle = `eukolia terminal probe ${process.pid}`;
      const probeScript = path.join(workspace, 'eukolia-terminal-probe.ps1');
      fs.writeFileSync(
        probeScript,
        [
          `# Written by the Eukolia smoke probe; deleted with the run.`,
          `Write-Host "$([char]27)[32m${colourLine}$([char]27)[0m"`,
          `$host.UI.RawUI.WindowTitle = '${probeTitle}'`
        ].join('\r\n') + '\r\n',
        'utf8'
      );

      const runProbe = `& '${probeScript}'`;
      for (const character of runProbe) {
        await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: character });
        await window.webContents.sendInputEvent({ type: 'char', keyCode: character });
        await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: character });
        await wait(30);
      }
      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      await window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

      let rendering: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 25; attempt++) {
        await wait(400);
        rendering = await evaluate<Record<string, unknown>>(`(() => {
          const rows = Array.from(document.querySelectorAll('.xterm-rows > div'));
          const line = rows.find((row) => (row.textContent || '').includes(${JSON.stringify(colourLine)}));
          const spans = line ? Array.from(line.querySelectorAll('span')) : [];
          const painted = spans.filter((span) => {
            const colour = getComputedStyle(span).color || '';
            const match = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(colour);
            // "Painted" means not one of the greys an unstyled terminal uses:
            // xterm leaves the default foreground in place for plain text.
            if (!match) return false;
            const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
            const spread = Math.max(r, g, b) - Math.min(r, g, b);
            return spread > 24 && g > r && g > b;
          });
          return {
            emulatorRows: rows.length,
            // The scrollable height xterm reports, i.e. the emulator really has a
            // viewport with history behind it rather than being a plain list.
            scrollback: (document.querySelector('.xterm-scrollable-element') || {}).scrollHeight || 0,
            // The cursor is a real element xterm draws, not a caret in a text box.
            cursor: !!document.querySelector('.xterm-cursor'),
            // What the shell set through OSC reached the panel's own header: the
            // title is carried on the session name's tooltip.
            panelTitle: !!Array.from(document.querySelectorAll('[data-testid="terminal-panel"] [title]')).find(
              (node) => (node.getAttribute('title') || '').includes('eukolia terminal probe')
            ),
            colouredSpans: painted.length,
            // The last few drawn lines, so the screen's content is reviewable in
            // the report without opening the PNG.
            screenTail: rows.slice(-4).map((row) => row.textContent || '').join('\\n')
          };
        })()`);
        if (rendering.colouredSpans) break;
      }

      probe.terminalRendering = rendering;
      if (!rendering.colouredSpans) {
        problems.push('Terminal: an ANSI-coloured line was not rendered in colour');
      }
      if (!rendering.panelTitle) {
        problems.push('Terminal: the window title the shell set did not reach the panel');
      }

      // A PNG of the panel, so its appearance can be reviewed rather than
      // inferred from span counts.
      await capture('terminal');

      command('view.toggleTerminal');
      await wait(600);
      const hidden = await evaluate<Record<string, unknown>>(
        `(() => ({ present: !!document.querySelector('[data-testid="terminal-panel"]') }))()`
      );
      if (hidden.present !== false) {
        problems.push('Terminal: toggling it off did not hide the panel');
      }
    }

    // ---------------------------------------------------------- 9. one editor, two modes
    await step('9 one editor, two modes');
    //
    // The user's requirement, measured rather than assumed: Code Mode and Visual
    // Mode must be one editor with one line index bar and one scrollbar, and
    // switching between them must keep the caret and the scroll position.
    //
    // This is the only check that can falsify that end to end. The node tests
    // prove the handle and the mode snapshot in isolation, but jsdom has no
    // layout, so "the scroll position survived" is observable only in a real
    // window. The caret is read back from the status bar — the application's own
    // readout, so it is the evidence a user would see — and the scroll from the
    // editor's own scroller.
    {
      const editorShape = () =>
        evaluate<Record<string, unknown>>(`(() => {
          ${EDITOR_DOM}
          const scrollers = document.querySelectorAll('.cm-scroller');
          const only = scrollers.length === 1 ? scrollers[0] : null;
          const content = document.querySelector('.cm-content');
          // The source line at the top of the viewport, read through the live
          // view the editor publishes. This is the instrument that actually
          // works: reading the gutter's first rendered entry was unreliable in
          // Visual Mode (the ported decorations collapse runs of source lines,
          // so it once reported line 99 at scrollTop 0), and comparing pixel
          // offsets is invalid because the two modes lay the same source out at
          // different heights. This asks CodeMirror the same question the
          // application asks itself when it records the position.
          //
          // Guarded, because a probe must not abort a whole run over a
          // diagnostic read. A mode switch destroys and recreates the view, so
          // between the two the published reference can point at a dead view
          // whose geometry is gone; the connectivity check is how that is
          // detected, and the try/catch keeps a throw from reaching the page's
          // error handler, where it would be indistinguishable from an
          // application error.
          let topSourceLine = -1;
          try {
            const live = window.__cmView;
            if (live && live.dom && live.dom.isConnected) {
              // The height lookup answers with a BlockInfo, not an offset, so
              // the line query needs the block's own offset. Passing the block
              // itself makes the bounds check false rather than throwing, and
              // the text walk then reads a property of undefined.
              const block = live.lineBlockAtHeight(live.scrollDOM.scrollTop);
              topSourceLine = live.state.doc.lineAt(block.from).number;
            }
          } catch (error) {
            topSourceLine = -1;
          }
          return {
            engine,
            codeMirrorEditors: document.querySelectorAll('.cm-editor').length,
            monacoEditors: document.querySelectorAll('.monaco-editor').length,
            gutters: document.querySelectorAll('.cm-gutters').length,
            scrollers: scrollers.length,
            scrollTop: only ? Math.round(only.scrollTop) : -1,
            scrollRange: only ? Math.round(only.scrollHeight - only.clientHeight) : -1,
            topSourceLine,
            // Whether this is still the view the run started with. One editor in
            // the DOM is not the same claim as one editor instance: a rebuild
            // leaves exactly one element behind too, and only this distinguishes
            // "the mode was reconfigured" from "the editor was thrown away and
            // rebuilt", which is the difference the whole design rests on.
            viewSame: window.__probeView0 ? window.__cmView === window.__probeView0 : false,
            // Visual Mode paints the ported Overleaf widgets; Code Mode paints
            // none of them. That is how this tells the two modes apart.
            visualWidgets: document.querySelectorAll('[class*="ol-cm-"]').length,
            caret: (window.__cmView ? ('Ln ' + window.__cmView.state.doc.lineAt(window.__cmView.state.selection.main.head).number + ', Col ' + (window.__cmView.state.selection.main.head - window.__cmView.state.doc.lineAt(window.__cmView.state.selection.main.head).from + 1)) : (document.body.innerText.match(/Ln \\d+, Col \\d+/) || [''])[0])
          };
        })()`);

      // Put the caret somewhere distinctive first: the end of the document.
      // Ctrl+End is the document-end motion in CodeMirror and Monaco alike, and
      // it scrolls, so the assertions below cannot be satisfied trivially by a
      // document shorter than the viewport or by a caret that never moved.
      await evaluate(`(() => {
        ${EDITOR_DOM}
        return focusEditor();
      })()`);
      await wait(500);
      // The caret is placed through CodeMirror rather than with Ctrl+End. Two
      // reasons, both learned the hard way: Ctrl+End leaves the editor's cached
      // "scrolled to bottom" flag set, and — as the run that removed it proved —
      // it is the caret's position that decides whether the top line survives a
      // switch at all. A run with the caret at line 1 kept the top line (10 -> 9
      // -> 9); every run with the caret mid-document moved it to the caret's own
      // line (10 -> 16). So the caret is set deliberately, to the same place
      // every time, and the guard below still refuses to pass if it did not move.
      const placed = await evaluate<boolean>(`(() => {
        const view = window.__cmView;
        if (!view) return false;
        const target = view.state.doc.line(Math.min(16, view.state.doc.lines));
        view.dispatch({ selection: { anchor: target.from } });
        return true;
      })()`);
      await wait(500);
      const scrolled = await evaluate<boolean>(`(() => {
        const view = window.__cmView;
        if (!view) return false;
        const range = view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight;
        view.scrollDOM.scrollTop = Math.round(range * 0.6);
        return true;
      })()`);
      await wait(700);

      // Remember the editor instance the run is about to switch modes on, so the
      // later reads can prove it is the same one.
      await evaluate(`(() => {
        window.__probeView0 = window.__cmView ?? null;
        return !!window.__probeView0;
      })()`);

      const inCode = await editorShape();

      // Trace every write to the scroller across the switch, with a stack, so
      // the mover is named rather than inferred. The mode command is issued from
      // this process, so the trace is installed first and read afterwards — the
      // stack is what matters, not the timing.
      await evaluate(`(() => {
        const view = window.__cmView;
        if (!view) return false;
        window.__probeWrites = [];
        const proto = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
        if (!proto) return false;
        Object.defineProperty(view.scrollDOM, 'scrollTop', {
          configurable: true,
          get() { return proto.get.call(this); },
          set(value) {
            window.__probeWrites.push({
              value: Math.round(value),
              stack: String(new Error().stack || '').split('\\n').slice(1, 8).join(' <- ')
            });
            proto.set.call(this, value);
          }
        });
        return true;
      })()`);

      command('editor.visualMode');
      await wait(2600);
      const inVisual = await editorShape();
      const toVisual = await evaluate<Record<string, unknown>>(`(() => ({
        writes: window.__probeWrites || []
      }))()`);

      await evaluate(`(() => { window.__probeWrites = []; return true; })()`);
      command('editor.codeMode');
      await wait(2600);
      const backInCode = await editorShape();
      const toCode = await evaluate<Record<string, unknown>>(`(() => ({
        writes: window.__probeWrites || []
      }))()`);

      probe.modeSwitch = { inCode, inVisual, backInCode };
      probe.modeSwitchWrites = { toVisual: toVisual.writes, toCode: toCode.writes };

      /** The recorded shape, read back with types rather than through `unknown`. */
      const shape = (value: Record<string, unknown>) => ({
        caret: String(value.caret ?? ''),
        scrollTop: Number(value.scrollTop ?? -1),
        topSourceLine: Number(value.topSourceLine ?? -1),
        viewSame: value.viewSame === true,
        visualWidgets: Number(value.visualWidgets ?? -1),
        editors: Number(value.codeMirrorEditors ?? -1),
        monaco: Number(value.monacoEditors ?? -1),
        gutters: Number(value.gutters ?? -1),
        scrollers: Number(value.scrollers ?? -1)
      });
      const code = shape(inCode);
      const visual = shape(inVisual);
      const back = shape(backInCode);

      // One editor, one gutter, one scrollbar. A second editor, or a leftover
      // Monaco, is the exact defect this work existed to remove.
      if (code.editors !== 1) {
        problems.push(`One editor: expected exactly 1 CodeMirror editor, found ${code.editors}`);
      }
      if (code.monaco !== 0) {
        problems.push(`One editor: a Monaco editor is still mounted (${code.monaco})`);
      }
      if (code.gutters !== 1 || code.scrollers !== 1) {
        problems.push(`One editor: expected 1 gutter and 1 scroller, found ${code.gutters} and ${code.scrollers}`);
      }

      // The setup has to be meaningful before preservation means anything.
      if (!/Ln \d+, Col \d+/.test(code.caret) || code.caret === 'Ln 1, Col 1') {
        problems.push(`Mode switch: the caret was not moved before switching (${JSON.stringify(code.caret)}), so preservation proves nothing`);
      }
      if (!scrolled || code.scrollTop <= 0) {
        problems.push(
          `Mode switch: the viewport was not scrolled before switching (scrollTop ${code.scrollTop}), so the scroll half of this check proves nothing`
        );
      }
      // `ol-cm-` classes are emitted by ported widgets in both modes and their
      // count is not a stable mode indicator: measured 7 and 76 for the same
      // Code Mode state across two runs, depending on which decorations the
      // parse had painted by then. Recorded as evidence, not asserted on — an
      // unstable check manufactures failures instead of finding them.

      // The source line at the top of the viewport is the position that has to
      // survive. `scrollTop` is recorded but not asserted on: with the top line
      // preserved, the pixel offset is that line's offset in each mode's own
      // metrics, and those legitimately differ by hundreds of pixels on a long
      // document. One line of tolerance covers a collapsed widget at the
      // boundary, which can shift the reported line by one.
      if (code.topSourceLine < 1) {
        problems.push('Mode switch: the top source line could not be read from the live view, so preservation was not measured');
      }
      for (const [label, stage] of [
        ['Visual Mode', visual],
        ['Code Mode', back]
      ] as const) {
        if (!stage.viewSame) {
          problems.push(`Mode switch: switching to ${label} replaced the editor instance, so the mode is not being reconfigured on the live view`);
        }
        if (stage.caret !== code.caret) {
          problems.push(`Mode switch: the caret moved when switching to ${label} (${code.caret} -> ${stage.caret || 'none'})`);
        }
        if (stage.topSourceLine > 0 && Math.abs(stage.topSourceLine - code.topSourceLine) > 1) {
          problems.push(
            `Mode switch: the top source line moved when switching to ${label} (${code.topSourceLine} -> ${stage.topSourceLine}, scrollTop ${code.scrollTop} -> ${stage.scrollTop})`
          );
        }
      }
    }

    finish('probe');
  } catch (error) {
    problems.push(error instanceof Error ? error.stack ?? error.message : String(error));
    finish('exception');
  }
}






