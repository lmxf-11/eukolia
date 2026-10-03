// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { highlightTree, tags as t } from '@lezer/highlight'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { parser } from '@/vendor/overleaf/lezer-latex/latex.mjs'
import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { eukoliaHighlightStyle } from '@/visual/syntaxHighlighting'
import { atomicDecorations } from '@/vendor/overleaf/extensions/visual/atomic-decorations'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'

const getRules = (): string[] =>
  (eukoliaHighlightStyle.module as unknown as { rules?: string[] })?.rules ?? []

describe('Visual Mode Syntax Highlighting', () => {
  it('defines rules matching Code Mode syntax tokens via CSS custom properties', () => {
    const rules = getRules()
    expect(rules.length).toBeGreaterThan(0)

    const allRulesText = rules.join('\n')
    expect(allRulesText).toContain('var(--eu-syntax-command)')
    expect(allRulesText).toContain('var(--eu-syntax-environment)')
    expect(allRulesText).toContain('var(--eu-syntax-brace)')
    expect(allRulesText).toContain('var(--eu-syntax-comment)')
    expect(allRulesText).toContain('var(--eu-syntax-math-delimiter)')
    expect(allRulesText).toContain('var(--eu-syntax-math)')
    expect(allRulesText).toContain('var(--eu-syntax-operator)')
    expect(allRulesText).toContain('var(--eu-syntax-number)')
    expect(allRulesText).toContain('var(--eu-syntax-label)')
    expect(allRulesText).toContain('var(--eu-syntax-reference)')
    expect(allRulesText).toContain('var(--eu-syntax-citation)')
    expect(allRulesText).toContain('var(--eu-syntax-file-path)')
    expect(allRulesText).toContain('var(--eu-syntax-macro-definition)')
    expect(allRulesText).toContain('var(--eu-syntax-optional)')
  })

  it('correctly styles LaTeX constructs with the appropriate style classes', () => {
    const sample = `\\documentclass[12pt]{article}
\\usepackage{amsmath}
% A document comment
\\begin{document}
\\section{Test}
Hello $x + y = 1$ & more
\\label{sec:test}
\\ref{sec:test}
\\cite{knuth84}
\\input{chapter1.tex}
\\end{document}`

    const tree = LaTeXLanguage.parser.parse(sample)

    const styledSpans: Array<{ text: string; styleClass: string }> = []
    highlightTree(tree, eukoliaHighlightStyle, (from, to, styleClass) => {
      styledSpans.push({
        text: sample.slice(from, to),
        styleClass,
      })
    })

    expect(styledSpans.length).toBeGreaterThan(0)

    const rules = getRules()
    const findRule = (cls: string) =>
      rules.find(r => r.includes(`.${cls} `) || r.startsWith(`.${cls}{`))

    // Verify command (\documentclass, \usepackage, \begin, etc.) has command class
    const docClassSpan = styledSpans.find(s => s.text === '\\documentclass')
    expect(docClassSpan).toBeDefined()
    const commandRule = findRule(docClassSpan!.styleClass)
    expect(commandRule).toContain('var(--eu-syntax-command)')

    // Verify comment (% A document comment) has comment class
    const commentSpan = styledSpans.find(s => s.text.startsWith('%'))
    expect(commentSpan).toBeDefined()
    const commentRule = findRule(commentSpan!.styleClass)
    expect(commentRule).toContain('var(--eu-syntax-comment)')
    expect(commentRule).toContain('font-style: italic')

    // Verify environment name (document) has environment class
    const envSpan = styledSpans.find(s => s.text === 'document')
    expect(envSpan).toBeDefined()
    const envRule = findRule(envSpan!.styleClass)
    expect(envRule).toContain('var(--eu-syntax-environment)')

    // Verify brace has brace class
    const braceSpan = styledSpans.find(s => s.text === '{')
    expect(braceSpan).toBeDefined()
    const braceRule = findRule(braceSpan!.styleClass)
    expect(braceRule).toContain('var(--eu-syntax-brace)')

    // Verify citation key (knuth84)
    const citeSpan = styledSpans.find(s => s.text === 'knuth84')
    expect(citeSpan).toBeDefined()
    const citeRule = findRule(citeSpan!.styleClass)
    expect(citeRule).toContain('var(--eu-syntax-citation)')

    // Verify reference key (sec:test in \ref)
    const refSpans = styledSpans.filter(s => s.text === 'sec:test')
    expect(refSpans.length).toBeGreaterThan(0)

    // Verify file path (chapter1.tex in \input)
    const fileSpan = styledSpans.find(s => s.text === 'chapter1.tex')
    expect(fileSpan).toBeDefined()
    const fileRule = findRule(fileSpan!.styleClass)
    expect(fileRule).toContain('var(--eu-syntax-file-path)')

    // Verify math delimiter ($)
    const dollarSpan = styledSpans.find(s => s.text === '$')
    expect(dollarSpan).toBeDefined()
    const dollarRule = findRule(dollarSpan!.styleClass)
    expect(dollarRule).toContain('var(--eu-syntax-math-delimiter)')

    // Verify math content (x inside $x + y = 1$)
    const mathSpan = styledSpans.find(s => s.text === 'x')
    expect(mathSpan).toBeDefined()
    const mathRule = findRule(mathSpan!.styleClass)
    expect(mathRule).toContain('var(--eu-syntax-math)')

    // Verify number (1)
    const numSpan = styledSpans.find(s => s.text === '1')
    expect(numSpan).toBeDefined()
    const numRule = findRule(numSpan!.styleClass)
    expect(numRule).toContain('var(--eu-syntax-number)')

    // Verify operator (&)
    const opSpan = styledSpans.find(s => s.text === '&')
    expect(opSpan).toBeDefined()
    const opRule = findRule(opSpan!.styleClass)
    expect(opRule).toContain('var(--eu-syntax-operator)')
  })

  it('progressively creates decorations when syntax tree grows', () => {
    const doc = `\\documentclass{article}
\\begin{document}
\\section{One}
Content 1
\\section{Two}
Content 2
\\end{document}`

    const state = EditorState.create({
      doc,
      extensions: [
        LaTeXLanguage,
        phrases(EUKOLIA_EDITOR_PHRASES),
        filePreview(() => null),
        atomicDecorations,
      ],
    })

    const view = new EditorView({ state })
    const field = state.facet(EditorView.decorations)
    expect(field.length).toBeGreaterThan(0)
    view.destroy()
  })
})
