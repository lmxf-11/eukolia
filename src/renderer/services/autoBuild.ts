/**
 * Eukolia — when a build starts by itself.
 *
 * Three modes, and they are LaTeX Workshop's, because that is what a LaTeX user
 * already has in their fingers: `never`, `onSave` and `onFileChange`, with
 * `onSave` the *more restrictive* of the two automatic ones (its own words:
 * "`onSave` builds the project upon saving a `tex` file in vscode, `onFileChange`
 * builds the project upon detecting a file change in any of the dependencies,
 * even modified by other applications").
 *
 * The two automatic modes differ in where the trigger comes from, not in what
 * they build:
 *
 *   - `onSave` — the editor saved a source document. Eukolia writes the file and
 *     then asks for a build.
 *   - `onFileChange` — a watched file changed on disk. That includes Eukolia's own
 *     saves (a save *is* a change to the file), plus a change made by anything
 *     else: another editor, a script, a formatter, a `git checkout`.
 *
 * **A build must not trigger itself.** Compiling rewrites a dozen files next to
 * the source — `.aux`, `.log`, `.pdf`, `.synctex.gz`, the whole list in
 * `shared/cleanExtensions.ts` — so a mode that watches the project would see its
 * own output land and build again, forever. Those files are therefore recognised
 * by name and never count as a change (§`isBuildArtefact`), whatever the mode.
 * The recognition is the *job name*, not the extension: a figure called
 * `figure.pdf` is an asset the document reads, and it must still trigger a
 * build, while `main.pdf` beside `main.tex` is what latexmk just wrote.
 *
 * **One build per burst, and never two at once.** A save with `onFileChange`
 * arrives twice (the editor event and the watcher event), a formatter touches
 * twenty files, and a slow build is still running when the next trigger lands.
 * `AutoBuildScheduler` coalesces all of that into the smallest number of builds
 * that still ends with the current sources compiled: one debounce window, then a
 * build, and the next one no sooner than the minimum interval after the last
 * build *started* — which is also what keeps a manual `Ctrl+B` from being
 * immediately followed by an automatic one.
 */

import { CLEAN_EXTENSIONS } from '../../shared/cleanExtensions';

export type AutoBuildMode = 'never' | 'onSave' | 'onFileChange';

/** The modes, in the order the settings offer them. */
export const AUTO_BUILD_MODES: readonly AutoBuildMode[] = ['never', 'onSave', 'onFileChange'];

/** One line per mode, shown under the setting, in the same order. */
export const AUTO_BUILD_MODE_DESCRIPTIONS: readonly string[] = [
  'Never build by itself — only when you ask.',
  'Build whenever a LaTeX source file is saved.',
  'Build whenever any file of the project changes on disk, including changes made by other applications.'
];

/** Where a trigger came from. */
export type AutoBuildTrigger = 'save' | 'external-change';

export interface AutoBuildDecision {
  build: boolean;
  /**
   * Why, in one word. `ok` is the only one that builds; the rest exist so the
   * shell (and a test) can say *why* nothing happened instead of guessing.
   */
  reason:
    | 'ok'
    | 'mode-never'
    | 'mode-on-save-does-not-watch-disk'
    | 'no-root-document'
    | 'build-artefact'
    | 'ignored'
    | 'not-a-source-file';
}

/** Files whose change can affect the document: what TeX reads, and what it draws. */
const SOURCE_EXTENSIONS = /\.(tex|ltx|sty|cls|clo|def|cfg|fd|enc|bib|bst|tikz|pgf|gnuplot|dat|csv|py|m|jl|r|lua|sh|txt)$/i;
const ASSET_EXTENSIONS = /\.(pdf|png|jpg|jpeg|eps|svg|gif|tif|tiff|bmp|webp|mp|mps|jbig2|jb2)$/i;

/** True when the file is one TeX reads (source) or draws (asset). */
export function isProjectFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.test(filePath) || ASSET_EXTENSIONS.test(filePath);
}

/** True when the file is a LaTeX source document rather than an asset or a support file. */
export function isSourceDocument(filePath: string): boolean {
  return /\.(tex|ltx)$/i.test(filePath);
}

/**
 * True when the file is the output of a build of `rootFile`.
 *
 * The name is what decides — `<job>.<extension>` for every extension a clean
 * removes, plus the PDF itself — because that is exactly the set of files a
 * compile writes and a watcher would therefore notice. `figure.pdf` is not one of
 * them even though its extension is, and neither is a chapter's `main.tex` in
 * another directory.
 */
export function isBuildArtefact(filePath: string, rootFile: string | null): boolean {
  if (!rootFile) return false;
  const jobName = baseName(rootFile).replace(/\.[^.]*$/, '');
  if (!jobName) return false;
  const name = baseName(filePath);
  if (!name.startsWith(`${jobName}.`)) return false;
  const suffix = name.slice(jobName.length + 1);
  return suffix.toLowerCase() === 'pdf' || CLEAN_EXTENSIONS.includes(suffix);
}

/**
 * The `files.exclude`-style patterns of `compilation.autoBuildIgnore`, matched
 * against the file's path.
 *
 * Only the two shapes the setting's own default needs are supported — `**​/*.ext`
 * and `*.ext`, both suffix matches — plus an exact path. A full glob engine for a
 * list whose default is `['**​/*.sty', '**​/*.cls']` would be a dependency for
 * nothing, and this way the rule is readable in one line.
 */
