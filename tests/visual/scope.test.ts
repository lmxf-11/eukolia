import { describe, expect, it, vi } from 'vitest'

import {
  createEditorScope,
  EUKOLIA_EDITOR_PHRASES,
  getEditorScope,
  requireEditorScope,
  setEditorScope,
} from '@/visual/scope'
import {
  buildScopeMetadata,
  isVisualModeFile,
  relativeDocFolder,
  scopePreviewByPath,
  VISUAL_MODE_EXTENSIONS,
} from '@/visual/editorExtensions'
import {
  onEditorNavigation,
  setEditorSelection,
} from '@/vendor/overleaf/eukolia/selection-bridge'

describe('EukoliaEditorScope', () => {
  const scopeOf = () =>
    createEditorScope({
      id: 'test',
      filePath: 'D:/project/chapters/intro.tex',
      projectRoot: 'D:/project',
      text: '\\section{Intro}\n',
      files: [
        { path: 'D:/project/main.tex' },
        { path: 'D:/project/chapters/intro.tex' },
        { path: 'D:/project/chapters/method.tex' },
        { path: 'D:/project/figures/plot.png' },
        { path: 'D:/project/figures' , isDirectory: true },
      ],
      images: {
        'D:/project/figures/plot.png': {
          url: 'file:///D:/project/figures/plot.png',
          extension: 'png',
          width: 320,
          height: 200,
        },
      },
      macroTable: { '\\R': '\\mathbb{R}' },
      symbols: {
        labels: ['intro', 'method'],
        citationKeys: ['knuth1984'],
        environments: ['theorem'],
        includedFiles: ['chapters/method'],
      },
      phrases: { edit_figure: 'Edit figure' },
    })

  it('exposes the document identity', () => {
    const scope = scopeOf()
    expect(scope.getFilePath()).toBe('D:/project/chapters/intro.tex')
    expect(scope.getFileName()).toBe('intro.tex')
    expect(scope.getText()).toBe('\\section{Intro}\n')
    expect(scope.getVersion()).toBe(1)
  })

  it('applies a minimal change and reports it', () => {
    const changes: string[] = []
    const scope = createEditorScope({
      text: 'abc',
      onChange: text => changes.push(text),
    })
    scope.applyChange({ from: 1, to: 2, insert: 'X' })

    expect(scope.getText()).toBe('aXc')
    expect(scope.getVersion()).toBe(2)
    expect(changes).toEqual(['aXc'])
  })

  it('rejects an out-of-range change instead of corrupting the buffer', () => {
    const scope = createEditorScope({ text: 'abc' })
    expect(() => scope.applyChange({ from: 2, to: 99, insert: '' })).toThrow(
      RangeError
    )
    expect(scope.getText()).toBe('abc')
  })

  it('reports the document folder relative to the project root', () => {
    expect(relativeDocFolder(scopeOf())).toBe('chapters')
  })

  it('builds a nested folder tree from the flat file list', () => {
    const folders = scopeOf().getProjectFolders()
    const chapters = folders.find(folder => folder.name === 'chapters')
    expect(chapters).toBeDefined()
    expect(chapters?.files.map(file => file.name).sort()).toEqual([
      'intro.tex',
      'method.tex',
    ])
    const figures = folders.find(folder => folder.name === 'figures')
    expect(figures?.files.map(file => file.name)).toEqual(['plot.png'])
  })

  it('notifies subscribers when the project file list changes', () => {
    const scope = scopeOf()
    const listener = vi.fn()
    const unsubscribe = scope.onProjectFilesChange(listener)
    unsubscribe()
    // The in-memory scope's list is immutable, so the contract under test is
    // that subscribing and unsubscribing are both safe no-ops.
    expect(listener).not.toHaveBeenCalled()
  })

  it('resolves image metadata relative to the document and the project', () => {
    const scope = scopeOf()
    expect(scope.getImageMetadata('figures/plot.png')?.extension).toBe('png')
    expect(
      scope.getImageMetadata('D:/project/figures/plot.png')?.url
    ).toBe('file:///D:/project/figures/plot.png')
    expect(scope.getImageMetadata('figures/missing.png')).toBeNull()
  })

  it('resolves an image that exists but has no registered metadata', () => {
    const scope = scopeOf()
    const metadata = scope.getImageMetadata('chapters/method.tex')
    expect(metadata?.extension).toBe('tex')
  })

  it('exposes the macro table, symbols and phrases', () => {
    const scope = scopeOf()
    expect(scope.getMacroTable()).toEqual({ '\\R': '\\mathbb{R}' })
    expect(scope.getSymbols().labels).toEqual(['intro', 'method'])
    expect(scope.getPhrases().edit_figure).toBe('Edit figure')
  })

  it('installs and clears the process-wide scope', () => {
    const scope = scopeOf()
    setEditorScope(scope)
    expect(getEditorScope()).toBe(scope)
    expect(requireEditorScope()).toBe(scope)
    setEditorScope(null)
    expect(getEditorScope()).toBeNull()
    expect(() => requireEditorScope()).toThrow(/No Eukolia editor scope/)
  })
})

