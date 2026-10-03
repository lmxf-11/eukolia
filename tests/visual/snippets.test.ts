// @vitest-environment jsdom
/**
 * The editor must drive the HyperSnips engine in both modes.
 *
 * The snippet behaviour was written against the Monaco host — `A`-flag snippets
 * expand on typing, Tab walks the tab stops — and the editor is now CodeMirror in
 * both modes, so the same behaviour has to hold there: otherwise a snippet works
 * in one mode and silently corrupts the text in the other.
 */

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { forceParsing } from '@codemirror/language'
import { CompletionContext, autocompletion } from '@codemirror/autocomplete'

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language'
import { phrases } from '@/vendor/overleaf/extensions/phrases'
import { filePreview } from '@/vendor/overleaf/extensions/file-preview'
import { EUKOLIA_EDITOR_PHRASES, createEditorScope } from '@/visual/scope'
import { expandMatchingSnippet, snippetCompletionSource, snippetExtensions } from '@/visual/snippets'
import { getSnippetEngine } from '@/snippets/engine'
import { defaultSnippetSources } from '@/snippets/defaultSnippets'
import { setting, settingsManager } from '@/core/settings'

/**
 * Loads the built-in snippet library the application ships with.
 *
 * Unconditionally, because the engine is shared by every test in this file: a
 * test that loads its own library leaves the next one without the built-ins, and
 * "only if nothing is loaded" made that depend on the order the tests run in.
 */
const loadSnippets = (): void => {
  getSnippetEngine().loadSnippetSources(defaultSnippetSources())
}

const createView = (doc: string, anchor: number): EditorView => {
  loadSnippets()

  const parent = document.createElement('div')
  document.body.append(parent)

  const scope = createEditorScope({
    id: 'snippets',
    filePath: 'D:/project/homework.tex',
    projectRoot: 'D:/project',
    text: doc,
    files: [{ path: 'D:/project/homework.tex' }],
    phrases: EUKOLIA_EDITOR_PHRASES,
  })

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        LaTeXLanguage,
        phrases(EUKOLIA_EDITOR_PHRASES),
        filePreview(() => null),
        snippetExtensions(),
      ],
    }),
  })
  forceParsing(view, doc.length, 5000)
  return view
}

/** Types `text` one character at a time, the way a keyboard does. */
const type = (view: EditorView, text: string): void => {
  for (const character of text) {
    const { from, to } = view.state.selection.main
    view.dispatch({
      changes: { from, to, insert: character },
      selection: { anchor: from + character.length },
      userEvent: 'input.type',
    })
  }
}

/**
 * Waits for the snippet expansion.
 *
 * Expansion is deliberately deferred by one microtask so the host is told about
 * the keystroke before it is told about the expansion; see `snippets.ts`.
 */
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

/** Presses Tab the way a keyboard does. */
const pressTab = (view: EditorView, shift = false): void => {
  pressKey(view, { key: 'Tab', code: 'Tab', shiftKey: shift })
}

/** Dispatches one keydown as a keyboard would. */
const pressKey = (view: EditorView, init: KeyboardEventInit): void => {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  )
}

const caret = (view: EditorView): { from: number; to: number } => {
  const { from, to } = view.state.selection.main
  return { from, to }
}

describe('Visual Mode snippets', () => {
  it('has the snippet library loaded, or the test proves nothing', () => {
    loadSnippets()
    expect(getSnippetEngine().getSnippets('latex').length).toBeGreaterThan(20)
    expect(settingsManager.getValue('snippets.enabled')).toBe(true)
    expect(settingsManager.getValue('snippets.autoExpand')).toBe(true)
  })

  it('expands the in-math `@a` trigger to \\alpha without leaving the trigger behind', async () => {
    const doc = 'Text $x$ here\n'
    const anchor = doc.indexOf('$x$') + 2
    const view = createView(doc, anchor)

    // Type inside the existing mathematics, so the engine's `i` (in-math)
    // condition is satisfied exactly as it is in the application.
    type(view, '@a')
    await settle()

    const text = view.state.doc.toString()
    expect(text, `the trigger survived the expansion: ${JSON.stringify(text)}`).not.toContain('@a')
    expect(text).toContain('\\alpha')
    // Exactly one `\alpha`, not `\aalpha` or `\alpha alpha`.
    expect(text.match(/\\alpha/g)?.length).toBe(1)
    // Nothing else about the line changed.
    expect(text.startsWith('Text $x')).toBe(true)
    expect(text.endsWith('$ here\n')).toBe(true)
    expect(text).toBe('Text $x\\alpha$ here\n')

    view.destroy()
  })

  it('expands a second trigger on a fresh document without state leaking', async () => {
    const doc = 'Text $y$ here\n'
    const anchor = doc.indexOf('$y$') + 2
    const view = createView(doc, anchor)

    type(view, '@b')

    await settle()

    expect(view.state.doc.toString()).toBe('Text $y\\beta$ here\n')

    view.destroy()
  })

  it('does not expand outside mathematics, where the `i` flag does not hold', async () => {
    const doc = 'Plain text here\n'
    const view = createView(doc, doc.indexOf('\n'))

    type(view, '@a')

    await settle()

    expect(view.state.doc.toString()).toBe('Plain text here@a\n')

    view.destroy()
  })

  it('expands the shipped `beg` with its default environment, not with its markup', async () => {
    // `beg` is `${1:equation}` twice over. The engine used to recognise only the
    // bare `$1` form, so the editor received the literal `${1:equation}` and had
    // no tab stop to type over; the placeholder is also a mirror, so both
    // occurrences have to carry the default.
    const doc = 'Text $ here\n'
    const view = createView(doc, doc.length)

    type(view, 'beg')

    await settle()

    const text = view.state.doc.toString()
    expect(text, `markup survived: ${JSON.stringify(text)}`).not.toContain('${1')
    expect(text).toBe('Text $ here\n\\begin{equation}\n\t\n\\end{equation}')
    view.destroy()
  })
})

