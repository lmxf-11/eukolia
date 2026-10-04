/**
 * Where a symbol may go, and what happens when it does.
 *
 * Two claims, and both are the kind that look obviously true and are not:
 *
 *  1. **The insertion point's context is a property of the syntax tree, not of
 *     the characters around it.** `$a|$` is mathematics and `$a$|` is prose;
 *     `\text{…}` inside an equation is prose and a `$…$` inside *that* is
 *     mathematics again; a comment, a label name and a file path are none of
 *     them. `MathematicalSymbols.md` §8 lists each of these, and every one is a
 *     boundary the naive implementation gets wrong — which is why the
 *     classification is asked rather than guessed at from a `$` count.
 *
 *  2. **The insertion is decided before it is written.** A plan carries the
 *     exact text, the caret offsets and the refusal; applying it is one
 *     transaction. So the assertions here are about *source and offsets*, not
 *     about a rendered result — the same thing §11 asks for, and the only form
 *     in which "the document is unchanged when it fails" can be stated.
 *
 * The tests build a real `EditorState` with the vendored LaTeX grammar and
 * parse it fully before asking anything, because a partially parsed tree would
 * make every boundary case a coin toss (the parser stops after a budget, and a
 * test that measured a prefix would agree with itself and with nothing else).
 */

import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { isolateHistory } from '@codemirror/commands'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { classifyInsertionPoint, classifySelection } from '@/mathSymbols/insertionContext'
import {
  applyInsertionPlan,
  INSERT_USER_EVENT,
  planInsertion,
  renderVariant,
  needsTerminator,
  rawCommandVariant
} from '@/mathSymbols/insertMathSymbol'
import type { SymbolVariant } from '@/mathSymbols/types'

/**
 * A fully parsed state.
 *
 * `ensureSyntaxTree` is given the whole document and a generous budget: the
 * point of these tests is the grammar's answer, and a partial tree would answer
 * about the part it had reached instead.
 */
function stateOf(text: string, selection?: { anchor: number; head?: number }): EditorState {
  const base = EditorState.create({ doc: text, extensions: [LaTeXLanguage] })
  ensureSyntaxTree(base, text.length, 10_000)
  if (!selection) return base
  return base.update({
    selection: EditorSelection.single(selection.anchor, selection.head ?? selection.anchor)
  }).state
}

/** A caret written as `|` in the fixture, turned into an offset. */
function at(text: string): { doc: string; offset: number } {
  const offset = text.indexOf('|')
  if (offset === -1) throw new Error('fixture has no caret marker')
  return { doc: text.slice(0, offset) + text.slice(offset + 1), offset }
}

/**
 * A state with several cursors.
 *
 * `EditorState.allowMultipleSelections` defaults to off, and with it off a
 * multi-range selection is *collapsed* to its main range — so a test that built
 * two cursors and asserted one edit would be testing the facet, not the planner.
 */
function multiCursorState(doc: string, offsets: readonly number[]): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.create(offsets.map((offset) => EditorSelection.cursor(offset))),
    extensions: [LaTeXLanguage, EditorState.allowMultipleSelections.of(true)]
  })
  ensureSyntaxTree(state, doc.length, 10_000)
  return state
}

/** The classification of the caret in a `|`-marked fixture. */
function kindAt(fixture: string): string {
  const { doc, offset } = at(fixture)
  const state = stateOf(doc)
  return classifyInsertionPoint(state, offset, ensureSyntaxTree(state, doc.length, 10_000)!).kind
}

/** A plain symbol variant, as the catalog would supply it. */
function variantOf(command: string, extra: Partial<SymbolVariant> = {}): SymbolVariant {
  return {
    id: `test:${command}`,
    command,
    parts: [{ text: command }],
    slots: [],
    requires: [],
    engines: null,
    mode: 'math-only',
    selfContainedMath: false,
    ...extra
  }
}

