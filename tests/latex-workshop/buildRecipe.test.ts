/**
 * Build recipes, plans and steps — ported from LaTeX Workshop
 * `out/src/compile/{recipe,plan,step,constants}.js`.
 */

import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  absoluteOutputDirectory,
  resolveBuildRequest,
  resolveOutputDir,
  withAuxiliaryPath,
  withOutputDirectory
} from '../../src/renderer/compiler/buildRequest'
import { buildSteps, resolveTools } from '../../src/renderer/vendor/latex-workshop/compile/plan'
import {
  createRecipe,
  findMagicComments,
  initializeRecipeState,
  type RecipeResolverOptions
} from '../../src/renderer/vendor/latex-workshop/compile/recipe'
import { MemoryFileProvider } from '../../src/renderer/vendor/latex-workshop/fs/memoryFileProvider'
import { defaultSettingsProvider, mergeSettings, type LwSettings } from '../../src/renderer/vendor/latex-workshop/settings'
import {
  BIB_MAGIC_PROGRAM_NAME,
  MAGIC_PROGRAM_ARGS_SUFFIX,
  TEX_MAGIC_PROGRAM_NAME
} from '../../src/renderer/vendor/latex-workshop/compile/constants'

const ROOT = 'D:/proj'
const MAIN = `${ROOT}/main.tex`
const TEX_MAGIC_PROGRAM_NAME_WITH_ARGS = TEX_MAGIC_PROGRAM_NAME + MAGIC_PROGRAM_ARGS_SUFFIX

function options(fs: MemoryFileProvider, settings?: LwSettings): RecipeResolverOptions {
  const provider = defaultSettingsProvider(settings)
  return {
    settings: provider,
    readFile: (filePath) => fs.readFile(filePath),
    getWorkingFolder: () => ROOT,
    workspaceDir: ROOT
  }
}

function planContext(settings?: LwSettings) {
  return {
    settings: mergeSettings(settings),
    tmpDir: `${ROOT}/.tmp`,
    workspaceDir: ROOT
  }
}

describe('recipe resolution (ported compile/recipe.js)', () => {
  it('resolves the default latexmk recipe', async () => {
    initializeRecipeState()
    const fs = new MemoryFileProvider([{ path: MAIN, content: '\\documentclass{article}\n\\begin{document}x\\end{document}\n' }])
    const { recipe } = await createRecipe(MAIN, 'latex', 'latexmk', options(fs))
    expect(recipe).toBeDefined()
    expect(recipe!.name).toBe('latexmk')
    expect(recipe!.tools).toEqual(['latexmk'])
    expect(recipe!.rootFile).toBe(MAIN)
  })

  it('produces the -synctex=1 -interaction=nonstopmode -file-line-error command line', async () => {
    initializeRecipeState()
    const fs = new MemoryFileProvider([{ path: MAIN, content: '\\documentclass{article}\n' }])
    const { recipe } = await createRecipe(MAIN, 'latex', 'latexmk', options(fs))
    const plan = buildSteps(recipe!, planContext())
    expect(plan.steps).toHaveLength(1)
    const step = plan.steps[0]
    expect(step.command).toBe('latexmk')
    expect(step.args).toContain('-synctex=1')
    expect(step.args).toContain('-interaction=nonstopmode')
    expect(step.args).toContain('-file-line-error')
    expect(step.args).toContain('-pdf')
    expect(step.args).toContain('-outdir=D:/proj')
    expect(step.args).toContain('-auxdir=D:/proj')
    expect(step.args[step.args.length - 1]).toBe('D:/proj/main')
    expect(step.shell).toBe(false)
    expect(step.env.max_print_line).toBe('10000')
  })

  it('expands the multi-tool recipe into one step per tool', async () => {
    initializeRecipeState()
    const fs = new MemoryFileProvider([{ path: MAIN, content: '\\documentclass{article}\n' }])
    const { recipe } = await createRecipe(MAIN, 'latex', 'pdflatex -> bibtex -> pdflatex * 2', options(fs))
    expect(recipe).toBeDefined()
    const plan = buildSteps(recipe!, planContext())
    expect(plan.steps.map((step) => step.name)).toEqual(['pdflatex', 'bibtex', 'pdflatex', 'pdflatex'])
    expect(plan.steps[0].args).toContain('-file-line-error')
    expect(plan.steps[1].command).toBe('bibtex')
    expect(plan.steps[1].args).toEqual(['main'])
    expect(plan.steps[3].index).toBe(3)
    expect(plan.steps[3].total).toBe(4)
  })

  it('skips undefined tool names but keeps the resolvable ones', async () => {
    const settings: LwSettings = {
      'latex.recipes': [{ name: 'mixed', tools: ['pdflatex', 'does-not-exist'] }]
    }
    const fs = new MemoryFileProvider([{ path: MAIN, content: '\\documentclass{article}\n' }])
    const { recipe } = await createRecipe(MAIN, 'latex', 'mixed', options(fs, settings))
    const resolved = resolveTools(recipe!, planContext(settings))
    expect(resolved.tools.map((tool) => tool.name)).toEqual(['pdflatex'])
    expect(resolved.messages[0]).toContain('does-not-exist')
  })

  it('falls back to the first language-compatible recipe', async () => {
    initializeRecipeState()
    const fs = new MemoryFileProvider([{ path: MAIN, content: '\\documentclass{article}\n' }])
    const { recipe } = await createRecipe(MAIN, 'latex', undefined, options(fs))
    expect(recipe!.name).toBe('latexmk')
  })

  it('reports an unknown recipe name and falls back to the first recipe', async () => {
    const fs = new MemoryFileProvider([{ path: MAIN, content: '\\documentclass{article}\n' }])
    const { recipe, error } = await createRecipe(MAIN, 'latex', 'nope', options(fs))
    // The reference logs the failure and then falls back to `candidates[0]`.
    expect(error).toContain('Failed to resolve build recipe')
    expect(recipe!.name).toBe('latexmk')
  })
})

