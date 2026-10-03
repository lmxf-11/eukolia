/**
 * Eukolia — the recursive workspace watcher.
 *
 * VS Code watches a workspace twice over: a **native recursive** watcher where the
 * platform has one (`@parcel/watcher` on Windows and macOS, which is
 * `ReadDirectoryChangesW` and `FSEvents` underneath), and otherwise one watcher per
 * directory, walking the tree and adding a watcher for a directory the moment it
 * appears (`nodejsWatcher.ts`). Both deliver *batches*: a burst of changes is
 * collected and handed over together rather than one event per keystroke of an
 * outside program, because the workbench's answer to any of them is the same
 * re-read.
 *
 * This module is that policy, with the platform primitives injected, so it holds no
 * Electron import and can be driven in a test — with a fake watcher for the
 * fallback and error paths, and with the real filesystem for the behaviour that
 * actually matters.
 *
 * Three rules it implements, all of them VS Code's:
 *
 *  * **A directory that is not watched is not reported.** `files.watcherExclude`
 *    (and the application's own always-excluded names) keep dependency and VCS
 *    internals out of the watcher entirely, so a `node_modules` install cannot
 *    produce ten thousand events the Explorer will ignore anyway.
 *  * **A rename is resolved by looking.** `fs.watch` reports `rename` for both a
 *    creation and a deletion, so the kind is decided by asking whether the path
 *    exists — the same test VS Code's node watcher makes.
 *  * **A failure is reported, not retried.** Watcher failures are `EMFILE` and
 *    `ENOSPC` — the process is out of handles or the platform's change buffer is
 *    full — and neither is fixed by trying again; VS Code tells the user to raise
 *    the limit, and so does this.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FileWatchErrorEvent, FileWatchEvent } from '../../shared/ipc';

/**
 * How long a burst of changes is collected before it is delivered.
 *
 * VS Code's watcher runs in a utility-process worker and holds changes for 75 ms
 * before handing them to a throttler, which delivers at most once every 500 ms
 * (`parcelWatcher.ts`: `THROTTLE_DELAY = 500`, `THROTTLE_MAX_DELAY = 30000`; the
 * node watcher uses 100 ms and 10 s). 500 ms is the number that matters to a
 * consumer: it is the interval at which the workbench is told about changes.
 *
 * The window is measured from the *first* buffered event rather than restarted by
 * each new one — a sliding debounce never fires while an install is running, which
 * turns a busy directory into a stalled Explorer. VS Code bounds that the same way
 * with its `THROTTLE_MAX_DELAY`.
 */
export const WATCH_DEBOUNCE_MS = 500;

/**
 * How many directories the fallback strategy will watch for one workspace.
 *
 * The fallback is for platforms without a recursive watcher (VS Code's node
 * watcher, one handle per directory). Ten thousand handles is far past any
 * platform's ceiling, so the bound fails loudly — through the same `EMFILE` report
 * the platform itself would raise — rather than pretending to succeed.
 */
export const MAX_FALLBACK_DIRECTORIES = 10_000;

/**
 * The most changes delivered in one batch, and how long the next batch waits.
 *
 * VS Code's throttlers carry `maxWorkChunkSize: 500` / `throttleDelay: 200` (and
 * 100/200 for the node watcher): however many events are waiting, at most 500 are
 * handed over at once, then the rest wait 200 ms. A `git checkout` in a large
 * repository is tens of thousands of events, and delivering them in one message
 * each — or in one enormous array — costs the consumer more than the delay does.
 */
export const MAX_WORK_CHUNK = 500;
export const CHUNK_REST_MS = 200;

/**
 * The most paths buffered before the rest are dropped.
 *
 * VS Code's `maxBufferedWork: 30000`, and it drops the overflow with a warning
 * naming `files.watcherExclude` — because the alternative is a watcher that grows
 * without bound while something writes a build tree into the workspace. Dropping is
 * safe for our consumer in a way it would not be for a delta-based one: any event
 * at all makes it re-read the directory, so a tree that changed is still noticed.
 */
export const MAX_BUFFERED_CHANGES = 30_000;

/** One raw event from a platform watcher, as `fs.watch` reports it. */
export interface RawWatchEvent {
  type: 'rename' | 'change';
  filename: string | null;
}

/** A watching subscription. */
export interface WatchSubscription {
  close(): void;
}

/**
 * The platform, as this module needs it.
 *
 * Every member is injected rather than imported so a test can present a watcher
 * that fails on demand, or one that delivers events synchronously.
 */
