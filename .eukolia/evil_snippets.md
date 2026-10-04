# Compact mathematical expression scheme

## 1. Scope and notation

This scheme is implemented by the `evil_text` and `evil_math` snippets — their
bodies call `renderMultiFiberedText` and `renderMultiFiberedMath` in
`globals.js`, and section 15 documents the implemented parenthesis extension and its
whole-word balance guard. Earlier sections record the preceding syntax;
section 15 takes precedence where parenthesis rules overlap. In
`snippets.json` they are the last two entries belonging to the scheme; the
disabled `complex_fibered_op_text` just before them is the earlier hand-written
version they replaced, and every other entry in the file keeps its own
definition.

`big_regex` denotes a complete outer expression. `regex` denotes the relaxed
expression permitted inside a group. These are grammar names: a shared parser
performs validation and rendering after the trigger regex captures a candidate.

In the grammar below, `?` means optional, `*` means zero or more repetitions,
and `|` separates alternatives. Literal delimiters are quoted. The two
`literal_parenthesis` alternatives below overlap with `group`; section 15
resolves their priority and requires balanced parentheses before expansion.

```ebnf
big_regex = operand (symbol operand?)*
regex     = (operand | symbol | ",")*
operand   = function? input
function  = core_function minorscript?
input     = textstyle? base suffixes intermediate?
base      = letter | group | literal_parenthesis
simple_input = textstyle? base suffixes
suffixes  = minorscript? hat? | hat? minorscript?
group     = "{" regex "}" | "(" regex ")" | "[" regex "]"
          | "[[" regex "]]" | "|" regex "|"
symbol    = (core_symbol | literal_parenthesis) minorscript?
literal_parenthesis = "(" | ")"
minorscript = ("ud" | "ov") script_operand?
            | ("uo" | "ou") script_operand? script_operand?
intermediate = "(" simple_input? ")" | "[" simple_input? "]"
             | "[[" simple_input? "]]"
```

A group may contain adjacent inputs or operands, mixed with symbols. The entire
group counts as one operand. Empty groups are valid and create tabstops.
A single operand is valid syntax. Automatic expansion additionally requires a
recognizable shorthand feature (a symbol, function, Greek name, style, accent,
script, or explicit empty group). Plain letters, numbers, and groups alone are
left unchanged. Whitespace is not part of a compact
expression; a trailing delimiter requests expansion.

## 2. Outer expressions and parsing priority

1. The first operand is required. To omit its content, use an explicit empty group.
2. After an operand, a symbol is required before another operand.
3. After a symbol, the next operand may be absent. Consecutive symbols and a
   final symbol are valid; absence alone never creates a tabstop.
4. Prefer a complete alternating operand–symbol parse. In particular, after
   `:`, interpret `X` as an operand when that permits the complete expression.
5. Within a token category, prefer the longest name, for example `longto`
   before `to`, `arccot` before `cot`, and `what` before `hat`.
6. Inside groups, permit missing symbols and missing operands. Prefer named
   symbols over splitting their names into adjacent individual letters;
   full function and Greek operands retain operand priority.
7. Consume the complete candidate. Reject malformed braces or square brackets,
   unknown characters, or ungrouped adjacent operands without converting a valid
   suffix separately. Section 15 permits literal parentheses
   as tokens, but automatic expansion requires the complete word’s parentheses
   to balance; unmatched parentheses preserve the word literally.
8. Whole-input exclusions in `FIBERED_IGNORED_INPUTS` and
   `FIBERED_IGNORED_WORDS` remain in effect.

Examples:

| Input | Rendered snippet content |
| --- | --- |
| `f:XtoY` | `f:X\to Y` |
| `AtotoC` | `A\to\to C` |
| `Ato` | `A\to` |
| `Ato{}toC` | `A\to ${1}\to C` |
| `Ato()toC` | `A\to( ${1})\to C` |
| `{AB}toC` | `AB\to C` |
| `Ato{BC}` | `A\to BC` |
| `AtoBC` | Unchanged: adjacent outer operands are invalid. |
| `toA` | Unchanged: the first operand is missing. |

## 3. Groups and tabstops