describe('Visual Mode snippets: a snippet that declines is not an edit', () => {
  /** Every expansion the engine built, in order, for the length of one test. */
  const expansions: string[] = []

  const loadDeclining = (doc: string, anchor: number, content: string): EditorView => {
    const engine = getSnippetEngine()
    engine.clearStack()
    expansions.length = 0
    engine.setExpansionListener((_candidate, instance) => {
      expansions.push(instance.plainText)
    })
    engine.loadSnippetSources([{ name: 'test.hsnips', language: 'latex', content }])

    const parent = document.createElement('div')
    document.body.append(parent)

    const scope = createEditorScope({
      id: 'snippet-declining',
      filePath: 'D:/project/homework.tex',
      projectRoot: 'D:/project',
      text: doc,
      files: [{ path: 'D:/project/homework.tex' }],
      phrases: EUKOLIA_EDITOR_PHRASES,
    })

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor },
        extensions: [
          LaTeXLanguage,
          phrases(EUKOLIA_EDITOR_PHRASES),
          filePreview(() => null),
          snippetExtensions(),
        ],
      }),
    })
    forceParsing(view, doc.length, 5000)
    return view
  }

  /**
   * The shape `evil_text` and `evil_math` have: a body that hands back the text it
   * was given. `preserveFiberedInput` appends `$0` to the match, so the expansion's
   * plain text is exactly the range it matched.
   */
  const DECLINING = 'snippet `zz` A\n``rv = m[0] + "$0";``\nendsnippet\n'

  it('leaves the document object untouched when the body reproduces its match', async () => {
    // A fresh line, so the trigger is at the line start where the default boundary
    // accepts it and there is no doubt about whether it fired.
    const view = loadDeclining('x\n', 2, DECLINING)
    type(view, 'zz')
    const afterKeystroke = view.state.doc
    expect(afterKeystroke.toString()).toBe('x\nzz')

    /*
     * The trigger matched, the body handed back exactly what it matched, and the
     * document stays the object it was.
     *
     * A declining snippet used to be dispatched as a replacement of the range it
     * came from, with the identical text in it. That is invisible in the document but
     * not in the editor: CodeMirror reports the transaction as a change, so every
     * decoration in the file is rebuilt, the project index is re-run and the analyser
     * is re-armed — a second time for one keystroke, because the character typed had
     * already changed the document once.
     *
     * This is not a corner case: through the real engine, on the real library, typing
     * a space in text mode matches `evil_text` and is declined for every ordinary
     * word (`hello world ` comes back as ` world `), so the wasted second rebuild
     * happened once per word typed. Comparing the `Text` object is how the rest of
     * this module asks "did anything change", and CodeMirror's documents are
     * persistent, so an unchanged document is the same object.
     */
    await settle()
    expect(expansions).toEqual(['zz'])
    expect(view.state.doc).toBe(afterKeystroke)

    getSnippetEngine().setExpansionListener(null)
    view.destroy()
  })

  it('still dispatches a snippet that changes the text', async () => {
    const view = loadDeclining('x\n', 2, ['snippet `zz` A', '\\alpha', 'endsnippet', ''].join('\n'))
    type(view, 'zz')
    await settle()

    expect(expansions).toEqual(['\\alpha'])
    expect(view.state.doc.toString()).toBe('x\n\\alpha')

    getSnippetEngine().setExpansionListener(null)
    view.destroy()
  })
})

