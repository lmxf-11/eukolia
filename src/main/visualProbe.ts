/**
 * Measurement-only probe for the visual-editor defects that survive isolation.
 *
 * It boots the real application against the real workspace, switches to Visual
 * Mode through the command registry exactly as `smoke.ts` does, and reports what
 * the live editor actually contains. Answers are read from the DOM, from the
 * CodeMirror view and from the DevTools protocol, never inferred.
 *
 * It exists because every one of these questions was answered wrongly at least
 * once by a passing isolated test. jsdom performs no layout and no cascade, so it
 * cannot say which face painted a glyph, where a caret landed after an
 * asynchronous widget render, or what the mathematics produced. The questions
 * here are about measured appearance, and appearance exists only here.
 *
 * What it reports, and why each one cannot be answered anywhere else:
 *
 *  1. **The preamble.** Every line of it must be in the code face at the code
 *     size. `getComputedStyle` reports the size reliably (the rule states a
 *     variable that resolves to a pixel value) even though it reports the
 *     font's *name* unreliably.
 *  2. **The icon glyphs.** `material-symbols` spans draw ligature names; a
 *     missing font paints the words "expand" and "help" instead, and the glyph
 *     box is the only thing that distinguishes the two.
 *  3. **The mathematics.** What `\begin{definition}` produced with a
 *     `\newtheorem` declaration in the document, what `tikzcd` produced, and
 *     whether anything came back as an error.
 *  4. **The platform font.** `CSS.getPlatformFontsForNode` is the only
 *     instrument that names the face which *painted* a node — every DOM API
 *     reports the face that was asked for, including when it is not installed.
 *     Two traps are recorded where they are handled below: the `DOM` and `CSS`
 *     agents must be enabled first, and node ids have to be resolved from a live
 *     object handle rather than from an attribute selector.
 *  5. **The two modes' sizes**, read from one live editor with the mode flipped
 *     between the two readings, which is the only way to catch a size that
 *     differs by a factor rather than by a value.
 *  6. **Pictures.** A full window and one clipped capture per measured row, since
 *     a substituted diacritic is visible to the eye and to nothing else.
 *  7. **Where a click lands**, by dispatching a real mouse press and release
 *     through the protocol. A synthesised DOM event would not go through the
 *     browser's own hit-testing, which is the thing under test.
 *  8. **What each shortcut does**, by pressing the key for real. `Ctrl+B` is bound
 *     both by the shell's command registry and by the editor's own keymap, so
 *     reading either table alone answers the wrong question.
 *
 * Run with `EUKOLIA_CARET_PROBE=1` (see `scripts/probe-visual.mjs`).
 */
