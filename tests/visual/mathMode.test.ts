// @vitest-environment jsdom
/**
 * Math Mode — the editing context where the caret is inside a mathematical
 * region.
 *
 * Two claims are worth falsifying, and they are the two the feature is:
 *
 *  1. **The caret knows which context it is in.** `editor/mathContext.ts` marks
 *     the editor `data-caret-math`, and `visual-editor.css` gives that state a
 *     colour of its own, so mathematics is distinguishable at a glance from the
 *     prose around it. The boundary cases are the interesting ones: the caret at
 *     the closing `$` is *not* in mathematics, and neither is one that has left
 *     the region, even if the region is still on screen.
 *  2. **Source is set one way.** The LaTeX revealed under the caret is code, and
 *     it must read as the same code the editor shows anywhere else — the same
 *     face, size, weight, line height — so the rules for `eu-cm-math-source` are
 *     asserted against the rules the editor already applies to its source, and
 *     against the faces the ported theme actually publishes, rather than merely
 *     being asserted to exist.
 *
 * Most tests mount a *lean* editor — the LaTeX language and the two extensions
 * this feature adds — because the context is a property of the syntax tree and
 * the selection, and nothing else in the real extension set can change either.
 * Two tests mount the real set instead, to show that the feature is in it and
 * that a mount seeded inside mathematics reports the context immediately.
 *
 * The stylesheet is read as *text*, following `gutter.test.ts`: jsdom's CSS
 * implementation keeps only the properties it recognises, so a claim about
 * `font-variant` would be invisible through `getComputedStyle` even though
 * Chromium applies it.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import {
  inMathAt,
  isMathContext,
  MATH_ATTRIBUTE,
  MATH_SOURCE_CLASS,
  mathCaretAttribute,
  mathSourceDecorations,
  mathSourceMarks,
} from '@/editor/mathContext'
import { THEMES, THEME_NAMES, themeManager } from '@/core/themes'

/**
 * The editor's own stylesheet, as text. Read from disk rather than imported:
 * Vitest does not apply CSS imports, and the assertions are about what the
 * stylesheet *says*.
 */
const visualEditorCss = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'renderer', 'visual', 'visual-editor.css'),
  'utf8'
)

/**
 * Extracts the declarations of every rule whose selector contains
 * `selectorFragment`, so a declaration can be asserted against the rule that
 * actually carries it. Comments are removed first: this stylesheet explains
 * itself at length, and a brace inside prose would otherwise be read as a rule.
 * Both the selector and the declarations are collapsed to single spaces, so an
 * assertion does not depend on where the stylesheet happens to wrap a line.
 */
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

/** True when some rule for `selectorFragment` declares `property: value`. */
const cssDeclares = (
  selectorFragment: string,
  property: string,
  value: string
): boolean =>
  cssRules(selectorFragment).some(block =>
    new RegExp(`${property}\\s*:\\s*${value}\\s*(;|$)`).test(block)
  )

/** The declarations of the rules whose selector is exactly `selector`. */
const cssRulesForExactSelector = (selector: string): string[] => {
  const css = visualEditorCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const wanted = selector.replace(/\s+/g, ' ').trim()
  const blocks: string[] = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) {
    const each = match[1]
      .split(',')
      .map(part => part.replace(/\s+/g, ' ').trim())
    if (each.includes(wanted)) blocks.push(match[2].replace(/\s+/g, ' ').trim())
  }
  return blocks
}

/** Every selector the editor's generated stylesheet paints in the source face. */
const generatedSourceFaceSelectors = (): string[] => {
  const css = [...document.head.querySelectorAll('style')]
    .map(style => style.textContent ?? '')
    .join('\n')
  const found = new Set<string>()
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) {
    if (!match[2].includes('var(--source-font-family)')) continue
    for (const selector of match[1].split(',')) {
      const trimmed = selector.replace(/\s+/g, ' ').trim()
      // The editor's own chrome is not the document: line numbers and tooltips
      // carry the face for legibility, not because they show the user's LaTeX.
      if (!/\.cm-gutters|\.cm-lineNumbers|\.cm-tooltip|\.cm-foldGutter/.test(trimmed)) {
        found.add(trimmed)
      }
    }
  }
  return [...found]
}

