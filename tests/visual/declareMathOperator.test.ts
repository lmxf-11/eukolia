import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { parseLatexWithArguments } from '@/vendor/latex-workshop/parser/unified'
import { collectMacroDefinitions, normalizeDefinition } from '@/vendor/latex-workshop/parser/newcommand'
import { projectIndex } from '@/document/projectIndex'
import { composeMacroPreamble, setProjectMacros } from '@/editor/projectMacros'
import { resetMathJaxTypesetter, typesetToMarkup } from '@/visual/mathjax-typesetter'

describe('DeclareMathOperator and macro limits', () => {
  beforeEach(() => {
    resetMathJaxTypesetter()
    projectIndex.clearExternalMacros()
    setProjectMacros({})
  })

  afterAll(() => {
    resetMathJaxTypesetter()
    projectIndex.clearExternalMacros()
    setProjectMacros({})
  })

  it('correctly discovers DeclareMathOperator and DeclareMathOperator*', () => {
    const source = `
      \\DeclareMathOperator{\\foo}{foo}
      \\DeclareMathOperator*{\\mlim}{lim}
      \\DeclareMathOperator\\bar{bar}
      \\DeclareMathOperator*\\mcolim{colim}
    `
    const ast = parseLatexWithArguments(source, {})
    const macros = collectMacroDefinitions(ast.content, source)

    expect(macros.map(m => m.name)).toEqual(['foo', 'mlim', 'bar', 'mcolim'])
    expect(macros.find(m => m.name === 'mlim')?.definition).toBe('\\DeclareMathOperator*{\\mlim}{lim}')
    expect(macros.find(m => m.name === 'mcolim')?.definition).toBe('\\DeclareMathOperator*{\\mcolim}{colim}')
  })

  it('preserves asterisk on DeclareMathOperator* but strips it on newcommand*', () => {
    const starredOp = parseLatexWithArguments('\\DeclareMathOperator*{\\mlim}{lim}', {}).content[0]
    expect(normalizeDefinition(starredOp)).toBe('\\DeclareMathOperator*{\\mlim}{lim}')

    const starredCmd = parseLatexWithArguments('\\newcommand*{\\test}{body}', {}).content[0]
    expect(normalizeDefinition(starredCmd)).toBe('\\newcommand{\\test}{body}')
  })

  it('renders expressions with DeclareMathOperator* and limits to SVG without error', async () => {
    const source = `
      \\let\\lim\\relax
      \\DeclareMathOperator*{\\mlim}{lim}
      \\newcommand{\\lim}{\\mlim\\limits}
    `
    const ast = parseLatexWithArguments(source, {})
    const macros = collectMacroDefinitions(ast.content, source)

    projectIndex.registerExternalMacros(
      '/path/to/macros.tex',
      macros.map(m => ({
        name: m.name,
        args: m.args,
        file: '/path/to/macros.tex',
        line: m.line,
        definition: m.definition,
      }))
    )

    const table = projectIndex.getMacroTable()
    expect(table['mlim']).toBe('\\DeclareMathOperator*{\\mlim}{lim}')
    expect(table['lim']).toBe('\\newcommand{\\lim}{\\mlim\\limits}')

    setProjectMacros(table)
    const preamble = composeMacroPreamble('')

    const markup = await typesetToMarkup(`${preamble}\n\\lim_{n \\to \\infty}`)
    expect(markup).toContain('<svg')
    expect(markup).not.toContain('data-mjx-error')
    expect(markup).not.toContain('mjx-merror')
  })

  it('keeps the latest definition when a macro is redefined in external files', () => {
    projectIndex.registerExternalMacros('/path/to/macros.tex', [
      {
        name: 'lim',
        args: 0,
        file: '/path/to/macros.tex',
        line: 1,
        definition: '\\let\\lim\\relax',
      },
      {
        name: 'lim',
        args: 0,
        file: '/path/to/macros.tex',
        line: 10,
        definition: '\\newcommand{\\lim}{\\mlim\\limits}',
      },
    ])

    const table = projectIndex.getMacroTable()
    expect(table['lim']).toBe('\\newcommand{\\lim}{\\mlim\\limits}')
  })
})
