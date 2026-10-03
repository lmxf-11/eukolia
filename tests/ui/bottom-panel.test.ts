/**
 * The bottom panel's decisions.
 *
 * The panel is where a build is *read*: the Problems list, the compiler stream,
 * the parsed log, the search hits and a shell. Three of its behaviours are
 * decisions rather than layout, and each was a defect:
 *
 *   - how much of a compiler log is rendered (`compilation.maxLogLines`): the
 *     full text is bounded by characters, and a MiKTeX run of a large document
 *     reaches that bound, so the Output view was laying out tens of thousands of
 *     lines inside a `pre` in a 200px panel;
 *   - whether a problem row can be opened: the failure entry a build adds has no
 *     line to go to, and a row that navigates to line 0 is worse than an inert
 *     one;
 *   - what the failure strip says at its head.
 */

import { describe, expect, it } from 'vitest'

import { failureHeadline, isNearBottom, tailLines } from '../../src/renderer/ui/components/BottomPanel'

describe('how much of the compiler log the panel renders', () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')

  it('keeps the last lines, which is where a build ends', () => {
    const trimmed = tailLines(lines(10), 3)
    expect(trimmed.text).toBe('line 8\nline 9\nline 10')
    expect(trimmed.dropped).toBe(7)
  })

  it('says how many lines were left out rather than trimming silently', () => {
    // The panel prints this count; a stream that starts mid-sentence has to say
    // that it does.
    const trimmed = tailLines(lines(500), 100)
    expect(trimmed.dropped).toBe(400)
    expect(trimmed.text.split('\n')).toHaveLength(100)
  })

  it('leaves a log shorter than the limit alone', () => {
    expect(tailLines(lines(5), 20)).toEqual({ text: lines(5), dropped: 0 })
  })

  it('treats an unset or nonsensical limit as no limit', () => {
    expect(tailLines(lines(5), 0).dropped).toBe(0)
    expect(tailLines(lines(5), Number.NaN).dropped).toBe(0)
    expect(tailLines(lines(5), -10).dropped).toBe(0)
  })

  it('keeps a trailing newline, so the last line is still a line', () => {
    const trimmed = tailLines('a\nb\n', 1)
    expect(trimmed.text).toBe('')
    expect(trimmed.dropped).toBe(2)
  })
})

describe('the failure strip', () => {
  it('names the step that failed when there is one', () => {
    expect(failureHeadline({ step: 'pdflatex (main)', stepIndex: 1, totalSteps: 4 })).toBe('Build failed — pdflatex (main)')
  })

  it('states the build itself when no step is to blame', () => {
    expect(failureHeadline({})).toBe('Build failed')
  })
})

describe('following the build output', () => {
  it('follows while the reader is at the bottom', () => {
    expect(isNearBottom(1000, 100, 1100)).toBe(true)
  })

  it('stops following once they scroll up', () => {
    expect(isNearBottom(400, 100, 1100)).toBe(false)
  })
})