describe('insertion context: the delimiter families', () => {
  it('is mathematics between single dollars, and prose on either side', () => {
    expect(kindAt('$a + |b$')).toBe('math')
    // Before the opening delimiter is prose; immediately before the closing one
    // is inside; immediately after it is not. The three cases are the whole
    // boundary rule and they are one character apart from each other.
    expect(kindAt('|$a$')).toBe('text')
    expect(kindAt('$a|$')).toBe('math')
    expect(kindAt('$a$|')).toBe('text')
  })

  it('is mathematics between double dollars', () => {
    expect(kindAt('$$a|b$$')).toBe('math')
  })

  it('is mathematics between \\( and \\)', () => {
    expect(kindAt('\\(a|b\\)')).toBe('math')
  })

  it('is mathematics between \\[ and \\]', () => {
    expect(kindAt('\\[a|b\\]')).toBe('math')
  })

  it('is mathematics inside every recognised equation environment', () => {
    for (const environment of ['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray']) {
      const fixture = `\\begin{${environment}}\n  a |= b\n\\end{${environment}}`
      expect(kindAt(fixture), environment).toBe('math')
    }
  })

  it('is mathematics inside an inner structure of a formula', () => {
    expect(kindAt('$\\begin{matrix} a |& b \\end{matrix}$')).toBe('math')
    expect(kindAt('$\\begin{cases} a |& b \\\\ c & d \\end{cases}$')).toBe('math')
  })

  it('reports the delimiter family it found', () => {
    const cases: Array<[string, string]> = [
      ['$a|b$', 'dollar'],
      ['$$a|b$$', 'double-dollar'],
      ['\\(a|b\\)', 'paren'],
      ['\\[a|b\\]', 'bracket'],
      ['\\begin{equation}a|b\\end{equation}', 'environment']
    ]
    for (const [fixture, expected] of cases) {
      const { doc, offset } = at(fixture)
      const state = stateOf(doc)
      const context = classifyInsertionPoint(state, offset)
      expect(context.kind, fixture).toBe('math')
      expect(context.delimiter, fixture).toBe(expected)
      // The content bounds are what a wrapper has to respect, so they are stated
      // rather than inferred from the region.
      expect(context.contentFrom, fixture).not.toBeNull()
      expect(context.contentTo, fixture).not.toBeNull()
    }
  })
})

describe('insertion context: text islands inside mathematics', () => {
  it('reports the argument of \\text as prose', () => {
    expect(kindAt('$a + \\text{some |words}$')).toBe('text')
  })

  it('reports the argument of \\mbox as prose', () => {
    // `\mbox` is `\hbox` under another name and the grammar classifies only the
    // second, so this is the case the panel has to recognise by command.
    expect(kindAt('$a + \\mbox{some |words}$')).toBe('text')
  })

  it('reports the argument of \\textrm as prose', () => {
    expect(kindAt('$a + \\textrm{some |words}$')).toBe('text')
  })

  it('keeps \\mathrm as mathematics', () => {
    // A mathematical alphabet, not a mode change: `\mathrm{sin}` is still
    // mathematics, and a symbol inserted inside it needs no wrapper.
    expect(kindAt('$\\mathrm{si|n}$')).toBe('math')
  })

  it('is mathematics again inside a formula nested in a text island', () => {
    expect(kindAt('$\\text{a $b|c$ d}$')).toBe('math')
  })

  it('is mathematics in the argument of \\ensuremath, even in prose', () => {
    expect(kindAt('Some prose \\ensuremath{\\alpha| + \\beta}.')).toBe('math')
  })
})

