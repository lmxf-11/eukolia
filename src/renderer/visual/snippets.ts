/**
 * Eukolia — HyperSnips integration for the editor.
 *
 * Code Mode and Visual Mode are one CodeMirror editor, so a snippet has to
 * behave identically in both. This module wires the ported HyperSnips engine
 * into it in three places — an automatic-expansion hook on typing, a completion
 * source for the manual entries, and a Tab/Shift+Tab handler for tab stops —
 * using the same engine and the same settings the Monaco host used to drive,
 * which is where the behaviour (and the tests that pin it) came from.
 *
 * The expansion itself is applied as a single CodeMirror transaction — the
 * snippet text *and* the tab stop it lands on — dispatched one microtask after
 * the keystroke that triggered it. That keeps Instructions.md §27 intact (the
 * host reports whatever the transaction changed as a minimal delta and never
 * regenerates the document) and it is why the expansion cannot be seen arriving
 * a frame late: there is no second transaction, no timer and no round trip
 * between the character and the snippet.
 */

import { Annotation, Compartment, EditorSelection, EditorState, Prec, type Extension, type SelectionRange, type Text } from '@codemirror/state'
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { completionStatus, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { ancestorOfNodeWithType } from '../vendor/overleaf/utils/tree-operations/ancestors'
import { mathAncestorNode } from '../vendor/overleaf/utils/tree-operations/math'
import { inMathAt } from '../editor/mathContext'

import { setting, settingsManager } from '../core/settings'
import { Position, Range } from '../vendor/vscode-shim/position'
import type { TextDocumentContentChangeEvent } from 'vscode'
import {
  getSnippetEngine,
  type SnippetDocumentChange,
  type SnippetExpansion,
  type SnippetExpansionCandidate,
} from '../snippets/engine'
import { leadingLiteral, stripAnchor } from '../vendor/hypersnips/completion'
import type { DocumentLike } from '../snippets/documentAdapter'

/** The language id the ported HyperSnips sources are registered under. */
const LATEX_LANGUAGE_ID = 'latex'

/**
 * Selects the expansion's current tab stop, or places the caret after it.
 *
 * The behaviour the Monaco host's `selectActivePlaceholder` had, over the one
 * editor, so Tab walks the same placeholders in either mode.
 */
export function selectActivePlaceholder(
  view: EditorView,
  expansion: SnippetExpansion
): void {
  view.dispatch({
    selection: placeholderSelection(expansion),
    scrollIntoView: true,
    annotations: TAB_STOP_MOVED.of(true),
  })
}

/** The selection an expansion's current tab stop wants, in document offsets. */
function placeholderSelection(expansion: SnippetExpansion): SelectionRange {
  const geometry = getSnippetEngine().getGeometry(expansion)
  const target = geometry.selected[0]
  return target
    ? EditorSelection.range(target.documentFrom, target.documentTo)
    : EditorSelection.cursor(geometry.to)
}

/**
 * Expands an `A`-flag snippet after a single typed character.
 *
 * The ported engine only fires for one-character insertions, which is exactly
 * what a keystroke produces, so the caller has already established that. Returns
 * `true` when a snippet was expanded.
 *
 * `textOffset`/`position` are where the character landed — the editor knows both
 * without counting lines through the document — and `doc` is the buffer after the
 * keystroke, handed over as CodeMirror's own `Text` rather than as a string: the
 * engine reads a line or two out of it through its index, and nothing materialises
 * the whole document unless a snippet actually matched. Typing prose therefore
 * costs the match and nothing else; the string is built once, below, for the
 * expansion that needs to be laid out in it.
 */
export function applyAutomaticSnippet(
  view: EditorView,
  typed: string,
  textOffset: number,
  position: Position,
  doc: Text
): boolean {
  if (!setting.bool('snippets.enabled') || !setting.bool('snippets.autoExpand')) {
    return false
  }

  const engine = getSnippetEngine()
  // Both the pre- and post-change positions are the same for an insertion, and
  // CodeMirror already knows the line they are on.
  const change: SnippetDocumentChange = {
    text: typed,
    // A getter: read only when a snippet has matched and the expansion needs the
    // text it is being laid out in.
    get textAfter(): string {
      return doc.toString()
    },
    range: new Range(position, position),
    offset: textOffset,
  }

  const mathCheck = (offset: number) => inMathAt(view.state, offset)
  const cmDoc = createCodeMirrorDocument(doc, LATEX_LANGUAGE_ID, mathCheck)
  const result = engine.tryAutomaticExpansion(
    change,
    LATEX_LANGUAGE_ID,
    cmDoc,
    undefined,
    cmDoc
  )
  if (!result) return false

  const expansion = result.expansion as SnippetExpansion
  const text = doc.toString()

  /*
   * A snippet that hands back exactly what it matched is not an edit, and must not
   * be dispatched as one.
   *
   * This is the *common* case in prose, not a corner: `evil_text` and `evil_math`
   * decline a candidate by returning the text they were given (`preserveFiberedInput`
   * appends `$0` to it), so in text mode every word followed by a space matches the
   * trigger, is rejected, and then landed in the buffer as a replacement of the
   * range it came from. CodeMirror cannot know the text is identical — only the
   * caller can — so that replacement marked the document as changed, and a changed
   * document rebuilds every decoration in the file, re-runs the project index,
   * re-arms the analyser and reports a change to the host. One keystroke therefore
   * did all of that work **twice**: once for the character typed, and once for the
   * snippet declining to do anything with it.
   *
   * The guard is the transaction's own definition of a no-op: the text it would
   * insert is the text it would replace, and the selection it would set is the
   * selection the editor already has. Anything else — a different text, or a tab
   * stop placed somewhere else — still dispatches, so a snippet that reproduces its
   * trigger with a placeholder inside it keeps working.
   */
  const current = view.state.selection.main
  const wanted = placeholderSelection(expansion)
  if (result.text === text.slice(result.insertOffset, result.replaceEnd) && wanted.from === current.from && wanted.to === current.to) {
    // The completion list has to stay quiet after an insertion, and it decides that
    // from the document the edit produced — which, here, is the one already there.
    justInsertedInto = view.state.doc
    return true
  }

  // The instance was laid out against the document *before* the insertion, and
  // its tab stops are answered in the coordinates of whatever text the engine
  // holds for it. Handing it the document this edit produces — before the
  // selection is computed from it — is what puts the caret on the snippet's
  // first placeholder instead of at the end of it.
  engine.setExpansionDocumentText(
    expansion,
    text.slice(0, result.insertOffset) + result.text + text.slice(result.replaceEnd)
  )

  // One transaction, not two: the expansion and the tab stop it lands on are the
  // same edit as far as the host, the undo history and the renderer are
  // concerned. Dispatching the selection separately cost a second editor update,
  // a second change report to the host and a second selection report per
  // expansion, for a caret that was never meant to be seen in between.
  view.dispatch({
    changes: { from: result.insertOffset, to: result.replaceEnd, insert: result.text },
    selection: placeholderSelection(expansion),
    scrollIntoView: true,
    // A snippet insertion is one undoable step together with the trigger, and it
    // carries the annotation the update listener reads to tell it apart from an
    // edit made inside the expansion.
    userEvent: 'input.complete',
    annotations: SNIPPET_INSERTED.of(expansion),
  })
  return true
}

/**
 * How many entries the snippet list offers at once.
 *
 * A library can hold hundreds of entries and three typed characters can
 * prefix-match a large part of it. CodeMirror does not cap a completion result,
 * so the cap is here.
 */
const COMPLETION_LIMIT = 50

/**
 * The document a snippet was just inserted into.
 *
 * An insertion is itself a document change, and the completion query the editor
 * starts for it asks about the text it produced — in which the caret sits at the
 * end of exactly what the trigger matched. Left alone, the entry that was just
 * expanded is offered again, one keystroke away from being inserted twice.
 * Comparing `Text` is an identity check (CodeMirror documents are persistent), so
 * any later edit produces a different one and clears the suppression by itself.
 */
let justInsertedInto: Text | null = null

/**
 * Snippet entries for the completion list — the manual half of the feature.
 *
 * `expand: "manual"` is the format's default, and the completion list is the only
 * place such an entry can be reached from: it never fires while typing. The
 * engine's matcher already computes what the list should offer — the entries the
 * trigger has not matched fully, including patterns that have only matched their
 * leading literal so far — so this is a thin adapter over that answer: where the
 * replacement starts, what to call it, and what accepting it does.
 */
export function snippetCompletionSource(context: CompletionContext): CompletionResult | null {
  if (!setting.bool('snippets.enabled')) return null
  // An explicit request is the author asking, so it is always answered.
  if (!context.explicit && context.state.doc === justInsertedInto) return null

  // Nothing typed for a trigger to match against: an empty pair of braces, or a
  // keystroke in the middle of a word, must not pay for a copy of the document.
  const word = context.matchBefore(/[^\s{}[\]]*/)
  if (!word || word.from === word.to) return null

  const engine = getSnippetEngine()
  const text = context.state.doc.toString()
  const candidates = engine
    .getCompletions({ text, offset: context.pos, languageId: LATEX_LANGUAGE_ID })
    // Only what the trigger has *not* already done: an entry that matched and
    // expands while typing has inserted itself already, and offering it again
    // would be offering a duplicate.
    .filter(candidate => !candidate.automatic)
  if (candidates.length === 0) return null

  const options: Completion[] = []
  let earliest = context.pos
  for (const candidate of candidates.slice(0, COMPLETION_LIMIT)) {
    const from = offsetIn(context.state.doc, candidate.range.start)
    if (from > context.pos) continue
    earliest = Math.min(earliest, from)
    options.push({
      label: entryLabel(candidate),
      detail: candidate.snippet.description || undefined,
      type: 'snippet',
      // The range CodeMirror hands to `apply` is the result's, which is shared by
      // every option; the candidate's own range is the one the engine matched, so
      // it is what the replacement uses. They agree in practice — all the
      // matcher's ranges end at the caret — and the result's is the widest of
      // them, which is what highlighting needs.
      apply: view => applySnippetCandidate(view, candidate, from, context.pos),
    })
  }
  if (options.length === 0) return null

  // `filter: false`: the engine matched these against the trigger itself, and
  // CodeMirror's own matcher knows nothing about snippet triggers — left on, it
  // would rank by a fuzzy match against text that is still being typed.
  return { from: earliest, to: context.pos, options, filter: false }
}

/** What the list shows for a candidate: the text it matched, or its trigger. */
function entryLabel(candidate: SnippetExpansionCandidate): string {
  if (candidate.label) return candidate.label
  const source = candidate.snippet.regexp?.source ?? candidate.snippet.trigger
  // A pattern has no readable name of its own; its leading literal text is what
  // the author is typing, and the whole pattern is the fallback for one that
  // starts with a group.
  return leadingLiteral(source) || stripAnchor(source)
}

/**
 * Expands the snippet the list accepted.
 *
 * The same shape as the automatic path — build the instance, tell it what the
 * buffer is about to hold, then apply the expansion and its tab stop in one
 * transaction — with one difference: the replaced range is the one the list
 * reported, so a trigger that is longer than a keystroke (`\alpha` typed over
 * several characters) is replaced whole.
 */
function applySnippetCandidate(
  view: EditorView,
  candidate: SnippetExpansionCandidate,
  from: number,
  to: number
): void {
  const engine = getSnippetEngine()
  const doc = view.state.doc
  const text = doc.toString()

  const expansion = engine.expand(candidate, { text, languageId: LATEX_LANGUAGE_ID })
  // The instance was laid out against the text the trigger is still in; it has to
  // be told the document the edit produces before the caret is read out of it.
  engine.setExpansionDocumentText(
    expansion,
    text.slice(0, from) + expansion.plainText + text.slice(to)
  )

  view.dispatch({
    changes: { from, to, insert: expansion.plainText },
    selection: placeholderSelection(expansion),
    scrollIntoView: true,
    userEvent: 'input.complete',
    annotations: SNIPPET_INSERTED.of(expansion),
  })
}

/**
 * The engine's document seam over a CodeMirror `Text`.
 *
 * Every question the matcher asks — which line is the caret on, what does the
 * text before it say, where does this position sit — is one its own line index can
 * answer without building the buffer, so a keystroke never pays for the document
 * it is typing into. `getText()` is there because the seam requires it; it is the
 * one call that materialises everything, and nothing on the keystroke path makes
 * it unless a snippet matched.
 */
function createCodeMirrorDocument(
  doc: Text,
  languageId: string,
  isMathAt?: (offset: number) => boolean
): DocumentLike {
  const lineAt = (line: number | Position) => {
    const number = typeof line === 'number' ? line : line.line
    const clamped = Math.max(0, Math.min(number, doc.lines - 1))
    const info = doc.line(clamped + 1)
    return {
      text: info.text,
      firstNonWhitespaceCharacterIndex: info.text.length - info.text.replace(/^\s+/, '').length,
    }
  }

  return {
    languageId,
    getText: (range?: Range) =>
      range ? doc.sliceString(offsetIn(doc, range.start), offsetIn(doc, range.end)) : doc.toString(),
    offsetAt: (position: Position) => offsetIn(doc, position),
    positionAt: (offset: number) => {
      const info = doc.lineAt(Math.max(0, Math.min(offset, doc.length)))
      return new Position(info.number - 1, Math.max(0, offset - info.from))
    },
    lineAt,
    get lineCount() {
      return doc.lines
    },
    isMathAt,
  }
}

/** A document position as an offset, through CodeMirror's own line index. */
function offsetIn(doc: Text, position: Position): number {
  const clamped = Math.max(0, Math.min(position.line, doc.lines - 1))
  const info = doc.line(clamped + 1)
  return info.from + Math.max(0, Math.min(position.character, info.length))
}

/** Moves to the next (`forward`) or previous tab stop of the active expansion. */
function moveTabStop(view: EditorView, forward: boolean): boolean {
  // Snippets off means Tab is Tab: an expansion that was already live when the
  // setting was switched off must not keep capturing the key.
  if (!setting.bool('snippets.enabled')) return false

  const engine = getSnippetEngine()
  const active = engine.activeExpansion
  if (!active) return false

  // Shift-Tab at the first stop stays there. The reference's `prevPlaceholder`
  // reports "no earlier stop" by dropping the expansion, which abandoned a snippet
  // the author was still filling in — and with an outer expansion underneath, the
  // caret was then selected into *that* one, possibly in another part of the file.
  if (!forward && !engine.hasEarlierTabStops()) {
    selectActivePlaceholder(view, active)
    return true
  }

  // An expansion that is *finishing* is popped by the advance below, so it has to
  // be remembered first: `$0` is the last tab stop, and the caret still has to be
  // put on it. Without this Tab appears to do nothing on its final press, which
  // is the difference between a snippet that ends where its author said it does
  // and one that does not.
  const finishes = forward && !engine.hasMoreTabStops()
  const instance = forward ? engine.nextTabStop() : engine.previousTabStop()
  const target = instance ?? (finishes ? active : null)
  if (!target) return false

  const geometry = engine.getGeometry(target)
  const targets =
    geometry.selected.length > 0
      ? geometry.selected
      : geometry.placeholders.filter(placeholder => placeholder.id === 0)
  const selection = targets[0]

  // A tab stop is an offset into the document the expansion was laid out in, and
  // that document can be shorter now — an undo, a delete that took the snippet
  // with it. CodeMirror rejects an out-of-range selection by throwing, from inside
  // a key handler, which leaves the key unprevented; clamping instead puts the
  // caret at the end of what is actually there.
  const length = view.state.doc.length
  const clamp = (offset: number) => Math.max(0, Math.min(offset, length))

  view.dispatch({
    selection: selection
      ? EditorSelection.range(clamp(selection.documentFrom), clamp(selection.documentTo))
      : EditorSelection.cursor(clamp(geometry.to)),
    scrollIntoView: true,
    annotations: TAB_STOP_MOVED.of(true),
  })
  return true
}

/**
 * The last selection the user made, for `${VISUAL}`.
 *
 * The variable is read at the moment a snippet expands, and by then the
 * selection it names is already gone: the trigger character that fired the
 * snippet *replaced* it. So the text is captured as the selection is made — the
 * Monaco host's `onDidChangeTextEditorSelection` did the same — and the ported
 * instance only honours a snapshot younger than five seconds.
 *
 * Only a selection the user made is recorded. An expansion selects its first
 * placeholder's default text and Tab selects the stops after it, so recording
 * whatever the selection happens to be would make the next expansion wrap the
 * placeholder the snippet itself had just highlighted.
 */
let lastSelection: { text: string; timestamp: number } | undefined

function rememberSelection(update: ViewUpdate): void {
  if (!update.transactions.some(transaction => transaction.isUserEvent('select'))) return

  const { from, to } = update.state.selection.main
  if (to > from) {
    const text = update.state.sliceDoc(from, to)
    if (text) lastSelection = { text, timestamp: Date.now() }
    return
  }

  // Collapsing the selection by hand forgets it — `${VISUAL}` must not insert
  // text the author has already deselected. A keystroke that collapses it does
  // not, because that keystroke is the trigger the selection is there to be
  // wrapped by; typing is not a `select` event, so it never gets here.
  lastSelection = undefined
}

/**
 * The key binding that walks the tab stops, as a reconfigurable extension.
 *
 * `snippets.tabStopKey` names the key, and a key binding is part of an extension:
 * CodeMirror cannot change one in place, so the binding lives in a compartment and
 * every live editor is reconfigured when the setting changes. Nothing read that
 * setting before — Tab was Tab whatever it said — and Shift-Tab stays Shift-Tab,
 * which is the key that walks *back*.
 */
const tabStopKeymap = new Compartment()

/** The key the live editors are currently bound to. */
let boundTabStopKey: string | null = null

/** Every live view mounting the snippet extensions, for a re-bind. */
const snippetViews = new Set<EditorView>()

/**
 * Expands a matching manual snippet candidate when Tab is pressed without opening autocomplete.
 */
export function expandMatchingSnippet(view: EditorView): boolean {
  if (!setting.bool('snippets.enabled')) return false
  if (getSnippetEngine().activeExpansion) return false
  const sel = view.state.selection.main
  if (!sel.empty) return false
  const pos = sel.head
  const engine = getSnippetEngine()
  const text = view.state.doc.toString()
  const candidates = engine
    .getCompletions({ text, offset: pos, languageId: LATEX_LANGUAGE_ID })
    .filter(candidate => !candidate.automatic)
  if (candidates.length === 0) return false
  for (const candidate of candidates) {
    const from = offsetIn(view.state.doc, candidate.range.start)
    const to = offsetIn(view.state.doc, candidate.range.end)
    if (to === pos && from < to) {
      const matchedText = text.slice(from, to)
      const isExact =
        candidate.snippet.trigger
          ? matchedText === candidate.snippet.trigger
          : Boolean(candidate.matchGroups && candidate.matchGroups.length > 0 && matchedText === candidate.label)
      if (isExact) {
        applySnippetCandidate(view, candidate, from, to)
        return true
      }
    }
  }
  return false
}

/**
 * Finds the innermost math container ($MathContainer, EquationEnvironment, EquationArrayEnvironment)
 * enclosing `pos` strictly inside its boundaries (`from < pos < to`).
 */
export function findInnermostMathContainer(
  state: EditorState,
  pos: number
): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, pos, 15) ?? syntaxTree(state)
  const node0 = tree.resolveInner(pos, 0)
  const container0 = ancestorOfNodeWithType(
    node0,
    '$MathContainer',
    'EquationEnvironment',
    'EquationArrayEnvironment'
  )
  if (container0 && pos > container0.from && pos < container0.to) {
    return container0
  }

  const node1 = tree.resolveInner(pos, -1)
  const container1 = ancestorOfNodeWithType(
    node1,
    '$MathContainer',
    'EquationEnvironment',
    'EquationArrayEnvironment'
  )
  if (container1 && pos > container1.from && pos < container1.to) {
    return container1
  }

  const fallback = mathAncestorNode(state, pos, 0) ?? mathAncestorNode(state, pos, -1)
  if (fallback && pos > fallback.from && pos < fallback.to) {
    return fallback
  }

  return null
}