import { app, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { IPC } from '../shared/ipc'

/** The document the reports are about, written into the fixture workspace. */
const FIXTURE = String.raw`\documentclass{article}\usepackage{graphicx}
\usepackage{enumitem, makeidx}
\usepackage{geometry}
\usepackage{bm}
\usepackage[utf8]{vietnam}
\usepackage{tikz-cd}
\usepackage{amsthm}

\geometry{margin=1in}
\setlength{\parindent}{0pt}
\input{macros}

\title{Tôpô compact-mở}
\date{\today}

\newcommand{\R}{\mathbb{R}}
\newcommand{\half}{\tfrac{1}{2}}
\newtheorem{theorem}{Theorem}
\newtheorem{definition}[theorem]{Definition}

\begin{document}

Vietnamese prose, in the document face: Tôpô compact-mở, Đặng Thị Hồng,
nghiêng, ươ ứ ợ ẫ ệ.

\begin{definition}
A group is a set $G$ with multiplication $G \times G \to G$.
\end{definition}

Parenthesised mathematics: \(a + b\), and bracketed: \[c + d\].

\begin{proof}
Indeed $x = y$.\qedhere
\end{proof}

\begin{tikzcd}
A \arrow[r] \arrow[d] & B \arrow[d] \\
C \arrow[r]           & D
\end{tikzcd}

\begin{figure}
\centering
\includegraphics{plot.pdf}
\caption{A figure whose edges are hidden.}
\end{figure}

\begin{verbatim}
raw $source$ here
\end{verbatim}

\end{document}
`

interface Named<T> {
  [key: string]: T
}

/**
 * Globals the editor bundle publishes for this probe.
 *
 * Declared because the probe's script strings are evaluated in the page: the
 * editor bundle is a separate build from this one, so there is no import to type
 * through.
 */
declare global {
  interface Window {
    __cmView?: unknown
  }
}

/** Speaks one DevTools protocol command to the window's page target. */
async function cdp(
  window: BrowserWindow,
  method: string,
  params: Record<string, unknown> = {}
): Promise<any> {
  return window.webContents.debugger.sendCommand(method, params)
}

/**
 * Probe switches that must exist in the page **before the renderer evaluates its modules**.
 *
 * A switch read at module scope or plugin construction — the decoration pass's widget switch, for
 * instance — cannot be set by an injected script, because the injected script runs long after the
 * editor exists. An A/B that tries is a comparison of two identical configurations, which is exactly
 * what §3.40 measured before the mistake was found: the switch was on, the behaviour was unchanged,
 * and two identical timings looked like a result.
 *
 * The main process has the environment before the window loads, so it is the only place that can
 * publish a value early enough. `did-start-loading` fires before the document's own scripts run, and
 * the assignment is one line, so it is in place by the time the bundle evaluates. Failures are
 * ignored: a probe must not be taken down by a global it could not publish, and the switch simply
 * stays at its shipped value.
 *
 * Only probes set these variables. The application never does.
 */
const PAGE_GLOBALS: Array<[string, string]> = [['__eukoliaNoWidgets', 'EUKOLIA_NO_WIDGETS']]

export function publishPageGlobals(window: BrowserWindow): void {
  const assignments = PAGE_GLOBALS.filter(([, from]) => process.env[from] !== undefined).map(
    ([name, from]) => {
      const raw = process.env[from] as string
      const value =
        raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : JSON.stringify(raw)
      return `window.${name} = ${value};`
    }
  )
  if (assignments.length === 0) return
  window.webContents.on('did-start-loading', () => {
    window.webContents.executeJavaScript(assignments.join('\n')).catch(() => {})
  })
}

export async function runVisualProbe(window: BrowserWindow): Promise<void> {
  const report: Named<unknown> = {}

  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  /*
   * Where the probe has got to, written to disk as it goes.
   *
   * The probe kills itself on a timeout, and when it does there is no report at
   * all — so a stall is indistinguishable from a slow run. This appends one line
   * per stage to `.scratch/probe-progress.log`, and the last line of that file is
   * the stage that did not finish. It costs one `fs.appendFileSync` per stage.
   */
  const startedAt = Date.now()
  const progress = (stage: string, note = '') => {
    try {
      fs.appendFileSync(
        path.join(process.cwd(), '.scratch', 'probe-progress.log'),
        `${String(Date.now() - startedAt).padStart(7)}ms  ${stage}${note ? '  ' + note : ''}\n`,
        'utf8'
      )
    } catch {
      /* a progress log is never worth failing the probe over */
    }
  }
  progress('--- probe start ---')

  /*
   * `evaluate` names its own stage, so every script the probe runs is logged
   * without the call sites having to say so. The name is read back off the
   * assignment on the line above the call.
   */
  let evaluateStage = 'evaluate'
  /*
   * Bounded on purpose. A renderer wedged inside its own typesetting never answers
   * `executeJavaScript` at all, and an unbounded await there turns a diagnosable
   * hang into a probe that writes no report and says nothing. The timeout resolves
   * to `null`, which is why the return type stays `Promise<T>` — the callers that
   * can receive it compare against `null` explicitly rather than trusting it.
   *
   * `EUKOLIA_PROBE_EVALUATE_MS` raises it for the scripts that are *measurements*
   * rather than questions — the smoothness phase drives dozens of wheel gestures and
   * takes minutes by design, and at 30 s it was cut off mid-run and reported
   * `smoothness: null`, which reads exactly like a renderer that had wedged. A
   * phase that measures time needs a budget that is not smaller than the time it
   * means to measure.
   */
  const evaluateMs = Number(process.env.EUKOLIA_PROBE_EVALUATE_MS) > 0
    ? Number(process.env.EUKOLIA_PROBE_EVALUATE_MS)
    : 30_000
  const evaluate = <T>(script: string): Promise<T> => {
    progress(evaluateStage + ' …')
    return Promise.race<T | null>([
      window.webContents.executeJavaScript(script) as Promise<T | null>,
      wait(evaluateMs).then(() => {
        progress(
          evaluateStage,
          `TIMED OUT after ${Math.round(evaluateMs / 1000)}s — the renderer did not answer`
        )
        return null
      }),
    ]).then(
      value => {
        progress(evaluateStage, value === null ? 'no answer' : 'ok')
        return value as T
      },
      error => {
        progress(evaluateStage, 'FAILED ' + String(error).slice(0, 200))
        throw error
      }
    )
  }

  try {
    /*
     * Console and page errors from the *start* of the run, not the end.
     *
     * The report already collects the console, but it does so last — so a renderer
     * that never mounts reports `visualEditorMounted: false` and nothing else, and
     * the error that explains it has already gone. This listener is installed
     * before anything is opened, so the first thing a failing renderer says is
     * kept.
     */
    const earlyErrors: string[] = []
    window.webContents.on('console-message', (_event, level, message, line, source) => {
      if (level >= 2) earlyErrors.push(`${message} (${source}:${line})`)
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      earlyErrors.push(`render process gone: ${JSON.stringify(details)}`)
    })
    window.webContents.on('did-fail-load', (_event, code, description, url) => {
      earlyErrors.push(`did-fail-load ${code} ${description} ${url}`)
    })

    await wait(7000)

    // Write the document into the workspace the app opened, then open it. The
    // workspace itself is already open (`EUKOLIA_SMOKE_WORKSPACE`), and opening a
    // file is a protocol message — the same one `smoke.ts` uses.
    //
    // `EUKOLIA_PROBE_DOCUMENT` opens a *real* project instead: the fixture is a
    // page written to exercise constructs one at a time, and a report about
    // scrolling on a real paper needs a real paper — dense mathematics, macros in
    // an `\input`, several hundred lines. The document is opened and never written
    // to, so pointing this at somebody's work cannot modify it.
    const workspace = process.env.EUKOLIA_SMOKE_WORKSPACE
    report.workspace = workspace ?? null
    const documentOverride = process.env.EUKOLIA_PROBE_DOCUMENT
    if (workspace) {
      const file = documentOverride ?? path.join(workspace, 'report.tex')
      if (documentOverride) {
        report.openedRealDocument = file
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, FIXTURE, 'utf8')
        const macros = path.join(workspace, 'macros.tex')
        if (!fs.existsSync(macros)) {
          fs.writeFileSync(macros, '\\newcommand{\\R}{\\mathbb{R}}\n', 'utf8')
        }
      }
      report.wrote = file

      window.webContents.send(IPC.protocol.openProject, workspace)
      await wait(1200)
      window.webContents.send(IPC.protocol.openFile, { kind: 'open', path: file })
      await wait(3000)
    }

    // Visual Mode, through the same command channel the menu bar uses.
    window.webContents.send('menu:command', 'editor.visualMode')
    await wait(3500)

    /*
     * A scripted run may ask for the other surface first.
     *
     * `editor.codeMode` is a **setter**, which is what the first version of this got
     * wrong: it sent `editor.visualMode` and asked for Visual Mode a second time, so
     * every "source mode" measurement in this repository was silently a measurement of
     * Visual Mode. Nothing failed — the surface attribute simply still said `visual`, and
     * the probe reported the number it had been given rather than the one it asked for.
     * The assertion below is the guard: a mode switch that did not happen stops the run
     * instead of producing a comparison of a mode with itself.
     */
    if (process.env.EUKOLIA_PROFILE_SWITCH_MODE === 'source') {
      window.webContents.send('menu:command', 'editor.codeMode')
      await wait(2500)
      const mode = await evaluate<string>(
        `document.querySelector('.eukolia-visual-editor [data-mode], .cm-editor[data-mode]')?.getAttribute('data-mode') ?? 'unknown'`
      )
      if (mode !== 'source') {
        report.modeSwitchFailure = `asked for source mode, the editor reports "${mode}"`
        progress('mode', `FAILED: asked for source, editor is "${mode}"`)
      } else {
        progress('mode', 'source')
      }
    }

    /*
     * A single scripted measurement, in place of every phase below.
     *
     * `scripts/probe-raster.mjs` supplies a script that drives the live editor and
     * returns numbers; this runs it and prints them under a marker of its own. It
     * exists because the smoothness phase's own experiment is *one* script inside a
     * long report, measured once each, and an interleaved comparison of six
     * configurations needs many alternating cycles and per-gesture counters to be
     * readable at all. The first version of that experiment was confounded by the
     * ordering and said so in its own data; this is the instrument that replaced it.
     *
     * A script may carry a **profile boundary** — `__EUKOLIA_PROFILE_START__` on a line
     * of its own — and then V8's sampler is turned on between the two halves and the
     * result written to `EUKOLIA_VISUAL_CPU_PROFILE_PATH`. `scripts/probe-typing-profile.mjs`
     * uses that to profile exactly the typing loop: everything before the marker warms
     * the editor, everything after it is the window the profile describes. Without the
     * boundary a profile of "the probe" is a profile of thirty unrelated phases.
     */
    const scripted = process.env.EUKOLIA_RASTER_SCRIPT
    if (scripted) {
      /*
       * The injected script's own failures, reported as the script's.
       *
       * `executeJavaScript` answers "Script failed to execute, this normally means an
       * error was thrown. Check the renderer console for the error." — which names
       * neither the error nor the line, and is what a one-character mistake in a
       * two-hundred-line injected measurement produces. Wrapping the text puts the
       * message, the stack and the line count in the report, so a probe that fails
       * says why on the first run instead of the third.
       */
      const wrapped = (text: string) =>
        `(async () => {
  try {
    return { __eukoliaProbeOk: true, value: await (async () => { ${text} })() };
  } catch (error) {
    return {
      __eukoliaProbeOk: false,
      error: String(error && error.message ? error.message : error),
      stack: String(error && error.stack ? error.stack : '').split('\\n').slice(0, 6),
    };
  }
})()`
      const unwrap = <T>(answer: unknown): T => {
        const wrappedAnswer = answer as
          | { __eukoliaProbeOk?: boolean; value?: T; error?: string; stack?: string[] }
          | null
        if (wrappedAnswer && wrappedAnswer.__eukoliaProbeOk === false) {
          throw new Error(
            `${wrappedAnswer.error}\n  ${(wrappedAnswer.stack ?? []).join('\n  ')}`
          )
        }
        return (wrappedAnswer && 'value' in wrappedAnswer
          ? wrappedAnswer.value
          : wrappedAnswer) as T
      }
      const boundary = '__EUKOLIA_PROFILE_START__'
      const at = scripted.indexOf(boundary)
      const profilePath = process.env.EUKOLIA_VISUAL_CPU_PROFILE_PATH
      let result: unknown
      if (at >= 0 && profilePath) {
        /*
         * The sampler runs between two `evaluate` calls, and **the two halves are
         * separate programs**.
         *
         * That is a real constraint on any script that asks to be profiled: the second
         * half cannot call a function the first half declared, because each
         * `executeJavaScript` is its own scope and the second answers `… is not defined`.
         * An earlier version of this tried to keep one scope by embedding both halves in
         * a single wrapper and starting the sampler from inside the page — which
         * deadlocks, because the renderer then waits for a message that the main process
         * cannot send while it is awaiting the renderer.
         *
         * So a profiled script has to be written as two self-contained programs. Both
         * callers of this today do.
         */
        result = unwrap(await evaluate<unknown>(wrapped(scripted.slice(0, at))))
        /*
         * The protocol is only reachable once the debugger is attached, and the
         * phases that use it attach it themselves — `Profiler.enable` without an
         * attachment answers "No target available", which is what the first run of
         * this did. Detached again afterwards so a later phase's own `attach` cannot
         * find it already held.
         */
        try {
          if (!window.webContents.debugger.isAttached()) {
            window.webContents.debugger.attach('1.3')
          }
          await cdp(window, 'Profiler.enable')
          await cdp(window, 'Profiler.setSamplingInterval', { interval: 100 })
          await cdp(window, 'Profiler.start')
          result = unwrap(
            await evaluate<unknown>(wrapped(scripted.slice(at + boundary.length)))
          )
          const { profile } = (await cdp(window, 'Profiler.stop')) as {
            profile: unknown
          }
          try {
            fs.mkdirSync(path.dirname(profilePath), { recursive: true })
            fs.writeFileSync(profilePath, JSON.stringify(profile))
            progress('profile', `wrote ${profilePath}`)
          } catch (error) {
            progress('profile', `could not write ${profilePath}: ${String(error)}`)
          }
        } catch (error) {
          /*
           * A profile that cannot be taken must not cost the measurement: the script
           * is a measurement first and a profile window second, so the second half is
           * run (or re-run) with no sampler rather than reported as a failure.
           */
          progress('profile', `FAILED ${String(error).slice(0, 160)}`)
          if (result === undefined) {
            result = unwrap(
              await evaluate<unknown>(wrapped(scripted.slice(at + boundary.length)))
            )
          }
        } finally {
          if (window.webContents.debugger.isAttached()) {
            window.webContents.debugger.detach()
          }
        }
      } else if (process.env.EUKOLIA_VISUAL_TRACE_PATH) {
        /*
         * A real trace, and it is the only way to see paint.
         *
         * `long-animation-frame` says how much of a frame was script, style-and-layout
         * and blocking, and "blocking" is the remainder — paint, composite, and whatever
         * the compositor does off the main thread. On `algebra.tex` that remainder is
         * ~130 ms of a 170 ms frame, and no amount of wrapping JavaScript attributes it.
         * The trace's `Paint`/`Layout`/`UpdateLayerTree`/`CompositeLayers` events carry
         * the element counts and the timings that say which of them it is.
         *
         * An *alternative* to the profile rather than an addition to it: the two both use
         * the debugger, and a trace taken while V8 is sampling is a trace of the sampler.
         */
        const tracePath = process.env.EUKOLIA_VISUAL_TRACE_PATH as string
        try {
          if (!window.webContents.debugger.isAttached()) {
            window.webContents.debugger.attach('1.3')
          }
          const chunks: string[] = []
          /*
           * Every protocol event is counted while tracing, not just the ones the code
           * below expects.
           *
           * The empty trace gave no diagnosis at all: `Tracing.start` succeeded, the
           * gestures ran, `Tracing.end` succeeded, and nothing arrived — and a handler
           * that filters for one method name cannot tell "no events were emitted" from
           * "events arrive under a name I did not expect" from "the handler is never
           * called at all". This counts them.
           */
          const seen: Record<string, number> = {}
          const onData = (
            _event: unknown,
            method: string,
            params: unknown,
            data?: string
          ): void => {
            seen[method] = (seen[method] ?? 0) + 1
            if (method === 'Tracing.dataCollected') {
              /*
               * Electron's `message` event is `(event, method, params, ...rest)`, and for
               * `Tracing.dataCollected` the payload is `params.value` — an array of trace
               * events, not a JSON string. The first version looked for a string in the
               * fourth argument and in `params.value`, found neither, and pushed nothing
               * while the event fired 215 times: the listener was right and the reader of
               * its arguments was not.
               */
              const paramsValue = (params as { value?: unknown })?.value
              if (Array.isArray(paramsValue)) {
                for (const entry of paramsValue) chunks.push(JSON.stringify(entry))
              } else if (typeof paramsValue === 'string' && paramsValue) {
                chunks.push(paramsValue)
              } else if (typeof data === 'string' && data) {
                chunks.push(data)
              }
            }
          }
          window.webContents.debugger.on('message', onData)
          await cdp(window, 'Tracing.start', {
            /*
             * The `devtools.timeline` categories carry the frame, layout and paint
             * events; the `disabled-by-default-*` ones carry the detail — which paint
             * invalidation, which element count — and are off by default because they are
             * expensive to collect.
             */
            categories: [
              'devtools.timeline',
              'disabled-by-default-devtools.timeline',
              'disabled-by-default-devtools.timeline.frame',
              'blink.user_timing',
            ].join(','),
            /*
             * `ReportEvents`, not `ReturnAsStream`.
             *
             * A streamed trace is delivered through `IO.read` on the *stream* handle that
             * `Tracing.tracingComplete` carries — not through `Tracing.dataCollected`,
             * which the first version of this listened for. So the chunks array stayed
             * empty and the file it wrote was the two characters `[]`, with no error
             * anywhere: a trace of nothing is a valid trace. `ReportEvents` puts every
             * event on `Tracing.dataCollected` as it happens, which is what the listener
             * below collects.
             */
            transferMode: 'ReportEvents',
          })
          progress('trace', 'recording')
          result = unwrap(await evaluate<unknown>(wrapped(scripted)))
          await cdp(window, 'Tracing.end')
          /*
           * Three seconds for the remaining buffers, not an unbounded wait.
           *
           * `tracingComplete` is the correct signal and it arrives for both transfer
           * modes — but a listener registered *before* the work, as this one used to be,
           * is not the same as one that is still listening when the main process is busy
           * pumping `Tracing.dataCollected` for a megabyte of events. A bounded settle
           * gets the same events with a guaranteed end, which matters more here than the
           * last few milliseconds of trace: a probe that hangs produces no measurement.
           */
          await Promise.race([
            new Promise<void>(resolve => {
              const onEnd = (_event: unknown, method: string): void => {
                if (method === 'Tracing.tracingComplete') resolve()
              }
              window.webContents.debugger.once('message', onEnd)
            }),
            wait(3000),
          ])
          window.webContents.debugger.removeListener('message', onData)
          fs.mkdirSync(path.dirname(tracePath), { recursive: true })
          fs.writeFileSync(tracePath, `[${chunks.join(',')}]`)
          const methods = Object.entries(seen)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([name, count]) => `${name}×${count}`)
            .join(', ')
          progress(
            'trace',
            `wrote ${tracePath} (${chunks.length} chunks) — protocol events seen: ${methods || 'none'}`
          )
        } catch (error) {
          progress('trace', `FAILED ${String(error).slice(0, 200)}`)
        } finally {
          if (window.webContents.debugger.isAttached()) {
            window.webContents.debugger.detach()
          }
        }
      } else {
        result = unwrap(await evaluate<unknown>(wrapped(scripted)))
      }
      /*
       * What the compositor is actually doing, reported beside every scripted
       * measurement.
       *
       * A scroll measurement is a measurement of the compositor, and every frame-time
       * reading in this repository was taken without ever asking whether hardware
       * acceleration was on. If it is not — a driver blocklist, a software-GL fallback, a
       * VM without a GPU — then "paint is 82 % of the gesture" is a fact about the
       * fallback rasteriser and not about the application, and no CSS change would show
       * it. The three answers that separate those cases are the feature status, the
       * active GPU, and whether the renderer reports a compositing layer at all.
       */
      let gpu: Record<string, unknown> = {}
      try {
        const rendererGpu = await evaluate<Record<string, unknown>>(`(() => {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
          return {
            webgl: Boolean(gl),
            vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
            renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
            devicePixelRatio: window.devicePixelRatio,
          };
        })()`)
        gpu = {
          // Present at runtime, absent from this Electron's typings.
          hardwareAcceleration: (app as unknown as { isHardwareAccelerationEnabled?: () => boolean })
            .isHardwareAccelerationEnabled?.() ?? null,
          featureStatus: app.getGPUFeatureStatus(),
          gpuInfo: app.getGPUInfo('basic'),
          renderer: rendererGpu,
        }
      } catch (error) {
        gpu = { error: String(error).slice(0, 300) }
      }
      progress('gpu', JSON.stringify(gpu.gpuInfo ?? gpu.error ?? gpu).slice(0, 600))
      /*
       * A screenshot, when the scripted probe asks for one.
       *
       * The other phases capture the window, but the scripted branch is where a measurement that parks
       * the caret somewhere specific runs — and that is exactly when a picture is worth taking, because
       * a bug about where something is *drawn* cannot be settled by asking the DOM where it is. §3.47
       * is the case in point: the rectangles said the gutter highlight and the caret line agreed, and
       * the screenshot said otherwise.
       */
      let screenshot: string | null = null
      const shotPath = process.env.EUKOLIA_VISUAL_SHOT_PATH
      if (shotPath) {
        try {
          const image = await window.webContents.capturePage()
          fs.writeFileSync(shotPath, image.toPNG())
          screenshot = shotPath
        } catch (error) {
          screenshot = `FAILED: ${String(error).slice(0, 200)}`
        }
      }
      const payload =
        result && typeof result === 'object'
          ? { ...(result as Record<string, unknown>), gpu, screenshot }
          : { value: result, gpu, screenshot }
      process.stdout.write(`__EUKOLIA_RASTER_PROBE__${JSON.stringify(payload)}\n`)
      app.exit(0)
      return
    }

    // A short diagram-only pass avoids the later scrolling/performance experiments.
    if (process.env.EUKOLIA_TIKZCD_PROBE === '1') {
      report.tikzcd = await evaluate(`(async () => {
        const view = window.__cmView;
        const at = view.state.doc.toString().indexOf(${JSON.stringify('\\begin{tikzcd}')});
        if (at < 0) throw new Error('No tikzcd diagram in the document');
        view.dispatch({ selection: { anchor: 0 }, effects: view.constructor.scrollIntoView(at, { y: 'center' }) });
        await new Promise(resolve => setTimeout(resolve, 3000));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const grid = view.dom.querySelector('[data-tikzcd-grid]');
        const svg = grid?.closest('svg');
        if (!svg) throw new Error('Diagram has no SVG');
        const box = svg.getBoundingClientRect();
        return {
          grid: grid.getAttribute('data-tikzcd-grid'),
          shafts: grid.querySelectorAll('[data-tikzcd-shaft]').length,
          heads: grid.querySelectorAll('[data-tikzcd-head]').length,
          labels: [...grid.querySelectorAll('[data-tikzcd-label-content]')].map(node => node.getAttribute('data-tikzcd-label-tex')),
          errors: [...view.dom.querySelectorAll('[data-mjx-error]')].map(node => node.getAttribute('data-mjx-error')),
          connected: view.dom.isConnected,
          visibility: getComputedStyle(svg).visibility,
          color: getComputedStyle(svg).color,
          painted: [...svg.querySelectorAll('use, [data-tikzcd-shaft]')].slice(0, 12).map(node => {
            const style = getComputedStyle(node), rect = node.getBoundingClientRect();
            return {tag: node.tagName, ns: node.namespaceURI, fill: style.fill, stroke: style.stroke,
              visibility: style.visibility, opacity: style.opacity, transform: style.transform,
              rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}};
          }),
          missingGlyphs: [...svg.querySelectorAll('use')].filter(node => {
            const href = node.getAttribute('href') || node.getAttribute('xlink:href');
            return !href || !document.getElementById(href.slice(1));
          }).length,
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          scroller: { top: view.scrollDOM.scrollTop, height: view.scrollDOM.clientHeight },
        };
      })()`)
      const image = await window.webContents.capturePage()
      const screenshot = path.join(process.cwd(), '.scratch', 'tikzcd-focused.png')
      fs.writeFileSync(screenshot, image.toPNG())
      report.screenshot = screenshot
      process.stdout.write(`__EUKOLIA_VISUAL_PROBE__${JSON.stringify(report)}\n`)
      app.exit(0)
      return
    }

    /*
     * A renderer wedged inside MathJax cannot answer `executeJavaScript` at all, so
     * the only way to read how far the extension got is a channel that survives the
     * freeze. The page title does: an interval, installed *inside* the page before
     * startup, keeps publishing the extension's last stage marker into it, and the
     * browser process can still read the title over the DevTools protocol while the
     * renderer's own JavaScript is stuck.
     */
    report.mathJaxFrozenStage = {
      title: window.webContents.getTitle(),
      url: window.webContents.getURL(),
      crashed: window.webContents.isCrashed(),
    }

    /*
     * Bounded, because a renderer wedged inside its own typesetting never answers
     * `executeJavaScript` at all — and an unbounded await here turns a diagnosable
     * hang into a probe that writes no report. On timeout the probe carries on with
     * `mounted: null`, which the checks below read as "the page did not answer".
     */
    const mounted = await evaluate<boolean>('!!window.__cmView')
    progress('mount check', String(mounted))
    report.visualEditorMounted = mounted
    report.rendererAnswered = mounted !== null

    /*
     * The last stage the extension reached, published into the page title.
     *
     * A renderer wedged inside MathJax stops answering `executeJavaScript`
     * altogether, so a value written before the freeze is the only evidence of how
     * far it got. The title is that channel: this interval keeps rewriting it, and
     * the browser process can read it over the DevTools protocol even while the
     * renderer's own JavaScript is stuck. `ticks` says whether the interval was
     * still running at all.
     */
    await evaluate(`(() => {
      let ticks = 0;
      window.__eukoliaTitleTimer = setInterval(() => {
        ticks += 1;
        const grown = window.__eukoliaTikzcd;
        const stage = grown && grown.stages ? grown.stages[grown.stages.length - 1] : 'none';
        document.title = 'tikzcd:' + stage + '|ticks:' + ticks;
      }, 50);
      return true;
    })()`)

    /*
     * What the mathematics loader did, before anything else is asked of it.
     *
     * This is the measurement that settles a startup which never finishes: which
     * files the page actually requested, what became of each of them, and which
     * package the loader is still waiting on. A hang has no error to read, so it
     * has to be read out of the loader's own bookkeeping.
     */
    // Observe startup without constructing new jaxes or replacing its document.
    // Calling getComponents here would change the renderer being measured.
    report.mathJaxStartupError = await evaluate(`(() => {
      const mathjax = window.MathJax;
      const startup = mathjax && mathjax.startup;
      if (!startup) return { error: 'no startup' };
      return {
        texPackages: mathjax.config.tex.packages,
        inputCount: startup.input.length,
        hasOutput: !!startup.output,
        hasDocument: !!startup.document,
      };
    })()`)

    report.mathJaxLoadTrace = await evaluate(`(async () => {
      const mathjax = window.MathJax;
      if (!mathjax) return { error: 'no window.MathJax' };
      const settled = await Promise.race([
        (window.__eukoliaMathJaxStartup || Promise.resolve('no startup promise'))
          .then(() => 'resolved', (err) => 'rejected: ' + String(err && err.message ? err.message : err)),
        new Promise(resolve => setTimeout(() => resolve('still pending after 4s'), 4000)),
      ]);
      /*
       * How far the startup chain actually got.
       *
       * \`getComponents()\` and \`makeMethods()\` are both synchronous, so if the
       * jaxes are there and the methods are not, the chain died after them — in
       * \`pagePromise\` or in \`pageReady\`. If the jaxes are not there, it died
       * before them. Those are the only two possibilities and they are told apart
       * by this object.
       */
      const startup = mathjax.startup || {};
      const inputs = Array.isArray(startup.input) ? startup.input : [];
      const startupState = {
        inputCount: inputs.length,
        inputNames: inputs.map(jax => (jax && jax.name ? String(jax.name) : null)),
        hasOutput: !!startup.output,
        outputName: startup.output && startup.output.name ? String(startup.output.name) : null,
        hasHandler: !!startup.handler,
        hasDocument: !!startup.document,
        hasAdaptor: !!startup.adaptor,
        hasMathjax: !!startup.mathjax,
        // \`TagsFactory\` has no lookup: \`create\` is the only way to ask, and it
        // throws for a name that was never added — which is itself the answer.
        tagsFactoryHasNoLabel: (() => {
          try {
            const factory = mathjax._.input.tex.Tags.TagsFactory;
            return !!factory.create('none-removed');
          } catch (err) {
            return false;
          }
        })(),
        joined: inputs.map(jax => !!(jax && jax.configuration && typeof jax.configuration.getPackage === 'function' &&
          jax.configuration.getPackage('tikzcd'))),
        methods: ['tex2svgPromise', 'typesetPromise', 'svgStylesheet']
          .filter(name => typeof mathjax[name] === 'function'),
      };
      const loader = mathjax.loader;
      const packageMap = mathjax._?.components?.package?.Package?.packages;
      const packages = packageMap ? [...packageMap.entries()] : [];
      const grown = window.__eukoliaTikzcd || null;
      return {
        settled,
        readyState: document.readyState,
        baseURI: document.baseURI,
        hasTex2svg: typeof mathjax.tex2svgPromise === 'function',
        keys: Object.keys(mathjax).slice(0, 24),
        startupState,
        loadedFiles: [...document.querySelectorAll('script[src]')].map(s => String(s.getAttribute('src'))),
        inFlight: packages
          .filter(entry => {
            const value = entry[1];
            return !value.isLoaded || value.isLoading || value.hasFailed;
          })
          .map(entry => {
            const value = entry[1];
            return {
              name: String(entry[0]),
              isLoaded: !!value.isLoaded,
              isLoading: !!value.isLoading,
              hasFailed: !!value.hasFailed,
              dependencyCount: value.dependencyCount,
              noLoad: !!value.noLoad,
            };
          }),
        packageCount: packages.length,
        extension: grown && {
          stages: [...(grown.stages || [])],
          errors: [...(grown.errors || [])],
          parser: !!grown.parser,
          registered: !!grown.registered,
        },
      };
    })()`)

    if (!mounted) {
      // What the renderer said while it was failing, and what it did load: a boot
      // error is invisible from here otherwise.
      report.earlyErrors = earlyErrors.slice(0, 40)
    report.domAtFailure = await evaluate(`(() => {
        const app = document.getElementById('root');
        return {
          title: document.title,
          readyState: document.readyState,
          hasRoot: !!app,
          rootChildren: app ? app.children.length : null,
          rootHtml: app ? app.innerHTML.slice(0, 500) : null,
          bodyClasses: document.body ? document.body.className : null,
          mathJaxLoaded: typeof window.MathJax !== 'undefined',
          scripts: [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')),
        };
      })()`).catch((error: unknown) => String(error))
      fs.writeFileSync(
        path.join(process.cwd(), 'visual-probe.json'),
        JSON.stringify(report, null, 2)
      )
      process.stdout.write(`__EUKOLIA_VISUAL_PROBE__${JSON.stringify(report)}\n`)
      app.exit(0)
      return
    }

    report.document = await evaluate(`(() => {
      const view = window.__cmView;
      // The click handler appends its decisions here, if the array exists. Set up
      // before anything can click, so the log covers every click of the run.
      window.__eukoliaClickLog = [];
      window.__eukoliaIslandLog = [];
      return { lines: view.state.doc.lines, text: view.state.doc.toString().slice(0, 400) };
    })()`)

    /* 1. the preamble's code, and every face in play */
    report.preamble = await evaluate(`(() => {
      const view = window.__cmView;
      const doc = view.state.doc.toString();
      const report = [];
      for (const needle of ['\\\\geometry{margin=1in}', '\\\\title{Tôpô compact-mở}', '\\\\usepackage[utf8]{vietnam}', '\\\\setlength{\\\\parindent}{0pt}']) {
        const at = doc.indexOf(needle);
        if (at < 0) { report.push({ needle, missing: true }); continue }
        const line = view.state.doc.lineAt(at);
        // Bring the line on screen, then find its element *by its text*: the
        // first \`.cm-line\` in the document belongs to a different line, which is
        // what made an earlier version of this probe measure the wrong thing.
        view.dispatch({ selection: { anchor: at + 1 } });
        const head = line.text.slice(0, 12);
        const el = [...view.dom.querySelectorAll('.cm-line')].find(
          candidate => (candidate.textContent || '').startsWith(head)
        );
        const runs = [];
        if (el) {
          const walk = (node) => {
            for (const child of node.childNodes) {
              if (child.nodeType === 3) {
                const text = String(child.nodeValue || '');
                if (!text.trim()) continue;
                const cs = getComputedStyle(child.parentElement);
                runs.push({
                  text: text.slice(0, 26),
                  family: cs.fontFamily.split(',')[0].replace(/["']/g, ''),
                  size: cs.fontSize,
                  style: cs.fontStyle,
                  weight: cs.fontWeight,
                });
              } else if (child.nodeType === 1) walk(child);
            }
          };
          walk(el);
        }
        report.push({ needle, line: line.number, lineText: line.text, foundElement: !!el, runs });
      }
      return report;
    })()`)

    /* 2. do the icon glyphs paint? */
    report.icons = await evaluate(`(() => {
      const spans = [...document.querySelectorAll('.material-symbols')];
      const sample = spans.slice(0, 6).map(span => {
        const cs = getComputedStyle(span);
        const box = span.getBoundingClientRect();
        return { name: span.textContent, family: cs.fontFamily.split(',')[0], w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10 };
      });
      const faces = [...document.fonts].filter(f => /Material/i.test(f.family)).map(f => f.family + '/' + f.status);
      return { count: spans.length, sample, faces };
    })()`)

    /* 3 and 4. what the mathematics produced */
    report.math = await evaluate(`(() => {
      const view = window.__cmView;
      const doc = view.state.doc.toString();
      const lineOf = (needle) => { const p = doc.indexOf(needle); return p < 0 ? null : view.state.doc.lineAt(p).number };
      const out = {};
      for (const [key, needle] of [['definition','\\\\begin{definition}'], ['proof','\\\\begin{proof}'], ['tikzcd','\\\\begin{tikzcd}']]) {
        const line = lineOf(needle);
        out[key] = { line };
        if (line === null) continue;
        view.dispatch({ selection: { anchor: 0 } });
        view.dispatch({ scrollIntoView: true });
      }
      // Count what widget classes are painted while the caret is out of the way.
      out.painted = {
        theoremHeaders: view.dom.querySelectorAll('.ol-cm-begin-theorem').length,
        mathWidgets: view.dom.querySelectorAll('.ol-cm-math').length,
        mathErrors: view.dom.querySelectorAll('.ol-cm-math-error').length,
        unrenderable: view.dom.querySelectorAll('.ol-cm-unrenderable-math').length,
        preambleWidgets: view.dom.querySelectorAll('.ol-cm-preamble-widget').length,
      };
      out.errorText = [...view.dom.querySelectorAll('.ol-cm-math-error')].map(e => (e.textContent || '').slice(0, 60));

      // The delimiter forms: does the visual editor render the parenthesised and
      // bracketed mathematics as mathematics at all? The caret reports both as
      // mathematics either way, because the grammar makes both kinds of
      // delimiter a math container, so what a reader sees is whether a widget
      // appears in place of the source.
      const modes = [];
      for (const needle of ['$G \\\\times G', '\\\\(a + b\\\\)', '\\\\[c + d\\\\]']) {
        const at = doc.indexOf(needle);
        if (at < 0) { modes.push({ needle, found: false }); continue }
        // Caret far away, so everything renders rather than revealing source.
        view.dispatch({ selection: { anchor: 0 } });
        view.dispatch({ effects: [] });
        modes.push({
          needle,
          found: true,
          line: view.state.doc.lineAt(at).number,
        });
      }
      out.delimiters = modes;
      return out;
    })()`)

    /* 5. the preamble toggle, as it looks collapsed */
    report.toggle = await evaluate(`(() => {
      const view = window.__cmView;
      const widget = view.dom.querySelector('.ol-cm-preamble-widget');
      if (!widget) return { missing: true };
      const cs = getComputedStyle(widget);
      return {
        text: (widget.textContent || '').trim().slice(0, 80),
        html: widget.outerHTML.slice(0, 400),
        fontFamily: cs.fontFamily.slice(0, 60),
        iconCount: widget.querySelectorAll('.material-symbols').length,
        helpLinks: widget.querySelectorAll('a').length,
        box: (() => { const b = widget.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) } })(),
      };
    })()`)

    /* What the click handler sees. The widget is scrolled into view first and the
       layout allowed to settle, because a `getBoundingClientRect` taken after a
       scroll but before the next frame is a frame out of date — which is how the
       first attempt at this measurement managed to aim at a point 800px below the
       widget it was asking about. */
    await evaluate(`(() => {
      const view = window.__cmView;
      const widget = view.dom.querySelector('.ol-cm-environment-figure.ol-cm-environment-bottom');
      if (!widget) return false;
      const box = widget.getBoundingClientRect();
      view.scrollDOM.scrollTop += box.top + box.height / 2 - view.scrollDOM.clientHeight / 2;
      return true;
    })()`)
    await wait(900)

    report.clickDiagnostics = await evaluate(`(() => {
      const view = window.__cmView;
      const widget = view.dom.querySelector('.ol-cm-environment-figure.ol-cm-environment-bottom');
      if (!widget) return { missing: true };
      const box = widget.getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      const y = Math.round(box.top + box.height / 2);
      const hit = document.elementFromPoint(x, y);
      const closest = hit && hit.closest
        ? hit.closest('.ol-cm-environment-edge,.ol-cm-unrenderable-math,.ol-cm-preamble-widget')
        : null;
      const offset = y - view.documentTop;
      let block = null;
      try {
        const found = view.elementAtHeight(offset);
        block = {
          from: found.from, to: found.to, type: found.type,
          height: Math.round(found.height),
          textAtFrom: view.state.doc.lineAt(found.from).text,
          textAtTo: view.state.doc.lineAt(found.to).text,
        };
      } catch (error) { block = 'elementAtHeight threw: ' + String(error).slice(0, 90) }
      return {
        box: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)].join(','),
        point: x + ',' + y,
        hitTag: hit ? hit.tagName + '.' + String(hit.className).slice(0, 70) : null,
        closestFound: closest ? String(closest.className).slice(0, 70) : null,
        block,
      };
    })()`)

    /* Whether the handler runs, what it decides, and what survives afterwards.
       Those are different questions: the port's caret escape runs on the same
       event and can move the caret again, so a wrong reading is either a wrong
       decision or a decision something undid. The atomic ranges are dumped too,
       because they are what both the handler and the escape read. */
    report.clickHandler = await evaluate(`(() => {
      const view = window.__cmView;
      const widget = view.dom.querySelector('.ol-cm-environment-figure.ol-cm-environment-bottom');
      if (!widget) return { missing: true };
      const box = widget.getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      const y = Math.round(box.top + box.height / 2);
      const target = document.elementFromPoint(x, y);
      if (!target) return { noTargetAt: x + ',' + y };

      const ranges = [];
      for (const source of view.state.facet(view.constructor.atomicRanges)) {
        source(view).between(0, view.state.doc.length, (from, to) => {
          if (to <= from) return;
          let elementBox = null;
          try {
            const start = view.domAtPos(from);
            const node = start.node.nodeType === 1 ? start.node : start.node.parentElement;
            const element = node && node.closest
              ? node.closest('.ol-cm-environment-edge,.ol-cm-unrenderable-math,.ol-cm-preamble-widget')
              : null;
            if (element) {
              const b = element.getBoundingClientRect();
              elementBox = [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)].join(',');
            }
          } catch (error) { elementBox = 'threw: ' + String(error).slice(0, 50) }
          ranges.push({ from, to, elementBox });
        });
      }

      const before = view.state.selection.main.anchor;
      const event = new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y,
      });
      const notCancelled = target.dispatchEvent(event);
      const after = view.state.selection.main.anchor;
      const describe = (pos) => {
        const line = view.state.doc.lineAt(pos);
        return { pos, line: line.number, column: pos - line.from, text: line.text.slice(0, 30) };
      };
      return {
        target: target.tagName + '.' + String(target.className).slice(0, 40),
        widgetBox: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)].join(','),
        ranges,
        notCancelled,
        before,
        afterHandler: after,
        afterHandlerAt: describe(after),
      };
    })()`)

    /* Where the widget sits in the document, found without trusting the block
       map: the positions just outside the widget's own box bracket the range it
       replaced. `posAtCoords` is exact for text and this is only ever asked about
       the two points outside the widget, so it never has to resolve the widget
       itself. */
    report.widgetRange = await evaluate(`(() => {
      const view = window.__cmView;
      const widget = view.dom.querySelector('.ol-cm-environment-figure.ol-cm-environment-bottom');
      if (!widget) return { missing: true };
      const box = widget.getBoundingClientRect();
      const x = Math.round(box.left + 30);
      const above = view.posAtCoords({ x, y: Math.round(box.top - 3) }, false);
      const below = view.posAtCoords({ x, y: Math.round(box.bottom + 3) }, false);
      const describe = (pos) => {
        if (pos === null || pos === undefined) return null;
        const line = view.state.doc.lineAt(pos);
        return { pos, line: line.number, column: pos - line.from, text: line.text.slice(0, 30) };
      };
      return {
        box: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)].join(','),
        above: describe(above),
        below: describe(below),
      };
    })()`)

    /* What `domAtPos` says about a widget's own position. Everything the click
       fix does hangs on being able to name the element an atomic range stands
       for, and this is the step that could not name it. */
    report.domAtPos = await evaluate(`(() => {
      const view = window.__cmView;
      const rows = [];
      for (const source of view.state.facet(view.constructor.atomicRanges)) {
        source(view).between(0, view.state.doc.length, (from, to) => {
          if (to <= from || rows.length > 20) return;
          let entry = { from, to };
          try {
            const start = view.domAtPos(from);
            entry.node = start.node ? start.node.nodeName + '#' + start.node.nodeType : null;
            entry.offset = start.offset;
            const element = start.node.nodeType === 1
              ? start.node
              : start.node.parentElement;
            entry.elementClass = element ? String(element.className).slice(0, 60) : null;
            entry.closest = element && element.closest
              ? String(element.closest('.ol-cm-environment-edge,.ol-cm-unrenderable-math,.ol-cm-preamble-widget')?.className ?? 'none').slice(0, 60)
              : 'no element';
            if (element) {
              const b = element.getBoundingClientRect();
              entry.box = [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)].join(',');
            }
          } catch (error) {
            entry.error = String(error).slice(0, 80);
          }
          rows.push(entry);
        });
      }
      return rows;
    })()`)

    /* Whether CodeMirror's own `mousedown` dispatch reaches a plugin handler at
       all. A spy is appended to the live view, and the widget clicked the way the
       protocol clicks it. "The handler is not mounted" and "nothing reaches a
       handler" are different bugs and this tells them apart. */
    report.handlerReach = await evaluate(`(() => {
      const view = window.__cmView;
      // EditorState is not on the window either; the live state's constructor is.
      const StateEffect = view.state.constructor.StateEffect;
      if (!StateEffect) return { missing: 'no StateEffect handle' };
      const seen = [];
      const spy = view.constructor.domEventHandlers({
        mousedown: (event, v) => { seen.push('spy ' + v.state.selection.main.anchor); return false },
      });
      view.dispatch({ effects: StateEffect.appendConfig.of(spy) });
      const widget = view.dom.querySelector('.ol-cm-environment-figure.ol-cm-environment-bottom');
      if (!widget) return { missing: 'no widget' };
      const box = widget.getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      const y = Math.round(box.top + box.height / 2);
      const target = document.elementFromPoint(x, y);
      const anchorBefore = view.state.selection.main.anchor;
      if (target) {
        target.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y,
        }));
      }
      return {
        target: target ? target.tagName : null,
        spySaw: seen,
        anchorBefore,
        anchorAfter: view.state.selection.main.anchor,
      };
    })()`)

    /*
     * Performance, measured rather than guessed.
     *
     * Five interactions are reported as slow — scrolling, widget rendering,
     * typing, cursor movement, live re-rendering — and they have different causes,
     * so they are measured separately. Two instruments:
     *
     *  * **Long animation frames** (`PerformanceObserver('long-animation-frame')`),
     *    which break a slow frame down into script, style-and-layout and
     *    rendering. This is the one that says *where* the time goes; a wall-clock
     *    number on its own cannot tell a JavaScript cost from a layout cost.
     *  * **Counters read from the page**, because the most common cause of a slow
     *    editor is doing work that was not needed: widgets typeset again, widgets
     *    re-mounted, decorations rebuilt.
     *
     * The document is measured **as it is**. An earlier version of this probe
     * repeated the body sixteen times to make the numbers "matter", which they did
     * — and made every measurement describe a document nobody had open. The
     * project this is pointed at is the size it is, and a cost that only appears in
     * a document sixteen times longer is not the cost being reported.
     */
    try {
    progress('phase: perf');
    report.perf = await evaluate<Record<string, unknown>>(`(async () => {
        const view = window.__cmView;
        const doc = view.state.doc;
        const out = {};

        /* ---------------------------------------------------------- instruments */

        // Long animation frames: the only instrument that separates script from
        // style and layout. Collected for the whole measurement and summarised at
        // the end, so no single interaction pays for the observer.
        const frames = [];
        let observing = true;
        const observer = new PerformanceObserver(list => {
          if (!observing) return;
          for (const entry of list.getEntries()) {
            frames.push({
              duration: entry.duration,
              blocking: entry.blockingDuration,
              script: (entry.scripts || []).reduce((sum, s) => sum + (s.duration || 0), 0),
              styleAndLayout: entry.styleAndLayoutStart
                ? Math.max(0, entry.startTime + entry.duration - entry.styleAndLayoutStart)
                : 0,
              renderStart: entry.renderStart ? entry.renderStart - entry.startTime : 0,
            });
          }
        });
        try { observer.observe({ type: 'long-animation-frame', buffered: false }) } catch (error) { out.observerFailed = String(error) }

        const summarise = (list) => {
          if (!list.length) return { frames: 0 };
          const sorted = [...list].map(f => f.duration).sort((a, b) => a - b);
          const at = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
          return {
            frames: list.length,
            p50: at(0.5),
            p90: at(0.9),
            max: Math.round(sorted[sorted.length - 1]),
            blockingTotal: Math.round(list.reduce((sum, f) => sum + f.blocking, 0)),
            scriptTotal: Math.round(list.reduce((sum, f) => sum + f.script, 0)),
            styleLayoutTotal: Math.round(list.reduce((sum, f) => sum + f.styleAndLayout, 0)),
            worst: [...list].sort((a, b) => b.duration - a.duration).slice(0, 5)
              .map(f => ({ d: Math.round(f.duration), script: Math.round(f.script), style: Math.round(f.styleAndLayout), blocking: Math.round(f.blocking) })),
          };
        };

        const settle = (ms) => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, ms)));
        const take = () => { const copy = frames.slice(); frames.length = 0; return copy };

        /* ------------------------------------------------------- mounted widgets */

        const countNodes = () => view.contentDOM.querySelectorAll('*').length;
        const countMath = () => view.dom.querySelectorAll('.ol-cm-math').length;
        const countSvg = () => view.dom.querySelectorAll('.ol-cm-math svg').length;

        out.mounted = {
          lines: view.dom.querySelectorAll('.cm-line').length,
          docLines: doc.lines,
          mathWidgets: countMath(),
          mathSvgs: countSvg(),
          domNodesInContent: countNodes(),
        };

        /* -------------------------------------------------------------- scrolling */

        // A wheel gesture, the way a user makes one: many small deltas, each
        // followed by a frame. Programmatic scrollTop assignment would not exercise
        // the editor's own wheel handler, which is part of what is being measured.
        await settle(300);
        take();
        const scroller = view.scrollDOM;
        const before = scroller.scrollTop;
        const beforeDomNodes = countNodes();
        // Wall-clock as well as frames: a gesture that takes 1.4 s to travel 700 px
        // is slow whatever the per-frame budget says, and the frame observer cannot
        // see time the compositor spends between frames.
        const scrollStarted = performance.now();
        const wheelStamps = [];
        let longestStep = 0;
        for (let step = 0; step < 60; step += 1) {
          const stepStarted = performance.now();
          scroller.dispatchEvent(new WheelEvent('wheel', {
            deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true,
          }));
          await new Promise(resolve => requestAnimationFrame(resolve));
          const spent = performance.now() - stepStarted;
          longestStep = Math.max(longestStep, spent);
          wheelStamps.push(Math.round(spent));
        }
        const scrollWallMs = performance.now() - scrollStarted;
        await settle(300);
        // How far the gesture actually travelled once the easing came to rest.
        const settledAt = scroller.scrollTop;
        out.scroll = {
          wallMs: Math.round(scrollWallMs),
          perWheelStepMs: Math.round((scrollWallMs / 60) * 10) / 10,
          longestStepMs: Math.round(longestStep),
          stepHistogram: {
            under17: wheelStamps.filter(v => v <= 17).length,
            under34: wheelStamps.filter(v => v > 17 && v <= 34).length,
            under70: wheelStamps.filter(v => v > 34 && v <= 70).length,
            over70: wheelStamps.filter(v => v > 70).length,
          },
          distanceWhileWheeling: Math.round(settledAt - before),
          // The DOM grows during a scroll: widgets entering the viewport are mounted
          // and their SVGs injected a tick later, so the content being restyled is
          // not the content that was there when the gesture began.
          domNodesBefore: beforeDomNodes,
          frames: summarise(take()),
          mathWidgetsAfter: countMath(),
          mathSvgsAfter: countSvg(),
          domNodesAfter: countNodes(),
        };

        /* ------------------------------------------------- where the time goes */

        // Decoration rebuilds, counted by watching the decoration set's identity
        // across transactions. This is the editor's own work, as opposed to
        // MathJax's: a selection change that rebuilds every widget in the viewport
        // pays for all of them, and the cache cannot help with that.
        let decorationRebuilds = 0;
        const live = view;
        const rawDispatch = live.dispatch.bind(live);
        const atomics = live.state.facet(live.constructor.atomicRanges);
        let lastSet = atomics.length ? atomics[0](live) : null;
        live.dispatch = (...args) => {
          rawDispatch(...args);
          const sets = live.state.facet(live.constructor.atomicRanges);
          const now = sets.length ? sets[0](live) : null;
          if (now !== lastSet) decorationRebuilds += 1;
          lastSet = now;
        };
        const takeRebuilds = () => { const n = decorationRebuilds; decorationRebuilds = 0; return n };

        out.cacheBefore = window.__eukoliaRenderStats ? window.__eukoliaRenderStats() : null;

        // What a decoration rebuild costs, and how many widgets it builds. The
        // profile is installed by the probe, so the application never pays for it.
        const emptyProfile = () => ({
          rebuilds: 0, ms: 0, preambleMs: 0, rangeMs: 0, ranges: 0, widgets: 0,
        });
        window.__eukoliaDecorationProfile = emptyProfile();
        const takeProfile = () => {
          const p = window.__eukoliaDecorationProfile;
          window.__eukoliaDecorationProfile = emptyProfile();
          return {
            rebuilds: p.rebuilds,
            totalMs: Math.round(p.ms * 100) / 100,
            perRebuildMs: p.rebuilds ? Math.round((p.ms / p.rebuilds) * 100) / 100 : 0,
            preambleMs: Math.round(p.preambleMs * 100) / 100,
            rangeMs: Math.round(p.rangeMs * 100) / 100,
            ranges: p.ranges,
            widgets: p.widgets,
          };
        };

        /* -------------------------------------------- what makes scrolling expensive */

        // The same gesture again with the mathematics *hidden*. The frames report
        // zero script and all of the time in style and layout plus rendering, so the
        // cost is in the subtrees being restyled and composited; replacing the SVGs
        // with a plain box of the same size keeps the document's geometry and removes
        // only the graphics. Nothing here ships — it is a measurement, and the
        // widgets are rebuilt from the editor's own state afterwards.
        const svgNodes = [...view.dom.querySelectorAll('.ol-cm-math')];
        const hiddenSvgs = svgNodes.map(w => ({ w, html: w.innerHTML, height: w.offsetHeight }));
        for (const { w, height } of hiddenSvgs) {
          w.style.height = (height || 20) + 'px';
          w.replaceChildren();
        }
        await settle(300);
        take();
        const bareStarted = performance.now();
        for (let step = 0; step < 60; step += 1) {
          scroller.dispatchEvent(new WheelEvent('wheel', {
            deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true,
          }));
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        const bareWallMs = performance.now() - bareStarted;
        await settle(250);
        out.scrollWithoutSvg = {
          wallMs: Math.round(bareWallMs),
          perWheelStepMs: Math.round((bareWallMs / 60) * 10) / 10,
          domNodes: countNodes(),
          frames: summarise(take()),
        };

        // Put the graphics back from the editor's own state, so nothing after this
        // measures a document that has been tampered with.
        for (const { w, html } of hiddenSvgs) {
          w.innerHTML = html;
        }
        await settle(600);
        out.scrollWithoutSvgRestored = { mathSvgs: countSvg(), domNodes: countNodes() };

        /* ---------------------------------------------------------- cursor motion */

        // Arrow-key motion across a hundred lines. This is the "cursor movement"
        // report: each press is a transaction, and any work keyed on a selection
        // change is paid a hundred times.
        await settle(200);
        take();
        const start = doc.line(Math.max(1, Math.floor(doc.lines / 2))).from;
        view.dispatch({ selection: { anchor: start } });
        await settle(100);
        take();
        const t0 = performance.now();
        for (let step = 0; step < 100; step += 1) {
          view.dispatch({ selection: { anchor: Math.min(doc.length, start + step * 3) } });
        }
        const cursorDispatchMs = performance.now() - t0;
        await settle(250);
        out.cursor = {
          dispatchMs: Math.round(cursorDispatchMs),
          perMoveMs: Math.round((cursorDispatchMs / 100) * 100) / 100,
          decorationRebuilds: takeRebuilds(),
          rebuildProfile: takeProfile(),
          frames: summarise(take()),
        };

        /* ----------------------------------------------------------------- typing */

        // One character per frame, the way typing arrives. Inserted in prose, where
        // each character re-parses the line and can rebuild every decoration.
        await settle(200);
        take();
        const proseAt = (() => {
          const text = doc.toString();
          const at = text.indexOf('Vietnamese prose');
          return at > 0 ? at + 4 : Math.floor(doc.length / 2);
        })();
        view.dispatch({ selection: { anchor: proseAt } });
        await settle(150);
        take();
        const t1 = performance.now();
        for (let step = 0; step < 40; step += 1) {
          view.dispatch({
            changes: { from: proseAt + step, insert: 'x' },
            selection: { anchor: proseAt + step + 1 },
            userEvent: 'input.type',
          });
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        const typingMs = performance.now() - t1;
        await settle(300);
        out.typing = {
          perCharacterMs: Math.round((typingMs / 40) * 10) / 10,
          decorationRebuilds: takeRebuilds(),
          rebuildProfile: takeProfile(),
          frames: summarise(take()),
        };

        /* ------------------------------------------- typing in prose vs in mathematics */

        // The same insertion, once in ordinary prose and once inside an equation.
        // They are different problems: prose re-parses a line, mathematics destroys
        // the widget that renders it, reveals the source, and re-typesets when the
        // caret leaves. Measuring them together would average two unrelated costs.
        await settle(200);
        const prosePoint = (() => {
          const text = doc.toString();
          const at = text.indexOf('Vietnamese prose');
          return at > 0 ? at + 6 : Math.floor(doc.length / 3);
        })();
        const mathPoint = (() => {
          const text = doc.toString();
          const at = text.indexOf('$G \\times G');
          return at > 0 ? at + 4 : prosePoint + 200;
        })();

        const typeAt = async (at, label) => {
          view.dispatch({ selection: { anchor: at } });
          await settle(180);
          take();
          takeRebuilds();
          const cacheBefore = window.__eukoliaRenderStats ? window.__eukoliaRenderStats() : null;
          const profileBefore = takeProfile();
          const t = performance.now();
          for (let step = 0; step < 20; step += 1) {
            view.dispatch({
              changes: { from: at + step, insert: 'z' },
              selection: { anchor: at + step + 1 },
              userEvent: 'input.type',
            });
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
          const spent = performance.now() - t;
          await settle(300);
          const cacheAfter = window.__eukoliaRenderStats ? window.__eukoliaRenderStats() : null;
          return {
            perKeystrokeMs: Math.round((spent / 20) * 10) / 10,
            decorationRebuilds: takeRebuilds(),
            rebuildProfile: takeProfile(),
            typesetCalls: cacheAfter && cacheBefore ? cacheAfter.misses - cacheBefore.misses : null,
            frames: summarise(take()),
            profileBefore,
          };
        };

        out.typingProse = await typeAt(prosePoint, 'prose');
        out.typingMath = await typeAt(mathPoint, 'math');

        /* ------------------------------------------------ live re-render triggers */

        // What a single edit costs in work done: decoration rebuilds and widget
        // re-mounts are the two things that turn a keystroke into a re-render of
        // the whole viewport.
        const widgetsBefore = new WeakSet();
        for (const element of view.dom.querySelectorAll('.ol-cm-math')) widgetsBefore.add(element);
        const at2 = Math.floor(doc.length / 2);
        const beforeDom = countNodes();
        const t2 = performance.now();
        for (let step = 0; step < 20; step += 1) {
          view.dispatch({
            changes: { from: at2 + step, insert: 'y' },
            selection: { anchor: at2 + step + 1 },
            userEvent: 'input.type',
          });
        }
        const editMs = performance.now() - t2;
        await settle(400);
        let remounted = 0;
        for (const element of view.dom.querySelectorAll('.ol-cm-math')) {
          if (!widgetsBefore.has(element)) remounted += 1;
        }
        out.edit = {
          perEditMs: Math.round((editMs / 20) * 100) / 100,
          decorationRebuilds: takeRebuilds(),
          rebuildProfile: takeProfile(),
          mathWidgetsRemounted: remounted,
          domNodesBefore: beforeDom,
          domNodesAfter: countNodes(),
        };

        /* ---------------------------------------------------- widget render cost */

        // How expensive one mathematics widget is, in DOM. A widget that mounts two
        // thousand nodes per formula is what makes a viewport of them expensive to
        // restyle; this counts rather than times, because the cost lands in style
        // and layout rather than in script.
        const widgets = [...view.dom.querySelectorAll('.ol-cm-math')];
        const sizes = widgets.map(w => w.querySelectorAll('*').length).sort((a, b) => a - b);
        out.widgetCost = {
          sampled: sizes.length,
          medianNodes: sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0,
          maxNodes: sizes.length ? sizes[sizes.length - 1] : 0,
          medianSvgBytes: sizes.length
            ? [...widgets]
                .map(w => (w.querySelector('svg') ? w.querySelector('svg').outerHTML.length : 0))
                .sort((a, b) => a - b)[Math.floor(sizes.length / 2)]
            : 0,
        };

        /*
         * What a widget's preamble is made of, and how many distinct ones the
         * viewport holds.
         *
         * The important question about a macro-defining document: the widget's
         * preamble embeds the document's definitions, so if those are assembled
         * afresh per widget, two widgets showing the same equation hand CodeMirror
         * two preamble objects whose *text* is identical — and whether that counts
         * as "the same widget" decides whether the equation is rendered again. The
         * count of distinct strings is the answer, read from the widgets themselves.
         */
        out.preambles = (() => {
          const text = doc.toString();
          const declared = text.match(
            /\\\\(?:newcommand|renewcommand|def|DeclareMathOperator)\\b[^\\n]{0,60}/g
          );
          return {
            documentDefinesMacros: Boolean(declared && declared.length),
            declarations: (declared || []).slice(0, 4),
          };
        })();

        out.cacheAfter = window.__eukoliaRenderStats ? window.__eukoliaRenderStats() : null;
        observing = false;
        observer.disconnect();
        return out;
      })()`)
    } catch (error) {
      report.perfFailure = String(error).slice(0, 300)
    }

    /*
     * The same wheel gesture, four ways, with the viewport warmed first.
     *
     * The comparison this replaces measured each pass from wherever the previous one
     * had left the document, and reported the first pass as slow and every later one
     * as fast — which is not the effect of the property under test but of *where the
     * scroll was*. The document was scrolling through territory it had never shown,
     * so the first pass paid for mounting every widget it met and the later ones met
     * widgets that were already built.
     *
     * So: warm the whole document once, return to the top, and only then measure.
     * Every pass then begins from the same place, over widgets that exist, which is
     * the condition a reader is actually in after the first scroll — and the
     * question the report asks, "the SVGs are already loaded, why is scrolling not
     * smooth", is exactly this condition.
     */
    try {
    progress('phase: scrollComparison');
    report.scrollComparison = await evaluate<Record<string, unknown>>(`(async () => {
        const view = window.__cmView;
        const scroller = view.scrollDOM;
        const settle = (ms) => new Promise(r => setTimeout(r, ms));
        const frames = [];
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            frames.push({
              d: entry.duration,
              script: (entry.scripts || []).reduce((s, x) => s + (x.duration || 0), 0),
              style: entry.styleAndLayoutStart
                ? Math.max(0, entry.startTime + entry.duration - entry.styleAndLayoutStart)
                : 0,
              blocking: entry.blockingDuration,
            });
          }
        });
        try { observer.observe({ type: 'long-animation-frame' }) } catch (error) { void error }

        const widgets = [...view.dom.querySelectorAll('.ol-cm-math, .ol-cm-graphics, .ol-cm-unrenderable-math')];
        const countNodes = () => view.contentDOM.querySelectorAll('*').length;
        const countMath = () => view.dom.querySelectorAll('.ol-cm-math').length;

        const summarise = (list) => {
          if (!list.length) return { frames: 0, p90: 0, max: 0, styleTotal: 0, scriptTotal: 0 };
          const d = list.map(f => f.d).sort((a, b) => a - b);
          return {
            frames: list.length,
            p50: Math.round(d[Math.floor(d.length * 0.5)]),
            p90: Math.round(d[Math.floor(d.length * 0.9)]),
            max: Math.round(d[d.length - 1]),
            styleTotal: Math.round(list.reduce((s, f) => s + f.style, 0)),
            scriptTotal: Math.round(list.reduce((s, f) => s + f.script, 0)),
            blockingTotal: Math.round(list.reduce((s, f) => s + f.blocking, 0)),
          };
        };

        const gesture = async (label) => {
          scroller.scrollTop = 0;
          await settle(500);
          const nodesBefore = countNodes();
          frames.length = 0;
          const started = performance.now();
          for (let step = 0; step < 60; step += 1) {
            scroller.dispatchEvent(new WheelEvent('wheel', {
              deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true,
            }));
            await new Promise(r => requestAnimationFrame(r));
          }
          const spent = performance.now() - started;
          await settle(300);
          return {
            label,
            perStepMs: Math.round((spent / 60) * 10) / 10,
            travelled: Math.round(scroller.scrollTop),
            nodesBefore,
            nodesAfter: countNodes(),
            mathWidgets: countMath(),
            frames: summarise(frames.slice()),
          };
        };

        /*
         * Whether scrolling actually recreates work.
         *
         * This is the report's own hypothesis: "in theory all the SVG images have
         * already been loaded, so the scroll should be completely smooth". If that is
         * true, the second visit to a region mounts nothing new. If it is false, the
         * same equations are being typeset and rebuilt every time they come back —
         * which is both the cost and a source of visual defects, because a widget
         * that is rebuilt is a widget that is briefly empty.
         *
         * A fresh SVG element per mount is the signature. Comparing the identity of
         * the maths widget elements across a round trip says the same thing more
         * directly: same element means the DOM was kept, new element means rebuilt.
         */
        const visit = async (label) => {
          const before = new Set([...view.dom.querySelectorAll('.ol-cm-math svg')]);
          const stats = window.__eukoliaRenderStats ? window.__eukoliaRenderStats() : null;
          scroller.scrollTop = scroller.scrollHeight;
          await settle(1200);
          scroller.scrollTop = 0;
          await settle(1200);
          const after = [...view.dom.querySelectorAll('.ol-cm-math svg')];
          const kept = after.filter(svg => before.has(svg)).length;
          const now = window.__eukoliaRenderStats ? window.__eukoliaRenderStats() : null;
          return {
            label,
            svgsBefore: before.size,
            svgsAfter: after.length,
            svgsKept: kept,
            svgsNew: after.length - kept,
            typesetCalls: stats && now ? now.misses - stats.misses : null,
            cacheHits: stats && now ? now.hits - stats.hits : null,
            domNodes: countNodes(),
            mathWidgets: countMath(),
          };
        };

        // What one rebuild of the visible mathematics costs, isolated: the same work
        // the widget does on every mount, over the widgets currently on screen, with no
        // scrolling, no layout and no MathJax involved.
        const rebuildCost = (() => {
          const source = window.__cmView.dom.querySelector('.ol-cm-math svg');
          if (!source) return null;
          const samples = [];
          for (let round = 0; round < 5; round += 1) {
            const started = performance.now();
            for (let i = 0; i < 48; i += 1) {
              const holder = document.createElement('div');
              holder.appendChild(source.cloneNode(true));
              void holder;
            }
            samples.push(performance.now() - started);
          }
          samples.sort((a, b) => a - b);
          return {
            cloneMsPerSvg: Math.round((samples[2] / 48) * 1000) / 1000,
            cloneMsFor48: Math.round(samples[2] * 10) / 10,
            svgNodes: source.querySelectorAll('*').length,
            svgBytes: source.outerHTML.length,
          };
        })();

        const results = { rebuildCost };
        results.roundTrip1 = await visit('first round trip');
        results.roundTrip2 = await visit('second round trip');
        results.roundTrip3 = await visit('third round trip');

        // Warm: walk the document so every widget it shows has been built and
        // measured, then come back. These passes are not reported — they are the cost
        // being avoided, and reporting them was the mistake an earlier version of
        // this comparison made.
        for (let pass = 0; pass < 3; pass += 1) {
          scroller.scrollTop = scroller.scrollHeight;
          await settle(900);
        }
        scroller.scrollTop = 0;
        await settle(1200);

        results.cycles = [];

        /*
         * Alternating cycles rather than one pass each.
         *
         * Two passes with a first-mount in between are two samples of different
         * things — one warms the viewport and one does not — and comparing them
         * reads the warm-up as the effect of the property. Six alternating cycles
         * with the report taken from the last four is enough to see whether the
         * difference survives.
         */
        for (let cycle = 0; cycle < 6; cycle += 1) {
          const contained = cycle % 2 === 0;
          for (const w of widgets) w.style.contain = contained ? '' : 'none';
          const result = await gesture((contained ? 'contained' : 'uncontained') + ' #' + cycle);
          result.contained = contained;
          results.cycles.push(result);
        }
        for (const w of widgets) w.style.contain = '';

        // And the floor, with the graphics gone.
        const saved = widgets.map(w => ({ w, html: w.innerHTML, height: w.offsetHeight }));
        for (const item of saved) {
          item.w.style.height = (item.height || 20) + 'px';
          item.w.replaceChildren();
        }
        results.withoutSvg = await gesture('no SVG at all');
        for (const item of saved) item.w.innerHTML = item.html;
        await settle(800);
        results.restored = { mathSvgs: view.dom.querySelectorAll('.ol-cm-math svg').length };

        const settled = results.cycles.slice(2);
        const mean = (list) =>
          list.length ? Math.round((list.reduce((s, v) => s + v.perStepMs, 0) / list.length) * 10) / 10 : 0;
        results.summary = {
          containedMeanMs: mean(settled.filter(c => c.contained)),
          uncontainedMeanMs: mean(settled.filter(c => !c.contained)),
          containedSamples: settled.filter(c => c.contained).map(c => c.perStepMs),
          uncontainedSamples: settled.filter(c => !c.contained).map(c => c.perStepMs),
        };

        observer.disconnect();
        return results;
      })()`)
    } catch (error) {
      report.scrollComparisonFailure = String(error).slice(0, 300)
    }

    /*
     * One sweep of the whole document, asking what actually rendered.
     *
     * Written after four narrower probes each answered a slightly different
     * question and none of them the real one. The lesson is in the shape: a
     * document-wide walk that reports *every* rendered state, rather than a
     * targeted query for the defect currently being suspected, is what turns "I
     * could not find it" into a fact about the document.
     *
     * For each line: put the caret on it, let the decorations settle, and record
     * what is on screen. `data-mjx-error` is the important one — MathJax reports a
     * failure *inside* its own output as an `<svg>` carrying that attribute rather
     * than by throwing, so `.ol-cm-math-error` (the class Eukolia adds when the
     * promise rejects) misses exactly the case a reader sees as an error box.
     *
     * The environment counts this returns are **not** a completeness check: it
     * counts what is on screen at each step, so a construct whose lines were never
     * in the viewport when the caret passed is simply absent. `environmentDetail`
     * below is the one that asks "does *this* construct render", and it is the one
     * to trust for that question — a lesson learned when this sweep reported zeros
     * for environments that were decorating perfectly well.
     */
    progress('phase: renderSweep');
    report.renderSweep = await evaluate(`(async () => {
      const view = window.__cmView;
      const doc = view.state.doc;
      const settle = (ms) => new Promise(r => setTimeout(r, ms));
      const original = view.state.selection.main.anchor;

      const totals = {
        lines: doc.lines,
        environments: {},
        mathWidgets: 0,
        mathErrors: 0,
        mjxErrors: 0,
        islands: 0,
        islandLabels: [],
        mjxMessages: [],
        widestNodeCount: 0,
      };
      const atLine = [];

      for (let number = 1; number <= doc.lines; number += 1) {
        // The caret on the line *before*, so this line is rendered rather than
        // revealed as source — the condition a reader is in when reading it.
        const anchor = doc.line(Math.max(1, number - 1)).from;
        view.dispatch({ selection: { anchor } });
        await settle(0);

        const islands = view.dom.querySelectorAll('.ol-cm-unrenderable-math');
        const errors = view.dom.querySelectorAll('.ol-cm-math-error');
        const mjx = view.dom.querySelectorAll('svg[data-mjx-error]');
        const widgets = view.dom.querySelectorAll('.ol-cm-math');

        totals.mathWidgets = Math.max(totals.mathWidgets, widgets.length);
        totals.mathErrors = Math.max(totals.mathErrors, errors.length);
        totals.mjxErrors = Math.max(totals.mjxErrors, mjx.length);
        totals.islands = Math.max(totals.islands, islands.length);
        totals.widestNodeCount = Math.max(totals.widestNodeCount, view.contentDOM.querySelectorAll('*').length);
        for (const island of islands) {
          const label = island.querySelector('.ol-cm-unrenderable-math-label');
          if (label && !totals.islandLabels.includes(label.textContent)) {
            totals.islandLabels.push(label.textContent);
            atLine.push({ line: number, kind: 'island', label: label.textContent });
          }
        }
        for (const svg of mjx) {
          const message = svg.getAttribute('data-mjx-error');
          if (!totals.mjxMessages.includes(message)) {
            totals.mjxMessages.push(message);
            atLine.push({ line: number, kind: 'mjx-error', message });
          }
        }
        for (const error of errors) {
          const key = (error.textContent || '').slice(0, 40);
          if (!totals.mjxMessages.includes(key)) {
            totals.mjxMessages.push(key);
            atLine.push({ line: number, kind: 'math-error', message: key });
          }
        }

        // Which environments this line shows a header for.
        for (const header of view.dom.querySelectorAll('.ol-cm-begin')) {
          const line = header.closest('.cm-line');
          void line;
          const name = header.querySelector('.ol-cm-environment-name');
          const label = name ? name.textContent : null;
          if (label) totals.environments[label] = (totals.environments[label] || 0) + 1;
        }
      }
      view.dispatch({ selection: { anchor: original } });
      totals.environmentHeaderInstances = Object.keys(totals.environments).length;
      return { totals, notable: atLine.slice(0, 40) };
    })()`)

    /*
     * Pictures of the two things the sweep cannot describe: what the `tikzcd`
     * environment draws, and what a theorem looks like.
     *
     * The rectangles are taken *after* scrolling the region into the middle of the
     * scroller, because `getBoundingClientRect` is viewport-relative and a region
     * that is not on screen gives a box the capture cannot use — the first attempt
     * at this photographed the end of the document from coordinates 1000px off.
     */
    try {
      const shots: Record<string, string> = {}
      // Capture each region before scrolling to the next one. Saving all rectangles
      // first photographs the last viewport with stale coordinates.
      for (const [name, needle] of [['tikzcd', '\\begin{tikzcd}'], ['theorem', '\\begin{definition}']]) {
        const rect = await evaluate<{ x: number; y: number; width: number; height: number; line: number } | null>(`(async () => {
          const view = window.__cmView;
          const doc = view.state.doc;
          const at = doc.toString().indexOf(${JSON.stringify(needle)});
          if (at < 0) return null;
          const line = doc.lineAt(at);
          const anchor = doc.line(Math.max(1, line.number - 2)).from;
          view.dispatch({ selection: { anchor } });
          view.dispatch({ effects: view.constructor.scrollIntoView(at, { y: 'center' }) });
          await new Promise(resolve => setTimeout(resolve, 900));
          const diagram = ${JSON.stringify(name)} === 'tikzcd'
            ? view.dom.querySelector('[data-tikzcd-grid]')?.closest('svg') : null;
          if (diagram) {
            diagram.scrollIntoView({ block: 'center', behavior: 'instant' });
            await new Promise(resolve => setTimeout(resolve, 900));
            const box = diagram.getBoundingClientRect();
            return { line: line.number, x: Math.floor(box.left - 20), y: Math.floor(box.top),
              width: Math.ceil(box.width + 40), height: Math.ceil(box.height + 80) };
          }
          const coords = view.coordsAtPos(at);
          if (!coords) return null;
          const editor = view.dom.getBoundingClientRect();
          return { line: line.number, x: Math.round(editor.left), y: Math.round(coords.top),
            width: Math.round(editor.width), height: Math.round(Math.max(60, coords.bottom - coords.top + 140)) };
        })()`)
        if (!rect) continue
        const fullImage = await window.webContents.capturePage()
        fs.writeFileSync(path.join(process.cwd(), '.scratch', `project-${name}-full.png`), fullImage.toPNG())
        const image = await window.webContents.capturePage({
          x: Math.max(0, rect.x),
          y: Math.max(0, rect.y - 40),
          width: Math.max(200, Math.min(1000, rect.width)),
          height: Math.max(80, Math.min(520, rect.height)),
        })
        const file = path.join(process.cwd(), '.scratch', `project-${name}.png`)
        fs.writeFileSync(file, image.toPNG())
        shots[name] = file
        report[`shot_${name}_line`] = rect.line
      }
      report.renderShots = shots
    } catch (error) {
      report.renderShotsFailure = String(error).slice(0, 200)
    }

    /*
     * Whether the project's own macros reach the rendering.
     *
     * This is what the reader sees as `\cal` in red: the mathematics is typeset with
     * an empty or partial preamble, so a command the document defines (or
     * deliberately clears) is unknown to MathJax. The widget holds the preamble it
     * was built with, so the check is to read one and look.
     */
    progress('phase: macroDelivery');
    report.macroDelivery = await evaluate(`(() => {
      const view = window.__cmView;
      const doc = view.state.doc;
      const at = doc.toString().indexOf('\\\\cal{');
      const out = { foundCal: at >= 0, calLine: at >= 0 ? doc.lineAt(at).number : null };
      if (at >= 0) {
        view.dispatch({ selection: { anchor: doc.line(Math.max(1, doc.lineAt(at).number - 1)).from } });
      }
      const widget = view.dom.querySelector('.ol-cm-math');
      out.widgetPresent = Boolean(widget);
      // Read the preamble through the widget objects the decorations hold: the
      // elements do not carry it, but the editor's own state field does.
      const ranges = [];
      for (const source of view.state.facet(view.constructor.atomicRanges)) {
        source(view).between(0, view.state.doc.length, (from, to) => {
          if (to > from && ranges.length < 4) ranges.push({ from, to });
        });
      }
      out.atomicRangeCount = ranges.length;
      // And ask MathJax directly whether the commands the document relies on are
      // defined under the definitions now in force.
      out.checks = {};
      if (window.__eukoliaMathJaxProbe) {
        for (const name of ['cal', 'R', 'half', 'Implies', 'origforall']) {
          try {
            out.checks[name] = window.__eukoliaMathJaxProbe(name);
          } catch (error) {
            out.checks[name] = 'threw: ' + String(error).slice(0, 60);
          }
        }
      }
      return out;
    })()`)

    /*
     * How smooth a scroll actually is.
     *
     * Every earlier measurement here reported a *total* per gesture and an
     * aggregate frame time, and neither answers the complaint: "smooth" is about
     * the distribution of frame intervals, and a gesture that averages 12 ms a step
     * while dropping every fourth frame feels broken. So this records the interval
     * between animation frames for the whole gesture and reports the distribution —
     * how many arrived on a 60 Hz cadence, how many missed it, and the longest.
     *
     * It also counts widget mounts, because "has this already been rendered" is the
     * question the report asks: `toDOM` is called once per mount, so a counter on it
     * says whether scrolling back over ground already covered re-renders or reuses.
     */
    try {
    progress('phase: smoothness');
    report.smoothness = await evaluate<Record<string, unknown>>(`(async () => {
        const view = window.__cmView;
        const scroller = view.scrollDOM;
        const settle = (ms) => new Promise(r => setTimeout(r, ms));

        // The widget counters, zeroed once for both passes, so the two readings
        // are cumulative and the warm pass's delta is what matters.
        window.__eukoliaMathCounters = { mounts: 0, renders: 0, cacheHits: 0 };

        const gesture = async (label, steps) => {
          scroller.scrollTop = 0;
          await settle(500);
          const intervals = [];
          let last = performance.now();
          const started = last;
          for (let step = 0; step < steps; step += 1) {
            scroller.dispatchEvent(new WheelEvent('wheel', {
              deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true,
            }));
            await new Promise(r => requestAnimationFrame(() => {
              const now = performance.now();
              intervals.push(now - last);
              last = now;
              r();
            }));
          }
          const wall = performance.now() - started;
          const sorted = [...intervals].sort((a, b) => a - b);
          const at = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10;
          return {
            label,
            wallMs: Math.round(wall),
            frames: intervals.length,
            travelled: Math.round(scroller.scrollTop),
            // What the gesture cost in editor work: mounts is fresh DOM the editor
            // asked for, renders is how many of those then needed the mathematics
            // put into them. A warm pass over ground already covered should mount
            // (CodeMirror owns the DOM and discards what leaves the viewport) but
            // not render again.
            mounts: window.__eukoliaMathCounters ? window.__eukoliaMathCounters.mounts : null,
            renders: window.__eukoliaMathCounters ? window.__eukoliaMathCounters.renders : null,
            interval: {
              p50: at(0.5), p90: at(0.9), max: Math.round(sorted[sorted.length - 1]),
              under20: intervals.filter(v => v <= 20).length,
              over33: intervals.filter(v => v > 33).length,
              over100: intervals.filter(v => v > 100).length,
            },
          };
        };

        // Cold: from the top, over ground this session has not shown.
        const cold = await gesture('cold (first pass)', 60);
        // Warm: the same ground again.
        const warm = await gesture('warm (repeat pass)', 60);

        /*
         * Repeated passes, reported rather than summarised.
         *
         * A single reading of a cold scroll measures the order it ran in, not the
         * property: whichever pass runs first meets the most work, so one number
         * cannot say whether a change helped. Six alternating passes make the
         * spread visible — and they are what showed that an interleaved experiment
         * in render pacing was *worse* than not pacing at all (median p90 67.3 ms
         * against 14.1 ms), which is why that experiment was removed rather than
         * shipped. See ARCHITECTURE.md.
         */
        const passes = [];
        for (let pass = 0; pass < 6; pass += 1) {
          // Concatenated rather than interpolated: this whole block is itself a
          // template literal, and a nested one is what broke this file before —
          // the error it produces is reported on the *outer* expression.
          passes.push(await gesture('pass #' + pass, 40));
        }

        /*
         * Where the frame actually goes is **not** measured here.
         *
         * The first version of this report carried an interleaved comparison of six CSS
         * configurations at this point, and it was confounded by its own ordering:
         * mounts rose monotonically across all twelve gestures whichever
         * configuration was applied, so the later ones were measured against a
         * document that had changed underneath them, and the table read "baseline
         * 14.7 ms, content-visibility 7.0 ms" only because baseline ran first.
         *
         * scripts/probe-raster.mjs is that measurement done properly — per-gesture
         * counters, a sequence that repeats so drift lands on every configuration
         * equally, and a no-op control. What it found is in ARCHITECTURE.md §3.31:
         * hiding every rendered SVG changes the frame time by nothing, so the artwork
         * is not what the scroll costs.
         */
        return {
          cold,
          warm,
          counters: window.__eukoliaMathCounters,
          passes: passes.map(c => ({
            label: c.label,
            p50: c.interval.p50,
            p90: c.interval.p90,
            max: c.interval.max,
            over33: c.interval.over33,
            over100: c.interval.over100,
            wallMs: c.wallMs,
            mounts: c.mounts,
            renders: c.renders,
          })),
        };
      })()`)
    } catch (error) {
      report.smoothnessFailure = String(error).slice(0, 200)
    }

    /*
     * Every environment, one at a time, with the caret on the line before it.
     *
     * Kept separate from the document-wide sweep because the two answer different
     * questions: the sweep asks "does anything fail to render", this asks "does
     * *this* construct render, and with what label". A sweep that walks the
     * document can miss a construct whose lines are not on screen at the moment it
     * looks, which is how an earlier version reported zeros for environments that
     * were decorating perfectly well.
     */
    report.environmentDetail = await evaluate(`(() => {
      const view = window.__cmView;
      const doc = view.state.doc;
      const text = doc.toString();
      const opens = [];
      const re = /\\\\begin\\{([^}]+)\\}/g;
      let match;
      while ((match = re.exec(text))) opens.push({ name: match[1], pos: match.index });

      const out = [];
      const original = view.state.selection.main.anchor;
      for (const open of opens) {
        const line = doc.lineAt(open.pos);
        view.dispatch({ selection: { anchor: doc.line(Math.max(1, line.number - 1)).from } });
        const header = [...view.dom.querySelectorAll('.ol-cm-begin')].find(el => {
          const nameEl = el.querySelector('.ol-cm-environment-name');
          void nameEl;
          return true;
        });
        const names = [...view.dom.querySelectorAll('.ol-cm-environment-name')].map(el => el.textContent);
        out.push({
          name: open.name,
          line: line.number,
          names,
          rendered: !(view.dom.textContent || '').includes('\\\\begin{' + open.name + '}'),
          headerCount: view.dom.querySelectorAll('.ol-cm-begin').length,
        });
        void header;
      }
      view.dispatch({ selection: { anchor: original } });
      return out;
    })()`)

    /*
     * What the `tikzcd` region really contains.
     *
     * Three earlier checks said "rendered" and every one was wrong for a different
     * reason, which is worth recording because each was a plausible-looking query:
     *
     *  1. *does an environment header exist* — `tikzcd` has none, and the check was
     *     about the wrong construct;
     *  2. *is there a mathematics widget* — there is, and a widget is not a
     *     rendering: the one standing there was completely empty;
     *  3. *is `data-mjx-error` set* — it is not, because MathJax used to neither
     *     reject nor resolve on a `tikzcd` body at all. It hung.
     *
     * So this asks the only question that settles it: **what is in the element**.
     * Glyph outlines mean a diagram, `<text>` means the source spelled out, and
     * nothing at all means a widget that was never filled.
     *
     * Eukolia's port draws the diagram, so the island is expected to be gone and
     * the region to hold a filled mathematics widget whose `<g data-tikzcd-arrows>`
     * carries a drawn shaft. That is what `diagram` reports, beside the island
     * counts that the previous answer was recorded in.
     */
    progress('phase: tikzcdInspection');
    report.tikzcdInspection = await evaluate(`(() => {
      const view = window.__cmView;
      const doc = view.state.doc;
      const at = doc.toString().indexOf('\\\\begin{tikzcd}');
      if (at < 0) return { missing: true };
      const line = doc.lineAt(at);
      const anchor = doc.line(Math.max(1, line.number - 2)).from;
      // The caret two lines above, so the construct renders rather than revealing —
      // and scrolled into view, because a widget outside CodeMirror's viewport has no
      // element at all. Without the scroll this reported zero islands for a region
      // that was simply not on screen, twice.
      view.dispatch({ selection: { anchor } });
      view.dispatch({ effects: view.constructor.scrollIntoView(anchor, { y: 'center' }) });

      const island = view.dom.querySelector('.ol-cm-unrenderable-math');
      const describe = (element) => element && {
        classes: String(element.className).slice(0, 80),
        paths: element.querySelectorAll('path').length,
        textElements: element.querySelectorAll('text').length,
        children: element.querySelectorAll('*').length,
        text: (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      };
      // The widget the diagram is rendered into, found by the marker the extension
      // puts on its grid rather than by position.
      const grid = view.dom.querySelector('[data-tikzcd-grid]');
      const widget = grid ? grid.closest('.ol-cm-math') || grid : null;
      const arrows = grid ? grid.querySelectorAll('[data-tikzcd-arrow]') : [];
      const shafts = grid ? grid.querySelectorAll('[data-tikzcd-shaft]') : [];
      const labels = grid ? grid.querySelectorAll('[data-tikzcd-label]') : [];
      return {
        line: line.number,
        islands: view.dom.querySelectorAll('.ol-cm-unrenderable-math').length,
        islandLabel: view.dom.querySelector('.ol-cm-unrenderable-math-label')
          ? view.dom.querySelector('.ol-cm-unrenderable-math-label').textContent
          : null,
        island: describe(island),
        diagram: grid && {
          grid: grid.getAttribute('data-tikzcd-grid'),
          inMathWidget: !!widget && String(widget.className).includes('ol-cm-math'),
          arrows: arrows.length,
          shafts: shafts.length,
          labels: labels.length,
          paths: grid.querySelectorAll('path').length,
          glyphs: grid.querySelectorAll('use').length,
          cells: grid.querySelectorAll('[data-mml-node="mtd"]').length,
          error: grid.querySelector('[data-mjx-error]')
            ? grid.querySelector('[data-mjx-error]').getAttribute('data-mjx-error')
            : null,
        },
        emptyMathWidgets: [...view.dom.querySelectorAll('.ol-cm-math')]
          .filter(el => !el.querySelector('svg')).length,
        // What the source the island used to show actually is, so it can be seen to
        // be the diagram rather than something else.
        islandSource: view.dom.querySelector('.ol-cm-unrenderable-math-source')
          ? (view.dom.querySelector('.ol-cm-unrenderable-math-source').textContent || '').slice(0, 90)
          : null,
        // And the region that used to hold an empty widget.
        strayMathWidgets: [...view.dom.querySelectorAll('.ol-cm-math')].filter(el => !el.textContent && !el.querySelector('svg')).length,
      };
    })()`)

    report.tikzcdDecision = await evaluate(`(() => {
      const view = window.__cmView;
      const doc = view.state.doc;
      const text = doc.toString();
      const at = text.indexOf('\\\\begin{tikzcd}');
      if (at < 0) return { missing: true };

      // Walk the decorations the field holds and report what covers that offset.
      const covering = [];
      for (const source of view.state.facet(view.constructor.atomicRanges)) {
        source(view).between(Math.max(0, at - 200), Math.min(doc.length, at + 200), (from, to) => {
          covering.push({ from, to, text: doc.sliceString(from, Math.min(to, from + 40)).replace(/\\s+/g, ' ') });
        });
      }

      // And the same region through the editor's own DOM, to see what is painted.
      const lines = [...view.dom.querySelectorAll('.cm-line')]
        .filter(el => (el.textContent || '').includes('begin{tikzcd}') || (el.textContent || '').includes('tikzcd'));

      return {
        tikzcdAt: at,
        coveringRanges: covering,
        linesMentioning: lines.map(el => ({
          text: (el.textContent || '').slice(0, 60),
          classes: String(el.className).slice(0, 80),
        })),
        islandCount: view.dom.querySelectorAll('.ol-cm-unrenderable-math').length,
        mathWidgetCount: view.dom.querySelectorAll('.ol-cm-math').length,
        docHasBeginInText: text.includes('\\\\begin{tikzcd}'),
      };
    })()`)

    report.tikzcdHelper = await evaluate(`(() => {
      const view = window.__cmView;
      const doc = view.state.doc;
      const text = doc.toString();
      const at = text.indexOf('\\\\begin{tikzcd}');
      if (at < 0) return { missing: true };
      // The content the decoration pass computes for this region: everything the
      // atomic range covers.
      const from = 1548, to = 1675;
      const covered = doc.sliceString(from, to);
      const helper = window.__eukoliaUnrenderableIn;
      return {
        covered: covered.replace(/\\s+/g, ' ').slice(0, 90),
        coveredStartsWithSpace: /^\\s/.test(covered),
        helperPresent: typeof helper === 'function',
        helperResult: typeof helper === 'function' ? helper(covered) : null,
        unrenderableList: window.__eukoliaUnrenderableList ?? null,
        checked: typeof helper === 'function' ? helper(' \\\\begin{tikzcd} x \\\\end{tikzcd} ') : null,
        control: typeof helper === 'function' ? helper(' x = y ') : null,
      };
    })()`)

    report.tikzcdOverlaps = await evaluate(`(() => {
      const view = window.__cmView;
      const doc = view.state.doc;
      const at = doc.toString().indexOf('\\\\begin{tikzcd}');
      if (at < 0) return { missing: true };
      const line = doc.lineAt(at);
      view.dispatch({ selection: { anchor: doc.line(Math.max(1, line.number - 2)).from } });

      const fromAll = [];
      for (const source of view.state.facet(view.constructor.atomicRanges)) {
        source(view).between(at - 4, at + 4, (from, to) => {
          fromAll.push({
            from,
            to,
            text: doc.sliceString(from, Math.min(to, from + 30)).replace(/\\s+/g, ' '),
          });
        });
      }

      // The elements painted for that offset, via the editor's own geometry.
      const coords = view.coordsAtPos(at);
      const atPoint = coords
        ? [...view.dom.querySelectorAll('.ol-cm-unrenderable-math, .ol-cm-math')].filter(el => {
            const box = el.getBoundingClientRect();
            return coords.top >= box.top - 4 && coords.top <= box.bottom + 4;
          }).map(el => ({
            classes: String(el.className).slice(0, 70),
            html: el.outerHTML.slice(0, 120),
            paths: el.querySelectorAll('path').length,
            text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
          }))
        : [];

      return {
        at,
        decorationsAt: fromAll,
        islandTotal: view.dom.querySelectorAll('.ol-cm-unrenderable-math').length,
        atPoint,
      };
    })()`)

    report.islandLog = await evaluate(`window.__eukoliaIslandLog || 'none'`)

    report.tikzcdElement = await evaluate(`(() => {
      const view = window.__cmView;
      const doc = view.state.doc;
      const at = doc.toString().indexOf('\\\\begin{tikzcd}');
      // What the page can say about the typesetter itself. A mathematics widget
      // fills itself from \`tex2svgPromise\`, and if MathJax never loads the
      // element stays a blank box with no error anywhere, which is a shape no
      // assertion can tell from a slow render.
      const mathjs = window.MathJax;
      return {
        mathJaxPresent: !!mathjs,
        mathJaxVersion: mathjs ? mathjs.version : null,
        baseURI: document.baseURI,
        tikzcd: window.__eukoliaTikzcd || null,
        scriptSources: [...document.querySelectorAll('script[src]')]
          .map(s => s.getAttribute('src')).slice(0, 6),
      };
    })()`)
    /*
     * And the question that settles it: what does the typesetter answer, here, for
     * a diagram. `tex2svgPromise` is raced against a timer, because the failure
     * this guards against is a promise that never settles.
     */
    progress('phase: tikzcdTypeset');
    report.tikzcdTypeset = await evaluate(`(async () => {
      const mathjs = window.MathJax;
      if (!mathjs || !mathjs.tex2svgPromise) {
        // Say what state the loader reached rather than only that the method is
        // missing: a startup that neither resolves nor rejects and one that
        // rejected look the same from here otherwise.
        const settled = await Promise.race([
          (window.__eukoliaMathJaxStartup || Promise.resolve('no startup promise'))
            .then(() => 'resolved', (err) => 'rejected: ' + String(err && err.message ? err.message : err)),
          new Promise(resolve => setTimeout(() => resolve('still pending after 5s'), 5000)),
        ]);
        return {
          error: 'MathJax is on the page without its typesetting methods',
          startup: settled,
          keys: Object.keys(mathjs || {}).slice(0, 20),
        };
      }
      const timeout = new Promise(resolve => setTimeout(() => resolve({ error: 'tex2svgPromise did not settle in 8s' }), 8000));
      const attempt = (async () => {
        try {
          const node = await mathjs.tex2svgPromise('\\\\begin{tikzcd} A \\\\arrow[r] & B \\\\end{tikzcd}', { display: true });
          const html = mathjs.startup.adaptor.outerHTML(node);
          return {
            length: html.length,
            grid: /data-tikzcd-grid="([^"]*)"/.exec(html) ? RegExp.$1 : null,
            shafts: (html.match(/data-tikzcd-shaft/g) || []).length,
            heads: (html.match(/data-tikzcd-head/g) || []).length,
            mjxError: /data-mjx-error="([^"]*)"/.exec(html) ? RegExp.$1 : null,
          };
        } catch (err) {
          return { error: String(err && err.message ? err.message : err) };
        }
      })();
      return Promise.race([attempt, timeout]);
    })()`)

    report.tikzcdHost = await evaluate(`(() => {
      const view = window.__cmView;
      const doc = view.state.doc;
      const at = doc.toString().indexOf('\\\\begin{tikzcd}');
      if (at < 0) return { missing: true };
      const line = doc.lineAt(at);
      const anchor = doc.line(Math.max(1, line.number - 2)).from;
      view.dispatch({ selection: { anchor } });
      // Scrolled into view first: a widget outside CodeMirror's viewport has no
      // element at all, which is how this probe first reported "no host" for a
      // region that was simply not on screen.
      view.dispatch({ effects: view.constructor.scrollIntoView(anchor, { y: 'center' }) });
      const coords = view.coordsAtPos(at);
      const host = coords ? document.elementFromPoint(coords.left + 4, coords.top + 2) : null;
      const chain = [];
      let node = host;
      while (node && node !== view.dom) {
        chain.push(node.tagName + '.' + String(node.className).slice(0, 70));
        node = node.parentElement;
      }
      // Everything the content container holds that mentions the region.
      const candidates = [...view.contentDOM.children]
        .filter(child => /unrenderable|ol-cm-math|environment/.test(String(child.className)))
        .slice(0, 40)
        .map(child => String(child.className).slice(0, 70));
      return {
        at,
        hostFound: Boolean(host),
        hostChain: chain.slice(0, 6),
        unrenderableHtml: (() => {
          const el = view.dom.querySelector('.ol-cm-unrenderable-math');
          return el ? el.outerHTML.slice(0, 200) : null;
        })(),
        contentClasses: candidates,
      };
    })()`)

    report.legacyCommands = await evaluate(`(async () => {
      if (typeof window.__eukoliaTypeset !== 'function') {
        return { missing: 'the typesetter is not exposed to the page' };
      }
      const out = {};
      for (const name of ['1', '\\cal{A}', '\\cal C(X,Y)', '\\frak{g}', '\\Bbb{R}', '\\sf{A}', '\\mathcal{A}', '\\mathbb{R}']) {
        try {
          const markup = await window.__eukoliaTypeset(name, false);
          const error = /data-mjx-error="([^"]*)"/.exec(markup);
          out[name] = {
            error: error ? error[1].slice(0, 50) : null,
            paths: (markup.match(/<path /g) || []).length,
            bytes: markup.length,
          };
        } catch (thrown) {
          out[name] = { threw: String(thrown).slice(0, 60) };
        }
      }
      return out;
    })()`)

    report.finalView = await evaluate(`(async () => {
      const view = window.__cmView;
      await new Promise(r => setTimeout(r, 2500));
      const lines = [...view.dom.querySelectorAll('.cm-line')];
      const content = view.contentDOM.getBoundingClientRect();
      return {
        dataMode: view.dom.getAttribute('data-mode'),
        cmLines: lines.length,
        nonEmptyLines: lines.filter(el => (el.textContent || '').trim().length > 0).length,
        firstLine: lines.length ? (lines[0].textContent || '').slice(0, 50) : null,
        contentOpacity: getComputedStyle(view.contentDOM).opacity,
        contentHeight: Math.round(content.height),
        contentWidth: Math.round(content.width),
        scrollTop: Math.round(view.scrollDOM.scrollTop),
        widgets: view.dom.querySelectorAll('.ol-cm-math').length,
        islands: view.dom.querySelectorAll('.ol-cm-unrenderable-math').length,
        caret: view.state.selection.main.anchor,
        caretLine: view.state.doc.lineAt(view.state.selection.main.anchor).number,
      };
    })()`)

    report.consoleErrors = await evaluate(`window.__eukoliaProbeErrors || []`)

    /* The document itself, numbered, and every environment edge the editor
       painted. Click coordinates mean nothing without the line numbers they
       correspond to, and the offset arithmetic above is easy to get wrong. */
    progress('phase: documentMap');
    report.documentMap = await evaluate(`(() => {
      const view = window.__cmView;
      const lines = [];
      for (let number = 1; number <= view.state.doc.lines; number += 1) {
        lines.push(number + ': ' + view.state.doc.line(number).text);
      }
      const edges = [...view.dom.querySelectorAll('.ol-cm-environment-edge')].map(element => {
        const box = element.getBoundingClientRect();
        return {
          classes: element.className,
          text: (element.textContent || '').slice(0, 24),
          top: Math.round(box.top),
          height: Math.round(box.height),
        };
      });
      return { lines, edges };
    })()`)

    /*
     * Which *platform font* paints each region.
     *
     * `getComputedStyle` reports what was asked for, not what drew the glyphs —
     * and a font stack that names a face lacking a character gets a silent
     * substitution, which is exactly the defect being chased. Chromium will
     * answer the real question, but only over the DevTools protocol, which the
     * main process can speak and the renderer cannot.
     *
     * This runs *after* the constructions below the fold have been scrolled into
     * view, because an un-laid-out node answers with no fonts at all.
     */
    try {
      window.webContents.debugger.attach('1.3')
      // Both agents have to be switched on before anything can be asked of them;
      // without this, `CSS.getPlatformFontsForNode` fails with "CSS agent was not
      // enabled" and the interesting question goes unanswered.
      await cdp(window, 'DOM.enable')
      await cdp(window, 'CSS.enable')
      // The DOM agent needs a snapshot before node ids mean anything; without it
      // `DOM.requestNode` hands back ids that `CSS.getPlatformFontsForNode` will
      // not resolve, and every reading comes back as an empty list.
      await cdp(window, 'DOM.getDocument', { depth: 1 })

      /*
       * Node ids have to be resolved from a live object handle. Tagging the lines
       * with a `data-probe` attribute and using `DOM.querySelector` does not work:
       * CodeMirror reconciles `view.dom` on its next update and drops foreign
       * attributes, so the selector matches nothing and every reading comes back
       * empty.
       *
       * Each entry is a renderer-side expression yielding the element to ask
       * about, paired with a label for the report.
       */
      const targets: Array<[string, string]> = [
        // The prose line, which is where the mixed typeface shows.
        ['vietProseLine', `[...window.__cmView.dom.querySelectorAll('.cm-line')]
          .find(el => (el.textContent || '').includes('nghiêng'))`],
        // The same line broken into its individual text runs.
        ['vietProseRuns', `(() => {
          const line = [...window.__cmView.dom.querySelectorAll('.cm-line')]
            .find(el => (el.textContent || '').includes('nghiêng'));
          if (!line) return null;
          const runs = [];
          const walk = (node) => {
            for (const child of node.childNodes) {
              if (child.nodeType === 3 && String(child.nodeValue).trim()) runs.push(child.parentElement);
              else if (child.nodeType === 1) walk(child);
            }
          };
          walk(line);
          return runs;
        })()`],
        // The mathematics a widget drew, which must be the same face as the prose
        // around it. Before the document face was vendored these were two
        // different typefaces in one paragraph and nothing reported it.
        ['mathWidget', `window.__cmView.dom.querySelector('.ol-cm-math svg, .ol-cm-math')`],
        ['preamble', `[...window.__cmView.dom.querySelectorAll('.cm-line')]
          .find(el => (el.textContent || '').includes('margin=1in'))`],
        ['preambleTitle', `[...window.__cmView.dom.querySelectorAll('.cm-line')]
          .find(el => (el.textContent || '').includes('Title'))`],
      ]

      const faces: Record<string, unknown> = {}
      for (const [id, expression] of targets) {
        const { result } = await cdp(window, 'Runtime.evaluate', {
          expression,
          returnByValue: false,
        })
        if (!result?.objectId) {
          faces[id] = null
          continue
        }
        try {
          // A collection comes back as an array-like; ask about each element so
          // the answer keeps the run boundaries that `getPlatformFontsForNode`
          // would otherwise merge into one list for the whole line.
          const isCollection = id.endsWith('Runs')
          const nodeIds: number[] = []
          if (isCollection) {
            const { result: length } = await cdp(window, 'Runtime.callFunctionOn', {
              objectId: result.objectId,
              functionDeclaration: 'function () { return this.length }',
              returnByValue: true,
            })
            for (let index = 0; index < (length?.value ?? 0); index += 1) {
              const { result: item } = await cdp(window, 'Runtime.callFunctionOn', {
                objectId: result.objectId,
                functionDeclaration: 'function (i) { return this[i] }',
                arguments: [{ value: index }],
              })
              if (!item?.objectId) continue
              const { nodeId } = await cdp(window, 'DOM.requestNode', { objectId: item.objectId })
              if (nodeId) nodeIds.push(nodeId)
              await cdp(window, 'Runtime.releaseObject', { objectId: item.objectId }).catch(() => {})
            }
          } else {
            const { nodeId } = await cdp(window, 'DOM.requestNode', { objectId: result.objectId })
            if (nodeId) nodeIds.push(nodeId)
          }

          const readings = []
          for (const nodeId of nodeIds) {
            const { fonts } = await cdp(window, 'CSS.getPlatformFontsForNode', { nodeId })
            readings.push(
              (fonts ?? []).map((font: { familyName: string; glyphCount: number }) => ({
                family: font.familyName,
                glyphs: font.glyphCount,
              }))
            )
          }
          faces[id] = readings
        } catch (error) {
          // One target failing must not cost the readings from the others.
          faces[id] = { error: String(error).slice(0, 120) }
        } finally {
          await cdp(window, 'Runtime.releaseObject', { objectId: result.objectId }).catch(() => {})
        }
      }
      report.platformFonts = faces
      window.webContents.debugger.detach()
    } catch (error) {
      report.platformFontsFailure = String(error).slice(0, 200)
    }

    /*
     * Per-character ink extents.
     *
     * `CSS.getPlatformFontsForNode` reports one face per *node*, so it cannot see
     * a per-character substitution inside a single text run — which is exactly
     * the shape of the reported defect. A range over one character answers with
     * that character's own ink box, and a substituted face gives itself away by
     * the box it draws: a circumflex or a horn from another font sits at a
     * different height above the base letter than the face's own precomposed
     * glyph does.
     */
    report.perCharacterInk = await evaluate(`(() => {
      const view = window.__cmView;
      const line = [...view.dom.querySelectorAll('.cm-line')]
        .find(el => (el.textContent || '').includes('Tôpô compact-mở, Đặng'));
      if (!line) return { missing: true };
      const text = line.textContent;
      // Walk the text nodes to find offsets, so a Range can be built per character.
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const parts = [];
      let node;
      while ((node = walker.nextNode())) parts.push({ node, start: parts.length ? null : 0 });

      let consumed = 0;
      const offsets = [];
      for (const part of parts) {
        offsets.push({ node: part.node, start: consumed });
        consumed += part.node.nodeValue.length;
      }

      const ink = [];
      for (let index = 0; index < text.length; index += 1) {
        const ch = text[index];
        if (ch === ' ') continue;
        const owner = [...offsets].reverse().find(o => o.start <= index);
        if (!owner) continue;
        const range = document.createRange();
        try {
          range.setStart(owner.node, index - owner.start);
          range.setEnd(owner.node, index - owner.start + 1);
        } catch { continue }
        const box = range.getBoundingClientRect();
        const parent = owner.node.parentElement;
        ink.push({
          ch,
          cp: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'),
          w: Math.round(box.width * 100) / 100,
          h: Math.round(box.height * 100) / 100,
          bottom: Math.round(box.bottom * 100) / 100,
          top: Math.round(box.top * 100) / 100,
          face: getComputedStyle(parent).fontFamily.split(',')[0].replace(/["']/g, ''),
        });
      }
      return { text, ink };
    })()`)

    /*
     * The letterforms each candidate face actually draws.
     *
     * A computed style names the face that was *asked for*; nothing in the DOM
     * says which face painted a given character, because a stack with an
     * unavailable first entry resolves silently and reports the unavailable name
     * back. Chromium will however draw any face on request, so the reference is
     * produced the same way the screen was — and the probe then compares the two
     * as pictures. Written as PNGs beside the report.
     */
    try {
      const references = await evaluate<Record<string, string>>(`(() => {
        const sample = 'Tôpô compact-mở, Đặng Thị Hồng,';
        const faces = [
          'Latin Modern Roman', 'Computer Modern', 'Cambria', 'Times New Roman',
          'Palatino Linotype', 'Segoe UI', 'Microsoft Sans Serif', 'Consolas',
          'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Georgia', 'Tahoma',
          'Arial', 'Verdana', 'Calibri', 'Constantia',
        ];
        const scale = 4;
        const out = {};
        for (const face of faces) {
          const probeCanvas = document.createElement('canvas');
          const measure = probeCanvas.getContext('2d');
          measure.font = (16.1 * scale) + 'px "' + face + '"';
          const width = Math.ceil(measure.measureText(sample).width) + 16;
          const height = Math.ceil(16.1 * scale * 2.2);
          probeCanvas.width = width;
          probeCanvas.height = height;
          const ctx = probeCanvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.fillStyle = '#000000';
          ctx.font = (16.1 * scale) + 'px "' + face + '"';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(sample, 8, height * 0.7);
          out[face] = probeCanvas.toDataURL('image/png');
        }
        return out;
      })()`)

      const directory = path.join(process.cwd(), '.scratch', 'face-refs')
      fs.mkdirSync(directory, { recursive: true })
      const written: Record<string, string> = {}
      for (const [face, dataUrl] of Object.entries(references ?? {})) {
        const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, '')
        const file = path.join(directory, `${face.replace(/[^A-Za-z0-9]+/g, '-')}.png`)
        fs.writeFileSync(file, Buffer.from(base64, 'base64'))
        written[face] = file
      }
      report.faceReferences = written
    } catch (error) {
      report.faceReferencesFailure = String(error).slice(0, 200)
    }

    /* The constructs below the fold: bring the tikzcd island into view and read
       its markup, then bring the Vietnamese prose into view and ask Chromium
       which faces paint it. The caret is parked at the very end of the document
       throughout, so the tikzcd environment stays collapsed into its island and
       is never revealed as source. */
    await evaluate(`(() => {
      window.__cmView.dispatch({ selection: { anchor: window.__cmView.state.doc.length } });
      return true;
    })()`)
    await wait(900)

    progress('phase: belowFold');
    report.belowFold = await evaluate(`(() => {
      const view = window.__cmView;
      const doc = view.state.doc.toString();
      const bring = (needle) => {
        const at = doc.indexOf(needle);
        if (at < 0) return null;
        const line = view.state.doc.lineAt(at).number;
        // The EditorView class is not on the window; the live view's constructor is.
        view.dispatch({ effects: view.constructor.scrollIntoView(at, { y: 'center' }) });
        return doc.slice(at, at + 40);
      };

      const tikzcd = bring('\\\\begin{tikzcd}');
      const island = view.dom.querySelector('.ol-cm-unrenderable-math');

      const viet = bring('Tôpô compact-mở,');
      const line = [...view.dom.querySelectorAll('.cm-line')].find(
        el => (el.textContent || '').includes('nghiêng')
      );
      const proseRuns = [];
      if (line) {
        const walk = (node) => {
          for (const child of node.childNodes) {
            if (child.nodeType === 3 && String(child.nodeValue).trim()) {
              const cs = getComputedStyle(child.parentElement);
              proseRuns.push({
                text: String(child.nodeValue).slice(0, 30),
                family: cs.fontFamily.split(',')[0].replace(/["']/g, ''),
                size: cs.fontSize,
              });
            } else if (child.nodeType === 1) walk(child);
          }
        };
        walk(line);
      }
      const qed = view.dom.querySelector('.ol-cm-qed');
      return {
        tikzcd,
        islandHtml: island ? island.outerHTML.slice(0, 300) : null,
        islandLabel: island ? (island.querySelector('.ol-cm-unrenderable-math-label') || {}).textContent : null,
        viet,
        proseRuns,
        qedPresent: !!qed,
        qedText: qed ? qed.textContent : null,
      };
    })()`)

    /* The click handler's own record of what it decided, read *after* the clicks.
       The decision has to be seen apart from the caret that survives it, because
       the port's escape runs on the same event and can move it again. */
    report.clickLog = await evaluate(`window.__eukoliaClickLog || 'not installed'`)

    /* Both modes are the same editor, so the code has to be set identically in
       each. Read the computed styles once as Visual Mode has them, switch the
       live view to Code Mode through the command registry, and read them again —
       the only way to find out whether the visual theme's own size reaches the
       code, which a stylesheet comparison cannot answer. */
    try {
      const READ = `(() => {
        const view = window.__cmView;
        const properties = [
          'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
          'letter-spacing', 'word-spacing', 'font-variant-numeric', 'color',
        ];
        const read = (element) => {
          if (!element) return null;
          const style = getComputedStyle(element);
          const out = {};
          for (const property of properties) out[property] = style.getPropertyValue(property);
          return out;
        };
        // The caret is put on a plain prose line first: a code span under the
        // caret reveals its source and changes what is mounted.
        const doc = view.state.doc.toString();
        const at = doc.indexOf('Vietnamese prose');
        view.dispatch({ selection: { anchor: at > 0 ? at + 5 : 0 } });
        view.dispatch({ effects: [] });
        const line = view.dom.querySelector('.cm-line');
        return {
          mode: view.dom.getAttribute('data-mode'),
          content: read(view.contentDOM),
          line: read(line),
          scroll: read(view.dom.querySelector('.cm-scroller')),
          gutter: read(view.dom.querySelector('.cm-lineNumbers .cm-gutterElement')),
          cursor: read(view.dom.querySelector('.cm-cursor')),
          // The variables behind the two sizes, as the browser resolved them.
          variables: {
            fontSize: getComputedStyle(view.dom).getPropertyValue('--font-size'),
            lineHeight: getComputedStyle(view.dom).getPropertyValue('--line-height'),
            visualFontSize: getComputedStyle(view.dom).getPropertyValue('--visual-font-size'),
            visualFontFamily: getComputedStyle(view.dom).getPropertyValue('--visual-font-family'),
            sourceFontFamily: getComputedStyle(view.dom).getPropertyValue('--source-font-family'),
          },
        };
      })()`

      await wait(600)
      const visual = await evaluate(READ)
      window.webContents.send('menu:command', 'editor.codeMode')
      await wait(1200)
      const code = await evaluate(READ)
      report.modeStyles = { visual, code }
      window.webContents.send('menu:command', 'editor.visualMode')
      await wait(1200)
    } catch (error) {
      report.modeStylesFailure = String(error).slice(0, 200)
    }

    /* Where a click lands.
     *
     * Visual Mode replaces source with atomic widgets, so a click resolves to a
     * document position through CodeMirror's own hit-testing and then gets moved
     * off the widget by `skipPreambleWithCursor`. Which *side* it ends up on is
     * the question here: a click on a line the editor has hidden should put the
     * caret past the code it stands for, not before it, or the next keystroke
     * lands outside the construct the reader clicked on.
     *
     * Real mouse events, through the protocol: a synthesised DOM event would not
     * go through the browser's own hit-testing, which is the thing under test. */
    try {
      window.webContents.debugger.attach('1.3')
      await cdp(window, 'DOM.enable')

      // The caret is parked outside everything so the widgets are painted.
      await evaluate(`(() => {
        const view = window.__cmView;
        view.dispatch({ selection: { anchor: view.state.doc.length } });
        view.dispatch({ effects: [] });
        return true;
      })()`)
      await wait(900)

      /**
       * One click test: find a target, click it in the browser, and read where
       * the caret ended up relative to the source the target stands for.
       */
      const clickTests: Array<{
        name: string
        selector: string
        fraction?: number
      }> = [
        { name: 'environmentEnd', selector: '.ol-cm-environment-figure.ol-cm-environment-bottom' },
        { name: 'environmentBegin', selector: '.ol-cm-environment-figure.ol-cm-environment-top' },
        { name: 'verbatimEnd', selector: '.ol-cm-environment-verbatim.ol-cm-environment-bottom' },
        { name: 'verbatimBegin', selector: '.ol-cm-environment-verbatim.ol-cm-environment-top' },
        { name: 'preambleToggle', selector: '.ol-cm-preamble-widget' },
        { name: 'unrenderableIsland', selector: '.ol-cm-unrenderable-math' },
        { name: 'mathWidget', selector: '.ol-cm-math' },
        { name: 'theoremHeader', selector: '.ol-cm-begin-theorem' },
      ]

      const clicks: Record<string, unknown> = {}
      for (const test of clickTests) {
        const target = await evaluate<{ x: number; y: number } | null>(`(() => {
          const view = window.__cmView;
          const element = view.dom.querySelector(${JSON.stringify(test.selector)});
          if (!element) return null;
          const box = element.getBoundingClientRect();
          if (box.width < 2 || box.height < 2) return null;
          // Scrolled to the middle so the click cannot land off-screen.
          const position = view.posAtDOM(element, 0);
          view.dispatch({ effects: view.constructor.scrollIntoView(position, { y: 'center' }) });
          return null;
        })()`)
        void target
        await wait(400)

        const geometry = await evaluate<{ x: number; y: number; box: string } | null>(`(() => {
          const view = window.__cmView;
          const element = view.dom.querySelector(${JSON.stringify(test.selector)});
          if (!element) return null;
          const box = element.getBoundingClientRect();
          if (box.width < 2 || box.height < 2) return null;
          const fraction = ${test.fraction ?? 0.5};
          return {
            x: Math.round(box.left + box.width * fraction),
            y: Math.round(box.top + box.height / 2),
            box: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)].join(','),
          };
        })()`)
        if (!geometry) {
          clicks[test.name] = { missing: true, selector: test.selector }
          continue
        }

        // Re-measure immediately before the press: a rect read a frame earlier
        // belongs to a layout that may already have moved, which is how this
        // measurement first managed to click 800px below the widget.
        const fresh = await evaluate<{ x: number; y: number } | null>(`(() => {
          const element = window.__cmView.dom.querySelector(${JSON.stringify(test.selector)});
          if (!element) return null;
          const box = element.getBoundingClientRect();
          if (box.width < 2 || box.height < 2) return null;
          // The fraction is of the widget's *height*, so the top has to be added —
          // omitting it aimed every click at a point below the widget, which is how
          // this probe reported the fix as broken while the handler was working.
          const fraction = ${test.fraction ?? 0.5};
          return {
            x: Math.round(box.left + box.width / 2),
            y: Math.round(box.top + box.height * fraction),
            top: Math.round(box.top),
            height: Math.round(box.height),
          };
        })()`)
        if (!fresh) { clicks[test.name] = { missing: 'vanished before the click', selector: test.selector }; continue }
        geometry.x = fresh.x
        geometry.y = fresh.y
        // Taken and recorded *before* the press: a reading after it describes the
        // layout the click produced, which is a different screen.
        clicks[`${test.name}:pre`] = await evaluate<Record<string, unknown>>(`(() => {
          const view = window.__cmView;
          const element = view.dom.querySelector(${JSON.stringify(test.selector)});
          const box = element ? element.getBoundingClientRect() : null;
          const x = ${fresh.x}, y = ${fresh.y};
          const hit = document.elementFromPoint(x, y);
          const pane = view.dom.getBoundingClientRect();
          return {
            clickedPoint: x + ',' + y,
            hit: hit ? hit.tagName + '.' + String(hit.className).slice(0, 40) : null,
            editorBox: [Math.round(pane.left), Math.round(pane.top), Math.round(pane.width), Math.round(pane.height)].join(','),
            posAtCoords: view.posAtCoords({ x, y }, false),
          };
        })()`)
        // Real press and release, so CodeMirror's own handlers run.
        for (const type of ['mousePressed', 'mouseReleased'] as const) {
          await cdp(window, 'Input.dispatchMouseEvent', {
            type,
            x: geometry.x,
            y: geometry.y,
            button: 'left',
            clickCount: 1,
            buttons: type === 'mousePressed' ? 1 : 0,
          })
        }
        await wait(700)

        clicks[test.name] = {
          selector: test.selector,
          box: geometry.box,
          clicked: `${geometry.x},${geometry.y}`,
          caret: await evaluate<number>(`window.__cmView.state.selection.main.anchor`),
          caretLine: await evaluate<number>(
            `window.__cmView.state.doc.lineAt(window.__cmView.state.selection.main.anchor).number`
          ),
          // The line the caret landed on, and where in it: "before the source the
          // target stands for" and "after it" are one comparison away.
          caretColumn: await evaluate<number>(`(() => {
            const view = window.__cmView;
            const at = view.state.selection.main.anchor;
            const line = view.state.doc.lineAt(at);
            return at - line.from;
          })()`),
          caretLineText: await evaluate<string>(`(() => {
            const view = window.__cmView;
            const at = view.state.selection.main.anchor;
            return view.state.doc.lineAt(at).text;
          })()`),
          selectedText: await evaluate<string>(
            `window.__cmView.state.sliceDoc(
               window.__cmView.state.selection.main.from,
               window.__cmView.state.selection.main.to
             ).slice(0, 60)`
          ),
        }
      }
      report.clicks = clicks
      window.webContents.debugger.detach()
    } catch (error) {
      report.clicksFailure = String(error).slice(0, 200)
    }

    /* What each of the editor's own shortcuts actually does, and which command it
     * resolves to.
     *
     * The bindings are split between the shell's command registry and the
     * editor's own CodeMirror keymap, so reading either table alone answers the
     * wrong question — and `Ctrl+B` is bound in both, which is the report. The
     * only instrument that shows the winner is a real key press through the
     * protocol, with the sidebar's visibility read from the DOM around it. */
    try {
      window.webContents.debugger.attach('1.3')

      const documentText = (): Promise<string> =>
        evaluate<string>(`window.__cmView.state.doc.toString()`)

      const sidebarVisible = (): Promise<boolean> =>
        evaluate<boolean>(`!!document.querySelector('[data-testid="sidebar-region"]')`)

      const press = async (
        key: string,
        code: string,
        virtualKey: number,
        modifiers = 2 // 2 = Ctrl
      ): Promise<void> => {
        for (const type of ['keyDown', 'keyUp'] as const) {
          await cdp(window, 'Input.dispatchKeyEvent', {
            type,
            key,
            code,
            windowsVirtualKeyCode: virtualKey,
            nativeVirtualKeyCode: virtualKey,
            modifiers,
          })
        }
        await wait(500)
      }

      /**
       * One case: park the caret or the selection, press the key, and report what
       * changed — the document, the sidebar, or nothing at all.
       */
      const shortcuts: Record<string, unknown> = {}
      const cases: Array<{
        name: string
        key: string
        code: string
        virtualKey: number
        select: number | null
      }> = [
        { name: 'ctrlBNoSelection', key: 'b', code: 'KeyB', virtualKey: 66, select: null },
        { name: 'ctrlBSelection', key: 'b', code: 'KeyB', virtualKey: 66, select: 10 },
        { name: 'ctrlISelection', key: 'i', code: 'KeyI', virtualKey: 73, select: 10 },
      ]

      // Which command the registry resolves each binding to, asked directly.
      shortcuts.registryResolves = await evaluate<Record<string, unknown>>(`(() => {
        const probe = (key, code, virtualKey) => {
          const event = new KeyboardEvent('keydown', {
            key, code, ctrlKey: true, bubbles: true, cancelable: true,
          });
          return { key, resolved: window.__eukoliaResolveKeybinding ? window.__eukoliaResolveKeybinding(event) : 'no hook' };
        };
        return { ctrlB: probe('b', 'KeyB', 66), ctrlI: probe('i', 'KeyI', 73) };
      })()`)

      for (const test of cases) {
        const before = await documentText()
        const sidebarBefore = await sidebarVisible()

        await evaluate(`(() => {
          const view = window.__cmView;
          const doc = view.state.doc.toString();
          const at = doc.indexOf('Vietnamese prose');
          const select = ${test.select === null ? 'null' : test.select};
          view.dispatch({
            selection: select === null
              ? { anchor: at + 5 }
              : { anchor: at, head: at + select },
          });
          view.dispatch({ effects: [] });
          return true;
        })()`)
        await wait(350)

        await press(test.key, test.code, test.virtualKey)
        const after = await documentText()
        const sidebarAfter = await sidebarVisible()

        shortcuts[test.name] = {
          selection: test.select === null ? 'caret only' : `caret, ${test.select} chars selected`,
          documentChanged: before !== after,
          insertedCommand: /\\\\textbf\\{|\\\\textit\\{/.exec(after.slice(0, 400))?.[0] ?? null,
          sidebarToggled: sidebarBefore !== sidebarAfter,
          sidebarNow: sidebarAfter,
        }

        // Put the sidebar back the way it was and undo any edit the press made.
        if (sidebarBefore !== sidebarAfter) {
          await evaluate(`window.__eukoliaRunCommand
            ? window.__eukoliaRunCommand('view.toggleSidebar') : null`)
          await wait(400)
        }
        if (before !== after) {
          await evaluate(`(() => {
            const view = window.__cmView;
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(before)} } });
            return true;
          })()`)
          await wait(300)
        }
      }

      // Which command actually runs, and whether the sidebar element moves. The
      // shell and the editor both bind `Ctrl+B`, so "the document did not change"
      // is not yet "the sidebar toggled".
      const shell = await evaluate<Record<string, unknown>>(`(() => {
        const state = window.__eukoliaDebugState;
        const region = document.querySelector('[data-testid="sidebar-region"]');
        const api = window.__eukoliaApi || {};
        void api;
        return {
          hasAppState: !!state,
          regionPresent: !!region,
          regionWidth: region ? Math.round(region.getBoundingClientRect().width) : 0,
          keys: Object.keys(window).filter(k => k.startsWith('__eukolia')),
        };
      })()`)
      shortcuts.shell = shell
      shortcuts.beforeKey = await evaluate<Record<string, unknown>>(`(() => {
        const region = document.querySelector('[data-testid="sidebar-region"]');
        return {
          sidebarPresent: !!region,
          sidebarWidth: region ? Math.round(region.getBoundingClientRect().width) : 0,
        };
      })()`)

      // One real press, with the caret in the document and nothing selected.
      await evaluate(`(() => {
        const view = window.__cmView;
        const doc = view.state.doc.toString();
        view.dispatch({ selection: { anchor: doc.indexOf('Vietnamese prose') + 5 } });
        view.focus();
        return true;
      })()`)
      await wait(400)
      for (const type of ['keyDown', 'keyUp'] as const) {
        await cdp(window, 'Input.dispatchKeyEvent', {
          type, key: 'b', code: 'KeyB',
          windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66, modifiers: 2,
        })
      }
      await wait(700)
      shortcuts.afterKey = await evaluate<Record<string, unknown>>(`(() => {
        const region = document.querySelector('[data-testid="sidebar-region"]');
        const view = window.__cmView;
        const at = view.state.selection.main.anchor;
        return {
          sidebarPresent: !!region,
          sidebarWidth: region ? Math.round(region.getBoundingClientRect().width) : 0,
          caret: at,
          caretLine: view.state.doc.lineAt(at).text,
          docHasTextbf: view.state.doc.toString().includes('\\textbf{'),
        };
      })()`)

      report.shortcuts = shortcuts
      window.webContents.debugger.detach()
    } catch (error) {
      report.shortcutsFailure = String(error).slice(0, 200)
    }

    // A picture of the rows in question, so the appearance can be looked at rather
    // than inferred from computed styles. `capturePage` is fed device-independent
    // rectangles; `zoom` asks for more pixels per CSS pixel, which is the only way
    // to see whether two glyphs on one line came from two different faces.
    try {
      fs.mkdirSync(path.join(process.cwd(), '.scratch'), { recursive: true })

      const shots: Record<string, string> = {}
      // A line box is ~18px tall but ascenders and diacritics reach above it, so
      // the capture rectangle is padded generously — a clipped crop cannot show
      // where a circumflex sits relative to its letter.
      const PAD_X = 10
      const PAD_TOP = 16
      const PAD_BOTTOM = 12
      for (const [id, needle] of [
        ['viet', 'Đặng Thị Hồng,'],
        ['vietMarks', 'nghiêng'],
        ['preamble', 'margin=1in'],
        ['preambleTitle', 'Title'],
        ['tikzcd', 'tikzcd diagram'],
        ['qed', 'Indeed'],
      ] as const) {
        // Centre the row in the viewport first: a node scrolled out of view is
        // captured as empty space.
        const rect = await evaluate<{ x: number; y: number; width: number; height: number } | null>(
          `(() => {
            const view = window.__cmView;
            const line = [...view.dom.querySelectorAll('.cm-line')].find(
              el => (el.textContent || '').includes(${JSON.stringify(needle)})
            ) || [...view.dom.querySelectorAll('.ol-cm-unrenderable-math-label')].find(
              el => (el.textContent || '').includes(${JSON.stringify(needle)})
            );
            if (!line) return null;
            view.dispatch({ effects: view.constructor.scrollIntoView(
              view.posAtDOM(line, 0), { y: 'center' }
            ) });
            const box = line.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height };
          })()`
        )
        if (!rect) continue
        await wait(600)
        // Re-read after the scroll settled, then capture a padded rectangle.
        const settled = await evaluate<{ x: number; y: number; width: number; height: number } | null>(
          `(() => {
            const view = window.__cmView;
            const line = [...view.dom.querySelectorAll('.cm-line')].find(
              el => (el.textContent || '').includes(${JSON.stringify(needle)})
            ) || [...view.dom.querySelectorAll('.ol-cm-unrenderable-math-label')].find(
              el => (el.textContent || '').includes(${JSON.stringify(needle)})
            );
            if (!line) return null;
            const box = line.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height };
          })()`
        )
        if (!settled) continue
        const image = await window.webContents.capturePage({
          x: Math.max(0, Math.round(settled.x - PAD_X)),
          y: Math.max(0, Math.round(settled.y - PAD_TOP)),
          width: Math.round(settled.width + PAD_X * 2),
          height: Math.round(settled.height + PAD_TOP + PAD_BOTTOM),
        })
        const file = path.join(process.cwd(), '.scratch', `visual-zoom-${id}.png`)
        fs.writeFileSync(file, image.toPNG())
        shots[id] = file
      }
      report.zoomScreenshots = shots

      // And the whole window, caret parked at the very end so nothing below it is
      // revealed as source.
      await evaluate(`(() => {
        const view = window.__cmView;
        view.dispatch({ selection: { anchor: view.state.doc.length } });
        view.dispatch({ effects: [] });
        return true;
      })()`)
      await wait(1200)
      const image = await window.webContents.capturePage()
      const shot = path.join(process.cwd(), '.scratch', 'visual-probe.png')
      fs.writeFileSync(shot, image.toPNG())
      report.screenshot = shot
    } catch (error) {
      report.screenshotFailure = String(error)
    }

    /*
     * The hover preview's relationship to the wheel.
     *
     * In Code Mode, hovering mathematics opens a tooltip. A reader who then
     * scrolls with the pointer over the preview finds the page does not move,
     * which reads as the editor having stopped responding at exactly the moment
     * the reader is looking at the equation they are scrolling past.
     *
     * What decides it is where CodeMirror *mounts* the tooltip and what the
     * one wheel handler in the shell makes of a target inside it. CodeMirror puts
     * tooltips in `view.dom` — `.cm-editor` — unless a facet says otherwise, and
     * `.cm-scroller` is a *sibling* of `.cm-editor`, not an ancestor of it. So a
     * walk up from the tooltip can miss the scroller the wheel should be moving.
     * This reports the chain, so the fix is aimed at the element that is actually
     * in the way.
     */
    try {
      /*
       * The preview is a *Code Mode* feature, and this probe is in Visual Mode.
       * Switch through the command registry, exactly as the shortcut probe below
       * does, or the hover finds no tooltip and the measurement answers nothing.
       */
      window.webContents.send('menu:command', 'editor.codeMode')
      await wait(2200)

      /*
       * Place the caret inside the mathematics by dispatching the selection, which
       * is exactly what the preview's state field watches for: it builds its
       * tooltip from `tr.selection`, so no mouse event is needed and none is faked.
       * The click was tried first and made this flaky — a synthesised press only
       * opens the preview if it lands on the right character, and the whole
       * measurement then reports on whatever it did land on.
       */
      const placed = await evaluate<Named<unknown>>(`(() => {
        const view = window.__cmView;
        if (!view) return { error: 'no view' };
        const text = view.state.doc.toString();
        const match = /\\$[^$\\n]+\\$/.exec(text);
        if (!match) return { error: 'no inline math in the document' };
        const inside = match.index + Math.floor((match[0].length - 1) / 2);
        view.focus();
        view.dispatch({ selection: { anchor: inside } });
        view.dispatch({ effects: view.constructor.scrollIntoView(inside, { y: 'center' }) });
        return { inside, tex: match[0].slice(0, 40) };
      })()`)
      report.tooltipHover = placed
      await wait(900)

      /*
       * The coordinates are read in a *second* call, after the scroll has settled.
       * `coordsAtPos` answers null for a position that is not on screen, and a
       * reading taken straight after the dispatch is taken before the viewport has
       * moved — an earlier version reported "no coordinates for the math" for a
       * document full of it, and the version after that reported a y of -510 and
       * then dispatched its wheel outside the window entirely.
       */
      const coordsOf = await evaluate<Named<unknown>>(`((attempts) => {
        const view = window.__cmView;
        const inside = ${JSON.stringify((placed as { inside?: number }).inside ?? -1)};
        if (inside < 0) return { error: 'no position' };
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const coords = view.coordsAtPos(inside);
          const pane = view.dom.getBoundingClientRect();
          if (coords && coords.top >= pane.top && coords.bottom <= pane.bottom && coords.top > 0) {
            return { x: Math.round(coords.left + 2), y: Math.round((coords.top + coords.bottom) / 2), attempts: attempt };
          }
          // Not fully on screen: ask again, and let the synchronous scroll effect
          // move the viewport before the next read.
          view.dispatch({ effects: view.constructor.scrollIntoView(inside, { y: 'center' }) });
        }
        const last = view.coordsAtPos(inside);
        return { error: 'never fully on screen', last: last ? Math.round(last.top) : null };
      })(${12})`)
      report.tooltipHover = { ...(placed as object), ...(coordsOf as object) }
      await wait(1200)

      // The debugger has to be attached for the protocol to accept input; the
      // later sections attach it too, and a second attach on the same target
      // throws, so this one is wrapped and the state is checked first.
      if (!window.webContents.debugger.isAttached()) {
        try {
          window.webContents.debugger.attach('1.3')
        } catch {
          /* another section already owns it */
        }
      }

      const inside = (placed as { inside?: number }).inside
      if (typeof inside === 'number') {
        /*
         * Wait for the tooltip to be *placed*, not merely to exist.
         *
         * CodeMirror parks a tooltip it has not measured at `top: -10000px` — its
         * `Outside` sentinel — because the measurement is a `requestMeasure` write
         * that happens after the transaction. Reading the container as soon as it
         * appears therefore finds a box at y = -10000, and aiming a wheel at the
         * *centre of that box* dispatches it 10 000 px above the window: the
         * listener never runs, its counter stays at zero, and the report says the
         * fix does not work while it is working.
         */
        const READ_TOOLTIP = `(() => {
          const out = { present: false, chain: [], waitingAtY: null };
          const tip = document.querySelector('.ol-cm-math-tooltip-container')
            || document.querySelector('.ol-cm-math-tooltip');
          if (!tip) return out;
          const rect = tip.getBoundingClientRect();
          if (rect.top < 0 || rect.width < 2 || rect.height < 2) {
            out.waitingAtY = Math.round(rect.top);
            return out;
          }
          out.present = true;
          out.rect = {
            x: Math.round(rect.x), y: Math.round(rect.y),
            width: Math.round(rect.width), height: Math.round(rect.height),
          };
          out.pointerEvents = getComputedStyle(tip).pointerEvents;
          const canScroll = (el) => {
            const overflow = getComputedStyle(el).overflowY;
            if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') return false;
            return el.scrollHeight - el.clientHeight > 1;
          };
          for (let el = tip; el && el !== document.documentElement; el = el.parentElement) {
            out.chain.push({
              tag: el.tagName.toLowerCase(),
              cls: String(el.className || '').slice(0, 70),
              scrollable: canScroll(el),
            });
          }
          const scroller = document.querySelector('.cm-scroller');
          out.scrollerIsAncestor = scroller ? scroller.contains(tip) : false;
          return out;
        })()`

        let tooltip: Named<unknown> = { present: false }
        for (let attempt = 0; attempt < 25; attempt++) {
          tooltip = await evaluate<Named<unknown>>(READ_TOOLTIP)
          if (tooltip.present) break
          await wait(120)
        }
        report.tooltip = tooltip

        /*
         * With the tooltip up, put the *pointer* over it — which is the reported
         * situation — and send one real notch.
         */
        const tipRect = (tooltip as { rect?: { x: number; y: number; width: number; height: number } }).rect
        if ((tooltip as { present?: boolean }).present && tipRect) {
          const over = {
            x: Math.round(tipRect.x + tipRect.width / 2),
            y: Math.round(tipRect.y + tipRect.height / 2),
          }
          report.tooltipPointer = over
          // Move away first, then onto the tooltip, so the browser sees a change.
          await cdp(window, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: over.x + 40, y: over.y + 40, buttons: 0 })
          await cdp(window, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: over.x, y: over.y, buttons: 0 })
          await wait(300)

        const before = await evaluate<Named<unknown>>(`(() => {
          const scroller = document.querySelector('.cm-scroller');
          /*
           * The listener's own counters, zeroed here so the reading is about this
           * notch and not every earlier one. Whether the listener runs at all is
           * otherwise invisible: a wheel over the preview that does nothing looks
           * exactly like a wheel the listener never saw.
           */
          window.__eukoliaTooltipWheel = { seen: 0, threw: null, hasScrollDom: false, delta: null };
          const tip = document.querySelector('.ol-cm-math-tooltip-container');
          const box = tip ? tip.getBoundingClientRect() : null;
          const x = ${Math.round((report.tooltipPointer as { x: number }).x)};
          const y = ${Math.round((report.tooltipPointer as { y: number }).y)};
          const hit = document.elementFromPoint(x, y);
          const pane = window.__cmView ? window.__cmView.dom.getBoundingClientRect() : null;
          return {
            before: scroller ? scroller.scrollTop : null,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            pointer: { x, y },
            tipBox: box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null,
            hit: hit ? hit.tagName + '.' + String(hit.className).slice(0, 50) : null,
            editorBox: pane ? { top: Math.round(pane.top), bottom: Math.round(pane.bottom) } : null,
          };
        })()`)
        await cdp(window, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: over.x,
          y: over.y,
          deltaX: 0,
          deltaY: 240,
          buttons: 0,
        })
        await wait(1000)
        const after = await evaluate<Named<unknown>>(`(() => {
          const scroller = document.querySelector('.cm-scroller');
          return {
            after: scroller ? scroller.scrollTop : null,
            listener: window.__eukoliaTooltipWheel || null,
          };
        })()`)
        report.wheelOverTooltip = { ...(before as object), ...(after as object) }
        }
      }
    } catch (error) {
      report.wheelProbeFailure = String(error)
    }

    /*
     * The font audit.
     *
     * "The font style in Visual Mode is not completely fixed" is a claim about
     * which face painted a glyph. Inline mathematics is drawn from SVG `<path>`
     * data, and the *variant* is named in the id MathJax writes — `NCM-C` for
     * calligraphic, `NCM-B` for bold, `NCM-DS` for double-struck. Reading those
     * names out of markup the *live application's own MathJax* produced is the
     * only way to tell a correct face from a silent fallback: a variant whose
     * font file is missing does not throw, it renders in the fallback face.
     *
     * The assertions are negative on purpose. A face that is right in one
     * expression and wrong in another is the failure mode reported, so what
     * matters is that *no* expression falls back, not that one of them matches.
     */
    try {
      const fontAudit = await evaluate<Named<unknown>>(`(async () => {
        const out = { available: false, cases: [], fallbacks: [], errors: [], raw: [] };
        const MathJax = window.MathJax;
        if (!MathJax || typeof MathJax.tex2svgPromise !== 'function') return out;
        out.available = true;

        /* Same expressions the headless audit uses, so the two are comparable. */
        const cases = [
          ['cal-braced', '\\\\cal{C}'],
          ['cal-switch', '{\\\\bf C}'],
          ['cal-space', '\\\\cal C'],
          ['mathcal', '\\\\mathcal{C}'],
          ['mathbf', '\\\\mathbf{C}'],
          ['textbf', '\\\\textbf{C}'],
          ['mathrm', '\\\\mathrm{C}'],
          ['mathbb', '\\\\mathbb{C}'],
          ['mathfrak', '\\\\mathfrak{C}'],
          ['mathsf', '\\\\mathsf{C}'],
          ['mathtt', '\\\\mathtt{C}'],
          ['mathit', '\\\\mathit{C}'],
          ['bm', '\\\\bm{C}'],
          ['plain-italic', 'C'],
          ['bare-mathcal', '\\\\mathcal{}'],
          ['hat', '\\\\hat{g}'],
          ['iso', '\\\\iso'],
          ['paper-region', '\\\\cal{C}(X\\\\times Y,Z)\\\\iso \\\\cal{C}(Z,\\\\cal{C}(X,Y))'],
        ];

        /*
         * Read the face from *both* id shapes MathJax uses. A first version of
         * this audit matched only \\\`MJX-<n>-<VARIANT>-<HEX>\\\`, which is what the
         * headless build emits; the live build writes a different prefix, so the
         * audit reported "no variant" for every expression — a wrong answer about
         * the very thing it exists to measure.
         */
        const faces = (markup) => {
          const found = [
            ...markup.matchAll(/id="MJX-[^"]*?-([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*?)-[0-9A-F]{2,}"/g),
          ].map(m => m[1]);
          return [...new Set(found)];
        };

        for (const [label, tex] of cases) {
          const entry = { label, tex, faces: [], error: null, glyphs: 0, markupBytes: 0 };
          try {
            const node = await MathJax.tex2svgPromise(tex);
            const markup = node.outerHTML || String(node);
            entry.markupBytes = markup.length;
            entry.faces = faces(markup);
            entry.glyphs = (markup.match(/<use /g) || []).length;
            const err = /data-mjx-error="([^"]*)"/.exec(markup);
            if (err) entry.error = err[1];
            if (entry.error) out.errors.push({ label, tex, error: entry.error });
          } catch (thrown) {
            entry.error = 'threw: ' + String(thrown && thrown.message || thrown).slice(0, 120);
            out.errors.push({ label, tex, error: entry.error });
          }
          out.cases.push(entry);
        }

        /* The raw markup of two expressions, so the id shape is a fact and not a
           guess: one calligraphic letter and one held-out glyph. */
        for (const [label, tex] of [['cal-braced', '\\\\cal{C}'], ['mathrm', '\\\\mathrm{C}'], ['iso', '\\\\iso']]) {
          try {
            const node = await MathJax.tex2svgPromise(tex);
            const markup = node.outerHTML || String(node);
            out.raw.push({ label, tex, markup: markup.slice(0, 1400) });
          } catch (thrown) {
            out.raw.push({ label, tex, markup: 'THREW ' + String(thrown) });
          }
        }
        return out;
      })()`)
      report.fontAudit = fontAudit
    } catch (error) {
      report.fontAuditFailure = String(error)
    }
  } catch (error) {
    report.failure = String(error)
  }

  const target = path.join(process.cwd(), 'visual-probe.json')
  try {
    fs.writeFileSync(target, JSON.stringify(report, null, 2))
  } catch {
    /* nothing to do */
  }
  process.stdout.write(`__EUKOLIA_VISUAL_PROBE__${JSON.stringify(report)}\n`)
  app.exit(report.failure ? 1 : 0)
}

