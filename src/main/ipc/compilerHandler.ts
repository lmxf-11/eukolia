/**
 * Eukolia — compiler execution (Electron main process).
 *
 * Recipes and argument construction are resolved in the renderer by the ported
 * LaTeX Workshop build logic; this module only *executes* the resulting plan.
 * That split keeps privileged process launching in the main process
 * (Instructions.md §65) while the reusable recipe logic stays in the renderer.
 *
 * Output is streamed to the renderer as it arrives, and a build can be cancelled
 * at any point without leaving orphan processes behind.
 */

import { ipcMain, BrowserWindow, type WebContents } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { IPC } from '../../shared/ipc';
import { CLEAN_EXTENSIONS } from '../../shared/cleanExtensions';
import { withToolPath } from '../../shared/toolPath';
import type {
  BuildRequest,
  BuildResult,
  BuildStep,
  BuildStepResult,
  CompilerOutputStreamEvent,
  CompilerProgressEvent,
  ToolInfo
} from '../../shared/ipc';

interface RunningBuild {
  jobId: string;
  webContents: WebContents;
  child: ChildProcessWithoutNullStreams | null;
  cancelled: boolean;
  chunks: string[];
  steps: BuildStepResult[];
}

const running = new Map<string, RunningBuild>();

/** Cap on retained compiler output so a runaway log cannot exhaust memory. */
const MAX_LOG_CHARS = 8 * 1024 * 1024;

function send(webContents: WebContents, channel: string, payload: unknown): void {
  if (webContents.isDestroyed()) return;
  webContents.send(channel, payload);
}

function appendChunk(build: RunningBuild, text: string): void {
  build.chunks.push(text);
  let total = 0;
  for (let i = build.chunks.length - 1; i >= 0; i--) {
    total += build.chunks[i].length;
    if (total > MAX_LOG_CHARS) {
      build.chunks.splice(0, i);
      break;
    }
  }
}

function runStep(
  build: RunningBuild,
  step: BuildStep,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number | undefined,
  stepIndex: number,
  totalSteps: number,
  outputDir: string | undefined
): Promise<BuildStepResult> {
  return new Promise((resolve) => {
    const label = step.label ?? step.command;
    const started = Date.now();

    send(build.webContents, IPC.compiler.progress, {
      jobId: build.jobId,
      stepIndex,
      totalSteps,
      label
    } satisfies CompilerProgressEvent);

    appendChunk(build, `\n> ${step.shell ? step.command : `${step.command} ${step.args.join(' ')}`}\n`);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(step.command, step.args, {
        cwd,
        env: { ...env, ...(step.env ?? {}) },
        windowsHide: true,
        // Only `% !TeX options` recipes legitimately need a shell, and the build
        // log always shows the exact command line that was run.
        shell: step.shell === true,
        stdio: 'pipe'
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendChunk(build, `\n[eukolia] failed to launch ${step.command}: ${message}\n`);
      resolve({
        label,
        command: step.command,
        args: step.args,
        code: null,
        signal: null,
        durationMs: Date.now() - started,
        spawnFailed: true,
        errorMessage: message
      });
      return;
    }

    build.child = child;

    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : null;

    const onData = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
      const text = data.toString('utf8');
      appendChunk(build, text);
      send(build.webContents, IPC.compiler.output, {
        jobId: build.jobId,
        stream,
        text
      } satisfies CompilerOutputStreamEvent);
    };

    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));

    /*
     * The operating system's own reason the process never started.
     *
     * `spawn` reports a missing command asynchronously — the call itself
     * succeeds and the `error` event carries `ENOENT` — so "the engine is not
     * installed" is only knowable here, and it has to travel with the step
     * result: the renderer turns this exact string into the sentence the bottom
     * bar shows, and without it a failed launch is indistinguishable from a
     * compiler that exited non-zero.
     */
    let launchError: string | null = null;
    child.on('error', (err) => {
      launchError = err.message;
      appendChunk(build, `\n[eukolia] ${err.message}\n`);
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      build.child = null;
      const durationMs = Date.now() - started;
      if (timedOut) {
        appendChunk(build, `\n[eukolia] step timed out after ${timeoutMs} ms and was terminated\n`);
      }
      // A killed child reports neither an exit code nor a signal on Windows, so
      // "never started" cannot be inferred from the exit alone: an explicit
      // launch error is the evidence, and a timeout is not one.
      const spawnFailed = launchError !== null || (code === null && signal === null && !timedOut);
      const result: BuildStepResult = {
        label,
        command: step.command,
        args: step.args,
        code,
        signal: signal ?? null,
        durationMs,
        spawnFailed
      };
      if (launchError !== null) {
        result.errorMessage = launchError;
      } else if (timedOut) {
        result.errorMessage = `The step was terminated after ${timeoutMs} ms.`;
      }
      send(build.webContents, IPC.compiler.stepFinished, { jobId: build.jobId, step: result });
      resolve(result);
    });

    // TeX reads stdin when it hits an error prompt; closing it makes
    // `-interaction=nonstopmode` behave and prevents a hung build.
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* the child may exit before we write; ignore EPIPE */
      });
      child.stdin.end();
    }
  });
}