/**
 * Jumps immediately outside of the enclosing math block when Tab is pressed
 * and there are no active snippet tab stops / tab holders ($1, $2, ...).
 */
export function jumpOutsideMath(view: EditorView): boolean {
  if (!setting.bool('snippets.enabled')) return false
  if (completionStatus(view.state) === 'active' && setting.bool('snippets.expandOnTab')) {
    return false
  }
  const sel = view.state.selection.main
  if (!sel.empty) return false
  const pos = sel.head

  const container = findInnermostMathContainer(view.state, pos)
  if (!container) return false

  const targetPos = Math.max(0, Math.min(container.to, view.state.doc.length))
  if (targetPos <= pos) return false

  view.dispatch({
    selection: EditorSelection.cursor(targetPos),
    scrollIntoView: true,
    annotations: TAB_STOP_MOVED.of(true),
  })
  return true
}

function tabStopKey(): string {
  return setting.str('snippets.tabStopKey').trim() || 'Tab'
}

function tabStopKeyBinding(): Extension {
  const primaryKey = tabStopKey()
  const bindings = [
    {
      key: primaryKey,
      run: (view: EditorView) => {
        if (moveTabStop(view, true)) return true
        if (setting.bool('snippets.expandOnTab') && primaryKey === 'Tab' && expandMatchingSnippet(view)) {
          return true
        }
        if (jumpOutsideMath(view)) return true
        return false
      },
    },
    { key: 'Shift-Tab', run: (view: EditorView) => moveTabStop(view, false) },
  ]
  if (primaryKey !== 'Tab') {
    bindings.push({
      key: 'Tab',
      run: (view: EditorView) => {
        if (setting.bool('snippets.expandOnTab') && expandMatchingSnippet(view)) {
          return true
        }
        if (jumpOutsideMath(view)) return true
        return false
      },
    })
  }
  return Prec.highest(keymap.of(bindings))
}

