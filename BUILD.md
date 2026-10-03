# Building a document in Eukolia

This is the guide to the build: what a recipe is, what a tool is, which ones
Eukolia ships, what the settings do, how the PDF is found, and what the bottom
bar says when a build fails. `SNIPPETS.md` does the same job for the snippet
library; this is its counterpart for compilation.

The short version: **a recipe names tools, a tool is one command line, and the
command line is what runs.** Everything in the build is one of those three
things, which is why the picker, the settings and the failure report can be
checked against each other mechanically.

---

## 1. The model

```
recipe         "pdflatex -> bibtex -> pdflatex * 2"
  └── tool     pdflatex      (command + arguments + environment)
  └── tool     bibtex
  └── tool     pdflatex
  └── tool     pdflatex
                └── step    `pdflatex -synctex=1 -interaction=nonstopmode … %DOC%`
```

- A **recipe** is an ordered list of tool *names*. Order matters: the bibliography
  tool has to run between two TeX passes, or the `.bbl` it writes is never read.
- A **tool** is a name for one command line: `{ name, command, args, env?, cwd? }`.
  Argument placeholders are expanded just before the build starts (§4).
- A **step** is a tool after expansion and after Eukolia's own adapter has had its
  say (§5) — the single, concrete `command`/`args`/`env`/`shell` the main process
  spawns. The renderer never spawns anything; the main process never decides
  anything (`src/main/ipc/compilerHandler.ts` only executes).

The resolution is the **ported LaTeX Workshop code**: `recipe.ts`, `plan.ts` and
`step.ts` under `src/renderer/vendor/latex-workshop/compile/`, wired by
`src/renderer/compiler/buildRequest.ts`. Magic comments (`% !TeX program`,
`% !BIB program`, `% !LW recipe`, `% !TeX options`), the recipe lookup order
(explicit name → last used → the first compatible one) and the flag spellings are
the reference's, unchanged.

## 2. The catalogue — where recipes and tools are written down

`src/renderer/compiler/recipeCatalog.ts` is the single source of truth, and it
holds three things: `RECIPE_CATALOG`, `TOOL_CATALOG`, and `ENGINE_RECIPES` (which
recipe each `compilation.engine` value means).

**Why a catalogue and not a list beside the resolver.** The recipe picker used to
keep its own list of names — `pdflatex`, `xelatex`, `pdflatex ➞ bibtex ➞
pdflatex ×2` — while the resolver read `latex.recipes` from the ported settings.
Six of those seven names matched no recipe: choosing one produced

```
[Builder] Failed to resolve build recipe: pdflatex.
```

and no PDF, because `pdflatex` is a *tool* in the reference's configuration, not a
recipe. Nothing on screen said which of the two lists was wrong.

Now the bridge hands the resolver the catalogue (`latex.recipes`, `latex.tools`),
and the picker lists **the effective setting read back** — so a name the resolver
would reject cannot be offered, and a recipe a user adds through the advanced
settings file is listed too. `tests/latex-workshop/recipeCatalog.test.ts` pins the
invariants: every recipe names tools that exist, every tool's command is probed
on `PATH`, every engine maps to a recipe that exists.

### The recipes

| Recipe | Tools | Notes |
| --- | --- | --- |
| `latexmk` | latexmk | The default. Runs the bibliography and cross-reference passes itself. |
| `latexmk (xelatex)` | latexmk `-xelatex` | XeLaTeX through latexmk: the same dependency handling, a different engine. |
| `latexmk (lualatex)` | latexmk `-lualatex` | LuaLaTeX through latexmk. |
| `latexmk (latexmkrc)` | latexmk | For a project with its own `.latexmkrc`, which decides the engine itself. |
| `pdflatex` | pdflatex | One pass. No bibliography, no second pass for references. |
| `pdflatex -> bibtex -> pdflatex * 2` | pdflatex, bibtex, pdflatex, pdflatex | BibTeX with `\bibliography`/`\bibliographystyle`. |
| `xelatex` | xelatex | One pass, Unicode fonts. |
| `xelatex -> bibtex -> xelatex * 2` | xelatex, bibtex, xelatex, xelatex | As above, with xelatex. |
| `lualatex` | lualatex | One pass, LuaTeX. |
| `lualatex -> biber -> lualatex * 2` | lualatex, biber, lualatex, lualatex | For `biblatex` + biber. **Not** interchangeable with the BibTeX recipes: `biblatex` must not be used with `\bibliography`, and `\bibliography` documents must not use biber. |
| `tectonic` | tectonic | Single-binary engine; only offered when `tectonic` is on `PATH`. |