| Source group | Ordinary rendering | Direct function argument |
| --- | --- | --- |
| `{E}` | `E` | `\Function(E)` |
| `(E)` | `(E)` | `\Function(E)` |
| `[E]` | `[E]` | `\Function[E]` |
| `[[E]]` | `[[E]]` | `\Function[[E]]` |
| `|E|` | `\lvert E\rvert` | `\Function\lvert E\rvert` |

Every explicit empty group creates exactly one tabstop, including `[[]]`.
Tabstops are numbered in rendered order across the entire expression. Their
unambiguous snippet spelling is ` ${1}`, ` ${2}`, etc.; ` ${1}` is equivalent to
`$1`. Each numbered tabstop has a preceding space. Renderers append `$0` for the
final cursor position, adding a space before it when no whitespace is present.

Source curly braces are grouping syntax and disappear, except when they delimit
a direct function argument, where they become parentheses. TeX braces needed by
styles, accents, and scripts are generated separately and remain in the output.

Groups nest recursively, without a fixed regex nesting depth. A vertical bar
closes the current bar group when that group is innermost; use another delimiter
to disambiguate nested absolute values, for example `|A+{|B|}|`.

## 4. Functions

A function consists of a listed name, optional scripts, and a required input.
Render its name with a leading backslash. An unwrapped argument receives
parentheses; a directly grouped argument follows the table above.

Examples: `HomA` → `\Hom(A)`, `Hom{AB}` → `\Hom(AB)`,
`HomudkA` → `\Hom_{k}(A)`, and `Homuoij{A}` → `\Hom_{i}^{j}(A)`.
Use `Hom{}` to request an empty argument with a tabstop.

Function vocabulary:

```text
sin|cos|arccot|cot|tan|sec|csc|ln|exp|det|arcsin|arccos|arctan|arccot|arccsc|arcsec|min|max|arg|dim|ker|det|trace|range|sqn|Aut|Hom|Mor|Ob|Iso|End|Inn|Out|GL|SL|SO|Tor|Ext|Ann|Ass|Div|Pic|Spec|Proj|Ker|dom|codom|lcm|lcf|gcd|hcf|gcf|sign|const|log|deg|rad|hom|coker|nil|Nil|jac|Jac|codim|disc|adj|Range|rank|Rank|Nul|Col|Row|Span|diag|Image|card|Perv|Var|Isom|Map|Nat|Lan|Ran|Arr|Sh|PShDesc|Fib|DFib|Gr|Fact|TS|Tot|Res|gr|rk|cf|Cone|Cocone|Disc|Bun|Rep|Ind|Coind|Alt|Mult
```

Names and capitalization are preserved, including `PShDesc` as one name.

## 5. Inputs, letters, styles, and accents

A letter is a single ASCII letter or digit, or one of the Greek names below.
Greek names receive a leading backslash. A grouped base can contain several
letters, inputs, operands, or a relaxed expression; `{Aalpha}` renders as
`A\alpha`.

Greek vocabulary:

```text
alpha|beta|gamma|delta|zeta|eta|varepsilon|theta|iota|kappa|vartheta|lambda|nu|pi|tau|upsilon|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|[A-Za-z0-9]
```

Styles are prefixes and wrap their base as `\style{base}`:

```text
ds|sf|bb|bs|bf|bm|rm|cal|scr|frk
```

Accents are suffixes and wrap the preceding styled input, including any scripts
that occurred before the accent:

```text
ovl|udl|ovb|udb|bar|bre|hat|til|dot|vec|itr|conj|trans|what|wtil
```

| Input | Output |
| --- | --- |
| `bfAovxhat[y]` | `\hat{\bf{A}^{x}}[y]` |
| `Ahatovx` | `\hat{A}^{x}` |
| `Aov{xhat}` | `A^{\hat{x}}` |
| `AovltoB` | `\ovl{A}\to B` |

On an input, complete accent names such as `ovl`, `ovb`, `udl`, and `udb`
win over script-prefix matches, except when a script marker is immediately
followed by a style prefix: `udbfk` means `ud` + `bfk`, not the accent `udb`.
On a function or symbol, this position accepts scripts rather than accents.

## 6. Scripts

