/**
 * Eukolia — why a build failed, in one sentence.
 *
 * A build can fail in five different places, and they used to reach the shell as
 * the same two words: `Build failed`. The detail existed — an exit code in
 * `BuildStepResult.code`, `spawn ENOENT` in the compiler log, a recipe error in
 * the status message — but nothing put it together, so the panel that opened was
 * the *Problems* list with nothing in it and no statement anywhere of what had
 * actually gone wrong.
 *
 * This module is that statement, as a pure function of the build result, so the
 * bottom panel, the status bar and the tests all read the same sentence.
 *
 * The distinction that matters most is the one between a build that *ran* and a
 * build that never started:
 *
 *   - `launch`  — the command could not be spawned at all (usually `ENOENT`:
 *                 the engine is not installed or not on `PATH`). No compiler
 *                 output exists, so nothing downstream can explain it; the OS
 *                 error is the whole story.
 *   - `exit`    — the command ran and exited non-zero. The compiler's own first
 *                 error message is the useful part, so it is quoted.
 *   - `output`  — every step succeeded and no PDF appeared: the build "worked"
 *                 and produced nothing, which is never what the user wanted.
 *   - `recipe`  — resolution failed before anything ran.
 *   - `timeout` — a step exceeded the configured limit and was killed.
 */

import type { BuildResult, BuildStepResult } from '../../shared/ipc'
import type { DiagnosticItem } from './logParser'

export type BuildFailureKind = 'recipe' | 'launch' | 'exit' | 'output' | 'timeout'

export interface BuildFailure {
  kind: BuildFailureKind;
  /** One sentence naming exactly what failed. Shown in the bottom bar. */
  message: string;
  /** The command line that failed, verbatim, when a step was involved. */
  command?: string;
  /** Exit code of the failed step; null when the process never started. */
  code?: number | null;
  /** The step's label, e.g. `pdflatex (main)`. */
  step?: string;
  /** 1-based position of the failed step in the plan. */
  stepIndex?: number;
  totalSteps?: number;
  /** The operating system's own message when the process could not be started. */
  launchError?: string;
  /**
   * The first compiler error, when the log parser found one. This is the line a
   * reader wants next to the exit code: `pdflatex exited with code 1` says a
   * build failed, `! Undefined control sequence.` says what to fix.
   */
  detail?: string;
}

/** How a step is named in a failure sentence. */
export function describeStepCommand(step: BuildStepResult): string {
  const args = step.args ?? [];
  return args.length > 0 ? `${step.command} ${args.join(' ')}` : step.command;
}

function isTimeout(build: BuildResult, step: BuildStepResult): boolean {
  // A killed step reports neither an exit code nor a signal on Windows, which is
  // also what a spawn failure looks like; the compiler log is where the main
  // process records which of the two it was.
  return !step.spawnFailed && step.code === null && step.signal === null && /timed out after/i.test(build.log);
}

/**
 * The first error the compiler reported, as one line. Diagnostics arrive in
 * compiler order, so the first error is the one that caused the rest.
 */
export function firstErrorDetail(diagnostics: readonly DiagnosticItem[]): string | undefined {
  const error = diagnostics.find((item) => item.severity === 'error' && item.message.trim().length > 0);
  if (!error) return undefined;
  const message = error.message.replace(/\s+/g, ' ').trim();
  return message.length > 220 ? `${message.slice(0, 217)}…` : message;
}

/**
 * Turns a finished build into the reason it failed, or `null` when it did not.
 *
 * `cancelled` is not a failure: the reader asked for it.
 */
export function describeBuildFailure(
  build: BuildResult,
  options: { diagnostics?: readonly DiagnosticItem[]; jobName?: string } = {}
): BuildFailure | null {
  if (build.cancelled || build.success) {
    return null;
  }
  const detail = firstErrorDetail(options.diagnostics ?? []);
  const steps = build.steps ?? [];
  const failed = steps.find((step) => step.spawnFailed || step.code !== 0) ?? steps[steps.length - 1];
  const index = failed ? steps.indexOf(failed) + 1 : 0;
  const position = failed && steps.length > 1 ? ` (step ${index} of ${steps.length})` : '';

  if (!failed) {
    return {
      kind: 'output',
      message: build.steps.length === 0
        ? 'The build ran no steps.'
        : `The build produced no ${options.jobName ? `${options.jobName}.pdf` : 'PDF'}.`,
      detail
    };
  }

  if (failed.spawnFailed) {
    const reason = failed.errorMessage?.trim() || `${failed.command} could not be started`;
    return {
      kind: 'launch',
      message: `${reason}${position}`,
      command: describeStepCommand(failed),
      code: null,
      step: failed.label,
      stepIndex: index,
      totalSteps: steps.length,
      launchError: failed.errorMessage,
      detail
    };
  }

  if (isTimeout(build, failed)) {
    return {
      kind: 'timeout',
      message: `${failed.command} was terminated after the configured time limit${position}`,
      command: describeStepCommand(failed),
      code: null,
      step: failed.label,
      stepIndex: index,
      totalSteps: steps.length,
      detail
    };
  }

  if (failed.code !== 0) {
    return {
      kind: 'exit',
      message: `${failed.command} exited with code ${failed.code}${position}`,
      command: describeStepCommand(failed),
      code: failed.code,
      step: failed.label,
      stepIndex: index,
      totalSteps: steps.length,
      detail
    };
  }

  // Every step exited 0 and the run still failed: the output is not there.
  return {
    kind: 'output',
    message: `The build finished but produced no ${options.jobName ? `${options.jobName}.pdf` : 'PDF'}`,
    command: describeStepCommand(failed),
    code: failed.code,
    step: failed.label,
    stepIndex: index,
    totalSteps: steps.length,
    detail
  };
}

/** The failure as one line, as the bottom bar prints it. */
export function formatBuildFailure(failure: BuildFailure): string {
  return failure.detail ? `${failure.message} — ${failure.detail}` : failure.message;
}

/**
 * The diagnostic the Problems list carries when a build fails without the
 * compiler having reported anything a source line can be blamed for.
 *
 * A build that never started has no `! Undefined control sequence.` to point at,
 * and an empty Problems list next to the word "failed" is exactly the report
 * that sends a reader looking in the wrong place. The synthetic entry is marked
 * with line 0, which is what makes it non-navigable — there is nowhere to go.
 */
export function failureDiagnostic(failure: BuildFailure, rootFile: string): DiagnosticItem {
  return {
    file: rootFile,
    line: 0,
    severity: 'error',
    message: failure.message,
    source: 'latexmk',
    code: `eukolia.build.${failure.kind}`,
    level: 'error',
    raw: formatBuildFailure(failure),
    category: 'build'
  };
}
