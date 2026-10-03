/**
 * `ProjectIndex`'s re-index is coalesced, and it has to still be current.
 *
 * Opening a session is a burst of events that each used to ask for a full
 * re-index — a document's `change`, the `analysis-change` its deferred parse
 * produces, its `saved`, and one per buffer opened — so a four-file restore
 * walked every open buffer's analysis a dozen times in one task to recompute the
 * same answer. Measured on a 7,000-file project, opening one document produced a
 * **1,052 ms** main-thread task, which is a freeze the user sees.
 *
 * These tests pin both halves of the fix, because either one alone is a bug:
 *
 *  - the burst is **one** walk rather than a dozen (the cost), and
 *  - the index is current **within the same task** as the change (the correctness
 *    the `change` listener exists for — a completion source that reads it a
 *    microtask later must not see the previous analysis).
 *
 * A coalesced-but-late re-index would pass the first and fail the second, and it
 * would look fine in the application until a completion was typed immediately
 * after a paste.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { DocumentModel, type DocumentAnalysis, type DocumentAnalyzer } from '@/document/documentModel'
import { projectIndex } from '@/document/projectIndex'

/** An analyzer whose answer is fixed, so only the *calls* are under test. */
function countingAnalyzer(): DocumentAnalyzer & { calls: number } {
  const analysis: DocumentAnalysis = {
    outline: [],
    labels: [{ name: 'sec:one', offset: 0, line: 1 }],
    citations: [],
    macroDefinitions: [],
    environments: [],
    includedFiles: [],
    sectioning: [],
  }
  const analyzer = {
    id: 'counting',
    calls: 0,
    analyze(): DocumentAnalysis {
      analyzer.calls += 1
      return analysis
    },
  }
  return analyzer
}

function makeDocument(uri: string): DocumentModel {
  return new DocumentModel(uri, uri.split('/').pop() ?? 'doc.tex', '\\section{One}\\label{sec:one}', 'latex')
}

describe('ProjectIndex: one re-index per burst, still current in the same task', () => {
  beforeEach(() => {
    // The index is a process-wide singleton; a leftover document from another
    // test file would be walked by every assertion here.
    for (const document of projectIndex.getAllDocuments()) {
      projectIndex.unregisterDocument(document.uri)
    }
    projectIndex.setRootDocumentPath(null)
  })

  it('is current immediately after a change, without waiting for a microtask', () => {
    const analyzer = countingAnalyzer()
    const doc = makeDocument('C:/project/current.tex')
    doc.setAnalyzer(analyzer)
    projectIndex.registerDocument(doc)

    // The first pass is synchronous (`setAnalyzer` analyses on registration, and
    // `registerDocument` re-indexes), so this is already known.
    expect(projectIndex.getLabelOccurrences('sec:one')).toHaveLength(1)

    // A second document registered in the same task must not be invisible to a
    // reader that looks right now: `registerDocument` re-indexes synchronously.
    const second = makeDocument('C:/project/second.tex')
    second.setAnalyzer(analyzer)
    projectIndex.registerDocument(second)
    expect(projectIndex.getLabelOccurrences('sec:one')).toHaveLength(2)
  })

  it('walks the open buffers once for a burst of events, and reports the last one', async () => {
    const analyzer = countingAnalyzer()
    const doc = makeDocument('C:/project/burst.tex')
    doc.setAnalyzer(analyzer)
    projectIndex.registerDocument(doc)

    // Count the walks rather than the analyses: `reindex` is what is expensive,
    // and it is what used to run once per event.
    let walks = 0
    const original = projectIndex.reindex.bind(projectIndex)
    const counted = (): void => {
      walks += 1
      original()
    }
    const spy = Object.getOwnPropertyDescriptor(projectIndex, 'reindex')
    try {
      Object.defineProperty(projectIndex, 'reindex', { value: counted, configurable: true, writable: true })

      // A burst of edits in one task, the way opening a session produces them.
      for (let index = 0; index < 8; index++) {
        doc.setText(`\\section{One}\\label{sec:one}\n% edit ${index}`, 'code')
      }

      // Nothing has been walked yet — the coalescing is what defers it — and the
      // index is still the answer for the text before the burst, which is
      // acceptable only because no reader can observe it inside this task.
      expect(walks).toBe(0)

      // One microtask later: exactly one walk, and it reflects the final text.
      await Promise.resolve()
      expect(walks).toBe(1)
      expect(projectIndex.getLabelOccurrences('sec:one')).toHaveLength(1)
    } finally {
      if (spy) Object.defineProperty(projectIndex, 'reindex', spy)
    }
  })

  it('queues at most one walk while one is already pending', async () => {
    const doc = makeDocument('C:/project/queued.tex')
    doc.setAnalyzer(countingAnalyzer())
    projectIndex.registerDocument(doc)

    let walks = 0
    const original = projectIndex.reindex.bind(projectIndex)
    const descriptor = Object.getOwnPropertyDescriptor(projectIndex, 'reindex')
    try {
      Object.defineProperty(projectIndex, 'reindex', {
        value: () => {
          walks += 1
          original()
        },
        configurable: true,
        writable: true,
      })

      doc.setText('a', 'code')
      doc.setText('ab', 'code')
      doc.setText('abc', 'code')
      await Promise.resolve()
      expect(walks).toBe(1)

      // The next task is free to ask again: this is a coalescing window, not a
      // throttle, so a later edit is not swallowed.
      doc.setText('abcd', 'code')
      await Promise.resolve()
      expect(walks).toBe(2)
    } finally {
      if (descriptor) Object.defineProperty(projectIndex, 'reindex', descriptor)
    }
  })
})
