/**
 * Eukolia build service (renderer side).
 *
 * Turns the current project + settings into a `BuildRequest` and drives it
 * through the main process. The recipe resolution itself comes from the ported
 * LaTeX Workshop code (`vendor/latex-workshop/compile/*`) via
 * `compiler/buildRequest.ts`, wired in `services/bootstrap.ts`; this module owns
 * build lifecycle, output streaming, log parsing, diagnostics and the statement
 * of what went wrong.
 *
 * Compilation never blocks the UI: the work happens in a child process and every
 * result arrives as an event (Instructions.md §32, §60, §62).
 *
 * **The plan is resolved, not reassembled.** A resolved build is one
 * `BuildRequest` — where it runs, where it writes, what it runs — and this
 * service only adds the job identity to it. The earlier version rebuilt the
 * request here out of its own idea of the working directory
 * (`outputDirectory ?? workspaceDir ?? rootDir`), which is not the directory the
 * recipe resolved its relative arguments against: a `bibtex` step given
 * `%DOCFILE%` was told `main` and then run somewhere `main.aux` was not.
 */

import { EventEmitter } from '../core/events';
import { setting } from '../core/settings';
import { projectIndex } from '../document/projectIndex';
import { parseLatexLogFull, type DiagnosticItem } from '../compiler/logParser';
import {
  describeBuildFailure,
  failureDiagnostic,
  type BuildFailure
} from '../compiler/buildFailure';
import { CATALOG_COMMANDS } from '../compiler/recipeCatalog';
import type { BuildRequest, BuildResult, CompilerOutputStreamEvent, ToolInfo } from '../../shared/ipc';

/** One recipe the picker may offer, and whether this machine can run it. */
export interface RecipeOption {
  name: string;
  /** Tool names in the recipe's own order, e.g. `['pdflatex', 'bibtex', …]`. */
  tools: string[];
  /** The commands those tools launch, deduplicated, in order. */
  commands: string[];
  /** False when a command the recipe needs is not on `PATH`. */
  available: boolean;
  /** The commands that are missing, for the picker's tooltip. */
  missing: string[];
}

/**
 * The recipes the build service can offer, resolved from the same settings the
 * plan builder reads. Implemented by `services/bootstrap.ts`, which owns the
 * bridge into the ported `latex.recipes` / `latex.tools`.
 */
export interface RecipeCatalog {
  list(): RecipeOption[];
}

/**
 * Resolves a build plan just before a build starts. Recipe resolution reads
 * magic comments from disk, so it is asynchronous — this is the seam that keeps
 * the ported LaTeX Workshop resolver out of the build lifecycle itself.
 *
 * It returns the whole request rather than a list of steps: only the resolver
 * knows the recipe's working directory, its output directory and the job name
 * the PDF will carry.
 */
export type BuildPlanResolver = (
  rootFile: string,
  recipeName: string | null,
  options?: { force?: boolean }
) => Promise<ResolvedPlan>;

export interface ResolvedPlan {
  /** The request to execute, or null when resolution failed. */
  request: BuildRequest | null;
  recipeName: string;
  /** Present when resolution failed; `request` is then null. */
  error?: string;
  /** Things the resolver worked around; the build still runs. */
  warnings: string[];
}

export interface BuildState {
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  jobId: string | null;
  startedAt: number | null;
  durationMs: number | null;
  stepIndex: number;
  totalSteps: number;
  currentLabel: string;
  output: string;
  diagnostics: DiagnosticItem[];
  errorCount: number;
  warningCount: number;
  pdfPath: string | null;
  /** True when latexmk reported nothing to do. */
  skipped: boolean;
  /**
   * Exactly why the last build failed, or null when it did not.
   *
   * The bottom bar prints `formatBuildFailure(failure)`, the Problems list
   * carries `failureDiagnostic(failure, rootFile)` when the compiler reported
   * nothing of its own, and the status bar's build tooltip repeats it. One
   * value, three readers — so they cannot disagree about what happened.
   */
  failure: BuildFailure | null;
  /** The recipe the last build (or the last attempt) used. */
  recipeName: string | null;
  /** The root document the last build was for. */
  rootFile: string | null;
  /** Tools the recipe named that do not exist; the build ran without them. */
  warnings: string[];
}