/** Re-binds the walk key in every open editor, if the setting moved. */
function rebindTabStopKey(): void {
  const key = tabStopKey()
  boundTabStopKey = key
  for (const view of snippetViews) {
    view.dispatch({ effects: tabStopKeymap.reconfigure(tabStopKeyBinding()) })
  }
}

settingsManager.on('change', rebindTabStopKey)

/**
 * Ends every live snippet expansion, as a mountable no-op extension.
 *
 * A snippet is laid out against the document it was expanded in, and the engine
 * holding it is process-wide. Rebuilding the editor for a document snippets do
 * not run in (JSON, Python, a `.bib`) is therefore a move between buffers, and
 * `snippetExtensions`'s own view plugin is what normally clears the stack on the
 * way out — except that it is not mounted there, because the extension set for
 * such a document is exactly what says snippets do not apply to it. This is the
 * one call that says so explicitly.
 *
 * Returning an extension rather than nothing is what lets the caller write the
 * two cases in one expression (`supportsSnippets(name) ? snippetExtensions() :
 * clearSnippetExpansions()`): the arm that does nothing still has to contribute
 * a value to the extension list, and `[]` is that value.
 */
export function clearSnippetExpansions(): Extension {
  getSnippetEngine().clearStack()
  return []
}

/**
 * The Visual Mode snippet extension set.
 *
 * Ordering matters: the Tab handler is installed at the highest precedence so a
 * snippet's tab stops win over any other Tab binding while an expansion is
 * active, and yields immediately (`return false`) when none is.
 *
 * `allowed` is the document's answer — `supportsSnippets(fileName)` in the
 * application's own extension set — and it is deliberately a parameter rather
 * than a question asked of the view: a view carries a document, not a file name,
 * and a snippet has to be silenced for the whole of a document snippets do not
 * apply to rather than re-decided per keystroke. The default keeps the module's
 * own tests and any caller that has already decided reading as they did.
 */