| Marker | Meaning |
| --- | --- |
| `udE` | `_{E}` |
| `ovE` | `^{E}` |
| `uoEF` | `_{E}^{F}` |
| `ouEF` | `^{E}_{F}` |

The two operands of `uo` and `ou` are consumed separately. Thus `AxuoBC`
becomes `A\x_{B}^{C}`. Two distinct single markers can also be combined:
`AtoovfudgB` becomes `A\to^{f}_{g}B`. An owner can have at most one subscript
and one superscript; group an operand to put another script inside it.

A script operand supports functions, styled inputs, groups, and `*` as an
additional letter. Groups use the relaxed expression grammar. Curly braces are
invisible; parentheses, square brackets, double square brackets, and absolute
value delimiters remain visible.

Examples:

- `Aud{AtsB}` → `A_{A\ts B}`.
- `Aov[bfAwedB]` → `A^{[\bf{A}\wed B]}`.
- `Aov{Budn}` → `A^{B_{n}}`.
- `Aov{*}` → `A^{*}`.
- `Auo{}{}` → `A_{ ${1}}^{ ${2}}`.

A missing script operand produces no tabstop and no empty script. A following
named symbol remains available to the surrounding expression. For example,
`AtoovtoB` becomes `A\to\to B`.

### Attachment rules for ambiguous suffixes

An unwrapped script operand ends before an accent or another explicit script
marker. Those suffixes attach to the enclosing input, consistent with
`bfAovxhat[y]`. Wrap a script operand to give it its own accent or explicit
scripts. Quick scripts and an immediate simple intermediate are included in an
unwrapped script operand. For example, `AovB[x]` means `A^{B[x]}`.

### Quick input scripts

On an input, an immediate run of apostrophes is preserved. An immediate run of
asterisks or digits becomes a subscript:

- `A''` → `A''`.
- `A*` → `A_{*}`.
- `A12` → `A_{12}`.

Quick scripts occur directly after the base and before explicit scripts or an
accent. They do not apply to bare function names or symbols.

## 7. Intermediates

An input can end with one parenthesized, bracketed, or double-bracketed
`simple_input`. Its delimiters remain visible. A simple input has no further
intermediate of its own. Grouped bases retain their normal grouping behavior.
An empty intermediate creates a tabstop.

Examples: `A[x]`, `A(x)`, and `A[[x]]`. A direct expression such as `A[BtoC]`
is invalid as an intermediate; group the inner expression as a base, for
example `A[{BtoC}]`.

## 8. Symbols and custom mappings

Symbols cannot be replaced by an empty group. The outer grammar always requires
a real symbol between successive operands. A symbol can carry scripts.

Named symbols receive a leading backslash:

```text
perp|cir|com|nabla|notin|defeq|bot|top|iso|ito|isto|sto|mto|eto|lto|mid|Mid|nmid|cap|bcap|Cap|cup|bcup|Cup|vee|Vee|subp|sube|subn|supp|supe|supn|neq|geq|leq|bast|Ast|star|Star|sharp|ilim|dlim|plim|lim|colim|scup|sqcap|bscup|bsqcap|seq|noe|nop|aeq|cleq|lhd|rhd|equ|opl|Opl|upl|Upl|ts|Ts|amal|wed|bwed|bvee|dia|para|lx|prop|odot|Odot|dagg|idp|longto|from|longfrom|sum|dsum|prd|dprd|coprd|lapla|curl|dive|grad|To|Longto|sim|bd|pdx|pdy|pdz|pdt|ddx|ddy|ddz|ddt|bd|neg|id|Id|bull|heart|hbar|pm|bx|Im|Re|Pi|to|sup|gg|sub|approx|ne|ge|le|x|bx|X|pre|suc|npre|nsuc|pree|suce|dto|trto|xsto|adju|flat|ast|iff|Iff|int|ell|not|pi|ll|in
```

The characters `- + = : < > /` render literally. Under the section 15
extension, literal `(` and `)` also render unchanged and may carry scripts;
the same characters remain available as operand bases and wrapping delimiters. Additional spellings are
configured in `NONSTANDARD_SYMBOL_DICTIONARY`; its values are complete TeX
strings. The initial mappings are:

