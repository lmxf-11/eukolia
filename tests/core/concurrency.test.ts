// @vitest-environment node
/**
 * The bounded map.
 *
 * Its whole job is that no more than `limit` workers are ever outstanding, and its
 * results keep the input's order — the two things a caller replacing a `Promise.all`
 * with it has to be able to rely on.
 */
import { describe, expect, it, vi } from 'vitest'

import { mapWithConcurrency } from '@core/concurrency'

/** Runs `worker` over `items` while recording how many were in flight together. */
async function withPeak<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
  let inFlight = 0
  let peak = 0
  const results = await mapWithConcurrency(items, limit, async (item, index) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 0))
    inFlight -= 1
    return worker(item, index)
  })
  return { results, peak }
}

describe('mapWithConcurrency', () => {
  it('never runs more than the bound at once, and still runs everything', async () => {
    const items = Array.from({ length: 25 }, (_unused, index) => index)
    const worker = vi.fn(async (item: number) => item * 2)

    const { results, peak } = await withPeak(items, 4, worker)

    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
    expect(worker).toHaveBeenCalledTimes(25)
    expect(results).toEqual(items.map((item) => item * 2))
  })

  it('keeps the input order in the results', async () => {
    // The workers finish in whatever order the work takes; the answer must not.
    const { results } = await withPeak([30, 10, 20], 3, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item))
      return item
    })
    expect(results).toEqual([30, 10, 20])
  })

  it('runs serially when the bound is one, and everything at once above the count', async () => {
    const items = [1, 2, 3]
    expect((await withPeak(items, 1, async (item) => item)).peak).toBe(1)
    expect((await withPeak(items, 99, async (item) => item)).peak).toBe(3)
  })

  it('treats a nonsense bound as one rather than as unbounded', async () => {
    // A bound of `NaN` or `0` came from somewhere; running the whole list at once
    // is the failure this helper exists to prevent.
    expect((await withPeak([1, 2, 3], 0, async (item) => item)).peak).toBe(1)
    expect((await withPeak([1, 2, 3], Number.NaN, async (item) => item)).peak).toBe(1)
  })

  it('rejects like Promise.all, so a caller cannot mistake a failure for a result', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('bad item')
        return item
      })
    ).rejects.toThrow('bad item')
  })

  it('answers an empty list without running anything', async () => {
    const worker = vi.fn(async (item: number) => item)
    expect(await mapWithConcurrency([], 4, worker)).toEqual([])
    expect(worker).not.toHaveBeenCalled()
  })
})
