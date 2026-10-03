/**
 * The build service: what it tells the shell after a build.
 *
 * The shell has one source for a build's outcome — `BuildState` — and the bottom
 * panel, the status bar and the Problems list all read it. These tests pin the
 * three values that used to be missing from it:
 *
 *   - `failure`, the sentence that says exactly what went wrong (a launch error,
 *     an exit code, a missing PDF), which is what replaced the words "Build
 *     failed";
 *   - the synthetic `diagnostics` entry that keeps the Problems list from being
 *     empty under a heading that says the build failed;
 *   - `recipeName`, so the status bar names the recipe that ran rather than the
 *     setting that selected it.
 *
 * `window.eukoliaApi` is stubbed rather than mocked at the module boundary,
 * because the service's own logic — the order it sets state in, what it does
 * with a step result — is what is under test, not the IPC call.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildRequest, BuildResult, BuildStepResult, ToolInfo } from '../../src/shared/ipc';
import { BuildService, type RecipeCatalog } from '../../src/renderer/services/build';

/**
 * The catalogue the settings bridge would hand the service, with two recipes
 * whose tools this machine has and one whose tool it does not.
 */
const CATALOG: RecipeCatalog = {
  list: () => [
    { name: 'latexmk', tools: ['latexmk'], commands: ['latexmk'], available: true, missing: [] },
    {
      name: 'pdflatex -> bibtex -> pdflatex * 2',
      tools: ['pdflatex', 'bibtex', 'pdflatex', 'pdflatex'],
      commands: ['pdflatex', 'bibtex'],
      available: true,
      missing: []
    },
    { name: 'tectonic', tools: ['tectonic'], commands: ['tectonic'], available: true, missing: [] }
  ]
};

const REQUEST: BuildRequest = {
  jobId: 'job-1',
  cwd: 'C:/proj',
  jobName: 'main',
  steps: [
    { command: 'latexmk', args: ['-pdf', 'C:/proj/main'], label: 'latexmk (main)' }
  ]
};

function stepResult(overrides: Partial<BuildStepResult> = {}): BuildStepResult {
  return {
    label: 'latexmk (main)',
    command: 'latexmk',
    args: ['-pdf', 'C:/proj/main'],
    code: 0,
    signal: null,
    durationMs: 900,
    spawnFailed: false,
    ...overrides
  };
}

function buildResult(overrides: Partial<BuildResult> = {}): BuildResult {
  return {
    jobId: 'job-1',
    success: false,
    code: 1,
    log: '! Undefined control sequence.\n',
    steps: [stepResult({ code: 1 })],
    pdfPath: null,
    synctexPath: null,
    durationMs: 900,
    cancelled: false,
    ...overrides
  };
}

/**
 * A compiler log the ported parser understands.
 *
 * The dispatcher only parses LaTeX output for a run that *finished* — it keys on
 * `Output written on …`, `No pages of output.` or a fatal error — so a log with
 * the error line alone parses to nothing at all. That is worth knowing in its own
 * right: it is why a failed build can report no compiler error, and therefore why
 * the failure itself has to be able to become one.
 */
const FILE_LINE_ERROR_LOG = [
  'This is pdfTeX, Version 3.141592653-2.40-1.40.26 (MiKTeX 24.1)',
  '(./main.tex',
  './main.tex:12: Undefined control sequence.',
  'l.12 \\\\notacommand',
  '                  ',
  ')',
  'No pages of output.',
  'Transcript written on main.log.'
].join('\n');

interface Stub {
  detectTools: ReturnType<typeof vi.fn>;
  build: ReturnType<typeof vi.fn>;
  cancelBuild: ReturnType<typeof vi.fn>;
  cleanAuxiliaryFiles: ReturnType<typeof vi.fn>;
}

function installStub(overrides: Partial<Stub> = {}): Stub {
  const stub: Stub = {
    detectTools: vi.fn(async (names: string[]): Promise<ToolInfo[]> =>
      names.map((name) => ({
        name,
        path: name === 'tectonic' ? null : `C:/tex/bin/${name}.exe`,
        version: name === 'pdflatex' ? 'MiKTeX-pdfTeX 4.11 (MiKTeX 24.1)' : `${name} 1.0`,
        available: name !== 'tectonic'
      }))
    ),
    build: vi.fn(async () => buildResult()),
    cancelBuild: vi.fn(async () => true),
    cleanAuxiliaryFiles: vi.fn(async () => []),
    ...overrides
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      eukoliaApi: {
        ...stub,
        onCompilerOutput: () => () => undefined,
        onCompilerProgress: () => () => undefined
      }
    }
  });
  return stub;
}

/** A service with the catalogue and a resolver that always answers `REQUEST`. */
function service(plan?: () => Promise<{
  request: BuildRequest | null;
  recipeName: string;
  error?: string;
  warnings: string[];
}>): BuildService {
  const instance = new BuildService();
  instance.setRecipeCatalog(CATALOG);
  instance.setPlanResolver(
    plan ??
      (async () => ({
        request: { ...REQUEST, steps: REQUEST.steps.map((step) => ({ ...step })) },
        recipeName: 'latexmk',
        warnings: []
      }))
  );
  return instance;
}

