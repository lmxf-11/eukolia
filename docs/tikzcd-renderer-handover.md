# Finish the `tikzcd` port: get the extension into the renderer

> **Status update — 2026-09-28:** The renderer loading blocker is resolved. The
> extension is enabled in both MathJax configurations, and regression tests now run
> the production service in Electron (`npm run test:mathjax:renderer`). The document
> below describes the earlier investigation, not the current implementation. See
> `ARCHITECTURE.md` section 3.25 for the changes and remaining port work. In particular,
> labels now use native MathJax TeX typesetting; full TikZ-CD compatibility is not
> claimed. The commuting-square fixture contains four arrows, not three.
>
> Some old explanations below were hypotheses, not established browser behavior:
> an async IIFE is valid classic JavaScript, and script insertion during startup is
> not inherently a deadlock. The verified defects were package registration and the
> delayed parser URL lookup, followed by SVG namespace, label, and row-layout bugs.

**Written for:** an agent with no context on this repository or on the work already done.
**Predecessor's verdict, up front:** the port is *built and tested*; the one thing that does not work is
turning it on in the Electron renderer, and that is the whole of this task. Do not re-build the port.

Read `docs/tikzcd-port-plan.md` first (the original plan, whose stages 0–5 are done at extension level).
Then read `ARCHITECTURE.md` §3.25 — the one headed *"tikzcd diagrams are still not rendered", and why three
checks said they were* (the heading number is duplicated in that file; the other §3.25 is about the launch).
Its blocks *"The port: where it stands"* and *"What is not done, and what it costs"* are where this work was
recorded. This document is the handover between them.

---

## 1. The job in one sentence

Make `public/mathjax/input/tex/extensions/tikzcd.js` load in the renderer without stopping MathJax's
startup, then re-enable the two configuration lines that are currently switched off and prove the diagram
renders in the app.

---

## 2. What already exists, and what it does

| file | what it is |
| --- | --- |
| `public/mathjax/input/tex/extensions/tikzcd.js` | the extension: a MathJax 4 `[tex]/tikzcd` package |
| `public/mathjax/input/tex/extensions/tikzcd-parser.mjs` | the parser — **no MathJax in it, and no `export` either** (see §7.2) |
| `public/mathjax/input/tex/extensions/tikzcd-parser.d.mts` | types for the above, since it is plain JS |
| `tests/visual/tikzcd.test.ts` | 23 parser unit tests |
| `tests/visual/mathjax.test.ts` | 21 tests, 11 of them in the `tikzcd diagrams` block, rendering real diagrams through the typesetter |
| `tests/visual/realDocumentDefects.test.ts` | asserts a diagram, not a source island |
| `tests/visual/preambleReport.test.ts`, `builtinPreamble.test.ts`, `editorDrawnMarks.test.ts` | updated: `tikzcd` is no longer "un-renderable" |
| `src/renderer/visual/builtinPreamble.ts` | `UNRENDERABLE_MATH_ENVIRONMENTS` is now empty (kept, not deleted) |
| `src/renderer/visual/mathjax-typesetter.ts` | the headless path loads `[tex]/tikzcd` and points `loader.paths.mathjax` at `public/mathjax` |
| `src/renderer/math/mathjaxService.ts` | the renderer path — **the two lines you need are commented out here** |
| `src/main/visualProbe.ts` | the measurement harness; `tikzcdTypeset` and `tikzcdInspection` are the two reports that matter |

**Everything above works.** `npx vitest run tests/visual/mathjax.test.ts tests/visual/tikzcd.test.ts`
passes, and the diagrams render with arrows and labels drawn into the SVG. The extension's design, in
outline:

1. the `tikzcd` environment handler reads the body, parses it with the parser module, then **rewrites the
   parser's string** to a plain `A & B \\ C & D \end{tikzcd}` and returns an ordinary `ArrayItem` — so
   MathJax's own array code lays the grid out;
2. the arrow list rides out of the TeX pass as a `data-tikzcd-specs` attribute on the `mtable`;
3. an output-jax hook, installed by wrapping `startup.getOutputJax`, walks the finished SVG, measures the
   cell boxes MathJax placed, and draws each arrow and label into the `<g data-tikzcd-grid>`.

