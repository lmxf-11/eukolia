/**
 * Eukolia — where the caret is, for the purpose of inserting a symbol.
 *
 * The question this module answers is narrow and exact: **may a mathematical
 * command go here, and if not, why not?** It is not the same question
 * `mathContext.ts` answers. That module asks "should the caret be drawn in the
 * math colour", which is a question about the *visible* surface and is settled
 * by whether the editor has revealed the region's source. This one has to
 * distinguish prose from mathematics from a comment from a label argument
 * *inside* a heading — distinctions the colour question never needs, and which
 * `MathematicalSymbols.md` §8 requires before a single character is inserted.
 *
 * Everything here is read from the syntax tree. Counting `$` characters across
 * the document is the approach the reference implementations reach for and it is
 * wrong for reasons that are easy to demonstrate: a `$` inside a comment, a
 * `\$`, the body of a `verbatim`, and a formula the parser has not reached yet
 * all move the count without changing the context. The tree already knows.
 *
 * Three boundary rules are load-bearing, and all three come from existing
 * behaviour rather than from this file:
 *
 *  * **Immediately before a closing delimiter is inside; immediately after it is
 *    outside.** A `Math` node spans its *content*, so `$a|$` is at the node's end
 *    offset and `$a$|` is past it. `mathContext.ts` states and tests the same
 *    rule for the caret colour, and the two must not disagree about where a
 *    construct ends.
 *  * **Nested text islands win over the formula around them.** `\text{…}` is
 *    prose even inside an equation — the grammar gives it a `TextArgument` node
 *    for exactly this reason — and a `$…$` written inside that island is
 *    mathematics again.
 *  * **An insertion point the parser has not reached is `unknown`, not prose.**
 *    A guess in this direction inserts `$…$` into a comment or a label; there is
 *    no safe default, so the caller is told and the document is left alone.
 */

import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { SyntaxNode, Tree } from '@lezer/common'

import { mathRegionOf } from '../editor/mathContext'
import { mathAncestorNode } from '../vendor/overleaf/utils/tree-operations/math'
import type { InsertionContext, InsertionContextKind, MathDelimiterKind } from './types'

/**
 * How long a single context query may spend waiting for the parser.
 *
 * `MathematicalSymbols.md` §8 asks for a **bounded** parse budget rather than a
 * synchronous whole-document parse, and this is the bound. A caret in a document
 * the parser is still working through gets 30 ms of catch-up; past that the
 * answer is `unknown`, which refuses the insertion and says so. Thirty
 * milliseconds is under a frame, so a user clicking a symbol never waits on it.
 */
export const CONTEXT_PARSE_BUDGET_MS = 30

/**
 * Nodes an insertion may not go inside.
 *
 * Each entry is a place where a `$` would be data rather than a delimiter. They
 * are checked before anything else, because a label inside mathematics is still
 * a label: `\label{eq:$x$}` is not a formula, and inserting `\alpha` there would
 * corrupt a cross-reference key.
 */
const RESTRICTED_NODES = [
  'Comment',
  'VerbContent',
  'VerbatimContent',
  'LstInlineContent',
  'LiteralArgContent',
  'SpaceDelimitedLiteralArgContent',
  'Csname',
  'DefinitionArgument',
  'DefinitionFragment',
  'DefinitionFragmentCommand',
  'DefinitionFragmentArgument',
  'MacroParameter',
  'OptionalMacroParameter',
  'LabelArgument',
  'BibKeyArgument',
  'RefArgument',
  'UrlArgument',
  'FilePathArgument',
  'BareFilePathArgument',
  'PackageArgument',
  'EnvName',
  'DocumentEnvName',
  'TabularEnvName',
  'EquationEnvName',
  'EquationArrayEnvName',
  'VerbatimEnvName',
  'TikzPictureEnvName',
  'FigureEnvName',
  'ListEnvName',
  'TableEnvName'
] as const