describe('Visual Mode snippets: Tab walks the tab stops', () => {
  /** A view whose snippet library is exactly the sources given. */
  const createViewWith = (
    doc: string,
    anchor: number,
    sources: Array<{ name: string; content: string }>
  ): EditorView => {
    const engine = getSnippetEngine()
    // A stale expansion left behind by an earlier test is still what
    // `activeExpansion` answers with, and Tab would then move a tab stop in a
    // snippet that is no longer on screen.
    engine.clearStack()
    engine.loadSnippetSources(sources.map(source => ({ ...source, language: 'latex' })))

    const parent = document.createElement('div')
    document.body.append(parent)

    const scope = createEditorScope({
      id: 'snippet-tabs',
      filePath: 'D:/project/homework.tex',
      projectRoot: 'D:/project',
      text: doc,
      files: [{ path: 'D:/project/homework.tex' }],
      phrases: EUKOLIA_EDITOR_PHRASES,
    })

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor },
        extensions: [
          LaTeXLanguage,
          phrases(EUKOLIA_EDITOR_PHRASES),
          filePreview(() => null),
          snippetExtensions(),
        ],
      }),
    })
    forceParsing(view, doc.length, 5000)
    return view
  }

  it('walks one placeholder and finishes on $0', async () => {
    // The shape the report named: a space placeholder followed by the final
    // cursor, written the way a `.hsnips` file spells the literal dollars.
    const body = 'body \\$${1: }\\$ $0'
    const view = createViewWith('Text here\n', 'Text here\n'.length, [
      { name: 'one.hsnips', content: `snippet ONEPLACE "one" A\n${body}\nendsnippet\n` },
    ])

    type(view, 'ONEPLACE')
    await settle()

    const document = view.state.doc.toString()
    expect(document).toBe('Text here\nbody $ $ ')
    // The placeholder is selected over its own text — the space — so the author
    // types straight over it.
    expect(view.state.sliceDoc(caret(view).from, caret(view).to)).toBe(' ')

    type(view, 'X')
    await settle()
    expect(view.state.doc.toString()).toBe('Text here\nbody $X$ ')

    pressTab(view)
    // `$0` is the end of the snippet, and Tab has to put the caret there: the
    // expansion is finished, so nothing else will.
    expect(caret(view)).toEqual({ from: view.state.doc.length, to: view.state.doc.length })
    expect(getSnippetEngine().stackDepth).toBe(0)

    view.destroy()
  })

  it('walks with the key the setting names, and follows a change to it', async () => {
    const view = createViewWith('Text here\n', 'Text here\n'.length, [
      { name: 'two.hsnips', content: 'snippet TWOEDIT "two" A\nA ${1:one} B ${2:two} C $0\nendsnippet\n' },
    ])

    type(view, 'TWOEDIT')
    await settle()

    const document = view.state.doc.toString()
    const offsetOf = (needle: string): number => document.indexOf(needle)
    expect(caret(view)).toEqual({ from: offsetOf('one'), to: offsetOf('one') + 3 })

    // `snippets.tabStopKey` is the key the walk is bound to. A key binding is part
    // of an extension, so the change has to reconfigure the live editor rather than
    // wait for the next one.
    settingsManager.setValue('snippets.tabStopKey', 'Ctrl-Enter')
    try {
      pressKey(view, { key: 'Enter', ctrlKey: true })
      expect(caret(view), 'the configured key did not walk the tab stops').toEqual({
        from: offsetOf('two'),
        to: offsetOf('two') + 3,
      })

      // ...and Tab is no longer the walk key, so it leaves the caret alone.
      pressTab(view)
      expect(caret(view)).toEqual({ from: offsetOf('two'), to: offsetOf('two') + 3 })
    } finally {
      settingsManager.setValue('snippets.tabStopKey', 'Tab')
    }

    // Back on `Tab`, the same editor walks again.
    pressTab(view)
    expect(caret(view)).toEqual({ from: document.length, to: document.length })

    view.destroy()
  })

  it('walks two placeholders in order and finishes on $0', async () => {
    const view = createViewWith('Text here\n', 'Text here\n'.length, [
      { name: 'two.hsnips', content: 'snippet TWOEDIT "two" A\nA ${1:one} B ${2:two} C $0\nendsnippet\n' },
    ])

    type(view, 'TWOEDIT')
    await settle()

    const document = view.state.doc.toString()
    expect(document).toBe('Text here\nA one B two C ')
    const offsetOf = (needle: string): number => document.indexOf(needle)
    expect(caret(view)).toEqual({ from: offsetOf('one'), to: offsetOf('one') + 3 })

    pressTab(view)
    expect(caret(view)).toEqual({ from: offsetOf('two'), to: offsetOf('two') + 3 })

    // Filling the second placeholder moves nothing before it, and the tab stops
    // after it have to move with what was typed — this is the drift that used to
    // leave Tab pointing at a position the expansion no longer occupied.
    type(view, 'XX')
    await settle()
    const typedDocument = view.state.doc.toString()
    expect(typedDocument).toBe('Text here\nA one B XX C ')

    pressTab(view)
    expect(caret(view)).toEqual({ from: typedDocument.length, to: typedDocument.length })
    expect(getSnippetEngine().stackDepth).toBe(0)

    view.destroy()
  })

  it('walks nested placeholder ${1:($2)} in order and finishes', async () => {
    const view = createViewWith('Text here\n', 'Text here\n'.length, [
      { name: 'nest.hsnips', content: 'snippet NEST "nest" A\n\\sin ${1:($2)}\\$ \nendsnippet\n' },
    ])

    type(view, 'NEST')
    await settle()

    const document = view.state.doc.toString()
    expect(document).toBe('Text here\n\\sin ()$ ')
    const offsetOf = (needle: string): number => document.indexOf(needle)
    // $1 is selected over '()'
    expect(caret(view)).toEqual({ from: offsetOf('()'), to: offsetOf('()') + 2 })

    // Tab -> $2 inside '(' and ')'
    pressTab(view)
    expect(caret(view)).toEqual({ from: offsetOf('()') + 1, to: offsetOf('()') + 1 })

    // Type 'x' into $2
    type(view, 'x')
    await settle()
    const typedDoc = view.state.doc.toString()
    expect(typedDoc).toBe('Text here\n\\sin (x)$ ')

    // Tab -> exit to end
    pressTab(view)
    expect(caret(view)).toEqual({ from: typedDoc.length, to: typedDoc.length })
    expect(getSnippetEngine().stackDepth).toBe(0)

    view.destroy()
  })

  it('walks nested sum snippet \\sum ${1:_{$2\\}${3:^{$4\\}}}$0 in live view', async () => {
    const view = createViewWith('$  $', 2, [
      { name: 'sum.hsnips', content: 'snippet sum "sum" Am\n\\sum ${1:_{$2\\}${3:^{$4\\}}}$0\nendsnippet\n' },
    ])

    type(view, 'sum')
    await settle()

    const doc1 = view.state.doc.toString()
    expect(doc1).toBe('$ \\sum _{}^{} $')
    expect(view.state.sliceDoc(caret(view).from, caret(view).to)).toBe('_{}^{}')

    // Tab -> inside subscript ($2)
    pressTab(view)
    expect(caret(view)).toEqual({ from: 9, to: 9 })

    type(view, 'i=1')
    await settle()
    expect(view.state.doc.toString()).toBe('$ \\sum _{i=1}^{} $')

    // Tab -> superscript ($3: ^{})
    pressTab(view)
    expect(view.state.sliceDoc(caret(view).from, caret(view).to)).toBe('^{}')

    // Tab -> inside superscript ($4)
    pressTab(view)
    expect(caret(view)).toEqual({ from: 15, to: 15 })

    type(view, 'n')
    await settle()
    expect(view.state.doc.toString()).toBe('$ \\sum _{i=1}^{n} $')

    // Tab -> exit to end ($0)
    pressTab(view)
    expect(caret(view)).toEqual({ from: 17, to: 17 })
    expect(getSnippetEngine().stackDepth).toBe(0)

    view.destroy()
  })

  it('leaves the caret on the $0 the body names, not on the group it replaced', async () => {
    // The reported case: the trigger's capture group is written into the body, so
    // the `$1` it fills in is not a tab stop — it is gone from the body by the time
    // the body is read for placeholders. The parts used to be built *before* that
    // substitution, so the `$1` survived as an empty stop and the caret started on
    // it, in the middle of the inserted text, instead of at the `$0` at the end.
    const doc = '$   $ ;'
    const view = createViewWith(doc, doc.length, [
      { name: 'spacing.hsnips', content: 'snippet `(\\s*)\\$(\\s*);;` "spacing" Ai\n ``rv = m[1]``\\$ $0\nendsnippet\n' },
    ])

    type(view, ';')
    await settle()

    const text = view.state.doc.toString()
    // `   $ ;;` is replaced by ` ` + the matched whitespace + `\$` + ` `.
    expect(text, `text: ${JSON.stringify(text)}`).toBe('$    $ ')
    // `$0` is the last thing in the body, so that is where the caret belongs.
    expect(caret(view)).toEqual({ from: text.length, to: text.length })
    // Nothing is left on the tab-stop stack: the snippet has no stop but `$0`.
    expect(getSnippetEngine().stackDepth).toBe(0)

    view.destroy()
  })

  it('walks back through the tab stops with Shift-Tab', async () => {
    const view = createViewWith('Text here\n', 'Text here\n'.length, [
      { name: 'two.hsnips', content: 'snippet BACKWARDS "back" A\nA ${1:one} B ${2:two} C $0\nendsnippet\n' },
    ])

    type(view, 'BACKWARDS')
    await settle()

    const document = view.state.doc.toString()
    pressTab(view)
    expect(caret(view)).toEqual({ from: document.indexOf('two'), to: document.indexOf('two') + 3 })

    pressTab(view, true)
    expect(caret(view)).toEqual({ from: document.indexOf('one'), to: document.indexOf('one') + 3 })

    view.destroy()
  })
})

