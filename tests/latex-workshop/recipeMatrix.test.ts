/**
 * Every recipe in the catalogue, built for real.
 *
 * The unit tests prove a recipe resolves to a plan; this proves the plan is a
 * command line the installed TeX distribution actually accepts, and that the PDF
 * comes out. It is the test that would have caught the original defect — the
 * picker offering `pdflatex` as a *recipe* when it is only a tool — because it
 * walks the catalogue rather than a hand-written list of names.
 *
 * Each recipe is given the document it is for: a bibliography recipe is handed a
 * document with a `.bib` file (`\bibliography` for BibTeX, `biblatex` for
 * biber — the two are not interchangeable), and the `.latexmkrc` recipe is given
 * a `.latexmkrc`, since that is the whole point of it. A recipe whose tools are
 * not installed on this machine is reported as skipped rather than failed: the
 * matrix's job is to prove the *recipes* work, and a machine without `tectonic`
 * says nothing about the catalogue.
 *
 * Skipped entirely without a TeX distribution, like the plan-execution test
 * beside it, so it never breaks a machine that has no LaTeX.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { resolveBuildRequest } from '../../src/renderer/compiler/buildRequest';
import {
  CATALOG_COMMANDS,
  RECIPE_CATALOG,
  recipeConfigs,
  toolsWithOptions
} from '../../src/renderer/compiler/recipeCatalog';
import { NodeFileProvider } from '../../src/renderer/vendor/latex-workshop/fs/nodeFileProvider';
import { defaultSettingsProvider, type LwSettings } from '../../src/renderer/vendor/latex-workshop/settings';

function hasCommand(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = new Map(CATALOG_COMMANDS.map((command) => [command, hasCommand(command)]));
const latexmkAvailable = available.get('latexmk') === true;

const BIB = `@book{knuth,
  author = {Donald E. Knuth},
  title = {The TeXbook},
  year = {1984},
  publisher = {Addison-Wesley}
}
`;

/** A document with no bibliography: one pass is enough. */
const PLAIN_DOCUMENT = `\\documentclass{article}
\\begin{document}
\\section{Recipe matrix}
A paragraph, so the PDF has content.
\\end{document}
`;

/** The document a BibTeX recipe is for. */
const BIBTEX_DOCUMENT = `\\documentclass{article}
\\begin{document}
See \\cite{knuth}.
\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`;

/** The document a biber recipe is for: biblatex, not \\bibliography. */
const BIBER_DOCUMENT = `\\documentclass{article}
\\usepackage{biblatex}
\\addbibresource{refs.bib}
\\begin{document}
See \\cite{knuth}.
\\printbibliography
\\end{document}
`;

/**
 * The `.latexmkrc` recipe is only meaningful beside a `.latexmkrc`, which is what
 * the fixture writes for it — otherwise `latexmk` with no mode flag is free to
 * produce a DVI and the test would be asserting latexmk's default rather than
 * Eukolia's recipe.
 */
const PLANT_DOCUMENT_WITH_RC = PLAIN_DOCUMENT;

interface Fixture {
  /** The `refs.bib` to write beside the document, if the recipe needs one. */
  bib?: boolean;
  /** The `.latexmkrc` to write beside the document, if the recipe is for one. */
  latexmkrc?: boolean;
}

/** Which document and auxiliary files each recipe is exercised with. */
const FIXTURES: Record<string, { document: string } & Fixture> = {
  'latexmk': { document: PLAIN_DOCUMENT },
  'latexmk (xelatex)': { document: PLAIN_DOCUMENT },
  'latexmk (lualatex)': { document: PLAIN_DOCUMENT },
  'latexmk (latexmkrc)': { document: PLANT_DOCUMENT_WITH_RC, latexmkrc: true },
  'pdflatex': { document: PLAIN_DOCUMENT },
  'pdflatex -> bibtex -> pdflatex * 2': { document: BIBTEX_DOCUMENT, bib: true },
  'xelatex': { document: PLAIN_DOCUMENT },
  'xelatex -> bibtex -> xelatex * 2': { document: BIBTEX_DOCUMENT, bib: true },
  'lualatex': { document: PLAIN_DOCUMENT },
  'lualatex -> biber -> lualatex * 2': { document: BIBER_DOCUMENT, bib: true },
  'tectonic': { document: PLAIN_DOCUMENT }
};

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eukolia-recipes-'));