const EMPTY_STATE: BuildState = {
  status: 'idle',
  jobId: null,
  startedAt: null,
  durationMs: null,
  stepIndex: 0,
  totalSteps: 0,
  currentLabel: '',
  output: '',
  diagnostics: [],
  errorCount: 0,
  warningCount: 0,
  pdfPath: null,
  skipped: false,
  failure: null,
  recipeName: null,
  rootFile: null,
  warnings: []
};

export class BuildService extends EventEmitter {
  private catalog: RecipeCatalog | null = null;
  private recipes: RecipeOption[] = [];
  private planResolver: BuildPlanResolver | null = null;
  private state: BuildState = { ...EMPTY_STATE };
  private jobCounter = 0;
  private readonly unsubscribers: Array<() => void> = [];
  private toolCache: ToolInfo[] | null = null;
  private attached = false;

  constructor() {
    super();
    // IPC listeners are attached lazily by `ensureAttached()` rather than here,
    // so importing this module has no side effects and does not require the
    // preload bridge to exist (which matters for tests and for the main-process
    // graph, where `window.eukoliaApi` is absent).
  }

  /** Attaches the streaming listeners once, on first use. */
  private ensureAttached(): void {
    if (this.attached) return;
    this.attached = true;
    this.attachIpc();
  }

  public setRecipeCatalog(catalog: RecipeCatalog | null): void {
    this.catalog = catalog;
    this.refreshRecipes();
  }

  public setPlanResolver(resolver: BuildPlanResolver | null): void {
    this.planResolver = resolver;
  }

  private get api() {
    return window.eukoliaApi;
  }

  private attachIpc(): void {
    this.unsubscribers.push(
      this.api.onCompilerOutput((event: CompilerOutputStreamEvent) => {
        if (event.jobId !== this.state.jobId) return;
        this.state = { ...this.state, output: appendBounded(this.state.output, event.text) };
        this.emit('output', event);
      })
    );

    this.unsubscribers.push(
      this.api.onCompilerProgress((event) => {
        if (event.jobId !== this.state.jobId) return;
        this.state = {
          ...this.state,
          stepIndex: event.stepIndex + 1,
          totalSteps: event.totalSteps,
          currentLabel: event.label
        };
        this.emit('state', this.getState());
      })
    );
  }

  public dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  public getState(): BuildState {
    return { ...this.state };
  }

  public isRunning(): boolean {
    return this.state.status === 'running';
  }

  // ------------------------------------------------------------------ tooling

  /**
   * Detects which TeX tools are actually installed, caching the result.
   *
   * The probed set is the catalogue's commands, so one pass answers both
   * questions the shell asks: which distribution is installed (the status bar)
   * and whether a recipe can run (the picker).
   */
  public async detectTools(force = false): Promise<ToolInfo[]> {
    this.ensureAttached();
    if (this.toolCache && !force) return this.toolCache;
    const names = this.commandsToDetect();
    this.toolCache = await this.api.detectTools(names, this.toolPath());
    return this.toolCache;
  }

  /**
   * `advanced.texPath`: a TeX distribution the application was not launched with
   * on its `PATH`.
   *
   * Detection and the build read it from the same place, which is what keeps the
   * picker honest: a recipe is marked runnable exactly when the command it
   * launches would be found by the build that runs it.
   */
  private toolPath(): string | undefined {
    const configured = setting.str('advanced.texPath').trim();
    return configured || undefined;
  }

  /** The last detection result, without touching the filesystem. */
  public getTools(): ToolInfo[] {
    return this.toolCache ?? [];
  }

  /** The recipes currently offered, with their availability. */
  public getRecipes(): RecipeOption[] {
    return this.recipes;
  }

  /**
   * Re-reads the recipe list from the settings and marks each recipe against the
   * detected tools. Called on startup, after a settings change and when the user
   * asks for a fresh detection.
   */
  public refreshRecipes(): RecipeOption[] {
    if (!this.catalog) return [];
    const detected = new Map((this.toolCache ?? []).map((tool) => [tool.name.toLowerCase(), tool.available]));
    this.recipes = this.catalog.list().map((recipe) => {
      // A recipe is offered as runnable only when every command it launches was
      // found. An empty detection result means "not probed yet" rather than
      // "nothing is installed", and the picker must not grey out every recipe
      // during the second before the probe answers.
      const unknown = detected.size === 0;
      const missing = unknown ? [] : recipe.commands.filter((command) => detected.get(command.toLowerCase()) !== true);
      return { ...recipe, available: missing.length === 0, missing };
    });
    return this.recipes;
  }

