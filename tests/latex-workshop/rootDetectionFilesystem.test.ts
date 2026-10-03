/**
 * Root-document detection against a real directory tree.
 *
 * The other root tests use the in-memory `FileProvider`; this one exercises the
 * real filesystem path (`NodeFileProvider.findFiles` + the workspace scan) so
 * the ported `findInWorkspace` strategy is covered end to end.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRootDocumentService } from '../../src/renderer/document/rootDoc';
import { NodeFileProvider } from '../../src/renderer/vendor/latex-workshop/fs/nodeFileProvider';

describe('root detection on the real filesystem', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eukolia-root-'));

  beforeAll(() => {
    fs.mkdirSync(path.join(dir, 'chapters'));
    fs.mkdirSync(path.join(dir, 'shared'));
    fs.writeFileSync(
      path.join(dir, 'main.tex'),
      '\\documentclass{article}\n\\begin{document}\n\\input{chapters/one}\n\\end{document}\n'
    );
    fs.writeFileSync(path.join(dir, 'chapters', 'one.tex'), '\\section{One}\n\\input{two}\n');
    fs.writeFileSync(path.join(dir, 'chapters', 'two.tex'), '\\subsection{Two}\n\\input{../shared/macros}\n');
    fs.writeFileSync(path.join(dir, 'shared', 'macros.tex'), '\\newcommand{\\R}{\\mathbb{R}}\n');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves and caches the whole inclusion graph from disk', async () => {
    const service = createRootDocumentService({
      fs: new NodeFileProvider(dir),
      workspaceFolders: [dir],
      getWorkspaceFolder: () => dir
    });
    const root = await service.findRootFrom(path.join(dir, 'shared', 'macros.tex'));
    expect(root).toBe(path.join(dir, 'main.tex'));

    const files = await service.refreshProject(root!);
    expect(files.map((file) => path.relative(dir, file))).toEqual([
      'main.tex',
      path.join('chapters', 'one.tex'),
      path.join('chapters', 'two.tex'),
      path.join('shared', 'macros.tex')
    ]);
    expect([...service.getIncludedTeX()].map((file) => path.relative(dir, file)).sort()).toEqual([
      path.join('chapters', 'one.tex'),
      path.join('chapters', 'two.tex'),
      'main.tex',
      path.join('shared', 'macros.tex')
    ]);
    expect(service.getTeXChildren(path.join(dir, 'main.tex'))).toEqual([path.join(dir, 'chapters', 'one.tex')]);
  });

  it('honours a magic comment read from disk', async () => {
    fs.writeFileSync(path.join(dir, 'chapters', 'one.tex'), '% !TeX root = ../main.tex\n\\section{One}\n');
    const service = createRootDocumentService({
      fs: new NodeFileProvider(dir),
      workspaceFolders: [dir],
      getWorkspaceFolder: () => dir
    });
    expect(await service.findRootFrom(path.join(dir, 'chapters', 'one.tex'))).toBe(path.join(dir, 'main.tex'));
  });
});