beforeEach(() => {
  installStub();
});

describe('the recipe list the picker shows', () => {
  it('is not marked against tools before anything has been probed', () => {
    const instance = service();
    const recipes = instance.getRecipes();
    expect(recipes.map((recipe) => recipe.name)).toEqual(['latexmk', 'pdflatex -> bibtex -> pdflatex * 2', 'tectonic']);
    // Unknown is not missing: the picker must not grey everything out during the
    // second before the probe answers.
    expect(recipes.every((recipe) => recipe.available)).toBe(true);
  });

  it('marks a recipe with a tool this machine lacks, and names it', async () => {
    const instance = service();
    await instance.detectTools(true);
    const recipes = instance.refreshRecipes();
    expect(recipes[0].available).toBe(true);
    expect(recipes[1].available).toBe(true);
    expect(recipes[2].available).toBe(false);
    expect(recipes[2].missing).toEqual(['tectonic']);
  });

  it('probes every command the catalogue names, plus the engines', async () => {
    const stub = installStub();
    const instance = service();
    await instance.detectTools(true);
    const probed = stub.detectTools.mock.calls[0][0] as string[];
    for (const command of ['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'bibtex', 'biber', 'tectonic']) {
      expect(probed).toContain(command);
    }
  });
});

describe('a failed build', () => {
  it('publishes the exact failure and names the recipe and root file', async () => {
    const instance = service();
    const result = await instance.build({ rootFile: 'C:/proj/main.tex' });
    expect(result).not.toBeNull();
    const state = instance.getState();
    expect(state.status).toBe('failed');
    expect(state.failure?.kind).toBe('exit');
    expect(state.failure?.message).toBe('latexmk exited with code 1');
    expect(state.recipeName).toBe('latexmk');
    expect(state.rootFile).toBe('C:/proj/main.tex');
    expect(state.pdfPath).toBeNull();
  });

  it('adds the failure to the Problems list when the compiler reported no error of its own', async () => {
    installStub({ build: vi.fn(async () => buildResult({ log: '', steps: [stepResult({ code: 1 })] })) });
    const instance = service();
    await instance.build({ rootFile: 'C:/proj/main.tex' });
    const state = instance.getState();
    expect(state.errorCount).toBe(1);
    expect(state.diagnostics).toHaveLength(1);
    expect(state.diagnostics[0]).toMatchObject({
      file: 'C:/proj/main.tex',
      line: 0,
      severity: 'error',
      category: 'build'
    });
  });

  it('still reports the failure when the log said something the parser could not place', async () => {
    // `! Undefined control sequence.` with no file, line or `l.<n>` echo is what
    // the parser returns nothing for — the case that made an empty Problems list
    // under the word "failed" possible in the first place.
    const instance = service();
    await instance.build({ rootFile: 'C:/proj/main.tex' });
    const state = instance.getState();
    expect(state.failure?.kind).toBe('exit');
    expect(state.diagnostics).toHaveLength(1);
    expect(state.diagnostics[0].category).toBe('build');
  });

  it('does not duplicate an error the compiler already reported', async () => {
    installStub({
      build: vi.fn(async () => buildResult({ log: FILE_LINE_ERROR_LOG, steps: [stepResult({ code: 1 })] }))
    });
    const instance = service();
    await instance.build({ rootFile: 'C:/proj/main.tex' });
    const state = instance.getState();
    // The log parser found the `-file-line-error` error, so the Problems list
    // already says which line to look at; a second row saying "the build failed"
    // would be noise beside it.
    expect(state.diagnostics.length).toBeGreaterThan(0);
    expect(state.diagnostics.some((item) => item.category === 'build')).toBe(false);
    expect(state.errorCount).toBe(state.diagnostics.filter((item) => item.severity === 'error').length);
  });

  it('reports a step that could not be launched as a launch failure', async () => {
    installStub({
      build: vi.fn(async () =>
        buildResult({
          log: '[eukolia] spawn tectonic ENOENT\n',
          steps: [stepResult({ command: 'tectonic', code: null, spawnFailed: true, errorMessage: 'spawn tectonic ENOENT' })],
          code: null
        })
      )
    });
    const instance = service();
    await instance.build({ rootFile: 'C:/proj/main.tex' });
    const state = instance.getState();
    expect(state.failure?.kind).toBe('launch');
    expect(state.failure?.message).toBe('spawn tectonic ENOENT');
    expect(state.diagnostics[0].code).toBe('eukolia.build.launch');
  });

  it('reports a build that produced no PDF although every step succeeded', async () => {
    installStub({ build: vi.fn(async () => buildResult({ log: 'ok\n', steps: [stepResult()], code: 0 })) });
    const instance = service();
    await instance.build({ rootFile: 'C:/proj/main.tex' });
    const state = instance.getState();
    expect(state.failure?.kind).toBe('output');
    expect(state.failure?.message).toBe('The build finished but produced no main.pdf');
  });

  it('emits the failure so the shell can show it without re-deriving it', async () => {
    const instance = service();
    const seen: string[] = [];
    instance.on('failed', (failure: { message: string }) => seen.push(failure.message));
    await instance.build({ rootFile: 'C:/proj/main.tex' });
    expect(seen).toEqual(['latexmk exited with code 1']);
  });
});

describe('a build that resolved nothing', () => {
  it('reports the resolver\'s own words and keeps them in the log', async () => {
    const instance = service(async () => ({
      request: null,
      recipeName: 'pdflatex ➞ bibtex ➞ pdflatex ×2',
      error: '[Builder] Failed to resolve build recipe: pdflatex ➞ bibtex ➞ pdflatex ×2.',
      warnings: []
    }));
    const result = await instance.build({ rootFile: 'C:/proj/main.tex' });
    expect(result).toBeNull();
    const state = instance.getState();
    expect(state.status).toBe('failed');
    expect(state.failure?.kind).toBe('recipe');
    expect(state.failure?.message).toContain('Failed to resolve build recipe');
    expect(state.output).toContain('Failed to resolve build recipe');
    expect(state.recipeName).toBe('pdflatex ➞ bibtex ➞ pdflatex ×2');
    // The panel opens on the Output view when there is nothing to navigate to,
    // which it decides from this: a single problem with no line.
    expect(state.diagnostics.every((item) => item.line === 0)).toBe(true);
  });

  it('refuses a recipe that expands to no runnable steps', async () => {
    const instance = service(async () => ({ request: { ...REQUEST, steps: [] }, recipeName: 'mine', warnings: ['Skipping undefined tool "pdflatexx" in recipe "mine".'] }));
    await instance.build({ rootFile: 'C:/proj/main.tex' });
    expect(instance.getState().failure?.message).toContain('no executable steps');
  });

  it('carries the resolver\'s warnings into the log', async () => {
    const instance = service(async () => ({
      request: { ...REQUEST },
      recipeName: 'mine',
      warnings: ['Skipping undefined tool "pdflatexx" in recipe "mine".']
    }));
    await instance.build({ rootFile: 'C:/proj/main.tex' });
    const state = instance.getState();
    expect(state.warnings).toHaveLength(1);
    expect(state.output).toContain('Skipping undefined tool');
  });
});

describe('a successful build', () => {
  it('clears the failure and adopts the PDF', async () => {
    installStub({
      build: vi.fn(async () => buildResult({ success: true, code: 0, steps: [stepResult()], pdfPath: 'C:/proj/main.pdf' }))
    });
    const instance = service();
    await instance.build({ rootFile: 'C:/proj/main.tex' });
    const state = instance.getState();
    expect(state.status).toBe('succeeded');
    expect(state.failure).toBeNull();
    expect(state.pdfPath).toBe('C:/proj/main.pdf');
  });

  it('forgets the failure when the output is cleared', async () => {
    const instance = service();
    await instance.build({ rootFile: 'C:/proj/main.tex' });
    expect(instance.getState().failure).not.toBeNull();
    instance.clearOutput();
    const state = instance.getState();
    expect(state.output).toBe('');
    expect(state.failure).toBeNull();
    expect(state.errorCount).toBe(0);
  });
});

describe('what the build asks the resolver for', () => {
  it('passes the build\'s own force flag through, and nothing when it is absent', async () => {
    const instance = service();
    const calls: Array<{ recipe: string | null; options?: { force?: boolean } }> = [];
    instance.setPlanResolver(async (rootFile: string, recipeName: string | null, options?: { force?: boolean }) => {
      calls.push({ recipe: recipeName, options });
      return { request: { ...REQUEST }, recipeName: 'latexmk', warnings: [] };
    });
    await instance.build({ rootFile: 'C:/proj/main.tex', force: true });
    await instance.build({ rootFile: 'C:/proj/main.tex' });
    expect(calls[0].options?.force).toBe(true);
    expect(calls[1].options?.force).toBe(false);
  });

  it('resolves `default` to nothing, so the configured engine decides', async () => {
    const instance = service();
    const seen: Array<string | null> = [];
    instance.setPlanResolver(async (_rootFile: string, recipeName: string | null) => {
      seen.push(recipeName);
      return { request: { ...REQUEST }, recipeName: recipeName ?? 'latexmk', warnings: [] };
    });
    await instance.build({ rootFile: 'C:/proj/main.tex', recipeName: 'default' });
    expect(seen).toEqual([null]);
  });

  it('names the recipe it was asked for when one is given', async () => {
    const instance = service();
    const seen: Array<string | null> = [];
    instance.setPlanResolver(async (_rootFile: string, recipeName: string | null) => {
      seen.push(recipeName);
      return { request: { ...REQUEST }, recipeName: recipeName ?? 'latexmk', warnings: [] };
    });
    await instance.build({ rootFile: 'C:/proj/main.tex', recipeName: 'lualatex -> biber -> lualatex * 2' });
    expect(seen).toEqual(['lualatex -> biber -> lualatex * 2']);
  });
});
