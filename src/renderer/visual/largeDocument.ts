/**
 * Large-file handling, after VS Code's.
 *
 * VS Code decides a document's capabilities **once, at open**, from its size, and
 * never re-decides per keystroke — the comment in `textModel.ts` says so outright:
 * *"Make a decision in the ctor and permanently respect this decision … If a model is
 * too large at construction time, it will never get tokenized, under no
 * circumstances."* Above 20 MB or 300 000 lines it stops tokenizing, folding, code
 * lens, word highlighting, sticky scroll and wrapping, and it says which, in one
 * notification, with a `Forcefully Enable Features` action that turns
 * `editor.largeFileOptimizations` off.
 *
 * Eukolia had none of this: no threshold existed anywhere, and the one setting that
 * looked like it (`advanced.maxProjectFileSize`) was declared in the schema and read
 * by nothing. The contracts adopted here are VS Code's — one decision at open, each
 * disabled capability named, one setting to override it — but the *thresholds* are
 * not copied, because the cost curve is not the same shape.
 *
 * The difference that sets the numbers
 * -----------------------------------
 * VS Code's tokenization is viewport-bounded and runs in a worker, so a document
 * costs roughly the same to *type* in whether it has 500 lines or 50 000, and its
 * threshold can sit at 20 MB. Eukolia's Visual Mode decoration pass is a
 * `StateField` that walks the **whole** syntax tree and builds a widget object for
 * every construct in the document, and it rebuilds on every parse step — measured at
 * ~10 ms and ~387 widget objects per keystroke on a 665-line chapter. That is linear
 * in the document, so the point at which typing stops feeling immediate arrives far
 * earlier: around 2 000 lines. The thresholds below are that measurement, not a
 * copied constant, and they are the thing to raise once the pass is viewport-bounded
 * (see the note at the end of this file).
 *
 * Each gate turns off one thing, as in VS Code, rather than one switch turning off
 * everything.
 */

import type { Text } from '@codemirror/state'

/**
 * Above this many lines the document is not parsed eagerly at mount.
 *
 * `forceParsing(view, doc.length, 10_000)` exists so the whole document's widgets
 * exist immediately. It is a synchronous full parse in the frame that opens the file,
 * which on a large document is the freeze the user sees first. CodeMirror parses on
 * demand for the viewport anyway, so skipping it costs nothing that is on screen.
 */
export const EAGER_PARSE_LINES = 4_000

/**
 * Above this many lines the analysis waits for a pause instead of 120 ms of quiet.
 *
 * The analysis is a full `parseLatexWithArguments` of the document. VS Code keeps
 * language features on a large file — it moves them to another process rather than
 * disabling them — and until Eukolia does the same, the honest thing is to run it
 * when the user has stopped typing rather than between two keystrokes.
 */
export const LARGE_DOCUMENT_ANALYSIS_LINES = 1_000

/**
 * **No document is too large to render.**
 *
 * This was 2 000, and it gated `atomicDecorations` — the widget pass — because that
 * pass walked the whole syntax tree and built a widget object for every construct in
 * the file on every rebuild, which is per keystroke. Measured on the Stacks
 * project's `cohomology.tex` (14 529 lines): **107 ms** of decoration building in a
 * frame whose budget is 16 ms, for a document whose visible part is thirty lines.
 * Above the threshold Visual Mode therefore drew source instead of mathematics —
 * which is why a reader opening that file saw no SVG at all.
 *
 * The pass is now bounded to the viewport (`atomicDecorations` in
 * `atomic-decorations.ts`), and what it costs no longer depends on the size of the
 * document: a viewport's worth of constructs is built per rebuild, and a rebuild
 * happens only for work that can be seen. The threshold that made sense for the old
 * pass is meaningless for this one, and the capability it gated is the *point* of
 * Visual Mode — a mathematics editor that will not draw mathematics in a long
 * chapter has removed the thing the reader opened it for.
 *
 * Kept as a named constant, at a size past any document a LaTeX toolchain will
 * finish compiling, so that a future pass which genuinely is linear in the document
 * has an obvious place to say so again. The override and the notice are unchanged:
 * whatever is switched off is still named, and `editor.largeFileOptimizations` still
 * forces everything on.
 */
export const LARGE_DOCUMENT_DECORATION_LINES = 500_000

/**
 * Above this many lines the widget pass decorates the viewport instead of everything.
 *
 * The bound is not free: a viewport-bounded set has to be *rebuilt* when the reader
 * scrolls out of the part of the document it describes, and it says nothing about
 * the parts it does not describe — so anything asking the editor for a decoration
 * at an arbitrary position (a test, an outline that reads the whole field) sees less
 * than it would have. Both costs are real and neither is worth paying for a
 * document that is small enough to decorate outright in the first place.
 *
 * The number is where the two cross, measured with `tests/visual/rebuildCost.test.ts`
 * on the Stacks project's own chapters: a whole-document build costs a few
 * milliseconds at 1 000 lines and grows linearly, while a viewport's worth stays at
 * ~2 ms whatever the document is. Below the crossing point the bound buys nothing
 * and costs the rebuilds; above it, it is the difference between 2 ms and 107 ms.
 *
 * It is placed here rather than in `atomic-decorations.ts` because it is a statement
 * about document size, which is what this file is for, and because the number that
 * matters — the one that decides what a reader can see — is
 * {@link LARGE_DOCUMENT_DECORATION_LINES}, which is no longer a size at all.
 */