describe('insertion context: restricted', () => {
  const restricted: Array<[string, string]> = [
    ['a line % a comment |here', 'comment'],
    // `+` is `\verb`'s delimiter here, so the `|` in the fixture is only the
    // caret marker and not also a second delimiter.
    ['\\verb+raw |code+', 'verb'],
    ['\\begin{verbatim}\nraw |code\n\\end{verbatim}', 'verbatim'],
    ['\\label{eq:|one}', 'label'],
    ['\\cite{ke|y}', 'citation'],
    ['\\ref{se|ction}', 'reference'],
    ['\\includegraphics{fig|ure.png}', 'file'],
    ['\\newcommand{\\f|oo}{x}', 'definition'],
    ['\\def\\f|oo{x}', 'definition']
  ]

  for (const [fixture, what] of restricted) {
    it(`refuses a ${what}`, () => {
      const { doc, offset } = at(fixture)
      const state = stateOf(doc)
      const context = classifyInsertionPoint(state, offset)
      expect(context.kind, fixture).toBe('restricted')
      // A refusal is explained rather than silent.
      expect(context.reason.length, fixture).toBeGreaterThan(0)
    })
  }

  it('does not confuse a math command with a definition', () => {
    // The same characters appear in both; only the tree says which one it is.
    expect(kindAt('$\\alpha|$')).toBe('math')
  })
})

describe('insertion context: an unparsed position', () => {
  it('answers unknown rather than guessing prose', () => {
    // No language means no parse: the tree's length is zero and the position is
    // past it. §8 requires the honest answer here, because both guesses are
    // wrong half the time — `text` inserts `$…$` into a comment, `math` inserts
    // bare code into prose.
    const state = EditorState.create({ doc: 'some document text' })
    const context = classifyInsertionPoint(state, 10)
    expect(context.kind).toBe('unknown')
    expect(context.parsedTo).toBe(0)
  })
})

describe('selection classification', () => {
  it('is mathematics for a selection inside one formula', () => {
    const state = stateOf('$a + bc$', { anchor: 5, head: 7 })
    expect(classifySelection(state, 5, 7).kind).toBe('math')
  })

  it('is prose for a selection in prose', () => {
    const state = stateOf('some words here', { anchor: 5, head: 10 })
    expect(classifySelection(state, 5, 10).kind).toBe('text')
  })

  it('reports a selection covering one whole formula as replaceable prose', () => {
    // §9: a selection that is exactly one formula can be replaced by a newly
    // wrapped expression rather than nested inside the old one.
    const state = stateOf('$a+b$ tail', { anchor: 0, head: 5 })
    const context = classifySelection(state, 0, 5)
    expect(context.kind).toBe('text')
    expect(context.reason).toMatch(/complete formula/)
  })

  it('refuses a selection that crosses a closing delimiter', () => {
    const state = stateOf('$a+b$ tail', { anchor: 2, head: 6 })
    const context = classifySelection(state, 2, 6)
    expect(context.kind).toBe('restricted')
    expect(context.reason).toMatch(/crosses a mathematics boundary/)
  })

  it('refuses a selection that mixes prose and mathematics', () => {
    const state = stateOf('prose $a$ more', { anchor: 3, head: 8 })
    const context = classifySelection(state, 3, 8)
    expect(context.kind).toBe('restricted')
  })
})

/* ------------------------------------------------------------------ *
 * Insertion
 * ------------------------------------------------------------------ */

/** Applies a plan to a bare state and reports the resulting source. */
function apply(
  doc: string,
  variant: SymbolVariant,
  selection?: { anchor: number; head?: number },
  readOnly = false
): {
  ok: boolean
  text: string
  carets: Array<{ anchor: number; head: number; slot: number | null }>
  message: string
} {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [LaTeXLanguage, ...(readOnly ? [EditorState.readOnly.of(true)] : [])]
  })
  ensureSyntaxTree(state, doc.length, 10_000)
  const result = planInsertion({ entryId: variant.id, variant, state })
  if (!result.ok) {
    return { ok: false, text: doc, carets: [], message: result.message }
  }
  let next = state
  const target = {
    get state() {
      return next
    },
    dispatch(transaction: { state: EditorState; newDoc?: unknown }) {
      next = transaction.state
    }
  }
  const applied = applyInsertionPlan(result, target as never)
  return {
    ok: true,
    text: next.doc.toString(),
    carets: applied.carets.map((caret) => ({ ...caret })),
    message: ''
  }
}

