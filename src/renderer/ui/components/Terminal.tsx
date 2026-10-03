/**
 * Terminal — the integrated terminal, rendered as a view of the bottom panel.
 *
 * This is a **real terminal**, not a log view: the main process runs the shell on
 * a pseudo-terminal (`node-pty` → ConPTY on Windows) and streams its raw VT
 * output here, where `xterm.js` interprets it. That pairing is what Windows
 * Terminal and VS Code's integrated terminal are, and it is what makes the panel
 * behave the way a user expects:
 *
 *  - the shell draws its own prompt, so the line reads `PS D:\Projects\...>`
 *    because PowerShell wrote it, not because Eukolia synthesised it;
 *  - colour, bold and underline survive, so `git status` and compiler output are
 *    as readable here as in Windows Terminal;
 *  - a program can move the cursor, which is what makes a progress bar redraw in
 *    place instead of scrolling, and what makes `vim` or an interactive REPL
 *    actually work;
 *  - keystrokes go to the shell untouched, so Tab completion, history recall,
 *    `Ctrl+C` and the shell's own line editor all behave normally;
 *  - a resize tells the shell its new width, so a wrapped line re-wraps;
 *  - the wheel keeps its terminal meaning — xterm glides the scrollback at the
 *    shell's own scroll duration, and sends an arrow key instead when a
 *    full-screen program is on the alternate screen.
 *
 * The component owns the emulator and the session; the panel owns the frame
 * (tab strip, border, height). Nothing here decides what the output means — a VT
 * stream is not something to parse twice.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { setting, settingsManager } from '../../core/settings';
import { NATIVE_SCROLL_ATTRIBUTE, smoothScrollDuration, smoothScrollingEnabled } from '../../core/smoothScroll';
import { RotateCw, SquareFunction, TerminalSquare, Trash2 } from './icons';

export interface TerminalProps {
  /** Working directory; the project root when one is open. */
  cwd?: string | null;
  /**
   * False while the panel is showing another view. The session stays alive (the
   * host hides this subtree rather than unmounting it), so this refits the
   * emulator — a `display: none` container has no size — and takes focus back.
   */
  active?: boolean;
  /** Called when the shell exits, so the host can react. */
  onExit?(): void;
}

/**
 * Colours, matching the palette VS Code's dark terminal uses.
 *
 * A terminal's 16 ANSI colours are a contract, not a theme: a program asks for
 * "bright green" and expects the green a user recognises. The background and
 * foreground come from Eukolia's own theme so the panel sits flush with the
 * editor, but the palette is the one these escape codes were designed against.
 */
const ANSI = {
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5'
} as const;

/** Reads a theme token, falling back while the theme manager has not run yet. */
function themeToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** The emulator's palette, derived from the active Eukolia theme. */
function terminalTheme(): Record<string, string> {
  const background = themeToken('--eu-bg-panel', '#12141c');
  const foreground = themeToken('--eu-fg-primary', '#e8ecf4');
  return {
    ...ANSI,
    background,
    foreground,
    cursor: foreground,
    // The cursor is a solid block, so the glyph under it has to flip to the
    // background colour to stay readable — as it does in Windows Terminal.
    cursorAccent: background,
    selectionBackground: themeToken('--eu-accent-muted', 'rgba(61, 125, 255, 0.3)'),
    selectionForeground: foreground
  };
}

/**
 * Collapses a path for display, the way a prompt does.
 *
 * Exported for the test that pins the abbreviation: a header that shows all of
 * `C:\Users\…\Documents\…` pushes the session's own controls off the row.
 */