export interface TreeWatcherPorts {
  /**
   * A native recursive watch of `directory`.
   *
   * **Throws** `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where the platform has none
   * (Linux), which selects the fallback; any other throw is a real failure and is
   * reported.
   */
  watchRecursive(
    directory: string,
    onEvent: (event: RawWatchEvent) => void,
    onError: (error: unknown) => void
  ): WatchSubscription;
  /** A non-recursive watch of one directory. */
  watchDirectory(
    directory: string,
    onEvent: (event: RawWatchEvent) => void,
    onError: (error: unknown) => void
  ): WatchSubscription;
  /** Immediate subdirectories of `directory`, excluded ones already removed. */
  listSubdirectories(directory: string): string[];
  /** Whether `target` exists and is a directory. */
  isDirectory(target: string): boolean;
  /** Whether `target` exists at all. */
  exists(target: string): boolean;
}

export interface TreeWatcherOptions {
  /** The directory being watched. Everything below it is in scope. */
  root: string;
  ports: TreeWatcherPorts;
  /** Directory names never watched, matched against every path segment below `root`. */
  excludes: ReadonlySet<string>;
  /** Called with each settled batch, in the order the paths were first seen. */
  deliver(events: FileWatchEvent[]): void;
  /** Called once per distinct watcher failure. */
  report(error: FileWatchErrorEvent): void;
  /** Diagnostics that are not failures: an overflow, a dropped burst. */
  diagnose?(message: string): void;
  debounceMs?: number;
}

/** The `fs.watch` recursive failure that means "this platform cannot". */
function isMissingRecursiveSupport(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' || code === 'ERR_INVALID_ARG_VALUE';
}

/** A watcher failure, as the renderer is told about it. */
function toWatchError(target: string, error: unknown): FileWatchErrorEvent {
  const err = error as NodeJS.ErrnoException | undefined;
  const code = err?.code ?? 'UNKNOWN';
  return {
    path: target,
    code,
    message: err?.message ?? String(error),
    /*
     * The one code VS Code puts in front of the user, in its own words
     * (`workspaceWatcher.ts`, the `enospcError` notification, whose action opens
     * `https://go.microsoft.com/fwlink/?linkid=867693`). `EMFILE` is deliberately
     * left without one, because upstream leaves it without one: it is logged and
     * the watcher is not restarted, and the user is not told.
     */
    userMessage: code === 'ENOSPC' ? UNABLE_TO_WATCH_MESSAGE : undefined
  };
}

/** VS Code's user-facing text for a watcher that cannot watch. */
const UNABLE_TO_WATCH_MESSAGE =
  'Unable to watch for file changes. Please follow the instructions link to resolve this issue.';

/**
 * One path's events inside the window being collected.
 *
 * Both ends of the sequence are kept, because the order is what decides the
 * outcome: a file that was added and then deleted did not, as far as any consumer
 * is concerned, ever exist.
 */
interface BufferedChange {
  first: FileWatchEvent['kind'];
  last: FileWatchEvent['kind'];
}

export class TreeWatcher {
  private readonly subscriptions = new Map<string, WatchSubscription>();
  /** Paths seen in the window being collected, keyed case-insensitively on Windows. */
  private readonly pending = new Map<string, BufferedChange & { path: string }>();
  /** Resolved changes waiting for the next chunk to be delivered. */
  private queued: FileWatchEvent[] = [];
  private readonly reportedErrors = new Set<string>();
  private drops = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private recursive = false;
  private closed = false;

  constructor(private readonly options: TreeWatcherOptions) {}

  /** Starts watching. Safe to call twice; the second call does nothing. */
  public start(): void {
    if (this.closed || this.subscriptions.size > 0) return;

    try {
      const subscription = this.options.ports.watchRecursive(
        this.options.root,
        (event) => this.receive(this.options.root, event),
        (error) => this.fail(this.options.root, error)
      );
      this.subscriptions.set(this.options.root, subscription);
      this.recursive = true;
      return;
    } catch (error) {
      if (!isMissingRecursiveSupport(error)) {
        // A real failure — out of handles, most likely. Reported, not retried: the
        // next attempt has no more handles than this one did.
        this.fail(this.options.root, error);
        return;
      }
      // The platform has no recursive watch. One watcher per directory is what
      // VS Code's own node watcher does there.
      this.recursive = false;
    }

    this.watchDirectoryAndBelow(this.options.root);
  }