```javascript
const NONSTANDARD_SYMBOL_DICTIONARY = Object.freeze({
  '\\': '\\backslash',
  olp: '\\olp',
  bslash: '\\backslash'
});
```

`olp` retains the earlier shorthand supported by these snippets. For automatic
expansion, write `AbslashB` to obtain `A\backslash B`. The low-level parser
retains the original backslash dictionary entry, but automatic expansion never
accepts raw backslashes: `A\B` could already be native TeX. TeX command
names are preserved as supplied; definitions of custom commands belong in the
LaTeX document.

## 9. Integration and verification

- Import `snippets.json`; it contains the complete snippet collection and the
  updated JavaScript helpers in `globals.javascript`.
- `globals.js` is the same helper source for workflows that manage globals
  separately. Load one copy of the globals, not both copies into one scope.
- The two trigger patterns capture complete non-whitespace candidates ending
  in whitespace, a period, comma, or semicolon. The shared parser validates the
  grammar. Invalid or excluded candidates return their original literal text
  without adding escapes to backslashes or braces. Math candidates must begin
  at the start of input or after whitespace; text candidates preserve their
  whitespace/leading-comma behavior without matching inside larger tokens.
- Text mode adds inline math delimiters; math mode renders only the expression.
  Existing leading-dollar and comma behavior is preserved.
- Source curly brackets, bars, and square brackets are now included in both
  trigger patterns. No fixed-depth expansion of nested regexes is needed.
- Run `node test-snippets.cjs` beside the two implementation files. The checks
  cover the examples, failures, all token vocabularies, tabstop numbering,
  both trigger/body paths, exclusions, and equality of embedded/global helpers.

Validation was performed in Node.js. The Eukolia editor itself was not available
for an end-to-end import and keyboard test.


## 10. Native LaTeX conflict protection

The automatic renderers treat existing LaTeX source as authoritative.

- Raw backslashes are excluded from both candidate regexes. The renderer also
  rejects them defensively if called through an older trigger definition.
- Do not reinterpret a suffix after a native script marker, command, punctuation,
  or other character inside a larger non-whitespace token. For example,
  `A_{n}toB`, `\foo,AtoB`, and `\ts(a\tsB` remain unchanged.
- A rejected candidate is returned literally; the rejection path adds no TeX
  escapes. Malformed groups such as `AtoB}` therefore remain unchanged too.
- Plain `A`, `2`, `{AB}`, and `(AB)` are not enough to request automatic
  conversion. Explicit shorthand such as `AtoB`, `HomA`, `Aovx`, or `{}toA`
  still expands.
- When the host supplies normal RegExp match metadata (`input` and `index`),
  the renderer also checks the available prefix. It preserves candidates inside
  unfinished text/metadata arguments, comments, and `\verb`/`\verb*` spans. A command
  followed by a separate expression, as in `\alpha AtoB`, does not block the
  new expression. Escaped percent signs do not start comments.
- The guard can inspect only the prefix the host supplies; it is not a complete
  LaTeX document parser. The editor's math/text context detection still applies.
- Excessive recursive nesting that reaches JavaScript's stack limit falls back
  to literal preservation instead of throwing from the automatic parser.

The regression suite includes direct calls with old-style matches, token
boundaries, protected-prefix cases, malformed groups, every listed native
command, and repeated application to already-rendered results. The earlier
nested grammar, script, accent, exclusion, and tabstop tests remain in place.

Install the complete updated JSON, which embeds the matching globals. If using
separately managed globals, update those together with the two trigger patterns.
Updating only one component leaves part of the fix unapplied.


## 11. Function scripts, comma arguments, and continued editing

A group immediately following an unwrapped function script belongs to the
function's argument. Thus `Homudbfk(A)` renders as `\Hom_{\bf{k}}(A)`,
and `Homuoij(A,B)` renders as `\Hom_{i}^{j}(A,B)`. To include an intermediate
inside the script itself, group that script operand explicitly:
`Homud{k(A)}B` renders as `\Hom_{k(A)}(B)`.