describe('Visual Mode snippets: the full extension set', () => {
  /**
   * The application mounts the whole Overleaf extension set — auto-pair, the
   * completion engine, the visual decorations — not just the snippet extension.
   * Snippet expansion has to survive sharing the update cycle with all of them,
   * which is what this mounts.
   */
  const createFullView = async (doc: string, anchor: number) => {
    loadSnippets()

    const { eukoliaEditorExtensions } = await import('@/visual/editorExtensions')
    const { setEditable } = await import('@vendor/overleaf/extensions/editable')

    const scope = createEditorScope({
      id: 'snippets-full',
      filePath: 'D:/project/homework.tex',
      projectRoot: 'D:/project',
      text: doc,
      files: [{ path: 'D:/project/homework.tex' }],
      phrases: EUKOLIA_EDITOR_PHRASES,
    })

    const parent = document.createElement('div')
    document.body.append(parent)

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor },
        extensions: eukoliaEditorExtensions({
          scope,
          fileName: 'homework.tex',
          theme: 'light',
          startVisual: true,
        }),
      }),
    })
    view.dispatch(setEditable(true))
    forceParsing(view, doc.length, 5000)
    return view
  }

  it('expands `@a` between the two `$` of an auto-paired pair', async () => {
    // The application's auto-pair turns a typed `$` into `$$` with the caret
    // between them, so the trigger is followed by a closing delimiter. This is
    // the shape the smoke probe types, and it is the shape that used to come out
    // as `$\aalpha` instead of `$\alpha$`.
    const doc = 'Text $$ here\n'
    const anchor = doc.indexOf('$$') + 1
    const view = await createFullView(doc, anchor)

    type(view, '@a')

    await settle()

    const text = view.state.doc.toString()
    console.log('PAIRED-DELIMITER RESULT:', JSON.stringify(text))
    expect(text, `text mangled: ${JSON.stringify(text)}`).toBe('Text $\\alpha$ here\n')

    view.destroy()
  })

  it('expands `@a` when the closing `$` is typed after the trigger', async () => {
    // The other ordering: the author writes the trigger first and closes the
    // mathematics afterwards. Each keystroke is a separate task, as a real
    // keyboard produces them, so the expansion lands before the `$` arrives.
    const doc = 'Text $ here\n'
    const anchor = doc.indexOf('$') + 1
    const view = await createFullView(doc, anchor)

    type(view, '@a')

    await settle()

    type(view, '$')

    await settle()

    const text = view.state.doc.toString()
    console.log('CLOSE-AFTER RESULT:', JSON.stringify(text))
    expect(text).toContain('\\alpha')
    expect(text).not.toContain('@a')

    view.destroy()
  })

  it('expands `@a` inside existing mathematics with every extension mounted', async () => {
    const doc = 'Text $x$ here\n'
    const anchor = doc.indexOf('$x$') + 2
    const view = await createFullView(doc, anchor)

    type(view, '@a')

    await settle()

    const text = view.state.doc.toString()
    expect(text, `trigger left behind or text mangled: ${JSON.stringify(text)}`).not.toContain('@a')
    expect(text).toBe('Text $x\\alpha$ here\n')

    view.destroy()
  })

  it('expands `@a` inside a freshly typed `$` pair', async () => {
    // This is the path the smoke probe exercises: type `$` (auto-paired to `$$`),
    // then the trigger. The auto-paired delimiters must not corrupt the expansion.
    const doc = 'Text here\n'
    const view = await createFullView(doc, doc.indexOf('\n'))

    type(view, '$')

    await settle()
    type(view, '@a')
    await settle()

    const text = view.state.doc.toString()
    console.log('FULL-SET RESULT:', JSON.stringify(text))
    expect(text, `text mangled: ${JSON.stringify(text)}`).not.toContain('@a')
    expect(text.match(/\\alpha/g)?.length).toBe(1)

    view.destroy()
  })
})