  /** Stops watching everything. */
  public stop(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    /*
     * Whatever was collected is delivered rather than dropped, and delivered whole
     * rather than in chunks: the renderer's answer to any of it — re-read the tree —
     * is right either way, and a change that arrived just before the project was
     * closed is still a change.
     */
    this.resolvePending();
    const remaining = this.queued.splice(0);
    if (remaining.length > 0) this.options.deliver(remaining);

    for (const subscription of this.subscriptions.values()) subscription.close();
    this.subscriptions.clear();
  }

  /** True while the native recursive watcher is the one in use. */
  public get usingNativeRecursion(): boolean {
    return this.recursive;
  }

  private watchDirectoryAndBelow(directory: string): void {
    if (this.closed || this.subscriptions.has(directory)) return;
    if (this.subscriptions.size >= MAX_FALLBACK_DIRECTORIES) {
      this.fail(directory, Object.assign(new Error('too many directories to watch'), { code: 'EMFILE' }));
      return;
    }

    try {
      const subscription = this.options.ports.watchDirectory(
        directory,
        (event) => this.receive(directory, event),
        (error) => this.fail(directory, error)
      );
      this.subscriptions.set(directory, subscription);
    } catch (error) {
      this.fail(directory, error);
      return;
    }

    /*
     * The exclusion is applied here rather than inside the ports: which directories
     * are watched is part of the policy, and a port that quietly filtered would make
     * the rule untestable and the two implementations of it free to disagree.
     */
    for (const child of this.options.ports.listSubdirectories(directory)) {
      if (this.isExcluded(child)) continue;
      this.watchDirectoryAndBelow(child);
    }
  }

  private receive(directory: string, event: RawWatchEvent): void {
    if (this.closed || !event.filename) return;

    const target = path.join(directory, event.filename.toString());
    if (this.isExcluded(target)) return;

    const kind: FileWatchEvent['kind'] =
      event.type === 'rename' ? (this.options.ports.exists(target) ? 'create' : 'delete') : 'change';

    // A directory that has just appeared has to be watched as well, or everything
    // created inside it afterwards is invisible. Only the fallback strategy needs
    // this: the native one recurses on its own.
    if (!this.recursive && kind === 'create' && this.options.ports.isDirectory(target)) {
      this.watchDirectoryAndBelow(target);
    }

    const buffered = this.pending.get(keyOf(target));
    if (buffered) {
      buffered.last = kind;
    } else {
      if (this.pending.size >= MAX_BUFFERED_CHANGES) {
        // Dropped rather than buffered: see `MAX_BUFFERED_CHANGES`.
        this.noteDrop();
        return;
      }
      this.pending.set(keyOf(target), { path: target, first: kind, last: kind });
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.options.debounceMs ?? WATCH_DEBOUNCE_MS);
    }
  }

  private noteDrop(): void {
    this.drops += 1;
    if (this.drops !== 1) return;
    this.options.diagnose?.(
      `ignoring file change events: more than ${MAX_BUFFERED_CHANGES} changed at once. ` +
        `Use the 'files.watcherExclude' setting to exclude folders with lots of changing files (e.g. compilation output).`
    );
  }

  /**
   * Resolves a window's worth of events and delivers them.
   *
   * The rules are VS Code's, from its file-change coalescer, and each one exists
   * because a consumer that acted on the raw stream would do pointless or wrong
   * work:
   *
   *  * **added then deleted → nothing at all.** A file that appeared and vanished
   *    inside the window never existed as far as the tree is concerned; reporting a
   *    creation and a deletion only makes the consumer look twice.
   *  * **deleted then added → a change.** This is a save: the write is a rename over
   *    the target, so the platform reports the target as removed and then present
   *    again. It changed — it was not replaced by a different file.
   *  * **a delete under a deleted directory → dropped.** Removing a folder reports
   *    the folder and then everything that was inside it; only the folder matters,
   *    and the consumer re-reads the directory either way.
   *
   * On top of those, existence is checked once at delivery time, because a false
   * *delete* is the one outcome our consumer cannot undo: it tells the user their
   * open document was removed from disk. A path that is reported deleted and is
   * sitting there is delivered as a creation instead, and one that is reported
   * changed and is gone is delivered as a deletion.
   */
  private flush(): void {
    this.resolvePending();

    if (this.queued.length === 0) return;

    /*
     * At most `MAX_WORK_CHUNK` changes per delivery, then a rest. Without this a
     * checkout of ten thousand files becomes ten thousand IPC messages in one turn,
     * and the renderer's answer to each of them is the same walk of the tree.
     */
    const chunk = this.queued.splice(0, MAX_WORK_CHUNK);
    if (chunk.length > 0) this.options.deliver(chunk);

    if (this.queued.length > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, CHUNK_REST_MS);
    }
  }

  /** Turns the collected window into deliverable changes, applying VS Code's rules. */
  private resolvePending(): void {
    if (this.pending.size === 0) return;

    const resolved: FileWatchEvent[] = [];
    for (const change of this.pending.values()) {
      if (change.first === 'create' && change.last === 'delete') continue;
      const declared: FileWatchEvent['kind'] =
        change.first === 'delete' && change.last === 'create' ? 'change' : change.last;

      const present = this.options.ports.exists(change.path);
      const kind: FileWatchEvent['kind'] = present ? (declared === 'delete' ? 'create' : declared) : 'delete';
      resolved.push({ path: change.path, kind });
    }
    this.pending.clear();

    const deleted = new Set(resolved.filter((event) => event.kind === 'delete').map((event) => event.path));
    const events =
      deleted.size === 0
        ? resolved
        : resolved.filter((event) => event.kind !== 'delete' || !hasDeletedAncestor(event.path, deleted));

    this.queued.push(...events);
  }

  /**
   * Whether a path is out of scope.
   *
   * Only segments *below* the root are matched, so a workspace that happens to be
   * called `dist` is still watched; the comparison is case-insensitive because the
   * platform's own path comparison is.
   */
  private isExcluded(target: string): boolean {
    if (this.options.excludes.size === 0) return false;
    const relative = path.relative(this.options.root, target);
    if (!relative || relative.startsWith('..')) return false;
    return relative
      .split(/[\\/]/)
      .some((segment) => this.options.excludes.has(segment.toLowerCase()));
  }

  private fail(target: string, error: unknown): void {
    const report = toWatchError(target, error);
    const key = `${report.code}`;
    // One report per kind of failure: a full disk or an exhausted handle table
    // produces the same error for every directory it reaches, and a notice per
    // directory is noise rather than information.
    if (this.reportedErrors.has(key)) return;
    this.reportedErrors.add(key);
    this.options.report(report);
  }
}

