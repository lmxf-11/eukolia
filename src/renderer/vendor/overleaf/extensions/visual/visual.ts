import {
  Compartment,
  EditorState,
  Extension,
  StateEffect,
  StateField,
  TransactionSpec,
} from '@codemirror/state'
import { visualHighlightStyle, visualTheme } from './visual-theme'
import { atomicDecorations } from './atomic-decorations'
import { markDecorations } from './mark-decorations'
import importOverleafModules from '@/vendor/overleaf/eukolia/import-overleaf-modules'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { visualKeymap } from './visual-keymap'
import { mathPreRender } from './math-prerender'
import { getMousedownSelection, mousedown, mouseDownEffect } from './selection'
import { forceParsing, syntaxTree } from '@codemirror/language'
import { hasLanguageLoadedEffect } from '../language'
import { restoreScrollPosition } from '../scroll-position'
import { listItemMarker } from './list-item-marker'
import { pasteHtml } from './paste-html'
import { commandTooltip } from '../command-tooltip'
import { tableGeneratorTheme } from './table-generator'
import { debugConsole } from '@/vendor/overleaf/eukolia/debugging'
import { getFileExtension } from '../../utils/file'

// Module-provided visual editors registered via the
// `sourceEditorVisualExtensions` hook. Module exposes `getExtensions(ext)`,
// returning the visual-mode extensions for that file extension. A module match takes precedence
// over the LaTeX fallback
const moduleVisualExtensionProviders: Array<{
  import: { getExtensions: (ext: string) => Extension }
}> = importOverleafModules('sourceEditorVisualExtensions')

const visualConf = new Compartment()

export const toggleVisualEffect = StateEffect.define<boolean>()

const visualState = StateField.define<boolean>({
  create() {
    return false
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(toggleVisualEffect)) {
        return effect.value
      }
    }
    return value
  },
})

/**
 * What Eukolia lets a caller switch off in Visual Mode.
 *
 * `atomicDecorations` — the whole-document widget pass. `eagerParse` — parsing the
 * document to its end before showing it. Both are the same decision at different
 * sizes, and `src/renderer/visual/largeDocument.ts` holds the measurements behind
 * the thresholds.
 */
export interface VisualOptions {
  atomicDecorations?: boolean
  eagerParse?: boolean
}

let visualOptions: VisualOptions = {}

const configureVisualExtensions = (showVisual: boolean) =>
  showVisual ? sharedVisualExtensions(visualOptions) : []

export const visual = (
  docName: string,
  showVisual: boolean,
  options: VisualOptions = {}
): Extension => {
  // Recorded so the compartment's own reconfiguration — which happens on a mode
  // switch, without the options in hand — keeps the same decisions.
  visualOptions = options
  const extensions = visualModuleExtensions(docName) ?? latexVisualExtensions(options)

  return [
    visualState.init(() => showVisual),
    visualConf.of(configureVisualExtensions(showVisual)),
    visualOnly(showVisual, extensions),
  ]
}

export const isVisual = (view: EditorView) => {
  return view.state.field(visualState, false) || false
}

export const setVisual = (showVisual: boolean): TransactionSpec => {
  return {
    effects: [
      toggleVisualEffect.of(showVisual),
      visualConf.reconfigure(configureVisualExtensions(showVisual)),
    ],
  }
}

// Loads `extension` only while the editor is in a particular mode, reacting to
// mode switches via `toggleVisualEffect`. `activeWhenVisual` selects which mode:
// `true` for visual-only, `false` for source-only.
const modeOnly = (
  activeWhenVisual: boolean,
  visual: boolean,
  extension: Extension
) => {
  const conf = new Compartment()
  const configure = (visual: boolean) =>
    visual === activeWhenVisual ? extension : []
  return [
    conf.of(configure(visual)),

    // Respond to switching editor modes
    EditorState.transactionExtender.of(tr => {
      for (const effect of tr.effects) {
        if (effect.is(toggleVisualEffect)) {
          return {
            effects: conf.reconfigure(configure(effect.value)),
          }
        }
      }
      return null
    }),
  ]
}

export const visualOnly = (visual: boolean, extension: Extension) =>
  modeOnly(true, visual, extension)

export const sourceOnly = (visual: boolean, extension: Extension) =>
  modeOnly(false, visual, extension)

const parsedAttributesConf = new Compartment()

/**
 * A view plugin which shows the editor content, makes it focusable,
 * and restores the scroll position, once the initial decorations have been applied.
 *
 * `eagerParse` is Eukolia's: when false, the content is shown without first parsing
 * the document to its end. See the note in the body.
 */