Balanced groups accept comma-separated content, including nested functions:
`Hom(A,B)`, `Hom(Hom(A,B),C)`, and `Hom(AtoB,C)`. Commas render literally.
Empty comma slots do not create tabstops; use an explicit empty group such as
`Hom(A,{})` when a placeholder is wanted. An outer comma still terminates an
expansion; ungrouped `A,B` is not a compact outer expression.

Every generated numbered placeholder has a preceding ASCII space. For example,
`Hom()` produces `\Hom( ${1})`, while `Auo{}{}` produces
`A_{ ${1}}^{ ${2}}`. The final `$0` also gets a preceding space unless the
expansion already ends in whitespace. Rejected inputs remain unchanged.

The context guard allows a new, whitespace-separated shorthand expression inside
ordinary mathematical arguments and scripts. This is necessary for typing into
those placeholders. Textual arguments such as `\text{...}`, operator names,
labels, comments, and verbatim spans retain their protection when match-prefix
metadata is available. Existing native TeX tokens are still never reparsed.

The regression suite checks both trigger/body paths for function scripts and
comma lists, and simulates typing `AtoB` at the generated placeholder positions.


## 12. Current syntax additions (updated uploaded files)

The current snippet IDs are `evil_text` and `evil_math`. The updated uploaded
collection has 640 snippets. Both retain the supplied priority of 50 and trigger
on whitespace, optionally preceded by punctuation. Their earlier IDs and trigger
descriptions elsewhere in this document describe previous revisions.

### Math boundaries and exclusions

Math candidates can start after whitespace, `{`, `}`, or `$`. Boundary characters
are retained: lookbehind does not consume them, and any surrounding brace prefix
included in the match is returned explicitly. A whole valid compact expression
is preferred; otherwise a later brace can delimit a fresh expression inside an
existing mathematical argument. Escaped boundary characters and protected text
arguments remain guarded.

`FIBERED_IGNORED_WORDS` applies to text only. The independent
`FIBERED_MATH_IGNORED_WORDS` starts empty; add case-insensitive math exclusions
there. `FIBERED_IGNORED_INPUTS` remains a shared case-sensitive exclusion set.

### Named quick scripts

Apostrophe introduces a quick superscript and a literal period introduces a
quick subscript. Both use this mapping, taken from `urwdsu` and `kdfkjsdl`:

| Key | TeX value |
| --- | --- |
| `a` | `*` |
| `e` | `!` |
| `h` | `\#` |
| `sh` | `\sh` |
| `d` | `\dagg` |
| `f` | `\flat` |

For example, `f'a.sh:XtoY` becomes `f^{*}_{\sh}: X\to Y`.
The colon now emits a following space. Named quick scripts can follow accents,
and each owner still admits only one subscript and one superscript. Ordinary
prime runs, numeric subscripts, and explicit script markers remain supported.

### Greek aliases

The aliases from `greek_text`, prefixed by `@`, are valid letters in ordinary
inputs, scripts, and quoted letter sequences. Longest aliases take precedence.
The supplied lookup lacks three keys accepted by its trigger; the new parser's
local alias table fills them as `@h` → `\eta`, `@p` → `\pi`, and
`@R` → `\mathrm{P}` (the conventional uppercase rho glyph). The original
`GREEK` table and unrelated Greek snippets are unchanged.

### Invisible symbol and quoted letters

`⋅` is an actual grammar symbol whose rendered value is empty. Thus
`bfA⋅Bhat` becomes `\bf{A}\hat{B}` without violating the rule against two
adjacent outer operands. Necessary TeX control-word separators are still emitted.

Double quotes delimit a sequence of letters only. ASCII letters/digits, full
Greek names, and `@` aliases are recognized; function, style, accent, operator,
and script syntax is not interpreted inside the quotes. Quotes disappear, and
the complete sequence counts as one base. Examples:

- `"A2"` → `A2`, with no numeric subscript.
- `"bfAhat"` → `bfAhat`, with no style or accent.
- `bf"AB"` → `\bf{AB}`.
- `"alpha@vth"` → `\alpha\vartheta`.
- `""` creates a spaced numbered tabstop, like an empty brace group.