describe('magic comments (ported compile/recipe.js)', () => {
  it('reads the leading % !TeX comment block only', async () => {
    const content = ['% !TeX program = xelatex', '% !TeX options = -shell-escape', '% !BIB program = biber', '\\documentclass{article}'].join('\n')
    const fs = new MemoryFileProvider([{ path: MAIN, content }])
    const magic = await findMagicComments(MAIN, (p) => fs.readFile(p))
    expect(magic.tex?.command).toBe('xelatex')
    expect(magic.tex?.args).toEqual(['-shell-escape'])
    expect(magic.bib?.command).toBe('biber')
  })

  it('ignores magic comments that are not in the leading block', async () => {
    const content = ['\\documentclass{article}', '% !TeX program = xelatex'].join('\n')
    const fs = new MemoryFileProvider([{ path: MAIN, content }])
    const magic = await findMagicComments(MAIN, (p) => fs.readFile(p))
    expect(magic.tex).toBeUndefined()
  })

  it('overrides the recipe from % !TeX program', async () => {
    initializeRecipeState()
    const fs = new MemoryFileProvider([
      { path: MAIN, content: '% !TeX program = xelatex\n\\documentclass{article}\n\\begin{document}x\\end{document}\n' }
    ])
    const { recipe, magic } = await createRecipe(MAIN, 'latex', undefined, options(fs))
    expect(magic.tex?.command).toBe('xelatex')
    expect(recipe!.name).toBe('Build')
    const plan = buildSteps(recipe!, planContext())
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].command).toBe('xelatex')
    expect(plan.steps[0].name).toBe(TEX_MAGIC_PROGRAM_NAME_WITH_ARGS)
    expect(plan.steps[0].args).toEqual(['-synctex=1', '-interaction=nonstopmode', '-file-line-error', 'D:/proj/main'])
    expect(plan.steps[0].shell).toBe(false)
  })

  it('expands % !BIB program into a four-step TeX/Bib/TeX/TeX plan', async () => {
    initializeRecipeState()
    const fs = new MemoryFileProvider([
      {
        path: MAIN,
        content: '% !TeX program = pdflatex\n% !BIB program = biber\n\\documentclass{article}\n\\begin{document}x\\end{document}\n'
      }
    ])
    const { recipe } = await createRecipe(MAIN, 'latex', undefined, options(fs))
    const plan = buildSteps(recipe!, planContext())
    expect(plan.steps.map((step) => step.command)).toEqual(['pdflatex', 'biber', 'pdflatex', 'pdflatex'])
    expect(plan.steps[1].name).toBe(`${BIB_MAGIC_PROGRAM_NAME}_WITH_ARGS`)
    expect(plan.steps[1].args).toEqual(['main'])
  })

  it('flattens % !TeX options into a shell command, as the reference does', async () => {
    initializeRecipeState()
    const fs = new MemoryFileProvider([
      { path: MAIN, content: '% !TeX program = xelatex\n% !TeX options = -shell-escape -8bit\n\\documentclass{article}\n' }
    ])
    const { recipe } = await createRecipe(MAIN, 'latex', undefined, options(fs))
    const plan = buildSteps(recipe!, planContext())
    expect(plan.steps[0].name).toBe(TEX_MAGIC_PROGRAM_NAME)
    expect(plan.steps[0].command).toBe('xelatex -shell-escape -8bit')
    expect(plan.steps[0].args).toEqual([])
    expect(plan.steps[0].shell).toBe(true)
  })

  it('selects a configured recipe from % !LW recipe', async () => {
    initializeRecipeState()
    const fs = new MemoryFileProvider([
      { path: MAIN, content: '% !LW recipe = pdflatex -> bibtex -> pdflatex * 2\n\\documentclass{article}\n' }
    ])
    const { recipe } = await createRecipe(MAIN, 'latex', undefined, options(fs))
    expect(recipe!.name).toBe('pdflatex -> bibtex -> pdflatex * 2')
  })

  it('honours latex.build.enableMagicComments = false', async () => {
    initializeRecipeState()
    const fs = new MemoryFileProvider([{ path: MAIN, content: '% !TeX program = xelatex\n\\documentclass{article}\n' }])
    const { recipe } = await createRecipe(MAIN, 'latex', undefined, options(fs, { 'latex.build.enableMagicComments': false }))
    expect(recipe!.name).toBe('latexmk')
  })
})

