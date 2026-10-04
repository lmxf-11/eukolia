/**
 * Eukolia — Mathematical Symbols catalog generator.
 *
 * Normalises Eukolia's bundled mathematical-symbol sources into
 * `src/renderer/mathSymbols/catalog.generated.json`, and writes an accounting
 * manifest beside it.  Run with:
 *
 *     npm run build:math-symbols
 *
 * Three sources feed the catalog, and they are not interchangeable:
 *
 *  1. **MathJax's TeX symbol maps** (`mathjax-full`, Apache-2.0), read from the
 *     installed package rather than copied.  These carry the *base* mathematics
 *     every LaTeX document has — `\alpha`, `\rightarrow`, `\sum`, `\sin`,
 *     `\mathbb`, `\hat` — together with the glyph MathJax typesets and the map
 *     the command came from.  The map is what attributes a command to a LaTeX
 *     package; see `curated/packages.json`.
 *  2. **`src/renderer/data/latex-workshop/unimathsymbols.json`** (LaTeX
 *     Workshop, MIT) — 2 415 *extended* Unicode mathematics commands, most of
 *     which are not in base LaTeX and name the package that provides them in
 *     their free-text `detail`.  That text is a hint, not an authority.
 *  3. **The curated files** in `src/renderer/mathSymbols/curated/` — reviewed
 *     metadata: package attribution, structured templates with real argument
 *     slots, category overrides, and the explicit exclusion list.
 *
 * The manifest exists because "complete" has to be checkable.  Every upstream
 * record is either emitted, merged into another record, or listed in
 * `excluded` with a reason; `verifyCatalog` fails the run on an unexplained
 * omission, a duplicate id, a malformed command, an unknown category, or a
 * template whose slots do not line up.
 *
 * The output is deterministic: no timestamps, no hash of the environment, and
 * every list sorted by a stable key, so regenerating an unchanged catalog
 * produces byte-identical JSON.
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const outDir = path.join(repo, 'src/renderer/mathSymbols')
const curatedDir = path.join(outDir, 'curated')
const unimathsymbolsPath = path.join(
  repo,
  'src/renderer/data/latex-workshop/unimathsymbols.json'
)

/* ------------------------------------------------------------------ *
 * Categories
 *
 * The catalog's own classification.  `project-macros`, `favorites` and
 * `recent` from the panel's selector are *views* over the catalog rather
 * than tags on a record, so they are not listed here.
 * ------------------------------------------------------------------ */

const CATEGORIES = [
  'greek',
  'arrows',
  'relations',
  'binary-operators',
  'large-operators',
  'functions',
  'logic-sets',
  'delimiters',
  'accents',
  'alphabets',
  'miscellaneous',
  'templates'
]

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

const packagesJson = readJson(path.join(curatedDir, 'packages.json'))
const overridesJson = readJson(path.join(curatedDir, 'overrides.json'))
const templatesJson = readJson(path.join(curatedDir, 'templates.json'))
const upstream = readJson(unimathsymbolsPath)

/**
 * The MathJax symbol maps, as registered by MathJax's own mapping modules.
 *
 * `MapHandler.register` is wrapped *before* the modules are loaded, because
 * MathJax offers no way to enumerate what was registered — the maps register
 * themselves as a side effect of being imported.  That side effect is the
 * mature implementation doing the work; nothing here re-reads or re-parses
 * MathJax's source.
 *
 * **Both** `*Mappings.js` and `*Configuration.js` are loaded, and the second
 * group is not optional. About half of MathJax's TeX extensions — `cancel`,
 * `upgreek`, `gensymb`, `mhchem`, `boldsymbol`, `color`, `enclose`, `extpfeil`
 * and more — have no separate mappings module and declare their symbol maps
 * inline in their configuration. Loading only the mappings modules silently
 * loses every command those packages provide: `\cancel`, `\ce`, `\upalpha`,
 * `\bm` and `\degree` were all absent from an earlier run of this script for
 * exactly that reason.
 *
 * A configuration that will not load outside a full MathJax document is recorded
 * as a warning rather than failing the run, so the catalog states what it could
 * not read instead of quietly shrinking.
 */