/**
 * A document with one inline region, one display region and one region that must
 * *not* be mistaken for mathematics.
 */
const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Text with $x^2 + \\alpha$ inline.',
  'Then:',
  '\\[',
  '  gHg^{-1} = H',
  '\\]',
  '\\begin{equation}',
  '  E = mc^2',
  '\\end{equation}',
  '\\begin{verbatim}',
  'not $math$ here',
  '\\end{verbatim}',
  '\\end{document}',
].join('\n')

/** Offset just inside a marker's text (its first character). */
const inside = (marker: string): number => DOC.indexOf(marker) + 1

/** Offset just after a marker's text. */
const after = (marker: string): number => DOC.indexOf(marker) + marker.length

const INLINE = '$x^2 + \\alpha$'
const INLINE_FROM = DOC.indexOf(INLINE)
/** End of the inline region's content: the offset of the closing `$`. */
const INLINE_BODY_END = DOC.indexOf(INLINE) + INLINE.length - 1

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

let view: EditorView | null = null

beforeAll(() => {
  themeManager.apply('light')
})

/**
 * Mounts the LaTeX language plus the two extensions this feature adds — the
 * tree and the selection are all the detection reads, and leaving the rest of
 * the editor out keeps these tests a second long instead of ten.
 */
async function mountLean(anchor = 0): Promise<EditorView> {
  const { EditorState } = await import('@codemirror/state')
  const { forceParsing, syntaxTree } = await import('@codemirror/language')
  const { LaTeXLanguage } = await import(
    '@/vendor/overleaf/languages/latex/latex-language'
  )

  const host = document.createElement('div')
  document.body.appendChild(host)

  const mounted = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [LaTeXLanguage, mathCaretAttribute(), mathSourceDecorations],
      selection: { anchor, head: anchor },
    }),
    parent: host,
  })

  forceParsing(mounted, mounted.state.doc.length, 20000)
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (syntaxTree(mounted.state).length === mounted.state.doc.length) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }

  view = mounted
  return mounted
}

/** Mounts the real extension set, as `VisualEditor.tsx` does. */
async function mountFull(
  options: { visual?: boolean; anchor?: number; doc?: string } = {}
): Promise<EditorView> {
  const { EditorState } = await import('@codemirror/state')
  const { forceParsing, syntaxTree } = await import('@codemirror/language')
  const { eukoliaEditorExtensions } = await import('@/visual/editorExtensions')
  const { createEditorScope, EUKOLIA_EDITOR_PHRASES } = await import('@/visual/scope')

  const doc = options.doc ?? DOC
  const anchor = options.anchor ?? 0
  const scope = createEditorScope({
    id: `math:${options.visual ?? true}:${doc.length}:${anchor}`,
    filePath: 'D:/project/homework.tex',
    projectRoot: 'D:/project',
    text: doc,
    files: [{ path: 'D:/project/homework.tex' }],
    phrases: EUKOLIA_EDITOR_PHRASES,
  })

  const host = document.createElement('div')
  document.body.appendChild(host)

  const mounted = new EditorView({
    state: EditorState.create({
      doc,
      extensions: eukoliaEditorExtensions({
        scope,
        fileName: 'homework.tex',
        theme: 'light',
        startVisual: options.visual ?? true,
      }),
      selection: { anchor, head: anchor },
    }),
    parent: host,
  })

  forceParsing(mounted, mounted.state.doc.length, 20000)
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (syntaxTree(mounted.state).length === mounted.state.doc.length) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }

  view = mounted
  return mounted
}

/** Moves the caret and lets the plugins observe the transaction. */
const moveCaret = (target: EditorView, offset: number): void => {
  target.dispatch({ selection: EditorSelection.cursor(offset) })
}

afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