  /** Every command a probe should look for: the catalogue plus any user recipe. */
  private commandsToDetect(): string[] {
    const names = new Set<string>(CATALOG_COMMANDS);
    for (const recipe of this.catalog?.list() ?? []) {
      for (const command of recipe.commands) names.add(command);
    }
    return [...names];
  }

  // ------------------------------------------------------------------ building

  /**
   * Builds the project. When `rootFile` is omitted the root document detected for
   * the workspace is used, falling back to the active document.
   */
  public async build(options: { rootFile?: string; recipeName?: string; force?: boolean } = {}): Promise<BuildResult | null> {
    this.ensureAttached();
    if (this.state.status === 'running') {
      await this.cancel();
    }

    const rootFile = options.rootFile ?? projectIndex.getRootDocumentPath() ?? null;
    if (!rootFile) {
      this.fail('No root document: open a .tex file or set a project root first.', rootFile);
      return null;
    }
    if (!this.planResolver) {
      this.fail('The build recipe resolver is not available.', rootFile);
      return null;
    }

    const requestedRecipe = options.recipeName ?? setting.str('compilation.recipe') ?? null;

    let plan: ResolvedPlan;
    try {
      plan = await this.planResolver(rootFile, requestedRecipe && requestedRecipe !== 'default' ? requestedRecipe : null, {
        force: options.force === true
      });
    } catch (err) {
      this.fail(`Could not resolve a build recipe: ${err instanceof Error ? err.message : String(err)}`, rootFile);
      return null;
    }

    if (plan.error || !plan.request) {
      this.fail(plan.error ?? 'Could not resolve a build recipe.', rootFile, plan.recipeName);
      return null;
    }

    const steps = plan.request.steps;
    if (steps.length === 0) {
      this.fail(`The recipe "${plan.recipeName}" produced no executable steps.`, rootFile, plan.recipeName);
      return null;
    }

    const jobId = `build-${Date.now()}-${++this.jobCounter}`;
    const toolPath = this.toolPath();
    const request: BuildRequest = { ...plan.request, jobId, ...(toolPath ? { toolPath } : {}) };
    const warnings = plan.warnings ?? [];

    this.state = {
      ...EMPTY_STATE,
      status: 'running',
      jobId,
      startedAt: Date.now(),
      totalSteps: steps.length,
      stepIndex: 0,
      currentLabel: steps[0]?.label ?? steps[0]?.command ?? '',
      recipeName: plan.recipeName,
      rootFile,
      warnings,
      // The resolver's own remarks open the log: they are the first thing a
      // reader needs when the command lines below are not the ones the settings
      // asked for.
      output: warningsHeader(warnings)    };
    this.emit('state', this.getState());
    this.emit('started', request);

    try {
      const result = await this.api.build(request);
      this.applyResult(result, rootFile, request.jobName);
      return result;
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err), rootFile, plan.recipeName);
      return null;
    }
  }

  public async cancel(): Promise<void> {
    this.ensureAttached();
    if (!this.state.jobId) return;
    const cancelled = await this.api.cancelBuild(this.state.jobId);
    if (cancelled) {
      this.state = { ...this.state, status: 'cancelled', failure: null };
      this.emit('state', this.getState());
    }
  }

  private applyResult(result: BuildResult, rootFile: string, jobName: string): void {
    const parsed = parseLatexLogFull(result.log, { rootFile });
    const failure = describeBuildFailure(result, { diagnostics: parsed.diagnostics, jobName });

    /*
     * A failure the compiler cannot explain becomes a problem of its own.
     *
     * `pdflatex exited with code 1` is a fact about the build; the sentence after
     * it — `! Undefined control sequence.` — is a fact about the source, and when
     * the compiler produced one there is nothing to add. When it produced
     * nothing (an engine that is absent, a recipe that names a tool that does not
     * exist) the Problems list would otherwise be empty under a heading that says
     * the build failed, so the failure itself is listed.
     */
    const hasErrorDiagnostic = parsed.errorCount > 0;
    const failureItems = failure && !hasErrorDiagnostic ? [failureDiagnostic(failure, rootFile)] : [];
    const diagnostics = [...parsed.diagnostics, ...failureItems];

    this.state = {
      ...this.state,
      status: result.cancelled ? 'cancelled' : result.success ? 'succeeded' : 'failed',
      durationMs: result.durationMs,
      // The resolver's remarks are not in the compiler's own log — they were made
      // before it started — so they are put back in front of it.
      output: warningsHeader(this.state.warnings) + result.log,
      diagnostics,
      errorCount: parsed.errorCount + failureItems.filter((item) => item.severity === 'error').length,
      warningCount: parsed.warningCount,
      pdfPath: result.pdfPath,
      skipped: parsed.isLaTeXmkSkipped,
      stepIndex: result.steps.length,
      // The plan's own step count, not the number that ran: a build that stopped
      // at step 1 of 4 says "1/4", and the four is what tells the reader the
      // recipe had more to do.
      totalSteps: Math.max(this.state.totalSteps, result.steps.length),
      failure,
      rootFile
    };

    this.emit('state', this.getState());
    this.emit('finished', result);
    if (failure) this.emit('failed', failure);

    // `compilation.cleanAfterFailedBuild`: the auxiliary files of a build that
    // failed are what makes the *next* build fail the same way, so a user who
    // asked for this gets it without a second command.
    if (failure && setting.bool('compilation.cleanAfterFailedBuild')) {
      void this.clean(rootFile).catch(() => undefined);
    }
  }

  private fail(message: string, rootFile: string | null, recipeName: string | null = null): void {
    const failure: BuildFailure = { kind: 'recipe', message };
    this.state = {
      ...this.state,
      status: 'failed',
      failure,
      recipeName,
      rootFile: rootFile ?? this.state.rootFile,
      output: appendBounded(this.state.output, `\n[eukolia] ${message}\n`),
      diagnostics: rootFile ? [failureDiagnostic(failure, rootFile)] : this.state.diagnostics,
      errorCount: this.state.errorCount + 1
    };
    this.emit('state', this.getState());
    this.emit('error', message);
    this.emit('failed', failure);
  }

  /** Removes the auxiliary files a build produced (Instructions.md §32). */
  public async clean(rootFile?: string): Promise<string[]> {
    this.ensureAttached();
    const target = rootFile ?? projectIndex.getRootDocumentPath();
    if (!target) return [];
    const outputDirectorySetting = setting.str('compilation.outputDirectory').trim();
    const workspaceDir = projectIndex.getProjectRoot();
    const outputDirectory = outputDirectorySetting
      ? (workspaceDir ? joinPath(workspaceDir, outputDirectorySetting) : outputDirectorySetting)
      : undefined;

    const cleaned = await this.api.cleanAuxiliaryFiles(target, setting.list('compilation.cleanExtensions'), outputDirectory);
    this.emit('cleaned', cleaned);
    return cleaned;
  }

  public clearOutput(): void {
    // The failure goes with the output it explains: a panel that says "Build
    // failed: pdflatex exited with code 1" over an empty log is worse than one
    // that has been cleared outright.
    this.state = {
      ...this.state,
      output: '',
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      failure: this.state.status === 'failed' ? null : this.state.failure
    };
    this.emit('state', this.getState());
  }
}

/** Keeps the compiler log bounded so a runaway build cannot exhaust memory. */
function appendBounded(existing: string, chunk: string, maximum = 4 * 1024 * 1024): string {
  const next = existing + chunk;
  return next.length <= maximum ? next : next.slice(next.length - maximum);
}

/** The resolver's remarks, as the lines that open the compiler log. */
function warningsHeader(warnings: readonly string[]): string {
  return warnings.map((warning) => `[eukolia] ${warning}\n`).join('');
}

function joinPath(directory: string, relative: string): string {
  const separator = directory.includes('\\') ? '\\' : '/';
  const cleaned = relative.replace(/^[\\/]+/, '').replace(/[\\/]+/g, separator);
  return `${directory.replace(/[\\/]+$/, '')}${separator}${cleaned}`;
}

export const buildService = new BuildService();