export function isVisualProbeEnabled(): boolean {
  return process.env.EUKOLIA_CARET_PROBE === '1'
}

/**
 * The project library a visual-probe run reads, so that it can reach the editor
 * at all.
 *
 * The main process hands every probe its own `userData` (see `main.ts`), which
 * means a run starts with no configured library — and with none, the renderer
 * shows its welcome screen ("Choose a project library to keep your mathematics…")
 * and **nothing else happens**. The run then reports `visualEditorMounted: false`
 * and says nothing about the document it was pointed at, which is what the first
 * version of `scripts/probe-visual.mjs` produced the day it was pointed at a real
 * paper.
 *
 * The library is the folder that holds the projects, and the document's own
 * directory is where that folder is found when the caller does not name one
 * (`EUKOLIA_PROBE_WORKSPACE` is for a document inside a chapter, whose own
 * directory is not the library). Two things then have to be true, and the report
 * of the first attempt at this records both:
 *
 *  * the root must exist — `D:\LaTeX projects\The Stacks project` does, and
 *    `stacks-project-master` is opened from it by absolute path;
 *  * **`<root>/.eukolia` must exist**, because `projectLibraryStatus` reads it to
 *    validate the library and answers with an error status when it is missing —
 *    and an error status has no `root`, so the renderer showed the welcome screen
 *    even with a perfectly good `project-library.json`.
 *
 * The `.eukolia` folder is the *user's* settings, snippets and macro file, and the
 * probe must measure with them — a run against default settings would not say
 * anything about the document this machine actually opens. So they are **copied**
 * into a scratch library, never read from in place and never written back to: a
 * probe that toggles a setting must not be able to change the library a person
 * works in. That copy is the same rule `seedSmokeLibrary` follows for the same
 * reason.
 *
 * Returns the root the probe reads, or null when there is nothing to seed from.
 */
export function seedVisualProbeLibrary(userData: string): string | null {
  const document = process.env.EUKOLIA_PROBE_DOCUMENT
  const workspace =
    process.env.EUKOLIA_PROBE_WORKSPACE ?? (document ? path.dirname(document) : null)
  if (!workspace) return null
  try {
    const source = path.resolve(path.dirname(path.resolve(workspace)))
    if (!fs.existsSync(source)) return null

    const root = path.join(app.getPath('temp'), `eukolia-visual-library-${process.pid}`)
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })

    const shared = path.join(source, '.eukolia')
    if (fs.existsSync(shared)) {
      fs.cpSync(shared, path.join(root, '.eukolia'), { recursive: true })
    }
    // The library's own folders are created if the user has none, so that a run
    // measures a library rather than an error status (see above).
    for (const folder of ['templates', 'inputs']) {
      fs.mkdirSync(path.join(root, '.eukolia', folder), { recursive: true })
    }

    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(
      path.join(userData, 'project-library.json'),
      `${JSON.stringify({ root }, null, 2)}\n`,
      'utf8'
    )
    return root
  } catch (error) {
    process.stderr.write(
      `[visual-probe] could not seed a project library: ${String(error)}\n`
    )
    return null
  }
}