describe('IPC build request adapter', () => {
  it('emits BuildStep objects with labels and stripped undefined env values', async () => {
    initializeRecipeState()
    const fs = new MemoryFileProvider([{ path: MAIN, content: '\\documentclass{article}\n' }])
    const resolved = await resolveBuildRequest({
      rootFile: MAIN,
      languageId: 'latex',
      recipeName: 'pdflatex -> bibtex -> pdflatex * 2',
      jobId: 'job-1',
      settings: defaultSettingsProvider(),
      fs,
      tmpDir: `${ROOT}/.tmp`,
      workspaceDir: ROOT
    })
    expect(resolved).toBeDefined()
    const { request } = resolved!
    expect(request.jobId).toBe('job-1')
    expect(request.jobName).toBe('main')
    expect(request.cwd).toBe(ROOT)
    expect(request.steps).toHaveLength(4)
    expect(request.steps[0].label).toBe('pdflatex (main)')
    expect(request.steps[1].label).toBe('bibtex (main)')
    for (const step of request.steps) {
      expect(step.env).toBeDefined()
      for (const value of Object.values(step.env!)) {
        expect(value).not.toBeUndefined()
      }
    }
  })

  it('sets outputDir and adds -output-directory when latex.outDir differs', async () => {
    initializeRecipeState()
    const outDir = `${ROOT}/build`
    const settings: LwSettings = {
      'latex.outDir': outDir,
      'latex.recipes': [{ name: 'single', tools: ['pdflatex'] }]
    }
    expect(resolveOutputDir(MAIN, mergeSettings(settings), ROOT, '')).toBe(path.resolve(outDir))
    const fs = new MemoryFileProvider([{ path: MAIN, content: '\\documentclass{article}\n' }])
    const resolved = await resolveBuildRequest({
      rootFile: MAIN,
      languageId: 'latex',
      recipeName: 'single',
      jobId: 'job-2',
      settings: defaultSettingsProvider(settings),
      fs,
      tmpDir: `${ROOT}/.tmp`,
      workspaceDir: ROOT
    })
    expect(resolved!.request.outputDir).toBe(path.resolve(outDir))
    expect(resolved!.request.steps[0].command).toBe('pdflatex')
    expect(resolved!.request.steps[0].args).toContain(`-output-directory=${path.resolve(outDir)}`)
  })

  it('keeps the process cwd when the output directory is the source directory', () => {
    expect(withOutputDirectory(['-synctex=1'], 'pdflatex', ROOT, ROOT)).toEqual(['-synctex=1'])
    // latexmk already carries -outdir, so nothing is appended.
    expect(withOutputDirectory(['-outdir=D:/proj/build'], 'latexmk', `${ROOT}/build`, ROOT)).toEqual(['-outdir=D:/proj/build'])
    // bibtex does not accept the flag.
    expect(withOutputDirectory(['%DOCFILE%'], 'bibtex', `${ROOT}/build`, ROOT)).toEqual(['%DOCFILE%'])
  })

  it('accepts the prefixed VS Code spelling of every setting', async () => {
    initializeRecipeState()
    const fs = new MemoryFileProvider([{ path: MAIN, content: '\\documentclass{article}\n\\begin{document}x\\end{document}\n' }])
    // An adapter that mirrors `workspace.getConfiguration()` stores prefixed keys.
    const settings: LwSettings = {
      'latex-workshop.latex.recipes': [{ name: 'only', tools: ['pdflatex'] }],
      'latex-workshop.latex.recipe.default': 'only',
      'latex-workshop.latex.build.enableMagicComments': false,
      'latex-workshop.latex.outDir': `${ROOT}/out`
    }
    const resolved = await resolveBuildRequest({
      rootFile: MAIN,
      languageId: 'latex',
      jobId: 'job-prefixed',
      settings: defaultSettingsProvider(settings),
      fs,
      tmpDir: '',
      workspaceDir: ROOT
    })
    expect(resolved!.recipe.name).toBe('only')
    expect(resolved!.request.steps[0].command).toBe('pdflatex')
    expect(resolved!.request.outputDir).toBe(path.resolve(`${ROOT}/out`))
  })

  it('passes shell steps straight through', async () => {
    initializeRecipeState()
    const fs = new MemoryFileProvider([
      { path: MAIN, content: '% !TeX program = xelatex\n% !TeX options = -shell-escape\n\\documentclass{article}\n' }
    ])
    const resolved = await resolveBuildRequest({
      rootFile: MAIN,
      languageId: 'latex',
      jobId: 'job-3',
      settings: defaultSettingsProvider(),
      fs,
      tmpDir: `${ROOT}/.tmp`,
      workspaceDir: ROOT
    })
    expect(resolved!.request.steps[0].shell).toBe(true)
    expect(resolved!.request.steps[0].command).toBe('xelatex -shell-escape')
    expect(resolved!.request.steps[0].args).toEqual([])
  })
})

