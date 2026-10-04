# tools

The ignore list behind `evil_text` is **generated**, not hand-written. This folder
holds the generator and its input.

| file | what it is |
| --- | --- |
| `words.txt` | 195 130 English spellings (lower and capitalised), the raw material for the ignore list |
| `generate-ignored-words.mjs` | derives `FIBERED_IGNORED_WORDS` from `words.txt` and rewrites it in `../globals.js` |

## Why the list exists

`evil_text` turns a compact expression into inline mathematics whenever a space
follows it, so *every* word you type is a candidate: `XtoY` becomes `$X\to Y$`,
which is the point, and `sin` would become `$\sin()$` and `spin` something worse,
which is not. `FIBERED_IGNORED_WORDS` names the spellings that must be left alone.

Two details of that list are easy to get wrong by hand:

* **It is keyed on the lower-cased candidate.** `shouldIgnoreFiberedInput` lower-
  cases before looking a word up, so the entry that protects `Hi` and `HI` is `hi`.
  A list of the forms as typed would miss every capitalised word whose lower-case
  form is not itself listed.
* **It is decided by the real parser.** `test.py` used to re-implement the compact
  grammar in Python, which is a second answer to every question about it: the two
  can disagree, and the disagreement shows up as prose being rewritten. The
  generator loads `../globals.js` and calls `renderMultiFiberedText` — the function
  the snippet's own body calls — through the trigger pattern the editor compiles.

## Regenerating

```sh
node tools/generate-ignored-words.mjs          # rewrite globals.js
node tools/generate-ignored-words.mjs --check   # report only; exit 1 if stale
```

It prints what it added and removed, and then verifies its own output: the rewritten
list is loaded back and every dangerous spelling in `words.txt` is re-tested. A
missing entry, a syntax error in the block, or an entry written in the wrong case
fails the run rather than reaching the editor.

The block lives between two marker comments in `globals.js`; everything else in that
file is untouched, and the surrounding code (`shouldIgnoreFiberedInput`,
`FIBERED_IGNORED_INPUTS`, the parser) is not generated.

## Adding a word by hand

Add it to `FIBERED_IGNORED_INPUTS` in `globals.js` instead — it is checked
case-sensitively and is not regenerated, which is what makes it the right place for
a spelling that is not in `words.txt` (an abbreviation, a symbol, a name).