async function executeBuild(request: BuildRequest, webContents: WebContents): Promise<BuildResult> {
  const started = Date.now();
  const build: RunningBuild = {
    jobId: request.jobId,
    webContents,
    child: null,
    cancelled: false,
    chunks: [],
    steps: []
  };
  running.set(request.jobId, build);

  const cwd = path.resolve(request.cwd);
  const outputDir = request.outputDir ? path.resolve(request.outputDir) : cwd;

  // `advanced.texPath`: a distribution that is installed but not on the path this
  // process inherited. It is prepended for every step, so the recipe's own
  // commands and the tools they spawn see the same search path.
  const env = withToolPath(process.env, request.toolPath);

  try {
    if (request.parallelGroups && request.parallelGroups.length > 0) {
      for (const group of request.parallelGroups) {
        if (build.cancelled) break;
        // Every step in a group observes the same input state, so they run
        // concurrently; the group as a whole must succeed for the build to go on.
        const results = await Promise.all(
          group.map((index) =>
            runStep(build, request.steps[index], cwd, env, request.timeoutMs, index, request.steps.length, request.outputDir)
          )
        );
        build.steps.push(...results);
        if (results.some((result) => result.code !== 0)) break;
      }
    } else {
      for (let i = 0; i < request.steps.length; i++) {
        if (build.cancelled) break;
        const result = await runStep(build, request.steps[i], cwd, env, request.timeoutMs, i, request.steps.length, request.outputDir);
        build.steps.push(result);
        if (result.code !== 0) break;
      }
    }
  } finally {
    running.delete(request.jobId);
  }

  // Prefer an explicit output directory, then the source directory.
  const candidates = [
    path.join(outputDir, `${request.jobName}.pdf`),
    path.join(cwd, `${request.jobName}.pdf`)
  ];
  const pdfPath = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;

  const synctexCandidates = [
    path.join(outputDir, `${request.jobName}.synctex.gz`),
    path.join(cwd, `${request.jobName}.synctex.gz`),
    path.join(outputDir, `${request.jobName}.synctex`),
    path.join(cwd, `${request.jobName}.synctex`)
  ];
  const synctexPath = synctexCandidates.find((candidate) => fs.existsSync(candidate)) ?? null;

  const lastStep = build.steps[build.steps.length - 1];
  const allStepsOk = build.steps.length > 0 && build.steps.every((s) => s.code === 0);
  const expectedSteps = request.steps.length;
  const completedAll = build.steps.length === expectedSteps;

  return {
    jobId: request.jobId,
    success: !build.cancelled && completedAll && allStepsOk && pdfPath !== null,
    code: lastStep ? lastStep.code : null,
    log: build.chunks.join(''),
    steps: build.steps,
    pdfPath,
    synctexPath,
    durationMs: Date.now() - started,
    cancelled: build.cancelled
  };
}

/**
 * Extensions `compiler:clean` removes when the renderer sent no list.
 *
 * The list itself is `shared/cleanExtensions.ts`, because the settings schema's
 * default — which is what the command normally passes — has to be the same list.
 * Kept as a named export here for the callers that already import it from this
 * module.
 */
