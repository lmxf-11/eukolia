/**
 * Eukolia Visual Mode host.
 *
 * This component mounts a CodeMirror 6 `EditorView` running the **Visual
 * Editor** extension set and connects it to the Eukolia application:
 *
 *  * the document comes from `getText()` and every edit is reported back as a
 *    minimal range replacement through `applyChange()` (Instructions.md §17,
 *    §27), so neither editor owns a private copy of the source;
 *  * everything that is not the document text — the project file list, image
 *    previews, macros, phrases, symbols — comes from the `EukoliaEditorScope`,
 *    never from a global and never from the filesystem (Instructions.md §29);
 *  * the logical cursor, selection and scroll position survive a switch to and
 *    from Code Mode through `mode.ts` (Instructions.md §28, §37).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  EditorState,
  Transaction,
  type Extension,
  type Text,
} from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { forceParsing, syntaxTree } from '@codemirror/language'
import { ANALYSIS_SETTLE_MS } from '../document/documentModel'
import { largeDocumentNotice, largeDocumentProfile, lineCount } from './largeDocument'

import {
  eukoliaEditorExtensions,
  isVisual,
  isVisualModeFile,
  setVisualMode,
  sourceFontFamily,
} from './editorExtensions'
import { setOptionsTheme } from '@/vendor/overleaf/extensions/theme'
import { setActiveOverallTheme } from '@/vendor/overleaf/eukolia/theme-hooks'
import { setEditable } from '@/vendor/overleaf/extensions/editable'
import { renderCacheStats } from '@/vendor/overleaf/extensions/visual/visual-widgets/math-render-cache'
import type { EditorHandle } from '../editor/editorHandle'
import { setCompilerDiagnostics } from '../editor/cmDiagnostics'
import type { LatexNavigationHost } from '../editor/cmNavigation'
import { formattingEngine } from '../aligner/texAligner'
import {
  restoreOffsetFor,
  revealCaretIfOffscreen,
  scrollLineToTop,
  topVisibleLine,
} from './scrollRestore'
import { switchEditorMode } from './modeSwitch'
import { viewportStability } from './viewportStability'
import type { DiagnosticItem } from '../compiler/logParser'
import {
  computeMinimalDelta,
  createSnapshot,
  modeSwitchKey,
  modeSwitchStore,
  type LineColumn,
  type ModeSwitchSnapshot,
} from './mode'
import {
  createEditorScope,
  EUKOLIA_EDITOR_PHRASES,
  setEditorScope,
  type EukoliaEditorScope,
} from './scope'
import { projectIndex } from '../document/projectIndex'
import {
  getProjectMacros,
  projectMacroUpdate,
  setProjectMacros,
  type MacroTable,
} from '../editor/projectMacros'
import { buildFigureIndex, renderPdfFigurePage } from '../services/figurePreview'
import { setting, settingsManager } from '../core/settings'
import { FigureOptionsDialog } from './FigureOptionsDialog'
// Styling for the visual editor widget classes.
import './visual-editor.css'

export interface VisualEditorProps {
  getText(): string
  /** Minimal, source-preserving edit (Instructions.md §27). */
  applyChange(change: { from: number; to: number; insert: string }): void
  onChange?(text: string): void
  /**
   * Reported when the editor's own focus state changes: `true` as it gains
   * focus, `false` as it loses it.
   *
   * `files.autoSave`'s `onFocusChange` mode is what listens, and CodeMirror is
   * asked rather than the DOM: a view knows when it holds focus (it tracks
   * `document.activeElement` and the window's own focus), so "the editor lost
   * focus" is answered the same way whether focus moved to the file tree, to
   * another application, or to nothing at all.
   */
  onFocusChange?(focused: boolean): void
  /**
   * Reported when a document opens with fewer capabilities than usual, so the reader
   * is told which and why.
   *
   * VS Code's rule: a degradation that is not named reads as a bug. This is where
   * the sentence goes — the application shows it on the status bar.
   */
  onNotice?(message: string): void
  filePath: string | null
  /**
   * Project/document context. Optional so the component can also be mounted
   * with nothing but a buffer; when omitted, a scope is derived from the other
   * props and `projectIndex`.
   */
  scope?: EukoliaEditorScope
  theme: 'light' | 'dark'
  onSelectionChange?(selection: {
    from: number
    to: number
    anchor: number
    head: number
    /** 1-based line of the caret, for the status bar's position index. */
    line: number
    /** 1-based column of the caret, for the status bar's position index. */
    column: number
  }): void
  onScroll?(top: number): void
  /**
   * Start in Visual Mode (default) or with the visual extensions disabled.
   *
   * This is the *only* thing that distinguishes Code Mode from Visual Mode:
   * both are this one editor, and the mode is a property of its state rather
   * than of the component that hosts it.
   */
  startVisual?: boolean
  /** Font size in CSS pixels for the ported editor theme. */
  fontSize?: number
  /**
   * The compiler's diagnostics for the whole project, as the application holds
   * them. Only the entries naming the open document are drawn, so this can be
   * passed straight through on every render.
   */
  diagnostics?: readonly DiagnosticItem[]
  /**
   * What LaTeX navigation cannot do for itself: open a project file and show a
   * label's occurrences. Omitted, go-to-definition and Find All References are
   * not mounted.
   */
  navigation?: LatexNavigationHost
  /**
   * Published with the imperative handle the application drives this editor
   * through (`src/renderer/editor/editorHandle.ts`). There is one editor, so the
   * same handle is published in both modes.
   */
  handleRef?: React.MutableRefObject<EditorHandle | null>
  className?: string
  style?: React.CSSProperties
}