describe('insertion: the wrapper follows the context', () => {
  it('wraps in prose', () => {
    // §8's first worked example: `A | B` plus alpha becomes `A $\alpha|$ B`.
    const out = apply('A  B', variantOf('\\alpha'), { anchor: 2 })
    expect(out.text).toBe('A $\\alpha$ B')
  })

  it('does not wrap inside mathematics', () => {
    const out = apply('$a + $', variantOf('\\alpha'), { anchor: 5 })
    expect(out.text).toBe('$a + \\alpha$')
    // The caret is before the closing `$`, so a second insertion continues the
    // same formula instead of starting one beside it.
    expect(out.carets[0].anchor).toBe(5 + '\\alpha'.length)
  })

  it('wraps again immediately after a closed formula, without merging them', () => {
    // §8's boundary case: `$a$|` plus alpha becomes `$a$$\alpha|$`. Merging the
    // two into `$a\alpha$` would change what the document says.
    const out = apply('$a$', variantOf('\\alpha'), { anchor: 3 })
    expect(out.text).toBe('$a$$\\alpha$')
    // The caret is before the newly inserted closing `$`, not after it.
    expect(out.carets[0].anchor).toBe(10)
  })

  it('does not wrap a variant that brings its own mathematics', () => {
    // `\ensuremath` is already mathematics wherever it lands; a second wrapper
    // would be wrong in prose and catastrophic inside a formula.
    const out = apply('prose ', variantOf('\\ensuremath{\\alpha}', { selfContainedMath: true }), {
      anchor: 6
    })
    expect(out.text).toBe('prose \\ensuremath{\\alpha}')
  })

  it('refuses a text-only variant inside mathematics', () => {
    const variant = variantOf('\\textdegree', { mode: 'text-only' })
    const state = stateOf('$a + $', { anchor: 5 })
    const result = planInsertion({ entryId: variant.id, variant, state })
    // A text-only command inside a formula is not made safe by a wrapper, so the
    // plan is refused rather than inserting something that will not compile.
    expect(result.ok).toBe(false)
  })
})

describe('insertion: templates and slots', () => {
  const frac: SymbolVariant = {
    id: 'test:frac',
    command: '\\frac',
    parts: [
      { text: '\\frac{' },
      { slot: 1 },
      { text: '}{' },
      { slot: 2 },
      { text: '}' }
    ],
    slots: [
      { index: 1, required: true, default: '', select: 'placeholder' },
      { index: 2, required: true, default: '', select: 'placeholder' }
    ],
    requires: [],
    engines: null,
    mode: 'math-only',
    selfContainedMath: false
  }

  it('creates empty slots and leaves the caret in the first', () => {
    const out = apply('$x$', frac, { anchor: 2 })
    expect(out.text).toBe('$x\\frac{}{}$')
    // `\frac{` is six characters, so the caret sits between the braces.
    expect(out.carets[0]).toMatchObject({ anchor: 8, slot: 1 })
  })

  it('moves a selection into the designated slot', () => {
    const sqrt: SymbolVariant = {
      id: 'test:sqrt',
      command: '\\sqrt',
      parts: [{ text: '\\sqrt{' }, { slot: 1 }, { text: '}' }],
      slots: [{ index: 1, required: true, default: '', select: 'selected-text' }],
      requires: [],
      engines: null,
      mode: 'math-only',
      selfContainedMath: false
    }
    const out = apply('$a+b$', sqrt, { anchor: 1, head: 4 })
    expect(out.text).toBe('$\\sqrt{a+b}$')
    // The caret is after the expression it took, still inside the braces.
    expect(out.carets[0]).toMatchObject({ anchor: 10, slot: 1 })
  })

  it('renders a slot default when there is one', () => {
    const rendered = renderVariant({
      ...frac,
      slots: [
        { index: 1, required: false, default: 'n', select: 'placeholder' },
        { index: 2, required: true, default: '', select: 'placeholder' }
      ]
    })
    expect(rendered.text).toBe('\\frac{n}{}')
    expect(rendered.slots).toEqual([
      { index: 1, from: 6, to: 7 },
      { index: 2, from: 9, to: 9 }
    ])
  })

  it('never rewrites a literal part of a template', () => {
    // Slots are structured parts, so a `#` in the body is data. Substituting
    // markers textually is the bug this design exists to avoid.
    const variant: SymbolVariant = {
      ...frac,
      parts: [{ text: '\\newcommand{\\x}[1]{#1}%' }, { slot: 1 }],
      slots: [{ index: 1, required: true, default: '', select: 'placeholder' }]
    }
    expect(renderVariant(variant).text).toBe('\\newcommand{\\x}[1]{#1}%')
  })
})

