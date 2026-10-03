/**
 * End-to-end check of the ported build pipeline: resolve a recipe, turn it into
 * the IPC `BuildRequest`, and execute the produced steps verbatim.
 *
 * This is what proves the plan `src/renderer/compiler/buildRequest.ts` hands to
 * `src/main/ipc/compilerHandler.ts` is genuinely runnable — the same `command`,
 * `args`, `env` and `shell` values, spawned exactly as the main process does.
 *
 * Skipped when no TeX distribution is installed, so it never breaks a machine
 * without LaTeX.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { resolveBuildRequest } from '../../src/renderer/compiler/buildRequest';
import { NodeFileProvider } from '../../src/renderer/vendor/latex-workshop/fs/nodeFileProvider';
import { defaultSettingsProvider } from '../../src/renderer/vendor/latex-workshop/settings';

function hasCommand(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const latexmkAvailable = hasCommand('latexmk');

const DOCUMENT = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
\\section{Plan execution}
See \\ref{sec:nowhere} for a warning.
\\begin{align}
  a &= b \\\\
  c &= d
\\end{align}
\\end{document}
`;

describe.skipIf(!latexmkAvailable)('resolved build plan executes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eukolia-plan-'));
  const rootFile = path.join(dir, 'main.tex');
  fs.writeFileSync(rootFile, DOCUMENT, 'utf8');

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('builds the PDF and the SyncTeX file through the produced BuildRequest', async () => {
    const resolved = await resolveBuildRequest({
      rootFile,
      languageId: 'latex',
      jobId: 'plan-smoke',
      settings: defaultSettingsProvider(),
      fs: new NodeFileProvider(dir),
      tmpDir: dir,
      workspaceDir: dir,
      baseEnv: process.env as Record<string, string | undefined>
    });

    expect(resolved).toBeDefined();
    // The configured default recipe is the reference's `latexmk`.
    expect(resolved!.recipe.name).toBe('latexmk');
    expect(resolved!.request.jobName).toBe('main');
    expect(resolved!.request.cwd).toBe(dir);

    const [step] = resolved!.request.steps;
    expect(step.command).toBe('latexmk');
    expect(step.args).toContain('-synctex=1');
    expect(step.args).toContain('-interaction=nonstopmode');
    expect(step.args).toContain('-file-line-error');
    expect(step.label).toBe('latexmk (main)');
    expect(step.env?.max_print_line).toBe('10000');

    for (const buildStep of resolved!.request.steps) {
      execFileSync(buildStep.command, buildStep.args, {
        cwd: resolved!.request.cwd,
        env: { ...process.env, ...(buildStep.env ?? {}) },
        shell: buildStep.shell === true,
        stdio: 'pipe'
      });
    }

    expect(fs.existsSync(path.join(dir, 'main.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'main.synctex.gz'))).toBe(true);
  }, 180000);

  it('reports an unknown recipe and falls back to the first one', async () => {
    const resolved = await resolveBuildRequest({
      rootFile,
      languageId: 'latex',
      recipeName: 'pdflatex',
      jobId: 'plan-missing',
      settings: defaultSettingsProvider(),
      fs: new NodeFileProvider(dir),
      tmpDir: dir,
      workspaceDir: dir
    });
    // `pdflatex` is a *tool* in the reference defaults, not a recipe name.
    expect(resolved!.error).toContain('Failed to resolve build recipe: pdflatex');
    expect(resolved!.recipe.name).toBe('latexmk');
  });
});