export const VIEWPORT_BOUNDED_DECORATION_LINES = 1_000

/** How long a large document must be quiet before it is analysed, in ms. */
export const LARGE_DOCUMENT_ANALYSIS_SETTLE_MS = 1_500

export interface LargeDocumentProfile {
  /** The document is large enough that thinking about it needs a reason. */
  large: boolean
  /**
   * Mount the widget pass (Visual Mode's mathematics, tables and figures).
   *
   * Always true at every size a LaTeX toolchain will compile — see
   * `LARGE_DOCUMENT_DECORATION_LINES` — because the pass is bounded to the viewport
   * and its cost no longer depends on the document. The field is kept because the
   * decision is still the caller's to make and is still named in the notice when it
   * is made.
   */
  decorations: boolean
  /** Parse the whole document in the frame that opens it. */
  eagerParse: boolean
  /** Milliseconds of quiet before the document is analysed. */
  analysisSettleMs: number
  /** Send the document to the linter worker. */
  lint: boolean
  /** What is switched off, for the notice. Empty when nothing is. */
  disabled: string[]
}

/** A profile with nothing switched off, for callers with no document yet. */
export const FULL_FEATURES: LargeDocumentProfile = {
  large: false,
  decorations: true,
  eagerParse: true,
  analysisSettleMs: 120,
  lint: true,
  disabled: []
}

/**
 * The number of lines in `text`, counted rather than materialised.
 *
 * `text.split('\n').length` builds an array with one string per line to read one
 * number off it — twenty thousand throwaway strings for a large document, at the one
 * moment the document is being opened. CodeMirror's `Text` answers this without
 * copying (`doc.lines`), so this is only for the caller that has the string.
 */
export function lineCount(text: string): number {
  let lines = 1
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1
  return lines
}

/**
 * The capabilities of one document.
 *
 * `enabled` is `editor.largeFileOptimizations` — the same key and the same meaning as
 * VS Code's, including the direction of the override: turning it off restores every
 * feature regardless of size, which is what VS Code's `Forcefully Enable Features`
 * action does.
 */
export function largeDocumentProfile(
  doc: Pick<Text, 'length' | 'lines'>,
  options: { enabled: boolean; analysisSettleMs: number }
): LargeDocumentProfile {
  if (!options.enabled) return { ...FULL_FEATURES, analysisSettleMs: options.analysisSettleMs }

  const lines = doc.lines
  const disabled: string[] = []

  const decorations = lines <= LARGE_DOCUMENT_DECORATION_LINES
  if (!decorations) {
    disabled.push(
      `visual rendering (the document is ${lines.toLocaleString()} lines; mathematics and commands are shown as source)`
    )
  }

  const eagerParse = lines <= EAGER_PARSE_LINES
  if (!eagerParse) disabled.push('parsing the whole document up front')

  const largeAnalysis = lines > LARGE_DOCUMENT_ANALYSIS_LINES
  if (largeAnalysis) disabled.push('analysis while you type (it runs when you pause)')

  const lint = lines <= EAGER_PARSE_LINES
  if (!lint) disabled.push('live linting')

  return {
    large: disabled.length > 0,
    decorations,
    eagerParse,
    analysisSettleMs: largeAnalysis
      ? Math.max(LARGE_DOCUMENT_ANALYSIS_SETTLE_MS, options.analysisSettleMs)
      : options.analysisSettleMs,
    lint,
    disabled
  }
}

/**
 * The sentence the reader is owed when something has been switched off.
 *
 * VS Code's is *"{0}: tokenization, wrapping, folding, codelens, word highlighting
 * and sticky scroll have been turned off for this large file in order to reduce
 * memory usage and avoid freezing or crashing."* A degraded editor that does not say
 * so reads as a bug, which is the whole reason the notification exists.
 */
export function largeDocumentNotice(profile: LargeDocumentProfile): string | null {
  if (!profile.large) return null
  const list = profile.disabled.join('; ')
  return `Large file: ${list}. Turn off \`editor.largeFileOptimizations\` to force full features.`
}

/*
 * Raising the thresholds
 * ----------------------
 * Done, for the one that mattered. `LARGE_DOCUMENT_DECORATION_LINES` gated Visual
 * Mode's widgets on a pass that was linear in the document; the pass is now bounded
 * to the viewport (`atomicDecorations` in `atomic-decorations.ts`), so the number
 * followed VS Code's and the capability stayed on.
 *
 * What is left is gated on size for a reason that survives the bound:
 *
 *  * `eagerParse` — `forceParsing` to the end of the document is a synchronous parse
 *    in the frame that opens the file, and CodeMirror's own lazy parsing already
 *    covers what is on screen;
 *  * `lint` — the linter stringifies the whole buffer on every pass, which is
 *    bounded by the document rather than by the viewport;
 *  * `analysisSettleMs` — a full parse of the buffer, moved to the moment the reader
 *    pauses rather than dropped.
 *
 * The next threshold to raise is `eagerParse`'s, and the thing that raises it is
 * parsing off the renderer thread — VS Code's answer, and the same one this project
 * already adopted for the analyzer and the linter.
 */
