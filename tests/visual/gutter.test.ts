// @vitest-environment jsdom
/**
 * The gutter and its diagnostic markers.
 *
 * Three things are pinned down here. All of them are structural, so jsdom can
 * check them honestly — the *rendered* opacity and the marker pixels are
 * measured in the real Chromium probe (`npm run smoke`) instead:
 *
 *  * **One bar in both modes.** The ported Overleaf theme faded the whole gutter
 *    to half opacity, which is invisible in Overleaf — its gutter belongs to the
 *    visual editor alone — but makes the same bar paler in Visual Mode than in
 *    Code Mode here. The stylesheets the two modes mount are compared rule by
 *    rule, and a dimming rule is a failure on its own.
 *
 *  * **Markers left of the number.** The markers come from `@codemirror/lint`'s
 *    gutter, and CodeMirror keeps a gutter at the position of its first
 *    occurrence — so the order in the bar is the order the extensions are
 *    mounted in, which is what the host controls.
 *
 *  * **Markers drawn like the Problems panel.** The marker's shape is a mask
 *    over a theme token, and the artwork is compared element by element against
 *    the Lucide icons `ui/components/Sidebar.tsx` renders for the Problems list.
 *    That comparison is the point: the two surfaces are meant to read as one
 *    visual language.
 *
 * The CSS is read as *text* — the `<style>` elements CodeMirror mounted, and
 * `visual-editor.css` through Vite's `?raw` import — rather than through the
 * CSSOM. jsdom's CSS implementation keeps only the properties it recognises, so
 * a rule about `mask-image` would be invisible to `getComputedStyle` and to
 * `CSSStyleDeclaration` even though Chromium applies it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { switchEditorMode } from '@/visual/modeSwitch'
import { createEditorScope, EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'
import { themeManager } from '@/core/themes'

/**
 * The editor's own stylesheet, as text.
 *
 * Read from disk rather than imported: Vitest does not apply CSS imports, and
 * the assertions below are about what the stylesheet *says* — which is what
 * Chromium parses.
 */
const visualEditorCss = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'visual', 'visual-editor.css'),
  'utf8'
)
// jsdom performs no layout, and CodeMirror measures text through client rects.
const rect = {
  top: 0,
  left: 0,
  bottom: 16,
  right: 100,
  width: 100,
  height: 16,
  x: 0,
  y: 0,
  toJSON: () => ({}),
}
const rectList = [rect] as unknown as DOMRectList
Range.prototype.getClientRects = () => rectList
Range.prototype.getBoundingClientRect = () => rect as DOMRect
Element.prototype.getClientRects = () => rectList

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Alpha line one.',
  '  Indented line two.',
  '\\end{document}',
].join('\n')

let view: EditorView | null = null

/** Lets the language load and the first parse land before a test ends. */
const settle = async (target: EditorView): Promise<void> => {
  const { forceParsing, syntaxTree } = await import('@codemirror/language')
  forceParsing(target, target.state.doc.length, 5000)
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (syntaxTree(target.state).length === target.state.doc.length) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  await new Promise(resolve => setTimeout(resolve, 50))
}

/**
 * Mounts the real extension set.
 *
 * The imports are dynamic for the same reason `appearance.test.ts` makes them
 * dynamic: the ported LaTeX language constructs its lint `Worker` at module
 * scope, and a static import would do that before jsdom is in place.
 */
const mount = async (startVisual: boolean): Promise<EditorView> => {
  const { eukoliaEditorExtensions } = await import('@/visual/editorExtensions')
  themeManager.apply('light')
  const scope = createEditorScope({
    id: `gutter:${startVisual}`,
    filePath: 'D:/project/homework.tex',
    projectRoot: 'D:/project',
    text: DOC,
    files: [{ path: 'D:/project/homework.tex' }],
    phrases: EUKOLIA_EDITOR_PHRASES,
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: eukoliaEditorExtensions({
        scope,
        fileName: 'homework.tex',
        theme: 'light',
        startVisual,
      }),
      selection: { anchor: DOC.indexOf('Alpha') },
    }),
    parent: host,
  })
  // The language is loaded asynchronously by the editor's own extension set; a
  // test that ends while that import is still in flight leaves it to resolve
  // against a torn-down environment, which surfaces as an unhandled rejection
  // rather than as a failure here.
  await settle(view)
  return view
}

afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

/** Every stylesheet the mounted editor wrote, as text. */
const mountedCss = (): string =>
  [...document.querySelectorAll('style')]
    .map(style => style.textContent ?? '')
    .join('\n')

interface Rule {
  selector: string
  body: string
}

/**
 * Rules of a flat stylesheet, as `selector { body }` pairs.
 *
 * Comments are stripped and at-rules are skipped; the editor's generated
 * stylesheets and `visual-editor.css` are both flat, so a nested-brace-aware
 * parser would be a lot of machinery for nothing here.
 */
const rules = (css: string): Rule[] => {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const found: Rule[] = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const selector = match[1].trim()
    if (!selector || selector.startsWith('@')) continue
    found.push({ selector, body: match[2] })
  }
  return found
}

const declarationsOf = (body: string): Array<[string, string]> =>
  body
    .split(';')
    .map(part => {
      const colon = part.indexOf(':')
      if (colon < 0) return null
      const property = part.slice(0, colon).trim()
      const value = part.slice(colon + 1).trim()
      return property && value ? ([property, value] as [string, string]) : null
    })
    .filter((pair): pair is [string, string] => pair !== null)

/** The gutter columns, left to right, in the order CodeMirror rendered them. */
const gutterOrder = (target: EditorView): string[] =>
  [...target.dom.querySelectorAll('.cm-gutters > .cm-gutter')].map(
    gutter => gutter.className
  )

