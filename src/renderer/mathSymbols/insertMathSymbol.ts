/**
 * Eukolia — planning and applying a mathematical-symbol insertion.
 *
 * The whole insertion is decided **before** anything is written. `planInsertion`
 * reads the editor state, classifies every selection range, renders the chosen
 * variant, works out where the caret and the argument slots land, and returns
 * either a complete `InsertionPlan` or a refusal. `applyInsertionPlan` then does
 * one thing: turn that plan into a single CodeMirror transaction.
 *
 * That split is what makes the guarantees in `MathematicalSymbols.md` §9 true
 * rather than aspirational:
 *
 *  * **Atomic.** Every range is validated against the same pre-transaction
 *    state. One range in a comment refuses the whole operation, so a document is
 *    never half-edited.
 *  * **One undo step.** One transaction, and an `isolateHistory` annotation so
 *    two panel clicks a moment apart stay two steps instead of merging into one
 *    the user cannot see.
 *  * **The caret is planned, not derived.** Repeated insertions continue the same
 *    formula because the caret is placed before the closing `$` by construction,
 *    not because the change happened to map there.
 *
 * The lexical rules at the end are the ones that are easy to skip and impossible
 * to notice: inserting `\alpha` immediately before `beta` must not produce
 * `\alphabeta`, and it must not produce it for a *custom* control sequence
 * either — which is why the check runs against the document, not against a list
 * of known commands.
 */

import { EditorSelection, EditorState, Transaction, type Text } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import type { Tree } from '@lezer/common'

import { classifyInsertionPoint, classifySelection } from './insertionContext'
import type {
  ArgumentSlot,
  InsertionFailure,
  InsertionPlan,
  InsertionResult,
  PlannedCaret,
  PlannedChange,
  PlannedRange,
  SymbolVariant,
  TemplatePart
} from './types'

/** The user-event annotation an insertion carries, for undo and for tests. */
export const INSERT_USER_EVENT = 'insert.mathSymbol'

/* ------------------------------------------------------------------ *
 * Rendering a variant
 * ------------------------------------------------------------------ */

/** Where one slot's content sits inside a rendered variant. */
export interface RenderedSlot {
  readonly index: number
  /** Offsets into the rendered text. */
  readonly from: number
  readonly to: number
}

export interface RenderedTemplate {
  readonly text: string
  readonly slots: readonly RenderedSlot[]
}

/**
 * Renders a variant's parts, filling at most one slot.
 *
 * Slots are structured parts, not `#1` markers in a string, so no LaTeX is ever
 * re-parsed here — which is the failure this design exists to avoid: a body
 * containing a literal `#` (a macro parameter in a project template, a `#` in
 * `\text`) would be rewritten by any implementation that substituted markers
 * textually.
 */
export function renderVariant(
  variant: SymbolVariant,
  fill?: { readonly index: number; readonly text: string }
): RenderedTemplate {
  let text = ''
  const slots: RenderedSlot[] = []
  for (const part of variant.parts) {
    if (isSlot(part)) {
      const slot = variant.slots.find((candidate) => candidate.index === part.slot)
      const content = fill && fill.index === part.slot ? fill.text : slot?.default ?? ''
      const from = text.length
      text += content
      slots.push({ index: part.slot, from, to: text.length })
    } else {
      text += part.text
    }
  }
  return { text, slots }
}

const isSlot = (part: TemplatePart): part is { readonly slot: number } => 'slot' in part

/**
 * The slot the caret lands in, and the one a selection moves into.
 *
 * §9 names the "designated first slot" — the one an accent, a fraction or an
 * alphabet takes its argument from. That is the first slot marked
 * `selected-text`, because a template may open with an *optional* slot (an
 * nth-root's index, a `\xrightarrow`'s lower label) that a selection has no
 * business filling. When no slot is marked that way, the first declared slot is
 * the caret's destination: §9 asks for empty slots "with the first slot
 * selected", and a template whose slots were all `placeholder` would otherwise
 * leave the caret after the construct rather than inside it.
 */
export function primarySlot(variant: SymbolVariant): ArgumentSlot | null {
  return variant.slots.find((slot) => slot.select === 'selected-text') ?? variant.slots[0] ?? null
}

/* ------------------------------------------------------------------ *
 * Lexical termination
 * ------------------------------------------------------------------ */

const isLetter = (character: string): boolean => /[A-Za-z]/.test(character)

/** The character at `offset`, or `''` past the end. */
const charAt = (doc: Text, offset: number): string =>
  offset >= 0 && offset < doc.length ? doc.sliceString(offset, offset + 1) : ''