const EXTERNAL_SYNC_INTERVAL_MS = 400

/**
 * The host's text with CRLF line endings folded to LF.
 *
 * The fold is what makes the editor's view of the document identical to the
 * host's, and it has to stay — but the *scan* is not free, and this runs on every
 * render of this component (the sync effect below has no dependency list) plus
 * twice a second on the poll behind it. `String.replace` with a global pattern
 * walks the whole string through the regex engine to find nothing, on a document
 * that is already normalised: `DocumentModel` folds CRLF on every path into it
 * (`setText`, `replaceRange`, `markSaved`, `reload`), so the guard is the honest
 * statement of what the call is for — and `indexOf` for a single character is a
 * scan the engine can vectorise, with no match state and no allocation.
 */
const normalizeLineEndings = (text: string): string =>
  text.indexOf('\r') === -1 ? text : text.replace(/\r\n/g, '\n')

/**
 * Hands a project macro table to the editor, which is what makes the
 * mathematics on screen re-typeset with it.
 *
 * The dispatch is the point: it carries the new macros into the editor state,
 * and the decorations that own the mathematics rebuild on it — see
 * `editor/projectMacros.ts`. A destroyed view would make the dispatch throw, so
 * the caller checks that this editor is still the mounted one.
 */
function pushProjectMacros(view: EditorView, table: MacroTable): void {
  view.dispatch(projectMacroUpdate(table))
}

/** Builds a scope from the props alone, for hosts that do not pass one. */
const deriveScope = (props: {
  getText(): string
  applyChange(change: { from: number; to: number; insert: string }): void
  filePath: string | null
}): EukoliaEditorScope => {
  const projectRoot = projectIndex.getProjectRoot()
  const files = projectIndex.getFiles()
  const normalizedRoot = projectRoot
    ? projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    : null

  return createEditorScope({
    id: `derived:${props.filePath ?? 'untitled'}`,
    filePath: props.filePath,
    text: props.getText(),
    projectRoot,
    files: files.map(file => ({ path: file.path, isDirectory: file.isDirectory })),
    // `\includegraphics` resolution: the graphics widget asks for
    // an image by the path exactly as written in the source, so the index carries
    // every spelling (relative, `./`-prefixed, bare basename and absolute).
    images: buildFigureIndex(
      files.map(file => ({
        path: file.path,
        relativePath:
          normalizedRoot && file.path.replace(/\\/g, '/').startsWith(`${normalizedRoot}/`)
            ? file.path.replace(/\\/g, '/').slice(normalizedRoot.length + 1)
            : file.path,
        isDirectory: file.isDirectory,
      }))
    ),
    // Rasterised by Eukolia's native PDF engine.
    renderPdfFigurePage,
    macroTable: projectIndex.getMacroTable(),
    symbols: {
      labels: projectIndex.getLabels().map(label => label.name),
      citationKeys: [
        ...projectIndex.getBibEntries().map(entry => entry.key),
        ...projectIndex.getCitedKeys(),
      ],
      environments: projectIndex.getEnvironmentNames(),
    },
    phrases: EUKOLIA_EDITOR_PHRASES,
  })
}

/** The 1-based line/column of an offset, the way the status bar reports one. */
const lineColumnAt = (view: EditorView, offset: number): LineColumn => {
  const line = view.state.doc.lineAt(offset)
  return { line: line.number, column: offset - line.from + 1 }
}

/* ------------------------------------------------------------------ *
 * The imperative handle
 *
 * Every entry point below answers in the terms the application speaks
 * (`src/renderer/editor/editorHandle.ts`): raw character offsets, 1-based
 * lines and columns, a pixel scroll offset. Out-of-range input is clamped
 * rather than rejected — a handle call can arrive from a stale position after
 * an edit, and it must land somewhere sensible instead of throwing.
 * ------------------------------------------------------------------ */

/** A 1-based line number clamped into the document. */
const clampLine = (doc: Text, line: number): number =>
  Math.max(1, Math.min(Math.floor(line) || 1, doc.lines))