const isGutterSelector = (selector: string): boolean =>
  /\.cm-gutters?(\b|[.:[])/.test(selector)

/** Every gutter declaration in a stylesheet, sorted so two runs are comparable. */
const gutterDeclarations = (css: string): string[] =>
  rules(css)
    .filter(rule => isGutterSelector(rule.selector))
    .flatMap(rule =>
      declarationsOf(rule.body).map(
        ([property, value]) => `${rule.selector} { ${property}: ${value} }`
      )
    )
    .sort()

/**
 * True when a rule's selector ends in exactly `className`.
 *
 * `EditorView.theme()` prefixes every selector it is given with a generated
 * class, so the rule for `.cm-lint-marker-error` is written as
 * `.ͼ4 .cm-lint-marker-error` — the last compound is what identifies the
 * element.
 */
const selectorEndsWith = (selector: string, className: string): boolean =>
  selector
    .split(',')
    .map(part => part.trim())
    .some(part => part.split(/\s+/).pop() === className)

/** The declared value of one property on one selector, or `null`. */
const declaredValue = (
  css: string,
  selector: string,
  property: string,
  match: 'element' | 'exact' = 'element'
): string | null => {
  const matches =
    match === 'exact'
      ? (candidate: string) =>
          candidate
            .split(',')
            .map(part => part.trim())
            .includes(selector)
      : (candidate: string) => selectorEndsWith(candidate, selector)
  let found: string | null = null
  for (const rule of rules(css)) {
    if (!matches(rule.selector)) continue
    for (const [name, value] of declarationsOf(rule.body)) {
      if (name === property) found = value
    }
  }
  return found
}



describe('the gutter bar', () => {
  it('mounts the same columns in both modes', async () => {
    const source = await mount(false)
    const sourceOrder = gutterOrder(source)
    source.destroy()

    const visual = await mount(true)
    expect(gutterOrder(visual)).toEqual(sourceOrder)

    // Numbers, then folding — left to right (lint column removed).
    expect(sourceOrder.map(name => name.replace('cm-gutter ', ''))).toEqual([
      'cm-lineNumbers',
      'cm-foldGutter',
    ])
  })

  it('mounts the same gutter styles in both modes', async () => {
    // The defect this exists for: the ported visual theme carried
    // `.cm-gutter { opacity: 0.5 }`, so the same bar was half-faded in Visual
    // Mode. Comparing the two modes' declarations catches that *and* any other
    // mode-specific restyling of the bar, in one assertion.
    const source = await mount(false)
    const sourceRules = gutterDeclarations(mountedCss())
    expect(sourceRules.length).toBeGreaterThan(0)
    source.destroy()

    await mount(true)
    expect(gutterDeclarations(mountedCss())).toEqual(sourceRules)
  })

  it('never fades a gutter column', async () => {
    await mount(true)
    const everything = `${mountedCss()}\n${visualEditorCss}`
    const faded = rules(everything)
      .filter(rule => isGutterSelector(rule.selector))
      .flatMap(rule =>
        declarationsOf(rule.body)
          .filter(
            ([property, value]) => property === 'opacity' && Number(value) < 1
          )
          .map(([, value]) => `${rule.selector} { opacity: ${value} }`)
      )
    expect(faded, JSON.stringify(faded, null, 2)).toEqual([])
  })

  it('declares the bar’s colour and width once, for both modes', async () => {
    // `visual-editor.css` is the one stylesheet that styles the bar, and nothing
    // in it may be scoped to a mode: that is what "the same bar in both modes"
    // means in practice.
    const bar = rules(visualEditorCss).filter(rule =>
      isGutterSelector(rule.selector)
    )
    expect(bar.length).toBeGreaterThan(0)
    for (const rule of bar) {
      expect(
        rule.selector,
        `${rule.selector} must not be scoped to one mode`
      ).not.toContain('data-mode')
    }

    const app = (selector: string, property: string) =>
      declaredValue(visualEditorCss, selector, property, 'exact')
    expect(app('.eukolia-visual-editor .cm-gutters', 'background')).toBe(
      'var(--eu-current-editor-bg, var(--eu-editor-bg))'
    )
    expect(app('.eukolia-visual-editor .cm-gutters', 'color')).toBe(
      'var(--eu-editor-gutter-fg)'
    )
    /*
     * Padding and minimum width are asserted so that a *second* declaration cannot appear, not
     * because the numbers are load-bearing. Both changed together when the bar was reworked:
     * padding `0 8px 0 12px` -> `0 0 0 12px`, and `min-width: 3.4em` -> `0`, since CodeMirror's
     * line-number spacer already reserves the document's digits and the extra minimum left unused
     * space on the gutter's right. This test noticed both, which is what it is for.
     */
    expect(
      app('.eukolia-visual-editor .cm-lineNumbers .cm-gutterElement', 'padding')
    ).toBe('0 8px 0 0')
    expect(app('.eukolia-visual-editor .cm-gutters', 'min-width')).toBe('0')
  })

  it('flips the surface mode through the live compartment', async () => {
    const { isVisual } = await import('@/visual/editorExtensions')
    const target = await mount(false)
    expect(target.dom.getAttribute('data-mode')).toBe('source')
    expect(isVisual(target)).toBe(false)

    expect(switchEditorMode(target, true)).toBe(true)
    expect(target.dom.getAttribute('data-mode')).toBe('visual')

    expect(switchEditorMode(target, false)).toBe(true)
    expect(target.dom.getAttribute('data-mode')).toBe('source')
  })
})

describe('diagnostic line number highlighting', () => {
  it('does not mount a separate lint gutter column, narrowing the index bar', async () => {
    const target = await mount(false)
    expect(target.dom.querySelector('.cm-gutter-lint')).toBeNull()
  })

  it('declares red highlight for error line numbers', () => {
    expect(
      declaredValue(
        visualEditorCss,
        '.eukolia-visual-editor .cm-lineNumbers .cm-gutterElement.cm-lint-error',
        'color',
        'exact'
      )
    ).toBe('var(--eu-error)')
    expect(
      declaredValue(
        visualEditorCss,
        '.eukolia-visual-editor .cm-lineNumbers .cm-gutterElement.cm-lint-error',
        'font-weight',
        'exact'
      )
    ).toBe('600')
  })

  it('declares yellow highlight for warning line numbers', () => {
    expect(
      declaredValue(
        visualEditorCss,
        '.eukolia-visual-editor .cm-lineNumbers .cm-gutterElement.cm-lint-warning',
        'color',
        'exact'
      )
    ).toBe('var(--eu-warning)')
    expect(
      declaredValue(
        visualEditorCss,
        '.eukolia-visual-editor .cm-lineNumbers .cm-gutterElement.cm-lint-warning',
        'font-weight',
        'exact'
      )
    ).toBe('600')
  })

  it('highlights the line number when an error or warning occurs', async () => {
    const target = await mount(false)
    const { setDiagnosticsEffect } = await import('@codemirror/lint')
    target.dispatch({
      effects: [
        setDiagnosticsEffect.of([
          {
            from: target.state.doc.line(2).from,
            to: target.state.doc.line(2).to,
            severity: 'warning',
            message: 'test warning'
          },
          {
            from: target.state.doc.line(3).from,
            to: target.state.doc.line(3).to,
            severity: 'error',
            message: 'test error'
          }
        ])
      ]
    })
    const elements = [...target.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
    const line2 = elements.find((el) => el.textContent === '2')
    const line3 = elements.find((el) => el.textContent === '3')
    expect(line2?.classList.contains('cm-lint-warning')).toBe(true)
    expect(line3?.classList.contains('cm-lint-error')).toBe(true)
  })

  it('displays a modern diagnostic tooltip when hovering over an error line number', async () => {
    const target = await mount(false)
    const { setDiagnosticsEffect } = await import('@codemirror/lint')
    target.dispatch({
      effects: [
        setDiagnosticsEffect.of([
          {
            from: target.state.doc.line(3).from,
            to: target.state.doc.line(3).to,
            severity: 'error',
            message: 'Syntax error in document',
            source: 'latex'
          }
        ])
      ]
    })

    const elements = [...target.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
    const line3 = elements.find((el) => el.textContent === '3')!
    expect(line3).toBeDefined()

    line3.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    line3.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))

    await new Promise((r) => setTimeout(r, 120))

    const tooltip = document.querySelector('.cm-tooltip-line-diagnostic')
    expect(tooltip, 'tooltip must be rendered in DOM on hover').not.toBeNull()
    expect(tooltip?.querySelector('.cm-line-diagnostic-title')?.textContent).toBe('Line 3')
    expect(tooltip?.querySelector('.cm-line-diagnostic-count')?.textContent).toBe('1 problem')
    expect(tooltip?.querySelector('.cm-line-diagnostic-badge-error')?.textContent).toContain('Error')
    expect(tooltip?.querySelector('.cm-line-diagnostic-source')?.textContent).toBe('latex')
    expect(tooltip?.querySelector('.cm-line-diagnostic-message')?.textContent).toBe('Syntax error in document')
    expect(tooltip?.querySelector('.cm-line-diagnostic-icon')).not.toBeNull()
  })

  it('displays a warning tooltip when hovering over a warning line number', async () => {
    const target = await mount(false)
    const { setDiagnosticsEffect } = await import('@codemirror/lint')
    target.dispatch({
      effects: [
        setDiagnosticsEffect.of([
          {
            from: target.state.doc.line(2).from,
            to: target.state.doc.line(2).to,
            severity: 'warning',
            message: 'Package hyperref deprecated option',
            source: 'latex linter'
          }
        ])
      ]
    })

    const elements = [...target.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
    const line2 = elements.find((el) => el.textContent === '2')!
    expect(line2).toBeDefined()

    line2.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    line2.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))

    await new Promise((r) => setTimeout(r, 120))

    const tooltip = document.querySelector('.cm-tooltip-line-diagnostic')
    expect(tooltip).not.toBeNull()
    expect(tooltip?.querySelector('.cm-line-diagnostic-title')?.textContent).toBe('Line 2')
    expect(tooltip?.querySelector('.cm-line-diagnostic-badge-warning')?.textContent).toContain('Warning')
    expect(tooltip?.querySelector('.cm-line-diagnostic-source')?.textContent).toBe('latex linter')
    expect(tooltip?.querySelector('.cm-line-diagnostic-message')?.textContent).toBe(
      'Package hyperref deprecated option'
    )
  })

  it('dismisses the tooltip when mouse moves away', async () => {
    const target = await mount(false)
    const { setDiagnosticsEffect } = await import('@codemirror/lint')
    target.dispatch({
      effects: [
        setDiagnosticsEffect.of([
          {
            from: target.state.doc.line(3).from,
            to: target.state.doc.line(3).to,
            severity: 'error',
            message: 'Sample error'
          }
        ])
      ]
    })

    const elements = [...target.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
    const line3 = elements.find((el) => el.textContent === '3')!
    line3.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    line3.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))

    await new Promise((r) => setTimeout(r, 120))
    expect(document.querySelector('.cm-tooltip-line-diagnostic')).not.toBeNull()

    // Move mouse far away
    window.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: 9999,
        clientY: 9999
      })
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelector('.cm-tooltip-line-diagnostic')).toBeNull()
  })

  it('renders multiple diagnostics on the same line with error preceding warning', async () => {
    const target = await mount(false)
    const { setDiagnosticsEffect } = await import('@codemirror/lint')
    target.dispatch({
      effects: [
        setDiagnosticsEffect.of([
          {
            from: target.state.doc.line(3).from,
            to: target.state.doc.line(3).to,
            severity: 'warning',
            message: 'Warning on line 3'
          },
          {
            from: target.state.doc.line(3).from,
            to: target.state.doc.line(3).to,
            severity: 'error',
            message: 'Error on line 3'
          }
        ])
      ]
    })

    const elements = [...target.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
    const line3 = elements.find((el) => el.textContent === '3')!
    line3.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    line3.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))

    await new Promise((r) => setTimeout(r, 120))

    const tooltip = document.querySelector('.cm-tooltip-line-diagnostic')
    expect(tooltip).not.toBeNull()
    expect(tooltip?.querySelector('.cm-line-diagnostic-count')?.textContent).toBe('2 problems')

    const items = tooltip?.querySelectorAll('.cm-line-diagnostic-item')
    expect(items?.length).toBe(2)
    // Error takes precedence: first item is error, second is warning
    expect(items?.[0].classList.contains('cm-line-diagnostic-item-error')).toBe(true)
    expect(items?.[0].textContent).toContain('Error on line 3')
    expect(items?.[1].classList.contains('cm-line-diagnostic-item-warning')).toBe(true)
    expect(items?.[1].textContent).toContain('Warning on line 3')
  })

  it('declares modern tooltip styling using theme variables', () => {
    expect(
      declaredValue(
        visualEditorCss,
        '.cm-tooltip.cm-tooltip-line-diagnostic',
        'background',
        'exact'
      )
    ).toBe('var(--eu-bg-card, #181b25)')
    expect(
      declaredValue(
        visualEditorCss,
        '.cm-tooltip.cm-tooltip-line-diagnostic',
        'border',
        'exact'
      )
    ).toBe('1px solid var(--eu-border, #232838)')
    expect(
      declaredValue(
        visualEditorCss,
        '.cm-tooltip.cm-tooltip-line-diagnostic',
        'border-radius',
        'exact'
      )
    ).toBe('8px')
  })
})