Non-letter content such as `"A+B"` is rejected rather than evaluated as an
expression. Quotes carry no provenance after removal: explicitly re-triggering
on the resulting bare `A2`, for example, can apply the ordinary numeric-subscript
rule. No hidden marker is inserted into the TeX source.

The complete JSON embeds its matching globals. The regression suite covers all
six changes, prior parsing examples, actual trigger/body calls, all accepted
Greek aliases, mode-specific exclusions, punctuation, and native TeX protection.
Validation is in Node.js; editor-level testing remains unverified.


## 13. Inverse shorthand and unfinished script markers

Bare postfix `iv` is a quick superscript with value `-1`:
`fiv` → `f^{-1}`, `bfAiv` → `\bf{A}^{-1}`, and
`fiv:XtoY` → `f^{-1}: X\to Y`. It shares the existing superscript slot,
so it cannot add a second superscript to the same owner. Existing script operand
attachment rules remain in effect; use braces to disambiguate nesting.

At the end of an expression, missing operands of explicit script markers now
create numbered tabstops with the existing preceding space:

| Input | Rendered snippet content |
| --- | --- |
| `Aud` | `A_{ ${1}}` |
| `Aov` | `A^{ ${1}}` |
| `Auo` | `A_{ ${1}}^{ ${2}}` |
| `Aou` | `A^{ ${1}}_{ ${2}}` |
| `Atoov` | `A\to^{ ${1}}` |
| `AouB` | `A^{B}_{ ${1}}` |
| `Ato{Bov}` | `A\to B^{ ${1}}` |

This applies at the end of recursively parsed grouped expressions too. Ordinary
missing chain operands still create no tabstops. A missing script operand before
a following symbol is still omitted: `AtoovtoB` remains `A\to\to B`.
Quoted letters do not interpret `iv` or script markers.

### fnq6qi diagnosis and workaround

The uploaded snippet already declared `boundary: "anywhere"`, used the pattern
`\|`, and matched both `|` and `A|` in JavaScript. No competing text snippet
matched the tested `A|` input. Therefore its definition does not impose the
reported whitespace restriction; the editor's matching/context behavior cannot
be diagnosed conclusively from these files alone.

The revised pattern is `([^\s|]*)\|$`. It includes a preceding non-whitespace
token in the match, and the body returns that captured token before inserting
`|$1|$0`. This works around a matcher that requires a token boundary before the
match. It retains `context: "text"`; it is not intended to trigger in math mode.
The engine itself was not available for end-to-end verification.


## 14. `_` and `^` script markers; parenthesis boundaries

Both evil snippets accept `_` for a subscript and `^` for a superscript.
Each consumes one operand or one core symbol, preferring the symbol when both
are available. Longest symbol names retain priority within the symbol list.

| Input | Output |
| --- | --- |
| `A_n` | `A_{n}` |
| `A^x` | `A^{\x}` |
| `A^{x}` | `A^{x}` |
| `A^to` | `A^{\to}` |
| `A^bfB` | `A^{\bf{B}}` |
| `A^Hom(B)` | `A^{\Hom(B)}` |
| `A^x_n` | `A^{\x}_{n}` |
| `A_{BtoC}` | `A_{B\to C}` |
| `Hom_n(A,B)` | `\Hom_{n}(A,B)` |

The following script marker remains attached to the enclosing owner; to put
scripts on a script operand, group it explicitly, for example `A^{B_n}`.
The existing script operand rules for accents and intermediates still apply.
A trailing `_` or `^` creates a spaced tabstop, consistent with `ud` and `ov`.
Duplicate subscript/superscript slots on the same owner are rejected.
These additions supersede the earlier exclusion of native `_`/`^` characters
from candidate syntax; existing backslash-containing tokens remain protected.

In math mode, `(` and `)` now join whitespace, braces and dollar signs as
valid preceding boundaries. Boundaries outside the expression remain in the
source. A whole valid grouped expression still takes precedence over parsing
only a suffix. Escaped parentheses remain protected from use as boundaries.
No letter or symbol parsing is enabled inside quoted letter sequences.

The latest uploaded files are the base of this revision. Only the two evil
trigger patterns and their shared globals were changed. All parser and
trigger/body regression checks pass in Node.js; editor integration remains
unverified.