export const showContentWhenParsed = (eagerParse: boolean) => [
  parsedAttributesConf.of([EditorView.editable.of(false)]),
  ViewPlugin.define(view => {
    const showContent = () => {
      view.dispatch(
        {
          effects: parsedAttributesConf.reconfigure([
            EditorView.editorAttributes.of({
              class: 'ol-cm-parsed',
            }),
            EditorView.editable.of(true),
          ]),
        },
        restoreScrollPosition()
      )
      if (view.dom && !view.dom.contains(document.activeElement)) {
        // Eukolia: only when the editor does not already hold focus (a rebuild
        // while the user is in the settings view must not steal it), and through
        // CodeMirror's own `focus()`, which is the reference's call.
        //
        // `focus()` focuses `contentDOM` through `focusPreventScroll`, which uses
        // `{ preventScroll: true }` and restores the scroller by hand where the
        // browser does not support it — so it cannot move the viewport, and it
        // does make the caret active. Focusing `view.dom` instead (what this did
        // before) left the caret unfocused: the editor element is not the
        // contenteditable, so nothing was focused at all.
        view.focus()
      }
    }

    // already parsed
    if (syntaxTree(view.state).length === view.state.doc.length) {
      window.setTimeout(showContent)
      return {}
    }

    /*
     * Eukolia: a large document is not parsed to the end before it is shown.
     *
     * The reference forces the parse so that every widget exists before the content
     * appears — no pop-in. On a chapter of the Stacks project (47 886 lines, 1.77 MB)
     * that is a **3 s** synchronous parse on the renderer thread, in the frame that
     * opened the file, for decorations the application has already switched off at
     * that size (`largeDocument.ts`, `EAGER_PARSE_LINES`, passed in as `eagerParse`).
     * CodeMirror parses the viewport on demand, so what is on screen is decorated
     * either way and the rest arrives as the user scrolls.
     */
    if (!eagerParse) {
      window.setTimeout(showContent)
      return {}
    }

    // as a fallback, make sure the content is visible after 5s
    const fallbackTimer = window.setTimeout(showContent, 5000)

    let languageLoaded = false

    return {
      update(update) {
        // wait for the language to load before telling the parser to run
        if (!languageLoaded && hasLanguageLoadedEffect(update)) {
          languageLoaded = true
          // in a timeout, as this is already in a dispatch cycle
          window.setTimeout(() => {
            try {
              // tell the parser to run until the end of the document
              forceParsing(view, view.state.doc.length, 10000)
              // clear the fallback timeout
              window.clearTimeout(fallbackTimer)
              // show the content, in a timeout so the decorations can build first
              window.setTimeout(showContent)
            } catch (err) {
              debugConsole.error(err)
            }
          })
        }
      },
    }
  }),
]

/**
 * A transaction extender which scrolls mouse clicks into view, in case decorations have moved the cursor out of view.
 */
const scrollJumpAdjuster = EditorState.transactionExtender.of(tr => {
  // Attach a "scrollIntoView" effect on mouse selections to adjust for
  // any jumps that may occur when hiding/showing decorations, but only when
  // the user actually moved the cursor with their click/drag.
  // Scrolling via scrollbar clicks or drags should NEVER snap back to the cursor!
  if (!tr.scrollIntoView) {
    for (const effect of tr.effects) {
      if (effect.is(mouseDownEffect) && effect.value === false) {
        const initialSelection = getMousedownSelection(tr.startState)
        if (initialSelection && !tr.newSelection.eq(initialSelection)) {
          return {
            effects: EditorView.scrollIntoView(tr.newSelection.main.head),
          }
        }
      }
    }
  }

  return {}
})

const sharedVisualExtensions = (options: VisualOptions = {}) => [
  visualTheme,
  visualHighlightStyle,
  mousedown,
  scrollJumpAdjuster,
  ...showContentWhenParsed(options.eagerParse !== false),
  EditorView.contentAttributes.of({ 'aria-label': 'Visual Editor editing' }),
]

/**
 * The Visual Mode extensions, minus the ones a large document cannot afford.
 *
 * `atomicDecorations` is a `StateField` that walks the **whole** syntax tree and
 * builds a widget for every construct in the document, and it rebuilds on every parse
 * step: ~10 ms and ~387 widget objects per keystroke on a 665-line chapter, linear in
 * the document. VS Code answers the same problem by not tokenizing a large file at
 * all — the text is shown, the rendering that cannot keep up is not — and this is
 * that decision applied to the pass we have. Everything else in Visual Mode
 * (`markDecorations`, which is viewport-bounded, the keymap, the tooltips) stays, so
 * the mode is still Visual Mode; it draws source where a widget would have been.
 *
 * See `src/renderer/visual/largeDocument.ts` for the thresholds and the measured
 * curve behind them.
 */
const latexVisualExtensions = (options: VisualOptions = {}): Extension => [
  listItemMarker,
  ...(options.atomicDecorations === false ? [] : [atomicDecorations]),
  markDecorations, // NOTE: must be after atomicDecorations, so that mark decorations wrap inline widgets
  visualKeymap,
  mathPreRender,
  commandTooltip,
  pasteHtml,
  tableGeneratorTheme,
]

// Returns the visual-mode extensions provided by a module for the active document
const visualModuleExtensions = (docName: string): Extension | null => {
  const fileExt = getFileExtension(docName)
  if (!fileExt) {
    return null
  }

  for (const provider of moduleVisualExtensionProviders) {
    const result = provider.import.getExtensions(fileExt)
    const extensions = Array.isArray(result) ? result : [result]
    if (extensions.length > 0) {
      return extensions
    }
  }

  return null
}
