/**
 * Eukolia — URI protocol handler (`eukolia://`).
 *
 * Supported forms (Instructions.md §66):
 *
 *   eukolia://file/C%3A/path/to/main.tex[:line[:column]]   (the `vscode://` form)
 *   eukolia://open?file=C%3A%5Cpath%5Cto%5Cmain.tex[&line=42][&column=3]
 *   eukolia://goto?file=...&line=42&column=3
 *   eukolia://project?path=C%3A%5Cpath%5Cto%5Cproject
 *
 * The `file` host exists so that links copied from editors and tools that speak
 * the `vscode://file/…:line:column` convention work after changing the scheme,
 * which is what "openable from a browser like `vscode://`" means in practice: a
 * page can link straight to a document, a folder, or a position inside one.
 *
 * Requests arrive from browsers and other applications, so every argument is
 * validated and normalised before it reaches the renderer (§68). Unknown hosts,
 * schemes and non-existent paths are rejected rather than forwarded.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { IPC } from '../shared/ipc';
import { logToFile, rememberWorkspace } from './ipc/appHandler';

const SCHEME = 'eukolia';

/**
 * The executable that will handle `eukolia://` links.
 *
 * This matters to the user: the browser's "A website wants to open this
 * application" prompt names the *executable* registered for the scheme, not the
 * application's display name. A packaged build registers `Eukolia.exe` and the
 * prompt says "Eukolia"; a development run registers `electron.exe` and the
 * prompt says "Electron", because that is the binary that will be launched.
 */
export function protocolHandlerCommand(): { executable: string; args: string[] } {
  if (process.defaultApp && process.argv.length >= 2) {
    return { executable: process.execPath, args: [path.resolve(process.argv[1])] };
  }
  return { executable: process.execPath, args: [] };
}

/** True when the current run is the development launcher. */
export const isDevelopmentRun = (): boolean => Boolean(process.defaultApp);

export function registerEukoliaProtocol(): void {
  const { executable, args } = protocolHandlerCommand();
  const registered = args.length > 0
    ? app.setAsDefaultProtocolClient(SCHEME, executable, args)
    : app.setAsDefaultProtocolClient(SCHEME);

  logToFile(
    registered ? 'info' : 'warn',
    `eukolia protocol: ${SCHEME}:// ${registered ? 'registered to' : 'could not be registered to'} ` +
      `${executable}${args.length ? ` ${args.join(' ')}` : ''}`
  );
}

export interface ParsedProtocolRequest {
  kind: 'open' | 'project';
  path: string;
  line?: number;
  column?: number;
}

/**
 * Parses and validates a protocol URL.
 * Returns `null` (and logs) for anything malformed, unknown or non-existent.
 */