## 15. Balanced parentheses as symbols, operands, and wrapping indicators

This extension is implemented in the accompanying `globals.js`. Both evil
snippets call those helpers. The accompanying JSON preserves all 640 snippets;
only the two evil descriptions change, since their existing trigger character
classes already accept parentheses. This particular collection has no embedded
`globals.javascript` field: load the updated standalone globals as well as the
snippet collection. Earlier references to embedded globals describe older files.

### Whole-word balance requirement

Before automatic expansion, every word containing `(` or `)` must have properly
balanced parentheses. Scan left to right: `(` increases depth, `)` decreases it;
depth must never become negative and must end at zero. Equal counts alone are
insufficient: `A)(B` is rejected. Nested pairs such as `A((B))C` are valid.

The candidate itself must balance. When normal RegExp `input` and `index`
metadata are available, the complete surrounding non-whitespace word must also
balance. This prevents a trigger starting after a parenthesis from converting a
valid suffix of an invalid word. The math renderer checks balance **before** its
brace/parenthesis suffix fallback. No partial expansion is allowed to bypass it.
Without match metadata, only the captured candidate can be checked.

Thus `(a`, `(AtoB`, `AtoB)`, and `(a(toB` remain unchanged. Literal parenthesis
support does not relax this automatic-expansion requirement. Braces, brackets,
bars, exclusions, and native-LaTeX protection retain their existing rules.

### Token roles and priority

Each parenthesis can act as a one-character literal symbol or operand base.
A literal token renders as `(` or `)` without a backslash or an inserted partner.
Styles, accents, and scripts retain their existing category-specific rules.

A valid `(regex)` can still be one wrapped operand. Functions retain direct
wrapped arguments, and inputs retain valid intermediates. Empty `()` still
creates one numbered tabstop. The parser tries those existing interpretations
first, retaining shorter alternatives if the surrounding expression cannot
finish.

For `A(B)C`, consuming `A(B)` as an intermediate leaves an adjacent outer operand
`C`, which is invalid. The parser backtracks and reads:

- `A`: operand;
- `(`: symbol;
- `B`: operand;
- `)`: symbol;
- `C`: operand.

The expression therefore renders as `A(B)C`. In text mode it receives the usual
inline math delimiters; in math mode it renders directly. No placeholders are
inserted for the two literal parentheses.

The outer grammar remains `operand (symbol operand?)*`; arbitrary adjacent outer
operands are still invalid. Inside groups, the existing relaxed grammar applies.
For `_` and `^`, a valid parenthesized grouped operand takes priority over the
single-character symbol alternative: `A^(BtoC)` retains the complete group.

Ordinary grouped text such as `(AB)` or a plain intermediate `A(x)` still lacks
shorthand intent and is preserved. Parentheses used as separator symbols count
as syntax intent, so text-mode `A(B)C` can expand even without a named operator.
A standalone parenthesis fails the balance guard. Quoted letter sequences still
reject parentheses.

### Verified examples

The table shows expression content before text-mode delimiters, trailing input
whitespace, and the final cursor tabstop.

| Input | Rendered snippet content |
| --- | --- |
| `A(B)C` | `A(B)C` |
| `A(B)CtoD` | `A(B)C\to D` |
| `A(BtoC)D` | `A(B\to C)D` |
| `A((B))C` | `A((B))C` |
| `Ato(BtoC)` | `A\to(B\to C)` |
| `Hom(A,B)` | `\Hom(A,B)` |
| `Ato()` | `A\to( ${1})` |
| `A^(BtoC)` | `A^{(B\to C)}` |
| `A^()` | `A^{( ${1})}` |
| `(a` | Unchanged. |
| `(AtoB` | Unchanged. |
| `AtoB)` | Unchanged. |
| `A)(B` | Unchanged. |
| `(a(toB` | Unchanged; no suffix expansion. |

The Node.js checks exercise AST rendering, both actual evil regex/body paths,
whole-word and suffix balance protection, nested parentheses, placeholders,
previous script/function/style/spacing examples, and preservation of every
unrelated snippet definition. All 139 checks pass. Eukolia itself was not
available for an editor import and keyboard test.
