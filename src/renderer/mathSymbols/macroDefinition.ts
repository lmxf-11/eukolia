/**
 * Eukolia — reading a LaTeX macro declaration.
 *
 * The catalog says what a symbol is; this module says what the *project* calls
 * it. It answers two questions and nothing else:
 *
 *  1. **What does this declaration say?** — its kind, how many arguments it
 *     takes, and, when it is a zero-argument definition, the body it expands to.
 *  2. **Which catalog constructs does that body denote?** — the signature a
 *     project alias has to match before Eukolia will offer it in place of the
 *     canonical spelling.
 *
 * Both are answered by scanning the declaration's own source with a balanced
 * reader rather than by matching a regular expression against it. A regex cannot
 * read `\newcommand{\vect}[1]{\mathbf{#1}}` correctly: the body contains braces,
 * the argument count is optional, the name may or may not be braced, and there
 * may be a default value between the two. `projectMacros.ts` already shows what
 * the regex version costs — it reads bodies for MathJax and answers `null` for
 * anything it does not recognise, which is right there and wrong here, because
 * here an unrecognised declaration has to end up *uncertain* rather than absent.
 *
 * The one rule that governs everything below: **`\let` binds at declaration
 * time, and everything else expands at use time.** `\let\R\mathbb` makes `\R`
 * another name for whatever `\mathbb` was at that point, so `\R` is an alias of
 * the control sequence. `\def\R{\mathbb}` makes `\R` expand *later*, so what it
 * denotes is its body, not the command. Conflating the two is how a resolver
 * ends up offering a command that means something else by the time it runs.
 */

import type { MacroDeclarationKind, ProjectMacro } from './types'

/** What a declaration's source says, as far as it can be read. */
export interface ParsedMacroDeclaration {
  /** Without the backslash. */
  readonly name: string
  readonly kind: MacroDeclarationKind
  readonly args: number
  /** The body of a braced definition, or `null` when there is none to read. */
  readonly body: string | null
  /** The control sequence a `\let` bound the name to. */
  readonly letTarget: string | null
  /** The text of a `\DeclareMathOperator`. */
  readonly operatorText: string | null
  /** `\newcommand*`, `\DeclareMathOperator*`. */
  readonly starred: boolean
}

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */

const isSpace = (character: string): boolean =>
  character === ' ' || character === '\t' || character === '\n' || character === '\r'

const skipSpace = (text: string, index: number): number => {
  let at = index
  while (at < text.length && isSpace(text[at])) at += 1
  return at
}

/** The index of the `{` that closes the group opened at `open`, or `-1`. */
function matchingBrace(text: string, open: number): number {
  let depth = 0
  for (let at = open; at < text.length; at += 1) {
    const character = text[at]
    if (character === '\\') {
      at += 1
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return at
    }
  }
  return -1
}

/** The group starting at `text[index]`, and where it ends. */
function readGroup(text: string, index: number): { body: string; end: number } | null {
  const start = skipSpace(text, index)
  if (text[start] !== '{') return null
  const close = matchingBrace(text, start)
  if (close === -1) return null
  return { body: text.slice(start + 1, close), end: close + 1 }
}

/** The control sequence starting at `text[index]`, and where it ends. */
function readControlSequence(text: string, index: number): { name: string; end: number } | null {
  const start = skipSpace(text, index)
  if (text[start] !== '\\') return null
  const match = /^\\([A-Za-z]+|.)/.exec(text.slice(start))
  if (!match) return null
  return { name: match[1], end: start + match[0].length }
}

