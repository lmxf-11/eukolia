/**
 * Native PDF engine bridge (Electron main process).
 *
 * Owns the long-lived `eukolia-pdf.exe` child process and speaks the stdio
 * binary protocol documented in `src/native/pdf/PROTOCOL.md`. This is the only
 * place in Eukolia that knows the wire format (Instructions.md §63: keep the
 * cross-language API narrow).
 *
 * Design notes:
 *  - The worker is spawned once, lazily, on the first request, and reused.
 *  - It is restarted after a crash with a bounded retry budget; when the budget
 *    is exhausted the failure is surfaced instead of being retried forever.
 *  - Nothing here blocks the Electron main thread: reads are chunk-driven and
 *    every call is a promise resolved when its own response frame arrives.
 *  - Pixel payloads travel as raw bytes inside the frame and are handed to the
 *    caller as a `Uint8Array` view — never base64 in JSON.
 *  - Documents are keyed by a `docId` derived from the resolved path plus a
 *    generation counter, and rendered through a single worker-side document
 *    slot: switching documents closes the previous one.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FrameType,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type LayoutRequestParams,
  type RenderRequestParams,
  type SearchRequestParams,
  type SelectRequestParams,
  type ViewportRequestParams,
  type WorkerCommand,
  type WorkerLogMessage,
  type WorkerReadyInfo,
  type WireCancelResult,
  type WireErrorBody,
  type WireGlyphsResult,
  type WireInfoResult,
  type WireLayoutResult,
  type WireLinksResult,
  type WireOpenResult,
  type WireOutlineResult,
  type WireRenderHeader,
  type WireRenderResult,
  type WireSearchResult,
  type WireSelectionResult,
  type WireSimpleOk,
  type WireStatsResult,
  type WireTextResult,
  type WireTilesResult,
  type WireViewportResult
} from './workerProtocol';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Worker failures surfaced as a distinguishable error type. */
export class NativePdfError extends Error {
  readonly code: string;
  readonly requestId?: number;
  readonly needsPassword?: boolean;

  constructor(message: string, code = 'worker_error', requestId?: number, needsPassword?: boolean) {
    super(message);
    this.name = 'NativePdfError';
    this.code = code;
    this.requestId = requestId;
    this.needsPassword = needsPassword;
  }
}

export interface NativePdfEngineOptions {
  /** Explicit worker path; when omitted the standard locations are searched. */
  workerPath?: string;
  /** Directory to run the worker in. Defaults to the worker's own directory. */
  cwd?: string;
  /** Build the worker automatically when missing. Defaults to dev only. */
  autoBuild?: boolean;
  /** How many times to restart after a crash before giving up. */
  maxRestarts?: number;
  /** Pipe worker diagnostics to this sink. */
  onLog?: (message: WorkerLogMessage) => void;
  /** Maps a 0-based page index onto the document identity for progress events. */
  onProgress?: (info: { page: number; cached: boolean; ms: number }) => void;
  /** Called when the worker dies while requests were in flight. */
  onCrash?: (message: string, pendingRequests: number) => void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  command: WorkerCommand | 'ping' | 'shutdown';
  startedAt: number;
  timer: NodeJS.Timeout;
  /** Set for render requests so the pixels frame can be matched to it. */
  expectsPixels: boolean;
}

interface OpenDocumentState {
  docId: string;
  path: string;
  pageCount: number;
  generation: number;
}

/** Resolved geometry for one page, cached per document generation. */
interface PageGeometry {
  width: number;
  height: number;
  rotate: number;
}

const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 20_000;
/** A worker alive this long is considered proven, resetting the retry budget. */
const STABLE_AFTER_MS = 5_000;

/**
 * Locate `eukolia-pdf.exe`.
 *
 * Search order covers packaged apps (`process.resourcesPath`), the development
 * tree and a few historical layouts, so neither path needs special casing at
 * the call sites.
 */