/**
 * `expand: "manual"` is the format's default, and the completion list is the only
 * place such an entry can be reached from — it never fires while typing. These
 * drive the completion source directly rather than through the popup: what the
 * list offers and what accepting an entry does are this module's business, and a
 * test that waits for a popup would be testing CodeMirror's autocompletion.
 */
describe('Visual Mode snippet completion', () => {
  /** Loads exactly these header/body blocks, and nothing else. */
  const loadLibrary = (lines: string[]): void => {
    getSnippetEngine().loadSnippetSources([
      { name: 'completion-test.hsnips', language: 'latex', content: [...lines, ''].join('\n') },
    ])
  }

  const sourceAt = (view: EditorView, explicit = false) =>
    snippetCompletionSource(
      new CompletionContext(view.state, view.state.selection.main.head, explicit)
    )

  it('expands the manual entry the list accepted, onto its first tab stop', () => {
    const doc = 'Text $x$ \n'
    const view = createView(doc, doc.indexOf('\n'))
    loadLibrary([
      'snippet `@a` "alpha" A',
      'zz$0',
      'endsnippet',
      '',
      'snippet `mm` "manual one"',
      '\\mathrm{MANUAL{$1}}$0',
      'endsnippet',
    ])

    // Typing the trigger does nothing: it is manual.
    type(view, 'mm')
    expect(view.state.doc.toString()).toBe('Text $x$ mm\n')

    const result = sourceAt(view)
    expect(result, 'nothing was offered for a typed trigger').not.toBeNull()
    const option = result?.options.find(candidate => candidate.label === 'mm')
    expect(option, `offered: ${result?.options.map(o => o.label).join(', ')}`).toBeDefined()

    option?.apply?.(view, option, result?.from ?? 0, result?.to ?? 0)

    const text = view.state.doc.toString()
    // The trigger is replaced whole rather than left in front of the expansion.
    expect(text, `text: ${JSON.stringify(text)}`).toBe('Text $x$ \\mathrm{MANUAL{}}\n')
    // The caret is on the snippet's first tab stop, which is the empty `$1`
    // between the braces — not after the inserted text.
    expect(view.state.selection.main.head).toBe(text.indexOf('{}') + 1)

    loadSnippets()
    view.destroy()
  })

  it('stays quiet for the document an insertion produced, and answers an explicit request', async () => {
    const doc = 'Text $x$ \n'
    const view = createView(doc, doc.indexOf('\n'))
    loadLibrary([
      // Expands to the other entry's trigger, so the caret ends up at the end of
      // a word the list would otherwise offer — the state an insertion leaves.
      'snippet `@a` "alpha" A',
      'zz$0',
      'endsnippet',
      '',
      'snippet `zz` "manual one"',
      'ZED$0',
      'endsnippet',
    ])

    type(view, '@a')
    await settle()
    expect(view.state.doc.toString()).toBe('Text $x$ zz\n')

    expect(sourceAt(view), 'the list re-offered what it had just inserted').toBeNull()
    const explicit = sourceAt(view, true)
    expect(explicit?.options.map(option => option.label), 'an explicit request was dropped').toContain('zz')

    // The same text, reached by typing rather than by inserting: the suppression
    // is about the document the insertion produced, and this is a different one.
    type(view, 'x')
    view.dispatch({
      changes: { from: view.state.selection.main.head - 1, to: view.state.selection.main.head },
      userEvent: 'delete.backward',
    })
    expect(view.state.doc.toString()).toBe('Text $x$ zz\n')
    expect(sourceAt(view), 'a typed document was treated as an inserted one').not.toBeNull()

    loadSnippets()
    view.destroy()
  })

  it('runs snippet ws6qtr from user snippets.json in live CodeMirror view', async () => {
    const fs = await import('fs')
    const userSnippetsPath = 'C:/Users/Yinji/AppData/Roaming/Eukolia/User/snippets/snippets.json'
    const raw = fs.readFileSync(userSnippetsPath, 'utf8')
    const { parseSnippetFileText, normalizeSnippetFile, loadEusnipsIntoEngine } = await import('@/snippets/eusnips')
    const parsed = parseSnippetFileText(raw)
    const normalized = normalizeSnippetFile(parsed.file!)

    const engine = getSnippetEngine()
    engine.clearStack()
    const loadedList = loadEusnipsIntoEngine(engine, [normalized])
    const normWs = normalized.snippets.find(s => s.id === 'ws6qtr')
    const loadedWs = loadedList.find(s => s.id === 'ws6qtr')

    const parent = document.createElement('div')
    document.body.append(parent)

    const doc = 'Text here '
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [
          LaTeXLanguage,
          phrases(EUKOLIA_EDITOR_PHRASES),
          filePreview(() => null),
          snippetExtensions(),
        ],
      }),
    })
    forceParsing(view, doc.length, 5000)

    const ws = engine.getSnippets('latex').find(s => s.description === 'rm functions')

    // Type 'sin ' to trigger ws6qtr
    type(view, 'sin ')
    await settle()

    // Expansion should place selection on $1 '()'
    const textAfter = view.state.doc.toString()
    expect(textAfter).toContain('sin ()')
    const parenIndex = textAfter.indexOf('()')
    expect(caret(view)).toEqual({ from: parenIndex, to: parenIndex + 2 })
    expect(engine.stackDepth).toBe(1)

    // Press Tab -> cursor moves inside '()' to $2
    pressTab(view)
    expect(caret(view)).toEqual({ from: parenIndex + 1, to: parenIndex + 1 })
    expect(engine.activeExpansion?.selectedPlaceholder).toBe(2)

    // Type inside $2
    type(view, 'x')
    await settle()

    // Press Tab -> walks to end ($0)
    pressTab(view)
    expect(caret(view)).toEqual({ from: view.state.doc.length, to: view.state.doc.length })
    expect(engine.stackDepth).toBe(0)

    loadSnippets()
    view.destroy()
  })

  describe('Snippet expansion key settings', () => {
    it('registers expandOnEnter and expandOnTab in Snippets category with correct defaults', () => {
      const enterDesc = settingsManager.getDescriptor('snippets.expandOnEnter')
      const tabDesc = settingsManager.getDescriptor('snippets.expandOnTab')

      expect(enterDesc).toBeDefined()
      expect(enterDesc?.category).toBe('Snippets')
      expect(enterDesc?.type).toBe('boolean')
      expect(enterDesc?.default).toBe(true)

      expect(tabDesc).toBeDefined()
      expect(tabDesc?.category).toBe('Snippets')
      expect(tabDesc?.type).toBe('boolean')
      expect(tabDesc?.default).toBe(false)

      expect(setting.bool('snippets.expandOnEnter')).toBe(true)
      expect(setting.bool('snippets.expandOnTab')).toBe(false)
    })

    it('does not expand manual snippet on Tab when expandOnTab is false (default)', async () => {
      settingsManager.setValue('snippets.expandOnTab', false)
      const engine = getSnippetEngine()
      engine.clearStack()
      engine.loadSnippetSources([
        {
          name: 'manual.hsnips',
          content: 'snippet mk "math" w\n$${1}$${0}\nendsnippet\n',
          language: 'latex',
        },
      ])

      const parent = document.createElement('div')
      document.body.append(parent)
      const doc = 'Hello '
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc,
          selection: { anchor: doc.length },
          extensions: [
            LaTeXLanguage,
            phrases(EUKOLIA_EDITOR_PHRASES),
            filePreview(() => null),
            snippetExtensions(),
          ],
        }),
      })
      forceParsing(view, doc.length, 5000)

      type(view, 'mk')
      await settle()
      expect(view.state.doc.toString()).toBe('Hello mk')

      // Press Tab with expandOnTab: false
      pressTab(view)
      await settle()

      // Snippet should NOT expand
      expect(view.state.doc.toString()).toBe('Hello mk')
      expect(engine.stackDepth).toBe(0)

      loadSnippets()
      view.destroy()
    })

    it('expands manual snippet on Tab when expandOnTab is true', async () => {
      settingsManager.setValue('snippets.expandOnTab', true)
      const engine = getSnippetEngine()
      engine.clearStack()
      engine.loadSnippetSources([
        {
          name: 'manual.hsnips',
          content: 'snippet mk "math" w\n$${1}$${0}\nendsnippet\n',
          language: 'latex',
        },
      ])

      const parent = document.createElement('div')
      document.body.append(parent)
      const doc = 'Hello '
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc,
          selection: { anchor: doc.length },
          extensions: [
            LaTeXLanguage,
            phrases(EUKOLIA_EDITOR_PHRASES),
            filePreview(() => null),
            snippetExtensions(),
          ],
        }),
      })
      forceParsing(view, doc.length, 5000)

      type(view, 'mk')
      await settle()
      expect(view.state.doc.toString()).toBe('Hello mk')

      // Press Tab with expandOnTab: true
      pressTab(view)
      await settle()

      // Snippet SHOULD expand to $$ with cursor in placeholder $1
      expect(view.state.doc.toString()).toBe('Hello $$')
      expect(engine.stackDepth).toBe(1)
      expect(caret(view)).toEqual({ from: 'Hello $'.length, to: 'Hello $'.length })

      // Tab navigates placeholder
      type(view, 'x')
      await settle()
      pressTab(view)
      await settle()
      expect(view.state.doc.toString()).toBe('Hello $x$')
      expect(engine.stackDepth).toBe(0)

      // Reset settings & reload snippets
      settingsManager.setValue('snippets.expandOnTab', false)
      loadSnippets()
      view.destroy()
    })

    it('expandMatchingSnippet returns false when trigger does not match or engine disabled', () => {
      const parent = document.createElement('div')
      document.body.append(parent)
      const doc = 'plain text'
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc,
          selection: { anchor: doc.length },
          extensions: [snippetExtensions()],
        }),
      })

      // No trigger matches
      expect(expandMatchingSnippet(view)).toBe(false)

      view.destroy()
    })

    it('respects expandOnEnter setting when accepting completion', async () => {
      const { autoComplete } = await import('@/vendor/overleaf/extensions/auto-complete')
      const { startCompletion, completionStatus } = await import('@codemirror/autocomplete')

      settingsManager.setValue('snippets.expandOnEnter', true)

      const parent = document.createElement('div')
      document.body.append(parent)
      const doc = 'Text \\al'
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc,
          selection: { anchor: doc.length },
          extensions: [
            autoComplete({ enabled: true }),
            autocompletion({
              override: [
                () => ({
                  from: 5,
                  options: [{ label: '\\alpha', type: 'keyword' }],
                }),
              ],
            }),
          ],
        }),
      })

      startCompletion(view)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(completionStatus(view.state)).toBe('active')

      // With expandOnEnter: false, Enter should NOT accept
      settingsManager.setValue('snippets.expandOnEnter', false)
      pressKey(view, { key: 'Enter', code: 'Enter' })
      await settle()
      expect(view.state.doc.toString()).toBe('Text \\al')

      // With expandOnEnter: true, Enter SHOULD accept
      settingsManager.setValue('snippets.expandOnEnter', true)
      pressKey(view, { key: 'Enter', code: 'Enter' })
      await settle()
      expect(view.state.doc.toString()).toBe('Text \\alpha')

      view.destroy()
    })

    it('respects expandOnTab setting when accepting completion', async () => {
      const { autoComplete } = await import('@/vendor/overleaf/extensions/auto-complete')
      const { startCompletion, completionStatus } = await import('@codemirror/autocomplete')

      settingsManager.setValue('snippets.expandOnTab', false)

      const parent = document.createElement('div')
      document.body.append(parent)
      const doc = 'Text \\be'
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc,
          selection: { anchor: doc.length },
          extensions: [
            autoComplete({ enabled: true }),
            autocompletion({
              override: [
                () => ({
                  from: 5,
                  options: [{ label: '\\beta', type: 'keyword' }],
                }),
              ],
            }),
          ],
        }),
      })

      startCompletion(view)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(completionStatus(view.state)).toBe('active')

      // With expandOnTab: false (default), Tab should NOT accept completion
      pressTab(view)
      await settle()
      expect(view.state.doc.toString()).toBe('Text \\be')

      // With expandOnTab: true, Tab SHOULD accept completion
      settingsManager.setValue('snippets.expandOnTab', true)
      pressTab(view)
      await settle()
      expect(view.state.doc.toString()).toBe('Text \\beta')

      // Reset
      settingsManager.setValue('snippets.expandOnTab', false)
      view.destroy()
    })
  })

  describe('Tab jumps immediately outside math block when there is no tab holder', () => {
    it('jumps immediately after closing $ from inside inline math', async () => {
      const doc = 'See $x^2$ here'
      const pos = doc.indexOf('x')
      const view = createView(doc, pos)

      pressTab(view)
      await settle()

      expect(view.state.selection.main.head).toBe(doc.indexOf('$x^2$') + '$x^2$'.length)
      view.destroy()
    })

    it('jumps immediately after closing \\] from inside display math', async () => {
      const doc = 'Text \\[\n  a + b\n\\] more'
      const pos = doc.indexOf('+')
      const view = createView(doc, pos)

      pressTab(view)
      await settle()

      expect(view.state.selection.main.head).toBe(doc.indexOf('\\]') + 2)
      view.destroy()
    })

    it('jumps immediately after \\end{equation} from inside equation environment', async () => {
      const doc = 'Text \\begin{equation}\n  E = mc^2\n\\end{equation}\nAfter'
      const pos = doc.indexOf('mc^2')
      const view = createView(doc, pos)

      pressTab(view)
      await settle()

      expect(view.state.selection.main.head).toBe(doc.indexOf('\\end{equation}') + '\\end{equation}'.length)
      view.destroy()
    })

    it('walks snippet tab stops first and jumps outside math block on the final Tab', async () => {
      const doc = '$'
      const view = createView(doc, 1)

      type(view, 'ff')
      await settle()

      // ff is \frac{$1}{$2}$0. $1 is selected.
      expect(view.state.doc.toString()).toBe('$\\frac{}{}')
      type(view, '1')
      await settle()
      expect(view.state.doc.toString()).toBe('$\\frac{1}{}')

      // Tab -> moves to $2
      pressTab(view)
      await settle()
      type(view, '2')
      await settle()
      expect(view.state.doc.toString()).toBe('$\\frac{1}{2}')

      // Tab -> moves to $0 (after \frac{1}{2})
      pressTab(view)
      await settle()

      // Type closing $
      type(view, '$')
      await settle()
      expect(view.state.doc.toString()).toBe('$\\frac{1}{2}$')

      // Place cursor before closing $
      view.dispatch({ selection: { anchor: view.state.doc.toString().length - 1 } })

      // Tab -> no tab holders remain, so jumps immediately outside math block!
      pressTab(view)
      await settle()
      expect(view.state.selection.main.head).toBe(view.state.doc.toString().length)

      view.destroy()
    })

    it('does not jump when cursor is outside math block', async () => {
      const doc = 'Hello world'
      const view = createView(doc, 5)

      pressTab(view)
      await settle()

      expect(view.state.selection.main.head).not.toBe(doc.length)
      view.destroy()
    })

    it('does not jump when selection is non-empty inside math block', async () => {
      const doc = 'See $x^2$ here'
      const start = doc.indexOf('x')
      const end = doc.indexOf('2') + 1
      const view = createView(doc, start)
      view.dispatch({ selection: { anchor: start, head: end } })

      pressTab(view)
      await settle()

      expect(view.state.selection.main.head).not.toBe(doc.indexOf('$x^2$') + '$x^2$'.length)
      view.destroy()
    })

    it('steps out of nested math blocks level-by-level on consecutive Tabs', async () => {
      const doc = 'Text \\begin{equation}\n  \\begin{pmatrix}\n    a & b \\\\\n    c & d\n  \\end{pmatrix}\n\\end{equation}\nAfter'
      const pos = doc.indexOf('d')
      const view = createView(doc, pos)

      // First Tab -> jumps immediately outside of pmatrix
      pressTab(view)
      await settle()
      expect(view.state.selection.main.head).toBe(doc.indexOf('\\end{pmatrix}') + '\\end{pmatrix}'.length)

      // Second Tab -> jumps immediately outside of equation
      pressTab(view)
      await settle()
      expect(view.state.selection.main.head).toBe(doc.indexOf('\\end{equation}') + '\\end{equation}'.length)

      view.destroy()
    })
  })
})