/** Why a restricted context is restricted, in the words the panel shows. */
const RESTRICTED_REASONS: Readonly<Record<string, string>> = {
  Comment: 'the caret is in a comment',
  VerbContent: 'the caret is in the argument of \\verb',
  VerbatimContent: 'the caret is in a verbatim environment',
  LstInlineContent: 'the caret is in the argument of \\lstinline',
  LiteralArgContent: 'the caret is in a verbatim argument',
  SpaceDelimitedLiteralArgContent: 'the caret is in a verbatim argument',
  Csname: 'the caret is in a \\csname name',
  DefinitionArgument: 'the caret is in a macro definition',
  DefinitionFragment: 'the caret is in a macro definition',
  DefinitionFragmentCommand: 'the caret is in a macro definition',
  DefinitionFragmentArgument: 'the caret is in a macro definition',
  MacroParameter: 'the caret is in a macro parameter',
  OptionalMacroParameter: 'the caret is in a macro parameter',
  LabelArgument: 'the caret is in a label name',
  BibKeyArgument: 'the caret is in a citation key',
  RefArgument: 'the caret is in a reference name',
  UrlArgument: 'the caret is in a URL',
  FilePathArgument: 'the caret is in a file name',
  BareFilePathArgument: 'the caret is in a file name',
  PackageArgument: 'the caret is in a package name',
  EnvName: 'the caret is in an environment name',
  DocumentEnvName: 'the caret is in an environment name',
  TabularEnvName: 'the caret is in an environment name',
  EquationEnvName: 'the caret is in an environment name',
  EquationArrayEnvName: 'the caret is in an environment name',
  VerbatimEnvName: 'the caret is in an environment name',
  TikzPictureEnvName: 'the caret is in an environment name',
  FigureEnvName: 'the caret is in an environment name',
  ListEnvName: 'the caret is in an environment name',
  TableEnvName: 'the caret is in an environment name'
}

/**
 * Commands whose braced argument is prose, whichever mode it appears in.
 *
 * The grammar recognises `\text`, `\tag`, `\textrm`, `\intertext` and `\hbox`
 * as text islands on its own (`mathTextCommands` and `HboxCtrlSeq` in the
 * vendored token map). This list is the *additional* set the same reasoning
 * covers — `\mbox` is `\hbox` under another name, and the `\text…` family is
 * text by construction — recognised here by command name rather than by editing
 * the vendored grammar, which is shared with the reference and regenerated from
 * a copied `.grammar` file.
 *
 * `\mathrm` is deliberately absent: it is a *mathematical* alphabet, so
 * `\mathrm{sin}` stays mathematics and a symbol inserted inside it needs no
 * wrapper. `\text` is the one that changes mode.
 */
const TEXT_ARGUMENT_COMMANDS: ReadonlySet<string> = new Set([
  'text',
  'mbox',
  'hbox',
  'textrm',
  'textnormal',
  'textup',
  'textit',
  'textbf',
  'textsf',
  'texttt',
  'textmd',
  'textsc',
  'textsl',
  'textsuperscript',
  'textsubscript',
  'intertext',
  'tag'
])

/**
 * Commands that enter mathematics from wherever they are.
 *
 * `\ensuremath` is LaTeX's own "typeset this as mathematics" wrapper, and
 * `\math`/`\displaymath` do the same job in the `amsmath` idiom. Its argument is
 * therefore mathematics even in the middle of a paragraph, which is the case
 * §8 asks to be handled on its own rather than by the surrounding context.
 */
const MATH_ARGUMENT_COMMANDS: ReadonlySet<string> = new Set([
  'ensuremath',
  'math',
  'displaymath'
])

/* ------------------------------------------------------------------ *
 * Tree walking
 * ------------------------------------------------------------------ */

const clamp = (state: EditorState, pos: number): number =>
  Math.max(0, Math.min(Math.floor(pos) || 0, state.doc.length))

/**
 * The innermost node at `pos` whose type is one of `names`.
 *
 * `resolveInner` is consulted at all three sides, because the position that
 * matters is frequently a *boundary*: the offset a closing brace sits at is the
 * end of one node and the start of another, and asking only one side is how a
 * caret one character from the end of a comment is reported as prose.
 */
