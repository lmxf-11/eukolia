/**
 * Eukolia — the integrated terminal's process side.
 *
 * One real shell process per session, attached to a **pseudo-terminal** through
 * `node-pty`, which on Windows is ConPTY — the same console host Windows
 * Terminal and VS Code's integrated terminal use. That is what makes the panel a
 * terminal rather than a log view: the shell believes it is talking to a screen,
 * so it emits the full VT stream (a cursor, colours, in-place line redraws, a
 * window title) and receives real keystrokes, including Ctrl+C as an interrupt
 * rather than as a byte written into a pipe.
 *
 * Why this shape:
 *
 *  - **A PTY, not a pipe.** PowerShell, `git` and `latexmk` all change their
 *    behaviour when `isatty` is false: they drop colour, replace progress
 *    redraws with line spam and refuse to prompt. A PTY restores the behaviour a
 *    user sees in Windows Terminal.
 *  - **No interpretation here.** This file treats the shell's output as an
 *    opaque byte stream and forwards it verbatim. Deciding what `\u001b[1;23H`
 *    means is the renderer's job (it runs a real VT emulator); parsing it twice
 *    is how terminal bugs are born.
 *  - **The scrollback lives here, not in the renderer.** A session outlives any
 *    one view of it, so the last `SCROLLBACK_LIMIT` characters are kept beside
 *    the process and replayed to whoever attaches. That is what makes a reload
 *    or a panel re-open show the history that is still there.
 */