describe('insertion: selections', () => {
  it('replaces a selection inside mathematics with raw code', () => {
    const out = apply('$a + bc$', variantOf('\\alpha'), { anchor: 5, head: 6 })
    // The letter `c` follows the insertion point, so a `{}` is added: without
    // it, `\alpha` and `c` would read as one command called `\alphac`.
    expect(out.text).toBe('$a + \\alpha{}c$')
  })

  it('replaces a prose selection with wrapped code', () => {
    const out = apply('A xy B', variantOf('\\alpha'), { anchor: 2, head: 4 })
    expect(out.text).toBe('A $\\alpha$ B')
  })

  it('replaces a whole formula with a newly wrapped expression', () => {
    const out = apply('$a+b$ tail', variantOf('\\beta'), { anchor: 0, head: 5 })
    expect(out.text).toBe('$\\beta$ tail')
  })

  it('refuses a selection that would cross a delimiter, and writes nothing', () => {
    const out = apply('$a+b$ tail', variantOf('\\alpha'), { anchor: 2, head: 6 })
    expect(out.ok).toBe(false)
    expect(out.text).toBe('$a+b$ tail')
  })
})

describe('insertion: refusals leave the document alone', () => {
  it('refuses a comment', () => {
    const out = apply('a % comment here', variantOf('\\alpha'), { anchor: 12 })
    expect(out.ok).toBe(false)
    expect(out.text).toBe('a % comment here')
    expect(out.message).toMatch(/comment/)
  })

  it('refuses a label name', () => {
    const out = apply('\\label{eq:one}', variantOf('\\alpha'), { anchor: 10 })
    expect(out.ok).toBe(false)
    expect(out.text).toBe('\\label{eq:one}')
  })

  it('refuses a read-only document', () => {
    // Respecting read-only is §9's last line and the one a panel is most likely
    // to skip, because the panel is not the thing that owns the flag.
    const out = apply('$a$', variantOf('\\alpha'), { anchor: 2 }, true)
    expect(out.ok).toBe(false)
    expect(out.text).toBe('$a$')
    expect(out.message).toMatch(/read-only/)
  })

  it('refuses when the context cannot be determined', () => {
    // A document with no parse at all: the tree covers offset 0 and nothing
    // else, so a caret past it is `unknown` rather than a guess. §8 is explicit
    // that both guesses are wrong half the time — `text` inserts `$…$` into a
    // comment, and `math` inserts bare code into prose.
    const state = EditorState.create({ doc: 'unparsed document', selection: { anchor: 8 } })
    const result = planInsertion({ entryId: 'x', variant: variantOf('\\alpha'), state })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('unknown-context')
  })
})

describe('insertion: lexical termination', () => {
  it('separates a control word from a letter that follows it', () => {
    // `\alpha` written against `beta` is one command called `alphabeta` — not an
    // error the user sees, but a different symbol than the one they picked. This
    // is §9's worked example, and it is the *mathematics* case, because in prose
    // the wrapper already separates them.
    const out = apply('$beta$', variantOf('\\alpha'), { anchor: 1 })
    expect(out.text).toBe('$\\alpha{}beta$')
  })

  it('adds nothing when no letter follows', () => {
    const out = apply('$a$', variantOf('\\alpha'), { anchor: 2 })
    expect(out.text).toBe('$a\\alpha$')
    expect(out.text).not.toContain('{}')
  })

  it('adds nothing when the insertion is wrapped', () => {
    // The `$` is already a delimiter, so a `{}` inside the formula would be
    // source the user did not ask for.
    const out = apply('beta', variantOf('\\alpha'), { anchor: 0 })
    expect(out.text).toBe('$\\alpha$beta')
    expect(out.text).not.toContain('{}')
  })

  it('states the rule as a function', () => {
    const doc = EditorState.create({ doc: 'beta' }).doc
    expect(needsTerminator(doc, 0, '\\alpha')).toBe(true)
    expect(needsTerminator(doc, 0, '\\alpha{}')).toBe(false)
    expect(needsTerminator(doc, 0, '\\alpha ')).toBe(false)
  })
})