/** Whether `text` ends with a control word — a backslash and letters. */
const endsWithControlWord = (text: string): boolean => /\\[A-Za-z]+$/.test(text)

/**
 * Whether the insertion needs an empty group after it.
 *
 * TeX reads a control word as *all* the letters that follow it, so `\alpha`
 * written against the text `beta` is one command called `alphabeta` — not an
 * error the user sees, but a different symbol than the one they picked. The
 * condition is therefore about the next character in the *document*, not about
 * the symbol: a `{}` is added only when a letter actually follows.
 *
 * `{}` rather than a space: a space terminates the control word but survives
 * into the output in text mode, while an empty group never typesets anything in
 * either mode.
 */
export function needsTerminator(doc: Text, atEnd: number, inserted: string): boolean {
  if (!endsWithControlWord(inserted)) return false
  return isLetter(charAt(doc, atEnd))
}

/**
 * Whether the insertion would extend the control word in front of it.
 *
 * The mirror image of `needsTerminator`, and it applies to the *preceding*
 * token: putting a bare letter immediately after `\foo` renames the command
 * rather than writing a letter. A `{}` in front separates them.
 *
 * Nothing in the generated catalog begins with a letter — every variant starts
 * with a backslash, a `$` or a brace — so this is a guard for project templates
 * and for any future variant that does, rather than a case the catalog produces.
 */
export function needsLeadingSeparator(doc: Text, atStart: number, inserted: string): boolean {
  const first = inserted.slice(0, 1)
  if (!isLetter(first)) return false
  let at = atStart - 1
  let letters = 0
  while (at >= 0 && isLetter(doc.sliceString(at, at + 1))) {
    letters += 1
    at -= 1
  }
  return letters > 0 && doc.sliceString(at, at + 1) === '\\'
}

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

/** What the caller has to supply for one planned insertion. */
export interface InsertionRequest {
  readonly entryId: string
  readonly variant: SymbolVariant
  /** The pre-transaction state. Every range is read from this and no other. */
  readonly state: EditorState
  /** Whether the underlying document refuses edits. */
  readonly readOnly?: boolean
  /** A tree already resolved for this state, when the caller has one. */
  readonly tree?: Tree
  /** One sentence for the details pane, describing why this variant was chosen. */
  readonly explanation?: string
  /**
   * Insert raw code with no math wrapping and no mode check.
   *
   * §7 allows it for an uncertain project command, and requires that it never be
   * what an ordinary glyph button does: the panel reaches it only from a
   * separate, explicitly labelled action.
   */
  readonly rawCode?: boolean
}

const failure = (
  entryId: string,
  code: InsertionFailure['code'],
  message: string
): InsertionFailure => ({ ok: false, entryId, code, message })

/**
 * Builds the plan, or refuses.
 *
 * The refusal is a *result*, not a thrown error: "this symbol needs `amssymb`
 * and the document does not load it" is an answer the panel shows, not a crash.
 */
