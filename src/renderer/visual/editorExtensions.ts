import { FULL_FEATURES, type LargeDocumentProfile } from './largeDocument'

/**
 * Eukolia Visual Mode extension set.
 *
 * Overleaf composes its editor in `extensions/index.ts` and toggles Visual Mode
 * through `extensions/visual/visual.ts`. This module performs the same job for
 * Eukolia: it assembles the ported Overleaf extensions into one CodeMirror 6
 * extension array, driven by the `EukoliaEditorScope` instead of Overleaf's
 * React contexts and `window.overleaf.*` globals.
 */

import {
  EditorState,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  dropCursor,
  highlightActiveLineGutter,
  keymap,
  rectangularSelection,
  tooltips,
} from '@codemirror/view'
import {
  foldGutter,
  indentOnInput,
  indentUnit,
  bracketMatching as cmBracketMatching,
} from '@codemirror/language'
import { history, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches } from '@codemirror/search'

import { language, setLanguage, setMetadata } from '@/vendor/overleaf/extensions/language'
import type { Metadata } from '@/vendor/overleaf/extensions/language'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { docName } from '@/vendor/overleaf/extensions/doc-name'
import { docFolder } from '@/vendor/overleaf/extensions/doc-folder'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import type { PreviewByPath } from '@/vendor/overleaf/extensions/file-preview'
import {
  visual,
  isVisual,
  setVisual,
  sourceOnly,
  visualOnly,
} from '@/vendor/overleaf/extensions/visual/visual'
import { theme } from '@/vendor/overleaf/extensions/theme'
import { search } from '@/vendor/overleaf/extensions/search'
import { contextMenu } from '@/vendor/overleaf/extensions/context-menu'
import { editable } from '@/vendor/overleaf/extensions/editable'
import { autoPair } from '@/vendor/overleaf/extensions/auto-pair'
import { autoComplete } from '@/vendor/overleaf/extensions/auto-complete'
import { keymaps } from '@/vendor/overleaf/extensions/keymaps'
import { shortcuts } from '@/vendor/overleaf/extensions/shortcuts'
import { symbolPalette } from '@/vendor/overleaf/extensions/symbol-palette'
import { mathPreview } from '@/vendor/overleaf/extensions/math-preview'
import { effectListeners } from '@/vendor/overleaf/extensions/effect-listeners'
import { lineNumbers } from '@/vendor/overleaf/extensions/line-numbers'
import { lineWrappingIndentation } from '@/vendor/overleaf/extensions/line-wrapping-indentation'
import { highlightSpecialChars } from '@/vendor/overleaf/extensions/highlight-special-chars'
import { highlightActiveLine } from '@/vendor/overleaf/extensions/highlight-active-line'
import { inlineBackground } from '@/vendor/overleaf/extensions/inline-background'
import { verticalOverflow } from '@/vendor/overleaf/extensions/vertical-overflow'
import { emptyLineFiller } from '@/vendor/overleaf/extensions/empty-line-filler'
import { drawSelection } from '@/vendor/overleaf/extensions/draw-selection'
import { nonBlinkingCursor } from '@/vendor/overleaf/extensions/non-blinking-cursor'
import { bracketSelection } from '@/vendor/overleaf/extensions/bracket-matching'
import { goToLinePanel } from '@/vendor/overleaf/extensions/go-to-line'
import { filterCharacters } from '@/vendor/overleaf/extensions/filter-characters'
import { toolbarPanel } from '@/vendor/overleaf/extensions/toolbar/toolbar-panel'

