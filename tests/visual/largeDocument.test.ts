// @vitest-environment node
/**
 * The large-file contract.
 *
 * VS Code decides a document's capabilities once, from its size, names what it
 * switched off, and ships one setting that forces everything back on. These are the
 * same three promises for Eukolia, with thresholds taken from the measured cost of
 * the pass they gate rather than from VS Code's constants — see `largeDocument.ts`.
 */
import { describe, expect, it } from 'vitest'

import {
  EAGER_PARSE_LINES,
  LARGE_DOCUMENT_ANALYSIS_LINES,
  LARGE_DOCUMENT_ANALYSIS_SETTLE_MS,
  LARGE_DOCUMENT_DECORATION_LINES,
  FULL_FEATURES,
  largeDocumentNotice,
  largeDocumentProfile,
  lineCount
} from '@/visual/largeDocument'

/** A document of `lines` lines, with the given characters per line. */
const document = (lines: number, columns = 40) => ({
  length: lines * (columns + 1),
  lines
})

const profileFor = (lines: number, enabled = true) =>
  largeDocumentProfile(document(lines), { enabled, analysisSettleMs: 120 })

describe('a document is given the capabilities its size allows', () => {
  it('gives a small document everything, and says nothing', () => {
    const profile = profileFor(200)
    expect(profile).toEqual({ ...FULL_FEATURES, analysisSettleMs: 120 })
    expect(largeDocumentNotice(profile)).toBeNull()
  })

  it('stops analysing between keystrokes once the document is large', () => {
    // The first gate to close: the analysis is a full parse of the buffer, so it
    // moves to the moment the reader pauses before anything is taken away.
    const just = profileFor(LARGE_DOCUMENT_ANALYSIS_LINES)
    expect(just.analysisSettleMs).toBe(120)
    expect(just.decorations).toBe(true)

    const large = profileFor(LARGE_DOCUMENT_ANALYSIS_LINES + 1)
    expect(large.analysisSettleMs).toBe(LARGE_DOCUMENT_ANALYSIS_SETTLE_MS)
    // A pause, not a removal: the outline and the labels still arrive.
    expect(large.decorations).toBe(true)
    expect(large.eagerParse).toBe(true)
    expect(large.large).toBe(true)
  })

  it('keeps rendering widgets at every size a document reaches, and names what it does drop', () => {
    // Visual rendering is bounded to the viewport now, so its cost no longer depends
    // on the document and there is nothing left for a threshold to protect: a
    // mathematics editor that will not draw mathematics in a long chapter has
    // removed the thing the reader opened it for. The old gate sat at 2 000 lines
    // and is why a Stacks chapter showed no SVG at all.
    const at = profileFor(LARGE_DOCUMENT_DECORATION_LINES)
    expect(at.decorations).toBe(true)

    const past = profileFor(LARGE_DOCUMENT_DECORATION_LINES + 1)
    expect(past.decorations).toBe(false)
    expect(past.disabled.some(entry => entry.includes('visual rendering'))).toBe(true)
    expect(largeDocumentNotice(past)).toContain('visual rendering')
    expect(largeDocumentNotice(past)).toContain('editor.largeFileOptimizations')

    // The sizes that actually turn up: a chapter of the Stacks project, and a whole
    // book. Both render.
    expect(profileFor(14_529).decorations).toBe(true)
    expect(profileFor(120_000).decorations).toBe(true)
  })

  it('stops parsing the whole document up front past that threshold, and stops linting', () => {
    const past = profileFor(EAGER_PARSE_LINES + 1)
    expect(past.eagerParse).toBe(false)
    expect(past.lint).toBe(false)
    const notice = largeDocumentNotice(past)
    expect(notice).toContain('up front')
    expect(notice).toContain('live linting')
  })

  it('does not decide per keystroke: the profile is a function of the document only', () => {
    // Editing a document past a threshold keeps the capabilities it opened with —
    // the caller decides once and does not re-decide (see `VisualEditor`), which is
    // what the comment in VS Code's `textModel.ts` insists on. This test is the
    // shape of that promise: two calls for one size agree, and the thresholds are
    // the only thing that separates them.
    expect(profileFor(500)).toEqual(profileFor(500))
    expect(profileFor(500, true).decorations).toBe(true)
    expect(profileFor(14_529, true).decorations).toBe(true)
  })
})

describe('the override is VS Code\'s, in the same direction', () => {
  it('restores every capability when the setting is off, however large the file', () => {
    const profile = profileFor(500_000, false)
    expect(profile.large).toBe(false)
    expect(profile.disabled).toEqual([])
    expect(profile.decorations).toBe(true)
    expect(profile.eagerParse).toBe(true)
    expect(profile.lint).toBe(true)
    // Except the analyse-on-pause, which is not a removed feature but a schedule:
    // the caller's own settle time is kept, so forcing features on cannot silently
    // reintroduce a parse between two keystrokes.
    expect(profile.analysisSettleMs).toBe(120)
  })

  it('names every capability it switched off, so the notice is complete', () => {
    // At 500 000 lines: the eager parse, the lint, and the analysis schedule.
    // Visual rendering is *not* among them — see the note on the threshold.
    const profile = profileFor(500_000)
    expect(profile.disabled).toHaveLength(3)
    expect(profile.disabled.some(entry => entry.includes('visual rendering'))).toBe(false)
    const notice = largeDocumentNotice(profile) ?? ''
    for (const entry of profile.disabled) expect(notice).toContain(entry)
  })
})

describe('counting lines', () => {
  it('counts like the document does, without materialising it', () => {
    expect(lineCount('')).toBe(1)
    expect(lineCount('one line')).toBe(1)
    expect(lineCount('a\nb')).toBe(2)
    expect(lineCount('a\nb\n')).toBe(3)
    expect(lineCount('\n')).toBe(2)
  })
})
