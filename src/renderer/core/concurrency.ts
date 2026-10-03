/**
 * Eukolia — a bound on how much work is in flight at once.
 *
 * The open path reads files it did not have to: every `.bib` in the project, and
 * the head of every `.tex` file for root detection. Each of those is cheap on its
 * own and the count is not bounded by anything the user controls — a project with
 * forty bibliographies issued forty reads in one `Promise.all`, and root detection
 * issues two hundred — so the *concurrency* is what has to be bounded rather than
 * the total. Two hundred outstanding IPC calls also means two hundred structured
 * clones landing in the main process at once, in front of the work it is doing for
 * the window the user is looking at.
 *
 * VS Code bounds the same thing in the same way: its file service queues reads
 * through a throttled worker rather than issuing one per caller, and its explorer
 * fetches children for the folders that are open rather than for the tree.
 *
 * The semantics are deliberately `Promise.all`'s: results come back in input order,
 * and a rejection rejects the whole call. A caller that wants one bad item to cost
 * only that item catches inside `worker` — which is what the `.bib` pass does, since
 * an unreadable bibliography must not fail the project open.
 */

/** Runs `worker` over `items`, never with more than `limit` calls outstanding. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const bound = Math.max(1, Math.floor(limit) || 1);
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = new Array(Math.min(bound, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