---

## 3. The blocker, precisely

In `src/renderer/math/mathjaxService.ts` (`tex.packages` at line 147, `loader.load` at line 198) the port's
two lines are commented out with the reason beside them. Putting them back:

```ts
packages: {
  '[-]': ['html', 'textmacros'],
  '[+]': ['require', 'tikzcd'],
},
require: { allow: { tikzcd: true } },
// …
loader: {
  load: ['ui/safe', '[tex]/tikzcd'],
  // …
}
```

produces this, measured, not inferred:

* `window.MathJax` exists and has `version`, `_`, `config`, `loader`, `startup`, `options`.
* It has **none** of `tex2svgPromise`, `typesetPromise`, `svgStylesheet` — those are added by the startup
  step that never ran.
* `MathJax.startup.promise` **never settles**. Not rejection: no settlement at all. Measured by
  `visualProbe`'s `tikzcdTypeset`, which races it against a timer and reports
  `startup: "still pending after 5s"`.
* Consequence: every mathematics widget in the editor is an empty box with **no error anywhere** —
  `tikzcdInspection.emptyMathWidgets` goes from `0` to `6` on the fixture. This is the same failure the
  `tikzcd` source island was introduced to avoid, one layer down, and it is invisible without asking what
  is *in* the element.

Narrowed further, also measured:

* **Fetching the file is what does it, not naming the package.** With only `'[+]': ['tikzcd']` and
  `loader.load: ['ui/safe']`, startup finishes normally (`emptyMathWidgets: 0`) — but the extension file is
  never fetched, so `\begin{tikzcd}` still answers `Unknown environment 'tikzcd'`.
* **The extension's own evaluation completes.** With the loader entry on, its diagnostics global reports
  `stages: ["evaluating", "registering", "registered"]`, `errors: []`, `parser: false`, `joined: 0` — it
  registered its environment map and its package configuration, and then the startup hung anyway.

---

## 4. What has already been ruled out — **do not retry these**

Each of these was fixed or disabled, and the hang persisted in every case. The predecessor's time went
here; yours should not. Two configurations were measured, and it matters which is which:

```ts
// A — works: startup finishes, every widget renders, but tikzcd is not loaded
packages: { '[-]': ['html', 'require', 'textmacros'] },   // as it is now
loader:   { load: ['ui/safe'] }                            // as it is now

// B — hangs: startup.promise never settles, every widget is empty
packages: { '[-]': ['html', 'textmacros'], '[+]': ['require', 'tikzcd'] },
loader:   { load: ['ui/safe', '[tex]/tikzcd'] }

// C — works as far as startup goes, but only names the package: nothing is fetched,
//     so \begin{tikzcd} still answers "Unknown environment 'tikzcd'"
packages: { '[-]': ['html', 'textmacros'], '[+]': ['require', 'tikzcd'] },
loader:   { load: ['ui/safe'] }
```

So the failing difference between B and C is the loader entry — the *fetch* — and not the package name. That
is the first thing to re-measure in the renderer (§6, Step 1), because everything else here is downstream of
it.

1. **An `async` IIFE in the extension.** It was `(async function () { … })()`. Chrome will not run an async
   module as a classic script, which is how MathJax's loader loads an extension, so the file never
   evaluated at all. Now a plain IIFE. *Real bug, fixed, not the cause.*
2. **`file://` will not run a module script** (a CORS rule), and a dynamic `import()` of a `file:` URL in
   that context is never answered — no rejection, just no reply. The parser is now export-free and loaded
   as a classic `<script>`. *Real bug, fixed, not the cause.* The renderer's `document.baseURI` is
   `file:///D:/Projects/Eukolia/dist/index.html`.
3. **Requesting the parser during startup.** Requesting anything with a `<script>` while the page is
   loading is what the page then waits on, and the page is what the loader is waiting on. The request is
   now deferred to `startup.promise`'s settlement and made lazily. *Real bug, fixed, not the cause.*
4. **Registration deferred behind a promise.** The environment map and the package configuration do not
   need the parser — only the handler does. Holding the loader's `ready` step open for it caused a hang of
   its own. Registration is synchronous now. *Real bug, fixed, not the cause.*