Names are LaTeX Workshop's own, so an existing `% !LW recipe = pdflatex -> bibtex
-> pdflatex * 2` magic comment and a `.vscode/settings.json` written for that
extension keep working. The three weave recipes of the reference (`Compile Rnw
files`, `Compile Jnw files`, `Compile Pnw files`) are deliberately absent: they
run `Rscript`, `julia` or `pweave`, none of which Eukolia detects or supports. A
user who wants one can add it through the advanced settings file.

## 3. The LaTeX dependencies

A build needs a TeX distribution on `PATH`. Eukolia does not ship one and does not
bundle one; it detects what is installed and says what is missing.

| Command | Needed by | Complete without? |
| --- | --- | --- |
| `pdflatex` | `pdflatex`, the BibTeX recipes, `latexmk`'s default engine | no |
| `xelatex` | `xelatex`, `latexmk (xelatex)` | no |
| `lualatex` | `lualatex`, the biber recipe | no |
| `latexmk` | every `latexmk` recipe and the default | no |
| `bibtex` | `pdflatex -> bibtex -> pdflatex * 2`, the xelatex BibTeX recipe | only for documents with a BibTeX bibliography |
| `biber` | `lualatex -> biber -> lualatex * 2` | only for `biblatex` documents |
| `tectonic` | `tectonic` | yes — the recipe is offered, and says the command is missing |
| `makeindex`, `synctex` | indexes and SyncTeX jumps | yes |

Detection runs once at startup and again on demand (`LaTeX: Detect TeX
Distribution`, or the `TeX` indicator in the status bar). One probe answers two
questions: the status bar's `TeX ✓ / TeX ✗ / TeX n missing` summary, and whether
each recipe in the picker can run at all. A recipe whose tools are missing is
still offered and marked `missing: <command>` — the alternative, hiding it, is a
name nobody can ask about.

MiKTeX is detected from `pdflatex --version`. It is what adds
`--max-print-line=10000` to the command line, so long error lines are not wrapped
by the compiler before the log parser reads them.

**A distribution the application cannot see.** `Advanced → TeX distribution bin
directory` (`advanced.texPath`) is searched before `PATH` — for detection *and*
for every build step, so a recipe is marked runnable exactly when the build would
find its command. It is prepended rather than substituted, because the tools a
build needs are not all TeX (`latexmk` is a Perl script on some installations, and
MiKTeX's helpers live outside its bin directory).

## 4. Placeholders

Expanded by the ported `replaceArgumentPlaceholders`, against the root file:

| Placeholder | Means |
| --- | --- |
| `%DOC%` | absolute path of the root document, without extension |
| `%DOCFILE%` | the root document's file name, without extension |
| `%DOC_EXT%`, `%DOCFILE_EXT%` | with the extension |
| `%DIR%` | the root document's directory |
| `%OUTDIR%`, `%AUXDIR%` | where output and auxiliary files go (default `%DIR%`) |
| `%TMPDIR%` | a temporary directory |
| `%WORKSPACE_FOLDER%`, `%RELATIVE_*%` | the project directory and relative paths |

## 5. What the settings do

| Setting | Effect |
| --- | --- |
| `compilation.recipe` | The recipe to build with. `default` means "the engine below". |
| `compilation.engine` | Which engine `default` resolves to: `pdflatex`, `xelatex`, `lualatex`, `latexmk` or `tectonic` — each is also a recipe name, so the mapping is an identity. |
| `compilation.synctex` | Keeps or removes `-synctex=1` (tectonic's `--synctex` is kept or removed with it). SyncTeX data is what source ↔ PDF jumps need. |
| `compilation.extraArgs` | Appended to every TeX-family command line (`pdflatex`, `xelatex`, `lualatex`, `latexmk`, `tectonic`) before the document argument — e.g. `-shell-escape`. |
| `compilation.latexmk.minimumRule` | Adds `-g` to the `latexmk` recipes: every rule runs whether or not latexmk thinks it is out of date. Off by default — latexmk's own check is what makes an unchanged document build in a fraction of a second — and the Rebuild command forces one build without changing it. |
| `compilation.outputDirectory` | Where output goes. Empty means beside the source. A relative value is resolved against the project directory. |
| `compilation.cleanExtensions` | The extensions `LaTeX: Clean Auxiliary Files` removes. The default list lives in `shared/cleanExtensions.ts`, where the main process that deletes the files reads it too — two lists is how `.xdv`, `.dvi` and the glossary family came to survive a clean. |
| `compilation.cleanAfterFailedBuild` | Cleans the auxiliary files after a failed build. |
| `compilation.autoBuild`, `compilation.autoBuildDelayMs` | Build on save, after that delay. |
| `compilation.maxLogLines` | How many lines of the compiler log the Output view renders; the panel says how many it left out. |

Every one of these is live. That is worth stating because six of them were not:
`compilation.engine` was read by the status bar and nothing else,
`compilation.extraArgs` was bridged to a key no ported code reads,
`compilation.synctex` likewise, `compilation.latexmk.minimumRule` and
`compilation.maxLogLines` were read by nothing at all, and
`compilation.cleanAfterFailedBuild` was connected to a reference key Eukolia's
build path never consulted.

## 6. Where the output goes, and why it is not where the process runs

`-output-directory` moves the *files*, not the process. TeX must keep running in
the root document's directory, because that is what `\input{chapters/one}` and
`\includegraphics{figures/plot}` are resolved against. Two consequences:

- a relative `compilation.outputDirectory` is resolved to an absolute path
  **before** any placeholder sees it — otherwise a relative value meant
  "wherever the renderer process happens to have been started from";
- `bibtex` and `biber` are given the path to the auxiliary file in the output
  directory (`out/main`), because their entire input is the `.aux` the previous
  step wrote and they do not read `-output-directory`.

The PDF is looked for in the output directory and then beside the source, under
the job name (the root document's base name). SyncTeX data is looked for in the
same places, as `.synctex.gz` or `.synctex`.

## 7. When a build fails

The bottom bar states **exactly** what failed. There is one value behind it
(`BuildState.failure`, computed by `compiler/buildFailure.ts` from the step
results) and three places read it, so they cannot disagree:

- the **Output** view shows a failure strip: which step, the command line as it
  was launched, the exit code or the launch error, and the first error the
  compiler reported;
- the **Problems** view carries the failure as a row when the compiler reported
  no error of its own — a build that never started has no source line to blame,
  and an empty list under the word "failed" is what used to make this
  unreadable. That row has no line number, so it is deliberately not clickable;
- the **status bar** shows the failure beside the build indicator (persistently)
  and as the transient message, and its build tooltip repeats it.

The five kinds, and what they mean:

| Kind | Message | What to do |
| --- | --- | --- |
| `recipe` | `Failed to resolve build recipe: <name>.` | The name in `compilation.recipe` is not in `latex.recipes`. Pick one from the picker. |
| `launch` | `spawn <command> ENOENT` | The command is not on `PATH`. Install the distribution, or pick another recipe. |
| `exit` | `<command> exited with code <n> (step i of n)` | A compiler error — the first one is quoted after the dash, and the Problems list has the rest. |
| `timeout` | `<command> was terminated after the configured time limit` | A build that will not finish — a package installer waiting for input, or a runaway loop. |
| `output` | `The build finished but produced no main.pdf` | Every step succeeded and there is no output: usually an engine writing a `.dvi`, or a job name that does not match the document. |

A cancelled build is not a failure, and neither is a build where latexmk reported
"nothing to do" — that is the `skipped` fact the Output and Log views print.

## 8. The bottom panel

Five views, one component, one tab strip:

| View | Shows |
| --- | --- |
| Problems | Compiler diagnostics, filterable by severity and text, grouped by file. Clicking one opens the file at its line. |
| Output | The raw compiler stream, the recipe that ran, the failure strip, and the live progress of a running build. |
| Log | The same messages as the log parser read them, including the bad boxes and notes the Problems list buries. |
| Search Results | The project search hits, grouped by file. |
| Terminal | A real shell in the project directory (PTY-backed, remounted only while the panel is open). |

The panel's height is dragged from its top edge (`↑`/`↓`, `Home`/`End` for the
limits) and remembered for the session. A build that fails opens the panel on the
view that can explain it: Problems when a compiler error points at a source line,
Output when the build never got that far.

## 9. Commands

| Command | Key | What it does |
| --- | --- | --- |
| `LaTeX: Build Project` | `Ctrl+B` | Builds the detected root document. |
| `LaTeX: Build the Active File` | `Ctrl+Alt+Shift+B` | Builds the file in the editor as its own root. |
| `LaTeX: Build and View` | `Ctrl+Alt+B` | Builds, then shows the PDF pane. |
| `LaTeX: Rebuild (force every rule)` | `Ctrl+Alt+Shift+R` | Builds with every `latexmk` rule forced. |
| `LaTeX: Build with Recipe…` | `Ctrl+Shift+B` | The recipe picker. |
| `LaTeX: Stop Compilation` | — | Kills the running build and its children (biber, makeindex). |
| `LaTeX: Clean Auxiliary Files` | — | Removes `compilation.cleanExtensions` for the job. |
| `LaTeX: Clean and Build` | — | Both, in that order. |
| `LaTeX: Detect TeX Distribution` | — | Re-probes the tools and re-marks the recipes. |

## 10. Checking that it works

```bash
npm test                                       # unit and integration tests
npx vitest run tests/latex-workshop/recipeMatrix.test.ts   # every recipe, built for real
npm run build && npm run smoke                 # the whole application, end to end
```

`recipeMatrix.test.ts` is the one that answers "do all the recipes work?": it
walks `RECIPE_CATALOG`, gives each recipe the document it is for (a `.bib` file
for the bibliography recipes, a `.latexmkrc` for the latexmkrc one), resolves it
through the same adapter the application uses, and runs the steps exactly as the
main process does — with stdin closed, because MiKTeX installs a missing package
by *asking* and a prompt with an open stdin waits forever. A recipe whose tools
are not installed is reported as skipped rather than failed.

The end-to-end probe covers the wiring the tests cannot: it builds the fixture
through the real command, switches through all five panel views and asserts each
one rendered its own content, opens the recipe picker, builds with a recipe it
picked, and then builds a document that cannot compile and asserts the failure
strip states the command and its exit code.

**Seven tests fail in this checkout for reasons unrelated to the build**, so a
red `npm test` is not evidence about anything here:

| Test | Why |
| --- | --- |
| `tests/snippets/snippet_e5sqeq.test.ts`, `snippet_65hkq8.test.ts`, `apply_global_functions.test.ts` (5) | They read `D:/XPlace/snippets.json`, a path on one developer's machine. |
| `tests/pdf/viewerBehaviour.test.ts` (2) | The viewer's render path was reworked on 1 October (`newest request wins`, the interaction flags) after those two assertions were last updated on 21 September; both count render calls and compare render scales. |

`tests/latex-workshop/*` — the recipe catalogue, the recipe matrix, the failure
sentences, the build service and the request adapter — passes on its own:

```bash
npx vitest run tests/latex-workshop
```

The probe runs in a user-data directory of its own and seeds a project library
there, because the shell does not exist until a library does — without that, the
window opens on first-run setup and every step behind it reports a missing
editor. The snippets of the machine's own library are *copied* into the seeded
one, so the probe's snippet steps still type triggers that live in a real
library without any of its writes landing in the library the user works in.

A passing run reports, among the rest: the PDF and its SyncTeX data produced by
`latexmk`; eleven recipes offered with `tectonic` marked `missing: tectonic` on a
machine without it; `latexmk (xelatex)` built successfully from a picked recipe
and named as such in the panel; and, after the failing document,

```
Build failed — latexmk (broken)
latexmk exited with code 12 — Undefined control sequence.
latexmk --max-print-line=10000 -synctex=1 -interaction=nonstopmode … broken
```

with the same sentence in the status bar.

## 11. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `spawn pdflatex ENOENT` | No TeX distribution on `PATH` | Install TeX Live or MiKTeX, or set `Advanced → TeX distribution bin directory` to its `bin` folder and detect again |
| `LaTeX Error: Environment <name> undefined` for your own environments, and `Undefined control sequence` for your own macros | The file that defines them is in the project but nothing inputs it — a `\documentclass` document does not read every `.tex` file beside it | Add `\input{macros}` (or whatever the file is called) to the preamble, **before** `\begin{document}`. The Problems list points at the first use, which is where the missing file shows up |
| `Undefined control sequence` repeated at `\end{tikzcd}` (or at any `\end{…}` of an environment whose body uses `"…"` labels) | `babel` makes `"` an active shorthand for some languages — Vietnamese among them — and TikZ's quoted-label syntax (`\ar[r,"x"]`) needs it to be an ordinary character | Wrap the diagram: `\shorthandoff{"}` before it and `\shorthandon{"}` after. This is the fix TikZ's own manual recommends for `babel` |
| `Failed to resolve build recipe: X` | `compilation.recipe` names a recipe that is not in `latex.recipes` | Pick one from `LaTeX: Build with Recipe…`, or set `compilation.recipe` to `default` and choose an engine |
| The build succeeds and the PDF is empty of references | A bibliographic pass is missing | Use an `latexmk` recipe, or the `→ bibtex →` / `→ biber →` recipe that matches the document's bibliography system |
| `biber` fails with "Cannot find control file" | A biber recipe on a `\bibliography` document (or the reverse) | `biblatex` + `\addbibresource` for biber; `\bibliography` + `\bibliographystyle` for BibTeX |
| A rebuild does nothing | latexmk decided nothing was out of date | `LaTeX: Rebuild (force every rule)`, or turn on `compilation.latexmk.minimumRule` |
| No source ↔ PDF jumps | The build produced no SyncTeX data | Turn on `compilation.synctex` and rebuild |
| The Output view is cut off at the top | `compilation.maxLogLines` | Raise it; the panel says how many lines it left out |
| A build hangs and then is killed | A package installer or a `read` waiting for input | Install the package once from a terminal (`mpm --install=…`), then build again |
| `Package babel Warning: No hyphenation patterns were preloaded for the language '<x>'` | The distribution's `language.dat` has no entry for that language, so text is hyphenated with the patterns of `\language=0` | Not an error — the build is fine and only the line breaks suffer. In MiKTeX: add `<language> loadhyph-<code>.tex` to `%APPDATA%\MiKTeX\tex\generic\config\language.dat`, then `initexmf --dump`. Vietnamese is a case where the loader file may be missing from `hyph-utf8` while the patterns (`hyph-vi.tex`) are present, and the line can point straight at them |
| A stale `.xdv` (or `.dvi`) survives `LaTeX: Clean Auxiliary Files` | The cleaner's list and the setting's default disagreed — the setting stopped at `run.xml` while the cleaner also carried `xdv`, `dvi` and the glossary family | Fixed: both read `shared/cleanExtensions.ts`. A project that saved its own `compilation.cleanExtensions` keeps its saved list |
