# Porting `tikzcd` rendering into Eukolia's vendored MathJax

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

**Task:** make `\begin{tikzcd}…\end{tikzcd}` render as an actual commutative diagram
inside Visual Mode's mathematics, instead of the explained source island it is today.

**Written for:** an AI agent with no context on this repository. Everything needed to
start is below, including the facts that were verified rather than assumed, the exact
files to touch, and the traps that cost time when this was first investigated.

---

## 1. Verdict up front

This is **feasible but substantial**. The honest size estimate is **800–1 500 lines of
new code** for a version that covers the syntax real documents use, plus tests. It is
not a configuration change and it is not a small patch: `tikzcd` is a *graphics*
language, and nothing in MathJax or in Eukolia draws arbitrary arrows between laid-out
cells today.

Three things make it tractable, and all three are verified in §2:

* the extension API is present and usable — MathJax exposes `window.MathJax._…` to
  extension files, and `\require{tikzcd}` resolves to a file path Eukolia controls;
* the loader that fetches a required package is disabled by a single config line, not
  absent;
* a **worked prior example ships in the bundle**: `amscd`, which is the same kind of
  extension (a commutative-diagram language) at a smaller scale. It is the model to
  copy, and reading it first will save a day.

A **staged** deliverable is strongly recommended (§5). A useful first stage — one row,
`\ar[r]`-class arrows, labels — is roughly a day's work for a competent agent, renders
the diagram in the motivating document, and is worth merging on its own.

---

## 2. Established facts

Do not re-derive these; each one cost time to establish. Verify any that a change
would invalidate.

### 2.1 Environment

| | |
| --- | --- |
| MathJax | **4.1.3**, vendored at `public/mathjax/` (`tex-svg.js` holds the version string) |
| npm package present | `node_modules/mathjax@4.1.3` — but it contains **no `tikzcd`** |
| Official Tex extensions vendored | **41 files** in `public/mathjax/input/tex/extensions/`, including `ams.js`, `mathtools.js`, `physics.js`, `mhchem.js`, `amscd.js`, `require.js`, `autoload.js` |
| `tikzcd` anywhere on the machine | **no.** Not vendored, not in `node_modules`, and the string `tikzcd` appears **zero times** in `tex-svg.js` |
| npm package `mathjax-tikzcd` | does not exist (registry returns 404) |
| Content-Security-Policy | **none** — no `script-src` restriction, so a dynamically loaded extension file is not blocked |