export const snippetExtensions = (allowed = true): Extension => {
  // The engine is process-wide and `${VISUAL}` has to be answered from the live
  // editor, so the view installs the snapshot it keeps as the engine's provider.
  getSnippetEngine().setSelectionProvider(() => lastSelection)
  boundTabStopKey = tabStopKey()

  return [
    tabStopKeymap.of(tabStopKeyBinding()),

    EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged) {
        // Adopt the edit into the active expansion *before* anything asks it a
        // question. A snippet's tab stops are ranges the ported instance owns, and
        // they only follow the buffer while the edit is reported to it: typing into
        // the first placeholder of `\braket{$1}{$2}$0` shifts `$2` along by what was
        // typed, and an instance that never heard about the keystroke still points
        // Tab at the position `$2` used to occupy.
        //
        // The insertions are also what the completion list has to be quiet about:
        // see `justInsertedInto`.
        if (adoptEditorEdit(update)) justInsertedInto = update.state.doc
      }

      // The caret leaving an expansion ends it. Without this the process-wide
      // `activeExpansion` outlived the place it belonged to: clicking elsewhere in
      // the document and pressing Tab yanked the caret back into a snippet that was
      // no longer being edited, and — because every later edit was still reported to
      // it — its tab stops drifted with edits made on the other side of the file.
      // The reference did this on every selection change (`onDidChangeTextEditorSelection`),
      // and it is done after the adoption above so the span it measures against is
      // the one the edit produced rather than the one before it.
      if (update.selectionSet || update.docChanged) {
        trimStackToSelection(update)
        rememberSelection(update)
      }

      // Nothing below expands anything in a document snippets do not apply to: a
      // trigger is a pattern in LaTeX notation, and running one in a JSON buffer is
      // how `ff` came to replace itself with `\frac{}{}`.
      if (!allowed) return

      if (!update.docChanged) return

      const typed = singleTypedCharacter(update)
      if (!typed) return

      // Expand *after* the update that carried the keystroke has finished.
      //
      // Dispatching from inside the listener applies the expansion immediately, so
      // its own update — and the host's change report for it — completes before
      // the host has been told about the keystroke itself. The document is shared
      // with Code Mode, and the host would then apply the expansion to offsets
      // that are still one edit behind: typing `@a` produced `$\aalpha` instead of
      // `$\alpha$` because the `a` was replayed at a stale offset.
      //
      // One microtask is enough to guarantee "keystroke reported, then expansion
      // reported", which is the order the shared buffer needs. It is also the
      // cheapest deferral there is and it is deliberately not a timer: the delay a
      // user sees is whatever the keystroke's own task costs, and a `setTimeout`
      // would add a frame on top of it for no gain.
      const view = update.view
      const doc = update.state.doc
      queueMicrotask(() => {
        // The document may have moved on (an undo, an external sync); expanding
        // against a stale buffer would replace the wrong range. Comparing the
        // `Text` is the same question as comparing its string and answers it in
        // constant time — CodeMirror's documents are immutable and persistent, so a
        // document that has not changed is the *same object*.
        if (view.state.doc === doc) {
          applyAutomaticSnippet(view, typed.text, typed.from, typed.position, doc)
        }
      })
    }),

    // A view is rebuilt when the file changes, and the engine is process-wide: a
    // snippet left half-filled in the old document has no place in the new one, and
    // its tab stops are offsets into a buffer that no longer exists. Without this,
    // Tab in the new file moved the caret to a position from the old one — which
    // CodeMirror rejects by throwing.
    //
    // The same plugin is how a live view is reached when the walk key changes
    // (`rebindTabStopKey`): one instance per editor mounting this set.
    ViewPlugin.fromClass(
      class {
        constructor(readonly view: EditorView) {
          snippetViews.add(view)
        }

        destroy(): void {
          snippetViews.delete(this.view)
          getSnippetEngine().clearStack()
        }
      }
    ),
  ]
}