/** A character offset clamped into the document. */
const clampOffset = (doc: Text, offset: number): number =>
  Math.max(0, Math.min(Math.floor(offset) || 0, doc.length))

/**
 * Puts the caret at `offset`, centres it and focuses the editor — the
 * CodeMirror equivalent of Monaco's `setPosition` + `revealPositionInCenter`
 * + `focus`, which is what the handle has always promised.
 */
const revealInCenter = (view: EditorView, offset: number): void => {
  view.dispatch({
    selection: { anchor: offset },
    effects: EditorView.scrollIntoView(offset, { y: 'center' }),
  })
  view.focus()
}

/**
 * Captures a mode-switch snapshot from a live editor: the caret and selection
 * as 1-based line/column, and the top visible line. `createSnapshot` turns that
 * into the editor-independent snapshot (deriving the matching offsets), so both
 * editors produce exactly the same shape.
 */
export function captureSnapshot(view: EditorView): ModeSwitchSnapshot {
  const range = view.state.selection.main
  const scroller = view.scrollDOM
  const height = scroller.clientHeight
  let caretVisible = false
  let caretViewportFraction = 0.5
  if (height > 0) {
    const head = range.head
    const caretBlock = view.lineBlockAt(head)
    const top = scroller.scrollTop
    caretVisible = caretBlock.top >= top - 2 && caretBlock.bottom <= top + height + 2
    if (caretVisible) {
      caretViewportFraction = Math.max(0, Math.min(1, (caretBlock.top - top) / height))
    }
  }
  return createSnapshot(view.state.doc.toString(), {
    anchor: lineColumnAt(view, range.anchor),
    head: lineColumnAt(view, range.head),
    topLine: topVisibleLine(view),
    scrollTop: scroller.scrollTop,
    caretVisible,
    caretViewportFraction,
  })
}

/** Reads the current text without needing a React reference to the editor. */
export const getVisualEditorText = (view: EditorView): string =>
  view.state.doc.toString()

/**
 * The navigation host, read through the props ref at gesture time.
 *
 * The application passes a fresh host object on every render while the editor is
 * built once per document and mode, so capturing the object would freeze the
 * callbacks of whichever render happened to build the editor — and a definition
 * jump running against a stale closure is exactly what this cannot afford. The
 * object is only built when a host was passed at all, so an editor with no host
 * does not bind `F12` to something that resolves to nothing.
 */
const navigationHost = (
  propsRef: React.MutableRefObject<VisualEditorProps>
): LatexNavigationHost | undefined =>
  propsRef.current.navigation
    ? {
        openFile: (path, line, column) =>
          propsRef.current.navigation?.openFile(path, line, column),
        showReferences: (label, occurrences) =>
          propsRef.current.navigation?.showReferences(label, occurrences),
      }
    : undefined