describe('identifying the mathematical region the caret is in', () => {
  it('reports a caret inside inline mathematics and outside it', async () => {
    const mounted = await mountLean()

    expect(inMathAt(mounted.state, inside('x^2'))).toBe(true)
    expect(inMathAt(mounted.state, inside('\\alpha'))).toBe(true)
    expect(inMathAt(mounted.state, inside('Text with'))).toBe(false)
    expect(inMathAt(mounted.state, after('inline.'))).toBe(false)
  })

  it('treats the offset before a closing delimiter as inside the region', async () => {
    const mounted = await mountLean()

    // `$x^2 + \alpha$`. The region's `to` is the offset the closing `$` sits at,
    // and that is where a caret walking back from the delimiter lands — the
    // position `$Hom(A)|$` names, where the mathematics is still on screen and
    // still being edited.
    expect(inMathAt(mounted.state, INLINE_FROM + 1)).toBe(true)
    expect(inMathAt(mounted.state, INLINE_BODY_END - 1)).toBe(true)
    expect(inMathAt(mounted.state, INLINE_BODY_END)).toBe(true)

    // The offset *after* the closing delimiter is prose, and so is the rest of
    // the line: this is the boundary the two questions share.
    expect(inMathAt(mounted.state, INLINE_BODY_END + 1)).toBe(false)
    expect(inMathAt(mounted.state, after('inline.'))).toBe(false)
  })

  it('holds at every boundary of every kind of region', async () => {
    const mounted = await mountLean()

    // Inline: the first and last content offsets are in, the prose either side is
    // out. This is the case `resolveInner` got wrong — it resolves the offset a
    // closing delimiter sits at to the delimiter node, a sibling of `Math`.
    const inline = [INLINE_FROM + 1, INLINE_BODY_END - 1, INLINE_BODY_END]
    for (const offset of inline) {
      expect(inMathAt(mounted.state, offset), `inline offset ${offset}`).toBe(true)
    }
    expect(inMathAt(mounted.state, INLINE_FROM)).toBe(false)

    // Display `\[ … \]`: the caret on the content's first character and on its
    // last are both in — the last being the offset `\]` sits at, which is where a
    // caret walking back from the delimiter lands. The rest of the line after
    // `\[` is inside too: `\[`'s own line ends inside the mathematics that
    // started on it, which is what the reference's display maths does.
    const gHg = DOC.indexOf('gHg')
    const displayEnd = DOC.indexOf('\\]')
    const displayOpen = DOC.indexOf('\\[')
    expect(inMathAt(mounted.state, gHg)).toBe(true)
    expect(inMathAt(mounted.state, displayEnd)).toBe(true)
    expect(inMathAt(mounted.state, gHg - 1)).toBe(true)
    // The delimiters themselves, and the line before, are not.
    expect(inMathAt(mounted.state, displayOpen)).toBe(false)
    expect(inMathAt(mounted.state, displayOpen + 1)).toBe(false)
    expect(inMathAt(mounted.state, displayEnd + 1)).toBe(false)
    expect(inMathAt(mounted.state, displayEnd + 2)).toBe(false)

    // An environment: the content's own offsets are in — including the offset
    // `\end{...}` sits at, which is the environment's last content character and
    // the position the caret holds while `\end` is being typed. The `\end` line's
    // own text is out, as is the `\begin` line's.
    const equationStart = DOC.indexOf('  E = mc^2')
    const equationEnd = DOC.indexOf('\\end{equation}')
    expect(inMathAt(mounted.state, equationStart)).toBe(true)
    expect(inMathAt(mounted.state, equationEnd - 1)).toBe(true)
    expect(inMathAt(mounted.state, equationEnd)).toBe(true)
    expect(inMathAt(mounted.state, equationEnd + 1)).toBe(false)
    expect(inMathAt(mounted.state, DOC.indexOf('\\begin{equation}'))).toBe(false)
  })

  it('recognises display mathematics and mathematical environments', async () => {
    const mounted = await mountLean()

    expect(inMathAt(mounted.state, inside('gHg'))).toBe(true)
    expect(inMathAt(mounted.state, inside('E = mc'))).toBe(true)
    // The environment's own `\begin` / `\end` lines are not the region.
    expect(inMathAt(mounted.state, inside('\\begin{equation}'))).toBe(false)
  })

  it('does not treat mathematics inside verbatim as mathematics', async () => {
    const mounted = await mountLean()

    expect(inMathAt(mounted.state, inside('not $math$'))).toBe(false)
  })

  it('answers for the whole selection when there is more than a caret', async () => {
    const mounted = await mountLean()
    const { syntaxTree } = await import('@codemirror/language')
    const tree = syntaxTree(mounted.state)

    // A range entirely inside the region is mathematics…
    mounted.dispatch({
      selection: EditorSelection.range(INLINE_FROM + 1, INLINE_BODY_END - 1),
    })
    expect(isMathContext(mounted.state, tree)).toBe(true)

    // …a range that runs out of it is not, however much of it is mathematics.
    mounted.dispatch({
      selection: EditorSelection.range(INLINE_FROM + 1, INLINE_FROM + INLINE.length + 8),
    })
    expect(isMathContext(mounted.state, tree)).toBe(false)
  })
})