/**
 * The output directory.
 *
 * `compilation.outputDirectory` is written by a person and read by a placeholder
 * expander that resolves with `path.resolve`, so a relative value used to mean
 * "wherever the renderer process was started from" — the application directory
 * for a launched app. And `-output-directory` moves the auxiliary files, not the
 * process: TeX has to keep running in the source directory or `\input{chapters/…}`
 * stops resolving, which leaves `bibtex` looking for an `.aux` it cannot see.
 */
describe('the output directory reaches the command line', () => {
  it('resolves a relative directory against the workspace', () => {
    expect(absoluteOutputDirectory('', ROOT, MAIN)).toBeUndefined()
    expect(absoluteOutputDirectory('   ', ROOT, MAIN)).toBeUndefined()
    expect(absoluteOutputDirectory('build', ROOT, MAIN)).toBe(path.resolve(ROOT, 'build'))
    expect(absoluteOutputDirectory('../out', ROOT, MAIN)).toBe(path.resolve(ROOT, '../out'))
  })

  it('keeps an absolute directory, and falls back to the root file', () => {
    const absolute = path.resolve(ROOT, 'nested/build')
    expect(absoluteOutputDirectory(absolute, ROOT, MAIN)).toBe(absolute)
    expect(absoluteOutputDirectory('build', null, MAIN)).toBe(path.resolve(ROOT, 'build'))
  })

  it('leaves the bibliography argument alone when the output is beside the source', () => {
    expect(withAuxiliaryPath(['main'], 'bibtex', ROOT, ROOT, 'main')).toEqual(['main'])
    expect(withAuxiliaryPath(['main'], 'biber', ROOT, ROOT, 'main')).toEqual(['main'])
  })

  it('points bibtex and biber at the auxiliary file in the output directory', () => {
    const out = path.resolve(ROOT, 'build')
    expect(withAuxiliaryPath(['main'], 'bibtex', out, ROOT, 'main')).toEqual([path.join(out, 'main')])
    expect(withAuxiliaryPath(['main'], 'biber', out, ROOT, 'main')).toEqual([path.join(out, 'main')])
    // `-output-directory` is the TeX tools' flag; bibtex does not take it.
    expect(withAuxiliaryPath(['main'], 'pdflatex', out, ROOT, 'main')).toEqual(['main'])
  })

  it('builds the whole plan into the output directory', async () => {
    initializeRecipeState()
    const out = path.resolve(`${ROOT}/build`)
    const settings: LwSettings = {
      'latex.recipes': [{ name: 'with bib', tools: ['pdflatex', 'bibtex', 'pdflatex'] }]
    }
    const fs = new MemoryFileProvider([{ path: MAIN, content: '\\documentclass{article}\n' }])
    const resolved = await resolveBuildRequest({
      rootFile: MAIN,
      languageId: 'latex',
      recipeName: 'with bib',
      jobId: 'job-out',
      settings: defaultSettingsProvider(settings),
      fs,
      tmpDir: `${ROOT}/.tmp`,
      workspaceDir: ROOT,
      outputDir: out
    })

    const [first, bib, last] = resolved!.request.steps
    expect(resolved!.request.outputDir).toBe(out)
    // The document's own directory is still where the process runs: TeX resolves
    // `\input{…}` and `\includegraphics{…}` against it, and `-output-directory`
    // does not change that.
    expect(resolved!.request.cwd).toBe(ROOT)
    expect(first.args).toContain(`-output-directory=${out}`)
    expect(bib.command).toBe('bibtex')
    expect(bib.args).toEqual([path.join(out, 'main')])
    expect(last.args).toContain(`-output-directory=${out}`)
  })
})
