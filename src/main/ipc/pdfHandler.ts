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
/**
 * The file's modification time when it was opened.
 *
 * The identity of a document is its *content*, not its path, and a LaTeX build
 * rewrites the PDF at the path that is already open. Without this, `ensureDocument`
 * hands back the previous handle — and the previous page count — for a file that
 * has been replaced on disk, so the viewer keeps reporting a one-page document
 * after the rebuild that made it two. `ReopenDocument` in light-pdf's terms.
 */
let activeDocMtimeMs: number | null = null;
/** Serialises open/close so two rapid opens cannot interleave. */
let documentQueue: Promise<unknown> = Promise.resolve();

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

/** Ensure the requested document is the one the worker has open. */
async function ensureDocument(pdfPath: string, password?: string): Promise<{ docId: string; pageCount: number }> {
  const resolved = resolvePdfPath(pdfPath);
  if (activeDocId && activeDocPath === resolved) {
    const doc = nativePdfEngine.getOpenDocument();
    // The cached handle is only reusable while the file is the one that was
    // opened. A rebuild replaces it in place, so the modification time is what
    // decides — see `activeDocMtimeMs`.
    if (doc && activeDocMtimeMs !== null && currentMtimeMs(resolved) === activeDocMtimeMs) {
      return { docId: doc.docId, pageCount: doc.pageCount };
    }
  }
  const opened = await nativePdfEngine.openDocument(resolved, password);
  activeDocPath = resolved;
  activeDocId = opened.docId;
  activeDocMtimeMs = currentMtimeMs(resolved);
  return { docId: opened.docId, pageCount: opened.open.pageCount };
}

/** The file's modification time, or `null` when it cannot be read. */
function currentMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
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

  // ----------------------------------------------------------------- open/close
  ipcMain.handle(IPC.pdf.open, async (_event, pdfPath: string, password?: string): Promise<PdfOpenResult> => {
    return enqueueDocumentWork(async () => {
      const resolved = resolvePdfPath(pdfPath);
      if (!fs.existsSync(resolved)) {
        throw new Error(`PDF not found: ${resolved}`);
      }
      try {
        const opened = await nativePdfEngine.openDocument(resolved, password);
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
      activeDocMtimeMs = null;
      return true;
    });
  });

  // -------------------------------------------------------------------- render
  ipcMain.handle(IPC.pdf.render, async (_event, request: PdfRenderRequest): Promise<PdfRenderResult> => {
    if (!request || typeof request.page !== 'number') {
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

    try {
      const result = await nativePdfEngine.renderPage(request.requestId, {
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
          : {})
      });

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
        pixels: result.pixels
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

  ipcMain.handle(IPC.pdf.cancelRender, async (_event, requestId: number): Promise<boolean> => {
    if (typeof requestId !== 'number') return false;
    return nativePdfEngine.cancelRender(requestId);
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
      const opened = await enqueueDocumentWork(() => nativePdfEngine.openDocument(resolved));
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
  activeDocMtimeMs = null;
  void nativePdfEngine.dispose();
}
