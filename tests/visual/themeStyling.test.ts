// @vitest-environment jsdom
/**
 * Tests for theme-responsive styling:
 * - Math block SVG and math preview tooltip styling across themes
 * - Tooltip theming (autocomplete, command, hover, line diagnostics)
 * - Cursor and caret styling in standard and math modes
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { THEMES, THEME_NAMES, themeManager } from '@/core/themes'

const visualEditorCss = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'visual', 'visual-editor.css'),
  'utf8'
)

function cssRules(selectorFragment: string): string[] {
  const css = visualEditorCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const wanted = selectorFragment.replace(/\s+/g, ' ').trim()
  const blocks: string[] = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) {
    const selector = match[1].replace(/\s+/g, ' ').trim()
    if (selector.includes(wanted)) blocks.push(match[2].replace(/\s+/g, ' ').trim())
  }
  return blocks
}

const cssDeclares = (
  selectorFragment: string,
  property: string,
  valuePattern: string
): boolean =>
  cssRules(selectorFragment).some(block =>
    new RegExp(`${property}\\s*:\\s*${valuePattern}(\\s*!important)?\\s*(;|$)`).test(block)
  )

describe('theme-responsive math SVGs and math preview tooltips', () => {
  it('declares theme color and currentColor fill for rendered math blocks', () => {
    expect(cssDeclares('.ol-cm-math', 'color', 'var\\(--eu-visual-fg.*\\)')).toBe(true)
    expect(cssDeclares('.ol-cm-math', 'fill', 'currentColor')).toBe(true)
  })

  it('declares theme color and currentColor fill for math preview tooltip', () => {
    expect(cssDeclares('.ol-cm-math-tooltip', 'color', 'var\\(--eu-visual-fg.*\\)')).toBe(true)
    expect(cssDeclares('.ol-cm-math-tooltip', 'background', 'var\\(--eu-bg-card.*\\)')).toBe(true)
    expect(cssDeclares('.ol-cm-math-tooltip', 'border', '1px solid var\\(--eu-border.*\\)')).toBe(true)
  })

  it('resets the outer container of math tooltip to avoid double borders', () => {
    expect(cssDeclares('.ol-cm-math-tooltip-container', 'background-color', 'transparent\\s*!important')).toBe(true)
    expect(cssDeclares('.ol-cm-math-tooltip-container', 'border', '0\\s*!important')).toBe(true)
  })

  it('tightens math preview tooltip without redundant blank space or margins', () => {
    expect(cssDeclares('.ol-cm-math-tooltip', 'padding', '3px 8px')).toBe(true)
    expect(cssDeclares('.ol-cm-math-tooltip mjx-container', 'margin', '0')).toBe(true)
    expect(cssDeclares('.ol-cm-math-tooltip mjx-container', 'display', 'inline-flex')).toBe(true)
  })

  it('updates root CSS custom properties when switching themes', () => {
    for (const name of THEME_NAMES) {
      themeManager.apply(name)
      const root = document.documentElement
      const tokens = THEMES[name]
      expect(root.style.getPropertyValue('--eu-fg-primary')).toBe(tokens.fgPrimary)
      expect(root.style.getPropertyValue('--eu-visual-fg')).toBe(tokens.visualFg)
      expect(root.style.getPropertyValue('--eu-bg-card')).toBe(tokens.bgCard)
      expect(root.style.getPropertyValue('--eu-border')).toBe(tokens.border)
      expect(root.style.getPropertyValue('--eu-editor-cursor')).toBe(tokens.editorCursor)
      expect(root.style.getPropertyValue('--eu-editor-cursor-math')).toBe(tokens.editorCursorMath)
    }
  })
})

describe('theme-responsive tooltips', () => {
  it('styles generic tooltips using theme tokens', () => {
    expect(cssDeclares('.cm-tooltip', 'background', 'var\\(--eu-bg-card.*\\)')).toBe(true)
    expect(cssDeclares('.cm-tooltip', 'border', '1px solid var\\(--eu-border.*\\)')).toBe(true)
    expect(cssDeclares('.cm-tooltip', 'color', 'var\\(--eu-fg-primary.*\\)')).toBe(true)
  })

  it('styles autocomplete tooltip with theme tokens and highlight selection', () => {
    expect(cssDeclares('.cm-tooltip.cm-tooltip-autocomplete', 'background', 'var\\(--eu-bg-card.*\\)')).toBe(true)
    expect(cssDeclares('.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected]', 'background', 'var\\(--eu-bg-selection-list.*\\)')).toBe(true)
    expect(cssDeclares('.cm-tooltip.cm-tooltip-autocomplete .cm-completionMatchedText', 'color', 'var\\(--eu-accent.*\\)')).toBe(true)
  })

  it('styles line diagnostic tooltip with theme tokens and status borders', () => {
    expect(cssDeclares('.cm-tooltip.cm-tooltip-line-diagnostic', 'background', 'var\\(--eu-bg-card.*\\)')).toBe(true)
    expect(cssDeclares('.cm-tooltip.cm-tooltip-line-diagnostic', 'border', '1px solid var\\(--eu-border.*\\)')).toBe(true)
    expect(cssDeclares('.cm-tooltip-line-diagnostic .cm-line-diagnostic-item-error', 'border-left-color', 'var\\(--eu-error.*\\)')).toBe(true)
    expect(cssDeclares('.cm-tooltip-line-diagnostic .cm-line-diagnostic-item-warning', 'border-left-color', 'var\\(--eu-warning.*\\)')).toBe(true)
  })
})

describe('theme-responsive cursor and caret', () => {
  it('defines caret color switching between normal and math mode', () => {
    expect(cssDeclares('.cm-editor', '--eu-caret-color', 'var\\(--eu-editor-cursor\\)')).toBe(true)
    expect(cssDeclares(".cm-editor[data-caret-math='on']", '--eu-caret-color', 'var\\(--eu-editor-cursor-math\\)')).toBe(true)
    expect(cssDeclares('.cm-cursor, .eukolia-visual-editor .cm-dropCursor', 'border-left-color', 'var\\(--eu-caret-color\\)')).toBe(true)
  })

  it('provides general fallback rules for cm-cursor and cm-cursorLayer', () => {
    expect(cssDeclares('.cm-cursor', 'border-left-color', 'var\\(--eu-caret-color.*\\)')).toBe(true)
    expect(cssDeclares('.cm-cursorLayer', 'color', 'var\\(--eu-caret-color.*\\)')).toBe(true)
  })
})
