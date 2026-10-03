/**
 * Analyses documents through a transport, with the renderer's own analyzer as the
 * fallback.
 *
 * The service owns one transport and a bounded number of requests in flight. It
 * exists because the project index's walk over a project's `\input`ed files —
 * measured at 24.8 s of parsing for 200 files on a 2 846-file project — must not
 * happen on the thread the user is typing on.
 *
 * The transport is `analysis:analyze`, answered by the main process (in the
 * application: `window.eukoliaApi.analyzeDocument`). It was a web worker, and the
 * worker had to go: the analyzer's dependency chain reaches for CommonJS `require`
 * at module scope, an ES module worker has none, and a module that fails to
 * evaluate takes the application's startup with it. The main process is Node, so
 * the same analyzer source runs there — which is also VS Code's arrangement, for
 * the same reason. It is injected rather than constructed here so a test can drive
 * the protocol directly, without a process boundary.
 *
 * Two deliberate properties, both taken from VS Code:
 *
 *  * **A transport that cannot be used is not a failure.** VS Code says *"Could not
 *    create web worker(s). Falling back to loading web worker code in main thread,
 *    which might cause UI freezes"* and carries on; so does this — the work moves
 *    back to the renderer's analyzer, the caller is unaffected, and the console says
 *    so once. A missing transport must not cost the application its macro index.
 *  * **A transport that dies loses only what was in flight.** The failing request is
 *    answered from the fallback, the transport is abandoned rather than retried, and
 *    every later request goes straight to the fallback. VS Code restarts its
 *    watcher for this, and the difference is why it does not apply here: a watcher is
 *    long-lived and its failures are usually transient, while a channel that is
 *    simply not there — a renderer built without the preload, a handler never
 *    registered — will not be there on the next attempt either.
 */

import type { AnalyzeDocumentResponse } from '../../shared/ipc'
import type { DocumentAnalysis, DocumentAnalyzer } from '../document/documentModel'

/**
 * How many analyses may be in flight at once.
 *
 * The walk that drives this is a sequential loop today, so in practice one file is
 * in flight at a time and this bound does not bite. It is here for the case the
 * bound is actually about: an analysis is *synchronous* work in the main process —
 * measured at 483 ms on average and 914 ms worst for one indexed file — so a caller
 * that fired 200 of them at once would queue 200 parses in front of the main
 * process's own work, which is the file reads this walk is waiting on, the window
 * it is drawing and the compiler it shares a process with. Four keeps the channel
 * busy without handing the main process a backlog it cannot interrupt.
 */
const MAX_IN_FLIGHT = 4

/** The transport: one document, analysed elsewhere. */
export type AnalyzeInvoke = (text: string, uri: string) => Promise<AnalyzeDocumentResponse>

export interface LatexAnalysisOptions {
  /**
   * The analyzer to use when no transport can be used. Awaited lazily, so a caller
   * that never needs the fallback never loads the parser on the renderer thread.
   */
  fallback: () => Promise<DocumentAnalyzer | null>
  /**
   * The transport, when this window has one. Absent — in a test double, in a
   * window whose preload predates the channel — every request goes to the fallback.
   */
  invoke?: AnalyzeInvoke
  /** Diagnostics for the two cases above; defaults to `console.warn`. */
  warn?: (message: string, error?: unknown) => void
}

export class LatexAnalysisService {
  private invoke: AnalyzeInvoke | null
  /** Set once the transport has failed in a way that makes another attempt pointless. */
  private unavailable = false
  /** The single message, so a broken transport is explained once and not per file. */
  private warned = false
  private inFlight = 0
  /** Requests parked on the in-flight bound, oldest first. */
  private readonly waiting: Array<() => void> = []

  constructor(private readonly options: LatexAnalysisOptions) {
    this.invoke = options.invoke ?? null
  }

  /** True while the work is happening somewhere other than this thread. */
  public get usingTransport(): boolean {
    return this.invoke !== null
  }

  /**
   * Reports whether the work will happen off this thread.
   *
   * The caller asks this *before* loading its fallback: the fallback is the parser
   * itself, and evaluating it is the cost this service exists to avoid. `false`
   * means "no transport here", not "nothing works" — `analyze` will still answer,
   * on the renderer's thread.
   */
  public start(): boolean {
    if (this.invoke) return true
    if (!this.unavailable) {
      /*
       * No transport at all. This is the state a window built without the bridge is
       * in, and it is said once rather than once per file.
       */
      this.unavailable = true
      this.warn('the main process analysis channel is not available; project indexing will run on the renderer\'s thread')
    }
    return false
  }

  /**
   * Analyses `text`. Never rejects for a file that cannot be parsed — that is
   * reported as a rejection so the caller can log it, but it is the caller's
   * decision to skip the file, which is what the index does.
   */
  public async analyze(text: string, uri: string): Promise<DocumentAnalysis> {
    if (!this.start()) return this.analyzeOnRenderer(text, uri)

    await this.acquire()
    // Read the transport *after* waiting its turn: a request that queued behind a
    // failing one must not go on to use a channel that has since been abandoned.
    const invoke = this.invoke
    if (!invoke) {
      this.release()
      return this.analyzeOnRenderer(text, uri)
    }

    let response: AnalyzeDocumentResponse
    try {
      response = await invoke(text, uri)
    } catch (error) {
      /*
       * A rejected call is the *channel* failing, not the document: a document the
       * parser cannot read comes back as `{ error }` and is handled below. The
       * difference is what keeps one bad file from costing the project its macro
       * index — this request is answered from the fallback rather than lost.
       */
      this.release()
      this.failTransport(error)
      return this.analyzeOnRenderer(text, uri)
    }
    this.release()

    if (response?.error !== undefined) throw new Error(response.error)
    const analysis = response?.analysis
    if (analysis === undefined || analysis === null) {
      throw new Error('the analysis channel returned neither an analysis nor an error')
    }
    return analysis as DocumentAnalysis
  }

  /**
   * Stops routing work through the transport.
   *
   * Nothing is terminated, because the transport holds no resources on this side —
   * the main process owns the analyzer and its lifetime. Safe to call more than
   * once, and safe to call before `start`.
   */
  public dispose(): void {
    this.invoke = null
    this.unavailable = true
    for (const wake of this.waiting.splice(0)) wake()
  }

  /** Waits for a slot under `MAX_IN_FLIGHT`. */
  private acquire(): Promise<void> {
    if (this.inFlight < MAX_IN_FLIGHT) {
      this.inFlight += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.inFlight += 1
        resolve()
      })
    })
  }

  /** Hands the slot to the oldest waiting request, if any. */
  private release(): void {
    this.inFlight -= 1
    this.waiting.shift()?.()
  }

  private failTransport(error: unknown): void {
    this.invoke = null
    this.unavailable = true
    this.warn('the main process analysis channel failed; project indexing will run on the renderer\'s thread', error)
  }

  private async analyzeOnRenderer(text: string, uri: string): Promise<DocumentAnalysis> {
    const analyzer = await this.options.fallback()
    if (!analyzer) throw new Error('no LaTeX analyzer is available')
    return analyzer.analyze(text, uri)
  }

  private warn(message: string, error?: unknown): void {
    if (this.warned) return
    this.warned = true
    if (this.options.warn) {
      this.options.warn(message, error)
      return
    }
    console.warn(`[eukolia] ${message}`, error)
  }
}
