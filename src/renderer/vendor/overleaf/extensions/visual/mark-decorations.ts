import {
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view'
import { EditorState, Range } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { getUnstarredEnvironmentName } from '../../utils/tree-operations/environments'
import { centeringNodeForEnvironment } from '../../utils/tree-operations/figure'
import { parseTheoremStyles } from '../../utils/tree-operations/theorems'
import { Tree, type SyntaxNode } from '@lezer/common'
import { parseColorArguments } from '../../utils/tree-operations/colors'

/**
 * The HTML heading level for a LaTeX sectioning command.
 *
 * `\part` and `\chapter` both open a document, so they map to `h1`; the
 * remaining levels follow LaTeX's own nesting order. Anything the grammar does
 * not list falls back to `h2`, which is where `\section` sits.
 */
const headingLevels: Record<string, number> = {
  part: 1,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
}

/**
 * Eukolia: section numbers, kept across rebuilds instead of recounted.
 *
 * `parseSectionNumbers` walks the **whole syntax tree** to count `\section`,
 * `\subsection` and `\subsubsection` commands and to record the number of each one by
 * position. It is the only way to get those numbers — a section's number is how many
 * sections precede it — but it does not have to be done per keystroke, and on a
 * 14 529-line Stacks chapter it was: measured with `scripts/probe-keystroke.mjs`, one
 * keystroke walked **253 535 nodes for 11.6 ms** in this function, the second largest
 * cost a keystroke had.
 *
 * **A section number is a prefix count, so it survives typing.** A character typed at
 * the caret cannot change how many `\section`s came before it, so the map can be kept
 * and the walk resumed from where the numbering stopped. Two positions matter:
 *
 *  - the walk reads *to* `tree.length`, so the next one can begin at the previous
 *    `tree.length` minus the overlap an incremental parse re-reads;
 *  - what it records is only useful at the sectioning commands themselves, and those
 *    below the caret keep their positions only until the edit moves them — so the map
 *    is reused as *counters*, and the entries for positions at or past the resume point
 *    are rebuilt by the resumed walk.
 *
 * The counters are the part that must be exact, and they are: `s`, `ss` and `sss` are
 * functions of the commands strictly before the resume point, which is exactly what the
 * previous walk counted.
 */
interface SectionNumbering {
  /** The document this numbering was read from, by identity — see `atomic-decorations.ts`. */
  doc: unknown
  /**
   * Where the counting actually stopped — the end of the last sectioning command seen.
   *
   * **Not the tree length**, which is what the first version of this stored and why the
   * resume never happened: a walk reads to the end of the document whether or not there
   * is anything in it to count, so `changedFrom >= tree.length` is false for every edit
   * that is not in the last few characters, and the whole tree was walked again on every
   * keystroke — 253 535 nodes for 13.6 ms, still there after the first attempt.
   */
  resumeAt: number
  s: number
  ss: number
  sss: number
  numbers: Map<number, string>
}

let sectionNumbering: SectionNumbering | null = null

/**
 * {@link parseSectionNumbers}, resumed from the previous call when it can be.
 *
 * `changedFrom` is the lowest position the document changed at since the last call, or
 * `undefined` when it did not change. The numbering is still correct up to `resumeAt`
 * exactly when the document is the same object (nothing changed) or the change was at
 * or after that point: below it, the commands and their order are untouched, so
 * `s`/`ss`/`sss` still describe them.
 *
 * The map is shared with the running state and must be treated as read-only; the caller
 * only reads from it, and `data-section-number` is a string copied out of it. An entry
 * recorded *before* the resume point keeps its value, which is correct for the same
 * reason the counters are.
 */
/**
 * Eukolia: nodes a `\section` can never be inside, skipped without descending.
 *
 * The list is by node name and deliberately narrow: a name that does not belong here
 * costs a missed heading, so only containers that structurally cannot hold a sectioning
 * command are listed — mathematics, verbatim blocks and comments.
 */
const SECTIONING_SKIP = new Set([
  'Math',
  'MathContainer',
  'InlineMath',
  'DisplayMath',
  '$MathContainer',
  'Verbatim',
  'VerbatimContent',
  'Comment',
  'LineComment',
  'BlockComment',
])

/**
 * Every `SectioningCommand` at or after `from`, walking with a cursor that skips.
 *
 * The descent is a hand-written pre-order traversal rather than `tree.iterate` for the
 * reason in `parseSectionNumbers`' own comment: the iterator cannot skip a subtree, and
 * a document's mathematics outweighs its headings by three orders of magnitude.
 *
 * The first loop positions the cursor at the shallowest node containing `from`, which is
 * what keeps a resumed walk from re-reading the file it already read. The second is the
 * traversal: visit, descend unless the node is skippable, then move to the next sibling,
 * climbing until there is one.
 */
const forEachSectioningCommand = (
  tree: Tree,
  from: number,
  visit: (node: SyntaxNode) => void
): void => {
  const cursor = tree.cursor()
  while (cursor.firstChild()) {
    if (cursor.to > from) break
    // A child that ends before `from` cannot contain it; step over it.
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) return
    }
  }

  for (;;) {
    if (cursor.to > from) {
      if (cursor.type.is('SectioningCommand')) visit(cursor.node)
      if (!SECTIONING_SKIP.has(cursor.name) && cursor.firstChild()) continue
    }
    for (;;) {
      if (cursor.nextSibling()) break
      if (!cursor.parent()) return
    }
  }
}