export function planInsertion(request: InsertionRequest): InsertionResult {
  const { state, variant, entryId } = request
  const { doc } = state

  if (request.readOnly ?? state.readOnly) {
    return failure(entryId, 'read-only', 'this document is read-only')
  }

  const raw = request.rawCode === true
  const wrapAllowed = !raw && variant.mode === 'math-only' && !variant.selfContainedMath

  const changes: PlannedChange[] = []
  const carets: PlannedCaret[] = []
  const ranges: PlannedRange[] = []

  for (const range of state.selection.ranges) {
    const context = range.empty
      ? classifyInsertionPoint(state, range.from, request.tree)
      : classifySelection(state, range.from, range.to, request.tree)

    if (context.kind === 'restricted') {
      return failure(entryId, 'restricted-context', context.reason)
    }
    if (context.kind === 'unknown') {
      return failure(
        entryId,
        'unknown-context',
        `${context.reason}; Eukolia will not guess whether this is mathematics`
      )
    }
    /*
     * A text-only command inside a formula is not made safe by the mode policy,
     * it is simply wrong there — a wrapper cannot turn `\textdegree` into
     * mathematics. §8's last line: "Text-only entries must not inherit the math
     * insertion policy."
     */
    if (variant.mode === 'text-only' && context.kind === 'math') {
      return failure(
        entryId,
        'mode-mismatch',
        'this command is text-only and the caret is in mathematics'
      )
    }

    const selected = range.empty ? '' : doc.sliceString(range.from, range.to)
    const slot = primarySlot(variant)
    /*
     * A selection is moved into the slot only when the slot asked for it. The
     * fallback slot — the first one, when nothing is marked `selected-text` — is
     * where the *caret* goes, not where a selection goes: dropping selected
     * prose into a `\frac`'s numerator because it happened to be first would be
     * a guess about the user's intent.
     */
    const fill =
      slot && slot.select === 'selected-text' && selected.length > 0
        ? { index: slot.index, text: selected }
        : undefined
    const rendered = renderVariant(variant, fill)

    /*
     * Whether the inserted code is already mathematics.
     *
     * `variant.mode` is what the *symbol* requires; the context is what the
     * *document* is. Both have to be consulted, and the only combination that
     * gets a wrapper is a math-only symbol dropped into prose. A
     * `mode-independent` variant that brings its own mathematics — an
     * `\ensuremath` alias — is deliberately not wrapped again.
     */
    const wrapping = wrapAllowed && context.kind === 'text'

    /*
     * Lexical separation, on both sides of the insertion.
     *
     * `\alpha` written against `beta` is one control word called `alphabeta`, so
     * a `{}` is added — but only when a letter really follows *in the document*.
     * A wrapped insertion needs neither guard: the `$` in front and behind the
     * body already delimits the control word, and adding `{}` inside the formula
     * would be source the user did not ask for and cannot explain.
     *
     * A body that would extend the control word *before* it needs a `{}` in
     * front for the mirror-image reason. Nothing in the generated catalog begins
     * with a letter — every variant starts with a backslash, a `$` or a brace —
     * so this is a guard for project templates rather than a case the catalog
     * produces.
     */
    const needsTerminatorHere =
      !wrapping && needsTerminator(doc, range.to, rendered.text)
    const leading = !wrapping && needsLeadingSeparator(doc, range.from, rendered.text)

    const body = `${leading ? '{}' : ''}${rendered.text}${needsTerminatorHere ? '{}' : ''}`
    const insert = wrapping ? `$${body}$` : body

    const insertionStart = range.from
    const bodyOffset = (leading ? 2 : 0) + (wrapping ? 1 : 0)
    const caretInBody = caretOffsetInBody(rendered, variant)
    const caretAbsolute = insertionStart + bodyOffset + caretInBody

    changes.push({ from: range.from, to: range.to, insert })
    const caret: PlannedCaret = {
      anchor: caretAbsolute,
      head: caretAbsolute,
      slot: firstSlotAt(rendered, caretInBody)
    }
    carets.push(caret)
    ranges.push({
      from: range.from,
      to: range.to,
      changes: [{ from: range.from, to: range.to, insert }],
      caret,
      wrapped: wrapping ? 'inline-math' : 'none'
    })
  }

  const explanation =
    request.explanation ??
    (variant.mode === 'math-only'
      ? 'typeset as mathematics'
      : `${variant.mode.replace('-', ' ')}`)

  return {
    ok: true,
    entryId,
    variantId: variant.id,
    command: variant.command,
    preview: describeInsertion(changes),
    changes,
    carets,
    ranges,
    explanation
  }
}
/**
 * A variant for a command the catalog does not know.
 *
 * Used by exactly one caller — the `editor:insert-symbol` compatibility adapter,
 * for ported code that names a command the catalog has never heard of. It is
 * deliberately not reachable from the panel's ordinary glyph button: §7 allows
 * raw code for an uncertain command, and requires that it never be the hidden
 * behaviour of a button that looks like it inserts a symbol.
 *
 * The variant is `math-only` like any other, so the wrapper still follows the
 * caret's context; what is unknown is the command, not the mode.
 */
export function rawCommandVariant(command: string): SymbolVariant {
  const spelled = command.startsWith('\\') ? command : `\\${command}`
  return {
    id: `raw:${spelled}`,
    command: spelled,
    parts: [{ text: spelled }],
    slots: [],
    requires: [],
    engines: null,
    mode: 'math-only',
    selfContainedMath: false
  }
}

/**
 * Where inside the rendered body the caret should sit.
 *
 * Inside the primary slot when there is one, so the caret is where the argument
 * goes and the slot's own default is selected; at the end of the body otherwise,
 * which for a wrapped insertion is the offset just before the closing `$` — the
 * position that makes a second click continue the same formula rather than
 * starting a new one beside it.
 */
/**
 * Where inside the rendered body the caret should sit.
 *
 * At the *end* of the primary slot's content when there is one — which for an
 * empty slot is the slot's own offset and for a slot filled from a selection is
 * the offset just after the expression that was moved into it, so the caret
 * carries on inside the construct rather than before it.
 *
 * With no slot the caret goes to the end of the body, which for a wrapped
 * insertion is the offset just before the closing `$`: the position that makes a
 * second click continue the same formula rather than starting a new one beside
 * it, as §8 asks.
 */