import type { EukoliaEditorScope, ProjectFileEntry } from './scope'
import { setActiveOverallTheme } from '@/vendor/overleaf/eukolia/theme-hooks'
import { syntaxHighlightingFor } from './syntaxHighlighting'
import { clearSnippetExpansions, snippetCompletionSource, snippetExtensions } from './snippets'
import { caretAppearance } from './caretAppearance'
import { alignWhileTyping } from './alignWhileTyping'
import {
  normalizeWhitespaceRendering,
  whitespaceRendering,
} from './whitespaceRendering'
import { indentGuides } from './indentGuides'
import { environmentBracket } from './environmentBracket'
import { compilerDiagnostics, diagnosticGutter, latexLint } from '../editor/cmDiagnostics'
import { latexCompletionSource, latexHover } from '../editor/cmCompletion'
import {
  latexNavigation,
  type LatexNavigationHost,
} from '../editor/cmNavigation'
import { mathCaretAttribute, mathSourceDecorations } from '../editor/mathContext'
import { clickOnHiddenLine } from '../editor/clickHiddenLine'
import { projectMacrosExtension } from '../editor/projectMacros'
import { setting } from '../core/settings'

export interface VisualModeOptions {
  scope: EukoliaEditorScope
  fileName: string | null
  /** `light` or `dark`; drives the ported editor theme. */
  theme: 'light' | 'dark'
  /** Font size in px for the ported theme's CSS variables. */
  fontSize?: number
  /** Monospace stack for source islands, matching Code Mode's `editor.fontFamily`. */
  fontFamily?: string
  /** `editor.cursorBlinking`, shared with Code Mode. */
  cursorBlinking?: string
  /** `editor.smoothCaret`, shared with Code Mode. */
  smoothCaret?: boolean
  /** Whether to start in Visual Mode (`true`) or source mode (`false`). */
  startVisual?: boolean
  /**
   * What the LaTeX navigation extension cannot do for itself: open a project
   * file, and show a label's occurrences. Omitted, go-to-definition and Find All
   * References are not mounted at all — a key binding that resolves to nothing
   * would be worse than no key binding.
   */
  navigation?: LatexNavigationHost
  /** Called for every user edit, in addition to the host's own handling. */
  onDocChanged?: () => void
  /**
   * What this document is allowed to ask of the machine, decided once from its size
   * when it is opened. See `src/renderer/visual/largeDocument.ts`.
   */
  largeFile?: LargeDocumentProfile
}

/** Turns Visual Mode on or off without rebuilding the editor. */
export const setVisualMode = (showVisual: boolean): TransactionSpec =>
  setVisual(showVisual)

export { isVisual }

/** The file extensions Overleaf's LaTeX visual editor claims. */
export const VISUAL_MODE_EXTENSIONS = ['tex', 'ltx', 'sty', 'cls']

/**
 * The gutter's number formatter, matching Code Mode.
 *
 * Monaco's `editor.lineNumbers` accepts `off`, `relative` and `on`; `off` is
 * handled by not mounting the extension at all, and this reproduces `relative`
 * — the distance from the caret line, with the caret's own line numbered
 * absolutely, which is exactly Monaco's behaviour.
 */
function visualLineNumberFormatter():
  | ((lineNo: number, state: EditorState) => string)
  | undefined {
  if (setting.str('editor.lineNumbers') !== 'relative') return undefined
  return (lineNo, state) => {
    const current = state.doc.lineAt(state.selection.main.head).number
    if (lineNo === current) return String(lineNo)
    return String(Math.abs(lineNo - current))
  }
}
export const isVisualModeFile = (fileName: string | null): boolean => {
  if (!fileName) return true // untitled buffers are LaTeX buffers in Eukolia
  const index = fileName.lastIndexOf('.')
  if (index < 0) return true
  return VISUAL_MODE_EXTENSIONS.includes(fileName.slice(index + 1).toLowerCase())
}

/**
 * The file extensions whose documents Eukolia expands snippets in.
 *
 * LaTeX and Markdown, and nothing else. A snippet library is written in the
 * notation of a *writing* format — `ff` is `\frac{}{}`, `mk` is `$$`, a trigger
 * may be chosen to fire inside `$…$` — and a buffer that does not read that
 * notation has no place for the expansion. Left ungated, `ff` typed in a JSON
 * file replaced itself with `\frac{}{}` and corrupted the document, and every
 * keystroke in a `.py` file paid for a scan of a snippet library that could
 * never apply to it.
 *
 * Markdown is included because it carries inline and display mathematics
 * (`$…$`, `$$…$$`) and a good deal of prose written *about* LaTeX, which is
 * exactly where a trigger is wanted; the LaTeX intelligence proper (the
 * ported analyzer, the linter, the visual surface) stays on the LaTeX set
 * above, which is a separate question from which documents may expand a
 * snippet.
 */