export function resolveWorkerPath(explicit?: string): string | null {
  if (explicit) {
    return fs.existsSync(explicit) ? explicit : null;
  }

  const names = process.platform === 'win32' ? ['eukolia-pdf.exe'] : ['eukolia-pdf'];
  const roots: string[] = [];

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    // electron-builder copies resources/native next to the app resources.
    roots.push(path.join(resourcesPath, 'native'));
    roots.push(path.join(resourcesPath, 'app', 'resources', 'native'));
    roots.push(path.join(resourcesPath, 'app.asar.unpacked', 'resources', 'native'));
  }

  // dist-electron/../resources/native when built by tsc, and the repo root.
  roots.push(path.resolve(__dirname, '..', '..', '..', 'resources', 'native'));
  roots.push(path.resolve(process.cwd(), 'resources', 'native'));
  roots.push(path.resolve(process.cwd(), '..', 'resources', 'native'));

  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Repo root, used to locate the build script when auto-building. */
function resolveRepoRoot(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..'),
    path.resolve(process.cwd())
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'scripts', 'build-native-pdf.mjs'))) return candidate;
  }
  return process.cwd();
}

/**
 * Build the worker with the dependency-free build script. This is the same path
 * `npm run build:native` takes, so there is exactly one build definition.
 */
function buildWorker(timeoutMs = 900_000): { ok: boolean; output: string } {
  const repoRoot = resolveRepoRoot();
  const script = path.join(repoRoot, 'scripts', 'build-native-pdf.mjs');
  if (!fs.existsSync(script)) {
    return { ok: false, output: `build script not found at ${script}` };
  }
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, output };
}

/**
 * Low-level worker handle. One instance per Electron main process.
 */
export class NativePdfEngine {
  private readonly options: NativePdfEngineOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private workerPath: string | null = null;
  private readBuffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, PendingCall>();
  private nextRequestId = 1;
  private starting: Promise<WorkerReadyInfo> | null = null;
  private readyInfo: WorkerReadyInfo | null = null;
  private restarts = 0;
  private crashed = false;
  private lastFailure: string | null = null;
  private shuttingDown = false;
  /** When the current worker process was spawned (for the stability window). */
  private startedAt = 0;
  /** Requests successfully answered by the current worker. */
  private requestsHandled = 0;

  /** Document currently loaded in the worker's single document slot. */
  private activeDocument: OpenDocumentState | null = null;
  private geometry = new Map<number, PageGeometry>();
  private generation = 0;

  constructor(options: NativePdfEngineOptions = {}) {
    this.options = options;
  }

  // ------------------------------------------------------------------ status

  /** True when a worker binary can be located (does not spawn it). */
  isAvailable(): boolean {
    if (this.workerPath && fs.existsSync(this.workerPath)) return true;
    return resolveWorkerPath(this.options.workerPath) !== null;
  }

  /** Human-readable description of the last hard failure, if any. */
  getLastFailure(): string | null {
    return this.lastFailure;
  }

  getReadyInfo(): WorkerReadyInfo | null {
    return this.readyInfo;
  }

  /** Path of the worker binary in use, or null when none was found. */
  getWorkerPath(): string | null {
    return this.workerPath ?? resolveWorkerPath(this.options.workerPath);
  }

  // --------------------------------------------------------------- lifecycle

  private async ensureWorker(): Promise<WorkerReadyInfo> {
    if (this.shuttingDown) {
      throw new NativePdfError('the native PDF engine is shutting down', 'shutting_down');
    }
    if (this.crashed && this.restarts >= (this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS)) {
      throw new NativePdfError(
        `the native PDF engine crashed ${this.restarts} times and was not restarted again` +
          (this.lastFailure ? `: ${this.lastFailure}` : ''),
        'worker_unavailable'
      );
    }
    if (this.child && this.readyInfo) return this.readyInfo;
    if (this.starting) return this.starting;

    this.starting = this.spawnWorker().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private locateWorker(): string {
    let resolved = resolveWorkerPath(this.options.workerPath);
    if (!resolved && this.options.autoBuild) {
      const built = buildWorker();
      if (!built.ok) {
        throw new NativePdfError(
          `the native PDF engine is not built and the automatic build failed:\n${built.output}`,
          'worker_missing'
        );
      }
      resolved = resolveWorkerPath(this.options.workerPath);
    }
    if (!resolved) {
      throw new NativePdfError(
        'the native PDF engine (resources/native/eukolia-pdf.exe) was not found. Run `npm run build:native`.',
        'worker_missing'
      );
    }
    return resolved;
  }

  private spawnWorker(): Promise<WorkerReadyInfo> {
    const exe = this.locateWorker();
    this.workerPath = exe;

    return new Promise<WorkerReadyInfo>((resolve, reject) => {
      let settled = false;
      const child = spawn(exe, [], {
        cwd: this.options.cwd ?? path.dirname(exe),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }) as ChildProcessWithoutNullStreams;

      this.child = child;
      this.readBuffer = Buffer.alloc(0);
      this.startedAt = Date.now();
      this.requestsHandled = 0;

      // A dead worker makes every write fail with EPIPE. Without a listener that
      // surfaces as an *uncaught* error event on the stream -- Node's default for
      // an unhandled 'error' -- which would take down the Electron main process
      // (Instructions.md §61: a crashed subsystem must surface a failure, never a
      // silent hang or an unhandled throw). The exit handler rejects the pending
      // request; this listener only stops the event escaping.
      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        this.lastFailure = `native PDF engine stdin error: ${error.message}`;
        this.options.onLog?.({ level: 'error', message: this.lastFailure });
      });
      child.stdout?.on('error', () => {
        // Drained by attachFrameReader; a read error is handled by the exit path.
      });

      const readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.failAllPending(new NativePdfError('the native PDF engine did not become ready', 'worker_timeout'));
        child.kill();
        reject(new NativePdfError('the native PDF engine did not become ready in time', 'worker_timeout'));
      }, READY_TIMEOUT_MS);