5. **Wrapping `startup.getInputJax`.** Disabled as a suspect; no change.
6. **Wrapping `startup.getOutputJax`** (how the arrow drawing is installed). Disabled as a suspect; no
   change. Restored — the headless tests need it.
7. **Naming the package without fetching it.** See §3: starts cleanly, but nothing loads.
8. **The configuration names being wrong.** Ruled out *after* the list above was written, and worth stating
   because it looks so much like the cause: the renderer's exact `loader.load` + `tex.packages` pair, with
   the package both fetched and named, works through MathJax's Node entry point — startup resolves and
   `\begin{tikzcd} A \arrow[r] & B \end{tikzcd}` typesets to `grid=1x2, shafts=1, heads=1, error=null`.
   Without the package named it gives the same diagram. So the two-line difference between the renderer's
   configuration and the working headless one cannot be the whole cause.
9. **The extension re-requesting itself.** `activatePackage` pushes `'[tex]/tikzcd'` into `packages['[+]']`
   only if it is not already there, and `input/tex.js`'s `useInput` re-merges that array as `'[+]'` entries
   after the bundle sets its own defaults — so the extension's own write does not duplicate the loader's
   entry, and it cannot be how the load chain closes on itself.

With 1–4 fixed and 5–6 disabled, the file's *mere presence in the loader's `load` list* still holds the
startup open. What remains is a difference between the browser's loader and the Node one, not between their
API or their options: `Loader.loadScript` appends a `<script>` and waits for that element's `load` event
(`public/mathjax/tex-svg.js`, the `loadScript`/`checkLoad`/`loaded` cluster), where Node's loader goes
through `loader.require` and its promise. `loaded()` is what resolves the package's promise, and it runs
only *after* the fetched file has finished evaluating — so anything the extension does synchronously while
it is being evaluated is racing the resolution of its own load.

---

## 5. The startup chain, read out of the bundle — start here

`mathjaxService.ts` wraps `startup.ready`, so the promise that never settles is this one, assembled from
`tex-svg.js` and `input/tex.js`:

```js
// startup, in tex-svg.js
promise = new Promise((resolve, reject) => { promiseResolve = resolve; promiseReject = reject })
pagePromise = /* resolves on load/DOMContentLoaded, or at once if the page is already interactive */

// tex-svg.js: Startup.defaultReady
defaultReady() { getComponents(); makeMethods(); pagePromise.then(pageReady).then(promiseResolve).catch(promiseReject) }

// tex-svg.js: Startup.getComponents — note: synchronous, and NOT what waits
getComponents() { input = getInputJax(); output = getOutputJax(); … }

// startup, in tex-svg.js: the loader's ready step is the config's `ready`
ready: defaultReady            // ← replaced by mathjaxService.ts with its own async ready()
// and in the loader: config.loader.ready = loader.defaultReady = () => config.startup.ready()

// mathjaxService.ts's replacement
async ready() { TagsFactory.add('none-removed', NoLabelTags); await api.startup.defaultReady(); … }

// input/tex.js: the TeX jax's promise is awaited before it can be used
const jax = new TeX(config.tex)
jax.configuration.add('tikzcd', jax, config)   // via joinPackage, from the wrapped getInputJax
```

So there are exactly three places the promise can be lost, and each has one cheap question:

1. **`config.startup.ready()` itself throws asynchronously and its rejection is swallowed.** The renderer's
   `ready` is `async`, and `TagsFactory.add` runs before `defaultReady`. Ask
   `window.__eukoliaMathJaxStartup` for its state — a rejection and a hang look the same from a widget.
2. **`defaultReady`'s `pagePromise` never resolves**, because `document.readyState` was neither `complete`
   nor `interactive` when `tex-svg.js` ran and neither event was ever delivered. Ask
   `document.readyState` in the hanging renderer and compare it with what the bundle reads at
   `pagePromise`'s construction (the `readyState && …` test above). This is the browser-only branch in the
   whole chain, and it is a one-line answer.