/**
 * The mark on the transaction that inserts a snippet.
 */
const SNIPPET_INSERTED = Annotation.define<SnippetExpansion>()

/**
 * The mark on the transaction that navigates tab stops.
 */
const TAB_STOP_MOVED = Annotation.define<boolean>()

/**
 * Ends an expansion whose place in the document the caret has left.
 *
 * The reference's rule — an expansion stays active while the selection is inside
 * it — over one CodeMirror selection, measured against the same span the tab
 * stops are placed from (`getGeometry`) rather than against the instance's own
 * range: the range is a `DynamicRange` the ported `update` translates, and the
 * geometry is what the caret was actually put on. Clicking away therefore ends the
 * snippet, which is what makes Tab indent again rather than jumping back.
 *
 * The transactions that place an expansion and move between its stops are
 * skipped: they are the snippet moving the caret inside itself, and re-deciding
 * that from the outside would end the snippet on its own Tab.
 */
function trimStackToSelection(update: ViewUpdate): void {
  const engine = getSnippetEngine()
  if (!engine.activeExpansion) return
  if (
    update.transactions.some(
      transaction =>
        transaction.annotation(SNIPPET_INSERTED) !== undefined ||
        transaction.annotation(TAB_STOP_MOVED) === true
    )
  ) {
    return
  }

  const { from, to } = update.state.selection.main
  while (engine.activeExpansion) {
    const span = engine.getGeometry(engine.activeExpansion)
    if (to >= span.from && from <= span.to) break
    engine.popExpansion()
  }
}

