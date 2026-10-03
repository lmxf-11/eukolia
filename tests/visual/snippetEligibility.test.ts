// @vitest-environment jsdom
/**
 * Where a snippet is allowed to fire.
 *
 * A snippet library is written in LaTeX notation — `ff` is `\frac{}{}`, `mk` is
 * `$$`, a body carries tab stops and may call into math mode — so the documents
 * it applies to are LaTeX and Markdown, and nothing else. Before this, the
 * snippet extension set was mounted for every LaTeX *source* (the `.tex`, `.ltx`,
 * `.sty`, `.cls` set Visual Mode claims) and never for anything else, which left
 * two holes: a Markdown file could not use a snippet at all, and no other
 * document said "no snippets" in a way that cleared an expansion left over from
 * the file before it.
 *
 * These tests mount the real extension set for three different file names, so
 * what is asserted is the decision the application makes rather than the
 * predicate alone.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { createEditorScope, EUKOLIA_EDITOR_PHRASES } from '@/visual/scope'
import {
  SNIPPET_FILE_EXTENSIONS,
  isVisualModeFile,
  supportsSnippets,
} from '@/visual/editorExtensions'
import { getSnippetEngine } from '@/snippets/engine'
import { defaultSnippetSources } from '@/snippets/defaultSnippets'
import { setting, settingsManager } from '@/core/settings'

/** The trigger every document in this file is asked to expand. */
const TRIGGER = 'XY'
const EXPANSION = 'ZZ'

/**
 * A snippet that expands anywhere, so a document's answer to "may snippets run
 * here?" is the only thing that can decide whether it fires.
 */
const autoSnippet = [
  'snippet `XY` "snippet eligibility probe" A',
  `${EXPANSION}$0`,
  'endsnippet',
  '',
].join('\n')

let view: EditorView | null = null

/**
 * Loads the built-in library plus the probe snippet.
 *
 * The built-ins are loaded too, deliberately: `supportsSnippets` is a
 * document-level decision, and a test that loaded only the probe would pass for
 * a document whose library is empty rather than for one whose snippets are
 * switched off.
 */
const loadLibrary = (): void => {
  getSnippetEngine().loadSnippetSources([
    ...defaultSnippetSources(),
    { name: 'eligibility.hsnips', content: autoSnippet, language: 'latex' },
  ])
}

/** Mounts the real extension set for one file name. */
const mount = async (fileName: string, doc: string): Promise<EditorView> => {
  const { eukoliaEditorExtensions } = await import('@/visual/editorExtensions')
  loadLibrary()

  const scope = createEditorScope({
    id: `snippet-eligibility:${fileName}`,
    filePath: `D:/project/${fileName}`,
    projectRoot: 'D:/project',
    text: doc,
    files: [{ path: `D:/project/${fileName}` }],
    phrases: EUKOLIA_EDITOR_PHRASES,
  })

  const parent = document.createElement('div')
  document.body.append(parent)

  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: eukoliaEditorExtensions({
        scope,
        fileName,
        theme: 'light',
        startVisual: false,
      }),
    }),
  })
  return view
}

/** Types `text` one character at a time, the way a keyboard does. */
const type = (target: EditorView, text: string): void => {
  for (const character of text) {
    const { from, to } = target.state.selection.main
    target.dispatch({
      changes: { from, to, insert: character },
      selection: { anchor: from + character.length },
      userEvent: 'input.type',
    })
  }
}

/** Expansion is deferred by one microtask; see `visual/snippets.ts`. */
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  view?.destroy()
  view = null
  getSnippetEngine().clearStack()
  document.body.innerHTML = ''
  settingsManager.setValue('snippets.enabled', true)
  settingsManager.setValue('snippets.autoExpand', true)
})

describe('which documents snippets apply to', () => {
  it('claims LaTeX and Markdown, and nothing else', () => {
    for (const name of [
      'homework.tex',
      'chapter.md',
      'notes.markdown',
      'readme.mdown',
      'draft.mkdn',
    ]) {
      expect(supportsSnippets(name), `${name} should expand snippets`).toBe(true)
    }
    for (const name of [
      'refs.bib',
      'package.json',
      'analysis.py',
      'main.js',
      'build.log',
      'data.csv',
      'notes.txt',
    ]) {
      expect(supportsSnippets(name), `${name} must not expand snippets`).toBe(false)
    }
  })

  it('treats a buffer with no extension as a LaTeX buffer, the same way the editor does', () => {
    // Eukolia has no second answer for "which language is this?": an untitled
    // buffer and a file with no extension are LaTeX buffers everywhere else
    // (`isVisualModeFile`, `languageIdFor`, the syntax highlighter), so a snippet
    // applies to them for the same reason and by the same rule.
    for (const name of [null, '', 'untitled', 'Makefile']) {
      expect(supportsSnippets(name), `${String(name)} is a LaTeX buffer here`).toBe(true)
      expect(supportsSnippets(name)).toBe(isVisualModeFile(name))
    }
  })

  it('covers every extension the editor claims as a LaTeX source', () => {
    // A LaTeX file whose snippets were dropped by a narrower list would be the
    // visible half of this bug, so the two sets are pinned against each other.
    for (const name of ['a.tex', 'b.ltx', 'c.sty', 'd.cls']) {
      expect(isVisualModeFile(name)).toBe(true)
      expect(supportsSnippets(name), `${name}: a LaTeX source lost its snippets`).toBe(true)
    }
    expect(new Set(SNIPPET_FILE_EXTENSIONS).size).toBe(SNIPPET_FILE_EXTENSIONS.length)
  })
})

describe('the editor mounts snippets for the documents they apply to', () => {
  it('expands a trigger in a Markdown document', async () => {
    const mounted = await mount('notes.md', '# Notes\n\n')
    type(mounted, TRIGGER)
    await settle()

    expect(mounted.state.doc.toString()).toBe(`# Notes\n\n${EXPANSION}`)
  })

  it('expands a trigger in a LaTeX document', async () => {
    const mounted = await mount('homework.tex', 'Text here\n')
    type(mounted, TRIGGER)
    await settle()

    expect(mounted.state.doc.toString()).toBe(`Text here\n${EXPANSION}`)
  })

  it('expands no trigger in any other document', async () => {
    for (const name of ['refs.bib', 'package.json', 'analysis.py', 'notes.txt']) {
      const mounted = await mount(name, 'x = 1\n')
      type(mounted, TRIGGER)
      await settle()

      expect(
        mounted.state.doc.toString(),
        `${name}: the trigger was expanded in a document snippets do not apply to`
      ).toBe(`x = 1\n${TRIGGER}`)
      expect(getSnippetEngine().stackDepth, `${name}: a snippet was left on the stack`).toBe(0)

      mounted.destroy()
      view = null
      document.body.innerHTML = ''
    }
  })

  it('still obeys the snippet settings where they do apply', async () => {
    // The mount is the document's answer; the settings are the user's. A
    // document that may expand snippets still must not when the engine is off.
    const mounted = await mount('homework.tex', 'Text here\n')
    setting.bool('snippets.enabled')
    settingsManager.setValue('snippets.enabled', false)

    type(mounted, TRIGGER)
    await settle()

    expect(mounted.state.doc.toString()).toBe(`Text here\n${TRIGGER}`)
  })
})