describe('the caret reports which editing context is active', () => {
  it('marks the editor while the caret is in mathematics, and unmarks it on leaving', async () => {
    const mounted = await mountLean(after('Text with'))
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('off')

    moveCaret(mounted, inside('x^2'))
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('on')

    moveCaret(mounted, inside('inline.'))
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('off')

    // Into the display region and back out across the environment boundary.
    moveCaret(mounted, inside('gHg'))
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('on')

    moveCaret(mounted, inside('\\begin{equation}'))
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('off')

    moveCaret(mounted, inside('E = mc'))
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('on')
  })

  it('keeps the colour while the caret walks back over the closing delimiter', async () => {
    // The reported case: `$Hom(A)|$`. Walking left out of the prose, the caret
    // reaches the offset the closing `$` sits at while the mathematics is still
    // on screen and still being edited, and it must not change colour there.
    const mounted = await mountLean(INLINE_BODY_END + 1)
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('off')

    moveCaret(mounted, INLINE_BODY_END)
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('on')

    moveCaret(mounted, INLINE_BODY_END - 1)
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('on')

    // And it does change once the caret is past the delimiter's far side.
    moveCaret(mounted, INLINE_FROM)
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('off')
  })
})

describe('the revealed mathematical source carries the editor’s source class', () => {
  it('marks the region, and only the region', async () => {
    const mounted = await mountLean()
    const marks = mathSourceMarks(mounted.state)

    expect(marks.length).toBeGreaterThanOrEqual(3)
    for (const mark of marks) {
      expect((mark.value.spec as { class?: string }).class).toBe(MATH_SOURCE_CLASS)
    }

    // The inline region's mark covers its content exactly, without the
    // delimiters, which are the editor's own punctuation rather than content.
    const inline = marks.find(mark => mark.from === INLINE_FROM + 1)
    expect(inline).toBeDefined()
    expect(inline?.to).toBe(INLINE_BODY_END)

    // Nothing in the verbatim block.
    const verbatimFrom = DOC.indexOf('not $math$')
    expect(marks.some(mark => mark.from >= verbatimFrom && mark.from < verbatimFrom + 16)).toBe(
      false
    )
  })

  it('covers the regions the visual editor reveals, delimiters excluded', async () => {
    // The reveal itself is the ported editor's: `decorations.test.ts` asserts
    // that an intersecting selection removes the `MathWidget`, so what is left to
    // check here is that the source which appears is the range this module marks
    // — the same node the reveal is keyed on, which is why the two cannot drift.
    const mounted = await mountLean()
    const marks = mathSourceMarks(mounted.state)

    // `\[` and `\]` are the region's punctuation: the mark covers the content
    // between them, from the newline after `\[` to the newline before `\]`.
    const display = marks.find(
      mark => mark.from <= inside('gHg') && mark.to >= after('gHg')
    )
    expect(display).toBeDefined()
    expect(mounted.state.doc.sliceString(display!.from, display!.to).trim()).toBe(
      'gHg^{-1} = H'
    )
  })

  it('applies the marks through the mounted editor', async () => {
    const mounted = await mountLean(inside('x^2'))
    const plugin = mathSourceDecorations as unknown as Parameters<
      EditorView['plugin']
    >[0]
    const instance = mounted.plugin(plugin) as { decorations?: { size: number } } | null

    expect(instance).not.toBeNull()
    expect(instance?.decorations?.size ?? 0).toBeGreaterThan(0)
  })
})