/** The optional `[...]` starting at `text[index]`, if there is one. */
function readOptional(text: string, index: number): { body: string; end: number } | null {
  const start = skipSpace(text, index)
  if (text[start] !== '[') return null
  let depth = 0
  for (let at = start; at < text.length; at += 1) {
    const character = text[at]
    if (character === '\\') {
      at += 1
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') depth -= 1
    else if (character === ']' && depth === 0) {
      return { body: text.slice(start + 1, at), end: at + 1 }
    }
  }
  return null
}

/** A macro's name, written either braced or bare. */
function readMacroName(text: string, index: number): { name: string; end: number } | null {
  const start = skipSpace(text, index)
  if (text[start] === '{') {
    const group = readGroup(text, start)
    if (!group) return null
    const inner = readControlSequence(group.body, 0)
    if (!inner || skipSpace(group.body, inner.end) !== group.body.length) return null
    return { name: inner.name, end: group.end }
  }
  return readControlSequence(text, start)
}

/* ------------------------------------------------------------------ *
 * Declarations
 * ------------------------------------------------------------------ */

const BRACED_KINDS: Readonly<Record<string, MacroDeclarationKind>> = {
  newcommand: 'newcommand',
  renewcommand: 'renewcommand',
  providecommand: 'providecommand',
  newrobustcmd: 'newcommand',
  DeclareRobustCommand: 'newcommand'
}

const PRIMITIVE_KINDS: Readonly<Record<string, MacroDeclarationKind>> = {
  def: 'def',
  edef: 'def',
  gdef: 'def',
  xdef: 'def'
}

/**
 * Reads one declaration.
 *
 * `fallbackName` and `fallbackArgs` come from the document analysis, which has
 * already found the declaration and knows its name and arity. They are the
 * answer when the source cannot be read — a `\let` to a character, a definition
 * split across a conditional — so a declaration is never lost just because this
 * reader does not recognise it; it is downgraded to `unknown` instead.
 */
export function parseMacroDeclaration(
  definition: string,
  fallbackName: string,
  fallbackArgs = 0
): ParsedMacroDeclaration {
  const text = definition.trim()
  const head = readControlSequence(text, 0)
  const bare = fallbackName.replace(/^\\/, '')
  if (!head) {
    return {
      name: bare,
      kind: 'unknown',
      args: fallbackArgs,
      body: null,
      letTarget: null,
      operatorText: null,
      starred: false
    }
  }

  const starred = text[head.end] === '*'
  let at = starred ? head.end + 1 : head.end
  const kind = BRACED_KINDS[head.name]

  if (kind) {
    const parsed = readMacroName(text, at)
    if (parsed) {
      at = parsed.end
      const count = readOptional(text, at)
      if (count) at = count.end
      const fallback = readOptional(text, at)
      if (fallback) at = fallback.end
      const group = readGroup(text, at)
      // `\providecommand` with no body is legal LaTeX and means "do nothing if
      // it exists" — there is nothing to expand to, and the canonical meaning
      // stands, so the body stays `null` rather than becoming an empty one.
      const declared = count && /^\s*\d+\s*$/.test(count.body) ? Number(count.body.trim()) : 0
      return {
        name: parsed.name,
        kind,
        args: declared,
        body: group ? stripOuterBraces(group.body) : null,
        letTarget: null,
        operatorText: null,
        starred
      }
    }
  }

  const primitive = PRIMITIVE_KINDS[head.name]
  if (primitive) {
    const parsed = readControlSequence(text, at)
    if (parsed) {
      const parameters = text.slice(parsed.end)
      const open = parameters.indexOf('{')
      const group = open === -1 ? null : readGroup(parameters, open)
      const parameterText = group ? parameters.slice(0, open) : parameters
      return {
        name: parsed.name,
        kind: primitive,
        args: new Set([...parameterText.matchAll(/#([1-9])/g)].map((match) => match[1])).size,
        body: group ? stripOuterBraces(group.body) : null,
        letTarget: null,
        operatorText: null,
        starred: false
      }
    }
  }

  if (head.name === 'let') {
    /*
     * The name, then the target — in that order, and reading the target from
     * where the *name* starts is the mistake this branch used to make: it
     * answered `\let\R\mathbb` with `letTarget: 'R'`, and every alias built from
     * a `\let` then pointed at itself.
     */
    const parsed = readMacroName(text, at)
    if (parsed) {
      let targetAt = skipSpace(text, parsed.end)
      if (text[targetAt] === '=') targetAt = skipSpace(text, targetAt + 1)
      const target = readControlSequence(text, targetAt)
      return {
        name: parsed.name,
        kind: 'let',
        args: 0,
        body: null,
        letTarget: target ? target.name : null,
        operatorText: null,
        starred: false
      }
    }
  }

  if (head.name === 'DeclareMathOperator' || head.name === 'DeclareMathOperatorX') {
    const parsed = readMacroName(text, at)
    if (parsed) {
      const group = readGroup(text, parsed.end)
      return {
        name: parsed.name,
        kind: 'DeclareMathOperator',
        args: 0,
        body: null,
        letTarget: null,
        operatorText: group ? group.body.trim() : null,
        starred
      }
    }
  }

  if (head.name === 'newenvironment' || head.name === 'renewenvironment') {
    const parsed = readMacroName(text, at)
    if (parsed) {
      return {
        name: parsed.name,
        kind: 'newenvironment',
        args: 0,
        body: null,
        letTarget: null,
        operatorText: null,
        starred
      }
    }
  }

  // The analysis said this is a declaration and this reader does not know the
  // spelling. Keeping the name and arity and marking the kind unknown is the
  // honest answer: the command exists, its meaning does not.
  return {
    name: bare,
    kind: 'unknown',
    args: fallbackArgs,
    body: null,
    letTarget: null,
    operatorText: null,
    starred: false
  }
}

/* ------------------------------------------------------------------ *
 * Signatures
 * ------------------------------------------------------------------ */

/**
 * `text` with its outer brace groups removed, while it is one whole group.
 *
 * `{\mathbb{R}}` and `\mathbb{R}` are the same expression, and a declaration may
 * be written either way. Only a group that *is* the whole expression is
 * stripped, so `{a}{b}` keeps both.
 */
function stripOuterBraces(text: string): string {
  let current = text.trim()
  for (;;) {
    if (!current.startsWith('{')) return current
    const close = matchingBrace(current, 0)
    if (close !== current.length - 1) return current
    current = current.slice(1, close).trim()
  }
}

/**
 * The comparable form of an expression, or `null` when it cannot be compared.
 *
 * Whitespace is collapsed, and the space TeX ignores after a control word is
 * removed — `\mathbb {R}` and `\mathbb{R}` denote the same thing, and a
 * declaration may be written either way. Nothing else is normalised: a body that
 * differs from the canonical one in any other respect must *not* match, because
 * the whole point of the signature is to refuse `\newcommand{\R}{\mathcal{R}}`
 * as a spelling of the real numbers.
 *
 * `null` is returned for a body that names a parameter or a definition-time
 * expansion this module cannot follow, which keeps the caller from treating an
 * unreadable body as an empty one.
 */
export function canonicalExpression(text: string | null): string | null {
  if (text === null) return null
  const stripped = stripOuterBraces(text)
  if (stripped.length === 0) return null
  // A body that merely renames a parameter, or that contains a TeX conditional,
  // denotes something this module cannot decide. `#` outside a parameterised
  // body is already a placeholder; the caller has established the arity.
  if (/\\[a-zA-Z]*(?:if|else|fi|expandafter|csname|futurelet)\b/.test(stripped)) return null
  return stripped
    .replace(/\s+/g, ' ')
    .replace(/\\([A-Za-z]+)\s+/g, '\\$1')
    .trim()
}

/**
 * The signature of a catalog variant — the expression a matching project alias
 * has to expand to.
 *
 * A slot renders as `#n`, which is exactly how a parameterised LaTeX declaration
 * writes it, so `\newcommand{\vect}[1]{\mathbf{#1}}` and a `\mathbf` variant with
 * one slot produce the same signature and the equivalence is *shown* rather than
 * assumed.
 *
 * The braces around the slot are the *template's* own parts — `\mathbf` is
 * `["\mathbf{", slot, "}"]`, not `["\mathbf", slot]` — so wrapping the slot here
 * as well would make the signature `\mathbf{{#1}}`, which no declaration can
 * ever match.
 *
 * A variant with no slots is a plain expression rather than a parameterised one:
 * `\alpha` denotes `\alpha`, and `\mathbb{R}` denotes `\mathbb{R}`. Its
 * signature is that expression, which is what lets §7's headline example —
 * `\newcommand{\R}{\mathbb{R}}` — be recognised at all. Returning `null` here
 * instead, on the reasoning that "no slots means nothing to compare", silently
 * disabled every zero-argument alias in the catalog.
 */
export function variantSignature(
  parts: readonly ({ readonly text: string } | { readonly slot: number })[],
  slotCount: number
): string | null {
  let rendered = ''
  for (const part of parts) {
    if ('text' in part) rendered += part.text
    else if (slotCount > 0) rendered += `#${part.slot}`
  }
  return canonicalExpression(rendered)
}

/* ------------------------------------------------------------------ *
 * Alias analysis
 * ------------------------------------------------------------------ */

/** How a project declaration relates to a catalog command. */
export interface ProjectAlias {
  readonly macro: ProjectMacro
  /**
   * `expression` — the alias denotes a whole construct, e.g. `\R` for
   * `\mathbb{R}`, and carries no slots of its own.
   *
   * `command` — the alias is another name for a control sequence, so it takes
   * whatever arguments that command takes, e.g. `\let\R\mathbb`.
   */
  readonly kind: 'expression' | 'command'
  /** For `command` aliases, the command it names. */
  readonly targetCommand: string | null
  /** For `expression` aliases, the canonical expression it denotes. */
  readonly signature: string | null
}

/** What the project's declarations say about the catalog. */
export interface ProjectAliasIndex {
  /** Signature → the one alias that denotes exactly it. */
  readonly bySignature: ReadonlyMap<string, ProjectAlias>
  /** Command (bare) → the one alias that is another name for it. */
  readonly byCommand: ReadonlyMap<string, ProjectAlias>
  /**
   * Catalog commands a project declaration redefines to mean something else.
   *
   * `\renewcommand{\epsilon}{\varepsilon}` puts `\epsilon` here: the name still
   * exists, but it no longer draws ϵ, so offering it for the epsilon entry would
   * insert a symbol that looks like the wrong one.
   */
  readonly redefined: ReadonlyMap<string, ProjectMacro>
  /** Declarations with arguments: project templates rather than glyph aliases. */
  readonly templates: readonly ProjectMacro[]
  /** Declarations whose meaning could not be established. */
  readonly uncertain: readonly ProjectMacro[]
  /** Aliases dropped because more than one declaration claimed the same meaning. */
  readonly ambiguous: readonly ProjectMacro[]
}

/**
 * Builds the alias index from a snapshot's macros.
 *
 * Only macros that are **in scope** take part. A `macros.tex` the compilation
 * root never includes declares commands this document will never run, and
 * treating it as a source of aliases is how `\R` comes to mean `\mathcal{R}` in
 * a document that never said so.
 *
 * Ambiguity is resolved the way `MathematicalSymbols.md` §7 asks: when two
 * in-scope declarations denote the same thing, neither becomes an alias, the
 * canonical spelling stands, and both are reported so the panel can offer them
 * as alternatives.
 */
export function buildProjectAliasIndex(
  macros: readonly ProjectMacro[]
): ProjectAliasIndex {
  /**
   * Every claim made for a meaning, before ambiguity is resolved.
   *
   * Claims are collected in full rather than first-wins, because §7 asks for
   * ambiguous aliases to be "exposed as alternatives" — and an index that keeps
   * only the first claimant cannot expose the second, or even name it. The
   * resolution happens once, at the end: one claimant is an alias, two or more
   * are an ambiguity and all of them are reported.
   */
  const signatureClaims = new Map<string, ProjectAlias[]>()
  const commandClaims = new Map<string, ProjectAlias[]>()
  const redefined = new Map<string, ProjectMacro>()
  const templates: ProjectMacro[] = []
  const uncertain: ProjectMacro[] = []

  for (const macro of macros) {
    if (!macro.inScope) continue
    if (macro.kind === 'newenvironment') continue

    if (macro.args > 0) {
      templates.push(macro)
      // A parameterised declaration is still an alias when its body is the
      // canonical construct with the parameters in the canonical order —
      // `\newcommand{\vect}[1]{\mathbf{#1}}` is `\mathbf`, written once.
      const signature = canonicalExpression(macro.expansion)
      if (signature && /#\d/.test(signature)) {
        addClaim(signatureClaims, signature, {
          macro,
          kind: 'expression',
          targetCommand: null,
          signature
        })
      }
      continue
    }

    if (macro.kind === 'DeclareMathOperator' && macro.expansion === null) continue

    if (macro.kind === 'let') {
      // The target comes from the declaration reader, which parsed the
      // statement rather than looking for the first control sequence after
      // `\let` — that search finds the *name*, and an alias that points at
      // itself is worse than no alias at all.
      const target = macro.letTarget ?? null
      if (!target) {
        uncertain.push(macro)
        continue
      }
      addClaim(commandClaims, target, {
        macro,
        kind: 'command',
        targetCommand: `\\${target}`,
        signature: null
      })
      continue
    }

    const signature = canonicalExpression(macro.expansion)
    if (signature === null) {
      uncertain.push(macro)
      continue
    }

    // A declaration whose body is a single control sequence is read as a *body*
    // and not as a `\let`: `\def\R{\mathbb}` expands at use time, so `\R` means
    // `\mathbb`'s body at the moment it runs. Where `\mathbb` is a base command
    // nothing redefines, the two readings agree, and the expression reading is
    // the one that stays correct when they do not.
    addClaim(signatureClaims, signature, {
      macro,
      kind: 'expression',
      targetCommand: null,
      signature
    })
  }

  /*
   * A definition that redefines a name the project also uses as a project alias
   * is how the "saved original" idiom reads: `\let\origA\A` then
   * `\renewcommand{\A}{\origA\,}`. The alias wins for the *original*, and the
   * redefinition is what the canonical command now means. Nothing further is
   * decided here; the resolver refuses the redefined canonical command when its
   * body does not match the catalog entry it would otherwise provide.
   */
  for (const macro of macros) {
    if (!macro.inScope) continue
    if (macro.kind !== 'renewcommand' && macro.kind !== 'def' && macro.kind !== 'let') continue
    const existing = redefined.get(macro.name)
    if (!existing || existing.line <= macro.line) redefined.set(macro.name, macro)
  }

  const ambiguous: ProjectMacro[] = []
  const bySignature = resolveClaims(signatureClaims, ambiguous)
  const byCommand = resolveClaims(commandClaims, ambiguous)

  return {
    bySignature,
    byCommand,
    redefined,
    templates: templates.slice().sort((a, b) => a.name.localeCompare(b.name)),
    uncertain: uncertain.slice().sort((a, b) => a.name.localeCompare(b.name)),
    ambiguous: ambiguous.slice().sort((a, b) => a.name.localeCompare(b.name))
  }
}

/** Adds one claim for a meaning, keeping every claimant. */
function addClaim<K>(claims: Map<K, ProjectAlias[]>, key: K, alias: ProjectAlias): void {
  const list = claims.get(key)
  if (list) list.push(alias)
  else claims.set(key, [alias])
}

/**
 * The unambiguous half of a claim set.
 *
 * One claimant is an alias. Two or more are an ambiguity: neither becomes an
 * alias — §7 keeps the verified canonical spelling by default rather than
 * letting file-registration order decide — and *both* are recorded, so the panel
 * can offer them as alternatives and name where each was declared.
 */
function resolveClaims<K>(
  claims: Map<K, ProjectAlias[]>,
  ambiguous: ProjectMacro[]
): Map<K, ProjectAlias> {
  const resolved = new Map<K, ProjectAlias>()
  for (const [key, list] of claims) {
    if (list.length === 1) {
      resolved.set(key, list[0])
      continue
    }
    for (const alias of list) ambiguous.push(alias.macro)
  }
  return resolved
}
