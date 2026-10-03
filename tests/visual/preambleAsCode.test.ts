/**
 * The preamble in Visual Mode, as both a reader and a stylesheet sees it.
 *
 * Two reports are behind these assertions, and they were contradictory in a way
 * worth recording. The first was that the preamble's *arguments* —
 * `\geometry{margin=1in}`, `\title{Tôpô compact-mở}` — were being drawn in the
 * document face while the commands around them were drawn in the code face, so a
 * single line changed typeface twice. The fix that followed made the unknown
 * arguments revert to the document face, which was backwards: a preamble is
 * code, the whole region is a LaTeX listing, and `margin=1in` is no more prose
 * than `\geometry` is.
 *
 * So the rule here is the simple one: inside the preamble, everything is set in
 * the code face, at the code size, on the code line height — including the
 * comments, which are still italic.
 *
 * The second report is the collapsed toggle: it had grown a "Learn more" link
 * and a `help` icon, pointing at a web page, in an application that is otherwise
 * entirely offline. Both are gone, and the button is now only a chevron and a
 * label.
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { EditorView } from '@codemirror/view'

const RENDERER = path.resolve(__dirname, '..', '..', 'src', 'renderer')
const VISUAL_EDITOR_CSS = fs.readFileSync(
  path.join(RENDERER, 'visual', 'visual-editor.css'),
  'utf8'
)
const INDEX_CSS = fs.readFileSync(path.join(RENDERER, 'index.css'), 'utf8')
const SETTINGS = fs.readFileSync(path.join(RENDERER, 'core', 'settings.ts'), 'utf8')
const VISUAL_THEME = fs.readFileSync(
  path.join(RENDERER, 'vendor', 'overleaf', 'extensions', 'visual', 'visual-theme.ts'),
  'utf8'
)
const PREAMBLE_WIDGET = fs.readFileSync(
  path.join(
    RENDERER,
    'vendor',
    'overleaf',
    'extensions',
    'visual',
    'visual-widgets',
    'preamble.ts'
  ),
  'utf8'
)

/** The rules of one stylesheet, split so a selector can be looked up by name. */
function rules(css: string): Array<{ selector: string; body: string }> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(match => ({ selector: match[1].trim(), body: match[2] }))
    .filter(rule => !rule.selector.startsWith('@'))
}

/** Every declaration that applies to a selector, joined. */
function declarations(selector: string): string {
  return rules(VISUAL_EDITOR_CSS)
    .filter(rule => rule.selector.includes(selector))
    .map(rule => rule.body)
    .join('\n')
}

// ---------------------------------------------------------------------------

describe('the preamble is set as code, all of it', () => {
  it('gives the preamble line the code size and the code line height', () => {
    // The defect: the arguments were at the document size inside a line at the
    // code size, so their baselines and their wrapping did not line up with the
    // commands they belonged to. The design tokens are what Code Mode uses.
    const body = declarations('.cm-line.ol-cm-preamble-line')
    expect(body, 'no rule for the preamble line').not.toBe('')
    expect(body).toContain('font-size: var(--font-size)')
    expect(body).toContain('line-height: var(--line-height)')

    // And those tokens are the editor's own, which the ported theme publishes
    // from the settings — 14px by default, i.e. the code size and not the
    // document's `calc(var(--font-size) * 1.15)`.
    expect(SETTINGS).toContain("key: 'editor.fontSize'")
    expect(SETTINGS).toMatch(/key: 'editor\.fontSize'[^}]*default: 14/)
    expect(VISUAL_THEME).toContain("'--visual-font-size': 'calc(var(--font-size) * 1.15)'")
  })

  it('sets every child of a preamble line at that size, not just the line', () => {
    // The reference's argument marks carry their own `font-size`, and a rule on
    // the line alone loses to them. The `[class] [class]` selector is what makes
    // the size reach the spans.
    const body = declarations('[class] [class]')
    expect(body, 'no descendant rule for the preamble').not.toBe('')
    expect(body).toContain('font-size: var(--font-size)')
    expect(body).toContain('line-height: var(--line-height)')
  })

  it('does not send the preamble back to the document face', () => {
    // The reverted fix. If a rule sets the preamble region in `--eu-serif-font`,
    // then `margin=1in` is prose again and the typeface changes mid-line.
    const preambleRules = rules(VISUAL_EDITOR_CSS).filter(
      rule =>
        rule.selector.includes('ol-cm-preamble') &&
        !rule.selector.includes('widget') &&
        !rule.selector.includes('expand') &&
        !rule.selector.includes('leading') &&
        !rule.selector.includes('text')
    )
    expect(preambleRules.length).toBeGreaterThan(0)
    for (const rule of preambleRules) {
      expect(rule.body, `${rule.selector} restores the document face`).not.toContain(
        '--eu-serif-font'
      )
    }
  })

  it('keeps the preamble comments italic while they are code', () => {
    // Italic is how the reference distinguishes a comment, and it has to be
    // restated because the rule above sets `font-style: normal` to defeat the
    // highlighter's own declarations.
    const italic = rules(VISUAL_EDITOR_CSS).filter(
      rule =>
        rule.selector.includes('ol-cm-preamble-line') &&
        rule.selector.includes('comment') &&
        rule.body.includes('font-style: italic')
    )
    expect(italic.length, 'no italic rule for preamble comments').toBeGreaterThan(0)
  })

  it('lets the sub- and superscript commands keep their smaller size', () => {
    // The blanket size rule must not flatten `\textsuperscript`, which shrinks
    // its own content on purpose.
    const smaller = rules(VISUAL_EDITOR_CSS).filter(
      rule =>
        rule.selector.includes('ol-cm-preamble-line') &&
        /ol-cm-command-textsuperscript|sup\b/.test(rule.selector) &&
        rule.body.includes('font-size: smaller')
    )
    expect(smaller.length).toBeGreaterThan(0)
  })

  it('sets the mathematics source and the verbatim environments at the code size', () => {
    // The same rule as the preamble, for the same reason: LaTeX source shown
    // inside the visual editor is code, whatever it is the source *of*.
    for (const selector of ['.eu-cm-math-source', '.ol-cm-begin', '.ol-cm-end']) {
      const body = declarations(selector)
      expect(body, `${selector} has no rule`).not.toBe('')
      expect(body, `${selector} is not at the code size`).toContain(
        'font-size: var(--font-size)'
      )
    }
  })
})