export const SNIPPET_FILE_EXTENSIONS = [
  ...VISUAL_MODE_EXTENSIONS,
  'md',
  'markdown',
  'mdown',
  'mkdn'
]

/**
 * Whether snippets may expand in this document.
 *
 * An untitled buffer is a LaTeX buffer in Eukolia (`isVisualModeFile`'s own
 * rule, and the language the editor gives a file with no name), so it is
 * included; a name with no extension at all is judged the same way.
 */
export const supportsSnippets = (fileName: string | null): boolean => {
  if (!fileName) return true
  const index = fileName.lastIndexOf('.')
  if (index < 0) return true
  return SNIPPET_FILE_EXTENSIONS.includes(fileName.slice(index + 1).toLowerCase())
}

const projectFilesToMetadataFolder = (files: readonly ProjectFileEntry[]) => {
  const docs = files
    .filter(file => !file.isDirectory && /\.(tex|ltx)$/i.test(file.name))
    .map(file => ({ _id: file.path, name: file.path }))
  const fileRefs = files
    .filter(file => !file.isDirectory)
    .map(file => ({ _id: file.path, name: file.path }))
  return {
    _id: 'rootFolder',
    name: 'rootFolder',
    docs,
    folders: [],
    fileRefs,
  }
}

/**
 * Builds the project metadata that Overleaf's completion sources read from the
 * `metadataState` field, from the Eukolia editor scope.
 */
export const buildScopeMetadata = (
  scope: EukoliaEditorScope
): Metadata => {
  const symbols = scope.getSymbols()
  const macros = scope.getMacroTable()
  const files = scope.getProjectFiles()

  return {
    labels: new Set(symbols.labels),
    packageNames: new Set<string>(),
    commands: Object.entries(macros).map(([name, definition]) => ({
      caption: name,
      snippet: definition,
      meta: 'macro',
      score: 0,
    })),
    referenceKeys: new Set(symbols.citationKeys),
    searchLocalReferences: async (query: string) => ({
      keys: symbols.citationKeys.filter(key =>
        key.toLowerCase().includes(query.toLowerCase())
      ),
    }),
    fileTreeData: projectFilesToMetadataFolder(files),
  }
}

/** Path of the folder containing `filePath`, relative to the project root. */
export const relativeDocFolder = (
  scope: EukoliaEditorScope
): string | null => {
  const filePath = scope.getFilePath()
  const root = scope.getProjectRoot()
  if (!filePath) return null
  const normalized = filePath.replace(/\\/g, '/')
  const relative =
    root && normalized.startsWith(root.replace(/\\/g, '/'))
      ? normalized.slice(root.replace(/\\/g, '/').length + 1)
      : normalized
  const index = relative.lastIndexOf('/')
  return index < 0 ? '' : relative.slice(0, index)
}

/**
 * Resolves an image reference from the document to something the graphics
 * widget can load, which is what `previewByPathFacet` expects.
 */
export const scopePreviewByPath = (
  scope: EukoliaEditorScope
): PreviewByPath => path => {
  const metadata = scope.getImageMetadata(path)
  if (!metadata) return null
  return { url: metadata.url, extension: metadata.extension }
}

/**
 * The ported Overleaf theme takes a `FontFamily` name and maps it to a stack.
 * Eukolia's `editor.fontFamily` is already a stack, so the value is matched
 * against the families the ported mapping knows; anything else is passed
 * through as a CSS stack of its own, which is what the theme puts in
 * `--source-font-family` (consumed by `.cm-lineNumbers` and the source islands).
 *
 * The first family in the stack decides it: two stacks that name the same first
 * face render the same, and the ported table's fallbacks are Overleaf's, not
 * Eukolia's.
 */
