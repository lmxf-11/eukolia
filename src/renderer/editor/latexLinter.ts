/**
 * Eukolia — LaTeX linting service.
 *
 * Drives the linter ported from Overleaf
 * (`vendor/overleaf/languages/latex/linter/latex-linter.worker.ts`, the same
 * worker the reference runs) and exposes its results as plain data so the editor
 * can consume them: `cmDiagnostics.ts` turns them into lint diagnostics and the
 * ported CodeMirror `linting()` extension draws them, under a marker owner of
 * their own so a lint pass never clears the compiler's errors.
 *
 * The worker is created lazily and shared. Requests are coalesced: while a lint
 * is running, only the most recent request is kept, so a fast typist never
 * queues up stale work (Instructions.md §61).
 */

import { errorsToDiagnostics, type LintError } from '../vendor/overleaf/languages/latex/linter/errors-to-diagnostics';
import { mergeCompatibleOverlappingDiagnostics } from '../vendor/overleaf/languages/latex/linter/merge-overlapping-diagnostics';

export interface LintDiagnostic {
  /** Character offsets into the linted text. */
  from: number;
  to: number;
  /** 1-based, for editors that address positions by line and column. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
}

interface PendingRequest {
  text: string;
  cursor: number;
  resolve: (diagnostics: LintDiagnostic[]) => void;
  reject: (error: unknown) => void;
}

/** The worker module URL, resolved by the bundler. */
function createWorker(): Worker {
  return new Worker(
    new URL('../vendor/overleaf/languages/latex/linter/latex-linter.worker.ts', import.meta.url),
    { type: 'module' }
  );
}

export class LatexLintService {
  private worker: Worker | null = null;
  private running = false;
  /** The newest request received while a lint was in flight. */
  private queued: PendingRequest | null = null;
  private current: PendingRequest | null = null;
  private readonly listeners = new Set<(diagnostics: readonly LintDiagnostic[]) => void>();
  private lastResult: LintDiagnostic[] = [];

  /** True once the worker has been started. */
  public get isRunning(): boolean {
    return this.worker !== null;
  }

  public getLastResult(): readonly LintDiagnostic[] {
    return this.lastResult;
  }

  public onResult(listener: (diagnostics: readonly LintDiagnostic[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Lints `text`. Resolves with an empty list when a newer request supersedes
   * this one, rather than rejecting, because a superseded lint is not an error.
   */
  public lint(text: string, cursor = 0): Promise<LintDiagnostic[]> {
    return new Promise<LintDiagnostic[]>((resolve, reject) => {
      const request: PendingRequest = { text, cursor, resolve, reject };

      if (this.running) {
        // Only the newest request matters; anything already queued is superseded.
        this.queued?.resolve([]);
        this.queued = request;
        return;
      }

      this.current = request;
      this.run();
    });
  }

  private run(): void {
    const request = this.current;
    if (!request) return;

    this.running = true;
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (err) {
      this.running = false;
      this.current = null;
      request.reject(err);
      this.drain();
      return;
    }

    const onMessage = (event: MessageEvent) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);

      const errors = (event.data?.errors ?? []) as LintError[];
      const diagnostics = this.toDiagnostics(errors, request.text, request.cursor);
      this.lastResult = diagnostics;

      this.running = false;
      this.current = null;
      request.resolve(diagnostics);
      for (const listener of this.listeners) {
        try {
          listener(diagnostics);
        } catch (err) {
          console.error('[eukolia] lint listener threw', err);
        }
      }
      this.drain();
    };

    const onError = (event: ErrorEvent) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      this.running = false;
      this.current = null;
      request.reject(new Error(event.message || 'the LaTeX linter worker failed'));
      this.drain();
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ text: request.text });
  }

  /** Starts the next queued request, if any. */
  private drain(): void {
    const next = this.queued;
    this.queued = null;
    if (!next) return;
    this.current = next;
    this.run();
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = createWorker();
      // A worker that dies must not take the editor down with it: the next lint
      // builds a fresh one.
      this.worker.addEventListener('error', () => {
        this.worker?.terminate();
        this.worker = null;
      });
    }
    return this.worker;
  }

  /** Converts the reference's offset-based errors into line/column diagnostics. */
  private toDiagnostics(errors: readonly LintError[], text: string, cursor: number): LintDiagnostic[] {
    // `errorsToDiagnostics` implements the reference's cursor-aware suppression
    // and range adjustments; positions are then translated into the line/column
    // pair the application reports.
    const converted = mergeCompatibleOverlappingDiagnostics(errorsToDiagnostics([...errors], cursor, text.length));

    const lineStarts = buildLineStarts(text);
    return converted.map((diagnostic) => {
      const from = Math.max(0, Math.min(diagnostic.from, text.length));
      const to = Math.max(from, Math.min(diagnostic.to, text.length));
      const start = positionAt(lineStarts, from);
      const end = positionAt(lineStarts, to);
      return {
        from,
        to,
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
        severity: diagnostic.severity,
        message: diagnostic.message,
        source: 'latex linter'
      };
    });
  }

  public dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.queued?.resolve([]);
    this.queued = null;
    this.current = null;
    this.listeners.clear();
  }
}

/** Offsets at which each line starts, for offset → line/column conversion. */
function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function positionAt(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}

export const latexLintService = new LatexLintService();
