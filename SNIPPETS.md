# Snippets — setting them up and using them

Eukolia's snippet engine runs inside the editor: it expands short triggers into
LaTeX as you type, and it offers the rest from the completion list.

This document is the user-facing guide: where snippets live, every field of the
format, every placeholder form, the code-block API, the manager's UI, and what to
do when a snippet does not fire.

---

## 1. Quick start

1. Press **`Ctrl+Alt+L`** (the shortcut is `keybindings.openSnippets`).
2. **Add snippet**.
3. Fill in the trigger (`ff`), the body (`\frac{$1}{$2}$0`) and, on the Advanced
   tab, tick **Automatic** if you want it to expand the moment `ff` is typed.
4. Press **Save** (or `Esc`). The window closes and the file is written.
5. Type `ff` in a LaTeX document.

Everything else in this document is a refinement of step 3.

---

## 2. Where snippets live

| Scope | Path | Format |
| --- | --- | --- |
| Your library | `<appData>/User/snippets/snippets.json` | EUSnips (JSON) |
| Older files there | `<appData>/User/snippets/*.hsnips` | header + body text, imported once |
| The project | `<project>/snips/*.hsnips`, `*.snips`, `*.tex` | header + body text |

* `appData` is Electron's per-user directory; **Open the snippets folder** in the
  manager (Advanced) reveals it.
* The project folder is `snips` by default and configurable with
  `snippets.snippetDirectories`. Project snippets are deliberately kept as plain
  files: they belong in a repository and are shareable with people who do not use
  Eukolia.
* The first run writes the built-in library — the entries LaTeX Workshop ships —
  into `snippets.json`. **Restore built-in snippets** (Advanced) puts it back and
  **discards your own entries**; it asks first.

**Precedence.** Both scopes are loaded into one engine and sorted by `priority`,
highest first. Order is stable within a priority, and your library is loaded
first — so at equal priority your entry wins and a project entry overrides it only
with a higher `priority` (say `200`).

**Reloading.** The file is watched: editing `snippets.json` by hand takes effect
immediately. Changing workspace reloads the project folder as well.

---

## 3. The file

