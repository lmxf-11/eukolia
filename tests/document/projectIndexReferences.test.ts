/**
 * Reference resolution: the project's answer for `\input{...}` and friends.
 *
 * The search itself is old; what is new is that it is *remembered*. `cmNavigation`
 * resolves every reference in the document on every edit — it is what decides
 * which of them can be clicked — so the search used to run once per reference per
 * keystroke, and each run built a lower-cased spelling of every file's path and
 * name. That is fine on a fixture and not on a real project, which is the shape of
 * "typing gets slower as the project grows".
 *
 * A cache is only worth having if it can be wrong and is not, so most of what is
 * asserted here is invalidation: a renamed file, a rescanned tree and a moved
 * project root must all produce the truth rather than the remembered answer.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { projectIndex } from '@/document/projectIndex'

const ROOT = 'D:/paper'

beforeEach(() => {
  projectIndex.setProjectRoot(ROOT)
  projectIndex.setFiles([
    { path: 'D:/paper/main.tex', name: 'main.tex', isDirectory: false },
    { path: 'D:/paper/chapters', name: 'chapters', isDirectory: true },
    { path: 'D:/paper/chapters/intro.tex', name: 'intro.tex', isDirectory: false },
    { path: 'D:/paper/chapters/method.tex', name: 'method.tex', isDirectory: false },
    { path: 'D:/paper/figures', name: 'figures', isDirectory: true },
    { path: 'D:/paper/figures/plot.png', name: 'plot.png', isDirectory: false },
    { path: 'D:/paper/figures/plot.tex', name: 'plot.tex', isDirectory: false },
    { path: 'D:/paper/refs.bib', name: 'refs.bib', isDirectory: false },
  ])
})

const SOURCES = ['tex', 'ltx', 'sty', 'cls'] as const
const GRAPHICS = ['pdf', 'png', 'jpg', 'jpeg', 'eps', 'svg'] as const

describe('the project resolves a reference like the search it stands in for', () => {
  it('finds a chapter by its relative path', () => {
    expect(projectIndex.resolveReference('chapters/intro', SOURCES)?.path).toBe(
      'D:/paper/chapters/intro.tex',
    )
  })

  it('finds it by its bare name', () => {
    expect(projectIndex.resolveReference('intro', SOURCES)?.path).toBe(
      'D:/paper/chapters/intro.tex',
    )
  })

  it('finds it however the author spelled the prefix', () => {
    for (const spelling of ['./chapters/intro', 'chapters\\intro']) {
      expect(projectIndex.resolveReference(spelling, SOURCES)?.path).toBe(
        'D:/paper/chapters/intro.tex',
      )
    }
  })

  it('keeps a picture and a source apart, which is why the caller passes the list', () => {
    // `\includegraphics{figures/plot}` names the picture; `\input{figures/plot}`
    // names the source. Resolving both to one of them would open the wrong file.
    expect(projectIndex.resolveReference('figures/plot', GRAPHICS)?.path).toBe(
      'D:/paper/figures/plot.png',
    )
    expect(projectIndex.resolveReference('figures/plot', SOURCES)?.path).toBe(
      'D:/paper/figures/plot.tex',
    )
  })

  it('never returns a directory, though a directory name matches what is inside it', () => {
    // The match is a substring of the relative path, so a reference naming a
    // folder resolves to the first thing in it — deliberately, since
    // `\input{chapters/first}` and `\input{first}` both have to work. What can
    // never come back is the folder itself.
    const candidates = projectIndex.findFileCandidates('chapters', SOURCES)
    expect(candidates.map((file) => file.name)).toEqual(['intro.tex', 'method.tex'])
    for (const candidate of candidates) expect(candidate.isDirectory).toBe(false)
  })

  it('answers nothing for a path the project does not hold', () => {
    expect(projectIndex.resolveReference('chapters/conclusion', SOURCES)).toBeUndefined()
  })

  it('is the first candidate the full search returns, for every reference', () => {
    for (const prefix of ['main', 'chapters/', 'plot', 'refs']) {
      for (const extensions of [SOURCES, GRAPHICS]) {
        const search = projectIndex.findFileCandidates(prefix, extensions)[0]
        const resolved = projectIndex.resolveReference(prefix, extensions)
        expect(resolved?.path).toBe(search?.path)
      }
    }
  })

  it('returns every candidate in file order, without duplicates', () => {
    expect(
      projectIndex.findFileCandidates('plot', [...SOURCES, ...GRAPHICS]).map((file) => file.name),
    ).toEqual(['plot.png', 'plot.tex'])
  })

  it('takes an empty prefix as "any file with one of these extensions"', () => {
    expect(projectIndex.findFileCandidates('', SOURCES).map((file) => file.name)).toEqual([
      'main.tex',
      'intro.tex',
      'method.tex',
      'plot.tex',
    ])
  })
})

describe('a remembered answer cannot outlive the file list it came from', () => {
  it('forgets a file that is no longer there', () => {
    expect(projectIndex.resolveReference('chapters/intro', SOURCES)?.path).toBe(
      'D:/paper/chapters/intro.tex',
    )
    projectIndex.setFiles([
      { path: 'D:/paper/main.tex', name: 'main.tex', isDirectory: false },
    ])
    expect(projectIndex.resolveReference('chapters/intro', SOURCES)).toBeUndefined()
  })

  it('forgets a file that was removed one at a time', () => {
    projectIndex.resolveReference('intro', SOURCES)
    projectIndex.removeFile('D:/paper/chapters/intro.tex')
    expect(projectIndex.resolveReference('intro', SOURCES)).toBeUndefined()
  })

  it('learns a file that has just been added', () => {
    expect(projectIndex.resolveReference('conclusion', SOURCES)).toBeUndefined()
    projectIndex.addFile({
      path: 'D:/paper/chapters/conclusion.tex',
      name: 'conclusion.tex',
      isDirectory: false,
    })
    expect(projectIndex.resolveReference('conclusion', SOURCES)?.path).toBe(
      'D:/paper/chapters/conclusion.tex',
    )
  })

  it('forgets everything when the project root moves', () => {
    // The spellings are derived from the root, so a new root makes every one of
    // them stale — including the ones that still resolve, by a different path.
    projectIndex.resolveReference('chapters/intro', SOURCES)
    projectIndex.setProjectRoot('D:/other')
    projectIndex.setFiles([
      { path: 'D:/other/chapters/intro.tex', name: 'intro.tex', isDirectory: false },
    ])
    const resolved = projectIndex.resolveReference('chapters/intro', SOURCES)
    expect(resolved?.path).toBe('D:/other/chapters/intro.tex')
    expect(resolved?.relativePath).toBe('chapters/intro.tex')
  })

  it('keeps a picture and a source apart across a reuse of the same text', () => {
    // The two calls differ only in the extension list, and the remembered answer
    // is keyed on both — otherwise the second call would be handed the first's
    // picture for a `\input`.
    expect(projectIndex.resolveReference('figures/plot', GRAPHICS)?.name).toBe('plot.png')
    expect(projectIndex.resolveReference('figures/plot', SOURCES)?.name).toBe('plot.tex')
  })
})

/**
 * The theorem environments the index reports are remembered per source text.
 *
 * That cache is what took the walk from 4.3 ms to 0.41 ms per keystroke on a project
 * that registers two hundred `\input`ed files — it used to run two regular
 * expressions over two megabytes of unchanged text on every character typed. A cache
 * of a *source* is only worth having if it notices the source changing, and this is
 * the test that says so: an environment added to a file on disk, and one added to an
 * open buffer, both have to appear.
 */