`tikzcd` is a **third-party** extension, not part of MathJax's distribution
([MathJax third-party extensions](https://docs.mathjax.org/en/v2.7-latest/options/ThirdParty.html)).
There is no upstream 4.x build to vendor, so this is a port, not an install.

### 2.2 How a third-party extension loads

Read from the vendored `public/mathjax/input/tex/extensions/require.js`:

* It is a webpack UMD bundle. It reaches MathJax's internals through
  `window.MathJax._`, which the bundle assigns. An extension imports from there.
* `\require{name}` in TeX loads `"[mathjax]/input/tex/extensions/" + name + ".js"`,
  so **a file dropped at `public/mathjax/input/tex/extensions/tikzcd.js` is reachable
  with no path configuration at all**.
* There is a `retry` mechanism (`MathJax.loader` `retryAfter`), so a multi-file
  package whose parts depend on each other is supported.
* `\require` is governed by `tex.require.allow`, and **`require` itself is disabled in
  Eukolia's configuration** (see §4.1). Both have to change.

### 2.3 The API an extension imports

Exact names available on `window.MathJax._`, gathered from the imports of the
extensions that ship in this bundle:

```
components.global        components.loader       components.package    components.startup
input.tex.Configuration            input.tex.HandlerTypes
input.tex.ParseMethods.default     input.tex.ParseUtil
input.tex.TexParser.default        input.tex.TexConstants.TexConstant
input.tex.TexError.default         input.tex.TokenMap        input.tex.Token
input.tex.NodeUtil.default         input.tex.Tags
input.tex.base.BaseItems           input.tex.base.BaseMethods
input.tex.ams.AmsItems             input.tex.ams.AmsMethods.AmsMethods
input.tex.newcommand.NewcommandMethods.default
core.MmlTree.MmlNode
```

An extension exports named pieces, e.g. `cancel.js`:

```js
e.d(t, { CancelConfiguration: () => x, CancelMethods: () => g })
```

### 2.4 The nearest prior art: `amscd`

`public/mathjax/input/tex/extensions/amscd.js` is **4 310 bytes** and implements a
commutative-diagram language. Read it end to end before writing anything. What it
establishes:

* **It does not draw SVG.** It parses its own syntax and emits MathJax's *native*
  structures — `array`/`mtable` with `columnalign`, `rowspacing`, `minsize` — so
  MathJax does all layout, spacing and label typesetting. This is the pattern to
  follow, not hand-rolled SVG.
* Cells are split by a `cell` handler; arrow tokens are recognised with a character
  class (`/[><VA.|=]/`); labels become ordinary MathJax nodes (`\\scriptstyle\\raise…`)
  beside a rule character.
* It keeps state on `stack.env` (`CD_minw`, `CD_minh`).

The difference for `tikzcd`: arrows may be **diagonal** and may **cross cells**, which
`amscd`'s rules cannot express. That is the whole of the extra work.

### 2.5 The real-world syntax surface

From the document that motivated this
(`D:\XPlace\LaTeX projects\compact-open topology\compact-open topology.tex`), the
actual usage is:

```latex
\[
\begin{tikzcd}
X\times Z \ar[r,"\,\mathrm{id}\times\hat g\,"] & X\times\cal{C}(X,Y) \ar[r,"\operatorname{ev}"] & Y
\end{tikzcd}
\]
```

One diagram; **two arrows, both `\ar[r]` in a single row, both with a quoted label**.
Writing the minimal version first would render this document's diagram completely.

For general usefulness the parser should cover, in this order:

1. `&` cell separation, `\\` row separation, braces and nested environments not split
2. `\ar[direction]`, `\arrow[direction]`
3. quoted labels: `\ar[r,"f"]`, `"f"', "f"''`, `{below}{above}` options
4. `Rightarrow`, `hookrightarrow`, `two heads`, `tail`, `no head`, `dashed`, `dotted`,
   `bend left=N`, `bend right=N`, `shift left=N`, `crossing over`
5. arrows not on a cell: `\arrow[from=1-1,to=2-2]`
6. direction strings: `r`, `l`, `u`, `d`, `dr`, `ur`, `rr`, `dd`, …
7. `\rar`, `\lar`, `\dar`, `\uar`, `\drar`, … shortcuts
8. `\arrow[r, "f", bend left]` full option lists

---

## 3. Design decision: where the implementation lives

Two viable shapes. **Take A.**

### A. A MathJax Tex extension at `[tex]/tikzcd` — recommended

Add `public/mathjax/input/tex/extensions/tikzcd.js`, enable `require`, and let the
existing pipeline typeset `tikzcd` bodies like any other mathematics.

*Why:* it is what `tikzcd` **is** — an environment the TeX parser encounters — so it
composes. Labels are typeset by MathJax in the surrounding math font and size, the
result sits correctly on the math axis, and the same code path serves Visual Mode, the
math preview (`math-preview.ts`), and equation numbering. It also removes the special
case from Eukolia's decoration code (§4.4) rather than adding to it.

*Cost:* the extension API is undocumented internals; the agent will be reading the
bundle and the vendored extensions to learn the shape.

### B. An Eukolia widget that never involves MathJax

Intercept `tikzcd` in `atomic-decorations.ts` (the hook **already exists**, §4.4),
parse the body in TypeScript, and produce an `<svg>` directly in a widget.

*Why not:* it is a **dead end for composition** — the diagram cannot participate in a
larger expression, cannot be numbered, and needs its own cache, its own typesetting for
labels, and its own integration with `math-render-cache.ts`. It duplicates everything
MathJax already does except the arrows.

The one thing B has in its favour is plain TypeScript with tests. If A's extension API
proves unusable in stage 0 (§5), fall back to B rather than fighting it.

---

## 4. Files involved

### 4.1 The configuration to change — `src/renderer/math/mathjaxService.ts`

Currently, at the second `tex: {` (line 111), the packages block is (line 148):

```ts
packages: {
  '[-]': [
    'html',       // avoid creating HTML elements/attributes
    'require',    // prevent loading disabled packages
    'textmacros'  // text macros are loaded by default in v4, disable them
  ]
},
```

Change to keep `html` and `textmacros` disabled, enable `require`, and allow the one
package:

```ts
packages: {
  '[-]': ['html', 'textmacros'],
  '[+]': ['require']
},
require: { allow: ['tikzcd'] },
```

The `require.allow` list is what makes `\require{tikzcd}` legal; its default excludes
the base packages and allows third-party names, so name it explicitly rather than
relying on the default.

### 4.2 The second configuration — `src/renderer/visual/mathjax-typesetter.ts`

**Trap: MathJax is configured in two places.** The headless path (used by tests and by
`npm run smoke`) builds its own config at the `const MathJax = await init({` on line 139:

```ts
const MathJax = await init({
  loader: { load: ['input/tex', 'output/svg'], require: mjRequire },
  tex: {
    macros: { bm: ['\\boldsymbol{#1}', 1] },
    …
  },
})
```

It has **its own `macros`** and no package list. The legacy font commands were already
missed here once for exactly this reason. Whatever is added in 4.1 must be added here
too, or the feature will work in the app and fail in every test.

### 4.3 The new file

`public/mathjax/input/tex/extensions/tikzcd.js` — the port. A single file is enough
(the loader supports more, via `retry`, if it grows worth splitting).

Suggested internal shape:

```
parse      split cells and rows; collect \arrow specs with their cell
direction  parse a direction string / from-to pair into (dx, dy)
layout     cell widths and row heights from MathJax's own array node
render     emit the mtable, then the arrows
```

Keep the parser and the direction resolver **free of MathJax imports** so they can be
unit-tested from Node without a MathJax instance. That is the single most valuable
structural decision in the port: it makes the hard part (parsing tikzcd syntax) testable
in isolation, and the untestable part (talking to MathJax) small.

### 4.4 Eukolia code that must change once diagrams render

In `src/renderer/vendor/overleaf/extensions/visual/atomic-decorations.ts`, the diversion
to a source island is at **line 929**:

```ts
if (isUnrenderableMathEnvironment(environmentName)) { … UnrenderableMathWidget … }
```

and the name it is tested with comes from `unrenderableEnvironmentIn` (line 193) and
`getUnstarredEnvironmentName`.

When diagrams render, `tikzcd` must come **out** of `UNRENDERABLE_MATH_ENVIRONMENTS` in
`src/renderer/visual/builtinPreamble.ts` (line 141, currently
`= ['tikzcd'] as const`). Keep the island path: it is still the right answer for a
document whose `tikzcd` the extension cannot parse, and for the fallback if `\require`
fails.

Files the agent will also need to read:

* `src/renderer/vendor/overleaf/extensions/visual/visual-widgets/math.ts` — the widget
  that calls the typesetter
* `src/renderer/vendor/overleaf/extensions/visual/visual-widgets/math-render-cache.ts` —
  output cache, keyed on `displayMode \0 preamble \0 math`
* `src/renderer/vendor/overleaf/extensions/visual/visual-widgets/unrenderable-math.ts` —
  the island that must stop being used for `tikzcd`
* `tests/visual/mathjax.test.ts` — headless typesetting tests, the place for unit tests
  of the extension
* `tests/visual/realDocumentDefects.test.ts` — asserts the island today; must be updated
  to assert a diagram
* `tests/smoke/fixture/homework.tex` — the fixture the end-to-end and probe runs use
* `src/main/visualProbe.ts`, `scripts/probe-visual.mjs` — the measurement harness

---

## 5. Staged plan

Each stage is independently verifiable and mergeable. **Do not start stage N+1 before
stage N's acceptance test passes.**

### Stage 0 — prove the loading path (do this first; it is the risk)

Nothing works if this does not. ~1 hour.

1. Create `public/mathjax/input/tex/extensions/tikzcd.js` as a **stub** that registers a
   configuration and defines one trivial macro (e.g. `\tikzcdtest` expanding to a
   visible symbol).
2. Make the two config changes in §4.1 and §4.2.
3. Assert that `$\require{tikzcd}\tikzcdtest$` typesets to real output.

**Acceptance:** a test in `tests/visual/mathjax.test.ts` that typesets
`\require{tikzcd}` + the stub macro and gets SVG containing path data, with no
`data-mjx-error`. **If this cannot be made to work, stop and report — do not proceed to
stage 1**, because everything after it assumes it.

### Stage 1 — grid and labels, no arrows

Parse cells and rows; emit a MathJax `array`/`mtable` with `columnalign: center`, like
`amscd` does. Arrows are parsed but ignored.

**Acceptance:** unit tests over the parser (cells, rows, nested braces, nested
environments, quoted labels preserved verbatim) and one typesetting test that
`\begin{tikzcd} A & B \\ C & D \end{tikzcd}` produces a 2×2 grid with the four letters.

### Stage 2 — straight arrows with labels

`\ar[r]`-class arrows (single-step in one of eight directions), `\arrow[direction]`, and
quoted labels placed on the arrow's outer side. This is the stage that renders the
motivating document.

**Acceptance:** the diagram in §2.5 renders with both `\ar[r]` arrows and both labels.
A test asserts arrow geometry (start/end within the source and target cell boxes) and
that each label's text appears in the output.

### Stage 3 — the common option set

Arrowheads and styles (`Rightarrow`, `hookrightarrow`, `two heads`, `tail`, `no head`,
`dashed`, `dotted`), `bend left/right`, `shift left/right`, `crossing over`.

**Acceptance:** one test per option, asserting at least that it parses, renders without
error, and changes the output from the default.

### Stage 4 — arrows off the cell, and shortcuts

`\arrow[from=1-1,to=2-2]`, the `\rar`/`\dar`/`\drar` family, multi-step directions
(`rr`, `dd`).

**Acceptance:** a test per form.

### Stage 5 — integration and cleanup

* Remove `tikzcd` from `UNRENDERABLE_MATH_ENVIRONMENTS`.
* Extend the smoke fixture and the probe fixture with a diagram.
* Update `tests/visual/realDocumentDefects.test.ts` to assert a **diagram**, not an island.
* Keep the island as the fallback when the extension is unavailable or fails to parse.

**Acceptance:** the full commands in §7 all pass, and the probe on the real project
reports a diagram for line 44 rather than an island.

---

## 6. The extension's contract

Write this down before implementing; it is the interface the tests will use.

### Registration

Export a configuration in the webpack UMD shape the other extensions use, registered as
`[tex]/tikzcd`, with the environment `tikzcd` handled by a macro/environment handler.
Model the file on `amscd.js` and `cancel.js` — read both.

### Parser output (keep this MathJax-free)

```ts
type Cell = { row: number; column: number; content: string }
type ArrowSpec = {
  from: { row: number; column: number } | null   // null ⇒ the cell it is written on
  host: { row: number; column: number } | null   // the cell the \arrow appears in
  direction: string | null                       // 'r', 'dr', … when shorthand
  to: { row: number; column: number } | null     // explicit from=/to=
  labels: string[]                               // raw TeX, in order
  options: Record<string, string | true>         // bend left=30, Rightarrow, …
}
parse(body: string): { cells: Cell[]; arrows: ArrowSpec[]; rows: number; columns: number }
```

### Rendering

Emit the grid as MathJax's own array node (so cell sizes, spacing and label typesetting
come from MathJax), then draw each arrow as an SVG element positioned from the resolved
cell geometry. Arrow endpoints are cell edges, not cell centres. Labels are typeset as
inline mathematics through `AmsMethods`/`TexParser` and placed perpendicular to the
arrow direction — except a vertical arrow, where a quoted label conventionally sits to
the right and `"f"`/`"f"'` choose which side.

### Failure

An unparseable body must **not** throw a MathJax error box and must **not** hang. Emit
`data-mjx-error` with a short message so the caller can fall back — or better, emit the
source as `\text{}` so a reader sees their own diagram. **Return, never hang:** the
previous attempt at this feature hung for 300 s (§8).

---

## 7. Acceptance criteria — the commands that must pass

```bash
npm run typecheck                       # 0 errors
npx vitest run                          # whole suite; expect ~1800 tests
npx vitest run tests/visual/mathjax.test.ts tests/visual/realDocumentDefects.test.ts
npx vite build                          # renderer + main
node scripts/probe-visual.mjs           # fixture run, exit 0
$env:EUKOLIA_PROBE_DOCUMENT="D:\XPlace\LaTeX projects\compact-open topology\compact-open topology.tex"
node scripts/probe-visual.mjs           # real-project run, exit 0
```

And, in the real-project report:

* `tikzcdInspection.islands` is **0** and a diagram widget is present in its place;
* `renderSweep.totals.mathErrors`, `.mjxErrors` are **0**;
* the diagram region is **not** an `.ol-cm-unrenderable-math`.

The probe's `renderShots` writes a PNG per measured region — **look at the picture**.
Every wrong answer in this area's history passed a programmatic check.

---

## 8. Traps, each of which cost real time here

1. **MathJax hangs on a `tikzcd` body; it does not error.** `tex2svgPromise` neither
   resolved nor rejected in 300 s. A widget that asks for it is an element that is
   **never filled** — no diagram, no error box, no source, nothing — and because the
   promise never settles, the `.finally` that re-measures the caret never runs either.
   **Whatever the port does, it must always settle.**
2. **`mathAncestorNode` returns the wrong node for the common shape.** For a `tikzcd`
   inside `\[…\]`, it returns the **`BracketMath` of the brackets**, not the
   `$Environment`, because the port's ancestor search stops at the first
   `$MathContainer`. Any code that asks "which environment is this" must handle that: the
   environment name is readable from the content.
3. **The content handed over still carries the delimiters' whitespace** — measured,
   `" \begin{tikzcd} … \end{tikzcd} "`. A pattern anchored with `^` matches nothing.
4. **`$MathContainer` is a lezer *alias*, not a node name.** The tree reports
   `DollarMath`, `ParenMath`, `BracketMath`, `Environment`. Use `type.is()`, never a
   name comparison. This exact mistake silently disabled mathematics-source revelation
   once.
5. **A widget is not a rendering.** `hasSvg: false, paths: 0, textNodes: 0` was reported
   as "rendered" three times by three different checks. Ask what is **in** the element.
6. **A widget outside CodeMirror's viewport has no element at all.** Any check must
   scroll the region into view first, and can read stale geometry if it does not.
7. **The macro preamble must not contain TeX primitives.** `\let\cal\relax` in a project
   macro file reached MathJax as that literal text and painted `\cal` red 38 times;
   `composeMacroPreamble` now filters primitives. A label containing `\let` will do the
   same thing.
8. **Two MathJax configurations** — §4.2. Test-side failures with a working app are the
   signature.
9. **This machine's measurements vary a lot.** Performance numbers from one run are not
   evidence: interleave configurations, pin the starting state, run three times. Two
   optimisation attempts here were accepted on a single reading and were wrong.
10. **`node_modules/@codemirror/view` and the vendored bundle are read-only references.**
    Do not edit them. The extension is a *new file* that registers itself.

---

## 9. If the port turns out not to be worth it

A fallback that needs no porting: use the PDF. `\usepackage{tikz-cd}` compiles the
diagram into the PDF the viewer is already showing, beside the editor, with SyncTeX
wired up. A reader who wants the picture has it. That is what the application already
does for every construct Eukolia cannot draw, and the island explains itself.

Record the outcome either way in `ARCHITECTURE.md` §3.25, which currently explains why
`tikzcd` is an island and why three checks said otherwise.