import { app, BrowserWindow, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';
import { IPC } from '../../shared/ipc';
import type { TerminalCreateRequest, TerminalCreateResult, TerminalExitEvent } from '../../shared/ipc';

interface TerminalSession {
  id: number;
  pty: pty.IPty;
  /** The executable actually started, for the panel's header. */
  command: string;
  /** The command line, including arguments, for the hover title. */
  commandLine: string;
  cwd: string;
  /** The window that asked for this session; output is streamed only to it. */
  owner: WebContents;
  /** The tail of the session's output, replayed to a view that attaches late. */
  history: string;
  /** The tail of the output not yet sent, held until the next flush. */
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  /** Set once the process is gone, so a late write is a no-op rather than a throw. */
  exited: boolean;
  /** Stops this session's PTY subscriptions; `node-pty` hands back disposables. */
  disposers: Array<{ dispose(): void }>;
}

const sessions = new Map<number, TerminalSession>();
let nextId = 1;

/**
 * How much scrollback to keep per session, in characters.
 *
 * A pointer into the string rather than an array of lines: output arrives in
 * arbitrary chunks, and splitting it into lines here would mean reassembling
 * them in the renderer for no benefit. The renderer's emulator has its own
 * line-based scrollback; this is only what a re-attaching view needs to catch up.
 */
const SCROLLBACK_LIMIT = 512 * 1024;

/**
 * Output is coalesced for this long before being sent.
 *
 * A compiler or `git status` can emit thousands of small chunks; one
 * `webContents.send` per chunk would put the IPC channel, not the shell, on the
 * critical path. Ordering is preserved because the buffer is a single string.
 */
const FLUSH_INTERVAL_MS = 8;

/** Flush immediately past this size, so a flood still feels live. */
const FLUSH_THRESHOLD = 64 * 1024;

const isWindows = process.platform === 'win32';

/** The shell to run: the user's setting, else the platform default. */
export function defaultShell(configured?: string): string {
  const explicit = configured?.trim();
  if (explicit && isExecutable(explicit)) return explicit;

  if (isWindows) {
    // PowerShell 7 first, then the Windows PowerShell that ships with Windows.
    // `ProgramFiles` is not consulted through `process.env` because a 32-bit
    // host would resolve it to the wrong hive.
    const candidates = [
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      'powershell.exe'
    ];
    for (const candidate of candidates) {
      if (candidate && isExecutable(candidate)) return candidate;
    }
    return process.env.ComSpec || 'cmd.exe';
  }

  return process.env.SHELL || '/bin/bash';
}

/**
 * True when a path exists and looks runnable.
 *
 * A bare command name (`powershell.exe`) is accepted as-is and left to the OS to
 * resolve through `PATH`; only real paths are stat-ed, so a configured shell that
 * is missing falls back to the default instead of failing to spawn.
 */
function isExecutable(candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return true;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Arguments that put the shell into interactive mode.
 *
 * The banner is suppressed, because the panel is not a console window and a
 * logo would only be scrollback. User profiles are **not** skipped: an alias or
 * a custom prompt is exactly the kind of thing that makes the panel feel like
 * the terminal the user already has, and Windows Terminal runs them too.
 */
export function shellArguments(shell: string): string[] {
  const name = path.basename(shell).toLowerCase();
  if (name.startsWith('pwsh') || name.startsWith('powershell')) {
    // `-NoExit` is not needed: with no `-Command`, the shell reads from the PTY
    // and stays interactive until the session is killed.
    return ['-NoLogo'];
  }
  if (name === 'cmd.exe' || name === 'cmd') {
    return ['/K', 'prompt $P$G'];
  }
  return [];
}

/** The environment a terminal session runs with. */
function shellEnvironment(shell: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  // A real 256-colour terminal, so programs that check for one turn their colour
  // and progress output back on. `NO_COLOR` is removed for the same reason: it
  // is now the wrong answer, and an inherited `NO_COLOR=1` would silently strip
  // the colour the emulator is there to draw.
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  delete env.NO_COLOR;

  // Terminals advertise themselves so the shell can pick a matching prompt: the
  // `TERM_PROGRAM` block is what makes the VS Code / Windows Terminal prompt
  // functions activate in PowerShell and `oh-my-posh`.
  env.TERM_PROGRAM = 'Eukolia';
  env.TERM_PROGRAM_VERSION = app.getVersion();
  if (isWindows) env.WT_SESSION = env.WT_SESSION ?? '';

  // PowerShell reads this to decide how much of the host to light up; without it
  // the prompt is treated as running under a plain console.
  if (path.basename(shell).toLowerCase().startsWith('pwsh')) {
    env.POWERSHELL_TELEMETRY_OPTOUT = env.POWERSHELL_TELEMETRY_OPTOUT ?? '1';
  }

  return env;
}

/** Releases a session's PTY subscriptions. */
function releaseSubscriptions(session: TerminalSession): void {
  for (const disposer of session.disposers) {
    try {
      disposer.dispose();
    } catch {
      // Already disposed with the pty.
    }
  }
  session.disposers = [];
}

/** Appends to a session's retained tail, dropping the oldest output past the cap. */
function retain(session: TerminalSession, data: string): void {
  session.history += data;
  if (session.history.length <= SCROLLBACK_LIMIT) return;

  // Cut at a line break near the cap rather than at an arbitrary character, so
  // the replay does not begin halfway through an escape sequence.
  const overflow = session.history.length - SCROLLBACK_LIMIT;
  const boundary = session.history.indexOf('\n', overflow);
  session.history = boundary === -1 ? session.history.slice(overflow) : session.history.slice(boundary + 1);
}

/** Sends whatever output has accumulated for a session. */
function flush(session: TerminalSession): void {
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }
  const data = session.pending;
  session.pending = '';
  if (!data) return;
  if (session.owner.isDestroyed()) return;
  session.owner.send(IPC.terminal.data, { id: session.id, data });
}

/** Queues output for a session, flushing on the coalescing timer or immediately. */
function emit(session: TerminalSession, data: string): void {
  session.pending += data;
  if (session.pending.length >= FLUSH_THRESHOLD) {
    flush(session);
    return;
  }
  if (!session.flushTimer) {
    session.flushTimer = setTimeout(() => flush(session), FLUSH_INTERVAL_MS);
  }
}

/**
 * Starts a shell attached to a PTY and streams its output to `owner`.
 *
 * `owner` is the window whose renderer asked for the session. Output goes to it
 * alone: a second window has no view of this session, and broadcasting would
 * hand it a stream of terminal escapes it has nowhere to put.
 */
export function createTerminal(
  request: TerminalCreateRequest = {},
  owner?: WebContents
): TerminalCreateResult {
  const window = owner ?? BrowserWindow.getAllWindows()[0]?.webContents ?? null;

  const shell = defaultShell(request.shell);
  const args = shellArguments(shell);
  const cwd = request.cwd && fs.existsSync(request.cwd) ? request.cwd : app.getPath('home');

  // Start at a plausible size so the shell's first paint is not one column wide;
  // the renderer sends its measured size as soon as the emulator is fitted.
  const cols = clampDimension(request.cols, 80, 20, 500);
  const rows = clampDimension(request.rows, 24, 5, 200);

  const child = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: shellEnvironment(shell),
    // ConPTY is the Windows console host, and is what gives a Windows shell the
    // rendering, colour and input behaviour a user recognises. WinPTY is the
    // pre-Windows-10 fallback and is only reachable through `useConpty: false`.
    useConpty: true
  });

  const id = nextId++;
  const session: TerminalSession = {
    id,
    pty: child,
    command: shell,
    commandLine: [shell, ...args].join(' '),
    cwd,
    owner: window ?? ({ isDestroyed: () => true, send: () => undefined } as unknown as WebContents),
    history: '',
    pending: '',
    flushTimer: null,
    exited: false,
    disposers: []
  };
  sessions.set(id, session);

  session.disposers.push(
    child.onData((data) => {
      retain(session, data);
      emit(session, data);
    })
  );

  session.disposers.push(
    child.onExit(({ exitCode }) => {
      // The shell can exit between two chunks; whatever it managed to say last
      // has to reach the renderer before the exit notice overtakes it.
      flush(session);
      session.exited = true;
      sessions.delete(id);
      releaseSubscriptions(session);
      if (!session.owner.isDestroyed()) {
        const event: TerminalExitEvent = { id, exitCode };
        session.owner.send(IPC.terminal.exit, event);
      }
    })
  );

  return {
    id,
    command: shell,
    cwd,
    commandLine: session.commandLine,
    home: app.getPath('home'),
    history: session.history
  };
}