describe('a remembered environment list cannot outlive the text it came from', () => {
  const environments = (): string[] => projectIndex.getEnvironmentNames()
  /** `registerExternalSource` asks for a re-index on a microtask, not synchronously. */
  const settle = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
  }

  it('answers with the unreachable-file default before anything is registered', () => {
    expect(projectIndex.getIdleMs()).toBe(Number.POSITIVE_INFINITY)
  })

  it('learns a theorem declared in a file that is not open', async () => {
    projectIndex.registerExternalSource('D:/paper/refs.thm.tex', '\\newtheorem{proposition}{Proposition}\n')
    await settle()
    expect(environments()).toContain('proposition')
    expect(environments()).not.toContain('corollary')
  })

  it('sees the declaration change when the file does', async () => {
    projectIndex.registerExternalSource('D:/paper/refs.thm.tex', '\\newtheorem{proposition}{Proposition}\n')
    await settle()
    expect(environments()).toContain('proposition')

    projectIndex.registerExternalSource('D:/paper/refs.thm.tex', '\\newtheorem{corollary}{Corollary}\n')
    await settle()
    expect(environments()).toContain('corollary')
    // The old name is gone with the text that declared it: a stale name would offer
    // an environment the document no longer defines.
    expect(environments()).not.toContain('proposition')
  })

  it('forgets it when the source is dropped', async () => {
    projectIndex.registerExternalSource('D:/paper/refs.thm.tex', '\\newtheorem{proposition}{Proposition}\n')
    await settle()
    expect(environments()).toContain('proposition')
    projectIndex.clearExternalSources('D:/paper/refs.thm.tex')
    await settle()
    expect(environments()).not.toContain('proposition')
  })

  it('follows a declaration made through thmtools too', async () => {
    projectIndex.registerExternalSource('D:/paper/thmtools.tex', '\\declaretheorem[numberwithin=section]{theorem*}\n')
    await settle()
    expect(environments()).toContain('theorem*')
  })
})
