// @vitest-environment node
/**
 * Analysing a file the project index read, off the renderer's thread.
 *
 * The transport is the main process (`analysis:analyze`), and three claims about
 * the analyzer behind it are worth testing here rather than in the packaged app,
 * because the message plumbing around them is thin:
 *
 *  1. the analyzer can be evaluated and run **outside a window** at all — it drags
 *     unified-latex behind it, and a module that touches `window` (or CommonJS
 *     `require`) at load time fails only in the built application;
 *  2. it produces **the same analysis** as the renderer's own instance, since the
 *     two are separate objects in separate processes and a divergence would show up
 *     as macros that exist in one place and not the other;
 *  3. the answer **survives a structured clone**, which is what crosses the IPC
 *     bridge and what the old renderer-thread version never had to face.
 *
 * `LatexAnalysisService` is then driven with a fake transport, because the real one
 * needs a process boundary — and because the fallback path is the part that must
 * not break a project's macro index when the channel is unavailable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { analyzeWith } from '../../src/main/analysis/analyzer'
import { LatexAnalysisService } from '@/parser/latexAnalysis'
import type { AnalyzeDocumentRequest, AnalyzeDocumentResponse } from '../../src/shared/ipc'
import type { DocumentAnalysis } from '@/document/documentModel'

/** A document with a macro, a label, a citation, an include and an environment. */
const SOURCE = [
  '\\documentclass{article}',
  '\\newcommand{\\R}{\\mathbb{R}}',
  '\\newtheorem{proposition}{Proposition}',
  '\\input{sections/intro}',
  '\\begin{document}',
  '\\section{First}',
  'See \\cite{knuth1984} and \\label{sec:first}.',
  '\\begin{proposition}A claim.\\end{proposition}',
  '\\end{document}'
].join('\n')

/**
 * The transport as the service drives it: a function from one document to one
 * response. Recorded calls, and answers on a later task the way the bridge does —
 * a synchronous answer would hide a service that resolves before it has registered
 * the request.
 */
function fakeTransport(respond: (request: AnalyzeDocumentRequest) => AnalyzeDocumentResponse) {
  const calls: AnalyzeDocumentRequest[] = []
  const invoke = vi.fn((text: string, uri: string) => {
    const request = { text, uri }
    calls.push(request)
    return new Promise<AnalyzeDocumentResponse>(resolve => setTimeout(() => resolve(respond(request)), 0))
  })
  return { invoke, calls }
}

/** Lets every pending timer run, so a fire-and-forget failure has happened. */
const drain = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))

const analysis = (over: Partial<DocumentAnalysis> = {}): DocumentAnalysis => ({
  outline: [],
  labels: [],
  citations: [],
  macroDefinitions: [],
  environments: [],
  includedFiles: [],
  sectioning: [],
  ...over
})

describe('the analyzer the main process runs is usable and agrees with the renderer', () => {
  it('runs outside a window and reports the same analysis the renderer computes', async () => {
    // The real analyzer, loaded here the way the renderer loads it.
    const module = await import('@/parser/latexAnalyzer')
    const onRenderer = module.latexDocumentAnalyzer.analyze(SOURCE, '/project/main.tex')

    const response = analyzeWith(module.latexDocumentAnalyzer, { text: SOURCE, uri: '/project/main.tex' })
    expect(response.error).toBeUndefined()
    expect(response.analysis).toEqual(onRenderer)

    // And it found something, so the comparison above is not two empty answers.
    // `environments` is the environments the document *uses*, not the ones it
    // declares, which is why the assertion is on `document` and `proposition` as
    // they appear in the body.
    const parsed = response.analysis as DocumentAnalysis
    expect(parsed.macroDefinitions.map(entry => entry.name)).toContain('R')
    expect(parsed.labels.map(entry => entry.name)).toContain('sec:first')
    expect(parsed.citations.flatMap(entry => entry.keys)).toContain('knuth1984')
    expect(parsed.includedFiles.map(entry => entry.path)).toContain('sections/intro')
    expect(parsed.environments.map(entry => entry.name)).toEqual(
      expect.arrayContaining(['document', 'proposition'])
    )
  })

  it('reports a document the analyzer cannot handle as an error, not as a crash', () => {
    const throwing = {
      id: 'throwing',
      analyze: () => {
        throw new Error('bad document')
      }
    }
    const response = analyzeWith(throwing as never, { text: '', uri: '' })
    expect(response.analysis).toBeUndefined()
    expect(response.error).toBe('bad document')
  })

  it('produces an answer that survives being posted', () => {
    const response = analyzeWith(
      { id: 'stub', analyze: () => analysis({ labels: [{ name: 'sec:first', offset: 0, line: 7 }] }) },
      { text: SOURCE, uri: '/project/main.tex' }
    )
    // `ipcRenderer.invoke` structured-clones; anything not cloneable would throw
    // here and only in the packaged app.
    const round = structuredClone(response) as AnalyzeDocumentResponse
    expect(round).toEqual(response)
    expect((round.analysis as DocumentAnalysis).labels).toHaveLength(1)
  })
})