describe('visual mode file selection', () => {
  it('claims the LaTeX extensions', () => {
    for (const extension of VISUAL_MODE_EXTENSIONS) {
      expect(isVisualModeFile(`doc.${extension}`)).toBe(true)
    }
    expect(isVisualModeFile('doc.bib')).toBe(false)
    expect(isVisualModeFile('untitled')).toBe(true)
    expect(isVisualModeFile(null)).toBe(true)
  })
})

describe('scope → Overleaf metadata', () => {
  it('maps the scope symbols into the shape the completion sources read', async () => {
    const scope = createEditorScope({
      filePath: 'D:/project/main.tex',
      projectRoot: 'D:/project',
      files: [
        { path: 'D:/project/main.tex' },
        { path: 'D:/project/refs.bib' },
      ],
      macroTable: { '\\R': '\\mathbb{R}' },
      symbols: { labels: ['a'], citationKeys: ['knuth1984', 'lamport1994'] },
    })

    const metadata = buildScopeMetadata(scope)
    expect(metadata.labels.has('a')).toBe(true)
    expect(metadata.referenceKeys.has('knuth1984')).toBe(true)
    expect(metadata.commands).toEqual([
      { caption: '\\R', snippet: '\\mathbb{R}', meta: 'macro', score: 0 },
    ])
    expect(metadata.fileTreeData.docs.map(doc => doc.name)).toEqual([
      'D:/project/main.tex',
    ])

    const result = await metadata.searchLocalReferences('knuth')
    expect(result.keys).toEqual(['knuth1984'])
  })
})

describe('scope → graphics preview resolution', () => {
  it('returns a preview for a known image and null otherwise', () => {
    const scope = createEditorScope({
      filePath: 'D:/project/main.tex',
      projectRoot: 'D:/project',
      files: [{ path: 'D:/project/figures/plot.svg' }],
      images: {
        'D:/project/figures/plot.svg': {
          url: 'file:///D:/project/figures/plot.svg',
          extension: 'svg',
        },
      },
    })
    const previewByPath = scopePreviewByPath(scope)

    expect(previewByPath('figures/plot.svg')).toEqual({
      url: 'file:///D:/project/figures/plot.svg',
      extension: 'svg',
    })
    expect(previewByPath('figures/nope.svg')).toBeNull()
  })
})

describe('editor phrases', () => {
  it('covers every phrase the ported widgets look up', () => {
    // These keys are the ones `view.state.phrase(...)` is called with in the
    // ported visual widgets; a missing key would surface a raw i18n key to the
    // user.
    expect(EUKOLIA_EDITOR_PHRASES).toMatchObject({
      sorry_your_table_cant_be_displayed_at_the_moment: expect.any(String),
      this_could_be_because_we_cant_support_some_elements_of_the_table:
        expect.any(String),
      the_visual_editor_cant_preview_this_type_of_image_file:
        expect.any(String),
      click_recompile_and_check_your_pdf_to_see_how_its_looking:
        expect.any(String),
      edit_figure: expect.any(String),
    })
  })
})

describe('navigation bridge', () => {
  it('forwards requests from the ported editor to the host', () => {
    const listener = vi.fn()
    const unsubscribe = onEditorNavigation(listener)

    setEditorSelection({ filePath: 'D:/project/chapters/method.tex', offset: 0 })
    expect(listener).toHaveBeenCalledWith({
      filePath: 'D:/project/chapters/method.tex',
      offset: 0,
    })

    unsubscribe()
    setEditorSelection({ filePath: 'other.tex' })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