describe('the collapsed preamble toggle', () => {
  /**
   * The widget with its comments removed.
   *
   * The doc comment above this file's subject quotes the report — "Remove the
   * Learn More" — so searching the raw source for the phrase matches the
   * explanation of the fix rather than the fix. What ships is the code.
   */
  const WIDGET_CODE = PREAMBLE_WIDGET.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /(^|[^:])\/\/.*$/gm,
    '$1'
  )

  it('is a button that says what it does, with no link in it', () => {
    // The report: "Collapsing preamble button still looks terrible. Remove the
    // Learn More." The link went to a web page from an offline application, and
    // the `help` icon beside it was one of the three ligature names that were
    // being painted as words because no icon font was loaded.
    expect(WIDGET_CODE).not.toMatch(/learn\s*more/i)
    expect(WIDGET_CODE).not.toContain('https://')
    expect(WIDGET_CODE).not.toMatch(/['"]help['"]/)
    expect(WIDGET_CODE).not.toMatch(/<a\b/)
    expect(WIDGET_CODE).not.toMatch(/document\.createElement\(['"]a['"]\)/)
  })

  it('still reports its state to assistive technology', () => {
    // Removing the link must not remove the semantics: the control is a toggle
    // and has to say whether the preamble is showing.
    expect(PREAMBLE_WIDGET).toContain('aria-expanded')
    expect(PREAMBLE_WIDGET).toContain('button')
    // Both states have a label, and the labels come from the phrase table rather
    // than from the key names.
    expect(PREAMBLE_WIDGET).toMatch(/hide_document_preamble|show_document_preamble/)
  })

  it('draws its chevron from the vendored icon font', () => {
    expect(PREAMBLE_WIDGET).toContain('material-symbols')
    expect(PREAMBLE_WIDGET).toMatch(/expand_more|expand_less/)
  })

  it('lays the chevron and the label out as one row, without a stretched gap', () => {
    // The other half of "looks terrible": the leading group was stretched apart
    // by `space-between`, so the chevron sat at one end of a 400px button and the
    // label at the other. The widget is also a `<button>`, which brings its own
    // centring and its own font unless both are answered for.
    const body = declarations('.ol-cm-preamble-widget')
    expect(body, 'no rule for the toggle').not.toBe('')
    expect(body).toContain('appearance: none')
    expect(body).not.toContain('space-between')
    expect(body).toContain('text-align: left')
    expect(body).toContain('font: inherit')
    // And it is chrome, not code: the UI face and the UI size, restated so the
    // preamble's blanket code rule cannot reach it.
    expect(body).toContain('font-family: var(--eu-ui-font)')
    expect(body).toContain('font-size: 12px')

    // The icon is a glyph box, not a sentence: it must not stretch with the row.
    const icon = declarations('.ol-cm-preamble-expand-icon')
    expect(icon, 'no rule for the chevron').not.toBe('')
    expect(icon).toMatch(/flex:\s*(0|none)|width:\s*1em/)
    expect(icon).toContain('line-height: 1')
  })
})

// ---------------------------------------------------------------------------
// And the same two properties as the live editor renders them.

// The ported LaTeX language constructs a lint Web Worker on import; jsdom has no
// `Worker`, so a minimal stub keeps the language loadable.
class WorkerStub {
  onmessage: ((event: MessageEvent) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
Object.defineProperty(globalThis, 'Worker', {
  configurable: true,
  writable: true,
  value: WorkerStub,
})

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
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => rect as DOMRect
Element.prototype.getClientRects = () => [rect] as unknown as DOMRectList

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const DOC = [
  '\\documentclass{article}',
  '\\usepackage{geometry}',
  '\\usepackage[utf8]{vietnam}',
  '',
  '\\geometry{margin=1in}',
  '\\setlength{\\parindent}{0pt}',
  '',
  '\\title{Tôpô compact-mở}',
  '\\date{\\today}',
  '',
  '\\begin{document}',
  'Vietnamese prose, in the document face: Tôpô compact-mở.',
  '\\end{document}',
  '',
].join('\n')

let view: EditorView

beforeAll(async () => {
  const { EditorState } = await import('@codemirror/state')
  const { EditorView: View } = await import('@codemirror/view')
  const { forceParsing, syntaxTree } = await import('@codemirror/language')
  const { eukoliaEditorExtensions } = await import('@/visual/editorExtensions')
  const { createEditorScope, EUKOLIA_EDITOR_PHRASES } = await import('@/visual/scope')
  const { setEditable } = await import('@vendor/overleaf/extensions/editable')

  const scope = createEditorScope({
    id: 'preamble-as-code',
    filePath: 'D:/project/main.tex',
    projectRoot: 'D:/project',
    text: DOC,
    files: [{ path: 'D:/project/main.tex' }],
    phrases: EUKOLIA_EDITOR_PHRASES,
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  view = new View({
    state: EditorState.create({
      doc: DOC,
      extensions: eukoliaEditorExtensions({
        scope,
        fileName: 'main.tex',
        theme: 'dark',
        startVisual: true,
      }),
      selection: { anchor: DOC.indexOf('\\begin{document}') + 1 },
    }),
    parent: host,
  })
  view.dispatch(setEditable(true))

  forceParsing(view, view.state.doc.length, 10000)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (syntaxTree(view.state).length === view.state.doc.length) break
    await wait(25)
  }
  await wait(150)
}, 60000)

describe('the live editor marks the preamble for that styling', () => {
  it('puts `ol-cm-preamble-line` on the preamble and not on the body', () => {
    // The stylesheet rule above is only as good as the class it selects.
    const lines = [...view.dom.querySelectorAll('.cm-line')]
    const preamble = lines.filter(line => line.classList.contains('ol-cm-preamble-line'))
    expect(preamble.length).toBeGreaterThan(0)

    const preambleText = preamble.map(line => line.textContent).join('\n')
    expect(preambleText).toContain('margin=1in')
    expect(preambleText).toContain('Tôpô compact-mở')
    // And the document body is not in the region.
    expect(preambleText).not.toContain('Vietnamese prose')
  })

  it('renders the collapsed toggle with no link, as a button with a state', () => {
    const button = view.dom.querySelector('.ol-cm-preamble-widget')
    expect(button, 'the collapsed toggle is missing').not.toBeNull()
    expect(button!.tagName).toBe('BUTTON')
    expect(button!.querySelectorAll('a')).toHaveLength(0)
    expect((button!.textContent ?? '').toLowerCase()).not.toContain('learn more')
    expect(button!.getAttribute('aria-expanded')).not.toBeNull()
  })

  it('does not put a link anywhere in the editor chrome', () => {
    // The whole application is offline; a link in the editor is either a
    // navigation that cannot work or a page the user cannot reach.
    const links = [...view.dom.querySelectorAll('a[href]')].filter(anchor =>
      /^https?:/i.test(anchor.getAttribute('href') ?? '')
    )
    expect(links.map(anchor => anchor.getAttribute('href'))).toEqual([])
  })
})

/**
 * A file reached by `\input{macros}` is a preamble and nothing else.
 *
 * This is a real project's shape, and it had no test because it is not a shape the
 * fixture used: `macros.tex` is 37 lines of `\usepackage`, `\newtheorem`, `\let`
 * and `\newcommand` with no `\begin{document}` anywhere, because it is never a
 * document. Every one of its lines was rendered as ordinary document text — set as
 * prose, with no preamble styling and no toggle — which is what a reader reported
 * as "portions of the code are erroneously rendered as plain text".
 *
 * The two halves matter equally, and the second is what the first attempt at this
 * got wrong: a *document* that simply has no `\begin{document}` yet must be left
 * alone. Treating every such file as a preamble collapsed a bare sentence behind a
 * toggle and broke `\emph` decoration in it.
 */
describe('a preamble fragment with no document environment', () => {
  const mount = async (doc: string): Promise<EditorView> => {
    const { EditorState } = await import('@codemirror/state')
    const { EditorView: View } = await import('@codemirror/view')
    const { forceParsing, syntaxTree } = await import('@codemirror/language')
    const { eukoliaEditorExtensions } = await import('@/visual/editorExtensions')
    const { createEditorScope, EUKOLIA_EDITOR_PHRASES } = await import('@/visual/scope')

    const scope = createEditorScope({
      id: `preamble-fragment-${doc.length}`,
      filePath: 'D:/project/macros.tex',
      projectRoot: 'D:/project',
      text: doc,
      files: [{ path: 'D:/project/macros.tex' }],
      phrases: EUKOLIA_EDITOR_PHRASES,
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const mounted = new View({
      state: EditorState.create({
        doc,
        extensions: eukoliaEditorExtensions({
          scope,
          fileName: 'macros.tex',
          theme: 'dark',
          startVisual: true,
        }),
        // Away from the start, so the preamble is not expanded by the caret.
        selection: { anchor: doc.length },
      }),
      parent: host,
    })
    forceParsing(mounted, doc.length, 20000)
    for (let attempt = 0; attempt < 40; attempt++) {
      if (syntaxTree(mounted.state).length === doc.length) break
      await wait(25)
    }
    await wait(150)
    return mounted
  }

  /** The shape of the real `macros.tex`: packages, theorem declarations, macros. */
  const FRAGMENT = [
    '\\usepackage{amsmath, amssymb, amsthm, mathtools}',
    '',
    '\\newtheorem{theorem}{Theorem}[section]',
    '\\newtheorem{proposition}[theorem]{Proposition}',
    '',
    '\\let\\cal\\relax',
    '\\newcommand{\\R}{\\mathbb{R}}',
    '',
  ].join('\n')

  it('treats every line of the fragment as preamble, and offers the toggle', async () => {
    const mounted = await mount(FRAGMENT)
    const lines = [...mounted.dom.querySelectorAll('.cm-line')]
    const marked = lines.filter(line => line.classList.contains('ol-cm-preamble-line'))

    // Every line, not most of them: the fragment has no body to exclude.
    expect(marked).toHaveLength(lines.length)
    expect(mounted.dom.querySelector('.ol-cm-preamble-widget')).not.toBeNull()

    // And it says what it does, rather than reading as debris above the file.
    const label = mounted.dom.querySelector('.ol-cm-preamble-text')?.textContent ?? ''
    expect(label.length).toBeGreaterThan(0)
  }, 60000)

  it('recognises a fragment that declares only theorem environments', async () => {
    // A preamble split across files may carry no `\usepackage` at all.
    const mounted = await mount('\\newtheorem{lemma}[theorem]{Lemma}\n')
    const lines = [...mounted.dom.querySelectorAll('.cm-line')]
    expect(lines.every(line => line.classList.contains('ol-cm-preamble-line'))).toBe(true)
  }, 60000)

  it('leaves a document with no `\\begin{document}` alone when it is not a fragment', async () => {
    /*
     * The regression that the first version of this fix introduced. A bare sentence
     * has no document environment either, and folding it away as a preamble hid the
     * reader's own text and broke `\emph` decoration inside it.
     */
    const mounted = await mount('A subgroup is \\emph{normal} if\n')
    const lines = [...mounted.dom.querySelectorAll('.cm-line')]
    expect(lines.some(line => line.classList.contains('ol-cm-preamble-line'))).toBe(false)
    expect(mounted.dom.querySelector('.ol-cm-preamble-widget')).toBeNull()
  }, 60000)

  it('leaves a document that does have a body unchanged', async () => {
    const mounted = await mount(
      [
        '\\documentclass{article}',
        '\\usepackage{amsmath}',
        '\\begin{document}',
        'Body text.',
        '\\end{document}',
        '',
      ].join('\n')
    )
    /*
     * The preamble here is *folded*, so its lines are not `.cm-line` elements at
     * all — an earlier version of this assertion counted them and measured zero.
     * What matters for this document is the boundary: the body is on screen and the
     * preamble is not.
     */
    expect(mounted.dom.querySelector('.ol-cm-preamble-widget')).not.toBeNull()
    const visible = [...mounted.dom.querySelectorAll('.cm-line')]
      .map(line => line.textContent ?? '')
      .join('\n')
    expect(visible).toContain('Body text.')
    expect(visible).not.toContain('documentclass')
    expect(visible).not.toContain('amsmath')
  }, 60000)
})