3. **`makeMethods()` waits on a jax that never becomes usable.** `makeMethods` is what adds
   `tex2svgPromise`, `typesetPromise` and `svgStylesheet` — the three methods the half-built `window.MathJax`
   is missing — and they are added from the *jaxes*. So "no `tex2svgPromise`" means the input jax never
   completed, which is where a package that never finished loading shows up. Dump
   `MathJax.loader.packages` for the entry that is `isLoading: true` and never `isLoaded`.

All three are readable from the probe in one evaluation, and any one of them being the answer is
self-evident once printed. That is the measurement to take first.

---

## 6. What to do, in order

### Step 1 — instrument the renderer, and do not detour through jsdom

**A warning first, because it will otherwise cost you an afternoon.** The obvious idea — reproduce the hang
in jsdom under Vitest, which is faster than a 90-second Electron probe — was tried at handover and does not
work: the vendored `tex-svg.js` hangs in jsdom under *every* configuration, including the one the app runs
and the control cases, whatever the extension does. It is not a faithful stand-in for the renderer's
`file://` page, and the time spent on it bought nothing. The attempts are left at `.scratch/barePage.ts`
(a copy has to live under `tests/` to be picked up by Vitest) so that you can see what was tried and why it
failed rather than repeat it. Do not build a third one.

What *is* cheap and was worth doing: the same configuration through MathJax's Node entry point, which is
what ruled out the configuration in §4.8. If you change a line of the configuration, re-run that check
first — a small test that calls `init({ loader: { load: […], require: mjRequire, paths: { mathjax } }, tex: {
packages } })` and asserts `startup.promise` settles and `grid=1x2` comes out. It runs in a second, and it
tells you whether a change is wrong before you spend 90 seconds finding out.

So: put the diagnostics *in the page that hangs*. `visualProbe` already evaluates arbitrary script in the
renderer, and `mathjaxService.ts` already leaves `window.__eukoliaMathJaxStartup` there for you. Four
questions, each of which narrows it a lot:

1. **What did the loader resolve `[tex]/tikzcd` to?** `MathJax.loader.constructor.resolvePath('[tex]/tikzcd')`.
   It must come out under `dist/mathjax/input/tex/extensions/tikzcd.js`. If it does not, the fetch is
   looking in the wrong place and nothing else matters. Check that `dist/mathjax/input/tex/extensions/`
   actually contains both files after `npx vite build` — `public/` is the source, `dist/` is what `file://`
   serves, and a file that is missing from the build would hang the loader exactly like this.
2. **Which package names are in flight?** `MathJax.loader.packages` is a `Map`; dump every entry with its
   `isLoaded` / `isLoading` / `hasFailed` flags. A truncated load chain is visible here and nowhere else.
3. **Did the file's script element ever get its `load` event?** Instrument
   `document.createElement` for `SCRIPT` and record every `src` the page ever asks for, in order, before
   MathJax starts. If `tikzcd.js` is requested and never loads, that is a fetch problem; if it is never
   requested, that is a config-path problem; if it loads and startup still hangs, the cause is in the
   extension's evaluation, and §7's list is where to look.
4. **What does the extension's own record say?** `globalThis.__eukoliaTikzcd` — `stages`, `errors`,
   `parser`, `joined`, `registered`. The predecessor's reading stopped at
   `["evaluating","registering","registered"]` with `errors: []`, `parser: false`, `joined: 0`. Whether
   `joined` stays `0` is the important one: it means no TeX jax ever received the package, and a jax that
   never received it is a jax the parser cannot parse with.

If the answer is "the file loads, registers, and startup still hangs", the next move is the one the
predecessor never reached: comment out blocks of the extension from the bottom up — a version that
registers nothing but writes its stage markers, then one that adds the `EnvironmentMap` only, then
`Configuration.create`, then `activatePackage`, and finally the output filter — and see which block makes
the difference. Take `installOutputFilter` first: it wraps `startup.getOutputJax`, and the startup is the
thing that never finishes.

Before any of that, read §5. The chain there is short, it is the actual code in the vendored bundle, and it
reduces the whole problem to three questions — a `ready` that rejected, a `pagePromise` that never fired,
or a jax that never completed. All three are cheaper to answer than anything above.

### Step 2 — fix it, then turn the two lines back on

`src/renderer/math/mathjaxService.ts`, the `packages` block and `loader.load`. The comment beside them
spells out exactly what goes back.