describe('insertion: several selections', () => {
  it('classifies and wraps each range independently', () => {
    // One caret in prose and one in mathematics, from the same pre-transaction
    // state: a mixed pair gets two different wrappers, which is what §9 asks
    // for and what a single "is the caret in maths" flag cannot express.
    const state = multiCursorState('prose $a$', [0, 8])
    expect(state.selection.ranges.length, 'the facet must be on or CodeMirror collapses the ranges').toBe(2)
    const plan = planInsertion({ entryId: 'x', variant: variantOf('\\alpha'), state })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.changes.map((change) => change.insert).sort()).toEqual([
      '$\\alpha$',
      '\\alpha'
    ])
  })

  it('refuses the whole operation when one range is invalid', () => {
    // §9: "If any range is invalid, refuse the entire operation and explain why;
    // do not partially edit a document."
    const state = multiCursorState('a % comment', [0, 8])
    const plan = planInsertion({ entryId: 'x', variant: variantOf('\\alpha'), state })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('restricted-context')
  })

  it('maps every caret through the combined change set', () => {
    const state = multiCursorState('aa bb', [0, 3])
    const plan = planInsertion({ entryId: 'x', variant: variantOf('\\omega'), state })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    let next = state
    const applied = applyInsertionPlan(plan, {
      get state() {
        return next
      },
      dispatch(transaction: { state: EditorState }) {
        next = transaction.state
      }
    } as never)
    expect(next.doc.toString()).toBe('$\\omega$aa $\\omega$bb')
    // The second caret moved by the length the first insertion added; an
    // unmapped caret would land inside the first formula. Both sit before their
    // own closing `$`, so a second click continues the same formula.
    expect(next.doc.sliceString(18, 19)).toBe('$')
    expect(applied.carets.map((caret) => caret.anchor)).toEqual([7, 18])
  })
})

describe('insertion: undo and the editor contract', () => {
  it('applies exactly one transaction, with a new history boundary', () => {
    // §9: "Apply one transaction with an insertion user-event annotation, one
    // undo step … Keep history boundaries from merging multiple panel clicks
    // unexpectedly." A panel click produces no keyboard or pointer event of its
    // own, so without the annotation CodeMirror's grouping would merge two
    // clicks into one undo the user cannot see.
    const state = EditorState.create({
      doc: 'a b',
      selection: { anchor: 2 },
      extensions: [LaTeXLanguage]
    })
    const plan = planInsertion({ entryId: 'x', variant: variantOf('\\alpha'), state })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    const dispatches: Array<{ isolated: unknown; userEvent: unknown; text: string }> = []
    let next = state
    applyInsertionPlan(plan, {
      get state() {
        return next
      },
      dispatch(transaction: Transaction) {
        dispatches.push({
          isolated: transaction.annotation(isolateHistory),
          userEvent: transaction.annotation(Transaction.userEvent),
          text: transaction.state.doc.toString()
        })
        next = transaction.state
      }
    })

    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].isolated).toBe('full')
    expect(dispatches[0].userEvent).toBe(INSERT_USER_EVENT)
    expect(dispatches[0].text).toBe('a $\\alpha$b')
  })
})

describe('the raw-command escape hatch', () => {
  it('wraps an unknown command by context like any other', () => {
    const out = apply('prose ', rawCommandVariant('\\myUnknown'), { anchor: 6 })
    expect(out.text).toBe('prose $\\myUnknown$')
  })

  it('accepts a command written without its backslash', () => {
    expect(rawCommandVariant('myUnknown').command).toBe('\\myUnknown')
  })
})