/** Whether some directory above `target` was itself deleted in the same window. */
function hasDeletedAncestor(target: string, deleted: ReadonlySet<string>): boolean {
  let parent = path.dirname(target);
  while (parent !== target && parent.length > 0) {
    if (deleted.has(parent)) return true;
    const next = path.dirname(parent);
    if (next === parent) return false;
    parent = next;
  }
  return false;
}

/**
 * The key a path is buffered under.
 *
 * VS Code coalesces events "for the same (case-normalised) path", because on
 * Windows `C:\Project\Main.tex` and `c:\project\main.tex` are one file and two
 * buffered entries for it would deliver two changes where there was one. The
 * spelled path is kept alongside the key, so what is delivered is what the platform
 * said.
 */
function keyOf(target: string): string {
  return process.platform === 'win32' ? target.toLowerCase() : target;
}

/**
 * The real filesystem, as `TreeWatcher` needs it.
 *
 * `fs.watch` is used rather than a native module because it *is* the platform
 * primitive on Windows and macOS — `{ recursive: true }` becomes
 * `ReadDirectoryChangesW` and `FSEvents` — and because a dependency that has to be
 * rebuilt per Electron version is a large price for behaviour the runtime already
 * has. Linux has no recursive mode, which is what the fallback is for.
 *
 * The ports filter nothing: which directories are watched and which events are
 * reported is `TreeWatcher`'s decision, taken in one place.
 */
export function nodeWatchPorts(): TreeWatcherPorts {
  const listen = (
    directory: string,
    options: fs.WatchOptions,
    onEvent: (event: RawWatchEvent) => void,
    onError: (error: unknown) => void
  ): WatchSubscription => {
    const watcher = fs.watch(directory, options, (type, filename) => {
      onEvent({ type: type as 'rename' | 'change', filename: filename ? filename.toString() : null });
    });
    watcher.on('error', onError);
    return { close: () => watcher.close() };
  };

  return {
    watchRecursive: (directory, onEvent, onError) =>
      listen(directory, { recursive: true, persistent: false }, onEvent, onError),
    watchDirectory: (directory, onEvent, onError) =>
      listen(directory, { persistent: false }, onEvent, onError),
    listSubdirectories: (directory) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return [];
      }
      return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name));
    },
    isDirectory: (target) => {
      try {
        return fs.statSync(target).isDirectory();
      } catch {
        return false;
      }
    },
    exists: (target) => fs.existsSync(target)
  };
}