export const sourceFontFamily = (settingValue: string): string => {
  const first =
    settingValue
      .split(',')[0]
      ?.trim()
      .replace(/^['"]|['"]$/g, '')
      .toLowerCase() ?? ''
  if (first === 'jetbrains mono') return 'jetbrains-mono'
  if (first === 'consolas') return 'consolas'
  if (first === 'courier new') return 'courier'
  if (first === 'fira code' || first === 'fira mono') return 'fira'
  if (first === 'source code pro') return 'source-code-pro'
  if (first === 'literata') return 'literata'
  if (first === 'noto serif') return 'noto-serif'
  if (first === 'monaco' || first === 'menlo' || first === 'ubuntu mono') {
    return 'monaco'
  }
  if (first === 'system-ui') return 'system-ui'
  return settingValue
}

/**
 * The full Eukolia Visual Mode extension set.
 *
 * Mirrors Overleaf's `createExtensions`, restricted to the extensions Eukolia
 * ports and with every Overleaf-app-specific input replaced by the scope.
 */
export const eukoliaEditorExtensions = (
  options: VisualModeOptions
): Extension[] => {
  const { scope, fileName, theme: themeName, startVisual = true } = options
  const showVisual = startVisual && isVisualModeFile(fileName)
  /** Whether Eukolia claims this document as a LaTeX source (see below). */
  const isLaTeXSource = isVisualModeFile(fileName)
  /**
   * What this document may ask of the machine.
   *
   * A caller that has already decided (the editor, which knows the document) passes
   * it in; a caller that has not gets full features, because guessing "large" from
   * nothing would silently disable Visual Mode for every host that does not pass one.
   */
  const largeFile = options.largeFile ?? FULL_FEATURES

  // The ported theme extension reads the active theme from this store.
  setActiveOverallTheme(themeName)

  // Settings both surfaces read. The caller passes them in so the editor is
  // rebuilt when they change (the lifecycle effect depends on them); the
  // defaults are here so a host that omits one still matches Code Mode rather
  // than falling back to a hard-coded value.
  const fontSize = options.fontSize ?? setting.num('editor.fontSize')
  const fontFamily = options.fontFamily ?? setting.str('editor.fontFamily')
  const cursorBlinking =
    options.cursorBlinking ?? setting.str('editor.cursorBlinking')
  const smoothCaret = options.smoothCaret ?? setting.bool('editor.smoothCaret')

  // The rest of the `editor.*` settings the retired Monaco Code Mode used to
  // hand Monaco. They are read here, at build time, because most of them decide
  // whether an extension is mounted at all; the host
  // (`VisualEditor.tsx`) rebuilds the editor when one of them changes, and the
  // caret and scroll are carried across the rebuild by the mode snapshot, which
  // is how a settings change reaches CodeMirror.
  const showLineNumbers = setting.str('editor.lineNumbers') !== 'off'
  const folding = setting.bool('editor.folding')
  const wordWrap = setting.bool('editor.wordWrap')
  const autoIndent = setting.bool('editor.autoIndent')
  const indentGuidesEnabled = setting.bool('editor.renderIndentGuides')
  const smartDelimiters = setting.bool('editor.smartDelimiters')
  const matchBrackets = setting.bool('editor.matchBrackets')
  const multiCursorModifier =
    setting.str('editor.multiCursorModifier') === 'ctrlCmd' ? 'ctrlCmd' : 'alt'
  const tabSize = Math.max(
    1,
    Math.min(16, Math.round(setting.num('editor.tabSize')) || 1)
  )
  // `indentUnit` must be a run of one whitespace character; `insertSpaces` off
  // means a tab is what Tab and the auto-indenter insert.
  const indentUnitSetting = setting.bool('editor.insertSpaces')
    ? ' '.repeat(tabSize)
    : '\t'

  /**
   * `editor.multiCursorModifier`: the modifier that adds a second cursor and
   * starts a rectangular selection. Monaco's two values, `alt` and `ctrlCmd`,
   * are the two CodeMirror's own `rectangularSelection`/`crosshairCursor` accept
   * — CodeMirror's default for adding a cursor by click is the *platform*
   * modifier (Ctrl on Windows and Linux, Cmd on macOS), so without this the
   * setting would be ignored in both directions.
   */
  const addsSelectionRange = (event: MouseEvent): boolean =>
    multiCursorModifier === 'ctrlCmd'
      ? event.ctrlKey || event.metaKey
      : event.altKey

  return [
    // ---------------------------------------------------------- core editing
    //
    // The index bar (the line-number gutter) is the **same bar in both modes**.
    // There is one editor, so `editor.lineNumbers` and `editor.folding` mount one
    // gutter set that Code Mode and Visual Mode share.
    // Diagnostic errors and warnings highlight line numbers directly instead of
    // taking up a separate gutter column, keeping the line index bar narrow.
    diagnosticGutter,
    ...(showLineNumbers ? [lineNumbers(visualLineNumberFormatter())] : []),
    ...(folding
      ? [foldGutter({ openText: '\u25be', closedText: '\u25b8' })]
      : []),
    highlightActiveLineGutter(),
    EditorView.contentAttributes.of({ 'aria-label': 'Source Editor editing' }),
    // Which of the two surfaces the one editor is showing, for the application
    // stylesheet. Every mode-dependent extension here is mounted through a
    // compartment, so the attribute flips with `setVisualMode` on the live view
    // and needs no React state; `visual-editor.css` is the only place that reads
    // it, to give each mode its own background, text colour and body font.
    visualOnly(showVisual, EditorView.editorAttributes.of({ 'data-mode': 'visual' })),
    sourceOnly(showVisual, EditorView.editorAttributes.of({ 'data-mode': 'source' })),
    highlightSpecialChars(showVisual),
    history({ newGroupDelay: 250 }),
    drawSelection(),
    nonBlinkingCursor(),
    // Caret motion, from the same two settings Code Mode hands Monaco.
    caretAppearance({ cursorBlinking, smoothCaret }),
    ...(isLaTeXSource
      ? [
          // Which editing context the caret is in. Mathematics is *not* a mode of the
          // editor — it is a property of where the caret is — so this is mounted in
          // both mode compartments and reports itself through `data-caret-math`, which
          // gives mathematics its own caret colour, and through `eu-cm-math-source`,
          // which sets the revealed source in the same type as every other piece of
          // code the editor shows.
          mathCaretAttribute(),
          // Where a click on a line the editor has hidden puts the caret. Mounted in
          // the visual compartment, because the hidden lines it answers for exist only
          // there, and registered ahead of the ported visual extensions so it answers
          // the click before CodeMirror resolves it by half and the port's caret escape
          // strands it on the next line; see the module for the measurements.
          visualOnly(showVisual, clickOnHiddenLine),
          // The project's macro definitions, which the mathematics on screen is
          // typeset with. Mounted in its own compartment so the host can hand over the
          // table when the project index has it, without rebuilding the editor.
          projectMacrosExtension(),
          mathSourceDecorations,
        ]
      : []),
    EditorState.allowMultipleSelections.of(true),
    ...(wordWrap ? [EditorView.lineWrapping] : []),
    // `editor.renderWhitespace`: in Visual Mode the source whitespace is not on
    // screen — the ported decorations render the document — so the extension
    // belongs to the source mode. `sourceOnly` mounts it in a compartment that
    // `setVisualMode` reconfigures on the live view, which is what lets the mode
    // change without rebuilding the editor; the flag passed here is the mode the
    // editor starts in, nothing more. Every other mode-dependent extension in
    // this set is already wrapped that way inside its own module
    // (`highlightSpecialChars`, `lineWrappingIndentation`, `highlightActiveLine`,
    // `inlineBackground`) or by the ported `visual()` itself.
    sourceOnly(
      showVisual,
      whitespaceRendering(
        normalizeWhitespaceRendering(setting.str('editor.renderWhitespace'))
      )
    ),
    ...(autoIndent ? [indentOnInput()] : []),
    ...(matchBrackets ? [cmBracketMatching()] : []),
    // Indentation guides: one hairline per indentation level, drawn from the
    // theme's `editorIndentGuide.*` tokens. `editor.renderIndentGuides` is
    // Monaco's own name for the setting; CodeMirror has no extension that draws
    // them, so the guides are Eukolia's (`indentGuides.ts`). They are mounted in
    // both modes — an indented LaTeX environment is indented whichever surface is
    // showing — and, like every other `editor.*` setting, this one decides at
    // build time whether the extension is mounted at all.
    ...(indentGuidesEnabled ? [indentGuides()] : []),
    // Instructions.md §14: alignment on demand, on save, and while typing. The
    // plugin is always mounted and reads both `formatting.alignWhileTyping`
    ...(isLaTeXSource ? [alignWhileTyping()] : []),
    // Double-clicking a bracket still selects to its partner; only the
    // highlighting of the pair follows `editor.matchBrackets`.
    bracketSelection(),
    rectangularSelection({ eventFilter: addsSelectionRange }),
    crosshairCursor({
      key: multiCursorModifier === 'ctrlCmd' ? 'Control' : 'Alt',
    }),
    EditorView.clickAddsSelectionRange.of(addsSelectionRange),
    dropCursor(),
    tooltips({
      parent: typeof document === 'undefined' ? undefined : document.body,
      tooltipSpace(view) {
        const { top, bottom } = view.scrollDOM.getBoundingClientRect()
        return {
          top,
          left: 0,
          bottom,
          right: typeof window === 'undefined' ? 0 : window.innerWidth,
        }
      },
    }),
    lineWrappingIndentation(showVisual),
    highlightActiveLine(showVisual),
    inlineBackground(showVisual),
    emptyLineFiller(),
    verticalOverflow(),
    effectListeners(),
    goToLinePanel(),
    filterCharacters(),

    // ------------------------------------------------------------ the project
    docName(fileName ?? 'untitled.tex'),
    docFolder(relativeDocFolder(scope)),
    filePreview(scopePreviewByPath(scope)),
    phrases(scope.getPhrases()),

    // ------------------------------------------------------------- language
    //
    // Overleaf's `annotations()` is deliberately **not** mounted. It is inert —
    // nothing in Eukolia ever calls its `setAnnotations`, so its compile-log
    // linter can only ever produce an empty list — but `@codemirror/lint`
    // combines `markerFilter` / `tooltipFilter` / `delay` / `needsRefresh`
    // across *every* linter, and its config keeps errors only while suppressing
    // tooltips entirely. Mounting it beside the diagnostics below would hide
    // every warning and every diagnostic tooltip, from both sources.
    //
    // Indentation is the shared editor setting (`editor.tabSize` and
    // `editor.insertSpaces`), so it has to be mounted *before* the ported
    // `language()` extension: `indentUnit` is a first-value-wins facet, and
    // `language()` installs its own four-space unit for LaTeX.
    indentUnit.of(indentUnitSetting),
    EditorState.tabSize.of(tabSize),
    language(fileName ?? 'untitled.tex', buildScopeMetadata(scope), {
      syntaxValidation: false,
    }),
    syntaxHighlightingFor(fileName),
    theme({
      fontSize,
      fontFamily: sourceFontFamily(fontFamily),
      lineHeight: 'normal',
      activeOverallTheme: themeName,
    }),

    // ---------------------------------------------------------------- input
    autoComplete({ enabled: true }),
    autoPair({ autoPairDelimiters: smartDelimiters }),
    editable(),
    search(null),
    highlightSelectionMatches(),
    shortcuts,
    symbolPalette(),
    keymaps,
    contextMenu(),

    // ----------------------------------------------------- LaTeX intelligence
    //
    // Everything below is LaTeX intelligence, so it is mounted for the files
    // Eukolia claims as LaTeX sources — `.tex`, `.ltx`, `.sty`, `.cls` and
    // untitled buffers, the same set Visual Mode claims. Monaco registered its
    // providers against the `latex` language id, so a `.bib` or a plain-text
    // buffer never offered them.
    ...(isLaTeXSource
      ? [
          // Eukolia's own completion sources, added *alongside* whatever the
          // language offers rather than replacing it: `autoComplete` above mounts
          // CodeMirror's `autocompletion` with no `override`, so every source
          // registered in the `languageData` facet is used, and registering these
          // as language data is the way to join them. The snippet source is what
          // makes `expand: "manual"` — the format's default — reachable at all.
          EditorState.languageData.of(() => [
            { autocomplete: latexCompletionSource },
            { autocomplete: snippetCompletionSource },
          ]),
          latexHover(),
          // Go to definition (`F12`, `Mod`-click), Find All References
          // (`Shift+F12`) and clickable `\input{...}` / URL links. The host is
          // the application's: the editor resolves, the shell opens files and
          // shows results. Without one, none of it is mounted — a key binding
          // that resolves to nothing would be worse than no key binding.
          ...(options.navigation ? [latexNavigation(options.navigation)] : []),
        ]
      : []),

    // ----------------------------------------------------------- diagnostics
    //
    // Two independent sources, deliberately: `cmDiagnostics.ts` holds the
    // compiler's errors and the ported linter's warnings in separate state
    // fields, so a lint pass cannot wipe the compiler's errors and a build
    // cannot wipe the linter's warnings. `file` scopes the compiler's
    // diagnostics to the document on screen — the application holds the whole
    // project's.
    compilerDiagnostics({ file: fileName }),
    // The linter stringifies the whole document and hands it to a worker every
    // `latex.diagnostics.delayMs`. On a large document that copy is the thing the
    // user feels, and VS Code stops diagnostics for a large file for the same
    // reason — see `largeDocument.ts`.
    ...(isLaTeXSource && largeFile.lint ? [latexLint()] : []),

    // ------------------------------------------------------------- visual mode
    visual(fileName ?? 'untitled.tex', showVisual, {
      atomicDecorations: largeFile.decorations,
      // The same decision the mount pass makes in `VisualEditor.tsx`: a document
      // this large is not parsed to its end before it is shown, because that parse
      // is seconds of blocked renderer thread for decorations that are off anyway.
      eagerParse: largeFile.eagerParse
    }),
    visualOnly(showVisual, environmentBracket()),
    ...(isLaTeXSource ? [mathPreview(true)] : []),

    // HyperSnips, the same engine Code Mode drives: automatic expansion while
    // typing and Tab/Shift+Tab through the tab stops of an active expansion.
    // Mounted for the documents snippets are written for — LaTeX and Markdown
    // (`supportsSnippets`), which is deliberately *not* the same question as
    // `isLaTeXSource` above: Markdown carries mathematics and prose about LaTeX
    // and gets snippets, while it gets none of the LaTeX intelligence. Every
    // other document (JSON, JS, Python …) gets standard Tab indentation instead,
    // and no snippet can fire in it — `clearSnippetExpansions` is what ends an
    // expansion left over from the file before it.
    ...(supportsSnippets(fileName)
      ? [snippetExtensions(), keymap.of([indentWithTab])]
      : [clearSnippetExpansions(), keymap.of([indentWithTab])]),

    // ---------------------------------------------------------------- toolbar
    //
    // The formatting toolbar Overleaf mounts above the editor. It is a
    // CodeMirror panel; `VisualEditor.tsx` portals the React chrome into it.
    toolbarPanel(),

    EditorView.updateListener.of(update => {
      if (update.docChanged) options.onDocChanged?.()
    }),
  ]
}
