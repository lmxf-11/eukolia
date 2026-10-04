/**
 * PDF and SyncTeX IPC handlers (Electron main process).
 *
 * Maps the frozen main<->renderer contract in `src/shared/ipc.ts` onto the
 * native engine bridge in `src/main/pdf/nativePdfEngine.ts`. This layer owns:
 *
 *  - path resolution, so the renderer can keep using project-relative paths;
 *  - page-index conventions (the contract is 0-based for PDF, 1-based for
 *    SyncTeX, matching what MiKTeX's `synctex` reports);
 *  - translating worker wire shapes into the exact contract types;
 *  - forwarding engine progress and failures to the renderer as events.
 *
 * Nothing here does CPU work: every call is handed to the worker process and
 * awaited, so the main thread only marshals messages (Instructions.md §65).
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { IPC } from '../../shared/ipc';
import type {
  PdfLink,
  PdfOpenResult,
  PdfOutlineItem,
  PdfRect,
  PdfRenderRequest,
  PdfRenderResult,
  PdfSearchMatch,
  PdfSelectRequest,
  PdfSelectionResult,
  PdfTextBlock,
  PdfTileCapabilities,
  PdfViewportRequest,
  PdfViewportResult,
  SynctexForwardRequest,
  SynctexForwardResult,
  SynctexInverseRequest,
  SynctexInverseResult
} from '../../shared/ipc';
import { NativePdfError, nativePdfEngine } from '../pdf/nativePdfEngine';
import { syncTexEngine } from '../pdf/synctexEngine';
import type { WireOutlineItem, WireRect } from '../pdf/workerProtocol';

/** Path -> docId for the document currently loaded in the worker. */
let activeDocPath: string | null = null;
let activeDocId: string | null = null;
/** Serialises open/close so two rapid opens cannot interleave. */
let documentQueue: Promise<unknown> = Promise.resolve();
let renderSequence = 0;
const ownedRenders = new Map<string, number>();