/** Extracts vscode-shim change events from a CodeMirror ViewUpdate. */
function extractChanges(update: ViewUpdate): TextDocumentContentChangeEvent[] {
  const changes: TextDocumentContentChangeEvent[] = []
  update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes.push({
      range: new Range(positionIn(update.startState.doc, fromA), positionIn(update.startState.doc, toA)),
      rangeOffset: fromA,
      rangeLength: toA - fromA,
      text: inserted.toString(),
    })
  })
  return changes
}

/**
 * Reports a CodeMirror edit to snippet expansions on the stack.
 */
function adoptEditorEdit(update: ViewUpdate): boolean {
  const placedExpansions = update.transactions
    .map(transaction => transaction.annotation(SNIPPET_INSERTED))
    .filter((expansion): expansion is SnippetExpansion => expansion !== undefined)

  const engine = getSnippetEngine()

  if (placedExpansions.length > 0) {
    /*
     * One copy of the document for the whole pass, not one per expansion.
     *
     * `update.state.doc.toString()` is a full materialisation of the rope, and it
     * used to be evaluated *inside* both loops below — once per placed expansion
     * and again for every expansion on the stack. A nested expansion is several
     * frames deep, so a single keystroke inside one cost a copy per frame, of the
     * whole document, to hand every frame the same string.
     */
    const text = update.state.doc.toString()
    for (const placed of placedExpansions) {
      engine.setExpansionDocumentText(placed, text)
    }

    const changes = extractChanges(update)
    if (changes.length > 0) {
      for (const exp of engine.allExpansions) {
        if (!placedExpansions.includes(exp)) {
          engine.applyExpansionEdit(exp, changes, text)
        }
      }
    }
    return true
  }

  if (!engine.activeExpansion) return false

  const changes = extractChanges(update)
  if (changes.length === 0) return false

  const text = update.state.doc.toString()
  for (const exp of engine.allExpansions) {
    engine.applyExpansionEdit(exp, changes, text)
  }
  return false
}

/** A document offset as a `Position`, which the ported engine's ranges speak. */
function positionIn(doc: Text, offset: number): Position {
  const line = doc.lineAt(offset)
  return new Position(line.number - 1, offset - line.from)
}

/**
 * Returns the single character the user typed, or `null`.
 *
 * Only genuine keystrokes qualify: a paste, an undo or a programmatic edit must
 * never trigger automatic expansion, which is also the engine's own rule.
 */
function singleTypedCharacter(
  update: ViewUpdate
): { text: string; from: number; position: Position } | null {
  const isTyping = update.transactions.some(
    transaction =>
      transaction.isUserEvent('input.type') ||
      transaction.isUserEvent('input.type.compose')
  )
  if (!isTyping) return null

  let typed: { text: string; from: number; position: Position } | null = null
  let count = 0
  update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    count += 1
    const text = inserted.toString()
    if (fromA === toA && text.length === 1) {
      // The insertion point's position, from the document's own line index:
      // the engine needs a `Position`, and this is a lookup rather than a scan.
      const line = update.startState.doc.lineAt(fromA)
      typed = { text, from: fromA, position: new Position(line.number - 1, fromA - line.from) }
    }
  })

  return count === 1 ? typed : null
}
