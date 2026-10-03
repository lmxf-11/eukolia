/**
 * Eukolia — the LaTeX analyzer, in the main process.
 *
 * **Why the analyzer is not in the renderer.** The ported LaTeX Workshop parser
 * (`src/renderer/parser/latexAnalyzer.ts` and the vendored `unified.js` behind it)
 * is a Node bundle: at module scope it reaches for CommonJS `require("path")`, and
 * `vite-plugin-electron-renderer` keeps that reference as written rather than
 * rewriting it. In the renderer a narrow `require` shim installed by
 * `index.html` supplies `path`; an ES module *worker* has no such thing, so every
 * request in it failed with `require is not defined` — during module evaluation,
 * which is why that worker took the application's startup down with it.
 *
 * The main process is Node and Vite externalises builtins there, so the very same
 * source file imports `path` for real and runs unchanged. This is VS Code's own
 * arrangement, and its reason: language work belongs in the process that has Node,
 * not in the renderer that has the user's keystrokes. What crosses the boundary is
 * plain data in both directions — see `AnalyzeDocumentResponse`, which is plain
 * data by construction, since `tests/parser/latexAnalysis.test.ts` asserts that an
 * analysis survives a structured clone.
 *
 * **One shared analyzer, loaded lazily.** The import is dynamic so the 1.9 MB
 * parser and the ~200 package-data chunks behind it are not evaluated when the
 * application starts; the first file the project index asks about pays for it, and
 * every later file reuses the instance. Nothing in the application calls
 * `setSettings`, so both processes run the analyzer's defaults and the answer is
 * the one the renderer would have computed for itself.
 */

import type { AnalyzeDocumentRequest, AnalyzeDocumentResponse } from '../../shared/ipc'
import type { DocumentAnalyzer } from '../../renderer/document/documentModel'

let analyzerPromise: Promise<DocumentAnalyzer> | null = null

/**
 * Loads the analyzer, once.
 *
 * Rejects when the parser cannot be evaluated at all, and that rejection is
 * deliberately *not* turned into a per-file error: a parser that will not load
 * will not load for the next file either, and the renderer's answer to it is to
 * stop using this channel and fall back to its own analyzer (see
 * `LatexAnalysisService`). Rejecting the call is what tells it so.
 */
export function loadDocumentAnalyzer(): Promise<DocumentAnalyzer> {
  analyzerPromise ??= import('../../renderer/parser/latexAnalyzer').then((module) => module.latexDocumentAnalyzer)
  return analyzerPromise
}

/**
 * Analyses one document with `analyzer`, as the channel answers it.
 *
 * Total: a document the parser cannot handle becomes `{ error }`, because one
 * unparseable file must not lose the walk over the project. The caller logs and
 * skips that file, exactly as it did when this ran on the renderer's thread.
 */
export function analyzeWith(analyzer: DocumentAnalyzer, request: AnalyzeDocumentRequest): AnalyzeDocumentResponse {
  try {
    return { analysis: analyzer.analyze(request.text, request.uri) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Analyses one document in this process: the body of `analysis:analyze`. */
export async function analyzeDocument(text: string, uri: string): Promise<AnalyzeDocumentResponse> {
  const analyzer = await loadDocumentAnalyzer()
  return analyzeWith(analyzer, { text, uri })
}