export function matchesIgnorePattern(filePath: string, pattern: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const cleaned = pattern.trim().replace(/\\/g, '/').toLowerCase();
  if (!cleaned) return false;
  // `**/` and a bare name are both "any directory, this name": `**/*.sty` is a
  // suffix match on `.sty`, and so is `*.sty`.
  const rest = cleaned.startsWith('**/') ? cleaned.slice(3) : cleaned;
  if (rest.startsWith('*.')) return normalized.endsWith(rest.slice(1));
  if (rest.includes('*')) return false;
  if (cleaned.startsWith('**/') || rest.includes('/')) return normalized.endsWith(`/${rest}`) || normalized === rest;
  return normalized.endsWith(`/${rest}`) || normalized === rest;
}

/** True when the path matches any pattern of the ignore list. */
export function isIgnored(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesIgnorePattern(filePath, pattern));
}

/**
 * Whether a trigger should start a build, and if not, why.
 *
 * The order of the checks is the order a reader would ask them in: is the mode
 * even on, is there something to build, is this file the build's own output, has
 * the user excluded it, and does this trigger kind belong to this mode.
 */
export function decideAutoBuild(input: {
  mode: string;
  trigger: AutoBuildTrigger;
  path: string;
  rootFile: string | null;
  ignore: readonly string[];
}): AutoBuildDecision {
  const mode = (input.mode || 'never') as AutoBuildMode;
  if (mode === 'never') return { build: false, reason: 'mode-never' };
  if (mode !== 'onSave' && mode !== 'onFileChange') return { build: false, reason: 'mode-never' };
  if (!input.rootFile) return { build: false, reason: 'no-root-document' };
  if (isBuildArtefact(input.path, input.rootFile)) return { build: false, reason: 'build-artefact' };
  if (isIgnored(input.path, input.ignore)) return { build: false, reason: 'ignored' };
  if (input.trigger === 'external-change' && mode !== 'onFileChange') {
    return { build: false, reason: 'mode-on-save-does-not-watch-disk' };
  }
  // A save of something TeX does not read — a `.json`, a note, the PDF itself —
  // is not a reason to compile; a change on disk is only interesting for a file
  // the document could depend on.
  if (!isProjectFile(input.path)) return { build: false, reason: 'not-a-source-file' };
  if (input.trigger === 'save' && !isSourceDocument(input.path)) {
    return { build: false, reason: 'not-a-source-file' };
  }
  return { build: true, reason: 'ok' };
}

export interface AutoBuildSchedulerOptions {
  /** Starts a build. Its result is ignored: the build service owns the outcome. */
  build: () => void;
  /** True while a build is running — nothing new may start until it ends. */
  isRunning: () => boolean;
  /** `compilation.autoBuildDelayMs`: how long a burst of triggers is collected. */
  delayMs: () => number;
  /** `compilation.autoBuildMinIntervalMs`: the least time between two builds. */
  minIntervalMs: () => number;
  /**
   * When the last build (manual or automatic) started, from the build service.
   * A manual build resets the interval too, which is what stops `Ctrl+B` from
   * being followed by an automatic build of the same sources a moment later.
   */
  lastBuildStartedAt: () => number | null;
  /** Decisions and schedules, for the probe and for tests. */
  onDecision?: (decision: AutoBuildDecision & { trigger: AutoBuildTrigger; path: string }) => void;
  now?: () => number;
}

/**
 * Turns a stream of triggers into the fewest builds that end with everything
 * compiled: one debounce window, one build at a time, and a minimum gap between
 * two builds.
 */
export class AutoBuildScheduler {
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private waiting: ReturnType<typeof setTimeout> | null = null;
  private lastStart: number | null = null;
  private disposed = false;

  constructor(private readonly options: AutoBuildSchedulerOptions) {}

  /**
   * A save or a disk change happened. Whether it leads to a build is
   * `decideAutoBuild`'s answer, reported through `onDecision` either way — a
   * trigger that was deliberately ignored is the first thing somebody debugging
   * "why did nothing build?" needs to see.
   */
  public request(trigger: AutoBuildTrigger, path: string, context: { mode: string; rootFile: string | null; ignore: readonly string[] }): AutoBuildDecision {
    const decision = decideAutoBuild({ ...context, trigger, path });
    this.options.onDecision?.({ ...decision, trigger, path });
    if (!decision.build || this.disposed) return decision;

    if (this.debounce) clearTimeout(this.debounce);
    if (this.waiting) {
      clearTimeout(this.waiting);
      this.waiting = null;
    }
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.pump();
    }, Math.max(0, this.options.delayMs()));
    return decision;
  }

  /** True while a trigger is collected or a build is waiting for its turn. */
  public isPending(): boolean {
    return this.debounce !== null || this.waiting !== null;
  }

  public dispose(): void {
    this.disposed = true;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.waiting) clearTimeout(this.waiting);
    this.debounce = null;
    this.waiting = null;
  }

  /** Build when the machine is free and the interval has passed; otherwise wait. */
  private pump(): void {
    if (this.disposed) return;
    if (this.options.isRunning()) {
      this.waiting = setTimeout(() => {
        this.waiting = null;
        this.pump();
      }, WAIT_FOR_BUILD_MS);
      return;
    }
    const now = this.options.now?.() ?? Date.now();
    const last = Math.max(this.lastStart ?? 0, this.options.lastBuildStartedAt() ?? 0);
    const waitMs = last + Math.max(0, this.options.minIntervalMs()) - now;
    if (waitMs > 0) {
      this.waiting = setTimeout(() => {
        this.waiting = null;
        this.pump();
      }, waitMs);
      return;
    }
    this.lastStart = now;
    this.options.build();
  }
}

/** How often to look again while a build is still running. */
const WAIT_FOR_BUILD_MS = 250;

function baseName(filePath: string): string {
  const match = /[^\\/]*$/.exec(filePath);
  return match ? match[0] : filePath;
}
