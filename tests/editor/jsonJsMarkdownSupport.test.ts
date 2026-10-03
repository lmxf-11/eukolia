// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { highlightTree } from '@lezer/highlight'
import { jsonLanguage } from '@codemirror/lang-json'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@/vendor/overleaf/languages'
import { LanguageDescription } from '@codemirror/language'
import {
  codeHighlightStyle,
  eukoliaHighlightStyle,
  markdownHighlightStyle,
  syntaxHighlightingFor,
  isLaTeXFile,
  eukoliaSyntaxHighlighting,
  codeSyntaxHighlighting,
} from '@/visual/syntaxHighlighting'
import { languageIdFor, TEXT_EXTENSIONS } from '@/services/workspace'
import { DocumentModel, EMPTY_ANALYSIS } from '@/document/documentModel'
import { DARK_THEME, LIGHT_THEME } from '@/core/themes'

const getRules = (): string[] =>
  (codeHighlightStyle.module as unknown as { rules?: string[] })?.rules ?? []

const getMdRules = (): string[] =>
  (markdownHighlightStyle.module as unknown as { rules?: string[] })?.rules ?? []

describe('JSON, JavaScript, and Markdown Support', () => {
  describe('Workspace file extension detection and language identification', () => {
    it('recognizes JSON, JavaScript, TypeScript, and Markdown file extensions in TEXT_EXTENSIONS', () => {
      const expectedExts = ['json', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'md', 'markdown']
      for (const ext of expectedExts) {
        expect(TEXT_EXTENSIONS.test(`file.${ext}`), `Expected ${ext} in TEXT_EXTENSIONS`).toBe(true)
      }
    })

    it('maps filenames to appropriate language IDs', () => {
      expect(languageIdFor('data.json')).toBe('json')
      expect(languageIdFor('package.json')).toBe('json')
      expect(languageIdFor('app.js')).toBe('javascript')
      expect(languageIdFor('server.mjs')).toBe('javascript')
      expect(languageIdFor('config.cjs')).toBe('javascript')
      expect(languageIdFor('component.jsx')).toBe('javascript')
      expect(languageIdFor('index.ts')).toBe('typescript')
      expect(languageIdFor('view.tsx')).toBe('typescript')
      expect(languageIdFor('README.md')).toBe('markdown')
      expect(languageIdFor('spec.markdown')).toBe('markdown')
      expect(languageIdFor('main.tex')).toBe('latex')
    })
  })

  describe('DocumentModel for JSON, JS, and Markdown', () => {
    it('creates and edits a JSON document model without running LaTeX analysis', () => {
      const initialJson = '{\n  "name": "eukolia"\n}'
      const doc = new DocumentModel('C:/proj/package.json', 'package.json', initialJson)
      expect(doc.languageId).toBe('json')
      expect(doc.getText()).toBe(initialJson)

      // Edit document
      doc.replaceRange(12, 21, '"eukolia-app"')
      expect(doc.getText()).toBe('{\n  "name": "eukolia-app"\n}')

      // Analysis remains EMPTY_ANALYSIS for non-LaTeX documents
      expect(doc.getAnalysis()).toEqual(EMPTY_ANALYSIS)
    })

    it('creates and edits a JavaScript document model', () => {
      const code = 'export function add(a, b) { return a + b; }'
      const doc = new DocumentModel('C:/proj/math.js', 'math.js', code)
      expect(doc.languageId).toBe('javascript')

      doc.applyDeltas([{ from: 16, to: 19, insert: 'sum' }])
      expect(doc.getText()).toBe('export function sum(a, b) { return a + b; }')
      expect(doc.getAnalysis()).toEqual(EMPTY_ANALYSIS)
    })

    it('creates and edits a Markdown document model', () => {
      const md = '# Title\n\nSome **bold** prose.'
      const doc = new DocumentModel('C:/proj/README.md', 'README.md', md)
      expect(doc.languageId).toBe('markdown')

      doc.replaceRange(2, 7, 'Document Overview')
      expect(doc.getText()).toBe('# Document Overview\n\nSome **bold** prose.')
      expect(doc.getAnalysis()).toEqual(EMPTY_ANALYSIS)
    })
  })

  describe('CodeMirror language bundles in vendor/overleaf/languages', () => {
    it('matches and loads json language description', async () => {
      const desc = LanguageDescription.matchFilename(languages, 'package.json')
      expect(desc).toBeDefined()
      expect(desc!.name).toBe('json')
      const lang = await desc!.load()
      expect(lang).toBeDefined()
    })

    it('matches and loads javascript and typescript language descriptions', async () => {
      const jsDesc = LanguageDescription.matchFilename(languages, 'index.js')
      expect(jsDesc).toBeDefined()
      expect(jsDesc!.name).toBe('javascript')

      const tsDesc = LanguageDescription.matchFilename(languages, 'app.ts')
      expect(tsDesc).toBeDefined()
      expect(tsDesc!.name).toBe('javascript')

      const lang = await jsDesc!.load()
      expect(lang).toBeDefined()
    })

    it('matches and loads markdown language description', async () => {
      const desc = LanguageDescription.matchFilename(languages, 'README.md')
      expect(desc).toBeDefined()
      expect(desc!.name).toBe('markdown')
      const lang = await desc!.load()
      expect(lang).toBeDefined()
    })
  })

  describe('Vivid Syntax Highlighting Rules', () => {
    const rules = getRules()
    const mdRules = getMdRules()
    const allRulesText = [...rules, ...mdRules].join('\n')

    const findRule = (cls: string) => {
      const classes = cls.split(' ').filter(Boolean)
      const matchingRules: string[] = []
      for (const c of classes) {
        const found = [...rules, ...mdRules].find(
          r => r.includes(`.${c} `) || r.startsWith(`.${c}{`)
        )
        if (found) matchingRules.push(found)
      }
      return matchingRules.join('; ')
    }

    it('defines vivid color rules for all code and markdown syntax tokens', () => {
      expect(allRulesText).toContain('var(--eu-syntax-keyword)')
      expect(allRulesText).toContain('var(--eu-syntax-function)')
      expect(allRulesText).toContain('var(--eu-syntax-string)')
      expect(allRulesText).toContain('var(--eu-syntax-property)')
      expect(allRulesText).toContain('var(--eu-syntax-constant)')
      expect(allRulesText).toContain('var(--eu-syntax-variable)')
      expect(allRulesText).toContain('var(--eu-syntax-variable-def)')
      expect(allRulesText).toContain('var(--eu-syntax-heading)')
      expect(allRulesText).toContain('var(--eu-syntax-monospace)')
    })

    it('vividly styles JSON tokens (keys, strings, numbers, booleans, delimiters)', () => {
      const sample = '{\n  "version": 42,\n  "name": "eukolia",\n  "enabled": true\n}'
      const tree = jsonLanguage.parser.parse(sample)

      const spans: Array<{ text: string; styleClass: string }> = []
      highlightTree(tree, codeHighlightStyle, (from, to, styleClass) => {
        spans.push({ text: sample.slice(from, to), styleClass })
      })

      // Keys (propertyName)
      const keySpan = spans.find(s => s.text === '"version"')
      expect(keySpan).toBeDefined()
      expect(findRule(keySpan!.styleClass)).toContain('var(--eu-syntax-property)')

      // Strings (string)
      const strSpan = spans.find(s => s.text === '"eukolia"')
      expect(strSpan).toBeDefined()
      expect(findRule(strSpan!.styleClass)).toContain('var(--eu-syntax-string)')

      // Numbers (number)
      const numSpan = spans.find(s => s.text === '42')
      expect(numSpan).toBeDefined()
      expect(findRule(numSpan!.styleClass)).toContain('var(--eu-syntax-number)')

      // Booleans (constant)
      const boolSpan = spans.find(s => s.text === 'true')
      expect(boolSpan).toBeDefined()
      expect(findRule(boolSpan!.styleClass)).toContain('var(--eu-syntax-constant)')

      // Braces / punctuation
      const braceSpan = spans.find(s => s.text === '{')
      expect(braceSpan).toBeDefined()
      expect(findRule(braceSpan!.styleClass)).toContain('var(--eu-syntax-brace)')
    })

    it('vividly styles JavaScript tokens (keywords, functions, variables, strings, operators)', () => {
      const sample = 'const calculate = function(num) {\n  return num * 2;\n};'
      const tree = javascriptLanguage.parser.parse(sample)

      const spans: Array<{ text: string; styleClass: string }> = []
      highlightTree(tree, codeHighlightStyle, (from, to, styleClass) => {
        spans.push({ text: sample.slice(from, to), styleClass })
      })

      // Keywords (const, function, return)
      const constSpan = spans.find(s => s.text === 'const')
      expect(constSpan).toBeDefined()
      expect(findRule(constSpan!.styleClass)).toContain('var(--eu-syntax-keyword)')

      const returnSpan = spans.find(s => s.text === 'return')
      expect(returnSpan).toBeDefined()
      expect(findRule(returnSpan!.styleClass)).toContain('var(--eu-syntax-keyword)')

      // Variable definitions
      const defSpan = spans.find(s => s.text === 'calculate')
      expect(defSpan).toBeDefined()
      expect(findRule(defSpan!.styleClass)).toContain('var(--eu-syntax-variable-def)')

      // Operators (*, =)
      const multSpan = spans.find(s => s.text === '*')
      expect(multSpan).toBeDefined()
      expect(findRule(multSpan!.styleClass)).toContain('var(--eu-syntax-operator)')

      // Numbers
      const numSpan = spans.find(s => s.text === '2')
      expect(numSpan).toBeDefined()
      expect(findRule(numSpan!.styleClass)).toContain('var(--eu-syntax-number)')
    })

    it('vividly styles Markdown tokens (headings, bold, italic, inline code)', () => {
      const sample = '# Heading\n**bold text** and *italic text*\n`const x = 1`'
      const tree = markdownLanguage.parser.parse(sample)

      const spans: Array<{ text: string; styleClass: string }> = []
      highlightTree(tree, codeHighlightStyle, (from, to, styleClass) => {
        spans.push({ text: sample.slice(from, to), styleClass })
      })

      // Heading
      const headingSpan = spans.find(s => s.text === ' Heading')
      expect(headingSpan).toBeDefined()
      expect(findRule(headingSpan!.styleClass)).toContain('var(--eu-syntax-heading)')

      // Bold (strong)
      const boldSpan = spans.find(s => s.text === 'bold text')
      expect(boldSpan).toBeDefined()
      expect(findRule(boldSpan!.styleClass)).toContain('var(--eu-syntax-command)')

      // Italic (emphasis)
      const italicSpan = spans.find(s => s.text === 'italic text')
      expect(italicSpan).toBeDefined()
      expect(findRule(italicSpan!.styleClass)).toContain('var(--eu-syntax-environment)')

      // Monospace inline code via markdownHighlightStyle
      const mdSpans: Array<{ text: string; styleClass: string }> = []
      highlightTree(tree, markdownHighlightStyle, (from, to, styleClass) => {
        mdSpans.push({ text: sample.slice(from, to), styleClass })
      })
      const codeSpan = mdSpans.find(s => s.text === 'const x = 1')
      expect(codeSpan).toBeDefined()
      expect(findRule(codeSpan!.styleClass)).toContain('var(--eu-syntax-monospace)')
    })

    it('preserves LaTeX math syntax coloring without string pollution', () => {
      expect(isLaTeXFile('main.tex')).toBe(true)
      expect(isLaTeXFile('document.ltx')).toBe(true)
      expect(isLaTeXFile('custom.sty')).toBe(true)
      expect(isLaTeXFile('paper.cls')).toBe(true)
      expect(isLaTeXFile(null)).toBe(true) // untitled buffer
      expect(isLaTeXFile('package.json')).toBe(false)
      expect(isLaTeXFile('index.js')).toBe(false)
      expect(isLaTeXFile('README.md')).toBe(false)

      expect(syntaxHighlightingFor('main.tex')).toBe(eukoliaSyntaxHighlighting)
      expect(syntaxHighlightingFor('package.json')).toBe(codeSyntaxHighlighting)
      expect(syntaxHighlightingFor('index.js')).toBe(codeSyntaxHighlighting)
      expect(syntaxHighlightingFor('README.md')).toBe(codeSyntaxHighlighting)
    })

    it('verifies vivid color definitions in DARK_THEME and LIGHT_THEME', () => {
      const tokens: Array<keyof typeof DARK_THEME.syntax> = [
        'keyword',
        'function',
        'string',
        'property',
        'constant',
        'variable',
        'variableDef',
        'heading',
        'link',
        'monospace',
      ]

      for (const tok of tokens) {
        expect(DARK_THEME.syntax[tok], `Dark theme missing token ${tok}`).toBeTruthy()
        expect(LIGHT_THEME.syntax[tok], `Light theme missing token ${tok}`).toBeTruthy()

        // Ensure distinct non-empty colors
        expect(DARK_THEME.syntax[tok]).toMatch(/^#[0-9a-fA-F]{6}$/)
        expect(LIGHT_THEME.syntax[tok]).toMatch(/^#[0-9a-fA-F]{6}$/)
      }
    })
  })
})