function caretOffsetInBody(rendered: RenderedTemplate, variant: SymbolVariant): number {
  const slot = primarySlot(variant)
  if (slot) {
    const placed = rendered.slots.find((candidate) => candidate.index === slot.index)
    if (placed) return placed.to
  }
  return rendered.text.length
}

/** The slot whose content the caret sits in, if any. */
function firstSlotAt(rendered: RenderedTemplate, offset: number): number | null {
  for (const slot of rendered.slots) {
    if (offset >= slot.from && offset <= slot.to) return slot.index
  }
  return null
}

/** The exact source the plan will write, for the panel's preview line. */
function describeInsertion(changes: readonly PlannedChange[]): string {
  return changes.map((change) => change.insert).join(' … ')
}

/* ------------------------------------------------------------------ *
 * Applying
 * ------------------------------------------------------------------ */

/**
 * A planned change set, with each change's insertion offset resolved.
 *
 * The final caret positions are computed from the changes rather than mapped
 * through them, and each caret is paired with *its own* range's change rather
 * than with whichever change happens to start before it. Ranges are disjoint and
 * sorted, so a change's insertion point in the new document is its old offset
 * plus the net length change of everything before it — an exact answer, where
 * `mapPos` with the wrong association would be an off-by-one nobody notices
 * until the second insertion. Pairing by position instead of by identity is the
 * same bug in a different disguise: with cursors at 0 and 3, both final carets
 * sit past both changes, so a positional search gives them the same shift.
 */
function placeInsertions(plan: InsertionPlan): {
  changes: PlannedChange[]
  selection: EditorSelection
  carets: PlannedCaret[]
} {
  const ordered = plan.changes
    .map((change, index) => ({ change, index }))
    .sort((a, b) => a.change.from - b.change.from)

  const shiftByRange = new Map<number, number>()
  let shift = 0
  for (const { change, index } of ordered) {
    shiftByRange.set(index, shift)
    shift += change.insert.length - (change.to - change.from)
  }

  const placed = plan.ranges
    .map((range, index) => {
      const offset = range.caret.anchor + (shiftByRange.get(index) ?? 0)
      return { anchor: offset, head: offset, slot: range.caret.slot }
    })
    .sort((a, b) => a.anchor - b.anchor)

  const selection =
    placed.length === 0
      ? EditorSelection.single(0)
      : EditorSelection.create(
          placed.map((caret) => EditorSelection.cursor(caret.head)),
          placed.length - 1
        )

  return { changes: ordered.map((entry) => entry.change), selection, carets: placed }
}

/**
 * Applies a plan to a view's state and returns the transaction.
 *
 * `view` is anything with a `dispatch`, which is what lets this run against a
 * real `EditorView` in the application and against a bare state in a test.
 */
export function applyInsertionPlan(
  plan: InsertionPlan,
  target: { readonly state: EditorState; dispatch(transaction: Transaction): void }
): { readonly carets: readonly PlannedCaret[] } {
  const { changes, selection, carets } = placeInsertions(plan)
  target.dispatch(
    target.state.update({
      changes: changes.map((change) => ({
        from: change.from,
        to: change.to,
        insert: change.insert
      })),
      selection,
      scrollIntoView: true,
      userEvent: INSERT_USER_EVENT,
      // Two clicks on the panel are two edits the user made, and one undo has to
      // put back exactly one of them. Without this the history merges them,
      // because a panel click produces no keyboard or pointer event of its own
      // for CodeMirror's grouping to key off.
      annotations: [isolateHistory.of('full'), Transaction.userEvent.of(INSERT_USER_EVENT)]
    })
  )
  return { carets }
}

/**
 * The insertion plan for a template's remaining slots, as source edits.
 *
 * Returned rather than applied, because slot navigation is a UI concern: the
 * panel decides whether Tab is a CodeMirror snippet session or its own key
 * handler, and this only has to say where the slots ended up.
 */
export function slotRanges(plan: InsertionPlan): Array<{ slot: number; from: number; to: number }> {
  const placed = placeInsertions(plan)
  const found: Array<{ slot: number; from: number; to: number }> = []
  plan.ranges.forEach((range, index) => {
    const caret = placed.carets[index]
    if (caret?.slot === null || caret?.slot === undefined) return
    found.push({ slot: caret.slot, from: caret.anchor, to: caret.anchor })
  })
  return found
}