function parseSectionNumbers(
  state: EditorState,
  tree: Tree,
  changedFrom: number | undefined
): Map<number, string> {
  const document = state.doc
  const previous = sectionNumbering
  const canResume =
    previous !== null &&
    previous.doc === document &&
    (changedFrom === undefined || changedFrom >= previous.resumeAt)
  const from = canResume ? previous.resumeAt : 0

  const numbers = canResume ? previous.numbers : new Map<number, string>()
  let s = canResume ? previous.s : 0
  let ss = canResume ? previous.ss : 0
  let sss = canResume ? previous.sss : 0
  let resumeAt = from

  forEachSectioningCommand(tree, from, node => {
    /*
     * A command that *starts* before the resume point was counted by the walk that
     * stopped there, and the cursor hands it over again because it is the node that
     * contains the position. The guard is on the node's own end, the same way the
     * context scan's is on its start, so the two passes agree about a straddling node.
     */
    if (node.to <= from) return
    const ctrlSeq = node.getChild('$CtrlSeq')
    if (ctrlSeq) {
      const text = state.doc.sliceString(ctrlSeq.from + 1, ctrlSeq.to)
      if (!text.endsWith('*')) {
        if (text === 'section') {
          s++
          ss = 0
          sss = 0
          numbers.set(node.from, `${s}`)
        } else if (text === 'subsection') {
          ss++
          sss = 0
          numbers.set(node.from, `${s > 0 ? s + '.' : ''}${ss}`)
        } else if (text === 'subsubsection') {
          sss++
          numbers.set(node.from, `${s > 0 ? s + '.' : ''}${ss}.${sss}`)
        }
      }
    }
    if (node.to > resumeAt) resumeAt = node.to
  })

  sectionNumbering = { doc: document, resumeAt, s, ss, sss, numbers }
  return numbers
}

export const sectionHeadingTag = (command: string): string =>
  `h${headingLevels[command] ?? 2}`

/**
 * A view plugin that decorates ranges of text with Mark decorations.
 * Mark decorations add attributes to elements within a range.
 */