export function parseProtocolUrl(rawUrl: string): ParsedProtocolRequest | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    logToFile('warn', `eukolia protocol: unparseable url ${rawUrl}`);
    return null;
  }

  if (parsed.protocol !== `${SCHEME}:`) {
    logToFile('warn', `eukolia protocol: unexpected scheme ${parsed.protocol}`);
    return null;
  }

  // `new URL` lower-cases the host; treat an empty host as unknown.
  const host = (parsed.hostname || parsed.pathname.replace(/^\/+/, '')).toLowerCase();

  const toAbsolute = (value: string | null): string | null => {
    if (!value) return null;
    let candidate = value;
    try {
      candidate = decodeURIComponent(value);
    } catch {
      /* keep the raw value when it is not valid percent-encoding */
    }
    if (candidate.includes('\u0000')) return null;
    const resolved = path.resolve(candidate);
    return path.isAbsolute(resolved) ? resolved : null;
  };

  const parsePositiveInt = (value: string | null): number | undefined => {
    if (!value) return undefined;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  if (host === 'open') {
    const filePath = toAbsolute(parsed.searchParams.get('file') ?? parsed.searchParams.get('path'));
    if (!filePath) {
      logToFile('warn', `eukolia protocol: open without a usable file parameter (${rawUrl})`);
      return null;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      logToFile('warn', `eukolia protocol: file does not exist (${filePath})`);
      return null;
    }
    return {
      kind: 'open',
      path: filePath,
      line: parsePositiveInt(parsed.searchParams.get('line')),
      column: parsePositiveInt(parsed.searchParams.get('column'))
    };
  }

  if (host === 'project') {
    const projectPath = toAbsolute(parsed.searchParams.get('path') ?? parsed.searchParams.get('folder'));
    if (!projectPath) {
      logToFile('warn', `eukolia protocol: project without a usable path parameter (${rawUrl})`);
      return null;
    }
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      logToFile('warn', `eukolia protocol: project directory does not exist (${projectPath})`);
      return null;
    }
    return { kind: 'project', path: projectPath };
  }

  // `eukolia://file/<path>[:line[:column]]` — the `vscode://file/…` form, so a
  // link written for VS Code works here after changing the scheme. The path is
  // the whole pathname, because a Windows drive letter is a path segment rather
  // than a host.
  if (host === 'file' || host === 'goto') {
    // `new URL` gives `/C:/dir/file.tex:12:5`; strip the leading slash before a
    // drive letter, then take the trailing `:line[:column]` off the end.
    let raw = parsed.pathname ?? '';
    if (host === 'goto') {
      // `goto` also accepts the query form, which is easier to build by hand.
      const fromQuery = parsed.searchParams.get('file') ?? parsed.searchParams.get('path');
      if (fromQuery) raw = `/${fromQuery.replace(/\\/g, '/')}`;
    }

    const suffix = /:(\d+)(?::(\d+))?$/.exec(raw);
    let lineFromPath: number | undefined;
    let columnFromPath: number | undefined;
    if (suffix) {
      raw = raw.slice(0, suffix.index);
      lineFromPath = Number.parseInt(suffix[1], 10);
      columnFromPath = suffix[2] ? Number.parseInt(suffix[2], 10) : undefined;
    }

    const candidate = raw.replace(/^\/(?=[a-zA-Z]:)/, '');
    const filePath = toAbsolute(decodePathSegments(candidate));
    if (!filePath) {
      logToFile('warn', `eukolia protocol: file url without a usable path (${rawUrl})`);
      return null;
    }

    // A directory here means "open this project", which is what a `file://`
    // link to a folder means in every other editor.
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      return { kind: 'project', path: filePath };
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      logToFile('warn', `eukolia protocol: file does not exist (${filePath})`);
      return null;
    }

    return {
      kind: 'open',
      path: filePath,
      line: lineFromPath ?? parsePositiveInt(parsed.searchParams.get('line')),
      column: columnFromPath ?? parsePositiveInt(parsed.searchParams.get('column'))
    };
  }

  logToFile('warn', `eukolia protocol: unknown host "${host}"`);
  return null;
}

/**
 * Decodes percent-escapes inside a path.
 *
 * `new URL` leaves the pathname encoded, and a path built from a real file name
 * may contain a literal `%` that is not an escape, so each failure falls back to
 * the raw segment rather than rejecting the whole link.
 */
function decodePathSegments(value: string): string {
  return value
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

/** Delivers a validated request to the renderer. */
export function handleProtocolUrl(rawUrl: string, mainWindow: BrowserWindow | null): void {
  const request = parseProtocolUrl(rawUrl);
  if (!request) return;

  if (request.kind === 'project') rememberWorkspace(request.path);

  const target = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
  deliverProtocolRequest(request, target);
  if (target && !target.webContents.isDestroyed()) {
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  }
}

const readyRenderers = new WeakSet<Electron.WebContents>();

export function resetProtocolDelivery(window: BrowserWindow): void {
  readyRenderers.delete(window.webContents);
}

/** Setup may keep a window visible before the document services exist. */
export function deliverProtocolRequest(request: ParsedProtocolRequest, target: BrowserWindow | null): void {
  if (!target || target.webContents.isDestroyed() || !readyRenderers.has(target.webContents)) {
    pendingRequests.push(request);
    return;
  }

  if (request.kind === 'open') {
    target.webContents.send(IPC.protocol.openFile, request);
  } else {
    target.webContents.send(IPC.protocol.openProject, request.path);
  }

}

const pendingRequests: ParsedProtocolRequest[] = [];

/**
 * Requests that arrived before a window existed. `window.eukoliaApi` is not yet
 * usable at that point, so the renderer pulls them once it is ready.
 */
export function takePendingProtocolRequests(): ParsedProtocolRequest[] {
  return pendingRequests.splice(0, pendingRequests.length);
}

/** Extracts an `eukolia://` URL from a process command line, if present. */
export function findProtocolUrlInCommandLine(commandLine: readonly string[]): string | null {
  return commandLine.find((arg) => typeof arg === 'string' && arg.startsWith(`${SCHEME}://`)) ?? null;
}

/**
 * Lets the renderer drain requests that arrived before it was ready.
 * Idempotent: after the first call the queue is empty.
 */
export function registerProtocolHandlers(): void {
  ipcMain.handle(IPC.protocol.pending, async (event): Promise<ParsedProtocolRequest[]> => {
    readyRenderers.add(event.sender);
    return takePendingProtocolRequests();
  });
}