function loadMathJaxMaps() {
  const require = createRequire(import.meta.url)
  const texDir = path.dirname(require.resolve('mathjax-full/js/input/tex/MapHandler.js'))
  const { MapHandler } = require('mathjax-full/js/input/tex/MapHandler.js')
  const readdir = require('node:fs').readdirSync

  const registry = new Map()
  const register = MapHandler.register
  MapHandler.register = (map) => {
    registry.set(map.name, map)
    return register(map)
  }

  const mappings = []
  const configurations = []
  for (const entry of readdir(texDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of readdir(path.join(texDir, entry.name))) {
      if (file.endsWith('Mappings.js')) mappings.push(`${entry.name}/${file}`)
      else if (file.endsWith('Configuration.js')) configurations.push(`${entry.name}/${file}`)
    }
  }

  const loaded = []
  for (const rel of mappings.sort()) {
    const id = `mathjax-full/js/input/tex/${rel}`
    try {
      require(id)
      loaded.push(rel)
    } catch (error) {
      throw new Error(`could not load MathJax mapping module ${id}: ${error.message}`)
    }
  }
  for (const rel of configurations.sort()) {
    const id = `mathjax-full/js/input/tex/${rel}`
    try {
      require(id)
      loaded.push(rel)
    } catch (error) {
      warnings.push(`MathJax configuration not loadable outside a document — ${rel}: ${error.message}`)
    }
  }
  return { registry, loaded: loaded.sort() }
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

/** Unicode ranges that decide a category when the command name does not. */
const GREEK = /[\u0370-\u03ff\u1f00-\u1fff\u03d1\u03d2\u03d5\u03d6\u03dc\u03f0-\u03f5]/
const ARROW_BLOCKS = [
  [0x2190, 0x21ff],
  [0x27f0, 0x27ff],
  [0x2900, 0x297f],
  [0x2b00, 0x2b11]
]
const RELATION_BLOCKS = [
  [0x2236, 0x2237],
  [0x223c, 0x223d],
  [0x2241, 0x224f],
  [0x2250, 0x226f],
  [0x2270, 0x22ff],
  [0x27c0, 0x27ef],
  [0x2a00, 0x2aff]
]
const LARGE_OPERATOR_NAMES = new Set([
  'sum', 'prod', 'coprod', 'int', 'intop', 'iint', 'iiint', 'iiiint', 'idotsint',
  'oint', 'oiint', 'oiiint', 'smallint', 'bigcap', 'bigcup', 'bigvee', 'bigwedge',
  'bigoplus', 'bigotimes', 'bigodot', 'biguplus', 'bigsqcup', 'bigtimes', 'biginterleave',
  'bigboxplus', 'bigboxminus', 'fint', 'varliminf', 'varlimsup'
])
const LOGIC_SET_NAMES = new Set([
  'forall', 'exists', 'nexists', 'neg', 'lnot', 'land', 'lor', 'wedge', 'vee',
  'implies', 'impliedby', 'iff', 'in', 'notin', 'ni', 'owns', 'subset', 'subseteq',
  'subsetneq', 'supset', 'supseteq', 'supsetneq', 'cup', 'cap', 'emptyset',
  'varnothing', 'complement', 'setminus', 'smallsetminus', 'top', 'bot', 'vdash',
  'dashv', 'models', 'vDash', 'Vdash', 'therefore', 'because', 'nvdash', 'nvDash',
  'nVdash', 'nsubseteq', 'nsupseteq', 'sqsubset', 'sqsupset', 'sqsubseteq',
  'sqsupseteq', 'bigcup', 'bigcap', 'intercal', 'uplus'
])
const ACCENT_NAMES = new Set([
  'acute', 'bar', 'breve', 'check', 'ddot', 'dddot', 'ddddot', 'dot', 'grave',
  'hat', 'mathring', 'not', 'overbrace', 'overleftarrow', 'overleftrightarrow',
  'overline', 'overparen', 'overrightarrow', 'tilde', 'underbrace',
  'underleftarrow', 'underleftrightarrow', 'underline', 'underparen',
  'underrightarrow', 'utilde', 'undertilde', 'widehat', 'widetilde', 'widecheck',
  'overbracket', 'underbracket', 'overgroup', 'undergroup', 'overrightarrow',
  'accentset', 'overset', 'underset', 'stackrel', 'overunderset', 'xrightarrow',
  'xleftarrow', 'xtwoheadrightarrow', 'xtwoheadleftarrow', 'xmapsto', 'xlongequal',
  'xtofrom', 'annuity', 'barleftarrow', 'barrightarrow', 'overleftrightarrow'
])
const ALPHABET_NAMES = new Set([
  'Bbb', 'bbFont', 'bf', 'bm', 'boldsymbol', 'cal', 'frak', 'it', 'mathbb',
  'mathbf', 'mathbfcal', 'mathbffrak', 'mathbfit', 'mathbfscr', 'mathbfsf',
  'mathbfsfit', 'mathbfsfup', 'mathbfup', 'mathcal', 'mathfrak', 'mathit',
  'mathnormal', 'mathrm', 'mathscr', 'mathsf', 'mathsfit', 'mathsfup', 'mathtt',
  'mathup', 'mit', 'oldsymbol', 'pmb', 'rm', 'scr', 'sf', 'sl', 'symbb', 'symbf',
  'symbfcal', 'symbffrak', 'symbfit', 'symbfscr', 'symbfsf', 'symbfsfit',
  'symbfsfup', 'symbfup', 'symcal', 'symfrak', 'symit', 'symnormal', 'symrm',
  'symscr', 'symsf', 'symsfit', 'symsfup', 'symtt', 'symup', 'tt', 'mathdefault',
  'mathds', 'mathdsb'
])
const FUNCTION_NAMES = new Set([
  'arccos', 'arcsin', 'arctan', 'arg', 'cos', 'cosh', 'cot', 'coth', 'csc',
  'deg', 'det', 'dim', 'exp', 'gcd', 'hom', 'inf', 'injlim', 'ker', 'lg', 'lim',
  'liminf', 'limsup', 'ln', 'log', 'max', 'min', 'Pr', 'projlim', 'sec', 'sin',
  'sinh', 'sup', 'tan', 'tanh', 'varinjlim', 'varliminf', 'varlimsup',
  'varprojlim', 'tr', 'trdeg', 'sgn', 'erf', 'erfc', 'ord', 'lcm', 'st'
])
const DELIMITER_NAMES = new Set([
  'lbrace', 'rbrace', 'lbrack', 'rbrack', 'lparen', 'rparen', 'langle',
  'rangle', 'lfloor', 'rfloor', 'lceil', 'rceil', 'lvert', 'rvert', 'lVert',
  'rVert', 'vert', 'Vert', 'lmoustache', 'rmoustache', 'lgroup', 'rgroup',
  'ulcorner', 'urcorner', 'llcorner', 'lrcorner', 'backslash', 'uparrow',
  'downarrow', 'updownarrow', 'Uparrow', 'Downarrow', 'Updownarrow', 'arrowvert',
  'Arrowvert', 'bracevert', 'lBrace', 'rBrace', 'lAngle', 'rAngle', 'lBrack',
  'rBrack', 'lParen', 'rParen', 'lfloor', 'lceil', 'llbracket', 'rrbracket',
  'lobrack', 'robrack', 'lbrbrak', 'rbrbrak', 'llparenthesis', 'rrparenthesis'
])

const inBlocks = (code, blocks) => blocks.some(([lo, hi]) => code >= lo && code <= hi)

/**
 * The categories a command belongs to.
 *
 * Name first, then the glyph's Unicode block, then the map it came from.
 * Name-first matters because Unicode cannot tell `\varnothing` (a set) from
 * `\emptyset` (a set) beyond both being ordinary symbols, and it cannot tell
 * `\mid` (a relation) from `\vert` (a delimiter) at all — the two share a glyph
 * and differ only in spacing, which is the map's own `texClass`.
 */
function classify(input) {
  const { command, char, mapName, glyph } = input
  const categories = new Set()

  if (mapName.startsWith('delimiter') || mapName.endsWith('-delimiter') || mapName.endsWith('-delimiters')) {
    categories.add('delimiters')
  }
  if (DELIMITER_NAMES.has(command)) categories.add('delimiters')
  if (LARGE_OPERATOR_NAMES.has(command)) categories.add('large-operators')
  if (FUNCTION_NAMES.has(command)) categories.add('functions')
  if (ACCENT_NAMES.has(command)) categories.add('accents')
  if (ALPHABET_NAMES.has(command)) categories.add('alphabets')
  if (LOGIC_SET_NAMES.has(command)) categories.add('logic-sets')

  const code = char ? char.codePointAt(0) : glyph ? glyph.codePointAt(0) : null
  if (code !== null) {
    if (GREEK.test(String.fromCodePoint(code))) categories.add('greek')
    if (inBlocks(code, ARROW_BLOCKS)) categories.add('arrows')
    if (inBlocks(code, RELATION_BLOCKS)) categories.add('relations')
  }
  if (/arrow/i.test(command) || /harpoon/i.test(command) || /(?:^|[a-z])(?:to|gets)$/.test(command)) {
    categories.add('arrows')
  }
  if (/(?:leq|geq|less|gtr|prec|succ|sim|simeq|approx|equiv|cong|propto|asymp|doteq|frown|smile|bowtie|parallel|perp|mid|models|vdash)/i.test(command)) {
    categories.add('relations')
  }
  if (
    /(?:plus|minus|times|cdot|circ|bullet|dagger|ast|star|oplus|otimes|odot|uplus|sqcup|sqcap|wedge|vee|amalg|wr|diamond|triangle|setminus|boxplus|boxminus|boxtimes|boxdot|divide|div|pm|mp|ltimes|rtimes|curlyvee|curlywedge|intercal|dotplus|centerdot|crossproduct|dotproduct)/i.test(
      command
    )
  ) {
    if (!categories.has('large-operators')) categories.add('binary-operators')
  }

  if (categories.size === 0) categories.add('miscellaneous')
  return [...categories].sort((a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b))
}

/* ------------------------------------------------------------------ *
 * Requirements
 * ------------------------------------------------------------------ */

const capability = (packageName, source, verified) => ({
  package: packageName,
  kind: packageName === 'core' ? 'core' : 'package',
  verified,
  source
})

/** The reviewed LaTeX capability a MathJax map belongs to. */
function capabilityForMap(mapName) {
  const entry = packagesJson.maps[mapName]
  if (!entry) throw new Error(`no package attribution for MathJax map "${mapName}"`)
  if (entry.package === null) return null
  return capability(entry.package, 'mathjax-configuration', entry.verified === true)
}

/**
 * The package named in a `unimathsymbols.json` `detail` field, when it names
 * one.
 *
 * The field reads `⟂ ("wasysym" command)`, and the parenthetical is a *hint*
 * that a package is involved — not proof of the package's name, and not proof
 * that the command needs it.  It is recorded as unverified unless
 * `curated/packages.json` lists the package as reviewed.
 */
function packageHintFromDetail(detail) {
  const match = /\((?:"|\\")?([A-Za-z][A-Za-z0-9_.+-]*)(?:"|\\")?\s+command\)/.exec(detail ?? '')
  if (!match) return null
  const name = match[1]
  return {
    name,
    verified: packagesJson.unimathsymbolsPackages.verified.includes(name)
  }
}

/** The glyph a `unimathsymbols.json` record describes, if it has one. */
function glyphFromDetail(detail) {
  if (!detail) return null
  const head = detail.split('(')[0].trim()
  if (!head) return null
  // The field can hold a whole replacement recipe; only a single non-ASCII
  // character is a glyph the grid can draw.
  const chars = [...head]
  if (chars.length === 1 && head.codePointAt(0) > 0x7f) return head
  if (chars.length === 2 && /\p{Mark}/u.test(chars[1])) return head
  return null
}

/* ------------------------------------------------------------------ *
 * Entry assembly
 * ------------------------------------------------------------------ */

const warnings = []
const excluded = []

/**
 * An id-safe spelling of a TeX control sequence.
 *
 * Case is preserved on purpose: TeX command names are case-sensitive, and
 * `unimathsymbols.json` really does hold both `BbbA` and `Bbba`. Folding case
 * here would silently drop one of them.
 */
const idSafe = (name) => name.replace(/^\\/, '').replace(/[^A-Za-z0-9@]+/g, '-')

/** One emitted catalog entry. */
function entry(input) {
  return {
    id: input.id,
    name: input.name,
    glyph: input.glyph ?? null,
    preview:
      input.preview ?? (input.glyph ? 'glyph' : input.previewSource ? 'math' : 'command'),
    previewSource: input.previewSource ?? null,
    categories: input.categories,
    aliases: input.aliases ?? [],
    keywords: input.keywords ?? [],
    description: input.description ?? null,
    core: input.core ?? null,
    source: input.source,
    variants: input.variants
  }
}

/** A variant built from a plain, argument-less command. */
function plainVariant(id, command, requires, options = {}) {
  return {
    id,
    command,
    parts: [{ text: command }],
    slots: [],
    requires,
    engines: options.engines ?? null,
    mode: options.mode ?? 'math-only',
    selfContainedMath: options.selfContainedMath ?? false
  }
}

/**
 * Normalises a template body to one shape.
 *
 * The curated files may write a literal as a bare string — it is the readable
 * way to write `"\frac{"` — and the catalog stores it as `{ text }`. Normalising
 * here means nothing downstream has to ask which of the two it is holding, and
 * the validation below can be written against one shape rather than two.
 */
function normalizeParts(parts) {
  return parts.map((part) => {
    if (typeof part === 'string') return { text: part }
    if (typeof part?.text === 'string') return { text: part.text }
    if (typeof part?.slot === 'number') return { slot: part.slot }
    throw new Error(`malformed template part: ${JSON.stringify(part)}`)
  })
}

const { registry, loaded } = loadMathJaxMaps()

/**
 * Every MathJax-derived command, keyed by the command name.
 *
 * A command can appear in more than one map; the first map in the priority
 * order below wins, and the others are recorded as aliases of it.
 */
const MAP_PRIORITY = [
  'mathchar0mi',
  'mathchar0mo',
  'mathchar7',
  'macros',
  'delimiter',
  'AMSsymbols-mathchar0mi',
  'AMSsymbols-mathchar0mo',
  'AMSsymbols-macros',
  'AMSmath-macros',
  'AMSmath-mathchar0mo',
  'AMSsymbols-delimiter',
  'AMSmath-delimiter',
  'mathtools-macros',
  'mathtools-delimiters',
  'mathtools-characters',
  'Braket-macros',
  'Braket-characters',
  'Bussproofs-macros',
  'Physics-vector-mi',
  'Physics-vector-mo',
  'Physics-expressions-macros',
  'Physics-vector-macros',
  'Physics-derivative-macros',
  'Physics-bra-ket-macros',
  'Physics-matrix-macros',
  'Physics-quick-quad-macros',
  'Physics-automatic-bracing-macros',
  'textcomp-macros',
  'upgreek',
  'gensymb-symbols',
  'cancel',
  'cases-macros',
  'centernot',
  'color',
  'colortbl',
  'empheq-macros',
  'enclose',
  'extpfeil',
  'boldsymbol',
  'mhchem',
  'verb'
]

const mathJaxCommands = new Map()
const mathJaxEnvironmentNames = new Set()

const recordMathJaxCommand = (mapName, rawCommand, value) => {
  /*
   * Delimiter maps key their letter commands with the backslash — `'\\lvert'`,
   * `'\\ulcorner'`, `'\\lmoustache'` — where every other map keys them bare.
   * Normalising here is what keeps `\lvert`, `\rvert`, `\lVert` and the corner
   * brackets in the catalog at all; an earlier version dropped them without a
   * word because the key did not look like a name.
   */
  const command = rawCommand.startsWith('\\') ? rawCommand.slice(1) : rawCommand
  if (!/^[A-Za-z@]+$/.test(command)) return // TeX syntax characters are not commands
  const existing = mathJaxCommands.get(command)
  if (existing && MAP_PRIORITY.indexOf(existing.mapName) <= MAP_PRIORITY.indexOf(mapName)) return
  mathJaxCommands.set(command, {
    mapName,
    command,
    char: typeof value?._char === 'string' ? value._char : null,
    texClass: value?._attributes?.texClass ?? null,
    mathvariant: value?._attributes?.mathvariant ?? null
  })
}

for (const [mapName, map] of registry) {
  if (map.constructor.name === 'EnvironmentMap') {
    for (const name of map.map.keys()) mathJaxEnvironmentNames.add(name)
    continue
  }
  if (map.constructor.name === 'RegExpMap') continue
  for (const [command, value] of map.map ?? []) {
    recordMathJaxCommand(mapName, command, value)
  }
}

/* ---------------------------------------------------------- MathJax entries */

/**
 * The command each curated template is *about*.
 *
 * A template's head command comes from its own body, so nothing has to repeat
 * it. It matters for two reasons: a command that has a template must not also
 * appear as a bare MathJax symbol (section §5 asks for one id per symbol, and
 * two buttons inserting `\hat` differently is exactly the duplicate it forbids),
 * and the template inherits the symbol's categories — an accent is still an
 * accent when it is written with an argument slot.
 */
const templateCommand = (template) => {
  for (const part of template.parts) {
    const text = typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : null
    if (text === null) continue
    const match = /\\[A-Za-z]+/.exec(text)
    if (match) return match[0]
  }
  return null
}

const templateCommands = new Map()
for (const template of templatesJson.templates) {
  const command = templateCommand(template)
  if (command && !templateCommands.has(command)) templateCommands.set(command, template.id)
}
const structuralExclusions = overridesJson.structuralExclusions
/**
 * Commands Eukolia has decided are not catalog symbols, and the reason for each.
 *
 * Two sources, one list. The curated exclusions say "this is structural, or a
 * template writes it"; the template-derived ones say "a curated template already
 * owns this command". Both loops below consult the same map, so an upstream
 * record and its MathJax twin cannot be accounted for differently.
 */
const notASymbol = new Map()
for (const [command, reason] of Object.entries(structuralExclusions)) {
  notASymbol.set(command, reason)
}
for (const [command, templateId] of templateCommands) {
  notASymbol.set(command.replace(/^\\/, ''), `written by the "${templateId}" template`)
}
const suppressed = new Set(notASymbol.keys())

/** Commands that must never be folded into another, whatever they share. */
const noMerge = new Set(overridesJson.noMerge ?? [])

const entries = new Map()


/**
 * How many brace arguments a MathJax command takes.
 *
 * MathJax does not record this. A `CommandMap`'s `_args` is the *method's own*
 * parameter list — `\widehat` carries `['005E', 1]` for a one-argument accent,
 * and `\frac` carries `[]` for a two-argument one — so it cannot be counted.
 * The reviewed statement lives in `curated/overrides.json`, and the two families
 * where the answer follows from what the command *is* are derived here: an
 * accent decorates what follows it, and a mathematical alphabet styles it.
 * `\not` is the one accent that takes no argument group: it prefixes the next
 * token, as in `\not=`.
 */
const argumentCounts = new Map()
for (const [count, commands] of Object.entries(overridesJson.argumentCounts)) {
  for (const command of commands) argumentCounts.set(command, Number(count))
}
for (const command of [...ACCENT_NAMES, ...ALPHABET_NAMES]) {
  if (!argumentCounts.has(command)) argumentCounts.set(command, 1)
}
argumentCounts.set('not', 0)

/** A slot-carrying command's variant: `\hat{□}`, `\mathbb{□}`, `\sqrt{□}`. */
function slotVariant(id, command, requires, count) {
  const parts = [{ text: command }]
  const slots = []
  for (let index = 1; index <= count; index += 1) {
    parts.push({ text: '{' }, { slot: index }, { text: '}' })
    slots.push({
      index,
      required: index === 1,
      default: '',
      select: index === 1 ? 'selected-text' : 'placeholder',
      description: null
    })
  }
  return {
    id,
    command,
    parts,
    slots,
    requires,
    engines: null,
    mode: 'math-only',
    selfContainedMath: false
  }
}

/**
 * The command-level package corrections.
 *
 * The map attribution is right for most commands and wrong for a few: `\mathbb`
 * is in MathJax's base `macros` map, which is attributed to the LaTeX kernel,
 * while in LaTeX it comes from `amsfonts`. Those are stated per command in
 * `curated/overrides.json` rather than being inferred from the family.
 */
const requirementOverrides = new Map()
for (const [command, packageName] of Object.entries(overridesJson.requirements)) {
  requirementOverrides.set(command, packageName)
}
for (const group of overridesJson.requirementGroups) {
  for (const command of group.commands) requirementOverrides.set(command, group.package)
}

const requirementFor = (command, mapRequirement) => {
  const declared = requirementOverrides.get(command)
  if (!declared) return mapRequirement
  return capability(
    declared,
    'curated',
    packagesJson.unimathsymbolsPackages.verified.includes(declared) || declared === 'core'
  )
}

for (const [command, record] of [...mathJaxCommands].sort(([a], [b]) => a.localeCompare(b))) {
  const notSymbol = notASymbol.get(command)
  if (notSymbol) {
    excluded.push({ source: 'mathjax', id: command, reason: notSymbol })
    continue
  }
  const mapRequirement = capabilityForMap(record.mapName)
  if (mapRequirement === null) {
    excluded.push({
      source: 'mathjax',
      id: command,
      reason: `MathJax's "${record.mapName}" extension has no LaTeX equivalent`
    })
    continue
  }
  const requires = requirementFor(command, mapRequirement)
  const categoryOverride = overridesJson.categoryOverrides[command]
  const categories = categoryOverride
    ? [...categoryOverride].sort((a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b))
    : classify({ command, char: record.char, mapName: record.mapName, glyph: record.char })

  const id = `mjs:${idSafe(command)}`
  const variantId = `${id}@${command}`
  const arity = argumentCounts.get(command) ?? 0
  const variant =
    arity > 0
      ? slotVariant(variantId, `\\${command}`, [requires], arity)
      : plainVariant(variantId, `\\${command}`, [requires])

  entries.set(id, {
    entry: entry({
      id,
      name: `\\${command}`,
      glyph: record.char && record.char.codePointAt(0) > 0x7f ? record.char : null,
      // An argument-taking command has nothing to draw on its own: the preview
      // is the command typeset by MathJax, not a bare glyph.
      ...(arity > 0 ? { preview: 'command' } : {}),
      categories,
      aliases: [],
      keywords: overridesJson.keywords[command] ?? [],
      description: null,
      core: requires.kind === 'core',
      source: `MathJax ${record.mapName} (Apache-2.0)`,
      variants: [variant]
    }),
    // Only argument-less commands take part in the glyph merge: two spellings of
    // an accent are two spellings only when the whole construct is the same.
    mergeKey:
      arity === 0 && !noMerge.has(command)
        ? mergeKeyFor(record.char, record.texClass, record.mathvariant, 'plain', [requires])
        : null,
    commands: [command],
    requires
  })
}

/**
 * The identity two *plain* commands must share to be one symbol.
 *
 * Glyph identity is necessary and nowhere near sufficient.
 *
 * `\mid` and `\vert` are both `∣` and are not the same symbol — one is a
 * relation and one a delimiter, which is what `texClass` records. `\hbar` and
 * `\hslash` draw the same character and live in different packages, so folding
 * them would report a core command as needing `amssymb`. `\times` and the
 * `physics` package's `\cp` are the same glyph and the same idea, but a document
 * that loads neither package can write `\times` and cannot write `\cp`; merging
 * them would make the catalog claim the wrong thing about both.
 *
 * So the key carries the glyph, the TeX class, the math variant **and the
 * requirement set**. Two commands can be one symbol only when they need exactly
 * the same things. Anything else is a merge that corrupts availability, which is
 * the one property the panel exists to state honestly.
 *
 * A few families still need the reviewed `noMerge` list: symbols that share a
 * glyph, a class *and* a package and are nonetheless different — `\shortmid`
 * against `\mid`, `\bigtriangleup` against `\vartriangle`, `\dotso` against
 * `\dotsc`. `MathematicalSymbols.md` §5 names the short/long family explicitly.
 */
function mergeKeyFor(char, texClass, mathvariant, kind, requires) {
  if (!char) return null
  const signature = (requires ?? [])
    .map((requirement) => requirement.package)
    .sort()
    .join(',')
  return `${char}\u0000${texClass ?? ''}\u0000${mathvariant ?? ''}\u0000${kind}\u0000${signature}`
}


/* ------------------------------------------- unimathsymbols entries */

const upstreamCommands = Object.keys(upstream).sort()
let upstreamMerged = 0
/**
 * Upstream records that produced a decision.
 *
 * Filled as each record is handled — emitted, merged, or excluded — so the
 * validation below compares against what actually happened rather than against
 * a reconstruction of it.
 */
const accountedUpstream = new Set()

for (const name of upstreamCommands) {
  const record = upstream[name]
  const exclusion = overridesJson.excludeUpstream[name]
  if (exclusion) {
    excluded.push({ source: 'unimathsymbols', id: name, reason: exclusion })
    continue
  }
  const existing = mathJaxCommands.get(name)
  const hint = packageHintFromDetail(record.detail)
  const glyph = glyphFromDetail(record.detail)

  /*
   * Every upstream record is accounted for exactly once, and it is recorded
   * *here* rather than inferred from the catalog afterwards.
   *
   * The inference version was wrong in a way worth keeping the note for: an
   * upstream record merged into `mjs:leq` looked accounted for, but `mjs:leq`
   * was itself then merged into the shorter `mjs:le` spelling, so the id the
   * check looked for no longer existed and 2 415 records produced 19 phantom
   * omissions. Naming them as they are handled cannot drift like that.
   */
  accountedUpstream.add(name)

  const notSymbol = notASymbol.get(name)
  if (notSymbol) {
    excluded.push({
      source: 'unimathsymbols',
      id: name,
      reason: notSymbol
    })
    continue
  }

  if (existing) {
    // MathJax already has this command with richer metadata; the upstream
    // record only adds spelling and a description.
    const id = `mjs:${idSafe(name)}`
    const target = entries.get(id)
    if (target) {
      target.entry.description = target.entry.description ?? record.documentation ?? null
      if (!target.entry.glyph && glyph) target.entry.glyph = glyph
      if (hint && !target.requires.verified) {
        target.entry.variants[0].requires = [
          ...target.entry.variants[0].requires,
          capability(hint.name, 'unimathsymbols-detail', hint.verified)
        ]
      }
      upstreamMerged += 1
      continue
    }
  }

  const categoryOverride = overridesJson.categoryOverrides[name]
  const categories = categoryOverride
    ? [...categoryOverride].sort((a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b))
    : classify({ command: name, char: null, mapName: 'unimathsymbols', glyph })

  const id = `ums:${idSafe(name)}`
  const requires = hint
    ? [capability(hint.name, 'unimathsymbols-detail', hint.verified)]
    : []
  const mergeKey =
    glyph && !noMerge.has(name) ? mergeKeyFor(glyph, null, null, 'plain', requires) : null

  entries.set(id, {
    entry: entry({
      id,
      name: `\\${name}`,
      glyph,
      categories,
      aliases: [],
      keywords: overridesJson.keywords[name] ?? [],
      description: record.documentation ?? null,
      core: requires.length === 0 ? null : false,
      source: 'unimathsymbols.json (LaTeX Workshop, MIT)',
      variants: [plainVariant(`${id}@${name}`, `\\${name}`, requires)]
    }),
    mergeKey,
    commands: [name],
    requires: requires[0] ?? capability('core', 'mathjax-configuration', false)
  })
}

/* --------------------------------------------------- curated extra symbols */

for (const extra of overridesJson.symbols) {
  if (entries.has(extra.id)) throw new Error(`curated symbol id "${extra.id}" is already used`)
  const requires = (extra.requires ?? []).map((packageName) =>
    capability(
      packageName,
      'curated',
      packagesJson.unimathsymbolsPackages.verified.includes(packageName) || packageName === 'core'
    )
  )
  // An empty list is the reviewed statement "the LaTeX kernel provides this",
  // not "nobody checked" — so it becomes an explicit core requirement rather
  // than an entry with no requirements at all, which would read as unknown.
  if (requires.length === 0) requires.push(capability('core', 'curated', true))
  entries.set(extra.id, {
    entry: entry({
      id: extra.id,
      name: extra.name,
      glyph: extra.glyph ?? null,
      previewSource: extra.previewSource ?? null,
      categories: extra.categories,
      aliases: extra.aliases ?? [],
      keywords: extra.keywords ?? [],
      description: extra.description ?? null,
      core: requires.some((r) => r.kind === 'core'),
      source: 'curated (Eukolia)',
      variants: [
        {
          id: `${extra.id}@${extra.command ?? extra.id}`,
          command: extra.command,
          parts: normalizeParts(extra.parts),
          slots: extra.slots ?? [],
          requires,
          engines: extra.engines ?? null,
          mode: extra.mode ?? 'math-only',
          selfContainedMath: extra.selfContainedMath ?? false
        }
      ]
    }),
    mergeKey: null,
    commands: extra.command ? [extra.command.replace(/^\\/, '')] : [],
    requires: requires[0]
  })
}

/* ------------------------------------------------------------ templates */

/**
 * The categories a template carries.
 *
 * Always `templates`, plus whatever the command it writes is classified as — an
 * accent is still an accent when it is written with an argument slot, and an
 * alphabet is still an alphabet. The inheritance is skipped for the structural
 * commands (`\left`, `\begin`) the exclusion list already removed from the
 * catalog: they are not symbols, so they have no categories to give.
 */
function categoryOverridesFor(command, templateId) {
  const categories = new Set(['templates'])
  if (command) {
    const bare = command.replace(/^\\/, '')
    const record = mathJaxCommands.get(bare)
    if (record && !suppressed.has(bare)) {
      const override = overridesJson.categoryOverrides[bare]
      const inferred =
        override ??
        classify({ command: bare, char: record.char, mapName: record.mapName, glyph: record.char })
      for (const category of inferred) categories.add(category)
    }
  }
  return [...categories].sort((a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b))
}

for (const template of templatesJson.templates) {
  if (entries.has(template.id)) throw new Error(`template id "${template.id}" is already used`)
  const requires = (template.requires ?? []).map((packageName) =>
    capability(
      packageName,
      'curated',
      packagesJson.unimathsymbolsPackages.verified.includes(packageName)
    )
  )
  if (requires.length === 0) requires.push(capability('core', 'curated', true))
  const command = templateCommands.size
    ? [...templateCommands].find(([, id]) => id === template.id)?.[0] ?? null
    : null
  /*
   * A template is a template, and it is also whatever the command it writes
   * *is*: an accent stays an accent when it is written with an argument slot,
   * and an alphabet stays an alphabet. Inheriting the symbol's categories from
   * the MathJax map it stands in for is what keeps the Accents, Alphabets and
   * Delimiters categories populated once the bare records are withdrawn.
   */
  const inherited = categoryOverridesFor(command, template.id)
  entries.set(template.id, {
    entry: entry({
      id: template.id,
      name: template.name,
      glyph: null,
      preview: 'math',
      previewSource: template.mathjaxPreview,
      categories: inherited,
      aliases: template.aliases ?? [],
      keywords: template.keywords ?? [],
      description: template.description ?? null,
      core: requires.every((requirement) => requirement.kind === 'core'),
      source: 'curated template (Eukolia)',
      variants: [
        {
          id: `${template.id}@template`,
          command,
          parts: normalizeParts(template.parts),
          slots: template.slots,
          requires,
          engines: null,
          mode: template.mode,
          selfContainedMath: false
        }
      ]
    }),
    mergeKey: null,
    commands: command ? [command.replace(/^\\/, '')] : [],
    requires: requires[0]
  })
}

/* ------------------------------------------------------------- aliasing */

/**
 * Merge entries that are the same symbol written two ways.
 *
 * Two plain commands sharing a glyph *and* a TeX class *and* a math variant are
 * the same symbol: `\le`/`\leq`, `\to`/`\rightarrow`, `\land`/`\wedge`. The
 * merge key deliberately excludes the command name and deliberately includes
 * everything that changes what the symbol *is* — which is why `\mid` and
 * `\vert`, `\epsilon` and `\varepsilon`, and `\rightarrow` and
 * `\longrightarrow` all stay separate entries.
 *
 * The survivor is the entry whose command the catalog prefers: a MathJax base
 * spelling over an extended one, then the shortest, then alphabetical. The
 * merged entries become extra variants of the survivor so every spelling stays
 * insertable, and their ids are recorded in the manifest as merged.
 */
const survivors = new Map()
const mergedIds = new Map()
const preference = (record) => {
  const id = record.entry.id
  const base = id.startsWith('mjs:') ? 0 : id.startsWith('ums:') ? 1 : 2
  return [base, record.commands[0]?.length ?? 99, record.commands[0] ?? '']
}

for (const [id, record] of entries) {
  if (!record.mergeKey) continue
  const current = survivors.get(record.mergeKey)
  if (!current) {
    survivors.set(record.mergeKey, { id, record })
    continue
  }
  const [aBase, aLen, aName] = preference(current.record)
  const [bBase, bLen, bName] = preference(record)
  const winner = bBase < aBase || (bBase === aBase && (bLen < aLen || (bLen === aLen && bName < aName)))
  const loserId = winner ? current.id : id
  const winnerId = winner ? id : current.id
  const winnerRecord = entries.get(winnerId)
  const loserRecord = entries.get(loserId)
  for (const variant of loserRecord.entry.variants) {
    winnerRecord.entry.variants.push({
      ...variant,
      id: `${winnerId}@${variant.command.replace(/^\\/, '')}`
    })
  }
  winnerRecord.entry.aliases = [
    ...winnerRecord.entry.aliases,
    ...loserRecord.entry.aliases,
    ...loserRecord.entry.variants.map((variant) => variant.command)
  ]
  winnerRecord.entry.keywords = [...new Set([...winnerRecord.entry.keywords, ...loserRecord.entry.keywords])].sort()
  mergedIds.set(loserId, winnerId)
  entries.delete(loserId)
  survivors.set(record.mergeKey, { id: winnerId, record: winnerRecord })
}

/* ------------------------------------------------------ curated spelling */

for (const [canonical, spellings] of Object.entries(overridesJson.variantSpellings)) {
  const target = [...entries.values()].find((record) =>
    record.commands.some((command) => command === canonical)
  )
  if (!target) throw new Error(`variantSpellings names unknown command "\\${canonical}"`)
  for (const spelling of spellings) {
    if (target.entry.aliases.includes(`\\${spelling}`)) continue
    target.entry.aliases.push(`\\${spelling}`)
    target.entry.variants.push(
      plainVariant(`${target.entry.id}@${spelling}`, `\\${spelling}`, [target.requires])
    )
  }
}

/* ------------------------------------------------------------- finalise */

const catalogEntries = [...entries.values()]
  .map((record) => {
    const value = record.entry
    return {
      ...value,
      aliases: [...new Set(value.aliases)].sort(),
      categories: [...new Set(value.categories)].sort(
        (a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b)
      ),
      variants: value.variants
        .map((variant) => ({ ...variant }))
        .sort((a, b) => a.id.localeCompare(b.id))
    }
  })
  .sort((a, b) => a.id.localeCompare(b.id))

/* ---------------------------------------------------------- validation */

function verifyCatalog(catalog) {
  const problems = []
  const seenIds = new Set()
  const seenVariants = new Set()
  /**
   * Which entry provides each command.
   *
   * A command is the thing the user types, so two entries answering to `\hat`
   * would be two buttons that insert different source under one name. The
   * alias merge and the template-covered command list both have to keep this
   * unique, and this is where that is checked rather than assumed.
   *
   * Templates are the one legitimate exception, and only among themselves:
   * `\left` heads every delimiter pair and `\begin` heads every environment, so
   * several templates share a first command by construction. What must not
   * happen — and is reported below — is a template and a *symbol* entry both
   * claiming the same command.
   */
  const commandOwners = new Map()
  let variantCount = 0
  let slotCount = 0

  for (const record of catalog.entries) {
    if (seenIds.has(record.id)) problems.push(`duplicate entry id "${record.id}"`)
    seenIds.add(record.id)
    if (!/^[a-z]+:[A-Za-z0-9@-]+$/.test(record.id)) {
      problems.push(`malformed entry id "${record.id}"`)
    }
    if (record.categories.length === 0) problems.push(`"${record.id}" has no category`)
    for (const category of record.categories) {
      if (!CATEGORIES.includes(category)) {
        problems.push(`"${record.id}" has unknown category "${category}"`)
      }
    }
    if (record.variants.length === 0) problems.push(`"${record.id}" has no variants`)
    for (const variant of record.variants) {
      variantCount += 1
      if (seenVariants.has(variant.id)) problems.push(`duplicate variant id "${variant.id}"`)
      seenVariants.add(variant.id)
      if (variant.mode !== 'math-only' && variant.mode !== 'text-only' && variant.mode !== 'mode-independent') {
        problems.push(`"${variant.id}" has unknown mode "${variant.mode}"`)
      }
      if (variant.parts.length === 0) problems.push(`"${variant.id}" has an empty template`)
      if (!variant.parts.some((part) => typeof part.text === 'string' && part.text.length > 0)) {
        problems.push(`"${variant.id}" renders no literal text`)
      }
      const usedSlots = []
      for (const part of variant.parts) {
        if (typeof part.text === 'string') {
          if (/#\d/.test(part.text) || /\$\d/.test(part.text) || part.text.includes('${')) {
            problems.push(`"${variant.id}" uses a placeholder marker in literal text`)
          }
          continue
        }
        if (typeof part.slot !== 'number' || !Number.isInteger(part.slot) || part.slot < 1) {
          problems.push(`"${variant.id}" has a malformed slot reference`)
          continue
        }
        usedSlots.push(part.slot)
      }
      if (usedSlots.some((slot, index) => index > 0 && slot < usedSlots[index - 1])) {
        problems.push(`"${variant.id}" references its slots out of order`)
      }
      const declared = variant.slots.map((slot) => slot.index)
      if (new Set(declared).size !== declared.length) {
        problems.push(`"${variant.id}" declares a slot index twice`)
      }
      for (const slot of usedSlots) {
        if (!declared.includes(slot)) problems.push(`"${variant.id}" uses undeclared slot #${slot}`)
      }
      for (const slot of variant.slots) {
        if (!usedSlots.includes(slot.index)) {
          problems.push(`"${variant.id}" declares unused slot #${slot.index}`)
        }
        if (!Number.isInteger(slot.index) || slot.index < 1) {
          problems.push(`"${variant.id}" has a bad slot index`)
        }
        if (typeof slot.required !== 'boolean') {
          problems.push(`"${variant.id}" slot #${slot.index} has a non-boolean "required"`)
        }
        if (!['placeholder', 'selected-text', 'none'].includes(slot.select)) {
          problems.push(`"${variant.id}" slot #${slot.index} has unknown select "${slot.select}"`)
        }
        if (typeof slot.default !== 'string') {
          problems.push(`"${variant.id}" slot #${slot.index} has a non-string default`)
        }
        slotCount += 1
      }
      for (const requirement of variant.requires) {
        if (typeof requirement.package !== 'string' || requirement.package.length === 0) {
          problems.push(`"${variant.id}" has a requirement with no package`)
        }
        if (typeof requirement.verified !== 'boolean') {
          problems.push(`"${variant.id}" has a requirement whose "verified" is not a boolean`)
        }
      }
      if (variant.command !== null && !/^\\[A-Za-z@]+$/.test(variant.command)) {
        problems.push(`"${variant.id}" has malformed command "${variant.command}"`)
      }
      if (variant.command !== null) {
        const owners = commandOwners.get(variant.command) ?? []
        owners.push({ variantId: variant.id, template: record.id.startsWith('tpl:') })
        commandOwners.set(variant.command, owners)
      }
    }
  }

  for (const [command, owners] of commandOwners) {
    if (owners.length < 2) continue
    if (owners.every((owner) => owner.template)) continue
    problems.push(
      `command "${command}" is provided by ${owners.map((owner) => `"${owner.variantId}"`).join(' and ')}`
    )
  }

  const unexplained = upstreamCommands.filter((name) => !accountedUpstream.has(name))
  for (const name of unexplained) {
    problems.push(`unimathsymbols record "${name}" was neither emitted nor excluded`)
  }

  return { problems, variantCount, slotCount }
}

const catalog = {
  version: 1,
  categories: CATEGORIES,
  entries: catalogEntries
}

const { problems, variantCount, slotCount } = verifyCatalog(catalog)

const manifest = {
  version: 1,
  categories: CATEGORIES,
  sources: {
    mathjax: {
      package: 'mathjax-full',
      licence: 'Apache-2.0',
      mapModules: loaded,
      maps: [...registry.keys()].sort(),
      commands: mathJaxCommands.size,
      environments: [...mathJaxEnvironmentNames].sort()
    },
    unimathsymbols: {
      path: 'src/renderer/data/latex-workshop/unimathsymbols.json',
      licence: 'MIT (LaTeX Workshop)',
      records: upstreamCommands.length,
      mergedIntoMathJax: upstreamMerged
    },
    curated: {
      templates: templatesJson.templates.length,
      extraSymbols: overridesJson.symbols.length,
      structuralExclusions: Object.keys(structuralExclusions).length,
      variantSpellings: Object.keys(overridesJson.variantSpellings).length
    }
  },
  emitted: {
    entries: catalogEntries.length,
    variants: variantCount,
    slots: slotCount,
    byCategory: Object.fromEntries(
      CATEGORIES.map((category) => [
        category,
        catalogEntries.filter((record) => record.categories.includes(category)).length
      ])
    )
  },
  mergedIds: Object.fromEntries([...mergedIds].sort(([a], [b]) => a.localeCompare(b))),
  excluded: excluded
    .slice()
    .sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id)),
  warnings: warnings.slice().sort(),
  problems: problems.slice().sort()
}