export function displayPath(cwd: string, home: string): string {
  if (!home) return cwd;
  if (cwd === home) return '~';
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/**
 * How many output chunks may wait for the emulator before the oldest is dropped.
 *
 * Generous, because dropping output is the last resort: the main process has
 * already coalesced the stream, so this only trips when the renderer is far
 * behind — a `latexmk` run pasted into a panel being resized, say.
 */
const MAX_QUEUED_CHUNKS = 512;

/**
 * The emulator's own glide, in milliseconds.
 *
 * xterm animates its viewport itself, and it has to: on the alternate screen a
 * notch is not a scroll at all but an arrow key sent to the program, which is how
 * `less` and `vim` scroll a page. That is why the shell's wheel handler is told to
 * leave this subtree alone (`data-native-scroll`) and the terminal takes its
 * duration from the same two settings instead — one notch, one speed, whichever
 * surface it lands on.
 */
function terminalSmoothScrollDuration(): number {
  return smoothScrollingEnabled() ? smoothScrollDuration() : 0;
}

export const Terminal: React.FC<TerminalProps> = ({ cwd, active = true, onExit }) => {
  const [status, setStatus] = useState<'starting' | 'ready' | 'exited'>('starting');
  const [shellName, setShellName] = useState('');
  const [commandLine, setCommandLine] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [home, setHome] = useState('');
  /** The shell's own window title, when it sets one (OSC 0 / OSC 2). */
  const [title, setTitle] = useState('');
  const [restartCount, setRestartCount] = useState(0);
  const [themeVersion, setThemeVersion] = useState(0);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<number | null>(null);
  /** The size last reported to the PTY, so only real changes are sent. */
  const reported = useRef({ cols: 0, rows: 0 });
  const lastSize = useRef({ cols: 0, rows: 0 });

  // Read once: changing these restarts the session, which is a new shell rather
  // than a re-render, so they are not reactive by design.
  const options = useMemo(
    () => ({
      fontSize: Math.max(8, setting.num('terminal.fontSize')),
      scrollback: Math.max(200, setting.num('terminal.scrollbackLines')),
      followsProject: setting.bool('terminal.cwdFollowsProject'),
      shell: setting.str('terminal.shell')
    }),
    []
  );

  // `onExit` is a prop that may change identity; the session effect runs once and
  // should still call the current one.
  const exitHandler = useRef(onExit);
  exitHandler.current = onExit;

  // ------------------------------------------------------------- the emulator

  // The emulator is created once and lives as long as the component. It is built
  // during the first render rather than in an effect so that output which arrives
  // as soon as the session starts has somewhere to go.
  if (termRef.current === null && typeof window !== 'undefined') {
    const term = new XTerm({
      // A terminal's default font: a monospace stack, at the size the user chose.
      fontFamily: themeToken('--eu-mono-font', 'Consolas, monospace'),
      fontSize: options.fontSize,
      lineHeight: 1,
      letterSpacing: 0,
      cursorBlink: true,
      // A solid block, as Windows Terminal and VS Code's terminal draw it.
      cursorStyle: 'block',
      // The PTY owns line endings; reinterpreting them here would break cursor
      // addressing for anything that repaints.
      convertEol: false,
      scrollback: options.scrollback,
      scrollOnUserInput: true,
      smoothScrollDuration: terminalSmoothScrollDuration(),
      allowProposedApi: true,
      // Tells the emulator which console backend produced this stream. ConPTY on
      // Windows is not a perfect VT: this is what keeps its redraw quirks from
      // being treated as real escape sequences.
      windowsPty: /windows/i.test(navigator.userAgent) ? { backend: 'conpty' } : undefined,
      theme: terminalTheme()
    });

    // Grapheme and East-Asian width handling, so box drawing, CJK and emoji line
    // up instead of leaving gaps — a terminal that mismeasures a wide character
    // corrupts everything after it on the line. xterm 6 ships its width tables in
    // core; the version is only selected when a browser-independent one is
    // registered, because assigning an unknown version throws.
    if (term.unicode.versions.includes('11')) term.unicode.activeVersion = '11';

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        // Links belong to the OS browser, never to this window.
        void window.eukoliaApi.openExternal(uri);
      })
    );

    termRef.current = term;
    fitRef.current = fit;
  }

  // ------------------------------------------------------------------ sizing

  /**
   * Fits the emulator to its container and reports the new size to the PTY.
   *
   * Fitting a hidden container would compute a 0×0 grid, so that case is skipped
   * rather than applied: the panel hides this subtree with `display: none`, and a
   * zero-sized PTY would make the shell wrap every character onto its own line.
   */
  const syncSize = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) return;
    if (host.clientWidth < 8 || host.clientHeight < 8) return;

    const before = term.cols * term.rows;
    try {
      fit.fit();
    } catch {
      // A container mid-layout can measure oddly; the next resize will fit it.
      return;
    }

    if (term.cols === lastSize.current.cols && term.rows === lastSize.current.rows) return;
    lastSize.current = { cols: term.cols, rows: term.rows };
    if (before === 0) term.refresh(0, term.rows - 1);

    const id = sessionRef.current;
    if (id === null) return;
    if (reported.current.cols === term.cols && reported.current.rows === term.rows) return;
    reported.current = { cols: term.cols, rows: term.rows };
    void window.eukoliaApi.resizeTerminal(id, term.cols, term.rows);
  }, []);

  // The panel is drag-resizable, so the container changes size without the
  // window doing so: observe the element itself.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => syncSize());
    observer.observe(host);
    return () => observer.disconnect();
  }, [syncSize]);

  useEffect(() => {
    const onWindowResize = () => syncSize();
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, [syncSize]);

  // A hidden subtree has no layout, so the first fit after it comes back has to
  // wait for the browser to lay it out again.
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      syncSize();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, syncSize]);

  // ------------------------------------------------------------- the session

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    let disposed = false;
    // Output waiting to be handed to the emulator, drained one chunk at a time.
    //
    // `xterm.write` is asynchronous — it parses on its own schedule — so a child
    // that prints faster than the screen refreshes would otherwise queue
    // unboundedly inside xterm. Holding one chunk in flight and keeping the rest
    // here bounds that queue to what the main process has already coalesced, and
    // preserves order, which is the only thing a terminal stream cannot lose.
    const queue: string[] = [];
    let writing = false;

    const drain = () => {
      if (writing || queue.length === 0) return;
      const next = queue.shift() as string;
      writing = true;
      term.write(next, () => {
        writing = false;
        drain();
      });
    };

    /**
     * Queues output for the emulator.
     *
     * Everything that goes on screen comes through here — the PTY's own stream,
     * the catch-up replay and Eukolia's own notices — so their order is the order
     * they were produced in. Writing a notice straight to `term` would let it
     * overtake output still waiting in the queue, which is how a "[process
     * exited]" line ends up above the output that explains why.
     */
    const enqueue = (data: string) => {
      if (!data) return;
      // Past the cap the oldest output is dropped rather than the newest: a
      // terminal that lags is bad, one that shows the wrong end of a build log is
      // worse.
      if (queue.length >= MAX_QUEUED_CHUNKS) queue.shift();
      queue.push(data);
      drain();
    };

    // Subscribed *before* the session exists, because the PTY starts printing the
    // moment it is spawned — the shell's first prompt is often emitted before
    // `createTerminal` has even resolved, and a listener attached afterwards would
    // drop it. Until the session's id is known there is nothing to match a chunk
    // against, so chunks are held here and filtered the instant it arrives.
    //
    // Chunks belonging to another session are then discarded; this view is the
    // only one that receives them, but a restart leaves the old session's last
    // output in flight.
    let id: number | null = null;
    const held: Array<{ id: number; data: string }> = [];
    const offData = window.eukoliaApi.onTerminalData(({ id: dataId, data }) => {
      if (disposed) return;
      if (id === null) {
        held.push({ id: dataId, data });
        return;
      }
      if (dataId !== id) return;
      enqueue(data);
    });

    const offExit = window.eukoliaApi.onTerminalExit(({ id: exitId, exitCode }) => {
      if (disposed || exitId !== id) return;
      sessionRef.current = null;
      setStatus('exited');
      enqueue(`\r\n\x1b[2m[process exited with code ${exitCode ?? 0}]\x1b[0m\r\n`);
      exitHandler.current?.();
    });

    const start = async () => {
      setStatus('starting');
      setTitle('');
      try {
        const created = await window.eukoliaApi.createTerminal({
          cwd: options.followsProject && cwd ? cwd : undefined,
          shell: options.shell || undefined,
          // Start at the size the emulator already measured, so the shell's first
          // prompt is drawn at the right width instead of being re-wrapped.
          cols: term.cols,
          rows: term.rows
        });
        if (disposed) {
          void window.eukoliaApi.killTerminal(created.id);
          return;
        }
        id = created.id;
        sessionRef.current = created.id;
        setShellName(created.command);
        setCommandLine(created.commandLine || created.command);
        setWorkdir(created.cwd);
        setHome(created.home || '');
        setStatus('ready');

        // Whatever the shell said before this view attached — at minimum its
        // prompt. Queued first so it precedes anything arriving after.
        if (created.history) enqueue(created.history);

        // Anything the shell emitted while the session id was still unknown. This
        // is the first paint in the common case: ConPTY clears the screen and
        // draws the prompt within a millisecond or two of the spawn, which is
        // faster than the `createTerminal` round trip.
        for (const chunk of held.splice(0)) if (chunk.id === id) enqueue(chunk.data);

        // The emulator has a size now; tell the PTY about it.
        reported.current = { cols: 0, rows: 0 };
        syncSize();

        // Focus without stealing it: the panel may have opened while the user was
        // typing in the editor, and only an already-visible panel should take it.
        if (active) term.focus();
      } catch (error) {
        if (disposed) return;
        setStatus('exited');
        enqueue(`\r\n\x1b[31m[eukolia] could not start a shell: ${String(error)}\x1b[0m\r\n`);
      }
    };

    void start();

    return () => {
      disposed = true;
      offData();
      offExit();
      sessionRef.current = null;
      const created = id;
      if (created !== null) void window.eukoliaApi.killTerminal(created);
    };
    // One session per mount; `restartCount` is what deliberately starts another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartCount]);

  // --------------------------------------------------------------- input path

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    // Every keystroke, unchanged: the shell's line editor is what understands an
    // arrow key, a Tab or Ctrl+C, and second-guessing it here is how a terminal
    // stops feeling like one.
    const offInput = term.onData((data) => {
      const id = sessionRef.current;
      if (id === null) return;
      void window.eukoliaApi.writeTerminal(id, data);
    });

    const offTitle = term.onTitleChange((value) => setTitle(value));

    return () => {
      offInput.dispose();
      offTitle.dispose();
    };
  }, []);

  /**
   * Clipboard behaviour, matching Windows Terminal and VS Code.
   *
   * The only keys intercepted are the ones a terminal reserves: `Ctrl+C` copies
   * when there is a selection and otherwise falls through to the shell as an
   * interrupt, and the `Ctrl+Shift+…` pair always means the clipboard. Everything
   * else — including `Ctrl+C` with nothing selected — belongs to the shell.
   */
  const attachKeyHandler = useCallback((term: XTerm) => {
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (!event.ctrlKey || event.altKey) return true;

      const key = event.key.toLowerCase();
      const wantsClipboard = event.shiftKey;

      if (key === 'c') {
        const selection = term.getSelection();
        if (selection) {
          void navigator.clipboard.writeText(selection);
          // Clear it, so a second Ctrl+C interrupts the running command rather
          // than copying the same text again.
          term.clearSelection();
          return false;
        }
        // No selection: `Ctrl+Shift+C` still means "copy", and there is nothing
        // to copy, so it must not become an interrupt.
        return !wantsClipboard;
      }

      if (key === 'v') {
        if (!wantsClipboard) return true;
        void navigator.clipboard.readText().then((text) => {
          const id = sessionRef.current;
          if (id === null || !text) return;
          // Bracketed paste when the shell asked for it, so multi-line input is
          // inserted rather than executed line by line; otherwise send the line
          // endings the PTY expects.
          const useBracketed = term.modes.bracketedPasteMode;
          const payload = text.replace(/\r?\n/g, '\r');
          const wrapped = useBracketed ? `\u001b[200~${payload}\u001b[201~` : payload;
          void window.eukoliaApi.writeTerminal(id, wrapped);
        });
        return false;
      }

      return true;
    });
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (term) attachKeyHandler(term);
  }, [attachKeyHandler]);

  // ---------------------------------------------------------------- app theme

  // The palette follows the app theme, so switching theme does not leave a panel
  // of stale colours behind. `themes.ts` writes the tokens onto `<html>`.
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setThemeVersion((value) => value + 1));
    observer.observe(root, { attributes: true, attributeFilter: ['style', 'data-theme', 'class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalTheme();
    term.options.fontFamily = themeToken('--eu-mono-font', 'Consolas, monospace');
    syncSize();
  }, [themeVersion, syncSize]);

  // The emulator's glide follows the scrolling settings, which this option reads
  // live: changing the duration applies to the next notch rather than restarting
  // the shell (unlike the font and the scrollback, which are session options).
  useEffect(() => {
    const apply = () => {
      const term = termRef.current;
      if (term) term.options.smoothScrollDuration = terminalSmoothScrollDuration();
    };
    apply();
    return settingsManager.on('change', apply);
  }, []);

  // ------------------------------------------------------------------ actions

  const clear = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    // Clear the emulator's own buffer *and* its scrollback, which is what "clear"
    // means in a terminal; a repaint alone would leave the history behind.
    term.clear();
    term.focus();
  }, []);

  const interrupt = useCallback(() => {
    const id = sessionRef.current;
    if (id === null) return;
    // The interrupt character, exactly as pressing Ctrl+C sends it: the console
    // delivers it to the foreground process group, so it stops the running
    // command without ending the session.
    void window.eukoliaApi.writeTerminal(id, '\u0003');
    termRef.current?.focus();
  }, []);

  const restart = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    term.clear();
    setRestartCount((value) => value + 1);
  }, []);

  const focusTerminal = useCallback(() => termRef.current?.focus(), []);

  return (
    <div style={root} data-testid="terminal-panel" data-terminal-status={status} data-terminal-tty="pty">
      {/* The session's own row. The panel supplies the frame — tab strip, border,
          height — so this is body content: which shell is running, where, and the
          controls that act on it. Its type and colour are the sheet's
          (`.eu-terminal__header`), so it matches the panel's other status rows. */}
      <div style={header} className="eu-terminal__header">
        <TerminalSquare size={12} strokeWidth={2} style={{ flexShrink: 0, color: 'var(--eu-fg-secondary)' }} />
        {/* The shell's name leads, as a terminal's tab does; the title it sets for
            itself is the tooltip. A PowerShell profile that names the window
            "Windows PowerShell" would otherwise push the working directory — the
            part that says *where* the command will run — off the row. */}
        <span title={[commandLine, title].filter(Boolean).join(' — ') || undefined} className="eu-terminal__title">
          {shellName || 'Starting the shell…'}
        </span>
        <span title={workdir || undefined} className="eu-terminal__path">
          {workdir ? displayPath(workdir, home) : ''}
        </span>
        <span style={{ flex: 1 }} />
        {status === 'exited' && (
          <button type="button" title="Start a new shell" aria-label="Restart the shell" onClick={restart} className="eu-icon-btn eu-terminal__button">
            <RotateCw size={12} strokeWidth={2} />
          </button>
        )}
        <button
          type="button"
          title="Interrupt the running command (Ctrl+C)"
          aria-label="Interrupt"
          onClick={interrupt}
          disabled={status !== 'ready'}
          className="eu-icon-btn eu-terminal__button"
        >
          <SquareFunction size={12} strokeWidth={2} />
        </button>
        <button type="button" title="Clear the terminal" aria-label="Clear terminal" onClick={clear} className="eu-icon-btn eu-terminal__button">
          <Trash2 size={12} strokeWidth={2} />
        </button>
      </div>

      {/* The emulator's screen. xterm draws its own text, cursor and scrollbar
          here; the wrapper exists only to give the fit addon something to
          measure. The subtree is handed back to xterm's own wheel handling —
          `data-native-scroll` — because a notch here can be a keystroke. The
          host's padding is an *inset* (`panel-surfaces.css`) rather than padding
          on the box the fit addon measures, or the grid would be laid out wider
          than the box holding it. */}
      <div ref={hostRef} style={screen} className="eu-terminal__screen" onClick={focusTerminal} data-testid="terminal-screen" {...{ [NATIVE_SCROLL_ATTRIBUTE]: 'true' }}>
        <div className="eu-terminal__host" ref={(node) => {
          // Mount the emulator's DOM once; `open` is not idempotent.
          if (node && termRef.current && !node.hasChildNodes()) termRef.current.open(node);
        }} />
      </div>
    </div>
  );
};

/**
 * Fills the panel's content region; the panel owns the height and the borders.
 *
 * The background is `--eu-bg-panel` — the same token `terminalTheme()` reads to
 * paint the emulator's screen — and that is deliberate rather than incidental:
 * the host is inset inside this surface, so any other colour here would show up
 * as a band of the wrong colour around the grid. The value the terminal is *set*
 * in belongs to xterm, and nothing in the shell second-guesses it.
 */
const root: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
  background: 'var(--eu-bg-panel)',
  overflow: 'hidden'
};

/** A body row, like the panel's other status rows — not a second title bar. Its
    padding, type, colour and divider are `.eu-terminal__header`'s, so the row
    lines up with the panel's status lines; the flex skeleton stays here. */
const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: 24,
  flexShrink: 0
};

const screen: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  minHeight: 0,
  // xterm's screen is absolutely positioned inside its parent, which is why the
  // wrapper has to be positioned and sized rather than left to content.
  overflow: 'hidden',
  cursor: 'text'
};

export default Terminal;