function nearestNode(pos: number, tree: Tree, names: readonly string[]): SyntaxNode | null {
  for (const side of [0, -1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(pos, side)
    while (node) {
      if (names.some((name) => node!.type.is(name))) return node
      node = node.parent
    }
  }
  return null
}

/** The command name a node's text spells, or `null`. */
function commandNameAt(state: EditorState, node: SyntaxNode): string | null {
  const text = state.doc.sliceString(node.from, Math.min(node.to, node.from + 32))
  const match = /^\\([A-Za-z]+)/.exec(text)
  return match ? match[1] : null
}

/**
 * The command a braced group belongs to, when the group's own syntax does not
 * say.
 *
 * `\mbox{…}` inside mathematics is not one of the grammar's text islands, so its
 * argument arrives as an ordinary mathematical group and the only thing that
 * identifies it as text is the control sequence in front of it. Walking back
 * through the group's preceding siblings — and, at the start of a line, through
 * the whitespace before them — is what recovers it.
 */
function owningCommand(state: EditorState, group: SyntaxNode): string | null {
  let sibling = group.prevSibling
  while (sibling && (sibling.type.is('Whitespace') || sibling.name === '')) {
    sibling = sibling.prevSibling
  }
  if (!sibling) return null
  if (sibling.type.is('Command') || sibling.type.is('CtrlSeq') || sibling.type.is('CtrlSym')) {
    return commandNameAt(state, sibling)
  }
  // A command node's name lives in a child in some grammar shapes.
  const child = sibling.firstChild
  if (child) return commandNameAt(state, child)
  return commandNameAt(state, sibling)
}

/**
 * Whether the command owning this argument puts its argument into mathematics.
 *
 * `\ensuremath{…}` and `\math{…}` are LaTeX's own "typeset this as
 * mathematics" wrappers, so their argument is mathematics wherever it appears —
 * including in the middle of a paragraph, which is the case §8 asks to be
 * handled on its own rather than by the surrounding context. The grammar has no
 * idea what `\ensuremath` means (it parses it as an unknown command whose
 * argument is a `TextArgument`), so the command's *name* is what settles it.
 */
function entersMathematics(state: EditorState, group: SyntaxNode): boolean {
  const owner = owningCommand(state, group)
  return owner !== null && MATH_ARGUMENT_COMMANDS.has(owner)
}

/**
 * The nearest enclosing braced argument whose *command* is one of `commands`.
 *
 * The nearest match by node type is not enough, and `\ensuremath{…}` shows why:
 * the innermost node at a caret inside its argument is a `LongArg`, whose own
 * previous sibling is the opening brace — the command is two levels further up,
 * as the sibling of the enclosing `TextArgument`. Walking outwards until a node
 * is found whose *preceding control sequence* is one of the recognized commands
 * is what recovers it, and it stays exact for nesting: `\mathrm{\mbox{x}}` finds
 * `\mbox` first, because that is the argument actually around the caret.
 */
function recognizedArgument(
  state: EditorState,
  pos: number,
  tree: Tree,
  names: readonly string[],
  commands: ReadonlySet<string>
): SyntaxNode | null {
  for (const side of [0, -1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(pos, side)
    while (node) {
      if (names.some((name) => node!.type.is(name))) {
        const owner = owningCommand(state, node)
        if (owner && commands.has(owner)) return node
      }
      node = node.parent
    }
  }
  return null
}

/** The braced-argument node names the grammar uses. */
const ARGUMENT_NODES = [
  'TextArgument',
  'ShortTextArgument',
  'MathArgument',
  'Argument',
  'UnknownArgument',
  'LongArg',
  'ShortArg'
] as const

/** The `Math` node whose *content* contains `pos`, with the tree supplied. */function mathNodeAtIn(state: EditorState, pos: number, tree: Tree): SyntaxNode | null {
  const line = state.doc.lineAt(pos)
  let found: SyntaxNode | null = null
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(reference) {
      if (!reference.type.is('Math')) return
      const region = mathRegionOf(state, reference.node)
      if (region && region.from <= pos && pos <= region.to) {
        found = reference.node
        return false
      }
    }
  })
  return found
}

/** How a mathematical region is delimited, from the container around it. */
function delimiterKindOf(container: SyntaxNode | null): MathDelimiterKind {
  if (!container) return 'unknown'
  if (container.type.is('DollarMath')) {
    return container.getChild('DisplayMath') ? 'double-dollar' : 'dollar'
  }
  if (container.type.is('ParenMath')) return 'paren'
  if (container.type.is('BracketMath')) return 'bracket'
  if (container.type.is('EquationEnvironment') || container.type.is('EquationArrayEnvironment')) {
    return 'environment'
  }
  if (container.type.is('MathDelimitedGroup')) return 'inner'
  return 'unknown'
}

/**
 * Whether an unescaped `$` inside `[from, pos)` leaves the position in
 * mathematics.
 *
 * This is the one place a character is counted rather than read from the tree,
 * and it is bounded to a single text island's own span. It exists because a
 * `$…$` written inside `\text{…}` is mathematics again and the grammar does not
 * nest one inside the other — so there is no node to consult. Restricting the
 * count to the island is what keeps the rule honest: the dollars being counted
 * are the island's own, not the document's.
 */
