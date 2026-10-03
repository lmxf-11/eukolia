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
import { Tree } from '@lezer/common'
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

function parseSectionNumbers(state: EditorState, tree: Tree): Map<number, string> {
  const map = new Map<number, string>()
  let s = 0, ss = 0, sss = 0
  tree.iterate({
    enter(nodeRef) {
      if (nodeRef.type.is('SectioningCommand')) {
        const ctrlSeq = nodeRef.node.getChild('$CtrlSeq')
        if (ctrlSeq) {
          const text = state.doc.sliceString(ctrlSeq.from + 1, ctrlSeq.to)
          if (!text.endsWith('*')) {
            if (text === 'section') {
              s++
              ss = 0
              sss = 0
              map.set(nodeRef.from, `${s}`)
            } else if (text === 'subsection') {
              ss++
              sss = 0
              map.set(nodeRef.from, `${s > 0 ? s + '.' : ''}${ss}`)
            } else if (text === 'subsubsection') {
              sss++
              map.set(nodeRef.from, `${s > 0 ? s + '.' : ''}${ss}.${sss}`)
            }
          }
        }
      }
    },
  })
  return map
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
      tree: Tree
    ): DecorationSet => {
      const decorations: Range<Decoration>[] = []

      const theoremStyles = parseTheoremStyles(state, tree)
      const sectionNumbers = parseSectionNumbers(state, tree)

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

    const build = (state: EditorState, tree: Tree): DecorationSet => {
      // A plugin is constructed before the view's first measure, so `view.viewport`
      // is not there yet on the first build. Recording `-1` means the first update
      // that reports a viewport change rebuilds rather than skipping, which is the
      // safe direction to be wrong in.
      const viewport = view.viewport
      builtFrom = viewport ? viewport.from : -1
      builtTo = viewport ? viewport.to : -1
      return createDecorations(state, tree)
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
          // parsed, or the visible range moved
          previousTree = tree
          // TODO: update the existing decorations for the changed range(s)?
          this.decorations = build(update.state, tree)
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