/* ----------------------------------------------------------------- emit */

if (problems.length > 0) {
  console.error(`math symbol catalog: ${problems.length} problem(s)`)
  for (const problem of problems.slice(0, 40)) console.error(`  - ${problem}`)
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
/*
 * The catalog is written compact and the manifest pretty, and the difference is
 * deliberate. The catalog is *loaded* — it is bundled as a string and parsed by
 * the panel — and a few thousand entries at one space of indent is roughly a
 * fifth of the file spent on whitespace the browser pays to transfer and parse.
 * The manifest is *read*: by a person checking that a record was accounted for,
 * and by the tests. It is small enough that legibility costs nothing.
 */
writeFileSync(path.join(outDir, 'catalog.generated.json'), `${JSON.stringify(catalog)}\n`)
writeFileSync(path.join(outDir, 'catalog.manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`)

console.info('math symbol catalog generated')
console.info(`  entries          ${manifest.emitted.entries}`)
console.info(`  variants         ${manifest.emitted.variants}`)
console.info(`  argument slots   ${manifest.emitted.slots}`)
console.info(`  upstream records ${manifest.sources.unimathsymbols.records}`)
console.info(`  excluded         ${manifest.excluded.length}`)
console.info(`  merged ids       ${Object.keys(manifest.mergedIds).length}`)
console.info(
  `  categories       ${Object.entries(manifest.emitted.byCategory)
    .map(([category, count]) => `${category}=${count}`)
    .join(' ')}`
)