function enqueueDocumentWork<T>(work: () => Promise<T>): Promise<T> {
  const next = documentQueue.then(work, work);
  // Keep the chain alive even when a caller's promise rejects.
  documentQueue = next.catch(() => undefined);
  return next;
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function emitError(message: string, source = 'pdf'): void {
  broadcast(IPC.pdf.onError, { path: activeDocPath ?? '', message, source });
}

/**
 * Resolve a PDF path the renderer sent. Accepts absolute paths, paths relative
 * to the project, and bare file names, the same tolerance the other handlers
 * provide.
 */
function resolvePdfPath(targetPath: string): string {
  if (!targetPath) return targetPath;
  if (fs.existsSync(targetPath)) return path.resolve(targetPath);

  const appPath = (() => {
    try {
      return app.getAppPath();
    } catch {
      return process.cwd();
    }
  })();
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '';

  const candidates = [
    path.resolve(process.cwd(), targetPath),
    path.resolve(appPath, targetPath),
    path.resolve(appPath, '..', targetPath),
    resourcesPath ? path.resolve(resourcesPath, targetPath) : '',
    resourcesPath ? path.resolve(resourcesPath, path.basename(targetPath)) : ''
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(targetPath);
}

function toRect(rect: WireRect | undefined): PdfRect {
  if (!rect) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function toOutline(items: WireOutlineItem[]): PdfOutlineItem[] {
  return items.map((item) => ({
    title: item.title,
    page: item.page,
    uri: item.uri,
    children: toOutline(item.children ?? [])
  }));
}

function describeError(error: unknown): string {
  if (error instanceof NativePdfError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * How many page indices one viewport publication may carry.
 *
 * `PDFVIEWER.md` §7 wants the main process to validate what the renderer asks for. A
 * page index is the one field here that indexes native memory: the worker checks its
 * own range, but a renderer bug that sends a hundred thousand entries is work in this
 * process before the worker ever sees it. A viewport holds a handful of pages, so 64
 * is far past anything legitimate.
 */
const MAX_VIEWPORT_PAGES = 64;

/** Clamp a page list to the open document, drop duplicates and non-integers. */
function sanitisePageList(pages: readonly number[], pageCount: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of pages) {
    if (out.length >= MAX_VIEWPORT_PAGES) break;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (!Number.isInteger(value)) continue;
    const index = value;
    if (index < 0) continue;
    if (pageCount > 0 && index >= pageCount) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    out.push(index);
  }
  return out;
}

/**
 * Validate a tile address against the worker's own grid rules.
 *
 * Returns `null` for anything the worker's 16-bit fields could not carry, or that
 * falls outside its `2^res` grid — the same two checks `HandleRender` performs,
 * applied at the boundary so a renderer bug is rejected before a serialisation. The
 * `15` is the worker's `kMaxTileRes`, duplicated deliberately: it is a property of
 * the address fields rather than of a build, and consulting a negotiated value here
 * would let a stale handshake admit an address an older worker would narrow silently.
 */
function sanitiseTileAddress(tile: PdfRenderRequest['tile']): { res: number; row: number; col: number } | null {
  if (!tile || typeof tile !== 'object') return null;
  const res = Number(tile.res);
  const row = Number(tile.row);
  const col = Number(tile.col);
  for (const value of [res, row, col]) {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  }
  if (res < 0 || res > 15) return null;
  const grid = 1 << res;
  if (row < 0 || row >= grid || col < 0 || col >= grid) return null;
  return { res, row, col };
}

/** Ensure the requested document is the one the worker has open. */
async function ensureDocument(pdfPath: string, password?: string): Promise<{ docId: string; pageCount: number }> {
  const resolved = resolvePdfPath(pdfPath);
  if (activeDocId && activeDocPath === resolved) {
    const doc = nativePdfEngine.getOpenDocument();
    // Page work uses the committed snapshot. Only explicit pdfOpen refreshes it:
    // a compiler write must not trigger hidden swaps between individual tiles.
    if (doc && doc.path === resolved) {
      return { docId: doc.docId, pageCount: doc.pageCount };
    }
  }
  const opened = await openDocumentTolerant(resolved, password);
  activeDocPath = resolved;
  activeDocId = opened.docId;
  return { docId: opened.docId, pageCount: opened.open.pageCount };
}

/**
 * A read failure that *could* simply be a file still being written.
 *
 * `pdflatex` writes its output *in place* — `Eukolia.pdf` is truncated and then
 * refilled — so part-way through there is a real file on disk with a valid
 * `%PDF-` header and either no page tree or an unterminated one. Measured against
 * the real document, that state fails as:
 *
 *   - header present, catalog but no `/Pages`  -> "document contains no pages"
 *   - 40 % of the bytes present                -> "array not closed before end of file"
 *
 * Neither is distinguishable from real damage by the message alone, which is why
 * the caller also requires the file to be *changing* before it retries. This
 * matcher only says "worth another look"; `fileIsStillMoving` decides.
 */
function mightBePartialRead(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  return (
    message.includes('no pages') ||
    message.includes('array not closed') ||
    message.includes('unexpected end of file') ||
    message.includes('unexpected eof') ||
    message.includes('premature end') ||
    message.includes('cannot find startxref') ||
    message.includes('no objects found') ||
    message.includes('syntax error') ||
    message.includes('broken file') ||
    // A half-written cross-reference table: measured on a file refilled in place,
    // this is what MuPDF reports for the states between "no page tree" and
    // "array not closed".
    message.includes('invalid key in dict')
  );
}

/** Size and mtime together: a writer may land inside one filesystem tick. */
function fileStamp(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Open the document, tolerating a read that lands mid-write.
 *
 * light-pdf does not retry: `ReloadDocument` builds the replacement controller
 * first and, when that fails during an auto-refresh, postpones the whole reload
 * with a "this file is stale" mark and tries again on the next watcher event
 * (`LightPDF.cpp:1972-1977`). Its stale document stays on screen throughout,
 * because the old controller is only replaced once a new one exists.
 *
 * The worker preserves an immutable committed snapshot on failure. Short retries
 * here handle a moving file; the viewer keeps the old preview and retries later
 * if the replacement is still incomplete.
 *
 * **The retry is gated on the file having changed since the previous attempt.**
 * Without that, a PDF that is genuinely damaged — and therefore fails the same
 * way every time — would be opened four times and its real error delayed by 1.5 s
 * for nothing. A truncated-but-static file fails on the first attempt, exactly as
 * it did before; only a file that is still growing or being rewritten is waited
 * on, and that is precisely the case this exists for.
 */
async function openDocumentTolerant(
  resolved: string,
  password?: string
): Promise<Awaited<ReturnType<typeof nativePdfEngine.openDocument>>> {
  const delaysMs = [150, 300, 450, 600];
  let stamp = fileStamp(resolved);
  for (let attempt = 0; ; attempt++) {
    try {
      return await nativePdfEngine.openDocument(resolved, password, true);
    } catch (error) {
      if (attempt >= delaysMs.length || !mightBePartialRead(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
      const next = fileStamp(resolved);
      // Unchanged across the wait: this is not a write in progress, so the error
      // is the real one and belongs to the caller.
      if (next === null || next === stamp) throw error;
      stamp = next;
    }
  }
}

export function registerPdfHandlers(): void {
  // --------------------------------------------------------------- availability
  ipcMain.handle(IPC.pdf.available, async () => {
    try {
      return nativePdfEngine.isAvailable();
    } catch {
      return false;
    }
  });

  /**
   * Capability negotiation for the tiled route.
   *
   * `PDFVIEWER.md` §7: "Add capability negotiation for tiled presentation and
   * viewport updates, forwarding existing native functionality through main/preload
   * with runtime validation." This is answered from the startup handshake, so it
   * costs no worker round trip and cannot itself fail — a renderer must be able to ask
   * this before it opens a document.
   */
  ipcMain.handle(IPC.pdf.tileCapabilities, async (): Promise<PdfTileCapabilities> => {
    const caps = nativePdfEngine.getTileCapabilities();
    return {
      available: caps.available,
      tiledRender: caps.tiledRender,
      viewport: caps.viewport,
      maxTileRes: caps.maxTileRes,
      targetTileSize: caps.targetTileSize,
      protocolVersion: caps.protocolVersion,
      engine: caps.engine,
      mupdfVersion: caps.mupdfVersion
    };
  });

  /**
   * Publish the viewport to the native cache in one call.
   *
   * `PDFVIEWER.md` §7: "Do not hide native prefetch behind a route that also makes the
   * renderer issue identical jobs. Choose one scheduler as authoritative." So
   * `prefetch` defaults to **false** here: the renderer's scheduler is authoritative
   * for this viewer, and the native cache's job is to hold what the renderer asked
   * for and to drop what the viewport no longer wants. The benchmark harness passes
   * `prefetch: true` when it wants the reference's own prediction policy instead.
   */
  ipcMain.handle(IPC.pdf.viewport, async (_event, request: PdfViewportRequest): Promise<PdfViewportResult> => {
    if (!request || !Number.isFinite(request.scale) || request.scale <= 0 || !Array.isArray(request.visiblePages) ||
      (request.adjacentPages !== undefined && !Array.isArray(request.adjacentPages)) ||
      (request.nearbyPages !== undefined && !Array.isArray(request.nearbyPages))) {
      throw new Error('pdf:viewport requires { path, visiblePages, scale }');
    }
    const resolved = resolvePdfPath(request.path);
    await ensureDocument(resolved);
    const open = nativePdfEngine.getOpenDocument();
    const pageCount = open?.pageCount ?? 0;
    const result = await nativePdfEngine.setViewport({
      visiblePages: sanitisePageList(request.visiblePages, pageCount),
      adjacentPages: sanitisePageList(request.adjacentPages ?? [], pageCount),
      nearbyPages: sanitisePageList(request.nearbyPages ?? [], pageCount),
      scale: request.scale > 0 ? request.scale : 1,
      rotate: request.rotate ?? 0,
      invert: request.invert ?? false,
      format: 'rgba',
      prefetch: request.prefetch ?? false
    });
    return {
      queued: result.queued,
      cacheEntries: result.cacheEntries,
      cacheBytes: result.cacheBytes,
      queuedTotal: result.queuedTotal
    };
  });

  // ----------------------------------------------------------------- open/close
  ipcMain.handle(IPC.pdf.open, async (_event, pdfPath: string, password?: string): Promise<PdfOpenResult> => {
    return enqueueDocumentWork(async () => {
      const resolved = resolvePdfPath(pdfPath);
      if (!fs.existsSync(resolved)) {
        throw new Error(`PDF not found: ${resolved}`);
      }
      try {
        const opened = await openDocumentTolerant(resolved, password);
        activeDocPath = resolved;
        activeDocId = opened.docId;
        return {
          path: resolved,
          unchanged: opened.open.unchanged,
          docId: opened.docId,
          pageCount: opened.open.pageCount,
          pages: opened.open.pages
            .slice()
            .sort((a, b) => a.index - b.index)
            .map((page) => ({ width: page.width, height: page.height })),
          outline: toOutline(opened.open.outline),
          metadata: opened.open.metadata ?? {},
          needsPassword: opened.open.needsPassword,
          engine: opened.open.engine
        };
      } catch (error) {
        emitError(describeError(error), 'open');
        throw error;
      }
    });
  });

  ipcMain.handle(IPC.pdf.close, async (_event, pdfPath?: string): Promise<boolean> => {
    return enqueueDocumentWork(async () => {
      if (pdfPath) {
        const resolved = resolvePdfPath(pdfPath);
        // Only close when the request refers to the document we hold; the worker
        // has a single document slot.
        if (activeDocPath && activeDocPath !== resolved) return false;
      }
      await nativePdfEngine.closeDocument();
      activeDocPath = null;
      activeDocId = null;
      return true;
    });
  });

  // -------------------------------------------------------------------- render
  ipcMain.handle(IPC.pdf.render, async (event, request: PdfRenderRequest): Promise<PdfRenderResult> => {
    if (!request || !Number.isInteger(request.page) || request.page < 0 ||
      !Number.isSafeInteger(request.requestId) || request.requestId <= 0 ||
      !Number.isFinite(request.scale) || request.scale <= 0 ||
      (request.rotate !== undefined && ![0, 90, 180, 270].includes(request.rotate))) {
      throw new Error('pdf:render requires { requestId, path, page, scale }');
    }
    const resolved = resolvePdfPath(request.path);
    try {
      await ensureDocument(resolved);
    } catch (error) {
      emitError(describeError(error), 'render');
      throw error;
    }

    const scale = request.scale > 0 ? request.scale : 1;
    const rotate = request.rotate ?? 0;
    const invert = request.invert ?? false;

    /**
     * A tile request is validated before it reaches the worker, because the worker's
     * tile fields are 16-bit and its grid check is the last line of defence.
     * `PDFVIEWER.md` §7 requires "runtime validation" of what the renderer asks for:
     * a renderer bug must produce a clean rejection, not a silently wrong region.
     */
    const tile = sanitiseTileAddress(request.tile);
    if (request.tile !== undefined && tile === null) {
      throw new Error('pdf:render tile address is not a finite integer within its resolution grid');
    }

    try {
      const ownerKey = `${event.sender.id}/${request.requestId}`;
      if (ownedRenders.has(ownerKey)) throw new Error('duplicate active PDF request');
      const nativeId = ++renderSequence;
      ownedRenders.set(ownerKey, nativeId);
      const result = await nativePdfEngine.renderPage(nativeId, {
        page: request.page,
        scale,
        rotate,
        invert,
        // The worker renders RGB and reports it as `rgba` (four components with alpha).
        // The field itself only chooses between colour and gray, but its name should
        // not claim a channel order nothing produces any more.
        format: 'rgba',
        allowCache: request.allowCache ?? true,
        ...(request.clip
          ? {
              clip: {
                x: request.clip.x,
                y: request.clip.y,
                width: request.clip.width,
                height: request.clip.height
              }
            }
          : {}),
        ...(tile ? { tile } : {}),
        ...(typeof request.targetTileSize === 'number' && Number.isFinite(request.targetTileSize) && request.targetTileSize > 0
          ? { targetTileSize: Math.round(request.targetTileSize) }
          : {})
      }).finally(() => { ownedRenders.delete(ownerKey); });

      // The worker returns 4-channel RGBA (it is asked for `format: 'rgba'`
      // above), which is what Chromium's ImageData wants. `order` still comes
      // from the worker so a future grayscale or RGB request stays consistent
      // with the contract, but the contract's union has no 'gray': a 1-channel
      // buffer is reported as 'rgb' because a grayscale sample maps straight
      // onto all three channels.
      const order: PdfRenderResult['order'] =
        result.order === 'gray' ? 'rgb' : result.order;
      return {
        requestId: request.requestId,
        page: result.page,
        width: result.width,
        height: result.height,
        stride: result.stride,
        channels: result.channels,
        order,
        pageRect: toRect(result.pageRect),
        pixels: result.pixels,
        fromEngineCache: result.fromCache
      };
    } catch (error) {
      // A cancelled render is not an error worth telling the user about.
      const message = describeError(error);
      if (!/cancel/i.test(message)) {
        emitError(message, 'render');
      }
      throw error;
    }
  });

  ipcMain.handle(IPC.pdf.cancelRender, async (event, requestId: number): Promise<boolean> => {
    if (typeof requestId !== 'number') return false;
    const nativeId = ownedRenders.get(`${event.sender.id}/${requestId}`);
    return nativeId === undefined ? false : nativePdfEngine.cancelRender(nativeId);
  });

  // ---------------------------------------------------------------------- text
  ipcMain.handle(IPC.pdf.text, async (_event, pdfPath: string, page: number): Promise<PdfTextBlock[]> => {
    const resolved = resolvePdfPath(pdfPath);
    try {
      await ensureDocument(resolved);
    } catch (error) {
      emitError(describeError(error), 'text');
      throw error;
    }
    if (typeof page !== 'number' || page < 0) return [];

    try {
      const text = await nativePdfEngine.getPageText(page);
      return text.blocks.map((block) => ({
        bbox: toRect(block.bbox),
        lines: block.lines.map((line) => ({
          bbox: toRect(line.bbox),
          spans: line.spans.map((span) => ({
            text: span.text,
            bbox: toRect(span.bbox),
            font: span.font,
            size: span.size
          }))
        }))
      }));
    } catch (error) {
      // "no_text" is a normal outcome for image-only pages: report an empty
      // page rather than an error the viewer has to special-case.
      if (error instanceof NativePdfError && error.code === 'no_text') return [];
      throw error;
    }
  });

  // -------------------------------------------------------------------- search
  ipcMain.handle(
    IPC.pdf.search,
    async (
      _event,
      pdfPath: string,
      query: string,
      options?: { caseSensitive?: boolean; regex?: boolean; maxResults?: number; wholeWord?: boolean }
    ): Promise<PdfSearchMatch[]> => {
      const resolved = resolvePdfPath(pdfPath);
      try {
        await ensureDocument(resolved);
      } catch (error) {
        emitError(describeError(error), 'search');
        throw error;
      }
      if (!query) return [];

      // `regex` is accepted by the contract but the engine matches literal text
      // with light-pdf's own multi-line-aware matcher; a caller asking for a
      // regex gets a clear failure instead of a silently wrong result.
      if (options?.regex) {
        throw new Error('pdf:search does not support regular expressions; use a literal query');
      }

      const result = await nativePdfEngine.search({
        query,
        matchCase: options?.caseSensitive ?? false,
        wholeWord: options?.wholeWord ?? false,
        forward: true,
        maxResults: options?.maxResults ?? 512
      });

      return result.matches.map((match) => ({
        page: match.page,
        rects: match.rects.map(toRect)
      }));
    }
  );

  // --------------------------------------------------------------------- links
  ipcMain.handle(IPC.pdf.links, async (_event, pdfPath: string, page: number): Promise<PdfLink[]> => {
    const resolved = resolvePdfPath(pdfPath);
    try {
      await ensureDocument(resolved);
    } catch (error) {
      emitError(describeError(error), 'links');
      throw error;
    }
    if (typeof page !== 'number' || page < 0) return [];

    const result = await nativePdfEngine.getLinks(page);
    return result.links.map((link) => ({
      rect: toRect(link.rect),
      uri: link.uri,
      page: link.page
    }));
  });

  // ------------------------------------------------------------------- outline
  ipcMain.handle(IPC.pdf.outline, async (_event, pdfPath: string): Promise<PdfOutlineItem[]> => {
    const resolved = resolvePdfPath(pdfPath);
    try {
      await ensureDocument(resolved);
    } catch (error) {
      emitError(describeError(error), 'outline');
      throw error;
    }
    const result = await nativePdfEngine.getOutline();
    return toOutline(result.outline);
  });

  // ----------------------------------------------------------------- selection
  //
  // `TextSelection.cpp` is compiled into the worker unchanged, so selection is
  // entirely native: this handler carries the gesture across and converts the
  // rectangles to page coordinates.
  ipcMain.handle(
    IPC.pdf.select,
    async (_event, pdfPath: string, request: PdfSelectRequest): Promise<PdfSelectionResult> => {
      const resolved = resolvePdfPath(pdfPath);
      try {
        await ensureDocument(resolved);
      } catch (error) {
        emitError(describeError(error), 'select');
        throw error;
      }

      const page = Math.max(0, Math.trunc(request?.page ?? 1) - 1);
      const result = await nativePdfEngine.select({
        page,
        mode: request?.mode ?? 'range',
        startX: request?.startX,
        startY: request?.startY,
        endX: request?.endX,
        endY: request?.endY,
        x: request?.x,
        y: request?.y
      });

      return {
        page: (result.endPage ?? result.page ?? page) + 1,
        text: result.text ?? '',
        rects: (result.rects ?? []).map(toRect),
        startPage: result.startPage,
        endPage: result.endPage
      };
    }
  );

  // ---------------------------------------------------------------------- info
  ipcMain.handle(IPC.pdf.info, async (_event, pdfPath: string): Promise<PdfOpenResult | null> => {
    const resolved = resolvePdfPath(pdfPath);
    if (!fs.existsSync(resolved)) return null;
    try {
      const opened = await enqueueDocumentWork(() => openDocumentTolerant(resolved));
      activeDocPath = resolved;
      activeDocId = opened.docId;
      return {
        path: resolved,
        pageCount: opened.open.pageCount,
        pages: opened.open.pages
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((page) => ({ width: page.width, height: page.height })),
        outline: toOutline(opened.open.outline),
        metadata: opened.open.metadata ?? {},
        needsPassword: opened.open.needsPassword,
        engine: opened.open.engine
      };
    } catch (error) {
      emitError(describeError(error), 'info');
      return null;
    }
  });

  // ------------------------------------------------------------------- synctex
  ipcMain.handle(IPC.synctex.available, async (): Promise<boolean> => syncTexEngine.isAvailable());

  ipcMain.handle(
    IPC.synctex.forward,
    async (_event, request: SynctexForwardRequest): Promise<SynctexForwardResult | null> => {
      if (!request?.synctexPath || typeof request.line !== 'number') {
        throw new Error('synctex:forward requires { synctexPath, file, line }');
      }
      return syncTexEngine.sourceToDoc(request);
    }
  );

  ipcMain.handle(
    IPC.synctex.inverse,
    async (_event, request: SynctexInverseRequest): Promise<SynctexInverseResult | null> => {
      if (!request?.synctexPath || typeof request.page !== 'number') {
        throw new Error('synctex:inverse requires { synctexPath, page, x, y }');
      }
      return syncTexEngine.docToSource(request);
    }
  );
}

/** Stop the worker and drop every handler. Called on application quit. */
export function disposePdfHandlers(): void {
  for (const channel of [
    IPC.pdf.available,
    IPC.pdf.open,
    IPC.pdf.close,
    IPC.pdf.render,
    IPC.pdf.cancelRender,
    IPC.pdf.tileCapabilities,
    IPC.pdf.viewport,
    IPC.pdf.text,
    IPC.pdf.search,
    IPC.pdf.links,
    IPC.pdf.outline,
    IPC.pdf.select,
    IPC.pdf.info,
    IPC.synctex.available,
    IPC.synctex.forward,
    IPC.synctex.inverse
  ]) {
    ipcMain.removeHandler(channel);
  }
  activeDocPath = null;
  activeDocId = null;
  void nativePdfEngine.dispose();
}