describe('the service uses the channel when it can and answers when it cannot', () => {
  let warn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    warn = vi.fn()
  })

  it('sends the work through the transport and resolves with the answer', async () => {
    const { invoke, calls } = fakeTransport(() => ({
      analysis: analysis({ macroDefinitions: [{ name: 'R', args: 0, offset: 0, line: 2, definition: '\\newcommand{\\R}{\\mathbb{R}}' }] })
    }))
    const service = new LatexAnalysisService({ fallback: async () => null, invoke, warn })

    expect(service.start()).toBe(true)
    const result = await service.analyze(SOURCE, '/project/main.tex')
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toBe(SOURCE)
    expect(calls[0].uri).toBe('/project/main.tex')
    expect(result.macroDefinitions.map(entry => entry.name)).toEqual(['R'])
    expect(service.usingTransport).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    service.dispose()
  })

  it('keeps concurrent requests apart', async () => {
    const { invoke } = fakeTransport(request => ({
      analysis: analysis({ sectioning: [{ level: 1, title: request.uri, offset: 0, line: 1 }] })
    }))
    const service = new LatexAnalysisService({ fallback: async () => null, invoke, warn })

    const [first, second] = await Promise.all([
      service.analyze('a', '/one.tex'),
      service.analyze('b', '/two.tex')
    ])
    expect(first.sectioning[0].title).toBe('/one.tex')
    expect(second.sectioning[0].title).toBe('/two.tex')
    service.dispose()
  })

  it('never has more than a handful of analyses in flight', async () => {
    // The bound the main process depends on: an analysis is synchronous work there,
    // so a caller that fired every file at once would queue parses in front of the
    // file reads this walk is itself waiting on.
    let inFlight = 0
    let peak = 0
    const invoke = vi.fn(
      () =>
        new Promise<AnalyzeDocumentResponse>(resolve => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          setTimeout(() => {
            inFlight -= 1
            resolve({ analysis: analysis() })
          }, 0)
        })
    )
    const service = new LatexAnalysisService({ fallback: async () => null, invoke, warn })

    await Promise.all(Array.from({ length: 20 }, (_unused, index) => service.analyze('x', `/f${index}.tex`)))

    expect(invoke).toHaveBeenCalledTimes(20)
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
    service.dispose()
  })

  it('reports a document that cannot be parsed as a rejection, so the caller can skip it', async () => {
    const { invoke } = fakeTransport(() => ({ error: 'bad document' }))
    const service = new LatexAnalysisService({ fallback: async () => null, invoke, warn })
    await expect(service.analyze(SOURCE, '/project/main.tex')).rejects.toThrow('bad document')
    service.dispose()
  })

  it('falls back to the renderer analyzer when there is no channel', async () => {
    // The VS Code behaviour: "Could not create web worker(s). Falling back to loading
    // web worker code in main thread, which might cause UI freezes" — and carrying on.
    const onRenderer = vi.fn(() => analysis({ labels: [{ name: 'sec:one', offset: 0, line: 1 }] }))
    const service = new LatexAnalysisService({
      fallback: async () => ({ id: 'test', analyze: onRenderer }) as never,
      warn
    })

    expect(service.start()).toBe(false)
    const result = await service.analyze(SOURCE, '/project/main.tex')
    expect(result.labels.map(entry => entry.name)).toEqual(['sec:one'])
    expect(onRenderer).toHaveBeenCalledWith(SOURCE, '/project/main.tex')
    expect(service.usingTransport).toBe(false)
    // Said once, so the reason the app is slow is findable rather than mysterious.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("renderer's thread")
  })

  it('abandons a channel that fails, answering that file on this thread and the rest too', async () => {
    // What the packaged build did: every request failed with `require is not defined`,
    // and retrying only multiplied the console noise and delayed the fallback.
    const onRenderer = vi.fn(() => analysis({ labels: [{ name: 'sec:one', offset: 0, line: 1 }] }))
    const invoke = vi.fn(async () => {
      throw new Error('require is not defined')
    })
    const service = new LatexAnalysisService({
      fallback: async () => ({ id: 'test', analyze: onRenderer }) as never,
      invoke,
      warn
    })

    // The failing request is not lost: the caller gets an answer from the fallback,
    // because one broken channel must not cost the project a file's macros.
    const result = await service.analyze('a', '/one.tex')
    expect(result.labels.map(entry => entry.name)).toEqual(['sec:one'])
    await drain()

    expect(service.usingTransport).toBe(false)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("renderer's thread")

    // And the next call goes straight to the fallback: no second attempt.
    await service.analyze('b', '/two.tex')
    expect(invoke).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('rejects when there is no analyzer and no channel either', async () => {
    const service = new LatexAnalysisService({ fallback: async () => null, warn })
    await expect(service.analyze(SOURCE, '/project/main.tex')).rejects.toThrow(/no LaTeX analyzer/)
  })
})