```json
{
  "version": 1,
  "name": "My snippets",
  "language": "latex",
  "defaults": { "context": "math", "priority": 100 },
  "snippets": [
    {
      "id": "ff",
      "trigger": { "pattern": "ff" },
      "description": "fraction",
      "expand": "auto",
      "body": "\\frac{$1}{$2}$0"
    }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `version` | Always `1`. |
| `name`, `description` | Free text, shown in the manager. |
| `language` / `namespace` | Which language the file's snippets apply to (`latex` by default; `all` makes them global). The two are aliases and must agree. |
| `includes` | Names of other snippet files this one is meant to be read with. |
| `defaults` | Values every entry in the file inherits (`priority`, `expand`, `boundary`, `hidden`, `multiline`, `context`, `enabled`, `tags`). An entry's own property always wins. |
| `globals` | File-level code and variables shared by the entries — see §12. |
| `metadata` | Bookkeeping. Records which older snippet files were already imported, so an import is never repeated. |
| `snippets` | The entries. |

### Entry fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | string | generated | Stable name for the entry, unique in the file. The manager generates six-character ids (letters, digits, `.`, `-`, `_`) for anything unnamed. |
| `trigger` | object | — | `{ "pattern": …, "flags": … }`. See §4. |
| `description` | string | `""` | Shown after the label in the completion list and in the history panel. |
| `priority` | integer | `100` | Higher wins when several entries match. |
| `expand` | `"manual"` \| `"auto"` | `"manual"` | `auto` expands the moment the trigger matches; `manual` is reached from the completion list. |
| `boundary` | see §5 | `"whitespace"` | How much of the text before the cursor the match has to be. |
| `hidden` | boolean | `false` | Still matches automatically, but is never offered in the completion list. |
| `multiline` | boolean \| integer | `false` | Match against the previous lines too. |
| `context` | string \| object \| array | `"any"` | Where the snippet may expand. See §6. |
| `body` | string \| array | — | What is inserted. See §8. |
| `tags` | array of strings | — | Your own labels; searchable in the manager. |
| `enabled` | boolean | `true` | A disabled entry stays in the file and is never offered. |
| `script` | object | — | A snippet-level script. **Preserved, not run** — see §12. |

---

## 4. Triggers

`trigger.pattern` is a **regular expression** matched against the line before the
cursor and anchored at the cursor: the engine appends `$` when the pattern does
not already end in one. The text you type *is* a pattern — `ff` is a regular
expression that matches the characters `ff` — which is why there is only one kind
of trigger, and why `boundary` (§5) is where you say how much of the token it has
to be.

```json
{ "trigger": { "pattern": "ff" } }              // the two characters f f
{ "trigger": { "pattern": "\\d+%" } }           // digits followed by a percent sign
{ "trigger": { "pattern": "(\\w+)bf" } }        // a capture group: $1 in the body
{ "trigger": { "pattern": "re", "flags": "i" } } // case-insensitive
```

* **The editor escapes plain text for you.** Typing `**` in the manager stores
  `\*\*`, so it matches two asterisks and not "any two characters". Backslashes,
  brackets and braces are escaped the same way. Switch to Advanced if you want to
  write the pattern yourself.
* **Capture groups.** Anything in `(…)` is available to the body as `$1`, `$2`, …
  — this is how a trigger's own text gets into the expansion:
  `snippet (\\?[a-zA-Z]\w*)(bf)` with the body `\mathbf{$1}$0` turns `\alphabf`
  into `\mathbf{\alpha}`. A `$1` that a group fills in is **text, not a tab stop**:
  it does not claim the caret, so where the caret ends up is decided by the stops
  the body still has — write `$0` where you want it:
  `snippet (\s*)\$(\s*);;` with the body ` $1$0\$ ` leaves the caret before the
  closing `$ `, while ` $1\$ $0` leaves it after it.
* **`flags`** are regular-expression flags: `i` (case-insensitive), `s`, `u`, …
  `g` and `y` are stateful and are **ignored** (the manager says so): every
  keystroke matches from the start.
* **What a pattern cannot contain.** A backtick and a line break. Both are
  reported in the manager.
* The pattern is matched against the current line, or against the multi-line
  context when `multiline` is on.

---

## 5. Boundaries

`boundary` says how much of the text before the cursor the match has to be. It is
the difference between a trigger that fires inside a word and one that does not.

| Value | The match must be… | Example |
| --- | --- | --- |
| `whitespace` (default) | everything since the preceding whitespace | `ff` fires in `\frac ff` but not in `staff` |
| `word` | the whole word at the cursor | `\alpha` fires in `x \alpha`; `staff` still does not |
| `anywhere` | a suffix of the line; it may end inside a word | `ff` fires in `staff` |
| `line-start` | as `whitespace`, and only whitespace may precede it on the line | `  ff` fires, `x ff` does not |

A multi-line pattern is judged on the whole context it matched, since it begins on
an earlier line.

---

## 6. Context

`context` decides where an entry is eligible. The engine evaluates three:

| Value | Meaning |
| --- | --- |
| `"any"` | Everywhere (the default). |
| `"math"` | Inside mathematics — between `$…$`, `\(…\)`, `\[…\]`, or in a mathematics environment. |
| `"text"` | The opposite: outside mathematics. |
| `{ "not": "math" }` | Same as `"text"`; `{ "not": "text" }` is `"math"`. |
| `{ "any": [ … ] }` | True when any member is true. |

Mathematics is read from the document text before the cursor — not from a parse of
the document — by a scanner that keeps the state a LaTeX reader would:

* `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, and the mathematics environments
  (`equation`, `align`, `gather`, `multline`, `alignat`, `flalign`, `eqnarray`,
  `math`, `displaymath`, `split`, `cases`, `array`, `matrix`, `pmatrix`, …).
  An opener with no closer leaves the caret in mathematics, exactly as LaTeX reads
  it — which is why a stray `$` in prose reads as mathematics for the rest of the
  document.
* **Ignored, because LaTeX ignores it:** comments (`% …` to the end of the line),
  `verbatim`/`lstlisting`/`minted`/`comment` environments, `\verb|…|`,
  `\lstinline|…|`, and the argument of `\url`/`\href`/`\path`. A `$` in any of
  those never opens mathematics.
* `\\[1ex]` is a **line break with vertical space**, not the start of display
  maths: `\[` opens display maths only when the backslash stands alone
  (`\\\[` is a break followed by real display maths).