/** Clamps a renderer-supplied dimension into something a console will accept. */
function clampDimension(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

/** Replays a session's retained output; used by a view that attached after the start. */
export function terminalHistory(id: number): string {
  return sessions.get(id)?.history ?? '';
}

/**
 * Writes keystrokes to a session's PTY.
 *
 * The bytes are forwarded untouched — an arrow key is `\u001b[A`, Ctrl+C is
 * `\u0003`, a paste is whatever the clipboard held — because the shell's line
 * editor is the thing that understands them, exactly as it would in Windows
 * Terminal.
 */
export function writeTerminal(id: number, data: string): void {
  const session = sessions.get(id);
  if (!session || session.exited) return;
  try {
    session.pty.write(data);
  } catch {
    // The process died between the check and the write; the exit handler will
    // report it.
  }
}

/**
 * Resizes a session's PTY.
 *
 * This is the half of a terminal that a pipe could never do: the shell and every
 * program under it are told the new width, so a wrapped line re-wraps and a
 * full-width prompt redraws instead of spilling.
 */
export function resizeTerminal(id: number, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session || session.exited) return;
  const width = clampDimension(cols, 80, 2, 1000);
  const height = clampDimension(rows, 24, 1, 500);
  if (session.pty.cols === width && session.pty.rows === height) return;
  try {
    session.pty.resize(width, height);
  } catch {
    // ConPTY rejects a resize for a process that is already tearing down.
  }
}

/** Terminates a session. */
export function killTerminal(id: number): void {
  const session = sessions.get(id);
  if (!session) return;
  session.exited = true;
  sessions.delete(id);
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }
  session.pending = '';
  releaseSubscriptions(session);
  try {
    // `kill` on Windows tears down the ConPTY, which closes the console and takes
    // the shell and every child process with it — the same guarantee the old
    // `taskkill /T /F` was reaching for, without the extra process.
    session.pty.kill();
  } catch {
    // Already gone.
  }
}

/** Kills every session; used on shutdown so no shell outlives the window. */
export function disposeTerminals(): void {
  for (const id of [...sessions.keys()]) killTerminal(id);
}
