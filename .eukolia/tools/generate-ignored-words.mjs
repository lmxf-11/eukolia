#!/usr/bin/env node
/**
 * Regenerates `FIBERED_IGNORED_WORDS` in `../globals.js` from `words.txt`.
 *
 * ## Why this file exists
 *
 * `evil_text` renders a compact expression as inline mathematics whenever you type
 * a space after it, so *every* word you type is a candidate. The words that must
 * not be rewritten — ordinary English, and anything that merely looks like the
 * shorthand — are listed in `FIBERED_IGNORED_WORDS`, and that list is derived from
 * `words.txt` rather than maintained by hand.
 *
 * The list used to be produced by `test.py`, which re-implemented the grammar in
 * Python. A second implementation of a parser is a second answer to every question
 * about it: it decides which words are dangerous using rules that can drift from
 * the rules the editor actually runs. This script asks the real thing instead — it
 * loads `../globals.js` and calls `renderMultiFiberedText`, the same function the
 * snippet's body calls, through the same trigger pattern the editor compiles.
 *
 * ## What counts as dangerous
 *
 * A word is dangerous when typing it and then a space would rewrite it. That is
 * exactly `renderMultiFiberedText(match) !== preserveFiberedInput(match)` — the
 * rejection path the snippet uses to leave text alone. The list is keyed on the
 * **lower-cased** candidate, because `shouldIgnoreFiberedInput` lower-cases before
 * it looks a word up: that is why a spelling whose capitalised form is a function
 * call (``Hi`` → ``\H(i)``) is protected by adding ``hi``, and why adding it also
 * protects ``HI``.
 *
 * ## Usage
 *
 *     node tools/generate-ignored-words.mjs            # rewrite globals.js
 *     node tools/generate-ignored-words.mjs --check    # report only, exit 1 if stale
 *
 * The words are written into `globals.js` between the two marker comments, so the
 * rest of that file is untouched and the block can be regenerated at any time.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const globalsPath = path.join(root, 'globals.js')
const snippetsPath = path.join(root, 'snippets.json')
const wordsPath = path.join(here, 'words.txt')

const BEGIN = '// >>> FIBERED_IGNORED_WORDS'
const END = '// <<< FIBERED_IGNORED_WORDS'
const IDENTIFIER = 'FIBERED_IGNORED_WORDS'
/** How many entries per line in the generated block. */
const PER_LINE = 8

/* --------------------------------------------------------------- the real code */

const globalsSource = fs.readFileSync(globalsPath, 'utf8')
const globals = new Function(
  `${globalsSource}
   return { renderMultiFiberedText, preserveFiberedInput, FIBERED_IGNORED_WORDS };`
)()

/**
 * The list under construction must not be consulted while it is being decided.
 *
 * `renderMultiFiberedText` rejects a candidate that is already in
 * `FIBERED_IGNORED_WORDS`, so sweeping with the current list in place asks "is this
 * word *still* dangerous?" and answers no for every word the list already guards —
 * the list would shrink to nothing on the first run and report success. Emptying it
 * first is what makes the sweep ask the real question: would this word be rewritten
 * if nothing guarded it?
 */
globals.FIBERED_IGNORED_WORDS.clear()

const snippets = JSON.parse(fs.readFileSync(snippetsPath, 'utf8'))
const evil = snippets.snippets.find((snippet) => snippet.id === 'evil_text')
if (!evil) throw new Error('evil_text is missing from snippets.json')

/** The engine appends `$` to a pattern that does not end in an unescaped one. */
function anchor(pattern) {
  if (!pattern.endsWith('$')) return `${pattern}$`
  let backslashes = 0
  for (let i = pattern.length - 2; i >= 0 && pattern[i] === '\\'; i -= 1) backslashes += 1
  return backslashes % 2 === 1 ? `${pattern}$` : pattern
}

const trigger = new RegExp(anchor(evil.trigger.pattern), `m${evil.trigger.flags ?? ''}`)

/**
 * Whether typing `line` and stopping would rewrite the candidate.
 *
 * `line` must end at the caret. Returns the candidate the snippet would be handed,
 * or `null` when the trigger does not match this line at all.
 */
function rewriteCandidate(line) {
  trigger.lastIndex = 0
  const match = trigger.exec(line)
  if (!match || match[0].length === 0) return null
  const candidate = match[3] ?? match[1]
  if (typeof candidate !== 'string' || candidate.length === 0) return null
  const rendered = globals.renderMultiFiberedText(match)
  return rendered === globals.preserveFiberedInput(match) ? null : candidate
}

/* ---------------------------------------------------------------- the dictionary */

const words = fs
  .readFileSync(wordsPath, 'utf8')
  .split('\n')
  .map((word) => word.trim())
  .filter(Boolean)

/**
 * Every shape a typed word can arrive in.
 *
 * The candidate the trigger captures depends on what follows the word, because the
 * trigger fires on the character *after* it: a bare space, a comma, a full stop, a
 * semicolon, or a hyphen. Two prefixes are tried so the leading group is exercised
 * in both of its forms. A decision made here is the most permissive case — a word
 * inside `\text{…}` is suppressed by `isFiberedProtectedContext` — so a word that
 * is not dangerous in any of these lines is not dangerous at all.
 */
const shapesOf = (word) => [
  `${word} `,
  `${word}, `,
  `${word}. `,
  `${word}; `,
  `${word}- `,
  `the ${word} `,
  `a ${word}, `,
  `We ${word}. `,
  `x ${word}; `,
  `A ${word}- `,
]

/* ------------------------------------------------------------------- the sweep */

const needed = new Set()
const dangerousWords = []