* Inside mathematics, `\text{…}`, `\mbox{…}`, `\mathrm{…}` and `\operatorname{…}`
  are **text**: a word trigger stays quiet there.
* In the editor, a backtick span is literal (`` `$` `` is a code span), which is
  the one place it differs from LaTeX.

**Not implemented:** `"preamble"`, `"comment"`, `{ "type": "environment" }`,
`{ "type": "command" }`, `{ "type": "document-class" }` and
`{ "type": "package" }`. They are part of the format and survive a round trip, but
the engine cannot evaluate them yet, so an entry using one is **treated as
applying everywhere** and the manager reports it. The Simple tab offers only the
three contexts the engine evaluates for exactly this reason.

---

## 7. Multi-line triggers

`"multiline": true` matches the pattern against the previous lines as well as the
current one — how many is `snippets.multiLineContext` (20 by default).

An integer (`"multiline": 5`) is part of the format, is preserved, and is
**reported rather than honoured**: the engine reads on or off, and always the
configured number of lines.

```json
{
  "trigger": { "pattern": "\\\\\\end\\{align\\*?\\}\\s*$" },
  "multiline": true,
  "body": "\\end{align}$0"
}
```

---

## 8. The body

A body is mostly literal text with placeholders in it. Two characters are special:
`$` starts a placeholder, and a pair of backticks starts a code block. A literal
dollar is written `\$`.

### 8.1 Placeholders and tab stops

| Written | What it is |
| --- | --- |
| `$1`, `${1}` | An empty tab stop. |
| `${1:default}` | A tab stop whose initial text is `default`, selected so typing replaces it. |
| `${1\|a,b,c\|}` | A choice; the first option is inserted. |
| `$0` | The final cursor position. The expansion ends here. |
| `${1}` used again | A **mirror**: the same text appears in both places and both update together. |

Tab stops are numbered; the engine visits them in order:

* **`Tab`** (`snippets.tabStopKey`) moves to the next stop, **`Shift-Tab`** to the
  previous one. At the first stop `Shift-Tab` stays put.
* `$0` is always last, and moving onto it **finishes** the snippet: the tab stops
  stop capturing Tab.
* Clicking outside the expansion, switching files or closing the editor ends it as
  well, so a half-filled snippet cannot capture a key in another document.
* A snippet expanded while another is being filled in is kept on a stack: `Tab`
  walks the inner one first, then returns to the outer one.

### 8.2 Defaults, nesting and mirrors

A default may contain another placeholder or a variable; it is rendered down to
its text before it reaches the document:

```json
{ "body": "${1:${2:inner}}" }   // inserts: inner      (only the outer is a tab stop)
{ "body": "${1:${TM_FILENAME}}" } // inserts: the file name
```

A placeholder with the same number in two places is a mirror: `\begin{${1:env}} … \end{${1:env}}`
shows the default in both spots, and typing in either one updates the other.

### 8.3 The selection: `${VISUAL}`

`${VISUAL}` is replaced with text you had selected, which is how a "wrap this"
snippet works:

```json
{
  "trigger": { "pattern": "BEQ" },
  "description": "equation environment",
  "expand": "auto",
  "body": "\\begin{equation}\n\t${1:${VISUAL}}\n\\end{equation}$0"
}
```

* Select the text, then type the trigger. The trigger character replaces the
  selection, so the selection itself is remembered from the moment you made it —
  and only for **five seconds**, which is the engine's freshness rule.
* Only selections *you* made count. The text a snippet itself selects (its first
  placeholder) never becomes `${VISUAL}`.
* `${VISUAL:default}` uses `default` when there is no selection, which is the form
  LaTeX Workshop's own snippets use (`\textnormal{${1:${VISUAL:text}}}`).

### 8.4 Variables

`${NAME}` and `${NAME:default}` — a name the host knows is replaced by its value,
then by the default, then by nothing:

| Name | Value |
| --- | --- |
| `TM_FILENAME` | `homework.tex` |
| `TM_FILENAME_BASE` | `homework` |
| `TM_DIRECTORY` | the file's directory |
| `TM_FILEPATH` | the file's full path |
| `CURRENT_YEAR`, `CURRENT_MONTH`, `CURRENT_DATE`, `CURRENT_DAY_NAME` | today's date, in pieces |

