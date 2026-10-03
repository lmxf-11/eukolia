/**
 * Eukolia — renderer diagnostics.
 *
 * Errors from the renderer are forwarded to the main process log so a crash or a
 * rejected promise is diagnosable after the fact, rather than only appearing in
 * a devtools console the user never opens.
 */

let reported = 0;
const MAX_REPORTS = 200;

export function logRendererError(error: unknown): void {
  if (reported >= MAX_REPORTS) return;
  reported++;

  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  // eslint-disable-next-line no-console
  console.error('[eukolia]', error);

  try {
    void window.eukoliaApi?.log('error', `renderer: ${message}`);
  } catch {
    /* logging must never throw */
  }
}

export function logRendererWarning(message: string): void {
  try {
    void window.eukoliaApi?.log('warn', `renderer: ${message}`);
  } catch {
    /* ignore */
  }
}