export const VisualEditor: React.FC<VisualEditorProps> = React.memo(props => {
  const {
    getText,
    applyChange,
    filePath,
    scope: scopeProp,
    theme,
    startVisual = true,
    // Font size is the *same setting* Code Mode reads (`editor.fontSize`), so a
    // document looks the same size whichever surface is showing it. The prop
    // stays for a host that wants to override it.
    fontSize = setting.num('editor.fontSize'),
    handleRef,
    className,
    style,
  } = props

  // The rest of the shared editor settings are read here rather than inside the
  // extension set, because they are part of the effect's dependencies: changing
  // one rebuilds the editor, and the snapshot captured on unmount carries the
  // caret and scroll across the rebuild.
  const fontFamily = setting.str('editor.fontFamily')
  const cursorBlinking = setting.str('editor.cursorBlinking')
  const smoothCaret = setting.bool('editor.smoothCaret')

  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  /** Whether the editor held focus when the previous view was destroyed. */
  const hadFocusRef = useRef(false)
  /**
   * The focus state CodeMirror last announced, for the unmount report below.
   *
   * Kept rather than re-read: at that point the DOM is already detached, and a
   * rebuild — which also destroys a focused view — must not look like a loss.
   */
  const focusedRef = useRef(false)

  // Latest props, read from CodeMirror callbacks that must not be re-created.
  const propsRef = useRef(props)
  propsRef.current = props

  const applyingExternalChange = useRef(false)
  /**
   * The document text the host is known to hold, as last reported by this
   * editor. `syncFromHost` compares the host against *this* rather than against
   * the live editor text, so an edit still in flight is never undone.
   */
  const reportedTextRef = useRef<string | null>(null)
  const [figureDialogOpen, setFigureDialogOpen] = useState(false)
  /**
   * Bumped when one of the editor settings this surface reads changes, so the
   * editor is rebuilt from the new values. The host does not necessarily
   * re-render on a settings change (`editorPane` is memoised on the document and
   * app state), so the subscription is what keeps the editor in step with the
   * settings view.
   *
   * The set below is exactly `editor.*`: the ported extension set decides what
   * to mount from those at build time (see `editorExtensions.ts`), so a change
   * has to rebuild rather than be applied to a live editor. Nothing outside
   * `editor.*` shapes this surface — the Visual Editor settings
   * (`visual.fontSize`, `visual.lineWidth`, …) reach it through the ported
   * extensions' own subscriptions.
   */
  const [settingsVersion, setSettingsVersion] = useState(0)

  useEffect(() => {
    const editorSettings = new Set([
      'editor.fontSize',
      'editor.fontFamily',
      'editor.cursorBlinking',
      'editor.smoothCaret',
      'editor.lineNumbers',
      'editor.folding',
      'editor.wordWrap',
      'editor.renderWhitespace',
      'editor.renderIndentGuides',
      'editor.autoIndent',
      'editor.smartDelimiters',
      'editor.autoCloseSquareBrackets',
      'editor.autoCloseCurlyBraces',
      'editor.autoCloseParentheses',
      'editor.autoCloseDollarSigns',
      'editor.autoCloseQuotes',
      'editor.matchBrackets',
      'editor.multiCursorModifier',
      'editor.tabSize',
      'editor.insertSpaces',
      // Which capabilities a document is given is decided when the view is built,
      // so turning this on or off has to rebuild it — the same "reopen the file for
      // this to take effect" VS Code asks for, carried out immediately instead of by
      // hand. See `largeDocument.ts`.
      'editor.largeFileOptimizations',
    ])
    const readEditorSettings = () => {
      const values: Record<string, unknown> = {}
      for (const k of editorSettings) {
        values[k] = setting.str ? setting.str(k) : settingsManager.getValue(k)
      }
      return values
    }
    let lastValues = readEditorSettings()

    return settingsManager.on('change', payload => {
      const key = (payload as { key?: string; section?: string } | undefined)?.key
      const section = (payload as { key?: string; section?: string } | undefined)?.section
      if (key !== undefined && !editorSettings.has(key)) return
      if (section !== undefined && section !== 'editor') return

      const currentValues = readEditorSettings()
      let changed = false
      for (const k of editorSettings) {
        if (currentValues[k] !== lastValues[k]) {
          changed = true
          break
        }
      }
      if (!changed) return
      lastValues = currentValues
      setSettingsVersion(version => version + 1)
    })
  }, [])

  const scope = useMemo(
    () => scopeProp ?? deriveScope({ getText, applyChange, filePath }),
    // The derived scope is only rebuilt when the document identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeProp, filePath]
  )

  // ------------------------------------------------------------------ helpers

  const emitSelection = useCallback((view: EditorView) => {
    const range = view.state.selection.main
    // CodeMirror knows the line structure exactly, so the position index is
    // computed here rather than re-derived from the text by the host. This is
    // what makes the status bar read the same in Visual Mode as in Code Mode.
    const line = view.state.doc.lineAt(range.head)
    propsRef.current.onSelectionChange?.({
      from: range.from,
      to: range.to,
      anchor: range.anchor,
      head: range.head,
      line: line.number,
      column: range.head - line.from + 1,
    })
  }, [])

  const emitScroll = useCallback((view: EditorView) => {
    // The host callback is read *before* the position is worked out, and that
    // ordering is the whole point rather than a style: `topVisibleLine` measures
    // the scroller (`getBoundingClientRect`) and searches the height map, so
    // computing it for a host that never asked costs a forced layout on every
    // scroll event — which, with the shell's wheel handling animating the offset
    // frame by frame, is a forced layout per frame of every gesture. No host
    // currently passes `onScroll`; the guard is what keeps that from mattering.
    const onScroll = propsRef.current.onScroll
    if (!onScroll) return
    // The offset of the *first character of the top visible line*, so the host
    // sees the same line-based scroll position the hand-off carries.
    onScroll(view.state.doc.line(topVisibleLine(view)).from)
  }, [])

  // --------------------------------------------------------------- handle API
  //
  // The application drives the editor through this object rather than through
  // React (`AppState.editorHandleRef`): the breadcrumbs, SyncTeX, the command
  // registry and the VS Code host bridge all resolve positions through it. Every
  // method reads `viewRef.current` at call time, so the handle stays valid across
  // an editor rebuild — a settings change, a mode switch or a document switch
  // replaces the view without the application being told.
  const handle = useMemo<EditorHandle<EditorView>>(
    () => ({
      getEditor: () => viewRef.current,
      revealPosition(line, column = 1) {
        const view = viewRef.current
        if (!view) return
        const target = view.state.doc.line(clampLine(view.state.doc, line))
        const offset = Math.min(
          target.from + Math.max(1, Math.floor(column) || 1) - 1,
          target.to
        )
        revealInCenter(view, offset)
      },
      revealOffset(offset) {
        const view = viewRef.current
        if (!view) return
        revealInCenter(view, clampOffset(view.state.doc, offset))
      },
      getSelectionOffsets() {
        const view = viewRef.current
        if (!view) return null
        const range = view.state.selection.main
        return {
          from: range.from,
          to: range.to,
          anchor: range.anchor,
          head: range.head,
        }
      },
      setSelectionOffsets(from, to) {
        const view = viewRef.current
        if (!view) return
        const doc = view.state.doc
        const head = clampOffset(doc, to)
        view.dispatch({
          selection: { anchor: clampOffset(doc, from), head },
          effects: EditorView.scrollIntoView(head, { y: 'center' }),
        })
      },
      getScrollTop: () => viewRef.current?.scrollDOM.scrollTop ?? 0,
      setScrollTop(value) {
        const view = viewRef.current
        if (view) view.scrollDOM.scrollTop = value
      },
      alignAmpersands(scope = 'document') {
        const view = viewRef.current
        if (!view) return
        const state = view.state
        const selection = state.selection.main
        const useSelection = scope === 'selection' && !selection.empty
        const from = useSelection ? selection.from : 0
        const to = useSelection ? selection.to : state.doc.length
        const slice = state.sliceDoc(from, to)

        const edits = formattingEngine.aligner.computeEdits(slice, from)
        if (edits.length === 0) return

        view.dispatch({
          // CodeMirror requires changes in ascending order. The aligner emits
          // them in closing order, which for disjoint environments is ascending;
          // sorted here so the contract does not depend on that.
          changes: edits
            .map((edit) => ({
              from: edit.start,
              to: edit.end,
              insert: edit.newText,
            }))
            .sort((a, b) => a.from - b.from),
        })
      },
      insertText(text) {
        const view = viewRef.current
        if (!view) return
        const range = view.state.selection.main
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: text },
          // The caret follows the insertion, as it does after Monaco's
          // `executeEdits` with `forceMoveMarkers`.
          selection: { anchor: range.from + text.length },
        })
        view.focus()
      },
      wrapSelection(prefix, suffix = prefix, placeholder = '') {
        const view = viewRef.current
        if (!view) return
        const range = view.state.selection.main
        const selected = view.state.sliceDoc(range.from, range.to)
        const inner = selected || placeholder
        view.dispatch({
          changes: {
            from: range.from,
            to: range.to,
            insert: `${prefix}${inner}${suffix}`,
          },
          // With nothing selected the delimiters are inserted around the
          // placeholder and the placeholder is left selected, so the user can
          // type straight over it. With a selection the caret follows the
          // inserted pair, which is what the change itself maps it to.
          ...(selected
            ? {}
            : {
                selection: {
                  anchor: range.from + prefix.length,
                  head: range.from + prefix.length + inner.length,
                },
              }),
        })
        view.focus()
      },
      getCursorOffset() {
        const view = viewRef.current
        return view ? view.state.selection.main.head : null
      },
      focus() {
        viewRef.current?.focus()
      },
    }),
    []
  )

  useEffect(() => {
    if (handleRef) handleRef.current = handle
  }, [handle, handleRef])

  // ---------------------------------------------------------------- lifecycle

  /**
   * The surface going away while it held focus is a focus loss too.
   *
   * The lifecycle effect below reports focus through CodeMirror, which is right
   * for everything except one case: the whole component unmounting without a DOM
   * blur first — opening the settings pane from the keyboard, say, where focus
   * never left the editor before React took it away. This effect has no
   * dependencies, so its cleanup runs on a real unmount and *not* on a rebuild
   * (which hands the focus to the new view instead).
   *
   * It reports from the focus state CodeMirror last announced rather than asking
   * the view at cleanup time: by the time a passive effect is cleaned up React
   * has already detached the editor's DOM, so `hasFocus` would be false for a
   * rebuild and an unmount alike — and a rebuild must not be mistaken for a loss.
   */
  useEffect(
    () => () => {
      if (focusedRef.current) propsRef.current.onFocusChange?.(false)
    },
    []
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    setEditorScope(scope)

    const storeKey = modeSwitchKey(filePath)
    const initialText = getText().replace(/\r\n/g, '\n')
    const snapshot = modeSwitchStore.load(storeKey, initialText)
    // The document text the host is known to hold, written whenever this editor
    // reports an edit (see `syncFromHost`).
    reportedTextRef.current = initialText

    const changeReporter = EditorView.updateListener.of(
      (update: ViewUpdate) => {
        if (update.docChanged && !applyingExternalChange.current) {
          const nextText = update.state.doc.toString()

          let changeCount = 0
          let single: { from: number; to: number; insert: string } | null = null
          update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            changeCount += 1
            single = { from: fromA, to: toA, insert: inserted.toString() }
          })

          if (changeCount === 1 && single) {
            // Exactly the edit the user made, in source coordinates — this is
            // what keeps a rendered-character change a one-character delta.
            propsRef.current.applyChange(single)
          } else {
            // A multi-range transaction cannot be expressed as one minimal
            // delta; report the smallest single replacement that reproduces
            // the new text rather than regenerating the document.
            propsRef.current.applyChange(
              computeMinimalDelta(update.startState.doc.toString(), nextText)
            )
          }

          // Record what the host now holds. Without this the periodic host sync
          // below cannot tell "the host changed under us" from "we have not been
          // read back yet", and a snippet expansion reported in one transaction
          // could be overwritten by the pre-expansion text.
          reportedTextRef.current = nextText
          propsRef.current.onChange?.(nextText)
        }

        if (update.focusChanged) {
          // Reported for both directions: the host decides what a focus change
          // means (`files.autoSave`'s `onFocusChange` acts on the loss).
          focusedRef.current = update.view.hasFocus
          propsRef.current.onFocusChange?.(update.view.hasFocus)
        }

        if (update.docChanged || update.selectionSet) {
          emitSelection(update.view)
        }
      }
    )

    const scrollReporter = ViewPlugin.define(view => ({
      eventHandlers: {
        scroll() {
          emitScroll(view)
        },
      },
    }))

    /*
     * What this document is allowed to ask of the machine, decided once here and
     * not re-decided as it is edited.
     *
     * VS Code's rule is explicit — *"Make a decision in the ctor and permanently
     * respect this decision"* — and it is the right one for the same reason there:
     * a capability that switches on and off as a document crosses a line count would
     * make the editor's behaviour depend on how much has been typed, and Visual Mode
     * appearing or vanishing mid-sentence is worse than either answer. Editing a
     * document past the threshold therefore keeps the capabilities it opened with;
     * reopening it (or turning `editor.largeFileOptimizations` off) is what changes
     * them, which is exactly what VS Code tells the user to do.
     *
     * See `largeDocument.ts` for the thresholds and the measured curve behind them.
     */
    const profile = largeDocumentProfile(
      { length: initialText.length, lines: lineCount(initialText) },
      {
        enabled: setting.bool('editor.largeFileOptimizations'),
        analysisSettleMs: ANALYSIS_SETTLE_MS
      }
    )

    // Said once per document open, and only when something was actually switched
    // off: a notice that appears for every file is a notice nobody reads.
    const notice = largeDocumentNotice(profile)
    if (notice) propsRef.current.onNotice?.(notice)

    const extensions: Extension[] = [
      ...eukoliaEditorExtensions({
        scope,
        fileName: filePath,
        theme,
        fontSize,
        fontFamily,
        cursorBlinking,
        smoothCaret,
        startVisual: startVisual && isVisualModeFile(filePath),
        navigation: navigationHost(propsRef),
        largeFile: profile,
      }),
      viewportStability,
      changeReporter,
      scrollReporter,
    ]

    // Before the view exists, so the first description of the document already
    // knows the project's macros: a project keeps them in an `\input`ed file, and
    // mathematics using one must not be typeset with it undefined even once.
    setProjectMacros(projectIndex.getMacroTable())

    const state = EditorState.create({
      doc: initialText,
      extensions,
      selection: { anchor: snapshot.anchor, head: snapshot.head },
    })

    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    // Published for the end-to-end probe, which reads the live view to ask what
    // the top visible line is. Cleared on destroy (see the cleanup below) so a
    // probe can never be handed a destroyed view.
    ;(window as any).__cmView = view
    /*
     * The render cache's own counters, on the window, for the performance probe.
     *
     * `scripts/probe-visual.mjs` measures interactions from outside the renderer and
     * has no other way to ask "was this slow because MathJax ran, or because the
     * editor asked it to?". Reading it costs a function call, and nothing in the
     * application reads it.
     */
    ;(window as any).__eukoliaRenderStats = renderCacheStats

    // The project index gains macros after the editor is built — the included
    // files are read once the project has been scanned, and the user may edit the
    // macro file or open another chapter at any time. Each change is handed to
    // the editor, which typesets the mathematics on screen again with it.
    const stopMacroWatch = projectIndex.on('index-change', () => {
      if (viewRef.current !== view) return
      pushProjectMacros(view, projectIndex.getMacroTable())
    })

    // The editor is created read-only and released once the document is known
    // to be writable. Leaving it read-only would keep every decoration
    // permanently expanded (see `shouldDecorate`) as well as hiding the caret.
    view.dispatch(setEditable(true))

    // Publish the caret straight away. The status bar's position index is fed by
    // `onSelectionChange`, and a freshly mounted editor has not moved its
    // selection yet, so without this the index would keep whatever the previous
    // editor left behind.
    emitSelection(view)

    // Hand focus back if the editor is what had it before this rebuild (see the
    // cleanup below). `focus()` deliberately does not scroll, so this cannot
    // disturb the position the restore below is about to set.
    if (hadFocusRef.current) view.focus()

    // Eagerly force parsing synchronously so all atomic decorations exist immediately across the whole document.
    try {
      if (profile.eagerParse && syntaxTree(view.state).length < view.state.doc.length) {
        forceParsing(view, view.state.doc.length, 10000)
      }
    } catch {
      // ignore parse timeout or errors
    }

    // Restore the recorded position, by exact pixel scrollTop or line, for the
    // rebuilds that remain: a different document, the theme, or an `editor.*`
    // setting — the things that decide how the editor is constructed. A mode
    // switch does not come through here any more, because it no longer rebuilds
    // the view (see the mode effect below); the scroll, the selection and the
    // top line simply survive it.
    let userAdjusted = false
    const markUserAdjusted = () => {
      userAdjusted = true
    }
    for (const event of ['wheel', 'pointerdown', 'keydown'] as const) {
      view.scrollDOM.addEventListener(event, markUserAdjusted, { passive: true })
    }

    const restorePosition = () => {
      if (viewRef.current !== view || userAdjusted) return
      if (typeof snapshot.scrollTop === 'number' && snapshot.scrollTop > 0) {
        const maxScroll = Math.max(
          0,
          view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight
        )
        view.scrollDOM.scrollTop = Math.min(snapshot.scrollTop, maxScroll)
      } else {
        scrollLineToTop(view, restoreOffsetFor(view, snapshot))
      }
    }

    const scrollRestoreTimer = window.setTimeout(restorePosition, 0)

    const eagerParseTimer = window.setTimeout(() => {
      if (viewRef.current !== view) return
      /*
       * The same decision the mount pass above makes, and for the same reason.
       *
       * This timer exists to put the scroll position and the caret back once the
       * first pass has settled; forcing the parse here is the part that has to obey
       * `profile.eagerParse`, because it is the same synchronous full parse — it just
       * happens 50 ms later. Left ungated it defeated the flag entirely: measured on
       * a 47 886-line chapter, this call was a single **3.3 s** task on the renderer
       * thread, which is the freeze `EAGER_PARSE_LINES` documents and exists to
       * avoid. CodeMirror parses the viewport on demand either way, so what the user
       * sees is unaffected.
       */
      if (profile.eagerParse && syntaxTree(view.state).length < view.state.doc.length) {
        forceParsing(view, view.state.doc.length, 10000)
      }
      // Decorations exist now; the first pass may have landed against an
      // estimated line height, so put the line back. Then, if this rebuild also
      // changed the metrics under the caret — a font size, say — bring a caret
      // that is past an edge back on screen, with the smallest scroll that does.
      restorePosition()
      if (!userAdjusted && snapshot.caretVisible !== false) {
        revealCaretIfOffscreen(view)
      }
    }, 50)

    return () => {
      window.clearTimeout(eagerParseTimer)
      window.clearTimeout(scrollRestoreTimer)
      stopMacroWatch()
      for (const event of ['wheel', 'pointerdown', 'keydown'] as const) {
        view.scrollDOM.removeEventListener(event, markUserAdjusted)
      }
      // Focus follows the editor across a rebuild. Every editor key binding is a
      // DOM key map — the view has to hold focus for any of them to fire — so a
      // rebuild would otherwise leave the next keystroke going nowhere. Read
      // before the view is destroyed, and only restored when the editor is what
      // had focus: a rebuild caused by a settings change must not pull focus out
      // of the settings view. (A mode switch never lands here: it does not
      // rebuild, so there is no focus to carry.)
      hadFocusRef.current = host.contains(document.activeElement)
      const leaving = viewRef.current
      if (leaving) {
        modeSwitchStore.save(storeKey, captureSnapshot(leaving))
      }
      view.destroy()
      viewRef.current = null
      // A destroyed view is a trap for anything holding one — every method still
      // exists and some of them throw from deep inside CodeMirror. The probe
      // guards on `if (view)`, so it must see nothing rather than a corpse.
      if ((window as any).__cmView === view) (window as any).__cmView = null
      if (scopeProp) setEditorScope(null)
    }
    // Rebuilt when the document identity or an `editor.*` setting
    // changes — the things that decide how the editor is *constructed*. Theme,
    // font size, and mode are not among them: they are handled dynamically
    // through compartments without destroying the live view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scope,
    filePath,
    cursorBlinking,
    smoothCaret,
    settingsVersion,
  ])

  // ------------------------------------------------------------- theme & styles
  // Theme and typography styles update dynamically through the ported theme
  // compartment (`optionsThemeConf`) without rebuilding the editor view,
  // destroying the state, or causing twitching and jerking.
  const prevThemeRef = useRef(theme)
  const prevFontSizeRef = useRef(fontSize)
  const prevFontFamilyRef = useRef(fontFamily)

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (
      prevThemeRef.current === theme &&
      prevFontSizeRef.current === fontSize &&
      prevFontFamilyRef.current === fontFamily
    ) {
      return
    }
    prevThemeRef.current = theme
    prevFontSizeRef.current = fontSize
    prevFontFamilyRef.current = fontFamily
    const hadFocus = view.hasFocus
    setActiveOverallTheme(theme)
    view.dispatch(
      setOptionsTheme({
        fontSize,
        fontFamily: sourceFontFamily(fontFamily),
        lineHeight: 'normal',
        activeOverallTheme: theme,
      })
    )
    if (hadFocus && !view.hasFocus) {
      view.focus()
    }
    emitSelection(view)
  }, [theme, fontSize, fontFamily, emitSelection])

  // ------------------------------------------------ external document changes

  const syncFromHost = useCallback(() => {
    const view = viewRef.current
    if (!view) return
    const external = normalizeLineEndings(propsRef.current.getText())

    // Only a change the *host* made is adopted. Comparing against the editor
    // would also fire when this editor is mid-flight — a snippet expansion
    // dispatches its own transaction, and the host has not been read back yet —
    // and copying the host's older text in would undo the expansion.
    if (reportedTextRef.current === external) return

    const current = view.state.doc.toString()
    if (external === current) {
      reportedTextRef.current = external
      return
    }

    applyingExternalChange.current = true
    try {
      view.dispatch({
        changes: computeMinimalDelta(current, external),
        // The host document owns undo/redo (Instructions.md §28).
        annotations: Transaction.addToHistory.of(false),
      })
      reportedTextRef.current = external
    } finally {
      applyingExternalChange.current = false
    }
  }, [])

  // Runs after every render, covering host re-renders, plus a slow poll as a
  // safety net for edits the host makes without re-rendering this component.
  useEffect(() => {
    syncFromHost()
  })

  useEffect(() => {
    const timer = window.setInterval(syncFromHost, EXTERNAL_SYNC_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [syncFromHost])

  // ------------------------------------------------------------- diagnostics

  // The compiler's diagnostics are the application's: it holds the whole
  // project's list and pushes it here after every build. The editor draws only
  // the entries that name the open document (`compilerDiagnostics({ file })` in
  // the extension set does the scoping), and the linter's own diagnostics live in
  // a separate field, so this cannot clear them.
  //
  // No dependency list on purpose: the runtime is idempotent (an unchanged list
  // is not dispatched) and it has to run again after any render that rebuilt the
  // editor — a mode switch or a settings change replaces the state the
  // diagnostics were pushed into.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    setCompilerDiagnostics(view, props.diagnostics ?? [])
  })

  // -------------------------------------------------------- figure edit dialog

  useEffect(() => {
    const open = () => setFigureDialogOpen(true)
    window.addEventListener('figure-modal:open-modal', open)
    return () => window.removeEventListener('figure-modal:open-modal', open)
  }, [])

  // ------------------------------------------------------------ mode switching

  // The mode is a transaction, not a rebuild.
  //
  // Everything that differs between the two modes is mounted through a
  // compartment — the ported `visual()` set, and every extension wrapped in
  // `visualOnly` / `sourceOnly` — so this is all a mode switch does. The
  // `EditorState`, the selection and the viewport element all survive, so the
  // caret and the document are simply still there; the viewport is held across
  // the re-layout by the caret line's position in it (see `modeSwitch.ts`).
  //
  // The editor is built in the requested mode, so a redundant dispatch would
  // reconfigure the visual extension set for nothing; `isVisual(view)` answers
  // which mode the live view is actually in.
  //
  // `isVisualModeFile` is applied here for the same reason the extension set
  // applies it: a document Visual Mode does not claim (`.bib`, plain text) must
  // stay in source mode however the application's mode is set.
  //
  // The switch itself runs on the next animation frame, which is not a delay for
  // its own sake: CodeMirror refreshes its notion of the scroll position while
  // measuring, the browser delivers pending `scroll` events *before* animation
  // frame callbacks, and a direct `scrollTop` write — a programmatic scroll,
  // including a probe's — is only reported by that event. One frame later, the
  // position captured by the snapshot is the one actually on screen.
  useEffect(() => {
    const view = viewRef.current
    const showVisual = startVisual && isVisualModeFile(filePath)
    if (!view || isVisual(view) === showVisual) return

    const frame = window.requestAnimationFrame(() => {
      if (viewRef.current !== view) return
      if (isVisual(view) === showVisual) return
      switchEditorMode(view, showVisual)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [startVisual, filePath])

  return (
    <>
      <div
        ref={hostRef}
        className={['eukolia-visual-editor', className]
          .filter(Boolean)
          .join(' ')}
        data-theme={theme}
        style={{ height: '100%', overflow: 'hidden', ...style }}
      />
      {figureDialogOpen && (
        <FigureOptionsDialog
          view={viewRef.current}
          scope={scope}
          onClose={() => setFigureDialogOpen(false)}
        />
      )}
    </>
  )
})

export default VisualEditor