Any other name renders its default (`${FOO:bar}` → `bar`) or nothing (`${FOO}` →
nothing), so a snippet copied from elsewhere degrades quietly instead of putting
`${FOO}` in your document.

The host also answers `fileName`, `dirName`, `workspaceUri`, `fileUri` and `date`
— the base values it hands a resolver, which a snippet may use directly.

### 8.5 Code blocks

A body may compute its text. Two backticks open and close a code block, the
JavaScript between them runs, and the value of `rv` when it finishes is inserted
in its place:

```json
{
  "trigger": { "pattern": "(\\w+)up" },
  "description": "uppercase the word before `up`",
  "expand": "auto",
  "body": "``rv = m[1].toUpperCase()``$0"
}
```

Typing `alphaupt` inserts `ALPHA`. `rv` is reset to the empty string before each
block, so a block that never assigns it inserts nothing.

**What a block can see**

| Name | Value |
| --- | --- |
| `t` | The tab stops' text, in order — what the author has typed into them. On the first run it is each stop's default. |
| `m` | The trigger's capture groups (`m[1]`, `m[2]`, …). |
| `w` | The project's path. |
| `path` | The document's URI. |
| `context` | Always `undefined` — the reference bound Node's `require` here and Eukolia deliberately does not. |
| anything a `global … endglobal` block declares | Shared with every snippet in the same file. |

**What a block cannot see.** The page and the machine are out of reach: `window`,
`document`, `globalThis`, `process`, `require`, `Buffer`, `fetch`,
`XMLHttpRequest`, `localStorage`, `setTimeout`, `eval`-style escapes and the rest
of a list in `src/renderer/vendor/hypernips/parser.ts` are bound to a value that
**throws** the moment it is used. This is a scope restriction, not a hardened
sandbox: treat a `.hsnips` file from elsewhere as code you are choosing to run.

**Turning it off.** `snippets.allowJavaScript` off means a block does not run at
all: the snippet expands to nothing and reports why. That is the same outcome as
a block that throws — a body's sections are built by its generator, so a generator
that refuses leaves no text to insert.

**When blocks run.** Once, when the snippet expands; `t` then holds each stop's
default. Recomputing a block as you type into a placeholder is not wired into the
editor yet, so a block that depends on `t` shows its expansion-time answer.

### 8.6 Substitutions

`${1/find/replace/}` is recognised — it is not left in the document as markup —
and preserved in the file, but the engine **does not compute it yet**: the tab
stop inserts its own text. A code block is the way to compute text today.

---

## 9. How a snippet fires

**Automatic** (`"expand": "auto"`) expands on the keystroke that completes the
match. It needs `snippets.enabled` and `snippets.autoExpand` both on, and only
genuine typing counts: pasting, undoing and programmatic edits never fire a
snippet.

**Manual** (`"expand": "manual"`, the default) is reached from the completion list
that appears as you type. The list is answered by the same matcher the editor
uses, so an entry shows up when the text before the cursor matches its trigger or
a leading part of it:

* the label is the matched text, or the trigger when only part of it matched;
* the description follows it;
* entries marked `hidden` are never offered;
* the list is capped at 50 entries;
* an entry that has just been inserted is not immediately offered again (press
  `Ctrl-Space` to ask anyway).

Both kinds of expansion are one undoable step together with the trigger.

**When several match,** `priority` decides — highest first. With equal priority
the order is the load order: your library, then the project's folder, each in file
order.

**Nesting.** An expansion can start inside another one's placeholder: the inner
snippet is expanded, and `Tab` walks its stops before returning to the outer one.

---

## 10. The Snippet Manager (`Ctrl+Alt+L`)

A pop-up over the window, not a settings page: you open it, change something, and
close it. `Ctrl+Alt+L` again or `Esc` closes it.