describe('the real extension set carries the feature', () => {
  it('keeps the attribute in step with the caret in the live editor', async () => {
    // A document with no preamble on purpose: the port's `skipPreambleWithCursor`
    // escapes the caret out of a collapsed preamble during the first parse, which
    // is correct behaviour but moves a seeded position while the test watches.
    const doc = 'Text with $x^2$ inline.\n'
    const mounted = await mountFull({ doc, anchor: 0 })

    // The whole claim, stated as one relation: the attribute is the live answer
    // for wherever the caret is, never a stale one. The port's escape from atomic
    // ranges may nudge the caret at a region's edge, and this holds either way.
    const agrees = () =>
      mounted.dom.getAttribute(MATH_ATTRIBUTE) ===
      (inMathAt(mounted.state, mounted.state.selection.main.anchor) ? 'on' : 'off')

    expect(mounted.dom.getAttribute('data-mode')).toBe('visual')
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('off')
    expect(agrees()).toBe(true)

    // Into the mathematics, and back out into the prose.
    moveCaret(mounted, doc.indexOf('x^2') + 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(agrees()).toBe(true)

    moveCaret(mounted, doc.indexOf('inline'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('off')
    expect(agrees()).toBe(true)
  })

  it('reports the same context in source mode, because it is a property of the caret', async () => {
    const mounted = await mountFull({ visual: false, anchor: 0 })
    expect(mounted.dom.getAttribute('data-mode')).toBe('source')
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('off')

    moveCaret(mounted, inside('x^2'))
    expect(mounted.dom.getAttribute(MATH_ATTRIBUTE)).toBe('on')
  })
})

describe('the revealed mathematics is set as source, not as prose', () => {
  it('reads the two faces the ported theme publishes, and they are not the same one', async () => {
    // The ported theme puts a *source* face (`--source-font-family`, from
    // `editor.fontFamily`) and a *prose* face (`--visual-font-family`) on the
    // editor element. Which of the two mathematical source inherits is the whole
    // question, and the rule under test is only meaningful while they differ.
    const mounted = await mountFull()
    const style = window.getComputedStyle(mounted.dom)
    const sourceFamily = style.getPropertyValue('--source-font-family').trim()
    const visualFamily = style.getPropertyValue('--visual-font-family').trim()

    expect(sourceFamily).toBeTruthy()
    expect(visualFamily).toBeTruthy()
    expect(sourceFamily).not.toBe(visualFamily)

    // A size, not just a face: the prose size is the source size multiplied, and
    // that multiplication is what the revealed mathematics used to inherit.
    expect(style.getPropertyValue('--visual-font-size').replace(/\s+/g, '')).toBe(
      'calc(var(--font-size)*1.15)'
    )
  })

  it('takes the source face and size rather than the prose ones', () => {
    const declarations = cssRules('.eu-cm-math-source').join(' ')
    expect(declarations).toContain('font-size: var(--font-size)')
    expect(declarations).not.toContain('--visual-font-size')
    expect(declarations).not.toContain('--visual-font-family')
  })
})

describe('mathematics and rendered code are set identically', () => {
  it('gives mathematical source the editor’s own face, size and line height', () => {
    // The same variables the ported theme publishes on the editor element from
    // `editor.fontFamily`, `editor.fontSize` and `editor.lineHeight` — the values
    // Code Mode's own content is set with, and not the visual surface's prose at
    // 1.15× with the prose line height, which is what the source used to inherit.
    expect(cssDeclares('.eu-cm-math-source', 'font-family', 'var\\(--source-font-family\\)')).toBe(
      true
    )
    expect(cssDeclares('.eu-cm-math-source', 'font-size', 'var\\(--font-size\\)')).toBe(true)
    // Line height is the caret's height, so this is the assertion that pins it.
    expect(cssDeclares('.eu-cm-math-source', 'line-height', 'var\\(--line-height\\)')).toBe(true)
    expect(cssDeclares('.eu-cm-math-source', 'font-weight', 'normal')).toBe(true)
    expect(cssDeclares('.eu-cm-math-source', 'font-style', 'normal')).toBe(true)
    expect(cssDeclares('.eu-cm-math-source', 'font-variant', 'normal')).toBe(true)
  })

  it('does not restate syntax colours in the rule, so both surfaces share one palette', () => {
    const declarations = cssRules('.eu-cm-math-source').join('\n')
    expect(declarations).not.toContain('color')
    expect(declarations).not.toContain('--eu-syntax')
  })

  it('departs from the ported monospace rule on line height, on purpose', () => {
    // The ported theme sets `line-height: 1` on its code classes, which is right
    // for a code span quoted inside a paragraph and wrong for a line of source:
    // it makes a source line's box shorter than the prose line's, and CodeMirror
    // draws the caret at `textHeight`, measured from the lines whose text has no
    // non-ASCII characters. So the divergence is asserted rather than left
    // implicit — if the port ever changes its mind, this test says so.
    const themeSource = fs.readFileSync(
      path.resolve(
        __dirname,
        '..',
        '..',
        'src',
        'renderer',
        'vendor',
        'overleaf',
        'extensions',
        'visual',
        'visual-theme.ts'
      ),
      'utf8'
    )
    const monospaceRule = /'\.ol-cm-monospace':\s*\{([^}]*)\}/.exec(themeSource)?.[1]
    expect(monospaceRule, 'the ported monospace rule was not found').toBeTruthy()

    const monospace = monospaceRule!.replace(/\s+/g, ' ')
    expect(monospace).toContain("fontFamily: 'var(--source-font-family)'")
    // The rule the port states, and the one we do not follow.
    expect(monospace).toContain('lineHeight: 1,')

    const ours = cssRules('.eu-cm-math-source').join(' ')
    expect(ours).toContain('font-family: var(--source-font-family)')
    expect(ours).toContain('line-height: var(--line-height)')
  })

  it('places one background tint on the visual surface only', () => {
    expect(
      cssDeclares(
        ".cm-editor[data-mode='visual'] .eu-cm-math-source",
        'background',
        'var\\(--eu-visual-math-source-bg\\)'
      )
    ).toBe(true)
    // Code Mode is source throughout; there is no region to pick out.
    expect(cssRules('.eu-cm-math-source').join('\n')).not.toContain("[data-mode='source']")
  })

  it('sets every piece of code in the editor at Code Mode’s size', async () => {
    // The claim, stated against the editor's *own* generated stylesheet rather
    // than against a list written here: whatever the ported theme decides to paint
    // in the source face, the size rule has to cover it. A selector added to the
    // port later — or a rule of ours that stops matching after a rename — then
    // shows up as a failure instead of as text that is quietly 15% too large.
    const mounted = await mountFull()

    // The ported theme publishes the sizes it uses as variables on the editor
    // element: `--font-size` is `editor.fontSize` (Code Mode's content size) and
    // `--visual-font-size` is that multiplied for the visual surface's prose.
    const computed = window.getComputedStyle(mounted.dom)
    const contentSize = computed.getPropertyValue('--font-size').trim()
    const proseSize = computed.getPropertyValue('--visual-font-size').replace(/\s+/g, '')
    expect(contentSize).toBe('14px')
    expect(proseSize).toBe('calc(var(--font-size)*1.15)')

    const painted = generatedSourceFaceSelectors()
    // The ported theme writes these as `.ͼ<id> .ol-cm-monospace`, nested under its
    // own generated class. The declarations are ours to state at document order
    // and at a specificity the ported rules cannot beat, so the class at the end
    // of each selector is what has to be covered.
    const classes = painted.map(selector => selector.split(' ').pop() as string).sort()

    // A sanity check that the extraction found the theme's real rules rather than
    // an empty list, which would make the loop below vacuously pass.
    expect(classes.length).toBeGreaterThanOrEqual(5)
    expect(classes).toContain('.ol-cm-monospace')
    expect(classes).toContain('.ol-cm-environment-verbatim')

    /**
     * Selectors that carry the source face for a reason other than showing the
     * user's LaTeX, each with the reason. Listed rather than pattern-matched, so
     * that a *new* one cannot slip in unnoticed.
     */
    const excluded = new Map([
      // The document's own body element: it decides the size everything inherits,
      // and Visual Mode sets it larger on purpose — that is prose, not code.
      ['.cm-content', 'the visual surface’s prose size, which code then overrides'],
      ['.cm-cursor-primary', 'the caret, sized like the text it sits in'],
      // `\textsf{}` is a sans-serif request inside prose, not a code island; the
      // ported theme reaches for the source stack because it is the only sans
      // face it has.
      ['.ol-cm-command-textsf', 'a font choice inside prose, not a code island'],
      // The completion popup's "kind" label ("function", "snippet"), which is UI
      // chrome rather than document text and is set relative to its own list.
      ['.ol-cm-completionType', 'the completion popup’s kind label'],
      // `tags.monospace`, which the ported highlighter gives `\texttt{}` and file
      // paths. Same reason as `\textsf`: a typewriter face for a word inside a
      // sentence, which must not shrink relative to that sentence.
      ['ͼo', '`\\texttt{}` and file paths — a face inside prose'],
    ])

    const uncovered: string[] = []
    for (const klass of classes) {
      const name = klass.replace(/^\./, '')
      if (excluded.has(klass) || excluded.has(name)) continue
      const declarations = cssRulesForExactSelector(`.eukolia-visual-editor ${klass}`).join(' ')
      if (!declarations.includes('font-size: var(--font-size)')) uncovered.push(klass)
    }

    expect(
      uncovered,
      `these elements render source but are not set at Code Mode's size:\n${uncovered.join('\n')}`
    ).toEqual([])

    // And the exclusions are real: every one of them names a selector the theme
    // actually paints, so a rename in the port shows up here rather than silently
    // widening the exemption.
    for (const klass of excluded.keys()) {
      const found = classes.some(actual => actual === klass || actual === `.${klass}`)
      expect(found, `exclusion ${klass} no longer matches any rule`).toBe(true)
    }
  })
})

describe('the caret takes the theme’s colour for the active context', () => {
  it('draws the caret from one variable, switched by the context attribute', () => {
    expect(cssDeclares('.cm-editor', '--eu-caret-color', 'var\\(--eu-editor-cursor\\)')).toBe(
      true
    )
    expect(
      cssDeclares(
        ".cm-editor[data-caret-math='on']",
        '--eu-caret-color',
        'var\\(--eu-editor-cursor-math\\)'
      )
    ).toBe(true)
    expect(
      cssDeclares(
        '.cm-cursor, .eukolia-visual-editor .cm-dropCursor',
        'border-left-color',
        'var\\(--eu-caret-color\\)'
      )
    ).toBe(true)
  })

  it('gives every theme a mathematics caret colour that differs from the plain one', () => {
    for (const name of THEME_NAMES) {
      const tokens = THEMES[name]
      expect(tokens.editorCursorMath, `${name} has no editorCursorMath`).toBeTruthy()
      // A colour that did not differ would defeat the purpose of the signal.
      expect(tokens.editorCursorMath, `${name} reuses editorCursor`).not.toBe(tokens.editorCursor)
    }
  })

  it('resolves both tokens into custom properties the stylesheet can read', () => {
    themeManager.apply('dark')
    const root = document.documentElement
    const plain = root.style.getPropertyValue('--eu-editor-cursor')
    const math = root.style.getPropertyValue('--eu-editor-cursor-math')

    expect(plain).toBeTruthy()
    expect(math).toBeTruthy()
    expect(math).not.toBe(plain)

    // The visual surface's token for the revealed source comes through too.
    expect(root.style.getPropertyValue('--eu-visual-math-source-bg')).toBeTruthy()
  })
})