const DEFAULT_CLEAN_EXTENSIONS = CLEAN_EXTENSIONS;

function cleanAuxiliaryFiles(rootFile: string, extensions: readonly string[], outputDir?: string): string[] {
  const dir = outputDir ? path.resolve(outputDir) : path.dirname(rootFile);
  const jobName = path.basename(rootFile, path.extname(rootFile));
  const cleaned: string[] = [];

  for (const extension of extensions) {
    const candidate = path.join(dir, `${jobName}.${extension}`);
    if (fs.existsSync(candidate)) {
      try {
        fs.unlinkSync(candidate);
        cleaned.push(candidate);
      } catch {
        /* a locked file is reported by omission */
      }
    }
  }

  return cleaned;
}

async function detectTool(name: string, env: NodeJS.ProcessEnv = process.env): Promise<ToolInfo> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(name, ['--version'], { windowsHide: true, shell: false, stdio: 'pipe', env });
    } catch {
      resolve({ name, path: null, version: null, available: false });
      return;
    }

    let output = '';
    let resolvedPath: string | null = null;
    child.stdout.on('data', (data: Buffer) => {
      if (output.length < 4096) output += data.toString('utf8');
    });
    child.stderr.on('data', (data: Buffer) => {
      if (output.length < 4096) output += data.toString('utf8');
    });
    child.on('error', () => {
      resolve({ name, path: null, version: null, available: false });
    });
    child.on('close', (code) => {
      // `kpsewhich` finds the real binary even when the command was a shim.
      const which = process.platform === 'win32' ? 'where' : 'which';
      const finder = spawn(which, [name], { windowsHide: true, shell: false, stdio: 'pipe', env });
      let found = '';
      finder.stdout.on('data', (data: Buffer) => {
        found += data.toString('utf8');
      });
      finder.on('close', () => {
        resolvedPath = found.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? null;
        const firstLine = output.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
        resolve({
          name,
          path: resolvedPath,
          version: firstLine,
          available: code === 0 || resolvedPath !== null
        });
      });
      finder.on('error', () => {
        const firstLine = output.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
        resolve({ name, path: null, version: firstLine, available: code === 0 });
      });
    });
  });
}

export function registerCompilerHandlers(): void {
  ipcMain.handle(IPC.compiler.build, async (event, request: BuildRequest): Promise<BuildResult> => {
    return executeBuild(request, event.sender);
  });

  ipcMain.handle(IPC.compiler.cancel, async (_event, jobId: string): Promise<boolean> => {
    const build = running.get(jobId);
    if (!build) return false;
    build.cancelled = true;
    const child = build.child;
    if (child && child.pid !== undefined) {
      if (process.platform === 'win32') {
        // TeX spawns children (biber, makeindex); kill the whole tree.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    }
    return true;
  });

  ipcMain.handle(
    IPC.compiler.clean,
    async (_event, rootFile: string, extensions?: string[], outputDir?: string): Promise<string[]> => {
      return cleanAuxiliaryFiles(rootFile, extensions ?? DEFAULT_CLEAN_EXTENSIONS, outputDir);
    }
  );

  ipcMain.handle(IPC.compiler.detectTools, async (_event, names: string[], toolPath?: string): Promise<ToolInfo[]> => {
    // Detection searches where a build would: a distribution named by
    // `advanced.texPath` is found by the picker as well as by the compiler, so
    // the recipes it makes runnable are the ones that are offered as runnable.
    const env = withToolPath(process.env, toolPath);
    return Promise.all(names.map((name) => detectTool(name, env)));
  });
}

/** Terminates every running build — called on window close and app quit. */
export function disposeCompiler(): void {
  for (const build of running.values()) {
    build.cancelled = true;
    const pid = build.child?.pid;
    if (pid !== undefined) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        build.child?.kill('SIGKILL');
      }
    }
  }
  running.clear();
}

export { DEFAULT_CLEAN_EXTENSIONS };

/** Broadcasts a build event to every window (used by the protocol handler). */
export function broadcastBuildEvent(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }
}