function nestedDollarMath(state: EditorState, from: number, pos: number): boolean {
  let dollars = 0
  for (let at = from; at < pos; at += 1) {
    if (state.doc.sliceString(at, at + 1) !== '$') continue
    let backslashes = 0
    for (let check = at - 1; check >= from && state.doc.sliceString(check, check + 1) === '\\'; check -= 1) {
      backslashes += 1
    }
    if (backslashes % 2 === 1) continue
    dollars += 1
  }
  return dollars % 2 === 1
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

const result = (
  kind: InsertionContextKind,
  reason: string,
  rest: Partial<InsertionContext> = {}
): InsertionContext => ({
  kind,
  reason,
  region: null,
  delimiter: 'unknown',
  contentFrom: null,
  contentTo: null,
  parsedTo: null,
  ...rest
})

/**
 * Classifies the insertion point.
 *
 * `tree` is accepted so a caller that already has the tree — the resolver, which
 * classifies every range of a multi-selection from one state — does not make the
 * parser answer the same question twice.
 */
export function classifyInsertionPoint(
  state: EditorState,
  offset: number,
  tree?: Tree
): InsertionContext {
  const pos = clamp(state, offset)

  let syntax = tree ?? syntaxTree(state)
  if (pos > syntax.length) {
    // The parser has not reached the position. `ensureSyntaxTree` spends at most
    // the budget below catching up; if it still has not arrived, the answer is
    // `unknown` rather than a guess in either direction.
    const caught = ensureSyntaxTree(state, pos + 1, CONTEXT_PARSE_BUDGET_MS)
    if (caught) syntax = caught
  }
  const parsedTo = syntax.length
  if (pos > parsedTo) {
    return result('unknown', 'the parser has not reached this position', { parsedTo })
  }

  const restricted = nearestNode(pos, syntax, RESTRICTED_NODES)
  if (restricted) {
    const name = restricted.type.name
    return result('restricted', RESTRICTED_REASONS[name] ?? `the caret is in ${name}`, {
      parsedTo
    })
  }

  /*
   * A command that *makes* its argument mathematics, checked before the
   * surroundings — because `\ensuremath{…}` in the middle of a paragraph is the
   * case that has no surrounding formula to be found in. §8 asks for its
   * argument to be handled on its own rather than by context.
   */
  const mathArgument = recognizedArgument(
    state,
    pos,
    syntax,
    ARGUMENT_NODES,
    MATH_ARGUMENT_COMMANDS
  )
  if (mathArgument) {
    return result('math', 'the caret is in the argument of \\ensuremath', { parsedTo })
  }

  const mathNode = mathNodeAtIn(state, pos, syntax)
  if (!mathNode) {
    return result('text', 'the caret is in prose', { parsedTo })
  }

  const region = mathRegionOf(state, mathNode) ?? { from: mathNode.from, to: mathNode.to }
  const container = mathAncestorNode(state, pos, 0)
  const delimiter = delimiterKindOf(container)
  const base: Partial<InsertionContext> = {
    region: { from: region.from, to: region.to },
    delimiter,
    contentFrom: region.from,
    contentTo: region.to,
    parsedTo
  }

  /*
   * A text island inside the formula. It has to be checked *inside* mathematics
   * and only there: `\text{…}` in a paragraph is ordinary prose and needs no
   * special handling, while `\text{…}` in an equation is the case that would
   * otherwise get `$\alpha$` inserted into it.
   */
  const island = nearestNode(pos, syntax, ['TextArgument', 'ShortTextArgument'])
  if (island && island.from >= region.from && island.to <= region.to) {
    const nested = mathNodeAtIn(state, pos, syntax)
    if (nested && nested.from >= island.from && nested.to <= island.to && nested.from > island.from) {
      return result('math', 'the caret is in a formula nested inside a text argument', base)
    }
    if (nestedDollarMath(state, island.from, pos)) {
      return result('math', 'the caret is in a formula nested inside a text argument', base)
    }
    return result('text', 'the caret is in the text argument of a command', base)
  }

  /*
   * The braced group of a command inside the formula whose argument mode the
   * grammar does not decide on its own — `\mbox{…}` and the `\text…` family.
   * `nearestNode` is not enough here for the reason `recognizedArgument`
   * documents: the innermost node is the `LongArg` inside the braces, and the
   * command is the sibling of the argument *around* it.
   */
  const group = recognizedArgument(
    state,
    pos,
    syntax,
    ARGUMENT_NODES,
    TEXT_ARGUMENT_COMMANDS
  )
  if (group && group.from >= region.from && group.to <= region.to) {
    const owner = owningCommand(state, group)
    if (nestedDollarMath(state, group.from, pos)) {
      return result('math', 'the caret is in a formula nested inside a text argument', base)
    }
    return result('text', `the caret is in the argument of \\${owner ?? 'a text command'}`, base)
  }

  return result('math', 'the caret is in mathematics', base)
}

/** Container node types: a formula together with its own delimiters. */
const MATH_CONTAINER_NODES = [
  'DollarMath',
  'ParenMath',
  'BracketMath',
  'EquationEnvironment',
  'EquationArrayEnvironment'
] as const

/**
 * The classification for a *selection*, which is not the same question.
 *
 * An empty selection is the caret, answered by `classifyInsertionPoint`. A
 * non-empty one is one of four cases, and §9 names all four:
 *
 *  * wholly inside one formula's content — raw mathematics;
 *  * wholly in prose — wrapped;
 *  * exactly one complete formula, delimiters included — prose, so it is
 *    replaced by a newly wrapped expression rather than nested inside the old
 *    one;
 *  * anything else that touches a delimiter or spans both — refused, and the
 *    document is left alone.
 *
 * Note the asymmetry with the caret at the very end of a formula. `$a|$` is
 * mathematics, but a *selection* whose end is that same offset and whose start
 * is inside would have swallowed the closing `$` — so the test here is the
 * region's own bounds rather than the caret's inclusive one.
 */
export function classifySelection(
  state: EditorState,
  from: number,
  to: number,
  tree?: Tree
): InsertionContext {
  const start = clamp(state, from)
  const end = clamp(state, to)
  if (start === end) return classifyInsertionPoint(state, start, tree)

  const head = classifyInsertionPoint(state, start, tree)
  const parsedTo = head.parsedTo

  if (head.kind === 'math' && head.region) {
    if (start >= head.region.from && end <= head.region.to) {
      return { ...head, reason: 'the selection is inside one formula' }
    }
    const container = containerAt(state, tree, start, end)
    if (container) {
      return result('text', 'the selection is one complete formula', { parsedTo })
    }
    return result('restricted', 'the selection crosses a mathematics boundary', { parsedTo })
  }
  if (head.kind !== 'text') return head

  const container = containerAt(state, tree, start, end)
  if (container) {
    return result('text', 'the selection is one complete formula', { parsedTo })
  }
  for (const node of mathNodesIn(state, tree, start, end)) {
    if (node.from >= start && node.to <= end) {
      return result('restricted', 'the selection mixes prose and mathematics', { parsedTo })
    }
    return result('restricted', 'the selection crosses a mathematics boundary', { parsedTo })
  }
  return { ...head, reason: 'the selection is prose' }
}

/** The container node whose span is exactly this range, if there is one. */
function containerAt(
  state: EditorState,
  tree: Tree | undefined,
  from: number,
  to: number
): SyntaxNode | null {
  if (from === to) return null
  const syntax = tree ?? syntaxTree(state)
  if (to > syntax.length) return null
  let found: SyntaxNode | null = null
  syntax.iterate({
    from,
    to,
    enter(reference) {
      if (!MATH_CONTAINER_NODES.some((name) => reference.type.is(name))) return
      if (reference.from === from && reference.to === to) {
        found = reference.node
        return false
      }
    }
  })
  return found
}

/** Every `Math` node intersecting a range. */
function mathNodesIn(
  state: EditorState,
  tree: Tree | undefined,
  from: number,
  to: number
): SyntaxNode[] {
  const syntax = tree ?? syntaxTree(state)
  if (to > syntax.length) return []
  const found: SyntaxNode[] = []
  syntax.iterate({
    from,
    to,
    enter(reference) {
      if (!reference.type.is('Math')) return
      if (!mathRegionOf(state, reference.node)) return
      found.push(reference.node)
    }
  })
  return found
}

/**
 * How a selection covering exactly one formula should be replaced.
 *
 * Kept because the resolver's explanation distinguishes "replacing a formula"
 * from "wrapping prose", and the two read differently in the details pane even
 * though they produce the same source.
 */
export function selectionCoversFormula(
  context: InsertionContext,
  from: number,
  to: number
): boolean {
  if (context.kind !== 'text') return false
  if (!/complete formula/.test(context.reason)) return false
  return from < to
}