| Part | What it does |
| --- | --- |
| Search box | Filters by trigger, description, body, tags and id. |
| Status filter | All / enabled / disabled / entries with problems. |
| List | One row per entry: trigger, description, and a marker for problems or unsaved changes. |
| **Add**, **Duplicate**, **Delete** | Operate on the selected entry. |
| **Simple** / **Advanced** | Simple shows what most entries need (trigger, behaviour, context, description, body) plus the **Try it** box; Advanced adds the id, boundary, the remaining contexts, multi-line, tags, the script/data fields, and the file actions. Both edit the same entry, so switching cannot lose anything. |
| **Generate** | A fresh unused id. |
| **Try it** | Type a sample; the real projection, parser and matcher say what would happen — "Expands", "Offered by the completion list", "No match", or why the entry cannot run. It also shows the pattern as it is read and how the boundary is applied. |
| **Save** | Writes the file and closes. `Esc` does the same. |

**Saving.** Nothing is written while you type. Every change is applied to the
library in memory at once — a trigger works as soon as you type it — and the file
is written **once, when the window closes**. A row whose entry differs from what is
on disk carries a grey dot. A document that does not validate cannot be saved: the
window says so and stays open rather than dropping your edit, and an invalid file
is never written.

**Advanced file actions:** *Restore built-in snippets* (replaces the library —
your entries are lost), *Open the snippets folder*, and, when legacy `.hsnips`
files are present, an import button per file.

---

## 11. The Snippets panel (history)

The sidebar's snippet panel lists the expansions that actually fired, newest
first: the entry's id or trigger, what it inserted, and when. Selecting one shows
the snippet, its template, the inserted text and where it landed — which is how
you find out *which* `beg` fired when two of them exist. **Clear** empties the
list; the last 200 expansions are kept.

---

## 12. Globals, and what is preserved but not run

### 12.1 Global JavaScript — shared helpers

`globals.javascript` is written back out as a `global … endglobal` block ahead of
the file's snippets, so **the functions it declares are in scope for every code
block in the file**. That is how a library keeps one copy of a helper:

```json
{
  "globals": {
    "javascript": "function openInlineMath(m, content = \"\") {\n  return m[1] ? content : m[2] + \"\\\\$\" + content;\n}"
  },
  "snippets": [
    { "trigger": { "pattern": "(\\s+)([A-Zb-z])" }, "body": "``rv = openInlineMath(m, m[2]);``$0" }
  ]
}
```

It is compiled in the same restricted scope as a body's code blocks (§8.5), and it
runs when the library loads. `snippets.allowJavaScript` off stops the *bodies*
from running; the globals are still compiled, because they are part of the
library's definition rather than something an expansion asks for.

The **Library** page (Advanced) has an editor for it, and the **Try it** box uses
it, so an entry that calls a helper can be tested there.

### 12.2 Preserved but not run

These are part of the format, survive any round trip, and are reported by the
manager rather than silently ignored:

| Field | Status |
| --- | --- |
| `globals.variables` | Kept; not substituted into bodies — use `${NAME}` variables (§8.4) or a code block. |
| `script` (snippet-level) | Kept; the engine executes a body's code blocks and has no second point of execution for a snippet-level script. |
| `${1/find/replace/}` substitutions | Kept; not computed (§8.6). |
| `"multiline": <integer>` | Kept; the count is ignored (§7). |
| Context objects (`environment`, `command`, …) | Kept; treated as "everywhere" (§6). |

---

## 13. Importing existing snippets

* **Older snippet files** (`*.hsnips`) in `User/snippets/` are read and offered
  for import when the manager opens. An import is recorded as a receipt in the
  file's `metadata.imports`, so it happens once; if a source file changes
  afterwards, the manager offers to import it again.
* **LaTeX Workshop's library** is what the built-in first-run library was made
  from. Triggers, descriptions and bodies are kept, and every entry is given a
  stable id.
* What a file's header says about an entry *becomes properties*: automatic
  expansion, the boundary, the context, multi-line and hidden all arrive as the
  fields the manager shows. A header can ask for more than one boundary rule at
  once and only one of them can decide, so the others are not carried — everything
  else survives, including the body verbatim.
* A file's `global … endglobal` block is imported into the file's
  `globals.javascript`, and is compiled with the library, so an imported library's
  shared helpers keep working (§12.1).

---

## 14. Settings

