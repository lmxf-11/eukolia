/**
 * Eukolia — document analysis over the IPC bridge (Electron main process).
 *
 * The handler is deliberately thin: it validates what arrived and hands the work
 * to `analysis/analyzer.ts`. Everything interesting about *why* the analyzer lives
 * here rather than in the renderer is documented there.
 *
 * The one decision this file makes is what a failure means. A document the parser
 * cannot handle is answered with `{ error }` — the caller logs it and moves on to
 * the next file. A promise this handler *rejects* means the channel itself is
 * unusable (the parser would not load, or the arguments were not what this channel
 * accepts), and the renderer answers that by stopping its use of the channel and
 * analysing on its own thread instead. Conflating the two would either lose the
 * project's macro index to one bad file or cost 200 log lines to one broken bundle.
 */

import { ipcMain } from 'electron';
import { IPC, type AnalyzeDocumentResponse } from '../../shared/ipc';
import { analyzeDocument } from '../analysis/analyzer';

export function registerAnalysisHandlers(): void {
  ipcMain.handle(
    IPC.analysis.analyze,
    async (_event, text: unknown, uri: unknown): Promise<AnalyzeDocumentResponse> => {
      /*
       * Validated here rather than trusted, like every other channel: the renderer
       * is the least privileged side of this boundary, and the cost of being wrong
       * is a `TypeError` in the main process's log rather than a confusing failure
       * inside the parser.
       */
      if (typeof text !== 'string') {
        throw new TypeError('analysis:analyze expects the document text as a string');
      }
      if (typeof uri !== 'string') {
        throw new TypeError('analysis:analyze expects the document uri as a string');
      }
      return analyzeDocument(text, uri);
    }
  );
}