for (const word of words) {
  let dangerous = false
  for (const line of shapesOf(word)) {
    const candidate = rewriteCandidate(line)
    if (candidate === null) continue
    dangerous = true
    // Only the word's own spelling is recorded. A candidate that merely *starts*
    // with it — `x-` for `x` — is a punctuation shape, not a word, and belongs to
    // a different question than "which English words must be left alone".
    if (candidate.toLowerCase() === word.toLowerCase()) needed.add(word.toLowerCase())
  }
  if (dangerous) dangerousWords.push(word)
}

/* ------------------------------------------------------------- the generated block */

const sorted = [...needed].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const lines = []
for (let i = 0; i < sorted.length; i += PER_LINE) {
  lines.push(`  ${sorted.slice(i, i + PER_LINE).map((word) => `'${word.replace(/'/g, "\\'")}'`).join(', ')},`)
}
// The trailing comma on the last line is dropped so the block reads normally.
const last = lines.length - 1
if (last >= 0) lines[last] = lines[last].replace(/,$/, '')
const block = [
  BEGIN,
  '// Generated by tools/generate-ignored-words.mjs — do not edit by hand.',
  `// ${sorted.length} words from tools/words.txt that \`evil_text\` would otherwise`,
  '// rewrite. Keyed on the lower-cased candidate, which is what',
  '// `shouldIgnoreFiberedInput` looks up.',
  `const ${IDENTIFIER} = new Set([`,
  ...lines,
  ']);',
  END,
].join('\n')

/* ------------------------------------------------------------------- rewrite */

const start = globalsSource.indexOf(BEGIN)
const end = globalsSource.indexOf(END)
if (start < 0 || end < 0) {
  throw new Error(
    `globals.js does not contain the ${BEGIN} … ${END} markers; add them around the\n` +
      'existing `FIBERED_IGNORED_WORDS` declaration before running this script.'
  )
}

const existingBlock = globalsSource.slice(start, end + END.length)
const next = `${globalsSource.slice(0, start)}${block}${globalsSource.slice(end + END.length)}`

const previous = /const FIBERED_IGNORED_WORDS = new Set\(\[([\s\S]*?)\]\)/.exec(existingBlock)
const previousWords = previous
  ? new Set([...previous[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'")))
  : new Set()

const added = sorted.filter((word) => !previousWords.has(word))
const removed = [...previousWords].filter((word) => !needed.has(word))

const check = process.argv.includes('--check')
const stale = next !== globalsSource

console.log(`dictionary        ${words.length} lines`)
console.log(`dangerous         ${dangerousWords.length} spellings rewrite if typed`)
console.log(`ignore list       ${previousWords.size} -> ${sorted.length} (`+
  `${added.length} added, ${removed.length} removed)`)
if (added.length) console.log(`  added           ${added.slice(0, 40).join(', ')}${added.length > 40 ? ' …' : ''}`)
if (removed.length) console.log(`  removed         ${removed.slice(0, 20).join(', ')}${removed.length > 20 ? ' …' : ''}`)

if (check) {
  console.log(stale ? 'STALE: run without --check to rewrite globals.js' : 'up to date')
  process.exit(stale ? 1 : 0)
}

if (!stale) {
  console.log('globals.js is already up to date')
} else {
  fs.writeFileSync(globalsPath, next, 'utf8')
  console.log(`rewrote ${path.relative(process.cwd(), globalsPath)}`)
}

/* -------------------------------------------------------------- verification */

/*
 * The rewritten list is loaded back and the sweep is run again with it in place.
 *
 * The invariant is not "nothing is rewritten": a candidate that is a word plus
 * punctuation (`x-` from `x`) is a different question from "which English words
 * must be left alone", and the list deliberately answers only the second. What must
 * hold is that no candidate **which is a dictionary spelling** is still rewritten —
 * that is exactly what the list is for, and it is the check that catches a missing
 * entry, a syntax error in the block, or an entry written in the wrong case.
 */
const verifiedSource = fs.readFileSync(globalsPath, 'utf8')
const verified = new Function(
  `${verifiedSource}
   return { FIBERED_IGNORED_WORDS, shouldIgnoreFiberedInput, renderMultiFiberedText, preserveFiberedInput };`
)()

const spelled = new Set(words.map((word) => word.toLowerCase()))
let unguarded = 0
let shapeOnly = 0
for (const word of words) {
  for (const line of shapesOf(word)) {
    trigger.lastIndex = 0
    const match = trigger.exec(line)
    if (!match || match[0].length === 0) continue
    const candidate = match[3] ?? match[1]
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    if (verified.renderMultiFiberedText(match) === verified.preserveFiberedInput(match)) continue
    if (candidate.toLowerCase() === word.toLowerCase()) {
      unguarded += 1
      if (unguarded <= 10) console.log(`  UNGUARDED ${JSON.stringify(word)} as ${JSON.stringify(candidate)}`)
    } else if (spelled.has(candidate.toLowerCase())) {
      unguarded += 1
      if (unguarded <= 10) console.log(`  UNGUARDED ${JSON.stringify(candidate)} (typed as ${JSON.stringify(word)})`)
    } else {
      shapeOnly += 1
    }
  }
}
console.log(
  unguarded === 0
    ? `verified: every dangerous spelling is guarded (${verified.FIBERED_IGNORED_WORDS.size} entries)`
    : `verified: ${unguarded} dangerous spellings are NOT guarded`
)
if (shapeOnly > 0) {
  console.log(
    `not covered by design: ${shapeOnly} candidates that are a word plus punctuation ` +
      '(e.g. `x-`), which this list does not name'
  )
}
process.exit(unguarded === 0 ? 0 : 1)