### Step 3 — prove it in the app

```bash
npm run typecheck
npx vitest run                       # expect ~1844 tests; see §8 for the two known failures
npx vite build
node scripts/probe-visual.mjs        # ~90 s, run it as a background job
```

Then read `visual-probe.json`, and **look at the picture** — the probe writes a PNG per measured region
and every wrong answer in this area's history passed a programmatic check. What must be true:

| field | wanted |
| --- | --- |
| `tikzcdTypeset.error` | absent (the success case does not report it) |
| `tikzcdTypeset.startup` | absent — today it is `"still pending after 5s"`, which is how the hang is recognised |
| `tikzcdTypeset.grid` | `"1x2"` for a `A \arrow[r] & B` diagram |
| `tikzcdTypeset.shafts`, `.heads` | `1`, `1` |
| `tikzcdTypeset.mjxError` | `null` |
| `tikzcdInspection.islands` | `0` |
| `tikzcdInspection.diagram.inMathWidget` | `true` |
| `tikzcdInspection.diagram.shafts` | `1` (the fixture's first row is `A \arrow[r] \arrow[d] & B \arrow[d]`) |
| `tikzcdInspection.diagram.error` | `null` |
| `tikzcdInspection.emptyMathWidgets`, `.strayMathWidgets` | `0` |
| `renderSweep.totals.mathErrors`, `.mjxErrors` | `0` |
| `renderSweep.totals.islands` | `0` |
| `renderShots.tikzcd` PNG | a grid with arrows drawn between the cells |

The fixture document is in `src/main/visualProbe.ts`, `\begin{tikzcd}` at line 88:

```latex
\begin{tikzcd}
A \arrow[r] \arrow[d] & B \arrow[d] \\
C \arrow[r]           & D
\end{tikzcd}
```

A 2×2 grid with three arrows. Note the difference from `tikzcdTypeset`, which typesets its own one-line
`A \arrow[r] & B` probe string and so reports `"1x2"`: the two numbers are not measuring the same diagram.

### Step 4 — the real project

```powershell
$env:EUKOLIA_PROBE_DOCUMENT="D:\XPlace\LaTeX projects\compact-open topology\compact-open topology.tex"
node scripts/probe-visual.mjs
```

Its diagram is the one that motivated the port, at line 44:

```latex
\[
\begin{tikzcd}
X\times Z \ar[r,"\,\mathrm{id}\times\hat g\,"] & X\times \cal{C}(X,Y) \ar[r,"\operatorname{ev}"] & Y
\end{tikzcd}
\]
```

Wanted: `tikzcdInspection.islands` is `0`, a diagram widget is in its place, both arrows drawn, both labels
present as `data-tikzcd-text`, and the region is not an `.ol-cm-unrenderable-math`. Look at
`.scratch/project-tikzcd.png`.

### Step 5 — close out the documentation

`ARCHITECTURE.md` §3.25's block *"What is not done, and what it costs"* is written as a live blocker. When
you fix it, rewrite that block as solved: what the cause was, and what it cost to find. Keep the four
causes of §4 — they are real and hard-won — and keep the paragraphs about the island path and the
`\cal{C}` defect below it.

---

## 7. Traps, each of which cost time here

1. **An extension file must not be an async module.** `(async function () { … })()` is enough: Chrome will
   not run an async module as a classic script, so the file never evaluates and the loader waits for it
   forever. It hangs rather than fails, with no console error.
2. **The renderer runs from `file://`.** Chrome refuses module scripts there (CORS) and never answers a
   dynamic `import()` of a `file:` URL. Anything the extension loads must be a classic script that
   publishes itself on a global. That is why `tikzcd-parser.mjs` has no `export` in it despite its
   extension.
3. **`MathJax.startup.promise` can never settle.** The half-built `window.MathJax` that results *looks*
   loaded — it has `version`, `config`, `loader`, `startup` — and has no typesetting methods at all. A
   widget that awaits it is an empty element with no error, which is indistinguishable from a slow render.
   `mathjaxService` now rejects on a rejection and leaves the promise on
   `window.__eukoliaMathJaxStartup`; read that before concluding anything.
4. **The extension's diagnostics global is `globalThis.__eukoliaTikzcd`.** It records `stages`, `errors`,
   `parser`, `joined`, `registered`. Leave it in. Ask it what happened instead of guessing.
5. **`readEnvironment`'s `after` must be put back into the parser string.** Dropping it discards whatever
   followed `\end{tikzcd}` *and* the closing tag itself, which makes MathJax report
   `Missing \end{tikzcd}` for a diagram that has one. This bug only showed up when a `tikzcd` was the first
   thing a fresh typesetter was asked for, which is why it needs a test that does exactly that.
6. **The parser arrives asynchronously, so the handler must retry, not fail.** The first diagram can reach
   the handler before the parser is loaded. The handler now calls
   `internals().mathjax.mathjax.retryAfter(parserPromise)` and returns `null` — leaving the environment
   unconsumed so the retry finds it. An error box there would be a lie: the diagram is readable.
7. **`EnvironmentMap`'s second argument is a parse *function*, not the map's name**, and each entry in the
   JSON is that environment's method — so the handler's signature is `(parser, begin)`, with the name read
   off the item. Passing the wrong thing fails several frames later as `isKind is not a function`, or as a
   diagram that silently disappears.
8. **A package file the loader fetches is not a package the parser has joined.** `\require{tikzcd}` (or the
   package list) is what calls `add`. The extension does this itself in `joinPackage`, called from a
   wrapped `startup.getInputJax`; see the comment there.
9. **`jax.configuration` in the bundled `input/tex.js` holds the *parse options*.** `packageData` lives on
   it, not on `parser.parseOptions`.
10. **A widget is not a rendering.** `hasSvg: false, paths: 0, textNodes: 0` was reported as "rendered"
    three times by three different checks. Ask what is **in** the element.
11. **A widget outside CodeMirror's viewport has no element at all.** Scroll the region into view before
    reading geometry. The probe already does; anything you write must too.
12. **`No version information available for component [tex]/tikzcd` is cosmetic.** The test run prints it
    because each MathJax instance in a Node process has its own loader, and the version an extension
    records with `loader.checkVersion` is looked up in that loader's map; the bundled distributions in
    `public/mathjax/` are separate files with separate maps, so a second instance warns about the first
    one's entry. It appears in no browser run and it is not a symptom of anything. The version argument is
    `MATHJAX_VERSION = '4.1.3'` in the extension, which matches the vendored bundle.

---

## 8. The state of the test suite, so you can tell your failures from the existing ones

`npx vitest run` as of handover: **1842 passed, 2 failed, 118/119 files passed.**

The two failures are in `tests/pdf/viewerBehaviour.test.ts` — `renders at the device pixel ratio and
caches what it has already drawn` (expects `0.967`, gets `1`) and `picks up a rebuilt PDF from disk once,
without rendering twice` (expects `2`, gets `3`). They are about PDF rendering and are unrelated to this
work; `src/renderer/math/mathjaxService.ts` was touched but not that path. Treat them as pre-existing, and
if you touch them, say so.

Vitest also reports some unhandled errors from `@codemirror/view` under jsdom
(`textRange(...).getClientRects is not a function`) in the editor tests. Also pre-existing.

`npm run typecheck` is clean. `npm run typecheck:tests` has pre-existing errors in
`tests/visual/decorateWork.test.ts`, `tests/visual/snippets.test.ts` and
`tests/ui/snippets-manager.test.ts` — none of them yours.

---

## 9. If you decide the renderer cannot be fixed this way

Then **say so and record it**, as the plan's §9 allows: leave `ARCHITECTURE.md` §3.25's blocker block
accurate (it already is), leave the two configuration lines off, and leave the extension, its parser and
its tests in place — they are worth keeping whether or not the renderer ever loads them. What is *not*
acceptable is leaving the configuration on and the editor's mathematics broken; that is the state §4
describes, and it is worse than the source island this work set out to remove.

Do not delete the island path either. `UNRENDERABLE_MATH_ENVIRONMENTS` is empty by design, not removed:
the island is still the right answer for anything genuinely un-renderable, and
`tests/visual/editorDrawnMarks.test.ts` exercises the widget directly.