| Key | Default | What it does |
| --- | --- | --- |
| `snippets.enabled` | `true` | The whole engine. Off: no automatic expansion, no completion entries, and `Tab` stops walking a snippet's tab stops. |
| `snippets.autoExpand` | `true` | Automatic expansion while typing: entries set to expand by themselves fire as soon as their trigger matches. |
| `snippets.allowJavaScript` | `true` | Backtick code blocks. Off: they do not run. |
| `snippets.multiLineContext` | `20` | How many previous lines a multi-line trigger is read against (1–200). |
| `snippets.snippetDirectories` | `["snips"]` | Project-relative folders read for `.hsnips`, `.snips` and `.tex` snippet sources. |
| `snippets.tabStopKey` | `Tab` | The key that walks to the next tab stop (CodeMirror key name, e.g. `Ctrl-Enter`). `Shift-Tab` always walks back. Changing it re-binds open editors immediately. |
| `keybindings.openSnippets` | `Ctrl+Alt+L` | Opens the snippet library. |

---

## 15. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing expands while typing | The entry is `manual` (the default) | Tick **Automatic**, or pick it from the completion list |
| | `snippets.enabled` or `snippets.autoExpand` is off | Settings → Snippets |
| | The entry is disabled | **Enabled** in Advanced, or the row's switch |
| `ff` fires in `\frac ff` but not in `staff` | The default boundary is `whitespace` | Set `boundary` to `anywhere` |
| A trigger fires in prose but should not | No context | Set `context` to `math` |
| A `context: "math"` entry fires in prose anyway | Something before the cursor reads as an open delimiter: a stray `$` (prose about money), or a `$`/`\[` in a construct the scanner does not ignore. Comments, verbatim environments, `\verb`, `\lstinline` and `\url` arguments **are** ignored; an *unclosed* `$` is not — LaTeX would call that mathematics too | Find the unbalanced `$` (it is a LaTeX error as well) |
| A trigger never fires | The pattern contains a backtick or a line break | Reported in the manager; rewrite the trigger |
| | You wrote a regex and it matches too much or too little | Check **Read as** in **Try it**, which shows the compiled pattern |
| A dollar in the body turned into a placeholder | A literal `$` is `\$` | Escape it |
| The expansion inserted nothing at all and warned | A code block threw, or `snippets.allowJavaScript` is off | Fix the block, or turn scripting back on |
| What I typed **disappeared** and nothing was inserted | A code block threw, and a body's sections are built *by* its generator — so a block that throws leaves no text to insert, and the matched trigger is already gone. The usual cause is a helper the body calls that is not defined (a missing `globals.javascript`, or one that does not declare it) | Put the helper in the Library page's **Global JavaScript** (§12.1), and test with **Try it**, which now names the error |
| `${FOO}` appeared in the document | The name is neither a host variable nor a *nested* token — a nested one is rendered, an unknown one is not | Use a supported name (§8.4), or write the text directly |
| `Tab` indents instead of moving to the next stop | The snippet finished (it is on `$0`), or the caret left it | Expected: move the caret back into the snippet |
| A change does not reach the file | The manager writes on close | Press **Save** or `Esc` |
| The manager refuses to save | An entry does not validate | The offending field is marked; fix it, or delete the entry |

---

## 16. Worked examples

**Fraction with two stops**

```json
{
  "id": "ff",
  "trigger": { "pattern": "ff" },
  "description": "fraction",
  "expand": "auto",
  "context": "math",
  "body": "\\frac{$1}{$2}$0"
}
```

**Environment with a default, inserted twice as a mirror**

```json
{
  "id": "beg",
  "trigger": { "pattern": "beg" },
  "description": "begin/end",
  "expand": "auto",
  "boundary": "line-start",
  "body": "\\begin{${1:equation}}\n\t$0\n\\end{${1:equation}}"
}
```

**Wrap the selection**

```json
{
  "id": "emph",
  "trigger": { "pattern": "emph" },
  "description": "emphasise the selection",
  "body": "\\emph{${1:${VISUAL}}}$0"
}
```

**Computed text with a code block**

```json
{
  "id": "date",
  "trigger": { "pattern": "today" },
  "description": "today's date",
  "body": "``rv = new Date().toISOString().slice(0, 10)``$0"
}
```

**Trigger text into the expansion with a capture group**

```json
{
  "id": "bf",
  "trigger": { "pattern": "(\\\\?[a-zA-Z]\\w*)bf" },
  "description": "bold a command",
  "expand": "auto",
  "body": "\\mathbf{$1}$0"
}
```