export const markDecorations = ViewPlugin.define(
  view => {
    const createDecorations = (
      state: EditorState,
      tree: Tree,
      changedFrom?: number
    ): DecorationSet => {
      const decorations: Range<Decoration>[] = []

      const theoremStyles = parseTheoremStyles(state, tree)
      const sectionNumbers = parseSectionNumbers(state, tree, changedFrom)

      for (const { from, to } of view.visibleRanges) {
        tree?.iterate({
          from,
          to,
          enter(nodeRef) {
            if (
              nodeRef.type.is('KnownCommand') ||
              nodeRef.type.is('UnknownCommand')
            ) {
              // decorate commands with a class, for optional styling
              const ctrlSeq =
                nodeRef.node.getChild('$CtrlSeq') ??
                nodeRef.node.firstChild?.getChild('$CtrlSeq')

              if (ctrlSeq) {
                const text = state.doc.sliceString(ctrlSeq.from + 1, ctrlSeq.to)

                // a special case for "label" as the whole command needs a space afterwards
                if (text === 'label') {
                  // decorate the whole command
                  const from = nodeRef.from
                  const to = nodeRef.to
                  if (to > from) {
                    decorations.push(
                      Decoration.mark({
                        class: `ol-cm-${text}`,
                        inclusive: true,
                      }).range(from, to)
                    )
                  }
                } else {
                  // decorate the command content
                  const from = ctrlSeq.to + 1
                  const to = nodeRef.to - 1
                  if (to > from) {
                    decorations.push(
                      Decoration.mark({
                        class: `ol-cm-command-${text}`,
                        inclusive: true,
                      }).range(from, to)
                    )
                  }
                }
              }
            } else if (nodeRef.type.is('SectioningCommand')) {
              // decorate section headings with a class, for styling
              const ctrlSeq = nodeRef.node.getChild('$CtrlSeq')
              if (ctrlSeq) {
                const text = state.doc.sliceString(ctrlSeq.from + 1, ctrlSeq.to)
                const secNumber = sectionNumbers.get(nodeRef.from)

                decorations.push(
                  Decoration.mark({
                    class: `ol-cm-heading ol-cm-command-${text}`,
                    // Eukolia: emit a real heading element, not a styled span.
                    // The wrapping element is what gives the document structure
                    // to assistive technology (and to the smoke probe); the
                    // visual editor's own stylesheet keeps it inline so it
                    // still flows inside a CodeMirror line.
                    tagName: sectionHeadingTag(text),
                    attributes: secNumber ? { 'data-section-number': secNumber } : undefined,
                  }).range(nodeRef.from, nodeRef.to)
                )
              }
            } else if (nodeRef.type.is('Caption') || nodeRef.type.is('Label')) {
              const type = nodeRef.type.is('Caption') ? 'caption' : 'label'
              // decorate caption and label lines with a class, for styling
              const argument = nodeRef.node.getChild('$Argument')

              if (argument) {
                const lines = {
                  start: state.doc.lineAt(nodeRef.from),
                  end: state.doc.lineAt(nodeRef.to),
                }

                for (
                  let lineNumber = lines.start.number;
                  lineNumber <= lines.end.number;
                  lineNumber++
                ) {
                  const line = state.doc.line(lineNumber)
                  decorations.push(
                    Decoration.line({
                      class: `ol-cm-${type}-line`,
                    }).range(line.from)
                  )
                }
              }
            } else if (nodeRef.type.is('TextColorCommand')) {
              const result = parseColorArguments(state, nodeRef.node)

              if (result) {
                const { color, from, to } = result

                // decorate the content
                decorations.push(
                  Decoration.mark({
                    class: 'ol-cm-textcolor',
                    inclusive: true,
                    attributes: {
                      style: `color: ${color}`,
                    },
                  }).range(from, to)
                )
              }
            } else if (nodeRef.type.is('ColorBoxCommand')) {
              const result = parseColorArguments(state, nodeRef.node)

              if (result) {
                const { color, from, to } = result

                // decorate the content
                decorations.push(
                  Decoration.mark({
                    class: 'ol-cm-colorbox',
                    inclusive: true,
                    attributes: {
                      style: `background-color: ${color}`,
                    },
                  }).range(from, to)
                )
              }
            } else if (nodeRef.type.is('$Environment')) {
              const environmentName = getUnstarredEnvironmentName(
                nodeRef.node,
                state
              )

              if (environmentName) {
                switch (environmentName) {
                  case 'abstract':
                  case 'figure':
                  case 'table':
                  case 'verbatim':
                  case 'lstlisting':
                    {
                      const centered = Boolean(
                        centeringNodeForEnvironment(nodeRef)
                      )

                      const lines = {
                        start: state.doc.lineAt(nodeRef.from),
                        end: state.doc.lineAt(nodeRef.to),
                      }

                      for (
                        let lineNumber = lines.start.number;
                        lineNumber <= lines.end.number;
                        lineNumber++
                      ) {
                        const line = state.doc.line(lineNumber)

                        const classNames = [
                          `ol-cm-environment-${environmentName}`,
                          'ol-cm-environment-line',
                        ]

                        if (centered) {
                          classNames.push('ol-cm-environment-centered')
                        }

                        decorations.push(
                          Decoration.line({
                            class: classNames.join(' '),
                          }).range(line.from)
                        )
                      }
                    }
                    break

                  case 'quote':
                  case 'quotation':
                  case 'quoting':
                  case 'displayquote':
                    {
                      const lines = {
                        start: state.doc.lineAt(nodeRef.from),
                        end: state.doc.lineAt(nodeRef.to),
                      }

                      for (
                        let lineNumber = lines.start.number;
                        lineNumber <= lines.end.number;
                        lineNumber++
                      ) {
                        const line = state.doc.line(lineNumber)

                        const classNames = [
                          `ol-cm-environment-${environmentName}`,
                          'ol-cm-environment-quote-block',
                          'ol-cm-environment-line',
                        ]

                        decorations.push(
                          Decoration.line({
                            class: classNames.join(' '),
                          }).range(line.from)
                        )
                      }
                    }
                    break

                  default:
                    if (theoremStyles.has(environmentName)) {
                      const theoremStyle = theoremStyles.get(environmentName)

                      if (theoremStyle) {
                        const lines = {
                          start: state.doc.lineAt(nodeRef.from),
                          end: state.doc.lineAt(nodeRef.to),
                        }

                        decorations.push(
                          Decoration.line({
                            class: [
                              `ol-cm-environment-theorem-${theoremStyle}`,
                              'ol-cm-environment-first-line',
                            ].join(' '),
                          }).range(lines.start.from)
                        )

                        for (
                          let lineNumber = lines.start.number + 1;
                          lineNumber <= lines.end.number - 1;
                          lineNumber++
                        ) {
                          const line = state.doc.line(lineNumber)

                          decorations.push(
                            Decoration.line({
                              class: [
                                `ol-cm-environment-theorem-${theoremStyle}`,
                                'ol-cm-environment-line',
                              ].join(' '),
                            }).range(line.from)
                          )
                        }

                        decorations.push(
                          Decoration.line({
                            class: [
                              `ol-cm-environment-theorem-${theoremStyle}`,
                              'ol-cm-environment-last-line',
                            ].join(' '),
                          }).range(lines.start.from)
                        )
                      }
                    }
                    break
                }
              }
            }
          },
        })
      }

      return Decoration.set(decorations, true)
    }

    let previousTree = syntaxTree(view.state)
    /**
     * The viewport range the current decorations were built for.
     *
     * `createDecorations` decorates the commands the user can see
     * (`view.visibleRanges`, line 81), so its output genuinely depends on the
     * viewport — but only on *which* range is visible, not on the fact that a
     * `viewportChanged` flag was set. Scrolling redraws the viewport several times
     * per step (measured: 3.6–11.3 updates per scroll step on a 665-line chapter),
     * and every one of them rebuilt the whole set for the same range. Recording the
     * range turns those into nothing while keeping the rebuild that matters: when
     * the visible range actually moves.
     */
    let builtFrom = -1
    let builtTo = -1

    const build = (
      state: EditorState,
      tree: Tree,
      changedFrom?: number
    ): DecorationSet => {
      // A plugin is constructed before the view's first measure, so `view.viewport`
      // is not there yet on the first build. Recording `-1` means the first update
      // that reports a viewport change rebuilds rather than skipping, which is the
      // safe direction to be wrong in.
      const viewport = view.viewport
      builtFrom = viewport ? viewport.from : -1
      builtTo = viewport ? viewport.to : -1
      return createDecorations(state, tree, changedFrom)
    }

    return {
      decorations: build(view.state, previousTree),
      update(update: ViewUpdate) {
        const tree = syntaxTree(update.state)

        // still parsing
        if (
          tree.type === previousTree.type &&
          tree.length < update.view.viewport.to
        ) {
          this.decorations = this.decorations.map(update.changes)
        } else if (
          tree !== previousTree ||
          (update.viewportChanged &&
            (update.view.viewport.from !== builtFrom || update.view.viewport.to !== builtTo))
        ) {
          /*
           * Where the document changed, which is what lets the section numbering be
           * resumed rather than recounted — see `parseSectionNumbers`. The *earliest*
           * changed position, over every range the transaction carries.
           */
          let changedFrom: number | undefined
          if (update.docChanged) {
            const changed = update.changes
            changed.iterChangedRanges((fromA, _toA, fromB) => {
              const at = Math.min(fromA, fromB)
              if (changedFrom === undefined || at < changedFrom) changedFrom = at
            })
          }
          // parsed, or the visible range moved
          previousTree = tree
          // TODO: update the existing decorations for the changed range(s)?
          this.decorations = build(update.state, tree, changedFrom)
        }
      },
    }
  },
  {
    decorations(value) {
      return value.decorations
    },
  }
)