      const onReady = (info: WorkerReadyInfo) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        this.readyInfo = info;
        this.crashed = false;
        if (info.protocolVersion !== PROTOCOL_VERSION) {
          const error = new NativePdfError(
            `native PDF protocol mismatch: worker speaks v${info.protocolVersion}, Eukolia expects v${PROTOCOL_VERSION}`,
            'protocol_mismatch'
          );
          this.crashed = true;
          child.kill();
          reject(error);
          return;
        }
        resolve(info);
      };

      // The worker emits its Ready frame before reading any request, so the
      // normal frame reader is what resolves startup.
      this.attachFrameReader(child, onReady);

      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(new NativePdfError(`failed to start the native PDF engine: ${error.message}`, 'worker_spawn_failed'));
        }
        this.crashed = true;
        this.lastFailure = error.message;
        this.failAllPending(new NativePdfError(`native PDF engine process error: ${error.message}`, 'worker_crash'));
      });

      child.on('exit', (code, signal) => {
        clearTimeout(readyTimer);
        const expected = this.shuttingDown;
        const hadPending = this.pending.size;
        this.child = null;
        this.readyInfo = null;
        this.activeDocument = null;
        this.geometry.clear();
        if (!settled) {
          settled = true;
          reject(
            new NativePdfError(
              `the native PDF engine exited during startup (code ${code ?? 'null'}, signal ${signal ?? 'none'})`,
              'worker_crash'
            )
          );
        }
        if (!expected) {
          this.crashed = true;
          this.restarts += 1;
          this.lastFailure = `worker exited with code ${code ?? 'null'}`;
          // A worker that had already proved itself (a request completed, or it
          // stayed up past the stability window) starts from a clean retry budget
          // again: the budget exists to stop a crash loop, not to cap the number
          // of crashes over a long session.
          if (this.requestsHandled > 0 || Date.now() - this.startedAt > STABLE_AFTER_MS) {
            this.restarts = 1;
          }
        }
        // Reject EVERY in-flight request. Without this a caller would wait for
        // its timeout while the subsystem is already gone, which is the silent
        // hang Instructions.md §61 forbids.
        this.failAllPending(
          new NativePdfError(
            `the native PDF engine stopped unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'})`,
            'worker_crash'
          )
        );
        if (!expected && hadPending > 0) {
          this.options.onCrash?.(this.lastFailure ?? 'the native PDF engine stopped unexpectedly', hadPending);
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        // The worker writes nothing to stderr in normal operation; anything here
        // is mupdf warning output or a crash diagnostic.
        this.options.onLog?.({ level: 'warn', message: chunk.toString('utf8').trim() });
      });
    });
  }

  private attachFrameReader(child: ChildProcessWithoutNullStreams, onReady: (info: WorkerReadyInfo) => void): void {
    child.stdout.on('data', (chunk: Buffer) => {
      this.readBuffer = this.readBuffer.length === 0 ? chunk : Buffer.concat([this.readBuffer, chunk]);
      this.drainFrames(onReady);
    });
    child.stdout.on('end', () => {
      this.readBuffer = Buffer.alloc(0);
    });
  }

  /** Parse as many complete frames as the buffer holds. */
  private drainFrames(onReady: (info: WorkerReadyInfo) => void): void {
    for (;;) {
      if (this.readBuffer.length < 4) return;
      const payloadLength = this.readBuffer.readUInt32LE(0);
      if (payloadLength < 5 || payloadLength > MAX_FRAME_BYTES) {
        // Unrecoverable: the stream is desynchronised. Kill the worker so the
        // restart path can take over rather than parsing garbage.
        this.lastFailure = `malformed frame length ${payloadLength} from the native PDF engine`;
        this.options.onLog?.({ level: 'error', message: this.lastFailure });
        this.crashed = true;
        this.child?.kill();
        return;
      }
      if (this.readBuffer.length < 4 + payloadLength) return;

      const payload = this.readBuffer.subarray(4, 4 + payloadLength);
      this.readBuffer = this.readBuffer.subarray(4 + payloadLength);
      this.handleFrame(payload, onReady);
    }
  }

  private handleFrame(payload: Buffer, onReady: (info: WorkerReadyInfo) => void): void {
    const type = payload[0] as (typeof FrameType)[keyof typeof FrameType];
    const requestId = payload.readUInt32LE(1);
    const body = payload.subarray(5);

    switch (type) {
      case FrameType.Ready: {
        onReady(JSON.parse(body.toString('utf8')) as WorkerReadyInfo);
        return;
      }
      case FrameType.Pong: {
        const call = this.pending.get(requestId);
        if (call) {
          clearTimeout(call.timer);
          this.pending.delete(requestId);
          this.requestsHandled += 1;
          call.resolve(JSON.parse(body.toString('utf8')) as WireSimpleOk);
        }
        return;
      }
      case FrameType.Log: {
        try {
          this.options.onLog?.(JSON.parse(body.toString('utf8')) as WorkerLogMessage);
        } catch {
          // Malformed log frames are never worth failing a request over.
        }
        return;
      }
      case FrameType.Pixels: {
        this.handlePixelsFrame(requestId, body);
        return;
      }
      case FrameType.Response: {
        const call = this.pending.get(requestId);
        if (!call) return;
        clearTimeout(call.timer);
        this.pending.delete(requestId);
        const parsed = body.length ? (JSON.parse(body.toString('utf8')) as WireSimpleOk) : ({ ok: true } as WireSimpleOk);
        this.requestsHandled += 1;
        call.resolve(parsed);
        return;
      }
      case FrameType.Error: {
        const call = this.pending.get(requestId);
        const parsed = body.length ? (JSON.parse(body.toString('utf8')) as WireErrorBody) : ({ ok: false, error: 'unknown error' } as WireErrorBody);
        const error = new NativePdfError(
          parsed.error ?? 'the native PDF engine reported an error',
          parsed.code ?? 'worker_error',
          requestId,
          parsed.needsPassword
        );
        if (call) {
          clearTimeout(call.timer);
          this.pending.delete(requestId);
          call.reject(error);
        } else if (requestId === 0) {
          // Stream-level error: no request to attribute it to.
          this.lastFailure = error.message;
          this.options.onLog?.({ level: 'error', message: error.message });
        }
        return;
      }
      default:
        return;
    }
  }

  private handlePixelsFrame(requestId: number, body: Buffer): void {
    if (body.length < 4) {
      this.rejectRequest(requestId, new NativePdfError('truncated pixel frame', 'protocol_error', requestId));
      return;
    }
    const headerBytes = body.readUInt32LE(0);
    if (4 + headerBytes > body.length) {
      this.rejectRequest(requestId, new NativePdfError('pixel frame header overruns the frame', 'protocol_error', requestId));
      return;
    }
    const header = JSON.parse(body.subarray(4, 4 + headerBytes).toString('utf8')) as WireRenderHeader;
    // subarray() is a view, not a copy: the pixels are never duplicated in the
    // main process, and the IPC layer copies once when it serialises.
    const pixels = new Uint8Array(body.buffer, body.byteOffset + 4 + headerBytes, body.length - 4 - headerBytes);

    if (header.blobBytes !== pixels.byteLength) {
      this.rejectRequest(
        requestId,
        new NativePdfError(
          `pixel frame length mismatch: header says ${header.blobBytes}, frame carries ${pixels.byteLength}`,
          'protocol_error',
          requestId
        )
      );
      return;
    }

    const call = this.pending.get(requestId);
    if (!call) return;
    clearTimeout(call.timer);
    this.pending.delete(requestId);
    const result: WireRenderResult = { ...header, pixels };
    this.requestsHandled += 1;
    call.resolve(result);
  }

  private rejectRequest(requestId: number, error: Error): void {
    const call = this.pending.get(requestId);
    if (!call) return;
    clearTimeout(call.timer);
    this.pending.delete(requestId);
    call.reject(error);
  }

  private failAllPending(error: Error): void {
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  /** True when the worker's stdin can still accept a frame. */
  private canWrite(): boolean {
    const stdin = this.child?.stdin;
    return Boolean(stdin && !stdin.destroyed && !stdin.writableEnded && stdin.writable);
  }

  /**
   * Write one frame to the worker, converting any failure into a rejected
   * request rather than an uncaught exception.
   *
   * Returns false when the frame could not be handed to the stream at all.
   */
  private writeFrame(frame: Buffer, requestId: number, command: string): boolean {
    const child = this.child;
    if (!child || !this.canWrite()) {
      this.rejectRequest(
        requestId,
        new NativePdfError(
          `the native PDF engine is not running (request "${command}" was not sent)`,
          'worker_unavailable',
          requestId
        )
      );
      return false;
    }
    try {
      // The callback fires if the write fails after being queued (EPIPE/EIO);
      // the try/catch covers a throw from write() itself (e.g. ERR_STREAM_DESTROYED).
      child.stdin.write(frame, (error?: Error | null) => {
        if (error) {
          this.rejectRequest(
            requestId,
            new NativePdfError(
              `failed to write to the native PDF engine: ${error.message}`,
              'worker_write_failed',
              requestId
            )
          );
        }
      });
      return true;
    } catch (error) {
      this.rejectRequest(
        requestId,
        new NativePdfError(
          `failed to write to the native PDF engine: ${(error as Error).message}`,
          'worker_write_failed',
          requestId
        )
      );
      return false;
    }
  }

  /** Send one command and await its response frame. */
  private call<T>(command: WorkerCommand, params: Record<string, unknown> = {}, options: { timeoutMs?: number; expectsPixels?: boolean } = {}): Promise<T> {
    return this.ensureWorker().then(
      () =>
        new Promise<T>((resolve, reject) => {
          const child = this.child;
          if (!child || child.killed) {
            reject(new NativePdfError('the native PDF engine is not running', 'worker_unavailable'));
            return;
          }
          const requestId = this.nextRequestId++;
          const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
          const timer = setTimeout(() => {
            if (this.pending.delete(requestId)) {
              reject(
                new NativePdfError(
                  `native PDF request "${command}" timed out after ${timeoutMs} ms`,
                  'worker_timeout',
                  requestId
                )
              );
            }
          }, timeoutMs);

          this.pending.set(requestId, {
            resolve: resolve as (value: unknown) => void,
            reject,
            command,
            startedAt: Date.now(),
            timer,
            expectsPixels: options.expectsPixels ?? false
          });

          const body = Buffer.from(JSON.stringify({ cmd: command, ...params }), 'utf8');
          const frame = Buffer.allocUnsafe(4 + 5 + body.length);
          frame.writeUInt32LE(5 + body.length, 0);
          frame[4] = FrameType.Request;
          frame.writeUInt32LE(requestId, 5);
          body.copy(frame, 9);
          this.writeFrame(frame, requestId, command);
        })
    );
  }

  // ----------------------------------------------------------- public: PDF

  /**
   * Open a document (closing whatever was open) and return its structure.
   * `docId` identifies the document for subsequent calls.
   */
  async openDocument(
    filePath: string,
    password?: string
  ): Promise<{ docId: string; open: WireOpenResult; geometry: PageGeometry[] }> {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new NativePdfError(`PDF not found: ${resolved}`, 'not_found');
    }
    if (this.activeDocument?.path === resolved) {
      // Same document already loaded: reuse the worker's open handle and just
      // re-read the metadata, so a viewer reopen is nearly free.
      return {
        docId: this.activeDocument.docId,
        open: await this.rawInfo(resolved),
        geometry: this.geometryArray()
      };
    }

    const open = await this.call<WireOpenResult>('open', { path: resolved, password: password ?? '' }, { timeoutMs: 60_000 });
    this.generation += 1;
    const docId = `${crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12)}:${this.generation}`;
    this.activeDocument = { docId, path: resolved, pageCount: open.pageCount, generation: this.generation };
    this.geometry.clear();
    for (const page of open.pages) {
      this.geometry.set(page.index, { width: page.width, height: page.height, rotate: page.rotate });
    }
    return { docId, open, geometry: this.geometryArray() };
  }

  private geometryArray(): PageGeometry[] {
    return [...this.geometry.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value);
  }

  private async rawInfo(filePath: string): Promise<WireOpenResult> {
    const info = await this.call<WireInfoResult>('info');
    return {
      ok: true,
      path: filePath,
      pageCount: info.pageCount,
      needsPassword: false,
      pages: info.pages,
      outline: (await this.call<WireOutlineResult>('outline')).outline,
      metadata: info.metadata,
      engine: info.engine
    };
  }

  /** Document structure without re-opening (requires a loaded document). */
  async getDocumentInfo(): Promise<WireInfoResult | null> {
    if (!this.activeDocument) return null;
    try {
      return await this.call<WireInfoResult>('info');
    } catch {
      return null;
    }
  }

  /**
   * Re-open the document currently loaded, discarding cached state. Used after
   * a recompile writes a new PDF to the same path.
   */
  async reloadDocument(): Promise<WireOpenResult | null> {
    const current = this.activeDocument;
    if (!current) return null;
    this.activeDocument = null;
    this.geometry.clear();
    const reopened = await this.openDocument(current.path);
    return reopened.open;
  }

  /** Close the document and release worker-side caches. */
  async closeDocument(): Promise<boolean> {
    if (!this.activeDocument) return true;
    try {
      await this.call<WireSimpleOk>('close');
    } finally {
      this.activeDocument = null;
      this.geometry.clear();
    }
    return true;
  }

  getOpenDocument(): OpenDocumentState | null {
    return this.activeDocument;
  }

  getPageGeometry(page: number): PageGeometry | null {
    return this.geometry.get(page) ?? null;
  }

  /**
   * Rasterise a page (or a sub-rectangle of it).
   *
   * `requestId` is chosen by the caller so it can cancel a superseded render;
   * the worker echoes it back on the response.
   */
  async renderPage(
    requestId: number,
    params: RenderRequestParams,
    options: { timeoutMs?: number } = {}
  ): Promise<WireRenderResult> {
    if (!this.activeDocument) {
      throw new NativePdfError('no document is open', 'not_open');
    }
    const startedAt = Date.now();
    const result = await this.call<WireRenderResult>(
      'render',
      {
        requestId,
        page: params.page,
        scale: params.scale,
        rotate: params.rotate ?? 0,
        invert: params.invert ?? false,
        format: params.format ?? 'bgra',
        allowCache: params.allowCache ?? true,
        ...(params.clip ? { clip: params.clip } : {}),
        ...(params.tile ? { tile: params.tile } : {})
      },
      { timeoutMs: options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, expectsPixels: true }
    );
    this.options.onProgress?.({ page: params.page, cached: result.fromCache, ms: Date.now() - startedAt });
    return result;
  }

  /** Cancel a queued render. In-flight renders finish and are discarded. */
  async cancelRender(requestId: number): Promise<boolean> {
    if (!this.child) return false;
    try {
      await this.call<WireCancelResult>('cancel', { targetRequestId: requestId }, { timeoutMs: 15_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Structured text for a page: blocks -> lines -> spans, with PDF-point boxes. */
  async getPageText(page: number): Promise<WireTextResult> {
    if (!this.activeDocument) throw new NativePdfError('no document is open', 'not_open');
    return this.call<WireTextResult>('text', { page }, { timeoutMs: 60_000 });
  }

  /** The flat per-codepoint glyph model used for hit testing and selection. */
  async getPageGlyphs(page: number): Promise<WireGlyphsResult> {
    if (!this.activeDocument) throw new NativePdfError('no document is open', 'not_open');
    return this.call<WireGlyphsResult>('glyphs', { page }, { timeoutMs: 60_000 });
  }

  /** Page-scoped search. Omit `pages` to search the whole document. */
  async search(params: SearchRequestParams): Promise<WireSearchResult> {
    if (!this.activeDocument) throw new NativePdfError('no document is open', 'not_open');
    return this.call<WireSearchResult>(
      'search',
      {
        query: params.query,
        matchCase: params.matchCase ?? false,
        wholeWord: params.wholeWord ?? false,
        forward: params.forward ?? true,
        maxResults: params.maxResults ?? 512,
        ...(params.page !== undefined ? { page: params.page } : {}),
        ...(params.pages ? { pages: params.pages } : {})
      },
      { timeoutMs: 300_000 }
    );
  }

  /** Text selection rectangles and the selected string. */
  async select(params: SelectRequestParams): Promise<WireSelectionResult> {
    if (!this.activeDocument) throw new NativePdfError('no document is open', 'not_open');
    return this.call<WireSelectionResult>('select', { ...params }, { timeoutMs: 60_000 });
  }

  async getLinks(page: number): Promise<WireLinksResult> {
    if (!this.activeDocument) throw new NativePdfError('no document is open', 'not_open');
    return this.call<WireLinksResult>('links', { page }, { timeoutMs: 60_000 });
  }

  async getOutline(): Promise<WireOutlineResult> {
    if (!this.activeDocument) throw new NativePdfError('no document is open', 'not_open');
    return this.call<WireOutlineResult>('outline', {}, { timeoutMs: 60_000 });
  }

  /** Document metadata (already loaded, kept for API symmetry). */
  async getMetadata(): Promise<Record<string, string>> {
    if (!this.activeDocument) return {};
    const info = await this.call<WireInfoResult>('info', {}, { timeoutMs: 30_000 });
    return info.metadata;
  }

  /**
   * Tells the engine which pages are wanted so obsolete queued work is dropped
   * and prefetch is prioritised (Instructions.md §36/§38).
   */
  async setViewport(params: ViewportRequestParams): Promise<WireViewportResult> {
    if (!this.activeDocument) throw new NativePdfError('no document is open', 'not_open');
    return this.call<WireViewportResult>(
      'viewport',
      {
        visiblePages: params.visiblePages,
        adjacentPages: params.adjacentPages ?? [],
        nearbyPages: params.nearbyPages ?? [],
        scale: params.scale,
        rotate: params.rotate ?? 0,
        invert: params.invert ?? false,
        format: params.format ?? 'bgra',
        prefetch: params.prefetch ?? true
      },
      { timeoutMs: 60_000 }
    );
  }

  /** Tile grid for a page at a scale, so the renderer can request tiles lazily. */
  async getTiles(page: number, scale: number, rotate = 0): Promise<WireTilesResult> {
    if (!this.activeDocument) throw new NativePdfError('no document is open', 'not_open');
    return this.call<WireTilesResult>('tiles', { page, scale, rotate }, { timeoutMs: 30_000 });
  }

  /**
   * Continuous-scroll page placement, computed by light-pdf's DocumentLayout
   * inside the worker.
   *
   * Relayout() resolves the zoom (including the fit-page / fit-width / fit-
   * content sentinels), sizes and places every page for the requested display
   * mode, centres the canvas, applies right-to-left mirroring and reports how
   * much of each page the viewport shows. All page coordinates are canvas
   * coordinates in points at the returned `zoomReal`.
   */
  async getLayout(params: LayoutRequestParams): Promise<WireLayoutResult> {
    if (!this.activeDocument) throw new NativePdfError('no document is open', 'not_open');
    return this.call<WireLayoutResult>(
      'layout',
      {
        displayMode: params.displayMode ?? 'continuous',
        startPage: params.startPage ?? 1,
        viewPortWidth: params.viewPortWidth ?? 0,
        viewPortHeight: params.viewPortHeight ?? 0,
        viewPortX: params.viewPortX ?? 0,
        viewPortY: params.viewPortY ?? 0,
        zoomVirtual: params.zoomVirtual ?? 100,
        dpiFactor: params.dpiFactor ?? 1,
        rotation: params.rotation ?? 0,
        displayR2L: params.displayR2L ?? false,
        usePageZooms: params.usePageZooms ?? false,
        marginTop: params.marginTop ?? 0,
        marginRight: params.marginRight ?? 0,
        marginBottom: params.marginBottom ?? 0,
        marginLeft: params.marginLeft ?? 0,
        pageSpacingX: params.pageSpacingX ?? 0,
        pageSpacingY: params.pageSpacingY ?? 0
      },
      { timeoutMs: 60_000 }
    );
  }

  /** Render-cache and queue statistics, for diagnostics. */
  async getStats(): Promise<WireStatsResult> {
    if (!this.child) {
      return {
        ok: true,
        cacheEntries: 0,
        cacheBytes: 0,
        queued: 0,
        active: 0,
        servedFromCache: 0,
        rendered: 0,
        aborted: 0,
        evicted: 0,
        pendingTextTasks: 0
      };
    }
    return this.call<WireStatsResult>('stats', {}, { timeoutMs: 15_000 });
  }

  /** The page-space rectangle actually covered by the page's content. */
  async getPageContentBox(page: number): Promise<{ ok: true; page: number; rect: { x: number; y: number; width: number; height: number } }> {
    if (!this.activeDocument) throw new NativePdfError('no document is open', 'not_open');
    return this.call('pageContentBox', { page }, { timeoutMs: 60_000 });
  }

  /** Font names used by the given page range. */
  async getFontList(firstPage = 0, lastPage?: number): Promise<string[]> {
    if (!this.activeDocument) return [];
    const last = lastPage ?? this.activeDocument.pageCount - 1;
    const result = await this.call<{ ok: true; fonts: string[] }>('fontList', { firstPage, lastPage: last }, { timeoutMs: 120_000 });
    return result.fonts;
  }

  /** Round-trip check that the worker is alive and speaking the same protocol. */
  async ping(): Promise<boolean> {
    await this.ensureWorker();
    const child = this.child;
    if (!child) return false;
    return new Promise<boolean>((resolve) => {
      const requestId = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, 5000);
      this.pending.set(requestId, {
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
        reject: () => {
          clearTimeout(timer);
          resolve(false);
        },
        command: 'ping',
        startedAt: Date.now(),
        timer,
        expectsPixels: false
      });
      const body = Buffer.from('{}', 'utf8');
      const frame = Buffer.allocUnsafe(4 + 5 + body.length);
      frame.writeUInt32LE(5 + body.length, 0);
      frame[4] = FrameType.Ping;
      frame.writeUInt32LE(requestId, 5);
      body.copy(frame, 9);
      // A failed write resolves the pending entry with `reject`, which this
      // caller maps to "not alive".
      this.writeFrame(frame, requestId, 'ping');
    });
  }

  /** Stop the worker. Safe to call more than once. */
  async dispose(): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    if (!child) return;
    this.failAllPending(new NativePdfError('the native PDF engine was shut down', 'shutting_down'));

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      if (this.canWrite()) {
        try {
          const frame = Buffer.alloc(9);
          frame.writeUInt32LE(5, 0);
          frame[4] = FrameType.Shutdown;
          child.stdin.write(frame, (error?: Error | null) => {
            if (error) {
              try {
                child.stdin.end();
              } catch {
                // Already gone; the kill timer below finishes the job.
              }
              return;
            }
            try {
              child.stdin.end();
            } catch {
              // Already gone.
            }
          });
        } catch {
          // Fall through to the kill below.
        }
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
      }, 3000);
      child.once('exit', () => clearTimeout(killTimer));
    });

    this.child = null;
    this.readyInfo = null;
    this.activeDocument = null;
    this.geometry.clear();
  }
}

/**
 * Process-wide engine instance. `autoBuild` defaults to true outside a packaged
 * app so a developer who edits the C++ and forgets to rebuild still gets a
 * working engine, but a packaged app never shells out to a build script.
 */
const isPackaged = Boolean((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath);

export const nativePdfEngine = new NativePdfEngine({
  autoBuild: !isPackaged,
  onLog: (message) => {
    if (message.level === 'error') {
      // eslint-disable-next-line no-console
      console.error(`[native-pdf] ${message.message}`);
    }
  },
  onCrash: (message, pendingRequests) => {
    // Surfaced so the renderer can show it rather than hanging on a promise that
    // will never settle (Instructions.md §61).
    // eslint-disable-next-line no-console
    console.error(`[native-pdf] ${message} (${pendingRequests} request(s) abandoned)`);
  }
});