afterAll(() => {
  fs.rmSync(workRoot, { recursive: true, force: true });
});

describe.skipIf(!latexmkAvailable)('the recipe matrix', () => {
  it('exercises every recipe in the catalogue', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(RECIPE_CATALOG.map((recipe) => recipe.name).sort());
  });

  it('offers exactly the recipes this file knows how to feed', () => {
    for (const recipe of RECIPE_CATALOG) {
      expect(FIXTURES[recipe.name], `no fixture for ${recipe.name}`).toBeDefined();
    }
  });

  for (const recipe of RECIPE_CATALOG) {
    const fixture = FIXTURES[recipe.name];
    const tools = recipe.tools;
    const missing = tools
      .map((name) => toolsWithOptions({ synctex: true, forceLatexmk: false }).find((tool) => tool.name === name))
      .map((tool) => tool?.command ?? '')
      .filter((command) => command !== '' && available.get(command) !== true);

    it.skipIf(missing.length > 0)(`builds a PDF with "${recipe.name}"`, async () => {
      const dir = fs.mkdtempSync(path.join(workRoot, 'run-'));
      const rootFile = path.join(dir, 'main.tex');
      fs.writeFileSync(rootFile, fixture.document, 'utf8');
      if (fixture.bib) fs.writeFileSync(path.join(dir, 'refs.bib'), BIB, 'utf8');
      if (fixture.latexmkrc) fs.writeFileSync(path.join(dir, '.latexmkrc'), '$pdf_mode = 1;\n', 'utf8');

      // The catalogue is what the settings bridge hands the resolver, so this is
      // the same list the application builds with.
      const settings: LwSettings = {
        'latex.recipes': recipeConfigs(),
        'latex.tools': toolsWithOptions({ synctex: true, forceLatexmk: false })
      };

      const resolved = await resolveBuildRequest({
        rootFile,
        languageId: 'latex',
        recipeName: recipe.name,
        jobId: `matrix-${recipe.name}`,
        settings: defaultSettingsProvider(settings),
        fs: new NodeFileProvider(dir),
        tmpDir: dir,
        workspaceDir: dir
      });

      expect(resolved, `${recipe.name} did not resolve`).toBeDefined();
      expect(resolved!.error, `${recipe.name} reported ${resolved!.error}`).toBeUndefined();
      expect(resolved!.request.steps.map((step) => step.command)).toEqual(
        tools.map((name) => toolsWithOptions({ synctex: true, forceLatexmk: false }).find((tool) => tool.name === name)!.command)
      );

      // Exactly as the main process runs them: one step at a time, stopping at
      // the first non-zero exit, with stdin closed. The closed stdin is not
      // cosmetic — MiKTeX builds a missing format or installs a missing package
      // on the fly by *asking*, and a prompt with an open stdin waits forever
      // (this test hung on a first-ever `lualatex` until it was closed, which is
      // what `compilerHandler` avoids by ending the child's stdin).
      for (const [index, buildStep] of resolved!.request.steps.entries()) {
        const run = spawnSync(buildStep.command, buildStep.args, {
          cwd: resolved!.request.cwd,
          env: { ...process.env, ...(buildStep.env ?? {}) },
          shell: buildStep.shell === true,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 240000
        });
        if (run.status !== 0) {
          throw new Error(
            `step ${index + 1} of "${recipe.name}" failed: ${buildStep.command} ${buildStep.args.join(' ')}\n` +
              `exit ${run.status ?? run.signal}\n${(run.stdout ?? Buffer.alloc(0)).toString('utf8').slice(-2000)}\n` +
              `${(run.stderr ?? Buffer.alloc(0)).toString('utf8').slice(-1000)}`
          );
        }
      }

      expect(fs.existsSync(path.join(dir, 'main.pdf')), `${recipe.name} produced no main.pdf`).toBe(true);
      expect(fs.statSync(path.join(dir, 'main.pdf')).size).toBeGreaterThan(1000);
    }, 240000);
  }
});
